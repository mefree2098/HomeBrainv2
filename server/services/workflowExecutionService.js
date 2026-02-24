const Device = require('../models/Device');
const deviceService = require('./deviceService');
const sceneService = require('./sceneService');
const insteonService = require('./insteonService');

const MAX_DELAY_SECONDS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function compareValues(left, operator, right) {
  const lhs = normalizeComparable(left);
  const rhs = normalizeComparable(right);
  switch (operator) {
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

async function executeDeviceControl(action) {
  const target = action?.target || action?.deviceId;
  if (!target) {
    throw new Error('Device target is required');
  }

  const device = await Device.findById(target).lean();
  if (!device) {
    throw new Error('Device not found');
  }

  const actionName = getActionName(action);
  const value = getActionValue(actionName, action?.parameters || {});
  const source = (device?.properties?.source || '').toString().toLowerCase();

  if (source === 'insteon') {
    switch (actionName) {
      case 'turn_on':
      case 'turnon':
        await insteonService.turnOn(target.toString(), value != null ? Number(value) : 100);
        break;
      case 'turn_off':
      case 'turnoff':
        await insteonService.turnOff(target.toString());
        break;
      case 'set_brightness':
      case 'setbrightness':
        await insteonService.setBrightness(target.toString(), value != null ? Number(value) : 100);
        break;
      default:
        await deviceService.controlDevice(target.toString(), actionName, value);
        break;
    }
  } else {
    await deviceService.controlDevice(target.toString(), actionName, value);
  }

  return {
    target: target.toString(),
    message: `Executed ${actionName} on ${device.name}`,
    value
  };
}

async function executeSceneActivate(action) {
  const sceneId = action?.target || action?.sceneId;
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

async function executeDelay(action) {
  const requested = Number(action?.parameters?.seconds ?? action?.seconds ?? 0);
  const seconds = Number.isFinite(requested) ? Math.max(0, Math.min(MAX_DELAY_SECONDS, requested)) : 0;
  if (seconds > 0) {
    await sleep(seconds * 1000);
  }
  return {
    target: action?.target || null,
    message: `Delay complete (${seconds}s)`
  };
}

async function evaluateCondition(action, context = {}) {
  const parameters = action?.parameters || {};
  const operator = (parameters.operator || 'eq').toString().toLowerCase();

  if (parameters.deviceId && parameters.property) {
    const device = await Device.findById(parameters.deviceId).lean();
    if (!device) {
      return false;
    }
    const leftValue = parameters.property === 'status'
      ? device.status
      : parameters.property === 'isOnline'
        ? device.isOnline
        : device?.[parameters.property];
    return compareValues(leftValue, operator, parameters.value);
  }

  if (Object.prototype.hasOwnProperty.call(parameters, 'left')) {
    return compareValues(parameters.left, operator, parameters.right);
  }

  if (Object.prototype.hasOwnProperty.call(parameters, 'contextKey')) {
    const contextValue = context?.[parameters.contextKey];
    return compareValues(contextValue, operator, parameters.value);
  }

  return true;
}

async function executeAction(action, context = {}) {
  switch (action?.type) {
    case 'device_control':
      return executeDeviceControl(action);
    case 'scene_activate':
      return executeSceneActivate(action);
    case 'notification':
      return executeNotification(action);
    case 'delay':
      return executeDelay(action);
    case 'condition': {
      const met = await evaluateCondition(action, context);
      return {
        target: action?.target || null,
        message: met ? 'Condition met' : 'Condition not met',
        conditionMet: met
      };
    }
    default:
      throw new Error(`Unsupported action type: ${action?.type || 'unknown'}`);
  }
}

async function executeActionSequence(actions = [], options = {}) {
  const context = options.context || {};
  const results = [];
  let halt = false;

  for (let index = 0; index < actions.length; index += 1) {
    if (halt) {
      break;
    }

    const action = actions[index];
    const startedAt = Date.now();

    try {
      const details = await executeAction(action, context);
      const conditionMet = details?.conditionMet;
      if (action?.type === 'condition' && conditionMet === false) {
        halt = true;
      }

      results.push({
        actionIndex: index,
        actionType: action?.type || 'unknown',
        target: details?.target ?? action?.target ?? null,
        parameters: action?.parameters || {},
        success: true,
        executedAt: new Date(),
        durationMs: Date.now() - startedAt,
        message: details?.message || 'Action executed'
      });
    } catch (error) {
      results.push({
        actionIndex: index,
        actionType: action?.type || 'unknown',
        target: action?.target ?? null,
        parameters: action?.parameters || {},
        success: false,
        error: error.message || 'Action failed',
        executedAt: new Date(),
        durationMs: Date.now() - startedAt
      });
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
  executeActionSequence
};
