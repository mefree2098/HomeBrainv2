#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) {
      continue;
    }

    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }

    flags[key] = next;
    index += 1;
  }
  return flags;
}

function trimString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizePublicUrl(value) {
  const candidate = trimString(value).replace(/\/+$/, '');
  if (!candidate) {
    return '';
  }

  try {
    return new URL(candidate).origin;
  } catch (_error) {
    return '';
  }
}

const flags = parseArgs(process.argv.slice(2));
const publicUrl = normalizePublicUrl(flags['public-url'] || process.env.AUDIOBOOK_PUBLIC_BASE_URL || process.env.AUDIOBOOK_PUBLIC_URL);
if (publicUrl) {
  process.env.AUDIOBOOK_PUBLIC_BASE_URL = publicUrl;
  process.env.AUDIOBOOK_PUBLIC_HOST = new URL(publicUrl).hostname;
}

if (flags['upstream-host']) {
  process.env.AUDIOBOOK_UPSTREAM_HOST = trimString(flags['upstream-host']);
}
if (flags['upstream-port']) {
  process.env.AUDIOBOOK_UPSTREAM_PORT = trimString(flags['upstream-port']);
}
if (flags['client-id']) {
  process.env.OIDC_AUDIOBOOK_CLIENT_ID = trimString(flags['client-id']);
}

const initDb = require('../models/init');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const oidcService = require('../services/oidcService');
const reverseProxyService = require('../services/reverseProxyService');

function buildRoutePayload({ enabled }) {
  const targetUrl = normalizePublicUrl(process.env.AUDIOBOOK_PUBLIC_BASE_URL);
  if (!targetUrl) {
    throw new Error('AUDIOBOOK_PUBLIC_BASE_URL or --public-url is required.');
  }

  const parsed = new URL(targetUrl);
  return {
    hostname: parsed.hostname,
    platformKey: 'audiobook',
    displayName: 'Audiobook Studio',
    upstreamProtocol: 'http',
    upstreamHost: trimString(process.env.AUDIOBOOK_UPSTREAM_HOST, '127.0.0.1'),
    upstreamPort: Number(process.env.AUDIOBOOK_UPSTREAM_PORT || 8787),
    healthCheckPath: '/api/health',
    websocketSupport: true,
    tlsMode: 'automatic',
    enabled,
    notes: 'Managed by the Audiobook Studio installer.'
  };
}

async function ensureRoute(payload, actor) {
  const existing = await ReverseProxyRoute.findOne({ hostname: payload.hostname });
  if (!existing) {
    const created = await reverseProxyService.createRoute(payload, actor);
    return {
      action: 'created',
      hostname: created.hostname,
      enabled: created.enabled
    };
  }

  const updated = await reverseProxyService.updateRoute(existing._id, payload, actor);
  return {
    action: 'updated',
    hostname: updated.hostname,
    enabled: updated.enabled
  };
}

async function main() {
  const actor = trimString(flags.actor, 'system:audiobook-bootstrap');
  const enableRoute = parseBoolean(flags['enable-route'], true);
  const applyCaddy = parseBoolean(flags['apply-caddy'], false);

  console.log(`Bootstrapping Audiobook integration as ${actor}...`);
  await initDb();

  try {
    const identity = await oidcService.ensureBootstrapState({ actor });
    const route = await ensureRoute(buildRoutePayload({ enabled: enableRoute }), actor);
    const apply = applyCaddy ? await reverseProxyService.applyConfig(actor) : null;

    console.log(`Identity settings updated: ${identity.settingsUpdated.length > 0 ? identity.settingsUpdated.join(', ') : 'none'}`);
    console.log(`OIDC clients created: ${identity.createdClients.length > 0 ? identity.createdClients.join(', ') : 'none'}`);
    console.log(`OIDC clients updated: ${identity.updatedClients.length > 0 ? identity.updatedClients.join(', ') : 'none'}`);
    console.log(`Route ${route.action}: ${route.hostname} enabled=${route.enabled ? 'yes' : 'no'}`);
    if (apply) {
      console.log(`Caddy applied: ${apply.appliedRoutes.join(', ') || 'no routes'}`);
    }
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Audiobook integration bootstrap failed: ${error.message}`);
  process.exit(1);
});
