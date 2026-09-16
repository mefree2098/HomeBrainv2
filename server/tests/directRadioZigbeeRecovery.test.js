const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const methods = require('../services/directRadioZigbee');

test('protocol reconnect queries listening devices and marks failed reads stale without waiting on sleepers', async (t) => {
  const core = require('../services/directRadioCore');
  const Device = require('../models/Device');
  const deviceService = require('../services/deviceService');
  const original = { find: Device.find, update: Device.updateOne, refresh: deviceService.refreshDirectRadioDeviceState };
  t.after(() => { Device.find = original.find; Device.updateOne = original.update; deviceService.refreshDirectRadioDeviceState = original.refresh; });
  const queried = [], stale = [];
  Device.find = () => ({ lean: async () => [{ _id: 'light', type: 'light' }, { _id: 'sleeping-lock', type: 'lock' }, { _id: 'offline-switch', type: 'switch' }] });
  Device.updateOne = async (filter, update) => stale.push([filter._id, update['properties.homebrainDirect.stateStale']]);
  deviceService.refreshDirectRadioDeviceState = async (device, options) => {
    assert.equal(options.liveRead, true);
    queried.push(device._id);
    return { __homebrainLiveRead: { success: device._id === 'light' } };
  };
  const radio = { zigbee: { started: true }, getDirectNodeForDevice: (device) => ({ type: device._id === 'sleeping-lock' ? 'EndDevice' : 'Router' }), log() {} };
  await core.refreshDirectStatesOnReconnect.call(radio, 'zigbee');
  assert.deepEqual(queried, ['light', 'offline-switch']);
  assert.deepEqual(stale, [['light', false], ['offline-switch', true]]);
});

function service() {
  return Object.assign({ zigbee: { started: false, controller: null }, log() {}, dispatchHandler() {} }, methods);
}

test('concurrent Zigbee recovery attempts open only one controller', async () => {
  const radio = service();
  let starts = 0;
  let finish;
  radio.startZigbeeOnce = async () => {
    starts++;
    await new Promise((resolve) => { finish = resolve; });
    radio.zigbee.started = true;
  };
  const first = radio.startZigbee('/test');
  const second = radio.startZigbee('/test');
  assert.equal(starts, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(radio.zigbee.startPromise, null);
  await radio.startZigbee('/test');
  assert.equal(starts, 1);
});

test('failed startup releases the serial adapter without saving an incomplete coordinator backup, and retries', async (t) => {
  const herdsman = require('zigbee-herdsman');
  const descriptor = Object.getOwnPropertyDescriptor(herdsman, 'Controller');
  t.after(() => Object.defineProperty(herdsman, 'Controller', descriptor));
  let attempts = 0;
  let releases = 0;
  let locked = false;
  class Controller extends EventEmitter {
    constructor() {
      super();
      this.adapter = new EventEmitter();
      this.adapter.stop = async () => { locked = false; releases++; };
    }
    async start() {
      assert.equal(locked, false, 'the previous serial lock must be released');
      locked = true;
      if (++attempts === 1) throw new Error('SRSP - ZDO - activeEpReq after 6000ms');
      return 'resumed';
    }
    async stop() { assert.fail('incomplete controller must not write a backup'); }
  }
  Object.defineProperty(herdsman, 'Controller', { value: Controller, configurable: true });
  const radio = service();
  radio.ensureControllerConfig = async () => ({ zigbee: { panID: 123, extendedPanID: Array(8).fill(1), networkKey: Array(16).fill(2), channelList: [15] } });
  radio.syncZigbeeDevices = async () => {};
  await radio.startZigbee('/test');
  assert.equal(releases, 1);
  assert.equal(radio.zigbee.controller, null);
  assert.equal(radio.zigbee.started, false);
  assert.match(radio.zigbee.error, /activeEpReq/);
  await radio.startZigbee('/test');
  assert.equal(attempts, 2);
  assert.equal(radio.zigbee.started, true);
  assert.equal(radio.zigbee.error, null);
});

test('failed adapter cleanup retains the controller for a subsequent cleanup attempt', async () => {
  const radio = service();
  const controller = new EventEmitter();
  controller.adapter = new EventEmitter();
  controller.adapter.stop = async () => { throw new Error('serial close failed'); };
  radio.zigbee.controller = controller;
  await assert.rejects(radio.releaseFailedZigbeeController(), /serial close failed/);
  assert.equal(radio.zigbee.controller, controller);
  controller.adapter.stop = async () => {};
  await radio.releaseFailedZigbeeController();
  assert.equal(radio.zigbee.controller, null);
});
