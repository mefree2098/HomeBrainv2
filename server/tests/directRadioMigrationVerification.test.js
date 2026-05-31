const test = require('node:test');
const assert = require('node:assert/strict');

const directRadioService = require('../services/directRadioService');
const Device = require('../models/Device');
const smartThingsService = require('../services/smartThingsService');

const DirectRadioService = directRadioService.DirectRadioService;
const {
  inferFeaturesFromZigbeeDefinition,
  isDuplicateDirectRadioRecord,
  mergeSmartThingsTelemetryFallback,
  mergeDirectDeviceUpdateForExisting,
  selectPrimaryDirectDeviceRecord,
  scoreDetachedSmartThingsMigrationSource,
  buildRecoveredSmartThingsMigrationSnapshot
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

test('direct radio refresh preserves known Z-Wave catalog identity during incomplete re-interview updates', () => {
  const existing = {
    name: 'Kitchen Siren',
    type: 'siren',
    room: 'Upstairs',
    brand: 'AEON Labs',
    model: 'ZW080',
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 13,
        manufacturerId: 134,
        productType: 260,
        productId: 80,
        ready: true,
        status: 4,
        catalog: {
          manufacturer: 'AEON Labs',
          label: 'ZW080'
        },
        generatedName: 'ZW080',
        generatedRoom: 'Unassigned'
      },
      directRadioFeatures: ['alarm', 'button', 'switch'],
      directRadioCatalog: {
        manufacturer: 'AEON Labs',
        label: 'ZW080'
      }
    }
  };
  const update = {
    name: 'Z-Wave Node 13',
    type: 'sensor',
    room: 'Unassigned',
    isOnline: false,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 13,
        manufacturerId: null,
        productType: null,
        productId: null,
        ready: false,
        status: 0,
        catalog: null,
        lastReason: 'refresh-info requested'
      },
      directRadioFeatures: [],
      directRadioCatalog: null
    }
  };

  const merged = mergeDirectDeviceUpdateForExisting(existing, update);

  assert.equal(merged.name, 'Kitchen Siren');
  assert.equal(merged.type, 'siren');
  assert.equal(merged.properties.homebrainDirect.manufacturerId, 134);
  assert.equal(merged.properties.homebrainDirect.productType, 260);
  assert.equal(merged.properties.homebrainDirect.productId, 80);
  assert.equal(merged.properties.homebrainDirect.catalog.label, 'ZW080');
  assert.equal(merged.properties.directRadioCatalog.label, 'ZW080');
  assert.deepEqual(merged.properties.directRadioFeatures, ['alarm', 'button', 'switch']);
});

test('direct radio refresh clears stale Zigbee state when the interview shell is incomplete', () => {
  const existing = {
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    isOnline: true,
    temperature: 64.6,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f00057c3ef1',
        modelID: null,
        manufacturerName: null,
        interviewCompleted: true
      },
      directRadioFeatures: ['acceleration', 'axis', 'battery', 'contact', 'temperature', 'vibration'],
      directRadioState: {
        contactOpen: false,
        contact: 'closed',
        batteryLevel: 17,
        temperatureF: 64.6,
        acceleration: 'inactive',
        vibration: 'inactive',
        axis: [17, 9, 1011]
      },
      directRadioCatalog: {
        label: '3321-S'
      },
      homeBrainBatteryLevel: 17,
      batteryLevel: 17,
      supportsContactSensor: true,
      supportsVibrationSensor: true
    }
  };
  const update = {
    name: 'Zigbee 7c3ef1',
    type: 'sensor',
    room: 'Unassigned',
    isOnline: false,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f00057c3ef1',
        modelID: null,
        manufacturerName: null,
        interviewCompleted: false,
        incomplete: true,
        incompleteReason: 'missing_zigbee_interview_identity_and_state'
      },
      directRadioFeatures: [],
      directRadioCapabilities: [],
      supportsContactSensor: false,
      supportsVibrationSensor: false
    }
  };

  const merged = mergeDirectDeviceUpdateForExisting(existing, update);

  assert.equal(merged.isOnline, false);
  assert.equal(merged.properties.homebrainDirect.incomplete, true);
  assert.deepEqual(merged.properties.directRadioFeatures, []);
  assert.deepEqual(merged.properties.directRadioCapabilities, []);
  assert.equal(merged.properties.directRadioState, undefined);
  assert.equal(merged.properties.directRadioCatalog, undefined);
  assert.equal(merged.properties.homeBrainBatteryLevel, undefined);
  assert.equal(merged.properties.batteryLevel, undefined);
  assert.equal(merged.properties.supportsContactSensor, false);
  assert.equal(merged.properties.supportsVibrationSensor, false);
});

test('direct radio refresh does not rename cataloged devices to generic Z-Wave node names after failed interviews', () => {
  const existing = {
    name: 'ZW080',
    type: 'siren',
    room: 'Unassigned',
    model: 'ZW080',
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 13,
        generatedName: 'ZW080',
        catalog: {
          label: 'ZW080'
        }
      },
      directRadioFeatures: ['alarm', 'button', 'switch'],
      directRadioCatalog: {
        label: 'ZW080'
      }
    }
  };
  const update = {
    name: 'Z-Wave Node 13',
    type: 'sensor',
    room: 'Unassigned',
    isOnline: false,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 13,
        ready: false,
        status: 3,
        lastReason: 'interview failed'
      },
      directRadioFeatures: []
    }
  };

  const merged = mergeDirectDeviceUpdateForExisting(existing, update);

  assert.equal(merged.name, 'ZW080');
  assert.equal(merged.type, 'siren');
  assert.deepEqual(merged.properties.directRadioFeatures, ['alarm', 'button', 'switch']);
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

test('Zigbee feature inference recognizes SmartThings multipurpose moving and axis exposes', () => {
  const features = inferFeaturesFromZigbeeDefinition({
    exposes: [
      { name: 'temperature' },
      { name: 'contact' },
      { name: 'battery' },
      { name: 'moving' },
      { name: 'x_axis' },
      { name: 'y_axis' },
      { name: 'z_axis' }
    ]
  }, {
    modelID: '3321-S',
    manufacturerName: 'SmartThings',
    endpoints: [
      {
        ID: 1,
        inputClusters: [1, 1026, 1280, 64514]
      }
    ]
  });

  assert.ok(features.includes('contact'));
  assert.ok(features.includes('temperature'));
  assert.ok(features.includes('battery'));
  assert.ok(features.includes('vibration'));
  assert.ok(features.includes('acceleration'));
  assert.ok(features.includes('axis'));
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

test('Zigbee normalization marks empty interview shells incomplete and offline', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x000d6f00057c3ef1',
    networkAddress: 57452,
    modelID: null,
    manufacturerName: null,
    interviewCompleted: true,
    endpoints: []
  }, 'sync');

  assert.equal(normalized.update.isOnline, false);
  assert.equal(normalized.update.properties.homebrainDirect.interviewCompleted, false);
  assert.equal(normalized.update.properties.homebrainDirect.incomplete, true);
  assert.equal(
    normalized.update.properties.homebrainDirect.incompleteReason,
    'missing_zigbee_interview_identity_and_state'
  );
  assert.deepEqual(normalized.update.properties.directRadioFeatures, []);
  assert.equal(normalized.update.properties.directRadioState, undefined);
});

test('Zigbee normalization captures SmartThings multipurpose moving and axis state', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x000d6ffffe000001',
    modelID: '3321-S',
    manufacturerName: 'SmartThings',
    interviewCompleted: true,
    state: {
      contact: true,
      moving: true,
      x_axis: 21,
      y_axis: 11,
      z_axis: 1008
    },
    endpoints: [
      {
        ID: 1,
        inputClusters: [1, 1026, 1280, 64514],
        getClusterAttributeValue() {
          return undefined;
        }
      }
    ]
  }, 'deviceInterview');

  const state = normalized.update.properties.directRadioState;
  assert.equal(normalized.update.model, '3321-S');
  assert.ok(normalized.update.properties.directRadioFeatures.includes('contact'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('temperature'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('battery'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('tamper'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('vibration'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('acceleration'));
  assert.ok(normalized.update.properties.directRadioFeatures.includes('axis'));
  assert.equal(state.contactOpen, false);
  assert.equal(state.accelerationActive, true);
  assert.equal(state.acceleration, 'active');
  assert.equal(state.vibrationActive, true);
  assert.equal(state.vibration, 'active');
  assert.deepEqual(state.axis, [21, 11, 1008]);
});

test('Zigbee normalization captures SmartThings multipurpose acceleration reports', () => {
  const service = createService();
  const normalized = service.normalizeZigbeeDevice({
    ieeeAddr: '0x000d6ffffe000002',
    modelID: '3321-S',
    manufacturerName: 'SmartThings',
    interviewCompleted: true,
    endpoints: [
      {
        ID: 1,
        inputClusters: [1, 1026, 1280, 64514],
        getClusterAttributeValue() {
          return undefined;
        }
      }
    ]
  }, 'message', {
    message: {
      cluster: 'manuSpecificSamsungAccelerometer',
      data: {
        acceleration: 1,
        xAxis: -1007,
        yAxis: 12,
        zAxis: 18
      }
    }
  });

  const state = normalized.update.properties.directRadioState;
  assert.equal(state.accelerationActive, true);
  assert.equal(state.acceleration, 'active');
  assert.equal(state.vibrationActive, true);
  assert.equal(state.vibration, 'active');
  assert.equal(state.xAxis, 18);
  assert.equal(state.yAxis, 12);
  assert.equal(state.zAxis, 1007);
  assert.deepEqual(state.axis, [18, 12, 1007]);
  assert.ok(normalized.update.properties.directRadioFeatures.includes('axis'));
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

test('Zigbee message handling reads live IAS zone status during sleepy contact check-in', async () => {
  const service = createService();
  let capturedUpdate = null;
  service.upsertDirectDevice = async (_identity, update) => {
    capturedUpdate = update;
    return { _id: DEVICE_ID, ...update };
  };

  const endpoint = {
    ID: 1,
    inputClusters: [1, 1280],
    getClusterAttributeValue() {
      return undefined;
    },
    async read(cluster, attributes) {
      assert.equal(cluster, 'ssIasZone');
      assert.deepEqual(attributes, ['zoneStatus']);
      return { zoneStatus: 0x0001 };
    }
  };

  await service.handleZigbeeDeviceChanged({
    ieeeAddr: '0x000d6f000b11f6e5',
    modelID: 'MCT-340 E',
    manufacturerName: 'Visonic',
    interviewCompleted: true,
    endpoints: [endpoint]
  }, 'message', {
    message: {
      cluster: 'genPollCtrl',
      data: {}
    }
  });

  assert.ok(capturedUpdate);
  assert.equal(capturedUpdate.status, true);
  assert.equal(capturedUpdate.properties.directRadioState.contactOpen, true);
  assert.equal(capturedUpdate.properties.directRadioState.contact, 'open');
  assert.ok(capturedUpdate.properties.directRadioFeatures.includes('contact'));
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

test('active Zigbee migration ignores existing baseline device chatter', async () => {
  const service = createService();
  const migration = {
    id: 'migration-front-door',
    sourceDeviceId: SOURCE_DEVICE_ID,
    protocol: 'zigbee',
    status: 'pairing',
    expiresAt: Date.now() + 60_000
  };
  service.activeMigrations.set(migration.id, migration);
  service.activePairings.set('zigbee', {
    id: 'pairing-front-door',
    protocol: 'zigbee',
    status: 'active',
    baselineIdentities: ['0x000d6f000b11f6e5'],
    events: []
  });

  let completeCalled = false;
  let upsertOptions = null;
  service.completeMigration = async () => {
    completeCalled = true;
    throw new Error('Existing baseline device should not complete migration');
  };
  service.withDirectDeviceUpsertLock = async (_identity, fn) => fn();
  service.upsertDirectDeviceRecord = async (_identity, _update, options) => {
    upsertOptions = options;
    return { _id: DEVICE_ID };
  };

  const result = await service.upsertDirectDevice({
    protocol: 'zigbee',
    id: '0x000d6f000b11f6e5'
  }, {
    properties: {
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f000b11f6e5',
        lastReason: 'message'
      }
    }
  });

  assert.equal(completeCalled, false);
  assert.equal(result._id, DEVICE_ID);
  assert.equal(upsertOptions.skipActiveMigration, true);
  assert.equal(upsertOptions.suppressPairingCompletion, true);
});

test('Zigbee migration aborts pairing when SmartThings delete is not authorized', async () => {
  const service = createService();
  const originalFindById = Device.findById;
  const sourceDevice = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    isOnline: true,
    brand: 'SmartThings',
    model: 'Multipurpose Sensor',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-front-door',
      smartThingsCapabilities: [
        'contactSensor',
        'temperatureMeasurement',
        'threeAxis',
        'accelerationSensor',
        'battery',
        'refresh'
      ],
      smartThingsCategories: ['MultiFunctionalSensor'],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };
  const removedDeviceIds = [];
  let startPairingCalled = false;

  Device.findById = () => ({
    lean: async () => sourceDevice
  });
  service.smartThingsService = {
    getDevice: async () => ({
      deviceId: 'smartthings-front-door',
      type: 'ZIGBEE',
      parentDeviceId: 'hub-1'
    }),
    deleteDevice: async (deviceId) => {
      removedDeviceIds.push(deviceId);
      const error = new Error('SmartThings API DELETE /devices/smartthings-front-door failed 403: Forbidden');
      error.status = 403;
      throw error;
    }
  };
  service.startPairing = async () => {
    startPairingCalled = true;
  };

  try {
    await assert.rejects(
      () => service.startMigration({
        deviceId: DEVICE_ID,
        protocol: 'zigbee',
        durationSeconds: 60
      }),
      (error) => {
        assert.equal(error.code, 'SMARTTHINGS_DEVICE_REMOVAL_FAILED');
        assert.equal(error.status, 403);
        assert.match(error.message, /w:devices:\*/);
        return true;
      }
    );

    assert.deepEqual(removedDeviceIds, ['smartthings-front-door']);
    assert.equal(startPairingCalled, false);
    const migration = Array.from(service.activeMigrations.values()).find((entry) => entry.sourceDeviceId === DEVICE_ID);
    assert.ok(migration);
    assert.equal(migration.status, 'pairing_failed');
    assert.equal(migration.inclusionStatus, 'failed');
    assert.equal(migration.smartThingsRemovalRequest.status, 'failed');
    assert.equal(migration.smartThingsRemovalRequest.reason, 'not_authorized');
    assert.equal(migration.smartThingsRemovalRequest.statusCode, 403);
  } finally {
    Device.findById = originalFindById;
  }
});

test('Zigbee migration marks the SmartThings source as awaiting native pairing after removal starts', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const sourceDevice = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    isOnline: true,
    brand: 'SmartThings',
    model: 'Multipurpose Sensor',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-front-door',
      smartThingsCapabilities: [
        'contactSensor',
        'temperatureMeasurement',
        'threeAxis',
        'accelerationSensor',
        'battery',
        'refresh'
      ],
      smartThingsCategories: ['MultiFunctionalSensor'],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };
  const persistedUpdates = [];
  const removedDeviceIds = [];

  Device.findById = () => ({
    lean: async () => sourceDevice
  });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdates.push(update);
    return {
      ...sourceDevice,
      ...update,
      properties: update.properties
    };
  };
  service.smartThingsService = {
    getDevice: async () => ({
      deviceId: 'smartthings-front-door',
      type: 'ZIGBEE',
      parentDeviceId: 'hub-1'
    }),
    deleteDevice: async (deviceId) => {
      removedDeviceIds.push(deviceId);
      return {};
    }
  };
  service.startPairing = async () => ({
    pairing: {
      id: 'pairing-front-door'
    }
  });

  try {
    const result = await service.startMigration({
      deviceId: DEVICE_ID,
      protocol: 'zigbee',
      durationSeconds: 60
    });

    assert.deepEqual(removedDeviceIds, ['smartthings-front-door']);
    assert.equal(result.migration.pairingId, 'pairing-front-door');
    assert.equal(result.migration.smartThingsRemovalRequest.status, 'requested');
    assert.equal(persistedUpdates.length, 2);
    const finalUpdate = persistedUpdates[persistedUpdates.length - 1];
    assert.equal(finalUpdate.isOnline, false);
    assert.equal(finalUpdate.properties.smartThingsMigration.status, 'awaiting_native_pairing');
    assert.equal(finalUpdate.properties.smartThingsMigration.nativePairingStatus, 'active');
    assert.equal(finalUpdate.properties.smartThingsMigration.smartThingsRemovalStatus, 'requested');
    assert.equal(finalUpdate.properties.smartThingsMigration.smartThingsDeviceId, 'smartthings-front-door');
    assert.equal(finalUpdate.properties.smartThingsMigration.pairingId, 'pairing-front-door');
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test('Zigbee migration retry reuses prior SmartThings removal instead of deleting again', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const sourceDevice = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    isOnline: false,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-front-door',
      smartThingsCapabilities: ['contactSensor', 'temperatureMeasurement', 'battery'],
      smartThingsDeviceNetworkType: 'ZIGBEE',
      smartThingsMigration: {
        status: 'awaiting_native_pairing',
        nativePairingStatus: 'expired',
        smartThingsDeviceId: 'smartthings-front-door',
        smartThingsRemovalStatus: 'requested',
        smartThingsRemovalRequest: {
          status: 'requested',
          requestedAt: '2026-05-31T14:20:50.426Z'
        }
      }
    }
  };
  let deleteCalled = false;
  let startPairingCalled = false;

  Device.findById = () => ({
    lean: async () => sourceDevice
  });
  Device.findByIdAndUpdate = async (_id, update) => ({
    ...sourceDevice,
    ...update,
    properties: update.properties
  });
  service.smartThingsService = {
    getDevice: async () => {
      throw new Error('SmartThings should not be queried after removal was already recorded');
    },
    deleteDevice: async () => {
      deleteCalled = true;
      throw new Error('SmartThings delete should not run again');
    }
  };
  service.startPairing = async () => {
    startPairingCalled = true;
    return {
      pairing: {
        id: 'pairing-retry'
      }
    };
  };

  try {
    const result = await service.startMigration({
      deviceId: DEVICE_ID,
      protocol: 'zigbee',
      durationSeconds: 60
    });

    assert.equal(deleteCalled, false);
    assert.equal(startPairingCalled, true);
    assert.equal(result.migration.smartThingsRemovalRequest.status, 'requested');
    assert.equal(result.migration.pairingId, 'pairing-retry');
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test('Zigbee migration recovers limbo source when SmartThings detail 403s but live list is missing the device', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const sourceDevice = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    isOnline: true,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-front-door',
      smartThingsCapabilities: ['contactSensor', 'temperatureMeasurement', 'battery'],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };
  let deleteCalled = false;
  let persistedUpdate = null;

  Device.findById = () => ({
    lean: async () => sourceDevice
  });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...sourceDevice,
      ...update,
      properties: update.properties
    };
  };
  service.smartThingsService = {
    getDevice: async () => {
      const error = new Error('SmartThings API GET /devices/smartthings-front-door failed 403: Forbidden');
      error.status = 403;
      throw error;
    },
    getDevices: async () => [
      { deviceId: 'other-smartthings-device', label: 'Other Sensor' }
    ],
    deleteDevice: async () => {
      deleteCalled = true;
      throw new Error('Delete should not be called after live list proves the device is gone');
    }
  };
  service.startPairing = async () => ({
    pairing: {
      id: 'pairing-limbo'
    }
  });

  try {
    const result = await service.startMigration({
      deviceId: DEVICE_ID,
      protocol: 'zigbee',
      durationSeconds: 60
    });

    assert.equal(deleteCalled, false);
    assert.equal(result.migration.smartThingsRemovalRequest.status, 'already_missing');
    assert.equal(result.migration.smartThingsRemovalRequest.verifiedBy, 'device_list_absent');
    assert.equal(result.migration.pairingId, 'pairing-limbo');
    assert.equal(persistedUpdate.isOnline, false);
    assert.equal(persistedUpdate.properties.smartThingsMigration.status, 'awaiting_native_pairing');
    assert.equal(persistedUpdate.properties.smartThingsMigration.nativePairingStatus, 'active');
    assert.equal(persistedUpdate.properties.smartThingsMigration.smartThingsRemovalStatus, 'already_missing');
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test('expired Zigbee migration keeps removed SmartThings source offline and retryable', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const sourceDevice = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    isOnline: true,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-front-door',
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };
  const migration = {
    id: 'migration-timeout',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-front-door',
    protocol: 'zigbee',
    status: 'pairing',
    pairingId: 'pairing-timeout',
    expiresAt: Date.now() - 1000,
    smartThingsRemovalRequest: {
      status: 'requested',
      requestedAt: '2026-05-31T14:20:50.426Z'
    }
  };
  let persistedUpdate = null;

  service.activeMigrations.set(migration.id, migration);
  Device.findById = () => ({
    lean: async () => sourceDevice
  });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...sourceDevice,
      ...update,
      properties: update.properties
    };
  };

  try {
    const expired = await service.markActiveMigrationPairingExpired('zigbee', {
      id: 'pairing-timeout'
    });

    assert.equal(expired.status, 'pairing_failed');
    assert.equal(expired.inclusionStatus, 'failed');
    assert.ok(expired.inclusionFailedAt);
    assert.equal(persistedUpdate.isOnline, false);
    assert.equal(persistedUpdate.properties.smartThingsMigration.status, 'awaiting_native_pairing');
    assert.equal(persistedUpdate.properties.smartThingsMigration.nativePairingStatus, 'expired');
    assert.equal(persistedUpdate.properties.smartThingsMigration.pairingId, 'pairing-timeout');
    assert.equal(persistedUpdate.properties.smartThingsMigration.smartThingsRemovedFromSmartThings, true);
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test('active Zigbee migration waits for a new device interview before completing', async () => {
  const service = createService();
  const migration = {
    id: 'migration-front-door',
    sourceDeviceId: SOURCE_DEVICE_ID,
    protocol: 'zigbee',
    status: 'pairing',
    expiresAt: Date.now() + 60_000
  };
  service.activeMigrations.set(migration.id, migration);
  service.activePairings.set('zigbee', {
    id: 'pairing-front-door',
    protocol: 'zigbee',
    status: 'active',
    baselineIdentities: ['0x000d6f000b11f6e5'],
    events: []
  });

  let completeCalled = false;
  let upsertCalled = false;
  service.completeMigration = async () => {
    completeCalled = true;
    return null;
  };
  service.upsertDirectDeviceRecord = async () => {
    upsertCalled = true;
    return null;
  };

  const joinedResult = await service.upsertDirectDevice({
    protocol: 'zigbee',
    id: '0x000d6ffffe000003'
  }, {
    properties: {
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6ffffe000003',
        lastReason: 'deviceJoined'
      }
    }
  });

  assert.equal(joinedResult, null);
  assert.equal(completeCalled, false);
  assert.equal(upsertCalled, false);
  assert.equal(service.activePairings.get('zigbee').detectedIdentity.id, '0x000d6ffffe000003');

  service.completeMigration = async (migrationId, identity) => ({
    migrationId,
    identity
  });

  const interviewResult = await service.upsertDirectDevice({
    protocol: 'zigbee',
    id: '0x000d6ffffe000003'
  }, {
    properties: {
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6ffffe000003',
        lastReason: 'deviceInterview'
      }
    }
  });

  assert.equal(interviewResult.migrationId, 'migration-front-door');
  assert.equal(interviewResult.identity.id, '0x000d6ffffe000003');
  assert.equal(upsertCalled, false);
});

test('direct radio migration finalization persists passed validation for native route', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeleteDevice = smartThingsService.deleteDevice;
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
  const deletedSmartThingsDeviceIds = [];
  Device.findById = async () => device;
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...device,
      ...update,
      properties: update.properties
    };
  };
  smartThingsService.deleteDevice = async (deviceId) => {
    deletedSmartThingsDeviceIds.push(deviceId);
    return {};
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
    assert.equal(persistedUpdate.properties.smartThingsMigration.smartThingsDeleteStatus, 'deleted');
    assert.ok(persistedUpdate.properties.smartThingsMigration.smartThingsDeletedAt);
    assert.deepEqual(deletedSmartThingsDeviceIds, ['smartthings-device-1']);
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    smartThingsService.deleteDevice = originalDeleteDevice;
  }
});

test('direct radio migration finalization rejects incomplete Zigbee contact records', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeleteDevice = smartThingsService.deleteDevice;
  const device = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      smartThingsCapabilities: ['contactSensor', 'temperatureMeasurement', 'threeAxis', 'accelerationSensor', 'battery'],
      smartThingsDeviceId: 'smartthings-front-door',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f00057c3ef1',
        modelID: null,
        manufacturerName: null,
        iasZone: null
      },
      directRadioFeatures: ['acceleration', 'axis', 'battery', 'contact', 'temperature', 'vibration'],
      directRadioState: {
        contactOpen: false,
        contact: 'closed',
        batteryLevel: 17
      },
      smartThingsMigration: {
        migratedAt: '2026-05-31T02:50:00.000Z',
        previousSource: 'smartthings',
        smartThingsDeviceId: 'smartthings-front-door',
        migrationId: 'migration-front-door',
        validation: {
          status: 'needs_review'
        }
      }
    }
  };
  const persistedUpdates = [];
  const deletedSmartThingsDeviceIds = [];
  Device.findById = async () => device;
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdates.push(update);
    return {
      ...device,
      ...update,
      properties: update.properties
    };
  };
  smartThingsService.deleteDevice = async (deviceId) => {
    deletedSmartThingsDeviceIds.push(deviceId);
    return {};
  };

  try {
    let rejection = null;
    try {
      await service.finalizeDeviceMigration({
        deviceId: DEVICE_ID,
        reason: 'Native contact state verified'
      });
    } catch (error) {
      rejection = error;
    }

    assert.ok(rejection);
    assert.equal(rejection.status, 409);
    assert.equal(rejection.validation.status, 'needs_review');
    const checks = new Map(rejection.validation.checks.map((check) => [check.key, check]));
    assert.equal(checks.get('features').matched, true);
    assert.equal(checks.get('zigbee_identity').matched, false);
    assert.equal(checks.get('zigbee_ias_zone').matched, false);
    assert.equal(checks.get('zigbee_contact_state').matched, true);
    assert.deepEqual(persistedUpdates, []);
    assert.deepEqual(deletedSmartThingsDeviceIds, []);
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    smartThingsService.deleteDevice = originalDeleteDevice;
  }
});

test('direct radio migration finalization repairs retained SmartThings sensor telemetry before validation', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeleteDevice = smartThingsService.deleteDevice;
  let device = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    temperature: 64.6,
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      smartThingsCapabilities: ['contactSensor', 'temperatureMeasurement', 'threeAxis', 'accelerationSensor', 'battery'],
      smartThingsAttributeValues: {
        contactSensor: {
          contact: 'closed'
        },
        accelerationSensor: {
          acceleration: 'inactive'
        },
        threeAxis: {
          threeAxis: [17, 9, 1011]
        },
        battery: {
          battery: 17
        },
        temperatureMeasurement: {
          temperature: 64.6
        }
      },
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f00057c3ef1',
        manufacturerName: 'SmartThings',
        modelID: 'multi',
        iasZone: {
          enrolled: true,
          zoneState: 1,
          cieAddr: '0x00124b003a12562a',
          coordinatorIeee: '0x00124b003a12562a',
          cieMatchesCoordinator: true
        }
      },
      directRadioFeatures: ['battery', 'contact', 'temperature'],
      smartThingsMigration: {
        migratedAt: '2026-05-31T02:50:00.000Z',
        previousSource: 'smartthings',
        smartThingsDeviceId: 'smartthings-front-door',
        migrationId: 'migration-front-door',
        validation: {
          status: 'needs_review'
        }
      }
    }
  };
  const persistedUpdates = [];
  const deletedSmartThingsDeviceIds = [];
  Device.findById = async () => device;
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdates.push(update);
    device = {
      ...device,
      ...update,
      properties: update.properties
    };
    return device;
  };
  smartThingsService.deleteDevice = async (deviceId) => {
    deletedSmartThingsDeviceIds.push(deviceId);
    return {};
  };

  try {
    const result = await service.finalizeDeviceMigration({
      deviceId: DEVICE_ID,
      reason: 'Native contact state verified'
    });

    const finalizeUpdate = persistedUpdates[0];
    assert.equal(result.finalization.validation.status, 'passed');
    assert.equal(finalizeUpdate.properties.directRadioState.contactOpen, false);
    assert.equal(finalizeUpdate.properties.directRadioState.contact, 'closed');
    assert.equal(finalizeUpdate.properties.directRadioState.vibrationActive, false);
    assert.equal(finalizeUpdate.properties.directRadioState.vibration, 'inactive');
    assert.equal(finalizeUpdate.properties.directRadioState.accelerationActive, false);
    assert.deepEqual(finalizeUpdate.properties.directRadioState.axis, [17, 9, 1011]);
    assert.ok(finalizeUpdate.properties.directRadioFeatures.includes('vibration'));
    assert.ok(finalizeUpdate.properties.directRadioFeatures.includes('acceleration'));
    assert.ok(finalizeUpdate.properties.directRadioFeatures.includes('axis'));
    assert.equal(finalizeUpdate.properties.supportsVibrationSensor, true);
    assert.deepEqual(deletedSmartThingsDeviceIds, ['smartthings-front-door']);
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    smartThingsService.deleteDevice = originalDeleteDevice;
  }
});

test('active direct radio migration deletes the old SmartThings device after native pairing completes', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeleteDevice = smartThingsService.deleteDevice;
  const migration = {
    id: 'migration-active-delete',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zigbee',
    status: 'pairing',
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  const sourceDevice = {
    _id: {
      toString: () => DEVICE_ID
    },
    name: 'Vault Overhead Lights',
    type: 'switch',
    room: 'Vault',
    status: true,
    isOnline: true,
    brand: 'SmartThingsCommunity',
    model: 'SmartThings Switch',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-active-delete',
      smartThingsCapabilities: ['switch', 'refresh'],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };
  const persistedUpdates = [];
  const deletedSmartThingsDeviceIds = [];
  service.activeMigrations.set(migration.id, migration);
  Device.findById = async () => sourceDevice;
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdates.push(update);
    return {
      ...sourceDevice,
      ...update,
      _id: DEVICE_ID,
      properties: update.properties
    };
  };
  smartThingsService.deleteDevice = async (deviceId) => {
    deletedSmartThingsDeviceIds.push(deviceId);
    return {};
  };

  try {
    const updated = await service.completeMigration(migration.id, {
      protocol: 'zigbee',
      id: '0x5c0272fffeadf493'
    }, {
      status: true,
      brightness: 100,
      isOnline: true,
      brand: 'Innr',
      model: 'SP 224',
      properties: {
        source: 'homebrain-zigbee',
        homebrainDirect: {
          protocol: 'zigbee',
          ieeeAddr: '0x5c0272fffeadf493'
        },
        directRadioFeatures: ['switch']
      }
    });

    assert.equal(updated.properties.source, 'homebrain-zigbee');
    assert.equal(updated.properties.smartThingsDeviceId, undefined);
    assert.equal(updated.properties.smartThingsMigration.smartThingsDeleteStatus, 'deleted');
    assert.deepEqual(deletedSmartThingsDeviceIds, ['smartthings-active-delete']);
    assert.equal(migration.status, 'completed');
    assert.equal(persistedUpdates.at(-1).properties.smartThingsMigration.smartThingsDeletedAt !== undefined, true);
  } finally {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    smartThingsService.deleteDevice = originalDeleteDevice;
  }
});

test('direct radio migration finalization recovers detached SmartThings source and retires duplicate source', async () => {
  const service = createService();
  service.emitDeviceUpdate = () => {};

  const originalFindById = Device.findById;
  const originalFind = Device.find;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeleteDevice = smartThingsService.deleteDevice;
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
        modelID: 'MCT-340 E',
        iasZone: {
          enrolled: true,
          zoneState: 1,
          cieAddr: '0x00124b003a12562a',
          coordinatorIeee: '0x00124b003a12562a',
          cieMatchesCoordinator: true
        }
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
  const deletedSmartThingsDeviceIds = [];
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
  smartThingsService.deleteDevice = async (deviceId) => {
    deletedSmartThingsDeviceIds.push(deviceId);
    return {};
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
    const deleteUpdate = persistedUpdates.filter((entry) => entry.id === DEVICE_ID).at(-1)?.update;
    assert.equal(deleteUpdate.properties.smartThingsMigration.smartThingsDeleteStatus, 'deleted');
    assert.deepEqual(deletedSmartThingsDeviceIds, ['decc41de-30d6-4eac-96d9-82ff3b4e7f05']);
  } finally {
    Device.findById = originalFindById;
    Device.find = originalFind;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    smartThingsService.deleteDevice = originalDeleteDevice;
  }
});

test('recovered SmartThings migration context is repaired when strict matching rejects the old source', async () => {
  const service = createService();
  const originalFindById = Device.findById;
  const originalFind = Device.find;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const directDevice = {
    _id: DEVICE_ID,
    name: 'Garage Door Sensor',
    type: 'sensor',
    room: 'Outside',
    brand: 'Ecolink',
    model: 'TILTZWAVE1',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 9,
        manufacturerName: 'Ecolink',
        modelID: 'TILTZWAVE1'
      },
      directRadioFeatures: ['battery', 'contact', 'garage'],
      smartThingsMigration: {
        recoveredAt: '2026-05-29T02:01:50.539Z',
        migratedAt: '2026-05-29T02:01:50.539Z',
        previousSource: 'smartthings',
        smartThingsDeviceId: 'wrong-smartthings-id',
        sourceDeviceId: SOURCE_DEVICE_ID,
        sourceDeviceName: 'Greenhouse',
        directDeviceId: DEVICE_ID,
        migrationId: `recovered-${SOURCE_DEVICE_ID}-${DEVICE_ID}`
      }
    }
  };
  const wrongSource = {
    _id: SOURCE_DEVICE_ID,
    name: 'Greenhouse',
    type: 'sensor',
    room: 'Outside',
    properties: {
      source: 'smartthings',
      smartThingsLabel: 'Greenhouse',
      smartThingsDeviceName: 'Z-Wave Contact Sensor',
      smartThingsDeviceId: 'wrong-smartthings-id',
      smartThingsCapabilities: ['contactSensor', 'battery'],
      smartThingsDeviceNetworkType: 'ZWAVE'
    }
  };
  const correctSource = {
    _id: '507f1f77bcf86cd799439099',
    name: 'Garage Tilt Sensor',
    type: 'sensor',
    room: 'Outside',
    properties: {
      source: 'smartthings',
      smartThingsLabel: 'Garage Tilt Sensor',
      smartThingsDeviceName: 'Z-Wave Contact Sensor',
      smartThingsDeviceId: 'garage-smartthings-id',
      smartThingsCapabilities: ['contactSensor', 'battery'],
      smartThingsDeviceNetworkType: 'ZWAVE'
    }
  };
  let persistedUpdate = null;

  Device.findById = async (id) => (String(id) === SOURCE_DEVICE_ID ? wrongSource : null);
  Device.find = async () => [wrongSource, correctSource];
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...directDevice,
      ...update,
      properties: update.properties
    };
  };

  try {
    const repaired = await service.repairRecoveredSmartThingsMigrationIfMismatched(directDevice, {
      protocol: 'zwave',
      id: '9'
    });

    assert.ok(persistedUpdate);
    assert.equal(repaired.properties.smartThingsMigration.sourceDeviceId, correctSource._id);
    assert.equal(repaired.properties.smartThingsMigration.sourceDeviceName, 'Garage Tilt Sensor');
    assert.equal(repaired.properties.smartThingsMigration.smartThingsDeviceId, 'garage-smartthings-id');
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

test('detached SmartThings migration matching rejects multipurpose sensors when native features are missing', () => {
  const directDevice = {
    name: 'Back Door',
    type: 'sensor',
    room: 'Upstairs',
    brand: 'Visonic',
    model: 'MCT-340 E',
    properties: {
      homebrainDirect: {
        protocol: 'zigbee',
        manufacturerName: 'Visonic',
        modelID: 'MCT-340 E'
      },
      directRadioFeatures: ['battery', 'contact', 'tamper', 'temperature']
    }
  };
  const sourceDevice = {
    name: 'Back Door',
    type: 'sensor',
    room: 'Upstairs',
    properties: {
      source: 'smartthings',
      smartThingsLabel: 'Back Door',
      smartThingsDeviceName: 'Multipurpose Sensor',
      smartThingsManufacturer: 'SmartThingsCommunity',
      smartThingsCapabilities: [
        'contactSensor',
        'temperatureMeasurement',
        'threeAxis',
        'accelerationSensor',
        'battery',
        'firmwareUpdate',
        'refresh'
      ],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };

  assert.equal(scoreDetachedSmartThingsMigrationSource(directDevice, sourceDevice, 'zigbee'), -Infinity);
});

test('recovered SmartThings migration snapshot does not graft source-only features onto native device', () => {
  const directDevice = {
    _id: DEVICE_ID,
    name: 'Back Door',
    type: 'sensor',
    room: 'Upstairs',
    brand: 'Visonic',
    model: 'MCT-340 E',
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f000b11f6e5',
        manufacturerName: 'Visonic',
        modelID: 'MCT-340 E'
      },
      directRadioFeatures: ['battery', 'contact', 'tamper', 'temperature']
    }
  };
  const sourceDevice = {
    _id: SOURCE_DEVICE_ID,
    name: 'Back Door',
    type: 'sensor',
    room: 'Upstairs',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-back-door',
      smartThingsLabel: 'Back Door',
      smartThingsDeviceName: 'Multipurpose Sensor',
      smartThingsManufacturer: 'SmartThingsCommunity',
      smartThingsCapabilities: [
        'contactSensor',
        'temperatureMeasurement',
        'threeAxis',
        'accelerationSensor',
        'battery',
        'firmwareUpdate',
        'refresh'
      ],
      smartThingsDeviceNetworkType: 'ZIGBEE'
    }
  };

  const snapshot = buildRecoveredSmartThingsMigrationSnapshot({
    directDevice,
    sourceDevice,
    protocol: 'zigbee',
    validation: { status: 'needs_review' }
  });

  assert.deepEqual(snapshot.properties.directRadioFeatures, ['battery', 'contact', 'tamper', 'temperature']);
  assert.equal(snapshot.properties.supportsAccelerationSensor, false);
  assert.equal(snapshot.properties.supportsAxisSensor, undefined);
});

test('detached SmartThings migration matching rejects generic same-room sensor overlap without identity evidence', () => {
  const directDevice = {
    name: 'Garage Door Sensor',
    type: 'sensor',
    room: 'Outside',
    brand: 'Ecolink',
    model: 'TILTZWAVE1',
    properties: {
      homebrainDirect: {
        protocol: 'zwave',
        manufacturerName: 'Ecolink',
        modelID: 'TILTZWAVE1'
      },
      directRadioFeatures: ['battery', 'contact', 'garage']
    }
  };
  const unrelated = {
    name: 'Greenhouse',
    type: 'sensor',
    room: 'Outside',
    properties: {
      source: 'smartthings',
      smartThingsLabel: 'Greenhouse',
      smartThingsDeviceName: 'Z-Wave Contact Sensor',
      smartThingsCapabilities: ['contactSensor', 'battery'],
      smartThingsDeviceNetworkType: 'ZWAVE'
    }
  };
  const correctSource = {
    name: 'Garage Tilt Sensor',
    type: 'sensor',
    room: 'Outside',
    properties: {
      source: 'smartthings',
      smartThingsLabel: 'Garage Tilt Sensor',
      smartThingsDeviceName: 'Z-Wave Contact Sensor',
      smartThingsCapabilities: ['contactSensor', 'battery'],
      smartThingsDeviceNetworkType: 'ZWAVE'
    }
  };

  assert.equal(scoreDetachedSmartThingsMigrationSource(directDevice, unrelated, 'zwave'), -Infinity);
  assert.ok(scoreDetachedSmartThingsMigrationSource(directDevice, correctSource, 'zwave') >= 55);
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

test('SmartThings telemetry fallback restores contact vibration and axis state for migrated sensors', () => {
  const snapshot = mergeSmartThingsTelemetryFallback({
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f00057c3ef1'
      },
      directRadioFeatures: ['battery', 'contact', 'temperature']
    }
  }, {
    temperature: 64.6,
    properties: {
      source: 'smartthings',
      smartThingsBatteryLevel: 17,
      smartThingsAttributeValues: {
        contactSensor: {
          contact: 'closed'
        },
        accelerationSensor: {
          acceleration: 'inactive'
        },
        threeAxis: {
          threeAxis: [17, 9, 1011]
        },
        battery: {
          battery: 17
        },
        temperatureMeasurement: {
          temperature: 64.6
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
  });

  assert.equal(snapshot.status, false);
  assert.equal(snapshot.temperature, 64.6);
  assert.equal(snapshot.properties.directRadioState.contactOpen, false);
  assert.equal(snapshot.properties.directRadioState.contact, 'closed');
  assert.equal(snapshot.properties.directRadioState.accelerationActive, false);
  assert.equal(snapshot.properties.directRadioState.acceleration, 'inactive');
  assert.equal(snapshot.properties.directRadioState.vibrationActive, false);
  assert.equal(snapshot.properties.directRadioState.vibration, 'inactive');
  assert.deepEqual(snapshot.properties.directRadioState.axis, [17, 9, 1011]);
  assert.equal(snapshot.properties.directRadioState.xAxis, 17);
  assert.equal(snapshot.properties.directRadioState.yAxis, 9);
  assert.equal(snapshot.properties.directRadioState.zAxis, 1011);
  assert.ok(snapshot.properties.directRadioFeatures.includes('vibration'));
  assert.ok(snapshot.properties.directRadioFeatures.includes('acceleration'));
  assert.ok(snapshot.properties.directRadioFeatures.includes('axis'));
  assert.equal(snapshot.properties.supportsVibrationSensor, true);
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

test('direct radio upserts serialize writes for the same node identity', async () => {
  const service = createService();
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const completed = [];

  service.upsertDirectDeviceRecord = async (_identity, _update, options) => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeWrites -= 1;
    completed.push(options.marker);
    return { _id: options.marker };
  };

  await Promise.all([
    service.upsertDirectDevice({ protocol: 'zwave', id: '13' }, {}, { marker: 'node-ready' }),
    service.upsertDirectDevice({ protocol: 'zwave', id: '13' }, {}, { marker: 'ready' }),
    service.upsertDirectDevice({ protocol: 'zwave', id: '13' }, {}, { marker: 'interview-complete' })
  ]);

  assert.equal(maxActiveWrites, 1);
  assert.deepEqual(completed, ['node-ready', 'ready', 'interview-complete']);
});

test('direct radio duplicate detection collapses complete same-node siren rows', () => {
  const primary = {
    _id: 'primary-siren',
    name: 'ZW080',
    type: 'siren',
    properties: {
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 13
      },
      directRadioFeatures: ['alarm', 'button', 'switch']
    }
  };
  const duplicate = {
    _id: 'duplicate-siren',
    name: 'ZW080',
    type: 'siren',
    properties: {
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: '13'
      },
      directRadioFeatures: ['alarm', 'button', 'switch']
    }
  };
  const unrelated = {
    _id: 'other-node',
    name: 'ZW080',
    type: 'siren',
    properties: {
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 14
      },
      directRadioFeatures: ['alarm', 'button', 'switch']
    }
  };

  assert.equal(isDuplicateDirectRadioRecord(duplicate, primary, { protocol: 'zwave', id: '13' }), true);
  assert.equal(isDuplicateDirectRadioRecord(primary, primary, { protocol: 'zwave', id: '13' }), false);
  assert.equal(isDuplicateDirectRadioRecord(unrelated, primary, { protocol: 'zwave', id: '13' }), false);
});

test('direct radio upsert removes duplicate same-node records through device cleanup', async (t) => {
  const service = createService();
  const deviceService = require('../services/deviceService');
  const originalFind = Device.find;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeleteDevice = deviceService.deleteDevice;
  const deletedDeviceIds = [];
  const primary = {
    _id: '507f1f77bcf86cd799439061',
    name: 'ZW080',
    type: 'siren',
    isOnline: true,
    updatedAt: '2026-05-29T04:36:06.369Z',
    properties: {
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 13
      },
      directRadioFeatures: ['alarm', 'button', 'switch']
    }
  };
  const duplicate = {
    _id: '507f1f77bcf86cd799439062',
    name: 'ZW080',
    type: 'siren',
    isOnline: true,
    updatedAt: '2026-05-29T04:36:06.326Z',
    properties: {
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: '13'
      },
      directRadioFeatures: ['alarm', 'button', 'switch']
    }
  };
  const update = {
    name: 'ZW080',
    type: 'siren',
    isOnline: true,
    status: false,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 13
      },
      directRadioFeatures: ['alarm', 'button', 'switch']
    }
  };

  Device.find = async () => [primary, duplicate];
  Device.findByIdAndUpdate = async (_id, payload) => ({
    ...primary,
    ...payload,
    _id: primary._id,
    properties: payload.properties
  });
  deviceService.deleteDevice = async (deviceId) => {
    deletedDeviceIds.push(String(deviceId));
    return {
      _id: deviceId,
      name: 'ZW080',
      deletionCleanup: {
        securitySirenOutputsRemoved: 1
      }
    };
  };
  service.attachRecoveredSmartThingsMigrationIfMatched = async (device) => device;
  service.emitDeviceUpdate = () => {};
  service.completePairingSession = () => {};
  t.after(() => {
    Device.find = originalFind;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.deleteDevice = originalDeleteDevice;
  });

  const device = await service.upsertDirectDeviceRecord({ protocol: 'zwave', id: '13' }, update);

  assert.equal(device._id, primary._id);
  assert.deepEqual(deletedDeviceIds, [duplicate._id]);
});

test('Zigbee generic add reclaims the single SmartThings source awaiting native pairing', async (t) => {
  const service = createService();
  const deviceService = require('../services/deviceService');
  const originalFind = Device.find;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeleteDevice = deviceService.deleteDevice;
  const genericDeviceId = '507f1f77bcf86cd799439071';
  const sourceDeviceId = '507f1f77bcf86cd799439072';
  const ieeeAddr = '0x000d6f00057c3ef1';
  const genericDevice = {
    _id: genericDeviceId,
    name: 'Zigbee 7c3ef1',
    type: 'sensor',
    room: 'Unassigned',
    isOnline: true,
    status: false,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr,
        interviewCompleted: false,
        lastReason: 'deviceJoined'
      },
      directRadioFeatures: []
    }
  };
  const sourceDevice = {
    _id: sourceDeviceId,
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: true,
    isOnline: false,
    temperature: 67,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'front-door-smartthings-id',
      smartThingsDeviceNetworkType: 'ZIGBEE',
      smartThingsLabel: 'Front Door',
      smartThingsDeviceName: 'SmartThings Multipurpose Sensor',
      smartThingsCapabilities: [
        'contactSensor',
        'temperatureMeasurement',
        'threeAxis',
        'accelerationSensor',
        'battery'
      ],
      smartThingsBatteryLevel: 33,
      smartThingsMigration: {
        status: 'awaiting_native_pairing',
        protocol: 'zigbee',
        nativePairingStatus: 'expired',
        smartThingsDeviceId: 'front-door-smartthings-id',
        sourceDeviceId,
        sourceDeviceName: 'Front Door',
        smartThingsRemovalStatus: 'already_missing',
        smartThingsRemovalRequest: {
          status: 'already_missing',
          requestedAt: '2026-05-31T14:57:55.161Z'
        },
        updatedAt: '2026-05-31T15:00:55.654Z'
      }
    }
  };
  const deletedDeviceIds = [];
  const updates = [];
  Device.find = async (query = {}) => {
    if (Array.isArray(query.$and) && query.$and.some((clause) => clause['properties.smartThingsMigration.status'])) {
      return [sourceDevice];
    }
    return [genericDevice];
  };
  Device.findByIdAndUpdate = async (id, payload) => {
    updates.push({ id: String(id), payload });
    const base = String(id) === sourceDeviceId ? sourceDevice : genericDevice;
    return {
      ...base,
      ...payload,
      _id: String(id),
      properties: payload.properties
    };
  };
  deviceService.deleteDevice = async (deviceId) => {
    deletedDeviceIds.push(String(deviceId));
    return { _id: deviceId, name: 'Zigbee 7c3ef1' };
  };
  service.emitDeviceUpdate = () => {};
  service.completePairingSession = () => {};
  service.repairRecoveredSmartThingsMigrationIfMismatched = async (device) => device;
  t.after(() => {
    Device.find = originalFind;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.deleteDevice = originalDeleteDevice;
  });

  const result = await service.upsertDirectDeviceRecord({ protocol: 'zigbee', id: ieeeAddr }, {
    name: 'Zigbee 7c3ef1',
    type: 'sensor',
    room: 'Unassigned',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr,
        interviewCompleted: false,
        lastReason: 'deviceJoined'
      },
      directRadioFeatures: []
    }
  });

  const sourceUpdate = updates.find((entry) => entry.id === sourceDeviceId)?.payload;
  assert.equal(result._id, sourceDeviceId);
  assert.equal(result.name, 'Front Door');
  assert.equal(result.room, 'Upstairs');
  assert.equal(result.properties.source, 'homebrain-zigbee');
  assert.equal(result.properties.homebrainDirect.ieeeAddr, ieeeAddr);
  assert.equal(result.properties.smartThingsDeviceId, undefined);
  assert.equal(result.properties.smartThingsMigration.status, 'native_joined_pending_interview');
  assert.equal(result.properties.smartThingsMigration.nativePairingStatus, 'joined');
  assert.equal(result.properties.smartThingsMigration.duplicateDeviceId, genericDeviceId);
  assert.equal(result.properties.smartThingsMigration.validation.status, 'needs_review');
  assert.equal(sourceUpdate.properties.smartThingsMigration.smartThingsDeviceId, 'front-door-smartthings-id');
  assert.deepEqual(deletedDeviceIds, [genericDeviceId]);
});

test('Z-Wave controller nodes are not normalized as user devices', () => {
  const service = createService();

  const normalized = service.normalizeZWaveNode({
    id: 1,
    isControllerNode: true,
    ready: true,
    status: 4
  }, 'node ready');

  assert.equal(normalized, null);
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

test('SmartThings-backed Z-Wave migration trusts controller-verified native exclusion', async () => {
  const service = createService();
  const migration = {
    id: 'migration-native-exclusion',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-device-native-exclusion',
    protocol: 'zwave',
    status: 'excluding',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);
  service.smartThingsService = {
    getDevice: async () => ({
      deviceId: migration.smartThingsDeviceId,
      type: 'ZWAVE'
    })
  };

  service.recordZWaveExclusionStatus(6, { nodeId: 44 });
  const result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });

  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.exclusionNodeId, 44);
  assert.equal(migration.smartThingsRemovalVerifiedAt, undefined);
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

test('Zigbee contact migration verification blocks incomplete native reporting', async () => {
  const service = createService();
  const originalFindById = Device.findById;
  const migration = {
    id: 'migration-zigbee-contact-verification',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zigbee',
    status: 'completed',
    completedAt: new Date().toISOString(),
    inclusionVerifiedAt: new Date().toISOString(),
    directIdentity: {
      protocol: 'zigbee',
      id: '0x000d6f00057c3ef1'
    }
  };
  const device = {
    _id: DEVICE_ID,
    name: 'Front Door',
    type: 'sensor',
    room: 'Upstairs',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      smartThingsCapabilities: ['contactSensor', 'temperatureMeasurement', 'threeAxis', 'accelerationSensor', 'battery'],
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x000d6f00057c3ef1',
        modelID: null,
        manufacturerName: null,
        iasZone: null
      },
      directRadioFeatures: ['acceleration', 'axis', 'battery', 'contact', 'temperature', 'vibration'],
      directRadioState: {
        contactOpen: false,
        contact: 'closed'
      }
    }
  };
  service.activeMigrations.set(migration.id, migration);
  Device.findById = () => ({
    lean: async () => device
  });

  try {
    const result = await service.verifyMigrationStep({
      migrationId: migration.id,
      phase: 'verification'
    });

    assert.equal(result.verification.status, 'failed');
    assert.equal(result.verification.canAdvance, false);
    assert.match(result.verification.message, /IAS Zone enrollment/);
    const checks = new Map(result.verification.evidence.validation.checks.map((check) => [check.key, check]));
    assert.equal(checks.get('features').matched, true);
    assert.equal(checks.get('zigbee_identity').matched, false);
    assert.equal(checks.get('zigbee_ias_zone').matched, false);
  } finally {
    Device.findById = originalFindById;
  }
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

test('Zigbee pairing chunks long permit-join windows and renews them safely', async () => {
  const service = createService();
  const permitJoinCalls = [];
  service.start = async () => {};
  service.detected.zigbee = { path: '/dev/zigbee-test' };
  service.zigbee.started = true;
  service.zigbee.controller = {
    getDevices: () => [],
    permitJoin: async (seconds) => {
      permitJoinCalls.push(seconds);
    }
  };

  const result = await service.startPairing('zigbee', { durationSeconds: 600 });

  assert.deepEqual(permitJoinCalls, [240]);
  assert.equal(result.expiresAt, result.pairing.expiresAt);
  assert.equal(result.pairing.status, 'active');
  assert.ok(service.zigbeePermitJoinRenewalTimer);

  await service.stopPairing('zigbee');

  assert.deepEqual(permitJoinCalls, [240, 0]);
  assert.equal(service.zigbeePermitJoinRenewalTimer, null);
});

test('Z-Wave generic pairing defaults to standard inclusion without a DSK PIN prompt', async () => {
  const service = createService();
  const zwave = require('zwave-js');
  let inclusionOptions = null;
  const calls = [];
  service.start = async () => {};
  service.zwave.started = true;
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      stopInclusion: async () => {
        calls.push('stopInclusion');
        return false;
      },
      stopExclusion: async () => {
        calls.push('stopExclusion');
        return false;
      },
      beginInclusion: async (options) => {
        calls.push('beginInclusion');
        inclusionOptions = options;
        return true;
      }
    }
  };

  const result = await service.startPairing('zwave', { durationSeconds: 60 });
  assert.equal(inclusionOptions.strategy, zwave.InclusionStrategy.Insecure);
  assert.equal(result.pairing.zwaveSecurityMode, 'insecure');
  assert.match(result.pairing.message, /No DSK PIN is required/);
  assert.deepEqual(calls, ['stopInclusion', 'stopExclusion', 'beginInclusion']);
});

test('Z-Wave auto secure pairing forces S0 fallback for legacy secure devices', async () => {
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
    zwaveSecurityMode: 'default'
  });

  assert.equal(inclusionOptions.strategy, zwave.InclusionStrategy.Default);
  assert.equal(inclusionOptions.forceSecurity, true);
  assert.equal(result.pairing.zwaveSecurityMode, 'default');
});

test('Z-Wave pairing can explicitly request legacy S0 inclusion', async () => {
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
    zwaveSecurityMode: 's0'
  });

  assert.equal(inclusionOptions.strategy, zwave.InclusionStrategy.Security_S0);
  assert.equal(result.pairing.zwaveSecurityMode, 's0');
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

test('Z-Wave pairing retries once when the controller reports inclusion was not started', async () => {
  const service = createService();
  service.start = async () => {};
  service.zwave.started = true;
  let beginCalls = 0;
  let stopCalls = 0;
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      stopInclusion: async () => {
        stopCalls += 1;
        return true;
      },
      stopExclusion: async () => false,
      beginInclusion: async () => {
        beginCalls += 1;
        return beginCalls > 1;
      }
    }
  };

  const result = await service.startPairing('zwave', { durationSeconds: 60 });
  assert.equal(beginCalls, 2);
  assert.equal(stopCalls, 2);
  assert.equal(result.pairing.status, 'active');
  assert.ok(service.zwave.inclusionUntil);
});

test('Z-Wave pairing fails instead of reporting open when inclusion never starts', async () => {
  const service = createService();
  service.start = async () => {};
  service.zwave.started = true;
  service.zwave.driver = {
    controller: {
      inclusionState: 1,
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      stopInclusion: async () => false,
      stopExclusion: async () => false,
      beginInclusion: async () => false
    }
  };

  await assert.rejects(
    () => service.startPairing('zwave', { durationSeconds: 60 }),
    (error) => error.status === 409 && /Z-Wave inclusion did not start/.test(error.message)
  );
  assert.equal(service.zwave.inclusionUntil, null);
  assert.equal(service.activePairings.get('zwave').status, 'failed');
});

test('Z-Wave exclusion fails instead of reporting open when exclusion never starts', async () => {
  const service = createService();
  service.start = async () => {};
  service.zwave.started = true;
  service.zwave.driver = {
    controller: {
      inclusionState: 2,
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      stopInclusion: async () => false,
      stopExclusion: async () => false,
      beginExclusion: async () => false
    }
  };

  await assert.rejects(
    () => service.startExclusion('zwave', { durationSeconds: 60 }),
    (error) => error.status === 409 && /Z-Wave exclusion did not start/.test(error.message)
  );
  assert.equal(service.zwave.exclusionUntil, null);
});

test('Z-Wave generic pairing records a detected node before interview completion', () => {
  const service = createService();
  service.activePairings.set('zwave', {
    id: 'pairing-zwave-complete',
    protocol: 'zwave',
    mode: 'inclusion',
    status: 'active',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    baselineIdentities: [],
    events: []
  });

  const session = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '3', source: 'homebrain-zwave' },
    {
      _id: { toString: () => 'device-node-3' },
      name: 'Cold Storage Switch',
      properties: {
        homebrainDirect: { protocol: 'zwave', nodeId: 3, ready: false, status: 0 },
        directRadioFeatures: []
      }
    },
    'node added'
  );

  assert.equal(session.status, 'interviewing');
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
    {
      _id: { toString: () => 'device-node-4' },
      name: 'New Z-Wave Node',
      properties: {
        homebrainDirect: {
          protocol: 'zwave',
          nodeId: 4,
          ready: true,
          status: 4,
          manufacturerId: 57,
          productType: 18770,
          productId: 12597
        },
        directRadioFeatures: ['switch']
      }
    },
    'node value updated'
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.detectedIdentity.id, '4');
});

test('Z-Wave generic pairing waits for interview completion after a new node is detected', () => {
  const service = createService();
  let stopPairingCalls = 0;
  service.stopPairing = async () => {
    stopPairingCalls += 1;
  };
  service.activePairings.set('zwave', {
    id: 'pairing-zwave-interview',
    protocol: 'zwave',
    mode: 'inclusion',
    status: 'active',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    baselineIdentities: ['3'],
    events: []
  });

  const detected = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '13', source: 'homebrain-zwave' },
    {
      _id: { toString: () => 'partial-node-13' },
      name: 'Z-Wave Node 13',
      properties: {
        homebrainDirect: {
          protocol: 'zwave',
          nodeId: 13,
          ready: false,
          status: 0
        },
        directRadioFeatures: []
      }
    },
    'node added'
  );

  assert.equal(detected.status, 'interviewing');
  assert.equal(detected.detectedIdentity.id, '13');
  assert.equal(stopPairingCalls, 0);

  const completed = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '13', source: 'homebrain-zwave' },
    {
      _id: { toString: () => 'device-node-13' },
      name: 'Kitchen Siren',
      properties: {
        homebrainDirect: {
          protocol: 'zwave',
          nodeId: 13,
          ready: true,
          status: 4,
          manufacturerId: 134,
          productType: 260,
          productId: 80
        },
        directRadioFeatures: ['alarm', 'button', 'switch']
      }
    },
    'node value updated'
  );

  assert.equal(completed.status, 'completed');
  assert.equal(completed.directDeviceId, 'device-node-13');
  assert.equal(stopPairingCalls, 1);
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

test('Z-Wave node refresh skips re-interview when ping recovers the node', async () => {
  const service = createService();
  service.started = true;
  let refreshCalled = false;
  let changedReason = null;
  const node = {
    id: 4,
    isControllerNode: false,
    ready: true,
    status: 4,
    manufacturerId: 144,
    productType: 1,
    productId: 1,
    valueDB: { hasValue: () => false },
    ping: async () => true,
    refreshInfo: async () => {
      refreshCalled = true;
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
  service.handleZWaveNodeChanged = async (_node, reason) => {
    changedReason = reason;
  };

  const result = await service.refreshZWaveNodeInfo(4, {
    pingFirst: true,
    skipRefreshIfPingSucceeds: true
  });

  assert.equal(result.ping, true);
  assert.equal(result.skippedRefresh, true);
  assert.equal(refreshCalled, false);
  assert.equal(changedReason, 'ping succeeded');
});

test('Z-Wave failed-node replacement opens a legacy S0 replacement session', async (t) => {
  const service = createService();
  const zwave = require('zwave-js');
  service.start = async () => {};
  service.zwave.started = true;
  let replaceNodeId = null;
  let replacementOptions = null;
  const node = {
    id: 13,
    isControllerNode: false,
    ready: false,
    status: 3,
    valueDB: { hasValue: () => false }
  };
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [13, node]
      ]),
      stopInclusion: async () => false,
      stopExclusion: async () => false,
      isFailedNode: async () => true,
      replaceFailedNode: async (nodeId, options) => {
        replaceNodeId = nodeId;
        replacementOptions = options;
        return true;
      }
    }
  };
  t.after(() => {
    service.clearPairingTimer('zwave');
  });

  const result = await service.replaceFailedZWaveNode(13, {
    confirm: true,
    durationSeconds: 60,
    zwaveSecurityMode: 'default'
  });

  assert.equal(replaceNodeId, 13);
  assert.equal(replacementOptions.strategy, zwave.InclusionStrategy.Security_S0);
  assert.equal(result.zwaveSecurityMode, 's0');
  assert.equal(result.pairing.mode, 'replace_failed');
  assert.equal(result.pairing.replaceNodeId, 13);
  assert.equal(result.pairing.zwaveSecurityMode, 's0');
  assert.match(result.message, /legacy S0 replacement is open/);
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

test('Z-Wave failed-node removal force-cleans controller ghosts and matching device rows', async (t) => {
  const service = createService();
  service.started = true;
  const deviceService = require('../services/deviceService');
  const originalFind = Device.find;
  const originalDeleteDevice = deviceService.deleteDevice;
  let removedNodeId = null;
  let deleteQuery = null;
  const deletedDeviceIds = [];
  const node = {
    id: 4,
    isControllerNode: false,
    ready: false,
    status: 0,
    valueDB: { hasValue: () => false }
  };
  const nodes = new Map([
    [4, node]
  ]);
  service.zwave.driver = {
    controller: {
      nodes,
      isFailedNode: async () => false,
      removeFailedNode: async (nodeId) => {
        removedNodeId = nodeId;
      }
    }
  };
  Device.find = (query) => {
    deleteQuery = query;
    return {
      select: () => ({
        lean: async () => [
          { _id: '507f1f77bcf86cd799439041', name: 'Siren New' },
          { _id: '507f1f77bcf86cd799439042', name: 'Siren Old' }
        ]
      })
    };
  };
  deviceService.deleteDevice = async (deviceId) => {
    deletedDeviceIds.push(String(deviceId));
    return {
      _id: deviceId,
      name: `Deleted ${deviceId}`,
      deletionCleanup: {
        securitySirenOutputsRemoved: 1
      }
    };
  };
  t.after(() => {
    Device.find = originalFind;
    deviceService.deleteDevice = originalDeleteDevice;
  });

  const result = await service.removeFailedZWaveNode('4', {
    confirm: true,
    force: true
  });

  assert.equal(removedNodeId, 4);
  assert.equal(nodes.has(4), false);
  assert.deepEqual(deleteQuery, {
    'properties.homebrainDirect.protocol': 'zwave',
    'properties.homebrainDirect.nodeId': {
      $in: [4, '4']
    }
  });
  assert.deepEqual(deletedDeviceIds, [
    '507f1f77bcf86cd799439041',
    '507f1f77bcf86cd799439042'
  ]);
  assert.equal(result.nodeId, 4);
  assert.equal(result.force, true);
  assert.equal(result.deletedDeviceCount, 2);
  assert.equal(result.deletionCleanups.length, 2);
  assert.equal(result.deletionCleanups[0].cleanup.securitySirenOutputsRemoved, 1);
  assert.deepEqual(result.deletionErrors, []);
});

test('Z-Wave failed-node removal still succeeds when a matching HomeBrain record cleanup fails', async (t) => {
  const service = createService();
  service.started = true;
  const deviceService = require('../services/deviceService');
  const originalFind = Device.find;
  const originalDeleteDevice = deviceService.deleteDevice;
  let removedNodeId = null;
  const node = {
    id: 14,
    isControllerNode: false,
    ready: false,
    status: 3,
    valueDB: { hasValue: () => false }
  };
  const nodes = new Map([
    [14, node]
  ]);
  service.zwave.driver = {
    controller: {
      nodes,
      isFailedNode: async () => true,
      removeFailedNode: async (nodeId) => {
        removedNodeId = nodeId;
      }
    }
  };
  Device.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: '507f1f77bcf86cd799439051', name: 'Broken Cleanup Siren' }
      ]
    })
  });
  deviceService.deleteDevice = async () => {
    throw new Error('Failed to delete device');
  };
  t.after(() => {
    Device.find = originalFind;
    deviceService.deleteDevice = originalDeleteDevice;
  });

  const result = await service.removeFailedZWaveNode('14', {
    confirm: true,
    force: true
  });

  assert.equal(removedNodeId, 14);
  assert.equal(nodes.has(14), false);
  assert.equal(result.nodeId, 14);
  assert.equal(result.deletedDeviceCount, 0);
  assert.equal(result.deletionCleanups.length, 0);
  assert.deepEqual(result.deletionErrors, [
    {
      deviceId: '507f1f77bcf86cd799439051',
      name: 'Broken Cleanup Siren',
      message: 'Failed to delete device'
    }
  ]);
});
