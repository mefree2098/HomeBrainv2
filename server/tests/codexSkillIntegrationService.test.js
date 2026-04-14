const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const CodexSkillIntegration = require('../models/CodexSkillIntegration');
const codexSkillIntegrationService = require('../services/codexSkillIntegrationService');
const UserService = require('../services/userService');

test('buildConnectionBundle includes env exports and helper metadata', async () => {
  const bundle = await codexSkillIntegrationService.buildConnectionBundle(
    {
      protocol: 'https',
      secure: true,
      headers: { host: 'homebrain.example.com' },
      get(name) {
        return name.toLowerCase() === 'host' ? 'homebrain.example.com' : undefined;
      }
    },
    {
      integration: {
        publishedBaseUrl: 'https://homebrain.example.com'
      },
      token: 'hbcdx_live_test_token'
    }
  );

  assert.equal(bundle.baseUrl, 'https://homebrain.example.com');
  assert.match(bundle.exportSnippet, /HOMEBRAIN_CODEX_URL/);
  assert.match(bundle.exportSnippet, /hbcdx_live_test_token/);
  assert.equal(bundle.helper.relativePath, 'scripts/homebrain-live.js');
  assert.equal(bundle.skill.directory, 'homebrain-live');
});

test('rotateToken hashes and stores a new HomeBrain Codex skill token', async (t) => {
  const originalGetIntegration = CodexSkillIntegration.getIntegration;

  t.after(() => {
    CodexSkillIntegration.getIntegration = originalGetIntegration;
  });

  const integration = {
    enabled: true,
    displayName: 'Test Codex Integration',
    tokenHash: '',
    tokenPrefix: '',
    tokenCreatedAt: null,
    tokenRotatedAt: null,
    issuedToUserId: null,
    issuedToEmail: '',
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
        tokenRotatedAt: this.tokenRotatedAt,
        issuedToEmail: this.issuedToEmail
      };
    }
  };

  CodexSkillIntegration.getIntegration = async () => integration;

  const result = await codexSkillIntegrationService.rotateToken({
    actor: 'tester@homebrain',
    user: {
      _id: '507f1f77bcf86cd799439011',
      email: 'tester@homebrain'
    }
  });

  assert.match(result.token, /^hbcdx_live_/);
  assert.equal(integration.createdBy, 'tester@homebrain');
  assert.equal(String(integration.issuedToUserId), '507f1f77bcf86cd799439011');
  assert.equal(integration.issuedToEmail, 'tester@homebrain');
  assert.equal(await bcrypt.compare(result.token, integration.tokenHash), true);
  assert.match(integration.tokenPrefix, /^hbcdx_live_/);
  assert.ok(integration.tokenCreatedAt instanceof Date);
  assert.ok(integration.tokenRotatedAt instanceof Date);
  assert.equal(result.integration.tokenConfigured, true);
});

test('verifyToken accepts valid tokens and records last use metadata', async (t) => {
  const originalGetIntegration = CodexSkillIntegration.getIntegration;

  t.after(() => {
    CodexSkillIntegration.getIntegration = originalGetIntegration;
  });

  const rawToken = 'hbcdx_live_valid_token';
  const integration = {
    enabled: true,
    issuedToUserId: '507f1f77bcf86cd799439011',
    tokenHash: await bcrypt.hash(rawToken, 12),
    lastUsedAt: null,
    lastUsedIp: '',
    lastUserAgent: '',
    async save() {
      return this;
    }
  };

  CodexSkillIntegration.getIntegration = async () => integration;

  const verified = await codexSkillIntegrationService.verifyToken(rawToken, {
    headers: {
      'x-forwarded-for': '203.0.113.10, 10.0.0.3',
      'user-agent': 'Codex/Test'
    }
  });

  assert.equal(verified, integration);
  assert.ok(integration.lastUsedAt instanceof Date);
  assert.equal(integration.lastUsedIp, '203.0.113.10');
  assert.equal(integration.lastUserAgent, 'Codex/Test');

  await assert.rejects(
    () => codexSkillIntegrationService.verifyToken('hbcdx_live_wrong_token'),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, 'Invalid Codex skill token');
      return true;
    }
  );
});

test('resolveAuthenticatedUser returns the bound HomeBrain user', async (t) => {
  const originalGetIntegration = CodexSkillIntegration.getIntegration;
  const originalUserGet = UserService.get;

  t.after(() => {
    CodexSkillIntegration.getIntegration = originalGetIntegration;
    UserService.get = originalUserGet;
  });

  const rawToken = 'hbcdx_live_bound_token';
  CodexSkillIntegration.getIntegration = async () => ({
    enabled: true,
    issuedToUserId: '507f1f77bcf86cd799439011',
    tokenHash: await bcrypt.hash(rawToken, 12),
    async save() {
      return this;
    }
  });

  const user = {
    _id: '507f1f77bcf86cd799439011',
    email: 'admin@example.com',
    role: 'admin',
    isActive: true,
    platforms: {
      homebrain: true,
      axiom: true
    }
  };
  UserService.get = async () => user;

  const resolved = await codexSkillIntegrationService.resolveAuthenticatedUser(rawToken, {
    headers: {
      'user-agent': 'Codex/Test'
    }
  });

  assert.equal(resolved.user, user);
});

test('currentTokenMatches accepts the current raw token without requiring the integration to be enabled', async (t) => {
  const originalGetIntegration = CodexSkillIntegration.getIntegration;

  t.after(() => {
    CodexSkillIntegration.getIntegration = originalGetIntegration;
  });

  const rawToken = 'hbcdx_live_current_token';
  CodexSkillIntegration.getIntegration = async () => ({
    enabled: false,
    tokenHash: await bcrypt.hash(rawToken, 12)
  });

  assert.equal(await codexSkillIntegrationService.currentTokenMatches(rawToken), true);
  assert.equal(await codexSkillIntegrationService.currentTokenMatches('hbcdx_live_wrong'), false);
});
