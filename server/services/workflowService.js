const crypto = require('crypto');
const mongoose = require('mongoose');
const Workflow = require('../models/Workflow');
const Automation = require('../models/Automation');
const automationService = require('./automationService');
const eventStreamService = require('./eventStreamService');

function normalizeTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') {
    return { type: 'manual', conditions: {} };
  }
  const type = typeof trigger.type === 'string' && trigger.type.trim()
    ? trigger.type.trim()
    : 'manual';
  return {
    type,
    conditions: trigger.conditions && typeof trigger.conditions === 'object'
      ? trigger.conditions
      : {}
  };
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object') {
    return null;
  }
  if (!action.type || typeof action.type !== 'string') {
    return null;
  }
  return {
    type: action.type,
    target: Object.prototype.hasOwnProperty.call(action, 'target') ? action.target : null,
    parameters: action.parameters && typeof action.parameters === 'object' ? action.parameters : {}
  };
}

function nodeTypeForAction(actionType) {
  switch (actionType) {
    case 'device_control':
      return 'device_action';
    case 'scene_activate':
      return 'scene_action';
    case 'delay':
      return 'delay';
    case 'notification':
      return 'notification';
    case 'condition':
      return 'condition';
    default:
      return 'device_action';
  }
}

function buildGraphFromWorkflowParts(trigger, actions) {
  const nodes = [];
  const edges = [];

  const triggerNodeId = 'trigger-1';
  nodes.push({
    id: triggerNodeId,
    type: 'trigger',
    label: `Trigger: ${trigger.type}`,
    data: {
      triggerType: trigger.type,
      conditions: trigger.conditions || {}
    },
    position: { x: 64, y: 64 }
  });

  let previousNodeId = triggerNodeId;
  actions.forEach((action, index) => {
    const nodeId = `action-${index + 1}`;
    nodes.push({
      id: nodeId,
      type: nodeTypeForAction(action.type),
      label: `${index + 1}. ${action.type.replace(/_/g, ' ')}`,
      data: {
        actionType: action.type,
        target: action.target,
        parameters: action.parameters || {}
      },
      position: { x: 64, y: 180 + (index * 120) }
    });
    edges.push({
      id: `edge-${previousNodeId}-${nodeId}`,
      source: previousNodeId,
      target: nodeId,
      label: ''
    });
    previousNodeId = nodeId;
  });

  return { nodes, edges };
}

function normalizeGraph(graph, trigger, actions) {
  if (
    graph &&
    typeof graph === 'object' &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.edges) &&
    graph.nodes.length > 0
  ) {
    return {
      nodes: graph.nodes,
      edges: graph.edges
    };
  }
  return buildGraphFromWorkflowParts(trigger, actions);
}

function normalizeVoiceAliases(aliases = []) {
  if (!Array.isArray(aliases)) {
    return [];
  }
  const unique = new Set();
  aliases.forEach((value) => {
    if (typeof value !== 'string') {
      return;
    }
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    unique.add(normalized);
  });
  return [...unique];
}

async function ensureUniqueWorkflowName(name, excludeId = null) {
  const base = name.trim();
  let candidate = base;
  let counter = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await Workflow.findOne({
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      name: { $regex: new RegExp(`^${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    }).select('_id name');
    if (!existing) {
      return candidate;
    }
    candidate = `${base} (${counter})`;
    counter += 1;
  }
}

async function ensureWorkflowAutomationName(name, workflowId, linkedAutomationId = null) {
  const base = name.trim();
  let candidate = base;
  let counter = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await Automation.findOne({
      name: { $regex: new RegExp(`^${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    }).select('_id workflowId');

    if (
      !existing ||
      (existing.workflowId && existing.workflowId.toString() === workflowId.toString()) ||
      (linkedAutomationId && existing._id.toString() === linkedAutomationId.toString())
    ) {
      return candidate;
    }

    candidate = `${base} (${counter})`;
    counter += 1;
  }
}

class WorkflowService {
  async getAllWorkflows() {
    return Workflow.find().sort({ updatedAt: -1 }).lean();
  }

  async getWorkflowById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid workflow ID format');
    }

    const workflow = await Workflow.findById(id).lean();
    if (!workflow) {
      throw new Error(`Workflow with ID ${id} not found`);
    }
    return workflow;
  }

  async getWorkflowStats() {
    const [total, enabled, disabled, byCategory] = await Promise.all([
      Workflow.countDocuments(),
      Workflow.countDocuments({ enabled: true }),
      Workflow.countDocuments({ enabled: false }),
      Workflow.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ])
    ]);

    return {
      total,
      enabled,
      disabled,
      categories: byCategory.reduce((acc, entry) => {
        acc[entry._id] = entry.count;
        return acc;
      }, {})
    };
  }

  async syncWorkflowToAutomation(workflowId) {
    const workflow = await Workflow.findById(workflowId);
    if (!workflow) {
      throw new Error('Workflow not found for automation sync');
    }

    const desiredName = await ensureWorkflowAutomationName(workflow.name, workflow._id, workflow.linkedAutomationId);
    const payload = {
      name: desiredName,
      description: workflow.description || '',
      trigger: workflow.trigger,
      actions: workflow.actions,
      enabled: workflow.enabled,
      priority: workflow.priority || 5,
      category: workflow.category || 'custom',
      cooldown: workflow.cooldown || 0,
      workflowId: workflow._id,
      workflowGraph: workflow.graph || null
    };

    let automation = null;
    if (workflow.linkedAutomationId) {
      automation = await Automation.findById(workflow.linkedAutomationId);
    }

    if (!automation) {
      automation = await Automation.findOne({ workflowId: workflow._id });
    }

    if (!automation) {
      automation = new Automation(payload);
      await automation.save();
    } else {
      Object.assign(automation, payload);
      await automation.save();
    }

    if (!workflow.linkedAutomationId || workflow.linkedAutomationId.toString() !== automation._id.toString()) {
      workflow.linkedAutomationId = automation._id;
      await workflow.save();
    }

    return automation;
  }

  async createWorkflow(workflowData = {}, options = {}) {
    if (!workflowData.name || !workflowData.name.trim()) {
      throw new Error('Workflow name is required');
    }

    const actions = (Array.isArray(workflowData.actions) ? workflowData.actions : [])
      .map((action) => normalizeAction(action))
      .filter(Boolean);

    if (!actions.length) {
      throw new Error('At least one workflow action is required');
    }

    const trigger = normalizeTrigger(workflowData.trigger);
    const name = await ensureUniqueWorkflowName(workflowData.name.trim());
    const graph = normalizeGraph(workflowData.graph, trigger, actions);

    const workflow = new Workflow({
      name,
      description: workflowData.description || '',
      source: options.source || workflowData.source || 'manual',
      enabled: typeof workflowData.enabled === 'boolean' ? workflowData.enabled : true,
      category: workflowData.category || 'custom',
      priority: workflowData.priority || 5,
      cooldown: workflowData.cooldown || 0,
      trigger,
      actions,
      graph,
      voiceAliases: normalizeVoiceAliases(workflowData.voiceAliases),
      linkedAutomationId: workflowData.linkedAutomationId || null
    });

    const savedWorkflow = await workflow.save();
    await this.syncWorkflowToAutomation(savedWorkflow._id);
    const fullWorkflow = await Workflow.findById(savedWorkflow._id).lean();

    void eventStreamService.publishSafe({
      type: 'workflow.created',
      source: 'workflow',
      category: 'automation',
      payload: {
        workflowId: savedWorkflow._id.toString(),
        name: fullWorkflow?.name || savedWorkflow.name,
        source: fullWorkflow?.source || savedWorkflow.source,
        enabled: fullWorkflow?.enabled !== false,
        triggerType: fullWorkflow?.trigger?.type || 'manual',
        steps: Array.isArray(fullWorkflow?.actions) ? fullWorkflow.actions.length : 0
      },
      tags: ['workflow', 'create']
    });

    return fullWorkflow;
  }

  async updateWorkflow(id, updateData = {}) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid workflow ID format');
    }

    const workflow = await Workflow.findById(id);
    if (!workflow) {
      throw new Error(`Workflow with ID ${id} not found`);
    }

    if (typeof updateData.name === 'string' && updateData.name.trim()) {
      workflow.name = await ensureUniqueWorkflowName(updateData.name.trim(), workflow._id);
    }
    if (typeof updateData.description === 'string') {
      workflow.description = updateData.description;
    }
    if (typeof updateData.enabled === 'boolean') {
      workflow.enabled = updateData.enabled;
    }
    if (typeof updateData.category === 'string') {
      workflow.category = updateData.category;
    }
    if (typeof updateData.priority === 'number') {
      workflow.priority = updateData.priority;
    }
    if (typeof updateData.cooldown === 'number') {
      workflow.cooldown = Math.max(0, updateData.cooldown);
    }
    if (updateData.trigger) {
      workflow.trigger = normalizeTrigger(updateData.trigger);
    }
    if (Array.isArray(updateData.actions)) {
      const actions = updateData.actions.map((action) => normalizeAction(action)).filter(Boolean);
      if (!actions.length) {
        throw new Error('At least one workflow action is required');
      }
      workflow.actions = actions;
    }
    if (Array.isArray(updateData.voiceAliases)) {
      workflow.voiceAliases = normalizeVoiceAliases(updateData.voiceAliases);
    }

    workflow.graph = normalizeGraph(
      updateData.graph,
      workflow.trigger,
      workflow.actions
    );

    await workflow.save();
    await this.syncWorkflowToAutomation(workflow._id);
    const updatedWorkflow = await Workflow.findById(workflow._id).lean();

    void eventStreamService.publishSafe({
      type: 'workflow.updated',
      source: 'workflow',
      category: 'automation',
      payload: {
        workflowId: workflow._id.toString(),
        name: updatedWorkflow?.name || workflow.name,
        enabled: updatedWorkflow?.enabled !== false,
        triggerType: updatedWorkflow?.trigger?.type || workflow.trigger?.type || 'manual',
        steps: Array.isArray(updatedWorkflow?.actions) ? updatedWorkflow.actions.length : workflow.actions.length
      },
      tags: ['workflow', 'update']
    });

    return updatedWorkflow;
  }

  async deleteWorkflow(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid workflow ID format');
    }

    const workflow = await Workflow.findById(id);
    if (!workflow) {
      throw new Error(`Workflow with ID ${id} not found`);
    }

    if (workflow.linkedAutomationId) {
      await Automation.deleteOne({
        _id: workflow.linkedAutomationId,
        workflowId: workflow._id
      });
    } else {
      await Automation.deleteMany({ workflowId: workflow._id });
    }

    await Workflow.deleteOne({ _id: workflow._id });

    void eventStreamService.publishSafe({
      type: 'workflow.deleted',
      source: 'workflow',
      category: 'automation',
      severity: 'warn',
      payload: {
        workflowId: workflow._id.toString(),
        name: workflow.name
      },
      tags: ['workflow', 'delete']
    });

    return {
      success: true,
      message: `Workflow "${workflow.name}" deleted successfully`
    };
  }

  async toggleWorkflow(id, enabled) {
    if (typeof enabled !== 'boolean') {
      throw new Error('Enabled status must be a boolean value');
    }

    const workflow = await this.updateWorkflow(id, { enabled });
    void eventStreamService.publishSafe({
      type: 'workflow.toggled',
      source: 'workflow',
      category: 'automation',
      payload: {
        workflowId: workflow._id.toString(),
        name: workflow.name,
        enabled
      },
      tags: ['workflow', 'toggle']
    });
    return {
      message: `Workflow "${workflow.name}" has been ${enabled ? 'enabled' : 'disabled'}`,
      workflow
    };
  }

  async executeWorkflow(id, options = {}) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid workflow ID format');
    }

    const workflow = await Workflow.findById(id);
    if (!workflow) {
      throw new Error(`Workflow with ID ${id} not found`);
    }

    if (!workflow.enabled && !options.force) {
      throw new Error(`Workflow "${workflow.name}" is currently disabled`);
    }

    const automation = await this.syncWorkflowToAutomation(workflow._id);
    const execution = await automationService.executeAutomation(automation._id.toString(), {
      triggerType: options.triggerType || workflow.trigger?.type || 'manual',
      triggerSource: options.triggerSource || 'manual',
      voiceCommandId: options.voiceCommandId || null,
      context: options.context || {}
    });

    workflow.lastRun = new Date();
    workflow.executionCount = (workflow.executionCount || 0) + 1;
    if (!execution.success) {
      workflow.lastError = {
        message: execution.message || 'Workflow execution failed',
        timestamp: new Date()
      };
    } else {
      workflow.lastError = undefined;
    }
    await workflow.save();

    void eventStreamService.publishSafe({
      type: execution.success ? 'workflow.executed' : 'workflow.execution_failed',
      source: 'workflow',
      category: 'automation',
      severity: execution.success ? 'info' : 'error',
      payload: {
        workflowId: workflow._id.toString(),
        name: workflow.name,
        triggerType: options.triggerType || workflow.trigger?.type || 'manual',
        triggerSource: options.triggerSource || 'manual',
        success: Boolean(execution.success),
        message: execution.message || null
      },
      tags: ['workflow', 'execution']
    });

    return {
      ...execution,
      workflow: workflow.toObject()
    };
  }

  async createWorkflowFromText(text, roomContext = null, source = 'chat') {
    if (!text || !text.trim()) {
      throw new Error('Workflow text description is required');
    }

    const creation = await automationService.createAutomationFromText(text.trim(), roomContext);
    if (creation?.handledDirectCommand) {
      void eventStreamService.publishSafe({
        type: 'workflow.command_handled',
        source: 'workflow',
        category: 'automation',
        payload: {
          source,
          text: text.trim(),
          message: creation.message || null
        },
        tags: ['workflow', 'nl']
      });

      return {
        success: true,
        handledDirectCommand: true,
        message: creation.message,
        device: creation.device
      };
    }

    const automation = creation?.automation;
    if (!automation) {
      throw new Error('Automation generation failed');
    }

    const trigger = normalizeTrigger(automation.trigger);
    const actions = (Array.isArray(automation.actions) ? automation.actions : [])
      .map((action) => normalizeAction(action))
      .filter(Boolean);

    if (!actions.length) {
      throw new Error('Generated workflow does not include executable actions');
    }

    const uniqueName = await ensureUniqueWorkflowName(automation.name || `Workflow ${crypto.randomUUID().slice(0, 8)}`);
    const workflow = new Workflow({
      name: uniqueName,
      description: automation.description || text.trim(),
      source,
      enabled: automation.enabled !== false,
      category: automation.category || 'custom',
      priority: automation.priority || 5,
      cooldown: automation.cooldown || 0,
      trigger,
      actions,
      graph: buildGraphFromWorkflowParts(trigger, actions),
      linkedAutomationId: automation._id
    });

    const savedWorkflow = await workflow.save();
    await Automation.findByIdAndUpdate(automation._id, {
      workflowId: savedWorkflow._id,
      workflowGraph: savedWorkflow.graph
    });
    await this.syncWorkflowToAutomation(savedWorkflow._id);

    void eventStreamService.publishSafe({
      type: 'workflow.created_from_text',
      source: 'workflow',
      category: 'automation',
      payload: {
        workflowId: savedWorkflow._id.toString(),
        name: savedWorkflow.name,
        source,
        triggerType: savedWorkflow.trigger?.type || 'manual'
      },
      tags: ['workflow', 'nl']
    });

    return {
      success: true,
      workflow: await Workflow.findById(savedWorkflow._id).lean(),
      automation,
      message: 'Workflow created successfully from natural language'
    };
  }

  async findWorkflowForControl({ workflowId, workflowName }) {
    let workflow = null;
    if (workflowId && mongoose.Types.ObjectId.isValid(workflowId)) {
      workflow = await Workflow.findById(workflowId);
    }

    if (!workflow && workflowName && typeof workflowName === 'string') {
      const escaped = workflowName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      workflow = await Workflow.findOne({
        name: { $regex: new RegExp(`^${escaped}$`, 'i') }
      });
    }

    if (!workflow) {
      throw new Error('Workflow not found');
    }

    return workflow;
  }

  async controlWorkflow({ workflowId = null, workflowName = '', operation = 'run' }) {
    const workflow = await this.findWorkflowForControl({ workflowId, workflowName });
    const normalizedOperation = (operation || 'run').toString().toLowerCase();

    if (['enable', 'on', 'start'].includes(normalizedOperation)) {
      const result = await this.toggleWorkflow(workflow._id.toString(), true);
      return {
        success: true,
        operation: 'enable',
        message: result.message,
        workflow: result.workflow
      };
    }

    if (['disable', 'off', 'stop', 'pause'].includes(normalizedOperation)) {
      const result = await this.toggleWorkflow(workflow._id.toString(), false);
      return {
        success: true,
        operation: 'disable',
        message: result.message,
        workflow: result.workflow
      };
    }

    const execution = await this.executeWorkflow(workflow._id.toString(), {
      triggerType: 'manual',
      triggerSource: 'voice'
    });
    return {
      success: execution.success,
      operation: 'run',
      message: execution.message,
      workflow: execution.workflow
    };
  }
}

module.exports = new WorkflowService();
