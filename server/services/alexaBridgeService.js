const crypto = require('crypto');
const axios = require('axios');
const AlexaBrokerRegistration = require('../models/AlexaBrokerRegistration');
const AlexaLinkedAccount = require('../models/AlexaLinkedAccount');
const alexaProjectionService = require('./alexaProjectionService');
const deviceService = require('./deviceService');
const sceneService = require('./sceneService');
const workflowService = require('./workflowService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const { executeActionSequence } = require('./workflowExecutionService');
const { getConfiguredPublicOrigin } = require('../utils/publicOrigin');
const { normalizeAlexaName, parseEndpointId } = require('../../shared/alexa/contracts');

const DEFAULT_LINK_CODE_TTL_MINUTES = 15;
const MAX_LINK_CODES = 10;
const BROKER_TIMEOUT_MS = 10000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function randomCodeSegment() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function generateReadableLinkCode() {
  return `HBAX-${randomCodeSegment()}-${randomCodeSegment()}-${randomCodeSegment()}`;
}

function pruneLinkCodes(codes = []) {
  const now = Date.now();
  return (Array.isArray(codes) ? codes : [])
    .filter((entry) => {
      const expiresAt = new Date(entry?.expiresAt || 0).getTime();
      return Number.isFinite(expiresAt) && expiresAt > now;
    })
    .slice(-MAX_LINK_CODES);
}

function sanitizeBrokerBaseUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }

  const parsed = new URL(normalized);
  return parsed.origin;
}

function extractBearerToken(headerValue) {
  const match = String(headerValue || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function normalizeDirectivePayload(requestBody = {}) {
  const directive = requestBody.directive && typeof requestBody.directive === 'object'
    ? requestBody.directive
    : {};
  const header = directive.header && typeof directive.header === 'object'
    ? directive.header
    : {};
  const endpoint = directive.endpoint && typeof directive.endpoint === 'object'
    ? directive.endpoint
    : {};

  return {
    namespace: requestBody.namespace || directive.namespace || header.namespace || '',
    name: requestBody.name || directive.name || header.name || '',
    payload: requestBody.payload || directive.payload || {},
    endpointId: requestBody.endpointId || endpoint.endpointId || '',
    correlationToken: requestBody.correlationToken || header.correlationToken || directive.correlationToken || '',
    rawDirective: directive
  };
}

function getPropertyValue(properties = [], namespace, name) {
  return (Array.isArray(properties) ? properties : [])
    .find((entry) => entry?.namespace === namespace && entry?.name === name)?.value;
}

function alexaColorToHex(color) {
  if (!color || typeof color !== 'object') {
    return null;
  }

  const hue = Number(color.hue);
  const saturation = Number(color.saturation);
  const brightness = Number(color.brightness);

  if (!Number.isFinite(hue) || !Number.isFinite(saturation) || !Number.isFinite(brightness)) {
    return null;
  }

  const s = Math.max(0, Math.min(1, saturation));
  const v = Math.max(0, Math.min(1, brightness));
  const c = v * s;
  const normalizedHue = ((hue % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const m = v - c;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (normalizedHue < 60) {
    rPrime = c;
    gPrime = x;
  } else if (normalizedHue < 120) {
    rPrime = x;
    gPrime = c;
  } else if (normalizedHue < 180) {
    gPrime = c;
    bPrime = x;
  } else if (normalizedHue < 240) {
    gPrime = x;
    bPrime = c;
  } else if (normalizedHue < 300) {
    rPrime = x;
    bPrime = c;
  } else {
    rPrime = c;
    bPrime = x;
  }

  const rgb = [rPrime, gPrime, bPrime]
    .map((value) => Math.round((value + m) * 255))
    .map((value) => Math.max(0, Math.min(255, value)))
    .map((value) => value.toString(16).padStart(2, '0'));

  return `#${rgb.join('')}`;
}

function mapThermostatModeForHomeBrain(mode) {
  const normalized = String(mode || '').trim().toUpperCase();
  switch (normalized) {
    case 'AUTO':
      return 'auto';
    case 'COOL':
      return 'cool';
    case 'HEAT':
      return 'heat';
    case 'OFF':
      return 'off';
    default:
      return '';
  }
}

function buildGroupControlAction(groupName, actionName, value) {
  const parameters = { action: actionName };
  if (value !== undefined) {
    parameters.value = value;
  }
  if (actionName === 'setbrightness') {
    parameters.brightness = value;
  }
  if (actionName === 'setcolor') {
    parameters.color = value;
  }
  if (actionName === 'settemperature') {
    parameters.temperature = value;
  }
  if (actionName === 'setcolortemperature') {
    parameters.colorTemperature = value;
  }
  if (actionName === 'setmode') {
    parameters.mode = value;
  }

  return {
    type: 'device_control',
    target: {
      kind: 'device_group',
      group: groupName
    },
    parameters
  };
}

class AlexaBridgeService {
  constructor() {
    this.started = false;
    this.handleDeviceUpdate = this.handleDeviceUpdate.bind(this);
  }

  async ensureRegistration() {
    return alexaProjectionService.ensureBrokerRegistration();
  }

  async appendActivity(registration, entry = {}) {
    const target = registration || await this.ensureRegistration();
    target.recentActivity = [
      ...(Array.isArray(target.recentActivity) ? target.recentActivity : []),
      {
        direction: entry.direction || 'system',
        type: entry.type || 'unknown',
        status: entry.status || 'info',
        message: entry.message || '',
        details: entry.details && typeof entry.details === 'object' ? entry.details : {},
        occurredAt: entry.occurredAt || new Date()
      }
    ].slice(-50);
    await target.save();
    return target;
  }

  async getSummary() {
    const [registration, catalog, exposures, linkedAccounts] = await Promise.all([
      this.ensureRegistration(),
      alexaProjectionService.buildCatalog(),
      alexaProjectionService.listExposureSummaries(),
      AlexaLinkedAccount.find().sort({ linkedAt: -1 }).lean()
    ]);

    return {
      hubId: registration.hubId,
      status: registration.status,
      mode: registration.mode,
      brokerBaseUrl: registration.brokerBaseUrl,
      brokerClientId: registration.brokerClientId,
      brokerDisplayName: registration.brokerDisplayName,
      proactiveEventsEnabled: registration.proactiveEventsEnabled !== false,
      publicOrigin: registration.publicOrigin || getConfiguredPublicOrigin(),
      lastRegisteredAt: registration.lastRegisteredAt,
      lastSeenAt: registration.lastSeenAt,
      lastCatalogSyncAt: registration.lastCatalogSyncAt,
      lastCatalogSyncStatus: registration.lastCatalogSyncStatus,
      lastCatalogSyncError: registration.lastCatalogSyncError,
      lastStateSyncAt: registration.lastStateSyncAt,
      lastStateSyncStatus: registration.lastStateSyncStatus,
      lastStateSyncError: registration.lastStateSyncError,
      linkedAccounts,
      recentActivity: Array.isArray(registration.recentActivity) ? registration.recentActivity.slice(-20).reverse() : [],
      exposureStats: {
        total: exposures.length,
        enabled: exposures.filter((entry) => entry.enabled).length,
        valid: catalog.endpoints.length
      }
    };
  }

  async listExposures() {
    return alexaProjectionService.listExposureSummaries();
  }

  async upsertExposure(entityType, entityId, updates = {}) {
    const exposure = await alexaProjectionService.upsertExposure(entityType, entityId, updates);
    void this.pushCatalogToBroker('exposure_updated').catch((error) => {
      console.warn(`AlexaBridgeService: Failed to push catalog after exposure update: ${error.message}`);
    });
    return exposure;
  }

  async generateLinkCode({ actor = 'system', mode = 'private', ttlMinutes = DEFAULT_LINK_CODE_TTL_MINUTES } = {}) {
    const registration = await this.ensureRegistration();
    const code = generateReadableLinkCode();
    const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlMinutes || DEFAULT_LINK_CODE_TTL_MINUTES)) * 60 * 1000);

    registration.pendingLinkCodes = pruneLinkCodes([
      ...(Array.isArray(registration.pendingLinkCodes) ? registration.pendingLinkCodes : []),
      {
        codeHash: sha256(code),
        codePreview: code.slice(-4),
        mode: mode === 'public' ? 'public' : 'private',
        createdBy: actor,
        createdAt: new Date(),
        expiresAt
      }
    ]);
    await registration.save();
    await this.appendActivity(registration, {
      direction: 'system',
      type: 'link_code_issued',
      status: 'success',
      message: `Issued ${mode === 'public' ? 'public' : 'private'} Alexa pairing code`,
      details: { createdBy: actor, expiresAt, mode }
    });

    return {
      hubId: registration.hubId,
      code,
      codePreview: code.slice(-4),
      mode: mode === 'public' ? 'public' : 'private',
      expiresAt,
      publicOrigin: registration.publicOrigin || getConfiguredPublicOrigin()
    };
  }

  async registerBroker(payload = {}) {
    const registration = await this.ensureRegistration();
    const providedLinkCode = String(payload.linkCode || '').trim();
    if (!providedLinkCode) {
      throw new Error('Pairing link code is required');
    }

    const pendingCodes = pruneLinkCodes(registration.pendingLinkCodes);
    const matchingCode = pendingCodes.find((entry) => secureEqual(entry.codeHash, sha256(providedLinkCode)));
    if (!matchingCode) {
      throw new Error('Pairing link code is invalid or expired');
    }

    const relayToken = crypto.randomBytes(32).toString('hex');
    registration.pendingLinkCodes = pendingCodes.filter((entry) => entry.codeHash !== matchingCode.codeHash);
    registration.status = 'paired';
    registration.mode = payload.mode === 'public' || matchingCode.mode === 'public' ? 'public' : 'private';
    registration.brokerBaseUrl = sanitizeBrokerBaseUrl(payload.brokerBaseUrl || registration.brokerBaseUrl);
    registration.brokerClientId = String(payload.brokerClientId || '').trim();
    registration.brokerDisplayName = normalizeAlexaName(payload.brokerDisplayName, registration.brokerDisplayName || 'HomeBrain Alexa Broker');
    registration.relayTokenHash = sha256(relayToken);
    registration.publicOrigin = getConfiguredPublicOrigin();
    registration.lastRegisteredAt = new Date();
    registration.lastSeenAt = new Date();
    await registration.save();

    await this.appendActivity(registration, {
      direction: 'inbound',
      type: 'broker_registered',
      status: 'success',
      message: `Broker paired in ${registration.mode} mode`,
      details: {
        brokerBaseUrl: registration.brokerBaseUrl,
        brokerClientId: registration.brokerClientId,
        brokerDisplayName: registration.brokerDisplayName
      }
    });

    return {
      success: true,
      hubId: registration.hubId,
      relayToken,
      status: registration.status,
      mode: registration.mode,
      publicOrigin: registration.publicOrigin,
      endpoints: {
        health: '/api/alexa/broker/health',
        catalog: '/api/alexa/broker/catalog',
        execute: '/api/alexa/broker/execute',
        state: '/api/alexa/broker/state',
        accounts: '/api/alexa/broker/accounts'
      }
    };
  }

  async authenticateBrokerRequest(req) {
    const registration = await this.ensureRegistration();
    if (registration.status !== 'paired' || !registration.relayTokenHash) {
      const error = new Error('Alexa broker is not paired');
      error.status = 401;
      throw error;
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token || !secureEqual(registration.relayTokenHash, sha256(token))) {
      const error = new Error('Invalid Alexa broker credentials');
      error.status = 401;
      throw error;
    }

    const requestedHubId = String(req.headers['x-homebrain-hub-id'] || '').trim();
    if (requestedHubId && requestedHubId !== registration.hubId) {
      const error = new Error('Broker hub ID mismatch');
      error.status = 403;
      throw error;
    }

    registration.lastSeenAt = new Date();
    await registration.save();
    return registration;
  }

  async buildHealth() {
    const [summary, catalog] = await Promise.all([
      this.getSummary(),
      alexaProjectionService.buildCatalog()
    ]);

    return {
      success: true,
      hubId: summary.hubId,
      status: summary.status,
      mode: summary.mode,
      publicOrigin: summary.publicOrigin,
      brokerBaseUrl: summary.brokerBaseUrl,
      endpointsExposed: catalog.endpoints.length,
      proactiveEventsEnabled: summary.proactiveEventsEnabled,
      lastSeenAt: summary.lastSeenAt,
      generatedAt: new Date().toISOString()
    };
  }

  async getCatalog() {
    const catalog = await alexaProjectionService.buildCatalog();
    return {
      success: true,
      hubId: catalog.hubId,
      endpoints: catalog.endpoints,
      count: catalog.endpoints.length
    };
  }

  async getStateSnapshot(endpointIds = []) {
    const ids = Array.isArray(endpointIds)
      ? endpointIds.filter((entry) => typeof entry === 'string' && entry.trim())
      : [];

    const catalog = ids.length > 0
      ? await Promise.all(ids.map((endpointId) => alexaProjectionService.getStateForEndpoint(endpointId)))
      : (await alexaProjectionService.buildCatalog()).endpoints.map((endpoint) => ({
        endpointId: endpoint.endpointId,
        entityType: endpoint.cookie?.entityType,
        entityId: endpoint.cookie?.entityId,
        properties: endpoint.state?.properties || [],
        connectivity: endpoint.state?.connectivity || 'OK'
      }));

    return {
      success: true,
      states: catalog,
      count: catalog.length
    };
  }

  async executeDirective(body = {}) {
    const normalized = normalizeDirectivePayload(body);
    if (!normalized.endpointId) {
      throw new Error('Alexa directive endpoint ID is required');
    }
    if (!normalized.namespace || !normalized.name) {
      throw new Error('Alexa directive namespace and name are required');
    }

    const record = await alexaProjectionService.getCatalogEntryByEndpointId(normalized.endpointId);
    if (!record?.endpoint || record.validationErrors.length > 0) {
      throw new Error('Alexa endpoint is not currently valid');
    }

    const namespace = normalized.namespace;
    const name = normalized.name;
    const payload = normalized.payload || {};

    if (namespace === 'Alexa.SceneController' && name === 'Activate') {
      if (record.exposure.entityType === 'scene') {
        await sceneService.activateScene(record.exposure.entityId);
      } else if (record.exposure.entityType === 'workflow') {
        await workflowService.executeWorkflow(record.exposure.entityId, {
          triggerType: 'manual',
          triggerSource: 'alexa',
          context: {
            source: 'alexa',
            endpointId: normalized.endpointId
          }
        });
      } else {
        throw new Error('Scene activation directive is only valid for Alexa scene endpoints');
      }
    } else if (record.exposure.entityType === 'device') {
      await this.executeDeviceDirective(record, namespace, name, payload);
    } else if (record.exposure.entityType === 'device_group') {
      await this.executeGroupDirective(record, namespace, name, payload);
    } else {
      throw new Error(`Unsupported Alexa directive ${namespace}.${name} for ${record.exposure.entityType}`);
    }

    const state = await alexaProjectionService.getStateForEndpoint(normalized.endpointId);
    return {
      success: true,
      endpointId: normalized.endpointId,
      entityType: record.exposure.entityType,
      entityId: record.exposure.entityId,
      namespace,
      name,
      correlationToken: normalized.correlationToken,
      properties: state.properties,
      connectivity: state.connectivity
    };
  }

  async executeDeviceDirective(record, namespace, name, payload) {
    const deviceId = record.exposure.entityId;
    const currentProperties = record.endpoint?.state?.properties || [];

    if (namespace === 'Alexa.PowerController') {
      await deviceService.controlDevice(deviceId, name === 'TurnOn' ? 'turn_on' : 'turn_off');
      return;
    }

    if (namespace === 'Alexa.BrightnessController') {
      if (name === 'SetBrightness') {
        await deviceService.controlDevice(deviceId, 'set_brightness', payload.brightness);
        return;
      }

      if (name === 'AdjustBrightness') {
        const current = Number(getPropertyValue(currentProperties, 'Alexa.BrightnessController', 'brightness') || 0);
        await deviceService.controlDevice(deviceId, 'set_brightness', Math.max(0, Math.min(100, current + Number(payload.brightnessDelta || 0))));
        return;
      }
    }

    if (namespace === 'Alexa.ColorController' && name === 'SetColor') {
      const color = alexaColorToHex(payload.color);
      if (!color) {
        throw new Error('Alexa color payload is invalid');
      }
      await deviceService.controlDevice(deviceId, 'set_color', color);
      return;
    }

    if (namespace === 'Alexa.ColorTemperatureController') {
      const current = Number(getPropertyValue(currentProperties, 'Alexa.ColorTemperatureController', 'colorTemperatureInKelvin') || 4000);
      if (name === 'SetColorTemperature') {
        await deviceService.controlDevice(deviceId, 'set_color_temperature', payload.colorTemperatureInKelvin);
        return;
      }

      if (name === 'IncreaseColorTemperature') {
        await deviceService.controlDevice(deviceId, 'set_color_temperature', current + 500);
        return;
      }

      if (name === 'DecreaseColorTemperature') {
        await deviceService.controlDevice(deviceId, 'set_color_temperature', current - 500);
        return;
      }
    }

    if (namespace === 'Alexa.ThermostatController') {
      if (name === 'SetTargetTemperature') {
        await deviceService.controlDevice(deviceId, 'set_temperature', payload.targetSetpoint?.value);
        return;
      }

      if (name === 'AdjustTargetTemperature') {
        const current = Number(getPropertyValue(currentProperties, 'Alexa.ThermostatController', 'targetSetpoint')?.value || record.entity?.targetTemperature || 0);
        await deviceService.controlDevice(deviceId, 'set_temperature', current + Number(payload.targetSetpointDelta?.value || 0));
        return;
      }

      if (name === 'SetThermostatMode') {
        const mode = mapThermostatModeForHomeBrain(payload.thermostatMode?.value || payload.thermostatMode);
        if (!mode) {
          throw new Error('Alexa thermostat mode payload is invalid');
        }
        await deviceService.controlDevice(deviceId, 'set_mode', mode);
        return;
      }
    }

    if (namespace === 'Alexa.LockController') {
      await deviceService.controlDevice(deviceId, name === 'Lock' ? 'lock' : 'unlock');
      return;
    }

    throw new Error(`Unsupported Alexa directive ${namespace}.${name}`);
  }

  async executeGroupDirective(record, namespace, name, payload) {
    const currentProperties = record.endpoint?.state?.properties || [];
    const groupName = record.entity?.name;
    if (!groupName) {
      throw new Error('Device group could not be found');
    }

    let actionName = '';
    let value;

    if (namespace === 'Alexa.PowerController') {
      actionName = name === 'TurnOn' ? 'turn_on' : 'turn_off';
    } else if (namespace === 'Alexa.BrightnessController') {
      if (name === 'SetBrightness') {
        actionName = 'set_brightness';
        value = payload.brightness;
      } else if (name === 'AdjustBrightness') {
        const current = Number(getPropertyValue(currentProperties, 'Alexa.BrightnessController', 'brightness') || 0);
        actionName = 'set_brightness';
        value = Math.max(0, Math.min(100, current + Number(payload.brightnessDelta || 0)));
      }
    } else if (namespace === 'Alexa.ColorController' && name === 'SetColor') {
      actionName = 'set_color';
      value = alexaColorToHex(payload.color);
    } else if (namespace === 'Alexa.ColorTemperatureController') {
      const current = Number(getPropertyValue(currentProperties, 'Alexa.ColorTemperatureController', 'colorTemperatureInKelvin') || 4000);
      actionName = 'set_color_temperature';
      if (name === 'SetColorTemperature') {
        value = payload.colorTemperatureInKelvin;
      } else if (name === 'IncreaseColorTemperature') {
        value = current + 500;
      } else if (name === 'DecreaseColorTemperature') {
        value = current - 500;
      }
    }

    if (!actionName) {
      throw new Error(`Unsupported Alexa group directive ${namespace}.${name}`);
    }

    const result = await executeActionSequence([buildGroupControlAction(groupName, actionName, value)], {
      context: {
        source: 'alexa',
        endpointId: record.endpoint.endpointId
      }
    });

    if (result.failedActions > 0) {
      const failure = result.actionResults.find((entry) => entry.success === false);
      throw new Error(failure?.error || 'Failed to execute Alexa group directive');
    }
  }

  async syncLinkedAccounts(accounts = []) {
    const registration = await this.ensureRegistration();
    const list = Array.isArray(accounts) ? accounts : [accounts];
    const persisted = [];

    for (const account of list) {
      const brokerAccountId = String(account?.brokerAccountId || account?.id || '').trim();
      if (!brokerAccountId) {
        continue;
      }

      let linkedAccount = await AlexaLinkedAccount.findOne({
        hubId: registration.hubId,
        brokerAccountId
      });

      if (!linkedAccount) {
        linkedAccount = new AlexaLinkedAccount({
          hubId: registration.hubId,
          brokerAccountId
        });
      }

      linkedAccount.alexaUserId = String(account?.alexaUserId || '').trim();
      linkedAccount.alexaAccountId = String(account?.alexaAccountId || '').trim();
      linkedAccount.alexaHouseholdId = String(account?.alexaHouseholdId || '').trim();
      linkedAccount.locale = String(account?.locale || linkedAccount.locale || 'en-US').trim() || 'en-US';
      linkedAccount.status = account?.status === 'revoked' ? 'revoked' : account?.status === 'pending' ? 'pending' : 'linked';
      linkedAccount.permissions = Array.isArray(account?.permissions) ? account.permissions.filter(Boolean) : [];
      linkedAccount.acceptedGrantAt = account?.acceptedGrantAt ? new Date(account.acceptedGrantAt) : linkedAccount.acceptedGrantAt;
      linkedAccount.lastDiscoveryAt = account?.lastDiscoveryAt ? new Date(account.lastDiscoveryAt) : linkedAccount.lastDiscoveryAt;
      linkedAccount.lastSeenAt = account?.lastSeenAt ? new Date(account.lastSeenAt) : new Date();
      linkedAccount.metadata = account?.metadata && typeof account.metadata === 'object' ? account.metadata : {};
      await linkedAccount.save();
      persisted.push(linkedAccount.toObject());
    }

    await this.appendActivity(registration, {
      direction: 'inbound',
      type: 'linked_accounts_synced',
      status: 'success',
      message: `Synced ${persisted.length} Alexa linked account record(s)`,
      details: { count: persisted.length }
    });

    return persisted;
  }

  async notifyBroker(pathname, payload, meta = {}) {
    const registration = await this.ensureRegistration();
    if (registration.status !== 'paired' || !registration.brokerBaseUrl) {
      return {
        skipped: true,
        reason: 'Broker is not paired or does not have a base URL'
      };
    }

    try {
      const response = await axios.post(`${registration.brokerBaseUrl}${pathname}`, payload, {
        timeout: BROKER_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-HomeBrain-Hub-Id': registration.hubId
        }
      });

      if (meta.kind === 'catalog') {
        registration.lastCatalogSyncAt = new Date();
        registration.lastCatalogSyncStatus = 'success';
        registration.lastCatalogSyncError = '';
      }
      if (meta.kind === 'state') {
        registration.lastStateSyncAt = new Date();
        registration.lastStateSyncStatus = 'success';
        registration.lastStateSyncError = '';
      }
      await registration.save();

      await this.appendActivity(registration, {
        direction: 'outbound',
        type: meta.type || 'broker_notify',
        status: 'success',
        message: meta.message || 'Delivered Alexa payload to broker',
        details: { pathname, status: response.status }
      });

      return {
        success: true,
        status: response.status,
        data: response.data
      };
    } catch (error) {
      if (meta.kind === 'catalog') {
        registration.lastCatalogSyncAt = new Date();
        registration.lastCatalogSyncStatus = 'failed';
        registration.lastCatalogSyncError = error.message;
      }
      if (meta.kind === 'state') {
        registration.lastStateSyncAt = new Date();
        registration.lastStateSyncStatus = 'failed';
        registration.lastStateSyncError = error.message;
      }
      await registration.save();

      await this.appendActivity(registration, {
        direction: 'outbound',
        type: meta.type || 'broker_notify',
        status: 'error',
        message: meta.failureMessage || error.message,
        details: {
          pathname,
          error: error.message,
          status: error.response?.status || null
        }
      });

      throw error;
    }
  }

  async pushCatalogToBroker(reason = 'manual') {
    const catalog = await alexaProjectionService.buildCatalog();
    return this.notifyBroker('/api/alexa/hubs/catalog', {
      hubId: catalog.hubId,
      reason,
      timestamp: new Date().toISOString(),
      endpoints: catalog.endpoints
    }, {
      kind: 'catalog',
      type: 'catalog_sync',
      message: `Pushed Alexa catalog to broker (${reason})`,
      failureMessage: `Failed to push Alexa catalog to broker (${reason})`
    });
  }

  async pushStateChangesToBroker(endpointIds = [], reason = 'state_changed') {
    const snapshot = await this.getStateSnapshot(endpointIds);
    return this.notifyBroker('/api/alexa/hubs/state', {
      hubId: (await this.ensureRegistration()).hubId,
      reason,
      timestamp: new Date().toISOString(),
      states: snapshot.states
    }, {
      kind: 'state',
      type: 'state_sync',
      message: `Pushed Alexa state changes to broker (${reason})`,
      failureMessage: `Failed to push Alexa state changes to broker (${reason})`
    });
  }

  async handleDeviceUpdate(devices = []) {
    try {
      const registration = await this.ensureRegistration();
      if (registration.status !== 'paired' || !registration.brokerBaseUrl) {
        return;
      }

      const catalog = await alexaProjectionService.buildCatalog();
      const endpointIdSet = new Set();
      const deviceIds = new Set((Array.isArray(devices) ? devices : [])
        .map((device) => device?._id?.toString?.() || String(device?._id || ''))
        .filter(Boolean));

      catalog.endpoints.forEach((endpoint) => {
        const parsed = parseEndpointId(endpoint.endpointId);
        if (!parsed) {
          return;
        }

        if (parsed.entityType === 'device' && deviceIds.has(parsed.entityId)) {
          endpointIdSet.add(endpoint.endpointId);
        }

        if (parsed.entityType === 'device_group') {
          const groupDeviceIds = Array.isArray(endpoint.cookie?.groupDeviceIds)
            ? endpoint.cookie.groupDeviceIds
            : [];
          if (groupDeviceIds.some((deviceId) => deviceIds.has(String(deviceId)))) {
            endpointIdSet.add(endpoint.endpointId);
          }
        }
      });

      if (endpointIdSet.size === 0) {
        return;
      }

      await this.pushStateChangesToBroker(Array.from(endpointIdSet), 'device_update');
    } catch (error) {
      console.warn(`AlexaBridgeService: Failed to process device update for broker sync: ${error.message}`);
    }
  }

  start() {
    if (this.started) {
      return;
    }

    deviceUpdateEmitter.on('devices:update', this.handleDeviceUpdate);
    this.started = true;
  }
}

const alexaBridgeService = new AlexaBridgeService();

module.exports = alexaBridgeService;
module.exports.AlexaBridgeService = AlexaBridgeService;
module.exports.alexaColorToHex = alexaColorToHex;
module.exports.mapThermostatModeForHomeBrain = mapThermostatModeForHomeBrain;
module.exports.normalizeDirectivePayload = normalizeDirectivePayload;
module.exports.generateReadableLinkCode = generateReadableLinkCode;
