const test = require('node:test');
const assert = require('node:assert/strict');
const zwave = require('zwave-js');

const directRadioService = require('../services/directRadioService');

const DirectRadioService = directRadioService.DirectRadioService;

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
