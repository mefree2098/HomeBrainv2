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

function installLockContext(t, { device = nativeLockDevice(), accessControl = makeAccessControl() } = {}) {
  const service = new DirectRadioService();
  const updateCalls = [];
  const published = [];
  const node = {
    id: 9,
    accessControl,
    commandClasses: {}
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
