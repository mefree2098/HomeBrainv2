const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const { URL, domainToASCII } = require('url');

const PlatformManagedService = require('../models/PlatformManagedService');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const eventStreamService = require('./eventStreamService');
const mqttPlatformService = require('./mqttPlatformService');
const reverseProxyService = require('./reverseProxyService');

const SERVICE_DEFINITIONS = Object.freeze([
  {
    serviceId: 'caddy',
    displayName: 'Caddy',
    packageName: 'caddy',
    systemdUnit: process.env.CADDY_SERVICE_NAME || 'caddy-api',
    setupCommand: 'setup-caddy',
    updateTarget: 'caddy',
    managementNotes: 'Public HTTP/HTTPS edge and reverse proxy.'
  },
  {
    serviceId: 'mqtt',
    displayName: 'Mosquitto MQTT',
    packageName: 'mosquitto',
    systemdUnit: process.env.HOMEBRAIN_MQTT_SERVICE_NAME || 'homebrain-mqtt',
    setupCommand: 'setup-mqtt',
    updateTarget: 'mqtt',
    managementNotes: 'Local platform event and device-state bus.'
  },
  {
    serviceId: 'pihole',
    displayName: 'Pi-hole',
    packageName: 'pihole',
    systemdUnit: 'pihole-FTL',
    setupCommand: 'setup-pihole',
    updateTarget: 'pihole',
    managementNotes: 'Managed DNS sinkhole and network filtering service.'
  },
  {
    serviceId: 'codex',
    displayName: 'Codex CLI',
    packageName: '@openai/codex',
    systemdUnit: '',
    runtimeKind: 'cli',
    setupCommand: 'setup-codex',
    updateTarget: 'codex',
    managementNotes: 'OpenAI coding agent CLI used by HomeBrain for current model access.'
  },
  {
    serviceId: 'reachy-homebrain-app',
    displayName: 'Reachy Mini Companion',
    packageName: 'reachy-homebrain-app',
    systemdUnit: '',
    runtimeKind: 'remote-fleet',
    setupCommand: '',
    updateTarget: 'reachy-homebrain-app',
    managementNotes: 'HomeBrain companion app managed across paired Reachy Mini Wireless robots.'
  }
]);

const DEFINITIONS_BY_ID = new Map(SERVICE_DEFINITIONS.map((definition) => [definition.serviceId, definition]));
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return {};
  }

  const firstJsonLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{') && line.endsWith('}'));
  if (!firstJsonLine) {
    return {};
  }

  return JSON.parse(firstJsonLine);
}

function trimString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function clampPort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeHostname(value) {
  let candidate = trimString(value).toLowerCase();
  while (candidate.endsWith('.')) {
    candidate = candidate.slice(0, -1);
  }
  if (!candidate) {
    return '';
  }
  const ascii = domainToASCII(candidate);
  if (!ascii || ascii.includes('*') || ascii.split('.').length < 2) {
    throw new Error('Hostname must be a fully-qualified DNS name');
  }
  for (const label of ascii.split('.')) {
    if (!label || label.length > 63 || !/^[a-z0-9-]+$/i.test(label) || label.startsWith('-') || label.endsWith('-')) {
      throw new Error('Hostname must be a valid DNS name');
    }
  }
  return ascii.toLowerCase();
}

function getDefaultPublicHostname() {
  const explicit = trimString(process.env.HOMEBRAIN_PUBLIC_HOST).toLowerCase();
  if (explicit) {
    return explicit.replace(/^www\./, '');
  }
  const baseUrl = trimString(process.env.HOMEBRAIN_PUBLIC_BASE_URL);
  if (baseUrl) {
    try {
      return new URL(baseUrl).hostname.replace(/^www\./, '');
    } catch (_error) {
      return '';
    }
  }
  return '';
}

function getSuggestedPiholeHostname() {
  try {
    const configured = normalizeHostname(process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST || '');
    if (configured) {
      return configured;
    }
  } catch (_error) {
    // Ignore invalid environment defaults and fall back to the public host suggestion.
  }
  const publicHost = getDefaultPublicHostname();
  try {
    return publicHost ? normalizeHostname(`pihole.${publicHost}`) : '';
  } catch (_error) {
    return '';
  }
}

function getConfiguredPiholeHostname(existing = {}) {
  const persisted = trimString(existing.adminHostname);
  if (persisted) {
    return normalizeHostname(persisted);
  }

  try {
    return normalizeHostname(process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST || '');
  } catch (_error) {
    return '';
  }
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseListInput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => trimString(entry)).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createReachyUpdateInProgressError() {
  const error = new Error('A Reachy companion fleet update is already in progress');
  error.status = 409;
  error.code = 'REACHY_UPDATE_IN_PROGRESS';
  return error;
}

class PlatformManagedServiceManager {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.spawnProcess = options.spawnProcess || spawn;
    this.checkIntervalMs = Math.max(
      60_000,
      Number(options.checkIntervalMs || process.env.HOMEBRAIN_PLATFORM_SERVICE_MONITOR_MS || DEFAULT_CHECK_INTERVAL_MS)
    );
    this.timer = null;
    this.started = false;
  }

  getDefinitions() {
    return SERVICE_DEFINITIONS.map((definition) => ({ ...definition }));
  }

  getSetupServicesPath() {
    return path.join(this.projectRoot, 'scripts', 'setup-services.sh');
  }

  isDatabaseReady() {
    return mongoose.connection.readyState === 1 && Boolean(mongoose.connection.db);
  }

  async runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, args, {
        cwd: options.cwd || this.projectRoot,
        env: { ...process.env, ...(options.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      child.once('close', (code) => {
        const result = {
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        };
        if (code === 0) {
          resolve(result);
          return;
        }
        const error = new Error(result.stderr || result.stdout || `Command exited with code ${code}`);
        error.code = code;
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        reject(error);
      });
    });
  }

  async runSetupCommand(commandName, target = null) {
    const setupServicesPath = this.getSetupServicesPath();
    if (!fs.existsSync(setupServicesPath)) {
      throw new Error('scripts/setup-services.sh is missing');
    }

    const bashPath = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
    const args = ['-n', bashPath, setupServicesPath, commandName];
    if (target) {
      args.push(target);
    }
    return this.runCommand('sudo', args);
  }

  async getOrCreateRecord(definition) {
    let record = await PlatformManagedService.findOne({ serviceId: definition.serviceId });
    if (!record) {
      record = await PlatformManagedService.create({
        serviceId: definition.serviceId,
        displayName: definition.displayName,
        packageName: definition.packageName
      });
    }
    return record;
  }

  normalizeRecord(record, definition, runtime = {}) {
    const doc = typeof record?.toObject === 'function' ? record.toObject() : record;
    const policy = doc?.policy || {};
    const remoteFleet = definition.runtimeKind === 'remote-fleet';
    const updateAvailable = remoteFleet
      ? Boolean(runtime.updateAvailable)
      : Boolean(doc?.updateAvailable);
    const eligibleAt = doc?.eligibleForAutoUpdateAt ? new Date(doc.eligibleForAutoUpdateAt).toISOString() : null;
    const autoUpdateEligible = updateAvailable
      && Boolean(policy.autoUpdateEnabled)
      && doc?.eligibleForAutoUpdateAt
      && new Date(doc.eligibleForAutoUpdateAt).getTime() <= Date.now();

    return {
      serviceId: definition.serviceId,
      displayName: definition.displayName,
      packageName: definition.packageName,
      systemdUnit: definition.systemdUnit,
      runtimeKind: definition.runtimeKind || 'daemon',
      managementNotes: definition.managementNotes,
      installed: Boolean(runtime.installed),
      ...(remoteFleet ? {
        paired: Boolean(runtime.paired),
        setupRequired: Boolean(runtime.setupRequired),
        devices: Array.isArray(runtime.devices) ? runtime.devices : []
      } : {}),
      active: Boolean(runtime.active),
      currentVersion: remoteFleet ? (runtime.currentVersion || '') : (doc?.currentVersion || runtime.currentVersion || ''),
      latestVersion: remoteFleet ? (runtime.latestVersion || doc?.latestVersion || '') : (doc?.latestVersion || ''),
      updateAvailable,
      candidateFirstSeenAt: doc?.candidateFirstSeenAt ? new Date(doc.candidateFirstSeenAt).toISOString() : null,
      eligibleForAutoUpdateAt: eligibleAt,
      autoUpdateEligible: Boolean(autoUpdateEligible),
      lastCheckedAt: doc?.lastCheckedAt ? new Date(doc.lastCheckedAt).toISOString() : null,
      lastUpdatedAt: doc?.lastUpdatedAt ? new Date(doc.lastUpdatedAt).toISOString() : null,
      lastUpdateStatus: doc?.lastUpdateStatus || 'never',
      lastError: doc?.lastError || runtime.error || '',
      policy: {
        autoCheckEnabled: policy.autoCheckEnabled !== false,
        autoUpdateEnabled: policy.autoUpdateEnabled === true,
        checkIntervalDays: clampInteger(policy.checkIntervalDays, 7, 1, 90),
        stabilityDelayDays: clampInteger(policy.stabilityDelayDays, 30, 0, 365)
      }
    };
  }

  getServiceDefinition(serviceId) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }
    return definition;
  }

  getMqttConfig(record = null) {
    const existing = record?.config?.mqtt && typeof record.config.mqtt === 'object'
      ? record.config.mqtt
      : {};
    const explicitUrl = trimString(process.env.HOMEBRAIN_MQTT_URL);
    let parsedUrl = null;
    if (explicitUrl) {
      try {
        parsedUrl = new URL(explicitUrl);
      } catch (_error) {
        parsedUrl = null;
      }
    }

    return {
      mode: ['auto', 'enabled', 'disabled'].includes(existing.mode)
        ? existing.mode
        : (process.env.HOMEBRAIN_MQTT_ENABLED || 'auto'),
      protocol: ['mqtt', 'mqtts'].includes(existing.protocol)
        ? existing.protocol
        : (parsedUrl?.protocol?.replace(':', '') || process.env.HOMEBRAIN_MQTT_PROTOCOL || 'mqtt'),
      host: trimString(existing.host)
        || parsedUrl?.hostname
        || trimString(process.env.HOMEBRAIN_MQTT_HOST, '127.0.0.1'),
      port: clampPort(existing.port, Number(parsedUrl?.port || process.env.HOMEBRAIN_MQTT_PORT || 1883)),
      topicPrefix: mqttPlatformService.normalizeTopicPrefix
        ? mqttPlatformService.normalizeTopicPrefix(existing.topicPrefix || process.env.HOMEBRAIN_MQTT_TOPIC_PREFIX || 'homebrain')
        : (existing.topicPrefix || process.env.HOMEBRAIN_MQTT_TOPIC_PREFIX || 'homebrain'),
      clientId: trimString(existing.clientId || process.env.HOMEBRAIN_MQTT_CLIENT_ID),
      username: trimString(existing.username || process.env.HOMEBRAIN_MQTT_USERNAME),
      password: existing.password || process.env.HOMEBRAIN_MQTT_PASSWORD || '',
      keepaliveSeconds: clampNumber(existing.keepaliveSeconds, Number(process.env.HOMEBRAIN_MQTT_KEEPALIVE_SECONDS || 60), 15, 600),
      connectTimeoutMs: clampNumber(existing.connectTimeoutMs, Number(process.env.HOMEBRAIN_MQTT_CONNECT_TIMEOUT_MS || 3000), 1000, 60000),
      reconnectMs: clampNumber(existing.reconnectMs, Number(process.env.HOMEBRAIN_MQTT_RECONNECT_MS || 15000), 0, 300000)
    };
  }

  sanitizeMqttConfig(input = {}, existingRecord = null) {
    const current = this.getMqttConfig(existingRecord);
    const protocol = ['mqtt', 'mqtts'].includes(input.protocol) ? input.protocol : current.protocol;
    const host = trimString(input.host, current.host) || '127.0.0.1';
    const port = clampPort(input.port, current.port);
    const topicPrefix = mqttPlatformService.normalizeTopicPrefix
      ? mqttPlatformService.normalizeTopicPrefix(input.topicPrefix || current.topicPrefix)
      : trimString(input.topicPrefix, current.topicPrefix || 'homebrain');
    const mode = ['auto', 'enabled', 'disabled'].includes(input.mode) ? input.mode : current.mode;
    const password = Object.prototype.hasOwnProperty.call(input, 'password')
      ? String(input.password || '')
      : current.password;

    return {
      mode,
      protocol,
      host,
      port,
      brokerUrl: `${protocol}://${host}:${port}`,
      topicPrefix,
      clientId: trimString(input.clientId, current.clientId),
      username: trimString(input.username, current.username),
      password,
      keepaliveSeconds: clampNumber(input.keepaliveSeconds, current.keepaliveSeconds, 15, 600),
      connectTimeoutMs: clampNumber(input.connectTimeoutMs, current.connectTimeoutMs, 1000, 60000),
      reconnectMs: clampNumber(input.reconnectMs, current.reconnectMs, 0, 300000)
    };
  }

  sanitizeMqttConfigForClient(config) {
    const { password: _password, ...safe } = config || {};
    return {
      ...safe,
      passwordConfigured: Boolean(config?.password)
    };
  }

  async getMqttManagement({ limit = 50 } = {}) {
    const definition = this.getServiceDefinition('mqtt');
    const [record, runtime, status] = await Promise.all([
      this.getOrCreateRecord(definition),
      this.getRuntimeStatus(definition),
      mqttPlatformService.getStatus({ probe: true })
    ]);
    return {
      service: this.normalizeRecord(record, definition, runtime),
      status,
      config: this.sanitizeMqttConfigForClient(this.getMqttConfig(record)),
      recentMessages: mqttPlatformService.getRecentMessages(limit),
      routing: {
        supported: false,
        protocol: 'tcp',
        reason: 'MQTT uses raw TCP on 1883. HomeBrain reverse-proxy routes are HTTP/S, so no Caddy route is needed unless MQTT-over-WebSockets is added later.'
      }
    };
  }

  async updateMqttConfig(configPatch = {}) {
    const definition = this.getServiceDefinition('mqtt');
    const record = await this.getOrCreateRecord(definition);
    const config = this.sanitizeMqttConfig(configPatch, record);
    record.config = {
      ...(record.config || {}),
      mqtt: config
    };
    record.markModified('config');
    await record.save();
    await mqttPlatformService.reloadConfig({ reconnect: true });
    return this.getMqttManagement();
  }

  async publishMqttTest(payload = {}) {
    const status = await mqttPlatformService.getStatus({ probe: true });
    const topicSuffix = trimString(payload.topic, 'diagnostics/test').replace(/^\/+/, '');
    const topic = topicSuffix.includes('/')
      ? `${status.topicPrefix}/${topicSuffix}`
      : `${status.topicPrefix}/diagnostics/${topicSuffix}`;
    const message = {
      schema: 'homebrain.mqtt.test.v1',
      message: trimString(payload.message, 'HomeBrain MQTT test'),
      publishedAt: new Date().toISOString()
    };
    const result = await mqttPlatformService.publishJson(topic, message, {
      qos: Number(payload.qos) === 1 ? 1 : 0,
      retain: payload.retain === true
    });
    return {
      ...result,
      topic,
      payload: message
    };
  }

  getPiholeConfig(record = null) {
    const existing = record?.config?.pihole && typeof record.config.pihole === 'object'
      ? record.config.pihole
      : {};
    const configuredHostname = getConfiguredPiholeHostname(existing);
    const suggestedHostname = getSuggestedPiholeHostname();
    return {
      webPort: clampPort(existing.webPort, Number(process.env.HOMEBRAIN_PIHOLE_WEB_PORT || 8081)),
      webTlsPort: clampPort(existing.webTlsPort, Number(process.env.HOMEBRAIN_PIHOLE_WEB_TLS_PORT || 8444)),
      adminHostname: configuredHostname || suggestedHostname,
      adminHostnameConfigured: Boolean(configuredHostname),
      suggestedAdminHostname: suggestedHostname,
      adminRouteEnabled: existing.adminRouteEnabled === true,
      dynamicDnsEnabled: existing.dynamicDnsEnabled !== false,
      applyRouteOnSave: existing.applyRouteOnSave === true,
      upstreamDns: parseListInput(existing.upstreamDns || process.env.HOMEBRAIN_PIHOLE_UPSTREAM_DNS || ''),
      managedBlocklists: parseListInput(existing.managedBlocklists || '')
    };
  }

  sanitizePiholeConfig(input = {}, existingRecord = null) {
    const current = this.getPiholeConfig(existingRecord);
    const adminHostname = Object.prototype.hasOwnProperty.call(input, 'adminHostname')
      ? normalizeHostname(input.adminHostname)
      : current.adminHostname;
    return {
      webPort: clampPort(input.webPort, current.webPort),
      webTlsPort: clampPort(input.webTlsPort, current.webTlsPort),
      adminHostname,
      adminRouteEnabled: typeof input.adminRouteEnabled === 'boolean' ? input.adminRouteEnabled : current.adminRouteEnabled,
      dynamicDnsEnabled: typeof input.dynamicDnsEnabled === 'boolean' ? input.dynamicDnsEnabled : current.dynamicDnsEnabled,
      applyRouteOnSave: typeof input.applyRouteOnSave === 'boolean' ? input.applyRouteOnSave : current.applyRouteOnSave,
      upstreamDns: parseListInput(input.upstreamDns ?? current.upstreamDns),
      managedBlocklists: parseListInput(input.managedBlocklists ?? current.managedBlocklists)
    };
  }

  async findPiholeRoute(config = null) {
    const piholeConfig = config || this.getPiholeConfig();
    const queries = [{ platformKey: 'pihole' }];
    if (piholeConfig.adminHostname) {
      queries.push({ hostname: piholeConfig.adminHostname });
    }
    return ReverseProxyRoute.findOne({ $or: queries }).lean();
  }

  buildPiholeRoutePayload(config) {
    if (!config.adminHostname) {
      throw new Error('Pi-hole admin route hostname is required');
    }
    return {
      hostname: config.adminHostname,
      platformKey: 'pihole',
      displayName: 'Pi-hole Admin',
      upstreamProtocol: 'http',
      upstreamHost: '127.0.0.1',
      upstreamPort: config.webPort,
      enabled: config.adminRouteEnabled,
      tlsMode: 'automatic',
      allowOnDemandTls: true,
      allowPublicUpstream: false,
      healthCheckPath: '/',
      websocketSupport: false,
      dynamicDnsEnabled: config.dynamicDnsEnabled,
      notes: 'Managed automatically by HomeBrain Platform Services for the Pi-hole admin console.'
    };
  }

  async ensurePiholeRoute({ actor = 'system', apply = false } = {}) {
    const definition = this.getServiceDefinition('pihole');
    const record = await this.getOrCreateRecord(definition);
    const config = this.getPiholeConfig(record);
    const payload = this.buildPiholeRoutePayload(config);
    const existing = await ReverseProxyRoute.findOne({
      $or: [
        { platformKey: 'pihole' },
        { hostname: payload.hostname }
      ]
    });

    const route = existing
      ? await reverseProxyService.updateRoute(existing._id, payload, actor)
      : await reverseProxyService.createRoute(payload, actor);
    const applyResult = apply ? await reverseProxyService.applyConfig(actor) : null;
    return { route, applyResult };
  }

  async ensureManagedRoutes({ actor = 'system' } = {}) {
    const result = {
      created: [],
      updated: [],
      skipped: []
    };

    const definition = this.getServiceDefinition('pihole');
    const record = await this.getOrCreateRecord(definition);
    const existing = record?.config?.pihole && typeof record.config.pihole === 'object'
      ? record.config.pihole
      : {};
    const configuredHostname = getConfiguredPiholeHostname(existing);
    if (!configuredHostname) {
      result.skipped.push({ serviceId: 'pihole', reason: 'admin-hostname-not-configured' });
      return result;
    }

    const config = {
      ...this.getPiholeConfig(record),
      adminHostname: configuredHostname,
      adminHostnameConfigured: true
    };
    const before = await this.findPiholeRoute(config);
    const ensured = await this.ensurePiholeRoute({ actor, apply: false });
    const hostname = ensured.route?.hostname || config.adminHostname;
    if (before) {
      result.updated.push(hostname);
    } else {
      result.created.push(hostname);
    }
    return result;
  }

  async getPiholeStatusText() {
    return this.runCommand('bash', ['-lc', 'pihole status 2>/dev/null || true'])
      .then((result) => result.stdout)
      .catch((error) => error.message || '');
  }

  async getPiholeSummary() {
    const result = await this.runCommand('bash', ['-lc', 'pihole -c -j 2>/dev/null || true']).catch(() => ({ stdout: '' }));
    try {
      return JSON.parse(result.stdout || '{}');
    } catch (_error) {
      return {};
    }
  }

  async getPiholeQueryLog(limit = 80) {
    const safeLimit = Math.max(1, Math.min(250, Number(limit) || 80));
    const command = [
      'if sudo -n test -r /var/log/pihole/pihole.log 2>/dev/null; then',
      `sudo -n tail -n ${safeLimit} /var/log/pihole/pihole.log;`,
      'elif test -r /var/log/pihole/pihole.log; then',
      `tail -n ${safeLimit} /var/log/pihole/pihole.log;`,
      'elif sudo -n test -r /var/log/pihole.log 2>/dev/null; then',
      `sudo -n tail -n ${safeLimit} /var/log/pihole.log;`,
      'else true; fi'
    ].join(' ');
    const result = await this.runCommand('bash', ['-lc', command]).catch(() => ({ stdout: '' }));
    return splitLines(result.stdout).slice(-safeLimit).map((line) => ({ line }));
  }

  async getPiholeAdlists() {
    const sql = 'SELECT address, enabled, comment FROM adlist ORDER BY id;';
    const command = `if command -v sqlite3 >/dev/null 2>&1 && sudo -n test -r /etc/pihole/gravity.db 2>/dev/null; then sudo -n sqlite3 -separator $'\\t' /etc/pihole/gravity.db ${shellQuote(sql)}; fi`;
    const result = await this.runCommand('bash', ['-lc', command]).catch(() => ({ stdout: '' }));
    return splitLines(result.stdout).map((line) => {
      const [address, enabled, comment] = line.split('\t');
      return {
        address,
        enabled: enabled !== '0',
        comment: comment || ''
      };
    }).filter((entry) => entry.address);
  }

  async applyPiholeWebPortConfig(config) {
    const portConfig = `${config.webPort}o,[::]:${config.webPort}o,${config.webTlsPort}os,[::]:${config.webTlsPort}os`;
    const command = [
      'if command -v pihole-FTL >/dev/null 2>&1; then',
      `sudo -n pihole-FTL --config webserver.port ${shellQuote(portConfig)} >/dev/null;`,
      'if sudo -n systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk \'{print $1}\' | grep -qx pihole-FTL.service; then',
      'sudo -n systemctl restart pihole-FTL >/dev/null 2>&1 || true;',
      'fi;',
      'fi'
    ].join(' ');
    return this.runCommand('bash', ['-lc', command]);
  }

  async getPiholeManagement({ queryLimit = 80 } = {}) {
    const definition = this.getServiceDefinition('pihole');
    const record = await this.getOrCreateRecord(definition);
    const [runtime, route, statusText, summary, queryLog, adlists] = await Promise.all([
      this.getRuntimeStatus(definition),
      this.findPiholeRoute(this.getPiholeConfig(record)),
      this.getPiholeStatusText(),
      this.getPiholeSummary(),
      this.getPiholeQueryLog(queryLimit),
      this.getPiholeAdlists()
    ]);
    const config = this.getPiholeConfig(record);
    return {
      service: this.normalizeRecord(record, definition, runtime),
      config,
      route,
      statusText,
      summary,
      queryLog,
      adlists,
      adminUrls: {
        local: `http://127.0.0.1:${config.webPort}/admin`,
        public: route?.enabled && route.hostname ? `https://${route.hostname}/admin` : ''
      },
      routing: {
        needed: true,
        routePresent: Boolean(route),
        routeEnabled: Boolean(route?.enabled),
        routeStatus: route?.validationStatus || 'missing'
      }
    };
  }

  async updatePiholeConfig(configPatch = {}, { actor = 'system' } = {}) {
    const definition = this.getServiceDefinition('pihole');
    const record = await this.getOrCreateRecord(definition);
    const previous = this.getPiholeConfig(record);
    const config = this.sanitizePiholeConfig(configPatch, record);
    record.config = {
      ...(record.config || {}),
      pihole: config
    };
    record.markModified('config');
    await record.save();

    if (previous.webPort !== config.webPort || previous.webTlsPort !== config.webTlsPort) {
      await this.applyPiholeWebPortConfig(config).catch((error) => {
        record.lastError = error.message;
        return record.save();
      });
    }

    if (config.adminHostname) {
      await this.ensurePiholeRoute({
        actor,
        apply: config.applyRouteOnSave && config.adminRouteEnabled
      }).catch((error) => {
        record.lastError = error.message;
        return record.save();
      });
    }

    return this.getPiholeManagement();
  }

  async runPiholeGravity({ actor = 'system' } = {}) {
    await this.runCommand('sudo', ['-n', 'pihole', '-g']);
    void eventStreamService.publishSafe({
      type: 'platform_service.pihole_gravity_updated',
      source: 'platform_services',
      category: 'platform',
      payload: { actor },
      tags: ['platform-services', 'pihole']
    });
    return this.getPiholeManagement();
  }

  async getRuntimeStatus(definition) {
    if (definition.serviceId === 'reachy-homebrain-app') {
      const reachyMiniService = require('./reachyMiniService');
      return reachyMiniService.getCompanionFleetStatus();
    }
    const executableName = definition.serviceId === 'pihole'
      ? 'pihole'
      : definition.serviceId === 'codex'
        ? 'codex'
        : definition.packageName;
    const installed = await this.runCommand('bash', ['-lc', `command -v ${executableName}`])
      .then(() => true)
      .catch(() => false);
    const active = definition.runtimeKind === 'cli'
      ? installed
      : await this.runCommand('systemctl', ['is-active', '--quiet', definition.systemdUnit])
        .then(() => true)
        .catch(() => false);

    let currentVersion = '';
    try {
      if (definition.serviceId === 'caddy') {
        currentVersion = (await this.runCommand('bash', ['-lc', 'caddy version 2>/dev/null || true'])).stdout;
      } else if (definition.serviceId === 'mqtt') {
        currentVersion = (await this.runCommand('bash', ['-lc', "mosquitto -h 2>&1 | awk 'NR==1 {print}'"])).stdout;
      } else if (definition.serviceId === 'pihole') {
        currentVersion = (await this.runCommand('bash', ['-lc', "pihole version 2>/dev/null | tr '\\n' ' ' | sed 's/[[:space:]]\\+/ /g' || true"])).stdout;
      } else if (definition.serviceId === 'codex') {
        currentVersion = (await this.runCommand('bash', ['-lc', "codex --version 2>/dev/null | awk 'NR==1 {print $NF}' || true"])).stdout;
      }
    } catch (error) {
      currentVersion = '';
    }

    return {
      installed,
      active,
      currentVersion
    };
  }

  async reconcileReachyRecord(record, fleet, options = {}) {
    if (!record || !fleet) return record;
    record.currentVersion = fleet.currentVersion || '';
    record.latestVersion = fleet.latestVersion || record.latestVersion || '';
    record.updateAvailable = Boolean(fleet.updateAvailable);
    if (options.checkedAt) record.lastCheckedAt = options.checkedAt;

    const update = record.config?.reachyUpdate;
    if (record.lastUpdateStatus === 'in_progress' && update) {
      const plannedDeviceIds = Array.isArray(update.plannedDeviceIds)
        ? update.plannedDeviceIds.map((value) => String(value || '')).filter(Boolean)
        : [];
      const acceptedDeviceIds = Array.isArray(update.deviceIds)
        ? update.deviceIds.map((value) => String(value || '')).filter(Boolean)
        : [];
      const dispatchFailures = Array.isArray(update.dispatchFailures)
        ? update.dispatchFailures.filter((failure) => failure && failure.deviceId)
        : [];
      const trackedDeviceIds = Array.from(new Set([
        ...plannedDeviceIds,
        ...acceptedDeviceIds,
        ...dispatchFailures.map((failure) => String(failure.deviceId))
      ]));
      const fleetStatuses = Array.isArray(fleet.devices) ? fleet.devices : [];
      const statusByDeviceId = new Map(
        fleetStatuses.map((status) => [String(status.deviceId), status])
      );
      const requestByDeviceId = new Map(
        (Array.isArray(update.requests) ? update.requests : [])
          .filter((request) => request?.deviceId && request?.requestId)
          .map((request) => [String(request.deviceId), request])
      );
      const dispatchFailureByDeviceId = new Map(
        dispatchFailures.map((failure) => [String(failure.deviceId), failure])
      );
      const activeStates = new Set(['staging', 'staged', 'updating']);
      const failureStates = new Set([
        'failed',
        'manual_reinstall_required',
        'version_collision',
        'downgrade_blocked'
      ]);
      const startedAt = Date.parse(update.startedAt || '');
      const dispatchCompleted = Number.isFinite(Date.parse(update.dispatchCompletedAt || ''));
      const stale = Number.isFinite(startedAt) && Date.now() - startedAt > 30 * 60 * 1000;
      const outcomes = [];
      let recoveredCorrelation = false;

      for (const deviceId of trackedDeviceIds) {
        const status = statusByDeviceId.get(deviceId) || null;
        const expectedRequest = requestByDeviceId.get(deviceId) || null;
        const statusRequestId = trimString(status?.requestId);
        const statusRequestedAt = Date.parse(status?.requestedAt || status?.updateStartedAt || '');
        const freshPlannedRequest = Boolean(
          statusRequestId
          && Number.isFinite(startedAt)
          && Number.isFinite(statusRequestedAt)
          && statusRequestedAt >= startedAt - 5_000
        );
        const requestMatches = expectedRequest
          ? statusRequestId === String(expectedRequest.requestId)
          : (acceptedDeviceIds.includes(deviceId) ? Boolean(statusRequestId) : freshPlannedRequest);
        const current = Boolean(status?.current === true && status?.updateAvailable === false);

        // A hub crash can happen after Reachy durably enters staging but before
        // the accepted request correlation is saved. Recover that correlation
        // only from a fleet request created during this exact batch window.
        if (!expectedRequest && freshPlannedRequest) {
          update.deviceIds = Array.from(new Set([
            ...(Array.isArray(update.deviceIds) ? update.deviceIds : []).map((value) => String(value || '')).filter(Boolean),
            deviceId
          ]));
          update.requests = [
            ...(Array.isArray(update.requests) ? update.requests : []),
            { deviceId, requestId: statusRequestId, recovered: true }
          ];
          requestByDeviceId.set(deviceId, { deviceId, requestId: statusRequestId, recovered: true });
          recoveredCorrelation = true;
        }

        if (current || (requestMatches && status?.state === 'completed')) {
          outcomes.push({ deviceId, state: 'success', status });
        } else if (requestMatches && activeStates.has(status?.state)) {
          outcomes.push({ deviceId, state: 'active', status });
        } else if (requestMatches && failureStates.has(status?.state)) {
          outcomes.push({ deviceId, state: 'failed', status, error: status?.error });
        } else if (dispatchFailureByDeviceId.has(deviceId)) {
          outcomes.push({
            deviceId,
            state: 'failed',
            status,
            error: dispatchFailureByDeviceId.get(deviceId)?.error
          });
        } else if (dispatchCompleted) {
          outcomes.push({
            deviceId,
            state: 'failed',
            status,
            error: status?.unavailableReason || 'Reachy did not acknowledge the planned update'
          });
        } else {
          outcomes.push({ deviceId, state: 'unresolved', status });
        }
      }

      if (recoveredCorrelation) record.markModified?.('config');
      const active = outcomes.filter((outcome) => outcome.state === 'active');
      const failures = outcomes.filter((outcome) => outcome.state === 'failed');
      const successes = outcomes.filter((outcome) => outcome.state === 'success');
      const unresolved = outcomes.filter((outcome) => outcome.state === 'unresolved');
      const totalFailures = failures.length;

      if (active.length === 0 && unresolved.length === 0 && totalFailures > 0) {
        record.lastUpdateStatus = 'failed';
        record.lastUpdatedAt = new Date();
        record.lastError = successes.length > 0
          ? `Reachy update partially completed (${successes.length} succeeded, ${totalFailures} failed)`
          : (
              failures.find((failure) => failure.error)?.error
              || 'Reachy companion update failed'
            );
      } else if (
        active.length === 0
        && unresolved.length === 0
        && trackedDeviceIds.length > 0
        && successes.length === trackedDeviceIds.length
      ) {
        record.lastUpdateStatus = 'success';
        record.lastUpdatedAt = new Date();
        record.lastError = '';
        record.updateAvailable = Boolean(fleet.updateAvailable);
      } else if (stale) {
        record.lastUpdateStatus = 'failed';
        record.lastUpdatedAt = new Date();
        record.lastError = successes.length > 0
          ? `Reachy update partially completed (${successes.length} succeeded, ${trackedDeviceIds.length - successes.length} failed)`
          : 'Reachy companion update did not reach a terminal state';
      }

      if (record.lastUpdateStatus !== 'in_progress') {
        record.config = { ...(record.config || {}) };
        delete record.config.reachyUpdate;
        record.markModified?.('config');
      }
    }
    await record.save();
    return record;
  }

  async claimReachyUpdateBatch(record, reachyUpdate) {
    if (record?.lastUpdateStatus === 'in_progress') {
      throw createReachyUpdateInProgressError();
    }

    const claimedAt = new Date();
    if (record?._id) {
      const claimed = await PlatformManagedService.findOneAndUpdate(
        { _id: record._id, lastUpdateStatus: { $ne: 'in_progress' } },
        {
          $set: {
            'config.reachyUpdate': reachyUpdate,
            lastUpdatedAt: claimedAt,
            lastUpdateStatus: 'in_progress',
            lastError: ''
          }
        },
        { returnDocument: 'after', runValidators: true }
      );
      if (!claimed) throw createReachyUpdateInProgressError();
      return claimed;
    }

    // Isolated unit tests may use a document-shaped record without a Mongo ID.
    // Production records always take the atomic findOneAndUpdate path above.
    record.config = { ...(record.config || {}), reachyUpdate };
    record.lastUpdatedAt = claimedAt;
    record.lastUpdateStatus = 'in_progress';
    record.lastError = '';
    record.markModified?.('config');
    await record.save();
    return record;
  }

  async reconcileReachyFleetStatus(options = {}) {
    if (!this.isDatabaseReady()) return null;
    const definition = this.getServiceDefinition('reachy-homebrain-app');
    const [record, fleet] = await Promise.all([
      this.getOrCreateRecord(definition),
      require('./reachyMiniService').getCompanionFleetStatus({ force: options.force === true })
    ]);
    await this.reconcileReachyRecord(record, fleet, options);
    return this.normalizeRecord(record, definition, fleet);
  }

  async listServices() {
    if (!this.isDatabaseReady()) {
      return Promise.all(SERVICE_DEFINITIONS.map(async (definition) => (
        this.normalizeRecord(null, definition, await this.getRuntimeStatus(definition))
      )));
    }

    const services = [];
    for (const definition of SERVICE_DEFINITIONS) {
      const [record, runtime] = await Promise.all([
        this.getOrCreateRecord(definition),
        this.getRuntimeStatus(definition)
      ]);
      if (definition.serviceId === 'reachy-homebrain-app') {
        await this.reconcileReachyRecord(record, runtime);
      }
      services.push(this.normalizeRecord(record, definition, runtime));
    }
    return services;
  }

  async checkForUpdates(serviceId, { actor = 'system' } = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    const checkedAt = new Date();
    const record = await this.getOrCreateRecord(definition);
    let updateInfo;

    try {
      if (serviceId === 'reachy-homebrain-app') {
        const fleet = await require('./reachyMiniService').getCompanionFleetStatus({ force: true });
        updateInfo = {
          latestVersion: fleet.latestVersion,
          currentVersion: fleet.currentVersion,
          updateAvailable: fleet.updateAvailable
        };
        await this.reconcileReachyRecord(record, fleet, { checkedAt });
      } else {
        const result = await this.runSetupCommand('check-platform-service-updates', definition.updateTarget);
        updateInfo = parseJsonOutput(result.stdout);
      }
    } catch (error) {
      record.lastCheckedAt = checkedAt;
      record.lastError = error.message || 'Update check failed';
      await record.save();
      throw error;
    }

    const nextLatest = String(updateInfo.latestVersion || '').trim();
    const nextCurrent = String(updateInfo.currentVersion || '').trim();
    const updateAvailable = updateInfo.updateAvailable === true;
    const existingLatest = record.latestVersion || '';
    const firstSeenAt = updateAvailable
      ? (existingLatest === nextLatest && record.candidateFirstSeenAt ? record.candidateFirstSeenAt : checkedAt)
      : null;
    const stabilityDelayDays = clampInteger(record.policy?.stabilityDelayDays, 30, 0, 365);

    record.currentVersion = nextCurrent || record.currentVersion || '';
    record.latestVersion = nextLatest || '';
    record.updateAvailable = updateAvailable;
    record.candidateFirstSeenAt = firstSeenAt;
    record.eligibleForAutoUpdateAt = updateAvailable && firstSeenAt ? addDays(firstSeenAt, stabilityDelayDays) : null;
    record.lastCheckedAt = checkedAt;
    if (serviceId !== 'reachy-homebrain-app' || record.lastUpdateStatus !== 'failed') {
      record.lastError = '';
    }
    await record.save();

    void eventStreamService.publishSafe({
      type: 'platform_service.update_checked',
      source: 'platform_services',
      category: 'platform',
      payload: {
        serviceId,
        actor,
        currentVersion: record.currentVersion,
        latestVersion: record.latestVersion,
        updateAvailable: record.updateAvailable,
        eligibleForAutoUpdateAt: record.eligibleForAutoUpdateAt
      },
      tags: ['platform-services', serviceId]
    });

    return this.normalizeRecord(record, definition, await this.getRuntimeStatus(definition));
  }

  async installService(serviceId, { actor = 'system' } = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    try {
      if (serviceId === 'reachy-homebrain-app') {
        const fleet = await require('./reachyMiniService').getCompanionFleetStatus();
        if (!fleet.paired) {
          throw new Error('Reachy setup is required: pair a Reachy Mini from the Reachy settings page first.');
        }
        if (!fleet.installed || fleet.setupRequired) {
          throw new Error('Reachy bootstrap is required: run the one-time installer from the Reachy settings page.');
        }
      } else {
        await this.runSetupCommand(definition.setupCommand);
      }
    } catch (error) {
      const record = await this.getOrCreateRecord(definition);
      record.lastUpdateStatus = 'failed';
      record.lastError = error.message || 'Install failed';
      await record.save();
      throw error;
    }

    if (serviceId === 'reachy-homebrain-app') {
      return this.checkForUpdates(serviceId, { actor });
    }

    void eventStreamService.publishSafe({
      type: 'platform_service.installed',
      source: 'platform_services',
      category: 'platform',
      payload: { serviceId, actor },
      tags: ['platform-services', serviceId]
    });
    return this.checkForUpdates(serviceId, { actor });
  }

  async updateService(serviceId, { actor = 'system', automatic = false } = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    let record = await this.getOrCreateRecord(definition);
    let reachyUpdateClaimed = false;
    if (serviceId === 'reachy-homebrain-app' && record.lastUpdateStatus === 'in_progress') {
      throw createReachyUpdateInProgressError();
    }
    try {
      if (serviceId === 'reachy-homebrain-app') {
        const reachyMiniService = require('./reachyMiniService');
        const fleet = await reachyMiniService.getCompanionFleetStatus({ force: true });
        const candidates = fleet.devices.filter((device) => device.updateAvailable && !device.unavailableReason);
        if (!candidates.length && fleet.updateAvailable) {
          throw new Error('Reachy companion updates are available, but no paired robot is currently reachable.');
        }
        if (!candidates.length) {
          record.lastUpdatedAt = new Date();
          record.lastUpdateStatus = 'skipped';
          record.lastError = '';
          record.currentVersion = fleet.currentVersion || record.currentVersion || '';
          record.latestVersion = fleet.latestVersion || record.latestVersion || '';
          record.updateAvailable = Boolean(fleet.updateAvailable);
          await record.save();
          return this.normalizeRecord(record, definition, fleet);
        }
        const startedAt = new Date().toISOString();
        const dispatched = [];
        const dispatchFailures = [];
        // Persist the complete batch intent before the first robot receives a
        // stage request. Every accepted correlation is then appended and saved
        // immediately, so a later robot failure or hub crash can never erase an
        // already-triggered physical-fleet side effect.
        const reachyUpdate = {
          plannedDeviceIds: candidates.map((device) => device.deviceId),
          deviceIds: [],
          requests: [],
          dispatchFailures: [],
          startedAt,
          actor,
          automatic
        };
        record = await this.claimReachyUpdateBatch(record, reachyUpdate);
        reachyUpdateClaimed = true;

        for (const device of candidates) {
          try {
            const accepted = await reachyMiniService.requestCompanionUpdate(device.deviceId, {
              manifestUrl: `/api/reachy-mini/${device.deviceId}/companion/manifest`,
              actorUserId: null
            });
            if (!accepted?.requestId || accepted.accepted === false) {
              throw new Error(accepted?.reason || 'Reachy did not accept the update request');
            }
            dispatched.push({ deviceId: device.deviceId, requestId: accepted.requestId });
            record.config.reachyUpdate.deviceIds = dispatched.map((entry) => entry.deviceId);
            record.config.reachyUpdate.requests = [...dispatched];
          } catch (error) {
            dispatchFailures.push({
              deviceId: device.deviceId,
              error: String(error?.message || 'Update dispatch failed').slice(0, 500),
              failedAt: new Date().toISOString()
            });
            record.config.reachyUpdate.dispatchFailures = [...dispatchFailures];
          }
          record.markModified?.('config');
          await record.save();
        }
        record.config.reachyUpdate.dispatchCompletedAt = new Date().toISOString();
        record.markModified?.('config');
        await record.save();
        if (dispatched.length === 0) {
          record.lastUpdateStatus = 'failed';
          record.lastUpdatedAt = new Date();
          record.lastError = dispatchFailures[0]?.error || 'No Reachy update request was accepted';
          await record.save();
          throw new Error(record.lastError);
        }
        if (dispatchFailures.length > 0) {
          record.lastError = `Reachy update dispatch partially accepted (${dispatched.length} accepted, ${dispatchFailures.length} failed)`;
          await record.save();
        }
      } else {
        await this.runSetupCommand('update-platform-service', definition.updateTarget);
      }
    } catch (error) {
      if (serviceId === 'reachy-homebrain-app' && !reachyUpdateClaimed) {
        throw error;
      }
      record.lastUpdatedAt = new Date();
      record.lastUpdateStatus = 'failed';
      record.lastError = error.message || 'Update failed';
      await record.save();
      throw error;
    }

    record.lastUpdatedAt = new Date();
    record.lastUpdateStatus = serviceId === 'reachy-homebrain-app' ? 'in_progress' : 'success';
    record.updateAvailable = serviceId === 'reachy-homebrain-app' ? record.updateAvailable : false;
    record.candidateFirstSeenAt = null;
    record.eligibleForAutoUpdateAt = null;
    if (serviceId !== 'reachy-homebrain-app' || !record.lastError) {
      record.lastError = '';
    }
    await record.save();

    void eventStreamService.publishSafe({
      type: automatic ? 'platform_service.auto_updated' : 'platform_service.updated',
      source: 'platform_services',
      category: 'platform',
      payload: { serviceId, actor },
      tags: ['platform-services', serviceId, automatic ? 'auto-update' : 'manual-update']
    });

    if (serviceId === 'reachy-homebrain-app') {
      return this.normalizeRecord(record, definition, await this.getRuntimeStatus(definition));
    }
    return this.checkForUpdates(serviceId, { actor });
  }

  async updatePolicy(serviceId, policyPatch = {}) {
    const definition = DEFINITIONS_BY_ID.get(serviceId);
    if (!definition) {
      throw new Error(`Unknown platform service: ${serviceId}`);
    }

    const record = await this.getOrCreateRecord(definition);
    record.policy = {
      autoCheckEnabled: typeof policyPatch.autoCheckEnabled === 'boolean'
        ? policyPatch.autoCheckEnabled
        : record.policy?.autoCheckEnabled !== false,
      autoUpdateEnabled: typeof policyPatch.autoUpdateEnabled === 'boolean'
        ? policyPatch.autoUpdateEnabled
        : record.policy?.autoUpdateEnabled === true,
      checkIntervalDays: clampInteger(policyPatch.checkIntervalDays, record.policy?.checkIntervalDays || 7, 1, 90),
      stabilityDelayDays: clampInteger(policyPatch.stabilityDelayDays, record.policy?.stabilityDelayDays || 30, 0, 365)
    };
    if (record.updateAvailable && record.candidateFirstSeenAt) {
      record.eligibleForAutoUpdateAt = addDays(record.candidateFirstSeenAt, record.policy.stabilityDelayDays);
    }
    await record.save();
    return this.normalizeRecord(record, definition, await this.getRuntimeStatus(definition));
  }

  isDueForCheck(service) {
    if (!service.policy.autoCheckEnabled) {
      return false;
    }
    if (!service.lastCheckedAt) {
      return true;
    }
    const lastChecked = Date.parse(service.lastCheckedAt);
    if (!Number.isFinite(lastChecked)) {
      return true;
    }
    return Date.now() - lastChecked >= service.policy.checkIntervalDays * 24 * 60 * 60 * 1000;
  }

  async runPolicyPass({ actor = 'system:platform-service-monitor' } = {}) {
    if (!this.isDatabaseReady()) {
      return { checked: [], updated: [], skipped: true, reason: 'database-not-ready' };
    }

    const checked = [];
    const updated = [];
    const services = await this.listServices();

    for (const service of services) {
      try {
        let latest = service;
        if (this.isDueForCheck(service)) {
          latest = await this.checkForUpdates(service.serviceId, { actor });
          checked.push(service.serviceId);
        }
        if (latest.autoUpdateEligible) {
          await this.updateService(service.serviceId, { actor, automatic: true });
          updated.push(service.serviceId);
        }
      } catch (error) {
        console.warn(`PlatformManagedServiceManager: ${service.serviceId} policy action failed: ${error.message}`);
      }
    }

    return { checked, updated, skipped: false };
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => {
      this.runPolicyPass().catch((error) => {
        console.warn(`PlatformManagedServiceManager: policy pass failed: ${error.message}`);
      });
    }, this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = new PlatformManagedServiceManager();
module.exports.PlatformManagedServiceManager = PlatformManagedServiceManager;
module.exports.SERVICE_DEFINITIONS = SERVICE_DEFINITIONS;
