const crypto = require('crypto');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const SecurityAlarm = require('../models/SecurityAlarm');
const Device = require('../models/Device');
const smartThingsService = require('./smartThingsService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');

const DEFAULT_PERMISSIONS = [
  'r:devices:*',
  'x:devices:*',
  'r:scenes:*',
  'x:scenes:*',
  'r:locations:*',
  'x:locations:*',
  'r:rules:*',
  'w:rules:*',
  'r:security:locations:*:armstate'
];

const trim = (value) => (typeof value === 'string' ? value.trim() : '');
const toDateOrNull = (value) => {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

class SmartThingsWebhookService {
  constructor() {
    this.configurationPageId = 'homebrain-main';
    this.metrics = this.createEmptyMetrics();
    this.eventStallThresholdMs = Number(process.env.SMARTTHINGS_EVENT_STALL_ALERT_MS || 5 * 60 * 1000);
    this.signatureFailureAlertThreshold = Number(process.env.SMARTTHINGS_SIGNATURE_FAILURE_ALERT_THRESHOLD || 3);
    this.signatureFailureAlerted = false;
    this.eventStallAlerted = false;
    this.metricsHistory = [];
    this.metricsHistorySize = Math.max(
      1,
      Number(process.env.SMARTTHINGS_WEBHOOK_METRICS_HISTORY || 1440)
    );
    this.metricsSnapshotIntervalMs = Number(process.env.SMARTTHINGS_WEBHOOK_METRICS_INTERVAL_MS || 60 * 1000);
    this.metricsSamplerTimer = null;
    if (this.metricsSnapshotIntervalMs > 0) {
      this.startMetricsSampler();
    }
  }

  createEmptyMetrics() {
    return {
      received: {
        total: 0,
        successful: 0,
        lastRequestAt: null,
        byLifecycle: {}
      },
      lifecycle: {
        lastAt: null
      },
      signature: {
        failures: 0,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: null
      },
      events: {
        lastAt: null,
        received: 0,
        processedDevices: 0,
        ignoredDevices: 0,
        perCapability: {}
      }
    };
  }

  resetMetrics() {
    this.metrics = this.createEmptyMetrics();
    this.signatureFailureAlerted = false;
    this.eventStallAlerted = false;
    this.metricsHistory = [];
  }

  getMetricsSnapshot() {
    return JSON.parse(JSON.stringify(this.metrics, (key, value) => {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
    }));
  }

  captureMetricsSnapshot(reason = 'manual') {
    const entry = {
      capturedAt: new Date(),
      reason,
      metrics: this.getMetricsSnapshot()
    };

    this.metricsHistory.push(entry);
    if (this.metricsHistory.length > this.metricsHistorySize) {
      this.metricsHistory.splice(0, this.metricsHistory.length - this.metricsHistorySize);
    }

    return entry;
  }

  getMetricsHistory(limit) {
    const effectiveLimit = Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), this.metricsHistory.length)
      : this.metricsHistory.length;

    return this.metricsHistory
      .slice(effectiveLimit === this.metricsHistory.length ? 0 : -effectiveLimit)
      .map((entry) => ({
        capturedAt: entry.capturedAt.toISOString(),
        reason: entry.reason,
        metrics: entry.metrics
      }));
  }

  startMetricsSampler() {
    if (this.metricsSnapshotIntervalMs <= 0) {
      return;
    }

    this.stopMetricsSampler();

    this.metricsSamplerTimer = setInterval(() => {
      try {
        this.captureMetricsSnapshot('interval');
      } catch (error) {
        this.log('warn', 'Failed to capture SmartThings webhook metrics snapshot', { error: error.message });
      }
    }, this.metricsSnapshotIntervalMs);

    if (this.metricsSamplerTimer && typeof this.metricsSamplerTimer.unref === 'function') {
      this.metricsSamplerTimer.unref();
    }

    try {
      this.captureMetricsSnapshot('interval-start');
    } catch (error) {
      this.log('warn', 'Initial SmartThings webhook metrics snapshot failed', { error: error.message });
    }
  }

  stopMetricsSampler() {
    if (this.metricsSamplerTimer) {
      clearInterval(this.metricsSamplerTimer);
      this.metricsSamplerTimer = null;
    }
  }

  updateMetricsConfig({ intervalMs, historySize } = {}) {
    const updates = {};
    let restartSampler = false;

    if (intervalMs !== undefined) {
      const numericInterval = Number(intervalMs);
      if (!Number.isFinite(numericInterval) || numericInterval < 0) {
        throw new Error('metrics interval must be a non-negative number');
      }
      const normalizedInterval = Math.floor(numericInterval);
      if (normalizedInterval !== this.metricsSnapshotIntervalMs) {
        this.metricsSnapshotIntervalMs = normalizedInterval;
        restartSampler = true;
      }
      updates.intervalMs = this.metricsSnapshotIntervalMs;
    } else {
      updates.intervalMs = this.metricsSnapshotIntervalMs;
    }

    if (historySize !== undefined) {
      const numericHistory = Number(historySize);
      if (!Number.isFinite(numericHistory) || numericHistory <= 0) {
        throw new Error('metrics history size must be a positive number');
      }
      const normalizedHistory = Math.floor(numericHistory);
      if (normalizedHistory !== this.metricsHistorySize) {
        this.metricsHistorySize = normalizedHistory;
        if (this.metricsHistory.length > this.metricsHistorySize) {
          this.metricsHistory.splice(0, this.metricsHistory.length - this.metricsHistorySize);
        }
      }
      updates.historySize = this.metricsHistorySize;
    } else {
      updates.historySize = this.metricsHistorySize;
    }

    if (restartSampler) {
      this.stopMetricsSampler();
      if (this.metricsSnapshotIntervalMs > 0) {
        this.startMetricsSampler();
      }
    }

    return updates;
  }

  getPrometheusMetrics() {
    const snapshot = this.getMetricsSnapshot();
    const lines = [];
    const emittedMeta = new Set();

    const pushMetric = (metadata, value, labels) => {
      if (value === undefined || value === null || Number.isNaN(Number(value))) {
        return;
      }

      const labelString = labels && Object.keys(labels).length > 0
        ? `{${Object.entries(labels).map(([key, val]) => `${key}="${String(val).replace(/"/g, '\\"')}"`).join(',')}}`
        : '';

      if (!emittedMeta.has(metadata.name)) {
        if (metadata.help) {
          lines.push(`# HELP ${metadata.name} ${metadata.help}`);
        }
        if (metadata.type) {
          lines.push(`# TYPE ${metadata.name} ${metadata.type}`);
        }
        emittedMeta.add(metadata.name);
      }
      const numericValue = typeof value === 'string' && value.trim() === '' ? 0 : value;
      lines.push(`${metadata.name}${labelString} ${Number(numericValue)}`);
    };

    pushMetric({
      name: 'smartthings_webhook_requests_total',
      help: 'Total SmartThings webhook requests received',
      type: 'counter'
    }, snapshot.received?.total || 0);

    pushMetric({
      name: 'smartthings_webhook_requests_successful_total',
      help: 'Total SmartThings webhook lifecycles successfully handled',
      type: 'counter'
    }, snapshot.received?.successful || 0);

    const lifecycleCounts = snapshot.received?.byLifecycle || {};
    Object.entries(lifecycleCounts).forEach(([lifecycle, count]) => {
      pushMetric({
        name: 'smartthings_webhook_requests_by_lifecycle_total',
        help: 'SmartThings webhook requests by lifecycle',
        type: 'counter'
      }, count || 0, { lifecycle: lifecycle.toLowerCase() });
    });

    pushMetric({
      name: 'smartthings_webhook_signature_failures_total',
      help: 'Total SmartThings webhook signature verification failures',
      type: 'counter'
    }, snapshot.signature?.failures || 0);

    pushMetric({
      name: 'smartthings_webhook_signature_consecutive_failures',
      help: 'Current consecutive SmartThings webhook signature failures',
      type: 'gauge'
    }, snapshot.signature?.consecutiveFailures || 0);

    const signatureTimestamps = [
      ['smartthings_webhook_signature_last_success_timestamp', snapshot.signature?.lastSuccessAt, 'Last successful signature verification time'],
      ['smartthings_webhook_signature_last_failure_timestamp', snapshot.signature?.lastFailureAt, 'Last failed signature verification time']
    ];

    signatureTimestamps.forEach(([metricName, isoValue, help]) => {
      if (!isoValue) {
        return;
      }
      const epochSeconds = Number.isNaN(Date.parse(isoValue)) ? null : Math.floor(Date.parse(isoValue) / 1000);
      if (epochSeconds !== null) {
        pushMetric({
          name: metricName,
          help,
          type: 'gauge'
        }, epochSeconds);
      }
    });

    pushMetric({
      name: 'smartthings_webhook_events_total',
      help: 'Total SmartThings events received via webhook',
      type: 'counter'
    }, snapshot.events?.received || 0);

    pushMetric({
      name: 'smartthings_webhook_events_processed_devices_total',
      help: 'Total number of SmartThings devices processed from webhook events',
      type: 'counter'
    }, snapshot.events?.processedDevices || 0);

    pushMetric({
      name: 'smartthings_webhook_events_ignored_devices_total',
      help: 'Total number of SmartThings devices ignored during webhook processing',
      type: 'counter'
    }, snapshot.events?.ignoredDevices || 0);

    const perCapability = snapshot.events?.perCapability || {};
    Object.entries(perCapability).forEach(([capability, count]) => {
      pushMetric({
        name: 'smartthings_webhook_events_by_capability_total',
        help: 'SmartThings webhook events received by capability',
        type: 'counter'
      }, count || 0, { capability });
    });

    const temporalMetrics = [
      ['smartthings_webhook_last_request_timestamp', snapshot.received?.lastRequestAt, 'Timestamp of the last webhook request received'],
      ['smartthings_webhook_last_lifecycle_timestamp', snapshot.lifecycle?.lastAt, 'Timestamp of the last lifecycle processed'],
      ['smartthings_webhook_last_event_timestamp', snapshot.events?.lastAt, 'Timestamp of the last SmartThings event processed']
    ];

    temporalMetrics.forEach(([metricName, isoValue, help]) => {
      if (!isoValue) {
        return;
      }
      const epochSeconds = Number.isNaN(Date.parse(isoValue)) ? null : Math.floor(Date.parse(isoValue) / 1000);
      if (epochSeconds !== null) {
        pushMetric({
          name: metricName,
          help,
          type: 'gauge'
        }, epochSeconds);
      }
    });

    return `${lines.join('\n')}\n`;
  }

  log(level, message, context = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      service: 'SmartThingsWebhookService',
      level,
      message
    };

    if (context && Object.keys(context).length > 0) {
      entry.context = context;
    }

    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log';
    try {
      console[method](JSON.stringify(entry));
    } catch {
      console[method](`${entry.timestamp} [${entry.service}] ${level.toUpperCase()}: ${message} ${JSON.stringify(context)}`);
    }
  }

  recordRequestReceipt() {
    this.metrics.received.total += 1;
    this.metrics.received.lastRequestAt = new Date();
  }

  recordLifecycle(lifecycle) {
    const now = new Date();
    this.metrics.received.successful += 1;
    this.metrics.lifecycle.lastAt = now;
    this.metrics.received.byLifecycle[lifecycle] = (this.metrics.received.byLifecycle[lifecycle] || 0) + 1;
    this.log('debug', 'Handling SmartThings lifecycle', { lifecycle });
  }

  recordSignatureFailure(reason) {
    const now = new Date();
    this.metrics.signature.failures += 1;
    this.metrics.signature.consecutiveFailures += 1;
    this.metrics.signature.lastFailureAt = now;
    this.log('warn', 'SmartThings signature verification failed', { reason });

    if (this.metrics.signature.consecutiveFailures >= this.signatureFailureAlertThreshold && !this.signatureFailureAlerted) {
      this.signatureFailureAlerted = true;
      this.log('warn', 'Consecutive SmartThings signature failures exceeded threshold', {
        threshold: this.signatureFailureAlertThreshold,
        consecutiveFailures: this.metrics.signature.consecutiveFailures
      });
    }
  }

  recordSignatureSuccess() {
    this.metrics.signature.consecutiveFailures = 0;
    this.metrics.signature.lastSuccessAt = new Date();
    if (this.signatureFailureAlerted) {
      this.signatureFailureAlerted = false;
      this.log('info', 'SmartThings signature verification recovered');
    }
  }

  incrementCapabilityMetric(capability) {
    if (!capability) {
      return;
    }
    this.metrics.events.perCapability[capability] = (this.metrics.events.perCapability[capability] || 0) + 1;
  }

  evaluateEventStall(triggerLifecycle) {
    if (!this.metrics.events.lastAt) {
      return;
    }

    const elapsed = Date.now() - this.metrics.events.lastAt.getTime();
    if (elapsed > this.eventStallThresholdMs) {
      if (!this.eventStallAlerted) {
        this.eventStallAlerted = true;
        this.log('warn', 'SmartThings event stream appears stalled', {
          secondsSinceLastEvent: Math.round(elapsed / 1000),
          triggerLifecycle
        });
      }
    } else if (this.eventStallAlerted && triggerLifecycle === 'EVENT') {
      this.eventStallAlerted = false;
      this.log('info', 'SmartThings event stream recovered', {
        secondsSinceLastEvent: Math.round(elapsed / 1000)
      });
    }
  }

  getRawBody(req) {
    if (!req) {
      return Buffer.alloc(0);
    }

    if (Buffer.isBuffer(req.rawBody)) {
      return req.rawBody;
    }

    if (typeof req.body === 'string') {
      return Buffer.from(req.body, 'utf8');
    }

    // Fallback – stringify object if JSON middleware already ran
    if (req.body && typeof req.body === 'object') {
      try {
        return Buffer.from(JSON.stringify(req.body), 'utf8');
      } catch (error) {
        console.warn(`SmartThings Webhook: failed to serialize payload for signature verification - ${error.message}`);
      }
    }

    return Buffer.alloc(0);
  }

  extractInstalledAppContext(payload, sectionKey) {
    const installedApp = payload?.[sectionKey]?.installedApp || {};
    return {
      installedAppId: trim(installedApp.installedAppId || ''),
      locationId: trim(installedApp.locationId || ''),
      installedApp
    };
  }

  normalizeSubscriptions(subscriptions) {
    if (!Array.isArray(subscriptions)) {
      return [];
    }

    return subscriptions
      .map(subscription => this.normalizeSubscription(subscription))
      .filter(Boolean);
  }

  normalizeSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') {
      return null;
    }

    const sourceType = subscription.sourceType || (subscription.device ? 'DEVICE' : 'CAPABILITY');

    const normalized = {
      subscriptionId: trim(subscription.id || subscription.subscriptionId || ''),
      sourceType,
      deviceId: '',
      capability: '',
      attribute: '',
      componentId: 'main',
      subscriptionName: '',
      stateChangeOnly: true,
      value: '*',
      createdDate: toDateOrNull(subscription.createdDate || subscription.creationTime || subscription.created),
      expirationTime: toDateOrNull(subscription.expirationTime || subscription.expiration)
    };

    if (subscription.capability && typeof subscription.capability === 'object') {
      const { capability, attribute, componentId, deviceId, subscriptionName, stateChangeOnly, value } = subscription.capability;
      normalized.capability = trim(capability || normalized.capability);
      normalized.attribute = trim(attribute || normalized.attribute);
      normalized.componentId = trim(componentId || normalized.componentId);
      normalized.deviceId = trim(deviceId || normalized.deviceId);
      normalized.subscriptionName = trim(subscriptionName || normalized.subscriptionName);
      if (typeof stateChangeOnly === 'boolean') {
        normalized.stateChangeOnly = stateChangeOnly;
      }
      if (value) {
        normalized.value = value;
      }
    }

    if (subscription.device && typeof subscription.device === 'object') {
      const { deviceId, capability, attribute, componentId, subscriptionName, stateChangeOnly, value } = subscription.device;
      normalized.deviceId = trim(deviceId || normalized.deviceId);
      normalized.capability = trim(capability || normalized.capability);
      normalized.attribute = trim(attribute || normalized.attribute);
      normalized.componentId = trim(componentId || normalized.componentId || 'main');
      normalized.subscriptionName = trim(subscriptionName || normalized.subscriptionName);
      if (typeof stateChangeOnly === 'boolean') {
        normalized.stateChangeOnly = stateChangeOnly;
      }
      if (value) {
        normalized.value = value;
      }
    }

    return normalized;
  }
  extractDeviceEvents(events) {
    if (!Array.isArray(events)) {
      return {
        deviceEvents: [],
        relatedDeviceIds: [],
        ignoredEventTypeCounts: [],
        malformedCount: 0
      };
    }

    const deviceEvents = [];
    const ignoredEventTypes = new Map();
    const relatedDeviceIds = new Set();
    let malformedCount = 0;

    for (const entry of events) {
      if (!entry || typeof entry !== 'object') {
        malformedCount += 1;
        continue;
      }

      const eventType = typeof entry.eventType === 'string' ? entry.eventType.toUpperCase() : '';
      const candidate = entry.deviceEvent && typeof entry.deviceEvent === 'object'
        ? entry.deviceEvent
        : null;

      if (eventType === 'SECURITY_ARM_STATE_EVENT') {
        continue;
      }

      if (eventType === 'DEVICE_EVENT' && candidate) {
        const deviceId = trim(candidate.deviceId || '');
        const capability = trim(candidate.capability || '');
        const attribute = trim(candidate.attribute || '');
        const componentId = trim(candidate.componentId || 'main');

        if (!deviceId || !capability || !attribute) {
          malformedCount += 1;
          if (deviceId) {
            relatedDeviceIds.add(deviceId);
          }
          continue;
        }

        relatedDeviceIds.add(deviceId);

        const { timestampMs, timestampIso } = this.resolveEventTimestamp(candidate);

        deviceEvents.push({
          deviceId,
          capability,
          attribute,
          componentId,
          value: candidate.value,
          unit: candidate.unit || candidate.unitOfMeasure || null,
          data: candidate.data || candidate.additionalData,
          locationId: trim(candidate.locationId || ''),
          timestampMs,
          timestampIso,
          raw: candidate
        });
        continue;
      }

      const fallbackDeviceId = this.extractDeviceIdFromEvent(entry);
      if (fallbackDeviceId) {
        relatedDeviceIds.add(fallbackDeviceId);
      }

      if (eventType) {
        const previousCount = ignoredEventTypes.get(eventType) || 0;
        ignoredEventTypes.set(eventType, previousCount + 1);
      } else {
        malformedCount += 1;
      }
    }

    return {
      deviceEvents,
      relatedDeviceIds: Array.from(relatedDeviceIds),
      ignoredEventTypeCounts: Array.from(ignoredEventTypes.entries()),
      malformedCount
    };
  }

  extractSecurityArmStateEvents(events) {
    if (!Array.isArray(events)) {
      return {
        securityArmStateEvents: [],
        malformedCount: 0
      };
    }

    const securityArmStateEvents = [];
    let malformedCount = 0;

    for (const entry of events) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const eventType = typeof entry.eventType === 'string' ? entry.eventType.toUpperCase() : '';
      if (eventType !== 'SECURITY_ARM_STATE_EVENT') {
        continue;
      }

      const candidate = entry.securityArmStateEvent && typeof entry.securityArmStateEvent === 'object'
        ? entry.securityArmStateEvent
        : null;

      if (!candidate) {
        malformedCount += 1;
        continue;
      }

      const armState = trim(candidate.armState || '');
      if (!armState) {
        malformedCount += 1;
        continue;
      }

      const locationId = trim(candidate.locationId || '');
      const { timestampMs, timestampIso } = this.resolveEventTimestamp(candidate);

      securityArmStateEvents.push({
        armState,
        locationId,
        timestampMs,
        timestampIso,
        raw: candidate
      });
    }

    return {
      securityArmStateEvents,
      malformedCount
    };
  }

  normalizeSecurityArmState(armState) {
    try {
      return smartThingsService.normalizeArmState(armState);
    } catch (error) {
      return null;
    }
  }

  mapNormalizedArmStateToLocalAlarm(normalizedArmState) {
    if (normalizedArmState === 'Disarmed') {
      return 'disarmed';
    }
    if (normalizedArmState === 'ArmedStay') {
      return 'armedStay';
    }
    if (normalizedArmState === 'ArmedAway') {
      return 'armedAway';
    }
    return null;
  }

  resolveEventTimestamp(eventBody) {
    const stringTimestampSources = [
      eventBody?.eventTime,
      eventBody?.utcTime,
      eventBody?.localTime,
      eventBody?.stateChangeTime,
      eventBody?.sourceTime
    ].filter((value) => typeof value === 'string' && value.trim().length > 0);

    for (const value of stringTimestampSources) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return {
          timestampMs: parsed,
          timestampIso: new Date(parsed).toISOString()
        };
      }
    }

    const numericTimestampSources = [
      eventBody?.epochMillis,
      eventBody?.epochTimeMs,
      eventBody?.epochTime,
      eventBody?.time,
      eventBody?.timestamp
    ];

    for (const candidate of numericTimestampSources) {
      if (candidate === undefined || candidate === null) {
        continue;
      }

      const numericValue = typeof candidate === 'number' ? candidate : Number(candidate);
      if (!Number.isFinite(numericValue)) {
        continue;
      }

      const timestampMs = numericValue >= 1e12 ? numericValue : numericValue * 1000;
      return {
        timestampMs,
        timestampIso: new Date(timestampMs).toISOString()
      };
    }

    const fallbackMs = Date.now();
    return {
      timestampMs: fallbackMs,
      timestampIso: new Date(fallbackMs).toISOString()
    };
  }

  extractDeviceIdFromEvent(entry) {
    if (!entry || typeof entry !== 'object') {
      return '';
    }

    const candidates = [
      entry?.deviceEvent?.deviceId,
      entry?.deviceLifecycleEvent?.deviceId,
      entry?.deviceHealthEvent?.deviceId,
      entry?.deviceStateEvent?.deviceId,
      entry?.deviceCommandsEvent?.deviceId,
      entry?.deviceCommandEvent?.deviceId,
      entry?.device?.deviceId,
      entry?.deviceId
    ];

    for (const candidate of candidates) {
      const trimmed = trim(candidate || '');
      if (trimmed) {
        return trimmed;
      }
    }

    return '';
  }

  buildPseudoDeviceFromStatus(tracked, status, integration) {
    if (!tracked || !status || typeof status !== 'object') {
      return null;
    }

    const capabilityIds = Array.isArray(tracked?.properties?.smartThingsCapabilities)
      ? tracked.properties.smartThingsCapabilities
      : [];

    const componentIds = Array.isArray(tracked?.properties?.componentIds) && tracked.properties.componentIds.length > 0
      ? tracked.properties.componentIds
      : ['main'];

    const components = componentIds.map((componentId) => ({
      id: componentId,
      capabilities: capabilityIds.map((capabilityId) => ({ id: capabilityId }))
    }));

    const healthState = status?.healthState || tracked?.properties?.smartThingsHealthState || (typeof tracked.isOnline === 'boolean'
      ? {
          state: tracked.isOnline ? 'ONLINE' : 'OFFLINE',
          lastUpdatedDate: new Date(tracked.lastSeen || Date.now()).toISOString()
        }
      : null);

    const statusComponents = status?.components && typeof status.components === 'object'
      ? status.components
      : {};

    return {
      deviceId: tracked?.properties?.smartThingsDeviceId || tracked?.deviceId || String(tracked?._id || ''),
      components,
      status: {
        components: statusComponents
      },
      healthState,
      locationId: tracked?.properties?.smartThingsLocationId || integration?.webhook?.locationId || ''
    };
  }



  async verifyRequestSignature(rawBody, headers = {}) {
    this.recordRequestReceipt();

    const signatureHeader = headers['x-st-signature'] || headers['X-St-Signature'];
    if (!signatureHeader) {
      this.recordSignatureFailure('missing header');
      throw new Error('Missing x-st-signature header');
    }

    let integration;
    try {
      integration = await SmartThingsIntegration.getIntegration();
    } catch (error) {
      this.recordSignatureFailure('integration lookup failed');
      this.log('error', 'Unable to load SmartThings integration while validating signature', { error: error.message });
      throw error;
    }

    const clientSecret = integration?.clientSecret;

    if (!clientSecret || typeof clientSecret !== 'string') {
      this.recordSignatureFailure('client secret not configured');
      throw new Error('SmartThings client secret is not configured');
    }

    const payloadBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '', 'utf8');
    const expectedDigest = crypto.createHmac('sha256', clientSecret).update(payloadBuffer).digest();

    const candidateValues = this.extractCandidateSignatures(signatureHeader);

    for (const candidate of candidateValues) {
      if (this.isMatchingSignature(candidate, expectedDigest)) {
        this.recordSignatureSuccess();
        return true;
      }
    }

    this.recordSignatureFailure('signature mismatch');
    throw new Error('Signature mismatch');
  }

  extractCandidateSignatures(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') {
      return [];
    }

    return headerValue
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const eqIndex = part.indexOf('=');
        if (eqIndex > -1) {
          const possibleKey = part.slice(0, eqIndex).trim();
          const possibleValue = part.slice(eqIndex + 1).trim();
          if (/^[a-z0-9_-]+$/i.test(possibleKey) && possibleValue.length > 0) {
            return this.stripWrappingQuotes(possibleValue);
          }
        }
        return this.stripWrappingQuotes(part);
      });
  }

  stripWrappingQuotes(value) {
    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }
    return value;
  }

  isMatchingSignature(candidate, expectedDigest) {
    if (!candidate || typeof candidate !== 'string' || !expectedDigest) {
      return false;
    }

    const normalizedCandidate = candidate.trim();
    const expectedLength = expectedDigest.length;

    const buffersToTry = [];

    try {
      const base64Buffer = Buffer.from(normalizedCandidate, 'base64');
      if (base64Buffer.length === expectedLength) {
        buffersToTry.push(base64Buffer);
      }
    } catch {
      // ignore invalid base64
    }

    try {
      const hexBuffer = Buffer.from(normalizedCandidate, 'hex');
      if (hexBuffer.length === expectedLength) {
        buffersToTry.push(hexBuffer);
      }
    } catch {
      // ignore invalid hex
    }

    if (buffersToTry.length === 0) {
      return false;
    }

    return buffersToTry.some(buffer => {
      if (buffer.length !== expectedDigest.length) {
        return false;
      }
      return crypto.timingSafeEqual(buffer, expectedDigest);
    });
  }

  async handleLifecycle(payload = {}, headers = {}) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('SmartThings webhook payload is missing or invalid');
    }

    const lifecycle = payload.lifecycle;
    if (!lifecycle || typeof lifecycle !== 'string') {
      throw new Error('SmartThings webhook payload missing lifecycle field');
    }

    const normalizedLifecycle = lifecycle.toUpperCase();
    this.recordLifecycle(normalizedLifecycle);
    this.evaluateEventStall(normalizedLifecycle);

    switch (normalizedLifecycle) {
      case 'PING':
        return this.handlePing(payload);
      case 'CONFIGURATION':
        return this.handleConfiguration(payload);
      case 'INSTALL':
        return this.handleInstall(payload, headers);
      case 'UPDATE':
        return this.handleUpdate(payload, headers);
      case 'UNINSTALL':
        return this.handleUninstall(payload, headers);
      case 'EVENT':
        return this.handleEvent(payload, headers);
      default:
        this.log('warn', 'Unsupported SmartThings lifecycle', { lifecycle: normalizedLifecycle });
        return {
          statusCode: 400,
          body: { error: `Unsupported lifecycle "${lifecycle}"` }
        };
    }
  }

  async handlePing(payload) {
    const challenge = payload?.pingData?.challenge;
    if (!challenge) {
      throw new Error('PING payload missing challenge');
    }

    return {
      statusCode: 200,
      body: {
        pingData: {
          challenge
        }
      }
    };
  }

  async handleConfiguration(payload) {
    const phase = payload?.configurationData?.phase;
    const integration = await SmartThingsIntegration.getIntegration();
    const permissions = Array.isArray(integration?.scope) && integration.scope.length > 0
      ? integration.scope
      : DEFAULT_PERMISSIONS;

    if (phase === 'INITIALIZE') {
      return {
        statusCode: 200,
        body: {
          configurationData: {
            initialize: {
              id: 'homebrain-smartthings-webhook',
              name: 'HomeBrain SmartThings Webhook',
              description: 'Subscribe SmartThings events for HomeBrain',
              firstPageId: this.configurationPageId,
              permissions,
              disableCustomDisplayName: true,
              disableRemoveApp: false
            }
          }
        }
      };
    }

    if (phase === 'PAGE') {
      const pageId = payload?.configurationData?.pageId || this.configurationPageId;
      return {
        statusCode: 200,
        body: {
          configurationData: {
            page: {
              pageId,
              name: 'HomeBrain Configuration',
              nextPageId: null,
              previousPageId: null,
              sections: []
            }
          }
        }
      };
    }

    console.warn(`SmartThings Webhook: unsupported configuration phase "${phase}"`);
    return {
      statusCode: 400,
      body: { error: `Unsupported configuration phase "${phase}"` }
    };
  }

  async handleInstall(payload) {
    console.log('SmartThings Webhook: received INSTALL lifecycle');
    const { installedAppId, locationId } = this.extractInstalledAppContext(payload, 'installData');

    if (!installedAppId || !locationId) {
      throw new Error('INSTALL lifecycle missing installedAppId or locationId');
    }

    const capabilityDescriptors = smartThingsService.getDefaultCapabilitySubscriptions();
    await smartThingsService.replaceCapabilitySubscriptions(installedAppId, locationId, capabilityDescriptors);

    const subscriptions = await smartThingsService.listSubscriptions(installedAppId);
    const normalizedSubscriptions = this.normalizeSubscriptions(subscriptions);

    const integration = await SmartThingsIntegration.getIntegration();
    if (typeof integration.updateWebhookState === 'function') {
      await integration.updateWebhookState({
        installedAppId,
        locationId,
        subscriptions: normalizedSubscriptions,
        lastSubscriptionSync: new Date(),
        lastLifecycleHandledAt: new Date()
      });
    }

    return {
      statusCode: 200,
      body: {
        installData: {
          status: 'SUBSCRIBED',
          installedAppId,
          locationId,
          subscriptionCount: normalizedSubscriptions.length,
          subscriptions: normalizedSubscriptions
        }
      }
    };
  }

  async handleUpdate(payload) {
    console.log('SmartThings Webhook: received UPDATE lifecycle');

    const integration = await SmartThingsIntegration.getIntegration();
    const storedInstalledAppId = trim(integration?.webhook?.installedAppId || '');
    const storedLocationId = trim(integration?.webhook?.locationId || '');

    const context = this.extractInstalledAppContext(payload, 'updateData');
    const installedAppId = context.installedAppId || storedInstalledAppId;
    const locationId = context.locationId || storedLocationId;

    if (!installedAppId) {
      throw new Error('UPDATE lifecycle missing installedAppId');
    }

    if (locationId) {
      const capabilityDescriptors = smartThingsService.getDefaultCapabilitySubscriptions();
      await smartThingsService.replaceCapabilitySubscriptions(installedAppId, locationId, capabilityDescriptors);
    } else {
      console.warn('SmartThings Webhook: UPDATE lifecycle missing locationId; skipping subscription replacement');
    }

    const subscriptions = await smartThingsService.listSubscriptions(installedAppId);
    const normalizedSubscriptions = this.normalizeSubscriptions(subscriptions);

    if (typeof integration.updateWebhookState === 'function') {
      await integration.updateWebhookState({
        installedAppId,
        locationId,
        subscriptions: normalizedSubscriptions,
        lastSubscriptionSync: new Date(),
        lastLifecycleHandledAt: new Date()
      });
    }

    return {
      statusCode: 200,
      body: {
        updateData: {
          status: 'SUBSCRIPTIONS_REFRESHED',
          installedAppId,
          locationId,
          subscriptionCount: normalizedSubscriptions.length,
          subscriptions: normalizedSubscriptions
        }
      }
    };
  }

  async handleUninstall(payload) {
    console.log('SmartThings Webhook: received UNINSTALL lifecycle');

    const integration = await SmartThingsIntegration.getIntegration();
    const storedInstalledAppId = trim(integration?.webhook?.installedAppId || '');

    const context = this.extractInstalledAppContext(payload, 'uninstallData');
    const installedAppId = context.installedAppId || storedInstalledAppId;

    if (installedAppId) {
      try {
        await smartThingsService.deleteAllSubscriptions(installedAppId);
      } catch (error) {
        if (error.status === 404) {
          console.debug(`SmartThings Webhook: Subscriptions already removed for installedApp ${installedAppId}`);
        } else {
          console.warn(`SmartThings Webhook: Failed to delete subscriptions for installedApp ${installedAppId}: ${error.message}`);
        }
      }
    }

    if (typeof integration.clearWebhookState === 'function') {
      await integration.clearWebhookState();
    }

    return {
      statusCode: 200,
      body: {
        uninstallData: {
          status: 'REMOVED',
          installedAppId
        }
      }
    };
  }

  async handleEvent(payload) {
    const rawEvents = Array.isArray(payload?.eventData?.events) ? payload.eventData.events : [];
    this.log('debug', 'SmartThings EVENT lifecycle received', { eventCount: rawEvents.length });

    const integration = await SmartThingsIntegration.getIntegration();
    const extractedDeviceEvents = this.extractDeviceEvents(rawEvents);
    const extractedSecurityEvents = this.extractSecurityArmStateEvents(rawEvents);
    const deviceEvents = extractedDeviceEvents.deviceEvents;
    const ignoredEventTypeCounts = extractedDeviceEvents.ignoredEventTypeCounts || [];
    const relatedDeviceIds = extractedDeviceEvents.relatedDeviceIds || [];
    const malformedCount = (extractedDeviceEvents.malformedCount || 0) + (extractedSecurityEvents.malformedCount || 0);
    const securityArmStateEvents = extractedSecurityEvents.securityArmStateEvents || [];

    this.metrics.events.received += deviceEvents.length + securityArmStateEvents.length;

    if (ignoredEventTypeCounts.length > 0) {
      this.log('debug', 'SmartThings EVENT lifecycle skipped unsupported event types', {
        eventTypes: ignoredEventTypeCounts.map(([type, count]) => ({ type, count }))
      });
    }

    if (malformedCount > 0) {
      this.log('warn', 'SmartThings EVENT lifecycle encountered malformed events', {
        malformedCount
      });
    }

    const relatedDeviceIdSet = new Set(Array.isArray(relatedDeviceIds) ? relatedDeviceIds : []);
    deviceEvents.forEach((event) => relatedDeviceIdSet.add(event.deviceId));

    if (deviceEvents.length === 0 && relatedDeviceIdSet.size === 0 && securityArmStateEvents.length === 0) {
      const now = new Date();
      if (typeof integration.updateWebhookState === 'function') {
        await integration.updateWebhookState({
          lastLifecycleHandledAt: now,
          lastEventReceivedAt: now
        });
      }
      this.metrics.events.lastAt = now;
      this.eventStallAlerted = false;
      return {
        statusCode: 200,
        body: {
          eventData: {
            status: rawEvents.length === 0 ? 'NO_EVENTS' : 'NO_DEVICE_EVENTS',
            skippedEventTypes: ignoredEventTypeCounts.map(([type]) => type),
            malformedCount: malformedCount > 0 ? malformedCount : undefined
          }
        }
      };
    }

    let securityStateUpdateCount = 0;
    let securityStateUpdateFailures = 0;
    let latestSecurityArmState = null;

    for (const event of securityArmStateEvents) {
      this.incrementCapabilityMetric('securityArmState');

      const normalizedArmState = this.normalizeSecurityArmState(event.armState);
      if (!normalizedArmState) {
        securityStateUpdateFailures += 1;
        this.log('warn', 'SmartThings SECURITY_ARM_STATE_EVENT had unsupported arm state', {
          armState: event.armState
        });
        continue;
      }

      const eventLocationId = trim(
        event.locationId ||
        integration?.webhook?.locationId ||
        integration?.sthm?.locationId ||
        ''
      );

      try {
        if (typeof integration.updateSecurityArmState === 'function') {
          await integration.updateSecurityArmState({
            armState: normalizedArmState,
            locationId: eventLocationId || undefined
          });
        } else if (integration?.sthm) {
          integration.sthm.lastArmState = normalizedArmState;
          integration.sthm.lastArmStateUpdatedAt = new Date(event.timestampMs || Date.now());
          if (eventLocationId) {
            integration.sthm.locationId = eventLocationId;
          }
          if (typeof integration.save === 'function') {
            await integration.save();
          }
        }

        securityStateUpdateCount += 1;

        if (!latestSecurityArmState || event.timestampMs > latestSecurityArmState.timestampMs) {
          latestSecurityArmState = {
            normalizedArmState,
            timestampMs: event.timestampMs,
            locationId: eventLocationId
          };
        }
      } catch (error) {
        securityStateUpdateFailures += 1;
        this.log('warn', 'Failed to persist SmartThings security arm state from webhook event', {
          armState: normalizedArmState,
          locationId: eventLocationId,
          error: error.message
        });
      }
    }

    if (latestSecurityArmState) {
      try {
        const alarm = await SecurityAlarm.getMainAlarm();
        const mappedState = this.mapNormalizedArmStateToLocalAlarm(latestSecurityArmState.normalizedArmState);
        if (mappedState) {
          alarm.alarmState = mappedState;
        }
        alarm.isOnline = true;
        alarm.lastSyncWithSmartThings = new Date(latestSecurityArmState.timestampMs || Date.now());
        await alarm.save();
      } catch (error) {
        this.log('warn', 'Failed to mirror SmartThings security arm state into local alarm model', {
          armState: latestSecurityArmState.normalizedArmState,
          error: error.message
        });
      }
    }

    const deviceIds = Array.from(relatedDeviceIdSet);

    const trackedDevices = deviceIds.length > 0
      ? await Device.find({ 'properties.smartThingsDeviceId': { $in: deviceIds } }).lean()
      : [];

    const trackedMap = new Map();
    trackedDevices.forEach((doc) => {
      const smartThingsId = trim(doc?.properties?.smartThingsDeviceId || '');
      if (smartThingsId) {
        trackedMap.set(smartThingsId, doc);
      }
    });

    const aggregatedByDevice = new Map();
    const ignoredDevices = new Set();
    let latestEventTime = 0;

    for (const event of deviceEvents) {
      const {
        deviceId,
        capability,
        attribute,
        componentId,
        value,
        unit,
        data,
        locationId,
        timestampMs,
        timestampIso
      } = event;

      if (timestampMs > latestEventTime) {
        latestEventTime = timestampMs;
      }

      this.incrementCapabilityMetric(capability);

      const tracked = trackedMap.get(deviceId);
      if (!tracked) {
        ignoredDevices.add(deviceId);
        continue;
      }

      let aggregation = aggregatedByDevice.get(deviceId);
      if (!aggregation) {
        aggregation = {
          components: {},
          capabilityIds: new Set(
            Array.isArray(tracked?.properties?.smartThingsCapabilities)
              ? tracked.properties.smartThingsCapabilities
              : []
          ),
          locationId: trim(
            locationId ||
            tracked?.properties?.smartThingsLocationId ||
            integration?.webhook?.locationId ||
            ''
          ),
          lastEventTime: 0
        };
        aggregatedByDevice.set(deviceId, aggregation);
      }

      const componentBucket = aggregation.components[componentId] || (aggregation.components[componentId] = {});
      const capabilityBucket = componentBucket[capability] || (componentBucket[capability] = {});
      capabilityBucket.value = value;
      capabilityBucket[attribute] = {
        value,
        unit: unit ?? null,
        data: data || undefined,
        timestamp: timestampIso
      };

      aggregation.capabilityIds.add(capability);
      if (!aggregation.lastEventTime || timestampMs > aggregation.lastEventTime) {
        aggregation.lastEventTime = timestampMs;
      }
    }

    const lastEventDate = latestEventTime ? new Date(latestEventTime) : new Date();
    this.metrics.events.lastAt = lastEventDate;
    this.eventStallAlerted = false;

    const bulkOps = [];
    const updatedDeviceIds = new Set();

    for (const [deviceId, aggregation] of aggregatedByDevice.entries()) {
      const tracked = trackedMap.get(deviceId);
      if (!tracked) {
        ignoredDevices.add(deviceId);
        continue;
      }

      const components = Object.entries(aggregation.components).map(([componentId, capabilityMap]) => ({
        id: componentId,
        capabilities: Object.keys(capabilityMap).map(capabilityId => ({ id: capabilityId }))
      }));

      if (components.length === 0) {
        continue;
      }

      const primaryComponent = components.find(component => component.id === 'main') || components[0];
      const primaryCapabilitySet = new Set(primaryComponent.capabilities.map(cap => cap.id));
      aggregation.capabilityIds.forEach((capabilityId) => {
        if (!primaryCapabilitySet.has(capabilityId)) {
          primaryComponent.capabilities.push({ id: capabilityId });
          primaryCapabilitySet.add(capabilityId);
        }
      });

      const pseudoDevice = {
        deviceId,
        components,
        status: {
          components: aggregation.components
        },
        healthState: {
          state: 'ONLINE',
          lastUpdatedDate: new Date(aggregation.lastEventTime || latestEventTime || Date.now()).toISOString()
        }
      };

      if (aggregation.locationId) {
        pseudoDevice.locationId = aggregation.locationId;
      }

      let updates;
      try {
        updates = await smartThingsService.buildSmartThingsDeviceUpdate(tracked, pseudoDevice);
      } catch (error) {
        this.log('warn', 'Failed to build SmartThings device update from webhook event', {
          deviceId,
          error: error.message
        });
        continue;
      }

      if (updates && Object.keys(updates).length > 0) {
        bulkOps.push({
          updateOne: {
            filter: { _id: tracked._id },
            update: { $set: updates }
          }
        });
        updatedDeviceIds.add(String(tracked._id));
      }
    }

    const fallbackDeviceIds = Array.from(relatedDeviceIdSet).filter((deviceId) => !aggregatedByDevice.has(deviceId));

    if (fallbackDeviceIds.length > 0) {
      for (const deviceId of fallbackDeviceIds) {
        const tracked = trackedMap.get(deviceId);
        if (!tracked) {
          ignoredDevices.add(deviceId);
          continue;
        }

        try {
          const statusSnapshot = await smartThingsService.getDeviceStatus(deviceId);
          if (!statusSnapshot || typeof statusSnapshot !== 'object') {
            continue;
          }

          const pseudoDevice = this.buildPseudoDeviceFromStatus(tracked, statusSnapshot, integration);
          if (!pseudoDevice) {
            continue;
          }

          const updates = await smartThingsService.buildSmartThingsDeviceUpdate(tracked, pseudoDevice);
          if (updates && Object.keys(updates).length > 0) {
            bulkOps.push({
              updateOne: {
                filter: { _id: tracked._id },
                update: { $set: updates }
              }
            });
            updatedDeviceIds.add(String(tracked._id));
          }
        } catch (error) {
          this.log('warn', 'SmartThings fallback device status refresh failed', {
            deviceId,
            error: error.message
          });
        }
      }
    }

    if (bulkOps.length > 0) {
      try {
        await Device.bulkWrite(bulkOps, { ordered: false });
      } catch (error) {
        this.log('error', 'Bulk device update failed during SmartThings webhook processing', { error: error.message });
      }
    }

    const updatedDeviceIdArray = Array.from(updatedDeviceIds);

    if (updatedDeviceIdArray.length > 0) {
      try {
        const refreshedDevices = await Device.find({ _id: { $in: updatedDeviceIdArray } }).lean();
        const payloadUpdates = deviceUpdateEmitter.normalizeDevices(refreshedDevices);
        if (payloadUpdates.length > 0) {
          this.log('info', 'Emitting SmartThings device updates', {
            deviceCount: payloadUpdates.length,
            deviceIds: payloadUpdates.map(device => device?._id || device?.id).filter(Boolean)
          });
          deviceUpdateEmitter.emit('devices:update', payloadUpdates);
        }
      } catch (error) {
        this.log('warn', 'Failed to emit device updates after SmartThings webhook processing', { error: error.message });
      }
    }

    this.metrics.events.processedDevices += updatedDeviceIdArray.length;
    this.metrics.events.ignoredDevices += ignoredDevices.size;
    if (ignoredDevices.size > 0) {
      this.log('warn', 'SmartThings EVENT lifecycle ignored tracked devices', {
        ignoredDeviceIds: Array.from(ignoredDevices)
      });
    }

    if (typeof integration.updateWebhookState === 'function') {
      await integration.updateWebhookState({
        lastLifecycleHandledAt: new Date(),
        lastEventReceivedAt: lastEventDate
      });
    }

    const status = updatedDeviceIdArray.length > 0
      || securityStateUpdateCount > 0
      ? 'PROCESSED'
      : (aggregatedByDevice.size === 0 && fallbackDeviceIds.length === 0 && securityArmStateEvents.length === 0 ? 'NO_MATCH' : 'ACKNOWLEDGED');

    this.log('info', 'SmartThings EVENT lifecycle processed', {
      eventsReceived: deviceEvents.length,
      securityEventsReceived: securityArmStateEvents.length,
      securityEventsApplied: securityStateUpdateCount,
      securityEventsFailed: securityStateUpdateFailures,
      devicesUpdated: updatedDeviceIdArray.length,
      ignoredDevices: ignoredDevices.size,
      status
    });

    return {
      statusCode: 200,
      body: {
        eventData: {
          status,
          processedDeviceCount: updatedDeviceIdArray.length,
          processedSecurityStateCount: securityStateUpdateCount,
          ignoredDeviceIds: ignoredDevices.size > 0 ? Array.from(ignoredDevices) : undefined
        }
      }
    };
  }
}

module.exports = new SmartThingsWebhookService();


