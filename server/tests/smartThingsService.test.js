const test = require('node:test');
const assert = require('node:assert/strict');

const smartThingsService = require('../services/smartThingsService');

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
