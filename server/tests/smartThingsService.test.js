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

test('dismissSthmAlert triggers the configured dismiss switch', async (t) => {
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
        dismissDeviceId: 'dismiss-switch-1'
      }
    };
  };
  smartThingsService.pulseVirtualSwitch = async (deviceId, options) => {
    captured.pulsed = { deviceId, options };
  };
  smartThingsService.updateSthmCommandLog = async () => {};

  const result = await smartThingsService.dismissSthmAlert();

  assert.deepEqual(capturedOptions, {
    requireAll: false,
    requiredMappings: ['dismiss']
  });
  assert.deepEqual(captured.pulsed, {
    deviceId: 'dismiss-switch-1',
    options: { ensureReset: true, delayMs: 300 }
  });
  assert.deepEqual(result, {
    dismissed: true,
    triggeredDeviceId: 'dismiss-switch-1',
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
