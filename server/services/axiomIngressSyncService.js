const OIDCClient = require('../models/OIDCClient');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const oidcService = require('./oidcService');
const reverseProxyService = require('./reverseProxyService');

const DEFAULT_AXIOM_UPSTREAM_PORT = Number(process.env.AXIOM_UPSTREAM_PORT || 4174);
const DEFAULT_AXIOM_MANIFEST_PORT = Number(process.env.AXIOM_HOMEBRAIN_MANIFEST_PORT || process.env.AXIOM_API_PORT || 3001);
const DEFAULT_AXIOM_MANIFEST_URL = `http://127.0.0.1:${DEFAULT_AXIOM_MANIFEST_PORT}/internal/deployment/homebrain-manifest`;
const MANAGED_AXIOM_ROUTE_NOTES = 'Managed automatically from Axiom mail domains.';

function trimString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim();
}

function uniqueSortedStrings(values) {
  return Array.from(new Set((values || []).map((value) => trimString(value)).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
}

function normalizeHostname(value) {
  return trimString(value).toLowerCase().replace(/\.+$/, '');
}

function normalizeAbsoluteUrl(value) {
  const candidate = trimString(value).replace(/\/+$/, '');
  if (!candidate) {
    return '';
  }

  try {
    return new URL(candidate).toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function getManifestUrl() {
  return trimString(process.env.AXIOM_HOMEBRAIN_MANIFEST_URL, DEFAULT_AXIOM_MANIFEST_URL);
}

function getAxiomClientId() {
  return trimString(process.env.OIDC_AXIOM_CLIENT_ID, oidcService.DEFAULT_CLIENT_ID);
}

function buildFallbackAxiomPreset() {
  return {
    platformKey: 'axiom',
    displayName: 'Axiom',
    upstreamProtocol: 'http',
    upstreamHost: trimString(process.env.AXIOM_UPSTREAM_HOST, '127.0.0.1'),
    upstreamPort: DEFAULT_AXIOM_UPSTREAM_PORT,
    healthCheckPath: '/healthz',
    websocketSupport: true,
    tlsMode: 'automatic'
  };
}

function buildManagedAxiomRoute(hostname, preset) {
  return {
    hostname,
    platformKey: 'axiom',
    displayName: trimString(preset.displayName, 'Axiom'),
    upstreamProtocol: preset.upstreamProtocol === 'https' ? 'https' : 'http',
    upstreamHost: trimString(preset.upstreamHost, '127.0.0.1'),
    upstreamPort: Number(preset.upstreamPort || DEFAULT_AXIOM_UPSTREAM_PORT),
    enabled: true,
    tlsMode: ['automatic', 'internal', 'manual', 'on_demand'].includes(preset.tlsMode)
      ? preset.tlsMode
      : 'automatic',
    allowOnDemandTls: false,
    allowPublicUpstream: false,
    healthCheckPath: trimString(preset.healthCheckPath, '/healthz'),
    websocketSupport: typeof preset.websocketSupport === 'boolean' ? preset.websocketSupport : true,
    stripPrefix: '',
    notes: MANAGED_AXIOM_ROUTE_NOTES
  };
}

function routeNeedsUpdate(route, desired) {
  const current = route.toObject ? route.toObject() : { ...route };
  const comparableKeys = [
    'platformKey',
    'displayName',
    'upstreamProtocol',
    'upstreamHost',
    'upstreamPort',
    'enabled',
    'tlsMode',
    'allowOnDemandTls',
    'allowPublicUpstream',
    'healthCheckPath',
    'websocketSupport',
    'stripPrefix',
    'notes'
  ];

  return comparableKeys.some((key) => current[key] !== desired[key]);
}

function arraysEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fetchAxiomManifest() {
  const manifestUrl = getManifestUrl();
  const response = await fetch(manifestUrl, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Axiom manifest fetch failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const mailHosts = uniqueSortedStrings((payload?.mailHosts || []).map((host) => normalizeHostname(host)));
  const redirectUris = uniqueSortedStrings(
    (payload?.homeBrainRedirectUris || []).map((redirectUri) => normalizeAbsoluteUrl(redirectUri))
  );

  if (mailHosts.length === 0) {
    throw new Error('Axiom manifest did not include any mail hosts.');
  }

  if (redirectUris.length === 0) {
    throw new Error('Axiom manifest did not include any HomeBrain redirect URIs.');
  }

  return {
    manifestUrl,
    generatedAt: trimString(payload?.generatedAt),
    mailHosts,
    redirectUris
  };
}

async function resolveAxiomPreset() {
  const presets = await reverseProxyService.getRoutePresets();
  return presets.find((preset) => preset.platformKey === 'axiom') || buildFallbackAxiomPreset();
}

async function syncManagedRoutes(manifest, actor) {
  const preset = await resolveAxiomPreset();
  const existingRoutes = await ReverseProxyRoute.find({ platformKey: 'axiom' }).sort({ hostname: 1 });
  const existingByHostname = new Map(existingRoutes.map((route) => [route.hostname, route]));
  const created = [];
  const updated = [];
  const deleted = [];

  for (const hostname of manifest.mailHosts) {
    const desired = buildManagedAxiomRoute(hostname, preset);
    const existing = existingByHostname.get(hostname);

    if (!existing) {
      await reverseProxyService.createRoute(desired, actor);
      created.push(hostname);
      continue;
    }

    if (routeNeedsUpdate(existing, desired)) {
      await reverseProxyService.updateRoute(existing._id, desired, actor);
      updated.push(hostname);
    }

    existingByHostname.delete(hostname);
  }

  for (const staleRoute of existingByHostname.values()) {
    await reverseProxyService.deleteRoute(staleRoute._id, actor);
    deleted.push(staleRoute.hostname);
  }

  return {
    created,
    updated,
    deleted,
    managedHosts: [...manifest.mailHosts]
  };
}

async function syncAxiomRedirectUris(manifest, actor) {
  await oidcService.ensureBootstrapState({ actor });

  const clientId = getAxiomClientId();
  const desiredRedirectUris = [...manifest.redirectUris];
  let client = await OIDCClient.findOne({ clientId });
  let created = false;
  const updatedFields = [];

  if (!client) {
    client = await OIDCClient.create({
      clientId,
      name: 'Axiom',
      platform: 'axiom',
      enabled: true,
      redirectUris: desiredRedirectUris,
      scopes: [...oidcService.SUPPORTED_SCOPES],
      requirePkce: true,
      tokenEndpointAuthMethod: 'none',
      updatedBy: actor
    });
    created = true;
  } else {
    const currentRedirectUris = uniqueSortedStrings(
      (client.redirectUris || []).map((redirectUri) => normalizeAbsoluteUrl(redirectUri))
    );

    if (!arraysEqual(currentRedirectUris, desiredRedirectUris)) {
      client.redirectUris = desiredRedirectUris;
      updatedFields.push('redirectUris');
    }

    if (trimString(client.name) !== 'Axiom') {
      client.name = 'Axiom';
      updatedFields.push('name');
    }

    if (trimString(client.platform) !== 'axiom') {
      client.platform = 'axiom';
      updatedFields.push('platform');
    }

    if (client.enabled !== true) {
      client.enabled = true;
      updatedFields.push('enabled');
    }

    const currentScopes = uniqueSortedStrings(client.scopes || []);
    const desiredScopes = uniqueSortedStrings(oidcService.SUPPORTED_SCOPES);
    if (!arraysEqual(currentScopes, desiredScopes)) {
      client.scopes = [...oidcService.SUPPORTED_SCOPES];
      updatedFields.push('scopes');
    }

    if (client.requirePkce !== true) {
      client.requirePkce = true;
      updatedFields.push('requirePkce');
    }

    if (trimString(client.tokenEndpointAuthMethod) !== 'none') {
      client.tokenEndpointAuthMethod = 'none';
      updatedFields.push('tokenEndpointAuthMethod');
    }

    if (updatedFields.length > 0) {
      client.updatedBy = actor;
      await client.save();
    }
  }

  return {
    clientId,
    created,
    updated: updatedFields.length > 0,
    updatedFields,
    redirectUris: desiredRedirectUris
  };
}

class AxiomIngressSyncService {
  async sync({ actor = 'system:axiom-sync', reason = 'manual' } = {}) {
    const manifest = await fetchAxiomManifest();
    const routeSummary = await syncManagedRoutes(manifest, actor);
    const oidcSummary = await syncAxiomRedirectUris(manifest, actor);
    const applySummary = await reverseProxyService.applyConfig(actor);

    return {
      manifest: {
        manifestUrl: manifest.manifestUrl,
        generatedAt: manifest.generatedAt || null,
        mailHosts: manifest.mailHosts,
        redirectUris: manifest.redirectUris
      },
      reason: trimString(reason, 'manual'),
      routes: routeSummary,
      oidc: oidcSummary,
      reverseProxy: {
        appliedAt: applySummary.appliedAt,
        appliedRoutes: applySummary.appliedRoutes || []
      }
    };
  }
}

module.exports = new AxiomIngressSyncService();
