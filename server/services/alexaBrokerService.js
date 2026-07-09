const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const AlexaBrokerConfig = require('../models/AlexaBrokerConfig');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const reverseProxyService = require('./reverseProxyService');

const DEFAULT_DISPLAY_NAME = 'HomeBrain Alexa Broker';
const DEFAULT_CLIENT_ID = 'homebrain-alexa-skill';
const DEFAULT_PORT = 4301;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_ALEXA_COMMAND_PROVIDER = 'disabled';
const DEFAULT_ALEXA_COMMAND_TYPE = 'announce';
const DEFAULT_ALEXA_COMMAND_LOCALE = 'en-US';
const DEFAULT_ALEXA_COMMAND_AMAZON_PAGE = 'amazon.com';
const DEFAULT_ALEXA_COMMAND_SERVICE_HOST = 'pitangui.amazon.com';
const DEFAULT_ALEXA_COMMAND_TIMEOUT_MS = 10000;
const DEFAULT_LOG_LIMIT = 500;
const DEFAULT_LIFECYCLE_LIMIT = 50;
const DEFAULT_MONITOR_INTERVAL_MS = 15000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 2;
const DEFAULT_PORT_OCCUPIED_HEALTH_FAILURE_THRESHOLD = 8;
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_TCP_PROBE_TIMEOUT_MS = 1000;
const DEFAULT_RECOVERY_RETRY_DELAY_MS = 5000;
const DEFAULT_STARTUP_STABILITY_MS = 300;
const MANAGED_REVERSE_PROXY_NOTES = 'Managed automatically by the HomeBrain Alexa Broker deployment flow.';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isMaskedSecret(value) {
  const normalized = trimString(value);
  if (!normalized) {
    return false;
  }

  if (/^[*•]+$/.test(normalized)) {
    return true;
  }

  return /^[*•]{4,}[^*•\s]+$/.test(normalized);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((entry) => trimString(entry))
    .filter(Boolean)));
}

function parseListInput(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  return uniqueStrings(String(value || '')
    .split(/[\n,]/g)
    .map((entry) => entry.trim()));
}

function maskSecret(value) {
  const normalized = trimString(value);
  if (!normalized) {
    return '';
  }

  return normalized.replace(/.(?=.{4})/g, '*');
}

function sanitizeBaseUrl(value) {
  const normalized = trimString(value).replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }

  const parsed = new URL(normalized);
  return parsed.origin;
}

function sanitizeUrl(value, fallback = '') {
  const normalized = trimString(value);
  if (!normalized) {
    return fallback;
  }

  return new URL(normalized).toString();
}

function normalizeAlexaCommandProvider(value, fallback = DEFAULT_ALEXA_COMMAND_PROVIDER) {
  const normalized = trimString(value);
  return ['disabled', 'homebrain', 'asp'].includes(normalized) ? normalized : fallback;
}

function normalizeAlexaCommandType(value, fallback = DEFAULT_ALEXA_COMMAND_TYPE) {
  const normalized = trimString(value);
  return ['announce', 'speak', 'ssml'].includes(normalized) ? normalized : fallback;
}

function parseAlexaCommandTargets(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => ({
      key: trimString(entry?.key),
      alexaDeviceId: trimString(entry?.alexaDeviceId || entry?.deviceId || entry?.target),
      displayName: trimString(entry?.displayName || entry?.name),
      room: trimString(entry?.room),
      enabled: entry?.enabled !== false
    })).filter((entry) => entry.key && entry.alexaDeviceId);
  }

  return String(value || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [keyPart, rest = ''] = line.split('=');
      const [devicePart, displayPart = '', roomPart = ''] = rest.split('|');
      return {
        key: trimString(keyPart),
        alexaDeviceId: trimString(devicePart),
        displayName: trimString(displayPart),
        room: trimString(roomPart),
        enabled: true
      };
    })
    .filter((entry) => entry.key && entry.alexaDeviceId);
}

function sanitizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function normalizeHost(value, fallback = DEFAULT_BIND_HOST) {
  const normalized = trimString(value);
  return normalized || fallback;
}

function formatHostForUrl(host) {
  const normalized = trimString(host);
  if (!normalized) {
    return '127.0.0.1';
  }

  if (normalized.includes(':') && !normalized.startsWith('[')) {
    return `[${normalized}]`;
  }

  return normalized;
}

function resolveLocalHealthHost(host) {
  const normalized = trimString(host).toLowerCase();
  if (!normalized || normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {
    return '127.0.0.1';
  }

  return host;
}

function buildLocalBaseUrl(bindHost, port) {
  return `http://${formatHostForUrl(resolveLocalHealthHost(bindHost))}:${sanitizePositiveInteger(port, DEFAULT_PORT, { min: 1, max: 65535 })}`;
}

function buildReverseProxyUpstreamHost(bindHost) {
  const normalized = trimString(bindHost).toLowerCase();

  if (!normalized || normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {
    return '127.0.0.1';
  }

  if (normalized === '::1' || normalized.includes(':')) {
    return 'localhost';
  }

  return normalized;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPositivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0;
}

function waitForChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    child.once('close', finish);
  });
}

function readProcessCommand(pid) {
  if (!isPositivePid(pid) || process.platform === 'win32') {
    return '';
  }

  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch (_error) {
    return '';
  }
}

function commandLooksLikeBrokerRuntime(command, brokerRoot) {
  const normalized = trimString(command);
  if (!normalized) {
    return false;
  }

  const entryScript = path.join(brokerRoot, 'src', 'app.js');
  return normalized.includes(entryScript)
    || (normalized.includes('broker/src/app.js') && /\bnode\b/.test(normalized));
}

function normalizeLifecycleStatus(status) {
  return ['info', 'success', 'warning', 'error'].includes(String(status || '').trim())
    ? String(status).trim()
    : 'info';
}

class AlexaBrokerService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.brokerRoot = options.brokerRoot || path.join(this.projectRoot, 'broker');
    this.spawnProcess = options.spawnProcess || spawn;
    this.netConnect = options.netConnect || net.createConnection;
    this.httpClient = options.httpClient || axios;
    this.configModel = options.configModel || AlexaBrokerConfig;
    this.reverseProxyRouteModel = options.reverseProxyRouteModel || ReverseProxyRoute;
    this.reverseProxyService = options.reverseProxyService || reverseProxyService;
    this.logLimit = options.logLimit || DEFAULT_LOG_LIMIT;
    this.lifecycleLimit = options.lifecycleLimit || DEFAULT_LIFECYCLE_LIMIT;
    this.monitorIntervalMs = options.monitorIntervalMs || DEFAULT_MONITOR_INTERVAL_MS;
    this.healthFailureThreshold = options.healthFailureThreshold || DEFAULT_HEALTH_FAILURE_THRESHOLD;
    this.portOccupiedHealthFailureThreshold = options.portOccupiedHealthFailureThreshold
      || sanitizePositiveInteger(
        process.env.HOMEBRAIN_ALEXA_BROKER_PORT_OCCUPIED_HEALTH_FAILURE_THRESHOLD,
        DEFAULT_PORT_OCCUPIED_HEALTH_FAILURE_THRESHOLD,
        { min: DEFAULT_HEALTH_FAILURE_THRESHOLD, max: 60 }
      );
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs || DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
    this.tcpProbeTimeoutMs = options.tcpProbeTimeoutMs || DEFAULT_TCP_PROBE_TIMEOUT_MS;
    this.recoveryRetryDelayMs = options.recoveryRetryDelayMs || DEFAULT_RECOVERY_RETRY_DELAY_MS;
    this.startupStabilityMs = options.startupStabilityMs ?? DEFAULT_STARTUP_STABILITY_MS;
    this.child = null;
    this.stoppingChildren = new WeakSet();
    this.installProcess = null;
    this.logBuffer = [];
    this.stoppingChild = false;
    this.monitorTimer = null;
    this.recoveryTimer = null;
    this.monitorInFlight = false;
    this.consecutiveHealthFailures = 0;
    this.lastAutoRecoveryAt = 0;
  }

  getDefaultStoreFile() {
    const homeDir = trimString(os.homedir());
    if (homeDir) {
      return path.join(homeDir, '.homebrain', 'alexa-broker', 'store.json');
    }

    return path.join(this.projectRoot, 'server', 'data', 'alexa-broker', 'store.json');
  }

  detectInstalled() {
    const requiredPackages = [
      path.join(this.brokerRoot, 'node_modules', 'axios', 'package.json'),
      path.join(this.brokerRoot, 'node_modules', 'express', 'package.json')
    ];

    return requiredPackages.every((candidate) => fs.existsSync(candidate));
  }

  isChildAlive() {
    return Boolean(this.child && this.child.exitCode == null && !this.child.killed);
  }

  isSpawnedChildAlive(child) {
    return Boolean(child && child.exitCode == null && !child.killed);
  }

  isProcessRunning(pid) {
    if (!isPositivePid(pid)) {
      return false;
    }

    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  isTrackedBrokerProcessAlive(config) {
    const pid = Number(config?.servicePid);
    if (!this.isProcessRunning(pid)) {
      return false;
    }

    const command = readProcessCommand(pid);
    return command ? commandLooksLikeBrokerRuntime(command, this.brokerRoot) : true;
  }

  isManagedRuntimeAlive(config) {
    return this.isChildAlive() || this.isTrackedBrokerProcessAlive(config);
  }

  pushLog(value, prefix = '') {
    const entries = String(value || '')
      .split(/\r?\n/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

    entries.forEach((entry) => {
      const taggedEntry = prefix ? `[${prefix}] ${entry}` : entry;
      this.logBuffer.push(`[${new Date().toISOString()}] ${taggedEntry}`);
      if (this.logBuffer.length > this.logLimit) {
        this.logBuffer.shift();
      }
    });
  }

  appendLifecycleEvent(config, entry = {}) {
    if (!config) {
      return;
    }

    config.lifecycleEvents = [
      ...(Array.isArray(config.lifecycleEvents) ? config.lifecycleEvents : []),
      {
        type: trimString(entry.type) || 'info',
        status: normalizeLifecycleStatus(entry.status),
        message: trimString(entry.message),
        details: entry.details && typeof entry.details === 'object' ? entry.details : {},
        occurredAt: entry.occurredAt || new Date()
      }
    ].slice(-this.lifecycleLimit);
  }

  async recordLifecycleEvent(entry = {}) {
    const config = await this.configModel.getConfig();
    this.appendLifecycleEvent(config, entry);
    await config.save();
    if (trimString(entry.message)) {
      this.pushLog(entry.message, 'broker-service');
    }
    return config;
  }

  shouldAutoRecover(config) {
    if (!config || config.isInstalled !== true) {
      return false;
    }

    if (config.manualStopRequested === true) {
      return false;
    }

    return config.autoStart === true || config.resumeAfterHostRestart === true;
  }

  getAutoRecoveryMode(config) {
    if (config?.manualStopRequested === true) {
      return 'paused_manual_stop';
    }

    if (config?.autoStart === true) {
      return 'keep_running';
    }

    if (config?.resumeAfterHostRestart === true) {
      return 'resume_after_restart';
    }

    return 'disabled';
  }

  startMonitor() {
    if (this.monitorTimer) {
      return;
    }

    this.monitorTimer = setInterval(() => {
      void this.runMonitorPass({ trigger: 'interval' });
    }, this.monitorIntervalMs);

    if (typeof this.monitorTimer.unref === 'function') {
      this.monitorTimer.unref();
    }
  }

  clearRecoveryTimer() {
    if (!this.recoveryTimer) {
      return;
    }

    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  scheduleRecoveryAttempt({ reason = 'broker recovery requested', delayMs = this.recoveryRetryDelayMs } = {}) {
    if (this.recoveryTimer) {
      return;
    }

    const retryDelayMs = Math.max(1000, Number(delayMs || this.recoveryRetryDelayMs) || DEFAULT_RECOVERY_RETRY_DELAY_MS);
    this.pushLog(`Scheduling Alexa broker auto-recovery retry in ${retryDelayMs}ms: ${reason}`, 'broker-service');

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.runMonitorPass({ trigger: 'retry' });
    }, retryDelayMs);

    if (typeof this.recoveryTimer.unref === 'function') {
      this.recoveryTimer.unref();
    }
  }

  async runMonitorPass({ trigger = 'interval' } = {}) {
    if (this.monitorInFlight) {
      return;
    }

    let config = null;
    this.monitorInFlight = true;
    try {
      config = await this.getConfig();

      if (this.installProcess || this.stoppingChild) {
        return;
      }

      const managedAlive = this.isManagedRuntimeAlive(config);
      const probe = await this.probeHealth(config);
      const canAutoRecover = this.shouldAutoRecover(config);

      if (probe.available && managedAlive) {
        this.consecutiveHealthFailures = 0;
        this.clearRecoveryTimer();
        if (config.serviceStatus !== 'running') {
          config.serviceStatus = 'running';
          await config.save();
        }
        return;
      }

      if ((probe.available || probe.portOccupied) && !managedAlive) {
        this.consecutiveHealthFailures = 0;
        this.clearRecoveryTimer();
        if (config.serviceStatus !== 'running_external') {
          config.serviceStatus = 'running_external';
          config.servicePid = null;
          config.serviceOwner = null;
          if (!probe.available) {
            config.lastError = {
              message: probe.message || 'Alexa broker port is occupied but did not answer the broker health check.',
              timestamp: new Date()
            };
          }
          await config.save();
        }
        return;
      }

      if (!canAutoRecover) {
        this.consecutiveHealthFailures = managedAlive ? this.consecutiveHealthFailures + 1 : 0;
        return;
      }

      const now = Date.now();
      if (managedAlive) {
        this.consecutiveHealthFailures += 1;
        const failureThreshold = probe.portOccupied
          ? Math.max(this.healthFailureThreshold, this.portOccupiedHealthFailureThreshold)
          : this.healthFailureThreshold;

        if (probe.portOccupied) {
          this.pushLog(
            `Broker /health probe failed but ${probe.localBaseUrl} is still accepting TCP connections (${this.consecutiveHealthFailures}/${failureThreshold}).`,
            'broker-service'
          );
        }

        if (this.consecutiveHealthFailures < failureThreshold) {
          return;
        }

        if (now - this.lastAutoRecoveryAt < this.monitorIntervalMs) {
          return;
        }

        this.lastAutoRecoveryAt = now;
        await this.restartService({
          actor: 'system:auto-recovery',
          automatic: true,
          source: `watchdog_${trigger}`,
          reason: `Broker health check failed: ${probe.message || 'broker is not responding on /health'}`
        });
        this.consecutiveHealthFailures = 0;
        return;
      }

      this.consecutiveHealthFailures = 0;
      if (now - this.lastAutoRecoveryAt < this.monitorIntervalMs) {
        return;
      }

      this.lastAutoRecoveryAt = now;
      await this.startService({
        actor: 'system:auto-recovery',
        automatic: true,
        quietIfRunning: true,
        source: `watchdog_${trigger}`,
        reason: probe.message || 'Managed Alexa broker is offline'
      });
    } catch (error) {
      this.pushLog(`Broker auto-recovery check failed: ${error.message}`, 'broker-service');
      if (this.shouldAutoRecover(config)) {
        this.scheduleRecoveryAttempt({ reason: error.message || 'auto-recovery check failed' });
      }
    } finally {
      this.monitorInFlight = false;
    }
  }

  async getConfig() {
    const config = await this.configModel.getConfig();
    let updated = false;
    const installed = this.detectInstalled();

    if (config.isInstalled !== installed) {
      config.isInstalled = installed;
      updated = true;
    }

    if (!trimString(config.bindHost)) {
      config.bindHost = DEFAULT_BIND_HOST;
      updated = true;
    }

    if (!config.servicePort) {
      config.servicePort = DEFAULT_PORT;
      updated = true;
    }

    if (!trimString(config.displayName)) {
      config.displayName = DEFAULT_DISPLAY_NAME;
      updated = true;
    }

    if (!trimString(config.oauthClientId)) {
      config.oauthClientId = DEFAULT_CLIENT_ID;
      updated = true;
    }

    const alexaCommandProvider = normalizeAlexaCommandProvider(config.alexaCommandProvider);
    if (config.alexaCommandProvider !== alexaCommandProvider) {
      config.alexaCommandProvider = DEFAULT_ALEXA_COMMAND_PROVIDER;
      updated = true;
    }

    const alexaCommandDefaultType = normalizeAlexaCommandType(config.alexaCommandDefaultType);
    if (config.alexaCommandDefaultType !== alexaCommandDefaultType) {
      config.alexaCommandDefaultType = DEFAULT_ALEXA_COMMAND_TYPE;
      updated = true;
    }

    if (!trimString(config.alexaCommandLocale)) {
      config.alexaCommandLocale = DEFAULT_ALEXA_COMMAND_LOCALE;
      updated = true;
    }

    if (!trimString(config.alexaCommandAmazonPage)) {
      config.alexaCommandAmazonPage = DEFAULT_ALEXA_COMMAND_AMAZON_PAGE;
      updated = true;
    }

    if (!trimString(config.alexaCommandServiceHost)) {
      config.alexaCommandServiceHost = DEFAULT_ALEXA_COMMAND_SERVICE_HOST;
      updated = true;
    }

    if (!config.alexaCommandTimeoutMs) {
      config.alexaCommandTimeoutMs = DEFAULT_ALEXA_COMMAND_TIMEOUT_MS;
      updated = true;
    }

    const allowedClientIds = uniqueStrings(config.allowedClientIds);
    if (allowedClientIds.length === 0) {
      config.allowedClientIds = [trimString(config.oauthClientId) || DEFAULT_CLIENT_ID];
      updated = true;
    } else if (allowedClientIds.length !== config.allowedClientIds.length) {
      config.allowedClientIds = allowedClientIds;
      updated = true;
    }

    if (!trimString(config.storeFile)) {
      config.storeFile = this.getDefaultStoreFile();
      updated = true;
    }

    if (!installed && config.serviceStatus !== 'installing') {
      if (config.serviceStatus !== 'not_installed') {
        config.serviceStatus = 'not_installed';
        updated = true;
      }
    } else if (installed && ['not_installed', 'error'].includes(config.serviceStatus) && !this.isChildAlive()) {
      config.serviceStatus = 'stopped';
      updated = true;
    }

    if (updated) {
      await config.save();
    }

    return config;
  }

  buildRuntimeEnv(config) {
    return {
      ...process.env,
      PORT: String(sanitizePositiveInteger(config.servicePort, DEFAULT_PORT, { min: 1, max: 65535 })),
      HOMEBRAIN_BROKER_BIND_HOST: normalizeHost(config.bindHost),
      HOMEBRAIN_BROKER_PUBLIC_BASE_URL: trimString(config.publicBaseUrl),
      HOMEBRAIN_ALEXA_BROKER_DISPLAY_NAME: trimString(config.displayName) || DEFAULT_DISPLAY_NAME,
      HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID: trimString(config.oauthClientId) || DEFAULT_CLIENT_ID,
      HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET: trimString(config.oauthClientSecret),
      HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS: uniqueStrings(config.allowedClientIds).join(','),
      HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS: uniqueStrings(config.allowedRedirectUris).join(','),
      HOMEBRAIN_ALEXA_EVENT_CLIENT_ID: trimString(config.eventClientId),
      HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET: trimString(config.eventClientSecret),
      HOMEBRAIN_BROKER_STORE_FILE: trimString(config.storeFile),
      HOMEBRAIN_ALEXA_AUTH_CODE_TTL_MS: String(sanitizePositiveInteger(config.authCodeTtlMs, 300000)),
      HOMEBRAIN_ALEXA_ACCESS_TOKEN_TTL_SECONDS: String(sanitizePositiveInteger(config.accessTokenTtlSeconds, 3600)),
      HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS: String(sanitizePositiveInteger(config.refreshTokenTtlSeconds, 15552000)),
      HOMEBRAIN_ALEXA_LWA_TOKEN_URL: sanitizeUrl(config.lwaTokenUrl, 'https://api.amazon.com/auth/o2/token'),
      HOMEBRAIN_ALEXA_EVENT_GATEWAY_URL: sanitizeUrl(config.eventGatewayUrl, 'https://api.amazonalexa.com/v3/events'),
      HOMEBRAIN_ALEXA_COMMAND_PROVIDER: normalizeAlexaCommandProvider(config.alexaCommandProvider),
      HOMEBRAIN_ALEXA_COMMAND_DEFAULT_TYPE: normalizeAlexaCommandType(config.alexaCommandDefaultType),
      HOMEBRAIN_ALEXA_COMMAND_LOCALE: trimString(config.alexaCommandLocale) || DEFAULT_ALEXA_COMMAND_LOCALE,
      HOMEBRAIN_ALEXA_COMMAND_AMAZON_PAGE: trimString(config.alexaCommandAmazonPage) || DEFAULT_ALEXA_COMMAND_AMAZON_PAGE,
      HOMEBRAIN_ALEXA_COMMAND_SERVICE_HOST: trimString(config.alexaCommandServiceHost) || DEFAULT_ALEXA_COMMAND_SERVICE_HOST,
      HOMEBRAIN_ALEXA_COMMAND_SESSION_COOKIE: trimString(config.alexaCommandSessionCookie),
      HOMEBRAIN_ALEXA_COMMAND_SESSION_DATA: trimString(config.alexaCommandSessionData),
      HOMEBRAIN_ALEXA_COMMAND_TARGETS_JSON: JSON.stringify(parseAlexaCommandTargets(config.alexaCommandTargets)),
      HOMEBRAIN_ALEXA_COMMAND_TIMEOUT_MS: String(sanitizePositiveInteger(
        config.alexaCommandTimeoutMs,
        DEFAULT_ALEXA_COMMAND_TIMEOUT_MS,
        { min: 1000, max: 60000 }
      )),
      HOMEBRAIN_ALEXA_RATE_LIMIT_WINDOW_MS: String(sanitizePositiveInteger(config.rateLimitWindowMs, 60000)),
      HOMEBRAIN_ALEXA_RATE_LIMIT_MAX: String(sanitizePositiveInteger(config.rateLimitMax, 120)),
      HOMEBRAIN_ALEXA_ALLOW_MANUAL_REGISTRATION: config.allowManualRegistration === true ? 'true' : 'false'
    };
  }

  async probeHealth(config) {
    const localBaseUrl = buildLocalBaseUrl(config.bindHost, config.servicePort);

    try {
      const response = await this.httpClient.get(`${localBaseUrl}/health`, {
        timeout: this.healthProbeTimeoutMs
      });
      return {
        available: true,
        portOccupied: true,
        localBaseUrl,
        health: response.data || null,
        message: ''
      };
    } catch (error) {
      const portProbe = await this.probeTcpPort(config);
      return {
        available: false,
        portOccupied: portProbe.occupied,
        localBaseUrl,
        health: null,
        message: [
          error?.message || 'Broker health check failed',
          portProbe.occupied ? 'TCP port is already in use.' : ''
        ].filter(Boolean).join(' ')
      };
    }
  }

  async probeTcpPort(config, timeoutMs = this.tcpProbeTimeoutMs) {
    const host = resolveLocalHealthHost(config.bindHost);
    const port = sanitizePositiveInteger(config.servicePort, DEFAULT_PORT, { min: 1, max: 65535 });

    return new Promise((resolve) => {
      let socket;
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          socket?.destroy?.();
        } catch (_error) {
          // noop
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ occupied: false, message: 'TCP probe timed out' });
      }, timeoutMs);

      try {
        socket = this.netConnect({ host, port });
      } catch (error) {
        finish({ occupied: false, message: error?.message || 'TCP probe failed' });
        return;
      }

      socket.once?.('connect', () => {
        finish({ occupied: true, message: '' });
      });

      socket.once?.('error', (error) => {
        finish({ occupied: false, message: error?.message || 'TCP probe failed' });
      });

      socket.once?.('timeout', () => {
        finish({ occupied: false, message: 'TCP probe timed out' });
      });
      socket.setTimeout?.(timeoutMs);
    });
  }

  attachProcessListeners(child) {
    child.stdout?.on('data', (chunk) => {
      this.pushLog(chunk.toString(), 'broker');
    });

    child.stderr?.on('data', (chunk) => {
      this.pushLog(chunk.toString(), 'broker');
    });

    child.on('error', async (error) => {
      this.pushLog(error.message || String(error), 'broker-error');
      if (this.child === child) {
        this.child = null;
      }

      const config = await this.configModel.getConfig();
      config.serviceStatus = 'error';
      config.servicePid = null;
      config.serviceOwner = null;
      config.lastError = {
        message: error.message || 'Alexa broker process failed to launch',
        timestamp: new Date()
      };
      const automaticRecoveryEligible = this.shouldAutoRecover(config);
      this.appendLifecycleEvent(config, {
        type: 'process_error',
        status: 'error',
        message: error.message || 'Alexa broker process failed to launch',
        details: {
          automaticRecoveryEligible
        }
      });
      await config.save();
      if (automaticRecoveryEligible) {
        this.scheduleRecoveryAttempt({ reason: error.message || 'Alexa broker process failed to launch' });
      }
    });

    child.on('exit', async (code, signal) => {
      const exitedDuringStop = this.stoppingChildren.has(child)
        || (this.child === child && this.stoppingChild === true);
      const exitSummary = `Broker process exited with code ${code}${signal ? ` (${signal})` : ''}`;
      this.pushLog(exitSummary, 'broker');

      this.stoppingChildren.delete(child);

      if (this.child === child) {
        this.child = null;
        this.stoppingChild = false;
      }

      const config = await this.configModel.getConfig();
      config.servicePid = null;
      config.serviceOwner = null;

      if (exitedDuringStop) {
        config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
        config.lastStoppedAt = new Date();
      } else if (config.serviceStatus !== 'starting') {
        const automaticRecoveryEligible = this.shouldAutoRecover(config);
        config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
        config.lastError = {
          message: `Alexa broker exited unexpectedly with code ${code}${signal ? ` (${signal})` : ''}`,
          timestamp: new Date()
        };
        this.appendLifecycleEvent(config, {
          type: 'unexpected_exit',
          status: automaticRecoveryEligible ? 'warning' : 'error',
          message: automaticRecoveryEligible
            ? `Alexa broker exited unexpectedly (${code}${signal ? ` / ${signal}` : ''}). HomeBrain will try to start it again automatically.`
            : `Alexa broker exited unexpectedly (${code}${signal ? ` / ${signal}` : ''}). Automatic recovery is currently disabled.`,
          details: {
            code,
            signal,
            automaticRecoveryEligible
          }
        });
      }

      await config.save();

      if (!exitedDuringStop) {
        if (this.shouldAutoRecover(config)) {
          this.scheduleRecoveryAttempt({ reason: exitSummary });
        }
        void this.runMonitorPass({ trigger: 'process_exit' });
      }
    });
  }

  async waitForHealthyBroker(config, timeoutMs = 10000, child = this.child) {
    const startedAt = Date.now();
    let lastMessage = 'Broker health check timed out';

    while (Date.now() - startedAt < timeoutMs) {
      if (!this.isSpawnedChildAlive(child)) {
        throw new Error('Alexa broker stopped before it became healthy');
      }

      const probe = await this.probeHealth(config);
      if (probe.available) {
        const stabilityDelay = Math.max(0, Number(this.startupStabilityMs) || 0);
        if (stabilityDelay > 0) {
          await wait(stabilityDelay);
        }
        if (!this.isSpawnedChildAlive(child)) {
          throw new Error('Alexa broker stopped before its startup health could be confirmed');
        }
        return probe;
      }

      lastMessage = probe.message || lastMessage;
      await wait(500);
    }

    throw new Error(lastMessage);
  }

  getDesiredPublicHostname(config, options = {}) {
    const publicBaseUrl = trimString(config?.publicBaseUrl);
    if (!publicBaseUrl) {
      if (options.required) {
        throw new Error('Set the public broker base URL before deploying the Alexa broker.');
      }
      return '';
    }

    try {
      return new URL(publicBaseUrl).hostname.toLowerCase();
    } catch (_error) {
      if (options.required) {
        throw new Error('The public broker base URL must be a valid URL before deploying the Alexa broker.');
      }
      return '';
    }
  }

  buildManagedReverseProxyRoutePayload(config) {
    const hostname = this.getDesiredPublicHostname(config, { required: true });

    return {
      hostname,
      platformKey: 'alexa-broker',
      displayName: trimString(config.displayName) || DEFAULT_DISPLAY_NAME,
      upstreamProtocol: 'http',
      upstreamHost: buildReverseProxyUpstreamHost(config.bindHost),
      upstreamPort: sanitizePositiveInteger(config.servicePort, DEFAULT_PORT, { min: 1, max: 65535 }),
      enabled: true,
      tlsMode: 'automatic',
      allowOnDemandTls: false,
      healthCheckPath: '/health',
      websocketSupport: false,
      notes: MANAGED_REVERSE_PROXY_NOTES
    };
  }

  async findManagedReverseProxyRoute(config, desiredHostname = this.getDesiredPublicHostname(config)) {
    let route = null;

    if (config?.reverseProxyRouteId) {
      route = await this.reverseProxyRouteModel.findById(config.reverseProxyRouteId);
    }

    if (!route && desiredHostname) {
      route = await this.reverseProxyRouteModel.findOne({ hostname: desiredHostname });
    }

    if (route && String(config?.reverseProxyRouteId || '') !== String(route._id)) {
      config.reverseProxyRouteId = route._id;
      await config.save();
    }

    return route;
  }

  buildReverseProxyStatus(config, route) {
    const expectedHostname = this.getDesiredPublicHostname(config);
    const expectedUpstreamHost = buildReverseProxyUpstreamHost(config.bindHost);
    const expectedUpstreamPort = sanitizePositiveInteger(config.servicePort, DEFAULT_PORT, { min: 1, max: 65535 });
    const matchesConfig = Boolean(
      route
      && (!expectedHostname || route.hostname === expectedHostname)
      && route.upstreamProtocol === 'http'
      && route.upstreamHost === expectedUpstreamHost
      && route.upstreamPort === expectedUpstreamPort
      && route.healthCheckPath === '/health'
      && route.websocketSupport === false
      && route.enabled === true
    );

    return {
      routeId: route?._id ? String(route._id) : null,
      routeExists: Boolean(route),
      expectedHostname: expectedHostname || null,
      hostname: route?.hostname || expectedHostname || null,
      enabled: Boolean(route?.enabled),
      tlsMode: route?.tlsMode || 'automatic',
      validationStatus: route?.validationStatus || 'unknown',
      lastApplyStatus: route?.lastApplyStatus || 'never',
      upstreamHost: route?.upstreamHost || expectedUpstreamHost,
      upstreamPort: route?.upstreamPort || expectedUpstreamPort,
      healthCheckPath: route?.healthCheckPath || '/health',
      matchesConfig
    };
  }

  async ensureManagedReverseProxyRoute(options = {}) {
    const actor = trimString(options.actor) || 'system';
    const applyConfig = options.applyConfig === true;
    const config = await this.getConfig();
    const routePayload = this.buildManagedReverseProxyRoutePayload(config);
    const existingRoute = await this.findManagedReverseProxyRoute(config, routePayload.hostname);

    const route = existingRoute
      ? await this.reverseProxyService.updateRoute(existingRoute._id, routePayload, actor)
      : await this.reverseProxyService.createRoute(routePayload, actor);

    if (String(config.reverseProxyRouteId || '') !== String(route._id)) {
      config.reverseProxyRouteId = route._id;
      await config.save();
    }

    let applyResult = null;
    if (applyConfig) {
      applyResult = await this.reverseProxyService.applyConfig(actor);
    }

    return {
      success: true,
      action: existingRoute ? 'updated' : 'created',
      route,
      appliedConfig: Boolean(applyResult),
      applyResult
    };
  }

  async prepareForHostRestart() {
    const config = await this.getConfig();
    const shouldResume = this.isManagedRuntimeAlive(config);

    if (config.resumeAfterHostRestart !== shouldResume) {
      config.resumeAfterHostRestart = shouldResume;
      await config.save();
    }

    return {
      success: true,
      shouldResume
    };
  }

  async initialize() {
    this.startMonitor();
    const config = await this.getConfig();
    const shouldAutoStart = this.shouldAutoRecover(config);
    if (!shouldAutoStart) {
      return;
    }

    try {
      await this.startService({
        quietIfRunning: true,
        automatic: true,
        actor: 'system:start',
        source: config.resumeAfterHostRestart ? 'host_restart_resume' : 'auto_start'
      });
    } catch (error) {
      const freshConfig = await this.configModel.getConfig();
      freshConfig.serviceStatus = 'error';
      freshConfig.lastError = {
        message: error.message || 'Failed to auto-start Alexa broker',
        timestamp: new Date()
      };
      await freshConfig.save();
      this.pushLog(error.message || String(error), 'broker-error');
    }
  }

  async updateConfig(updates = {}) {
    const config = await this.getConfig();
    const runtimeFields = new Set([
      'servicePort',
      'bindHost',
      'publicBaseUrl',
      'displayName',
      'oauthClientId',
      'oauthClientSecret',
      'allowedClientIds',
      'allowedRedirectUris',
      'eventClientId',
      'eventClientSecret',
      'storeFile',
      'authCodeTtlMs',
      'accessTokenTtlSeconds',
      'refreshTokenTtlSeconds',
      'lwaTokenUrl',
      'eventGatewayUrl',
      'alexaCommandProvider',
      'alexaCommandDefaultType',
      'alexaCommandLocale',
      'alexaCommandAmazonPage',
      'alexaCommandServiceHost',
      'alexaCommandSessionCookie',
      'alexaCommandSessionData',
      'alexaCommandTargets',
      'alexaCommandTimeoutMs',
      'rateLimitWindowMs',
      'rateLimitMax',
      'allowManualRegistration'
    ]);
    const providedKeys = Object.keys(updates || {});
    const requiresRestart = this.isChildAlive() && providedKeys.some((key) => runtimeFields.has(key));

    if (Object.prototype.hasOwnProperty.call(updates, 'servicePort')) {
      config.servicePort = sanitizePositiveInteger(updates.servicePort, config.servicePort || DEFAULT_PORT, {
        min: 1,
        max: 65535
      });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'bindHost')) {
      config.bindHost = normalizeHost(updates.bindHost, config.bindHost || DEFAULT_BIND_HOST);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'publicBaseUrl')) {
      config.publicBaseUrl = trimString(updates.publicBaseUrl)
        ? sanitizeBaseUrl(updates.publicBaseUrl)
        : '';
      if (!config.publicBaseUrl) {
        config.reverseProxyRouteId = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'displayName')) {
      config.displayName = trimString(updates.displayName) || DEFAULT_DISPLAY_NAME;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'oauthClientId')) {
      config.oauthClientId = trimString(updates.oauthClientId) || DEFAULT_CLIENT_ID;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'oauthClientSecret')) {
      const value = updates.oauthClientSecret;
      if (!isMaskedSecret(value) && trimString(value)) {
        config.oauthClientSecret = trimString(value);
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'allowedClientIds')) {
      const values = parseListInput(updates.allowedClientIds);
      config.allowedClientIds = values.length > 0 ? values : [config.oauthClientId || DEFAULT_CLIENT_ID];
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'allowedRedirectUris')) {
      config.allowedRedirectUris = parseListInput(updates.allowedRedirectUris);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'eventClientId')) {
      config.eventClientId = trimString(updates.eventClientId);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'eventClientSecret')) {
      const value = updates.eventClientSecret;
      if (!isMaskedSecret(value) && trimString(value)) {
        config.eventClientSecret = trimString(value);
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandProvider')) {
      config.alexaCommandProvider = normalizeAlexaCommandProvider(updates.alexaCommandProvider);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandDefaultType')) {
      config.alexaCommandDefaultType = normalizeAlexaCommandType(updates.alexaCommandDefaultType);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandLocale')) {
      config.alexaCommandLocale = trimString(updates.alexaCommandLocale) || DEFAULT_ALEXA_COMMAND_LOCALE;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandAmazonPage')) {
      config.alexaCommandAmazonPage = trimString(updates.alexaCommandAmazonPage) || DEFAULT_ALEXA_COMMAND_AMAZON_PAGE;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandServiceHost')) {
      config.alexaCommandServiceHost = trimString(updates.alexaCommandServiceHost) || DEFAULT_ALEXA_COMMAND_SERVICE_HOST;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandSessionCookie')) {
      const value = updates.alexaCommandSessionCookie;
      if (!isMaskedSecret(value) && trimString(value)) {
        config.alexaCommandSessionCookie = trimString(value);
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandSessionData')) {
      const value = updates.alexaCommandSessionData;
      if (!isMaskedSecret(value) && trimString(value)) {
        config.alexaCommandSessionData = trimString(value);
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandTargets')) {
      config.alexaCommandTargets = parseAlexaCommandTargets(updates.alexaCommandTargets);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'alexaCommandTimeoutMs')) {
      config.alexaCommandTimeoutMs = sanitizePositiveInteger(
        updates.alexaCommandTimeoutMs,
        config.alexaCommandTimeoutMs || DEFAULT_ALEXA_COMMAND_TIMEOUT_MS,
        { min: 1000, max: 60000 }
      );
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'storeFile')) {
      config.storeFile = trimString(updates.storeFile) || this.getDefaultStoreFile();
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'authCodeTtlMs')) {
      config.authCodeTtlMs = sanitizePositiveInteger(updates.authCodeTtlMs, config.authCodeTtlMs || 300000, { min: 60000 });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'accessTokenTtlSeconds')) {
      config.accessTokenTtlSeconds = sanitizePositiveInteger(updates.accessTokenTtlSeconds, config.accessTokenTtlSeconds || 3600, { min: 300 });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'refreshTokenTtlSeconds')) {
      config.refreshTokenTtlSeconds = sanitizePositiveInteger(updates.refreshTokenTtlSeconds, config.refreshTokenTtlSeconds || 15552000, { min: 3600 });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'lwaTokenUrl')) {
      config.lwaTokenUrl = sanitizeUrl(updates.lwaTokenUrl, config.lwaTokenUrl || 'https://api.amazon.com/auth/o2/token');
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'eventGatewayUrl')) {
      config.eventGatewayUrl = sanitizeUrl(updates.eventGatewayUrl, config.eventGatewayUrl || 'https://api.amazonalexa.com/v3/events');
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'rateLimitWindowMs')) {
      config.rateLimitWindowMs = sanitizePositiveInteger(updates.rateLimitWindowMs, config.rateLimitWindowMs || 60000, { min: 1000 });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'rateLimitMax')) {
      config.rateLimitMax = sanitizePositiveInteger(updates.rateLimitMax, config.rateLimitMax || 120, { min: 1 });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'allowManualRegistration')) {
      config.allowManualRegistration = updates.allowManualRegistration === true;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'autoStart')) {
      config.autoStart = updates.autoStart !== false;
    }

    await config.save();

    return {
      success: true,
      restartRequired: requiresRestart,
      status: await this.getStatus()
    };
  }

  async install() {
    const config = await this.getConfig();

    if (this.installProcess) {
      return {
        success: true,
        message: 'Alexa broker install is already running',
        status: await this.getStatus()
      };
    }

    config.serviceStatus = 'installing';
    config.lastError = null;
    await config.save();
    const hasLockfile = fs.existsSync(path.join(this.brokerRoot, 'package-lock.json'));
    const installArgs = hasLockfile
      ? ['ci', '--no-audit', '--no-fund']
      : ['install', '--no-audit', '--no-fund'];
    this.pushLog(`Installing Alexa broker dependencies with npm ${installArgs[0]}`, 'install');

    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, installArgs, {
        cwd: this.brokerRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.installProcess = child;

      child.stdout?.on('data', (chunk) => {
        this.pushLog(chunk.toString(), 'install');
      });

      child.stderr?.on('data', (chunk) => {
        this.pushLog(chunk.toString(), 'install');
      });

      child.on('error', async (error) => {
        this.installProcess = null;
        const freshConfig = await this.configModel.getConfig();
        freshConfig.serviceStatus = 'error';
        freshConfig.lastError = {
          message: error.message || 'Alexa broker install failed to start',
          timestamp: new Date()
        };
        await freshConfig.save();
        reject(new Error(error.message || 'Alexa broker install failed to start'));
      });

      child.on('close', async (code, signal) => {
        this.installProcess = null;
        const freshConfig = await this.configModel.getConfig();
        freshConfig.isInstalled = this.detectInstalled();

        if (code === 0 && freshConfig.isInstalled) {
          freshConfig.serviceStatus = 'stopped';
          freshConfig.lastError = null;
          await freshConfig.save();
          resolve({
            success: true,
            message: 'Alexa broker dependencies installed successfully',
            status: await this.getStatus()
          });
          return;
        }

        const errorMessage = `Alexa broker install exited with code ${code}${signal ? ` (${signal})` : ''}`;
        freshConfig.serviceStatus = 'error';
        freshConfig.lastError = {
          message: errorMessage,
          timestamp: new Date()
        };
        await freshConfig.save();
        reject(new Error(errorMessage));
      });
    });
  }

  async deployService(options = {}) {
    const actor = trimString(options.actor) || 'system';
    const installDependencies = options.installDependencies !== false;
    const config = await this.getConfig();

    if (this.installProcess) {
      throw new Error('Alexa broker install is already running. Wait for it to finish before deploying.');
    }

    this.getDesiredPublicHostname(config, { required: true });

    let installResult = null;
    if (installDependencies || !config.isInstalled) {
      installResult = await this.install();
    }

    const serviceResult = this.isManagedRuntimeAlive(config)
      ? await this.restartService({
        actor,
        source: 'deploy',
        reason: 'deploy broker request'
      })
      : await this.startService({
        actor,
        source: 'deploy',
        reason: 'deploy broker request'
      });

    const reverseProxyResult = await this.ensureManagedReverseProxyRoute({
      actor,
      applyConfig: true
    });

    return {
      success: true,
      message: 'Alexa broker deployed, reverse proxy applied, and broker runtime refreshed.',
      installResult,
      reverseProxy: reverseProxyResult,
      status: serviceResult.status || await this.getStatus()
    };
  }

  async startService(options = {}) {
    const config = await this.getConfig();
    const actor = trimString(options.actor) || 'system';
    const automatic = options.automatic === true;
    const source = trimString(options.source) || (automatic ? 'automatic' : 'manual');
    const startReason = trimString(options.reason);

    if (!config.isInstalled) {
      throw new Error('Alexa broker dependencies are not installed yet. Run Install first.');
    }

    if (this.installProcess) {
      throw new Error('Alexa broker install is still running. Wait for it to finish before starting the service.');
    }

    if (this.isManagedRuntimeAlive(config)) {
      if (config.lastError) {
        config.lastError = null;
      }
      config.serviceStatus = 'running';
      if (this.isChildAlive()) {
        config.servicePid = this.child?.pid || config.servicePid || null;
        config.serviceOwner = os.userInfo().username;
      }
      config.manualStopRequested = false;
      await config.save();
      return {
        success: true,
        message: 'Alexa broker is already running',
        status: await this.getStatus()
      };
    }

    const existingProbe = await this.probeHealth(config);
    if (existingProbe.available || existingProbe.portOccupied) {
      config.serviceStatus = 'running_external';
      config.servicePid = null;
      config.serviceOwner = null;
      config.resumeAfterHostRestart = false;
      config.manualStopRequested = false;
      config.lastError = existingProbe.available
        ? null
        : {
          message: existingProbe.message || 'Alexa broker port is already in use but /health is not responding.',
          timestamp: new Date()
        };
      this.appendLifecycleEvent(config, {
        type: existingProbe.available ? 'running_external' : 'port_occupied',
        status: 'warning',
        message: existingProbe.available
          ? 'HomeBrain detected an Alexa broker that is already running outside the managed service on the configured port.'
          : 'HomeBrain detected another process already occupying the configured Alexa broker port.',
        details: {
          actor,
          automatic,
          source,
          healthMessage: existingProbe.message || ''
        }
      });
      await config.save();
      this.clearRecoveryTimer();
      return {
        success: true,
        message: options.quietIfRunning
          ? 'Alexa broker is already running'
          : existingProbe.available
            ? 'Alexa broker is already running outside HomeBrain on the configured port'
            : 'Alexa broker port is already in use, but the broker health check is not responding',
        externallyManaged: true,
        status: await this.getStatus()
      };
    }

    config.serviceStatus = 'starting';
    config.servicePid = null;
    config.serviceOwner = null;
    config.manualStopRequested = false;
    config.lastError = null;
    await config.save();

    const entryScript = path.join(this.brokerRoot, 'src', 'app.js');
    const child = this.spawnProcess(process.execPath, [entryScript], {
      cwd: this.brokerRoot,
      env: this.buildRuntimeEnv(config),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.child = child;
    this.stoppingChild = false;
    this.attachProcessListeners(child);

    this.pushLog(
      `Starting Alexa broker on ${normalizeHost(config.bindHost)}:${config.servicePort} (${trimString(config.publicBaseUrl) || 'no public base URL configured'})`,
      'broker'
    );

    try {
      const probe = await this.waitForHealthyBroker(config, 10000, child);
      config.serviceStatus = 'running';
      config.servicePid = child.pid || null;
      config.serviceOwner = os.userInfo().username;
      config.resumeAfterHostRestart = false;
      config.manualStopRequested = false;
      config.lastStartedAt = new Date();
      config.lastError = null;
      this.appendLifecycleEvent(config, {
        type: automatic ? 'auto_started' : 'started',
        status: 'success',
        message: automatic
          ? `Alexa broker started automatically${startReason ? ` after ${startReason}` : ''}.`
          : 'Alexa broker started successfully.',
        details: {
          actor,
          automatic,
          source,
          reason: startReason || null,
          pid: child.pid || null
        }
      });
      await config.save();
      this.consecutiveHealthFailures = 0;
      this.clearRecoveryTimer();

      return {
        success: true,
        message: 'Alexa broker started successfully',
        health: probe.health,
        status: await this.getStatus()
      };
    } catch (error) {
      this.stoppingChild = true;
      if (this.child === child && child.exitCode == null && !child.killed) {
        this.stoppingChildren.add(child);
        child.kill('SIGTERM');
        await waitForChildExit(child, 5000);
      }
      if (this.child === child) {
        this.child = null;
      }
      this.stoppingChild = false;

      config.serviceStatus = 'error';
      config.servicePid = null;
      config.serviceOwner = null;
      config.lastError = {
        message: error.message || 'Alexa broker failed to become healthy',
        timestamp: new Date()
      };
      this.appendLifecycleEvent(config, {
        type: automatic ? 'auto_start_failed' : 'start_failed',
        status: 'error',
        message: automatic
          ? `Alexa broker automatic start failed${startReason ? ` after ${startReason}` : ''}: ${error.message || 'broker failed to become healthy'}.`
          : `Alexa broker failed to start: ${error.message || 'broker failed to become healthy'}.`,
        details: {
          actor,
          automatic,
          source,
          reason: startReason || null
        }
      });
      await config.save();
      if (this.shouldAutoRecover(config)) {
        this.scheduleRecoveryAttempt({ reason: error.message || 'broker failed to become healthy' });
      }
      throw error;
    }
  }

  async stopTrackedBrokerProcess(pid) {
    if (!isPositivePid(pid) || !this.isProcessRunning(pid)) {
      return;
    }

    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
      return;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      if (!this.isProcessRunning(pid)) {
        return;
      }
      await wait(200);
    }

    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
      return;
    }

    const killStartedAt = Date.now();
    while (Date.now() - killStartedAt < 3000) {
      if (!this.isProcessRunning(pid)) {
        return;
      }
      await wait(200);
    }

    throw new Error(`Alexa broker process ${pid} did not stop after SIGKILL.`);
  }

  async stopService(options = {}) {
    const config = await this.getConfig();
    const preserveResumeAfterHostRestart = options.preserveResumeAfterHostRestart === true;
    const actor = trimString(options.actor) || 'system';
    const manualStop = options.manual !== false;
    const source = trimString(options.source) || (manualStop ? 'manual' : 'internal');
    const stopReason = trimString(options.reason);

    const trackedPid = !this.isChildAlive() && this.isTrackedBrokerProcessAlive(config)
      ? Number(config.servicePid)
      : null;

    if (!this.isChildAlive() && !trackedPid) {
      const probe = await this.probeHealth(config);
      if (probe.available || probe.portOccupied) {
        config.serviceStatus = 'running_external';
        config.manualStopRequested = manualStop;
        if (!probe.available) {
          config.lastError = {
            message: probe.message || 'Alexa broker port is occupied but did not answer the broker health check.',
            timestamp: new Date()
          };
        }
        if (!preserveResumeAfterHostRestart) {
          config.resumeAfterHostRestart = false;
        }
        this.appendLifecycleEvent(config, {
          type: manualStop ? 'manual_stop_blocked_external' : 'stop_blocked_external',
          status: 'warning',
          message: 'HomeBrain could not stop the Alexa broker because another process is already managing the configured port.',
          details: {
            actor,
            source,
            reason: stopReason || null
          }
        });
        await config.save();
        throw new Error('Alexa broker is being managed outside HomeBrain. Stop that process manually or change the configured port.');
      }

      config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
      config.servicePid = null;
      config.serviceOwner = null;
      config.manualStopRequested = manualStop;
      if (!preserveResumeAfterHostRestart) {
        config.resumeAfterHostRestart = false;
      }
      config.lastStoppedAt = new Date();
      if (manualStop) {
        this.appendLifecycleEvent(config, {
          type: 'manual_stop',
          status: 'info',
          message: 'Alexa broker was already stopped. Automatic recovery is paused until it is started again.',
          details: {
            actor,
            source,
            reason: stopReason || null
          }
        });
      }
      await config.save();
      return {
        success: true,
        message: 'Alexa broker is already stopped',
        status: await this.getStatus()
      };
    }

    if (trackedPid) {
      this.stoppingChild = true;
      this.pushLog(`Stopping tracked Alexa broker process ${trackedPid}`, 'broker');
      try {
        await this.stopTrackedBrokerProcess(trackedPid);
      } catch (error) {
        this.stoppingChild = false;
        throw error;
      }

      config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
      config.servicePid = null;
      config.serviceOwner = null;
      config.manualStopRequested = manualStop;
      if (!preserveResumeAfterHostRestart) {
        config.resumeAfterHostRestart = false;
      }
      config.lastStoppedAt = new Date();
      this.appendLifecycleEvent(config, {
        type: manualStop ? 'manual_stop' : 'stopped',
        status: 'info',
        message: manualStop
          ? 'Alexa broker was stopped manually. Automatic recovery is paused until it is started again.'
          : `Alexa broker stopped${stopReason ? `: ${stopReason}` : '.'}`,
        details: {
          actor,
          source,
          reason: stopReason || null,
          pid: trackedPid
        }
      });
      await config.save();

      this.stoppingChild = false;
      this.consecutiveHealthFailures = 0;

      return {
        success: true,
        message: 'Alexa broker stopped successfully',
        status: await this.getStatus()
      };
    }

    const child = this.child;
    this.stoppingChild = true;
    this.stoppingChildren.add(child);
    this.pushLog('Stopping Alexa broker service', 'broker');

    child.kill('SIGTERM');
    await waitForChildExit(child, 5000);

    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 3000);
    }

    config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
    config.servicePid = null;
    config.serviceOwner = null;
    config.manualStopRequested = manualStop;
    if (!preserveResumeAfterHostRestart) {
      config.resumeAfterHostRestart = false;
    }
    config.lastStoppedAt = new Date();
    this.appendLifecycleEvent(config, {
      type: manualStop ? 'manual_stop' : 'stopped',
      status: 'info',
      message: manualStop
        ? 'Alexa broker was stopped manually. Automatic recovery is paused until it is started again.'
        : `Alexa broker stopped${stopReason ? `: ${stopReason}` : '.'}`,
      details: {
        actor,
        source,
        reason: stopReason || null
      }
    });
    await config.save();

    this.child = null;
    this.stoppingChild = false;
    this.consecutiveHealthFailures = 0;

    return {
      success: true,
      message: 'Alexa broker stopped successfully',
      status: await this.getStatus()
    };
  }

  async restartService(options = {}) {
    const actor = trimString(options.actor) || 'system';
    const automatic = options.automatic === true;
    const source = trimString(options.source) || (automatic ? 'automatic_restart' : 'manual_restart');
    const restartReason = trimString(options.reason);

    try {
      await this.stopService({
        preserveResumeAfterHostRestart: true,
        actor,
        manual: false,
        source: `${source}_stop`,
        reason: restartReason || 'restart requested'
      });
    } catch (error) {
      if (!String(error.message || '').includes('already stopped')) {
        throw error;
      }
    }

    return this.startService({
      actor,
      automatic,
      source,
      reason: restartReason || 'restart requested'
    });
  }

  buildStatusReason(config, effectiveStatus, probe, serviceRunning) {
    const lifecycleEvents = Array.isArray(config?.lifecycleEvents) ? config.lifecycleEvents : [];
    const latestEvent = lifecycleEvents.length > 0 ? lifecycleEvents[lifecycleEvents.length - 1] : null;

    if (effectiveStatus === 'running_external') {
      if (probe?.portOccupied && !probe?.available) {
        return {
          level: 'warning',
          source: 'port_occupied',
          message: `The configured Alexa broker port is already in use, but /health is not responding. Last health check: ${probe.message || 'unavailable'}`,
          timestamp: latestEvent?.occurredAt || null
        };
      }

      return {
        level: 'warning',
        source: 'running_external',
        message: 'Another process is already serving the configured Alexa broker port, so HomeBrain is leaving the managed broker stopped.',
        timestamp: latestEvent?.occurredAt || null
      };
    }

    if (serviceRunning) {
      return null;
    }

    if (!config?.isInstalled) {
      return {
        level: 'info',
        source: 'not_installed',
        message: 'Alexa broker dependencies are not installed yet.',
        timestamp: null
      };
    }

    if (config?.manualStopRequested === true && effectiveStatus === 'stopped') {
      return {
        level: 'info',
        source: 'manual_stop',
        message: 'Alexa broker was stopped manually. Automatic recovery is paused until it is started again.',
        timestamp: config?.lastStoppedAt || latestEvent?.occurredAt || null
      };
    }

    if (effectiveStatus === 'starting' || effectiveStatus === 'installing') {
      return {
        level: 'info',
        source: effectiveStatus,
        message: effectiveStatus === 'installing'
          ? 'Alexa broker dependencies are being installed.'
          : 'Alexa broker is starting.',
        timestamp: latestEvent?.occurredAt || null
      };
    }

    if (config?.lastError?.message) {
      return {
        level: 'error',
        source: 'last_error',
        message: config.lastError.message,
        timestamp: config.lastError.timestamp || latestEvent?.occurredAt || null
      };
    }

    if (trimString(probe?.message) && effectiveStatus === 'stopped' && this.shouldAutoRecover(config)) {
      return {
        level: 'warning',
        source: 'health_probe',
        message: `Alexa broker is offline. HomeBrain will keep trying to start it automatically. Last health check: ${probe.message}`,
        timestamp: latestEvent?.occurredAt || null
      };
    }

    if (latestEvent?.message) {
      return {
        level: normalizeLifecycleStatus(latestEvent.status),
        source: latestEvent.type || 'lifecycle',
        message: latestEvent.message,
        timestamp: latestEvent.occurredAt || null
      };
    }

    return null;
  }

  async getStatus() {
    const config = await this.getConfig();
    const [probe, reverseProxyRoute] = await Promise.all([
      this.probeHealth(config),
      this.findManagedReverseProxyRoute(config)
    ]);
    const childAlive = this.isChildAlive();
    const trackedProcessAlive = !childAlive && this.isTrackedBrokerProcessAlive(config);
    const managedRuntimeAlive = childAlive || trackedProcessAlive;
    let effectiveStatus = config.serviceStatus;
    let serviceRunning = false;

    if (!config.isInstalled && config.serviceStatus !== 'installing') {
      effectiveStatus = 'not_installed';
    } else if (probe.available && managedRuntimeAlive) {
      effectiveStatus = 'running';
      serviceRunning = true;
    } else if (probe.available && !managedRuntimeAlive) {
      effectiveStatus = 'running_external';
      serviceRunning = true;
    } else if (probe.portOccupied && !managedRuntimeAlive) {
      effectiveStatus = 'running_external';
    } else if (config.serviceStatus === 'starting' || config.serviceStatus === 'installing') {
      effectiveStatus = config.serviceStatus;
    } else if (config.isInstalled) {
      effectiveStatus = 'stopped';
    } else {
      effectiveStatus = 'not_installed';
    }

    if (effectiveStatus !== config.serviceStatus) {
      config.serviceStatus = effectiveStatus;
      if (childAlive) {
        config.servicePid = this.child?.pid || config.servicePid || null;
        config.serviceOwner = os.userInfo().username;
      } else if (!trackedProcessAlive) {
        config.servicePid = null;
        config.serviceOwner = null;
      }
      await config.save();
    }

    if (serviceRunning && config.lastError) {
      config.lastError = null;
      await config.save();
    }

    const sanitized = config.toSanitized();
    const lifecycleEvents = Array.isArray(sanitized.lifecycleEvents)
      ? sanitized.lifecycleEvents.slice(-20).reverse()
      : [];
    const statusReason = this.buildStatusReason(config, effectiveStatus, probe, serviceRunning);

    return {
      ...sanitized,
      serviceStatus: effectiveStatus,
      serviceRunning,
      servicePid: childAlive
        ? (this.child?.pid || sanitized.servicePid || null)
        : trackedProcessAlive
          ? (sanitized.servicePid || null)
          : null,
      serviceOwner: childAlive
        ? (os.userInfo().username || sanitized.serviceOwner || null)
        : trackedProcessAlive
          ? (sanitized.serviceOwner || os.userInfo().username || null)
          : effectiveStatus === 'running_external'
          ? null
          : sanitized.serviceOwner,
      localBaseUrl: buildLocalBaseUrl(config.bindHost, config.servicePort),
      reverseProxy: this.buildReverseProxyStatus(config, reverseProxyRoute),
      logs: this.logBuffer.slice(-200),
      lifecycleEvents,
      statusReason,
      autoRecoveryMode: this.getAutoRecoveryMode(config),
      health: probe.available ? probe.health : null,
      healthAvailable: probe.available,
      healthMessage: probe.available ? '' : probe.message,
      oauthClientSecretConfigured: Boolean(trimString(config.oauthClientSecret)),
      eventClientSecretConfigured: Boolean(trimString(config.eventClientSecret)),
      alexaCommandSessionConfigured: Boolean(trimString(config.alexaCommandSessionCookie) || trimString(config.alexaCommandSessionData)),
      oauthClientSecretMasked: maskSecret(config.oauthClientSecret),
      eventClientSecretMasked: maskSecret(config.eventClientSecret),
      alexaCommandSessionCookieMasked: maskSecret(config.alexaCommandSessionCookie),
      alexaCommandSessionDataMasked: maskSecret(config.alexaCommandSessionData)
    };
  }
}

const alexaBrokerService = new AlexaBrokerService();

module.exports = alexaBrokerService;
module.exports.AlexaBrokerService = AlexaBrokerService;
module.exports.buildLocalBaseUrl = buildLocalBaseUrl;
module.exports.parseListInput = parseListInput;
