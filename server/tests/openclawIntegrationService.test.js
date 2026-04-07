const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const OpenClawIntegration = require('../models/OpenClawIntegration');
const openclawIntegrationService = require('../services/openclawIntegrationService');

test('buildServerDefinition returns OpenClaw-compatible streamable-http config', () => {
  const definition = openclawIntegrationService.buildServerDefinition(
    'https://homebrain.example.com',
    'hboc_live_test'
  );

  assert.deepEqual(definition, {
    url: 'https://homebrain.example.com/api/openclaw/mcp',
    transport: 'streamable-http',
    headers: {
      Authorization: 'Bearer hboc_live_test'
    },
    connectionTimeoutMs: 10000
  });

  const cliCommand = openclawIntegrationService.buildCliCommand(definition);
  assert.match(cliCommand, /^openclaw mcp set homebrain-admin '/);
  assert.match(cliCommand, /"transport":"streamable-http"/);
});

test('extractBearerToken only accepts Authorization header tokens', () => {
  assert.equal(
    openclawIntegrationService.extractBearerToken({
      headers: {
        authorization: 'Bearer hboc_live_header_token'
      },
      query: {
        token: 'hboc_live_query_token'
      }
    }),
    'hboc_live_header_token'
  );

  assert.equal(
    openclawIntegrationService.extractBearerToken({
      headers: {},
      query: {
        token: 'hboc_live_query_token'
      }
    }),
    null
  );
});

test('resolveBaseUrl prefers the stored published HomeBrain URL over request host', () => {
  const resolved = openclawIntegrationService.resolveBaseUrl(
    {
      protocol: 'http',
      secure: false,
      headers: { host: 'internal.local:3000' },
      get(name) {
        return name.toLowerCase() === 'host' ? 'internal.local:3000' : undefined;
      }
    },
    '',
    {
      publishedBaseUrl: 'https://homebrain.example.com'
    }
  );

  assert.equal(resolved, 'https://homebrain.example.com');
});

test('rotateToken hashes and stores a new HomeBrain OpenClaw token', async (t) => {
  const originalGetIntegration = OpenClawIntegration.getIntegration;

  t.after(() => {
    OpenClawIntegration.getIntegration = originalGetIntegration;
  });

  const integration = {
    enabled: true,
    displayName: 'Test Integration',
    tokenHash: '',
    tokenPrefix: '',
    tokenCreatedAt: null,
    tokenRotatedAt: null,
    createdBy: 'system',
    async save() {
      return this;
    },
    toSanitized() {
      return {
        enabled: this.enabled,
        displayName: this.displayName,
        tokenConfigured: Boolean(this.tokenPrefix && this.tokenCreatedAt),
        tokenPrefix: this.tokenPrefix,
        tokenCreatedAt: this.tokenCreatedAt,
        tokenRotatedAt: this.tokenRotatedAt
      };
    }
  };

  OpenClawIntegration.getIntegration = async () => integration;

  const result = await openclawIntegrationService.rotateToken({ actor: 'tester@homebrain' });

  assert.match(result.token, /^hboc_live_/);
  assert.equal(integration.createdBy, 'tester@homebrain');
  assert.equal(await bcrypt.compare(result.token, integration.tokenHash), true);
  assert.match(integration.tokenPrefix, /^hboc_live_/);
  assert.ok(integration.tokenCreatedAt instanceof Date);
  assert.ok(integration.tokenRotatedAt instanceof Date);
  assert.equal(result.integration.tokenConfigured, true);
});

test('verifyToken accepts valid tokens and records last use metadata', async (t) => {
  const originalGetIntegration = OpenClawIntegration.getIntegration;

  t.after(() => {
    OpenClawIntegration.getIntegration = originalGetIntegration;
  });

  const rawToken = 'hboc_live_valid_token';
  const integration = {
    enabled: true,
    tokenHash: await bcrypt.hash(rawToken, 12),
    lastUsedAt: null,
    lastUsedIp: '',
    lastUserAgent: '',
    async save() {
      return this;
    }
  };

  OpenClawIntegration.getIntegration = async () => integration;

  const verified = await openclawIntegrationService.verifyToken(rawToken, {
    headers: {
      'x-forwarded-for': '203.0.113.10, 10.0.0.3',
      'user-agent': 'OpenClaw/Test'
    }
  });

  assert.equal(verified, integration);
  assert.ok(integration.lastUsedAt instanceof Date);
  assert.equal(integration.lastUsedIp, '203.0.113.10');
  assert.equal(integration.lastUserAgent, 'OpenClaw/Test');

  await assert.rejects(
    () => openclawIntegrationService.verifyToken('hboc_live_wrong_token'),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, 'Invalid OpenClaw integration token');
      return true;
    }
  );
});

test('currentTokenMatches accepts the current raw token without requiring the integration to be enabled', async (t) => {
  const originalGetIntegration = OpenClawIntegration.getIntegration;

  t.after(() => {
    OpenClawIntegration.getIntegration = originalGetIntegration;
  });

  const rawToken = 'hboc_live_current_token';
  OpenClawIntegration.getIntegration = async () => ({
    enabled: false,
    tokenHash: await bcrypt.hash(rawToken, 12)
  });

  assert.equal(await openclawIntegrationService.currentTokenMatches(rawToken), true);
  assert.equal(await openclawIntegrationService.currentTokenMatches('hboc_live_wrong'), false);
});
