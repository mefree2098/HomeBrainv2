const crypto = require('crypto');
const Automation = require('../models/Automation');
const AutomationHistory = require('../models/AutomationHistory');
const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const Scene = require('../models/Scene');
const Workflow = require('../models/Workflow');
const { sendLLMRequestWithFallbackDetailed } = require('./llmService');
const deviceService = require('./deviceService');
const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const { executeActionSequence, getActionTargetCandidate } = require('./workflowExecutionService');
const automationRuntimeService = require('./automationRuntimeService');

const MAX_LLM_RETRIES = 3;
const MAX_DEVICE_PROMPT_ENTRIES = 40;
const MAX_SCENE_PROMPT_ENTRIES = 25;
const MIN_KEYWORD_LENGTH = 3;
const MAX_AUTOMATIONS_PER_REQUEST = 12;
const VALID_TRIGGER_TYPES = new Set(['time', 'device_state', 'weather', 'location', 'sensor', 'schedule', 'manual', 'security_alarm_status']);
const VALID_SECURITY_ALARM_STATES = new Set(['disarmed', 'armedStay', 'armedAway', 'triggered', 'arming', 'disarming']);
const VALID_SOLAR_SCHEDULE_EVENTS = new Set(['sunrise', 'sunset']);
const DYNAMIC_TARGET_CONTEXT_KEYS = new Set(['triggeringDeviceId']);
const DEVICE_GROUP_TARGET_KINDS = new Set(['device_group', 'group']);

const DEVICE_TYPE_HINTS = {
  light: ['light', 'lights', 'lamp', 'bulb'],
  switch: ['switch', 'outlet', 'plug'],
  thermostat: ['thermostat', 'temperature', 'heat', 'cool'],
  lock: ['lock', 'unlock', 'door'],
  garage: ['garage', 'door'],
  sensor: ['sensor', 'motion', 'door', 'window', 'temperature', 'humidity']
};

function sanitizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeDeviceGroupNames(groups) {
  const values = Array.isArray(groups)
    ? groups
    : typeof groups === 'string'
      ? groups.split(',')
      : [];
  const seen = new Set();
  const normalized = [];

  values.forEach((entry) => {
    const trimmed = sanitizeString(typeof entry === 'string' ? entry : String(entry || ''));
    if (!trimmed) {
      return;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    normalized.push(trimmed);
  });

  return normalized;
}

function getWorkflowCapabilitiesForDevice(device = {}) {
  const source = sanitizeString(device?.properties?.source || 'local').toLowerCase();

  if (source === 'harmony') {
    return ['turn_on', 'turn_off', 'toggle'];
  }

  switch (sanitizeString(device.type).toLowerCase()) {
    case 'light':
      return device.color
        ? ['turn_on', 'turn_off', 'set_brightness', 'set_color']
        : ['turn_on', 'turn_off', 'set_brightness'];
    case 'thermostat':
      return ['turn_on', 'turn_off', 'set_temperature'];
    case 'lock':
      return ['lock', 'unlock'];
    case 'switch':
      return ['turn_on', 'turn_off', 'toggle'];
    case 'speaker':
      return ['turn_on', 'turn_off', 'toggle'];
    case 'garage':
      return ['open', 'close'];
    default:
      return ['turn_on', 'turn_off'];
  }
}

function collectDeviceGroups(devices = [], persistedGroups = []) {
  const groupMap = new Map();

  const ensureEntry = (name, metadata = {}) => {
    const trimmedName = sanitizeString(name);
    if (!trimmedName) {
      return null;
    }

    const key = trimmedName.toLowerCase();
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        name: trimmedName,
        description: sanitizeString(metadata.description),
        persistedId: metadata.persistedId || null,
        devices: [],
        rooms: new Set(),
        sources: new Set(),
        types: new Set()
      });
    }

    const entry = groupMap.get(key);
    if (metadata.persistedId && !entry.persistedId) {
      entry.persistedId = metadata.persistedId;
    }
    if (metadata.description && !entry.description) {
      entry.description = sanitizeString(metadata.description);
    }

    return entry;
  };

  persistedGroups.forEach((group) => {
    ensureEntry(group?.name, {
      description: group?.description || '',
      persistedId: group?._id?.toString?.() || null
    });
  });

  devices.forEach((device) => {
    const groups = normalizeDeviceGroupNames(device?.groups);
    groups.forEach((group) => {
      const entry = ensureEntry(group);
      if (!entry) {
        return;
      }
      entry.devices.push(device);
      if (device?.room) {
        entry.rooms.add(device.room);
      }
      if (device?.type) {
        entry.types.add(device.type);
      }
      const source = sanitizeString(device?.source || device?.properties?.source || 'local').toLowerCase();
      if (source) {
        entry.sources.add(source);
      }
    });
  });

  return [...groupMap.values()]
    .map((entry) => ({
      name: entry.name,
      description: entry.description || '',
      deviceCount: entry.devices.length,
      deviceIds: entry.devices
        .map((device) => device.id || device?._id?.toString?.() || null)
        .filter(Boolean),
      deviceNames: entry.devices
        .map((device) => sanitizeString(device.name))
        .filter(Boolean),
      rooms: [...entry.rooms].sort((left, right) => left.localeCompare(right)),
      sources: [...entry.sources].sort((left, right) => left.localeCompare(right)),
      types: [...entry.types].sort((left, right) => left.localeCompare(right))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeSecurityAlarmState(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'disarm':
    case 'disarmed':
      return 'disarmed';
    case 'stay':
    case 'armedstay':
    case 'armed_stay':
    case 'armed stay':
      return 'armedStay';
    case 'away':
    case 'armedaway':
    case 'armed_away':
    case 'armed away':
      return 'armedAway';
    case 'trigger':
    case 'triggered':
      return 'triggered';
    case 'arming':
      return 'arming';
    case 'disarming':
      return 'disarming';
    default:
      return null;
  }
}

function normalizeSolarScheduleEvent(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (VALID_SOLAR_SCHEDULE_EVENTS.has(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeTriggerConditions(type, conditions) {
  const safeConditions = conditions && typeof conditions === 'object' && !Array.isArray(conditions)
    ? { ...conditions }
    : {};

  if (type === 'schedule') {
    const event = normalizeSolarScheduleEvent(safeConditions.event || safeConditions.sunEvent);
    const days = Array.isArray(safeConditions.days)
      ? safeConditions.days.map((value) => String(value).trim()).filter(Boolean)
      : undefined;

    if (event) {
      const normalized = {
        event,
        offset: Number.isFinite(Number(safeConditions.offset)) ? Math.round(Number(safeConditions.offset)) : 0
      };
      if (days && days.length) {
        normalized.days = days;
      }
      return normalized;
    }

    const cron = sanitizeString(safeConditions.cron);
    const normalized = cron ? { cron } : {};
    if (days && days.length) {
      normalized.days = days;
    }
    return normalized;
  }

  if (type !== 'security_alarm_status') {
    return safeConditions;
  }

  const rawStates = Array.isArray(safeConditions.states)
    ? safeConditions.states
    : [safeConditions.state, safeConditions.status, safeConditions.value].filter((value) => value != null);
  const states = Array.from(new Set(rawStates
    .map((value) => normalizeSecurityAlarmState(String(value)))
    .filter(Boolean)));

  return { states };
}

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isContextTargetReference(value, allowedKeys = DYNAMIC_TARGET_CONTEXT_KEYS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const kind = sanitizeString(value.kind || value.type).toLowerCase();
  const key = sanitizeString(value.key || value.contextKey);
  if (kind !== 'context' || !key) {
    return false;
  }

  if (!allowedKeys) {
    return true;
  }

  return allowedKeys.has(key);
}

function normalizeDynamicActionTarget(target) {
  if (!isContextTargetReference(target)) {
    return null;
  }

  return {
    kind: 'context',
    key: sanitizeString(target.key || target.contextKey)
  };
}

function normalizeDeviceGroupTarget(target, groupMap = null) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return null;
  }

  const kind = sanitizeString(target.kind || target.type).toLowerCase();
  if (!DEVICE_GROUP_TARGET_KINDS.has(kind)) {
    return null;
  }

  const requestedGroup = sanitizeString(target.group || target.name || target.label || target.value);
  if (!requestedGroup) {
    return null;
  }

  const canonicalGroup = groupMap?.get(requestedGroup.toLowerCase()) || requestedGroup;
  return {
    kind: 'device_group',
    group: canonicalGroup
  };
}

function extractAutomationCandidates(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }

  if (Array.isArray(payload.automations)) {
    return payload.automations.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  }

  if (payload.automation && typeof payload.automation === 'object' && !Array.isArray(payload.automation)) {
    return [payload.automation];
  }

  if (payload.name || payload.trigger || payload.actions) {
    return [payload];
  }

  return [];
}

function standaloneAutomationFilter(extra = {}) {
  return {
    ...extra,
    workflowId: null
  };
}

function isWorkflowManagedAutomation(automation) {
  return Boolean(automation?.workflowId);
}

function assertStandaloneAutomationForRead(automation, id) {
  if (!automation || isWorkflowManagedAutomation(automation)) {
    throw new Error(`Automation with ID ${id} not found`);
  }
}

function assertStandaloneAutomationForMutation(automation) {
  if (isWorkflowManagedAutomation(automation)) {
    throw new Error('This automation is managed by a workflow. Edit it from Workflows instead.');
  }
}

async function listStandaloneAutomationIds() {
  const automations = await Automation.find(standaloneAutomationFilter())
    .select('_id')
    .lean();

  return automations.map((automation) => automation._id);
}

function buildEmptyExecutionSummary() {
  return {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    partialSuccessExecutions: 0,
    averageDuration: 0,
    totalActions: 0,
    successfulActions: 0,
    failedActions: 0
  };
}

function buildExecutionStatsMatch(automationIds, dateRange = null) {
  const match = {
    automationId: { $in: automationIds }
  };

  if (dateRange) {
    match.startedAt = {
      $gte: new Date(dateRange.start),
      $lte: new Date(dateRange.end)
    };
  }

  return match;
}

function getSmartThingsWorkflowPropertyHints(device) {
  const hints = [];
  const seen = new Set();

  const pushHint = (hint) => {
    if (typeof hint !== 'string' || !hint.trim()) {
      return;
    }
    const normalized = hint.trim();
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    hints.push(normalized);
  };

  pushHint('status');
  pushHint('isOnline');

  if (typeof device?.brightness === 'number') {
    pushHint('brightness');
  }
  if (typeof device?.temperature === 'number') {
    pushHint('temperature');
  }
  if (typeof device?.targetTemperature === 'number') {
    pushHint('targetTemperature');
  }

  const attributeRoot = device?.properties?.smartThingsAttributeValues || {};

  const walk = (node, prefix = []) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }

    Object.entries(node).forEach(([key, value]) => {
      if (key === 'byComponent') {
        Object.entries(value || {}).forEach(([componentId, componentValue]) => {
          if (componentId === 'main') {
            return;
          }
          walk(componentValue, [...prefix, key, componentId]);
        });
        return;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, [...prefix, key]);
        return;
      }

      const propertyPath = ['smartThingsAttributeValues', ...prefix, key].join('.');
      pushHint(propertyPath);
    });
  };

  walk(attributeRoot);

  return hints;
}

function getSmartThingsEnergyMonitoringHints(device) {
  const hints = [];
  const attributeRoot = device?.properties?.smartThingsAttributeValues || {};

  if (Object.prototype.hasOwnProperty.call(attributeRoot?.powerMeter || {}, 'power')) {
    hints.push('power level via smartThingsAttributeValues.powerMeter.power');
  }

  if (Object.prototype.hasOwnProperty.call(attributeRoot?.energyMeter || {}, 'energy')) {
    hints.push('energy total via smartThingsAttributeValues.energyMeter.energy');
  }

  return hints;
}

/**
 * Get all automations
 */
async function getAllAutomations() {
  console.log('AutomationService: Fetching all automations');

  try {
    const automations = await Automation.find(standaloneAutomationFilter())
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
    'sunrise',
    'sunset',
    'timer',
    'timers',
    'reminder',
    'reminders',
    'every ',
    'every day',
    'each ',
    'each day',
    'daily',
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

    assertStandaloneAutomationForRead(automation, id);

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

async function ensureUniqueAutomationName(name, reservedNames = new Set()) {
  const normalizedBase = sanitizeString(name) || 'Custom Automation';
  let candidate = normalizedBase;
  let counter = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const reserved = reservedNames.has(candidate.toLowerCase());
    const existing = await Automation.findOne({
      name: { $regex: new RegExp(`^${escapeRegexLiteral(candidate)}$`, 'i') }
    }).select('_id');

    if (!reserved && !existing) {
      return candidate;
    }

    candidate = `${normalizedBase} (${counter})`;
    counter += 1;
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
    assertStandaloneAutomationForMutation(existingAutomation);

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

    const existingAutomation = await Automation.findById(id);
    if (!existingAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }
    assertStandaloneAutomationForMutation(existingAutomation);

    const deletedAutomation = await Automation.findByIdAndDelete(id).lean();

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

    const existingAutomation = await Automation.findById(id);
    if (!existingAutomation) {
      throw new Error(`Automation with ID ${id} not found`);
    }
    assertStandaloneAutomationForMutation(existingAutomation);

    const updatedAutomation = await Automation.findByIdAndUpdate(
      id,
      { enabled, updatedAt: Date.now() },
      { returnDocument: 'after', runValidators: true }
    ).lean();

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
        groups: normalizeDeviceGroupNames(device.groups),
        hubIp: device?.properties?.harmonyHubIp || null,
        activityId: device?.properties?.harmonyActivityId || null,
        activityLabel: device?.properties?.harmonyActivityLabel || null,
        capabilities: getWorkflowCapabilitiesForDevice(device),
        workflowProperties: getSmartThingsWorkflowPropertyHints(device),
        energyMonitoringHints: getSmartThingsEnergyMonitoringHints(device)
      };

      devicesByRoom[device.room].push(deviceInfo);
    });

    return devicesByRoom;
  } catch (error) {
    console.error('AutomationService: Error building device context:', error);
    return {};
  }
}

async function buildDeviceGroupContext(devicesByRoom = {}) {
  let persistedGroups = [];
  try {
    persistedGroups = await DeviceGroup.find().sort({ name: 1 }).lean();
  } catch (error) {
    console.warn(`AutomationService: Unable to load persisted device groups: ${error.message}`);
  }

  return collectDeviceGroups(flattenDevices(devicesByRoom), persistedGroups);
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

  const triggerType = typeof automation.trigger.type === 'string'
    ? automation.trigger.type.trim()
    : '';
  if (!VALID_TRIGGER_TYPES.has(triggerType)) {
    issues.push(`Invalid trigger type: ${automation.trigger.type}`);
    return { valid: false, issues, fixedAutomation: null };
  }

  const fixedTrigger = {
    ...automation.trigger,
    type: triggerType,
    conditions: normalizeTriggerConditions(triggerType, automation.trigger.conditions)
  };

  if (triggerType === 'security_alarm_status') {
    const states = Array.isArray(fixedTrigger.conditions?.states) ? fixedTrigger.conditions.states : [];
    if (!states.length) {
      issues.push('Security alarm triggers require at least one target state');
      return { valid: false, issues, fixedAutomation: null };
    }

    const invalidStates = states.filter((state) => !VALID_SECURITY_ALARM_STATES.has(state));
    if (invalidStates.length) {
      issues.push(`Invalid security alarm state(s): ${invalidStates.join(', ')}`);
      return { valid: false, issues, fixedAutomation: null };
    }
  }

  if (triggerType === 'schedule') {
    const scheduleConditions = fixedTrigger.conditions || {};
    const solarEvent = normalizeSolarScheduleEvent(scheduleConditions.event || scheduleConditions.sunEvent);
    const cron = sanitizeString(scheduleConditions.cron);

    if (solarEvent) {
      fixedTrigger.conditions = {
        ...scheduleConditions,
        event: solarEvent,
        offset: Number.isFinite(Number(scheduleConditions.offset))
          ? Math.round(Number(scheduleConditions.offset))
          : 0
      };
    } else if (cron) {
      fixedTrigger.conditions = {
        ...scheduleConditions,
        cron
      };
    } else {
      issues.push('Schedule triggers require either a cron expression or event "sunrise"/"sunset"');
      return { valid: false, issues, fixedAutomation: null };
    }
  }

  // Validate actions
  if (!automation.actions || !Array.isArray(automation.actions) || automation.actions.length === 0) {
    issues.push('Missing or empty actions array');
    return { valid: false, issues, fixedAutomation: null };
  }

  // Validate and fix device references in actions
  const devices = await Device.find().lean();
  const deviceMap = new Map();
  const groupMap = new Map();
  const groupMembersMap = new Map();
  devices.forEach(device => {
    deviceMap.set(device._id.toString(), device);
    deviceMap.set(device.name.toLowerCase(), device);
    normalizeDeviceGroupNames(device.groups).forEach((group) => {
      const key = group.toLowerCase();
      if (!groupMap.has(key)) {
        groupMap.set(key, group);
      }
      if (!groupMembersMap.has(key)) {
        groupMembersMap.set(key, []);
      }
      groupMembersMap.get(key).push(device);
    });
  });

  try {
    const persistedGroups = await DeviceGroup.find().lean();
    persistedGroups.forEach((group) => {
      const key = normalizeDeviceGroupNames([group.name])[0]?.toLowerCase();
      if (key && !groupMap.has(key)) {
        groupMap.set(key, group.name);
      }
      if (key && !groupMembersMap.has(key)) {
        groupMembersMap.set(key, []);
      }
    });
  } catch (error) {
    console.warn(`AutomationService: Unable to load device group registry during validation: ${error.message}`);
  }

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
    if (action.type === 'device_control') {
      const dynamicTarget = normalizeDynamicActionTarget(action.target);
      const groupTarget = normalizeDeviceGroupTarget(action.target, groupMap);
      if (dynamicTarget) {
        fixedAction.target = dynamicTarget;
        if (JSON.stringify(dynamicTarget) !== JSON.stringify(action.target)) {
          fixed = true;
        }
      } else if (groupTarget) {
        fixedAction.target = groupTarget;
        if (JSON.stringify(groupTarget) !== JSON.stringify(action.target)) {
          fixed = true;
        }
      } else if (!action.target) {
        issues.push(`Device target missing at index ${index}`);
        return null;
      } else {
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
            const groupName = groupMap.get(targetStr);
            if (groupName) {
              fixedAction.target = {
                kind: 'device_group',
                group: groupName
              };
              fixed = true;
              console.log(`AutomationService: Fixed group reference from "${action.target}" to device group "${groupName}"`);
            } else {
              issues.push(`Device or device group not found: ${action.target}`);
              return null;
            }
          }
        } else {
          // Verify device exists
          if (!deviceMap.has(action.target.toString())) {
            issues.push(`Device ID not found: ${action.target}`);
            return null;
          }
        }

      }

      // Validate action parameters for device type
      const device = typeof fixedAction.target === 'string'
        ? deviceMap.get(fixedAction.target.toString())
        : null;
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
      } else if (fixedAction.target && typeof fixedAction.target === 'object' && action.parameters) {
        const normalizedGroupTarget = normalizeDeviceGroupTarget(fixedAction.target, groupMap);
        if (!normalizedGroupTarget) {
          return fixedAction;
        }
        const groupName = sanitizeString(normalizedGroupTarget?.group);
        const members = groupMembersMap.get(groupName.toLowerCase()) || [];
        if (!members.length) {
          issues.push(`Device group not found: ${groupName || 'unknown group'}`);
          return null;
        }

        const actionType = sanitizeString(action.parameters.action).toLowerCase();
        if (actionType) {
          const incompatibleDevices = members.filter((member) => !getWorkflowCapabilitiesForDevice(member).includes(actionType));
          if (incompatibleDevices.length) {
            issues.push(`Invalid action "${actionType}" for device group "${groupName}"`);
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
    } else if (action.type === 'scene_activate') {
      issues.push(`Scene target missing at index ${index}`);
      return null;
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
    trigger: fixedTrigger,
    actions: fixedActions
  };

  return { valid: true, issues, fixedAutomation, fixed };
}

async function validateAndFixAutomationPayload(payload) {
  const candidates = extractAutomationCandidates(payload);
  if (!candidates.length) {
    return {
      valid: false,
      issues: ['Response did not include any automation definitions'],
      fixedAutomations: null,
      fixed: false
    };
  }

  if (candidates.length > MAX_AUTOMATIONS_PER_REQUEST) {
    return {
      valid: false,
      issues: [`Response included too many automations (${candidates.length}). Maximum allowed is ${MAX_AUTOMATIONS_PER_REQUEST}.`],
      fixedAutomations: null,
      fixed: false
    };
  }

  const fixedAutomations = [];
  const issues = [];
  let fixed = false;

  for (let index = 0; index < candidates.length; index += 1) {
    const validation = await validateAndFixAutomation(candidates[index]);
    if (!validation.valid) {
      validation.issues.forEach((issue) => {
        issues.push(`Automation ${index + 1}: ${issue}`);
      });
      continue;
    }

    if (validation.fixed) {
      fixed = true;
    }

    fixedAutomations.push(validation.fixedAutomation);
  }

  if (issues.length > 0 || fixedAutomations.length !== candidates.length) {
    return {
      valid: false,
      issues,
      fixedAutomations: null,
      fixed
    };
  }

  return {
    valid: true,
    issues: [],
    fixedAutomations,
    fixed
  };
}

/**
 * Generate automation drafts from natural language text with self-healing
 */
async function generateAutomationDraftsFromText(text, roomContext = null, options = {}) {
  const mode = options.mode === 'revise' ? 'revise' : 'create';
  const existingAutomation = options.existingAutomation && typeof options.existingAutomation === 'object'
    ? options.existingAutomation
    : null;

  console.log(`AutomationService: ${mode === 'revise' ? 'Revising' : 'Creating'} automation from natural language text`);
  console.log('AutomationService: Input text:', text);
  console.log('AutomationService: Room context:', roomContext);

  try {
    if (!text || text.trim() === '') {
      throw new Error('Automation text description is required');
    }

    if (mode === 'revise' && !existingAutomation) {
      throw new Error('Existing automation definition is required for revision');
    }

    // Build comprehensive context
    const devicesByRoom = await buildDeviceContext();
    const scenes = await buildSceneContext();
    const flatDevices = flattenDevices(devicesByRoom);

    // For direct control requests like "turn on the vault light", bypass automation creation
    if (mode === 'create' && options.allowDirectCommand !== false && isLikelyImmediateCommand(text)) {
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
    const deviceGroups = await buildDeviceGroupContext(devicesByRoom);
    const promptScenes = refineSceneContextForPrompt(text, scenes);
    const deviceListForPrompt = formatDeviceList(promptDeviceContext);
    const deviceGroupListForPrompt = formatDeviceGroupList(deviceGroups);
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
    let prompt = mode === 'revise'
      ? buildAutomationRevisionPrompt(
          text,
          existingAutomation,
          promptDeviceContext,
          deviceGroups,
          promptScenes,
          roomContext,
          deviceListForPrompt,
          deviceGroupListForPrompt,
          sceneListForPrompt
        )
      : buildAutomationPrompt(
          text,
          promptDeviceContext,
          deviceGroups,
          promptScenes,
          roomContext,
          deviceListForPrompt,
          deviceGroupListForPrompt,
          sceneListForPrompt
        );

    const settingsDoc = await Settings.getSettings();
    const defaultPriority = Array.isArray(settingsDoc.llmPriorityList) && settingsDoc.llmPriorityList.length
      ? settingsDoc.llmPriorityList
      : ['local', 'codex', 'openai', 'anthropic'];
    let providerQueue = [...defaultPriority];
    let parsedAutomations = null;
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

        const parsedPayload = JSON.parse(jsonMatch[0]);

        // Validate and fix automation structure
        const validation = await validateAndFixAutomationPayload(parsedPayload);

        if (validation.valid) {
          if (mode === 'revise' && validation.fixedAutomations.length !== 1) {
            lastError = `Revision must return exactly one automation, received ${validation.fixedAutomations.length}`;
            console.error('AutomationService:', lastError);
            parsedAutomations = null;
            prompt = buildAutomationRetryPrompt({
              mode,
              text,
              roomContext,
              issues: [lastError],
              deviceList: deviceListForPrompt,
              deviceGroupList: deviceGroupListForPrompt,
              sceneList: sceneListForPrompt,
              existingAutomation
            });
            continue;
          }

          console.log(`AutomationService: Generated ${validation.fixedAutomations.length} automation definition(s)`);
          if (validation.fixed) {
            console.log('AutomationService: Applied fixes to automation structure');
          }
          parsedAutomations = validation.fixedAutomations;
          break; // Success!
        } else {
          lastError = `Validation failed: ${validation.issues.join(', ')}`;
          console.error('AutomationService:', lastError);
          parsedAutomations = null;
          if (providerUsed === 'local') {
            providerQueue = providerQueue.filter(
              (candidate) => candidate?.toLowerCase() !== providerUsed
            );
            console.warn('AutomationService: Removing local provider after invalid automation payload');
          }

          // Build feedback prompt for retry
          prompt = buildAutomationRetryPrompt({
            mode,
            text,
            roomContext,
            issues: validation.issues,
            deviceList: deviceListForPrompt,
            deviceGroupList: deviceGroupListForPrompt,
            sceneList: sceneListForPrompt,
            existingAutomation
          });
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
    if (!parsedAutomations || parsedAutomations.length === 0) {
      if (mode === 'revise') {
        throw new Error(`Failed to revise automation after ${MAX_LLM_RETRIES} attempts. Last error: ${lastError}`);
      }
      console.warn('AutomationService: Falling back to heuristic automation builder');
      const fallbackAutomation = buildFallbackAutomation(text, devicesByRoom, roomContext);
      if (!fallbackAutomation) {
        throw new Error(`Failed to create valid automation after ${MAX_LLM_RETRIES} attempts. Last error: ${lastError}`);
      }
      parsedAutomations = [fallbackAutomation];
    }

    return {
      success: true,
      automations: parsedAutomations,
      handledDirectCommand: false
    };
  } catch (error) {
    console.error(`AutomationService: Error ${mode === 'revise' ? 'revising' : 'creating'} automation from text:`, error.message);
    console.error('AutomationService: Full error:', error);

    if (error.message.includes('required') || error.message.includes('unavailable') || error.message.includes('after')) {
      throw error;
    }
    throw new Error(`Failed to ${mode === 'revise' ? 'revise' : 'create'} automation from text: ${error.message}`);
  }
}

/**
 * Create automation from natural language text with self-healing
 */
async function createAutomationFromText(text, roomContext = null) {
  try {
    const draftResult = await generateAutomationDraftsFromText(text, roomContext, {
      mode: 'create',
      allowDirectCommand: true
    });

    if (draftResult?.handledDirectCommand) {
      return draftResult;
    }

    const createdAutomations = [];
    const reservedNames = new Set();
    const parsedAutomations = Array.isArray(draftResult?.automations) ? draftResult.automations : [];

    for (const parsedAutomation of parsedAutomations) {
      // Validate and clean the parsed automation
      const actions = Array.isArray(parsedAutomation.actions)
        ? parsedAutomation.actions.filter(Boolean)
        : null;

      if (!Array.isArray(actions) || actions.length === 0) {
        throw new Error('At least one action is required');
      }

      const uniqueName = await ensureUniqueAutomationName(parsedAutomation.name || 'Custom Automation', reservedNames);
      reservedNames.add(uniqueName.toLowerCase());

      const automationData = {
        name: uniqueName,
        description: parsedAutomation.description || text.trim(),
        trigger: parsedAutomation.trigger || { type: 'manual', conditions: {} },
        actions,
        category: parsedAutomation.category || 'custom',
        priority: parsedAutomation.priority || 5,
        enabled: parsedAutomation.enabled !== false
      };

      // Create the automation
      // eslint-disable-next-line no-await-in-loop
      const newAutomation = await createAutomation(automationData);
      createdAutomations.push(newAutomation);
    }

    console.log('AutomationService: Automation created from natural language successfully');
    return {
      success: true,
      automation: createdAutomations[0] || null,
      automations: createdAutomations,
      createdCount: createdAutomations.length,
      message: createdAutomations.length === 1
        ? 'Automation created successfully from natural language'
        : `Created ${createdAutomations.length} automations from natural language`
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

async function reviseAutomationFromText(text, existingAutomation, roomContext = null) {
  const draftResult = await generateAutomationDraftsFromText(text, roomContext, {
    mode: 'revise',
    existingAutomation,
    allowDirectCommand: false
  });

  const revisedAutomation = Array.isArray(draftResult?.automations) ? draftResult.automations[0] : null;
  if (!revisedAutomation) {
    throw new Error('Automation revision did not return a revised automation');
  }

  return {
    success: true,
    automation: revisedAutomation,
    automations: [revisedAutomation],
    message: 'Automation revised successfully from natural language'
  };
}

const AUTOMATION_JSON_TEMPLATE = `{
  "automations": [
    {
      "name": "Laundry Room Fan Auto Off",
      "description": "Turns off the Laundry Room Fan 30 minutes after it turns on.",
      "trigger": {
        "type": "device_state",
        "conditions": {
          "deviceId": "<DEVICE_ID>",
          "property": "status",
          "operator": "eq",
          "value": true,
          "state": "on"
        }
      },
      "actions": [
        {
          "type": "delay",
          "target": null,
          "parameters": {
            "seconds": 1800
          }
        },
        {
          "type": "device_control",
          "target": {
            "kind": "context",
            "key": "triggeringDeviceId"
          },
          "parameters": {
            "action": "turn_off"
          }
        }
      ],
      "category": "energy",
      "priority": 5
    }
  ]
}`;

/**
 * Build detailed automation prompt for LLM
 */
function buildAutomationPrompt(text, devicesByRoom, deviceGroups, scenes, roomContext, preformattedDeviceList, preformattedDeviceGroupList, preformattedSceneList) {
  const deviceList = preformattedDeviceList ?? formatDeviceList(devicesByRoom);
  const deviceGroupList = preformattedDeviceGroupList ?? formatDeviceGroupList(deviceGroups);
  const sceneList = preformattedSceneList ?? formatSceneList(scenes);

  return `You are an expert at creating smart home automations. Convert the user's request into a JSON object that matches the schema below.

OUTPUT REQUIREMENTS (FOLLOW EXACTLY):
1. Return a single valid JSON object only. Do not include markdown, prose, comments, code fences, or additional explanations.
2. Every key must use double quotes. All string values must use double quotes.
3. The top-level JSON object must include an "automations" array.
4. Every automation in "automations" must include the fields: name, description, trigger, actions, category, priority.
5. The trigger must include a "type" key and a "conditions" object (empty object is fine for manual triggers).
6. The actions array must contain at least one item. Each action must have "type", "target", and "parameters".
7. Choose device IDs, device group names, and scene identifiers strictly from the provided context. Never invent IDs, group names, or placeholders.
8. Respond with valid JSON even when uncertain; never omit required fields.

REQUIRED JSON TEMPLATE (values are examples, not literals to reuse):
${AUTOMATION_JSON_TEMPLATE}

IMPORTANT RULES:
1. ALWAYS return at least one action when the user is asking to control something. Simple requests (for example, "turn on the vault light") must become one automation with a manual trigger and one device_control action.
2. Default the trigger to {"type": "manual", "conditions": {}} when no schedule or condition is provided.
3. Return one automation object per independently-triggered device or distinct trigger event when the request names multiple devices, rooms, or separate times like sunrise and sunset.
4. Use a fixed device ID in trigger.conditions.deviceId for device_state triggers.
5. When an action should target the same device that caused a device_state trigger, prefer the dynamic target {"kind":"context","key":"triggeringDeviceId"} instead of copying the device ID into the action target.
6. When a broad request should control many devices and a matching device group exists, prefer {"kind":"device_group","group":"Exact Group Name"} over enumerating many separate device_control actions.
7. ONLY use device IDs from the provided device list, exact device group names from the provided device group list, and scene IDs from the provided scene list. Never invent IDs, group names, or placeholders.
8. Match each action to the device's allowed capabilities and source restrictions.
9. Brightness values must be 0-100. Temperature values should be whole-number Fahrenheit unless specified otherwise.
10. Delay actions support long timers. Use the full requested duration in seconds, up to 86400 seconds. Do not reduce 30 minutes to 600 seconds.
11. Use intent-driven categories (choose from "security", "comfort", "energy", "convenience", "custom") and pick a sensible priority between 1-10 (default 5).
12. Never output any prefix/suffix text. Return ONLY the JSON object.
13. For devices with Source:harmony, only use turn_on, turn_off, or toggle. Do not use set_brightness, set_color, set_temperature, lock/unlock, or open/close on Harmony Hub activity devices.
14. For Source:harmony requests in schedules/workflows, prefer explicit turn_on or turn_off instead of toggle unless the user explicitly asks to toggle.
15. When the request refers to the security system or alarm arming/disarming state, use trigger type "security_alarm_status" with conditions like {"states":["armedStay","armedAway"]}.
16. When the request refers to sunrise or sunset, use trigger type "schedule" with conditions like {"event":"sunrise","offset":0} or {"event":"sunset","offset":0}. Offsets are in minutes and may be negative or positive.
17. For numeric SmartThings triggers such as power, energy, humidity, or temperature thresholds, prefer trigger type "device_state" and use the device's listed trigger property path (for example "smartThingsAttributeValues.powerMeter.power") with an explicit operator and numeric value.
18. When the request says a condition must stay true for a period of time before firing, add "forSeconds" to the device_state trigger conditions.
19. When the request says "greater than", "above", "over", or "more than", use operator "gt". When it says "less than", "below", or "under", use operator "lt". For energy-monitoring devices, prefer threshold operators over exact numeric equality unless the user explicitly asks for an exact value.

AVAILABLE DEVICES:
${deviceList}

AVAILABLE DEVICE GROUPS:
${deviceGroupList}

AVAILABLE SCENES:
${sceneList}

${roomContext ? `ROOM CONTEXT: The user is currently in the "${roomContext}" room.\n` : ''}

REQUIRED JSON STRUCTURE:
{
  "automations": [
    {
      "name": "Brief descriptive name (max 50 chars)",
      "description": "Detailed description of what this automation does",
      "trigger": {
        "type": "<trigger_type>",  // choose one: time, device_state, sensor, schedule, manual, security_alarm_status
        "conditions": {
          // For time: {"hour": 7, "minute": 0, "days": ["monday", "tuesday", ...]}
          // For schedule: {"cron": "0 7 * * 1-5"} or {"event": "sunrise", "offset": 0}
          // For device_state: {"deviceId": "ID", "property": "status" or "smartThingsAttributeValues.powerMeter.power", "operator": "eq"/"gt"/"lt"/..., "value": true or 25, "state": "on" or "off" (optional legacy alias), "forSeconds": 600 (optional)}
          // Prefer gt/lt for power or energy level thresholds instead of exact equality.
          // For sensor: {"sensorType": "<sensor_type>", "deviceId": "ID", "condition": "<condition>", "value": 25}
          // For security_alarm_status: {"states": ["armedStay", "armedAway"]}
          //   sensor_type options: motion, temperature, humidity
          //   condition options: detected, above, below
          // For manual: {}
        }
      },
      "actions": [
        {
          "type": "<action_type>",  // choose one: device_control, scene_activate, notification, delay
          "target": "DEVICE_ID_FROM_LIST_ABOVE or SCENE_ID_FROM_LIST_ABOVE or {\\"kind\\":\\"context\\",\\"key\\":\\"triggeringDeviceId\\"} or {\\"kind\\":\\"device_group\\",\\"group\\":\\"Exact Group Name\\"}",
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
  ]
}

DEVICE ACTION COMPATIBILITY:
- light: turn_on, turn_off, set_brightness, set_color
- thermostat: turn_on, turn_off, set_temperature
- lock: lock, unlock
- switch: turn_on, turn_off, toggle
- speaker: turn_on, turn_off, toggle
- harmony hub activity device (Source:harmony): turn_on, turn_off, toggle (activity start/stop only)
- garage: open, close
- sensor: (read-only, cannot be controlled)

TRIGGER TYPE EXAMPLES:
- "every morning at 7am" -> type: "time", conditions: {"hour": 7, "minute": 0}
- "when motion detected" -> type: "sensor", conditions: {"sensorType": "motion", "condition": "detected"}
- "when temperature above 75" -> type: "sensor", conditions: {"sensorType": "temperature", "condition": "above", "value": 75}
- "when front door unlocked" -> type: "device_state", conditions: {"state": "off"}
- "when dryer power goes above 25 watts" -> type: "device_state", conditions: {"deviceId": "ID", "property": "smartThingsAttributeValues.powerMeter.power", "operator": "gt", "value": 25}
- "when dryer energy level is greater than 25 watts" -> type: "device_state", conditions: {"deviceId": "ID", "property": "smartThingsAttributeValues.powerMeter.power", "operator": "gt", "value": 25}
- "when dryer power stays below 5 watts for 10 minutes" -> type: "device_state", conditions: {"deviceId": "ID", "property": "smartThingsAttributeValues.powerMeter.power", "operator": "lt", "value": 5, "forSeconds": 600}
- "when dryer energy level stays less than 5 watts for 10 minutes" -> type: "device_state", conditions: {"deviceId": "ID", "property": "smartThingsAttributeValues.powerMeter.power", "operator": "lt", "value": 5, "forSeconds": 600}
- "when the security alarm is armed stay or armed away" -> type: "security_alarm_status", conditions: {"states": ["armedStay", "armedAway"]}
- "at sunset" -> type: "schedule", conditions: {"event": "sunset", "offset": 0}
- "30 minutes before sunrise" -> type: "schedule", conditions: {"event": "sunrise", "offset": -30}
- "when the alarm is armed stay, turn off all interior lights" -> if a matching group exists, use one device_control action with target {"kind":"device_group","group":"Interior Lights"}
- "when a fan switch turns on, wait 30 minutes, then turn that same switch off" -> use type: "device_state", a delay action with {"seconds": 1800}, and a device_control action targeting {"kind":"context","key":"triggeringDeviceId"}
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
      const groups = Array.isArray(device.groups) && device.groups.length > 0
        ? `, Groups: ${device.groups.join(', ')}`
        : '';
      const energyMonitoring = Array.isArray(device.energyMonitoringHints) && device.energyMonitoringHints.length > 0
        ? `, Energy monitoring: ${device.energyMonitoringHints.join(', ')}`
        : '';
      const workflowProperties = Array.isArray(device.workflowProperties) && device.workflowProperties.length > 0
        ? `, Trigger properties: ${device.workflowProperties.slice(0, 10).join(', ')}`
        : '';
      return `  - ${device.name} (ID: ${device.id}, Type: ${device.type}, Source: ${source}, Actions: ${actions}${groups}${harmonyDetails}${energyMonitoring}${workflowProperties})`;
    }).join('\n');

    return `Room: ${room}\n${deviceLines}`;
  }).join('\n\n');
}

function formatDeviceGroupList(deviceGroups = []) {
  if (!Array.isArray(deviceGroups) || !deviceGroups.length) {
    return 'None';
  }

  return deviceGroups.map((group) => {
    const rooms = Array.isArray(group.rooms) && group.rooms.length ? group.rooms.join(', ') : 'Unknown';
    const types = Array.isArray(group.types) && group.types.length ? group.types.join(', ') : 'Unknown';
    const sources = Array.isArray(group.sources) && group.sources.length ? group.sources.join(', ') : 'Unknown';
    const memberPreview = Array.isArray(group.deviceNames) && group.deviceNames.length
      ? group.deviceNames.slice(0, 8).join(', ')
      : 'No members yet';
    const suffix = Array.isArray(group.deviceNames) && group.deviceNames.length > 8
      ? `, +${group.deviceNames.length - 8} more`
      : '';
    const description = sanitizeString(group.description)
      ? `, Description: ${group.description}`
      : '';
    return `  - ${group.name} (Devices: ${group.deviceCount}, Rooms: ${rooms}, Types: ${types}, Sources: ${sources}, Members: ${memberPreview}${suffix}${description})`;
  }).join('\n');
}

function formatSceneList(scenes = []) {
  if (!Array.isArray(scenes) || !scenes.length) {
    return 'None';
  }

  return scenes.map((scene) =>
    `  - ${scene.name} (ID: ${scene.id}, Category: ${scene.category})`
  ).join('\n');
}

function formatAutomationForPrompt(automation = {}) {
  return JSON.stringify({
    name: automation.name || '',
    description: automation.description || '',
    enabled: automation.enabled !== false,
    category: automation.category || 'custom',
    priority: automation.priority || 5,
    trigger: automation.trigger || { type: 'manual', conditions: {} },
    actions: Array.isArray(automation.actions) ? automation.actions : []
  }, null, 2);
}

function buildAutomationRevisionPrompt(
  text,
  existingAutomation,
  devicesByRoom,
  deviceGroups,
  scenes,
  roomContext,
  preformattedDeviceList,
  preformattedDeviceGroupList,
  preformattedSceneList
) {
  const deviceList = preformattedDeviceList ?? formatDeviceList(devicesByRoom);
  const deviceGroupList = preformattedDeviceGroupList ?? formatDeviceGroupList(deviceGroups);
  const sceneList = preformattedSceneList ?? formatSceneList(scenes);
  const existingAutomationJson = formatAutomationForPrompt(existingAutomation);

  return `You are an expert at revising smart home automations. Update the EXISTING automation below so it matches the user's requested changes.

OUTPUT REQUIREMENTS (FOLLOW EXACTLY):
1. Return a single valid JSON object only. Do not include markdown, prose, comments, code fences, or additional explanations.
2. Every key must use double quotes. All string values must use double quotes.
3. The top-level JSON object must include an "automations" array with EXACTLY ONE automation object.
4. Return the FULL revised automation, not a patch or partial diff.
5. The revised automation must include the fields: name, description, trigger, actions, category, priority.
6. The trigger must include a "type" key and a "conditions" object (empty object is fine for manual triggers).
7. The actions array must contain at least one item. Each action must have "type", "target", and "parameters".
8. Choose device IDs, device group names, and scene identifiers strictly from the provided context. Never invent IDs, group names, or placeholders.

REQUIRED JSON TEMPLATE:
${AUTOMATION_JSON_TEMPLATE}

REVISION RULES:
1. Revise the EXISTING automation below to satisfy the user's request.
2. Keep the current automation name unless the user explicitly asks to rename it.
3. Preserve the current trigger/action intent unless the user asks to change it.
4. When a broad request should control many devices and a matching device group exists, prefer {"kind":"device_group","group":"Exact Group Name"} over enumerating many separate device_control actions.
5. When fixing an automation that currently lists too few devices, expand the target coverage by using an appropriate group when available.
6. When an action should target the same device that caused a device_state trigger, prefer {"kind":"context","key":"triggeringDeviceId"}.
7. Use valid trigger/action structures and only capabilities allowed by the target devices.
8. For numeric SmartThings triggers such as power, energy, humidity, or temperature thresholds, prefer trigger type "device_state" and use the device's listed trigger property path with an explicit operator and numeric value.
9. When the request says a condition must stay true for a period of time before firing, add "forSeconds" to the device_state trigger conditions.
10. When the request says "greater than", "above", "over", or "more than", use operator "gt". When it says "less than", "below", or "under", use operator "lt".

EXISTING AUTOMATION TO REVISE:
${existingAutomationJson}

AVAILABLE DEVICES:
${deviceList}

AVAILABLE DEVICE GROUPS:
${deviceGroupList}

AVAILABLE SCENES:
${sceneList}

${roomContext ? `ROOM CONTEXT: The user is currently in the "${roomContext}" room.\n` : ''}USER REQUEST: "${text}"

Return ONLY the JSON object containing exactly one revised automation.`;
}

function buildAutomationRetryPrompt({
  mode,
  text,
  roomContext,
  issues,
  deviceList,
  deviceGroupList,
  sceneList,
  existingAutomation
}) {
  const revisionContext = mode === 'revise' && existingAutomation
    ? `\nEXISTING AUTOMATION TO REVISE:\n${formatAutomationForPrompt(existingAutomation)}\n`
    : '';
  const countInstruction = mode === 'revise'
    ? 'Return ONLY the corrected JSON object with an "automations" array containing EXACTLY ONE revised automation.'
    : 'Return ONLY the corrected JSON object with an "automations" array.';

  return `
The previous automation JSON had the following issues:
${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

Please fix these issues and return a corrected JSON object. Remember:
- Only use device IDs or exact device names from the provided list
- Only use exact device group names from the provided device group list
- Only use scene IDs or exact scene names from the provided scene list
- Ensure all action types are valid for the target device types
- Use valid action types: device_control, scene_activate, notification, delay, condition
- Use {"kind":"context","key":"triggeringDeviceId"} only when an action should target the same device that caused a device_state trigger
- Use {"kind":"device_group","group":"Exact Group Name"} when a broad request should apply to many devices and a matching group exists
${mode === 'revise' ? '- Return a FULL revised replacement for the existing automation, not a patch' : ''}

Original request: "${text}"

${roomContext ? `Room context: The user is currently in the "${roomContext}" room.\n` : ''}${revisionContext}AVAILABLE DEVICES:
${deviceList || 'None'}

AVAILABLE DEVICE GROUPS:
${deviceGroupList || 'None'}

AVAILABLE SCENES:
${sceneList || 'None'}

${countInstruction}`;
}

/**
 * Get automation statistics
 */
async function getAutomationStats() {
  console.log('AutomationService: Getting automation statistics');

  const recentExecutionThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const standaloneFilter = standaloneAutomationFilter();

  try {
    const [
      totalCount,
      enabledCount,
      disabledCount,
      categoryStats,
      recentExecutions,
      priorityStats
    ] = await Promise.all([
      Automation.countDocuments(standaloneFilter),
      Automation.countDocuments(standaloneAutomationFilter({ enabled: true })),
      Automation.countDocuments(standaloneAutomationFilter({ enabled: false })),
      Automation.aggregate([
        { $match: standaloneFilter },
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]),
      Automation.countDocuments(standaloneAutomationFilter({
        lastRun: { $gte: recentExecutionThreshold } // Last 7 days
      })),
      Automation.aggregate([
        { $match: standaloneFilter },
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

  let history = null;
  let runtimeContext = null;

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
    const triggerContext = options.context && typeof options.context === 'object'
      ? { ...options.context }
      : {};
    const workflowId = automation.workflowId?._id?.toString?.()
      || automation.workflowId?.toString?.()
      || null;
    const correlationId = options.correlationId || crypto.randomUUID();

    // Create history entry
    history = new AutomationHistory({
      automationId: automation._id,
      automationName: automation.name,
      workflowId: automation.workflowId || null,
      workflowName: workflowId ? automation.name : null,
      triggerType,
      triggerSource,
      correlationId,
      triggerContext,
      ...(options.voiceCommandId ? { voiceCommandId: options.voiceCommandId } : {}),
      totalActions: automation.actions.length,
      environment: {
        triggerType,
        triggerSource,
        context: triggerContext
      },
      status: 'running'
    });
    await history.save();

    runtimeContext = automationRuntimeService.buildExecutionContext({
      automation,
      history,
      workflowId,
      workflowName: workflowId ? automation.name : null,
      correlationId,
      triggerType,
      triggerSource,
      triggerContext,
      totalActions: automation.actions.length
    });

    await automationRuntimeService.recordTriggerMatched(runtimeContext, {
      message: `Trigger matched for "${automation.name}"`,
      triggerContext
    });
    await automationRuntimeService.recordExecutionStarted(runtimeContext);

    const execution = await executeActionSequence(automation.actions, {
      context: triggerContext,
      runtime: {
        onActionStart: async ({ actionIndex, parentActionIndex, action }) => {
          await automationRuntimeService.recordActionStarted(runtimeContext, {
            actionIndex,
            parentActionIndex,
            actionType: action?.type || 'unknown',
            target: getActionTargetCandidate(action, ['deviceId', 'sceneId']),
            message: `Starting ${action?.type || 'action'} action`
          });
        },
        onActionComplete: async ({ actionIndex, parentActionIndex, action, result, startedAt }) => {
          await automationRuntimeService.recordActionCompleted(runtimeContext, {
            actionIndex,
            parentActionIndex,
            actionType: action?.type || result?.actionType || 'unknown',
            target: result?.target ?? getActionTargetCandidate(action, ['deviceId', 'sceneId']),
            durationMs: result?.durationMs ?? null,
            message: result?.message || `Completed ${action?.type || 'action'} action`,
            startedAt,
            success: true
          });
        },
        onActionError: async ({ actionIndex, parentActionIndex, action, error, result, startedAt }) => {
          await automationRuntimeService.recordActionCompleted(runtimeContext, {
            actionIndex,
            parentActionIndex,
            actionType: action?.type || result?.actionType || 'unknown',
            target: result?.target ?? getActionTargetCandidate(action, ['deviceId', 'sceneId']),
            durationMs: result?.durationMs ?? null,
            message: error?.message || `Failed ${action?.type || 'action'} action`,
            error: error?.message || 'Action failed',
            startedAt,
            success: false
          });
        }
      }
    });
    const actionResults = execution.actionResults || [];
    const finalStatus = execution.status || 'failed';
    const allSuccess = finalStatus === 'success';

    history.actionResults = actionResults;
    await history.markCompleted(finalStatus);
    await automationRuntimeService.recordExecutionCompleted(runtimeContext, {
      status: finalStatus,
      successfulActions: execution.successfulActions,
      failedActions: execution.failedActions,
      durationMs: history.durationMs
    });

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

    if (automation.workflowId) {
      const workflow = await Workflow.findById(automation.workflowId);
      if (workflow) {
        workflow.lastRun = automation.lastRun;
        workflow.executionCount = (workflow.executionCount || 0) + 1;
        if (!allSuccess) {
          workflow.lastError = {
            message: automation.lastError?.message || execution.message || 'Workflow execution had errors',
            timestamp: new Date()
          };
        } else {
          workflow.lastError = undefined;
        }
        await workflow.save();
      }
    }

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
    if (history && runtimeContext && history.status === 'running') {
      try {
        await history.markCompleted('failed', error);
        await automationRuntimeService.recordExecutionCompleted(runtimeContext, {
          status: 'failed',
          successfulActions: 0,
          failedActions: 1,
          durationMs: history.durationMs,
          message: error.message || 'Automation execution failed'
        });
      } catch (loggingError) {
        console.warn(`AutomationService: failed to persist runtime failure for ${id}: ${loggingError.message}`);
      }
    }

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
    const resolvedLimit = Number.isFinite(Number(limit)) ? Number(limit) : 50;
    let history;
    if (automationId) {
      if (!mongoose.Types.ObjectId.isValid(automationId)) {
        throw new Error('Invalid automation ID format');
      }

      const automation = await Automation.findById(automationId).lean();
      assertStandaloneAutomationForRead(automation, automationId);

      history = await AutomationHistory.find({ automationId })
        .sort({ startedAt: -1 })
        .limit(resolvedLimit)
        .lean();
    } else {
      const automationIds = await listStandaloneAutomationIds();
      if (!automationIds.length) {
        return [];
      }

      history = await AutomationHistory.find({
        automationId: { $in: automationIds }
      })
        .sort({ startedAt: -1 })
        .limit(resolvedLimit)
        .populate('automationId', 'name category')
        .lean();
    }

    console.log(`AutomationService: Retrieved ${history.length} history entries`);
    return history;
  } catch (error) {
    console.error('AutomationService: Error fetching automation history:', error.message);
    console.error('AutomationService: Full error:', error);
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      throw error;
    }
    throw new Error(`Failed to fetch automation history: ${error.message}`);
  }
}

/**
 * Get execution statistics
 */
async function getExecutionStats(dateRange = null) {
  console.log('AutomationService: Fetching execution statistics');

  try {
    const automationIds = await listStandaloneAutomationIds();
    if (!automationIds.length) {
      return {
        execution: buildEmptyExecutionSummary(),
        failures: []
      };
    }

    const statsMatch = buildExecutionStatsMatch(automationIds, dateRange);
    const failureMatch = {
      ...buildExecutionStatsMatch(automationIds, dateRange),
      status: { $in: ['failed', 'partial_success'] }
    };

    const [stats, failureAnalysis] = await Promise.all([
      AutomationHistory.aggregate([
        { $match: statsMatch },
        {
          $group: {
            _id: null,
            totalExecutions: { $sum: 1 },
            successfulExecutions: {
              $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
            },
            failedExecutions: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
            },
            partialSuccessExecutions: {
              $sum: { $cond: [{ $eq: ['$status', 'partial_success'] }, 1, 0] }
            },
            averageDuration: { $avg: '$durationMs' },
            totalActions: { $sum: '$totalActions' },
            successfulActions: { $sum: '$successfulActions' },
            failedActions: { $sum: '$failedActions' }
          }
        }
      ]),
      AutomationHistory.aggregate([
        { $match: failureMatch },
        {
          $group: {
            _id: '$error.message',
            count: { $sum: 1 },
            automations: { $addToSet: '$automationName' },
            lastOccurrence: { $max: '$startedAt' }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ])
    ]);

    console.log('AutomationService: Retrieved execution statistics');
    return {
      execution: stats[0] || buildEmptyExecutionSummary(),
      failures: failureAnalysis
    };
  } catch (error) {
    console.error('AutomationService: Error fetching execution statistics:', error.message);
    console.error('AutomationService: Full error:', error);
    throw new Error(`Failed to fetch execution statistics: ${error.message}`);
  }
}

Object.assign(module.exports, {
  getAllAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  toggleAutomation,
  createAutomationFromText,
  reviseAutomationFromText,
  getAutomationStats,
  executeAutomation,
  getAutomationHistory,
  getExecutionStats
});
