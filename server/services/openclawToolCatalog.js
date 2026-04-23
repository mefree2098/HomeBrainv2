const crypto = require('crypto');
const z = require('zod/v4');

const deviceService = require('./deviceService');
const deviceEnergySampleService = require('./deviceEnergySampleService');
const sceneService = require('./sceneService');
const workflowService = require('./workflowService');
const automationService = require('./automationService');
const securityAlarmService = require('./securityAlarmService');
const eventStreamService = require('./eventStreamService');
const resourceMonitorService = require('./resourceMonitorService');
const platformDeployService = require('./platformDeployService');
const reverseProxyService = require('./reverseProxyService');
const sslService = require('./sslService');
const settingsService = require('./settingsService');
const UserService = require('./userService');
const voiceDeviceService = require('./voiceDeviceService');
const voiceCommandService = require('./voiceCommandService');

const jsonObjectSchema = z.record(z.string(), z.unknown());

const SECRET_KEY_PATTERN = /(token|secret|password|apiKey|privateKey|certificate|credential)/i;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toPlain(value) {
  if (value === undefined) {
    return null;
  }

  return JSON.parse(JSON.stringify(value));
}

function getEntityId(value) {
  return normalizeText(value?._id?.toString?.() || value?.id || value?._id || value);
}

function getEntityName(value) {
  return normalizeText(value?.name || value?.email || value?.label);
}

function sanitizeForAudit(value, depth = 0) {
  if (depth > 6) {
    return '[TRUNCATED]';
  }

  if (value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeForAudit(entry, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.entries(value).reduce((accumulator, [key, entry]) => {
      if (SECRET_KEY_PATTERN.test(key)) {
        accumulator[key] = '[REDACTED]';
        return accumulator;
      }

      accumulator[key] = sanitizeForAudit(entry, depth + 1);
      return accumulator;
    }, {});
  }

  if (typeof value === 'string' && value.length > 400) {
    return `${value.slice(0, 397)}...`;
  }

  return value;
}

function toolSuccess(message, data = {}) {
  const payload = {
    success: true,
    message,
    data: toPlain(data)
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function toolError(error, fallbackMessage = 'Tool execution failed') {
  const payload = {
    success: false,
    error: normalizeText(error?.message) || fallbackMessage
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload,
    isError: true
  };
}

async function publishMutationAudit(context, type, payload = {}, severity = 'info', correlationId = null) {
  return eventStreamService.publishSafe({
    type,
    source: 'openclaw',
    category: 'admin',
    severity,
    correlationId,
    payload: {
      actor: context.actor,
      integrationName: context.integrationName,
      ...sanitizeForAudit(payload)
    },
    tags: ['openclaw', 'admin']
  });
}

async function withMutationAudit(context, metadata, run) {
  const correlationId = crypto.randomUUID();

  await publishMutationAudit(context, 'openclaw.mutation.requested', {
    tool: metadata.tool,
    operation: metadata.operation,
    input: metadata.auditInput || {}
  }, 'info', correlationId);

  try {
    const result = await run(correlationId);
    await publishMutationAudit(context, 'openclaw.mutation.succeeded', {
      tool: metadata.tool,
      operation: metadata.operation,
      result: metadata.auditResult ? metadata.auditResult(result) : { success: true }
    }, 'info', correlationId);
    return result;
  } catch (error) {
    await publishMutationAudit(context, 'openclaw.mutation.failed', {
      tool: metadata.tool,
      operation: metadata.operation,
      input: metadata.auditInput || {},
      error: error.message || 'Unknown error'
    }, 'error', correlationId);
    throw error;
  }
}

function matchEntityByName(items, name, label) {
  const normalizedQuery = normalizeText(name).toLowerCase();
  if (!normalizedQuery) {
    throw new Error(`${label} name is required`);
  }

  const exactMatches = items.filter((item) => getEntityName(item).toLowerCase() === normalizedQuery);
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  if (exactMatches.length > 1) {
    throw new Error(`Multiple ${label.toLowerCase()} records matched "${name}"`);
  }

  const partialMatches = items.filter((item) => getEntityName(item).toLowerCase().includes(normalizedQuery));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  if (partialMatches.length > 1) {
    throw new Error(`Multiple ${label.toLowerCase()} records matched "${name}"`);
  }

  throw new Error(`${label} not found`);
}

async function resolveByIdOrName({ id, name, label, loadById, loadAll }) {
  const normalizedId = normalizeText(id);
  if (normalizedId) {
    return loadById(normalizedId);
  }

  const normalizedName = normalizeText(name);
  if (!normalizedName) {
    throw new Error(`${label} ID or name is required`);
  }

  const items = await loadAll();
  return matchEntityByName(items, normalizedName, label);
}

async function resolveDevice(input = {}) {
  return resolveByIdOrName({
    id: input.deviceId,
    name: input.deviceName,
    label: 'Device',
    loadById: (deviceId) => deviceService.getDeviceById(deviceId),
    loadAll: () => deviceService.getAllDevices({}, { includeExcludedHarmony: true })
  });
}

async function resolveScene(input = {}) {
  return resolveByIdOrName({
    id: input.sceneId,
    name: input.sceneName,
    label: 'Scene',
    loadById: (sceneId) => sceneService.getSceneById(sceneId),
    loadAll: () => sceneService.getAllScenes()
  });
}

async function resolveWorkflow(input = {}) {
  return resolveByIdOrName({
    id: input.workflowId,
    name: input.workflowName,
    label: 'Workflow',
    loadById: (workflowId) => workflowService.getWorkflowById(workflowId),
    loadAll: () => workflowService.getAllWorkflows()
  });
}

async function resolveAutomation(input = {}) {
  return resolveByIdOrName({
    id: input.automationId,
    name: input.automationName,
    label: 'Automation',
    loadById: (automationId) => automationService.getAutomationById(automationId),
    loadAll: () => automationService.getAllAutomations()
  });
}

async function resolveUser(input = {}) {
  return resolveByIdOrName({
    id: input.userId,
    name: input.email,
    label: 'User',
    loadById: (userId) => UserService.get(userId),
    loadAll: () => UserService.list()
  });
}

async function resolveVoiceDevice(input = {}) {
  return resolveByIdOrName({
    id: input.voiceDeviceId,
    name: input.voiceDeviceName,
    label: 'Voice device',
    loadById: (voiceDeviceId) => voiceDeviceService.getDeviceById(voiceDeviceId),
    loadAll: () => voiceDeviceService.getAllDevices()
  });
}

async function getPlatformDeployStatusSnapshot() {
  await platformDeployService.finalizePendingRestart().catch(() => null);

  const [repo, latestJob, runningJob, pendingRestart] = await Promise.all([
    platformDeployService.getRepoStatus(),
    platformDeployService.getLatestJob(),
    platformDeployService.getRunningJob(),
    platformDeployService.readPendingRestart()
  ]);
  const runtime = await platformDeployService.getRuntimeInfo(repo);

  return {
    repo,
    runtime,
    pendingRestart,
    latestJob,
    running: Boolean(runningJob)
  };
}

async function handleOverview(input, context) {
  const [
    devicesResult,
    scenesResult,
    workflowsResult,
    automationsResult,
    eventsSummaryResult,
    resourcesResult,
    securityResult,
    voiceResult,
    deployStatusResult
  ] = await Promise.allSettled([
    deviceService.getAllDevices({}, { includeExcludedHarmony: true }),
    sceneService.getAllScenes(),
    workflowService.getAllWorkflows(),
    automationService.getAllAutomations(),
    eventStreamService.summary(typeof input.windowMinutes === 'number' ? input.windowMinutes : 60),
    resourceMonitorService.getUtilization(),
    securityAlarmService.getAlarmStatus({ refreshDoorLocks: false }),
    voiceDeviceService.getSystemStatus(),
    getPlatformDeployStatusSnapshot()
  ]);

  const devices = devicesResult.status === 'fulfilled' ? devicesResult.value : [];
  const scenes = scenesResult.status === 'fulfilled' ? scenesResult.value : [];
  const workflows = workflowsResult.status === 'fulfilled' ? workflowsResult.value : [];
  const automations = automationsResult.status === 'fulfilled' ? automationsResult.value : [];
  const resourceUtilization = resourcesResult.status === 'fulfilled' ? resourcesResult.value : null;
  const securityStatus = securityResult.status === 'fulfilled' ? securityResult.value : null;
  const voiceStatus = voiceResult.status === 'fulfilled' ? voiceResult.value : null;
  const deployStatus = deployStatusResult.status === 'fulfilled' ? deployStatusResult.value : null;
  const eventSummary = eventsSummaryResult.status === 'fulfilled' ? eventsSummaryResult.value : null;

  return toolSuccess('Loaded HomeBrain platform overview', {
    counts: {
      devices: devices.length,
      scenes: scenes.length,
      workflows: workflows.length,
      automations: automations.length
    },
    devices: {
      online: devices.filter((device) => device.isOnline !== false).length,
      active: devices.filter((device) => device.status === true).length
    },
    events: eventSummary,
    resources: resourceUtilization,
    securityAlarm: securityStatus,
    voice: voiceStatus,
    platformDeploy: deployStatus,
    integration: {
      actor: context.actor,
      integrationName: context.integrationName
    }
  });
}

async function handleDevices(input, context) {
  switch (input.op) {
    case 'list': {
      const devices = await deviceService.getAllDevices(input.filters || {}, {
        refreshSmartThings: input.refresh === true,
        includeExcludedHarmony: input.includeExcludedHarmony === true
      });
      return toolSuccess(`Loaded ${devices.length} devices`, { devices });
    }
    case 'get': {
      const device = await resolveDevice(input);
      return toolSuccess(`Loaded device "${getEntityName(device)}"`, { device });
    }
    case 'stats': {
      const stats = await deviceService.getDeviceStats();
      return toolSuccess('Loaded device statistics', { stats });
    }
    case 'by_room': {
      const rooms = await deviceService.getDevicesByRoom();
      return toolSuccess('Loaded devices grouped by room', { rooms });
    }
    case 'energy_history': {
      const device = await resolveDevice(input);
      const samples = await deviceEnergySampleService.getDeviceEnergyHistory(getEntityId(device), {
        hours: input.hours,
        limit: input.limit
      });
      return toolSuccess(`Loaded energy history for "${getEntityName(device)}"`, {
        device,
        samples
      });
    }
    case 'create': {
      const payload = input.device || {};
      const createdDevice = await withMutationAudit(context, {
        tool: 'homebrain_devices',
        operation: 'create',
        auditInput: { device: payload }
      }, () => deviceService.createDevice(payload));
      return toolSuccess(`Created device "${getEntityName(createdDevice)}"`, { device: createdDevice });
    }
    case 'update': {
      const device = await resolveDevice(input);
      const payload = input.device || {};
      const updatedDevice = await withMutationAudit(context, {
        tool: 'homebrain_devices',
        operation: 'update',
        auditInput: {
          deviceId: getEntityId(device),
          deviceName: getEntityName(device),
          keys: Object.keys(payload)
        }
      }, () => deviceService.updateDevice(getEntityId(device), payload));
      return toolSuccess(`Updated device "${getEntityName(updatedDevice)}"`, { device: updatedDevice });
    }
    case 'delete': {
      const device = await resolveDevice(input);
      const deletedDevice = await withMutationAudit(context, {
        tool: 'homebrain_devices',
        operation: 'delete',
        auditInput: {
          deviceId: getEntityId(device),
          deviceName: getEntityName(device)
        }
      }, () => deviceService.deleteDevice(getEntityId(device)));
      return toolSuccess(`Deleted device "${getEntityName(device)}"`, { device: deletedDevice });
    }
    case 'control': {
      const device = await resolveDevice(input);
      const updatedDevice = await withMutationAudit(context, {
        tool: 'homebrain_devices',
        operation: 'control',
        auditInput: {
          deviceId: getEntityId(device),
          deviceName: getEntityName(device),
          action: input.action,
          value: input.value
        }
      }, () => deviceService.controlDevice(getEntityId(device), input.action, input.value, {
        command: {
          source: 'openclaw',
          triggerSource: 'openclaw',
          reason: `OpenClaw device control: ${input.action}`,
          actor: context?.actor || 'openclaw'
        }
      }));
      return toolSuccess(`Executed "${input.action}" on "${getEntityName(updatedDevice)}"`, {
        device: updatedDevice
      });
    }
    default:
      throw new Error(`Unsupported devices operation: ${input.op}`);
  }
}

async function handleScenes(input, context) {
  switch (input.op) {
    case 'list': {
      const scenes = await sceneService.getAllScenes();
      return toolSuccess(`Loaded ${scenes.length} scenes`, { scenes });
    }
    case 'get': {
      const scene = await resolveScene(input);
      return toolSuccess(`Loaded scene "${getEntityName(scene)}"`, { scene });
    }
    case 'stats': {
      const stats = await sceneService.getSceneStats();
      return toolSuccess('Loaded scene statistics', { stats });
    }
    case 'create': {
      const payload = input.scene || {};
      const scene = await withMutationAudit(context, {
        tool: 'homebrain_scenes',
        operation: 'create',
        auditInput: { scene: payload }
      }, () => sceneService.createScene(payload));
      return toolSuccess(`Created scene "${getEntityName(scene)}"`, { scene });
    }
    case 'create_from_text': {
      const description = normalizeText(input.description);
      if (!description) {
        throw new Error('description is required for scene create_from_text');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_scenes',
        operation: 'create_from_text',
        auditInput: { description }
      }, () => sceneService.createSceneFromNaturalLanguage(description));
      return toolSuccess(result?.message || 'Created scene from natural language', result);
    }
    case 'update': {
      const scene = await resolveScene(input);
      const payload = input.scene || {};
      const updatedScene = await withMutationAudit(context, {
        tool: 'homebrain_scenes',
        operation: 'update',
        auditInput: {
          sceneId: getEntityId(scene),
          sceneName: getEntityName(scene),
          keys: Object.keys(payload)
        }
      }, () => sceneService.updateScene(getEntityId(scene), payload));
      return toolSuccess(`Updated scene "${getEntityName(updatedScene)}"`, { scene: updatedScene });
    }
    case 'delete': {
      const scene = await resolveScene(input);
      const result = await withMutationAudit(context, {
        tool: 'homebrain_scenes',
        operation: 'delete',
        auditInput: {
          sceneId: getEntityId(scene),
          sceneName: getEntityName(scene)
        }
      }, () => sceneService.deleteScene(getEntityId(scene)));
      return toolSuccess(`Deleted scene "${getEntityName(scene)}"`, result);
    }
    case 'activate': {
      const scene = await resolveScene(input);
      const result = await withMutationAudit(context, {
        tool: 'homebrain_scenes',
        operation: 'activate',
        auditInput: {
          sceneId: getEntityId(scene),
          sceneName: getEntityName(scene)
        }
      }, () => sceneService.activateScene(getEntityId(scene), {
        command: {
          source: 'openclaw',
          triggerSource: 'openclaw',
          reason: `OpenClaw scene activation: ${getEntityName(scene)}`,
          actor: context?.actor || 'openclaw'
        }
      }));
      return toolSuccess(`Activated scene "${getEntityName(scene)}"`, result);
    }
    default:
      throw new Error(`Unsupported scenes operation: ${input.op}`);
  }
}

async function handleWorkflows(input, context) {
  switch (input.op) {
    case 'list': {
      const workflows = await workflowService.getAllWorkflows();
      return toolSuccess(`Loaded ${workflows.length} workflows`, { workflows });
    }
    case 'get': {
      const workflow = await resolveWorkflow(input);
      return toolSuccess(`Loaded workflow "${getEntityName(workflow)}"`, { workflow });
    }
    case 'stats': {
      const stats = await workflowService.getWorkflowStats();
      return toolSuccess('Loaded workflow statistics', { stats });
    }
    case 'runtime_history': {
      const workflow = input.workflowId || input.workflowName ? await resolveWorkflow(input) : null;
      const history = await workflowService.getWorkflowRuntimeHistory(
        workflow ? getEntityId(workflow) : null,
        {
          limit: input.limit,
          page: input.page,
          hours: input.hours
        }
      );
      return toolSuccess('Loaded workflow runtime history', {
        workflow,
        history
      });
    }
    case 'runtime_telemetry': {
      const workflow = input.workflowId || input.workflowName ? await resolveWorkflow(input) : null;
      const telemetry = await workflowService.getWorkflowRuntimeTelemetry(
        workflow ? getEntityId(workflow) : null,
        { hours: input.hours }
      );
      return toolSuccess('Loaded workflow runtime telemetry', {
        workflow,
        telemetry
      });
    }
    case 'running': {
      const executions = await workflowService.getRunningWorkflowExecutions(input.limit);
      return toolSuccess('Loaded running workflow executions', { executions });
    }
    case 'create': {
      const payload = input.workflow || {};
      const workflow = await withMutationAudit(context, {
        tool: 'homebrain_workflows',
        operation: 'create',
        auditInput: { workflow: payload }
      }, () => workflowService.createWorkflow(payload, {
        source: 'openclaw'
      }));
      return toolSuccess(`Created workflow "${getEntityName(workflow)}"`, { workflow });
    }
    case 'update': {
      const workflow = await resolveWorkflow(input);
      const payload = input.workflow || {};
      const updatedWorkflow = await withMutationAudit(context, {
        tool: 'homebrain_workflows',
        operation: 'update',
        auditInput: {
          workflowId: getEntityId(workflow),
          workflowName: getEntityName(workflow),
          keys: Object.keys(payload)
        }
      }, () => workflowService.updateWorkflow(getEntityId(workflow), payload));
      return toolSuccess(`Updated workflow "${getEntityName(updatedWorkflow)}"`, {
        workflow: updatedWorkflow
      });
    }
    case 'delete': {
      const workflow = await resolveWorkflow(input);
      const result = await withMutationAudit(context, {
        tool: 'homebrain_workflows',
        operation: 'delete',
        auditInput: {
          workflowId: getEntityId(workflow),
          workflowName: getEntityName(workflow)
        }
      }, () => workflowService.deleteWorkflow(getEntityId(workflow)));
      return toolSuccess(`Deleted workflow "${getEntityName(workflow)}"`, result);
    }
    case 'create_from_text': {
      const text = normalizeText(input.text);
      if (!text) {
        throw new Error('text is required for workflow create_from_text');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_workflows',
        operation: 'create_from_text',
        auditInput: {
          text,
          roomContext: input.roomContext || null
        }
      }, () => workflowService.createWorkflowFromText(text, input.roomContext || null, 'openclaw'));
      return toolSuccess(result?.message || 'Created workflow from natural language', result);
    }
    case 'revise_from_text': {
      const workflow = await resolveWorkflow(input);
      const text = normalizeText(input.text);
      if (!text) {
        throw new Error('text is required for workflow revise_from_text');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_workflows',
        operation: 'revise_from_text',
        auditInput: {
          workflowId: getEntityId(workflow),
          workflowName: getEntityName(workflow)
        }
      }, () => workflowService.reviseWorkflowFromText(getEntityId(workflow), text, input.roomContext || null, 'openclaw'));
      return toolSuccess(result?.message || `Revised workflow "${getEntityName(workflow)}"`, result);
    }
    case 'set_enabled': {
      const workflow = await resolveWorkflow(input);
      if (typeof input.enabled !== 'boolean') {
        throw new Error('enabled must be provided for workflow set_enabled');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_workflows',
        operation: 'set_enabled',
        auditInput: {
          workflowId: getEntityId(workflow),
          workflowName: getEntityName(workflow),
          enabled: input.enabled
        }
      }, () => workflowService.toggleWorkflow(getEntityId(workflow), input.enabled));
      return toolSuccess(result?.message || 'Workflow enabled state updated', result);
    }
    case 'execute': {
      const workflow = await resolveWorkflow(input);
      const result = await withMutationAudit(context, {
        tool: 'homebrain_workflows',
        operation: 'execute',
        auditInput: {
          workflowId: getEntityId(workflow),
          workflowName: getEntityName(workflow),
          force: input.force === true
        }
      }, () => workflowService.executeWorkflow(getEntityId(workflow), {
        force: input.force === true,
        context: input.context || {},
        triggerType: 'manual',
        triggerSource: 'openclaw'
      }));
      return toolSuccess(result?.message || `Executed workflow "${getEntityName(workflow)}"`, result);
    }
    default:
      throw new Error(`Unsupported workflows operation: ${input.op}`);
  }
}

async function handleAutomations(input, context) {
  switch (input.op) {
    case 'list': {
      const automations = await automationService.getAllAutomations();
      return toolSuccess(`Loaded ${automations.length} automations`, { automations });
    }
    case 'get': {
      const automation = await resolveAutomation(input);
      return toolSuccess(`Loaded automation "${getEntityName(automation)}"`, { automation });
    }
    case 'stats': {
      const stats = await automationService.getAutomationStats();
      return toolSuccess('Loaded automation statistics', { stats });
    }
    case 'history': {
      const automation = input.automationId || input.automationName ? await resolveAutomation(input) : null;
      const history = await automationService.getAutomationHistory(
        automation ? getEntityId(automation) : null,
        input.limit || 50
      );
      return toolSuccess('Loaded automation history', {
        automation,
        history
      });
    }
    case 'execution_stats': {
      const stats = await automationService.getExecutionStats(input.dateRange || null);
      return toolSuccess('Loaded automation execution statistics', { stats });
    }
    case 'create': {
      const payload = input.automation || {};
      const automation = await withMutationAudit(context, {
        tool: 'homebrain_automations',
        operation: 'create',
        auditInput: { automation: payload }
      }, () => automationService.createAutomation(payload));
      return toolSuccess(`Created automation "${getEntityName(automation)}"`, { automation });
    }
    case 'update': {
      const automation = await resolveAutomation(input);
      const payload = input.automation || {};
      const updatedAutomation = await withMutationAudit(context, {
        tool: 'homebrain_automations',
        operation: 'update',
        auditInput: {
          automationId: getEntityId(automation),
          automationName: getEntityName(automation),
          keys: Object.keys(payload)
        }
      }, () => automationService.updateAutomation(getEntityId(automation), payload));
      return toolSuccess(`Updated automation "${getEntityName(updatedAutomation)}"`, {
        automation: updatedAutomation
      });
    }
    case 'delete': {
      const automation = await resolveAutomation(input);
      const result = await withMutationAudit(context, {
        tool: 'homebrain_automations',
        operation: 'delete',
        auditInput: {
          automationId: getEntityId(automation),
          automationName: getEntityName(automation)
        }
      }, () => automationService.deleteAutomation(getEntityId(automation)));
      return toolSuccess(`Deleted automation "${getEntityName(automation)}"`, result);
    }
    case 'create_from_text': {
      const text = normalizeText(input.text);
      if (!text) {
        throw new Error('text is required for automation create_from_text');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_automations',
        operation: 'create_from_text',
        auditInput: {
          text,
          roomContext: input.roomContext || null
        }
      }, () => automationService.createAutomationFromText(text, input.roomContext || null));
      return toolSuccess(result?.message || 'Created automation from natural language', result);
    }
    case 'revise_from_text': {
      const automation = await resolveAutomation(input);
      const text = normalizeText(input.text);
      if (!text) {
        throw new Error('text is required for automation revise_from_text');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_automations',
        operation: 'revise_from_text',
        auditInput: {
          automationId: getEntityId(automation),
          automationName: getEntityName(automation)
        }
      }, () => automationService.reviseAutomationFromText(text, automation, input.roomContext || null));
      return toolSuccess(result?.message || `Revised automation "${getEntityName(automation)}"`, result);
    }
    case 'set_enabled': {
      const automation = await resolveAutomation(input);
      if (typeof input.enabled !== 'boolean') {
        throw new Error('enabled must be provided for automation set_enabled');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_automations',
        operation: 'set_enabled',
        auditInput: {
          automationId: getEntityId(automation),
          automationName: getEntityName(automation),
          enabled: input.enabled
        }
      }, () => automationService.toggleAutomation(getEntityId(automation), input.enabled));
      return toolSuccess(result?.message || 'Automation enabled state updated', result);
    }
    case 'execute': {
      const automation = await resolveAutomation(input);
      const result = await withMutationAudit(context, {
        tool: 'homebrain_automations',
        operation: 'execute',
        auditInput: {
          automationId: getEntityId(automation),
          automationName: getEntityName(automation)
        }
      }, (correlationId) => automationService.executeAutomation(getEntityId(automation), {
        triggerType: 'manual',
        triggerSource: 'openclaw',
        context: input.context || {},
        correlationId
      }));
      return toolSuccess(result?.message || `Executed automation "${getEntityName(automation)}"`, result);
    }
    default:
      throw new Error(`Unsupported automations operation: ${input.op}`);
  }
}

async function handleSecurityAlarm(input, context) {
  switch (input.op) {
    case 'system': {
      const alarm = await securityAlarmService.getAlarmSystem();
      return toolSuccess('Loaded security alarm system', { alarm });
    }
    case 'status': {
      const status = await securityAlarmService.getAlarmStatus({
        refreshDoorLocks: input.refreshDoorLocks === true
      });
      return toolSuccess('Loaded security alarm status', { status });
    }
    case 'arm': {
      const mode = normalizeText(input.mode).toLowerCase();
      if (!['stay', 'away'].includes(mode)) {
        throw new Error('mode must be "stay" or "away" for security alarm arm');
      }
      const alarm = await withMutationAudit(context, {
        tool: 'homebrain_security_alarm',
        operation: 'arm',
        auditInput: { mode }
      }, () => securityAlarmService.armAlarm(mode, context.actor));
      return toolSuccess(`Armed security alarm in ${mode} mode`, { alarm });
    }
    case 'disarm': {
      const alarm = await withMutationAudit(context, {
        tool: 'homebrain_security_alarm',
        operation: 'disarm',
        auditInput: {}
      }, () => securityAlarmService.disarmAlarm(context.actor));
      return toolSuccess('Disarmed security alarm', { alarm });
    }
    case 'dismiss': {
      const alarm = await withMutationAudit(context, {
        tool: 'homebrain_security_alarm',
        operation: 'dismiss',
        auditInput: {}
      }, () => securityAlarmService.dismissAlarm(context.actor));
      return toolSuccess('Dismissed active security alarm', { alarm });
    }
    case 'add_zone': {
      const zone = input.zone || {};
      const alarm = await withMutationAudit(context, {
        tool: 'homebrain_security_alarm',
        operation: 'add_zone',
        auditInput: { zone }
      }, () => securityAlarmService.addZone(zone));
      return toolSuccess('Added security zone', { alarm });
    }
    case 'remove_zone': {
      const deviceId = normalizeText(input.deviceId);
      if (!deviceId) {
        throw new Error('deviceId is required for security alarm remove_zone');
      }
      const alarm = await withMutationAudit(context, {
        tool: 'homebrain_security_alarm',
        operation: 'remove_zone',
        auditInput: { deviceId }
      }, () => securityAlarmService.removeZone(deviceId));
      return toolSuccess('Removed security zone', { alarm });
    }
    case 'set_zone_bypass': {
      const deviceId = normalizeText(input.deviceId);
      if (!deviceId) {
        throw new Error('deviceId is required for security alarm set_zone_bypass');
      }
      if (typeof input.bypass !== 'boolean') {
        throw new Error('bypass must be provided for security alarm set_zone_bypass');
      }
      const alarm = await withMutationAudit(context, {
        tool: 'homebrain_security_alarm',
        operation: 'set_zone_bypass',
        auditInput: {
          deviceId,
          bypass: input.bypass
        }
      }, () => securityAlarmService.bypassZone(deviceId, input.bypass));
      return toolSuccess(`Updated bypass state for zone ${deviceId}`, { alarm });
    }
    default:
      throw new Error(`Unsupported security alarm operation: ${input.op}`);
  }
}

async function handleOperations(input) {
  switch (input.op) {
    case 'summary': {
      const summary = await eventStreamService.summary(input.windowMinutes || 60);
      return toolSuccess('Loaded event summary', { summary });
    }
    case 'latest': {
      const events = await eventStreamService.latest({
        limit: input.limit,
        types: Array.isArray(input.types) ? input.types : [],
        source: input.source || null,
        category: input.category || null,
        correlationId: input.correlationId || null
      });
      return toolSuccess(`Loaded ${events.length} latest events`, { events });
    }
    case 'replay': {
      const replay = await eventStreamService.replay({
        sinceSequence: input.sinceSequence || 0,
        limit: input.limit,
        types: Array.isArray(input.types) ? input.types : [],
        source: input.source || null,
        category: input.category || null,
        correlationId: input.correlationId || null
      });
      return toolSuccess('Loaded event replay', replay);
    }
    default:
      throw new Error(`Unsupported operations event operation: ${input.op}`);
  }
}

async function handleResources(input, context) {
  switch (input.op) {
    case 'utilization': {
      const utilization = await resourceMonitorService.getUtilization();
      return toolSuccess('Loaded current resource utilization', { utilization });
    }
    case 'history': {
      const history = resourceMonitorService.getHistory(input.limit || 100);
      return toolSuccess('Loaded resource history', { history });
    }
    case 'cpu': {
      const cpu = await resourceMonitorService.getCPUUsage();
      return toolSuccess('Loaded CPU usage', { cpu });
    }
    case 'memory': {
      const memory = resourceMonitorService.getMemoryUsage();
      return toolSuccess('Loaded memory usage', { memory });
    }
    case 'disk': {
      const disk = await resourceMonitorService.getDiskUsage();
      return toolSuccess('Loaded disk usage', { disk });
    }
    case 'gpu': {
      const gpu = await resourceMonitorService.getGPUUsage();
      return toolSuccess('Loaded GPU usage', { gpu });
    }
    case 'temperature': {
      const temperature = await resourceMonitorService.getTemperature();
      return toolSuccess('Loaded system temperature', { temperature });
    }
    case 'system_info': {
      const systemInfo = await resourceMonitorService.getSystemInfo();
      return toolSuccess('Loaded system information', { systemInfo });
    }
    case 'process': {
      const processInfo = await resourceMonitorService.getProcessInfo();
      return toolSuccess('Loaded process information', { processInfo });
    }
    case 'clear_history': {
      const result = await withMutationAudit(context, {
        tool: 'homebrain_resources',
        operation: 'clear_history',
        auditInput: {}
      }, () => resourceMonitorService.clearHistory());
      return toolSuccess('Cleared resource history', result);
    }
    default:
      throw new Error(`Unsupported resources operation: ${input.op}`);
  }
}

async function handlePlatformDeploy(input, context) {
  switch (input.op) {
    case 'presets': {
      const presets = platformDeployService.getDeployPresets();
      return toolSuccess('Loaded deploy presets', { presets });
    }
    case 'status': {
      const status = await getPlatformDeployStatusSnapshot();
      return toolSuccess('Loaded platform deploy status', status);
    }
    case 'health': {
      const health = await platformDeployService.getDeployHealth(context.app);
      return toolSuccess('Loaded platform deploy health', health);
    }
    case 'get_job': {
      const jobId = normalizeText(input.jobId);
      if (!jobId) {
        throw new Error('jobId is required for platform deploy get_job');
      }
      const job = await platformDeployService.readJob(jobId);
      return toolSuccess(`Loaded deployment job ${jobId}`, { job });
    }
    case 'run': {
      const options = input.options || {};
      const job = await withMutationAudit(context, {
        tool: 'homebrain_platform_deploy',
        operation: 'run',
        auditInput: { options }
      }, () => platformDeployService.startDeploy(options, context.actor));
      return toolSuccess('Started platform deployment', { job });
    }
    case 'restart_services': {
      await withMutationAudit(context, {
        tool: 'homebrain_platform_deploy',
        operation: 'restart_services',
        auditInput: {}
      }, () => platformDeployService.triggerServiceRestart(null, {
        actor: context.actor,
        source: 'openclaw'
      }));
      return toolSuccess('Queued platform service restart');
    }
    default:
      throw new Error(`Unsupported platform deploy operation: ${input.op}`);
  }
}

async function handleReverseProxy(input, context) {
  switch (input.op) {
    case 'status': {
      const status = await reverseProxyService.getStatus();
      return toolSuccess('Loaded reverse proxy status', status);
    }
    case 'list_routes': {
      const routes = await reverseProxyService.listRoutes();
      return toolSuccess(`Loaded ${routes.length} reverse proxy routes`, { routes });
    }
    case 'certificates': {
      const certificates = await reverseProxyService.getCertificates();
      return toolSuccess('Loaded reverse proxy certificates', { certificates });
    }
    case 'audit': {
      const auditLogs = await reverseProxyService.listAuditLogs(input.limit || 50);
      return toolSuccess('Loaded reverse proxy audit log', { auditLogs });
    }
    case 'create_route': {
      const route = await withMutationAudit(context, {
        tool: 'homebrain_reverse_proxy',
        operation: 'create_route',
        auditInput: { route: input.route || {} }
      }, () => reverseProxyService.createRoute(input.route || {}, context.actor));
      return toolSuccess('Created reverse proxy route', { route });
    }
    case 'update_route': {
      const routeId = normalizeText(input.routeId);
      if (!routeId) {
        throw new Error('routeId is required for reverse proxy update_route');
      }
      const route = await withMutationAudit(context, {
        tool: 'homebrain_reverse_proxy',
        operation: 'update_route',
        auditInput: {
          routeId,
          keys: Object.keys(input.route || {})
        }
      }, () => reverseProxyService.updateRoute(routeId, input.route || {}, context.actor));
      return toolSuccess(`Updated reverse proxy route ${routeId}`, { route });
    }
    case 'delete_route': {
      const routeId = normalizeText(input.routeId);
      if (!routeId) {
        throw new Error('routeId is required for reverse proxy delete_route');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_reverse_proxy',
        operation: 'delete_route',
        auditInput: { routeId }
      }, () => reverseProxyService.deleteRoute(routeId, context.actor));
      return toolSuccess(`Deleted reverse proxy route ${routeId}`, result);
    }
    case 'validate': {
      const routes = await withMutationAudit(context, {
        tool: 'homebrain_reverse_proxy',
        operation: 'validate',
        auditInput: {}
      }, () => reverseProxyService.validateAllRoutes(context.actor));
      return toolSuccess('Validated reverse proxy routes', { routes });
    }
    case 'apply': {
      const result = await withMutationAudit(context, {
        tool: 'homebrain_reverse_proxy',
        operation: 'apply',
        auditInput: {}
      }, () => reverseProxyService.applyConfig(context.actor));
      return toolSuccess('Applied reverse proxy configuration', result);
    }
    case 'update_settings': {
      const settings = await withMutationAudit(context, {
        tool: 'homebrain_reverse_proxy',
        operation: 'update_settings',
        auditInput: {
          keys: Object.keys(input.settings || {})
        }
      }, () => reverseProxyService.updateSettings(input.settings || {}, context.actor));
      return toolSuccess('Updated reverse proxy settings', { settings });
    }
    default:
      throw new Error(`Unsupported reverse proxy operation: ${input.op}`);
  }
}

async function handleSsl(input, context) {
  switch (input.op) {
    case 'status': {
      const status = await sslService.getSSLStatus();
      return toolSuccess('Loaded SSL status', status);
    }
    case 'list': {
      const certificates = await sslService.listCertificates();
      return toolSuccess(`Loaded ${certificates.length} SSL certificates`, { certificates });
    }
    case 'generate_csr': {
      const result = await withMutationAudit(context, {
        tool: 'homebrain_ssl',
        operation: 'generate_csr',
        auditInput: {
          commonName: input.payload?.commonName || null
        }
      }, () => sslService.generateCSR(input.payload || {}));
      return toolSuccess('Generated SSL CSR', result);
    }
    case 'upload': {
      const result = await withMutationAudit(context, {
        tool: 'homebrain_ssl',
        operation: 'upload',
        auditInput: {
          domain: input.payload?.domain || null,
          certificateId: input.payload?.certificateId || null
        }
      }, () => sslService.uploadCertificate(input.payload || {}));
      return toolSuccess('Uploaded SSL certificate', result);
    }
    case 'activate': {
      const certificateId = normalizeText(input.certificateId);
      if (!certificateId) {
        throw new Error('certificateId is required for SSL activate');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_ssl',
        operation: 'activate',
        auditInput: { certificateId }
      }, () => sslService.activateCertificate(certificateId));
      return toolSuccess(`Activated SSL certificate ${certificateId}`, result);
    }
    case 'deactivate': {
      const certificateId = normalizeText(input.certificateId);
      if (!certificateId) {
        throw new Error('certificateId is required for SSL deactivate');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_ssl',
        operation: 'deactivate',
        auditInput: { certificateId }
      }, () => sslService.deactivateCertificate(certificateId));
      return toolSuccess(`Deactivated SSL certificate ${certificateId}`, result);
    }
    case 'delete': {
      const certificateId = normalizeText(input.certificateId);
      if (!certificateId) {
        throw new Error('certificateId is required for SSL delete');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_ssl',
        operation: 'delete',
        auditInput: { certificateId }
      }, () => sslService.deleteCertificate(certificateId));
      return toolSuccess(`Deleted SSL certificate ${certificateId}`, result);
    }
    case 'setup_lets_encrypt': {
      const result = await withMutationAudit(context, {
        tool: 'homebrain_ssl',
        operation: 'setup_lets_encrypt',
        auditInput: {
          domain: input.payload?.domain || null,
          staging: input.payload?.staging === true
        }
      }, () => sslService.setupLetsEncrypt(input.payload || {}));
      return toolSuccess('Configured Let\'s Encrypt', result);
    }
    case 'renew_lets_encrypt': {
      const certificateId = normalizeText(input.certificateId);
      if (!certificateId) {
        throw new Error('certificateId is required for SSL renew_lets_encrypt');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_ssl',
        operation: 'renew_lets_encrypt',
        auditInput: { certificateId }
      }, () => sslService.renewLetsEncryptCertificate(certificateId));
      return toolSuccess(`Renewed Let\'s Encrypt certificate ${certificateId}`, result);
    }
    default:
      throw new Error(`Unsupported SSL operation: ${input.op}`);
  }
}

async function handleSettings(input, context) {
  switch (input.op) {
    case 'get': {
      const settings = await settingsService.getSanitizedSettings();
      return toolSuccess('Loaded HomeBrain settings', { settings });
    }
    case 'update': {
      const updates = input.settings || {};
      const settings = await withMutationAudit(context, {
        tool: 'homebrain_settings',
        operation: 'update',
        auditInput: {
          keys: Object.keys(updates)
        }
      }, () => settingsService.updateSettings(updates));
      return toolSuccess('Updated HomeBrain settings', {
        settings: typeof settings?.toSanitized === 'function' ? settings.toSanitized() : settings
      });
    }
    default:
      throw new Error(`Unsupported settings operation: ${input.op}`);
  }
}

async function handleUsers(input, context) {
  switch (input.op) {
    case 'list': {
      const users = await UserService.list();
      return toolSuccess(`Loaded ${users.length} users`, { users });
    }
    case 'get': {
      const user = await resolveUser(input);
      return toolSuccess(`Loaded user "${user.email}"`, { user });
    }
    case 'create': {
      const payload = input.user || {};
      const user = await withMutationAudit(context, {
        tool: 'homebrain_users',
        operation: 'create',
        auditInput: {
          email: payload.email || null,
          role: payload.role || null
        }
      }, () => UserService.create(payload));
      return toolSuccess(`Created user "${user.email}"`, { user });
    }
    case 'update': {
      const user = await resolveUser(input);
      const payload = input.user || {};
      const updatedUser = await withMutationAudit(context, {
        tool: 'homebrain_users',
        operation: 'update',
        auditInput: {
          userId: getEntityId(user),
          email: user.email,
          keys: Object.keys(payload)
        }
      }, () => UserService.updateUserDetails(getEntityId(user), payload));
      return toolSuccess(`Updated user "${updatedUser.email}"`, { user: updatedUser });
    }
    case 'delete': {
      const user = await resolveUser(input);
      const deleted = await withMutationAudit(context, {
        tool: 'homebrain_users',
        operation: 'delete',
        auditInput: {
          userId: getEntityId(user),
          email: user.email
        }
      }, () => UserService.delete(getEntityId(user)));
      return toolSuccess(`Deleted user "${user.email}"`, { deleted });
    }
    case 'reset_password': {
      const user = await resolveUser(input);
      const password = normalizeText(input.password);
      if (!password) {
        throw new Error('password is required for user reset_password');
      }
      await withMutationAudit(context, {
        tool: 'homebrain_users',
        operation: 'reset_password',
        auditInput: {
          userId: getEntityId(user),
          email: user.email
        }
      }, () => UserService.setPasswordById(getEntityId(user), password));
      return toolSuccess(`Reset password for "${user.email}"`);
    }
    default:
      throw new Error(`Unsupported users operation: ${input.op}`);
  }
}

async function handleVoice(input, context) {
  switch (input.op) {
    case 'list_devices': {
      const devices = await voiceDeviceService.getAllDevices();
      return toolSuccess(`Loaded ${devices.length} voice devices`, { devices });
    }
    case 'get_device': {
      const device = await resolveVoiceDevice(input);
      return toolSuccess(`Loaded voice device "${getEntityName(device)}"`, { device });
    }
    case 'status': {
      const status = await voiceDeviceService.getSystemStatus();
      return toolSuccess('Loaded voice system status', status);
    }
    case 'interpret_command': {
      const commandText = normalizeText(input.commandText);
      if (!commandText) {
        throw new Error('commandText is required for voice interpret_command');
      }
      const result = await withMutationAudit(context, {
        tool: 'homebrain_voice',
        operation: 'interpret_command',
        auditInput: {
          commandText,
          room: input.room || null,
          deviceId: input.deviceId || null
        }
      }, () => voiceCommandService.processCommand({
        commandText,
        room: normalizeText(input.room) || null,
        wakeWord: 'openclaw',
        deviceId: normalizeText(input.deviceId) || null,
        stt: null,
        userRole: 'admin'
      }));
      return toolSuccess(result?.message || 'Executed HomeBrain voice-style command', result);
    }
    default:
      throw new Error(`Unsupported voice operation: ${input.op}`);
  }
}

function buildOpenClawToolCatalog(context) {
  const tools = [
    {
      name: 'homebrain_overview',
      title: 'HomeBrain Overview',
      description: 'Read a high-level status snapshot across devices, workflows, automations, resources, security alarm, voice system, and deployment state.',
      inputSchema: {
        windowMinutes: z.number().int().positive().optional().describe('Operations summary window in minutes. Default: 60.')
      },
      execute: (input) => handleOverview(input, context)
    },
    {
      name: 'homebrain_devices',
      title: 'HomeBrain Devices',
      description: 'List, inspect, create, update, delete, control, or inspect energy history for HomeBrain devices.',
      inputSchema: {
        op: z.enum(['list', 'get', 'stats', 'by_room', 'energy_history', 'create', 'update', 'delete', 'control']),
        deviceId: z.string().optional(),
        deviceName: z.string().optional(),
        filters: jsonObjectSchema.optional().describe('Used with op=list. Supports fields like room, type, status, isOnline, and source.'),
        refresh: z.boolean().optional().describe('Used with op=list to refresh SmartThings-backed device state first.'),
        includeExcludedHarmony: z.boolean().optional(),
        device: jsonObjectSchema.optional().describe('Used with op=create or op=update.'),
        action: z.string().optional().describe('Used with op=control. Example: turn_on, turn_off, set_brightness, set_temperature, lock, unlock.'),
        value: z.unknown().optional().describe('Optional control value used with op=control.'),
        hours: z.number().positive().optional().describe('Used with op=energy_history.'),
        limit: z.number().int().positive().optional().describe('Used with op=energy_history.')
      },
      execute: (input) => handleDevices(input, context)
    },
    {
      name: 'homebrain_scenes',
      title: 'HomeBrain Scenes',
      description: 'List, inspect, create, update, delete, activate, or generate HomeBrain scenes from natural language.',
      inputSchema: {
        op: z.enum(['list', 'get', 'stats', 'create', 'create_from_text', 'update', 'delete', 'activate']),
        sceneId: z.string().optional(),
        sceneName: z.string().optional(),
        scene: jsonObjectSchema.optional().describe('Used with op=create or op=update.'),
        description: z.string().optional().describe('Used with op=create_from_text.')
      },
      execute: (input) => handleScenes(input, context)
    },
    {
      name: 'homebrain_workflows',
      title: 'HomeBrain Workflows',
      description: 'Manage HomeBrain workflows, including natural-language creation and revision, runtime history, enable/disable, and execution.',
      inputSchema: {
        op: z.enum(['list', 'get', 'stats', 'runtime_history', 'runtime_telemetry', 'running', 'create', 'update', 'delete', 'create_from_text', 'revise_from_text', 'set_enabled', 'execute']),
        workflowId: z.string().optional(),
        workflowName: z.string().optional(),
        workflow: jsonObjectSchema.optional().describe('Used with op=create or op=update.'),
        text: z.string().optional().describe('Used with op=create_from_text or op=revise_from_text.'),
        roomContext: z.string().optional(),
        enabled: z.boolean().optional().describe('Used with op=set_enabled.'),
        force: z.boolean().optional().describe('Used with op=execute.'),
        context: jsonObjectSchema.optional().describe('Optional execution context for op=execute.'),
        limit: z.number().int().positive().optional(),
        page: z.number().int().positive().optional(),
        hours: z.number().positive().optional()
      },
      execute: (input) => handleWorkflows(input, context)
    },
    {
      name: 'homebrain_automations',
      title: 'HomeBrain Automations',
      description: 'Manage standalone HomeBrain automations, including natural-language creation and revision, history, enable/disable, and execution.',
      inputSchema: {
        op: z.enum(['list', 'get', 'stats', 'history', 'execution_stats', 'create', 'update', 'delete', 'create_from_text', 'revise_from_text', 'set_enabled', 'execute']),
        automationId: z.string().optional(),
        automationName: z.string().optional(),
        automation: jsonObjectSchema.optional().describe('Used with op=create or op=update.'),
        text: z.string().optional().describe('Used with op=create_from_text or op=revise_from_text.'),
        roomContext: z.string().optional(),
        enabled: z.boolean().optional().describe('Used with op=set_enabled.'),
        context: jsonObjectSchema.optional().describe('Optional execution context for op=execute.'),
        limit: z.number().int().positive().optional(),
        dateRange: jsonObjectSchema.optional().describe('Used with op=execution_stats. Example: { start: ISODate, end: ISODate }.')
      },
      execute: (input) => handleAutomations(input, context)
    },
    {
      name: 'homebrain_security_alarm',
      title: 'HomeBrain Security Alarm',
      description: 'Inspect and control the HomeBrain security alarm, including arm/disarm, active alarm dismissal, and zone management.',
      inputSchema: {
        op: z.enum(['system', 'status', 'arm', 'disarm', 'dismiss', 'add_zone', 'remove_zone', 'set_zone_bypass']),
        mode: z.string().optional().describe('Used with op=arm. Must be "stay" or "away".'),
        refreshDoorLocks: z.boolean().optional().describe('Used with op=status.'),
        zone: jsonObjectSchema.optional().describe('Used with op=add_zone.'),
        deviceId: z.string().optional().describe('Used with op=remove_zone or op=set_zone_bypass.'),
        bypass: z.boolean().optional().describe('Used with op=set_zone_bypass.')
      },
      execute: (input) => handleSecurityAlarm(input, context)
    },
    {
      name: 'homebrain_operations',
      title: 'HomeBrain Operations',
      description: 'Read recent HomeBrain operational events, summaries, and replay windows from the Operations event stream.',
      inputSchema: {
        op: z.enum(['summary', 'latest', 'replay']),
        windowMinutes: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        sinceSequence: z.number().int().min(0).optional(),
        types: z.array(z.string()).optional(),
        source: z.string().optional(),
        category: z.string().optional(),
        correlationId: z.string().optional()
      },
      execute: (input) => handleOperations(input, context)
    },
    {
      name: 'homebrain_resources',
      title: 'HomeBrain Resources',
      description: 'Inspect system utilization on the HomeBrain host, including CPU, memory, disk, GPU, temperature, history, and process status.',
      inputSchema: {
        op: z.enum(['utilization', 'history', 'cpu', 'memory', 'disk', 'gpu', 'temperature', 'system_info', 'process', 'clear_history']),
        limit: z.number().int().positive().optional()
      },
      execute: (input) => handleResources(input, context)
    },
    {
      name: 'homebrain_platform_deploy',
      title: 'HomeBrain Platform Deploy',
      description: 'Inspect deployment status and health, run deployment presets, inspect jobs, or restart platform services.',
      inputSchema: {
        op: z.enum(['presets', 'status', 'health', 'get_job', 'run', 'restart_services']),
        jobId: z.string().optional(),
        options: jsonObjectSchema.optional().describe('Used with op=run. Supports preset, allowDirty, installDependencies, runServerTests, runClientLint, restartServices, and related deploy options.')
      },
      execute: (input) => handlePlatformDeploy(input, context)
    },
    {
      name: 'homebrain_reverse_proxy',
      title: 'HomeBrain Reverse Proxy',
      description: 'Inspect and manage HomeBrain reverse proxy routes, status, certificates, settings, validation, apply, and audit history.',
      inputSchema: {
        op: z.enum(['status', 'list_routes', 'certificates', 'audit', 'create_route', 'update_route', 'delete_route', 'validate', 'apply', 'update_settings']),
        routeId: z.string().optional(),
        route: jsonObjectSchema.optional().describe('Used with op=create_route or op=update_route.'),
        settings: jsonObjectSchema.optional().describe('Used with op=update_settings.'),
        limit: z.number().int().positive().optional().describe('Used with op=audit.')
      },
      execute: (input) => handleReverseProxy(input, context)
    },
    {
      name: 'homebrain_ssl',
      title: 'HomeBrain SSL',
      description: 'Inspect and manage SSL certificates, including CSR generation, manual upload, activation, deletion, and Let\'s Encrypt actions.',
      inputSchema: {
        op: z.enum(['status', 'list', 'generate_csr', 'upload', 'activate', 'deactivate', 'delete', 'setup_lets_encrypt', 'renew_lets_encrypt']),
        certificateId: z.string().optional(),
        payload: jsonObjectSchema.optional().describe('Used with op=generate_csr, op=upload, or op=setup_lets_encrypt.')
      },
      execute: (input) => handleSsl(input, context)
    },
    {
      name: 'homebrain_settings',
      title: 'HomeBrain Settings',
      description: 'Read or update admin-managed HomeBrain settings. Returned settings are sanitized for secrets.',
      inputSchema: {
        op: z.enum(['get', 'update']),
        settings: jsonObjectSchema.optional().describe('Used with op=update. Provide a partial settings object.')
      },
      execute: (input) => handleSettings(input, context)
    },
    {
      name: 'homebrain_users',
      title: 'HomeBrain Users',
      description: 'List, inspect, create, update, delete, or reset passwords for HomeBrain users.',
      inputSchema: {
        op: z.enum(['list', 'get', 'create', 'update', 'delete', 'reset_password']),
        userId: z.string().optional(),
        email: z.string().optional(),
        user: jsonObjectSchema.optional().describe('Used with op=create or op=update.'),
        password: z.string().optional().describe('Used with op=reset_password.')
      },
      execute: (input) => handleUsers(input, context)
    },
    {
      name: 'homebrain_voice',
      title: 'HomeBrain Voice',
      description: 'Inspect HomeBrain voice devices and status, or execute a HomeBrain-native voice-style command interpreter as an admin fallback.',
      inputSchema: {
        op: z.enum(['list_devices', 'get_device', 'status', 'interpret_command']),
        voiceDeviceId: z.string().optional(),
        voiceDeviceName: z.string().optional(),
        commandText: z.string().optional().describe('Used with op=interpret_command.'),
        room: z.string().optional(),
        deviceId: z.string().optional()
      },
      execute: (input) => handleVoice(input, context)
    }
  ];

  return tools.map((tool) => ({
    ...tool,
    handler: async (input = {}) => {
      try {
        return await tool.execute(input || {});
      } catch (error) {
        return toolError(error);
      }
    }
  }));
}

module.exports = {
  buildOpenClawToolCatalog
};
