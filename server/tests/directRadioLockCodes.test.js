const test = require('node:test');
const assert = require('node:assert/strict');
const zwave = require('zwave-js');

const Device = require('../models/Device');
const directRadioService = require('../services/directRadioService');

const DirectRadioService = directRadioService.DirectRadioService;

function nativeLockDevice(overrides = {}) {
  return {
    _id: 'native-lock-1',
    name: 'Front Deadbolt',
    type: 'lock',
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 9
      },
      lockCodes: {
        assignments: {
          4: {
            name: 'Guest',
            enabled: true,
            source: 'homebrain',
            updatedAt: '2026-05-20T12:00:00.000Z',
            updatedBy: 'admin@example.com'
          }
        }
      }
    },
    ...overrides
  };
}

function makeAccessControl(overrides = {}) {
  const calls = {
    setCredential: [],
    setUser: [],
    deleteUser: []
  };
  const accessControl = {
    getUserCapabilitiesCached: () => ({
      maxUsers: 30,
      maxUserNameLength: 0,
      supportedUserTypes: [zwave.UserCredentialUserType.General],
      supportedCredentialRules: []
    }),
    getCredentialCapabilitiesCached: () => ({
      supportedCredentialTypes: new Map([
        [zwave.UserCredentialType.PINCode, {
          numberOfCredentialSlots: 30,
          minCredentialLength: 4,
          maxCredentialLength: 8
        }]
      ]),
      supportsAdminCode: false,
      supportsAdminCodeDeactivation: false,
      supportsCredentialAssignment: false
    }),
    getUsersCached: () => [
      {
        userId: 4,
        active: true,
        userType: zwave.UserCredentialUserType.General
      }
    ],
    getUsers: async () => [
      {
        userId: 4,
        active: true,
        userType: zwave.UserCredentialUserType.General
      }
    ],
    setCredential: async (...args) => {
      calls.setCredential.push(args);
      return zwave.SetCredentialResult.OK;
    },
    setUser: async (...args) => {
      calls.setUser.push(args);
      return zwave.SetUserResult.OK;
    },
    deleteUser: async (...args) => {
      calls.deleteUser.push(args);
      return zwave.SetUserResult.OK;
    },
    ...overrides
  };
  accessControl.calls = calls;
  return accessControl;
}

function valueKey(valueId) {
  return JSON.stringify(valueId);
}

function makeZWaveValueDB(entries = []) {
  const values = new Map(entries.map(([valueId, value]) => [valueKey(valueId), { valueId, value }]));
  return {
    hasValue: (valueId) => values.has(valueKey(valueId)),
    getValue: (valueId) => values.get(valueKey(valueId))?.value,
    findValues: (predicate) => Array.from(values.values())
      .filter((entry) => predicate(entry.valueId))
      .map((entry) => ({ ...entry.valueId, value: entry.value })),
    getMetadata: () => null
  };
}

function makeUserCodeApi(overrides = {}) {
  const calls = {
    getUsersCount: [],
    get: [],
    set: [],
    clear: []
  };
  const users = new Map(Object.entries(overrides.users || {
    4: {
      userIdStatus: zwave.UserIDStatus.Enabled,
      userCode: '1234'
    }
  }).map(([slot, user]) => [Number(slot), user]));

  const userCodeApi = {
    getUsersCount: async () => {
      calls.getUsersCount.push([]);
      return 30;
    },
    get: async (userId) => {
      calls.get.push([userId]);
      return users.get(Number(userId)) || {
        userIdStatus: zwave.UserIDStatus.Available
      };
    },
    set: async (userId, userIdStatus, userCode) => {
      calls.set.push([userId, userIdStatus, userCode]);
      users.set(Number(userId), { userIdStatus, userCode });
      return undefined;
    },
    clear: async (userId) => {
      calls.clear.push([userId]);
      users.delete(Number(userId));
      return undefined;
    },
    ...overrides
  };
  userCodeApi.calls = calls;
  userCodeApi.users = users;
  return userCodeApi;
}

function installLockContext(t, { device = nativeLockDevice(), accessControl = makeAccessControl(), userCodeApi = null, nodeOverrides = {} } = {}) {
  const service = new DirectRadioService();
  const updateCalls = [];
  const published = [];
  const userCodeValueDB = userCodeApi
    ? makeZWaveValueDB([
      [zwave.UserCodeCCValues.supportedUsers.id, 30],
      [zwave.UserCodeCCValues.userIdStatus(4).id, zwave.UserIDStatus.Enabled]
    ])
    : null;
  const node = {
    id: 9,
    accessControl,
    commandClasses: userCodeApi ? { 'User Code': userCodeApi } : {},
    ...(userCodeValueDB ? { valueDB: userCodeValueDB } : {}),
    ...nodeOverrides
  };

  const originalFindById = Device.findById;
  const originalUpdateOne = Device.updateOne;

  Device.findById = async (deviceId) => (deviceId === device._id ? device : null);
  Device.updateOne = async (filter, update) => {
    updateCalls.push({ filter, update });
    return { matchedCount: 1, modifiedCount: 1 };
  };
  service.start = async () => {
    service.started = true;
  };
  service.getDirectNodeForDevice = () => node;
  service.publishZWaveLockCodeEvent = async (_node, event) => {
    published.push(event);
    return { success: true };
  };

  t.after(() => {
    Device.findById = originalFindById;
    Device.updateOne = originalUpdateOne;
  });

  return {
    service,
    node,
    accessControl,
    updateCalls,
    published
  };
}

test('native Z-Wave lock normalization exposes battery level for display and automations', () => {
  const service = new DirectRadioService();
  const values = new Map([
    [zwave.DoorLockCCValues.currentMode.id, zwave.DoorLockMode.Secured],
    [zwave.BatteryCCValues.level.id, 72]
  ]);
  const node = {
    id: 9,
    name: 'Kwikset 916',
    status: 4,
    isListening: false,
    isFrequentListening: false,
    manufacturerId: 144,
    productType: 3,
    productId: 8,
    productLabel: 'SmartCode 916',
    deviceConfig: {
      manufacturer: 'Kwikset',
      label: 'SmartCode 916'
    },
    valueDB: {
      hasValue: (id) => values.has(id),
      getValue: (id) => values.get(id),
      findValues: () => [],
      getMetadata: () => null
    }
  };

  const normalized = service.normalizeZWaveNode(node, 'test');

  assert.equal(normalized.update.type, 'lock');
  assert.equal(normalized.update.properties.homeBrainBatteryLevel, 72);
  assert.equal(normalized.update.properties.batteryLevel, 72);
  assert.equal(normalized.update.properties.supportsBattery, true);
  assert.ok(normalized.update.properties.directRadioFeatures.includes('battery'));
});

test('native Z-Wave lock normalization treats 0 battery as awaiting a real report', () => {
  const service = new DirectRadioService();
  const values = new Map([
    [zwave.DoorLockCCValues.currentMode.id, zwave.DoorLockMode.Secured],
    [zwave.BatteryCCValues.level.id, 0]
  ]);
  const node = {
    id: 9,
    name: 'Kwikset 916',
    status: 4,
    manufacturerId: 144,
    productType: 1,
    productId: 1,
    productLabel: 'SmartCode 916',
    valueDB: {
      hasValue: (id) => values.has(id),
      getValue: (id) => values.get(id),
      findValues: () => [],
      getMetadata: () => null
    }
  };

  const normalized = service.normalizeZWaveNode(node, 'test');

  assert.equal(normalized.update.type, 'lock');
  assert.equal(normalized.update.properties.homeBrainBatteryLevel, null);
  assert.equal(normalized.update.properties.batteryLevel, null);
  assert.equal(normalized.update.properties.homeBrainBatteryReportPending, true);
  assert.equal(normalized.update.properties.directRadioState, undefined);
  assert.equal(normalized.update.properties.supportsBattery, true);
});

test('native Z-Wave lock normalization maps Z-Wave low-battery sentinel to alertable telemetry', () => {
  const service = new DirectRadioService();
  const values = new Map([
    [zwave.DoorLockCCValues.currentMode.id, zwave.DoorLockMode.Secured],
    [zwave.BatteryCCValues.level.id, 255]
  ]);
  const node = {
    id: 9,
    name: 'Kwikset 916',
    status: 4,
    manufacturerId: 144,
    productType: 1,
    productId: 1,
    productLabel: 'SmartCode 916',
    valueDB: {
      hasValue: (id) => values.has(id),
      getValue: (id) => values.get(id),
      findValues: () => [],
      getMetadata: () => null
    }
  };

  const normalized = service.normalizeZWaveNode(node, 'test');

  assert.equal(normalized.update.properties.homeBrainBatteryLevel, 1);
  assert.equal(normalized.update.properties.batteryLevel, 1);
  assert.equal(normalized.update.properties.homeBrainBatteryLow, true);
  assert.equal(normalized.update.properties.directRadioState.batteryLevel, 1);
  assert.equal(normalized.update.properties.directRadioState.batteryLow, true);
});

test('native Z-Wave lock normalization exposes legacy S0 User Code support', () => {
  const service = new DirectRadioService();
  const valueDB = makeZWaveValueDB([
    [zwave.DoorLockCCValues.currentMode.id, zwave.DoorLockMode.Secured],
    [zwave.UserCodeCCValues.supportedUsers.id, 30]
  ]);
  const node = {
    id: 9,
    name: 'Kwikset 916',
    status: 4,
    manufacturerId: 144,
    productType: 1,
    productId: 1,
    productLabel: 'SmartCode 916',
    commandClasses: {
      'User Code': makeUserCodeApi()
    },
    valueDB
  };

  const normalized = service.normalizeZWaveNode(node, 'test');

  assert.equal(normalized.update.type, 'lock');
  assert.ok(normalized.update.properties.directRadioFeatures.includes('lockCodes'));
  assert.equal(normalized.update.properties.supportsLockCodes, true);
});

test('direct Z-Wave lock merge drops stale SmartThings lock-code support and battery state', () => {
  const merged = directRadioService._test.mergeDirectDeviceUpdateForExisting(
    nativeLockDevice({
      properties: {
        source: 'homebrain-zwave',
        smartThingsBatteryLevel: 0,
        directRadioFeatures: ['battery', 'lock', 'lockCodes'],
        directRadioState: { batteryLevel: 0 },
        supportsLockCodes: true,
        homebrainDirect: { protocol: 'zwave', nodeId: 9 },
        lockCodes: { assignments: { 1: { name: 'Guest' } } }
      }
    }),
    {
      type: 'lock',
      properties: {
        source: 'homebrain-zwave',
        homebrainDirect: { protocol: 'zwave', nodeId: 9 },
        directRadioFeatures: ['battery', 'lock'],
        homeBrainBatteryLevel: null,
        batteryLevel: null,
        homeBrainBatteryReportPending: true
      }
    }
  );

  assert.ok(!merged.properties.directRadioFeatures.includes('lockCodes'));
  assert.equal(merged.properties.supportsLockCodes, false);
  assert.equal(merged.properties.lockCodes.supported, false);
  assert.equal(merged.properties.directRadioState, undefined);
});

test('Z-Wave lock commands remap legacy power actions to Door Lock CC targets', async () => {
  const service = new DirectRadioService();
  const writes = [];
  service.getDirectNodeForDevice = () => ({ id: 9, ready: true, status: 4 });
  service.setZWaveValue = async (_node, valueDef, value) => {
    writes.push({ valueId: valueDef.id, value });
  };

  await service.controlZWaveDevice({
    _id: 'native-lock-1',
    name: 'Front Deadbolt',
    type: 'lock',
    status: false,
    properties: { homebrainDirect: { nodeId: 9 } }
  }, 'turnon', true, {});

  assert.equal(writes.length, 1);
  assert.equal(writes[0].valueId, zwave.DoorLockCCValues.targetMode.id);
  assert.equal(writes[0].value, zwave.DoorLockMode.Secured);
});

test('native Z-Wave lock PIN state redacts codes and preserves HomeBrain labels', async (t) => {
  const { service } = installLockContext(t);

  const state = await service.getLockCodeState('native-lock-1');

  assert.equal(state.native, true);
  assert.equal(state.nodeId, 9);
  assert.equal(state.capabilities.minPinLength, 4);
  assert.equal(state.capabilities.maxPinLength, 8);
  assert.equal(state.slots.length, 1);
  assert.equal(state.slots[0].slot, 4);
  assert.equal(state.slots[0].name, 'Guest');
  assert.equal(state.slots[0].source, 'homebrain');
  assert.equal(Object.prototype.hasOwnProperty.call(state.slots[0], 'pin'), false);
  assert.ok(state.availableSlots.includes(1));
  assert.ok(!state.availableSlots.includes(4));
});

test('native Z-Wave lock PIN state uses endpoint access-control APIs when node accessControl is absent', async (t) => {
  const accessControl = makeAccessControl();
  const { service } = installLockContext(t, {
    accessControl: null,
    nodeOverrides: {
      getEndpoint: (index) => (index === 0 ? { accessControl } : null)
    }
  });

  const state = await service.getLockCodeState('native-lock-1');

  assert.equal(state.native, true);
  assert.equal(state.slots[0].slot, 4);
});

test('native Z-Wave lock PIN state uses legacy S0 User Code when access-control APIs are absent', async (t) => {
  const userCodeApi = makeUserCodeApi();
  const { service } = installLockContext(t, {
    accessControl: null,
    userCodeApi
  });

  const state = await service.getLockCodeState('native-lock-1');

  assert.equal(state.native, true);
  assert.equal(state.capabilities.backend, 'userCode');
  assert.equal(state.capabilities.maxSlots, 30);
  assert.equal(state.capabilities.minPinLength, 4);
  assert.equal(state.capabilities.maxPinLength, 10);
  assert.equal(state.slots.length, 1);
  assert.equal(state.slots[0].slot, 4);
  assert.equal(Object.prototype.hasOwnProperty.call(state.slots[0], 'pin'), false);
  assert.ok(userCodeApi.calls.get.length > 0);
});

test('native Z-Wave lock PIN set writes credential slot and records assignment metadata', async (t) => {
  const accessControl = makeAccessControl({
    getUsersCached: () => [],
    getUsers: async () => []
  });
  const { service, updateCalls, published } = installLockContext(t, { accessControl });

  await service.setLockCode('native-lock-1', {
    slot: 7,
    name: 'Cleaner',
    pin: '5824',
    enabled: true
  }, {
    actor: 'admin@example.com'
  });

  assert.deepEqual(accessControl.calls.setCredential[0], [
    7,
    zwave.UserCredentialType.PINCode,
    7,
    '5824'
  ]);
  assert.equal(accessControl.calls.setUser[0][0], 7);
  assert.equal(accessControl.calls.setUser[0][1].active, true);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].update.$set['properties.lockCodes.assignments.7'].name, 'Cleaner');
  assert.equal(updateCalls[0].update.$set['properties.lockCodes.assignments.7'].updatedBy, 'admin@example.com');
  assert.equal(published[0].type, 'lock_code.set');
  assert.equal(published[0].userId, 7);
});

test('native Z-Wave lock PIN set writes legacy S0 User Code slots', async (t) => {
  const userCodeApi = makeUserCodeApi({
    users: {}
  });
  const { service, updateCalls, published } = installLockContext(t, {
    accessControl: null,
    userCodeApi
  });

  await service.setLockCode('native-lock-1', {
    slot: 7,
    name: 'Cleaner',
    pin: '5824',
    enabled: true
  }, {
    actor: 'admin@example.com'
  });

  assert.deepEqual(userCodeApi.calls.set[0], [
    7,
    zwave.UserIDStatus.Enabled,
    '5824'
  ]);
  assert.equal(updateCalls[0].update.$set['properties.lockCodes.assignments.7'].name, 'Cleaner');
  assert.equal(published[0].type, 'lock_code.set');
  assert.equal(published[0].userId, 7);
});

test('native Z-Wave lock PIN set rejects invalid PIN values before touching the lock', async (t) => {
  const accessControl = makeAccessControl();
  const { service } = installLockContext(t, { accessControl });

  await assert.rejects(
    service.setLockCode('native-lock-1', {
      slot: 4,
      name: 'Guest',
      pin: '12ab'
    }),
    /PIN must be 4-8 digits/
  );
  assert.equal(accessControl.calls.setCredential.length, 0);
});

test('native Z-Wave lock PIN delete clears the user slot and assignment metadata', async (t) => {
  const { service, accessControl, updateCalls, published } = installLockContext(t);

  await service.deleteLockCode('native-lock-1', 4, {
    actor: 'admin@example.com'
  });

  assert.deepEqual(accessControl.calls.deleteUser[0], [4]);
  assert.equal(updateCalls[0].update.$unset['properties.lockCodes.assignments.4'], '');
  assert.equal(updateCalls[0].update.$set['properties.lockCodes.lastManagedBy'], 'admin@example.com');
  assert.equal(published[0].type, 'lock_code.deleted');
  assert.equal(published[0].userId, 4);
});

test('native Z-Wave lock PIN delete clears legacy S0 User Code slots', async (t) => {
  const userCodeApi = makeUserCodeApi();
  const { service, updateCalls, published } = installLockContext(t, {
    accessControl: null,
    userCodeApi
  });

  await service.deleteLockCode('native-lock-1', 4, {
    actor: 'admin@example.com'
  });

  assert.deepEqual(userCodeApi.calls.clear[0], [4]);
  assert.equal(updateCalls[0].update.$unset['properties.lockCodes.assignments.4'], '');
  assert.equal(published[0].type, 'lock_code.deleted');
  assert.equal(published[0].userId, 4);
});

test('SmartThings-backed locks must be migrated before native PIN management', async (t) => {
  const { service } = installLockContext(t, {
    device: nativeLockDevice({
      _id: 'smartthings-lock-1',
      properties: {
        source: 'smartthings',
        smartThingsDeviceId: 'st-lock-1',
        smartThingsDeviceNetworkType: 'ZWAVE'
      }
    })
  });

  await assert.rejects(
    service.getLockCodeState('smartthings-lock-1'),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /Migrate this SmartThings lock to HomeBrain Z-Wave first/);
      return true;
    }
  );
});

test('native Z-Wave lock audit merges HomeBrain events and lock hardware logs newest first', async (t) => {
  const { service } = installLockContext(t);
  service.readHomeBrainLockAudit = async () => [
    {
      id: 'hb-1',
      source: 'homebrain',
      type: 'lock_code.used',
      action: 'unlock',
      slot: 4,
      codeName: 'Guest',
      createdAt: '2026-05-20T12:00:00.000Z'
    }
  ];
  service.readZWaveLockAuditFromDevice = async () => [
    {
      id: 'lock-1',
      source: 'lock',
      type: 'door_lock_log',
      action: 'unlock',
      slot: 7,
      codeName: 'Cleaner',
      createdAt: '2026-05-20T12:05:00.000Z'
    }
  ];

  const audit = await service.getLockCodeAudit('native-lock-1');

  assert.equal(audit.events.length, 2);
  assert.equal(audit.events[0].id, 'lock-1');
  assert.equal(audit.events[1].id, 'hb-1');
});
