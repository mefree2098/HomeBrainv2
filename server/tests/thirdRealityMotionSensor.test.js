const test = require('node:test');
const assert = require('node:assert/strict');

const directRadioProtocolCatalogService = require('../services/directRadioProtocolCatalogService');
const {
  extractZigbeeMessageState,
  readZigbeeRuntimeState
} = require('../services/directRadioHelpers');
const securityAlarmService = require('../services/securityAlarmService');

test('THIRDREALITY 3RMS16BZ catalog entry exposes native motion and battery support', () => {
  const catalog = directRadioProtocolCatalogService.searchZigbeeCatalog({
    model: '3RMS16BZ',
    includeExposes: true,
    limit: 5
  });
  const entry = catalog.entries.find((candidate) => candidate.model === '3RMS16BZ');

  assert.ok(entry);
  assert.equal(entry.vendor, 'Third Reality');
  assert.deepEqual(entry.zigbeeModels, ['3RMS16BZ']);
  assert.equal(entry.ota, true);
  assert.ok(entry.homebrainFeatures.includes('motion'));
  assert.ok(entry.homebrainFeatures.includes('battery'));
  assert.ok(entry.capabilities.some((capability) => capability.type === 'motion_sensor'));
  assert.ok(entry.capabilities.some((capability) => capability.type === 'battery'));
  assert.ok(entry.exposes.some((expose) => expose.property === 'occupancy'));
  assert.ok(entry.exposes.some((expose) => expose.property === 'battery'));
  assert.ok(entry.exposes.some((expose) => expose.property === 'voltage' && expose.unit === 'mV'));
});

test('THIRDREALITY 3RMS16BZ IAS and power reports normalize motion, clear, and battery telemetry', () => {
  const motion = extractZigbeeMessageState({
    cluster: 'ssIasZone',
    data: { zoneStatus: 0x0001 }
  }, ['motion', 'battery']);
  const clear = extractZigbeeMessageState({
    cluster: 'ssIasZone',
    data: { zoneStatus: 0x0000 }
  }, ['motion', 'battery']);
  const battery = extractZigbeeMessageState({
    cluster: 'genPowerCfg',
    data: {
      batteryPercentageRemaining: 164,
      batteryVoltage: 30,
      batteryLow: false
    }
  }, ['motion', 'battery']);

  assert.equal(motion.motionActive, true);
  assert.equal(motion.motion, 'active');
  assert.equal(clear.motionActive, false);
  assert.equal(clear.motion, 'inactive');
  assert.equal(battery.batteryLevel, 82);
  assert.equal(battery.batteryVoltage, 3);
  assert.equal(battery.batteryLow, false);
});

test('THIRDREALITY 3RMS16BZ runtime state reaches the Security Center with its room assignment', () => {
  const runtime = readZigbeeRuntimeState({
    state: {
      occupancy: true,
      battery: 76,
      voltage: 2980,
      battery_low: false
    },
    endpoints: []
  }, {
    features: ['motion', 'battery']
  });

  assert.equal(runtime.status, true);
  assert.equal(runtime.directRadioState.motionActive, true);
  assert.equal(runtime.directRadioState.batteryLevel, 76);
  assert.equal(runtime.directRadioState.batteryVoltage, 2.98);

  const summary = securityAlarmService.buildSecuritySensorSummary({
    device: {
      _id: 'third-reality-motion-1',
      name: 'Hall Motion',
      type: 'sensor',
      room: 'Upstairs',
      status: false,
      isOnline: true,
      lastSeen: '2026-07-10T15:00:00.000Z',
      properties: {
        source: 'homebrain-zigbee',
        directRadioFeatures: ['battery', 'motion'],
        directRadioState: runtime.directRadioState,
        homebrainDirect: {
          protocol: 'zigbee',
          modelID: '3RMS16BZ'
        }
      }
    },
    zone: null
  });

  assert.equal(summary.sensorType, 'motion');
  assert.equal(summary.sensorTypeLabel, 'Motion');
  assert.equal(summary.isActive, true);
  assert.equal(summary.stateLabel, 'Motion');
  assert.equal(summary.batteryLevel, 76);
  assert.equal(summary.room, 'Upstairs');
});
