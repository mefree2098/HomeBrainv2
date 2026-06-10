const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const Room = require('../models/Room');
const VoiceDevice = require('../models/VoiceDevice');
const WallPanel = require('../models/WallPanel');
const roomService = require('../services/roomService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');

function queryResult(items) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => items,
    then(resolve, reject) {
      return Promise.resolve(items).then(resolve, reject);
    }
  };
}

function matchesRoom(doc, query = {}) {
  if (query.room instanceof RegExp) {
    return query.room.test(doc.room || '');
  }
  return true;
}

function installRoomMocks(t, state) {
  const originalRoomFind = Room.find;
  const originalRoomFindOne = Room.findOne;
  const originalRoomCreate = Room.create;
  const originalRoomDeleteOne = Room.deleteOne;
  const originalDeviceFind = Device.find;
  const originalDeviceUpdateMany = Device.updateMany;
  const originalWallPanelFind = WallPanel.find;
  const originalWallPanelUpdateMany = WallPanel.updateMany;
  const originalVoiceDeviceFind = VoiceDevice.find;
  const originalVoiceDeviceUpdateMany = VoiceDevice.updateMany;
  const originalNormalizeDevices = deviceUpdateEmitter.normalizeDevices;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Room.find = originalRoomFind;
    Room.findOne = originalRoomFindOne;
    Room.create = originalRoomCreate;
    Room.deleteOne = originalRoomDeleteOne;
    Device.find = originalDeviceFind;
    Device.updateMany = originalDeviceUpdateMany;
    WallPanel.find = originalWallPanelFind;
    WallPanel.updateMany = originalWallPanelUpdateMany;
    VoiceDevice.find = originalVoiceDeviceFind;
    VoiceDevice.updateMany = originalVoiceDeviceUpdateMany;
    deviceUpdateEmitter.normalizeDevices = originalNormalizeDevices;
    deviceUpdateEmitter.emit = originalEmit;
  });

  Room.find = () => queryResult(state.rooms);
  Room.findOne = async (query) => {
    const room = state.rooms.find((entry) => entry.normalizedName === query.normalizedName);
    if (!room) {
      return null;
    }
    return {
      ...room,
      save: async function save() {
        const index = state.rooms.findIndex((entry) => entry._id === room._id);
        state.rooms[index] = {
          _id: room._id,
          name: this.name,
          normalizedName: this.normalizedName
        };
        return state.rooms[index];
      }
    };
  };
  Room.create = async (payload) => {
    const name = roomService.sanitizeRoomName(payload.name);
    const normalizedName = roomService.normalizeRoomName(name);
    if (state.rooms.some((room) => room.normalizedName === normalizedName)) {
      const error = new Error('duplicate');
      error.code = 11000;
      throw error;
    }
    const room = {
      _id: `room-${state.rooms.length + 1}`,
      name,
      normalizedName
    };
    state.rooms.push(room);
    return room;
  };
  Room.deleteOne = async (query) => {
    const before = state.rooms.length;
    state.rooms = state.rooms.filter((room) => room.normalizedName !== query.normalizedName);
    return { deletedCount: before - state.rooms.length };
  };

  Device.find = (query = {}) => queryResult(state.devices.filter((device) => matchesRoom(device, query)));
  Device.updateMany = async (query, update) => {
    let count = 0;
    state.devices.forEach((device) => {
      if (matchesRoom(device, query)) {
        device.room = update.$set.room;
        count += 1;
      }
    });
    return { modifiedCount: count };
  };

  WallPanel.find = (query = {}) => queryResult(state.wallPanels.filter((panel) => matchesRoom(panel, query)));
  WallPanel.updateMany = async (query, update) => {
    let count = 0;
    state.wallPanels.forEach((panel) => {
      if (matchesRoom(panel, query)) {
        panel.room = update.$set.room;
        count += 1;
      }
    });
    return { modifiedCount: count };
  };

  VoiceDevice.find = (query = {}) => queryResult(state.voiceDevices.filter((device) => matchesRoom(device, query)));
  VoiceDevice.updateMany = async (query, update) => {
    let count = 0;
    state.voiceDevices.forEach((device) => {
      if (matchesRoom(device, query)) {
        device.room = update.$set.room;
        count += 1;
      }
    });
    return { modifiedCount: count };
  };

  deviceUpdateEmitter.normalizeDevices = (devices) => devices.map((device) => ({ _id: String(device._id), room: device.room }));
  deviceUpdateEmitter.emit = (eventName, payload) => {
    state.emitted.push({ eventName, payload });
    return true;
  };
}

test('listRooms merges registry rooms with rooms derived from devices and room hardware', async (t) => {
  const state = {
    rooms: [
      { _id: 'room-1', name: 'Vault', normalizedName: 'vault' },
      { _id: 'room-2', name: 'Library', normalizedName: 'library' }
    ],
    devices: [
      { _id: 'device-1', name: 'Vault Light', room: 'Vault' },
      { _id: 'device-2', name: 'Kitchen Light', room: 'Kitchen' }
    ],
    wallPanels: [
      { _id: 'panel-1', name: 'Kitchen Orb', room: 'Kitchen' }
    ],
    voiceDevices: [
      { _id: 'voice-1', name: 'Vault Voice', room: 'Vault' }
    ],
    emitted: []
  };
  installRoomMocks(t, state);

  const rooms = await roomService.listRooms();

  assert.deepEqual(rooms.map((room) => room.name), ['Unassigned', 'Kitchen', 'Library', 'Vault']);
  const vault = rooms.find((room) => room.name === 'Vault');
  assert.equal(vault.registered, true);
  assert.equal(vault.deviceCount, 1);
  assert.equal(vault.voiceDeviceCount, 1);
  assert.equal(vault.totalReferences, 2);
  const library = rooms.find((room) => room.name === 'Library');
  assert.equal(library.registered, true);
  assert.equal(library.totalReferences, 0);
});

test('renameRoom persists registry entry, updates assigned hardware, and emits device updates', async (t) => {
  const state = {
    rooms: [
      { _id: 'room-1', name: 'Vault', normalizedName: 'vault' }
    ],
    devices: [
      { _id: 'device-1', name: 'Vault Light', room: 'Vault' }
    ],
    wallPanels: [
      { _id: 'panel-1', name: 'Vault Orb', room: 'Vault' }
    ],
    voiceDevices: [
      { _id: 'voice-1', name: 'Vault Voice', room: 'Vault' }
    ],
    emitted: []
  };
  installRoomMocks(t, state);

  const result = await roomService.renameRoom('Vault', 'Secure Storage');

  assert.equal(state.rooms[0].name, 'Secure Storage');
  assert.equal(state.rooms[0].normalizedName, 'secure storage');
  assert.equal(state.devices[0].room, 'Secure Storage');
  assert.equal(state.wallPanels[0].room, 'Secure Storage');
  assert.equal(state.voiceDevices[0].room, 'Secure Storage');
  assert.deepEqual(result.updates, {
    devicesUpdated: 1,
    wallPanelsUpdated: 1,
    voiceDevicesUpdated: 1
  });
  assert.equal(state.emitted.length, 1);
  assert.equal(state.emitted[0].eventName, 'devices:update');
  assert.deepEqual(state.emitted[0].payload, [{ _id: 'device-1', room: 'Secure Storage' }]);
});

test('deleteRoom refuses assigned rooms unless a reassignment target is supplied', async (t) => {
  const state = {
    rooms: [
      { _id: 'room-1', name: 'Vault', normalizedName: 'vault' },
      { _id: 'room-2', name: 'Kitchen', normalizedName: 'kitchen' }
    ],
    devices: [
      { _id: 'device-1', name: 'Vault Light', room: 'Vault' }
    ],
    wallPanels: [],
    voiceDevices: [],
    emitted: []
  };
  installRoomMocks(t, state);

  await assert.rejects(
    () => roomService.deleteRoom('Vault'),
    /assigned hardware/
  );

  const result = await roomService.deleteRoom('Vault', { reassignTo: 'Kitchen' });

  assert.equal(state.devices[0].room, 'Kitchen');
  assert.deepEqual(state.rooms.map((room) => room.name), ['Kitchen']);
  assert.deepEqual(result.updates, {
    devicesUpdated: 1,
    wallPanelsUpdated: 0,
    voiceDevicesUpdated: 0
  });
});
