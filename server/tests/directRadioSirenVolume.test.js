const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const zwave = require('zwave-js');

const directRadioService = require('../services/directRadioService');

const DirectRadioService = directRadioService.DirectRadioService;
const {
  isZWaveNodeCommandReady,
  isZWaveNodeCommandProbeCandidate,
  isZWaveNodeOnline
} = directRadioService._test;

test('Z-Wave driver uses fast persistent cache writes by default', async (t) => {
  const originalLoad = Module._load;
  const originalThrottle = process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE;
  let capturedOptions = null;

  delete process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE;

  class FakeDriver {
    constructor(_serialPath, options) {
      capturedOptions = options;
      this.controller = { homeId: 1234 };
    }

    on() {}

    async start() {}
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'zwave-js') {
      return {
        Driver: FakeDriver,
        SecurityClass: {
          S2_AccessControl: 1,
          S2_Authenticated: 2,
          S2_Unauthenticated: 3,
          S0_Legacy: 4
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  t.after(() => {
    Module._load = originalLoad;
    if (originalThrottle === undefined) {
      delete process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE;
    } else {
      process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE = originalThrottle;
    }
  });

  const service = new DirectRadioService();
  service.ensureControllerConfig = async () => ({
    zwave: {
      securityKeys: {
        S2_AccessControl: '11111111111111111111111111111111',
        S2_Authenticated: '22222222222222222222222222222222',
        S2_Unauthenticated: '33333333333333333333333333333333',
        S0_Legacy: '44444444444444444444444444444444'
      },
      securityKeysLongRange: {
        S2_AccessControl: '55555555555555555555555555555555',
        S2_Authenticated: '66666666666666666666666666666666'
      }
    }
  });

  await service.startZWave('/dev/ttyUSB-test');

  assert.equal(capturedOptions.storage.throttle, 'fast');
  assert.match(capturedOptions.storage.cacheDir, /zwave[\\/]cache$/);
  assert.match(capturedOptions.storage.lockDir, /zwave[\\/]locks$/);
});

function sirenVolumeCatalogParameter(overrides = {}) {
  return {
    parameter: 37,
    valueBitMask: 0xff,
    label: 'Volume',
    minValue: 1,
    maxValue: 3,
    defaultValue: 3,
    allowManualEntry: true,
    options: [
      { label: 'Low', value: 1 },
      { label: 'Medium', value: 2 },
      { label: 'High', value: 3 }
    ],
    ...overrides
  };
}

function sirenSoundCatalogParameter(overrides = {}) {
  return {
    parameter: 37,
    valueBitMask: 0xff00,
    label: 'Siren Sound',
    minValue: 1,
    maxValue: 5,
    defaultValue: 1,
    allowManualEntry: false,
    options: [
      { label: 'Sound 1', value: 1 },
      { label: 'Sound 2', value: 2 },
      { label: 'Sound 3', value: 3 },
      { label: 'Sound 4', value: 4 },
      { label: 'Sound 5', value: 5 }
    ],
    ...overrides
  };
}

function nativeSirenDevice(overrides = {}) {
  return {
    _id: 'native-siren-1',
    name: 'Kitchen Siren',
    type: 'siren',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 8
      },
      directRadioFeatures: ['alarm', 'switch'],
      supportsAlarm: true,
      directRadioCatalog: {
        protocol: 'zwave',
        configParameters: [sirenSoundCatalogParameter(), sirenVolumeCatalogParameter()]
      }
    },
    ...overrides
  };
}

function zwaveNode(overrides = {}) {
  return {
    id: 8,
    ready: true,
    status: 4,
    interviewStage: 5,
    isControllerNode: false,
    isListening: true,
    valueDB: {
      hasValue: () => false,
      getValue: () => undefined
    },
    ...overrides
  };
}

test('Z-Wave readiness treats dead or incomplete nodes as offline', () => {
  const service = new DirectRadioService();
  const deadNode = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 1
  });
  const aliveNode = zwaveNode();

  const deadUpdate = service.normalizeZWaveNode(deadNode, 'sync').update;
  const aliveUpdate = service.normalizeZWaveNode(aliveNode, 'sync').update;

  assert.equal(isZWaveNodeOnline(deadNode), false);
  assert.equal(isZWaveNodeCommandReady(deadNode), false);
  assert.equal(deadUpdate.isOnline, false);
  assert.equal(deadUpdate.properties.homebrainDirect.ready, false);
  assert.equal(deadUpdate.properties.homebrainDirect.status, 3);

  assert.equal(isZWaveNodeOnline(aliveNode), true);
  assert.equal(isZWaveNodeCommandReady(aliveNode), true);
  assert.equal(aliveUpdate.isOnline, true);
  assert.equal(aliveUpdate.properties.homebrainDirect.ready, true);
});

test('Z-Wave readiness accepts a fresh probe for interviewed listening nodes', () => {
  const service = new DirectRadioService();
  const probedNode = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 5,
    isListening: true,
    manufacturerId: 134,
    productType: 260,
    productId: 80,
    deviceConfig: {
      manufacturer: 'AEON Labs',
      label: 'ZW080'
    },
    __homebrainReachabilityProbe: {
      ok: true,
      at: Date.now(),
      reason: 'command',
      source: 'ping'
    }
  });

  const update = service.normalizeZWaveNode(probedNode, 'sync').update;

  assert.equal(isZWaveNodeCommandProbeCandidate(probedNode), true);
  assert.equal(isZWaveNodeOnline(probedNode), true);
  assert.equal(isZWaveNodeCommandReady(probedNode), true);
  assert.equal(update.isOnline, true);
  assert.equal(update.properties.homebrainDirect.ready, true);
  assert.equal(update.properties.homebrainDirect.status, 4);
  assert.equal(update.properties.homebrainDirect.controllerReady, false);
  assert.equal(update.properties.homebrainDirect.controllerStatus, 3);
  assert.equal(update.properties.homebrainDirect.lastReachabilityProbeReason, 'command');
});

test('Z-Wave siren sound command probes stale interviewed listening nodes before rejecting them', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 5,
      isListening: true,
      manufacturerId: 134,
      productType: 260,
      productId: 80,
      deviceConfig: {
        manufacturer: 'AEON Labs',
        label: 'ZW080'
      }
    }),
    ping: async () => {
      pingCount += 1;
      return true;
    },
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 2', updateData);

  assert.equal(pingCount, 1);
  assert.equal(setCalls.length, 1);
  assert.equal(updateData.isOnline, true);
  assert.equal(updateData.properties.homebrainDirect.ready, true);
  assert.equal(updateData.properties.homebrainDirect.status, 4);
  assert.equal(updateData.properties.homebrainDirect.controllerReady, false);
  assert.equal(updateData.properties.homebrainDirect.controllerStatus, 3);
  assert.equal(updateData.properties.homebrainDirect.lastCommandAcceptedAt.length > 0, true);
  assert.equal(updateData.properties.sirenSound, 2);
});

test('Z-Wave siren sound command attempts known devices when readiness ping fails', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 5,
      isListening: true,
      manufacturerId: 134,
      productType: 260,
      productId: 80,
      deviceConfig: {
        manufacturer: 'AEON Labs',
        label: 'ZW080'
      }
    }),
    ping: async () => {
      pingCount += 1;
      return false;
    },
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 4', updateData);

  assert.equal(pingCount, 1);
  assert.equal(setCalls.length, 1);
  assert.equal(updateData.isOnline, true);
  assert.equal(updateData.properties.homebrainDirect.ready, true);
  assert.equal(updateData.properties.homebrainDirect.status, 4);
  assert.equal(updateData.properties.homebrainDirect.controllerReady, false);
  assert.equal(updateData.properties.homebrainDirect.controllerStatus, 3);
  assert.equal(updateData.properties.homebrainDirect.lastCommandAcceptedAt.length > 0, true);
  assert.equal(updateData.properties.sirenSound, 4);
});

test('Z-Wave siren sound command probes generic controller shells when the HomeBrain device identity is preserved', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 1,
      isListening: true,
      manufacturerId: null,
      productType: null,
      productId: null,
      manufacturer: null,
      productLabel: null,
      deviceConfig: null
    }),
    ping: async () => {
      pingCount += 1;
      return true;
    },
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  assert.equal(isZWaveNodeCommandProbeCandidate(node), false);
  assert.equal(isZWaveNodeCommandReady(node), false);

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 3', updateData);

  assert.equal(pingCount, 1);
  assert.equal(setCalls.length, 1);
  assert.equal(isZWaveNodeCommandReady(node), true);
  assert.equal(node.__homebrainReachabilityProbe.knownDeviceIdentity, true);
  assert.equal(updateData.isOnline, true);
  assert.equal(updateData.properties.homebrainDirect.ready, true);
  assert.equal(updateData.properties.homebrainDirect.status, 4);
  assert.equal(updateData.properties.homebrainDirect.controllerReady, false);
  assert.equal(updateData.properties.homebrainDirect.controllerStatus, 3);
  assert.equal(updateData.properties.homebrainDirect.lastCommandAcceptedAt.length > 0, true);
  assert.equal(updateData.properties.sirenSound, 3);
});

test('Z-Wave startup sync does not probe generic controller shells', async () => {
  const service = new DirectRadioService();
  let pingCount = 0;
  let changedReason = null;
  const node = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 1,
    isListening: true,
    manufacturerId: null,
    productType: null,
    productId: null,
    manufacturer: null,
    productLabel: null,
    deviceConfig: null,
    ping: async () => {
      pingCount += 1;
      return true;
    }
  });
  service.getZWaveControllerNodes = () => new Map([[node.id, node]]);
  service.findDeviceForZWaveNode = async () => nativeSirenDevice();
  service.handleZWaveNodeChanged = async (_node, reason) => {
    changedReason = reason;
  };

  await service.syncZWaveNodes();

  assert.equal(pingCount, 0);
  assert.equal(changedReason, 'sync');
  assert.equal(isZWaveNodeCommandReady(node), false);
  assert.equal(node.__homebrainReachabilityProbe, undefined);
});

test('Z-Wave siren volume command writes the catalog configuration parameter', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  const node = {
    id: 8,
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    },
    valueDB: {
      hasValue: () => false,
      getValue: () => undefined
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirenvolume', 2, updateData);

  assert.equal(setCalls.length, 1);
  assert.deepEqual(
    setCalls[0].valueId,
    zwave.ConfigurationCCValues.paramInformation(37, 0xff).id
  );
  assert.equal(setCalls[0].value, 2);
  assert.equal(updateData.properties.supportsSirenVolume, true);
  assert.equal(updateData.properties.sirenVolume, 2);
  assert.deepEqual(updateData.properties.sirenVolumeOptions, [
    { label: 'Low', value: 1 },
    { label: 'Medium', value: 2 },
    { label: 'High', value: 3 }
  ]);
});

test('Z-Wave siren volume command accepts catalog option labels and rejects out-of-range values', () => {
  const service = new DirectRadioService();
  const device = nativeSirenDevice();

  assert.deepEqual(service.normalizeSirenVolumeCommand(device, 'High'), {
    value: 3,
    parameter: sirenVolumeCatalogParameter(),
    options: [
      { label: 'Low', value: 1 },
      { label: 'Medium', value: 2 },
      { label: 'High', value: 3 }
    ]
  });
  assert.throws(
    () => service.normalizeSirenVolumeCommand(device, 4),
    /Siren volume must be at most 3/
  );
});

test('Z-Wave siren sound command writes the catalog configuration parameter', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  const node = {
    id: 8,
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    },
    valueDB: {
      hasValue: () => false,
      getValue: () => undefined
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 4', updateData);

  assert.equal(setCalls.length, 1);
  assert.deepEqual(
    setCalls[0].valueId,
    zwave.ConfigurationCCValues.paramInformation(37, 0xff00).id
  );
  assert.equal(setCalls[0].value, 4);
  assert.equal(updateData.properties.supportsSirenSound, true);
  assert.equal(updateData.properties.sirenSound, 4);
  assert.deepEqual(updateData.properties.sirenSoundOptions, [
    { label: 'Sound 1', value: 1 },
    { label: 'Sound 2', value: 2 },
    { label: 'Sound 3', value: 3 },
    { label: 'Sound 4', value: 4 },
    { label: 'Sound 5', value: 5 }
  ]);
});

test('Z-Wave siren sound command validates catalog options', () => {
  const service = new DirectRadioService();
  const device = nativeSirenDevice();

  assert.deepEqual(service.normalizeSirenSoundCommand(device, 'Sound 5'), {
    value: 5,
    parameter: sirenSoundCatalogParameter(),
    options: [
      { label: 'Sound 1', value: 1 },
      { label: 'Sound 2', value: 2 },
      { label: 'Sound 3', value: 3 },
      { label: 'Sound 4', value: 4 },
      { label: 'Sound 5', value: 5 }
    ]
  });
  assert.throws(
    () => service.normalizeSirenSoundCommand(device, 6),
    /Siren sound must be at most 5/
  );
});
