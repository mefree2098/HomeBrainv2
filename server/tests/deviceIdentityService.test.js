const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const {
  buildHarmonyDeviceIdentityQuery,
  normalizePlatformIdentityProperties,
  ensureUniquePlatformIdentity
} = require('../services/deviceIdentityService');

test('normalizePlatformIdentityProperties normalizes supported platform identity fields', () => {
  const normalized = normalizePlatformIdentityProperties({
    source: ' SMARTTHINGS ',
    smartThingsDeviceId: ' abc-123 ',
    harmonyHubIp: ' https://Example.Local:8088/path ',
    harmonyRemoteId: ' remote-77 ',
    harmonyActivityId: 42,
    ecobeeDeviceType: ' SENSOR ',
    ecobeeSensorKey: ' thermostat-1:sensor-2 ',
    tempest: {
      stationId: '42'
    }
  });

  assert.equal(normalized.source, 'smartthings');
  assert.equal(normalized.smartThingsDeviceId, 'abc-123');
  assert.equal(normalized.harmonyHubIp, 'example.local');
  assert.equal(normalized.harmonyRemoteId, 'remote-77');
  assert.equal(normalized.harmonyActivityId, '42');
  assert.equal(normalized.ecobeeDeviceType, 'sensor');
  assert.equal(normalized.ecobeeSensorKey, 'thermostat-1:sensor-2');
  assert.equal(normalized.tempest.stationId, 42);
});

test('buildHarmonyDeviceIdentityQuery matches on Harmony remoteId or hub IP', () => {
  const query = buildHarmonyDeviceIdentityQuery('https://Example.Local:8088', '55', 'remote-55');

  assert.deepEqual(query, {
    $or: [
      { 'properties.harmonyRemoteId': 'remote-55' },
      { 'properties.harmonyHubIp': 'example.local' }
    ],
    'properties.harmonyDeviceId': '55'
  });
});

test('ensureUniquePlatformIdentity rejects duplicate Ecobee sensor identities', async (t) => {
  const originalFindOne = Device.findOne;

  t.after(() => {
    Device.findOne = originalFindOne;
  });

  let observedQuery = null;
  Device.findOne = async (query) => {
    observedQuery = query;
    return {
      _id: 'device-existing',
      name: 'Hall Sensor'
    };
  };

  await assert.rejects(
    () => ensureUniquePlatformIdentity({
      source: 'ecobee',
      ecobeeDeviceType: 'sensor',
      ecobeeSensorKey: 'thermostat-1:sensor-2'
    }),
    /Ecobee sensor key already exists/i
  );

  assert.equal(observedQuery['properties.ecobeeSensorKey'], 'thermostat-1:sensor-2');
});
