const fs = require('fs');
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
const DEFAULT_LOG_LIMIT = 500;
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

function waitForChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.killed) {
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

class AlexaBrokerService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.brokerRoot = options.brokerRoot || path.join(this.projectRoot, 'broker');
    this.spawnProcess = options.spawnProcess || spawn;
    this.httpClient = options.httpClient || axios;
    this.configModel = options.configModel || AlexaBrokerConfig;
    this.reverseProxyRouteModel = options.reverseProxyRouteModel || ReverseProxyRoute;
    this.reverseProxyService = options.reverseProxyService || reverseProxyService;
    this.logLimit = options.logLimit || DEFAULT_LOG_LIMIT;
    this.child = null;
    this.installProcess = null;
    this.logBuffer = [];
    this.stoppingChild = false;
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
      HOMEBRAIN_ALEXA_RATE_LIMIT_WINDOW_MS: String(sanitizePositiveInteger(config.rateLimitWindowMs, 60000)),
      HOMEBRAIN_ALEXA_RATE_LIMIT_MAX: String(sanitizePositiveInteger(config.rateLimitMax, 120)),
      HOMEBRAIN_ALEXA_ALLOW_MANUAL_REGISTRATION: config.allowManualRegistration === true ? 'true' : 'false'
    };
  }

  async probeHealth(config) {
    const localBaseUrl = buildLocalBaseUrl(config.bindHost, config.servicePort);

    try {
      const response = await this.httpClient.get(`${localBaseUrl}/health`, {
        timeout: 2000
      });
      return {
        available: true,
        localBaseUrl,
        health: response.data || null,
        message: ''
      };
    } catch (error) {
      return {
        available: false,
        localBaseUrl,
        health: null,
        message: error?.message || 'Broker health check failed'
      };
    }
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
      await config.save();
    });

    child.on('exit', async (code, signal) => {
      const exitedDuringStop = this.stoppingChild === true;
      this.pushLog(`Broker process exited with code ${code}${signal ? ` (${signal})` : ''}`, 'broker');

      if (this.child === child) {
        this.child = null;
      }

      this.stoppingChild = false;

      const config = await this.configModel.getConfig();
      config.servicePid = null;
      config.serviceOwner = null;

      if (exitedDuringStop) {
        config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
        config.lastStoppedAt = new Date();
      } else if (config.serviceStatus !== 'starting') {
        config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
        config.lastError = {
          message: `Alexa broker exited unexpectedly with code ${code}${signal ? ` (${signal})` : ''}`,
          timestamp: new Date()
        };
      }

      await config.save();
    });
  }

  async waitForHealthyBroker(config, timeoutMs = 10000) {
    const startedAt = Date.now();
    let lastMessage = 'Broker health check timed out';

    while (Date.now() - startedAt < timeoutMs) {
      if (!this.isChildAlive()) {
        throw new Error('Alexa broker stopped before it became healthy');
      }

      const probe = await this.probeHealth(config);
      if (probe.available) {
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
    const shouldResume = this.isChildAlive();

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
    const config = await this.getConfig();
    const shouldAutoStart = config.autoStart || config.resumeAfterHostRestart;
    if (!shouldAutoStart) {
      return;
    }

    try {
      await this.startService({
        quietIfRunning: true,
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
    this.pushLog('Installing Alexa broker dependencies with npm install', 'install');

    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, ['install'], {
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

    const serviceResult = this.isChildAlive()
      ? await this.restartService()
      : await this.startService();

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

    if (!config.isInstalled) {
      throw new Error('Alexa broker dependencies are not installed yet. Run Install first.');
    }

    if (this.installProcess) {
      throw new Error('Alexa broker install is still running. Wait for it to finish before starting the service.');
    }

    if (this.isChildAlive()) {
      return {
        success: true,
        message: 'Alexa broker is already running',
        status: await this.getStatus()
      };
    }

    const existingProbe = await this.probeHealth(config);
    if (existingProbe.available) {
      config.serviceStatus = 'running_external';
      config.servicePid = null;
      config.serviceOwner = null;
      config.resumeAfterHostRestart = false;
      await config.save();
      return {
        success: true,
        message: options.quietIfRunning
          ? 'Alexa broker is already running'
          : 'Alexa broker is already running outside HomeBrain on the configured port',
        externallyManaged: true,
        status: await this.getStatus()
      };
    }

    config.serviceStatus = 'starting';
    config.servicePid = null;
    config.serviceOwner = null;
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
      const probe = await this.waitForHealthyBroker(config);
      config.serviceStatus = 'running';
      config.servicePid = child.pid || null;
      config.serviceOwner = os.userInfo().username;
      config.resumeAfterHostRestart = false;
      config.lastStartedAt = new Date();
      config.lastError = null;
      await config.save();

      return {
        success: true,
        message: 'Alexa broker started successfully',
        health: probe.health,
        status: await this.getStatus()
      };
    } catch (error) {
      this.stoppingChild = true;
      if (this.child === child && child.exitCode == null && !child.killed) {
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
      await config.save();
      throw error;
    }
  }

  async stopService(options = {}) {
    const config = await this.getConfig();
    const preserveResumeAfterHostRestart = options.preserveResumeAfterHostRestart === true;

    if (!this.isChildAlive()) {
      const probe = await this.probeHealth(config);
      if (probe.available) {
        config.serviceStatus = 'running_external';
        if (!preserveResumeAfterHostRestart) {
          config.resumeAfterHostRestart = false;
        }
        await config.save();
        throw new Error('Alexa broker is being managed outside HomeBrain. Stop that process manually or change the configured port.');
      }

      config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
      config.servicePid = null;
      config.serviceOwner = null;
      if (!preserveResumeAfterHostRestart) {
        config.resumeAfterHostRestart = false;
      }
      config.lastStoppedAt = new Date();
      await config.save();
      return {
        success: true,
        message: 'Alexa broker is already stopped',
        status: await this.getStatus()
      };
    }

    const child = this.child;
    this.stoppingChild = true;
    this.pushLog('Stopping Alexa broker service', 'broker');

    child.kill('SIGTERM');
    await waitForChildExit(child, 5000);

    if (child.exitCode == null && !child.killed) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 3000);
    }

    config.serviceStatus = config.isInstalled ? 'stopped' : 'not_installed';
    config.servicePid = null;
    config.serviceOwner = null;
    if (!preserveResumeAfterHostRestart) {
      config.resumeAfterHostRestart = false;
    }
    config.lastStoppedAt = new Date();
    await config.save();

    this.child = null;
    this.stoppingChild = false;

    return {
      success: true,
      message: 'Alexa broker stopped successfully',
      status: await this.getStatus()
    };
  }

  async restartService() {
    try {
      await this.stopService({ preserveResumeAfterHostRestart: true });
    } catch (error) {
      if (!String(error.message || '').includes('already stopped')) {
        throw error;
      }
    }

    return this.startService();
  }

  async getStatus() {
    const config = await this.getConfig();
    const [probe, reverseProxyRoute] = await Promise.all([
      this.probeHealth(config),
      this.findManagedReverseProxyRoute(config)
    ]);
    const childAlive = this.isChildAlive();
    let effectiveStatus = config.serviceStatus;
    let serviceRunning = false;

    if (!config.isInstalled && config.serviceStatus !== 'installing') {
      effectiveStatus = 'not_installed';
    } else if (probe.available && childAlive) {
      effectiveStatus = 'running';
      serviceRunning = true;
    } else if (probe.available && !childAlive) {
      effectiveStatus = 'running_external';
      serviceRunning = true;
    } else if (config.serviceStatus === 'starting' || config.serviceStatus === 'installing') {
      effectiveStatus = config.serviceStatus;
    } else if (config.isInstalled) {
      effectiveStatus = 'stopped';
    } else {
      effectiveStatus = 'not_installed';
    }

    if (effectiveStatus !== config.serviceStatus) {
      config.serviceStatus = effectiveStatus;
      if (!serviceRunning) {
        config.servicePid = null;
        config.serviceOwner = null;
      }
      await config.save();
    }

    const sanitized = config.toSanitized();
    return {
      ...sanitized,
      serviceStatus: effectiveStatus,
      serviceRunning,
      servicePid: childAlive ? (this.child?.pid || sanitized.servicePid || null) : null,
      serviceOwner: childAlive
        ? (os.userInfo().username || sanitized.serviceOwner || null)
        : effectiveStatus === 'running_external'
          ? null
          : sanitized.serviceOwner,
      localBaseUrl: buildLocalBaseUrl(config.bindHost, config.servicePort),
      reverseProxy: this.buildReverseProxyStatus(config, reverseProxyRoute),
      logs: this.logBuffer.slice(-200),
      health: probe.available ? probe.health : null,
      healthAvailable: probe.available,
      healthMessage: probe.available ? '' : probe.message,
      oauthClientSecretConfigured: Boolean(trimString(config.oauthClientSecret)),
      eventClientSecretConfigured: Boolean(trimString(config.eventClientSecret)),
      oauthClientSecretMasked: maskSecret(config.oauthClientSecret),
      eventClientSecretMasked: maskSecret(config.eventClientSecret)
    };
  }
}

const alexaBrokerService = new AlexaBrokerService();

module.exports = alexaBrokerService;
module.exports.AlexaBrokerService = AlexaBrokerService;
module.exports.buildLocalBaseUrl = buildLocalBaseUrl;
module.exports.parseListInput = parseListInput;
