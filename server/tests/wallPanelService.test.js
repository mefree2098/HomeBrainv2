const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const WallPanel = require('../models/WallPanel');
const Device = require('../models/Device');
const Scene = require('../models/Scene');
const deviceService = require('../services/deviceService');
const eventStreamService = require('../services/eventStreamService');
const sceneService = require('../services/sceneService');
const securityAlarmService = require('../services/securityAlarmService');
const harmonyService = require('../services/harmonyService');
const weatherService = require('../services/weatherService');
const wallPanelServiceModule = require('../services/wallPanelService');

const wallPanelService = wallPanelServiceModule;
const { WallPanelService } = wallPanelServiceModule;

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
  assert.equal(result.settings.mountAlignment.offsetTenths, 0);
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

test('activatePanel does not complete an OTA that is only waiting in ready state', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-2-ready',
    name: 'Bedroom Panel',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    ipAddress: '',
    firmwareVersion: 'panel-old',
    ota: {
      jobId: 'job-ready',
      status: 'ready',
      phase: 'ready',
      progress: 60,
      targetVersion: 'panel-target',
      currentVersion: 'panel-old',
      message: 'Waiting for the orb to download the package.'
    },
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
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

  const result = await wallPanelService.activatePanel('panel-2-ready', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, {
    ipAddress: '192.168.1.45',
    firmwareVersion: 'panel-target'
  });

  assert.equal(result.status, 'online');
  assert.equal(result.ota.status, 'ready');
  assert.equal(result.ota.phase, 'ready');
  assert.equal(result.ota.progress, 60);
  assert.equal(result.ota.currentVersion, 'panel-target');
});

test('activatePanel completes an OTA after download progress has started', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-2-downloading',
    name: 'Bedroom Panel',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    ipAddress: '',
    firmwareVersion: 'panel-old',
    ota: {
      jobId: 'job-downloading',
      status: 'downloading',
      phase: 'downloading',
      progress: 72,
      targetVersion: 'panel-target',
      currentVersion: 'panel-old',
      bytesTransferred: 1024,
      bytesTotal: 2048,
      message: 'Downloading firmware package.'
    },
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
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

  const result = await wallPanelService.activatePanel('panel-2-downloading', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, {
    ipAddress: '192.168.1.45',
    firmwareVersion: 'panel-target'
  });

  assert.equal(result.status, 'online');
  assert.equal(result.ota.status, 'completed');
  assert.equal(result.ota.phase, 'completed');
  assert.equal(result.ota.progress, 100);
  assert.equal(result.ota.currentVersion, 'panel-target');
});

test('getPanelState builds swipeable mode payloads for the firmware', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalDeviceFind = Device.find;
  const originalDeviceFindOne = Device.findOne;
  const originalSceneFind = Scene.find;
  const originalGetAlarmStatus = securityAlarmService.getAlarmStatus;
  const originalGetDeviceById = deviceService.getDeviceById;
  const originalGetHubSnapshot = harmonyService.getHubSnapshot;
  const originalFetchDashboardWeather = weatherService.fetchDashboardWeather;

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
    status: true,
    brightness: 35
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
  const frontDoorLock = {
    _id: 'lock-1',
    name: 'Front Door',
    type: 'lock',
    room: 'Entry',
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
      mountAlignment: {
        offsetTenths: 25
      },
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet'],
      thermostat: {
        deviceId: 'thermo-1',
        bedtimeSceneId: 'scene-bedtime'
      },
      roomControl: {
        lightDeviceId: 'light-1',
        favoriteDeviceIds: ['light-1', 'lock-1'],
        sceneIds: []
      },
      harmony: {
        hubIp: '192.168.1.99',
        defaultActivityId: 'activity-tv',
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
    weatherService.fetchDashboardWeather = originalFetchDashboardWeather;
  });

  WallPanel.findById = async () => panelDoc;
  Device.findOne = async () => thermostat;
  Device.find = (query = {}) => ({
    sort: async () => {
      if (query.room === 'Bedroom') {
        return [bedroomLight, bedroomSpeaker];
      }
      return [thermostat, bedroomLight, bedroomSpeaker, garage, frontDoorLock];
    }
  });
  Scene.find = async () => sceneDocs;
  securityAlarmService.getAlarmStatus = async () => ({
    alarmState: 'disarmed',
    isArmed: false,
    isTriggered: false,
    sensorCount: 3,
    activeSensorCount: 1,
    sensors: [
      { id: 'sensor-1', name: 'Front Door', isActive: false },
      { id: 'sensor-2', name: 'Master Window', isActive: true }
    ],
    doorLocks: [
      { id: 'lock-1', name: 'Front Door', isLocked: true }
    ]
  });
  deviceService.getDeviceById = async (id) => (id === 'thermo-1' ? thermostat : null);
  harmonyService.getHubSnapshot = async () => ({
    friendlyName: 'Bedroom Hub',
    currentActivityId: 'activity-tv',
    activities: [
      { id: 'activity-tv', label: 'Watch TV', activityTypeDisplayName: 'TV' }
    ]
  });
  weatherService.fetchDashboardWeather = async () => ({
    current: {
      icon: 'sunny',
      condition: 'Clear',
      isDay: true,
      temperatureF: 58
    }
  });

  const result = await wallPanelService.getPanelState('panel-3', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, 'https://example.com');

  assert.deepEqual(result.modeOrder, ['thermostat', 'room', 'home', 'media', 'quiet']);
  assert.equal(result.transport.pollIntervalMs, 1000);
  assert.equal(result.orientation.mountOffsetTenths, 25);
  assert.equal(result.orientation.mountOffsetDegrees, 2.5);
  assert.equal(result.orientation.clockwisePositive, true);
  assert.equal(result.modes.thermostat.centerValue, '69°');
  assert.equal(result.modes.thermostat.meta.mode, 'cool');
  assert.equal(result.modes.thermostat.meta.weatherIcon, 'sunny');
  assert.equal(result.modes.thermostat.meta.weatherCondition, 'Clear');
  assert.equal(result.modes.thermostat.secondaryValue, 'Set point 72°');
  assert.equal(result.modes.room.title, 'Bedroom');
  assert.equal(result.modes.room.centerValue, '35%');
  assert.equal(result.modes.room.secondaryValue, 'Lights');
  assert.equal(result.modes.room.knob.pressAction.targetId, 'light-1');
  assert.equal(result.modes.room.knob.pressAction.action, 'set_brightness');
  assert.equal(result.modes.room.knob.pressAction.value, 0);
  assert.equal(result.modes.room.meta.deviceId, 'light-1');
  assert.deepEqual(result.modes.room.quickActions, []);
  assert.equal(result.modes.home.title, 'Security');
  assert.equal(result.modes.home.centerValue, 'Disarmed');
  assert.equal(result.modes.home.quickActions[0].label, 'Arm Stay');
  assert.equal(result.modes.home.quickActions[1].label, 'Arm Away');
  assert.equal(result.modes.home.meta.security.sensorCount, 3);
  assert.equal(result.modes.home.meta.security.activeSensorCount, 1);
  assert.equal(result.modes.home.meta.security.sensors, undefined);
  assert.equal(result.modes.home.meta.security.doorLocks, undefined);
  assert.equal(result.modes.media.title, 'Bedroom Hub');
  assert.equal(result.modes.media.centerValue, 'On');
  assert.equal(result.modes.media.secondaryValue, 'Watch TV');
  assert.equal(result.modes.media.knob.kind, 'relative');
  assert.equal(result.modes.media.knob.pressAction.label, 'Off');
  assert.equal(result.modes.media.quickActions[0].label, 'On');
  assert.equal(result.modes.media.quickActions[1].label, 'Off');
  assert.equal(result.modes.quiet.quickActions[0].label, 'Bedtime');
  assert.equal(result.ota.available, false);
  assert.equal(result.ota.downloadUrl, '');
});

test('updatePanel clamps persisted mount alignment offsets to the supported range', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-rotation-clamp',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      mountAlignment: {
        offsetTenths: 0
      },
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet']
    },
    async save() {
      return this;
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });

  WallPanel.findById = async () => panelDoc;

  const result = await wallPanelService.updatePanel('panel-rotation-clamp', {
    settings: {
      mountAlignment: {
        offsetTenths: 999
      }
    }
  });

  assert.equal(result.settings.mountAlignment.offsetTenths, 150);
  assert.equal(panelDoc.settings.mountAlignment.offsetTenths, 150);
});

test('getPanelState prefers a LAN OTA download URL when the panel and hub share a private subnet', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalDeviceFind = Device.find;
  const originalDeviceFindOne = Device.findOne;
  const originalSceneFind = Scene.find;
  const originalGetAlarmStatus = securityAlarmService.getAlarmStatus;
  const originalGetDeviceById = deviceService.getDeviceById;
  const originalGetHubSnapshot = harmonyService.getHubSnapshot;
  const originalFetchDashboardWeather = weatherService.fetchDashboardWeather;
  const originalNetworkInterfaces = os.networkInterfaces;

  const panelDoc = {
    _id: 'panel-lan-ota',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    ipAddress: '192.168.2.72',
    firmwareVersion: 'panel-20260414T203000Z',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet']
    },
    ota: {
      status: 'ready',
      targetVersion: 'panel-20260414T204043Z-70305d3',
      artifactPath: '/tmp/panel.bin',
      artifactSizeBytes: 1234
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
    weatherService.fetchDashboardWeather = originalFetchDashboardWeather;
    os.networkInterfaces = originalNetworkInterfaces;
  });

  WallPanel.findById = async () => panelDoc;
  Device.findOne = async () => null;
  Device.find = () => ({
    sort: async () => []
  });
  Scene.find = async () => [];
  securityAlarmService.getAlarmStatus = async () => null;
  deviceService.getDeviceById = async () => null;
  harmonyService.getHubSnapshot = async () => null;
  weatherService.fetchDashboardWeather = async () => null;
  os.networkInterfaces = () => ({
    en0: [
      {
        family: 'IPv4',
        internal: false,
        address: '192.168.2.61'
      }
    ]
  });

  const result = await wallPanelService.getPanelState('panel-lan-ota', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, 'https://example.com');

  assert.equal(
    result.ota.downloadUrl,
    'http://192.168.2.61:3000/api/panels/panel-lan-ota/ota/download'
  );
});

test('getPanelState hides stale OTA payloads when the panel is already on a newer firmware', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalDeviceFind = Device.find;
  const originalDeviceFindOne = Device.findOne;
  const originalSceneFind = Scene.find;
  const originalGetAlarmStatus = securityAlarmService.getAlarmStatus;
  const originalGetDeviceById = deviceService.getDeviceById;
  const originalGetHubSnapshot = harmonyService.getHubSnapshot;
  const originalFetchDashboardWeather = weatherService.fetchDashboardWeather;

  const panelDoc = {
    _id: 'panel-stale-ota',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: 'panel-20260414T210957Z',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet']
    },
    ota: {
      status: 'ready',
      phase: 'ready',
      progress: 60,
      jobId: 'job-stale',
      targetVersion: 'panel-20260414T204043Z-70305d3',
      artifactPath: '/tmp/panel.bin',
      artifactSizeBytes: 1234,
      message: 'Waiting for download'
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
    weatherService.fetchDashboardWeather = originalFetchDashboardWeather;
  });

  WallPanel.findById = async () => panelDoc;
  Device.findOne = async () => null;
  Device.find = () => ({
    sort: async () => []
  });
  Scene.find = async () => [];
  securityAlarmService.getAlarmStatus = async () => null;
  deviceService.getDeviceById = async () => null;
  harmonyService.getHubSnapshot = async () => null;
  weatherService.fetchDashboardWeather = async () => null;

  const result = await wallPanelService.getPanelState('panel-stale-ota', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, 'https://example.com');

  assert.equal(result.ota.active, false);
  assert.equal(result.ota.available, false);
  assert.equal(result.ota.status, 'idle');
  assert.equal(result.ota.jobId, '');
  assert.equal(result.ota.targetVersion, '');
  assert.equal(result.ota.downloadUrl, '');
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

  await wallPanelService.executeAction('panel-4', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, {
    type: 'device.control',
    targetId: 'light-1',
    action: 'set_brightness',
    value: 63
  });

  assert.deepEqual(calls[0], ['device', 'thermo-1', 'set_temperature', 71]);
  assert.deepEqual(calls[1], ['scene', 'scene-1']);
  assert.deepEqual(calls[2], ['device', 'light-1', 'set_brightness', 63]);
});

test('getPanelProvisioning exposes the setup token for admin UI flows', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-5',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'offline',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: 'claim-token-123',
      claimTokenExpires: new Date(Date.now() + 60_000),
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet']
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });

  WallPanel.findById = async () => panelDoc;

  const result = await wallPanelService.getPanelProvisioning('panel-5', 'https://example.com');

  assert.equal(result.panel.settings.registrationCode, 'HBWP-ABCD-EF12-3456');
  assert.equal(result.provisioning.hubUrl, 'https://example.com');
  assert.equal(result.provisioning.firmwareHeader.HOMEBRAIN_PANEL_ID, 'panel-5');
});

test('rotateRegistrationCode regenerates the setup token and marks the panel unregistered', async (t) => {
  const originalFindById = WallPanel.findById;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-rotate-'));
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const staleArtifactPath = path.join(otaArtifactsDir, 'panel-6', 'job-old.bin');

  const panelDoc = {
    _id: 'panel-6',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    ota: {
      jobId: 'job-old',
      status: 'completed',
      phase: 'completed',
      artifactPath: staleArtifactPath
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet']
    },
    async save() {
      return this;
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.mkdir(path.dirname(staleArtifactPath), { recursive: true });
  await fs.promises.writeFile(staleArtifactPath, Buffer.from('stale-firmware'));

  WallPanel.findById = async () => panelDoc;

  const service = new WallPanelService({
    projectRoot: tempRoot,
    panelOtaArtifactsDir: otaArtifactsDir
  });

  const result = await service.rotateRegistrationCode('panel-6', 'https://example.com');

  assert.equal(result.panel.status, 'offline');
  assert.equal(result.panel.settings.registered, false);
  assert.match(result.panel.settings.registrationCode, /^HBWP-/);
  assert.notEqual(result.panel.settings.registrationCode, 'HBWP-ABCD-EF12-3456');
  assert.equal(result.provisioning.firmwareHeader.HOMEBRAIN_PANEL_HUB_URL, 'https://example.com');
  assert.equal(await fs.promises.stat(staleArtifactPath).catch(() => null), null);
});

test('getPanelById reports when newer HomeBrain firmware is available', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-7',
    name: 'Hallway Orb',
    room: 'Hallway',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: 'panel-20240409T235959Z-older',
    settings: {
      registered: true,
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      modeOrder: ['thermostat', 'room', 'home', 'media', 'quiet']
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });

  WallPanel.findById = async () => panelDoc;

  const service = new WallPanelService({
    projectRoot: '/tmp/homebrain',
    panelFirmwareProjectDir: '/tmp/homebrain/embedded/elecrow-wall-panel'
  });
  service.panelFirmwareVersionCache = {
    value: 'panel-20240410T000000Z-abc1234',
    expiresAt: Date.now() + 60_000
  };

  const result = await service.getPanelById('panel-7');

  assert.equal(result.latestFirmwareVersion, 'panel-20240410T000000Z-abc1234');
  assert.equal(result.updateAvailable, true);
});

test('buildPanelOtaArtifact falls back to Homebrew PlatformIO when pio is missing from PATH', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const originalPublishSafe = eventStreamService.publishSafe;

  t.after(async () => {
    eventStreamService.publishSafe = originalPublishSafe;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.mkdir(path.dirname(builtArtifactPath), { recursive: true });
  await fs.promises.writeFile(path.join(firmwareDir, 'platformio.ini'), '[env:elecrow-crowpanel-2_1]\n');
  await fs.promises.writeFile(builtArtifactPath, Buffer.from('firmware-binary'));

  eventStreamService.publishSafe = async () => {};

  const commands = [];
  const service = new WallPanelService({
    projectRoot: tempRoot,
    panelFirmwareProjectDir: firmwareDir,
    panelOtaArtifactsDir: otaArtifactsDir,
    platformioBin: 'pio',
    spawnProcess: (command, args, options) => {
      commands.push({
        command,
        args,
        envPath: options?.env?.PATH || ''
      });

      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();

      process.nextTick(() => {
        if (command !== '/opt/homebrew/bin/pio') {
          const error = new Error(`spawn ${command} ENOENT`);
          error.code = 'ENOENT';
          child.emit('error', error);
          return;
        }

        child.stdout.write('Compiling wall panel firmware...\n');
        child.stderr.write('Linking and packaging OTA image...\n');
        child.emit('close', 0);
      });

      return child;
    }
  });

  service.updatePanelOtaState = async () => ({});

  await service.buildPanelOtaArtifact(
    {
      id: 'panel-build',
      hardwareProfile: 'elecrow-crowpanel-2.1-rotary'
    },
    {
      jobId: 'job-1',
      targetVersion: 'panel-20240410T000000Z-abc1234'
    }
  );

  const copiedArtifact = await fs.promises.readFile(
    path.join(otaArtifactsDir, 'panel-build', 'job-1.bin'),
    'utf8'
  );

  assert.equal(commands[0].command, 'pio');
  assert.ok(commands.some((entry) => entry.command === '/opt/homebrew/bin/pio'));
  assert.ok(commands.some((entry) => entry.envPath.includes('/opt/homebrew/bin')));
  assert.equal(copiedArtifact, 'firmware-binary');
});

test('buildPanelOtaArtifact falls back to Linux user-local PlatformIO when PATH is missing it', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-local-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const homeDir = path.join(tempRoot, 'home');
  const userLocalPlatformio = path.join(homeDir, '.local', 'bin', 'platformio');
  const originalPublishSafe = eventStreamService.publishSafe;
  const originalHome = process.env.HOME;

  t.after(async () => {
    process.env.HOME = originalHome;
    eventStreamService.publishSafe = originalPublishSafe;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  process.env.HOME = homeDir;

  await fs.promises.mkdir(path.dirname(builtArtifactPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(userLocalPlatformio), { recursive: true });
  await fs.promises.writeFile(path.join(firmwareDir, 'platformio.ini'), '[env:elecrow-crowpanel-2_1]\n');
  await fs.promises.writeFile(builtArtifactPath, Buffer.from('firmware-binary'));

  eventStreamService.publishSafe = async () => {};

  const commands = [];
  const service = new WallPanelService({
    projectRoot: tempRoot,
    panelFirmwareProjectDir: firmwareDir,
    panelOtaArtifactsDir: otaArtifactsDir,
    platformioBin: 'pio',
    spawnProcess: (command, args, options) => {
      commands.push({
        command,
        args,
        envPath: options?.env?.PATH || ''
      });

      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();

      process.nextTick(() => {
        if (command !== userLocalPlatformio) {
          const error = new Error(`spawn ${command} ENOENT`);
          error.code = 'ENOENT';
          child.emit('error', error);
          return;
        }

        child.stdout.write('Compiling wall panel firmware...\n');
        child.stderr.write('Linking and packaging OTA image...\n');
        child.emit('close', 0);
      });

      return child;
    }
  });

  service.updatePanelOtaState = async () => ({});

  await service.buildPanelOtaArtifact(
    {
      id: 'panel-build',
      hardwareProfile: 'elecrow-crowpanel-2.1-rotary'
    },
    {
      jobId: 'job-2',
      targetVersion: 'panel-20240410T000000Z-abc1234'
    }
  );

  const copiedArtifact = await fs.promises.readFile(
    path.join(otaArtifactsDir, 'panel-build', 'job-2.bin'),
    'utf8'
  );

  assert.ok(commands.some((entry) => entry.command === userLocalPlatformio));
  assert.ok(commands.some((entry) => entry.envPath.includes(path.join(homeDir, '.local', 'bin'))));
  assert.equal(copiedArtifact, 'firmware-binary');
});

test('buildPanelOtaArtifact keeps trying candidates when python3 lacks the platformio module', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-python-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const originalPublishSafe = eventStreamService.publishSafe;

  t.after(async () => {
    eventStreamService.publishSafe = originalPublishSafe;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.mkdir(path.dirname(builtArtifactPath), { recursive: true });
  await fs.promises.writeFile(path.join(firmwareDir, 'platformio.ini'), '[env:elecrow-crowpanel-2_1]\n');
  await fs.promises.writeFile(builtArtifactPath, Buffer.from('firmware-binary'));

  eventStreamService.publishSafe = async () => {};

  const commands = [];
  const service = new WallPanelService({
    projectRoot: tempRoot,
    panelFirmwareProjectDir: firmwareDir,
    panelOtaArtifactsDir: otaArtifactsDir,
    platformioBin: 'pio',
    spawnProcess: (command, args, options) => {
      commands.push({
        command,
        args,
        envPath: options?.env?.PATH || ''
      });

      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();

      process.nextTick(() => {
        if (command === 'python3') {
          child.stderr.write('/usr/bin/python3: No module named platformio\n');
          child.emit('close', 1);
          return;
        }

        if (command !== 'python') {
          const error = new Error(`spawn ${command} ENOENT`);
          error.code = 'ENOENT';
          child.emit('error', error);
          return;
        }

        child.stdout.write('Compiling wall panel firmware...\n');
        child.stderr.write('Linking and packaging OTA image...\n');
        child.emit('close', 0);
      });

      return child;
    }
  });

  service.updatePanelOtaState = async () => ({});

  await service.buildPanelOtaArtifact(
    {
      id: 'panel-build',
      hardwareProfile: 'elecrow-crowpanel-2.1-rotary'
    },
    {
      jobId: 'job-3',
      targetVersion: 'panel-20240410T000000Z-abc1234'
    }
  );

  assert.ok(commands.some((entry) => entry.command === 'python3'));
  assert.ok(commands.some((entry) => entry.command === 'python'));
});

test('buildPanelOtaArtifact bootstraps a private PlatformIO toolchain when none is installed', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-managed-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const managedRootDir = path.join(otaArtifactsDir, '.platformio-homebrain');
  const managedPython = path.join(managedRootDir, 'bin', 'python');
  const managedPio = path.join(managedRootDir, 'bin', 'pio');
  const originalPublishSafe = eventStreamService.publishSafe;

  t.after(async () => {
    eventStreamService.publishSafe = originalPublishSafe;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.mkdir(path.dirname(builtArtifactPath), { recursive: true });
  await fs.promises.writeFile(path.join(firmwareDir, 'platformio.ini'), '[env:elecrow-crowpanel-2_1]\n');
  await fs.promises.writeFile(builtArtifactPath, Buffer.from('firmware-binary'));

  eventStreamService.publishSafe = async () => {};

  const spawnCommands = [];
  const execCalls = [];
  const service = new WallPanelService({
    projectRoot: tempRoot,
    panelFirmwareProjectDir: firmwareDir,
    panelOtaArtifactsDir: otaArtifactsDir,
    platformioBin: 'pio',
    execFile: (file, args, options, callback) => {
      execCalls.push({ file, args });

      process.nextTick(async () => {
        try {
          if (file === 'python3' && args[0] === '--version') {
            callback(null, 'Python 3.11.0\n', '');
            return;
          }

          if (file === 'python3' && args[0] === '-m' && args[1] === 'venv') {
            await fs.promises.mkdir(path.dirname(managedPio), { recursive: true });
            await fs.promises.writeFile(managedPython, '#!/usr/bin/env python3\n');
            await fs.promises.writeFile(managedPio, '#!/bin/sh\n');
            callback(null, '', '');
            return;
          }

          if (file === managedPython && args[0] === '-m' && args[1] === 'ensurepip') {
            callback(null, '', '');
            return;
          }

          if (file === managedPython && args[0] === '-m' && args[1] === 'pip') {
            callback(null, 'installed platformio\n', '');
            return;
          }

          if (file === managedPio && args[0] === '--version') {
            callback(null, 'PlatformIO Core, version 6.1.18\n', '');
            return;
          }

          const error = new Error(`spawn ${file} ENOENT`);
          error.code = 'ENOENT';
          callback(error, '', '');
        } catch (error) {
          callback(error, '', '');
        }
      });
    },
    spawnProcess: (command, args, options) => {
      spawnCommands.push({
        command,
        args,
        envPath: options?.env?.PATH || ''
      });

      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();

      process.nextTick(() => {
        if (command !== managedPio || !fs.existsSync(managedPio)) {
          const error = new Error(`spawn ${command} ENOENT`);
          error.code = 'ENOENT';
          child.emit('error', error);
          return;
        }

        child.stdout.write('Compiling wall panel firmware...\n');
        child.stderr.write('Linking and packaging OTA image...\n');
        child.emit('close', 0);
      });

      return child;
    }
  });

  service.updatePanelOtaState = async () => ({});

  await service.buildPanelOtaArtifact(
    {
      id: 'panel-build',
      hardwareProfile: 'elecrow-crowpanel-2.1-rotary'
    },
    {
      jobId: 'job-4',
      targetVersion: 'panel-20240410T000000Z-abc1234'
    }
  );

  const copiedArtifact = await fs.promises.readFile(
    path.join(otaArtifactsDir, 'panel-build', 'job-4.bin'),
    'utf8'
  );

  assert.ok(execCalls.some((entry) => entry.file === 'python3' && entry.args[0] === '--version'));
  assert.ok(execCalls.some((entry) => entry.file === 'python3' && entry.args[0] === '-m' && entry.args[1] === 'venv'));
  assert.ok(execCalls.some((entry) => entry.file === managedPython && entry.args[1] === 'pip'));
  assert.ok(spawnCommands.some((entry) => entry.command === managedPio));
  assert.equal(copiedArtifact, 'firmware-binary');
});

test('updatePanelOtaState can refresh panel lastSeen while the orb is updating', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-ota-touch',
    status: 'updating',
    lastSeen: new Date('2026-04-20T19:15:16.295Z'),
    ota: {
      jobId: 'job-touch',
      status: 'ready',
      phase: 'ready',
      progress: 60,
      previousPanelStatus: 'online'
    },
    async save() {
      return this;
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });

  WallPanel.findById = async () => panelDoc;

  const service = new WallPanelService();
  const previousLastSeen = panelDoc.lastSeen.getTime();
  const result = await service.updatePanelOtaState(
    'panel-ota-touch',
    'job-touch',
    {
      status: 'downloading',
      phase: 'downloading',
      progress: 68
    },
    {
      touchLastSeen: true
    }
  );

  assert.equal(result.status, 'updating');
  assert.equal(result.ota.status, 'downloading');
  assert.equal(result.ota.progress, 68);
  assert.ok(result.lastSeen instanceof Date);
  assert.ok(result.lastSeen.getTime() >= previousLastSeen);
});

test('reportPanelOtaStatus preserves known OTA bytesTotal when download updates omit it', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-ota-report',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    firmwareVersion: 'panel-old',
    ota: {
      jobId: 'job-report',
      status: 'downloading',
      phase: 'downloading',
      progress: 62,
      bytesTransferred: 0,
      bytesTotal: 2_072_784,
      artifactSizeBytes: 2_072_784,
      currentVersion: 'panel-old',
      previousPanelStatus: 'online'
    },
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456'
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });

  WallPanel.findById = async () => panelDoc;

  const service = new WallPanelService();
  let capturedUpdates = null;
  let capturedOptions = null;
  service.updatePanelOtaState = async (panelId, jobId, updates, options) => {
    capturedUpdates = { panelId, jobId, ...updates };
    capturedOptions = options;
    return {
      _id: panelId,
      id: panelId,
      status: 'updating',
      ota: {
        previousPanelStatus: 'online',
        ...updates
      }
    };
  };
  service.serializePanelForResponse = async (panel) => panel;

  await service.reportPanelOtaStatus(
    'panel-ota-report',
    {
      registrationCode: 'HBWP-ABCD-EF12-3456'
    },
    {
      jobId: 'job-report',
      phase: 'downloading',
      progress: 35,
      bytesTransferred: 65_536,
      bytesTotal: 0,
      message: 'Downloading firmware package...'
    }
  );

  assert.equal(capturedUpdates.panelId, 'panel-ota-report');
  assert.equal(capturedUpdates.jobId, 'job-report');
  assert.equal(capturedUpdates.bytesTransferred, 65_536);
  assert.equal(capturedUpdates.bytesTotal, 2_072_784);
  assert.equal(capturedUpdates.phase, 'downloading');
  assert.equal(capturedUpdates.status, 'downloading');
  assert.equal(capturedOptions.allowMissingJob, true);
  assert.equal(capturedOptions.touchLastSeen, true);
});
