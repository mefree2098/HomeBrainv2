const https = require('node:https');
const axios = require('axios');
const Device = require('../models/Device');
const Workflow = require('../models/Workflow');
const deviceService = require('./deviceService');
const sceneService = require('./sceneService');
const insteonService = require('./insteonService');
const { resolveDeviceProperty } = require('../utils/devicePropertyResolver');

const MAX_DELAY_SECONDS = Math.max(
  600,
  Number(process.env.WORKFLOW_MAX_DELAY_SECONDS || 24 * 60 * 60)
);
const MIN_HTTP_TIMEOUT_MS = 1000;
const MAX_HTTP_TIMEOUT_MS = 120000;
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const MAX_NESTED_CONDITION_DEPTH = 4;
const MAX_WORKFLOW_CONTROL_DEPTH = 8;
const MAX_REPEAT_EVERY_ITERATIONS = 500;
const STOP_REQUEST_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEVICE_GROUP_CONCURRENCY = Math.max(
  1,
  Number(process.env.WORKFLOW_DEVICE_GROUP_CONCURRENCY || 8)
);
const DEFAULT_INSTEON_GROUP_CONCURRENCY = Math.max(
  1,
  Number(process.env.WORKFLOW_INSTEON_GROUP_CONCURRENCY || 6)
);

const conditionStateCache = new Map();
const isyVariableStore = new Map();
const isyProgramStateCache = new Map();
const workflowStopRequests = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObjectIdLike(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value.trim());
}

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function getDeviceSource(device) {
  return sanitizeString(device?.properties?.source).toLowerCase();
}

function getDeviceGroupConcurrency(devices = []) {
  const hasInsteon = devices.some((device) => getDeviceSource(device) === 'insteon');
  return hasInsteon ? DEFAULT_INSTEON_GROUP_CONCURRENCY : DEFAULT_DEVICE_GROUP_CONCURRENCY;
}

async function mapWithConcurrency(items, limit, iteratee) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

function normalizeDeviceGroupTarget(rawTarget) {
  if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    return null;
  }

  const kind = sanitizeString(rawTarget.kind || rawTarget.type).toLowerCase();
  if (kind !== 'device_group' && kind !== 'group') {
    return null;
  }

  const group = sanitizeString(rawTarget.group || rawTarget.name || rawTarget.label || rawTarget.value);
  if (!group) {
    return null;
  }

  return {
    kind: 'device_group',
    group
  };
}

function isyProgramMarker(programId) {
  return `[ISY_PROGRAM_ID:${programId}]`;
}

function normalizeComparable(value) {
  if (value == null) {
    return value;
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return value;
}

function normalizeWeekday(value) {
  const dayMap = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thur: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6
  };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) {
    return value;
  }
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(dayMap, key)) {
      return dayMap[key];
    }
  }
  return null;
}

function parseHourMinute(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function parseClockInput(value) {
  if (value && typeof value === 'object' && value.kind === 'clock' && typeof value.time === 'string') {
    return parseHourMinute(value.time);
  }
  if (typeof value === 'string') {
    return parseHourMinute(value);
  }
  return null;
}

function minutesOfDay(hour, minute) {
  return (hour * 60) + minute;
}

function matchesExpressionDays(days, now) {
  if (!Array.isArray(days) || days.length === 0) {
    return true;
  }
  const today = now.getDay();
  const allowed = new Set(days
    .map((entry) => normalizeWeekday(entry))
    .filter((entry) => entry !== null));
  if (allowed.size === 0) {
    return true;
  }
  return allowed.has(today);
}

function compareValues(left, operator, right) {
  const lhs = normalizeComparable(left);
  const rhs = normalizeComparable(right);
  switch ((operator || 'eq').toString().toLowerCase()) {
    case 'eq':
    case '==':
      return lhs === rhs;
    case 'neq':
    case '!=':
      return lhs !== rhs;
    case 'gt':
    case '>':
      return Number(lhs) > Number(rhs);
    case 'gte':
    case '>=':
      return Number(lhs) >= Number(rhs);
    case 'lt':
    case '<':
      return Number(lhs) < Number(rhs);
    case 'lte':
    case '<=':
      return Number(lhs) <= Number(rhs);
    case 'contains':
      return typeof lhs === 'string' && typeof rhs === 'string' ? lhs.includes(rhs) : false;
    default:
      return Boolean(lhs);
  }
}

function getActionName(action) {
  const fromParameters = action?.parameters?.action;
  if (typeof fromParameters === 'string' && fromParameters.trim()) {
    return fromParameters.trim().toLowerCase();
  }
  const fromAction = action?.action;
  if (typeof fromAction === 'string' && fromAction.trim()) {
    return fromAction.trim().toLowerCase();
  }
  return 'turn_on';
}

function getActionValue(actionName, parameters = {}) {
  if (Object.prototype.hasOwnProperty.call(parameters, 'value')) {
    return parameters.value;
  }

  if (actionName === 'set_brightness' || actionName === 'setbrightness') {
    return parameters.brightness;
  }
  if (actionName === 'set_temperature' || actionName === 'settemperature') {
    return parameters.temperature;
  }
  if (actionName === 'set_color' || actionName === 'setcolor') {
    return parameters.color;
  }
  if (actionName === 'turn_on' && Object.prototype.hasOwnProperty.call(parameters, 'brightness')) {
    return parameters.brightness;
  }

  return undefined;
}

function humanizeActionToken(value = '') {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function capitalizeLabel(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatDurationSecondsLabel(seconds) {
  const normalized = Math.max(0, Number(seconds) || 0);
  if (normalized <= 0) {
    return '0s';
  }

  if (normalized < 60) {
    const rounded = normalized % 1 === 0 ? normalized : Number(normalized.toFixed(1));
    return `${rounded}s`;
  }

  const totalSeconds = Math.round(normalized);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function describeActionTarget(rawTarget) {
  if (rawTarget == null) {
    return null;
  }

  if (typeof rawTarget === 'string') {
    const trimmed = rawTarget.trim();
    return trimmed || null;
  }

  if (typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    return String(rawTarget);
  }

  const kind = sanitizeString(rawTarget.kind || rawTarget.type).toLowerCase();
  if ((kind === 'device_group' || kind === 'group') && rawTarget.group) {
    return `device group "${rawTarget.group}"`;
  }
  if (kind === 'context' && (rawTarget.key || rawTarget.contextKey)) {
    return `context "${rawTarget.key || rawTarget.contextKey}"`;
  }
  if (rawTarget.name) {
    return String(rawTarget.name);
  }
  if (rawTarget.label) {
    return String(rawTarget.label);
  }
  if (rawTarget.value) {
    return String(rawTarget.value);
  }

  return kind || null;
}

function resolveDelaySeconds(action) {
  const parameters = action?.parameters || {};
  const requested = Number(parameters.seconds ?? action?.seconds ?? 0);
  let seconds = Number.isFinite(requested) ? Math.max(0, Math.min(MAX_DELAY_SECONDS, requested)) : 0;
  if (parameters.random === true && seconds > 0) {
    seconds = resolveRandomInteger(0, Math.round(seconds));
  }
  return seconds;
}

function describeWorkflowAction(action, options = {}) {
  const actionType = String(action?.type || 'action').trim().toLowerCase();
  const targetLabel = describeActionTarget(getActionTargetCandidate(action, ['deviceId', 'sceneId']));

  switch (actionType) {
    case 'device_control': {
      const actionName = humanizeActionToken(getActionName(action));
      const prefix = actionName ? capitalizeLabel(actionName) : 'Control device';
      return targetLabel ? `${prefix} ${targetLabel}` : prefix;
    }
    case 'scene_activate':
      return targetLabel ? `Activate scene ${targetLabel}` : 'Activate scene';
    case 'notification':
      return 'Send notification';
    case 'delay': {
      const seconds = options.resolvedDelaySeconds ?? resolveDelaySeconds(action);
      return `Wait ${formatDurationSecondsLabel(seconds)}`;
    }
    case 'condition':
      return 'Evaluate condition';
    case 'workflow_control': {
      const operation = humanizeActionToken(action?.parameters?.operation || action?.parameters?.action || 'run');
      return `${capitalizeLabel(operation || 'Run')} workflow`;
    }
    case 'variable_control':
      return 'Update variable';
    case 'repeat':
      return 'Repeat nested actions';
    case 'isy_network_resource':
      return 'Run ISY network resource';
    case 'http_request': {
      const method = sanitizeString(action?.parameters?.method || 'GET').toUpperCase();
      return action?.target ? `${method} ${action.target}` : `Send ${method} request`;
    }
    default:
      return capitalizeLabel(humanizeActionToken(actionType || 'action') || 'Action');
  }
}

function buildActionPreview(action, actionIndex, parentActionIndex = null, options = {}) {
  return {
    actionIndex,
    parentActionIndex: Number.isInteger(parentActionIndex) ? parentActionIndex : null,
    actionType: String(action?.type || 'unknown'),
    target: getActionTargetCandidate(action, ['deviceId', 'sceneId']) ?? null,
    message: describeWorkflowAction(action, options)
  };
}

function buildNextActionPreview(actions = [], currentIndex = 0, parentActionIndex = null) {
  if (Array.isArray(actions) && currentIndex + 1 < actions.length) {
    const nextAction = actions[currentIndex + 1];
    return buildActionPreview(nextAction, currentIndex + 1, parentActionIndex);
  }

  if (Number.isInteger(parentActionIndex)) {
    return {
      actionIndex: parentActionIndex,
      parentActionIndex: null,
      actionType: 'parent_sequence',
      target: null,
      message: 'Return to parent workflow steps'
    };
  }

  return {
    actionIndex: currentIndex + 1,
    parentActionIndex: null,
    actionType: 'execution_complete',
    target: null,
    message: 'Workflow completes'
  };
}

function buildDelayTimer(resolvedDelaySeconds, startedAt) {
  const durationMs = Math.round(Math.max(0, Number(resolvedDelaySeconds) || 0) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
    return null;
  }

  return {
    durationMs,
    endsAt: new Date(startedAt.getTime() + durationMs)
  };
}

function normalizeIsyVariableKey(value = '') {
  return String(value || '').replace(/^\$/u, '').trim().toLowerCase();
}

function normalizeIsyProgramKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function ensureIsyVariableState(variableName, options = {}) {
  const key = normalizeIsyVariableKey(variableName);
  if (!key) {
    return null;
  }

  if (!isyVariableStore.has(key)) {
    const fallback = Number(options.fallbackValue ?? 0);
    const initial = Number.isFinite(fallback) ? Math.trunc(fallback) : 0;
    isyVariableStore.set(key, {
      key,
      type: options.type || 'integer',
      value: initial,
      initValue: initial,
      updatedAt: new Date()
    });
  }

  return isyVariableStore.get(key);
}

function readIsyVariable(variableName, fallbackValue = 0) {
  const state = ensureIsyVariableState(variableName, { fallbackValue });
  if (!state) {
    return Number.isFinite(Number(fallbackValue)) ? Number(fallbackValue) : 0;
  }
  return state.value;
}

function writeIsyVariable(variableName, value, options = {}) {
  const state = ensureIsyVariableState(variableName, {
    fallbackValue: options.fallbackValue,
    type: options.type || 'integer'
  });
  if (!state) {
    return null;
  }

  const numeric = Number(value);
  const next = Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  state.value = next;
  if (options.setInit === true) {
    state.initValue = next;
  }
  if (options.type) {
    state.type = options.type;
  }
  state.updatedAt = new Date();

  return state;
}

function resolveWorkflowStopRequest(workflowId) {
  if (!workflowId) {
    return false;
  }
  const key = String(workflowId);
  const requestedAt = workflowStopRequests.get(key);
  if (!requestedAt) {
    return false;
  }

  if ((Date.now() - requestedAt) > STOP_REQUEST_TTL_MS) {
    workflowStopRequests.delete(key);
    return false;
  }

  return true;
}

function setWorkflowStopRequest(workflowId) {
  if (!workflowId) {
    return;
  }
  workflowStopRequests.set(String(workflowId), Date.now());
}

function clearWorkflowStopRequest(workflowId) {
  if (!workflowId) {
    return;
  }
  workflowStopRequests.delete(String(workflowId));
}

async function invokeRuntimeHook(runtime, hookName, payload) {
  if (!runtime || typeof runtime[hookName] !== 'function') {
    return;
  }

  await runtime[hookName](payload);
}

function ensureWorkflowNotStopped(context = {}) {
  if (resolveWorkflowStopRequest(context.workflowId)) {
    throw new Error(`Workflow ${context.workflowId} was stopped`);
  }
}

function resolveRandomInteger(min, max) {
  const boundedMin = Math.trunc(Math.min(min, max));
  const boundedMax = Math.trunc(Math.max(min, max));
  return boundedMin + Math.floor(Math.random() * ((boundedMax - boundedMin) + 1));
}

async function sleepWithStopCheck(totalMs, context = {}) {
  const remaining = Math.max(0, Number(totalMs) || 0);
  if (remaining <= 0) {
    return;
  }

  const chunkMs = 500;
  let elapsed = 0;
  while (elapsed < remaining) {
    ensureWorkflowNotStopped(context);
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(chunkMs, remaining - elapsed));
    elapsed += chunkMs;
  }
}

function parseScalar(value) {
  if (value == null) {
    return 0;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    if (/^(true|false)$/i.test(trimmed)) {
      return trimmed.toLowerCase() === 'true';
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    return trimmed;
  }
  return value;
}

function resolveValueReference(rawValue, context = {}) {
  if (rawValue && typeof rawValue === 'object') {
    const kind = String(rawValue.kind || '').toLowerCase();
    if (kind === 'literal') {
      return parseScalar(rawValue.value);
    }
    if (kind === 'variable' || kind === 'isy_variable') {
      const variableName = rawValue.name || rawValue.variable || rawValue.key;
      return readIsyVariable(variableName, 0);
    }
    if (kind === 'context') {
      const contextKey = rawValue.key || rawValue.contextKey;
      return context?.[contextKey];
    }
    if (kind === 'random') {
      const maxRaw = resolveValueReference(rawValue.max, context);
      const max = Number(maxRaw);
      const minRaw = Object.prototype.hasOwnProperty.call(rawValue, 'min')
        ? resolveValueReference(rawValue.min, context)
        : 1;
      const min = Number(minRaw);
      const normalizedMax = Number.isFinite(max) ? Math.trunc(max) : 1;
      const normalizedMin = Number.isFinite(min) ? Math.trunc(min) : 1;
      if (normalizedMax <= 1 && normalizedMin <= 1) {
        return 1;
      }
      return resolveRandomInteger(normalizedMin, normalizedMax);
    }
    if (Object.prototype.hasOwnProperty.call(rawValue, 'value')) {
      return parseScalar(rawValue.value);
    }
  }

  if (typeof rawValue === 'string' && /^\$/.test(rawValue.trim())) {
    return readIsyVariable(rawValue.trim(), 0);
  }

  return parseScalar(rawValue);
}

function getActionTargetCandidate(action, fallbackKeys = []) {
  if (!action || typeof action !== 'object') {
    return null;
  }

  const candidates = [
    action.target,
    ...fallbackKeys.map((key) => action?.[key])
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    if (typeof candidate === 'string' && !candidate.trim()) {
      continue;
    }

    return candidate;
  }

  return null;
}

function resolveActionTargetReference(rawTarget, context = {}) {
  if (rawTarget === undefined || rawTarget === null) {
    return null;
  }

  const resolved = resolveValueReference(rawTarget, context);
  if (resolved == null) {
    return null;
  }

  if (typeof resolved === 'string') {
    const trimmed = resolved.trim();
    return trimmed || null;
  }

  if (typeof resolved === 'number' || typeof resolved === 'boolean') {
    return String(resolved);
  }

  return null;
}

function setIsyProgramState(programKey, state, extra = {}) {
  const normalized = normalizeIsyProgramKey(programKey);
  if (!normalized) {
    return;
  }

  const existing = isyProgramStateCache.get(normalized) || {};
  isyProgramStateCache.set(normalized, {
    ...existing,
    state: Boolean(state),
    enabled: Object.prototype.hasOwnProperty.call(extra, 'enabled') ? Boolean(extra.enabled) : existing.enabled,
    runAtStartup: Object.prototype.hasOwnProperty.call(extra, 'runAtStartup') ? Boolean(extra.runAtStartup) : existing.runAtStartup,
    updatedAt: new Date()
  });
}

function getIsyProgramState(programKey, fallback = false) {
  const normalized = normalizeIsyProgramKey(programKey);
  if (!normalized || !isyProgramStateCache.has(normalized)) {
    return fallback;
  }
  return Boolean(isyProgramStateCache.get(normalized)?.state);
}

function getIsyProgramMeta(programKey) {
  const normalized = normalizeIsyProgramKey(programKey);
  if (!normalized) {
    return null;
  }
  return isyProgramStateCache.get(normalized) || null;
}

async function resolveWorkflowReference(parameters = {}, options = {}) {
  const preferElsePath = options.preferElsePath === true;

  const explicitId = parameters.workflowId || parameters.targetWorkflowId || parameters.target;
  if (isObjectIdLike(explicitId)) {
    const byId = await Workflow.findById(String(explicitId).trim());
    if (byId) {
      return byId;
    }
  }

  const isyProgramId = parameters.targetIsyProgramId || parameters.isyProgramId || parameters.programId;
  if (isyProgramId) {
    const markerRegex = new RegExp(escapeRegexLiteral(isyProgramMarker(isyProgramId)));
    const elsePathRegex = new RegExp(escapeRegexLiteral('[ISY_PROGRAM_PATH:ELSE]'));
    const query = preferElsePath
      ? { description: { $regex: new RegExp(`${markerRegex.source}.*${elsePathRegex.source}`) } }
      : {
          $and: [
            { description: { $regex: markerRegex } },
            { description: { $not: elsePathRegex } }
          ]
        };

    const byMarker = await Workflow.findOne(query);
    if (byMarker) {
      return byMarker;
    }
  }

  const name = parameters.programName || parameters.workflowName || parameters.name;
  if (typeof name === 'string' && name.trim()) {
    const exactPattern = new RegExp(`^ISY Program\\s+[^:]+:\\s*${escapeRegexLiteral(name.trim())}(?:\\s*\\(Else Path\\))?$`, 'i');
    const byName = await Workflow.findOne({ name: { $regex: exactPattern } });
    if (byName) {
      return byName;
    }

    const fallback = await Workflow.findOne({
      name: { $regex: new RegExp(`^${escapeRegexLiteral(name.trim())}$`, 'i') }
    });
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

async function executeDeviceControlForResolvedDevice(device, target, actionName, value, executionOptions = {}) {
  const source = getDeviceSource(device);
  let controlResult = null;
  const insteonOptions = executionOptions?.insteon && typeof executionOptions.insteon === 'object'
    ? executionOptions.insteon
    : {};

  if (source === 'insteon') {
    switch (actionName) {
      case 'turn_on':
      case 'turnon':
        controlResult = await insteonService.turnOn(
          target.toString(),
          value != null ? Number(value) : 100,
          insteonOptions
        );
        break;
      case 'turn_off':
      case 'turnoff':
        controlResult = await insteonService.turnOff(target.toString(), insteonOptions);
        break;
      case 'set_brightness':
      case 'setbrightness':
        controlResult = await insteonService.setBrightness(
          target.toString(),
          value != null ? Number(value) : 100,
          insteonOptions
        );
        break;
      default:
        controlResult = await deviceService.controlDevice(target.toString(), actionName, value);
        break;
    }
  } else {
    controlResult = await deviceService.controlDevice(target.toString(), actionName, value);
  }

  const controlMessage = typeof controlResult?.message === 'string' && controlResult.message.trim()
    ? controlResult.message.trim()
    : null;
  const controlDetails = controlResult && typeof controlResult === 'object'
    ? {
        ...((controlResult.details && typeof controlResult.details === 'object')
          ? controlResult.details
          : {}),
        ...Object.fromEntries(
          Object.entries(controlResult).filter(([key]) => !['message', 'details'].includes(key))
        )
      }
    : null;

  return {
    target: target.toString(),
    message: controlMessage
      ? `Executed ${actionName} on ${device.name}: ${controlMessage}`
      : `Executed ${actionName} on ${device.name}`,
    value,
    details: {
      source,
      ...(controlDetails && typeof controlDetails === 'object' ? controlDetails : {})
    }
  };
}

async function executeDeviceGroupControl(groupTarget, action) {
  const groupName = sanitizeString(groupTarget?.group);
  if (!groupName) {
    throw new Error('Device group target is required');
  }

  const devices = await Device.find({
    groups: { $regex: new RegExp(`^${escapeRegexLiteral(groupName)}$`, 'i') }
  })
    .sort({ room: 1, name: 1 })
    .lean();

  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error(`Device group "${groupName}" has no matching devices`);
  }

  const actionName = getActionName(action);
  const value = getActionValue(actionName, action?.parameters || {});
  const concurrency = getDeviceGroupConcurrency(devices);
  const memberResults = (await mapWithConcurrency(devices, concurrency, async (device) => {
    const target = device?._id?.toString?.() || null;
    if (!target) {
      return null;
    }

    try {
      const result = await executeDeviceControlForResolvedDevice(
        device,
        target,
        actionName,
        value,
        {
          insteon: {
            verificationMode: 'fast',
            deviceGroup: groupName
          }
        }
      );

      return {
        deviceId: target,
        deviceName: device.name,
        room: device.room || '',
        success: true,
        message: result.message,
        details: result.details || {}
      };
    } catch (error) {
      return {
        deviceId: target,
        deviceName: device.name,
        room: device.room || '',
        success: false,
        error: error.message || 'Group device control failed'
      };
    }
  })).filter(Boolean);

  const successfulTargets = memberResults.filter((entry) => entry.success).length;
  const failedTargets = memberResults.length - successfulTargets;
  const details = {
    kind: 'device_group',
    group: groupName,
    executionMode: 'parallel',
    concurrency,
    totalTargets: memberResults.length,
    successfulTargets,
    failedTargets,
    members: memberResults
  };

  if (failedTargets > 0) {
    const firstFailure = memberResults.find((entry) => !entry.success);
    const error = new Error(
      `Executed ${actionName} on device group "${groupName}" with ${failedTargets} failure${failedTargets === 1 ? '' : 's'}${firstFailure?.error ? `: ${firstFailure.error}` : ''}`
    );
    error.details = details;
    throw error;
  }

  return {
    target: {
      kind: 'device_group',
      group: groupName
    },
    message: `Executed ${actionName} on device group "${groupName}" (${successfulTargets} devices)`,
    value,
    details
  };
}

async function executeDeviceControl(action, context = {}) {
  const rawTarget = getActionTargetCandidate(action, ['deviceId']);
  const groupTarget = normalizeDeviceGroupTarget(rawTarget);
  if (groupTarget) {
    return executeDeviceGroupControl(groupTarget, action);
  }

  const target = resolveActionTargetReference(rawTarget, context);
  if (!target) {
    throw new Error('Device target is required');
  }

  const device = await Device.findById(target).lean();
  if (!device) {
    throw new Error('Device not found');
  }

  const actionName = getActionName(action);
  const value = getActionValue(actionName, action?.parameters || {});
  return executeDeviceControlForResolvedDevice(device, target, actionName, value);
}

async function executeSceneActivate(action, context = {}) {
  const sceneId = resolveActionTargetReference(
    getActionTargetCandidate(action, ['sceneId']),
    context
  );
  if (!sceneId) {
    throw new Error('Scene target is required');
  }
  const result = await sceneService.activateScene(sceneId.toString());
  return {
    target: sceneId.toString(),
    message: result?.message || 'Scene activated'
  };
}

async function executeNotification(action) {
  const message = action?.parameters?.message || action?.message || 'Notification action executed';
  return {
    target: action?.target || 'notification',
    message: String(message)
  };
}

async function executeHttpRequest(action) {
  const parameters = action?.parameters || {};
  const method = String(parameters.method || 'GET').trim().toUpperCase();
  const url = String(parameters.url || action?.target || '').trim();
  if (!url) {
    throw new Error('HTTP request URL is required');
  }

  const timeoutRaw = Number(parameters.timeoutMs ?? parameters.timeout ?? DEFAULT_HTTP_TIMEOUT_MS);
  const timeout = Number.isFinite(timeoutRaw)
    ? Math.max(MIN_HTTP_TIMEOUT_MS, Math.min(MAX_HTTP_TIMEOUT_MS, Math.round(timeoutRaw)))
    : DEFAULT_HTTP_TIMEOUT_MS;

  const headers = parameters.headers && typeof parameters.headers === 'object'
    ? { ...parameters.headers }
    : {};

  const requestConfig = {
    url,
    method,
    timeout,
    headers,
    params: parameters.query && typeof parameters.query === 'object' ? parameters.query : undefined,
    responseType: typeof parameters.responseType === 'string' ? parameters.responseType : 'text',
    maxRedirects: Number.isInteger(parameters.maxRedirects) ? parameters.maxRedirects : 5,
    validateStatus: () => true
  };

  const insecureTls = parameters.insecureTls === true || parameters.rejectUnauthorized === false;
  if (insecureTls && /^https:\/\//i.test(url)) {
    requestConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  if (parameters.basicAuth && typeof parameters.basicAuth === 'object') {
    const username = String(parameters.basicAuth.username || '').trim();
    const password = String(parameters.basicAuth.password || '');
    if (username) {
      requestConfig.auth = { username, password };
    }
  } else if (parameters.auth && typeof parameters.auth === 'object') {
    const username = String(parameters.auth.username || '').trim();
    const password = String(parameters.auth.password || '');
    if (username) {
      requestConfig.auth = { username, password };
    }
  }

  const hasBody = Object.prototype.hasOwnProperty.call(parameters, 'body')
    || Object.prototype.hasOwnProperty.call(parameters, 'data');
  if (hasBody && !['GET', 'HEAD'].includes(method)) {
    requestConfig.data = Object.prototype.hasOwnProperty.call(parameters, 'body')
      ? parameters.body
      : parameters.data;
  }

  const response = await axios.request(requestConfig);

  const expectedStatus = Array.isArray(parameters.expectedStatus)
    ? parameters.expectedStatus.map((value) => Number(value)).filter((value) => Number.isInteger(value))
    : [];
  const status = Number(response?.status || 0);
  const statusMin = Number(parameters.expectedStatusMin);
  const statusMax = Number(parameters.expectedStatusMax);

  const isExpected = expectedStatus.length > 0
    ? expectedStatus.includes(status)
    : (
        Number.isFinite(statusMin) && Number.isFinite(statusMax)
          ? status >= statusMin && status <= statusMax
          : status >= 200 && status < 300
      );

  if (!isExpected) {
    throw new Error(`HTTP ${method} ${url} returned unexpected status ${status}`);
  }

  return {
    target: url,
    message: `HTTP ${method} ${url} -> ${status}`,
    status
  };
}

async function executeIsyNetworkResource(action) {
  const parameters = action?.parameters || {};
  const payload = {
    resourceId: parameters.resourceId || action?.target || null,
    resourceName: parameters.resourceName || null
  };

  const response = await insteonService.executeISYNetworkResource(payload);
  return {
    target: response?.resourceId || payload.resourceId || payload.resourceName || action?.target || null,
    message: response?.message || 'ISY network resource executed'
  };
}

async function executeDelay(action, context = {}, options = {}) {
  const seconds = Number.isFinite(options.resolvedDelaySeconds)
    ? options.resolvedDelaySeconds
    : resolveDelaySeconds(action);
  if (seconds > 0) {
    await sleepWithStopCheck(seconds * 1000, context);
  }

  return {
    target: action?.target || null,
    message: `Delay complete (${seconds}s)`
  };
}

async function evaluateExpression(expression, context = {}) {
  if (!expression || typeof expression !== 'object') {
    return false;
  }

  if (expression.op === 'and' && Array.isArray(expression.conditions)) {
    for (const child of expression.conditions) {
      // eslint-disable-next-line no-await-in-loop
      if (!await evaluateExpression(child, context)) {
        return false;
      }
    }
    return true;
  }

  if (expression.op === 'or' && Array.isArray(expression.conditions)) {
    for (const child of expression.conditions) {
      // eslint-disable-next-line no-await-in-loop
      if (await evaluateExpression(child, context)) {
        return true;
      }
    }
    return false;
  }

  if (expression.op === 'not') {
    return !(await evaluateExpression(expression.condition, context));
  }

  if (expression.kind === 'time_is') {
    const now = new Date();
    const hour = Number(expression.hour);
    const minute = Number(expression.minute);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      return false;
    }
    if (!matchesExpressionDays(expression.days, now)) {
      return false;
    }
    return now.getHours() === hour && now.getMinutes() === minute;
  }

  if (expression.kind === 'time_window') {
    const now = new Date();
    if (!matchesExpressionDays(expression.days, now)) {
      return false;
    }

    const start = parseClockInput(expression.start);
    const end = parseClockInput(expression.end);
    if (!start || !end) {
      return false;
    }

    const nowMinutes = minutesOfDay(now.getHours(), now.getMinutes());
    const startMinutes = minutesOfDay(start.hour, start.minute);
    const endMinutes = minutesOfDay(end.hour, end.minute);

    if (startMinutes === endMinutes) {
      return true;
    }
    if (startMinutes < endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  if (expression.kind === 'device_state') {
    const deviceId = expression.deviceId || context?.deviceId;
    if (!deviceId) {
      return false;
    }

    const device = await Device.findById(deviceId).lean();
    if (!device) {
      return false;
    }

    const property = expression.property || 'status';
    const leftValue = resolveDeviceProperty(device, property, device.status);

    const operator = String(expression.operator || 'eq').toLowerCase();
    const expected = Object.prototype.hasOwnProperty.call(expression, 'value')
      ? resolveValueReference(expression.value, context)
      : resolveValueReference(expression.state, context);
    return compareValues(leftValue, operator, expected);
  }

  if (expression.kind === 'isy_variable') {
    const variableName = expression.name || expression.variable;
    const current = readIsyVariable(variableName, expression.defaultValue || 0);
    const operator = String(expression.operator || 'eq').toLowerCase();
    const expected = resolveValueReference(expression.value, context);
    return compareValues(current, operator, expected);
  }

  if (expression.kind === 'isy_program_state') {
    const programKey = expression.isyProgramId || expression.programName || expression.programKey;
    const property = String(expression.property || 'status').toLowerCase();
    const operator = String(expression.operator || 'eq').toLowerCase();
    const expected = resolveValueReference(expression.value, context);

    if (property === 'enabled') {
      const workflow = await resolveWorkflowReference({
        isyProgramId: expression.isyProgramId,
        programName: expression.programName
      });
      const enabledValue = workflow ? Boolean(workflow.enabled) : Boolean(getIsyProgramMeta(programKey)?.enabled);
      return compareValues(enabledValue, operator, expected);
    }

    const statusValue = getIsyProgramState(programKey, false);
    return compareValues(statusValue, operator, expected);
  }

  if (expression.kind === 'literal') {
    return Boolean(resolveValueReference(expression.value, context));
  }

  return false;
}

async function evaluateCondition(action, context = {}) {
  const parameters = action?.parameters || {};
  const operator = (parameters.operator || 'eq').toString().toLowerCase();

  if (parameters.expression && typeof parameters.expression === 'object') {
    return evaluateExpression(parameters.expression, context);
  }

  if (parameters.deviceId && parameters.property) {
    const device = await Device.findById(parameters.deviceId).lean();
    if (!device) {
      return false;
    }
    const leftValue = resolveDeviceProperty(device, parameters.property, device.status);
    return compareValues(leftValue, operator, resolveValueReference(parameters.value, context));
  }

  if (Object.prototype.hasOwnProperty.call(parameters, 'left')) {
    return compareValues(
      resolveValueReference(parameters.left, context),
      operator,
      resolveValueReference(parameters.right, context)
    );
  }

  if (Object.prototype.hasOwnProperty.call(parameters, 'contextKey')) {
    const contextValue = context?.[parameters.contextKey];
    return compareValues(contextValue, operator, resolveValueReference(parameters.value, context));
  }

  return true;
}

async function executeVariableControl(action, context = {}) {
  const parameters = action?.parameters || {};
  const variableName = parameters.variable || parameters.variableName || action?.target;
  if (!variableName) {
    throw new Error('Variable name is required');
  }

  const operationRaw = String(parameters.operation || parameters.op || 'assign').toLowerCase();
  const operationMap = {
    '=': 'assign',
    assign: 'assign',
    set: 'assign',
    '+=': 'add',
    add: 'add',
    '-=': 'subtract',
    subtract: 'subtract',
    sub: 'subtract',
    '*=': 'multiply',
    multiply: 'multiply',
    '/=': 'divide',
    divide: 'divide',
    '%=': 'modulo',
    modulo: 'modulo',
    '&=': 'bit_and',
    bit_and: 'bit_and',
    '|=': 'bit_or',
    bit_or: 'bit_or',
    '^=': 'bit_xor',
    bit_xor: 'bit_xor',
    init: 'init',
    init_to: 'init'
  };
  const operation = operationMap[operationRaw] || operationRaw;

  const rhsSource = Object.prototype.hasOwnProperty.call(parameters, 'value')
    ? parameters.value
    : (Object.prototype.hasOwnProperty.call(parameters, 'right') ? parameters.right : 0);
  const rhsValue = resolveValueReference(rhsSource, context);

  const current = Number(readIsyVariable(variableName, 0));
  const numericRhs = Number(rhsValue);
  const operand = Number.isFinite(numericRhs) ? Math.trunc(numericRhs) : 0;
  let nextValue = current;

  switch (operation) {
    case 'assign':
      nextValue = operand;
      break;
    case 'add':
      nextValue = current + operand;
      break;
    case 'subtract':
      nextValue = current - operand;
      break;
    case 'multiply':
      nextValue = current * operand;
      break;
    case 'divide':
      if (operand === 0) {
        throw new Error(`Cannot divide variable ${variableName} by zero`);
      }
      nextValue = Math.trunc(current / operand);
      break;
    case 'modulo':
      if (operand === 0) {
        throw new Error(`Cannot modulo variable ${variableName} by zero`);
      }
      nextValue = current % operand;
      break;
    case 'bit_and':
      nextValue = current & operand;
      break;
    case 'bit_or':
      nextValue = current | operand;
      break;
    case 'bit_xor':
      nextValue = current ^ operand;
      break;
    case 'init':
      writeIsyVariable(variableName, operand, {
        setInit: true,
        type: parameters.variableType || 'integer'
      });
      return {
        target: variableName,
        message: `Initialized ${variableName} init value to ${operand}`,
        value: readIsyVariable(variableName, operand)
      };
    default:
      throw new Error(`Unsupported variable operation: ${operation}`);
  }

  writeIsyVariable(variableName, nextValue, {
    type: parameters.variableType || 'integer'
  });

  return {
    target: variableName,
    message: `Variable ${variableName} ${operation} -> ${nextValue}`,
    value: nextValue
  };
}

async function executeRepeat(action, context = {}, options = {}) {
  const parameters = action?.parameters || {};
  const mode = String(parameters.mode || 'for').toLowerCase();
  const rawActions = Array.isArray(parameters.actions) ? parameters.actions : [];
  if (rawActions.length === 0) {
    return {
      target: null,
      message: 'Repeat skipped (no nested actions)',
      nestedActionResults: []
    };
  }

  const nestedResults = [];
  const nestedContext = {
    ...context,
    __repeatDepth: Number(context.__repeatDepth || 0) + 1
  };

  const maxIterations = Math.max(1, Number(parameters.maxIterations || MAX_REPEAT_EVERY_ITERATIONS));
  const random = parameters.random === true;

  if (mode === 'for') {
    let iterations = Math.max(0, Math.trunc(Number(parameters.count ?? parameters.times ?? 0)));
    if (random) {
      iterations = resolveRandomInteger(0, iterations);
    }

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      ensureWorkflowNotStopped(nestedContext);
      // eslint-disable-next-line no-await-in-loop
      const nested = await executeActionSequence(rawActions, {
        context: nestedContext,
        depth: Number(options.depth || 0) + 1,
        workflowControlDepth: Number(options.workflowControlDepth || 0),
        runtime: options.runtime,
        parentActionIndex: Number.isInteger(options.actionIndex) ? options.actionIndex : options.parentActionIndex
      });
      nested.actionResults.forEach((result) => {
        nestedResults.push({
          ...result,
          repeatIteration: iteration + 1
        });
      });
    }

    return {
      target: null,
      message: `Repeat complete (${iterations} iteration${iterations === 1 ? '' : 's'})`,
      nestedActionResults: nestedResults
    };
  }

  if (mode === 'every') {
    const requested = Number(parameters.intervalSeconds ?? parameters.seconds ?? 0);
    let intervalSeconds = Number.isFinite(requested)
      ? Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.round(requested)))
      : 0;
    if (random && intervalSeconds > 0) {
      intervalSeconds = resolveRandomInteger(0, intervalSeconds);
    }

    let iteration = 0;
    while (iteration < maxIterations) {
      ensureWorkflowNotStopped(nestedContext);
      // eslint-disable-next-line no-await-in-loop
      const nested = await executeActionSequence(rawActions, {
        context: nestedContext,
        depth: Number(options.depth || 0) + 1,
        workflowControlDepth: Number(options.workflowControlDepth || 0),
        runtime: options.runtime,
        parentActionIndex: Number.isInteger(options.actionIndex) ? options.actionIndex : options.parentActionIndex
      });
      nested.actionResults.forEach((result) => {
        nestedResults.push({
          ...result,
          repeatIteration: iteration + 1
        });
      });

      iteration += 1;
      if (iteration >= maxIterations) {
        break;
      }

      if (parameters.continueWhile && typeof parameters.continueWhile === 'object') {
        // eslint-disable-next-line no-await-in-loop
        const continueWhile = await evaluateExpression(parameters.continueWhile, nestedContext);
        if (!continueWhile) {
          break;
        }
      }

      if (intervalSeconds > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleepWithStopCheck(intervalSeconds * 1000, nestedContext);
      }
    }

    return {
      target: null,
      message: `Repeat every complete (${iteration} iteration${iteration === 1 ? '' : 's'})`,
      nestedActionResults: nestedResults
    };
  }

  throw new Error(`Unsupported repeat mode: ${mode}`);
}

async function executeWorkflowControl(action, context = {}, options = {}) {
  const parameters = action?.parameters || {};
  const operation = String(parameters.operation || parameters.action || 'run_if').toLowerCase();

  const preferElsePath = operation === 'run_else' || operation === 'else';
  const workflow = await resolveWorkflowReference(parameters, { preferElsePath });
  if (!workflow) {
    throw new Error('Target workflow/program could not be resolved');
  }

  const targetWorkflowId = workflow._id.toString();
  const nextControlDepth = Number(options.workflowControlDepth || 0) + 1;
  if (nextControlDepth > MAX_WORKFLOW_CONTROL_DEPTH) {
    throw new Error('Max workflow-control recursion depth exceeded');
  }

  const targetContext = {
    ...context,
    workflowId: targetWorkflowId,
    callerWorkflowId: context.workflowId || null
  };

  const isyProgramId = parameters.targetIsyProgramId || parameters.isyProgramId || null;
  const isyProgramName = parameters.programName || parameters.workflowName || workflow.name;

  const setProgramEnabledMeta = (enabled) => {
    if (isyProgramId) {
      setIsyProgramState(isyProgramId, getIsyProgramState(isyProgramId, false), { enabled });
    }
    if (isyProgramName) {
      setIsyProgramState(isyProgramName, getIsyProgramState(isyProgramName, false), { enabled });
    }
  };

  const setProgramRunAtStartupMeta = (runAtStartup) => {
    if (isyProgramId) {
      setIsyProgramState(isyProgramId, getIsyProgramState(isyProgramId, false), { runAtStartup });
    }
    if (isyProgramName) {
      setIsyProgramState(isyProgramName, getIsyProgramState(isyProgramName, false), { runAtStartup });
    }
  };

  if (['enable', 'disable'].includes(operation)) {
    workflow.enabled = operation === 'enable';
    await workflow.save();
    setProgramEnabledMeta(workflow.enabled);
    return {
      target: targetWorkflowId,
      message: `Workflow ${workflow.name} ${workflow.enabled ? 'enabled' : 'disabled'}`
    };
  }

  if (operation === 'set_run_at_startup' || operation === 'set_not_run_at_startup') {
    workflow.isyRunAtStartup = operation === 'set_run_at_startup';
    await workflow.save();
    setProgramRunAtStartupMeta(workflow.isyRunAtStartup);
    return {
      target: targetWorkflowId,
      message: `Workflow ${workflow.name} run-at-startup ${workflow.isyRunAtStartup ? 'enabled' : 'disabled'}`
    };
  }

  if (operation === 'stop') {
    setWorkflowStopRequest(targetWorkflowId);
    return {
      target: targetWorkflowId,
      message: `Workflow ${workflow.name} stop requested`
    };
  }

  clearWorkflowStopRequest(targetWorkflowId);

  if (operation === 'run_then' || operation === 'run_else' || operation === 'then' || operation === 'else') {
    const actions = Array.isArray(workflow.actions) ? workflow.actions : [];
    let thenActions = actions;
    let elseActions = [];
    if (
      actions.length > 0
      && actions[0]?.type === 'condition'
      && actions[0]?.parameters?.evaluator === 'isy_program_if'
    ) {
      thenActions = actions.slice(1);
      elseActions = Array.isArray(actions[0]?.parameters?.onFalseActions)
        ? actions[0].parameters.onFalseActions
        : [];
    }

    const branchActions = (operation === 'run_else' || operation === 'else') ? elseActions : thenActions;
    const nested = await executeActionSequence(branchActions, {
      context: targetContext,
      depth: Number(options.depth || 0) + 1,
      workflowControlDepth: nextControlDepth,
      runtime: options.runtime,
      parentActionIndex: Number.isInteger(options.actionIndex) ? options.actionIndex : options.parentActionIndex
    });

    const branchState = !(operation === 'run_else' || operation === 'else');
    if (isyProgramId) {
      setIsyProgramState(isyProgramId, branchState, { enabled: workflow.enabled, runAtStartup: Boolean(workflow.isyRunAtStartup) });
    }
    if (isyProgramName) {
      setIsyProgramState(isyProgramName, branchState, { enabled: workflow.enabled, runAtStartup: Boolean(workflow.isyRunAtStartup) });
    }

    return {
      target: targetWorkflowId,
      message: `Workflow ${workflow.name} ${branchState ? 'THEN' : 'ELSE'} path executed`,
      nestedActionResults: nested.actionResults || []
    };
  }

  if (operation === 'run' || operation === 'run_if' || operation === 'if') {
    const nested = await executeActionSequence(Array.isArray(workflow.actions) ? workflow.actions : [], {
      context: targetContext,
      depth: Number(options.depth || 0) + 1,
      workflowControlDepth: nextControlDepth,
      runtime: options.runtime,
      parentActionIndex: Number.isInteger(options.actionIndex) ? options.actionIndex : options.parentActionIndex
    });

    return {
      target: targetWorkflowId,
      message: `Workflow ${workflow.name} executed`,
      nestedActionResults: nested.actionResults || []
    };
  }

  throw new Error(`Unsupported workflow control operation: ${operation}`);
}

async function executeAction(action, context = {}, options = {}) {
  ensureWorkflowNotStopped(context);

  switch (action?.type) {
    case 'device_control':
      return executeDeviceControl(action, context);
    case 'scene_activate':
      return executeSceneActivate(action, context);
    case 'http_request':
      return executeHttpRequest(action);
    case 'notification':
      return executeNotification(action);
    case 'isy_network_resource':
      return executeIsyNetworkResource(action);
    case 'delay':
      return executeDelay(action, context, options);
    case 'variable_control':
      return executeVariableControl(action, context);
    case 'workflow_control':
      return executeWorkflowControl(action, context, options);
    case 'repeat':
      return executeRepeat(action, context, options);
    case 'condition': {
      const met = await evaluateCondition(action, context);
      const parameters = action?.parameters || {};
      const edge = String(parameters.edge || '').toLowerCase();
      const hasEdgeMode = ['change', 'rising', 'falling'].includes(edge);
      let conditionOutcome = met ? 'true' : 'false';

      if (hasEdgeMode) {
        const stateKey = parameters.stateKey
          || (parameters.expression ? `expr:${JSON.stringify(parameters.expression)}` : null)
          || `condition:${action?.target || 'none'}:${JSON.stringify(parameters)}`;
        const previous = conditionStateCache.get(stateKey);
        conditionStateCache.set(stateKey, met);
        if (previous === undefined) {
          conditionOutcome = 'unchanged';
        } else if (edge === 'change' && previous === met) {
          conditionOutcome = 'unchanged';
        } else if (edge === 'rising' && !(previous === false && met === true)) {
          conditionOutcome = 'unchanged';
        } else if (edge === 'falling' && !(previous === true && met === false)) {
          conditionOutcome = 'unchanged';
        }
      }

      if (parameters.evaluator === 'isy_program_if') {
        const stateChanged = conditionOutcome !== 'unchanged';
        if (stateChanged) {
          const state = Boolean(met);
          const keys = [
            parameters.isyProgramId,
            parameters.isyProgramName,
            parameters.programStateKey
          ].filter(Boolean);
          keys.forEach((key) => {
            setIsyProgramState(key, state);
          });
        }
      }

      return {
        target: action?.target || null,
        message: conditionOutcome === 'unchanged'
          ? 'Condition unchanged'
          : (met ? 'Condition met' : 'Condition not met'),
        conditionMet: met,
        conditionOutcome
      };
    }
    default:
      throw new Error(`Unsupported action type: ${action?.type || 'unknown'}`);
  }
}

async function executeActionSequence(actions = [], options = {}) {
  const context = options.context && typeof options.context === 'object'
    ? { ...options.context }
    : {};
  if (!context.workflowId && options.workflowId) {
    context.workflowId = options.workflowId;
  }

  const depth = Number(options.depth || 0);
  const workflowControlDepth = Number(options.workflowControlDepth || 0);
  const runtime = options.runtime && typeof options.runtime === 'object'
    ? options.runtime
    : null;
  const parentActionIndex = Number.isInteger(options.parentActionIndex)
    ? options.parentActionIndex
    : null;
  const results = [];
  let halt = false;

  for (let index = 0; index < actions.length; index += 1) {
    if (halt) {
      break;
    }

    const action = actions[index];
    const startedAt = Date.now();
    const startedAtDate = new Date(startedAt);
    const resolvedDelaySeconds = action?.type === 'delay'
      ? resolveDelaySeconds(action)
      : null;
    const nextAction = buildNextActionPreview(actions, index, parentActionIndex);
    const timer = action?.type === 'delay'
      ? buildDelayTimer(resolvedDelaySeconds, startedAtDate)
      : null;

    try {
      ensureWorkflowNotStopped(context);
      await invokeRuntimeHook(runtime, 'onActionStart', {
        actionIndex: index,
        parentActionIndex,
        actionType: action?.type || 'unknown',
        action,
        target: getActionTargetCandidate(action, ['deviceId', 'sceneId']),
        context,
        depth,
        workflowControlDepth,
        startedAt: startedAtDate,
        nextAction,
        timer
      });

      const details = await executeAction(action, context, {
        depth,
        workflowControlDepth,
        runtime,
        actionIndex: index,
        parentActionIndex,
        resolvedDelaySeconds
      });
      const conditionMet = details?.conditionMet;

      const resultEntry = {
        actionIndex: index,
        parentActionIndex,
        actionType: action?.type || 'unknown',
        target: details?.target ?? action?.target ?? null,
        parameters: action?.parameters || {},
        success: true,
        executedAt: new Date(),
        durationMs: Date.now() - startedAt,
        message: details?.message || 'Action executed',
        ...(details?.details && typeof details.details === 'object'
          ? { details: details.details }
          : {})
      };

      results.push(resultEntry);
      await invokeRuntimeHook(runtime, 'onActionComplete', {
        actionIndex: index,
        parentActionIndex,
        action,
        result: resultEntry,
        details,
        context,
        depth,
        workflowControlDepth,
        startedAt: startedAtDate
      });

      if (Array.isArray(details?.nestedActionResults) && details.nestedActionResults.length > 0) {
        details.nestedActionResults.forEach((nestedResult) => {
          results.push({
            ...nestedResult,
            parentActionIndex: index
          });
        });
      }

      if (action?.type === 'condition') {
        const conditionOutcome = details?.conditionOutcome;
        if (conditionOutcome === 'unchanged') {
          halt = true;
        } else if (conditionMet === false) {
          const onFalseActions = Array.isArray(action?.parameters?.onFalseActions)
            ? action.parameters.onFalseActions
            : [];
          if (onFalseActions.length > 0) {
            if (depth >= MAX_NESTED_CONDITION_DEPTH) {
              throw new Error('Max nested condition depth reached while executing onFalseActions');
            }

            const nested = await executeActionSequence(onFalseActions, {
              context,
              depth: depth + 1,
              workflowControlDepth,
              runtime,
              parentActionIndex: index
            });
            nested.actionResults.forEach((nestedResult) => {
              results.push({
                ...nestedResult,
                parentActionIndex: index
              });
            });
          }
          halt = true;
        }
      }
    } catch (error) {
      const resultEntry = {
        actionIndex: index,
        parentActionIndex,
        actionType: action?.type || 'unknown',
        target: action?.target ?? null,
        parameters: action?.parameters || {},
        success: false,
        error: error.message || 'Action failed',
        executedAt: new Date(),
        durationMs: Date.now() - startedAt,
        ...(error?.details && typeof error.details === 'object'
          ? { details: error.details }
          : {})
      };

      results.push(resultEntry);
      await invokeRuntimeHook(runtime, 'onActionError', {
        actionIndex: index,
        parentActionIndex,
        action,
        result: resultEntry,
        error,
        context,
        depth,
        workflowControlDepth,
        startedAt: startedAtDate
      });

      if (/was stopped$/i.test(String(error?.message || ''))) {
        halt = true;
      }
    }
  }

  const successful = results.filter((item) => item.success).length;
  const failed = results.length - successful;

  let status = 'success';
  if (failed > 0 && successful > 0) {
    status = 'partial_success';
  } else if (failed > 0 && successful === 0) {
    status = 'failed';
  }

  return {
    status,
    actionResults: results,
    successfulActions: successful,
    failedActions: failed
  };
}

module.exports = {
  executeActionSequence,
  getActionTargetCandidate
};
