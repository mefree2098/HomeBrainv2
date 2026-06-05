'use strict';

// Phase 4 coverage: a Z-Wave siren must actually sound, across all kinds of sirens.
//
// Regression guard (Aeotec Siren Gen5 / ZW080): support is now determined from the
// node's INTERVIEWED command classes (getDefinedValueIDs), not from whether a value
// happens to be cached. A freshly-included siren has not cached a targetValue yet, so
// the previous valueDB.hasValue() check returned false for every CC and wrongly threw
// "no supported trigger" -- breaking on/off that used to work. These tests deliberately
// model a freshly-included node (valueDB caches nothing) to lock the fix in place.
//
// Trigger priority: Binary Switch -> Sound Switch tone (255 play / 0 stop) ->
// Multilevel Switch -> Basic (legacy/simple sirens like the ZW080).

const test = require('node:test');
const assert = require('node:assert/strict');
const zwave = require('zwave-js');

const directRadioService = require('../services/directRadioService');
const DirectRadioService = directRadioService.DirectRadioService;

const BINARY_CC = zwave.BinarySwitchCCValues.targetValue.id.commandClass;
const SOUND_CC = zwave.SoundSwitchCCValues.toneId.id.commandClass;
const MULTILEVEL_CC = zwave.MultilevelSwitchCCValues.targetValue.id.commandClass;
const BASIC_CC = zwave.BasicCCValues.targetValue.id.commandClass;
const CONFIGURATION_CC = zwave.ConfigurationCCValues.paramInformation(5).id.commandClass;

function sirenDevice() {
  return {
    _id: 'siren-x',
    name: 'Test Siren',
    type: 'siren',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: { protocol: 'zwave', nodeId: 8 },
      directRadioFeatures: ['alarm']
    }
  };
}

// Models a node that *supports* the given command classes (per its interview) but,
// like a freshly-included device, has NOT cached any values yet (valueDB.hasValue is
// always false). setValue rejects unsupported CCs the way a real controller does.
//   options.exposeDefinedIds=false simulates an interview that has not yet populated
//   value IDs, exercising the try-each fallback path.
function nodeWithCommandClasses(presentCommandClasses, setCalls, options = {}) {
  const { exposeDefinedIds = true } = options;
  const present = new Set(presentCommandClasses);
  const rejected = new Set(options.rejectCommandClasses || []);
  const definedIds = [...present].map((cc) => ({ commandClass: cc, property: 'targetValue', endpoint: 0 }));
  return {
    id: 8,
    ready: true,
    status: 4,
    interviewStage: 5,
    isControllerNode: false,
    isListening: true,
    getDefinedValueIDs: () => (exposeDefinedIds ? definedIds.slice() : []),
    setValue: async (valueId, value) => {
      if (!present.has(valueId?.commandClass)) {
        return { status: zwave.SetValueStatus.NoDeviceSupport, message: 'Device does not support this command class' };
      }
      if (rejected.has(valueId?.commandClass)) {
        return { status: zwave.SetValueStatus.Fail, message: 'Command rejected by device' };
      }
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    },
    valueDB: {
      // Freshly-included device: nothing cached yet. This is the regression scenario.
      hasValue: () => false,
      getValue: () => undefined
    }
  };
}

test('freshly-included Binary Switch siren is sounded (no cached value required)', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([BINARY_CC], setCalls);

  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});

  assert.equal(setCalls.length, 1, 'a command was sent even though nothing was cached');
  assert.equal(setCalls[0].valueId.commandClass, BINARY_CC);
  assert.equal(setCalls[0].valueId.property, 'targetValue');
  assert.equal(setCalls[0].value, true);
});

test('Aeotec ZW080-style Basic-only siren is sounded via Basic CC (255 on / 0 off)', async () => {
  const service = new DirectRadioService();

  const onCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([BASIC_CC], onCalls);
  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});
  assert.equal(onCalls.length, 1, 'Basic-only siren is now supported (previously threw)');
  assert.equal(onCalls[0].valueId.commandClass, BASIC_CC);
  assert.equal(onCalls[0].value, 255, 'Basic on = 255');

  const offCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([BASIC_CC], offCalls);
  await service.controlZWaveDevice(sirenDevice(), 'turnoff', null, {});
  assert.equal(offCalls[0].valueId.commandClass, BASIC_CC);
  assert.equal(offCalls[0].value, 0, 'Basic off = 0');
});

test('Sound-Switch-only siren is sounded via tone play (255) and stopped via tone 0', async () => {
  const service = new DirectRadioService();

  const onCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([SOUND_CC], onCalls);
  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});
  assert.equal(onCalls.length, 1, 'a command was sent (previously this threw "no support")');
  assert.equal(onCalls[0].valueId.commandClass, SOUND_CC);
  assert.equal(onCalls[0].valueId.property, 'toneId');
  assert.equal(onCalls[0].value, 255, 'plays the configured default tone');

  const offCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([SOUND_CC], offCalls);
  await service.controlZWaveDevice(sirenDevice(), 'turnoff', null, {});
  assert.equal(offCalls[0].valueId.commandClass, SOUND_CC);
  assert.equal(offCalls[0].value, 0, 'stops the tone (not just volume=0)');
});

test('Binary Switch is preferred over Sound Switch when both exist', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([BINARY_CC, SOUND_CC], setCalls);

  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});
  assert.equal(setCalls[0].valueId.commandClass, BINARY_CC);
});

test('siren trigger falls back when preferred command class is rejected', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([BINARY_CC, SOUND_CC], setCalls, {
    rejectCommandClasses: [BINARY_CC]
  });

  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});

  assert.equal(setCalls.length, 1, 'fallback found an accepted command class');
  assert.equal(setCalls[0].valueId.commandClass, SOUND_CC);
  assert.equal(setCalls[0].valueId.property, 'toneId');
  assert.equal(setCalls[0].value, 255);
});

test('alarmon sounds a Z-Wave siren through the trigger path', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([SOUND_CC], setCalls);

  await service.controlZWaveDevice(sirenDevice(), 'alarmon', null, {});

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].valueId.commandClass, SOUND_CC);
  assert.equal(setCalls[0].valueId.property, 'toneId');
  assert.equal(setCalls[0].value, 255);
});

test('alarmon raises a muted siren volume before sounding', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  const device = sirenDevice();
  device.properties.supportsSirenVolume = true;
  device.properties.sirenVolume = 0;
  device.properties.directRadioCatalog = {
    configParameters: [
      {
        parameter: 5,
        label: 'Siren Playback Volume',
        minValue: 0,
        maxValue: 100,
        defaultValue: 100
      }
    ]
  };
  const updateData = {};
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([CONFIGURATION_CC, SOUND_CC], setCalls);

  await service.controlZWaveDevice(device, 'alarmon', null, updateData);

  assert.equal(setCalls.length, 2);
  assert.equal(setCalls[0].valueId.commandClass, CONFIGURATION_CC);
  assert.equal(setCalls[0].value, 100);
  assert.equal(setCalls[1].valueId.commandClass, SOUND_CC);
  assert.equal(setCalls[1].valueId.property, 'toneId');
  assert.equal(setCalls[1].value, 255);
  assert.equal(updateData.properties.sirenVolume, 100);
});

test('Multilevel-only siren falls back to Multilevel Switch', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([MULTILEVEL_CC], setCalls);

  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});
  assert.equal(setCalls[0].valueId.commandClass, MULTILEVEL_CC);
  assert.equal(setCalls[0].value, 99);
});

test('fallback: when the interview has not populated value IDs, the first accepted CC is used', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  // exposeDefinedIds=false => getDefinedValueIDs() is empty, forcing the try-each path.
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([BINARY_CC], setCalls, { exposeDefinedIds: false });

  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});
  assert.equal(setCalls.length, 1, 'fallback found the supported CC by trying it');
  assert.equal(setCalls[0].valueId.commandClass, BINARY_CC);
});

test('siren with no supported trigger throws a clear error', async () => {
  const service = new DirectRadioService();
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([], []);

  await assert.rejects(
    () => service.controlZWaveDevice(sirenDevice(), 'turnon', null, {}),
    /does not expose a supported on\/off trigger/
  );
});
