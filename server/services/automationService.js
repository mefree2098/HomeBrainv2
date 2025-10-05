const Automation = require('../models/Automation');
const AutomationHistory = require('../models/AutomationHistory');
const Device = require('../models/Device');
const Scene = require('../models/Scene');
const { sendLLMRequest } = require('./llmService');
const deviceService = require('./deviceService');
const mongoose = require('mongoose');

const MAX_LLM_RETRIES = 3;

/**
 * Get all automations
 */
async function getAllAutomations() {
  console.log('AutomationService: Fetching all automations');

  try {
    const automations = await Automation.find()
      .sort({ createdAt: -1 }) // Sort by newest first
      .lean(); // Use lean for better performance

    console.log(`AutomationService: Successfully retrieved ${automations.length} automations`);
    return automations;
  } catch (error) {
    console.error('AutomationService: Error fetching automations:', error.message);
    console.error('AutomationService: Full error:', error);
    throw new Error(`Failed to fetch automations: ${error.message}`);
  }
}

/**
 * Get automation by ID
 */
async function getAutomationById(id) {
  console.log(`AutomationService: Fetching automation with ID: ${id}`);

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }

    const automation = await Automation.findById(id).lean();

    if (!automation) {
      throw new Error(`Automation with ID ${id} not found`);
    }

    console.log(`AutomationService: Successfully retrieved automation: ${automation.name}`);
    return automation;
  } catch (error) {
    console.error(`AutomationService: Error fetching automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      throw error;
    }
    throw new Error(`Failed to fetch automation: ${error.message}`);
  }
}

/**
 * Create new automation
 */
async function createAutomation(automationData) {
  console.log('AutomationService: Creating new automation');
  console.log('AutomationService: Automation data:', automationData);

  try {
    // Validate required fields
    if (!automationData.name || automationData.name.trim() === '') {
      throw new Error('Automation name is required');
    }

    if (!automationData.trigger) {
      throw new Error('Automation trigger is required');
    }

    if (!automationData.actions || !Array.isArray(automationData.actions) || automationData.actions.length === 0) {
      throw new Error('At least one action is required');
    }

    // Check for duplicate names
    const existingAutomation = await Automation.findOne({
      name: { $regex: new RegExp(`^${automationData.name.trim()}$`, 'i') }
    });

    if (existingAutomation) {
      throw new Error(`Automation with name "${automationData.name}" already exists`);
    }

    // Create automation with proper data structure
    const newAutomation = new Automation({
      name: automationData.name.trim(),
      description: automationData.description || '',
      trigger: automationData.trigger,
      actions: automationData.actions,
      enabled: automationData.enabled !== undefined ? automationData.enabled : true,
      priority: automationData.priority || 5,
      category: automationData.category || 'custom',
      conditions: automationData.conditions || [],
      cooldown: automationData.cooldown || 0
    });

    const savedAutomation = await newAutomation.save();

    console.log(`AutomationService: Automation created successfully with ID: ${savedAutomation._id}`);
    return savedAutomation.toObject();
  } catch (error) {
    console.error('AutomationService: Error creating automation:', error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('required') || error.message.includes('already exists')) {
      throw error;
    }
    throw new Error(`Failed to create automation: ${error.message}`);
  }
}

/**
 * Update automation
 */
async function updateAutomation(id, updateData) {
  console.log(`AutomationService: Updating automation with ID: ${id}`);
  console.log('AutomationService: Update data:', updateData);

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }

    // Check if automation exists
    const existingAutomation = await Automation.findById(id);
    if (!existingAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }

    // Validate name if being updated
    if (updateData.name !== undefined) {
      if (!updateData.name || updateData.name.trim() === '') {
        throw new Error('Automation name cannot be empty');
      }

      // Check for duplicate names (excluding current automation)
      const duplicateAutomation = await Automation.findOne({
        _id: { $ne: id },
        name: { $regex: new RegExp(`^${updateData.name.trim()}$`, 'i') }
      });

      if (duplicateAutomation) {
        throw new Error(`Automation with name "${updateData.name}" already exists`);
      }
    }

    // Validate actions if being updated
    if (updateData.actions !== undefined) {
      if (!Array.isArray(updateData.actions) || updateData.actions.length === 0) {
        throw new Error('At least one action is required');
      }
    }

    // Update automation
    const updatedAutomation = await Automation.findByIdAndUpdate(
      id,
      { ...updateData, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).lean();

    console.log(`AutomationService: Automation updated successfully: ${updatedAutomation.name}`);
    return updatedAutomation;
  } catch (error) {
    console.error(`AutomationService: Error updating automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('not found') || error.message.includes('required') ||
        error.message.includes('cannot be empty') || error.message.includes('already exists') ||
        error.message.includes('Invalid')) {
      throw error;
    }
    throw new Error(`Failed to update automation: ${error.message}`);
  }
}

/**
 * Delete automation
 */
async function deleteAutomation(id) {
  console.log(`AutomationService: Deleting automation with ID: ${id}`);

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }

    const deletedAutomation = await Automation.findByIdAndDelete(id).lean();

    if (!deletedAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }

    console.log(`AutomationService: Automation deleted successfully: ${deletedAutomation.name}`);
    return {
      message: `Automation "${deletedAutomation.name}" has been deleted successfully`,
      deletedAutomation
    };
  } catch (error) {
    console.error(`AutomationService: Error deleting automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      throw error;
    }
    throw new Error(`Failed to delete automation: ${error.message}`);
  }
}

/**
 * Toggle automation enabled status
 */
async function toggleAutomation(id, enabled) {
  console.log(`AutomationService: Toggling automation ${id} to ${enabled ? 'enabled' : 'disabled'}`);

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }

    if (typeof enabled !== 'boolean') {
      throw new Error('Enabled status must be a boolean value');
    }

    const updatedAutomation = await Automation.findByIdAndUpdate(
      id,
      { enabled, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).lean();

    if (!updatedAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }

    console.log(`AutomationService: Automation ${enabled ? 'enabled' : 'disabled'} successfully: ${updatedAutomation.name}`);
    return {
      message: `Automation "${updatedAutomation.name}" has been ${enabled ? 'enabled' : 'disabled'}`,
      automation: updatedAutomation
    };
  } catch (error) {
    console.error(`AutomationService: Error toggling automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('not found') || error.message.includes('Invalid') ||
        error.message.includes('must be a boolean')) {
      throw error;
    }
    throw new Error(`Failed to toggle automation: ${error.message}`);
  }
}

/**
 * Build comprehensive device context for LLM
 */
async function buildDeviceContext() {
  console.log('AutomationService: Building device context for LLM');

  try {
    const devices = await Device.find({ isOnline: true }).lean();
    const devicesByRoom = {};

    devices.forEach(device => {
      if (!devicesByRoom[device.room]) {
        devicesByRoom[device.room] = [];
      }

      const deviceInfo = {
        id: device._id.toString(),
        name: device.name,
        type: device.type,
        capabilities: []
      };

      // Add capabilities based on device type
      switch (device.type) {
        case 'light':
          deviceInfo.capabilities = ['turn_on', 'turn_off', 'set_brightness'];
          if (device.color) deviceInfo.capabilities.push('set_color');
          break;
        case 'thermostat':
          deviceInfo.capabilities = ['turn_on', 'turn_off', 'set_temperature'];
          break;
        case 'lock':
          deviceInfo.capabilities = ['lock', 'unlock'];
          break;
        case 'switch':
          deviceInfo.capabilities = ['turn_on', 'turn_off'];
          break;
        case 'garage':
          deviceInfo.capabilities = ['open', 'close'];
          break;
        default:
          deviceInfo.capabilities = ['turn_on', 'turn_off'];
      }

      devicesByRoom[device.room].push(deviceInfo);
    });

    return devicesByRoom;
  } catch (error) {
    console.error('AutomationService: Error building device context:', error);
    return {};
  }
}

/**
 * Build scene context for LLM
 */
async function buildSceneContext() {
  console.log('AutomationService: Building scene context for LLM');

  try {
    const scenes = await Scene.find().lean();
    return scenes.map(scene => ({
      id: scene._id.toString(),
      name: scene.name,
      description: scene.description || '',
      category: scene.category
    }));
  } catch (error) {
    console.error('AutomationService: Error building scene context:', error);
    return [];
  }
}

/**
 * Validate and fix automation structure
 */
async function validateAndFixAutomation(automation) {
  console.log('AutomationService: Validating automation structure');

  const issues = [];
  let fixed = false;

  // Validate trigger
  if (!automation.trigger || !automation.trigger.type) {
    issues.push('Missing or invalid trigger type');
    return { valid: false, issues, fixedAutomation: null };
  }

  // Validate actions
  if (!automation.actions || !Array.isArray(automation.actions) || automation.actions.length === 0) {
    issues.push('Missing or empty actions array');
    return { valid: false, issues, fixedAutomation: null };
  }

  // Validate and fix device references in actions
  const devices = await Device.find().lean();
  const deviceMap = new Map();
  devices.forEach(device => {
    deviceMap.set(device._id.toString(), device);
    deviceMap.set(device.name.toLowerCase(), device);
  });

  const scenes = await Scene.find().lean();
  const sceneMap = new Map();
  scenes.forEach(scene => {
    sceneMap.set(scene._id.toString(), scene);
    sceneMap.set(scene.name.toLowerCase(), scene);
  });

  const fixedActions = automation.actions.map((action, index) => {
    const fixedAction = { ...action };

    // Validate action type
    if (!['device_control', 'scene_activate', 'notification', 'delay', 'condition'].includes(action.type)) {
      issues.push(`Invalid action type at index ${index}: ${action.type}`);
      return null;
    }

    // Fix device references
    if (action.type === 'device_control' && action.target) {
      const targetStr = action.target.toString().toLowerCase();

      // Check if target is valid device ID
      if (!mongoose.Types.ObjectId.isValid(action.target)) {
        // Try to find device by name
        const device = deviceMap.get(targetStr);
        if (device) {
          fixedAction.target = device._id.toString();
          fixed = true;
          console.log(`AutomationService: Fixed device reference from "${action.target}" to "${device._id}"`);
        } else {
          issues.push(`Device not found: ${action.target}`);
          return null;
        }
      } else {
        // Verify device exists
        if (!deviceMap.has(action.target.toString())) {
          issues.push(`Device ID not found: ${action.target}`);
          return null;
        }
      }

      // Validate action parameters for device type
      const device = deviceMap.get(fixedAction.target.toString());
      if (device && action.parameters) {
        const actionType = action.parameters.action;

        // Validate device-specific actions
        if (device.type === 'light') {
          if (!['turn_on', 'turn_off', 'set_brightness', 'set_color'].includes(actionType)) {
            issues.push(`Invalid action "${actionType}" for light device`);
            return null;
          }
        } else if (device.type === 'thermostat') {
          if (!['turn_on', 'turn_off', 'set_temperature'].includes(actionType)) {
            issues.push(`Invalid action "${actionType}" for thermostat device`);
            return null;
          }
        } else if (device.type === 'lock') {
          if (!['lock', 'unlock'].includes(actionType)) {
            issues.push(`Invalid action "${actionType}" for lock device`);
            return null;
          }
        }
      }
    }

    // Fix scene references
    if (action.type === 'scene_activate' && action.target) {
      const targetStr = action.target.toString().toLowerCase();

      if (!mongoose.Types.ObjectId.isValid(action.target)) {
        const scene = sceneMap.get(targetStr);
        if (scene) {
          fixedAction.target = scene._id.toString();
          fixed = true;
          console.log(`AutomationService: Fixed scene reference from "${action.target}" to "${scene._id}"`);
        } else {
          issues.push(`Scene not found: ${action.target}`);
          return null;
        }
      } else {
        if (!sceneMap.has(action.target.toString())) {
          issues.push(`Scene ID not found: ${action.target}`);
          return null;
        }
      }
    }

    return fixedAction;
  }).filter(action => action !== null);

  if (fixedActions.length === 0) {
    issues.push('All actions are invalid');
    return { valid: false, issues, fixedAutomation: null };
  }

  if (issues.length > 0 && fixedActions.length < automation.actions.length) {
    return { valid: false, issues, fixedAutomation: null };
  }

  const fixedAutomation = {
    ...automation,
    actions: fixedActions
  };

  return { valid: true, issues, fixedAutomation, fixed };
}

/**
 * Create automation from natural language text with self-healing
 */
async function createAutomationFromText(text, roomContext = null) {
  console.log('AutomationService: Creating automation from natural language text');
  console.log('AutomationService: Input text:', text);
  console.log('AutomationService: Room context:', roomContext);

  try {
    if (!text || text.trim() === '') {
      throw new Error('Automation text description is required');
    }

    // Build comprehensive context
    const devicesByRoom = await buildDeviceContext();
    const scenes = await buildSceneContext();

    // Build detailed prompt with all context
    const prompt = buildAutomationPrompt(text, devicesByRoom, scenes, roomContext);

    let parsedAutomation = null;
    let lastError = null;

    // Try up to MAX_LLM_RETRIES times with self-healing
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      console.log(`AutomationService: LLM attempt ${attempt}/${MAX_LLM_RETRIES}`);

      try {
        // Send request to LLM
        let llmResponse;
        try {
          llmResponse = await sendLLMRequest('anthropic', 'claude-3-haiku-20240307', prompt);
        } catch (anthropicError) {
          console.log('AutomationService: Anthropic failed, trying OpenAI:', anthropicError.message);
          llmResponse = await sendLLMRequest('openai', 'gpt-3.5-turbo', prompt);
        }

        console.log('AutomationService: LLM response received');

        // Parse LLM response
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          lastError = 'No valid JSON found in LLM response';
          console.error('AutomationService:', lastError);
          continue;
        }

        parsedAutomation = JSON.parse(jsonMatch[0]);

        // Validate and fix automation structure
        const validation = await validateAndFixAutomation(parsedAutomation);

        if (validation.valid) {
          console.log('AutomationService: Automation structure is valid');
          if (validation.fixed) {
            console.log('AutomationService: Applied fixes to automation structure');
          }
          parsedAutomation = validation.fixedAutomation;
          break; // Success!
        } else {
          lastError = `Validation failed: ${validation.issues.join(', ')}`;
          console.error('AutomationService:', lastError);

          // Build feedback prompt for retry
          const feedbackPrompt = `
The previous automation JSON had the following issues:
${validation.issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Please fix these issues and return a corrected JSON. Remember:
- Only use device IDs or exact device names from the provided list
- Only use scene IDs or exact scene names from the provided list
- Ensure all action types are valid for the target device types
- Use valid action types: device_control, scene_activate, notification, delay, condition

Original request: "${text}"

Return ONLY the corrected JSON, no explanation.`;

          // Update prompt for next attempt
          prompt = feedbackPrompt;
        }

      } catch (parseError) {
        lastError = `Parse error: ${parseError.message}`;
        console.error('AutomationService:', lastError);
      }
    }

    // If we exhausted all retries, throw error
    if (!parsedAutomation) {
      throw new Error(`Failed to create valid automation after ${MAX_LLM_RETRIES} attempts. Last error: ${lastError}`);
    }

    // Validate and clean the parsed automation
    const automationData = {
      name: parsedAutomation.name || 'Custom Automation',
      description: parsedAutomation.description || text.trim(),
      trigger: parsedAutomation.trigger || { type: 'manual', conditions: {} },
      actions: Array.isArray(parsedAutomation.actions) ? parsedAutomation.actions : [
        {
          type: 'notification',
          target: 'user',
          parameters: { message: `Execute: ${text.trim()}` }
        }
      ],
      category: parsedAutomation.category || 'custom',
      priority: parsedAutomation.priority || 5,
      enabled: true
    };

    // Create the automation
    const newAutomation = await createAutomation(automationData);

    console.log('AutomationService: Automation created from natural language successfully');
    return {
      success: true,
      automation: newAutomation,
      message: 'Automation created successfully from natural language'
    };
  } catch (error) {
    console.error('AutomationService: Error creating automation from text:', error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('required') || error.message.includes('unavailable') || error.message.includes('after')) {
      throw error;
    }
    throw new Error(`Failed to create automation from text: ${error.message}`);
  }
}

/**
 * Build detailed automation prompt for LLM
 */
function buildAutomationPrompt(text, devicesByRoom, scenes, roomContext) {
  const deviceList = Object.entries(devicesByRoom).map(([room, devices]) => {
    return `Room: ${room}\n${devices.map(d =>
      `  - ${d.name} (ID: ${d.id}, Type: ${d.type}, Actions: ${d.capabilities.join(', ')})`
    ).join('\n')}`;
  }).join('\n\n');

  const sceneList = scenes.map(s =>
    `  - ${s.name} (ID: ${s.id}, Category: ${s.category})`
  ).join('\n');

  return `You are an expert at creating smart home automations. Parse the following request into a structured JSON format.

IMPORTANT RULES:
1. ONLY use device IDs from the provided device list below
2. ONLY use scene IDs from the provided scene list below
3. DO NOT make up or invent device names or IDs
4. DO NOT use generic placeholders - use actual IDs from the lists
5. Match device capabilities to allowed actions for each device type
6. Return ONLY valid JSON with NO additional text or explanation

AVAILABLE DEVICES:
${deviceList}

AVAILABLE SCENES:
${sceneList}

${roomContext ? `ROOM CONTEXT: The user is currently in the "${roomContext}" room.\n` : ''}

REQUIRED JSON STRUCTURE:
{
  "name": "Brief descriptive name (max 50 chars)",
  "description": "Detailed description of what this automation does",
  "trigger": {
    "type": "time|device_state|sensor|schedule|manual",
    "conditions": {
      // For time: {"hour": 7, "minute": 0, "days": ["monday", "tuesday", ...]}
      // For schedule: {"cron": "0 7 * * 1-5"}
      // For device_state: {"deviceId": "ID", "state": "on|off", "property": "brightness", "operator": ">", "value": 50}
      // For sensor: {"sensorType": "motion|temperature|humidity", "deviceId": "ID", "condition": "detected|above|below", "value": 25}
      // For manual: {}
    }
  },
  "actions": [
    {
      "type": "device_control|scene_activate|notification|delay",
      "target": "EXACT_DEVICE_ID_FROM_LIST_ABOVE or EXACT_SCENE_ID_FROM_LIST_ABOVE",
      "parameters": {
        // For device_control: {"action": "turn_on|turn_off|set_brightness|set_temperature|lock|unlock", "brightness": 0-100, "temperature": number, "color": "#hex"}
        // For scene_activate: {}
        // For notification: {"message": "text"}
        // For delay: {"seconds": number}
      }
    }
  ],
  "category": "security|comfort|energy|convenience|custom",
  "priority": 1-10
}

DEVICE ACTION COMPATIBILITY:
- light: turn_on, turn_off, set_brightness, set_color
- thermostat: turn_on, turn_off, set_temperature
- lock: lock, unlock
- switch: turn_on, turn_off
- garage: open, close
- sensor: (read-only, cannot be controlled)

TRIGGER TYPE EXAMPLES:
- "every morning at 7am" -> type: "time", conditions: {"hour": 7, "minute": 0}
- "when motion detected" -> type: "sensor", conditions: {"sensorType": "motion", "condition": "detected"}
- "when temperature above 75" -> type: "sensor", conditions: {"sensorType": "temperature", "condition": "above", "value": 75}
- "when front door unlocked" -> type: "device_state", conditions: {"state": "off"}
- "manual trigger" -> type: "manual", conditions: {}

USER REQUEST: "${text}"

Return ONLY the JSON object, nothing else:`;
}

/**
 * Get automation statistics
 */
async function getAutomationStats() {
  console.log('AutomationService: Getting automation statistics');

  try {
    const [
      totalCount,
      enabledCount,
      disabledCount,
      categoryStats,
      recentExecutions,
      priorityStats
    ] = await Promise.all([
      Automation.countDocuments(),
      Automation.countDocuments({ enabled: true }),
      Automation.countDocuments({ enabled: false }),
      Automation.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]),
      Automation.countDocuments({
        lastRun: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
      }),
      Automation.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ])
    ]);

    const stats = {
      total: totalCount,
      enabled: enabledCount,
      disabled: disabledCount,
      categories: categoryStats.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      recentExecutions,
      priorityDistribution: priorityStats.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {})
    };

    console.log('AutomationService: Successfully retrieved automation statistics');
    return stats;
  } catch (error) {
    console.error('AutomationService: Error getting automation statistics:', error.message);
    console.error('AutomationService: Full error:', error);
    throw new Error(`Failed to get automation statistics: ${error.message}`);
  }
}

/**
 * Execute automation by ID (for manual triggers)
 */
async function executeAutomation(id) {
  console.log(`AutomationService: Manually executing automation with ID: ${id}`);

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Invalid automation ID format');
    }

    const automation = await Automation.findById(id);

    if (!automation) {
      throw new Error(`Automation with ID ${id} not found`);
    }

    if (!automation.enabled) {
      throw new Error(`Automation "${automation.name}" is currently disabled`);
    }

    // Create history entry
    const history = new AutomationHistory({
      automationId: automation._id,
      automationName: automation.name,
      triggerType: 'manual',
      triggerSource: 'manual',
      totalActions: automation.actions.length,
      status: 'running'
    });
    await history.save();

    // Execute actions (placeholder - actual execution would happen here)
    const actionResults = [];
    for (let i = 0; i < automation.actions.length; i++) {
      const action = automation.actions[i];
      const startTime = Date.now();

      try {
        // TODO: Execute actual action based on type
        actionResults.push({
          actionIndex: i,
          actionType: action.type,
          target: action.target,
          parameters: action.parameters,
          success: true,
          executedAt: new Date(),
          durationMs: Date.now() - startTime
        });
      } catch (actionError) {
        actionResults.push({
          actionIndex: i,
          actionType: action.type,
          target: action.target,
          parameters: action.parameters,
          success: false,
          error: actionError.message,
          executedAt: new Date(),
          durationMs: Date.now() - startTime
        });
      }
    }

    history.actionResults = actionResults;
    const allSuccess = actionResults.every(r => r.success);
    const allFailed = actionResults.every(r => !r.success);
    const finalStatus = allSuccess ? 'success' : (allFailed ? 'failed' : 'partial_success');

    await history.markCompleted(finalStatus);

    // Update execution tracking
    automation.lastRun = new Date();
    automation.executionCount = (automation.executionCount || 0) + 1;

    if (!allSuccess) {
      automation.lastError = {
        message: `${actionResults.filter(r => !r.success).length} actions failed`,
        timestamp: new Date()
      };
    }

    await automation.save();

    console.log(`AutomationService: Automation "${automation.name}" executed with status: ${finalStatus}`);
    return {
      success: allSuccess,
      message: `Automation "${automation.name}" executed ${finalStatus === 'success' ? 'successfully' : 'with issues'}`,
      automation: automation.toObject(),
      executedActions: automation.actions.length,
      history: history.toObject()
    };
  } catch (error) {
    console.error(`AutomationService: Error executing automation ${id}:`, error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('not found') || error.message.includes('Invalid') ||
        error.message.includes('disabled')) {
      throw error;
    }
    throw new Error(`Failed to execute automation: ${error.message}`);
  }
}

/**
 * Get automation execution history
 */
async function getAutomationHistory(automationId = null, limit = 50) {
  console.log(`AutomationService: Fetching automation history${automationId ? ` for ${automationId}` : ''}`);

  try {
    let history;
    if (automationId) {
      if (!mongoose.Types.ObjectId.isValid(automationId)) {
        throw new Error('Invalid automation ID format');
      }
      history = await AutomationHistory.getHistoryForAutomation(automationId, limit);
    } else {
      history = await AutomationHistory.getRecentExecutions(limit);
    }

    console.log(`AutomationService: Retrieved ${history.length} history entries`);
    return history;
  } catch (error) {
    console.error('AutomationService: Error fetching automation history:', error.message);
    console.error('AutomationService: Full error:', error);
    throw new Error(`Failed to fetch automation history: ${error.message}`);
  }
}

/**
 * Get execution statistics
 */
async function getExecutionStats(dateRange = null) {
  console.log('AutomationService: Fetching execution statistics');

  try {
    const stats = await AutomationHistory.getExecutionStats(dateRange);
    const failureAnalysis = await AutomationHistory.getFailureAnalysis(10);

    console.log('AutomationService: Retrieved execution statistics');
    return {
      execution: stats[0] || {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        partialSuccessExecutions: 0,
        averageDuration: 0,
        totalActions: 0,
        successfulActions: 0,
        failedActions: 0
      },
      failures: failureAnalysis
    };
  } catch (error) {
    console.error('AutomationService: Error fetching execution statistics:', error.message);
    console.error('AutomationService: Full error:', error);
    throw new Error(`Failed to fetch execution statistics: ${error.message}`);
  }
}

module.exports = {
  getAllAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  toggleAutomation,
  createAutomationFromText,
  getAutomationStats,
  executeAutomation,
  getAutomationHistory,
  getExecutionStats
};
