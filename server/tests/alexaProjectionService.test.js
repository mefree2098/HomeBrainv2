const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AlexaProjectionService,
  buildEndpointStatePropertiesForDevice,
  buildGroupStateProperties,
  canonicalizeDeviceSource,
  deviceMatchesSourceFilter,
  getDeviceSource,
  inferDeviceTraits,
  inferGroupTraits,
  validateSceneExposure,
  validateWorkflowExposure
} = require('../services/alexaProjectionService');
const AlexaExposure = require('../models/AlexaExposure');

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

test('scene Alexa endpoints support deactivation while workflow scene endpoints remain activate-only', () => {
  const service = new AlexaProjectionService();
  const context = {
    hubId: 'hub-1',
    devicesById: new Map([
      ['device-light-1', {
        _id: 'device-light-1',
        name: 'Lamp',
        type: 'light',
        status: true,
        brightness: 60,
        isOnline: true
      }]
    ]),
    groupsById: new Map(),
    groupsByNormalizedName: new Map(),
    scenesById: new Map([
      ['scene-1', {
        _id: 'scene-1',
        name: 'Movie Night',
        deviceActions: [
          { deviceId: 'device-light-1', action: 'set_brightness', value: 37 }
        ],
        groupActions: []
      }]
    ]),
    workflowsById: new Map([
      ['workflow-1', {
        _id: 'workflow-1',
        name: 'Night TV',
        enabled: true,
        trigger: { type: 'manual', conditions: {} },
        actions: [
          { type: 'device_control', target: 'device-light-1', parameters: { action: 'turn_on' } }
        ]
      }]
    ])
  };

  const sceneRecord = service.buildRecordForExposure({
    entityType: 'scene',
    entityId: 'scene-1',
    enabled: true,
    friendlyName: 'Movie Night'
  }, context);
  const workflowRecord = service.buildRecordForExposure({
    entityType: 'workflow',
    entityId: 'workflow-1',
    enabled: true,
    friendlyName: 'Night TV'
  }, context);

  const sceneController = sceneRecord.endpoint.capabilities.find((capability) => (
    capability.interface === 'Alexa.SceneController'
  ));
  const workflowSceneController = workflowRecord.endpoint.capabilities.find((capability) => (
    capability.interface === 'Alexa.SceneController'
  ));

  assert.equal(sceneController.supportsDeactivation, true);
  assert.equal(workflowSceneController.supportsDeactivation, false);
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

test('device source helpers canonicalize native radio and inferred integration devices', () => {
  assert.equal(canonicalizeDeviceSource('zigbee'), 'homebrain-zigbee');
  assert.equal(canonicalizeDeviceSource('z-wave'), 'homebrain-zwave');

  assert.equal(
    getDeviceSource({ properties: { homebrainDirect: { protocol: 'zwave' } } }),
    'homebrain-zwave'
  );
  assert.equal(
    getDeviceSource({ properties: { insteonAddress: '1A.2B.3C' } }),
    'insteon'
  );
  assert.equal(
    deviceMatchesSourceFilter({ properties: { source: 'homebrain-zigbee' } }, 'zigbee'),
    true
  );
  assert.equal(
    deviceMatchesSourceFilter({ properties: { matter: { nodeId: 12, transport: 'thread' } } }, 'thread'),
    true
  );
});

test('bulkUpdateDeviceExposuresBySource enables every matching source device', async (t) => {
  const originalFind = AlexaExposure.find;
  const originalSave = AlexaExposure.prototype.save;
  const service = new AlexaProjectionService();
  const existingExposure = new AlexaExposure({
    entityType: 'device',
    entityId: 'device-zigbee-1',
    enabled: false
  });
  const savedExposures = new Map([[existingExposure.entityId, existingExposure]]);
  const devices = [
    {
      _id: 'device-zigbee-1',
      name: 'Zigbee Lamp',
      type: 'light',
      room: 'Living Room',
      status: true,
      brightness: 80,
      isOnline: true,
      properties: { source: 'homebrain-zigbee' }
    },
    {
      _id: 'device-zigbee-2',
      name: 'Zigbee Outlet',
      type: 'switch',
      room: 'Office',
      status: false,
      isOnline: true,
      properties: { homebrainDirect: { protocol: 'zigbee' } }
    },
    {
      _id: 'device-zwave-1',
      name: 'Z-Wave Switch',
      type: 'switch',
      room: 'Hall',
      status: true,
      isOnline: true,
      properties: { source: 'homebrain-zwave' }
    }
  ];

  t.after(() => {
    AlexaExposure.find = originalFind;
    AlexaExposure.prototype.save = originalSave;
  });

  AlexaExposure.find = async (query = {}) => {
    const ids = new Set(Array.isArray(query.entityId?.$in) ? query.entityId.$in : []);
    return Array.from(savedExposures.values()).filter((exposure) => (
      exposure.entityType === query.entityType && ids.has(exposure.entityId)
    ));
  };
  AlexaExposure.prototype.save = async function saveStub() {
    savedExposures.set(this.entityId, this);
    return this;
  };
  service.loadContext = async () => ({
    hubId: 'test-hub',
    devices,
    devicesById: new Map(devices.map((device) => [device._id, device])),
    groups: [],
    groupsById: new Map(),
    groupsByNormalizedName: new Map(),
    scenes: [],
    scenesById: new Map(),
    workflows: [],
    workflowsById: new Map(),
    exposures: Array.from(savedExposures.values()).map((exposure) => exposure.toObject())
  });
  service.listExposureSummaries = async () => Array.from(savedExposures.values()).map((exposure) => ({
    entityType: exposure.entityType,
    entityId: exposure.entityId,
    enabled: exposure.enabled,
    validationWarnings: exposure.validationWarnings,
    validationErrors: exposure.validationErrors
  }));

  const result = await service.bulkUpdateDeviceExposuresBySource('zigbee');

  assert.equal(result.source, 'homebrain-zigbee');
  assert.equal(result.sourceLabel, 'Zigbee');
  assert.equal(result.matchedCount, 2);
  assert.equal(result.createdCount, 1);
  assert.equal(result.changedCount, 2);
  assert.equal(result.unchangedCount, 0);
  assert.equal(result.failedCount, 0);
  assert.equal(result.exposures.length, 2);
  assert.equal(savedExposures.get('device-zigbee-1').enabled, true);
  assert.equal(savedExposures.get('device-zigbee-2').enabled, true);
  assert.equal(savedExposures.has('device-zwave-1'), false);
});
