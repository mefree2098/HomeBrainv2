const { EventEmitter } = require('events');
const net = require('net');
const os = require('os');
const mongoose = require('mongoose');
const { URL } = require('url');

const PlatformManagedService = require('../models/PlatformManagedService');

const DEFAULT_TOPIC_PREFIX = 'homebrain';
const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1883';
const DEFAULT_CONNECT_BACKOFF_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

function normalizeBooleanMode(value, { nodeEnv = process.env.NODE_ENV } = {}) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return 'enabled';
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return 'disabled';
  }
  if (normalized === 'auto') {
    return 'auto';
  }

  return nodeEnv === 'test' ? 'disabled' : 'auto';
}

function normalizeTopicPrefix(value) {
  const segments = String(value || DEFAULT_TOPIC_PREFIX)
    .split('/')
    .map((segment) => sanitizeTopicSegment(segment, ''))
    .filter(Boolean);

  return segments.length > 0 ? segments.join('/') : DEFAULT_TOPIC_PREFIX;
}

function sanitizeTopicSegment(value, fallback = 'unknown') {
  const sanitized = String(value ?? '')
    .trim()
    .replace(/[#+/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || fallback;
}

function redactBrokerUrl(value) {
  try {
    const parsed = new URL(value || DEFAULT_BROKER_URL);
    if (parsed.username) {
      parsed.username = '***';
    }
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch (_error) {
    return DEFAULT_BROKER_URL;
  }
}

function parseBrokerEndpoint(value) {
  const parsed = new URL(value || DEFAULT_BROKER_URL);
  const protocol = parsed.protocol.replace(':', '');
  const defaultPort = protocol === 'mqtts' ? 8883 : 1883;

  return {
    protocol,
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port || defaultPort),
    canProbe: ['mqtt', 'mqtts'].includes(protocol)
  };
}

function buildBrokerUrl(env) {
  const explicitUrl = String(env.HOMEBRAIN_MQTT_URL || '').trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const host = String(env.HOMEBRAIN_MQTT_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(env.HOMEBRAIN_MQTT_PORT || 1883);
  const protocol = String(env.HOMEBRAIN_MQTT_PROTOCOL || 'mqtt').trim() || 'mqtt';
  return `${protocol}://${host}:${Number.isInteger(port) ? port : 1883}`;
}

class MqttPlatformService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.env = options.env || process.env;
    this.configOverride = options.configOverride || null;
    this.logger = options.logger || console;
    this.mqttFactory = options.mqttFactory || (() => require('mqtt'));
    this.netConnect = options.netConnect || net.createConnection;
    this.now = options.now || (() => Date.now());
    this.connectBackoffMs = Math.max(
      1_000,
      Number(options.connectBackoffMs || this.env.HOMEBRAIN_MQTT_CONNECT_BACKOFF_MS || DEFAULT_CONNECT_BACKOFF_MS)
    );
    this.probeTimeoutMs = Math.max(
      250,
      Number(options.probeTimeoutMs || this.env.HOMEBRAIN_MQTT_PROBE_TIMEOUT_MS || DEFAULT_PROBE_TIMEOUT_MS)
    );
    this.client = null;
    this.lastConnectAttemptAt = 0;
    this.lastWarningAt = 0;
    this.eventStreamService = null;
    this.deviceUpdateEmitter = null;
    this.eventListener = null;
    this.deviceUpdateListener = null;
    this.topicMonitorListener = null;
    this.subscribedMonitorTopic = '';
    this.recentMessages = [];
    this.status = {
      connected: false,
      reachable: false,
      lastError: null,
      lastConnectedAt: null,
      lastPublishedAt: null
    };
  }

  getMode() {
    return normalizeBooleanMode(this.configOverride?.mode ?? this.env.HOMEBRAIN_MQTT_ENABLED, { nodeEnv: this.env.NODE_ENV });
  }

  getBrokerUrl() {
    if (this.configOverride?.brokerUrl) {
      return this.configOverride.brokerUrl;
    }

    if (this.configOverride?.host || this.configOverride?.port || this.configOverride?.protocol) {
      return buildBrokerUrl({
        HOMEBRAIN_MQTT_PROTOCOL: this.configOverride.protocol || this.env.HOMEBRAIN_MQTT_PROTOCOL,
        HOMEBRAIN_MQTT_HOST: this.configOverride.host || this.env.HOMEBRAIN_MQTT_HOST,
        HOMEBRAIN_MQTT_PORT: this.configOverride.port || this.env.HOMEBRAIN_MQTT_PORT
      });
    }

    return buildBrokerUrl(this.env);
  }

  getTopicPrefix() {
    return normalizeTopicPrefix(this.configOverride?.topicPrefix || this.env.HOMEBRAIN_MQTT_TOPIC_PREFIX || DEFAULT_TOPIC_PREFIX);
  }

  getClientId() {
    const configured = String(this.configOverride?.clientId || this.env.HOMEBRAIN_MQTT_CLIENT_ID || '').trim();
    if (configured) {
      return configured;
    }

    const hostname = sanitizeTopicSegment(os.hostname(), 'host');
    return `homebrain-server-${hostname}-${process.pid}`;
  }

  buildConnectionOptions() {
    const topicPrefix = this.getTopicPrefix();
    const options = {
      clientId: this.getClientId(),
      clean: true,
      keepalive: Math.max(15, Number(this.configOverride?.keepaliveSeconds || this.env.HOMEBRAIN_MQTT_KEEPALIVE_SECONDS || 60)),
      connectTimeout: Math.max(1_000, Number(this.configOverride?.connectTimeoutMs || this.env.HOMEBRAIN_MQTT_CONNECT_TIMEOUT_MS || 3_000)),
      reconnectPeriod: Math.max(0, Number(this.configOverride?.reconnectMs || this.env.HOMEBRAIN_MQTT_RECONNECT_MS || 15_000)),
      will: {
        topic: `${topicPrefix}/status`,
        payload: JSON.stringify({
          schema: 'homebrain.availability.v1',
          status: 'offline',
          updatedAt: new Date().toISOString()
        }),
        qos: 1,
        retain: true
      }
    };

    if (this.configOverride?.username || this.env.HOMEBRAIN_MQTT_USERNAME) {
      options.username = this.configOverride?.username || this.env.HOMEBRAIN_MQTT_USERNAME;
    }
    if (this.configOverride?.password || this.env.HOMEBRAIN_MQTT_PASSWORD) {
      options.password = this.configOverride?.password || this.env.HOMEBRAIN_MQTT_PASSWORD;
    }

    return options;
  }

  async loadPersistedConfig() {
    if (this.env.NODE_ENV === 'test' && !this.configOverride) {
      return this.configOverride;
    }
    if (mongoose.connection.readyState !== 1) {
      return this.configOverride;
    }

    const record = await PlatformManagedService.findOne({ serviceId: 'mqtt' }).lean();
    const nextConfig = record?.config?.mqtt && typeof record.config.mqtt === 'object'
      ? record.config.mqtt
      : null;
    this.configOverride = nextConfig;
    return this.configOverride;
  }

  async disconnectClient() {
    const client = this.client;
    this.client = null;
    this.status.connected = false;
    this.subscribedMonitorTopic = '';
    this.topicMonitorListener = null;

    if (!client?.end) {
      return;
    }

    await new Promise((resolve) => {
      try {
        client.end(true, {}, resolve);
      } catch (_error) {
        resolve();
      }
    });
  }

  async reloadConfig({ reconnect = false } = {}) {
    await this.loadPersistedConfig();
    await this.disconnectClient();
    this.lastConnectAttemptAt = 0;
    if (reconnect && this.getMode() !== 'disabled') {
      await this.ensureClient();
    }
    return this.getStatus({ probe: true });
  }

  async probeBroker() {
    let endpoint;
    try {
      endpoint = parseBrokerEndpoint(this.getBrokerUrl());
    } catch (error) {
      this.status.reachable = false;
      this.status.lastError = error.message;
      return false;
    }

    if (!endpoint.canProbe) {
      return true;
    }

    return new Promise((resolve) => {
      let settled = false;
      const socket = this.netConnect({ host: endpoint.host, port: endpoint.port });

      const finish = (reachable, error = null) => {
        if (settled) {
          return;
        }
        settled = true;
        this.status.reachable = reachable;
        if (error) {
          this.status.lastError = error.message || String(error);
        } else if (reachable) {
          this.status.lastError = null;
        }
        try {
          socket.destroy();
        } catch (_error) {
          // No-op.
        }
        resolve(reachable);
      };

      socket.setTimeout(this.probeTimeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false, new Error('MQTT broker probe timed out')));
      socket.once('error', (error) => finish(false, error));
    });
  }

  shouldAttemptConnection() {
    const mode = this.getMode();
    if (mode === 'disabled') {
      return false;
    }

    const elapsed = this.now() - this.lastConnectAttemptAt;
    return this.lastConnectAttemptAt === 0 || elapsed >= this.connectBackoffMs;
  }

  warnOnce(message) {
    const now = this.now();
    if (now - this.lastWarningAt < 60_000) {
      return;
    }
    this.lastWarningAt = now;
    this.logger.warn(message);
  }

  async ensureClient() {
    if (this.getMode() === 'disabled') {
      return null;
    }

    if (this.client?.connected) {
      return this.client;
    }

    if (!this.shouldAttemptConnection()) {
      return this.client;
    }

    this.lastConnectAttemptAt = this.now();

    if (this.getMode() === 'auto') {
      const reachable = await this.probeBroker();
      if (!reachable) {
        return null;
      }
    }

    try {
      const mqtt = this.mqttFactory();
      this.client = mqtt.connect(this.getBrokerUrl(), this.buildConnectionOptions());
      this.client.on('connect', () => {
        this.status.connected = true;
        this.status.reachable = true;
        this.status.lastConnectedAt = new Date().toISOString();
        this.status.lastError = null;
        this.subscribeToTopicMonitor();
        void this.publishAvailability('online');
        this.emit('connect');
      });
      this.client.on('close', () => {
        this.status.connected = false;
      });
      this.client.on('offline', () => {
        this.status.connected = false;
      });
      this.client.on('error', (error) => {
        this.status.connected = false;
        this.status.lastError = error.message;
        this.warnOnce(`MQTT platform bridge error: ${error.message}`);
      });
      return this.client;
    } catch (error) {
      this.status.connected = false;
      this.status.lastError = error.message;
      this.warnOnce(`MQTT platform bridge unavailable: ${error.message}`);
      return null;
    }
  }

  async publishJson(topic, payload, options = {}) {
    await this.loadPersistedConfig().catch(() => null);
    const client = await this.ensureClient();
    if (!client?.connected) {
      return {
        success: false,
        skipped: true,
        reason: this.getMode() === 'disabled' ? 'disabled' : 'not_connected'
      };
    }

    const message = JSON.stringify(payload);
    const publishOptions = {
      qos: Number.isInteger(options.qos) ? options.qos : 0,
      retain: options.retain === true
    };

    return new Promise((resolve) => {
      client.publish(topic, message, publishOptions, (error) => {
        if (error) {
          this.status.lastError = error.message;
          resolve({ success: false, error: error.message });
          return;
        }

        this.status.lastPublishedAt = new Date().toISOString();
        resolve({ success: true, topic });
      });
    });
  }

  subscribeToTopicMonitor() {
    const client = this.client;
    if (!client?.subscribe || !client?.on) {
      return;
    }

    const monitorTopic = `${this.getTopicPrefix()}/#`;
    if (this.subscribedMonitorTopic === monitorTopic) {
      return;
    }

    this.subscribedMonitorTopic = monitorTopic;
    client.subscribe(monitorTopic, { qos: 0 }, (error) => {
      if (error) {
        this.status.lastError = error.message;
      }
    });

    if (!this.topicMonitorListener) {
      this.topicMonitorListener = (topic, message, packet = {}) => {
        const payload = Buffer.isBuffer(message) ? message.toString('utf8') : String(message || '');
        this.recentMessages.unshift({
          topic: String(topic || ''),
          payload: payload.slice(0, 2048),
          qos: packet.qos ?? null,
          retain: packet.retain === true,
          receivedAt: new Date().toISOString()
        });
        this.recentMessages = this.recentMessages.slice(0, 100);
      };
      client.on('message', this.topicMonitorListener);
    }
  }

  getRecentMessages(limit = 50) {
    return this.recentMessages.slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));
  }

  async publishAvailability(status) {
    return this.publishJson(`${this.getTopicPrefix()}/status`, {
      schema: 'homebrain.availability.v1',
      status,
      updatedAt: new Date().toISOString()
    }, {
      qos: 1,
      retain: true
    });
  }

  getEventTopic(event = {}) {
    const category = sanitizeTopicSegment(event.category || 'general');
    const type = sanitizeTopicSegment(event.type || 'event');
    return `${this.getTopicPrefix()}/events/${category}/${type}`;
  }

  async publishEvent(event = {}) {
    if (!event || typeof event !== 'object') {
      return { success: false, skipped: true, reason: 'invalid_event' };
    }

    return this.publishJson(this.getEventTopic(event), {
      schema: 'homebrain.event.v1',
      publishedAt: new Date().toISOString(),
      event
    });
  }

  async publishDeviceUpdate(devices = []) {
    const normalizedDevices = Array.isArray(devices) ? devices : [devices];
    if (normalizedDevices.length === 0) {
      return { success: false, skipped: true, reason: 'empty_update' };
    }

    const batchResult = await this.publishJson(`${this.getTopicPrefix()}/devices/update`, {
      schema: 'homebrain.devices.update.v1',
      publishedAt: new Date().toISOString(),
      devices: normalizedDevices
    });

    if (batchResult.success) {
      await Promise.all(normalizedDevices.map((device) => {
        const id = sanitizeTopicSegment(device?._id || device?.id || device?.remoteId || 'unknown');
        return this.publishJson(`${this.getTopicPrefix()}/devices/${id}/state`, {
          schema: 'homebrain.device.state.v1',
          publishedAt: new Date().toISOString(),
          device
        }, {
          qos: 1,
          retain: true
        });
      }));
    }

    return batchResult;
  }

  attach({ eventStreamService = null, deviceUpdateEmitter = null } = {}) {
    this.detach();

    this.eventStreamService = eventStreamService;
    this.deviceUpdateEmitter = deviceUpdateEmitter;

    if (this.eventStreamService?.on) {
      this.eventListener = (event) => {
        void this.publishEvent(event).catch((error) => {
          this.warnOnce(`MQTT platform bridge failed to publish event: ${error.message}`);
        });
      };
      this.eventStreamService.on('event', this.eventListener);
    }

    if (this.deviceUpdateEmitter?.on) {
      this.deviceUpdateListener = (devices) => {
        const normalized = typeof this.deviceUpdateEmitter.normalizeDevices === 'function'
          ? this.deviceUpdateEmitter.normalizeDevices(devices)
          : (Array.isArray(devices) ? devices : [devices]);
        void this.publishDeviceUpdate(normalized).catch((error) => {
          this.warnOnce(`MQTT platform bridge failed to publish device update: ${error.message}`);
        });
      };
      this.deviceUpdateEmitter.on('devices:update', this.deviceUpdateListener);
    }
  }

  detach() {
    if (this.eventStreamService?.removeListener && this.eventListener) {
      this.eventStreamService.removeListener('event', this.eventListener);
    }
    if (this.deviceUpdateEmitter?.removeListener && this.deviceUpdateListener) {
      this.deviceUpdateEmitter.removeListener('devices:update', this.deviceUpdateListener);
    }

    this.eventStreamService = null;
    this.deviceUpdateEmitter = null;
    this.eventListener = null;
    this.deviceUpdateListener = null;
  }

  async initialize(dependencies = {}) {
    await this.loadPersistedConfig().catch(() => null);
    this.attach(dependencies);
    if (this.getMode() === 'enabled') {
      await this.ensureClient();
    }
    return this.getStatus({ probe: this.getMode() !== 'disabled' });
  }

  async getStatus({ probe = false } = {}) {
    await this.loadPersistedConfig().catch(() => null);
    const mode = this.getMode();
    const enabled = mode !== 'disabled';
    let reachable = this.status.reachable || Boolean(this.client?.connected);
    if (enabled && probe && !reachable) {
      reachable = await this.probeBroker();
    }

    const connected = Boolean(this.client?.connected);
    const status = !enabled || connected || reachable || mode === 'auto' ? 'healthy' : 'degraded';
    let message = 'MQTT bridge is disabled.';

    if (enabled && connected) {
      message = 'MQTT broker is connected.';
    } else if (enabled && reachable) {
      message = 'MQTT broker is reachable; bridge will connect when publishing.';
    } else if (enabled && mode === 'auto') {
      message = 'MQTT broker is not detected; bridge is idle in auto mode.';
    } else if (enabled) {
      message = `MQTT broker is unavailable${this.status.lastError ? `: ${this.status.lastError}` : '.'}`;
    }

    return {
      status,
      message,
      enabled,
      mode,
      brokerUrl: redactBrokerUrl(this.getBrokerUrl()),
      topicPrefix: this.getTopicPrefix(),
      connected,
      reachable,
      lastConnectedAt: this.status.lastConnectedAt,
      lastPublishedAt: this.status.lastPublishedAt,
      lastError: this.status.lastError,
      recentMessageCount: this.recentMessages.length
    };
  }

  async shutdown() {
    this.detach();
    const client = this.client;
    if (client?.connected) {
      await this.publishAvailability('offline').catch(() => null);
    }
    await this.disconnectClient();
  }
}

const mqttPlatformService = new MqttPlatformService();

module.exports = mqttPlatformService;
module.exports.MqttPlatformService = MqttPlatformService;
module.exports.normalizeTopicPrefix = normalizeTopicPrefix;
module.exports.sanitizeTopicSegment = sanitizeTopicSegment;
module.exports.redactBrokerUrl = redactBrokerUrl;
module.exports.buildBrokerUrl = buildBrokerUrl;
