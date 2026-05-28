const test = require('node:test');
const assert = require('node:assert/strict');

const directRadioService = require('../services/directRadioService');
const Device = require('../models/Device');

const DirectRadioService = directRadioService.DirectRadioService;
const {
  inferFeaturesFromZigbeeDefinition,
  mergeSmartThingsTelemetryFallback,
  mergeDirectDeviceUpdateForExisting,
  selectPrimaryDirectDeviceRecord,
  scoreDetachedSmartThingsMigrationSource
} = directRadioService._test;
const DEVICE_ID = '507f1f77bcf86cd799439011';
const SOURCE_DEVICE_ID = '507f1f77bcf86cd799439012';

function createService() {
  const service = new DirectRadioService();
  service.zwave.removeNodeStatusEnum = {
    2: 'NodeFound',
    6: 'Done',
    7: 'Failed'
  };
  service.zwave.addNodeStatusEnum = {
    6: 'Done',
    7: 'Failed'
  };
  return service;
}

test('direct radio refresh preserves user-edited name and room while updating live state', () => {
  const existing = {
    name: 'Cold Storage Switch',
    type: 'switch',
    room: 'Cold Storage',
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 6,
        generatedName: '39348 / 39455 / ZW4008',
        generatedRoom: 'Unassigned'
      },
      directRadioFeatures: ['switch']
    }
  };
  const update = {
    name: '39348 / 39455 / ZW4008',
    type: 'switch',
    room: 'Unassigned',
    status: true,
    isOnline: true,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 6,
        status: 4
      },
      directRadioFeatures: ['illuminance', 'switch'],
      supportsSwitch: true
    }
  };

  const merged = mergeDirectDeviceUpdateForExisting(existing, update);

  assert.equal(merged.name, 'Cold Storage Switch');
  assert.equal(merged.room, 'Cold Storage');
  assert.equal(merged.status, true);
  assert.equal(merged.properties.homebrainDirect.nodeId, 6);
  assert.equal(merged.properties.homebrainDirect.generatedName, '39348 / 39455 / ZW4008');
  assert.deepEqual(merged.properties.directRadioFeatures, ['illuminance', 'switch']);
  assert.ok(merged.properties.directRadioCapabilities.some((capability) => capability.type === 'switch'));
});

test('direct radio refresh preserves SmartThings-inferred switch features after Zigbee migration', () => {
  const existing = {
    name: 'Vault Overhead Lights',
    type: 'switch',
    room: 'Vault',
    properties: {
      source: 'homebrain-zigbee',
      smartThingsDeviceId: 'f6d7fcd7-9504-4c74-baa6-7404c8aa2fd3',
      smartThingsCapabilities: ['switch', 'firmwareUpdate', 'refresh'],
      smartThingsCategories: ['switch'],
      smartThingsDeviceNetworkType: 'ZIGBEE',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x5c0272fffeadf493',
        generatedName: 'SP 224',
        generatedRoom: 'Unassigned'
      },
      directRadioFeatures: []
    }
  };
  const update = {
    name: 'SP 224',
    type: 'sensor',
    room: 'Unassigned',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x5c0272fffeadf493'
      },
      directRadioFeatures: []
    }
  };

  const merged = mergeDirectDeviceUpdateForExisting(existing, update);

  assert.equal(merged.name, 'Vault Overhead Lights');
  assert.equal(merged.room, 'Vault');
  assert.equal(merged.type, 'switch');
  assert.equal(merged.properties.source, 'homebrain-zigbee');
  assert.ok(merged.properties.directRadioFeatures.includes('switch'));
  assert.ok(merged.properties.directRadioCapabilities.some((capability) => capability.type === 'switch'));
});

test('direct radio refresh infers renamed generic door sensor features', () => {
  const existing = {
    name: 'Theater Door Sensor',
    type: 'sensor',
    room: 'Vault',
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f000b010d0c',
        generatedName: 'Zigbee 010d0c',
        generatedRoom: 'Unassigned'
      },
      directRadioFeatures: []
    }
  };
  const update = {
    name: 'Zigbee 010d0c',
    type: 'sensor',
    room: 'Unassigned',
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f000b010d0c'
      },
      directRadioFeatures: []
    }
  };

  const merged = mergeDirectDeviceUpdateForExisting(existing, update);

  assert.equal(merged.name, 'Theater Door Sensor');
  assert.equal(merged.room, 'Vault');
  assert.ok(merged.properties.directRadioFeatures.includes('contact'));
  assert.ok(merged.properties.directRadioFeatures.includes('battery'));
  assert.ok(merged.properties.directRadioFeatures.includes('tamper'));
  assert.ok(merged.properties.directRadioFeatures.includes('temperature'));
  assert.equal(merged.properties.supportsContactSensor, true);
  assert.equal(merged.properties.supportsBattery, true);
  assert.ok(merged.properties.directRadioCapabilities.some((capability) => capability.type === 'contact_sensor'));
});

test('Zigbee feature inference falls back to endpoint clusters for Innr SP 224 plugs', () => {
  const features = inferFeaturesFromZigbeeDefinition(null, {
    modelID: 'SP 224',
    manufacturerName: 'innr',
    endpoints: [
      {
        ID: 1,
        inputClusters: [0, 3, 4, 5, 6, 2820, 1794]
      }
    ]
  });

  assert.ok(features.includes('switch'));
  assert.ok(features.includes('power'));
  assert.ok(features.includes('energy'));
});

test('Zigbee normalization enriches devices from the installed converter catalog', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x00158d0000000000',
    modelID: 'SP 224',
    manufacturerName: 'innr',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [0, 3, 4, 5, 6]
      }
    ]
  }, 'sync');

  assert.equal(normalized.update.model, 'SP 224');
  assert.equal(normalized.update.brand, 'Innr');
  assert.ok(normalized.update.properties.directRadioFeatures.includes('switch'));
  assert.equal(normalized.update.properties.homebrainDirect.catalog.model, 'SP 224');
  assert.ok(normalized.update.properties.directRadioCatalog.exposes.some((expose) => expose.type === 'switch'));
});

test('Zigbee normalization preserves state when no on/off attribute is observed', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x00158d0000000001',
    modelID: 'SP 224',
    manufacturerName: 'innr',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [0, 3, 4, 5, 6]
      }
    ]
  }, 'message');

  assert.equal(Object.prototype.hasOwnProperty.call(normalized.update, 'status'), false);
});

test('Zigbee normalization reads on/off state from endpoint attributes', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x00158d0000000002',
    modelID: 'SP 224',
    manufacturerName: 'innr',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [0, 3, 4, 5, 6],
        getClusterAttributeValue(cluster, attribute) {
          if (cluster === 'genOnOff' && attribute === 'onOff') {
            return 1;
          }
          return undefined;
        }
      }
    ]
  }, 'message');

  assert.equal(normalized.update.status, true);
});

test('Zigbee normalization captures color temperature from RGBW endpoint attributes', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0xf0d1b80000008d11',
    modelID: 'FLEX RGBW',
    manufacturerName: 'LEDVANCE',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [0, 3, 4, 5, 6, 8, 768],
        getClusterAttributeValue(cluster, attribute) {
          if (cluster === 'lightingColorCtrl' && attribute === 'colorTemperature') {
            return 370;
          }
          return undefined;
        }
      }
    ]
  }, 'sync');

  assert.equal(normalized.update.colorTemperature, 2703);
  assert.equal(normalized.update.properties.directRadioState.colorTemperatureK, 2703);
  assert.ok(normalized.update.properties.directRadioFeatures.includes('colorTemperature'));
  assert.equal(normalized.update.properties.supportsColorTemperature, true);
});

test('Zigbee normalization captures contact, temperature, tamper, and battery state from sensor reports', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x000d6f000b11f6e5',
    modelID: 'MCT-340 E',
    manufacturerName: 'Visonic',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [1, 1026, 1280],
        getClusterAttributeValue(cluster, attribute) {
          if (cluster === 'ssIasZone' && attribute === 'zoneStatus') {
            return 0x000d;
          }
          if (cluster === 'genPowerCfg' && attribute === 'batteryPercentageRemaining') {
            return 174;
          }
          if (cluster === 'msTemperatureMeasurement' && attribute === 'measuredValue') {
            return 2145;
          }
          return undefined;
        }
      }
    ]
  }, 'message');

  const state = normalized.update.properties.directRadioState;
  assert.equal(normalized.update.status, true);
  assert.equal(normalized.update.temperature, 70.7);
  assert.equal(state.contactOpen, true);
  assert.equal(state.contact, 'open');
  assert.equal(state.tamperActive, true);
  assert.equal(state.batteryLow, true);
  assert.equal(state.batteryLevel, 87);
  assert.equal(state.temperatureC, 21.5);
  assert.equal(state.temperatureF, 70.7);
  assert.ok(normalized.update.properties.directRadioFeatures.includes('contact'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('battery'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('tamper'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('temperature'));
  assert.equal(normalized.update.properties.supportsContactSensor, true);
});

test('Zigbee normalization estimates battery level from voltage-only sensor reports', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x000d6f000b010d0c',
    modelID: 'MCT-340 E',
    manufacturerName: 'Visonic',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [1, 1280],
        getClusterAttributeValue(cluster, attribute) {
          if (cluster === 'ssIasZone' && attribute === 'zoneStatus') {
            return 0x0000;
          }
          if (cluster === 'genPowerCfg' && attribute === 'batteryVoltage') {
            return 24;
          }
          return undefined;
        }
      }
    ]
  }, 'message');

  const state = normalized.update.properties.directRadioState;
  assert.equal(state.batteryVoltage, 2.4);
  assert.equal(state.batteryLevel, 33);
  assert.ok(normalized.update.properties.directRadioFeatures.includes('battery'));
});

test('Zigbee normalization captures direct electrical measurement telemetry', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x5c0272fffeadf493',
    modelID: 'SP 224',
    manufacturerName: 'innr',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [0, 3, 4, 5, 6, 2820, 1794],
        getClusterAttributeValue(cluster, attribute) {
          const clusterKey = String(cluster).toLowerCase();
          if (clusterKey === 'haelectricalmeasurement' || cluster === 2820) {
            const values = {
              activePower: 123,
              acPowerMultiplier: 1,
              acPowerDivisor: 10,
              rmsVoltage: 1215,
              acVoltageMultiplier: 1,
              acVoltageDivisor: 10,
              rmsCurrent: 1525,
              acCurrentMultiplier: 1,
              acCurrentDivisor: 1000
            };
            return values[attribute];
          }
          if (clusterKey === 'semetering' || cluster === 1794) {
            const values = {
              currentSummDelivered: 4567,
              multiplier: 1,
              divisor: 1000
            };
            return values[attribute];
          }
          return undefined;
        }
      }
    ]
  }, 'message');

  const state = normalized.update.properties.directRadioState;
  assert.equal(state.powerW, 12.3);
  assert.equal(state.energyKwh, 4.567);
  assert.equal(state.voltageV, 121.5);
  assert.equal(state.currentA, 1.525);
  assert.ok(normalized.update.properties.directRadioFeatures.includes('power'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('energy'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('voltage'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('current'));
  assert.equal(normalized.update.properties.supportsPowerMeter, true);
  assert.equal(normalized.update.properties.supportsEnergyMeter, true);
  assert.equal(normalized.update.properties.supportsVoltage, true);
  assert.equal(normalized.update.properties.supportsCurrent, true);
});

test('Zigbee control reads back on/off state after command acknowledgement', async () => {
  const service = createService();
  const calls = [];
  const endpoint = {
    ID: 1,
    async command(cluster, command, payload) {
      calls.push({ type: 'command', cluster, command, payload });
      return {};
    },
    async read(cluster, attributes) {
      calls.push({ type: 'read', cluster, attributes });
      return { onOff: 1 };
    }
  };
  service.getDirectNodeForDevice = () => ({
    getEndpoint() {
      return endpoint;
    }
  });

  const updateData = {};
  await service.controlZigbeeDevice({
    _id: DEVICE_ID,
    name: 'Vault Overhead Lights',
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x5c0272fffeadf493'
      }
    }
  }, 'turnon', true, updateData);

  assert.deepEqual(calls[0], {
    type: 'command',
    cluster: 'genOnOff',
    command: 'on',
    payload: {}
  });
  assert.deepEqual(calls[1], {
    type: 'read',
    cluster: 'genOnOff',
    attributes: ['onOff']
  });
  assert.equal(updateData.status, true);
  assert.equal(updateData.isOnline, true);
});

test('Zigbee control reads back color temperature after command acknowledgement', async () => {
  const service = createService();
  const calls = [];
  const endpoint = {
    ID: 1,
    inputClusters: [6, 8, 768],
    async command(cluster, command, payload) {
      calls.push({ type: 'command', cluster, command, payload });
      return {};
    },
    async read(cluster, attributes) {
      calls.push({ type: 'read', cluster, attributes });
      return { colorTemperature: 250 };
    }
  };
  service.getDirectNodeForDevice = () => ({
    getEndpoint() {
      return endpoint;
    }
  });

  const updateData = {};
  await service.controlZigbeeDevice({
    _id: DEVICE_ID,
    name: 'Vault LED Strip',
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0xf0d1b80000008d11'
      }
    }
  }, 'setcolortemperature', 4000, updateData);

  assert.deepEqual(calls[0], {
    type: 'command',
    cluster: 'lightingColorCtrl',
    command: 'moveToColorTemp',
    payload: { colortemp: 250, transtime: 0 }
  });
  assert.deepEqual(calls[1], {
    type: 'read',
    cluster: 'lightingColorCtrl',
    attributes: ['colorTemperature']
  });
  assert.equal(updateData.colorTemperature, 4000);
  assert.equal(updateData.status, true);
});

test('Zigbee control selects command-capable endpoints beyond the usual 1/2 switch endpoints', async () => {
  const service = createService();
  const calls = [];
  const endpointOne = { ID: 1, inputClusters: [0, 3] };
  const endpointTwo = { ID: 2, inputClusters: [0, 3] };
  const endpointThree = {
    ID: 3,
    inputClusters: [0, 3, 4, 5, 6, 8, 768],
    async command(cluster, command, payload) {
      calls.push({ endpoint: 3, type: 'command', cluster, command, payload });
      return {};
    },
    async read(cluster, attributes) {
      calls.push({ endpoint: 3, type: 'read', cluster, attributes });
      return { onOff: 1 };
    }
  };
  service.getDirectNodeForDevice = () => ({
    getEndpoint(id) {
      return {
        1: endpointOne,
        2: endpointTwo,
        3: endpointThree
      }[id] || null;
    }
  });

  const updateData = {};
  await service.controlZigbeeDevice({
    _id: DEVICE_ID,
    name: 'Vault Can Light',
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x84182600000638c0'
      }
    }
  }, 'turnon', true, updateData);

  assert.deepEqual(calls[0], {
    endpoint: 3,
    type: 'command',
    cluster: 'genOnOff',
    command: 'on',
    payload: {}
  });
  assert.equal(updateData.status, true);
});

test('direct radio merge keeps existing state when Zigbee refresh has no state payload', () => {
  const merged = mergeDirectDeviceUpdateForExisting({
    name: 'Vault Overhead Lights',
    type: 'switch',
    room: 'Vault',
    status: true,
    brightness: 75,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x5c0272fffeadf493'
      },
      directRadioFeatures: ['switch']
    }
  }, {
    name: 'SP 224',
    type: 'switch',
    room: 'Unassigned',
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x5c0272fffeadf493',
        lastReason: 'message'
      },
      directRadioFeatures: ['switch']
    }
  });

  assert.equal(merged.status, true);
  assert.equal(merged.brightness, 75);
});

test('direct radio post-command refresh keeps command state when Zigbee has no state payload', async () => {
  const service = createService();
  service.getDirectNodeForDevice = () => ({
    ieeeAddr: '0x5c0272fffeadf493',
    modelID: 'SP 224',
    manufacturerName: 'innr',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [0, 3, 4, 5, 6]
      }
    ]
  });

  const refreshed = await service.refreshDirectDeviceState({
    name: 'Vault Overhead Lights',
    type: 'switch',
    room: 'Vault',
    status: false,
    brightness: 75,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x5c0272fffeadf493'
      },
      directRadioFeatures: ['switch']
    }
  }, {
    preserveCommandState: {
      status: true,
      brightness: 75,
      colorTemperature: 4000
    }
  });

  assert.equal(refreshed.status, true);
  assert.equal(refreshed.brightness, 75);
  assert.equal(refreshed.colorTemperature, 4000);
});

test('direct radio migration finalization persists passed validation for native route', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const device = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Vault Overhead Lights',
    type: 'switch',
    room: 'Vault',
    status: true,
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      smartThingsDeviceId: 'smartthings-device-1',
      smartThingsCapabilities: ['switch', 'firmwareUpdate', 'refresh'],
      smartThingsCategories: ['switch'],
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x5c0272fffeadf493'
      },
      directRadioFeatures: ['switch'],
      smartThingsMigration: {
        migratedAt: '2026-05-28T02:50:00.000Z',
        previousSource: 'smartthings',
        smartThingsDeviceId: 'smartthings-device-1',
        migrationId: 'migration-old',
        validation: {
          status: 'needs_review'
        }
      }
    }
  };
  let persistedUpdate = null;
  Device.findById = async () => device;
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...device,
      ...update,
      properties: update.properties
    };
  };

  try {
    const result = await service.finalizeDeviceMigration({
      deviceId: DEVICE_ID,
      reason: 'Native switch command verified'
    });

    assert.equal(result.finalization.protocol, 'zigbee');
    assert.equal(result.finalization.validation.status, 'passed');
    assert.equal(result.finalization.validation.finalized, true);
    assert.ok(result.finalization.finalizedAt);
    assert.equal(persistedUpdate.properties.smartThingsMigration.validation.status, 'passed');
    assert.equal(persistedUpdate.properties.smartThingsMigration.validation.finalized, true);
    assert.ok(persistedUpdate.properties.smartThingsMigration.finalizedAt);
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test('direct radio migration finalization recovers detached SmartThings source and retires duplicate source', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFind = Device.find;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const directDevice = {
    _id: DEVICE_ID,
    name: 'Vault Door Sensor',
    type: 'sensor',
    room: 'Vault',
    status: false,
    isOnline: true,
    temperature: undefined,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f000b11f6e5',
        manufacturerName: 'Visonic',
        modelID: 'MCT-340 E'
      },
      directRadioFeatures: ['battery', 'contact', 'tamper', 'temperature'],
      directRadioState: {
        contactOpen: false,
        contact: 'closed',
        batteryLevel: 33
      },
      homeBrainBatteryLevel: 33,
      batteryLevel: 33
    }
  };
  const sourceDevice = {
    _id: SOURCE_DEVICE_ID,
    name: 'Vault Door',
    type: 'sensor',
    room: 'Vault',
    status: true,
    isOnline: true,
    temperature: 75.2,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'decc41de-30d6-4eac-96d9-82ff3b4e7f05',
      smartThingsDeviceName: 'Visonic Open/Closed Sensor',
      smartThingsLabel: 'Vault Door',
      smartThingsCapabilities: ['contactSensor', 'temperatureMeasurement', 'battery', 'firmwareUpdate', 'refresh'],
      smartThingsCategories: ['contactsensor'],
      smartThingsManufacturer: 'SmartThingsCommunity',
      smartThingsDeviceNetworkType: 'ZIGBEE',
      smartThingsBatteryLevel: 33,
      smartThingsAttributeValues: {
        temperatureMeasurement: {
          temperature: 75.2
        },
        battery: {
          battery: 33
        }
      },
      smartThingsAttributeMetadata: {
        temperatureMeasurement: {
          temperature: {
            unit: 'F'
          }
        }
      }
    }
  };
  const persistedUpdates = [];
  Device.findById = async (id) => (String(id) === DEVICE_ID ? directDevice : null);
  Device.find = async () => [sourceDevice];
  Device.findByIdAndUpdate = async (id, update) => {
    persistedUpdates.push({ id: String(id), update });
    const base = String(id) === SOURCE_DEVICE_ID ? sourceDevice : directDevice;
    return {
      ...base,
      ...update,
      _id: String(id),
      properties: update.properties
    };
  };

  try {
    const result = await service.finalizeDeviceMigration({
      deviceId: DEVICE_ID,
      reason: 'Native contact state verified'
    });

    const directUpdate = persistedUpdates.find((entry) => entry.id === DEVICE_ID)?.update;
    const sourceUpdate = persistedUpdates.find((entry) => entry.id === SOURCE_DEVICE_ID)?.update;
    assert.equal(result.finalization.validation.status, 'passed');
    assert.equal(directUpdate.temperature, 75.2);
    assert.equal(directUpdate.properties.directRadioState.temperatureF, 75.2);
    assert.equal(directUpdate.properties.smartThingsMigration.sourceDeviceId, SOURCE_DEVICE_ID);
    assert.equal(directUpdate.properties.smartThingsMigration.smartThingsDeviceId, 'decc41de-30d6-4eac-96d9-82ff3b4e7f05');
    assert.equal(sourceUpdate.properties.smartThingsMigration.retiredSource, true);
    assert.equal(sourceUpdate.properties.smartThingsMigration.status, 'finalized_source');
    assert.equal(sourceUpdate.properties.smartThingsMigration.directDeviceId, DEVICE_ID);
  } finally {
    Device.findById = originalFindById;
    Device.find = originalFind;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test('detached SmartThings migration matching scores matching native sensor above unrelated candidates', () => {
  const directDevice = {
    name: 'Vault Door Sensor',
    type: 'sensor',
    room: 'Vault',
    brand: 'Visonic',
    model: 'MCT-340 E',
    properties: {
      homebrainDirect: {
        protocol: 'zigbee',
        manufacturerName: 'Visonic',
        modelID: 'MCT-340 E'
      },
      directRadioFeatures: ['contact', 'battery', 'temperature']
    }
  };
  const sourceDevice = {
    name: 'Vault Door',
    type: 'sensor',
    room: 'Vault',
    properties: {
      source: 'smartthings',
      smartThingsLabel: 'Vault Door',
      smartThingsDeviceName: 'Visonic Open/Closed Sensor',
      smartThingsCapabilities: ['contactSensor', 'battery', 'temperatureMeasurement'],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };
  const unrelated = {
    name: 'Kitchen Motion',
    type: 'sensor',
    room: 'Kitchen',
    properties: {
      source: 'smartthings',
      smartThingsCapabilities: ['motionSensor', 'battery'],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };

  assert.ok(scoreDetachedSmartThingsMigrationSource(directDevice, sourceDevice, 'zigbee') >= 55);
  assert.ok(scoreDetachedSmartThingsMigrationSource(directDevice, unrelated, 'zigbee') < 55);
  assert.equal(scoreDetachedSmartThingsMigrationSource(directDevice, sourceDevice, 'zwave'), -Infinity);
});

test('SmartThings telemetry fallback carries available temperature without replacing native battery', () => {
  const snapshot = mergeSmartThingsTelemetryFallback({
    properties: {
      directRadioState: {
        contactOpen: false,
        batteryLevel: 41
      },
      homeBrainBatteryLevel: 41,
      batteryLevel: 41
    }
  }, {
    temperature: 75.2,
    properties: {
      smartThingsBatteryLevel: 33
    }
  });

  assert.equal(snapshot.temperature, 75.2);
  assert.equal(snapshot.properties.directRadioState.temperatureF, 75.2);
  assert.equal(snapshot.properties.directRadioState.batteryLevel, 41);
  assert.equal(snapshot.properties.homeBrainBatteryLevel, 41);
});

test('direct radio upsert prefers complete switch records over stale partial duplicates', () => {
  const selected = selectPrimaryDirectDeviceRecord([
    {
      _id: 'partial-a',
      name: 'Z-Wave Node 7',
      type: 'sensor',
      isOnline: true,
      updatedAt: '2026-05-28T00:59:00.000Z',
      properties: {
        directRadioFeatures: []
      }
    },
    {
      _id: 'complete-switch',
      name: '39348 / 39455 / ZW4008',
      type: 'switch',
      isOnline: true,
      updatedAt: '2026-05-28T00:58:00.000Z',
      properties: {
        directRadioFeatures: ['illuminance', 'switch']
      }
    }
  ]);

  assert.equal(selected._id, 'complete-switch');
});

test('Z-Wave migration exclusion does not advance until controller reports Done', async () => {
  const service = createService();
  const migration = {
    id: 'migration-exclusion',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zwave',
    status: 'excluding',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  let result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  service.recordZWaveExclusionStatus(2, { nodeId: 12 });
  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  service.recordZWaveExclusionStatus(6, { nodeId: 12 });
  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.equal(migration.exclusionNodeId, 12);
});

test('Z-Wave migration observes controller status reports that are awaited internally by zwave-js', async () => {
  const service = createService();
  const migration = {
    id: 'migration-observed-exclusion',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zwave',
    status: 'excluding',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.observeZWaveMigrationMessage({
    functionType: 75,
    status: 6,
    statusContext: { nodeId: 42 },
    constructor: { name: 'RemoveNodeFromNetworkRequestStatusReport' }
  });

  const result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(migration.exclusionNodeId, 42);
});

test('SmartThings-backed Z-Wave migration exclusion verifies after SmartThings removes the device', async () => {
  const service = createService();
  const migration = {
    id: 'migration-smartthings-exclusion',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-device-1',
    protocol: 'zwave',
    status: 'awaiting_smartthings_exclusion',
    exclusionStatus: 'waiting_smartthings',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.smartThingsService = {
    getDevice: async () => ({ deviceId: migration.smartThingsDeviceId })
  };
  let result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  service.smartThingsService = {
    getDevice: async () => {
      const error = new Error('SmartThings device not found');
      error.status = 404;
      throw error;
    }
  };
  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.ok(migration.exclusionVerifiedAt);
  assert.ok(migration.smartThingsRemovalVerifiedAt);
});

test('SmartThings-backed Z-Wave migration accepts offline SmartThings health as stale-tile exclusion evidence', async () => {
  const service = createService();
  const migration = {
    id: 'migration-smartthings-offline-exclusion',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-device-2',
    protocol: 'zwave',
    status: 'awaiting_smartthings_exclusion',
    exclusionStatus: 'waiting_smartthings',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.smartThingsService = {
    getDevice: async () => ({
      deviceId: migration.smartThingsDeviceId,
      type: 'ZWAVE',
      parentDeviceId: 'hub-1',
      zwave: {
        hubId: 'hub-1',
        provisioningState: 'PROVISIONED'
      }
    }),
    getDeviceHealth: async () => ({
      deviceId: migration.smartThingsDeviceId,
      state: 'OFFLINE',
      lastUpdatedDate: new Date().toISOString()
    }),
    getHubHealth: async () => ({
      hubId: 'hub-1',
      connectivity: 'CONNECTED'
    }),
    getDeviceStatus: async () => ({
      components: {
        main: {
          switch: {
            switch: {
              value: 'off',
              timestamp: '2026-05-23T18:18:44.775Z'
            }
          }
        }
      }
    })
  };

  const result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.equal(migration.smartThingsExclusionVerificationSource, 'device_health_offline');
  assert.ok(migration.smartThingsExclusionEvidence);
  assert.equal(migration.smartThingsExclusionEvidence.healthState, 'OFFLINE');
});

test('SmartThings-backed Z-Wave migration verifies when hub exclusion counter increases', async () => {
  const service = createService();
  const migration = {
    id: 'migration-smartthings-counter-exclusion',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-device-3',
    protocol: 'zwave',
    status: 'awaiting_smartthings_exclusion',
    exclusionStatus: 'waiting_smartthings',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    smartThingsHubHealthBeforeExclusion: {
      hubRadioState: {
        zwave: {
          excludedDevices: 0
        }
      }
    },
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.smartThingsService = {
    getDevice: async () => ({
      deviceId: migration.smartThingsDeviceId,
      type: 'ZWAVE',
      parentDeviceId: 'hub-1',
      zwave: {
        hubId: 'hub-1',
        provisioningState: 'PROVISIONED'
      }
    }),
    getDeviceHealth: async () => ({
      deviceId: migration.smartThingsDeviceId,
      state: 'ONLINE',
      lastUpdatedDate: new Date().toISOString()
    }),
    getHubHealth: async () => ({
      hubId: 'hub-1',
      connectivity: 'CONNECTED',
      hubRadioState: {
        zwave: {
          excludedDevices: 1
        }
      }
    }),
    getDeviceStatus: async () => ({ components: {} })
  };

  const result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.equal(migration.smartThingsExclusionVerificationSource, 'hub_exclusion_counter');
  assert.deepEqual(migration.smartThingsExclusionCounter, {
    path: 'zwave.excludedDevices',
    value: 1
  });
});

test('direct-radio migration inclusion does not advance until HomeBrain completes the native device record', async () => {
  const service = createService();
  const migration = {
    id: 'migration-inclusion',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zwave',
    status: 'pairing',
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  let result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_inclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  migration.status = 'completed';
  migration.completedAt = new Date().toISOString();
  migration.inclusionVerifiedAt = migration.completedAt;
  migration.directIdentity = { protocol: 'zwave', id: '12' };

  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_inclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
});

test('Z-Wave generic pairing waits for a submitted S2 DSK PIN instead of aborting', async () => {
  const service = createService();
  service.activePairings.set('zwave', {
    id: 'pairing-zwave-test',
    protocol: 'zwave',
    mode: 'inclusion',
    status: 'active',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    baselineIdentities: [],
    events: []
  });

  const callbacks = service.buildZWaveInclusionCallbacks({
    SecurityClass: {
      S2_AccessControl: 1,
      S2_Authenticated: 2,
      S2_Unauthenticated: 3,
      S0_Legacy: 4
    }
  });
  const pinPromise = callbacks.validateDSKAndEnterPIN('12345-11111-22222-33333-44444-55555-66666-77777');
  await new Promise((resolve) => setImmediate(resolve));

  const waitingPairing = service.serializePairingSession(service.activePairings.get('zwave'));
  assert.equal(waitingPairing.status, 'awaiting_dsk');
  assert.equal(waitingPairing.pendingDsk, '12345-11111-22222-33333-44444-55555-66666-77777');

  const submitResult = service.submitZWaveDskPin('12345');
  assert.equal(submitResult.accepted, true);
  assert.equal(await pinPromise, '12345');
  assert.equal(service.zwave.pendingDsk, null);
});

test('Z-Wave generic pairing defaults to standard inclusion without a DSK PIN prompt', async () => {
  const service = createService();
  const zwave = require('zwave-js');
  let inclusionOptions = null;
  service.start = async () => {};
  service.zwave.started = true;
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      beginInclusion: async (options) => {
        inclusionOptions = options;
        return true;
      }
    }
  };

  const result = await service.startPairing('zwave', { durationSeconds: 60 });
  assert.equal(inclusionOptions.strategy, zwave.InclusionStrategy.Insecure);
  assert.equal(result.pairing.zwaveSecurityMode, 'insecure');
  assert.match(result.pairing.message, /No DSK PIN is required/);
});

test('Z-Wave pairing can explicitly request secure S2 inclusion', async () => {
  const service = createService();
  const zwave = require('zwave-js');
  let inclusionOptions = null;
  service.start = async () => {};
  service.zwave.started = true;
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      beginInclusion: async (options) => {
        inclusionOptions = options;
        return true;
      }
    }
  };

  const result = await service.startPairing('zwave', {
    durationSeconds: 60,
    zwaveSecurityMode: 's2'
  });
  assert.equal(inclusionOptions.strategy, zwave.InclusionStrategy.Security_S2);
  assert.equal(result.pairing.zwaveSecurityMode, 's2');
});

test('generic pairing session completes immediately when an included direct device is upserted', () => {
  const service = createService();
  service.activePairings.set('zwave', {
    id: 'pairing-zwave-complete',
    protocol: 'zwave',
    mode: 'inclusion',
    status: 'active',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    baselineIdentities: ['3'],
    events: []
  });

  const session = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '3', source: 'homebrain-zwave' },
    { _id: { toString: () => 'device-node-3' }, name: 'Cold Storage Switch' },
    'node added'
  );

  assert.equal(session.status, 'completed');
  assert.equal(session.directDeviceId, 'device-node-3');
  assert.equal(session.directDeviceName, 'Cold Storage Switch');
  assert.equal(session.detectedIdentity.id, '3');
});

test('generic pairing baseline ignores already-known Z-Wave nodes', () => {
  const service = createService();
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }],
        [3, { id: 3, isControllerNode: false }]
      ])
    }
  };

  const session = service.createPairingSession('zwave', 60);
  session.status = 'active';
  assert.deepEqual(session.baselineIdentities, ['3']);

  const unchanged = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '3', source: 'homebrain-zwave' },
    { _id: { toString: () => 'device-node-3' }, name: 'Existing Z-Wave Node' },
    'node value updated'
  );
  assert.equal(unchanged.status, 'active');

  const completed = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '4', source: 'homebrain-zwave' },
    { _id: { toString: () => 'device-node-4' }, name: 'New Z-Wave Node' },
    'node value updated'
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.detectedIdentity.id, '4');
});

test('Z-Wave node refresh requests a fresh interview for an already-included node', async () => {
  const service = createService();
  service.started = true;
  let refreshOptions = null;
  let pingTryReallyHard = null;
  const node = {
    id: 4,
    isControllerNode: false,
    ready: false,
    status: 0,
    valueDB: { hasValue: () => false },
    ping: async (tryReallyHard) => {
      pingTryReallyHard = tryReallyHard;
      return false;
    },
    refreshInfo: async (options) => {
      refreshOptions = options;
    }
  };
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }],
        [4, node]
      ])
    }
  };

  const result = await service.refreshZWaveNodeInfo(4, {
    waitForWakeup: false,
    pingFirst: true
  });

  assert.equal(pingTryReallyHard, true);
  assert.deepEqual(refreshOptions, {
    resetSecurityClasses: false,
    waitForWakeup: false
  });
  assert.equal(result.node.id, 4);
  assert.equal(result.node.incomplete, true);
  assert.equal(result.ping, false);
});

test('Z-Wave failed-node removal refuses a responding node unless forced', async () => {
  const service = createService();
  service.started = true;
  let removeCalled = false;
  const node = {
    id: 4,
    isControllerNode: false,
    ready: false,
    status: 0,
    valueDB: { hasValue: () => false }
  };
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [4, node]
      ]),
      isFailedNode: async () => false,
      removeFailedNode: async () => {
        removeCalled = true;
      }
    }
  };

  await assert.rejects(
    () => service.removeFailedZWaveNode(4, { confirm: true }),
    /still responding/
  );
  assert.equal(removeCalled, false);
});
