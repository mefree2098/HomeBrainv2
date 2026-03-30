const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const OIDCProviderSettings = require('../models/OIDCProviderSettings');
const OIDCClient = require('../models/OIDCClient');
const OIDCAuthorizationCode = require('../models/OIDCAuthorizationCode');
const UserService = require('./userService');
const { generateAccessToken } = require('../utils/auth');
const { getAxiomCallbackUrl } = require('../utils/platformUrls');
const { getRequestOrigin } = require('../utils/publicOrigin');
const { ALL_USER_PLATFORMS, hasPlatformAccess } = require('../utils/userPlatforms');
const {
  ACCESS_TOKEN_COOKIE_NAME,
  SESSION_TOKEN_COOKIE_NAME,
  clearAuthCookies,
  getCookieValue,
  setAccessTokenCookie,
  setSessionTokenCookie
} = require('../utils/authCookies');

const DEFAULT_CLIENT_ID = 'homebrain-axiom';
const CODE_TTL_MS = Math.max(60 * 1000, Number(process.env.OIDC_CODE_TTL_MS || 5 * 60 * 1000));
const TOKEN_TTL_SECONDS = Math.max(300, Number(process.env.OIDC_TOKEN_TTL_SECONDS || 60 * 60));
const SUPPORTED_SCOPES = Object.freeze(['openid', 'profile', 'email']);
const SUPPORTED_TOKEN_AUTH_METHODS = Object.freeze(['none', 'client_secret_post', 'client_secret_basic']);
const SUPPORTED_PKCE_METHODS = Object.freeze(['plain', 'S256']);

class OIDCRequestError extends Error {
  constructor(error, description, status = 400, options = {}) {
    super(description || error);
    this.name = 'OIDCRequestError';
    this.oidcError = error;
    this.description = description || error;
    this.status = status;
    this.redirectUri = options.redirectUri || '';
    this.state = options.state || '';
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(trimString).filter(Boolean)));
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

function hashAuthorizationCode(code) {
  return sha256Base64Url(code);
}

function randomToken(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  if (typeof value !== 'string') {
    return [];
  }

  return uniqueStrings(value.split(/\s+/));
}

function splitPrompt(prompt) {
  return uniqueStrings(trimString(prompt).split(/\s+/));
}

function getDefaultClientId() {
  return trimString(process.env.OIDC_AXIOM_CLIENT_ID) || DEFAULT_CLIENT_ID;
}

function deriveAxiomRedirectUri() {
  return getAxiomCallbackUrl();
}

function buildStandardClaims(user) {
  const email = trimString(user?.email);
  const subject = String(user?._id || '');

  return {
    sub: subject,
    email,
    email_verified: false,
    preferred_username: email,
    name: email
  };
}

function buildAuthorizeRedirect(redirectUri, params = {}) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

function buildAuthorizeErrorRedirect(redirectUri, error, description, state) {
  return buildAuthorizeRedirect(redirectUri, {
    error,
    error_description: description,
    state
  });
}

function parseBasicAuthorization(header) {
  const raw = trimString(header);
  if (!raw || !raw.toLowerCase().startsWith('basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(raw.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) {
      return null;
    }

    return {
      clientId: decoded.slice(0, separatorIndex),
      clientSecret: decoded.slice(separatorIndex + 1)
    };
  } catch (_error) {
    return null;
  }
}

async function getProviderSettings() {
  return OIDCProviderSettings.getSettings();
}

async function ensureBootstrapState({ actor = 'system:oidc-bootstrap' } = {}) {
  const summary = {
    settingsUpdated: [],
    createdClients: [],
    updatedClients: []
  };

  const settings = await getProviderSettings();
  let settingsDirty = false;

  if (!trimString(settings.signingKeyId) || !trimString(settings.signingPrivateKeyPem) || !trimString(settings.signingPublicKeyPem)) {
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

    settings.signingPublicKeyPem = publicKey;
    settings.signingPrivateKeyPem = privateKey;
    settings.signingKeyId = sha256Base64Url(publicKey).slice(0, 24);
    settings.updatedBy = actor;
    settingsDirty = true;
    summary.settingsUpdated.push('signingKeys');
  }

  if (settingsDirty) {
    await settings.save();
  }

  const clientId = getDefaultClientId();
  const redirectUri = deriveAxiomRedirectUri();

  if (!clientId || !redirectUri) {
    return summary;
  }

  let client = await OIDCClient.findOne({ clientId });
  if (!client) {
    await OIDCClient.create({
      clientId,
      name: 'Axiom',
      platform: 'axiom',
      enabled: true,
      redirectUris: [redirectUri],
      scopes: [...SUPPORTED_SCOPES],
      requirePkce: true,
      tokenEndpointAuthMethod: 'none',
      updatedBy: actor
    });
    summary.createdClients.push(clientId);
    return summary;
  }

  let clientDirty = false;
  const redirectUris = uniqueStrings(client.redirectUris || []);
  if (!redirectUris.includes(redirectUri)) {
    client.redirectUris = [...redirectUris, redirectUri];
    clientDirty = true;
    summary.updatedClients.push(`${clientId}:redirectUris`);
  }

  if (!Array.isArray(client.scopes) || client.scopes.length === 0) {
    client.scopes = [...SUPPORTED_SCOPES];
    clientDirty = true;
    summary.updatedClients.push(`${clientId}:scopes`);
  }

  if (client.platform !== 'axiom') {
    client.platform = 'axiom';
    clientDirty = true;
    summary.updatedClients.push(`${clientId}:platform`);
  }

  if (clientDirty) {
    client.updatedBy = actor;
    await client.save();
  }

  return summary;
}

function buildDiscoveryDocument(req) {
  const issuer = getRequestOrigin(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    scopes_supported: [...SUPPORTED_SCOPES],
    claims_supported: ['sub', 'email', 'email_verified', 'preferred_username', 'name', 'role'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: [...SUPPORTED_TOKEN_AUTH_METHODS],
    code_challenge_methods_supported: [...SUPPORTED_PKCE_METHODS]
  };
}

async function buildJwks() {
  const settings = await getProviderSettings();
  const publicKey = crypto.createPublicKey(settings.signingPublicKeyPem);
  const jwk = publicKey.export({ format: 'jwk' });

  return {
    keys: [{
      ...jwk,
      kid: settings.signingKeyId,
      use: 'sig',
      alg: 'RS256'
    }]
  };
}

async function getClientById(clientId) {
  const normalizedClientId = trimString(clientId);
  if (!normalizedClientId) {
    return null;
  }
  return OIDCClient.findOne({ clientId: normalizedClientId, enabled: true });
}

async function getUserFromSessionToken(sessionToken) {
  const normalizedToken = trimString(sessionToken);
  if (!normalizedToken || !process.env.REFRESH_TOKEN_SECRET) {
    return null;
  }

  try {
    const decoded = jwt.verify(normalizedToken, process.env.REFRESH_TOKEN_SECRET);
    const user = await UserService.get(decoded.sub);
    if (!user || user.refreshToken !== normalizedToken) {
      return null;
    }
    return user;
  } catch (_error) {
    return null;
  }
}

async function getAuthenticatedUserFromSession(req, res) {
  const accessToken = getCookieValue(req, ACCESS_TOKEN_COOKIE_NAME);
  if (accessToken && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(accessToken, process.env.JWT_SECRET);
      const user = await UserService.get(decoded.sub);
      if (user) {
        return user;
      }
    } catch (_error) {
      // Fall through to the durable session cookie below.
    }
  }

  const sessionToken = getCookieValue(req, SESSION_TOKEN_COOKIE_NAME);
  const user = await getUserFromSessionToken(sessionToken);
  if (!user) {
    if (sessionToken || accessToken) {
      clearAuthCookies(res);
    }
    return null;
  }

  setAccessTokenCookie(res, generateAccessToken(user));
  setSessionTokenCookie(res, sessionToken);
  return user;
}

async function parseAuthorizeRequest(query = {}) {
  const responseType = trimString(query.response_type);
  const clientId = trimString(query.client_id);
  const redirectUri = trimString(query.redirect_uri);
  const state = trimString(query.state);
  const nonce = trimString(query.nonce);
  const scopes = normalizeScopes(query.scope);
  const prompts = splitPrompt(query.prompt);
  const codeChallenge = trimString(query.code_challenge);
  const codeChallengeMethod = trimString(query.code_challenge_method) || (codeChallenge ? 'plain' : '');

  if (responseType !== 'code') {
    throw new OIDCRequestError('unsupported_response_type', 'Only authorization code flow is supported.');
  }

  if (!clientId) {
    throw new OIDCRequestError('invalid_request', 'client_id is required.');
  }

  const client = await getClientById(clientId);
  if (!client) {
    throw new OIDCRequestError('unauthorized_client', 'The requested client is not registered or is disabled.');
  }

  if (!redirectUri) {
    throw new OIDCRequestError('invalid_request', 'redirect_uri is required.');
  }

  if (!Array.isArray(client.redirectUris) || !client.redirectUris.includes(redirectUri)) {
    throw new OIDCRequestError('invalid_request', 'redirect_uri is not registered for this client.');
  }

  if (!scopes.includes('openid')) {
    throw new OIDCRequestError('invalid_scope', 'openid scope is required.', 400, { redirectUri, state });
  }

  const allowedClientScopes = Array.isArray(client.scopes) && client.scopes.length > 0
    ? client.scopes
    : [...SUPPORTED_SCOPES];
  const unsupportedScopes = scopes.filter((scope) => !SUPPORTED_SCOPES.includes(scope) || !allowedClientScopes.includes(scope));
  if (unsupportedScopes.length > 0) {
    throw new OIDCRequestError('invalid_scope', `Unsupported scope requested: ${unsupportedScopes.join(', ')}`, 400, { redirectUri, state });
  }

  if (prompts.includes('none') && prompts.length > 1) {
    throw new OIDCRequestError('invalid_request', 'prompt=none cannot be combined with other prompt values.', 400, { redirectUri, state });
  }

  if (client.requirePkce && !codeChallenge) {
    throw new OIDCRequestError('invalid_request', 'PKCE is required for this client.', 400, { redirectUri, state });
  }

  if (codeChallenge && !SUPPORTED_PKCE_METHODS.includes(codeChallengeMethod)) {
    throw new OIDCRequestError('invalid_request', 'Unsupported PKCE code_challenge_method.', 400, { redirectUri, state });
  }

  return {
    client,
    redirectUri,
    state,
    nonce,
    scopes,
    prompts,
    codeChallenge,
    codeChallengeMethod
  };
}

async function createAuthorizationCode({ client, user, redirectUri, scopes, nonce, codeChallenge, codeChallengeMethod }) {
  const code = randomToken(32);
  await OIDCAuthorizationCode.create({
    codeHash: hashAuthorizationCode(code),
    clientId: client.clientId,
    userId: user._id,
    redirectUri,
    scopes,
    nonce,
    codeChallenge,
    codeChallengeMethod,
    authTime: user.lastLoginAt || new Date(),
    expiresAt: new Date(Date.now() + CODE_TTL_MS)
  });

  return code;
}

async function handleAuthorize(req, res) {
  await ensureBootstrapState({ actor: 'system:oidc-authorize' });

  let authorizationRequest;
  try {
    authorizationRequest = await parseAuthorizeRequest(req.query || {});
  } catch (error) {
    if (error instanceof OIDCRequestError && error.redirectUri) {
      return res.redirect(302, buildAuthorizeErrorRedirect(error.redirectUri, error.oidcError, error.description, error.state));
    }
    throw error;
  }

  const { client, redirectUri, state, nonce, scopes, prompts, codeChallenge, codeChallengeMethod } = authorizationRequest;
  const forceLogin = prompts.includes('login');
  const promptNone = prompts.includes('none');
  const user = forceLogin ? null : await getAuthenticatedUserFromSession(req, res);

  if (!user) {
    if (promptNone) {
      return res.redirect(302, buildAuthorizeErrorRedirect(redirectUri, 'login_required', 'The user is not signed in.', state));
    }

    const returnTo = req.originalUrl || req.url || '/';
    return res.redirect(302, `/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  const clientPlatform = trimString(client.platform).toLowerCase();
  if (ALL_USER_PLATFORMS.includes(clientPlatform) && !hasPlatformAccess(user, clientPlatform)) {
    const target = trimString(client.name) || clientPlatform;
    return res.redirect(302, buildAuthorizeErrorRedirect(
      redirectUri,
      'access_denied',
      `The signed-in user does not have access to ${target}.`,
      state
    ));
  }

  const code = await createAuthorizationCode({
    client,
    user,
    redirectUri,
    scopes,
    nonce,
    codeChallenge,
    codeChallengeMethod
  });

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  return res.redirect(302, buildAuthorizeRedirect(redirectUri, { code, state }));
}

async function validateClientAuthentication(req, client, body = {}) {
  if (client.tokenEndpointAuthMethod === 'none') {
    return;
  }

  const basicCredentials = parseBasicAuthorization(req.headers.authorization);
  const bodyClientSecret = trimString(body.client_secret);
  const secret = client.tokenEndpointAuthMethod === 'client_secret_basic'
    ? trimString(basicCredentials?.clientSecret)
    : bodyClientSecret;

  if (!secret || !client.clientSecretHash) {
    const error = new OIDCRequestError('invalid_client', 'Client authentication failed.', 401);
    error.wwwAuthenticate = 'Basic realm="oidc", charset="UTF-8"';
    throw error;
  }

  const isValid = await bcrypt.compare(secret, client.clientSecretHash);
  if (!isValid) {
    const error = new OIDCRequestError('invalid_client', 'Client authentication failed.', 401);
    error.wwwAuthenticate = 'Basic realm="oidc", charset="UTF-8"';
    throw error;
  }
}

function verifyPkce(codeVerifier, authorizationCode, client) {
  const verifier = trimString(codeVerifier);
  const challenge = trimString(authorizationCode.codeChallenge);
  const method = trimString(authorizationCode.codeChallengeMethod) || 'plain';

  if (!challenge) {
    if (client.requirePkce) {
      throw new OIDCRequestError('invalid_grant', 'The authorization code is missing PKCE state.');
    }
    return;
  }

  if (!verifier) {
    throw new OIDCRequestError('invalid_request', 'code_verifier is required.');
  }

  const derivedChallenge = method === 'S256' ? sha256Base64Url(verifier) : verifier;
  if (derivedChallenge !== challenge) {
    throw new OIDCRequestError('invalid_grant', 'PKCE verification failed.');
  }
}

async function issueTokens(req, client, authorizationCode, user) {
  const settings = await getProviderSettings();
  const issuer = getRequestOrigin(req);
  const authTime = Math.floor(new Date(authorizationCode.authTime || user.lastLoginAt || Date.now()).getTime() / 1000);
  const standardClaims = buildStandardClaims(user);
  const signingOptions = {
    algorithm: 'RS256',
    keyid: settings.signingKeyId,
    issuer,
    audience: client.clientId,
    expiresIn: TOKEN_TTL_SECONDS
  };

  const accessToken = jwt.sign({
    ...standardClaims,
    scope: (authorizationCode.scopes || []).join(' '),
    role: user.role,
    auth_time: authTime,
    token_use: 'access'
  }, settings.signingPrivateKeyPem, signingOptions);

  const idTokenPayload = {
    ...standardClaims,
    role: user.role,
    auth_time: authTime
  };

  if (authorizationCode.nonce) {
    idTokenPayload.nonce = authorizationCode.nonce;
  }

  const idToken = jwt.sign(idTokenPayload, settings.signingPrivateKeyPem, signingOptions);

  return {
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    access_token: accessToken,
    id_token: idToken,
    scope: (authorizationCode.scopes || []).join(' ')
  };
}

async function handleToken(req, res) {
  await ensureBootstrapState({ actor: 'system:oidc-token' });

  try {
    const body = req.body || {};
    const grantType = trimString(body.grant_type);
    if (grantType !== 'authorization_code') {
      throw new OIDCRequestError('unsupported_grant_type', 'Only authorization_code is supported.');
    }

    const basicCredentials = parseBasicAuthorization(req.headers.authorization);
    const clientId = trimString(body.client_id || basicCredentials?.clientId);
    if (!clientId) {
      throw new OIDCRequestError('invalid_client', 'client_id is required.', 401);
    }

    const client = await getClientById(clientId);
    if (!client) {
      throw new OIDCRequestError('invalid_client', 'Client authentication failed.', 401);
    }

    await validateClientAuthentication(req, client, body);

    const code = trimString(body.code);
    const redirectUri = trimString(body.redirect_uri);
    if (!code || !redirectUri) {
      throw new OIDCRequestError('invalid_request', 'code and redirect_uri are required.');
    }

    const authorizationCode = await OIDCAuthorizationCode.findOneAndUpdate(
      {
        codeHash: hashAuthorizationCode(code),
        consumedAt: null,
        expiresAt: { $gt: new Date() }
      },
      {
        $set: { consumedAt: new Date() }
      },
      {
        new: true
      }
    );

    if (!authorizationCode) {
      throw new OIDCRequestError('invalid_grant', 'The authorization code is invalid or has expired.');
    }

    if (authorizationCode.clientId !== client.clientId || authorizationCode.redirectUri !== redirectUri) {
      throw new OIDCRequestError('invalid_grant', 'The authorization code does not match this client or redirect URI.');
    }

    verifyPkce(body.code_verifier, authorizationCode, client);

    const user = await UserService.get(authorizationCode.userId);
    if (!user) {
      throw new OIDCRequestError('invalid_grant', 'The authorization code subject no longer exists.');
    }

    const tokenResponse = await issueTokens(req, client, authorizationCode, user);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json(tokenResponse);
  } catch (error) {
    if (error instanceof OIDCRequestError) {
      if (error.wwwAuthenticate) {
        res.setHeader('WWW-Authenticate', error.wwwAuthenticate);
      }

      return res.status(error.status || 400).json({
        error: error.oidcError,
        error_description: error.description
      });
    }

    throw error;
  }
}

async function verifyIssuedAccessToken(req, tokenOverride = '') {
  const authorizationHeader = trimString(tokenOverride || req.headers.authorization);
  if (!authorizationHeader.toLowerCase().startsWith('bearer ')) {
    throw new OIDCRequestError('invalid_token', 'Bearer access token is required.', 401);
  }

  const token = authorizationHeader.slice(7).trim();
  const settings = await getProviderSettings();
  const issuer = getRequestOrigin(req);

  let decoded;
  try {
    decoded = jwt.verify(token, settings.signingPublicKeyPem, {
      algorithms: ['RS256'],
      issuer
    });
  } catch (_error) {
    throw new OIDCRequestError('invalid_token', 'The access token is invalid or has expired.', 401);
  }

  if (decoded.token_use !== 'access') {
    throw new OIDCRequestError('invalid_token', 'The provided token is not an access token.', 401);
  }

  return decoded;
}

async function handleUserInfo(req, res) {
  try {
    const decoded = await verifyIssuedAccessToken(req);
    const user = await UserService.get(decoded.sub);
    if (!user) {
      throw new OIDCRequestError('invalid_token', 'The access token subject no longer exists.', 401);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({
      ...buildStandardClaims(user),
      role: user.role
    });
  } catch (error) {
    if (error instanceof OIDCRequestError) {
      return res.status(error.status || 401).json({
        error: error.oidcError,
        error_description: error.description
      });
    }

    throw error;
  }
}

module.exports = {
  DEFAULT_CLIENT_ID,
  SUPPORTED_SCOPES,
  buildDiscoveryDocument,
  buildJwks,
  ensureBootstrapState,
  getAuthenticatedUserFromSession,
  getUserFromSessionToken,
  handleAuthorize,
  handleToken,
  handleUserInfo,
  verifyIssuedAccessToken
};
