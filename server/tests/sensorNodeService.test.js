const test = require('node:test');
const assert = require('node:assert/strict');

const sensorNodeService = require('../services/sensorNodeService');

const {
  buildRuntimeConfig,
  hashSecret,
  nodeIsFresh,
  normalizeReadingPayload,
  normalizeSettings,
  secureEqual,
  serializeNode
} = sensorNodeService._private;

test('sensor reading contract accepts firmware field names and derives Fahrenheit', () => {
  const reading = normalizeReadingPayload({
    schema: sensorNodeService.SENSOR_SCHEMA,
    profile: 'air-station',
    firmware_version: '1.0.0',
    hardware_id: 'XIAO-C6-AABBCC',
    sequence: 42,
    capabilities: ['CO2', 'particulate', 'co2'],
    readings: {
      temperature_c: 21.25,
      humidity_pct: 44.2,
      co2_ppm: 812,
      pm2_5_ugm3: 6.4,
      presence_present: 0
    },
    power: { usb_powered: 1 },
    diagnostics: { signal_rssi_dbm: -61, ip_address: '192.168.1.44' }
  });

  assert.equal(reading.readings.temperature_f, 70.25);
  assert.equal(reading.readings.presence_present, false);
  assert.equal(reading.power.usb_powered, true);
  assert.deepEqual(reading.capabilities, ['co2', 'particulate']);
  assert.equal(reading.sequence, 42);
});

test('sensor reading contract rejects unknown schemas and empty or out-of-range data', () => {
  assert.throws(
    () => normalizeReadingPayload({ schema: 'future.schema.v9', readings: { temperature_c: 20 } }),
    /Unsupported sensor reading schema/
  );
  assert.throws(
    () => normalizeReadingPayload({ readings: { temperature_c: 900, humidity_pct: -1 } }),
    /no valid measurements/
  );
});

test('sensor settings apply profile defaults and clamp unsafe values', () => {
  assert.deepEqual(normalizeSettings({}, 'climate', 'battery'), {
    reportingIntervalSeconds: 300,
    deepSleepEnabled: true,
    temperatureOffsetC: 0,
    humidityOffsetPct: 0,
    altitudeMeters: 0,
    presenceHoldSeconds: 30
  });

  const settings = normalizeSettings({
    reporting_interval_seconds: 1,
    temperature_offset_c: 99,
    humidity_offset_pct: -99,
    altitude_meters: 12000,
    presence_hold_seconds: 9999
  }, 'presence', 'wired');
  assert.equal(settings.reportingIntervalSeconds, 10);
  assert.equal(settings.deepSleepEnabled, false);
  assert.equal(settings.temperatureOffsetC, 20);
  assert.equal(settings.humidityOffsetPct, -50);
  assert.equal(settings.altitudeMeters, 9000);
  assert.equal(settings.presenceHoldSeconds, 3600);
});

test('sensor runtime config is stable and stale nodes serialize offline', () => {
  const now = Date.now();
  const node = {
    _id: 'node-123',
    name: 'Bedroom Climate',
    room: 'Bedroom',
    profile: 'climate',
    powerSource: 'battery',
    status: 'online',
    lastSeen: new Date(now - 10 * 60 * 1000),
    deviceTokenVersion: 3,
    settings: {
      reportingIntervalSeconds: 120,
      deepSleepEnabled: true,
      temperatureOffsetC: 0.4,
      humidityOffsetPct: -2,
      altitudeMeters: 1550,
      presenceHoldSeconds: 30
    }
  };

  assert.equal(nodeIsFresh(node, now), false);
  assert.equal(serializeNode(node, now).status, 'offline');
  assert.deepEqual(buildRuntimeConfig(node), {
    schema: sensorNodeService.CONFIG_SCHEMA,
    node_id: 'node-123',
    profile: 'climate',
    reporting_interval_seconds: 120,
    deep_sleep_enabled: true,
    calibration: {
      temperature_offset_c: 0.4,
      humidity_offset_pct: -2,
      altitude_meters: 1550
    },
    presence_hold_seconds: 30,
    token_version: 3
  });
});

test('sensor secrets are node-bound and compared in constant-time compatible form', () => {
  const first = hashSecret('node-a', 'SECRET');
  assert.equal(secureEqual(first, hashSecret('node-a', 'SECRET')), true);
  assert.equal(secureEqual(first, hashSecret('node-b', 'SECRET')), false);
  assert.equal(secureEqual(first, hashSecret('node-a', 'WRONG')), false);
});

test('provisioning identifies the hardware Wi-Fi suffix without inventing one from the database ID', () => {
  const { buildProvisioning } = sensorNodeService._private;
  assert.equal(buildProvisioning({ _id: '507f1f77bcf86cd799439011' }, null, 'https://home.example').portalName,
    'HomeBrain-Sensor-XXXXXX');
  assert.equal(buildProvisioning({ _id: '507f1f77bcf86cd799439011', hardwareId: 'XIAO-C6-001122ABCDEF' }, null, 'https://home.example').portalName,
    'HomeBrain-Sensor-ABCDEF');
});

test('activation consumes the setup code once and rotation revokes the old device token', async () => {
  const nodeId = '507f1f77bcf86cd799439011';
  let stored = {
    _id: nodeId, name: 'Bedroom', room: 'Bedroom', profile: 'climate',
    powerSource: 'battery', status: 'provisioning', deviceTokenVersion: 0,
    setupCodeHash: hashSecret(nodeId, 'SETUP'), setupCodeUsedAt: null,
    setupCodeExpiresAt: new Date(Date.now() + 60_000)
  };
  const read = () => {
    const snapshot = structuredClone(stored);
    snapshot.save = async () => {
      const { save: _save, ...fields } = snapshot;
      stored = structuredClone(fields);
    };
    return snapshot;
  };
  const service = new sensorNodeService.SensorNodeService({
    SensorNodeModel: {
      findById: () => ({ select: async () => read() }),
      findOne: async () => null,
      findOneAndUpdate: async (filter, update) => {
        if (stored.setupCodeHash !== filter.setupCodeHash || stored.setupCodeUsedAt
          || stored.setupCodeExpiresAt <= filter.setupCodeExpiresAt.$gt) return null;
        stored = { ...stored, ...update.$set, deviceTokenVersion: stored.deviceTokenVersion + update.$inc.deviceTokenVersion };
        return read();
      }
    }
  });
  const results = await Promise.allSettled([
    service.activateNode(nodeId, 'SETUP'), service.activateNode(nodeId, 'SETUP')
  ]);
  const successful = results.filter((result) => result.status === 'fulfilled');
  assert.equal(successful.length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409);
  const { deviceToken, node } = successful[0].value;
  assert.equal(node.deviceTokenHash, undefined);
  assert.equal(node.setupCodeHash, undefined);
  assert.equal(stored.deviceTokenVersion, 1);
  assert.equal((await service.getRuntimeConfig(nodeId, deviceToken)).node_id, nodeId);
  await assert.rejects(service.getRuntimeConfig(nodeId, 'WRONG'), { status: 401 });
  await assert.rejects(service.activateNode(nodeId, 'SETUP'), { status: 409 });

  const rotated = await service.rotateSetupCode(nodeId, 'https://home.example');
  assert.equal(rotated.node.status, 'provisioning');
  await assert.rejects(service.getRuntimeConfig(nodeId, deviceToken), { status: 401 });
  await assert.rejects(service.activateNode(nodeId, 'SETUP'), { status: 401 });
  stored.setupCodeExpiresAt = new Date(Date.now() - 1);
  await assert.rejects(service.activateNode(nodeId, rotated.provisioning.setupCode), { status: 410 });
});

test('sensor readings update the linked device and reach normal device events without exposing secrets', async () => {
  let saves = 0;
  const node = { _id: '507f1f77bcf86cd799439011', deviceId: '507f1f77bcf86cd799439012',
    profile: 'presence', powerSource: 'wired', deviceTokenHash: 'private', setupCodeHash: 'private',
    hardwareId: 'XIAO-C6-1234', save: async () => { saves += 1; } };
  const device = { _id: node.deviceId, properties: { retained: true }, save: async () => { saves += 1; } };
  const events = [];
  const service = new sensorNodeService.SensorNodeService({
    DeviceModel: { findById: async () => device },
    deviceUpdateEmitter: { normalizeDevices: (values) => values, emit: (name, values) => events.push({ name, values }) }
  });
  service.authenticateToken = async () => node;
  const result = await service.ingestReading(node._id, 'TOKEN', {
    hardware_id: node.hardwareId, readings: { temperature_c: 20, presence_present: false },
    power: { usb_powered: true }
  });
  assert.equal(result.accepted, true);
  assert.equal(result.node.deviceTokenHash, undefined);
  assert.equal(device.temperature, 68);
  assert.equal(device.isOnline, true);
  assert.equal(device.status, false);
  assert.equal(device.properties.retained, true);
  assert.equal(device.properties.source, 'homebrain-sensor');
  assert.equal(device.properties.homebrainSensor.readings.presence_present, false);
  assert.equal(saves, 2);
  assert.equal(events[0].name, 'devices:update');
  await assert.rejects(service.ingestReading(node._id, 'TOKEN', {
    hardware_id: 'DIFFERENT', readings: { temperature_c: 20 }
  }), { status: 409 });
  assert.equal(saves, 2);
});
