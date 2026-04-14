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

  const panelDoc = {
    _id: 'panel-6',
    name: 'Bedroom Orb',
    room: 'Bedroom',
    hardwareProfile: 'elecrow-crowpanel-2.1-rotary',
    status: 'online',
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

  WallPanel.findById = async () => panelDoc;

  const result = await wallPanelService.rotateRegistrationCode('panel-6', 'https://example.com');

  assert.equal(result.panel.status, 'offline');
  assert.equal(result.panel.settings.registered, false);
  assert.match(result.panel.settings.registrationCode, /^HBWP-/);
  assert.notEqual(result.panel.settings.registrationCode, 'HBWP-ABCD-EF12-3456');
  assert.equal(result.provisioning.firmwareHeader.HOMEBRAIN_PANEL_HUB_URL, 'https://example.com');
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
