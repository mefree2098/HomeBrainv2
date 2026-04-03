const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.NODE_ENV = 'test';

const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const Settings = require('../models/Settings');
const smartThingsService = require('../services/smartThingsService');

test('getValidAccessToken refreshes when access token is missing but a refresh token exists', async (t) => {
  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const originalGetSettings = Settings.getSettings;
  const originalRefreshAccessToken = smartThingsService.refreshAccessToken;

  let getIntegrationCalls = 0;
  let refreshCalled = false;

  SmartThingsIntegration.getIntegration = async () => {
    getIntegrationCalls += 1;
    if (getIntegrationCalls === 1) {
      return {
        accessToken: '',
        refreshToken: 'refresh-token-1',
        isTokenValid: () => false
      };
    }

    return {
      accessToken: 'fresh-access-token',
      refreshToken: 'refresh-token-1',
      isTokenValid: () => true
    };
  };
  Settings.getSettings = async () => ({
    smartthingsUseOAuth: true,
    smartthingsToken: ''
  });
  smartThingsService.refreshAccessToken = async () => {
    refreshCalled = true;
    return { access_token: 'fresh-access-token' };
  };

  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    Settings.getSettings = originalGetSettings;
    smartThingsService.refreshAccessToken = originalRefreshAccessToken;
  });

  const token = await smartThingsService.getValidAccessToken();

  assert.equal(token, 'fresh-access-token');
  assert.equal(refreshCalled, true);
  assert.equal(getIntegrationCalls, 2);
});

test('getValidAccessToken marks SmartThings disconnected when no OAuth tokens are available', async (t) => {
  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const originalGetSettings = Settings.getSettings;
  const originalPersistConnectionStatus = smartThingsService.persistConnectionStatus;

  let persistedStatus = null;

  SmartThingsIntegration.getIntegration = async () => ({
    accessToken: '',
    refreshToken: '',
    isTokenValid: () => false
  });
  Settings.getSettings = async () => ({
    smartthingsUseOAuth: true,
    smartthingsToken: ''
  });
  smartThingsService.persistConnectionStatus = async (payload) => {
    persistedStatus = payload;
    return true;
  };

  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    Settings.getSettings = originalGetSettings;
    smartThingsService.persistConnectionStatus = originalPersistConnectionStatus;
  });

  await assert.rejects(
    () => smartThingsService.getValidAccessToken(),
    /No access token available\. Please authorize the application\./
  );

  assert.deepEqual(persistedStatus, {
    isConnected: false,
    lastError: 'No access token available. Please authorize the application.',
    reason: 'get-token:missing-credentials'
  });
});

test('getValidAccessToken falls back to the soft-expired access token when refresh fails transiently', async (t) => {
  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const originalGetSettings = Settings.getSettings;
  const originalRefreshAccessToken = smartThingsService.refreshAccessToken;

  SmartThingsIntegration.getIntegration = async () => ({
    accessToken: 'soft-expired-access-token',
    refreshToken: 'refresh-token-1',
    expiresAt: new Date(Date.now() - 60 * 1000),
    isTokenValid: () => false
  });
  Settings.getSettings = async () => ({
    smartthingsUseOAuth: true,
    smartthingsToken: ''
  });
  smartThingsService.refreshAccessToken = async () => {
    const error = new Error('socket hang up');
    error.code = 'ECONNRESET';
    throw error;
  };

  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    Settings.getSettings = originalGetSettings;
    smartThingsService.refreshAccessToken = originalRefreshAccessToken;
  });

  const token = await smartThingsService.getValidAccessToken();

  assert.equal(token, 'soft-expired-access-token');
});

test('refreshAccessToken preserves stored tokens on transient SmartThings failures', async (t) => {
  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const originalAxiosPost = axios.post;

  let clearTokensCalled = false;

  SmartThingsIntegration.getIntegration = async () => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token-1',
    updateTokens: async () => {},
    clearTokens: async () => {
      clearTokensCalled = true;
    }
  });
  axios.post = async () => {
    const error = new Error('timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };

  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    axios.post = originalAxiosPost;
  });

  await assert.rejects(
    () => smartThingsService.refreshAccessToken(),
    /Failed to refresh access token: timeout/
  );

  assert.equal(clearTokensCalled, false);
});

test('makeAuthenticatedRequest refreshes and retries once after a SmartThings 401', async (t) => {
  const originalAxiosRequest = axios.request;
  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const originalGetValidAccessToken = smartThingsService.getValidAccessToken;
  const originalRefreshAccessToken = smartThingsService.refreshAccessToken;
  const originalPersistConnectionStatus = smartThingsService.persistConnectionStatus;
  const originalGetSettings = Settings.getSettings;

  let requestCount = 0;
  let refreshCount = 0;
  let tokenReads = 0;
  const persisted = [];

  Settings.getSettings = async () => ({
    smartthingsUseOAuth: true,
    smartthingsToken: ''
  });
  SmartThingsIntegration.getIntegration = async () => ({
    refreshToken: 'refresh-token-1'
  });
  smartThingsService.getValidAccessToken = async () => {
    tokenReads += 1;
    return tokenReads === 1 ? 'stale-token' : 'fresh-token';
  };
  smartThingsService.refreshAccessToken = async () => {
    refreshCount += 1;
    return {
      access_token: 'fresh-token'
    };
  };
  smartThingsService.persistConnectionStatus = async (payload) => {
    persisted.push(payload);
    return true;
  };
  axios.request = async (config) => {
    requestCount += 1;

    if (requestCount === 1) {
      assert.equal(config.headers.Authorization, 'Bearer stale-token');
      const error = new Error('Unauthorized');
      error.response = {
        status: 401,
        data: {
          message: 'Unauthorized'
        }
      };
      throw error;
    }

    assert.equal(config.headers.Authorization, 'Bearer fresh-token');
    return {
      data: {
        ok: true
      }
    };
  };

  t.after(() => {
    axios.request = originalAxiosRequest;
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    smartThingsService.getValidAccessToken = originalGetValidAccessToken;
    smartThingsService.refreshAccessToken = originalRefreshAccessToken;
    smartThingsService.persistConnectionStatus = originalPersistConnectionStatus;
    Settings.getSettings = originalGetSettings;
  });

  const result = await smartThingsService.makeAuthenticatedRequest('/devices');

  assert.deepEqual(result, { ok: true });
  assert.equal(requestCount, 2);
  assert.equal(refreshCount, 1);
  assert.deepEqual(persisted, [{
    isConnected: true,
    lastError: '',
    reason: 'request:/devices'
  }]);
});

test('bootstrapConnectionState keeps prior authorization on transient probe failures', async (t) => {
  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const originalGetSettings = Settings.getSettings;
  const originalMakeAuthenticatedRequest = smartThingsService.makeAuthenticatedRequest;
  const originalPersistConnectionStatus = smartThingsService.persistConnectionStatus;

  const persisted = [];

  SmartThingsIntegration.getIntegration = async () => ({
    isConfigured: true,
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1'
  });
  Settings.getSettings = async () => ({
    smartthingsUseOAuth: true,
    smartthingsToken: ''
  });
  smartThingsService.makeAuthenticatedRequest = async () => {
    const error = new Error('SmartThings startup connection probe timed out after 12000ms');
    error.code = 'TIMEOUT';
    throw error;
  };
  smartThingsService.persistConnectionStatus = async (payload) => {
    persisted.push(payload);
    return true;
  };

  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    Settings.getSettings = originalGetSettings;
    smartThingsService.makeAuthenticatedRequest = originalMakeAuthenticatedRequest;
    smartThingsService.persistConnectionStatus = originalPersistConnectionStatus;
  });

  const result = await smartThingsService.bootstrapConnectionState({ reason: 'server-startup' });

  assert.equal(result.success, false);
  assert.equal(result.error, 'SmartThings startup connection probe timed out after 12000ms');
  assert.deepEqual(persisted, []);
});

test('setSecurityArmState allows disarm with only the disarm switch configured', async (t) => {
  const originalGetSthmVirtualSwitchConfig = smartThingsService.getSthmVirtualSwitchConfig;
  const originalResolveLocationId = smartThingsService.resolveLocationId;
  const originalPulseVirtualSwitch = smartThingsService.pulseVirtualSwitch;
  const originalUpdateSthmCommandLog = smartThingsService.updateSthmCommandLog;

  t.after(() => {
    smartThingsService.getSthmVirtualSwitchConfig = originalGetSthmVirtualSwitchConfig;
    smartThingsService.resolveLocationId = originalResolveLocationId;
    smartThingsService.pulseVirtualSwitch = originalPulseVirtualSwitch;
    smartThingsService.updateSthmCommandLog = originalUpdateSthmCommandLog;
  });

  let capturedRequireAll = null;
  const captured = {
    pulsed: null
  };

  smartThingsService.getSthmVirtualSwitchConfig = async ({ requireAll } = {}) => {
    capturedRequireAll = requireAll;
    return {
      integration: null,
      config: {
        disarmDeviceId: 'disarm-switch-1',
        armStayDeviceId: '',
        armAwayDeviceId: '',
        locationId: ''
      }
    };
  };
  smartThingsService.resolveLocationId = async () => 'location-1';
  smartThingsService.pulseVirtualSwitch = async (deviceId, options) => {
    captured.pulsed = { deviceId, options };
  };
  smartThingsService.updateSthmCommandLog = async () => {};

  const result = await smartThingsService.setSecurityArmState('Disarmed');

  assert.equal(capturedRequireAll, false);
  assert.deepEqual(captured.pulsed, {
    deviceId: 'disarm-switch-1',
    options: { ensureReset: true, delayMs: 300 }
  });
  assert.equal(result.armState, 'Disarmed');
  assert.equal(result.triggeredDeviceId, 'disarm-switch-1');
});

test('triggerSthmSilenceSwitch triggers the configured silence switch', async (t) => {
  const originalGetSthmVirtualSwitchConfig = smartThingsService.getSthmVirtualSwitchConfig;
  const originalPulseVirtualSwitch = smartThingsService.pulseVirtualSwitch;
  const originalUpdateSthmCommandLog = smartThingsService.updateSthmCommandLog;

  t.after(() => {
    smartThingsService.getSthmVirtualSwitchConfig = originalGetSthmVirtualSwitchConfig;
    smartThingsService.pulseVirtualSwitch = originalPulseVirtualSwitch;
    smartThingsService.updateSthmCommandLog = originalUpdateSthmCommandLog;
  });

  let capturedOptions = null;
  const captured = {
    pulsed: null
  };

  smartThingsService.getSthmVirtualSwitchConfig = async (options = {}) => {
    capturedOptions = options;
    return {
      integration: null,
      config: {
        silenceDeviceId: 'silence-switch-1'
      }
    };
  };
  smartThingsService.pulseVirtualSwitch = async (deviceId, options) => {
    captured.pulsed = { deviceId, options };
  };
  smartThingsService.updateSthmCommandLog = async () => {};

  const result = await smartThingsService.triggerSthmSilenceSwitch();

  assert.deepEqual(capturedOptions, {
    requireAll: false,
    requiredMappings: ['silence']
  });
  assert.deepEqual(captured.pulsed, {
    deviceId: 'silence-switch-1',
    options: { ensureReset: true, delayMs: 300 }
  });
  assert.deepEqual(result, {
    silenced: true,
    triggeredDeviceId: 'silence-switch-1',
    via: 'virtualSwitch'
  });
});

test('silenceAlarmDevice falls back to switch off when alarm off is unsupported', async (t) => {
  const originalSendDeviceCommand = smartThingsService.sendDeviceCommand;

  t.after(() => {
    smartThingsService.sendDeviceCommand = originalSendDeviceCommand;
  });

  const commands = [];
  smartThingsService.sendDeviceCommand = async (deviceId, payload) => {
    commands.push({
      deviceId,
      capability: payload[0]?.capability,
      command: payload[0]?.command
    });

    if (payload[0]?.capability === 'alarm') {
      const error = new Error('Command not supported');
      error.status = 422;
      throw error;
    }

    return { ok: true };
  };

  const result = await smartThingsService.silenceAlarmDevice('siren-device-1', {
    capabilities: ['alarm', 'switch'],
    categories: ['siren']
  });

  assert.deepEqual(commands, [
    {
      deviceId: 'siren-device-1',
      capability: 'alarm',
      command: 'off'
    },
    {
      deviceId: 'siren-device-1',
      capability: 'switch',
      command: 'off'
    }
  ]);
  assert.deepEqual(result, {
    deviceId: 'siren-device-1',
    via: 'switch.off'
  });
});

test('buildSmartThingsDeviceUpdate preserves generic SmartThings attribute snapshots for workflow triggers', async () => {
  const originalGetRoomName = smartThingsService.getRoomName;
  smartThingsService.getRoomName = async () => 'Laundry';

  try {
  const updates = await smartThingsService.buildSmartThingsDeviceUpdate(
    {
      name: 'Dryer Monitor',
      type: 'switch',
      room: 'Laundry',
      status: false,
      brightness: 0,
      temperature: undefined,
      targetTemperature: undefined,
      isOnline: false,
      lastSeen: new Date('2026-03-31T00:00:00.000Z'),
      brand: '',
      model: '',
      properties: {
        smartThingsCapabilities: ['switch'],
        smartThingsCategories: ['switch']
      }
    },
    {
      deviceId: 'st-device-1',
      name: 'Dryer Monitor',
      label: 'Dryer Monitor',
      locationId: 'location-1',
      roomId: 'room-1',
      manufacturerName: 'Aeotec',
      deviceTypeName: 'Outlet',
      presentationId: 'presentation-1',
      components: [
        {
          id: 'main',
          capabilities: [{ id: 'switch' }, { id: 'powerMeter' }, { id: 'energyMeter' }],
          categories: [{ name: 'switch' }]
        }
      ],
      healthState: {
        state: 'ONLINE',
        lastUpdatedDate: '2026-03-31T10:15:00.000Z'
      },
      status: {
        components: {
          main: {
            switch: {
              switch: {
                value: 'on'
              }
            },
            powerMeter: {
              power: {
                value: 812,
                unit: 'W'
              }
            },
            energyMeter: {
              energy: {
                value: 4.6,
                unit: 'kWh'
              }
            }
          }
        }
      }
    }
  );

  assert.equal(updates.status, true);
  assert.equal(updates.isOnline, true);
  assert.deepEqual(updates['properties.smartThingsAttributeValues'], {
    byComponent: {
      main: {
        switch: {
          switch: 'on'
        },
        powerMeter: {
          power: 812
        },
        energyMeter: {
          energy: 4.6
        }
      }
    },
    switch: {
      switch: 'on'
    },
    powerMeter: {
      power: 812
    },
    energyMeter: {
      energy: 4.6
    }
  });
  assert.equal(updates['properties.smartThingsAttributeMetadata'].powerMeter.power.unit, 'W');
  assert.equal(updates['properties.smartThingsAttributeMetadata'].energyMeter.energy.unit, 'kWh');
  assert.equal(updates['properties.smartThingsStatus'].components.main.powerMeter.power.value, 812);
  assert.equal(updates['properties.smartThingsComponents'][0].capabilities.length, 3);
  } finally {
    smartThingsService.getRoomName = originalGetRoomName;
  }
});
