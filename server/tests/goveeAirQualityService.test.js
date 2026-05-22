const test = require('node:test');
const assert = require('node:assert/strict');

const goveeAirQualityService = require('../services/goveeAirQualityService');

const {
  deriveUsAqiFromPm25,
  isAirQualityDevice,
  normalizeDeviceList,
  normalizeStateResponse
} = goveeAirQualityService.__testHooks;

test('detects H5106 and capability-based Govee indoor air devices', () => {
  assert.equal(isAirQualityDevice({
    sku: 'H5106',
    device: 'AA:BB',
    capabilities: []
  }), true);

  assert.equal(isAirQualityDevice({
    sku: 'H9999',
    device: 'AA:CC',
    type: 'devices.types.air_quality_monitor',
    capabilities: []
  }), true);

  assert.equal(isAirQualityDevice({
    sku: 'H9998',
    device: 'AA:DD',
    capabilities: [
      { type: 'devices.capabilities.property', instance: 'sensorTemperature' },
      { type: 'devices.capabilities.property', instance: 'sensorHumidity' }
    ]
  }), true);
});

test('normalizes Govee device discovery payloads', () => {
  const devices = normalizeDeviceList({
    data: {
      devices: [
        {
          sku: 'H5106',
          device: 'AA:BB:CC',
          deviceName: 'Kitchen Air',
          type: 'devices.types.air_quality_monitor',
          capabilities: [
            { type: 'devices.capabilities.property', instance: 'sensorTemperature' },
            { type: 'devices.capabilities.property', instance: 'sensorHumidity' },
            { type: 'devices.capabilities.property', instance: 'pm25' }
          ]
        }
      ]
    }
  });

  assert.equal(devices.length, 1);
  assert.equal(devices[0].sku, 'H5106');
  assert.equal(devices[0].isAirQualityDevice, true);
  assert.deepEqual(devices[0].capabilities.map((entry) => entry.instance), ['sensorTemperature', 'sensorHumidity', 'pm25']);
});

test('normalizes state response into indoor weather and telemetry metrics', () => {
  const sample = normalizeStateResponse({
    data: {
      sku: 'H5106',
      device: 'AA:BB:CC',
      capabilities: [
        { type: 'devices.capabilities.online', instance: 'online', state: { value: true } },
        { type: 'devices.capabilities.property', instance: 'sensorTemperature', state: { value: 71.6 }, parameters: { unit: 'fahrenheit' } },
        { type: 'devices.capabilities.property', instance: 'sensorHumidity', state: { value: 44.2 } },
        { type: 'devices.capabilities.property', instance: 'pm25', state: { value: 7.5 } }
      ]
    }
  }, {
    sku: 'H5106',
    device: 'AA:BB:CC',
    deviceName: 'Kitchen Air',
    type: 'devices.types.air_quality_monitor'
  }, {
    room: 'Kitchen',
    tempOffsetF: 0.4,
    humidityOffsetPct: -1,
    pm25OffsetUgM3: 0.5
  });

  assert.equal(sample.deviceName, 'Kitchen Air');
  assert.equal(sample.room, 'Kitchen');
  assert.equal(sample.isOnline, true);
  assert.equal(sample.temperatureF, 72);
  assert.equal(sample.humidityPct, 43.2);
  assert.equal(sample.pm25UgM3, 8);
  assert.equal(sample.usAqi, deriveUsAqiFromPm25(8));
  assert.equal(sample.qualityLabel, 'Good');
  assert.deepEqual(sample.metrics, {
    online: 1,
    temperature_f: 72,
    temperature_c: 22.2,
    humidity_pct: 43.2,
    pm2_5_ugm3: 8,
    air_quality_index: 44
  });
});
