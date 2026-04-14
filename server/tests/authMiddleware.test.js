const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const authMiddleware = require('../routes/middlewares/auth');
const authSessionService = require('../services/authSessionService');
const codexSkillIntegrationService = require('../services/codexSkillIntegrationService');
const oidcService = require('../services/oidcService');
const OIDCProviderSettings = require('../models/OIDCProviderSettings');
const UserService = require('../services/userService');

function generateProviderKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  return {
    signingKeyId: crypto.createHash('sha256').update(publicKey).digest('base64url').slice(0, 24),
    signingPublicKeyPem: publicKey,
    signingPrivateKeyPem: privateKey
  };
}

test('verifyAccessToken accepts HomeBrain-issued OIDC access tokens for admin routes', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalUserGet = UserService.get;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    UserService.get = originalUserGet;
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  process.env.JWT_SECRET = 'legacy-jwt-secret';
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
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

  const accessToken = jwt.sign(
    {
      sub: user._id,
      email: user.email,
      role: user.role,
      token_use: 'access'
    },
    providerKeys.signingPrivateKeyPem,
    {
      algorithm: 'RS256',
      keyid: providerKeys.signingKeyId,
      issuer: process.env.HOMEBRAIN_PUBLIC_BASE_URL,
      audience: 'homebrain-axiom',
      expiresIn: '1h'
    }
  );

  const verified = await authMiddleware.verifyAccessToken(accessToken, ['admin'], {
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    get(header) {
      return header === 'host' ? 'example.com' : undefined;
    },
    protocol: 'https',
    secure: true
  });

  assert.equal(String(verified._id), user._id);
  assert.equal(verified.email, user.email);
});

test('verifyAccessToken rejects HomeBrain access when the user only has Axiom enabled', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalUserGet = UserService.get;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    UserService.get = originalUserGet;
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  process.env.JWT_SECRET = 'legacy-jwt-secret';
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
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
      homebrain: false,
      axiom: true
    }
  };
  UserService.get = async () => user;

  const accessToken = jwt.sign(
    {
      sub: user._id,
      email: user.email,
      role: user.role,
      token_use: 'access'
    },
    providerKeys.signingPrivateKeyPem,
    {
      algorithm: 'RS256',
      keyid: providerKeys.signingKeyId,
      issuer: process.env.HOMEBRAIN_PUBLIC_BASE_URL,
      audience: 'homebrain-axiom',
      expiresIn: '1h'
    }
  );

  await assert.rejects(
    () => authMiddleware.verifyAccessToken(accessToken, ['admin'], {
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      get(header) {
        return header === 'host' ? 'example.com' : undefined;
      },
      protocol: 'https',
      secure: true
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.message, 'HomeBrain access is not enabled for this account');
      return true;
    }
  );
});

test('verifyAccessToken rejects a valid JWT when its session has been revoked', async (t) => {
  const originalUserGet = UserService.get;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalAssertSessionActive = authSessionService.assertSessionActive;

  t.after(() => {
    UserService.get = originalUserGet;
    process.env.JWT_SECRET = originalJwtSecret;
    authSessionService.assertSessionActive = originalAssertSessionActive;
  });

  process.env.JWT_SECRET = 'legacy-jwt-secret';

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
  authSessionService.assertSessionActive = async () => {
    const error = new Error('Session has been revoked');
    error.status = 401;
    throw error;
  };

  const accessToken = jwt.sign(
    {
      sub: user._id,
      sid: 'session-ios-1'
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '1h'
    }
  );

  await assert.rejects(
    () => authMiddleware.verifyAccessToken(accessToken, ['admin']),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, 'Session has been revoked');
      return true;
    }
  );
});

test('verifyAccessToken accepts a HomeBrain Codex skill token for admin routes', async (t) => {
  const originalLooksLikeCodexToken = codexSkillIntegrationService.looksLikeCodexSkillToken;
  const originalResolveAuthenticatedUser = codexSkillIntegrationService.resolveAuthenticatedUser;

  t.after(() => {
    codexSkillIntegrationService.looksLikeCodexSkillToken = originalLooksLikeCodexToken;
    codexSkillIntegrationService.resolveAuthenticatedUser = originalResolveAuthenticatedUser;
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

  codexSkillIntegrationService.looksLikeCodexSkillToken = () => true;
  codexSkillIntegrationService.resolveAuthenticatedUser = async () => ({
    integration: {
      displayName: 'HomeBrain Codex Live Admin'
    },
    user
  });

  const verified = await authMiddleware.verifyAccessToken('hbcdx_live_token', ['admin'], {
    headers: {
      authorization: 'Bearer hbcdx_live_token'
    }
  });

  assert.equal(String(verified._id), user._id);
  assert.equal(verified.email, user.email);
});
