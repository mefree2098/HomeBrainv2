const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
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
