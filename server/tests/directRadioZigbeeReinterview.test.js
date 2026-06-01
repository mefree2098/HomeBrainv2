'use strict';

// Phase 3 coverage: the Zigbee re-interview path (the contact-sensor / IAS Zone
// repair flow) validates input, requires a ready coordinator, forces a full
// re-interview, and gives wake-the-sensor guidance on failure.

const test = require('node:test');
const assert = require('node:assert');

const directRadioService = require('../services/directRadioService');

function stubZigbee(t, { controller = null, started = false } = {}) {
  const originalStart = directRadioService.start;
  const originalHandle = directRadioService.handleZigbeeDeviceChanged;
  const originalController = directRadioService.zigbee.controller;
  const originalStarted = directRadioService.zigbee.started;
  const originalIasRepairAttempts = directRadioService.zigbee.iasRepairAttempts;
  t.after(() => {
    directRadioService.start = originalStart;
    directRadioService.handleZigbeeDeviceChanged = originalHandle;
    directRadioService.zigbee.controller = originalController;
    directRadioService.zigbee.started = originalStarted;
    directRadioService.zigbee.iasRepairAttempts = originalIasRepairAttempts;
  });
  directRadioService.start = async () => {};
  directRadioService.handleZigbeeDeviceChanged = async () => {};
  directRadioService.zigbee.controller = controller;
  directRadioService.zigbee.started = started;
  directRadioService.zigbee.iasRepairAttempts = new Map();
}

test('reinterviewZigbeeDevice rejects an empty IEEE address', async () => {
  await assert.rejects(
    () => directRadioService.reinterviewZigbeeDevice(''),
    (err) => err.status === 400
  );
});

test('reinterviewZigbeeDevice errors when the coordinator is not ready', async (t) => {
  stubZigbee(t, { controller: null, started: false });
  await assert.rejects(
    () => directRadioService.reinterviewZigbeeDevice('0x00158d0001'),
    (err) => err.status === 503
  );
});

test('reinterviewZigbeeDevice 404s when no device matches the address', async (t) => {
  stubZigbee(t, { controller: { getDeviceByIeeeAddr: () => null }, started: true });
  await assert.rejects(
    () => directRadioService.reinterviewZigbeeDevice('0x00158d0001'),
    (err) => err.status === 404
  );
});

test('reinterviewZigbeeDevice forces a full re-interview and returns a result', async (t) => {
  let interviewArg = 'unset';
  const fakeDevice = {
    modelID: 'MCT-340 SMA',
    type: 'EndDevice',
    interviewCompleted: true,
    endpoints: [],
    interview: async (ignoreCache) => { interviewArg = ignoreCache; }
  };
  stubZigbee(t, {
    controller: { getDeviceByIeeeAddr: () => fakeDevice, getDevicesByType: () => [] },
    started: true
  });

  const result = await directRadioService.reinterviewZigbeeDevice('0x00158d0001');
  assert.strictEqual(interviewArg, true, 'forced a full re-interview (ignoreCache=true)');
  assert.strictEqual(result.ieeeAddr, '0x00158d0001');
  assert.strictEqual(result.interviewCompleted, true);
  assert.strictEqual(result.isSleepy, true, 'EndDevice flagged as sleepy');
  assert.strictEqual(result.iasZone, null, 'no IAS endpoints -> null enrollment info');
  assert.match(result.message, /re-ran the Zigbee interview/);
});

test('reinterviewZigbeeDevice surfaces wake-the-sensor guidance on a sleepy-device failure', async (t) => {
  const fakeDevice = {
    type: 'EndDevice',
    endpoints: [],
    interview: async () => { throw new Error('Interview failed because of failed IAS enroll'); }
  };
  stubZigbee(t, { controller: { getDeviceByIeeeAddr: () => fakeDevice, getDevicesByType: () => [] }, started: true });

  await assert.rejects(
    () => directRadioService.reinterviewZigbeeDevice('0x00158d0001'),
    (err) => err.status === 502 && /Wake the sensor/.test(err.message)
  );
});

test('reinterviewZigbeeDevice repairs IAS enrollment directly for sleepy sensors with known endpoints', async (t) => {
  let interviewCalled = false;
  let handleReason = null;
  const coordinatorIeee = '0x00124b003a12562a';
  const iasAttributes = {
    iasCieAddr: '0xffffffffffffffff',
    zoneState: 0,
    zoneId: 23
  };
  const endpoint = {
    ID: 1,
    inputClusters: [1280],
    supportsInputCluster(cluster) {
      return cluster === 'ssIasZone' || cluster === 1280;
    },
    getClusterAttributeValue(cluster, attribute) {
      if (cluster === 'ssIasZone') {
        return iasAttributes[attribute];
      }
      return undefined;
    },
    saveClusterAttributeKeyValue(cluster, attributes) {
      assert.equal(cluster, 'ssIasZone');
      Object.assign(iasAttributes, attributes);
    },
    async read(cluster, attributes) {
      assert.equal(cluster, 'ssIasZone');
      assert.ok(attributes.includes('iasCieAddr'));
      return { ...iasAttributes };
    },
    async write(cluster, attributes) {
      assert.equal(cluster, 'ssIasZone');
      iasAttributes.iasCieAddr = attributes.iasCieAddr;
    },
    async command(cluster, command, payload) {
      assert.equal(cluster, 'ssIasZone');
      assert.equal(command, 'enrollRsp');
      assert.equal(payload.enrollrspcode, 0);
      iasAttributes.zoneState = 1;
    }
  };
  const fakeDevice = {
    ieeeAddr: '0x000d6f00057c378b',
    modelID: '3321-S',
    manufacturerName: 'CentraLite',
    type: 'EndDevice',
    powerSource: 'Battery',
    interviewCompleted: true,
    endpoints: [endpoint],
    interview: async () => { interviewCalled = true; }
  };
  stubZigbee(t, {
    controller: {
      getDeviceByIeeeAddr: () => fakeDevice,
      getDevicesByType: () => [{ ieeeAddr: coordinatorIeee, endpoints: [{ ID: 1 }] }]
    },
    started: true
  });
  directRadioService.handleZigbeeDeviceChanged = async (_device, reason) => {
    handleReason = reason;
  };

  const result = await directRadioService.reinterviewZigbeeDevice('0x000d6f00057c378b');

  assert.equal(interviewCalled, false, 'known sleepy IAS devices use targeted repair instead of full interview');
  assert.equal(handleReason, 'reinterview');
  assert.equal(result.iasRepair.ready, true);
  assert.equal(result.iasZone.enrolled, true);
  assert.equal(result.iasZone.cieMatchesCoordinator, true);
  assert.equal(iasAttributes.iasCieAddr, coordinatorIeee);
  assert.match(result.message, /repaired IAS Zone enrollment/);
});

test('forgetZigbeeDevice force-removes a stale coordinator entry when leave fails', async (t) => {
  let removeFromNetworkCalled = false;
  let removeFromDatabaseCalled = false;
  const fakeDevice = {
    ieeeAddr: '0x00158d0001',
    networkAddress: 1234,
    modelID: null,
    manufacturerName: null,
    interviewCompleted: false,
    endpoints: [],
    removeFromNetwork: async () => {
      removeFromNetworkCalled = true;
      throw new Error('no response from sleepy device');
    },
    removeFromDatabase: () => {
      removeFromDatabaseCalled = true;
    }
  };
  stubZigbee(t, {
    controller: { getDeviceByIeeeAddr: () => fakeDevice },
    started: true
  });

  const result = await directRadioService.forgetZigbeeDevice('0x00158d0001', {
    force: true,
    source: 'test'
  });

  assert.strictEqual(removeFromNetworkCalled, true);
  assert.strictEqual(removeFromDatabaseCalled, true);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.leaveSucceeded, false);
  assert.strictEqual(result.databaseRemoved, true);
  assert.strictEqual(result.forced, true);
  assert.match(result.error, /no response/);
});

test('forgetZigbeeDevice reports an already-absent coordinator entry as success', async (t) => {
  stubZigbee(t, {
    controller: { getDeviceByIeeeAddr: () => null },
    started: true
  });

  const result = await directRadioService.forgetZigbeeDevice('0x00158d0001');
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.databaseRemoved, false);
  assert.match(result.message, /No Zigbee device/);
});

test('readZigbeeIasEnrollment returns null on missing/invalid devices', () => {
  assert.strictEqual(directRadioService.readZigbeeIasEnrollment(null), null);
  assert.strictEqual(directRadioService.readZigbeeIasEnrollment({}), null);
  assert.strictEqual(directRadioService.readZigbeeIasEnrollment({ endpoints: [] }), null);
});
