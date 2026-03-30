const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { URL, domainToASCII } = require('url');

const axios = require('axios');

const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const ReverseProxyAuditLog = require('../models/ReverseProxyAuditLog');
const ReverseProxySettings = require('../models/ReverseProxySettings');
const caddyAdminService = require('./caddyAdminService');

const CADDY_LETSENCRYPT_PRODUCTION_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
const CADDY_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const CADDY_CERTIFICATE_DIR = path.join(__dirname, '..', 'certificates');
const DEFAULT_EDGE_PROBE_HOST = process.env.CADDY_EDGE_PROBE_HOST || '127.0.0.1';
const DEFAULT_EDGE_HTTP_PORT = Number(process.env.CADDY_EDGE_HTTP_PORT || 80);
const DEFAULT_EDGE_HTTPS_PORT = Number(process.env.CADDY_EDGE_HTTPS_PORT || 443);
const DEFAULT_BIND_PORT = Number(process.env.PORT || 3000);
const DEFAULT_ASK_URL = `http://127.0.0.1:${DEFAULT_BIND_PORT}/internal/caddy/can-issue-cert`;
const DEFAULT_AXIOM_PUBLIC_UPSTREAM_PORT = Number(process.env.AXIOM_UPSTREAM_PORT || 4174);

const ROUTE_PRESETS = Object.freeze({
  homebrain: Object.freeze({
    platformKey: 'homebrain',
    displayName: 'HomeBrain',
    upstreamProtocol: 'http',
    upstreamHost: process.env.HOMEBRAIN_UPSTREAM_HOST || '127.0.0.1',
    upstreamPort: Number(process.env.HOMEBRAIN_UPSTREAM_PORT || DEFAULT_BIND_PORT),
    healthCheckPath: '/ping',
    websocketSupport: true,
    tlsMode: 'automatic'
  }),
  axiom: Object.freeze({
    platformKey: 'axiom',
    displayName: 'Axiom',
    upstreamProtocol: 'http',
    upstreamHost: process.env.AXIOM_UPSTREAM_HOST || '127.0.0.1',
    upstreamPort: DEFAULT_AXIOM_PUBLIC_UPSTREAM_PORT,
    healthCheckPath: '/healthz',
    websocketSupport: true,
    tlsMode: 'automatic'
  })
});

const DEFAULT_PUBLIC_HOSTNAME = 'freestonefamily.com';

function trimString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim();
}

function normalizePlatformKey(value) {
  const normalized = trimString(value, 'custom')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'custom';
}

function normalizeHostname(value) {
  const candidate = trimString(value).toLowerCase().replace(/\.+$/, '');
  if (!candidate) {
    throw new Error('Hostname is required');
  }

  if (candidate.includes('*')) {
    throw new Error('Wildcard hostnames are not allowed without explicit approval');
  }

  const ascii = domainToASCII(candidate);
  if (!ascii) {
    throw new Error('Hostname is not a valid DNS name');
  }

  const labels = ascii.split('.');
  if (labels.length < 2) {
    throw new Error('Hostname must be a fully-qualified DNS name');
  }

  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9-]+$/i.test(label) || label.startsWith('-') || label.endsWith('-')) {
      throw new Error('Hostname is not a valid DNS name');
    }
  }

  return ascii.toLowerCase();
}

function normalizeUpstreamHost(value) {
  const candidate = trimString(value).toLowerCase();
  if (!candidate) {
    throw new Error('Upstream host is required');
  }

  if (net.isIP(candidate)) {
    return candidate;
  }

  if (candidate === 'localhost') {
    return candidate;
  }

  if (!/^[a-z0-9.-]+$/i.test(candidate) || candidate.startsWith('.') || candidate.endsWith('.')) {
    throw new Error('Upstream host is invalid');
  }

  return candidate;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Upstream port must be between 1 and 65535');
  }

  return port;
}

function normalizePath(value, fallback = '/') {
  const candidate = trimString(value, fallback);
  if (!candidate) {
    return fallback;
  }

  if (!candidate.startsWith('/')) {
    return `/${candidate}`;
  }

  return candidate;
}

function normalizeOptionalPath(value) {
  const candidate = trimString(value);
  if (!candidate) {
    return '';
  }

  return normalizePath(candidate, '');
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function isBlankString(value) {
  return trimString(value) === '';
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isPrivateIp(host) {
  if (!net.isIP(host)) {
    return false;
  }

  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  const normalized = host.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80');
}

function isPrivateUpstreamHost(host) {
  if (isLoopbackHost(host) || isPrivateIp(host)) {
    return true;
  }

  return host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan');
}

function quoteCaddy(value) {
  return JSON.stringify(String(value));
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parseAdminListenAddress(adminUrl) {
  const parsed = new URL(trimString(adminUrl, 'http://127.0.0.1:2019'));
  return parsed.host;
}

function getManualCertificateFiles() {
  return {
    cert: path.join(CADDY_CERTIFICATE_DIR, 'active-chain.pem'),
    key: path.join(CADDY_CERTIFICATE_DIR, 'active-key.pem')
  };
}

function getDefaultAskUrl() {
  return process.env.CADDY_ON_DEMAND_ASK_URL || DEFAULT_ASK_URL;
}

function getDefaultPublicHostname() {
  const explicitHost = trimString(process.env.HOMEBRAIN_PUBLIC_HOST).toLowerCase();
  if (explicitHost) {
    try {
      return normalizeHostname(explicitHost.replace(/^www\./, ''));
    } catch (_error) {
      // noop
    }
  }

  const baseUrl = trimString(process.env.HOMEBRAIN_PUBLIC_BASE_URL);
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const hostname = normalizeHostname(parsed.hostname);
      if (!net.isIP(hostname) && !isLoopbackHost(hostname)) {
        return hostname.replace(/^www\./, '');
      }
    } catch (_error) {
      // noop
    }
  }

  return DEFAULT_PUBLIC_HOSTNAME;
}

function getDefaultAxiomHostname(homebrainHostname) {
  const explicitHost = trimString(process.env.AXIOM_PUBLIC_HOST).toLowerCase();
  if (explicitHost) {
    try {
      return normalizeHostname(explicitHost);
    } catch (_error) {
      // noop
    }
  }

  return normalizeHostname(`mail.${homebrainHostname}`);
}

function buildUpstreamUrl(route) {
  return `${route.upstreamProtocol}://${route.upstreamHost}:${route.upstreamPort}`;
}

function buildPresetSuggestions() {
  const homebrainHostname = getDefaultPublicHostname();
  const wwwHostname = normalizeHostname(`www.${homebrainHostname}`);
  const axiomHostname = getDefaultAxiomHostname(homebrainHostname);

  return [
    {
      id: 'homebrain-primary',
      hostname: homebrainHostname,
      ...ROUTE_PRESETS.homebrain
    },
    {
      id: 'homebrain-www',
      hostname: wwwHostname,
      ...ROUTE_PRESETS.homebrain
    },
    {
      id: 'axiom-mail',
      hostname: axiomHostname,
      ...ROUTE_PRESETS.axiom
    }
  ];
}

function buildBootstrapRouteSeeds() {
  return buildPresetSuggestions().map((route) => {
    if (route.platformKey === 'axiom') {
      return {
        ...route,
        enabled: false,
        notes: 'Seeded automatically for the upcoming Axiom platform. Enable this route once the Axiom upstream is live.'
      };
    }

    return {
      ...route,
      enabled: true,
      notes: 'Seeded automatically as the default public HomeBrain route.'
    };
  });
}

function buildBootstrapSettings(settings) {
  const updates = {};
  const defaultAdminUrl = trimString(process.env.CADDY_ADMIN_URL, 'http://127.0.0.1:2019');
  const defaultStorageRoot = trimString(process.env.CADDY_STORAGE_ROOT, '/var/lib/caddy');
  const defaultAcmeEmail = trimString(process.env.CADDY_ACME_EMAIL);
  const defaultExpectedIpv4 = trimString(process.env.HOMEBRAIN_EXPECTED_PUBLIC_IP);
  const defaultExpectedIpv6 = trimString(process.env.HOMEBRAIN_EXPECTED_PUBLIC_IPV6);
  const defaultAcmeEnv = process.env.ACME_ENV === 'production' ? 'production' : 'staging';

  if (isBlankString(settings.caddyAdminUrl)) {
    updates.caddyAdminUrl = defaultAdminUrl;
  }

  if (isBlankString(settings.caddyStorageRoot)) {
    updates.caddyStorageRoot = defaultStorageRoot;
  }

  if (!['staging', 'production'].includes(settings.acmeEnv)) {
    updates.acmeEnv = defaultAcmeEnv;
  }

  if (isBlankString(settings.acmeEmail) && defaultAcmeEmail) {
    updates.acmeEmail = defaultAcmeEmail;
  }

  if (isBlankString(settings.expectedPublicIp) && defaultExpectedIpv4) {
    updates.expectedPublicIp = defaultExpectedIpv4;
  }

  if (isBlankString(settings.expectedPublicIpv6) && defaultExpectedIpv6) {
    updates.expectedPublicIpv6 = defaultExpectedIpv6;
  }

  return updates;
}

function applyPresetDefaults(payload) {
  const platformKey = normalizePlatformKey(payload.platformKey);
  const preset = ROUTE_PRESETS[platformKey];

  if (!preset) {
    return {
      platformKey,
      displayName: trimString(payload.displayName) || '',
      upstreamProtocol: payload.upstreamProtocol || 'http',
      upstreamHost: payload.upstreamHost,
      upstreamPort: payload.upstreamPort,
      healthCheckPath: payload.healthCheckPath,
      websocketSupport: payload.websocketSupport,
      tlsMode: payload.tlsMode || 'automatic'
    };
  }

  return {
    platformKey,
    displayName: trimString(payload.displayName) || preset.displayName,
    upstreamProtocol: payload.upstreamProtocol || preset.upstreamProtocol,
    upstreamHost: payload.upstreamHost || preset.upstreamHost,
    upstreamPort: payload.upstreamPort ?? preset.upstreamPort,
    healthCheckPath: payload.healthCheckPath || preset.healthCheckPath,
    websocketSupport: typeof payload.websocketSupport === 'boolean'
      ? payload.websocketSupport
      : preset.websocketSupport,
    tlsMode: payload.tlsMode || preset.tlsMode
  };
}

async function resolveDnsAddresses(hostname) {
  const addresses = new Set();

  try {
    const v4 = await dns.resolve4(hostname);
    v4.forEach((entry) => addresses.add(entry));
  } catch (_error) {
    // noop
  }

  try {
    const v6 = await dns.resolve6(hostname);
    v6.forEach((entry) => addresses.add(entry));
  } catch (_error) {
    // noop
  }

  return Array.from(addresses);
}

async function probeTcpPort(host, port, timeoutMs = 2_500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finalize = (reachable) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch (_error) {
        // noop
      }
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
  });
}

async function probeUpstream(route) {
  const baseUrl = buildUpstreamUrl(route);
  const url = `${baseUrl}${normalizePath(route.healthCheckPath || '/', '/')}`;
  const isHttps = route.upstreamProtocol === 'https';

  try {
    const response = await axios.get(url, {
      timeout: 3_500,
      validateStatus: () => true,
      httpsAgent: isHttps ? new https.Agent({ rejectUnauthorized: true }) : undefined
    });

    return {
      reachable: response.status >= 200 && response.status < 500,
      statusCode: response.status
    };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      error: error.message
    };
  }
}

async function probeServedCertificate(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: DEFAULT_EDGE_PROBE_HOST,
      port: DEFAULT_EDGE_HTTPS_PORT,
      servername: hostname,
      rejectUnauthorized: false,
      timeout: 3_500
    }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();

      if (!cert || !cert.subject) {
        resolve({ success: false, error: 'No certificate presented by edge proxy' });
        return;
      }

      resolve({
        success: true,
        issuer: cert.issuer && Object.values(cert.issuer).join(', '),
        subject: cert.subject && Object.values(cert.subject).join(', '),
        validTo: cert.valid_to ? new Date(cert.valid_to) : null
      });
    });

    socket.once('error', (error) => {
      resolve({ success: false, error: error.message });
    });

    socket.once('timeout', () => {
      resolve({ success: false, error: 'TLS probe timed out' });
      try {
        socket.destroy();
      } catch (_error) {
        // noop
      }
    });
  });
}

function buildSiteBlock(route, settings) {
  const lines = [
    `${route.hostname} {`,
    '  encode zstd gzip'
  ];

  if (settings.accessLogsEnabled) {
    lines.push('  log {');
    lines.push('    output stdout');
    lines.push('    format json');
    lines.push('  }');
  }

  if (route.tlsMode === 'internal') {
    lines.push('  tls internal');
  } else if (route.tlsMode === 'manual') {
    const files = getManualCertificateFiles();
    lines.push(`  tls ${quoteCaddy(files.cert)} ${quoteCaddy(files.key)}`);
  } else if (route.tlsMode === 'on_demand') {
    lines.push('  tls {');
    lines.push('    on_demand');
    lines.push('  }');
  }

  lines.push('  route {');
  if (route.stripPrefix) {
    lines.push(`    uri strip_prefix ${quoteCaddy(route.stripPrefix)}`);
  }
  lines.push(`    reverse_proxy ${quoteCaddy(buildUpstreamUrl(route))} {`);
  lines.push(`      health_uri ${quoteCaddy(normalizePath(route.healthCheckPath || '/', '/'))}`);
  if (route.upstreamProtocol === 'https') {
    lines.push('      transport http {');
    lines.push(`        tls_server_name ${quoteCaddy(route.upstreamHost)}`);
    lines.push('      }');
  }
  lines.push('    }');
  lines.push('  }');
  lines.push('}');

  return lines.join('\n');
}

function buildGlobalOptions(settings) {
  const lines = [
    '{',
    `  admin ${quoteCaddy(parseAdminListenAddress(settings.caddyAdminUrl))}`,
    '  storage file_system {',
    `    root ${quoteCaddy(settings.caddyStorageRoot)}`,
    '  }'
  ];

  if (settings.acmeEmail) {
    lines.push(`  email ${quoteCaddy(settings.acmeEmail)}`);
  }

  if (settings.acmeEnv === 'production') {
    lines.push(`  acme_ca ${quoteCaddy(CADDY_LETSENCRYPT_PRODUCTION_DIRECTORY)}`);
  } else if (settings.acmeEnv === 'staging') {
    lines.push(`  acme_ca ${quoteCaddy(CADDY_STAGING_DIRECTORY)}`);
  }

  if (settings.onDemandTlsEnabled) {
    lines.push('  on_demand_tls {');
    lines.push(`    ask ${quoteCaddy(getDefaultAskUrl())}`);
    lines.push('  }');
  }

  lines.push('}');
  return lines.join('\n');
}

function sanitizeRoutePayload(input = {}) {
  const defaults = applyPresetDefaults(input);
  const hostname = normalizeHostname(input.hostname);
  const upstreamHost = normalizeUpstreamHost(defaults.upstreamHost);
  const upstreamPort = normalizePort(defaults.upstreamPort);
  const upstreamProtocol = defaults.upstreamProtocol === 'https' ? 'https' : 'http';
  const tlsMode = ['automatic', 'internal', 'manual', 'on_demand'].includes(defaults.tlsMode)
    ? defaults.tlsMode
    : 'automatic';

  return {
    hostname,
    platformKey: defaults.platformKey,
    displayName: trimString(defaults.displayName) || hostname,
    upstreamProtocol,
    upstreamHost,
    upstreamPort,
    enabled: normalizeBoolean(input.enabled, false),
    tlsMode,
    allowOnDemandTls: normalizeBoolean(input.allowOnDemandTls, false),
    allowPublicUpstream: normalizeBoolean(input.allowPublicUpstream, false),
    healthCheckPath: normalizePath(defaults.healthCheckPath || '/', '/'),
    websocketSupport: normalizeBoolean(defaults.websocketSupport, true),
    stripPrefix: normalizeOptionalPath(input.stripPrefix),
    notes: trimString(input.notes),
    ownershipVerified: normalizeBoolean(input.ownershipVerified, false),
    adminApproved: normalizeBoolean(input.adminApproved, false)
  };
}

function sanitizeSettingsPayload(input = {}) {
  const updates = {};

  if (typeof input.caddyAdminUrl === 'string' && trimString(input.caddyAdminUrl)) {
    new URL(trimString(input.caddyAdminUrl));
    updates.caddyAdminUrl = trimString(input.caddyAdminUrl).replace(/\/+$/, '');
  }

  if (typeof input.caddyStorageRoot === 'string' && trimString(input.caddyStorageRoot)) {
    updates.caddyStorageRoot = trimString(input.caddyStorageRoot);
  }

  if (typeof input.acmeEmail === 'string') {
    updates.acmeEmail = trimString(input.acmeEmail);
  }

  if (typeof input.expectedPublicIp === 'string') {
    updates.expectedPublicIp = trimString(input.expectedPublicIp);
  }

  if (typeof input.expectedPublicIpv6 === 'string') {
    updates.expectedPublicIpv6 = trimString(input.expectedPublicIpv6);
  }

  if (typeof input.acmeEnv === 'string' && ['staging', 'production'].includes(input.acmeEnv)) {
    updates.acmeEnv = input.acmeEnv;
  }

  if (typeof input.onDemandTlsEnabled === 'boolean') {
    updates.onDemandTlsEnabled = input.onDemandTlsEnabled;
  }

  if (typeof input.accessLogsEnabled === 'boolean') {
    updates.accessLogsEnabled = input.accessLogsEnabled;
  }

  if (typeof input.adminApiEnabled === 'boolean') {
    updates.adminApiEnabled = input.adminApiEnabled;
  }

  return updates;
}

class ReverseProxyService {
  async writeAuditLog(payload) {
    return ReverseProxyAuditLog.create(payload);
  }

  async getSettings() {
    return ReverseProxySettings.getSettings();
  }

  async listAuditLogs(limit = 20) {
    return ReverseProxyAuditLog.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  async getRoutePresets() {
    return buildPresetSuggestions();
  }

  async ensureBootstrapState(options = {}) {
    const actor = trimString(options.actor, 'system:bootstrap');
    const seedDefaultRoutes = options.seedDefaultRoutes !== false;
    const validateExistingRoutes = options.validateExistingRoutes !== false;
    const forceRevalidate = options.forceRevalidate === true;
    const settings = await this.getSettings();
    const before = settings.toObject ? settings.toObject() : { ...settings };
    const settingsUpdates = buildBootstrapSettings(settings);

    if (Object.keys(settingsUpdates).length > 0) {
      Object.assign(settings, settingsUpdates, {
        updatedBy: actor
      });
      await settings.save();

      await this.writeAuditLog({
        actor,
        action: 'settings_updated',
        status: 'success',
        details: {
          bootstrap: true,
          updatedFields: Object.keys(settingsUpdates),
          before,
          after: settings.toObject()
        }
      });
    }

    const createdRoutes = [];
    const revalidatedRoutes = [];
    const existingRoutes = [];

    if (seedDefaultRoutes) {
      const presets = buildBootstrapRouteSeeds();
      const existing = await ReverseProxyRoute.find({
        hostname: {
          $in: presets.map((route) => route.hostname)
        }
      });
      const existingByHostname = new Map(existing.map((route) => [route.hostname, route]));

      for (const preset of presets) {
        const route = existingByHostname.get(preset.hostname);
        if (!route) {
          const created = await this.createRoute(preset, actor);
          createdRoutes.push(created.hostname);
          continue;
        }

        existingRoutes.push(route.hostname);

        if (validateExistingRoutes && (forceRevalidate || route.validationStatus === 'unknown')) {
          await this.validateRoute(route, settings, {
            persist: true,
            actor
          });
          revalidatedRoutes.push(route.hostname);
        }
      }
    }

    return {
      settings,
      settingsUpdated: Object.keys(settingsUpdates),
      createdRoutes,
      existingRoutes,
      revalidatedRoutes,
      routePresets: buildPresetSuggestions()
    };
  }

  async listRoutes(options = {}) {
    const routes = await ReverseProxyRoute.find().sort({ hostname: 1 });
    if (!options.refreshValidation) {
      return routes;
    }

    const settings = await this.getSettings();
    for (const route of routes) {
      await this.validateRoute(route, settings, { persist: true });
    }

    return ReverseProxyRoute.find().sort({ hostname: 1 });
  }

  async createRoute(payload, actor = 'system') {
    const sanitized = sanitizeRoutePayload(payload);
    const { ownershipVerified, adminApproved, ...routeFields } = sanitized;
    const duplicate = await ReverseProxyRoute.findOne({ hostname: sanitized.hostname });
    if (duplicate) {
      throw new Error(`A route for ${sanitized.hostname} already exists`);
    }

    const route = await ReverseProxyRoute.create({
      ...routeFields,
      createdBy: actor,
      updatedBy: actor,
      certificateStatus: {
        ownershipVerified,
        adminApproved
      }
    });

    await this.validateRoute(route, null, { persist: true, actor });
    await this.writeAuditLog({
      routeId: route._id,
      hostname: route.hostname,
      actor,
      action: 'route_created',
      status: 'success',
      details: {
        after: route.toObject()
      }
    });

    return ReverseProxyRoute.findById(route._id);
  }

  async updateRoute(routeId, payload, actor = 'system') {
    const route = await ReverseProxyRoute.findById(routeId);
    if (!route) {
      throw new Error('Route not found');
    }

    const before = route.toObject();
    const sanitized = sanitizeRoutePayload({
      ...before,
      ...payload,
      hostname: payload.hostname ?? before.hostname,
      platformKey: payload.platformKey ?? before.platformKey,
      displayName: payload.displayName ?? before.displayName,
      upstreamProtocol: payload.upstreamProtocol ?? before.upstreamProtocol,
      upstreamHost: payload.upstreamHost ?? before.upstreamHost,
      upstreamPort: payload.upstreamPort ?? before.upstreamPort,
      healthCheckPath: payload.healthCheckPath ?? before.healthCheckPath,
      websocketSupport: payload.websocketSupport ?? before.websocketSupport,
      tlsMode: payload.tlsMode ?? before.tlsMode,
      ownershipVerified: payload.ownershipVerified ?? before.certificateStatus?.ownershipVerified,
      adminApproved: payload.adminApproved ?? before.certificateStatus?.adminApproved
    });

    const duplicate = await ReverseProxyRoute.findOne({
      hostname: sanitized.hostname,
      _id: { $ne: route._id }
    });
    if (duplicate) {
      throw new Error(`A route for ${sanitized.hostname} already exists`);
    }

    const { ownershipVerified, adminApproved, ...routeFields } = sanitized;
    Object.assign(route, routeFields, {
      updatedBy: actor
    });
    route.certificateStatus = {
      ...route.certificateStatus?.toObject?.(),
      ownershipVerified,
      adminApproved
    };
    await route.save();
    await this.validateRoute(route, null, { persist: true, actor });

    await this.writeAuditLog({
      routeId: route._id,
      hostname: route.hostname,
      actor,
      action: 'route_updated',
      status: 'success',
      details: {
        before,
        after: route.toObject()
      }
    });

    return ReverseProxyRoute.findById(route._id);
  }

  async deleteRoute(routeId, actor = 'system') {
    const route = await ReverseProxyRoute.findById(routeId);
    if (!route) {
      throw new Error('Route not found');
    }

    const before = route.toObject();
    await route.deleteOne();
    await this.writeAuditLog({
      routeId: route._id,
      hostname: route.hostname,
      actor,
      action: 'route_deleted',
      status: 'success',
      details: {
        before
      }
    });

    return {
      success: true,
      hostname: before.hostname
    };
  }

  async updateSettings(payload, actor = 'system') {
    const settings = await this.getSettings();
    const updates = sanitizeSettingsPayload(payload);

    if (
      updates.acmeEnv === 'production' &&
      settings.acmeEnv === 'staging' &&
      payload.confirmProductionSwitch !== true
    ) {
      throw new Error('Switching ACME mode from staging to production requires confirmation');
    }

    const before = settings.toObject();
    Object.assign(settings, updates, {
      updatedBy: actor
    });
    await settings.save();

    await this.writeAuditLog({
      actor,
      action: 'settings_updated',
      status: 'success',
      details: {
        before,
        after: settings.toObject()
      }
    });

    return settings;
  }

  async validateRoute(routeDocument, settingsOverride = null, options = {}) {
    const route = routeDocument.toObject ? routeDocument.toObject() : { ...routeDocument };
    const settings = settingsOverride || await this.getSettings();
    const validation = {
      lastCheckedAt: new Date(),
      hostnameValid: true,
      upstreamReachable: false,
      upstreamStatusCode: null,
      caddyAdminReachable: false,
      dnsReady: false,
      publicIpMatches: null,
      routerPortsReachable: null,
      resolvedAddresses: [],
      blockingErrors: [],
      warnings: []
    };

    const certificateStatus = {
      automaticTlsEligible: false,
      dnsReady: false,
      status: route.enabled ? 'pending' : 'inactive',
      renewalState: 'unknown',
      lastError: '',
      ownershipVerified: Boolean(route.certificateStatus?.ownershipVerified),
      adminApproved: Boolean(route.certificateStatus?.adminApproved),
      servedIssuer: '',
      servedSubject: '',
      servedNotAfter: null,
      lastCheckedAt: new Date()
    };

    try {
      normalizeHostname(route.hostname);
    } catch (error) {
      validation.hostnameValid = false;
      validation.blockingErrors.push(error.message);
    }

    try {
      normalizeUpstreamHost(route.upstreamHost);
      normalizePort(route.upstreamPort);
    } catch (error) {
      validation.blockingErrors.push(error.message);
    }

    if ((route.upstreamPort === 80 || route.upstreamPort === 443) && !route.allowPublicUpstream && !isPrivateUpstreamHost(route.upstreamHost)) {
      validation.blockingErrors.push('Routes may not proxy to public 80/443 upstreams unless explicitly allowed');
    }

    if (route.tlsMode === 'on_demand' && !settings.onDemandTlsEnabled) {
      validation.blockingErrors.push('On-demand TLS is disabled by policy');
    }

    if (route.tlsMode === 'manual') {
      const files = getManualCertificateFiles();
      if (!fs.existsSync(files.cert) || !fs.existsSync(files.key)) {
        validation.blockingErrors.push('Manual TLS selected but no active certificate files are present');
      }
    }

    const [dnsAddresses, caddyStatus, upstreamProbe, edge80Reachable, edge443Reachable] = await Promise.all([
      validation.hostnameValid ? resolveDnsAddresses(route.hostname) : Promise.resolve([]),
      caddyAdminService.ping(settings),
      probeUpstream(route),
      probeTcpPort(DEFAULT_EDGE_PROBE_HOST, DEFAULT_EDGE_HTTP_PORT),
      probeTcpPort(DEFAULT_EDGE_PROBE_HOST, DEFAULT_EDGE_HTTPS_PORT)
    ]);

    validation.resolvedAddresses = dnsAddresses;
    validation.dnsReady = dnsAddresses.length > 0;
    validation.caddyAdminReachable = Boolean(caddyStatus.reachable);
    validation.upstreamReachable = Boolean(upstreamProbe.reachable);
    validation.upstreamStatusCode = upstreamProbe.statusCode;
    validation.routerPortsReachable = Boolean(edge80Reachable && edge443Reachable);

    if (!validation.dnsReady) {
      validation.warnings.push('Hostname does not currently resolve in DNS');
    }

    if (!validation.caddyAdminReachable) {
      validation.warnings.push(`Caddy admin API is unreachable: ${caddyStatus.error || 'unknown error'}`);
    }

    if (!validation.upstreamReachable) {
      const upstreamError = `Upstream is unreachable at ${buildUpstreamUrl(route)}${route.healthCheckPath || '/'}`;
      if (route.enabled) {
        validation.blockingErrors.push(upstreamError);
      } else {
        validation.warnings.push(`${upstreamError} (route is currently disabled)`);
      }
    }

    if (!validation.routerPortsReachable) {
      validation.warnings.push('Local edge ports 80/443 are not both reachable on the host');
    }

    const expectedIps = [
      trimString(settings.expectedPublicIp),
      trimString(settings.expectedPublicIpv6)
    ].filter(Boolean);

    if (expectedIps.length > 0) {
      validation.publicIpMatches = dnsAddresses.some((entry) => expectedIps.includes(entry));
      if (!validation.publicIpMatches) {
        validation.blockingErrors.push(`DNS for ${route.hostname} does not match the expected public IP configuration`);
      }
    }

    certificateStatus.dnsReady = validation.dnsReady;
    certificateStatus.automaticTlsEligible = (
      route.enabled &&
      validation.hostnameValid &&
      validation.dnsReady &&
      validation.upstreamReachable &&
      validation.publicIpMatches !== false &&
      ['automatic', 'on_demand'].includes(route.tlsMode)
    );

    if (!route.enabled) {
      certificateStatus.status = 'inactive';
      if (route.tlsMode === 'manual') {
        certificateStatus.renewalState = 'manual';
      } else if (route.tlsMode === 'internal') {
        certificateStatus.renewalState = 'internal';
      } else {
        certificateStatus.renewalState = settings.acmeEnv === 'production' ? 'managed-production' : 'managed-staging';
      }
    } else if (route.tlsMode === 'manual') {
      certificateStatus.renewalState = 'manual';
    } else if (route.tlsMode === 'internal') {
      certificateStatus.renewalState = 'internal';
    } else {
      certificateStatus.renewalState = settings.acmeEnv === 'production' ? 'managed-production' : 'managed-staging';
    }

    if (
      route.enabled &&
      ['automatic', 'internal', 'manual', 'on_demand'].includes(route.tlsMode) &&
      validation.routerPortsReachable
    ) {
      const servedCertificate = await probeServedCertificate(route.hostname);
      if (servedCertificate.success) {
        certificateStatus.status = 'issued';
        certificateStatus.servedIssuer = servedCertificate.issuer || '';
        certificateStatus.servedSubject = servedCertificate.subject || '';
        certificateStatus.servedNotAfter = servedCertificate.validTo || null;
      } else if (validation.blockingErrors.length > 0) {
        certificateStatus.status = 'error';
        certificateStatus.lastError = servedCertificate.error || validation.blockingErrors[0];
      } else {
        certificateStatus.status = 'pending';
        certificateStatus.lastError = servedCertificate.error || '';
      }
    } else if (route.enabled && validation.blockingErrors.length > 0) {
      certificateStatus.status = 'error';
      certificateStatus.lastError = validation.blockingErrors[0];
    } else if (route.enabled) {
      certificateStatus.status = 'pending';
    }

    const validationStatus = validation.blockingErrors.length === 0 ? 'valid' : 'invalid';

    if (options.persist && routeDocument && typeof routeDocument.save === 'function') {
      routeDocument.validation = validation;
      routeDocument.validationStatus = validationStatus;
      routeDocument.certificateStatus = {
        ...routeDocument.certificateStatus?.toObject?.(),
        ...certificateStatus
      };
      if (options.actor) {
        routeDocument.updatedBy = options.actor;
      }
      await routeDocument.save();

      if (options.actor) {
        await this.writeAuditLog({
          routeId: routeDocument._id,
          hostname: routeDocument.hostname,
          actor: options.actor,
          action: 'validation_run',
          status: validationStatus === 'valid' ? 'success' : 'failed',
          details: {
            validationStatus,
            blockingErrors: validation.blockingErrors,
            warnings: validation.warnings
          },
          error: validation.blockingErrors.join('; ')
        });
      }
    }

    return {
      validationStatus,
      validation,
      certificateStatus
    };
  }

  async validateAllRoutes(actor = 'system') {
    const routes = await ReverseProxyRoute.find().sort({ hostname: 1 });
    const settings = await this.getSettings();
    const results = [];

    for (const route of routes) {
      results.push(await this.validateRoute(route, settings, {
        persist: true,
        actor
      }));
    }

    return ReverseProxyRoute.find().sort({ hostname: 1 });
  }

  async buildDesiredConfig(settingsOverride = null) {
    const settings = settingsOverride || await this.getSettings();
    const routes = await ReverseProxyRoute.find({ enabled: true }).sort({ hostname: 1 }).lean();
    const globalOptions = buildGlobalOptions(settings);
    const siteBlocks = routes.map((route) => buildSiteBlock(route, settings));
    const caddyfile = [globalOptions, ...siteBlocks].filter(Boolean).join('\n\n').trim();

    return {
      settings,
      routes,
      caddyfile,
      hash: hashText(caddyfile)
    };
  }

  async getStatus() {
    const [settings, routes, auditLogs, caddyStatus, upstreams, desiredConfig] = await Promise.all([
      this.getSettings(),
      ReverseProxyRoute.find().sort({ hostname: 1 }).lean(),
      this.listAuditLogs(20),
      caddyAdminService.ping(),
      caddyAdminService.getUpstreams().catch(() => null),
      this.buildDesiredConfig().catch(() => ({ caddyfile: '', hash: '' }))
    ]);

    return {
      settings,
      caddy: {
        adminReachable: Boolean(caddyStatus.reachable),
        error: caddyStatus.error || '',
        statusCode: caddyStatus.status || null,
        upstreams
      },
      summary: {
        totalRoutes: routes.length,
        enabledRoutes: routes.filter((route) => route.enabled).length,
        invalidRoutes: routes.filter((route) => route.validationStatus === 'invalid').length,
        failedApplies: routes.filter((route) => route.lastApplyStatus === 'failed').length
      },
      config: {
        desired: desiredConfig.caddyfile,
        desiredHash: desiredConfig.hash,
        lastApplied: settings.lastAppliedConfigText || '',
        lastAppliedHash: settings.lastAppliedConfigHash || '',
        changed: Boolean(desiredConfig.hash && desiredConfig.hash !== settings.lastAppliedConfigHash)
      },
      routePresets: buildPresetSuggestions(),
      auditLogs
    };
  }

  async applyConfig(actor = 'system') {
    const settings = await this.getSettings();
    const routes = await ReverseProxyRoute.find().sort({ hostname: 1 });

    for (const route of routes) {
      await this.validateRoute(route, settings, { persist: true });
    }

    const invalidEnabledRoutes = routes.filter((route) => route.enabled && route.validationStatus === 'invalid');
    if (invalidEnabledRoutes.length > 0) {
      const message = `Cannot apply Caddy config while enabled routes are invalid: ${invalidEnabledRoutes.map((route) => route.hostname).join(', ')}`;
      await this.writeAuditLog({
        actor,
        action: 'config_applied',
        status: 'failed',
        error: message,
        details: {
          invalidEnabledRoutes: invalidEnabledRoutes.map((route) => route.hostname)
        }
      });
      throw new Error(message);
    }

    const desired = await this.buildDesiredConfig(settings);
    const adapted = await caddyAdminService.adaptCaddyfile(desired.caddyfile, settings);
    await caddyAdminService.loadCaddyfile(desired.caddyfile, settings);

    settings.lastAppliedConfigText = desired.caddyfile;
    settings.lastAppliedConfigHash = desired.hash;
    settings.lastApplyStatus = 'success';
    settings.lastApplyError = '';
    settings.lastAppliedAt = new Date();
    settings.updatedBy = actor;
    await settings.save();

    await ReverseProxyRoute.updateMany({}, {
      $set: {
        lastApplyStatus: 'never',
        lastApplyError: ''
      }
    });
    await ReverseProxyRoute.updateMany({ enabled: true }, {
      $set: {
        lastApplyStatus: 'applied',
        lastApplyError: ''
      }
    });

    await this.writeAuditLog({
      actor,
      action: 'config_applied',
      status: 'success',
      details: {
        appliedRoutes: desired.routes.map((route) => route.hostname),
        adapted
      }
    });

    return {
      success: true,
      appliedAt: settings.lastAppliedAt,
      appliedRoutes: desired.routes.map((route) => route.hostname),
      caddyfile: desired.caddyfile,
      adapted
    };
  }

  async getCertificates() {
    const routes = await this.validateAllRoutes();
    return routes.map((route) => ({
      id: route._id,
      hostname: route.hostname,
      platformKey: route.platformKey,
      enabled: route.enabled,
      tlsMode: route.tlsMode,
      automaticTlsEligible: Boolean(route.certificateStatus?.automaticTlsEligible),
      dnsReady: Boolean(route.certificateStatus?.dnsReady),
      certStatus: route.certificateStatus?.status || 'unknown',
      renewalState: route.certificateStatus?.renewalState || 'unknown',
      lastError: route.certificateStatus?.lastError || '',
      servedIssuer: route.certificateStatus?.servedIssuer || '',
      servedSubject: route.certificateStatus?.servedSubject || '',
      servedNotAfter: route.certificateStatus?.servedNotAfter || null,
      lastCheckedAt: route.certificateStatus?.lastCheckedAt || null
    }));
  }

  async canIssueCertificate(domain) {
    const settings = await this.getSettings();
    if (!settings.onDemandTlsEnabled) {
      return false;
    }

    let normalizedDomain;
    try {
      normalizedDomain = normalizeHostname(domain);
    } catch (_error) {
      return false;
    }

    const route = await ReverseProxyRoute.findOne({ hostname: normalizedDomain }).lean();
    if (!route) {
      return false;
    }

    if (!route.enabled || route.tlsMode !== 'on_demand' || route.allowOnDemandTls !== true) {
      return false;
    }

    const certificateStatus = route.certificateStatus || {};
    return Boolean(certificateStatus.ownershipVerified || certificateStatus.adminApproved);
  }
}

module.exports = new ReverseProxyService();
