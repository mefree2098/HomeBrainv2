'use strict';

// Phase 4 coverage: a Z-Wave siren must actually sound. Sirens that only
// implement Sound Switch CC (no Binary Switch) are now triggered via the
// "Play Tone" value (toneId: 255 = play, 0 = stop) instead of throwing
// "no support" or only nudging volume.

const test = require('node:test');
const assert = require('node:assert/strict');
const zwave = require('zwave-js');

const directRadioService = require('../services/directRadioService');
const DirectRadioService = directRadioService.DirectRadioService;

const BINARY_CC = zwave.BinarySwitchCCValues.targetValue.id.commandClass;
const SOUND_CC = zwave.SoundSwitchCCValues.toneId.id.commandClass;
const MULTILEVEL_CC = zwave.MultilevelSwitchCCValues.targetValue.id.commandClass;

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

function nodeWithCommandClasses(presentCommandClasses, setCalls) {
  const present = new Set(presentCommandClasses);
  return {
    id: 8,
    ready: true,
    status: 4,
    interviewStage: 5,
    isControllerNode: false,
    isListening: true,
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    },
    valueDB: {
      hasValue: (id) => present.has(id?.commandClass),
      getValue: () => undefined
    }
  };
}

test('siren with Binary Switch is sounded via Binary Switch', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([BINARY_CC], setCalls);

  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].valueId.commandClass, BINARY_CC);
  assert.equal(setCalls[0].valueId.property, 'targetValue');
  assert.equal(setCalls[0].value, true);
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

test('Multilevel-only siren falls back to Multilevel Switch', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([MULTILEVEL_CC], setCalls);

  await service.controlZWaveDevice(sirenDevice(), 'turnon', null, {});
  assert.equal(setCalls[0].valueId.commandClass, MULTILEVEL_CC);
  assert.equal(setCalls[0].value, 99);
});

test('siren with no supported trigger throws a clear error', async () => {
  const service = new DirectRadioService();
  service.getDirectNodeForDevice = () => nodeWithCommandClasses([], []);

  await assert.rejects(
    () => service.controlZWaveDevice(sirenDevice(), 'turnon', null, {}),
    /does not expose a supported trigger/
  );
});
