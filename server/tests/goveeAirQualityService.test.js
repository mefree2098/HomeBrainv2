const test = require('node:test');
const assert = require('node:assert/strict');

const goveeAirQualityService = require('../services/goveeAirQualityService');

const {
  deriveUsAqiFromPm25,
  buildLanDiscoveryTargets,
  isAirQualityDevice,
  normalizeConnectionMode,
  normalizeLanTarget,
  normalizeLanTimeoutMs,
  normalizeDeviceList,
  normalizeLocalScanResponse,
  normalizeLocalStatusDiscoveryResponse,
  normalizeLocalStateResponse,
  normalizeStateResponse
} = goveeAirQualityService.__testHooks;

test('normalizes Govee connection modes safely', () => {
  assert.equal(normalizeConnectionMode('local'), 'local');
  assert.equal(normalizeConnectionMode('cloud'), 'cloud');
  assert.equal(normalizeConnectionMode('AUTO'), 'auto');
  assert.equal(normalizeConnectionMode('surprise'), 'auto');
});

test('normalizes Govee LAN timeout requests onto fixed safe durations', () => {
  assert.equal(normalizeLanTimeoutMs('surprise'), 3500);
  assert.equal(normalizeLanTimeoutMs(250), 1000);
  assert.equal(normalizeLanTimeoutMs(2400), 2500);
  assert.equal(normalizeLanTimeoutMs(3500), 5000);
  assert.equal(normalizeLanTimeoutMs(6000), 7500);
  assert.equal(normalizeLanTimeoutMs(60_000), 10_000);
});

test('normalizes Govee LAN scan targets from strings and objects', () => {
  assert.deepEqual(normalizeLanTarget('192.168.1.88'), {
    host: '192.168.1.88',
    port: 4001,
    command: 'scan'
  });
  assert.deepEqual(normalizeLanTarget('192.168.1.88:4010'), {
    host: '192.168.1.88',
    port: 4010,
    command: 'scan'
  });
  assert.deepEqual(normalizeLanTarget({ ip: '192.168.1.89', port: 4003, command: 'devStatus' }), {
    host: '192.168.1.89',
    port: 4003,
    command: 'devStatus'
  });
  assert.equal(normalizeLanTarget(''), null);
});

test('builds broad Govee LAN discovery targets with direct-IP probes', () => {
  const targets = buildLanDiscoveryTargets({
    localDeviceIp: '192.168.1.88',
    targets: ['192.168.1.99:4010', { host: '192.168.1.100', port: 4001 }],
    includeSubnetSweep: false
  });
  const keys = new Set(targets.map((target) => `${target.host}:${target.port}:${target.command}`));

  assert.equal(keys.has('239.255.255.250:4001:scan'), true);
  assert.equal(keys.has('255.255.255.255:4001:scan'), true);
  assert.equal(keys.has('192.168.1.88:4001:scan'), true);
  assert.equal(keys.has('192.168.1.88:4003:devStatus'), true);
  assert.equal(keys.has('192.168.1.99:4010:scan'), true);
  assert.equal(keys.has('192.168.1.100:4001:scan'), true);
  assert.equal(keys.size, targets.length);
});

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

test('normalizes Govee LAN scan responses with local endpoint details', () => {
  const device = normalizeLocalScanResponse({
    msg: {
      cmd: 'scan',
      data: {
        ip: '192.168.1.88',
        device: 'AA:BB:CC:DD',
        sku: 'H5106',
        deviceName: 'Kitchen Air',
        wifiVersionHard: '1.00.10'
      }
    }
  }, { address: '192.168.1.88', port: 4002 });

  assert.equal(device.sku, 'H5106');
  assert.equal(device.device, 'AA:BB:CC:DD');
  assert.equal(device.ip, '192.168.1.88');
  assert.equal(device.port, 4003);
  assert.equal(device.isAirQualityDevice, true);
  assert.equal(device.lanApiSupported, true);
});

test('normalizes direct Govee LAN devStatus responses as discoverable devices', () => {
  const device = normalizeLocalStatusDiscoveryResponse({
    msg: {
      cmd: 'devStatus',
      data: {
        online: true,
        tempC: 22.5,
        humidity: 41,
        pm25: 5.2
      }
    }
  }, { address: '192.168.1.88', port: 4002 });

  assert.equal(device.sku, 'LAN');
  assert.equal(device.device, '192.168.1.88');
  assert.equal(device.ip, '192.168.1.88');
  assert.equal(device.port, 4003);
  assert.equal(device.lanApiSupported, true);
  assert.equal(device.isAirQualityDevice, true);
  assert.deepEqual(device.capabilities.map((capability) => capability.instance), [
    'sensorTemperature',
    'sensorHumidity',
    'pm25'
  ]);
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

test('normalizes OpenAPI payload state responses into indoor weather metrics', () => {
  const sample = normalizeStateResponse({
    requestId: 'test-request',
    code: 200,
    payload: {
      sku: 'H5106',
      device: 'AA:BB:CC',
      capabilities: [
        { type: 'devices.capabilities.online', instance: 'online', state: { value: true } },
        { type: 'devices.capabilities.property', instance: 'sensorTemperature', state: { value: 22.4 }, parameters: { unit: 'Celsius' } },
        { type: 'devices.capabilities.property', instance: 'sensorHumidity', state: { value: 39.6 } },
        { type: 'devices.capabilities.property', instance: 'airQuality', state: { value: 17 } }
      ]
    }
  }, {
    deviceName: 'Office Air'
  }, {
    room: 'Office'
  });

  assert.equal(sample.device, 'AA:BB:CC');
  assert.equal(sample.sku, 'H5106');
  assert.equal(sample.deviceName, 'Office Air');
  assert.equal(sample.temperatureF, 72.3);
  assert.equal(sample.temperatureC, 22.4);
  assert.equal(sample.humidityPct, 39.6);
  assert.equal(sample.pm25UgM3, 17);
  assert.equal(sample.usAqi, deriveUsAqiFromPm25(17));
  assert.deepEqual(sample.stateInstances, ['online', 'sensorTemperature', 'sensorHumidity', 'airQuality']);
});

test('normalizes local LAN state responses when indoor metrics are exposed', () => {
  const sample = normalizeLocalStateResponse({
    msg: {
      cmd: 'devStatus',
      data: {
        online: true,
        tempC: 22.5,
        humidity: 41,
        pm25: 5.2,
        airQualityIndex: 22
      }
    }
  }, {
    sku: 'H5106',
    device: 'AA:BB:CC',
    deviceName: 'Kitchen Air',
    type: 'govee_lan',
    ip: '192.168.1.88'
  }, {
    room: 'Kitchen'
  });

  assert.equal(sample.source, 'local_lan');
  assert.equal(sample.localIp, '192.168.1.88');
  assert.equal(sample.temperatureF, 72.5);
  assert.equal(sample.humidityPct, 41);
  assert.equal(sample.pm25UgM3, 5.2);
  assert.equal(sample.usAqi, 22);
});

test('local LAN light-style status does not invent indoor air readings', () => {
  const sample = normalizeLocalStateResponse({
    msg: {
      cmd: 'devStatus',
      data: {
        onOff: 1,
        brightness: 50,
        colorTemInKelvin: 4000
      }
    }
  }, {
    sku: 'H6159',
    device: 'AA:BB:CC',
    deviceName: 'Strip',
    type: 'govee_lan',
    ip: '192.168.1.90'
  }, {
    room: 'Theater'
  });

  assert.equal(sample.temperatureF, null);
  assert.equal(sample.humidityPct, null);
  assert.equal(sample.pm25UgM3, null);
  assert.equal(sample.usAqi, null);
  assert.equal(sample.qualityLabel, 'Unknown');
});
