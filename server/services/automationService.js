const Automation = require('../models/Automation');
const AutomationHistory = require('../models/AutomationHistory');
const Device = require('../models/Device');
const Scene = require('../models/Scene');
const { sendLLMRequestWithFallbackDetailed } = require('./llmService');
const deviceService = require('./deviceService');
const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const { executeActionSequence } = require('./workflowExecutionService');

const MAX_LLM_RETRIES = 3;
const MAX_DEVICE_PROMPT_ENTRIES = 40;
const MAX_SCENE_PROMPT_ENTRIES = 25;
const MIN_KEYWORD_LENGTH = 3;

const DEVICE_TYPE_HINTS = {
  light: ['light', 'lights', 'lamp', 'bulb'],
  switch: ['switch', 'outlet', 'plug'],
  thermostat: ['thermostat', 'temperature', 'heat', 'cool'],
  lock: ['lock', 'unlock', 'door'],
  garage: ['garage', 'door'],
  sensor: ['sensor', 'motion', 'door', 'window', 'temperature', 'humidity']
};

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

function buildFallbackAutomation(text, devicesByRoom, roomContext) {
  const devices = flattenDevices(devicesByRoom);
  if (!devices.length) {
    console.warn('AutomationService: Fallback builder has no devices to target');
    return null;
  }

  const bestDevice = findBestDeviceForText(text, devices, roomContext);
  if (!bestDevice) {
    console.warn('AutomationService: Fallback builder could not match a device to text');
    return null;
  }

  const inferred = inferDeviceActionFromText(text, bestDevice);
  if (!inferred) {
    console.warn('AutomationService: Fallback builder could not infer an action');
    return null;
  }

  const actionParameters = { action: inferred.action };
  if (typeof inferred.value === 'number') {
    if (inferred.action === 'set_brightness') {
      actionParameters.brightness = inferred.value;
    } else if (inferred.action === 'set_temperature') {
      actionParameters.temperature = inferred.value;
    }
  }
  if (inferred.color) {
    actionParameters.color = inferred.color;
  }

  const prettyAction = inferred.phrase || `${inferred.action.replace(/_/g, ' ')} ${bestDevice.name}`;
  const automationName = `Manual: ${bestDevice.name} ${inferred.action.replace(/_/g, ' ')}`;

  return {
    name: automationName.slice(0, 50),
    description: `Manual trigger to ${prettyAction}.`,
    trigger: { type: 'manual', conditions: {} },
    actions: [
      {
        type: 'device_control',
        target: bestDevice.id,
        parameters: actionParameters
      }
    ],
    category: 'convenience',
    priority: 5,
    enabled: true
  };
}

function flattenDevices(devicesByRoom) {
  const list = [];
  Object.entries(devicesByRoom || {}).forEach(([room, devices]) => {
    (devices || []).forEach((device) => {
      list.push({
        ...device,
        room
      });
    });
  });
  return list;
}

function extractKeywords(text) {
  if (!text) {
    return [];
  }
  return Array.from(new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token && token.length >= MIN_KEYWORD_LENGTH)
  ));
}

function scoreDeviceEntry(entry, keywordSet, normalizedText, roomContextLower) {
  let score = 1;
  const device = entry.device;
  const nameLower = (device.name || '').toLowerCase();
  const typeLower = (device.type || '').toLowerCase();
  const roomLower = (entry.room || '').toLowerCase();

  if (nameLower && normalizedText.includes(nameLower)) {
    score += 10;
  }

  keywordSet.forEach((token) => {
    if (!token || token.length < MIN_KEYWORD_LENGTH) {
      return;
    }
    if (nameLower && nameLower.includes(token)) {
      score += 4;
    }
    if (typeLower && typeLower.includes(token)) {
      score += 3;
    }
    if (roomLower && roomLower.includes(token)) {
      score += 2;
    }
  });

  if (typeLower && DEVICE_TYPE_HINTS[typeLower]) {
    DEVICE_TYPE_HINTS[typeLower].forEach((hint) => {
      if (keywordSet.has(hint) || normalizedText.includes(hint)) {
        score += 2;
      }
    });
  }

  if (roomLower && normalizedText.includes(roomLower)) {
    score += 4;
  }

  if (roomContextLower && roomLower && roomLower === roomContextLower) {
    score += 6;
  }

  return score;
}

function refineDeviceContextForPrompt(userText, devicesByRoom, roomContext) {
  const entries = [];
  Object.entries(devicesByRoom || {}).forEach(([roomName, devices]) => {
    (devices || []).forEach((device) => {
      entries.push({
        room: roomName,
        device,
        order: entries.length
      });
    });
  });

  if (entries.length <= MAX_DEVICE_PROMPT_ENTRIES) {
    return devicesByRoom;
  }

  const normalizedText = (userText || '').toLowerCase();
  const roomContextLower = roomContext ? roomContext.toLowerCase() : null;
  const keywordSet = new Set(extractKeywords(userText));

  const scoredEntries = entries.map((entry) => ({
    ...entry,
    score: scoreDeviceEntry(entry, keywordSet, normalizedText, roomContextLower)
  }));

  const sortedEntries = scoredEntries.slice().sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.order - b.order;
  });

  const selected = [];
  const seenIds = new Set();

  const addEntry = (entry) => {
    if (selected.length >= MAX_DEVICE_PROMPT_ENTRIES) {
      return;
    }
    const id = entry.device.id || (entry.device._id && entry.device._id.toString());
    if (!id || seenIds.has(id)) {
      return;
    }
    seenIds.add(id);
    selected.push(entry);
  };

  if (roomContextLower) {
    sortedEntries
      .filter((entry) => (entry.room || '').toLowerCase() === roomContextLower)
      .forEach(addEntry);
  }

  sortedEntries
    .filter((entry) => entry.score >= 6)
    .forEach(addEntry);

  for (const entry of sortedEntries) {
    if (selected.length >= MAX_DEVICE_PROMPT_ENTRIES) {
      break;
    }
    addEntry(entry);
  }

  if (!selected.length) {
    return devicesByRoom;
  }

  const trimmed = {};
  selected.forEach(({ room, device }) => {
    if (!trimmed[room]) {
      trimmed[room] = [];
    }
    trimmed[room].push(device);
  });

  return trimmed;
}

function refineSceneContextForPrompt(userText, scenes) {
  if (!Array.isArray(scenes) || scenes.length <= MAX_SCENE_PROMPT_ENTRIES) {
    return scenes;
  }

  const normalizedText = (userText || '').toLowerCase();
  const keywordSet = new Set(extractKeywords(userText));

  const scoredScenes = scenes.map((scene, index) => {
    const nameLower = (scene.name || '').toLowerCase();
    const categoryLower = (scene.category || '').toLowerCase();
    let score = 1;

    if (nameLower && normalizedText.includes(nameLower)) {
      score += 10;
    }

    keywordSet.forEach((token) => {
      if (nameLower.includes(token)) {
        score += 4;
      }
      if (categoryLower.includes(token)) {
        score += 2;
      }
    });

    if (categoryLower && normalizedText.includes(categoryLower)) {
      score += 2;
    }

    return { scene, score, index };
  });

  const sortedScenes = scoredScenes.slice().sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });

  const selected = [];
  const seenIds = new Set();

  const addScene = (entry) => {
    if (selected.length >= MAX_SCENE_PROMPT_ENTRIES) {
      return;
    }
    const id = entry.scene.id || entry.scene._id || (entry.scene._id && entry.scene._id.toString());
    if (!id || seenIds.has(id)) {
      return;
    }
    seenIds.add(id);
    selected.push(entry.scene);
  };

  sortedScenes
    .filter((entry) => entry.score > 1)
    .forEach(addScene);

  for (const entry of sortedScenes) {
    if (selected.length >= MAX_SCENE_PROMPT_ENTRIES) {
      break;
    }
    addScene(entry);
  }

  if (!selected.length) {
    return scenes.slice(0, MAX_SCENE_PROMPT_ENTRIES);
  }

  return selected;
}

function findBestDeviceForText(text, devices, roomContext) {
  const normalized = (text || '').toLowerCase();
  const preferredRoom = roomContext ? roomContext.toLowerCase() : null;
  let bestDevice = null;
  let bestScore = 0;

  for (const device of devices) {
    let score = 0;
    const nameLower = (device.name || '').toLowerCase();

    if (!nameLower) {
      continue;
    }

    if (normalized.includes(nameLower)) {
      score += 5;
    }

    const tokens = nameLower.split(/\s+/);
    tokens.forEach((token) => {
      if (token.length >= 3 && normalized.includes(token)) {
        score += 2;
      }
    });

    if (preferredRoom && device.room && device.room.toLowerCase() === preferredRoom) {
      score += 2.5;
    } else if (device.room && normalized.includes(device.room.toLowerCase())) {
      score += 1.5;
    }

    const typeLower = (device.type || '').toLowerCase();
    if (typeLower && normalized.includes(typeLower)) {
      score += 1;
    }

    if (normalized.includes('light') && typeLower === 'light') {
      score += 1.5;
    }
    if (normalized.includes('switch') && typeLower === 'switch') {
      score += 1.5;
    }
    if ((normalized.includes('thermostat') || normalized.includes('temperature')) && typeLower === 'thermostat') {
      score += 1.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestDevice = device;
    }
  }

  return bestScore > 0 ? bestDevice : null;
}

function inferDeviceActionFromText(text, device) {
  const normalized = (text || '').toLowerCase();
  const capabilities = new Set(device.capabilities || []);
  const result = {
    action: 'turn_on',
    value: null,
    color: null,
    phrase: ''
  };

  if (/unlock\b/.test(normalized) && capabilities.has('unlock')) {
    result.action = 'unlock';
    result.phrase = `unlock ${device.name}`;
  } else if (/lock\b/.test(normalized) && capabilities.has('lock')) {
    result.action = 'lock';
    result.phrase = `lock ${device.name}`;
  } else if (/\b(open|raise)\b/.test(normalized) && capabilities.has('open')) {
    result.action = 'open';
    result.phrase = `open ${device.name}`;
  } else if (/\b(close|shut)\b/.test(normalized) && capabilities.has('close')) {
    result.action = 'close';
    result.phrase = `close ${device.name}`;
  } else if (/\b(turn\s*off|switch\s*off|power\s*off|shut\s*off)\b/.test(normalized) && capabilities.has('turn_off')) {
    result.action = 'turn_off';
    result.phrase = `turn off ${device.name}`;
  } else if (/\b(dim\b|\bset\b.*brightness|\blower\b.*light)/.test(normalized) && capabilities.has('set_brightness')) {
    const percent = extractPercentage(normalized);
    result.action = 'set_brightness';
    result.value = percent != null ? percent : 30;
    result.phrase = `set ${device.name} brightness to ${result.value}%`;
  } else if (/\b(brighten|increase\b.*brightness)\b/.test(normalized) && capabilities.has('set_brightness')) {
    result.action = 'set_brightness';
    result.value = 80;
    result.phrase = `brighten ${device.name}`;
  } else if (/\b(set\b.*temperature|heat\b.*to|cool\b.*to)\b/.test(normalized) && capabilities.has('set_temperature')) {
    const temperature = extractNumber(normalized);
    if (temperature != null) {
      result.action = 'set_temperature';
      result.value = temperature;
      result.phrase = `set ${device.name} temperature to ${temperature}`;
    }
  } else {
    // Default action preferences
    if (/\boff\b/.test(normalized) && capabilities.has('turn_off')) {
      result.action = 'turn_off';
      result.phrase = `turn off ${device.name}`;
    } else if (capabilities.has('turn_on')) {
      result.action = 'turn_on';
      result.phrase = `turn on ${device.name}`;
    } else if (capabilities.size > 0) {
      const [firstCapability] = Array.from(capabilities);
      result.action = firstCapability;
      result.phrase = `${firstCapability.replace(/_/g, ' ')} ${device.name}`;
    } else {
      return null;
    }
  }

  // Ensure capability exists
  if (!capabilities.has(result.action)) {
    if (capabilities.has('turn_on') && result.action === 'turn_off') {
      result.action = 'turn_on';
    } else if (capabilities.has('turn_off') && result.action === 'turn_on') {
      result.action = 'turn_off';
    } else if (capabilities.size > 0) {
      result.action = Array.from(capabilities)[0];
    } else {
      return null;
    }
  }

  return result;
}

function extractPercentage(text) {
  const match = text.match(/(\d{1,3})\s*(?:percent|%)/);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      return Math.max(0, Math.min(100, value));
    }
  }
  return null;
}

function extractNumber(text) {
  const match = text.match(/(-?\d{1,3})(?:\s*degrees|\s*°|(?:\s*fahrenheit)?)?/);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function isLikelyImmediateCommand(text) {
  const normalized = (text || '').toLowerCase().trim();
  if (!normalized) {
    return false;
  }

  const automationIndicators = [
    'automation',
    'automations',
    'routine',
    'routines',
    'schedule',
    'scheduled',
    'scheduling',
    'timer',
    'timers',
    'reminder',
    'reminders',
    'every ',
    'each ',
    'per day',
    'per night',
    'weekday',
    'weekend'
  ];

  if (automationIndicators.some((indicator) => normalized.includes(indicator))) {
    return false;
  }

  const schedulePatterns = [
    /\b(at|around)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/,
    /\b\d{1,2}\s*(am|pm)\b/,
    /\b(in|after)\s+\d+\s+(minutes?|hours?|days?)\b/,
    /\bwhen\b\s+(?:the\s+)?/,
    /\bif\b\s+(?:the\s+)?/
  ];

  if (schedulePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const directActionPattern = /\b(turn|switch)\s+(on|off)\b|\b(dim|brighten)\b|\bset\s+(?:the\s+)?(?:brightness|temperature)\b|\b(lock|unlock)\b|\b(open|close)\b|\bactivate\s+\w+/;

  return directActionPattern.test(normalized);
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
      { returnDocument: 'after', runValidators: true }
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
      { returnDocument: 'after', runValidators: true }
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
    const devices = await Device.find().lean();
    const devicesByRoom = {};

    devices.forEach(device => {
      if (!devicesByRoom[device.room]) {
        devicesByRoom[device.room] = [];
      }

      const source = (device?.properties?.source || 'local').toString().toLowerCase();
      const deviceInfo = {
        id: device._id.toString(),
        name: device.name,
        type: device.type,
        source,
        hubIp: device?.properties?.harmonyHubIp || null,
        activityId: device?.properties?.harmonyActivityId || null,
        activityLabel: device?.properties?.harmonyActivityLabel || null,
        capabilities: []
      };

      if (source === 'harmony') {
        deviceInfo.capabilities = ['turn_on', 'turn_off', 'toggle'];
        devicesByRoom[device.room].push(deviceInfo);
        return;
      }

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
          deviceInfo.capabilities = ['turn_on', 'turn_off', 'toggle'];
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
    if (!['device_control', 'scene_activate', 'notification', 'delay', 'condition', 'workflow_control', 'variable_control', 'repeat', 'isy_network_resource', 'http_request'].includes(action.type)) {
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
    const flatDevices = flattenDevices(devicesByRoom);

    // For direct control requests like "turn on the vault light", bypass automation creation
    if (isLikelyImmediateCommand(text)) {
      const directDevice = findBestDeviceForText(text, flatDevices, roomContext);
      if (directDevice) {
        const inferredAction = inferDeviceActionFromText(text, directDevice);
        if (inferredAction?.action) {
          try {
            await deviceService.controlDevice(
              directDevice.id,
              inferredAction.action,
              inferredAction.value != null ? inferredAction.value : undefined
            );

            console.log(`AutomationService: Executed direct device action (${inferredAction.action}) on ${directDevice.name} instead of creating automation.`);
            return {
              success: true,
              automation: null,
              message: inferredAction.phrase || `Executed ${inferredAction.action} on ${directDevice.name}`,
              handledDirectCommand: true,
              device: {
                id: directDevice.id,
                name: directDevice.name,
                room: directDevice.room,
                action: inferredAction.action,
                value: inferredAction.value
              }
            };
          } catch (directError) {
            console.warn('AutomationService: Direct device execution failed, falling back to automation workflow:', directError.message);
          }
        } else {
          console.log('AutomationService: Immediate command detected but no actionable capability inferred; continuing with automation workflow.');
        }
      } else {
        console.log('AutomationService: Immediate command detected but no matching device found; continuing with automation workflow.');
      }
    }

    const promptDeviceContext = refineDeviceContextForPrompt(text, devicesByRoom, roomContext);
    const promptScenes = refineSceneContextForPrompt(text, scenes);
    const deviceListForPrompt = formatDeviceList(promptDeviceContext);
    const sceneListForPrompt = formatSceneList(promptScenes);

    const originalDeviceCount = flatDevices.length;
    const promptDeviceCount = flattenDevices(promptDeviceContext).length;
    if (promptDeviceCount < originalDeviceCount) {
      console.log(`AutomationService: Trimmed device context for LLM prompt (${originalDeviceCount} -> ${promptDeviceCount})`);
    }

    if (promptScenes.length < scenes.length) {
      console.log(`AutomationService: Trimmed scene context for LLM prompt (${scenes.length} -> ${promptScenes.length})`);
    }

    // Build detailed prompt with filtered context
    let prompt = buildAutomationPrompt(
      text,
      promptDeviceContext,
      promptScenes,
      roomContext,
      deviceListForPrompt,
      sceneListForPrompt
    );

    const settingsDoc = await Settings.getSettings();
    const defaultPriority = Array.isArray(settingsDoc.llmPriorityList) && settingsDoc.llmPriorityList.length
      ? settingsDoc.llmPriorityList
      : ['local', 'openai', 'anthropic'];
    let providerQueue = [...defaultPriority];
    let parsedAutomation = null;
    let lastError = null;
    let jsonReminderAdded = false;

    // Try up to MAX_LLM_RETRIES times with self-healing
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES && providerQueue.length; attempt++) {
      console.log(`AutomationService: LLM attempt ${attempt}/${MAX_LLM_RETRIES}`);

      let providerUsed = null;
      let modelUsed = null;

      try {
        // Send request to LLM with automatic fallback based on priority
        console.log('AutomationService: Sending request to LLM with fallback');
        const { response: llmResponse, provider, model } =
          await sendLLMRequestWithFallbackDetailed(prompt, providerQueue);
        providerUsed = provider ? provider.toLowerCase() : null;
        modelUsed = model || null;

        console.log('AutomationService: LLM response received');
        console.log('AutomationService: LLM Response Preview:', llmResponse.substring(0, 500));
        if (providerUsed) {
          console.log(`AutomationService: Response provided by ${providerUsed}${modelUsed ? ` (${modelUsed})` : ''}`);
        }

        // Parse LLM response
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          lastError = 'No valid JSON found in LLM response';
          console.error('AutomationService:', lastError);
          console.error('AutomationService: Full LLM Response:', llmResponse);
          if (providerUsed === 'local') {
            providerQueue = providerQueue.filter(
              (candidate) => candidate?.toLowerCase() !== providerUsed
            );
            console.warn(`AutomationService: Removing provider ${providerUsed} from queue due to malformed response`);
          } else if (providerUsed) {
            console.warn(`AutomationService: Provider ${providerUsed} returned malformed response; will retry after reinforcing instructions.`);
            if (!jsonReminderAdded) {
              prompt = `${prompt}\n\nREMINDER: Return ONLY the JSON object described above with all required fields.`;
              jsonReminderAdded = true;
            }
          }
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
          parsedAutomation = null;
          if (providerUsed === 'local') {
            providerQueue = providerQueue.filter(
              (candidate) => candidate?.toLowerCase() !== providerUsed
            );
            console.warn('AutomationService: Removing local provider after invalid automation payload');
          }

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

${roomContext ? `Room context: The user is currently in the "${roomContext}" room.\n` : ''}
AVAILABLE DEVICES:
${deviceListForPrompt || 'None'}

AVAILABLE SCENES:
${sceneListForPrompt || 'None'}

Return ONLY the corrected JSON, no explanation.`;

          // Update prompt for next attempt
          prompt = feedbackPrompt;
          continue;
        }

      } catch (parseError) {
        lastError = `Parse error: ${parseError.message}`;
        console.error('AutomationService:', lastError);
        if (providerUsed === 'local') {
          providerQueue = providerQueue.filter(
            (candidate) => candidate?.toLowerCase() !== providerUsed
          );
          console.warn(`AutomationService: Removing provider ${providerUsed} from queue due to parse error`);
        } else if (providerUsed) {
          console.warn(`AutomationService: Provider ${providerUsed} caused parse error; reinforcing JSON reminder for next attempt.`);
          if (!jsonReminderAdded) {
            prompt = `${prompt}\n\nREMINDER: Return ONLY the JSON object described above with all required fields.`;
            jsonReminderAdded = true;
          }
        }
      }
    }

    // If we exhausted all retries, throw error
    if (!parsedAutomation) {
      console.warn('AutomationService: Falling back to heuristic automation builder');
      parsedAutomation = buildFallbackAutomation(text, devicesByRoom, roomContext);
      if (!parsedAutomation) {
        throw new Error(`Failed to create valid automation after ${MAX_LLM_RETRIES} attempts. Last error: ${lastError}`);
      }
    }

    // Validate and clean the parsed automation
    let actions = Array.isArray(parsedAutomation.actions)
      ? parsedAutomation.actions.filter(Boolean)
      : null;

    if (!Array.isArray(actions) || actions.length === 0) {
      const fallbackAutomation = buildFallbackAutomation(text, devicesByRoom, roomContext);
      if (fallbackAutomation && Array.isArray(fallbackAutomation.actions) && fallbackAutomation.actions.length) {
        actions = fallbackAutomation.actions;
        parsedAutomation.trigger = parsedAutomation.trigger || fallbackAutomation.trigger;
        parsedAutomation.category = parsedAutomation.category || fallbackAutomation.category;
        parsedAutomation.priority = parsedAutomation.priority || fallbackAutomation.priority;
        parsedAutomation.description = parsedAutomation.description || fallbackAutomation.description;
      } else {
        throw new Error('At least one action is required');
      }
    }

    const automationData = {
      name: parsedAutomation.name || 'Custom Automation',
      description: parsedAutomation.description || text.trim(),
      trigger: parsedAutomation.trigger || { type: 'manual', conditions: {} },
      actions,
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

const AUTOMATION_JSON_TEMPLATE = `{
  "name": "Manual: Vault Light On",
  "description": "Manual trigger to turn on the vault light switch.",
  "trigger": {
    "type": "manual",
    "conditions": {}
  },
  "actions": [
    {
      "type": "device_control",
      "target": "<DEVICE_ID>",
      "parameters": {
        "action": "turn_on"
      }
    }
  ],
  "category": "convenience",
  "priority": 5
}`;

/**
 * Build detailed automation prompt for LLM
 */
function buildAutomationPrompt(text, devicesByRoom, scenes, roomContext, preformattedDeviceList, preformattedSceneList) {
  const deviceList = preformattedDeviceList ?? formatDeviceList(devicesByRoom);
  const sceneList = preformattedSceneList ?? formatSceneList(scenes);

  return `You are an expert at creating smart home automations. Convert the user's request into a JSON object that matches the schema below.

OUTPUT REQUIREMENTS (FOLLOW EXACTLY):
1. Return a single valid JSON object only. Do not include markdown, prose, comments, code fences, or additional explanations.
2. Every key must use double quotes. All string values must use double quotes.
3. The JSON must include the fields: name, description, trigger, actions, category, priority.
4. The trigger must include a "type" key and a "conditions" object (empty object is fine for manual triggers).
5. The actions array must contain at least one item. Each action must have "type", "target", and "parameters".
6. Choose device and scene identifiers strictly from the provided context. If no appropriate device exists, leave "actions" as an empty array and set "category" to "custom".
7. If the user's request cannot be fulfilled with the available devices/scenes, set "actions" to an empty array and use category "custom".
8. Respond with valid JSON even when uncertain; never omit required fields.

REQUIRED JSON TEMPLATE (values are examples, not literals to reuse):
${AUTOMATION_JSON_TEMPLATE}

IMPORTANT RULES:
1. ALWAYS return at least one action when the user is asking to control something. Simple requests (e.g., "turn on the vault light") must become a manual trigger with one device_control action.
2. Default the trigger to {"type": "manual", "conditions": {}} when no schedule or condition is provided.
3. ONLY use device IDs from the provided device list and scene IDs from the provided scene list. Never invent IDs or placeholders.
4. Match each action to the device's allowed capabilities and source restrictions.
5. Brightness values must be 0-100. Temperature values should be whole-number Fahrenheit unless specified otherwise.
6. Use intent-driven categories (choose from "security", "comfort", "energy", "convenience", "custom") and pick a sensible priority between 1-10 (default 5).
7. Never output any prefix/suffix text. Return ONLY the JSON object.
8. For devices with Source:harmony, only use turn_on, turn_off, or toggle. Do not use set_brightness, set_color, set_temperature, lock/unlock, or open/close on Harmony Hub activity devices.
9. For Source:harmony requests in schedules/workflows, prefer explicit turn_on or turn_off instead of toggle unless the user explicitly asks to toggle.

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
    "type": "<trigger_type>",  // choose one: time, device_state, sensor, schedule, manual
    "conditions": {
      // For time: {"hour": 7, "minute": 0, "days": ["monday", "tuesday", ...]}
      // For schedule: {"cron": "0 7 * * 1-5"}
      // For device_state: {"deviceId": "ID", "state": "on" or "off", "property": "brightness", "operator": ">", "value": 50}
      // For sensor: {"sensorType": "<sensor_type>", "deviceId": "ID", "condition": "<condition>", "value": 25}
      //   sensor_type options: motion, temperature, humidity
      //   condition options: detected, above, below
      // For manual: {}
    }
  },
  "actions": [
    {
      "type": "<action_type>",  // choose one: device_control, scene_activate, notification, delay
      "target": "DEVICE_ID_FROM_LIST_ABOVE or SCENE_ID_FROM_LIST_ABOVE",
      "parameters": {
        // For device_control: {"action": "<device_action>", "brightness": 0-100, "temperature": number, "color": "#hex"}
        // Valid device actions include: turn_on, turn_off, toggle, set_brightness, set_color, set_temperature, lock, unlock, open, close
        // For scene_activate: {}
        // For notification: {"message": "text"}
        // For delay: {"seconds": number}
      }
    }
  ],
  "category": "<category>",  // choose one: security, comfort, energy, convenience, custom
  "priority": 1-10
}

DEVICE ACTION COMPATIBILITY:
- light: turn_on, turn_off, set_brightness, set_color
- thermostat: turn_on, turn_off, set_temperature
- lock: lock, unlock
- switch: turn_on, turn_off, toggle
- harmony hub activity device (Source:harmony): turn_on, turn_off, toggle (activity start/stop only)
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

function formatDeviceList(devicesByRoom = {}) {
  const entries = Object.entries(devicesByRoom || {}).filter(([, devices]) =>
    Array.isArray(devices) && devices.length
  );

  if (!entries.length) {
    return 'None';
  }

  return entries.map(([room, devices]) => {
    const deviceLines = devices.map((device) => {
      const actions = Array.isArray(device.capabilities) && device.capabilities.length
        ? device.capabilities.join(', ')
        : 'None';
      const source = device.source || 'local';
      const harmonyDetails = source === 'harmony'
        ? `, Hub: ${device.hubIp || 'unknown'}, Activity: ${device.activityLabel || device.activityId || 'unknown'}`
        : '';
      return `  - ${device.name} (ID: ${device.id}, Type: ${device.type}, Source: ${source}, Actions: ${actions}${harmonyDetails})`;
    }).join('\n');

    return `Room: ${room}\n${deviceLines}`;
  }).join('\n\n');
}

function formatSceneList(scenes = []) {
  if (!Array.isArray(scenes) || !scenes.length) {
    return 'None';
  }

  return scenes.map((scene) =>
    `  - ${scene.name} (ID: ${scene.id}, Category: ${scene.category})`
  ).join('\n');
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
async function executeAutomation(id, options = {}) {
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

    const triggerType = options.triggerType || automation.trigger?.type || 'manual';
    const triggerSource = options.triggerSource || 'manual';

    // Create history entry
    const history = new AutomationHistory({
      automationId: automation._id,
      automationName: automation.name,
      triggerType,
      triggerSource,
      ...(options.voiceCommandId ? { voiceCommandId: options.voiceCommandId } : {}),
      totalActions: automation.actions.length,
      status: 'running'
    });
    await history.save();

    const execution = await executeActionSequence(automation.actions, {
      context: options.context || {}
    });
    const actionResults = execution.actionResults || [];
    const finalStatus = execution.status || 'failed';
    const allSuccess = finalStatus === 'success';

    history.actionResults = actionResults;
    await history.markCompleted(finalStatus);

    // Update execution tracking
    automation.lastRun = new Date();
    automation.executionCount = (automation.executionCount || 0) + 1;

    if (!allSuccess) {
      automation.lastError = {
        message: `${execution.failedActions || actionResults.filter((r) => !r.success).length} actions failed`,
        timestamp: new Date()
      };
    } else {
      automation.lastError = undefined;
    }

    await automation.save();

    console.log(`AutomationService: Automation "${automation.name}" executed with status: ${finalStatus}`);
    return {
      success: allSuccess,
      message: `Automation "${automation.name}" executed ${finalStatus === 'success' ? 'successfully' : 'with issues'}`,
      automation: automation.toObject(),
      executedActions: automation.actions.length,
      successfulActions: execution.successfulActions,
      failedActions: execution.failedActions,
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
