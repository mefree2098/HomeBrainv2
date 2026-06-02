const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const Device = require('../models/Device');
const EcobeeIntegration = require('../models/EcobeeIntegration');
const ecobeeService = require('../services/ecobeeService');

test('upsertMappedDevice dedupes duplicate HomeBrain rows for an Ecobee thermostat', async (t) => {
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const canonicalDevice = {
    _id: 'ecobee-canonical',
    name: 'Hall Thermostat',
    groups: ['Climate'],
    properties: {
      ecobeeDeviceType: 'thermostat',
      ecobeeThermostatIdentifier: 'thermostat-1'
    },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const duplicateDevice = {
    _id: 'ecobee-duplicate',
    name: 'Hall Thermostat Duplicate',
    groups: ['Favorites'],
    properties: {
      ecobeeThermostatIdentifier: 'thermostat-1'
    },
    createdAt: new Date('2026-04-02T00:00:00Z')
  };

  const mappedDevice = {
    name: 'Hall Thermostat',
    type: 'thermostat',
    room: 'Hall',
    status: true,
    temperature: 71,
    targetTemperature: 72,
    properties: {
      source: 'ecobee',
      ecobeeDeviceType: 'thermostat',
      ecobeeThermostatIdentifier: 'thermostat-1'
    },
    brand: 'ecobee',
    model: 'Smart Thermostat',
    isOnline: true,
    lastSeen: new Date('2026-04-02T12:00:00Z')
  };

  Device.find = async (query) => {
    assert.equal(query['properties.ecobeeThermostatIdentifier'], 'thermostat-1');
    return [duplicateDevice, canonicalDevice];
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a canonical Ecobee row already exists');
  };
  Device.deleteMany = async (query) => {
    assert.deepEqual(query, {
      _id: { $in: ['ecobee-duplicate'] }
    });
    return { deletedCount: 1 };
  };

  const result = await ecobeeService.upsertMappedDevice(mappedDevice);

  assert.equal(result.updated, 1);
  assert.equal(result.deduped, 1);
  assert.deepEqual(canonicalDevice.groups, ['Climate', 'Favorites']);
  assert.equal(canonicalDevice.saved, true);
});

test('refreshAccessToken uses Auth0 token endpoint for Ecobee web auth', async (t) => {
  const originalGetIntegration = EcobeeIntegration.getIntegration;
  const originalPost = axios.post;

  t.after(() => {
    EcobeeIntegration.getIntegration = originalGetIntegration;
    axios.post = originalPost;
  });

  let updateOptions = null;
  const integration = {
    authMode: 'web',
    refreshToken: 'web-refresh-token',
    username: 'user@example.com',
    password: 'secret',
    async updateTokens(tokenData, options) {
      updateOptions = options;
      this.accessToken = tokenData.access_token;
    }
  };

  EcobeeIntegration.getIntegration = async () => integration;
  axios.post = async (url, body, options) => {
    assert.equal(url, 'https://auth.ecobee.com/oauth/token');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');

    const form = new URLSearchParams(body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'web-refresh-token');
    assert.equal(form.get('client_id'), '183eORFPlXyz9BbDZwqexHPBQoVjgadh');

    return {
      data: {
        access_token: 'web-access-token',
        token_type: 'Bearer',
        expires_in: 3600
      }
    };
  };

  const result = await ecobeeService.refreshAccessToken();

  assert.equal(result.access_token, 'web-access-token');
  assert.deepEqual(updateOptions, { authMode: 'web' });
  assert.equal(integration.accessToken, 'web-access-token');
});

test('refreshAccessToken preserves legacy App Key refresh endpoint', async (t) => {
  const originalGetIntegration = EcobeeIntegration.getIntegration;
  const originalPost = axios.post;

  t.after(() => {
    EcobeeIntegration.getIntegration = originalGetIntegration;
    axios.post = originalPost;
  });

  let updateTokensCalled = false;
  const integration = {
    authMode: 'appKey',
    clientId: 'legacy-app-key',
    refreshToken: 'legacy-refresh-token',
    async updateTokens(tokenData) {
      updateTokensCalled = true;
      this.accessToken = tokenData.access_token;
    }
  };

  EcobeeIntegration.getIntegration = async () => integration;
  axios.post = async (url, body, options) => {
    assert.equal(url, 'https://api.ecobee.com/token');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');

    const form = new URLSearchParams(body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'legacy-refresh-token');
    assert.equal(form.get('client_id'), 'legacy-app-key');

    return {
      data: {
        access_token: 'legacy-access-token',
        refresh_token: 'legacy-rotated-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600
      }
    };
  };

  const result = await ecobeeService.refreshAccessToken();

  assert.equal(result.access_token, 'legacy-access-token');
  assert.equal(updateTokensCalled, true);
  assert.equal(integration.accessToken, 'legacy-access-token');
});

test('EcobeeIntegration status sanitizes web auth secrets and pending MFA state', () => {
  const integration = new EcobeeIntegration({
    authMode: 'web',
    username: 'user@example.com',
    password: 'super-secret-password',
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    pendingMfa: {
      challengeUrl: 'https://auth.ecobee.com/u/mfa-otp-challenge?state=state-1',
      state: 'state-1',
      mfaType: 'otp',
      cookies: {
        auth0: 'cookie-value'
      },
      codeVerifier: 'verifier-value',
      username: 'user@example.com',
      password: 'super-secret-password',
      createdAt: new Date('2026-06-02T12:00:00Z')
    }
  });

  const sanitized = integration.toSanitized();

  assert.equal(sanitized.authMode, 'web');
  assert.equal(sanitized.username, 'user@example.com');
  assert.notEqual(sanitized.password, 'super-secret-password');
  assert.notEqual(sanitized.accessToken, 'access-token-value');
  assert.notEqual(sanitized.refreshToken, 'refresh-token-value');
  assert.equal(sanitized.pendingMfaRequired, true);
  assert.deepEqual(Object.keys(sanitized.pendingMfa).sort(), ['createdAt', 'mfaType', 'username']);
  assert.equal(sanitized.pendingMfa.mfaType, 'otp');
});
