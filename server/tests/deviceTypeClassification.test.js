const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferDirectDeviceType,
  mapSmartThingsDeviceType
} = require('../services/deviceTypeClassification');

function smartThingsDevice(overrides = {}) {
  return {
    name: 'Unnamed',
    label: 'Unnamed',
    presentationId: '',
    deviceTypeName: '',
    manufacturerName: 'SmartThings',
    ...overrides
  };
}

test('SmartThings dimmers and switch-level switch hardware classify as switches', () => {
  assert.equal(
    mapSmartThingsDeviceType(
      new Set(['switch', 'switchLevel', 'refresh']),
      new Set(['switch']),
      smartThingsDevice({ name: 'Back Extender' })
    ),
    'switch'
  );

  assert.equal(
    mapSmartThingsDeviceType(
      new Set(['switch', 'switchLevel', 'colorTemperature', 'refresh']),
      new Set(['light']),
      smartThingsDevice({
        name: 'Dining Room Dimmer',
        presentationId: 'generic-dimmer'
      })
    ),
    'switch'
  );
});

test('SmartThings actual light fixtures stay in the light category', () => {
  assert.equal(
    mapSmartThingsDeviceType(
      new Set(['switch', 'switchLevel', 'colorTemperature', 'colorControl']),
      new Set(['light']),
      smartThingsDevice({
        name: 'Vault LED Strip',
        presentationId: 'rgb-light'
      })
    ),
    'light'
  );
});

test('SmartThings camera profiles classify as cameras before switch or motion fallbacks', () => {
  assert.equal(
    mapSmartThingsDeviceType(
      new Set(['switch', 'motionSensor', 'videoStream', 'imageCapture']),
      new Set(['camera']),
      smartThingsDevice({
        name: 'Front Door Camera',
        presentationId: 'c2c-camera-rtsp-1'
      })
    ),
    'camera'
  );

  assert.equal(
    mapSmartThingsDeviceType(
      new Set(['motionSensor', 'cameraEvent']),
      new Set(['visionSensor']),
      smartThingsDevice({
        name: 'Driveway Vision Sensor',
        presentationId: 'c2c-camera-motion'
      })
    ),
    'camera'
  );
});

test('SmartThings sirens classify as sirens before switch fallback', () => {
  assert.equal(
    mapSmartThingsDeviceType(
      new Set(['alarm', 'switch']),
      new Set(['siren']),
      smartThingsDevice({
        name: 'Master Bedroom Siren',
        presentationId: 'generic-siren'
      })
    ),
    'siren'
  );
});

test('native direct radio dimmers classify as switches while actual bulbs stay lights', () => {
  assert.equal(
    inferDirectDeviceType(['switch', 'brightness'], { name: 'Kitchen In-Wall Dimmer Switch' }),
    'switch'
  );

  assert.equal(
    inferDirectDeviceType(['switch', 'brightness', 'battery'], { name: 'Remote Dimmer Switch' }),
    'switch'
  );

  assert.equal(
    inferDirectDeviceType(['switch', 'brightness'], { name: 'Kitchen LED Strip' }),
    'light'
  );

  assert.equal(
    inferDirectDeviceType(['switch', 'brightness', 'colorTemperature'], { name: 'Hall Tunable White Bulb' }),
    'light'
  );
});

test('native direct radio alarm-capable devices classify as sirens', () => {
  assert.equal(
    inferDirectDeviceType(['alarm', 'switch'], { name: 'Aeotec Siren' }),
    'siren'
  );

  assert.equal(
    inferDirectDeviceType(['switch'], { name: 'Utility Sounder Alarm' }),
    'siren'
  );
});
