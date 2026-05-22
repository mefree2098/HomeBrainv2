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
