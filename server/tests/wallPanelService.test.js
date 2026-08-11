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
const Settings = require('../models/Settings');
const deviceService = require('../services/deviceService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const eventStreamService = require('../services/eventStreamService');
const sceneService = require('../services/sceneService');
const securityAlarmService = require('../services/securityAlarmService');
const harmonyService = require('../services/harmonyService');
const weatherService = require('../services/weatherService');
const wallPanelServiceModule = require('../services/wallPanelService');

const wallPanelService = wallPanelServiceModule;
const { WallPanelService } = wallPanelServiceModule;

function withPanelWifiBuildSettings(t, overrides = {}) {
  const originalGetSettings = Settings.getSettings;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
  });

  Settings.getSettings = async () => ({
    hardwareOrbWifiSsid: 'HomeBrain-Test-WiFi',
    hardwareOrbWifiPassword: 'HomeBrain-Test-Password',
    ...overrides
  });
}

function withoutConfiguredPublicOrigin(t) {
  const originalHomeBrainPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

  t.after(() => {
    if (originalHomeBrainPublicBaseUrl === undefined) {
      delete process.env.HOMEBRAIN_PUBLIC_BASE_URL;
    } else {
      process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalHomeBrainPublicBaseUrl;
    }

    if (originalPublicBaseUrl === undefined) {
      delete process.env.PUBLIC_BASE_URL;
    } else {
      process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
    }
  });

  delete process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
}

function buildTestFirmwareArtifact(version, panelId = 'panel-build', registrationCode = '') {
  return Buffer.from(
    `firmware-binary\\0${version}\\0${panelId}\\0${registrationCode}\\0`
    + 'HomeBrain-Test-WiFi\\0HomeBrain-Test-Password\\0'
  );
}

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

test('activatePanel completes identity recovery for both panel records', async (t) => {
  const originalFindById = WallPanel.findById;
  const cleanedArtifacts = [];

  const sourcePanelDoc = {
    _id: 'panel-source',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    firmwareVersion: 'panel-master-current',
    ota: {
      jobId: 'job-recovery',
      status: 'rebooting',
      phase: 'rebooting',
      progress: 97,
      targetVersion: 'panel-office-recovered',
      recoveryTargetPanelId: 'panel-target',
      artifactPath: '/tmp/job-recovery.bin'
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-MASTER-1234'
    },
    async save() {
      return this;
    },
    toObject() {
      return { ...this };
    }
  };
  const targetPanelDoc = {
    _id: 'panel-target',
    name: 'Office Orb',
    room: 'Office',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    firmwareVersion: 'panel-office-old',
    ota: {
      jobId: 'job-recovery',
      status: 'rebooting',
      phase: 'identity-recovery',
      progress: 97,
      targetVersion: 'panel-office-recovered',
      bytesTransferred: 1,
      recoverySourcePanelId: 'panel-source'
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-OFFICE-1234'
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

  WallPanel.findById = async (panelId) => (
    panelId === 'panel-source' ? sourcePanelDoc : targetPanelDoc
  );

  const service = new WallPanelService();
  service.cleanupOtaArtifactFile = async (artifactPath) => {
    cleanedArtifacts.push(artifactPath);
    return true;
  };
  service.serializePanelForResponse = async (panel) => panel;

  const result = await service.activatePanel('panel-target', {
    registrationCode: 'HBWP-OFFICE-1234'
  }, {
    ipAddress: '192.168.2.2',
    firmwareVersion: 'panel-office-recovered'
  });

  assert.equal(result.status, 'online');
  assert.equal(result.ota.status, 'completed');
  assert.equal(result.ota.recoverySourcePanelId, '');
  assert.equal(sourcePanelDoc.status, 'online');
  assert.equal(sourcePanelDoc.ota.status, 'completed');
  assert.equal(sourcePanelDoc.ota.recoveryTargetPanelId, '');
  assert.equal(sourcePanelDoc.ota.artifactPath, '');
  assert.deepEqual(cleanedArtifacts, ['/tmp/job-recovery.bin']);
});

test('activatePanel fails an OTA when the orb reboots into a different firmware version', async (t) => {
  const originalFindById = WallPanel.findById;
  const cleanupCalls = [];

  const panelDoc = {
    _id: 'panel-2-rollback',
    name: 'Bedroom Panel',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    ipAddress: '',
    firmwareVersion: 'panel-old',
    ota: {
      jobId: 'job-rebooting',
      status: 'rebooting',
      phase: 'rebooting',
      progress: 97,
      targetVersion: 'panel-target',
      currentVersion: 'panel-old',
      bytesTransferred: 2048,
      bytesTotal: 2048,
      artifactPath: '/tmp/job-rebooting.bin',
      message: 'Rebooting into the new HomeBrain firmware.'
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

  const service = new WallPanelService();
  service.cleanupPanelOtaArtifact = async (_panel, artifactPath) => {
    cleanupCalls.push(artifactPath);
  };
  service.serializePanelForResponse = async (panel) => panel;

  const result = await service.activatePanel('panel-2-rollback', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, {
    ipAddress: '192.168.1.45',
    firmwareVersion: 'panel-old'
  });

  assert.equal(result.status, 'online');
  assert.equal(result.ota.status, 'failed');
  assert.equal(result.ota.phase, 'failed');
  assert.equal(result.ota.progress, 0);
  assert.equal(result.ota.currentVersion, 'panel-old');
  assert.match(result.ota.lastError, /instead of OTA target panel-target/i);
  assert.deepEqual(cleanupCalls, ['/tmp/job-rebooting.bin']);
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

test('getPanelState overlays recent realtime device updates for orb brightness', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalDeviceFind = Device.find;
  const originalGetAlarmStatus = securityAlarmService.getAlarmStatus;
  const originalFetchDashboardWeather = weatherService.fetchDashboardWeather;

  const staleLight = {
    _id: 'light-1',
    id: 'light-1',
    name: 'Bedroom Lamp',
    room: 'Bedroom',
    type: 'light',
    status: true,
    brightness: 35,
    properties: {
      brightness: 35
    }
  };
  const panelDoc = {
    _id: 'panel-realtime-state',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: '0.1.0',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      modeOrder: ['room'],
      roomControl: {
        lightDeviceId: 'light-1'
      }
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
    Device.find = originalDeviceFind;
    securityAlarmService.getAlarmStatus = originalGetAlarmStatus;
    weatherService.fetchDashboardWeather = originalFetchDashboardWeather;
    deviceUpdateEmitter.clearLatestDevices();
  });

  WallPanel.findById = async () => panelDoc;
  Device.find = () => ({
    sort: async () => [staleLight]
  });
  securityAlarmService.getAlarmStatus = async () => ({
    alarmState: 'disarmed',
    isArmed: false,
    isTriggered: false
  });
  weatherService.fetchDashboardWeather = async () => null;
  deviceUpdateEmitter.clearLatestDevices();
  deviceUpdateEmitter.emit('devices:update', [{
    ...staleLight,
    brightness: 72,
    properties: {
      brightness: 72
    }
  }]);

  const result = await wallPanelService.getPanelState('panel-realtime-state', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  });

  assert.equal(result.modes.room.centerValue, '72%');
  assert.equal(result.modes.room.knob.value, 72);
  assert.equal(result.modes.room.knob.pressAction.value, 0);
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

test('updatePanel normalizes optional orb category order', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-category-order',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
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
      return { ...this };
    }
  };

  t.after(() => {
    WallPanel.findById = originalFindById;
  });

  WallPanel.findById = async () => panelDoc;

  const result = await wallPanelService.updatePanel('panel-category-order', {
    settings: {
      modeOrder: ['quiet', 'thermostat', 'quiet', 'unknown', 'room']
    }
  });

  assert.deepEqual(result.settings.modeOrder, ['quiet', 'thermostat', 'room']);
  assert.deepEqual(panelDoc.settings.modeOrder, ['quiet', 'thermostat', 'room']);
});

test('getPanelState uses the saved enabled category order', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalDeviceFind = Device.find;
  const originalDeviceFindOne = Device.findOne;
  const originalSceneFind = Scene.find;
  const originalGetAlarmStatus = securityAlarmService.getAlarmStatus;
  const originalGetDeviceById = deviceService.getDeviceById;
  const originalGetHubSnapshot = harmonyService.getHubSnapshot;
  const originalFetchDashboardWeather = weatherService.fetchDashboardWeather;

  const panelDoc = {
    _id: 'panel-category-state',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: '0.1.0',
    settings: {
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      modeOrder: ['quiet', 'room']
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
  securityAlarmService.getAlarmStatus = async () => ({
    alarmState: 'disarmed',
    isArmed: false,
    isTriggered: false
  });
  deviceService.getDeviceById = async () => null;
  harmonyService.getHubSnapshot = async () => null;
  weatherService.fetchDashboardWeather = async () => null;

  const result = await wallPanelService.getPanelState('panel-category-state', {
    registrationCode: 'HBWP-ABCD-EF12-3456'
  }, 'https://example.com');

  assert.deepEqual(result.modeOrder, ['quiet', 'room']);
  assert.equal(result.modeOrder[0], 'quiet');
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
    docker0: [
      {
        family: 'IPv4',
        internal: false,
        address: '172.17.0.1'
      }
    ],
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

  assert.deepEqual(calls[0], ['device', 'thermo-1', 'set_temperature', 71, {
    command: {
      source: 'panel',
      triggerSource: 'wall_panel',
      reason: 'Wall panel Bedroom Orb thermostat.set_temperature',
      actor: 'wall-panel:panel-4'
    }
  }]);
  assert.deepEqual(calls[1], ['scene', 'scene-1', {
    command: {
      source: 'panel',
      triggerSource: 'wall_panel',
      reason: 'Wall panel Bedroom Orb scene.activate',
      actor: 'wall-panel:panel-4'
    }
  }]);
  assert.deepEqual(calls[2], ['device', 'light-1', 'set_brightness', 63, {
    command: {
      source: 'panel',
      triggerSource: 'wall_panel',
      reason: 'Wall panel Bedroom Orb device.control',
      actor: 'wall-panel:panel-4'
    }
  }]);
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

test('getPanelById ignores firmware timestamp churn when the fingerprint is unchanged', async (t) => {
  const originalFindById = WallPanel.findById;

  const panelDoc = {
    _id: 'panel-same-fingerprint',
    name: 'Office Orb',
    room: 'Office',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: 'panel-20260427T153736Z-aa508cf8',
    settings: {
      registered: true,
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      modeOrder: ['room']
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
    value: 'panel-20260501T224312Z-aa508cf8',
    expiresAt: Date.now() + 60_000
  };

  const result = await service.getPanelById('panel-same-fingerprint');

  assert.equal(result.latestFirmwareVersion, 'panel-20260501T224312Z-aa508cf8');
  assert.equal(result.updateAvailable, false);
});

test('pushFirmwareUpdate rejects timestamp-only firmware churn before queuing OTA', async (t) => {
  const originalFindById = WallPanel.findById;
  let saveCount = 0;

  const panelDoc = {
    _id: 'panel-noop-ota',
    name: 'Office Orb',
    room: 'Office',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: 'panel-20260427T153736Z-aa508cf8',
    ota: {
      status: 'idle',
      phase: 'idle'
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-ABCD-EF12-3456',
      claimToken: '',
      claimTokenExpires: null,
      modeOrder: ['room']
    },
    async save() {
      saveCount += 1;
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

  const service = new WallPanelService({
    projectRoot: '/tmp/homebrain',
    panelFirmwareProjectDir: '/tmp/homebrain/embedded/elecrow-wall-panel'
  });
  service.panelFirmwareVersionCache = {
    value: 'panel-20260501T224312Z-aa508cf8',
    expiresAt: Date.now() + 60_000
  };

  await assert.rejects(
    () => service.pushFirmwareUpdate('panel-noop-ota'),
    /already has the latest HomeBrain firmware content/i
  );
  assert.equal(saveCount, 0);
});

test('pushFirmwareUpdate can force a newer build targeted to one private Orb address', async (t) => {
  withPanelWifiBuildSettings(t);
  const originalFindById = WallPanel.findById;
  const panelDoc = {
    _id: 'panel-force-ota',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: 'panel-20260725T031842Z-8154711b',
    ota: {
      status: 'completed',
      phase: 'completed'
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-MASTER-1234'
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

  const service = new WallPanelService();
  service.buildPanelOtaArtifact = async () => {};
  service.serializePanelForResponse = async (panel) => panel;

  const result = await service.pushFirmwareUpdate(
    'panel-force-ota',
    'https://freestonefamily.com',
    {
      force: true,
      expectedIpAddress: '192.168.2.30',
      expectedOrigin: 'http://192.168.2.61:3000'
    }
  );

  assert.equal(result.ota.status, 'queued');
  assert.notEqual(result.ota.targetVersion, panelDoc.firmwareVersion);
  assert.equal(result.ota.deliveryIpAddress, '192.168.2.30');
  assert.equal(result.ota.deliveryOrigin, 'http://192.168.2.61:3000');
});

test('pushPanelIdentityRecovery queues target credentials behind the source identity', async (t) => {
  withPanelWifiBuildSettings(t);
  const originalFindById = WallPanel.findById;
  const buildCalls = [];

  const sourcePanelDoc = {
    _id: 'panel-master',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
    firmwareVersion: 'panel-master-current',
    ota: {
      status: 'completed',
      phase: 'completed'
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-MASTER-1234'
    },
    async save() {
      return this;
    },
    toObject() {
      return { ...this };
    }
  };
  const targetPanelDoc = {
    _id: 'panel-office',
    name: 'Office Orb',
    room: 'Office',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    firmwareVersion: 'panel-office-old',
    ota: {
      jobId: 'job-stuck',
      status: 'downloading',
      artifactPath: '/tmp/job-stuck.bin'
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-OFFICE-1234'
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

  WallPanel.findById = async (panelId) => (
    panelId === 'panel-master' ? sourcePanelDoc : targetPanelDoc
  );

  const service = new WallPanelService();
  service.cleanupOtaArtifactFile = async () => true;
  service.buildPanelIdentityRecoveryArtifact = async (...args) => {
    buildCalls.push(args);
  };
  service.serializePanelForResponse = async (panel) => panel;

  const result = await service.pushPanelIdentityRecovery(
    'panel-master',
    {
      targetPanelId: 'panel-office',
      expectedIpAddress: '192.168.2.2'
    }
  );

  assert.equal(result.sourcePanel.ota.status, 'queued');
  assert.equal(result.sourcePanel.ota.deliveryIpAddress, '192.168.2.2');
  assert.equal(result.sourcePanel.ota.recoveryTargetPanelId, 'panel-office');
  assert.equal(result.targetPanel.ota.status, 'rebooting');
  assert.equal(result.targetPanel.ota.recoverySourcePanelId, 'panel-master');
  assert.equal(result.targetPanel.ota.previousPanelStatus, 'online');
  assert.equal(result.sourcePanel.ota.jobId, result.targetPanel.ota.jobId);
  assert.equal(result.sourcePanel.ota.targetVersion, result.targetPanel.ota.targetVersion);
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0][0].id, 'panel-master');
  assert.equal(buildCalls[0][1].id, 'panel-office');
  assert.equal(buildCalls[0][1].settings.registrationCode, 'HBWP-OFFICE-1234');
});

test('buildPanelOtaArtifact falls back to Homebrew PlatformIO when pio is missing from PATH', async (t) => {
  withPanelWifiBuildSettings(t);
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const targetVersion = 'panel-20240410T000000Z-abc1234';
  const originalPublishSafe = eventStreamService.publishSafe;

  t.after(async () => {
    eventStreamService.publishSafe = originalPublishSafe;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.mkdir(path.dirname(builtArtifactPath), { recursive: true });
  await fs.promises.writeFile(path.join(firmwareDir, 'platformio.ini'), '[env:elecrow-crowpanel-2_1]\n');
  await fs.promises.writeFile(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));

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
        fs.mkdirSync(path.dirname(builtArtifactPath), { recursive: true });
        fs.writeFileSync(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));
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
      targetVersion
    }
  );

  const copiedArtifact = await fs.promises.readFile(
    path.join(otaArtifactsDir, 'panel-build', 'job-1.bin')
  );

  assert.equal(commands[0].command, 'pio');
  assert.ok(commands.some((entry) => entry.command === '/opt/homebrew/bin/pio'));
  assert.ok(commands.some((entry) => entry.envPath.includes('/opt/homebrew/bin')));
  assert.ok(copiedArtifact.includes(Buffer.from(targetVersion)));
});

test('buildPanelOtaArtifact falls back to Linux user-local PlatformIO when PATH is missing it', async (t) => {
  withPanelWifiBuildSettings(t);
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-local-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const targetVersion = 'panel-20240410T000000Z-abc1234';
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
  await fs.promises.writeFile(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));

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
        fs.mkdirSync(path.dirname(builtArtifactPath), { recursive: true });
        fs.writeFileSync(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));
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
      targetVersion
    }
  );

  const copiedArtifact = await fs.promises.readFile(
    path.join(otaArtifactsDir, 'panel-build', 'job-2.bin')
  );

  assert.ok(commands.some((entry) => entry.command === userLocalPlatformio));
  assert.ok(commands.some((entry) => entry.envPath.includes(path.join(homeDir, '.local', 'bin'))));
  assert.ok(copiedArtifact.includes(Buffer.from(targetVersion)));
});

test('buildPanelOtaArtifact keeps trying candidates when python3 lacks the platformio module', async (t) => {
  withPanelWifiBuildSettings(t);
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-python-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const targetVersion = 'panel-20240410T000000Z-abc1234';
  const originalPublishSafe = eventStreamService.publishSafe;

  t.after(async () => {
    eventStreamService.publishSafe = originalPublishSafe;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.mkdir(path.dirname(builtArtifactPath), { recursive: true });
  await fs.promises.writeFile(path.join(firmwareDir, 'platformio.ini'), '[env:elecrow-crowpanel-2_1]\n');
  await fs.promises.writeFile(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));

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
        fs.mkdirSync(path.dirname(builtArtifactPath), { recursive: true });
        fs.writeFileSync(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));
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
      targetVersion
    }
  );

  assert.ok(commands.some((entry) => entry.command === 'python3'));
  assert.ok(commands.some((entry) => entry.command === 'python'));
});

test('buildPanelOtaArtifact bootstraps a private PlatformIO toolchain when none is installed', async (t) => {
  withPanelWifiBuildSettings(t);
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-managed-'));
  const firmwareDir = path.join(tempRoot, 'embedded', 'elecrow-wall-panel');
  const otaArtifactsDir = path.join(tempRoot, 'server', 'data', 'wall-panel-ota');
  const builtArtifactPath = path.join(firmwareDir, '.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin');
  const targetVersion = 'panel-20240410T000000Z-abc1234';
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
  await fs.promises.writeFile(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));

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
        fs.mkdirSync(path.dirname(builtArtifactPath), { recursive: true });
        fs.writeFileSync(builtArtifactPath, buildTestFirmwareArtifact(targetVersion));
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
      targetVersion
    }
  );

  const copiedArtifact = await fs.promises.readFile(
    path.join(otaArtifactsDir, 'panel-build', 'job-4.bin')
  );

  assert.ok(execCalls.some((entry) => entry.file === 'python3' && entry.args[0] === '--version'));
  assert.ok(execCalls.some((entry) => entry.file === 'python3' && entry.args[0] === '-m' && entry.args[1] === 'venv'));
  assert.ok(execCalls.some((entry) => entry.file === managedPython && entry.args[1] === 'pip'));
  assert.ok(spawnCommands.some((entry) => entry.command === managedPio));
  assert.ok(copiedArtifact.includes(Buffer.from(targetVersion)));
});

test('runPanelFirmwareBuild refuses to build when orb Wi-Fi credentials are not configured', async (t) => {
  const service = new WallPanelService();

  await assert.rejects(
    () => service.runPanelFirmwareBuild(
      { id: 'panel-missing-wifi' },
      'job-missing-wifi',
      {
        env: 'elecrow-crowpanel-2_1',
        artifactRelativePath: path.join('.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin')
      },
      {}
    ),
    /Settings > Hardware Orbs/
  );
});

test('createPanelFirmwareBuildEnv refuses missing saved orb Wi-Fi settings', async (t) => {
  withPanelWifiBuildSettings(t, {
    hardwareOrbWifiSsid: '',
    hardwareOrbWifiPassword: ''
  });

  const service = new WallPanelService();

  await assert.rejects(
    () => service.createPanelFirmwareBuildEnv({
      _id: 'panel-missing-wifi-settings',
      id: 'panel-missing-wifi-settings',
      name: 'Kitchen Orb',
      room: 'Kitchen',
      hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
      settings: {
        registrationCode: 'HBWP-1234-5678-90AB'
      }
    }),
    /Settings > Hardware Orbs/
  );
});

test('validatePanelFirmwareArtifact rejects placeholder Wi-Fi credentials', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-artifact-validation-'));
  const artifactPath = path.join(tempRoot, 'firmware.bin');
  const targetVersion = 'panel-20260410T000000Z-abc1234';

  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.writeFile(
    artifactPath,
    Buffer.from(`firmware-binary\\0${targetVersion}\\0YOUR_WIFI_SSID\\0`)
  );

  const service = new WallPanelService();
  await assert.rejects(
    () => service.validatePanelFirmwareArtifact(artifactPath, { targetVersion }),
    /placeholder Wi-Fi credentials/
  );
});

test('validatePanelFirmwareArtifact rejects a firmware image for another panel identity', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-identity-validation-'));
  const artifactPath = path.join(tempRoot, 'firmware.bin');
  const targetVersion = 'panel-20260725T070000Z-abcd';

  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.writeFile(
    artifactPath,
    buildTestFirmwareArtifact(
      targetVersion,
      'master-bedroom-panel',
      'HBWP-MASTER-1234'
    )
  );

  const service = new WallPanelService();
  await assert.rejects(
    () => service.validatePanelFirmwareArtifact(artifactPath, {
      targetVersion,
      panelId: 'office-panel',
      registrationCode: 'HBWP-OFFICE-1234'
    }),
    /wrong panel identity/i
  );
});

test('getPanelOtaArtifact hides a targeted package from a different delivery path', async (t) => {
  const originalFindById = WallPanel.findById;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-targeted-ota-'));
  const artifactPath = path.join(tempRoot, 'firmware.bin');
  await fs.promises.writeFile(artifactPath, Buffer.from('targeted firmware'));

  const panelDoc = {
    _id: 'panel-targeted-download',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    firmwareVersion: 'panel-old',
    ota: {
      jobId: 'job-targeted',
      status: 'ready',
      targetVersion: 'panel-new',
      artifactPath,
      deliveryIpAddress: '192.168.2.2',
      deliveryOrigin: 'https://freestonefamily.com'
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-MASTER-1234'
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(async () => {
    WallPanel.findById = originalFindById;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  WallPanel.findById = async () => panelDoc;
  const service = new WallPanelService({ panelOtaArtifactsDir: tempRoot });

  await assert.rejects(
    () => service.getPanelOtaArtifact(
      'panel-targeted-download',
      { registrationCode: 'HBWP-MASTER-1234' },
      'https://freestonefamily.com',
      '192.168.2.30',
      'http://192.168.2.61:3000'
    ),
    /No OTA package is available/i
  );

  const artifact = await service.getPanelOtaArtifact(
    'panel-targeted-download',
    { registrationCode: 'HBWP-MASTER-1234' },
    'https://freestonefamily.com',
    '203.0.113.10',
    'https://freestonefamily.com'
  );
  assert.equal(artifact.artifactPath, await fs.promises.realpath(artifactPath));
});

test('getPanelOtaArtifact rejects files outside the managed OTA directory', async (t) => {
  const originalFindById = WallPanel.findById;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-ota-boundary-'));
  const managedDir = path.join(tempRoot, 'managed');
  const outsideArtifactPath = path.join(tempRoot, 'outside.bin');
  const linkedArtifactPath = path.join(managedDir, 'linked.bin');
  await fs.promises.mkdir(managedDir, { recursive: true });
  await fs.promises.writeFile(outsideArtifactPath, Buffer.from('unmanaged firmware'));
  await fs.promises.symlink(outsideArtifactPath, linkedArtifactPath);

  const panelDoc = {
    _id: 'panel-unmanaged-download',
    name: 'Unmanaged Orb',
    room: 'Office',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    firmwareVersion: 'panel-old',
    ota: {
      jobId: 'job-unmanaged',
      status: 'ready',
      targetVersion: 'panel-new',
      artifactPath: outsideArtifactPath
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-OFFICE-1234'
    },
    toObject() {
      return { ...this };
    }
  };

  t.after(async () => {
    WallPanel.findById = originalFindById;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  WallPanel.findById = async () => panelDoc;
  const service = new WallPanelService({ panelOtaArtifactsDir: managedDir });

  await assert.rejects(
    () => service.getPanelOtaArtifact(
      'panel-unmanaged-download',
      { registrationCode: 'HBWP-OFFICE-1234' },
      'https://freestonefamily.com',
      '203.0.113.10',
      'https://freestonefamily.com'
    ),
    /no longer available/i
  );

  panelDoc.ota.artifactPath = linkedArtifactPath;
  await assert.rejects(
    () => service.getPanelOtaArtifact(
      'panel-unmanaged-download',
      { registrationCode: 'HBWP-OFFICE-1234' },
      'https://freestonefamily.com',
      '203.0.113.10',
      'https://freestonefamily.com'
    ),
    /no longer available/i
  );
});

test('createPanelFirmwareBuildEnv injects per-orb firmware credentials', async (t) => {
  withPanelWifiBuildSettings(t);
  withoutConfiguredPublicOrigin(t);
  const originalNetworkInterfaces = os.networkInterfaces;
  t.after(() => {
    os.networkInterfaces = originalNetworkInterfaces;
  });
  os.networkInterfaces = () => ({
    en0: [
      {
        family: 'IPv4',
        internal: false,
        address: '192.168.2.32'
      }
    ]
  });

  const service = new WallPanelService();
  const env = await service.createPanelFirmwareBuildEnv({
    _id: 'panel-usb-env',
    id: 'panel-usb-env',
    name: 'Kitchen Orb',
    room: 'Kitchen',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    ipAddress: '192.168.2.38',
    settings: {
      registrationCode: 'HBWP-1234-5678-90AB'
    }
  }, {
    targetVersion: 'panel-20260421T210000Z-test',
    origin: 'http://homebrain.local:3000'
  });

  assert.equal(env.HOMEBRAIN_PANEL_BUILD_VERSION, 'panel-20260421T210000Z-test');
  assert.equal(env.HOMEBRAIN_PANEL_HUB_URL, 'http://homebrain.local:3000');
  assert.equal(env.HOMEBRAIN_PANEL_ID, 'panel-usb-env');
  assert.equal(env.HOMEBRAIN_PANEL_REGISTRATION_CODE, 'HBWP-1234-5678-90AB');
  assert.equal(env.HOMEBRAIN_PANEL_HOSTNAME, 'homebrain-kitchen-orb');
  assert.equal(env.HOMEBRAIN_PANEL_WIFI_SSID, 'HomeBrain-Test-WiFi');
  assert.equal(env.HOMEBRAIN_PANEL_WIFI_PASSWORD, 'HomeBrain-Test-Password');
});

test('createPanelFirmwareBuildEnv never embeds a DHCP-derived IP address', async (t) => {
  withPanelWifiBuildSettings(t);
  withoutConfiguredPublicOrigin(t);
  const service = new WallPanelService();
  const env = await service.createPanelFirmwareBuildEnv({
    _id: 'panel-stable-hub',
    id: 'panel-stable-hub',
    name: 'Office Orb',
    room: 'Office',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    ipAddress: '192.168.2.38',
    settings: {
      registrationCode: 'HBWP-1234-5678-90AB'
    }
  }, {
    targetVersion: 'panel-20260725T060000Z-test',
    origin: 'http://192.168.2.32:3000'
  });

  assert.equal(env.HOMEBRAIN_PANEL_HUB_URL, 'http://homebrain.local:3000');
});

test('createPanelFirmwareBuildEnv prefers the configured public hostname', async (t) => {
  withPanelWifiBuildSettings(t);
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  t.after(() => {
    if (originalPublicBaseUrl === undefined) {
      delete process.env.HOMEBRAIN_PUBLIC_BASE_URL;
    } else {
      process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
    }
  });
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://freestonefamily.com';

  const service = new WallPanelService();
  const env = await service.createPanelFirmwareBuildEnv({
    _id: 'panel-public-hub',
    id: 'panel-public-hub',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    ipAddress: '192.168.2.2',
    settings: {
      registrationCode: 'HBWP-1234-5678-90AB'
    }
  }, {
    targetVersion: 'panel-20260725T060100Z-test',
    origin: 'http://192.168.2.32:3000'
  });

  assert.equal(env.HOMEBRAIN_PANEL_HUB_URL, 'https://freestonefamily.com');
});

test('runExclusivePanelFirmwareTask serializes shared PlatformIO work', async () => {
  const service = new WallPanelService();
  const steps = [];
  let releaseFirstTask;
  const firstTaskGate = new Promise((resolve) => {
    releaseFirstTask = resolve;
  });

  const firstTask = service.runExclusivePanelFirmwareTask(async () => {
    steps.push('first-started');
    await firstTaskGate;
    steps.push('first-finished');
  });
  const secondTask = service.runExclusivePanelFirmwareTask(async () => {
    steps.push('second-started');
    steps.push('second-finished');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ['first-started']);

  releaseFirstTask();
  await Promise.all([firstTask, secondTask]);
  assert.deepEqual(steps, [
    'first-started',
    'first-finished',
    'second-started',
    'second-finished'
  ]);
});

test('runExclusivePanelFirmwareTask releases the queue after a failed build', async () => {
  const service = new WallPanelService();

  await assert.rejects(
    () => service.runExclusivePanelFirmwareTask(async () => {
      throw new Error('simulated build failure');
    }),
    /simulated build failure/
  );

  const result = await service.runExclusivePanelFirmwareTask(async () => 'next build ran');
  assert.equal(result, 'next build ran');
});

test('listProvisioningUsbPorts selects a single Espressif USB serial candidate', async () => {
  const service = new WallPanelService();
  service._serialPortModule = {
    list: async () => [
      {
        path: '/dev/ttyACM0',
        manufacturer: 'Espressif',
        friendlyName: 'USB JTAG/serial debug unit',
        vendorId: '303A',
        productId: '1001'
      }
    ]
  };
  service.getSerialByIdEntries = async () => [];
  service.scanFallbackSerialDevices = async () => [];

  const result = await service.listProvisioningUsbPorts();

  assert.equal(result.count, 1);
  assert.equal(result.selectedPort.path, '/dev/ttyACM0');
  assert.equal(result.selectedPort.likelyPanel, true);
});

test('listProvisioningUsbPorts ignores FTDI-style PLM serial ports when selecting the orb USB port', async () => {
  const service = new WallPanelService();
  service._serialPortModule = {
    list: async () => [
      {
        path: '/dev/ttyUSB0',
        manufacturer: 'FTDI',
        friendlyName: 'USB Serial Port',
        vendorId: '0403',
        productId: '6001'
      },
      {
        path: '/dev/ttyACM0',
        manufacturer: 'Espressif',
        friendlyName: 'USB JTAG/serial debug unit',
        vendorId: '303A',
        productId: '1001'
      }
    ]
  };
  service.getSerialByIdEntries = async () => [
    {
      symlinkPath: '/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A10XYZ-if00-port0',
      resolvedPath: '/dev/ttyUSB0',
      friendlyName: 'usb-FTDI_FT232R_USB_UART_A10XYZ-if00-port0'
    },
    {
      symlinkPath: '/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_ABC-if00',
      resolvedPath: '/dev/ttyACM0',
      friendlyName: 'usb-Espressif_USB_JTAG_serial_debug_unit_ABC-if00'
    }
  ];
  service.scanFallbackSerialDevices = async () => [];

  const result = await service.listProvisioningUsbPorts();
  const plmPort = result.ports.find((port) => port.path === '/dev/ttyUSB0');

  assert.equal(result.count, 2);
  assert.equal(result.selectedPort.path, '/dev/ttyACM0');
  assert.equal(result.selectedPort.stablePath, '/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_ABC-if00');
  assert.equal(result.selectedPort.likelyPanel, true);
  assert.equal(plmPort.likelyPanel, false);

  const resolved = await service.resolveProvisioningUsbPort();
  assert.equal(resolved.path, '/dev/ttyACM0');
});

test('flashPanelInitialFirmware uploads to the selected USB port with per-panel build env', async (t) => {
  withPanelWifiBuildSettings(t);
  withoutConfiguredPublicOrigin(t);
  const originalFindById = WallPanel.findById;
  const originalPublishSafe = eventStreamService.publishSafe;
  const uploadCommands = [];
  let capturedBuildEnv = null;

  const panelDoc = {
    _id: 'panel-usb-flash',
    id: 'panel-usb-flash',
    name: 'Kitchen Orb',
    room: 'Kitchen',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    firmwareVersion: '',
    ota: {
      jobId: 'job-usb-flash',
      status: 'queued',
      phase: 'usb-queued',
      progress: 4,
      previousPanelStatus: 'offline'
    },
    settings: {
      registrationCode: 'HBWP-1234-5678-90AB'
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
    eventStreamService.publishSafe = originalPublishSafe;
  });

  WallPanel.findById = async () => panelDoc;
  eventStreamService.publishSafe = async () => {};

  const service = new WallPanelService({
    spawnProcess: (command, args, options) => {
      uploadCommands.push({ command, args, env: options?.env || {} });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.write('Writing at 0x00010000...\n');
        child.stdout.write('Hash of data verified.\n');
        child.stdout.write('SUCCESS\n');
        child.emit('close', 0);
      });
      return child;
    }
  });
  service.runPanelFirmwareBuild = async (_panel, _jobId, _buildTarget, processEnv) => {
    capturedBuildEnv = processEnv;
    return {
      command: 'pio',
      args: [],
      label: 'pio'
    };
  };
  service.validatePanelFirmwareArtifact = async (_artifactPath, expected) => {
    assert.equal(expected.targetVersion, 'panel-20260421T210500Z-test');
    assert.equal(expected.panelId, 'panel-usb-flash');
    assert.equal(expected.registrationCode, 'HBWP-1234-5678-90AB');
    return 1024;
  };

  await service.flashPanelInitialFirmware(panelDoc, {
    jobId: 'job-usb-flash',
    targetVersion: 'panel-20260421T210500Z-test',
    origin: 'http://homebrain.local:3000',
    serialPath: '/dev/ttyACM0'
  });

  assert.equal(capturedBuildEnv.HOMEBRAIN_PANEL_ID, 'panel-usb-flash');
  assert.equal(capturedBuildEnv.HOMEBRAIN_PANEL_REGISTRATION_CODE, 'HBWP-1234-5678-90AB');
  assert.equal(capturedBuildEnv.HOMEBRAIN_PANEL_HUB_URL, 'http://homebrain.local:3000');
  assert.equal(capturedBuildEnv.HOMEBRAIN_PANEL_WIFI_SSID, 'HomeBrain-Test-WiFi');
  assert.equal(capturedBuildEnv.HOMEBRAIN_PANEL_WIFI_PASSWORD, 'HomeBrain-Test-Password');
  assert.equal(uploadCommands.length, 1);
  assert.deepEqual(uploadCommands[0].args.slice(-2), ['--upload-port', '/dev/ttyACM0']);
  assert.equal(panelDoc.status, 'offline');
  assert.equal(panelDoc.ota.status, 'provisioned');
  assert.equal(panelDoc.ota.phase, 'usb-provisioned');
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

test('cancelPanelOtaJob cancels an active OTA and removes the staged artifact', async (t) => {
  const originalFindById = WallPanel.findById;
  const originalPublishSafe = eventStreamService.publishSafe;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wall-panel-cancel-'));
  const artifactPath = path.join(tempRoot, 'server', 'data', 'wall-panel-ota', 'panel-cancel', 'job-cancel.bin');

  const panelDoc = {
    _id: 'panel-cancel',
    name: 'Office Orb',
    room: 'Office',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    firmwareVersion: 'panel-20260427T153736Z-aa508cf8',
    ota: {
      jobId: 'job-cancel',
      status: 'ready',
      phase: 'ready',
      progress: 60,
      targetVersion: 'panel-20260501T224312Z-aa508cf8',
      currentVersion: 'panel-20260427T153736Z-aa508cf8',
      message: 'Firmware package is ready.',
      previousPanelStatus: 'online',
      artifactPath,
      artifactSizeBytes: 8,
      bytesTransferred: 0,
      bytesTotal: 8
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-ABCD-EF12-3456'
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
    eventStreamService.publishSafe = originalPublishSafe;
  });
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.promises.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.promises.writeFile(artifactPath, Buffer.from('firmware'));

  WallPanel.findById = async () => panelDoc;
  eventStreamService.publishSafe = async () => {};

  const service = new WallPanelService({
    projectRoot: tempRoot,
    panelOtaArtifactsDir: path.join(tempRoot, 'server', 'data', 'wall-panel-ota')
  });

  const result = await service.cancelPanelOtaJob('panel-cancel', {
    reason: 'Cancelled from test.'
  });

  assert.equal(result.status, 'online');
  assert.equal(result.ota.status, 'cancelled');
  assert.equal(result.ota.phase, 'cancelled');
  assert.equal(result.ota.progress, 0);
  assert.equal(result.ota.message, 'Cancelled from test.');
  assert.equal(panelDoc.ota.artifactPath, '');
  assert.equal(await fs.promises.stat(artifactPath).catch(() => null), null);
});

test('pushFirmwareUpdate recovers a stale orb OTA build before queuing a new update', async (t) => {
  withPanelWifiBuildSettings(t);
  const originalFindById = WallPanel.findById;
  const recoveredJobs = [];

  const panelDoc = {
    _id: 'panel-stale-build',
    name: 'Master Bedroom Orb',
    room: 'Master Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'updating',
    firmwareVersion: 'panel-old',
    ota: {
      jobId: 'job-stale-build',
      status: 'building',
      phase: 'building',
      progress: 24,
      targetVersion: 'panel-target-old',
      currentVersion: 'panel-old',
      message: 'Compiling wall panel firmware...',
      updatedAt: new Date(Date.now() - (3 * 60 * 1000)),
      startedAt: new Date(Date.now() - (3 * 60 * 1000)),
      requestedAt: new Date(Date.now() - (3 * 60 * 1000)),
      previousPanelStatus: 'online',
      artifactPath: '',
      artifactSizeBytes: 0,
      bytesTransferred: 0,
      bytesTotal: 0
    },
    settings: {
      registered: true,
      registrationCode: 'HBWP-ABCD-EF12-3456'
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

  const service = new WallPanelService();
  service.getLatestPanelFirmwareVersion = async () => 'panel-20260420T205435Z-b36dc043';
  service.failPanelOtaJob = async (panelId, jobId, error) => {
    recoveredJobs.push({ panelId, jobId, message: error.message });
    panelDoc.status = 'online';
    panelDoc.ota = {
      jobId,
      status: 'failed',
      phase: 'failed',
      progress: 0,
      targetVersion: panelDoc.ota.targetVersion,
      currentVersion: panelDoc.firmwareVersion,
      message: error.message,
      lastError: error.message,
      previousPanelStatus: 'online'
    };
  };
  service.buildPanelOtaArtifact = async () => {};
  service.serializePanelForResponse = async (panel) => panel;

  const result = await service.pushFirmwareUpdate('panel-stale-build');

  assert.equal(recoveredJobs.length, 1);
  assert.equal(recoveredJobs[0].panelId, 'panel-stale-build');
  assert.equal(recoveredJobs[0].jobId, 'job-stale-build');
  assert.match(recoveredJobs[0].message, /stale orb OTA build/i);
  assert.notEqual(result.ota.jobId, 'job-stale-build');
  assert.equal(result.ota.status, 'queued');
  assert.equal(result.ota.targetVersion, 'panel-20260420T205435Z-b36dc043');
});
