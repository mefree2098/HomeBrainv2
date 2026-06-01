const test = require('node:test');
const assert = require('node:assert/strict');
const zwave = require('zwave-js');

const directRadioService = require('../services/directRadioService');

const DirectRadioService = directRadioService.DirectRadioService;
const {
  isZWaveNodeCommandReady,
  isZWaveNodeCommandProbeCandidate,
  isZWaveNodeOnline
} = directRadioService._test;

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
