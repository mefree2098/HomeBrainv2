const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_WATCH_PREFERENCES,
  normalizeWatchPreferences
} = require('../utils/watchPreferences');
const watchService = require('../services/watchService');

const {
  buildAvailableRooms,
  buildLightRooms,
  buildLightSection,
  isWatchLightDevice
} = watchService.__private__;

test('normalizeWatchPreferences keeps a safe default watch surface', () => {
  assert.deepEqual(normalizeWatchPreferences(null), DEFAULT_WATCH_PREFERENCES);
  assert.deepEqual(normalizeWatchPreferences({ sections: [] }).sections, DEFAULT_WATCH_PREFERENCES.sections);
});

test('normalizeWatchPreferences removes unknown sections and clamps brightness', () => {
  const normalized = normalizeWatchPreferences({
    sections: ['weather', 'lights', 'weather', 'unknown'],
    primaryRoom: ' Kitchen ',
    lightDeviceIds: [' a ', '', 'a', ' b '],
    defaultLightBrightness: 140
  });

  assert.deepEqual(normalized.sections, ['weather', 'lights']);
  assert.equal(normalized.primaryRoom, 'Kitchen');
  assert.deepEqual(normalized.lightDeviceIds, ['a', 'b']);
  assert.equal(normalized.defaultLightBrightness, 100);
});

test('watch light helpers include real lights and likely light switches', () => {
  assert.equal(isWatchLightDevice({ type: 'light' }), true);
  assert.equal(isWatchLightDevice({
    type: 'switch',
    name: 'Kitchen Lamp',
    properties: {}
  }), true);
  assert.equal(isWatchLightDevice({
    type: 'switch',
    name: 'Outlet',
    properties: {
      smartThingsCategories: ['light']
    }
  }), true);
  assert.equal(isWatchLightDevice({
    type: 'switch',
    name: 'Coffee Maker',
    properties: {}
  }), false);
});

test('buildAvailableRooms and buildLightSection summarize room lights for the watch', () => {
  const devices = [
    { _id: '1', name: 'Can Lights', type: 'light', room: 'Kitchen', status: true, brightness: 80, isOnline: true },
    { _id: '2', name: 'Pendant', type: 'light', room: 'Kitchen', status: false, brightness: 0, isOnline: false },
    { _id: '3', name: 'Lamp', type: 'light', room: 'Office', status: true, brightness: 50, isOnline: true }
  ];

  assert.deepEqual(buildAvailableRooms(devices), [
    { name: 'Kitchen', lightCount: 2, onlineCount: 1, onCount: 1, dimmableCount: 2 },
    { name: 'Office', lightCount: 1, onlineCount: 1, onCount: 1, dimmableCount: 1 }
  ]);

  const lights = buildLightSection({
    primaryRoom: 'Kitchen',
    lightDeviceIds: [],
    defaultLightBrightness: 70
  }, devices);

  assert.equal(lights.available, true);
  assert.equal(lights.totalCount, 2);
  assert.equal(lights.onCount, 1);
  assert.equal(lights.averageBrightness, 80);
  assert.deepEqual(lights.rooms.map((room) => room.name), ['Kitchen', 'Office']);
});

test('buildLightSection exposes configured light rooms and filters to selected devices', () => {
  const devices = [
    { _id: '1', name: 'Can Lights', type: 'light', room: 'Kitchen', status: true, brightness: 80, isOnline: true },
    { _id: '2', name: 'Pendant', type: 'light', room: 'Kitchen', status: false, brightness: 0, isOnline: true },
    { _id: '3', name: 'Lamp', type: 'light', room: 'Office', status: true, brightness: 50, isOnline: true },
    { _id: '4', name: 'Sconce', type: 'light', room: 'Hall', status: true, brightness: 30, isOnline: true }
  ];
  const config = {
    primaryRoom: 'Office',
    lightDeviceIds: ['1', '3'],
    defaultLightBrightness: 65
  };

  const rooms = buildLightRooms(config, devices);
  assert.deepEqual(rooms.map((room) => [room.name, room.totalCount]), [
    ['Kitchen', 1],
    ['Office', 1]
  ]);

  const lights = buildLightSection(config, devices);
  assert.equal(lights.room, 'Office');
  assert.equal(lights.totalCount, 1);
  assert.equal(lights.devices[0].name, 'Lamp');
  assert.deepEqual(lights.rooms.map((room) => room.name), ['Kitchen', 'Office']);
});
