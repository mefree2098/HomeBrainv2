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

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

test('ensureBootstrapState seeds signing keys and the default Axiom client', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalCreate = OIDCClient.create;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const originalRedirectUri = process.env.OIDC_AXIOM_REDIRECT_URI;
  const originalClientId = process.env.OIDC_AXIOM_CLIENT_ID;
  const originalAudiobookPublicBaseUrl = process.env.AUDIOBOOK_PUBLIC_BASE_URL;
  const originalAudiobookPublicHost = process.env.AUDIOBOOK_PUBLIC_HOST;
  const originalAudiobookRedirectUri = process.env.OIDC_AUDIOBOOK_REDIRECT_URI;
  const originalAudiobookClientId = process.env.OIDC_AUDIOBOOK_CLIENT_ID;
  const originalAgentOpsClientId = process.env.OIDC_AGENTOPS_CLIENT_ID;
  const originalAgentOpsRedirectUris = process.env.OIDC_AGENTOPS_REDIRECT_URIS;
  const originalS2ClientId = process.env.OIDC_S2_CLIENT_ID;
  const originalS2RedirectUri = process.env.OIDC_S2_REDIRECT_URI;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    OIDCClient.create = originalCreate;
    restoreEnv('HOMEBRAIN_PUBLIC_BASE_URL', originalPublicBaseUrl);
    restoreEnv('OIDC_AXIOM_REDIRECT_URI', originalRedirectUri);
    restoreEnv('OIDC_AXIOM_CLIENT_ID', originalClientId);
    restoreEnv('AUDIOBOOK_PUBLIC_BASE_URL', originalAudiobookPublicBaseUrl);
    restoreEnv('AUDIOBOOK_PUBLIC_HOST', originalAudiobookPublicHost);
    restoreEnv('OIDC_AUDIOBOOK_REDIRECT_URI', originalAudiobookRedirectUri);
    restoreEnv('OIDC_AUDIOBOOK_CLIENT_ID', originalAudiobookClientId);
    restoreEnv('OIDC_AGENTOPS_CLIENT_ID', originalAgentOpsClientId);
    restoreEnv('OIDC_AGENTOPS_REDIRECT_URIS', originalAgentOpsRedirectUris);
    restoreEnv('OIDC_S2_CLIENT_ID', originalS2ClientId);
    restoreEnv('OIDC_S2_REDIRECT_URI', originalS2RedirectUri);
  });

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';
  delete process.env.OIDC_AXIOM_REDIRECT_URI;
  delete process.env.OIDC_AXIOM_CLIENT_ID;
  delete process.env.AUDIOBOOK_PUBLIC_BASE_URL;
  delete process.env.AUDIOBOOK_PUBLIC_HOST;
  delete process.env.OIDC_AUDIOBOOK_REDIRECT_URI;
  delete process.env.OIDC_AUDIOBOOK_CLIENT_ID;
  delete process.env.OIDC_AGENTOPS_CLIENT_ID;
  delete process.env.OIDC_AGENTOPS_REDIRECT_URIS;
  delete process.env.OIDC_S2_CLIENT_ID;
  delete process.env.OIDC_S2_REDIRECT_URI;

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

  const createdClients = [];
  OIDCClient.create = async (payload) => {
    createdClients.push(payload);
    return payload;
  };

  const result = await oidcService.ensureBootstrapState({ actor: 'system:test-bootstrap' });
  const axiomClient = createdClients.find((client) => client.clientId === 'homebrain-axiom');
  const agentOpsClient = createdClients.find((client) => client.clientId === 'homebrain-agentops');
  const s2Client = createdClients.find((client) => client.clientId === 'homebrain-s2-voice-studio');

  assert.equal(saved, true);
  assert.deepEqual(result.settingsUpdated, ['signingKeys']);
  assert.ok(result.createdClients.includes('homebrain-axiom'));
  assert.ok(result.createdClients.includes('homebrain-agentops'));
  assert.ok(result.createdClients.includes('homebrain-s2-voice-studio'));
  assert.deepEqual(axiomClient.redirectUris, ['https://mail.example.com/api/identity/homebrain/callback']);
  assert.equal(axiomClient.requirePkce, true);
  assert.equal(axiomClient.tokenEndpointAuthMethod, 'none');
  assert.equal(agentOpsClient.name, 'Perpetual AgentOps');
  assert.equal(agentOpsClient.platform, 'homebrain');
  assert.deepEqual(agentOpsClient.redirectUris, [
    'https://agentops.ntechr.com/auth/callback',
    'http://127.0.0.1:4380/auth/callback',
    'http://localhost:4380/auth/callback',
    'http://192.168.1.42:4380/auth/callback'
  ]);
  assert.equal(agentOpsClient.requirePkce, true);
  assert.equal(agentOpsClient.tokenEndpointAuthMethod, 'none');
  assert.equal(s2Client.name, 'S2 Voice Studio');
  assert.equal(s2Client.platform, 'custom');
  assert.deepEqual(s2Client.redirectUris, ['https://s2.ntechr.com/auth/oidc/callback']);
  assert.deepEqual(s2Client.scopes, ['openid', 'profile', 'email']);
  assert.equal(s2Client.enabled, true);
  assert.equal(s2Client.requirePkce, true);
  assert.equal(s2Client.tokenEndpointAuthMethod, 'none');
});

test('handleAuthorize accepts only the exact S2 callback URI', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalCreate = OIDCClient.create;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const originalS2ClientId = process.env.OIDC_S2_CLIENT_ID;
  const originalS2RedirectUri = process.env.OIDC_S2_REDIRECT_URI;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    OIDCClient.create = originalCreate;
    restoreEnv('HOMEBRAIN_PUBLIC_BASE_URL', originalPublicBaseUrl);
    restoreEnv('OIDC_S2_CLIENT_ID', originalS2ClientId);
    restoreEnv('OIDC_S2_REDIRECT_URI', originalS2RedirectUri);
  });

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';
  delete process.env.OIDC_S2_CLIENT_ID;
  delete process.env.OIDC_S2_REDIRECT_URI;

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
    async save() {
      return this;
    }
  });

  const s2Client = {
    clientId: 'homebrain-s2-voice-studio',
    name: 'S2 Voice Studio',
    platform: 'custom',
    enabled: true,
    redirectUris: ['https://s2.ntechr.com/auth/oidc/callback'],
    scopes: ['openid', 'profile', 'email'],
    requirePkce: true,
    tokenEndpointAuthMethod: 'none',
    async save() {
      return this;
    }
  };

  OIDCClient.findOne = async ({ clientId }) => (
    clientId === s2Client.clientId ? s2Client : null
  );
  OIDCClient.create = async (payload) => payload;

  const buildRequest = (redirectUri) => ({
    query: {
      response_type: 'code',
      client_id: s2Client.clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state: 'state-s2',
      prompt: 'none',
      code_challenge: crypto.createHash('sha256').update('verifier-s2').digest('base64url'),
      code_challenge_method: 'S256'
    },
    headers: {}
  });

  const acceptedResponse = createMockResponse();
  await oidcService.handleAuthorize(
    buildRequest('https://s2.ntechr.com/auth/oidc/callback'),
    acceptedResponse
  );
  assert.equal(acceptedResponse.statusCode, 302);
  assert.match(acceptedResponse.redirectUrl, /^https:\/\/s2\.ntechr\.com\/auth\/oidc\/callback\?/);
  assert.equal(new URL(acceptedResponse.redirectUrl).searchParams.get('error'), 'login_required');

  const rejectedRedirectUris = [
    'https://voice.ntechr.com/auth/oidc/callback',
    'http://s2.ntechr.com/auth/oidc/callback',
    'https://s2.ntechr.com:8443/auth/oidc/callback',
    'https://s2.ntechr.com/auth/oidc/other',
    'https://s2.ntechr.com/auth/oidc/callback?next=/dashboard'
  ];

  for (const redirectUri of rejectedRedirectUris) {
    await assert.rejects(
      oidcService.handleAuthorize(buildRequest(redirectUri), createMockResponse()),
      /redirect_uri is not registered for this client/
    );
  }
});

test('ensureBootstrapState seeds Audiobook client when public URL is configured', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalCreate = OIDCClient.create;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const originalAudiobookPublicBaseUrl = process.env.AUDIOBOOK_PUBLIC_BASE_URL;
  const originalAudiobookClientId = process.env.OIDC_AUDIOBOOK_CLIENT_ID;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    OIDCClient.create = originalCreate;
    restoreEnv('HOMEBRAIN_PUBLIC_BASE_URL', originalPublicBaseUrl);
    restoreEnv('AUDIOBOOK_PUBLIC_BASE_URL', originalAudiobookPublicBaseUrl);
    restoreEnv('OIDC_AUDIOBOOK_CLIENT_ID', originalAudiobookClientId);
  });

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';
  process.env.AUDIOBOOK_PUBLIC_BASE_URL = 'https://audiobook.ntechr.com';
  delete process.env.OIDC_AUDIOBOOK_CLIENT_ID;

  OIDCProviderSettings.getSettings = async () => ({
    ...generateProviderKeys(),
    updatedBy: 'system',
    async save() {
      return this;
    }
  });

  OIDCClient.findOne = async () => null;

  const createdClients = [];
  OIDCClient.create = async (payload) => {
    createdClients.push(payload);
    return payload;
  };

  const result = await oidcService.ensureBootstrapState({ actor: 'system:test-bootstrap' });
  const audiobookClient = createdClients.find((client) => client.clientId === 'homebrain-audiobook');

  assert.ok(result.createdClients.includes('homebrain-audiobook'));
  assert.equal(audiobookClient.name, 'Audiobook Studio');
  assert.equal(audiobookClient.platform, 'audiobook');
  assert.deepEqual(audiobookClient.redirectUris, ['https://audiobook.ntechr.com/api/auth/homebrain/callback']);
  assert.equal(audiobookClient.requirePkce, true);
  assert.equal(audiobookClient.tokenEndpointAuthMethod, 'none');
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
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';

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
    redirectUris: ['https://mail.example.com/api/identity/homebrain/callback'],
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
    email: 'admin@example.com',
    role: 'admin',
    platforms: {
      homebrain: true,
      axiom: true
    },
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
      redirect_uri: 'https://mail.example.com/api/identity/homebrain/callback',
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
  assert.match(res.redirectUrl, /^https:\/\/mail\.example\.com\/api\/identity\/homebrain\/callback\?/);

  const redirectUrl = new URL(res.redirectUrl);
  assert.equal(redirectUrl.searchParams.get('state'), 'state-123');
  assert.ok(redirectUrl.searchParams.get('code'));
  assert.equal(storedCode.clientId, 'homebrain-axiom');
  assert.equal(storedCode.redirectUri, 'https://mail.example.com/api/identity/homebrain/callback');
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
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';

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
    redirectUris: ['https://mail.example.com/api/identity/homebrain/callback'],
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
      redirect_uri: 'https://mail.example.com/api/identity/homebrain/callback',
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
  assert.match(res.redirectUrl, /^https:\/\/mail\.example\.com\/api\/identity\/homebrain\/callback\?/);
  const redirectUrl = new URL(res.redirectUrl);
  assert.equal(redirectUrl.searchParams.get('error'), 'login_required');
  assert.equal(redirectUrl.searchParams.get('state'), 'state-123');
});

test('handleAuthorize returns access_denied when the signed-in user lacks Axiom access', async (t) => {
  const originalGetSettings = OIDCProviderSettings.getSettings;
  const originalFindOne = OIDCClient.findOne;
  const originalUserGet = UserService.get;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;

  t.after(() => {
    OIDCProviderSettings.getSettings = originalGetSettings;
    OIDCClient.findOne = originalFindOne;
    UserService.get = originalUserGet;
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';

  const providerKeys = generateProviderKeys();
  OIDCProviderSettings.getSettings = async () => ({
    ...providerKeys,
    async save() {
      return this;
    }
  });

  OIDCClient.findOne = async () => ({
    clientId: 'homebrain-axiom',
    name: 'Axiom',
    platform: 'axiom',
    enabled: true,
    redirectUris: ['https://mail.example.com/api/identity/homebrain/callback'],
    scopes: ['openid', 'profile', 'email'],
    requirePkce: true,
    tokenEndpointAuthMethod: 'none',
    async save() {
      return this;
    }
  });

  const user = {
    _id: '507f1f77bcf86cd799439011',
    email: 'admin@example.com',
    role: 'admin',
    platforms: {
      homebrain: true,
      axiom: false
    },
    lastLoginAt: new Date('2026-03-12T19:00:00.000Z')
  };
  UserService.get = async () => user;

  const accessToken = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
  const req = {
    query: {
      response_type: 'code',
      client_id: 'homebrain-axiom',
      redirect_uri: 'https://mail.example.com/api/identity/homebrain/callback',
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
  const redirectUrl = new URL(res.redirectUrl);
  assert.equal(redirectUrl.searchParams.get('error'), 'access_denied');
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

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';

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
    redirectUris: ['https://mail.example.com/api/identity/homebrain/callback'],
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
    redirectUri: 'https://mail.example.com/api/identity/homebrain/callback',
    scopes: ['openid', 'profile', 'email'],
    nonce: 'nonce-456',
    codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
    codeChallengeMethod: 'S256',
    userId: '507f1f77bcf86cd799439011',
    authTime: new Date('2026-03-12T19:00:00.000Z')
  });

  const user = {
    _id: '507f1f77bcf86cd799439011',
    email: 'admin@example.com',
    role: 'admin',
    platforms: {
      homebrain: true,
      axiom: true
    },
    lastLoginAt: new Date('2026-03-12T19:00:00.000Z')
  };
  UserService.get = async () => user;

  const req = {
    body: {
      grant_type: 'authorization_code',
      client_id: 'homebrain-axiom',
      code: 'raw-code-123',
      redirect_uri: 'https://mail.example.com/api/identity/homebrain/callback',
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
    issuer: 'https://example.com',
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

  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://example.com';

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
      email: 'admin@example.com',
      role: 'admin',
      token_use: 'access'
    },
    providerKeys.signingPrivateKeyPem,
    {
      algorithm: 'RS256',
      keyid: providerKeys.signingKeyId,
      issuer: 'https://example.com',
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
  assert.equal(decoded.email, 'admin@example.com');
  assert.equal(decoded.role, 'admin');
});
