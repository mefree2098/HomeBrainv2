const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const zwave = require('zwave-js');

const directRadioService = require('../services/directRadioService');
const directRadioProtocolCatalogService = require('../services/directRadioProtocolCatalogService');

const DirectRadioService = directRadioService.DirectRadioService;
const {
  isZWaveNodeCommandReady,
  isZWaveNodeCommandProbeCandidate,
  isZWaveNodeOnline
} = directRadioService._test;

test('Z-Wave driver uses fast persistent cache writes by default', async (t) => {
  const originalLoad = Module._load;
  const originalThrottle = process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE;
  let capturedOptions = null;

  delete process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE;

  class FakeDriver {
    constructor(_serialPath, options) {
      capturedOptions = options;
      this.controller = { homeId: 1234 };
    }

    on() {}

    async start() {}
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'zwave-js') {
      return {
        Driver: FakeDriver,
        SecurityClass: {
          S2_AccessControl: 1,
          S2_Authenticated: 2,
          S2_Unauthenticated: 3,
          S0_Legacy: 4
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  t.after(() => {
    Module._load = originalLoad;
    if (originalThrottle === undefined) {
      delete process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE;
    } else {
      process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE = originalThrottle;
    }
  });

  const service = new DirectRadioService();
  service.ensureControllerConfig = async () => ({
    zwave: {
      securityKeys: {
        S2_AccessControl: '11111111111111111111111111111111',
        S2_Authenticated: '22222222222222222222222222222222',
        S2_Unauthenticated: '33333333333333333333333333333333',
        S0_Legacy: '44444444444444444444444444444444'
      },
      securityKeysLongRange: {
        S2_AccessControl: '55555555555555555555555555555555',
        S2_Authenticated: '66666666666666666666666666666666'
      }
    }
  });

  await service.startZWave('/dev/ttyUSB-test');

  assert.equal(capturedOptions.storage.throttle, 'fast');
  assert.match(capturedOptions.storage.cacheDir, /zwave[\\/]cache$/);
  assert.match(capturedOptions.storage.lockDir, /zwave[\\/]locks$/);
  assert.equal(capturedOptions.logConfig.enabled, true);
  assert.equal(capturedOptions.logConfig.logToFile, true);
  assert.equal(capturedOptions.logConfig.level, 'debug');
  assert.match(capturedOptions.logConfig.filename, /zwave[\\/]logs[\\/]zwavejs_%DATE%\.log$/);
});

test('Z-Wave inclusion callbacks use zwave-js core security classes', async () => {
  const service = new DirectRadioService();
  const core = require('@zwave-js/core');

  const callbacks = service.buildZWaveInclusionCallbacks({});
  const grant = await callbacks.grantSecurityClasses({});

  assert.deepEqual(grant.securityClasses, [
    core.SecurityClass.S2_AccessControl,
    core.SecurityClass.S2_Authenticated,
    core.SecurityClass.S2_Unauthenticated,
    core.SecurityClass.S0_Legacy
  ]);
  assert.equal(grant.clientSideAuth, false);
});

test('direct radio shutdown closes Z-Wave driver before Zigbee controller', async () => {
  const service = new DirectRadioService();
  const calls = [];

  service.stopPairing = async () => {
    calls.push('pairing');
  };

  service.zwave.driver = {
    destroy: async () => {
      calls.push('zwave');
    }
  };
  service.zwave.started = true;

  service.zigbee.controller = {
    stop: async () => {
      calls.push('zigbee');
    }
  };
  service.zigbee.started = true;

  await service.shutdown();

  assert.deepEqual(calls, ['pairing', 'zwave', 'zigbee']);
  assert.equal(service.zwave.driver, null);
  assert.equal(service.zigbee.controller, null);
  assert.equal(service.zwave.started, false);
  assert.equal(service.zigbee.started, false);
});

function sirenVolumeCatalogParameter(overrides = {}) {
  return {
    parameter: 37,
    valueBitMask: 0xff,
    label: 'Volume',
    minValue: 1,
    maxValue: 3,
    defaultValue: 3,
    allowManualEntry: true,
    options: [
      { label: 'Low', value: 1 },
      { label: 'Medium', value: 2 },
      { label: 'High', value: 3 }
    ],
    ...overrides
  };
}

function sirenSoundCatalogParameter(overrides = {}) {
  return {
    parameter: 37,
    valueBitMask: 0xff00,
    label: 'Siren Sound',
    minValue: 1,
    maxValue: 5,
    defaultValue: 1,
    allowManualEntry: false,
    options: [
      { label: 'Sound 1', value: 1 },
      { label: 'Sound 2', value: 2 },
      { label: 'Sound 3', value: 3 },
      { label: 'Sound 4', value: 4 },
      { label: 'Sound 5', value: 5 }
    ],
    ...overrides
  };
}

function nativeSirenDevice(overrides = {}) {
  return {
    _id: 'native-siren-1',
    name: 'Kitchen Siren',
    type: 'siren',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: 8
      },
      directRadioFeatures: ['alarm', 'switch'],
      supportsAlarm: true,
      directRadioCatalog: {
        protocol: 'zwave',
        configParameters: [sirenSoundCatalogParameter(), sirenVolumeCatalogParameter()]
      }
    },
    ...overrides
  };
}

function zwaveNode(overrides = {}) {
  return {
    id: 8,
    ready: true,
    status: 4,
    interviewStage: 5,
    isControllerNode: false,
    isListening: true,
    valueDB: {
      hasValue: () => false,
      getValue: () => undefined
    },
    ...overrides
  };
}

test('Z-Wave readiness treats dead or incomplete nodes as offline', () => {
  const service = new DirectRadioService();
  const deadNode = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 1
  });
  const aliveNode = zwaveNode();

  const deadUpdate = service.normalizeZWaveNode(deadNode, 'sync').update;
  const aliveUpdate = service.normalizeZWaveNode(aliveNode, 'sync').update;

  assert.equal(isZWaveNodeOnline(deadNode), false);
  assert.equal(isZWaveNodeCommandReady(deadNode), false);
  assert.equal(deadUpdate.isOnline, false);
  assert.equal(deadUpdate.properties.homebrainDirect.ready, false);
  assert.equal(deadUpdate.properties.homebrainDirect.status, 3);

  assert.equal(isZWaveNodeOnline(aliveNode), true);
  assert.equal(isZWaveNodeCommandReady(aliveNode), true);
  assert.equal(aliveUpdate.isOnline, true);
  assert.equal(aliveUpdate.properties.homebrainDirect.ready, true);
});

test('Z-Wave readiness accepts a fresh probe for interviewed listening nodes', () => {
  const service = new DirectRadioService();
  const probedNode = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 5,
    isListening: true,
    manufacturerId: 134,
    productType: 260,
    productId: 80,
    deviceConfig: {
      manufacturer: 'AEON Labs',
      label: 'ZW080'
    },
    __homebrainReachabilityProbe: {
      ok: true,
      at: Date.now(),
      reason: 'command',
      source: 'ping'
    }
  });

  const update = service.normalizeZWaveNode(probedNode, 'sync').update;

  assert.equal(isZWaveNodeCommandProbeCandidate(probedNode), true);
  assert.equal(isZWaveNodeOnline(probedNode), true);
  assert.equal(isZWaveNodeCommandReady(probedNode), true);
  assert.equal(update.isOnline, true);
  assert.equal(update.properties.homebrainDirect.ready, true);
  assert.equal(update.properties.homebrainDirect.status, 4);
  assert.equal(update.properties.homebrainDirect.controllerReady, false);
  assert.equal(update.properties.homebrainDirect.controllerStatus, 3);
  assert.equal(update.properties.homebrainDirect.lastReachabilityProbeReason, 'command');
});

test('Z-Wave siren sound command probes stale interviewed listening nodes before rejecting them', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 5,
      isListening: true,
      manufacturerId: 134,
      productType: 260,
      productId: 80,
      deviceConfig: {
        manufacturer: 'AEON Labs',
        label: 'ZW080'
      }
    }),
    ping: async () => {
      pingCount += 1;
      return true;
    },
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 2', updateData);

  assert.equal(pingCount, 1);
  assert.equal(setCalls.length, 1);
  assert.equal(updateData.isOnline, true);
  assert.equal(updateData.properties.homebrainDirect.ready, true);
  assert.equal(updateData.properties.homebrainDirect.status, 4);
  assert.equal(updateData.properties.homebrainDirect.controllerReady, false);
  assert.equal(updateData.properties.homebrainDirect.controllerStatus, 3);
  assert.equal(updateData.properties.homebrainDirect.lastCommandAcceptedAt.length > 0, true);
  assert.equal(updateData.properties.sirenSound, 2);
});

test('Z-Wave siren sound command rejects known devices when readiness ping fails', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 5,
      isListening: true,
      manufacturerId: 134,
      productType: 260,
      productId: 80,
      deviceConfig: {
        manufacturer: 'AEON Labs',
        label: 'ZW080'
      }
    }),
    ping: async () => {
      pingCount += 1;
      return false;
    },
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await assert.rejects(
    () => service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 4', updateData),
    /Z-Wave node is not ready/
  );

  assert.equal(pingCount, 1);
  assert.equal(setCalls.length, 0);
  assert.deepEqual(updateData, {});
});

test('Z-Wave siren sound command probes generic controller shells when the HomeBrain device identity is preserved', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 1,
      isListening: true,
      manufacturerId: null,
      productType: null,
      productId: null,
      manufacturer: null,
      productLabel: null,
      deviceConfig: null
    }),
    ping: async () => {
      pingCount += 1;
      return true;
    },
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  assert.equal(isZWaveNodeCommandProbeCandidate(node), false);
  assert.equal(isZWaveNodeCommandReady(node), false);

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 3', updateData);

  assert.equal(pingCount, 1);
  assert.equal(setCalls.length, 1);
  assert.equal(isZWaveNodeCommandReady(node), true);
  assert.equal(node.__homebrainReachabilityProbe.knownDeviceIdentity, true);
  assert.equal(updateData.isOnline, true);
  assert.equal(updateData.properties.homebrainDirect.ready, true);
  assert.equal(updateData.properties.homebrainDirect.status, 4);
  assert.equal(updateData.properties.homebrainDirect.controllerReady, false);
  assert.equal(updateData.properties.homebrainDirect.controllerStatus, 3);
  assert.equal(updateData.properties.homebrainDirect.lastCommandAcceptedAt.length > 0, true);
  assert.equal(updateData.properties.sirenSound, 3);
});

test('Z-Wave startup sync does not probe generic controller shells', async () => {
  const service = new DirectRadioService();
  let pingCount = 0;
  let changedReason = null;
  const node = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 1,
    isListening: true,
    manufacturerId: null,
    productType: null,
    productId: null,
    manufacturer: null,
    productLabel: null,
    deviceConfig: null,
    ping: async () => {
      pingCount += 1;
      return true;
    }
  });
  service.getZWaveControllerNodes = () => new Map([[node.id, node]]);
  service.findDeviceForZWaveNode = async () => null;
  service.handleZWaveNodeChanged = async (_node, reason) => {
    changedReason = reason;
  };

  await service.syncZWaveNodes();

  assert.equal(pingCount, 0);
  assert.equal(changedReason, 'sync');
  assert.equal(isZWaveNodeCommandReady(node), false);
  assert.equal(node.__homebrainReachabilityProbe, undefined);
});

test('Z-Wave startup sync schedules recovery for known incomplete sirens without persisting offline', async () => {
  const service = new DirectRadioService();
  const node = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 1,
    isListening: true,
    manufacturerId: null,
    productType: null,
    productId: null,
    deviceConfig: null
  });
  const changedReasons = [];
  let scheduledRecovery = null;

  service.getZWaveControllerNodes = () => new Map([[node.id, node]]);
  service.findDeviceForZWaveNode = async () => nativeSirenDevice({
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: String(node.id),
        manufacturerId: 634,
        productType: 4,
        productId: 873
      },
      directRadioFeatures: ['alarm', 'switch'],
      supportsAlarm: true
    }
  });
  service.handleZWaveNodeChanged = async (_node, reason) => {
    changedReasons.push(reason);
  };
  service.scheduleZWaveNodeRouteRecovery = (scheduledNode, reason, options = {}) => {
    scheduledRecovery = { node: scheduledNode, reason, options };
    return true;
  };

  await service.syncZWaveNodes();

  assert.deepEqual(changedReasons, []);
  assert.equal(scheduledRecovery.node, node);
  assert.equal(scheduledRecovery.reason, 'startup sync');
  assert.equal(scheduledRecovery.options.persistFailure, false);
  assert.equal(scheduledRecovery.options.device.properties.homebrainDirect.nodeId, String(node.id));
});

test('Z-Wave interview failure defers persistence while known siren recovery is pending', async () => {
  const service = new DirectRadioService();
  const node = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 1,
    isListening: true,
    manufacturerId: null,
    productType: null,
    productId: null,
    deviceConfig: null
  });

  node.__homebrainKnownRecoveryDevice = nativeSirenDevice({
    properties: {
      source: 'homebrain-zwave',
      homebrainDirect: {
        protocol: 'zwave',
        nodeId: String(node.id),
        manufacturerId: 634,
        productType: 4,
        productId: 873
      },
      directRadioFeatures: ['alarm', 'switch'],
      supportsAlarm: true
    }
  });

  const recoveryMap = service.getZWaveNodeRouteRecoveryMap();
  recoveryMap.set(node.id, {
    scheduledAt: Date.now()
  });

  const deferred = service.shouldDeferZWaveFailurePersistence(node, 'interview failed');

  assert.equal(deferred, true);
});

test('Z-Wave startup sync does not persist known sirens before startup recovery proves reachability', async () => {
  const service = new DirectRadioService();
  const node = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 5,
    isListening: true,
    manufacturerId: 634,
    productType: 4,
    productId: 873,
    deviceConfig: {
      manufacturer: 'Zooz',
      label: 'ZSE50'
    }
  });
  const changedReasons = [];
  let scheduledRecovery = null;

  service.getZWaveControllerNodes = () => new Map([[node.id, node]]);
  service.handleZWaveNodeChanged = async (_node, reason) => {
    changedReasons.push(reason);
  };
  service.scheduleZWaveNodeRouteRecovery = (scheduledNode, reason, options = {}) => {
    scheduledRecovery = { node: scheduledNode, reason, options };
    return true;
  };

  await service.syncZWaveNodes();

  assert.deepEqual(changedReasons, []);
  assert.equal(scheduledRecovery.node, node);
  assert.equal(scheduledRecovery.reason, 'startup sync');
  assert.equal(scheduledRecovery.options.persistFailure, false);
});

test('Z-Wave route recovery rebuilds routes for interviewed listening nodes', async () => {
  const service = new DirectRadioService();
  const rebuildCalls = [];
  const changedReasons = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 5,
      isListening: true,
      manufacturerId: 134,
      productType: 260,
      productId: 80,
      deviceConfig: {
        manufacturer: 'AEON Labs',
        label: 'ZW080'
      }
    }),
    on: () => {},
    ping: async () => {
      pingCount += 1;
      return pingCount >= 2;
    }
  };
  const controller = {
    rebuildNodeRoutes: async (nodeId) => {
      rebuildCalls.push(nodeId);
      return true;
    }
  };
  service.start = async () => {};
  service.getZWaveController = () => controller;
  service.getZWaveControllerNodes = () => new Map([[node.id, node]]);
  service.findDeviceForZWaveNode = async () => nativeSirenDevice();
  service.handleZWaveNodeChanged = async (_node, reason) => {
    changedReasons.push(reason);
  };

  const result = await service.recoverZWaveNodeRoutes(node.id, {
    reason: 'test recovery',
    pingTimeoutMs: 1000,
    routeRebuildTimeoutMs: 1000
  });

  assert.equal(pingCount, 2);
  assert.deepEqual(rebuildCalls, [node.id]);
  assert.equal(result.recovered, true);
  assert.equal(result.routeRebuilt, true);
  assert.equal(isZWaveNodeCommandReady(node), true);
  assert.equal(changedReasons.includes('route recovery ping recovered'), true);
});

test('automatic Z-Wave startup route recovery does not persist failed siren reachability', async () => {
  const service = new DirectRadioService();
  const node = zwaveNode({
    ready: false,
    status: 3,
    interviewStage: 5,
    isListening: true,
    manufacturerId: 634,
    productType: 4,
    productId: 873,
    deviceConfig: {
      manufacturer: 'Zooz',
      label: 'ZSE50'
    }
  });
  const rebuildCalls = [];
  const probeReasons = [];
  const changedReasons = [];
  const controller = {
    rebuildNodeRoutes: async (nodeId) => {
      rebuildCalls.push(nodeId);
      return false;
    }
  };

  service.handleZWaveNodeChanged = async (_node, reason) => {
    changedReasons.push(reason);
  };
  service.probeZWaveNodeCommandReadiness = async (_node, context = {}) => {
    probeReasons.push(context.reason);
    return {
      ready: false,
      skipped: false,
      reason: context.reason || 'test probe failed'
    };
  };

  const result = await service.runZWaveNodeRouteRecovery({
    controller,
    node,
    nodeId: node.id,
    device: nativeSirenDevice(),
    reason: 'startup sync',
    force: false,
    persistFailure: false,
    pingTimeoutMs: 1000,
    routeRebuildTimeoutMs: 1000
  });

  assert.deepEqual(probeReasons, [
    'startup sync: ping before route rebuild',
    'startup sync: ping after route rebuild'
  ]);
  assert.deepEqual(rebuildCalls, [node.id]);
  assert.equal(result.recovered, false);
  assert.equal(result.persisted, false);
  assert.deepEqual(changedReasons, []);
  assert.equal(isZWaveNodeCommandReady(node), false);
});

test('automatic Z-Wave route recoveries run one at a time', async () => {
  const service = new DirectRadioService();
  const firstNode = zwaveNode({ id: 22, ready: false, status: 3, interviewStage: 5, isListening: true });
  const secondNode = zwaveNode({ id: 23, ready: false, status: 3, interviewStage: 5, isListening: true });
  const events = [];
  service.isZWaveAutoRouteRecoveryCandidate = () => true;

  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    service.recoverZWaveNodeRoutes = async (nodeId) => {
      events.push(`start:${nodeId}`);
      if (nodeId === firstNode.id) {
        resolve();
        await new Promise((release) => {
          releaseFirst = release;
        });
      }
      events.push(`finish:${nodeId}`);
      return { nodeId, recovered: true };
    };
  });
  let secondStartedResolve;
  const secondStarted = new Promise((resolve) => {
    secondStartedResolve = resolve;
  });
  const recoverZWaveNodeRoutes = service.recoverZWaveNodeRoutes;
  service.recoverZWaveNodeRoutes = async (nodeId, options) => {
    if (nodeId === secondNode.id) {
      secondStartedResolve();
    }
    return recoverZWaveNodeRoutes(nodeId, options);
  };

  assert.equal(service.scheduleZWaveNodeRouteRecovery(firstNode, 'test recovery', {
    delayMs: 0,
    queueSpacingMs: 0,
    persistFailure: false
  }), true);
  assert.equal(service.scheduleZWaveNodeRouteRecovery(secondNode, 'test recovery', {
    delayMs: 0,
    queueSpacingMs: 0,
    persistFailure: false
  }), true);

  await firstStarted;
  await Promise.resolve();
  assert.deepEqual(events, ['start:22']);

  releaseFirst();
  await secondStarted;
  await Promise.resolve();
  assert.deepEqual(events, ['start:22', 'finish:22', 'start:23', 'finish:23']);
});

test('Z-Wave command retries once after no-ack route recovery succeeds', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  const rebuildCalls = [];
  let pingCount = 0;
  const node = {
    ...zwaveNode({
      ready: false,
      status: 3,
      interviewStage: 5,
      isListening: true,
      manufacturerId: 134,
      productType: 260,
      productId: 80,
      deviceConfig: {
        manufacturer: 'AEON Labs',
        label: 'ZW080'
      }
    }),
    on: () => {},
    ping: async () => {
      pingCount += 1;
      return pingCount === 1 || pingCount >= 3;
    },
    getDefinedValueIDs: () => [
      { commandClass: zwave.BinarySwitchCCValues.targetValue.id.commandClass }
    ],
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      if (setCalls.length === 1) {
        delete node.__homebrainReachabilityProbe;
        node.ready = false;
        node.status = 3;
        throw new Error('The node did not acknowledge the command (ZW0204)');
      }
      return { status: zwave.SetValueStatus.Success };
    }
  };
  const controller = {
    rebuildNodeRoutes: async (nodeId) => {
      rebuildCalls.push(nodeId);
      return true;
    }
  };
  service.start = async () => {};
  service.getZWaveController = () => controller;
  service.getZWaveControllerNodes = () => new Map([[node.id, node]]);
  service.getDirectNodeForDevice = () => node;
  service.findDeviceForZWaveNode = async () => nativeSirenDevice();
  service.handleZWaveNodeChanged = async () => {};

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'turnon', null, updateData);

  assert.equal(pingCount, 3);
  assert.deepEqual(rebuildCalls, [node.id]);
  assert.equal(setCalls.length, 2);
  assert.equal(updateData.isOnline, true);
  assert.equal(updateData.properties.homebrainDirect.ready, true);
  assert.equal(updateData.properties.homebrainDirect.status, 4);
  assert.equal(updateData.properties.homebrainDirect.lastCommandAcceptedAt.length > 0, true);
});

test('Z-Wave siren volume command writes the catalog configuration parameter', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  const node = {
    id: 8,
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    },
    valueDB: {
      hasValue: () => false,
      getValue: () => undefined
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirenvolume', 2, updateData);

  assert.equal(setCalls.length, 1);
  assert.deepEqual(
    setCalls[0].valueId,
    zwave.ConfigurationCCValues.paramInformation(37, 0xff).id
  );
  assert.equal(setCalls[0].value, 2);
  assert.equal(updateData.properties.supportsSirenVolume, true);
  assert.equal(updateData.properties.sirenVolume, 2);
  assert.deepEqual(updateData.properties.sirenVolumeOptions, [
    { label: 'Low', value: 1 },
    { label: 'Medium', value: 2 },
    { label: 'High', value: 3 }
  ]);
});

test('Z-Wave siren volume command accepts catalog option labels and rejects out-of-range values', () => {
  const service = new DirectRadioService();
  const device = nativeSirenDevice();

  assert.deepEqual(service.normalizeSirenVolumeCommand(device, 'High'), {
    value: 3,
    parameter: sirenVolumeCatalogParameter(),
    options: [
      { label: 'Low', value: 1 },
      { label: 'Medium', value: 2 },
      { label: 'High', value: 3 }
    ]
  });
  assert.throws(
    () => service.normalizeSirenVolumeCommand(device, 4),
    /Siren volume must be at most 3/
  );
});

test('Z-Wave siren sound command writes the catalog configuration parameter', async () => {
  const service = new DirectRadioService();
  const setCalls = [];
  const node = {
    id: 8,
    setValue: async (valueId, value) => {
      setCalls.push({ valueId, value });
      return { status: zwave.SetValueStatus.Success };
    },
    valueDB: {
      hasValue: () => false,
      getValue: () => undefined
    }
  };
  service.start = async () => {};
  service.getDirectNodeForDevice = () => node;

  const updateData = {};
  await service.controlDevice(nativeSirenDevice(), 'setsirensound', 'Sound 4', updateData);

  assert.equal(setCalls.length, 1);
  assert.deepEqual(
    setCalls[0].valueId,
    zwave.ConfigurationCCValues.paramInformation(37, 0xff00).id
  );
  assert.equal(setCalls[0].value, 4);
  assert.equal(updateData.properties.supportsSirenSound, true);
  assert.equal(updateData.properties.sirenSound, 4);
  assert.deepEqual(updateData.properties.sirenSoundOptions, [
    { label: 'Sound 1', value: 1 },
    { label: 'Sound 2', value: 2 },
    { label: 'Sound 3', value: 3 },
    { label: 'Sound 4', value: 4 },
    { label: 'Sound 5', value: 5 }
  ]);
});

test('Z-Wave siren sound command validates catalog options', () => {
  const service = new DirectRadioService();
  const device = nativeSirenDevice();

  assert.deepEqual(service.normalizeSirenSoundCommand(device, 'Sound 5'), {
    value: 5,
    parameter: sirenSoundCatalogParameter(),
    options: [
      { label: 'Sound 1', value: 1 },
      { label: 'Sound 2', value: 2 },
      { label: 'Sound 3', value: 3 },
      { label: 'Sound 4', value: 4 },
      { label: 'Sound 5', value: 5 }
    ]
  });
  assert.throws(
    () => service.normalizeSirenSoundCommand(device, 6),
    /Siren sound must be at most 5/
  );
});

test('Zooz ZSE50 exposes practical siren tone and volume controls from the Z-Wave catalog', async () => {
  const service = new DirectRadioService();
  const entry = await directRadioProtocolCatalogService.lookupZWaveCatalogEntry({
    manufacturerId: '0x027a',
    productType: '0x0004',
    productId: '0x0369'
  });
  const directRadioCatalog = directRadioProtocolCatalogService.compactCatalogForDevice(entry);
  const device = nativeSirenDevice({
    name: 'Zooz ZSE50 Siren',
    brand: 'Zooz',
    model: 'ZSE50',
    properties: {
      ...nativeSirenDevice().properties,
      directRadioCatalog
    }
  });

  const soundCommand = service.normalizeSirenSoundCommand(device, 'Tone 50');
  assert.equal(soundCommand.parameter.parameter, 4);
  assert.equal(soundCommand.value, 50);
  assert.equal(soundCommand.options.length, 50);
  assert.deepEqual(soundCommand.options[0], { label: 'Tone 1', value: 1 });
  assert.deepEqual(soundCommand.options[49], { label: 'Tone 50', value: 50 });

  const volumeCommand = service.normalizeSirenVolumeCommand(device, '75%');
  assert.equal(volumeCommand.parameter.parameter, 5);
  assert.equal(volumeCommand.value, 75);
  assert.deepEqual(volumeCommand.options, [
    { label: 'Mute', value: 0 },
    { label: '25%', value: 25 },
    { label: '50%', value: 50 },
    { label: '75%', value: 75 },
    { label: '100%', value: 100 }
  ]);
});
