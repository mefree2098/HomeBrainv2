const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Settings = require('../models/Settings');
const DeviceCommandClaim = require('../models/DeviceCommandClaim');
const eventStreamService = require('../services/eventStreamService');
const coordinatorService = require('../services/deviceCommandCoordinatorService');

function makeClaimDocument(payload) {
  return {
    ...payload,
    toObject() {
      return { ...payload };
    }
  };
}

function createInMemoryClaimStore() {
  let claim = null;

  const matchesDevice = (query = {}) => !query.deviceId || String(query.deviceId) === String(claim?.deviceId);
  const conditionMatches = (condition = {}) => {
    if (!condition || Object.keys(condition).length === 0) {
      return true;
    }
    if (condition.expiresAt?.$lte) {
      return new Date(claim.expiresAt).getTime() <= new Date(condition.expiresAt.$lte).getTime();
    }
    if (condition.priority?.$lt !== undefined) {
      return Number(claim.priority) < Number(condition.priority.$lt);
    }
    if (condition.priority !== undefined) {
      return Number(claim.priority) === Number(condition.priority);
    }
    return false;
  };

  return {
    get claim() {
      return claim;
    },
    set claim(value) {
      claim = value;
    },
    findOne(query = {}) {
      return {
        lean: async () => (claim && matchesDevice(query) ? { ...claim } : null)
      };
    },
    async create(payload) {
      if (claim && String(claim.deviceId) === String(payload.deviceId)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      claim = { ...payload };
      return makeClaimDocument(claim);
    },
    async findOneAndUpdate(query = {}, update = {}) {
      if (!claim || !matchesDevice(query)) {
        return null;
      }
      const conditions = Array.isArray(query.$or) ? query.$or : [];
      if (conditions.length > 0 && !conditions.some((condition) => conditionMatches(condition))) {
        return null;
      }
      claim = {
        ...claim,
        ...(update.$set || {})
      };
      return makeClaimDocument(claim);
    },
    async findOneAndDelete(query = {}) {
      if (!claim || !matchesDevice(query)) {
        return null;
      }
      const deleted = claim;
      claim = null;
      return makeClaimDocument(deleted);
    },
    async deleteMany() {
      const deletedCount = claim ? 1 : 0;
      claim = null;
      return { deletedCount };
    }
  };
}

test('device command coordinator blocks lower priority commands and accepts higher priority overrides', async (t) => {
  const originalReadyState = mongoose.connection.readyState;
  const originalGetSettings = Settings.getSettings;
  const originalFindOne = DeviceCommandClaim.findOne;
  const originalCreate = DeviceCommandClaim.create;
  const originalFindOneAndUpdate = DeviceCommandClaim.findOneAndUpdate;
  const originalFindOneAndDelete = DeviceCommandClaim.findOneAndDelete;
  const originalDeleteMany = DeviceCommandClaim.deleteMany;
  const originalPublishSafe = eventStreamService.publishSafe;
  const store = createInMemoryClaimStore();

  t.after(() => {
    Object.defineProperty(mongoose.connection, 'readyState', {
      value: originalReadyState,
      configurable: true
    });
    Settings.getSettings = originalGetSettings;
    DeviceCommandClaim.findOne = originalFindOne;
    DeviceCommandClaim.create = originalCreate;
    DeviceCommandClaim.findOneAndUpdate = originalFindOneAndUpdate;
    DeviceCommandClaim.findOneAndDelete = originalFindOneAndDelete;
    DeviceCommandClaim.deleteMany = originalDeleteMany;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  Object.defineProperty(mongoose.connection, 'readyState', {
    value: 1,
    configurable: true
  });
  Settings.getSettings = async () => ({
    deviceCommandCoordinator: coordinatorService.defaultPolicy,
    async save() {}
  });
  DeviceCommandClaim.findOne = store.findOne.bind(store);
  DeviceCommandClaim.create = store.create.bind(store);
  DeviceCommandClaim.findOneAndUpdate = store.findOneAndUpdate.bind(store);
  DeviceCommandClaim.findOneAndDelete = store.findOneAndDelete.bind(store);
  DeviceCommandClaim.deleteMany = store.deleteMany.bind(store);
  eventStreamService.publishSafe = async () => {};

  const deviceId = new mongoose.Types.ObjectId().toString();
  const device = {
    _id: deviceId,
    name: 'Laundry Fan'
  };

  const workflowAdmission = await coordinatorService.admitCommand({
    device,
    action: 'turnoff',
    value: null,
    metadata: {
      source: 'workflow',
      workflowPriority: 5,
      reason: 'Routine humidity timeout'
    }
  });
  assert.equal(workflowAdmission.accepted, true);
  assert.equal(workflowAdmission.command.source, 'workflow');
  assert.equal(workflowAdmission.command.priority, 45);

  await assert.rejects(
    coordinatorService.admitCommand({
      device,
      action: 'turnon',
      value: null,
      metadata: {
        source: 'automation',
        reason: 'Lower priority automation'
      }
    }),
    (error) => {
      assert.equal(error.code, 'DEVICE_COMMAND_BLOCKED');
      assert.equal(error.status, 409);
      assert.equal(error.details.active.source, 'workflow');
      return true;
    }
  );

  const manualAdmission = await coordinatorService.admitCommand({
    device,
    action: 'turnon',
    value: null,
    metadata: {
      source: 'manual',
      reason: 'User override'
    }
  });

  assert.equal(manualAdmission.accepted, true);
  assert.equal(manualAdmission.command.source, 'manual');
  assert.equal(manualAdmission.replaced.source, 'workflow');
  assert.equal(store.claim.source, 'manual');

  const chatAdmission = await coordinatorService.admitCommand({
    device,
    action: 'turnoff',
    value: null,
    metadata: {
      source: 'chat',
      reason: 'User chat command'
    }
  });
  assert.equal(chatAdmission.accepted, true);
  assert.equal(chatAdmission.command.source, 'manual');
  assert.equal(store.claim.source, 'manual');
});

test('device command coordinator can hold equal priority commands when configured', async (t) => {
  const originalReadyState = mongoose.connection.readyState;
  const originalGetSettings = Settings.getSettings;
  const originalFindOne = DeviceCommandClaim.findOne;
  const originalCreate = DeviceCommandClaim.create;
  const originalFindOneAndUpdate = DeviceCommandClaim.findOneAndUpdate;
  const originalPublishSafe = eventStreamService.publishSafe;
  const store = createInMemoryClaimStore();
  const policy = coordinatorService.sanitizePolicy({
    ...coordinatorService.defaultPolicy,
    samePriorityMode: 'block'
  });

  t.after(() => {
    Object.defineProperty(mongoose.connection, 'readyState', {
      value: originalReadyState,
      configurable: true
    });
    Settings.getSettings = originalGetSettings;
    DeviceCommandClaim.findOne = originalFindOne;
    DeviceCommandClaim.create = originalCreate;
    DeviceCommandClaim.findOneAndUpdate = originalFindOneAndUpdate;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  Object.defineProperty(mongoose.connection, 'readyState', {
    value: 1,
    configurable: true
  });
  Settings.getSettings = async () => ({
    deviceCommandCoordinator: policy,
    async save() {}
  });
  DeviceCommandClaim.findOne = store.findOne.bind(store);
  DeviceCommandClaim.create = store.create.bind(store);
  DeviceCommandClaim.findOneAndUpdate = store.findOneAndUpdate.bind(store);
  eventStreamService.publishSafe = async () => {};

  const deviceId = new mongoose.Types.ObjectId().toString();
  const device = {
    _id: deviceId,
    name: 'Kitchen Light'
  };

  await coordinatorService.admitCommand({
    device,
    action: 'turnon',
    value: null,
    metadata: { source: 'manual', reason: 'First manual command' }
  });

  await assert.rejects(
    coordinatorService.admitCommand({
      device,
      action: 'turnoff',
      value: null,
      metadata: { source: 'manual', reason: 'Second manual command' }
    }),
    (error) => {
      assert.equal(error.code, 'DEVICE_COMMAND_BLOCKED');
      assert.equal(error.details.active.source, 'manual');
      return true;
    }
  );

  assert.equal(store.claim.action, 'turnon');
});
