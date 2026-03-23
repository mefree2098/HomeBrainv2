const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const oidcService = require('../services/oidcService');
const OIDCProviderSettings = require('../models/OIDCProviderSettings');
const OIDCClient = require('../models/OIDCClient');
const OIDCAuthorizationCode = require('../models/OIDCAuthorizationCode');
const UserService = require('../services/userService');

function createMockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    redirectUrl: '',
    cookies: [],
    setHeader(name, value) {
      this.headers[name] = value;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
    },
    clearCookie(name, options) {
      this.cookies.push({ name, value: '', options, cleared: true });
    },
    redirect(statusOrUrl, maybeUrl) {
      if (typeof statusOrUrl === 'number') {
        this.statusCode = statusOrUrl;
        this.redirectUrl = maybeUrl;
      } else {
        this.statusCode = 302;
        this.redirectUrl = statusOrUrl;
      }
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

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

test('ensureBootstrapState seeds signing keys and the default Axiom client', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalCreate = OIDCClient.create;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const originalRedirectUri = process.env.OIDC_AXIOM_REDIRECT_URI;
  const originalClientId = process.env.OIDC_AXIOM_CLIENT_ID;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    OIDCClient.create = originalCreate;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
    process.env.OIDC_AXIOM_REDIRECT_URI = originalRedirectUri;
    process.env.OIDC_AXIOM_CLIENT_ID = originalClientId;
  });

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://freestonefamily.com';
  delete process.env.OIDC_AXIOM_REDIRECT_URI;
  delete process.env.OIDC_AXIOM_CLIENT_ID;

  let saved = false;
  OIDCProviderSettings.getSettings = async () => ({
    signingKeyId: '',
    signingPublicKeyPem: '',
    signingPrivateKeyPem: '',
    updatedBy: 'system',
    async save() {
      saved = true;
      return this;
    }
  });

  OIDCClient.findOne = async () => null;

  let createdClient = null;
  OIDCClient.create = async (payload) => {
    createdClient = payload;
    return payload;
  };

  const result = await oidcService.ensureBootstrapState({ actor: 'system:test-bootstrap' });

  assert.equal(saved, true);
  assert.deepEqual(result.settingsUpdated, ['signingKeys']);
  assert.deepEqual(result.createdClients, ['homebrain-axiom']);
  assert.equal(createdClient.clientId, 'homebrain-axiom');
  assert.deepEqual(createdClient.redirectUris, ['https://mail.freestonefamily.com/api/identity/homebrain/callback']);
  assert.equal(createdClient.requirePkce, true);
  assert.equal(createdClient.tokenEndpointAuthMethod, 'none');
});

test('handleAuthorize redirects an authenticated HomeBrain session back to the client callback', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalCodeCreate = OIDCAuthorizationCode.create;
  const originalUserGet = UserService.get;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    OIDCAuthorizationCode.create = originalCodeCreate;
    UserService.get = originalUserGet;
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://freestonefamily.com';

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
    async save() {
      return this;
    }
  });

  const client = {
    clientId: 'homebrain-axiom',
    platform: 'axiom',
    enabled: true,
    redirectUris: ['https://mail.freestonefamily.com/api/identity/homebrain/callback'],
    scopes: ['openid', 'profile', 'email'],
    requirePkce: true,
    tokenEndpointAuthMethod: 'none',
    async save() {
      return this;
    }
  };
  OIDCClient.findOne = async () => client;

  const user = {
    _id: '507f1f77bcf86cd799439011',
    email: 'matt@freestonefamily.com',
    role: 'admin',
    lastLoginAt: new Date('2026-03-12T19:00:00.000Z')
  };
  UserService.get = async () => user;

  let storedCode = null;
  OIDCAuthorizationCode.create = async (payload) => {
    storedCode = payload;
    return payload;
  };

  const accessToken = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
  const req = {
    query: {
      response_type: 'code',
      client_id: 'homebrain-axiom',
      redirect_uri: 'https://mail.freestonefamily.com/api/identity/homebrain/callback',
      scope: 'openid profile email',
      state: 'state-123',
      nonce: 'nonce-456',
      code_challenge: crypto.createHash('sha256').update('verifier-123').digest('base64url'),
      code_challenge_method: 'S256'
    },
    headers: {
      cookie: `hbAccessToken=${encodeURIComponent(accessToken)}`
    },
    originalUrl: '/oauth/authorize?response_type=code'
  };
  const res = createMockResponse();

  await oidcService.handleAuthorize(req, res);

  assert.equal(res.statusCode, 302);
  assert.match(res.redirectUrl, /^https:\/\/mail\.freestonefamily\.com\/api\/identity\/homebrain\/callback\?/);

  const redirectUrl = new URL(res.redirectUrl);
  assert.equal(redirectUrl.searchParams.get('state'), 'state-123');
  assert.ok(redirectUrl.searchParams.get('code'));
  assert.equal(storedCode.clientId, 'homebrain-axiom');
  assert.equal(storedCode.redirectUri, 'https://mail.freestonefamily.com/api/identity/homebrain/callback');
  assert.deepEqual(storedCode.scopes, ['openid', 'profile', 'email']);
  assert.equal(storedCode.nonce, 'nonce-456');
});

test('handleAuthorize returns login_required when prompt=none has no active HomeBrain session', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_TOKEN_SECRET;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.REFRESH_TOKEN_SECRET = originalRefreshSecret;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://freestonefamily.com';

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
    async save() {
      return this;
    }
  });

  OIDCClient.findOne = async () => ({
    clientId: 'homebrain-axiom',
    platform: 'axiom',
    enabled: true,
    redirectUris: ['https://mail.freestonefamily.com/api/identity/homebrain/callback'],
    scopes: ['openid', 'profile', 'email'],
    requirePkce: true,
    tokenEndpointAuthMethod: 'none',
    async save() {
      return this;
    }
  });

  const req = {
    query: {
      response_type: 'code',
      client_id: 'homebrain-axiom',
      redirect_uri: 'https://mail.freestonefamily.com/api/identity/homebrain/callback',
      scope: 'openid profile email',
      state: 'state-123',
      prompt: 'none',
      code_challenge: crypto.createHash('sha256').update('verifier-123').digest('base64url'),
      code_challenge_method: 'S256'
    },
    headers: {}
  };
  const res = createMockResponse();

  await oidcService.handleAuthorize(req, res);

  assert.equal(res.statusCode, 302);
  assert.match(res.redirectUrl, /^https:\/\/mail\.freestonefamily\.com\/api\/identity\/homebrain\/callback\?/);
  const redirectUrl = new URL(res.redirectUrl);
  assert.equal(redirectUrl.searchParams.get('error'), 'login_required');
  assert.equal(redirectUrl.searchParams.get('state'), 'state-123');
});

test('handleToken exchanges a valid PKCE authorization code for signed OIDC tokens', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalFindOneAndUpdate = OIDCAuthorizationCode.findOneAndUpdate;
  const originalUserGet = UserService.get;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    OIDCAuthorizationCode.findOneAndUpdate = originalFindOneAndUpdate;
    UserService.get = originalUserGet;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://freestonefamily.com';

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
    async save() {
      return this;
    }
  });

  OIDCClient.findOne = async () => ({
    clientId: 'homebrain-axiom',
    platform: 'axiom',
    enabled: true,
    redirectUris: ['https://mail.freestonefamily.com/api/identity/homebrain/callback'],
    scopes: ['openid', 'profile', 'email'],
    requirePkce: true,
    tokenEndpointAuthMethod: 'none',
    async save() {
      return this;
    }
  });

  const codeVerifier = 'verifier-123';
  OIDCAuthorizationCode.findOneAndUpdate = async () => ({
    clientId: 'homebrain-axiom',
    redirectUri: 'https://mail.freestonefamily.com/api/identity/homebrain/callback',
    scopes: ['openid', 'profile', 'email'],
    nonce: 'nonce-456',
    codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
    codeChallengeMethod: 'S256',
    userId: '507f1f77bcf86cd799439011',
    authTime: new Date('2026-03-12T19:00:00.000Z')
  });

  const user = {
    _id: '507f1f77bcf86cd799439011',
    email: 'matt@freestonefamily.com',
    role: 'admin',
    lastLoginAt: new Date('2026-03-12T19:00:00.000Z')
  };
  UserService.get = async () => user;

  const req = {
    body: {
      grant_type: 'authorization_code',
      client_id: 'homebrain-axiom',
      code: 'raw-code-123',
      redirect_uri: 'https://mail.freestonefamily.com/api/identity/homebrain/callback',
      code_verifier: codeVerifier
    },
    headers: {}
  };
  const res = createMockResponse();

  await oidcService.handleToken(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.token_type, 'Bearer');
  assert.ok(res.body.access_token);
  assert.ok(res.body.id_token);

  const decodedIdToken = jwt.verify(res.body.id_token, providerKeys.signingPublicKeyPem, {
    algorithms: ['RS256'],
    issuer: 'https://freestonefamily.com',
    audience: 'homebrain-axiom'
  });

  assert.equal(decodedIdToken.sub, user._id);
  assert.equal(decodedIdToken.email, user.email);
  assert.equal(decodedIdToken.nonce, 'nonce-456');
});

test('verifyIssuedAccessToken accepts HomeBrain-issued bearer access tokens', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://freestonefamily.com';

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
    async save() {
      return this;
    }
  });

  const accessToken = jwt.sign(
    {
      sub: '507f1f77bcf86cd799439011',
      email: 'matt@freestonefamily.com',
      role: 'admin',
      token_use: 'access'
    },
    providerKeys.signingPrivateKeyPem,
    {
      algorithm: 'RS256',
      keyid: providerKeys.signingKeyId,
      issuer: 'https://freestonefamily.com',
      audience: 'homebrain-axiom',
      expiresIn: 3600
    }
  );

  const decoded = await oidcService.verifyIssuedAccessToken({
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  assert.equal(decoded.sub, '507f1f77bcf86cd799439011');
  assert.equal(decoded.email, 'matt@freestonefamily.com');
  assert.equal(decoded.role, 'admin');
});
