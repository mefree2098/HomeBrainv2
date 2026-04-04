const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEndpointStatePropertiesForDevice,
  buildGroupStateProperties,
  inferDeviceTraits,
  inferGroupTraits,
  validateSceneExposure,
  validateWorkflowExposure
} = require('../services/alexaProjectionService');

test('inferDeviceTraits exposes supported Alexa interfaces for a color-capable light', () => {
  const traits = inferDeviceTraits({
    _id: '507f191e810c19729de860aa',
    name: 'Living Room Lamp',
    type: 'light',
    room: 'Living Room',
    status: true,
    brightness: 62,
    color: '#3366ff',
    colorTemperature: 4200,
    isOnline: true
  });

  assert.deepEqual(traits.displayCategories, ['LIGHT']);
  assert.equal(traits.validationErrors.length, 0);
  assert.ok(traits.interfaces.has('Alexa.PowerController'));
  assert.ok(traits.interfaces.has('Alexa.BrightnessController'));
  assert.ok(traits.interfaces.has('Alexa.ColorController'));
  assert.ok(traits.interfaces.has('Alexa.ColorTemperatureController'));
  assert.ok(traits.interfaces.has('Alexa.EndpointHealth'));

  const properties = buildEndpointStatePropertiesForDevice({
    type: 'light',
    status: true,
    brightness: 62,
    color: '#3366ff',
    colorTemperature: 4200,
    isOnline: true
  }, traits);

  assert.equal(properties.find((entry) => entry.namespace === 'Alexa.PowerController')?.value, 'ON');
  assert.equal(properties.find((entry) => entry.namespace === 'Alexa.BrightnessController')?.value, 62);
  assert.equal(
    properties.find((entry) => entry.namespace === 'Alexa.ColorTemperatureController')?.value,
    4200
  );
});

test('inferGroupTraits downgrades mixed light and switch groups to safe power control', () => {
  const traits = inferGroupTraits(
    { name: 'Main Floor' },
    [
      { _id: '1', name: 'Lamp', type: 'light', status: true, brightness: 50, isOnline: true },
      { _id: '2', name: 'Outlet', type: 'switch', status: false, isOnline: true }
    ]
  );

  assert.deepEqual(traits.displayCategories, ['SWITCH']);
  assert.equal(traits.validationErrors.length, 0);
  assert.equal(traits.validationWarnings.length, 1);
  assert.ok(traits.interfaces.has('Alexa.PowerController'));
  assert.equal(traits.interfaces.has('Alexa.BrightnessController'), false);

  const properties = buildGroupStateProperties([
    { _id: '1', name: 'Lamp', type: 'light', status: true, brightness: 50, isOnline: true },
    { _id: '2', name: 'Outlet', type: 'switch', status: false, isOnline: true }
  ], traits);

  assert.equal(properties.find((entry) => entry.namespace === 'Alexa.PowerController')?.value, 'ON');
});

test('validateSceneExposure blocks restricted scene devices', () => {
  const result = validateSceneExposure({
    _id: 'scene-1',
    name: 'Night Lockdown',
    deviceActions: [
      { deviceId: 'device-lock-1', action: 'lock', value: null }
    ]
  }, new Map([
    ['device-lock-1', { _id: 'device-lock-1', name: 'Front Door', type: 'lock' }]
  ]));

  assert.ok(result.validationErrors.some((entry) => entry.includes('lock')));
});

test('validateSceneExposure accepts a scene backed by safe device groups', () => {
  const result = validateSceneExposure({
    _id: 'scene-2',
    name: 'All Lights Off',
    groupActions: [
      { groupId: 'group-1', action: 'turn_off', value: null }
    ]
  }, {
    devicesById: new Map([
      ['device-1', { _id: 'device-1', name: 'Lamp', type: 'light', status: true, brightness: 60, isOnline: true }],
      ['device-2', { _id: 'device-2', name: 'Porch Light', type: 'light', status: true, brightness: 100, isOnline: true }]
    ]),
    groupsById: new Map([
      ['group-1', {
        _id: 'group-1',
        name: 'Whole Home Lights',
        deviceIds: ['device-1', 'device-2']
      }]
    ])
  });

  assert.equal(result.validationErrors.length, 0);
  assert.equal(result.devices.length, 2);
});

test('validateWorkflowExposure accepts safe manual workflows and rejects unsupported actions', () => {
  const safeWorkflow = validateWorkflowExposure({
    _id: 'workflow-1',
    name: 'Movie Night',
    enabled: true,
    trigger: { type: 'manual', conditions: {} },
    actions: [
      {
        type: 'device_control',
        target: { kind: 'device_group', group: 'Living Room Lights' },
        parameters: { action: 'turn_off' }
      },
      {
        type: 'delay',
        target: null,
        parameters: { seconds: 2 }
      }
    ]
  }, {
    devicesById: new Map(),
    groupsByNormalizedName: new Map([
      ['living room lights', { name: 'Living Room Lights', deviceIds: [] }]
    ]),
    scenesById: new Map()
  });

  assert.equal(safeWorkflow.validationErrors.length, 0);
  assert.equal(safeWorkflow.displayCategory, 'ACTIVITY_TRIGGER');

  const unsafeWorkflow = validateWorkflowExposure({
    _id: 'workflow-2',
    name: 'Webhook Workflow',
    enabled: true,
    trigger: { type: 'manual', conditions: {} },
    actions: [
      {
        type: 'http_request',
        target: 'https://example.com',
        parameters: {}
      }
    ]
  }, {
    devicesById: new Map(),
    groupsByNormalizedName: new Map(),
    scenesById: new Map()
  });

  assert.ok(unsafeWorkflow.validationErrors.some((entry) => entry.includes('unsupported action type')));
});
