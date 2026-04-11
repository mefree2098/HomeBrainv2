const test = require('node:test');
const assert = require('node:assert/strict');

const WallPanel = require('../models/WallPanel');
const Device = require('../models/Device');
const Scene = require('../models/Scene');
const deviceService = require('../services/deviceService');
const sceneService = require('../services/sceneService');
const securityAlarmService = require('../services/securityAlarmService');
const harmonyService = require('../services/harmonyService');
const wallPanelService = require('../services/wallPanelService');

test('registerPanel issues panel credentials and default mode order', async (t) => {
  const originalSave = WallPanel.prototype.save;

  t.after(() => {
    WallPanel.prototype.save = originalSave;
  });

  WallPanel.prototype.save = async function saveStub() {
    this._id = this._id || 'panel-1';
    return this;
  };

  const result = await wallPanelService.registerPanel({
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom'
  });

  assert.equal(result.name, 'Master Bedroom Orb');
  assert.equal(result.room, 'Master Bedroom');
  assert.match(result.settings.registrationCode, /^HBWP-/);
  assert.ok(result.settings.claimToken);
  assert.deepEqual(result.settings.modeOrder, ['thermostat', 'room', 'home', 'media', 'quiet']);
});

test('activatePanel accepts the registration code and clears the claim token', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-2',
    name: 'Bedroom Panel',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'offline',
    ipAddress: '',
    firmwareVersion: '',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: 'claim-token-123',
      claimTokenExpires: new Date(Date.now() + 60_000),
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet']
    },
    async save() {
      return this;
    },
    toObject() {
      return {
        ...this
      };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });

  WallPanel.findById = async () => panelDoc;

  const result = await wallPanelService.activatePanel('panel-2', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, {
    ipAddress: '192.168.1.45',
    firmwareVersion: '0.1.0'
  });

  assert.equal(result.status, 'online');
  assert.equal(result.ipAddress, '192.168.1.45');
  assert.equal(result.firmwareVersion, '0.1.0');
  assert.equal(panelDoc.settings.registered, true);
  assert.equal(panelDoc.settings.claimToken, '');
});

test('getPanelState builds swipeable mode payloads for the firmware', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalDeviceFind = Device.find;
  const originalDeviceFindOne = Device.findOne;
  const originalSceneFind = Scene.find;
  const originalGetAlarmStatus = securityAlarmService.getAlarmStatus;
  const originalGetDeviceById = deviceService.getDeviceById;
  const originalGetHubSnapshot = harmonyService.getHubSnapshot;

  const thermostat = {
    _id: 'thermo-1',
    name: 'Main Thermostat',
    type: 'thermostat',
    room: 'Hallway',
    status: true,
    temperature: 69,
    targetTemperature: 72,
    properties: {
      hvacMode: 'cool'
    }
  };
  const bedroomLight = {
    _id: 'light-1',
    name: 'Bedroom Lamp',
    type: 'light',
    room: 'Bedroom',
    status: true
  };
  const bedroomSpeaker = {
    _id: 'speaker-1',
    name: 'White Noise',
    type: 'speaker',
    room: 'Bedroom',
    status: false
  };
  const garage = {
    _id: 'garage-1',
    name: 'Main Garage',
    type: 'garage',
    room: 'Garage',
    status: true
  };
  const sceneDocs = [
    { _id: 'scene-bedtime', name: 'Bedtime', category: 'comfort' },
    { _id: 'scene-quiet', name: 'Quiet House', category: 'comfort' }
  ];
  const panelDoc = {
    _id: 'panel-3',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: '0.1.0',
    lastSeen: new Date('2026-04-11T12:00:00Z'),
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      pollingIntervalMs: 4000,
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet'],
      thermostat: {
        deviceId: 'thermo-1',
        bedtimeSceneId: 'scene-bedtime'
      },
      roomControl: {
        favoriteDeviceIds: ['light-1', 'speaker-1'],
        sceneIds: []
      },
      harmony: {
        hubIp: '192.168.1.99',
        activityIds: ['activity-tv'],
        commandDeviceId: 'remote-1'
      },
      quietHouse: {
        bedtimeSceneId: 'scene-bedtime',
        lockUpSceneId: 'scene-quiet'
      }
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
    Device.find = originalDeviceFind;
    Device.findOne = originalDeviceFindOne;
    Scene.find = originalSceneFind;
    securityAlarmService.getAlarmStatus = originalGetAlarmStatus;
    deviceService.getDeviceById = originalGetDeviceById;
    harmonyService.getHubSnapshot = originalGetHubSnapshot;
  });

  WallPanel.findById = async () => panelDoc;
  Device.findOne = async () => thermostat;
  Device.find = (query = {}) => ({
    sort: async () => {
      if (query.room === 'Bedroom') {
        return [bedroomLight, bedroomSpeaker];
      }
      return [thermostat, bedroomLight, bedroomSpeaker, garage];
    }
  });
  Scene.find = async () => sceneDocs;
  securityAlarmService.getAlarmStatus = async () => ({
    alarmState: 'disarmed',
    isArmed: false,
    isTriggered: false
  });
  deviceService.getDeviceById = async (id) => (id === 'thermo-1' ? thermostat : null);
  harmonyService.getHubSnapshot = async () => ({
    friendlyName: 'Bedroom Hub',
    currentActivityId: 'activity-tv',
    activities: [
      { id: 'activity-tv', label: 'Watch TV', activityTypeDisplayName: 'TV' }
    ]
  });

  const result = await wallPanelService.getPanelState('panel-3', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  });

  assert.deepEqual(result.modeOrder, ['thermostat', 'room', 'home', 'media', 'quiet']);
  assert.equal(result.modes.thermostat.centerValue, '72°');
  assert.equal(result.modes.thermostat.meta.mode, 'cool');
  assert.equal(result.modes.room.quickActions[0].label, 'Bedroom Lamp');
  assert.equal(result.modes.home.centerValue, 'DISARMED');
  assert.equal(result.modes.media.centerValue, 'Watch TV');
  assert.equal(result.modes.quiet.quickActions[0].label, 'Bedtime');
});

test('executeAction delegates thermostat and scene actions to existing services', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalControlDevice = deviceService.controlDevice;
  const originalActivateScene = sceneService.activateScene;

  const calls = [];
  const panelDoc = {
    _id: 'panel-4',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      thermostat: {
        deviceId: 'thermo-1'
      },
      harmony: {}
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
    sceneService.activateScene = originalActivateScene;
  });

  WallPanel.findById = async () => panelDoc;
  deviceService.controlDevice = async (...args) => {
    calls.push(['device', ...args]);
    return { ok: true };
  };
  sceneService.activateScene = async (...args) => {
    calls.push(['scene', ...args]);
    return { ok: true };
  };

  await wallPanelService.executeAction('panel-4', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, {
    type: 'thermostat.set_temperature',
    value: 71
  });

  await wallPanelService.executeAction('panel-4', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, {
    type: 'scene.activate',
    targetId: 'scene-1'
  });

  assert.deepEqual(calls[0], ['device', 'thermo-1', 'set_temperature', 71]);
  assert.deepEqual(calls[1], ['scene', 'scene-1']);
});
