const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Device = require('../models/Device');
const Settings = require('../models/Settings');

const insteonService = require('../services/insteonService');

test('resolveConnectionTarget supports serial:// scheme for USB PLM endpoints', () => {
  const resolved = insteonService.resolveConnectionTarget('serial:///dev/ttyUSB0');

  assert.equal(resolved.transport, 'serial');
  assert.equal(resolved.serialPath, '/dev/ttyUSB0');
  assert.equal(resolved.label, '/dev/ttyUSB0');
});

test('resolveConnectionTarget keeps /dev/serial/by-id endpoints as serial', () => {
  const resolved = insteonService.resolveConnectionTarget('/dev/serial/by-id/usb-Insteon_PLM-if00-port0');

  assert.equal(resolved.transport, 'serial');
  assert.equal(resolved.serialPath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
});

test('resolveConnectionTarget parses host:port shorthand as tcp', () => {
  const resolved = insteonService.resolveConnectionTarget('192.168.1.50:9761');

  assert.equal(resolved.transport, 'tcp');
  assert.equal(resolved.host, '192.168.1.50');
  assert.equal(resolved.port, 9761);
});

test('listLocalSerialPorts merges serialport list entries with /dev/serial/by-id aliases', async (t) => {
  const originalLoadSerialPortModule = insteonService._loadSerialPortModule;
  const originalGetSerialByIdEntries = insteonService._getSerialByIdEntries;

  t.after(() => {
    insteonService._loadSerialPortModule = originalLoadSerialPortModule;
    insteonService._getSerialByIdEntries = originalGetSerialByIdEntries;
  });

  insteonService._loadSerialPortModule = () => ({
    list: async () => ([
      {
        path: '/dev/ttyUSB0',
        manufacturer: 'FTDI',
        vendorId: '0403',
        productId: '6001'
      }
    ])
  });

  insteonService._getSerialByIdEntries = async () => ([
    {
      symlinkPath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0',
      resolvedPath: '/dev/ttyUSB0'
    }
  ]);

  const ports = await insteonService.listLocalSerialPorts();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].path, '/dev/ttyUSB0');
  assert.equal(ports[0].stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
  assert.equal(ports[0].likelyInsteon, true);
});

test('getSerialTransportDiagnostics reports serialport load errors clearly', (t) => {
  const originalSerialPortModule = insteonService._serialPortModule;
  const originalSerialPortLoadError = insteonService._serialPortLoadError;

  t.after(() => {
    insteonService._serialPortModule = originalSerialPortModule;
    insteonService._serialPortLoadError = originalSerialPortLoadError;
  });

  insteonService._serialPortModule = null;
  insteonService._serialPortLoadError = new Error('native bindings mismatch');

  const diagnostics = insteonService.getSerialTransportDiagnostics();
  assert.equal(diagnostics.supported, false);
  assert.match(diagnostics.error, /native bindings mismatch/i);
});

test('_buildSerialTransportUnavailableMessage includes endpoint and load details', (t) => {
  const originalSerialPortLoadError = insteonService._serialPortLoadError;

  t.after(() => {
    insteonService._serialPortLoadError = originalSerialPortLoadError;
  });

  insteonService._serialPortLoadError = new Error('NODE_MODULE_VERSION mismatch');
  const message = insteonService._buildSerialTransportUnavailableMessage('/dev/serial/by-id/usb-test-port0');
  assert.match(message, /usb-test-port0/);
  assert.match(message, /NODE_MODULE_VERSION mismatch/);
});

test('_buildSerialTransportUnavailableMessage includes bridge fallback errors', (t) => {
  const originalSerialPortLoadError = insteonService._serialPortLoadError;

  t.after(() => {
    insteonService._serialPortLoadError = originalSerialPortLoadError;
  });

  insteonService._serialPortLoadError = new Error('native module failed');
  const message = insteonService._buildSerialTransportUnavailableMessage(
    '/dev/serial/by-id/usb-test-port0',
    new Error('bridge startup failed')
  );
  assert.match(message, /bridge startup failed/i);
});

test('_isMaskedSecretValue detects masked placeholders', () => {
  assert.equal(insteonService._isMaskedSecretValue('********abcd'), true);
  assert.equal(insteonService._isMaskedSecretValue('••••••••••••'), true);
  assert.equal(insteonService._isMaskedSecretValue('real-password-123'), false);
});

test('_normalizeInsteonInfoPayload maps home-controller info shape into stable fields', () => {
  const normalized = insteonService._normalizeInsteonInfoPayload({
    id: '2F.AA.10',
    firmware: '9E',
    deviceCategory: { id: 2, name: 'Switched Lighting Control' },
    deviceSubCategory: { id: 31 }
  });

  assert.equal(normalized.deviceId, '2FAA10');
  assert.equal(normalized.firmwareVersion, '9E');
  assert.equal(normalized.deviceCategory, 2);
  assert.equal(normalized.subcategory, 31);
});

test('importDevicesFromISY skips pre-link lookup when PLM id is unavailable', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalParse = insteonService._parseISYImportPayload;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalDeviceHasLinkToPLM = insteonService._deviceHasLinkToPLM;
  const originalLinkDeviceRemote = insteonService._linkDeviceRemote;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;
  const originalUpsertInsteonDevice = insteonService._upsertInsteonDevice;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService._parseISYImportPayload = originalParse;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._deviceHasLinkToPLM = originalDeviceHasLinkToPLM;
    insteonService._linkDeviceRemote = originalLinkDeviceRemote;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
    insteonService._upsertInsteonDevice = originalUpsertInsteonDevice;
  });

  let linkLookupCalls = 0;
  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService._parseISYImportPayload = () => ({
    devices: [{ address: '112233', displayAddress: '11.22.33', name: 'Test Device' }],
    invalidEntries: [],
    duplicateCount: 0,
    options: {
      group: 10,
      linkMode: 'remote',
      timeoutMs: 5000,
      pauseBetweenMs: 0,
      retries: 0,
      skipLinking: false,
      checkExistingLinks: true
    }
  });
  insteonService.getPLMInfo = async () => ({ firmwareVersion: '9E', deviceId: null });
  insteonService._deviceHasLinkToPLM = async () => {
    linkLookupCalls += 1;
    return false;
  };
  insteonService._linkDeviceRemote = async () => ({});
  insteonService.getDeviceInfo = async () => ({ deviceCategory: 1, subcategory: 0, firmwareVersion: '9E' });
  insteonService._upsertInsteonDevice = async () => ({
    action: 'created',
    device: { _id: 'mock-device-id' }
  });

  const result = await insteonService.importDevicesFromISY({});

  assert.equal(result.success, true);
  assert.equal(result.failed, 0);
  assert.equal(result.linked, 1);
  assert.equal(linkLookupCalls, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /PLM device ID unavailable/i);
});

test('importDevicesFromISY sanitizes malformed parsed entries instead of aborting import', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalParse = insteonService._parseISYImportPayload;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalLinkDeviceRemote = insteonService._linkDeviceRemote;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;
  const originalUpsertInsteonDevice = insteonService._upsertInsteonDevice;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService._parseISYImportPayload = originalParse;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._linkDeviceRemote = originalLinkDeviceRemote;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
    insteonService._upsertInsteonDevice = originalUpsertInsteonDevice;
  });

  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService._parseISYImportPayload = () => ({
    devices: [
      { address: '11.22.33', displayAddress: '11.22.33', name: 'Good Device' },
      { address: undefined, displayAddress: null, name: 'Broken Device' }
    ],
    invalidEntries: [],
    duplicateCount: 0,
    options: {
      group: 10,
      linkMode: 'remote',
      timeoutMs: 5000,
      pauseBetweenMs: 0,
      retries: 0,
      skipLinking: false,
      checkExistingLinks: false
    }
  });
  insteonService.getPLMInfo = async () => ({ firmwareVersion: '9E', deviceId: null });
  insteonService._linkDeviceRemote = async () => ({});
  insteonService.getDeviceInfo = async () => ({ deviceCategory: 1, subcategory: 0, firmwareVersion: '9E' });
  insteonService._upsertInsteonDevice = async () => ({
    action: 'created',
    device: { _id: 'mock-device-id' }
  });

  const result = await insteonService.importDevicesFromISY({});

  assert.equal(result.success, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.imported, 1);
  assert.equal(result.devices.length, 1);
  assert.match(result.invalidEntries[0].reason, /Invalid INSTEON address/i);
});

test('queryLinkedDevicesStatus reports level status and info fallback reachability', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalGetAllLinkedDevices = insteonService.getAllLinkedDevices;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalQueryDeviceLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalQueryDeviceInfoByAddress = insteonService._queryDeviceInfoByAddress;
  const originalSleep = insteonService._sleep;
  const originalDeviceFind = Device.find;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService.getAllLinkedDevices = originalGetAllLinkedDevices;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._queryDeviceLevelByAddress = originalQueryDeviceLevelByAddress;
    insteonService._queryDeviceInfoByAddress = originalQueryDeviceInfoByAddress;
    insteonService._sleep = originalSleep;
    Device.find = originalDeviceFind;
  });

  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService.getAllLinkedDevices = async () => ([
    { address: 'AABBCC', displayAddress: 'AA.BB.CC', group: 1, controller: false },
    { address: '112233', displayAddress: '11.22.33', group: 1, controller: false }
  ]);
  insteonService.getPLMInfo = async () => ({ deviceId: '010203', firmwareVersion: '9E' });
  insteonService._queryDeviceLevelByAddress = async (address) => {
    if (address === 'AABBCC') {
      return 128;
    }
    throw new Error('NACK');
  };
  insteonService._queryDeviceInfoByAddress = async () => ({
    firmwareVersion: '1.0',
    deviceCategory: 2,
    subcategory: 1
  });
  insteonService._sleep = async () => {};
  Device.find = async () => ([
    { _id: { toString: () => 'db-device-1' }, name: 'Kitchen Light', properties: { source: 'insteon', insteonAddress: 'AA.BB.CC' } }
  ]);

  const result = await insteonService.queryLinkedDevicesStatus({ pauseBetweenMs: 0 });
  assert.equal(result.success, true);
  assert.equal(result.summary.linkedDevices, 2);
  assert.equal(result.summary.reachable, 2);
  assert.equal(result.summary.unreachable, 0);
  assert.equal(result.summary.statusKnown, 1);
  assert.equal(result.summary.statusUnknown, 1);
  const kitchen = result.devices.find((device) => device.address === 'AABBCC');
  const fallback = result.devices.find((device) => device.address === '112233');
  assert.ok(kitchen);
  assert.ok(fallback);
  assert.equal(kitchen.name, 'Kitchen Light');
  assert.equal(kitchen.status, true);
  assert.equal(kitchen.respondedVia, 'level');
  assert.equal(fallback.status, null);
  assert.equal(fallback.respondedVia, 'info');
  assert.match(fallback.error, /status read unavailable/i);
});

test('queryLinkedDevicesStatus marks device unreachable when level and info both fail', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalGetAllLinkedDevices = insteonService.getAllLinkedDevices;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalQueryDeviceLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalQueryDeviceInfoByAddress = insteonService._queryDeviceInfoByAddress;
  const originalSleep = insteonService._sleep;
  const originalDeviceFind = Device.find;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService.getAllLinkedDevices = originalGetAllLinkedDevices;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._queryDeviceLevelByAddress = originalQueryDeviceLevelByAddress;
    insteonService._queryDeviceInfoByAddress = originalQueryDeviceInfoByAddress;
    insteonService._sleep = originalSleep;
    Device.find = originalDeviceFind;
  });

  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService.getAllLinkedDevices = async () => ([
    { address: '445566', displayAddress: '44.55.66', group: 1, controller: false }
  ]);
  insteonService.getPLMInfo = async () => ({ deviceId: '010203', firmwareVersion: '9E' });
  insteonService._queryDeviceLevelByAddress = async () => {
    throw new Error('timeout');
  };
  insteonService._queryDeviceInfoByAddress = async () => {
    throw new Error('no response');
  };
  insteonService._sleep = async () => {};
  Device.find = async () => [];

  const result = await insteonService.queryLinkedDevicesStatus({ pauseBetweenMs: 0 });
  assert.equal(result.success, true);
  assert.equal(result.summary.linkedDevices, 1);
  assert.equal(result.summary.reachable, 0);
  assert.equal(result.summary.unreachable, 1);
  assert.equal(result.devices[0].respondedVia, 'none');
  assert.equal(result.devices[0].reachable, false);
  assert.match(result.devices[0].error, /level query failed/i);
});

test('_resolveISYConnection ignores masked input password and falls back to stored password', async (t) => {
  const originalGetSettings = Settings.getSettings;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
  });

  Settings.getSettings = async () => ({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: 'actual-secret',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true
  });

  const resolved = await insteonService._resolveISYConnection({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: '********cret',
    isyUseHttps: false
  });

  assert.equal(resolved.password, 'actual-secret');
  assert.equal(resolved.host, '192.168.1.11');
  assert.equal(resolved.port, 80);
  assert.equal(resolved.useHttps, false);
});

test('_resolveISYConnection surfaces masked stored-password corruption clearly', async (t) => {
  const originalGetSettings = Settings.getSettings;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
  });

  Settings.getSettings = async () => ({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: '********abcd',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true
  });

  await assert.rejects(
    insteonService._resolveISYConnection({
      isyHost: '192.168.1.11',
      isyPort: 80,
      isyUsername: 'admin',
      isyUseHttps: false
    }),
    /stored isy password appears masked/i
  );
});

test('_probeISYConnection falls back when /rest/ping returns HTTP 404', async (t) => {
  const originalRequestISYResource = insteonService._requestISYResource;

  t.after(() => {
    insteonService._requestISYResource = originalRequestISYResource;
  });

  const requestedPaths = [];
  insteonService._requestISYResource = async (_connection, path) => {
    requestedPaths.push(path);
    if (path === '/rest/ping') {
      throw new Error('ISY request failed for /rest/ping: HTTP 404');
    }
    return '<ok />';
  };

  const probe = await insteonService._probeISYConnection({});
  assert.equal(probe.path, '/rest/config');
  assert.equal(probe.usedFallback, true);
  assert.deepEqual(requestedPaths, ['/rest/ping', '/rest/config']);
});

test('_probeISYConnection does not swallow non-404 errors', async (t) => {
  const originalRequestISYResource = insteonService._requestISYResource;

  t.after(() => {
    insteonService._requestISYResource = originalRequestISYResource;
  });

  insteonService._requestISYResource = async () => {
    throw new Error('ISY request failed for /rest/ping: HTTP 401');
  };

  await assert.rejects(
    insteonService._probeISYConnection({}),
    /HTTP 401/i
  );
});

test('_isLocalSerialBridgeActive returns true only for live bridge process', (t) => {
  const originalBridge = insteonService._localSerialBridge;

  t.after(() => {
    insteonService._localSerialBridge = originalBridge;
  });

  insteonService._localSerialBridge = { process: { exitCode: null, killed: false } };
  assert.equal(insteonService._isLocalSerialBridgeActive(), true);

  insteonService._localSerialBridge = { process: { exitCode: 0, killed: false } };
  assert.equal(insteonService._isLocalSerialBridgeActive(), false);
});

test('_validateSerialEndpoint surfaces missing device with detected endpoint hints', async (t) => {
  const originalListLocalSerialPorts = insteonService.listLocalSerialPorts;
  const originalAccess = fs.promises.access;

  t.after(() => {
    insteonService.listLocalSerialPorts = originalListLocalSerialPorts;
    fs.promises.access = originalAccess;
  });

  insteonService.listLocalSerialPorts = async () => ([
    { path: '/dev/ttyUSB0', stablePath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0', aliases: [] }
  ]);

  fs.promises.access = async () => {
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  };

  await assert.rejects(
    insteonService._validateSerialEndpoint('/dev/ttyUSB9'),
    /does not exist.*\/dev\/serial\/by-id\/usb-Insteon_PLM-if00-port0/i
  );
});

test('_validateSerialEndpoint includes stable path when ttyUSB path is used', async (t) => {
  const originalListLocalSerialPorts = insteonService.listLocalSerialPorts;
  const originalAccess = fs.promises.access;

  t.after(() => {
    insteonService.listLocalSerialPorts = originalListLocalSerialPorts;
    fs.promises.access = originalAccess;
  });

  insteonService.listLocalSerialPorts = async () => ([
    { path: '/dev/ttyUSB0', stablePath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0', aliases: [] }
  ]);
  fs.promises.access = async () => {};

  const result = await insteonService._validateSerialEndpoint('/dev/ttyUSB0');
  assert.equal(result.serialPath, '/dev/ttyUSB0');
  assert.equal(result.stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
});

test('_normalizeInsteonAddress normalizes separator formats', () => {
  assert.equal(insteonService._normalizeInsteonAddress('aa.bb.cc'), 'AABBCC');
  assert.equal(insteonService._normalizeInsteonAddress('aa bb cc'), 'AABBCC');
  assert.equal(insteonService._normalizeInsteonAddress('aa-bb-cc'), 'AABBCC');
});

test('_parseISYImportPayload parses and deduplicates mixed payload formats', () => {
  const parsed = insteonService._parseISYImportPayload({
    deviceIds: ['aa.bb.cc', '11.22.33', 'AABBCC'],
    rawDeviceList: 'Kitchen 44.55.66\nInvalid XYZ\n11-22-33',
    group: 2,
    retries: 0
  });

  assert.equal(parsed.devices.length, 3);
  assert.equal(parsed.devices[0].address, 'AABBCC');
  assert.equal(parsed.devices[1].address, '112233');
  assert.equal(parsed.devices[2].address, '445566');
  assert.equal(parsed.duplicateCount, 2);
  assert.equal(parsed.options.group, 2);
  assert.equal(parsed.options.retries, 0);
});

test('_parseISYImportPayload accepts ISY node object variants with resolved/normalized addresses', () => {
  const parsed = insteonService._parseISYImportPayload({
    devices: [
      { resolvedAddress: 'AA.BB.CC', name: 'Kitchen' },
      { normalizedAddress: '112233', displayName: 'Hallway' },
      { properties: { insteonAddress: '44-55-66' } }
    ]
  });

  assert.equal(parsed.devices.length, 3);
  assert.equal(parsed.devices[0].address, 'AABBCC');
  assert.equal(parsed.devices[1].address, '112233');
  assert.equal(parsed.devices[2].address, '445566');
  assert.equal(parsed.invalidEntries.length, 0);
});

test('_parseISYImportPayload rejects out-of-range group values', () => {
  assert.throws(
    () => insteonService._parseISYImportPayload({ deviceIds: ['AA.BB.CC'], group: 300 }),
    /group must be an integer between 0 and 255/i
  );
});

test('_parseISYTopologyPayload parses scene topology with mixed address formats', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    dryRun: true,
    scenes: [
      {
        name: 'Movie Lights',
        group: 3,
        controller: 'gw',
        responders: [
          { id: 'aa.bb.cc', level: 20, ramp: 2000 },
          '11-22-33'
        ]
      }
    ]
  });

  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.scenes[0].controller, 'gw');
  assert.equal(parsed.scenes[0].group, 3);
  assert.equal(parsed.scenes[0].responders[0].id, 'AABBCC');
  assert.equal(parsed.scenes[0].responders[1].id, '112233');
  assert.equal(parsed.options.dryRun, true);
});

test('_parseISYTopologyPayload converts linkRecords into scene operations', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    dryRun: true,
    linkRecords: [
      {
        controller: 'gw',
        group: 5,
        responder: 'AA.BB.CC'
      },
      {
        controller: 'gw',
        group: 5,
        responder: { id: '11.22.33', level: 40 }
      }
    ]
  });

  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.scenes[0].group, 5);
  assert.equal(parsed.scenes[0].responders.length, 2);
});

test('_parseISYTopologyPayload rejects missing responders', () => {
  assert.throws(
    () => insteonService._parseISYTopologyPayload({
      scenes: [{ name: 'Broken', group: 1, controller: 'gw', responders: [] }]
    }),
    /no valid isy scene topology entries/i
  );
});

test('_parseISYTopologyPayload enables existing-scene checks by default', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    scenes: [{ name: 'Scene', group: 1, controller: '11.22.33', responders: ['AA.BB.CC'] }]
  });

  assert.equal(parsed.options.checkExistingSceneLinks, true);
});

test('_isTopologySceneAlreadyLinked resolves gw controller using PLM id', async (t) => {
  const originalHasResponderLink = insteonService._deviceHasResponderLinkToController;

  t.after(() => {
    insteonService._deviceHasResponderLinkToController = originalHasResponderLink;
  });

  const calls = [];
  insteonService._deviceHasResponderLinkToController = async (responder, group, controller) => {
    calls.push({ responder, group, controller });
    return true;
  };

  const alreadyLinked = await insteonService._isTopologySceneAlreadyLinked({
    name: 'Scene 1',
    group: 9,
    controller: 'gw',
    responders: [{ id: 'AA.BB.CC' }]
  }, { normalizedPlmId: '112233' });

  assert.equal(alreadyLinked, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { responder: 'AABBCC', group: 9, controller: '112233' });
});

test('applyISYSceneTopology skips scenes already in desired state', async (t) => {
  const originalConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;
  const originalParseTopologyPayload = insteonService._parseISYTopologyPayload;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalIsSceneAlreadyLinked = insteonService._isTopologySceneAlreadyLinked;
  const originalApplyTopologyScene = insteonService._applyTopologyScene;
  const originalSleep = insteonService._sleep;

  t.after(() => {
    insteonService.isConnected = originalConnected;
    insteonService.hub = originalHub;
    insteonService._parseISYTopologyPayload = originalParseTopologyPayload;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._isTopologySceneAlreadyLinked = originalIsSceneAlreadyLinked;
    insteonService._applyTopologyScene = originalApplyTopologyScene;
    insteonService._sleep = originalSleep;
  });

  let applyCalls = 0;
  insteonService.isConnected = true;
  insteonService.hub = {};
  insteonService._parseISYTopologyPayload = () => ({
    scenes: [{ name: 'Scene 1', group: 1, controller: '11.22.33', remove: false, responders: [{ id: 'AA.BB.CC' }] }],
    invalidEntries: [],
    options: {
      dryRun: false,
      upsertDevices: false,
      continueOnError: true,
      checkExistingSceneLinks: true,
      pauseBetweenScenesMs: 0,
      sceneTimeoutMs: 5000
    }
  });
  insteonService.getPLMInfo = async () => ({ deviceId: '010203' });
  insteonService._isTopologySceneAlreadyLinked = async () => true;
  insteonService._applyTopologyScene = async () => {
    applyCalls += 1;
  };
  insteonService._sleep = async () => {};

  const result = await insteonService.applyISYSceneTopology({});
  assert.equal(result.success, true);
  assert.equal(result.sceneCount, 1);
  assert.equal(result.appliedScenes, 0);
  assert.equal(result.skippedExistingScenes, 1);
  assert.equal(result.failedScenes, 0);
  assert.equal(applyCalls, 0);
  assert.equal(result.scenes[0].status, 'already-linked');
});

test('_parseISYNodesXml parses device and group membership from ISY xml', () => {
  const xml = `
    <nodes>
      <node flag="0">
        <address>AA BB CC</address>
        <name>Kitchen Dimmer</name>
        <family>1</family>
        <type>1.2.3</type>
        <parent>0</parent>
        <enabled>true</enabled>
      </node>
      <group flag="0">
        <address>0010</address>
        <name>Movie Scene</name>
        <parent>0</parent>
        <link type="1">AA.BB.CC</link>
        <link type="0">11.22.33</link>
      </group>
    </nodes>
  `;

  const parsed = insteonService._parseISYNodesXml(xml);
  assert.equal(parsed.devices.length, 1);
  assert.equal(parsed.devices[0].normalizedAddress, 'AABBCC');
  assert.equal(parsed.devices[0].resolvedAddress, 'AABBCC');
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].controllers, ['AABBCC']);
  assert.deepEqual(parsed.groups[0].members.sort(), ['112233', 'AABBCC']);
});

test('_parseISYNodesXml resolves ISY subnode addresses to base Insteon IDs', () => {
  const xml = `
    <nodes>
      <node flag="0">
        <address>31.41.0F.1</address>
        <name>Keypad Button A</name>
        <parent>31.41.0F</parent>
      </node>
      <node flag="0">
        <address>31.49.05.1D</address>
        <name>Keypad LED</name>
        <parent>31.49.05</parent>
      </node>
      <group flag="0">
        <address>0010</address>
        <name>Movie Scene</name>
        <parent>0</parent>
        <link type="1">31.41.0F.1</link>
        <link type="0">31.49.05.1D</link>
      </group>
    </nodes>
  `;

  const parsed = insteonService._parseISYNodesXml(xml);
  assert.equal(parsed.devices.length, 2);
  assert.equal(parsed.devices[0].normalizedAddress, '31410F');
  assert.equal(parsed.devices[0].resolvedAddress, '31410F');
  assert.equal(parsed.devices[1].normalizedAddress, '314905');
  assert.equal(parsed.devices[1].resolvedAddress, '314905');
  assert.deepEqual(parsed.groups[0].controllers, ['31410F']);
  assert.deepEqual(parsed.groups[0].members.sort(), ['31410F', '314905']);
});

test('_parseISYProgramsXml parses non-folder programs', () => {
  const xml = `
    <programs>
      <program id="0001" parentId="0000" folder="false" enabled="true" runAtStartup="true" status="true">
        <name>Evening Lights</name>
        <lastRunTime>2026/03/01 20:30:00</lastRunTime>
      </program>
      <program id="0002" parentId="0000" folder="true" status="true">
        <name>Folder</name>
      </program>
    </programs>
  `;

  const programs = insteonService._parseISYProgramsXml(xml);
  assert.equal(programs.length, 1);
  assert.equal(programs[0].id, '0001');
  assert.equal(programs[0].name, 'Evening Lights');
  assert.equal(programs[0].enabled, true);
});

test('_parseISYProgramsXml extracts IF/THEN/ELSE program sections', () => {
  const xml = `
    <programs>
      <program id="0003" parentId="0000" folder="false" enabled="true" runAtStartup="false" status="true">
        <name>Porch Routine</name>
        <if>Time is  6:30:00PM</if>
        <then>
          Set 'Kitchen Dimmer' On
          Wait 5 seconds
        </then>
        <else>- No Actions - (To add one, press 'Action')</else>
      </program>
    </programs>
  `;

  const programs = insteonService._parseISYProgramsXml(xml);
  assert.equal(programs.length, 1);
  assert.equal(programs[0].ifLines[0], 'Time is 6:30:00PM');
  assert.equal(programs[0].thenLines[0], "Set 'Kitchen Dimmer' On");
  assert.equal(programs[0].thenLines[1], 'Wait 5 seconds');
  assert.equal(programs[0].elseLines.length, 0);
});

test('_parseISYNetworkResourcesXml parses resource ids, names, and control info', () => {
  const xml = `
    <NetConfig>
      <NetRule id="5">
        <sName>Doorbell Notify</sName>
        <ControlInfo>
          <protocol>https</protocol>
          <host>api.example.com</host>
          <port>443</port>
          <method>POST</method>
          <path>/v1/devices/notify</path>
          <timeout>5000</timeout>
        </ControlInfo>
      </NetRule>
      <resource id="07" name="Webhook Ping" />
    </NetConfig>
  `;

  const resources = insteonService._parseISYNetworkResourcesXml(xml);
  assert.equal(resources.length, 2);
  assert.equal(resources[0].id, '5');
  assert.equal(resources[0].name, 'Doorbell Notify');
  assert.equal(resources[0].controlInfo.protocol, 'https');
  assert.equal(resources[0].controlInfo.host, 'api.example.com');
  assert.equal(resources[0].controlInfo.method, 'POST');
  assert.equal(resources[0].controlInfo.path, '/v1/devices/notify');
  assert.equal(resources[1].id, '07');
  assert.equal(resources[1].name, 'Webhook Ping');
});

test('_buildISYProgramWorkflowPayloads translates simple time/device/scene program', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map([
      ['kitchen dimmer', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    devicesById: new Map([
      ['dev1', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    scenesByName: new Map([
      ['movie night', { _id: 'scene1', name: 'Movie Night', deviceActions: [] }]
    ]),
    programsByName: new Map(),
    programsById: new Map()
  };

  const payloads = insteonService._buildISYProgramWorkflowPayloads({
    id: '0003',
    name: 'Porch Routine',
    enabled: true,
    runAtStartup: false,
    status: true,
    ifLines: ['Time is 6:30:00PM'],
    thenLines: ["Set 'Kitchen Dimmer' On", 'Wait 5 seconds', "Set Scene 'Movie Night' On"],
    elseLines: []
  }, lookup, { enableWorkflows: true });

  assert.equal(payloads.mainPayload.trigger.type, 'schedule');
  assert.equal(payloads.mainPayload.trigger.conditions.cron, '* * * * *');
  assert.equal(payloads.mainPayload.actions.length, 4);
  assert.equal(payloads.mainPayload.actions[0].type, 'condition');
  assert.equal(payloads.mainPayload.actions[0].parameters.evaluator, 'isy_program_if');
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions.length, 0);
  assert.equal(payloads.mainPayload.actions[1].type, 'device_control');
  assert.equal(payloads.mainPayload.actions[1].target, 'dev1');
  assert.equal(payloads.mainPayload.actions[2].type, 'delay');
  assert.equal(payloads.mainPayload.actions[3].type, 'scene_activate');
  assert.equal(payloads.mainPayload.actions[3].target, 'scene1');
  assert.equal(payloads.elsePayload, null);
});

test('_buildISYProgramWorkflowPayloads embeds ELSE path in primary workflow for device-state IF', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map([
      ['kitchen dimmer', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    devicesById: new Map([
      ['dev1', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    scenesByName: new Map(),
    programsByName: new Map(),
    programsById: new Map()
  };

  const payloads = insteonService._buildISYProgramWorkflowPayloads({
    id: '0004',
    name: 'Kitchen Status',
    enabled: true,
    runAtStartup: false,
    status: true,
    ifLines: ["Status 'Kitchen Dimmer' is On"],
    thenLines: ["Set 'Kitchen Dimmer' Off"],
    elseLines: ["Set 'Kitchen Dimmer' On"]
  }, lookup, { enableWorkflows: true });

  assert.equal(payloads.mainPayload.trigger.type, 'schedule');
  assert.equal(payloads.elsePayload, null);
  assert.equal(payloads.elseHandledInPrimary, true);
  assert.equal(payloads.mainPayload.actions[0].type, 'condition');
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions[0].type, 'device_control');
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions[0].target, 'dev1');
});

test('_buildISYProgramWorkflowPayloads embeds ELSE path in primary workflow when trigger inversion is not possible', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map([
      ['kitchen dimmer', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    devicesById: new Map([
      ['dev1', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    scenesByName: new Map(),
    programsByName: new Map(),
    programsById: new Map()
  };

  const payloads = insteonService._buildISYProgramWorkflowPayloads({
    id: '0005',
    name: 'Time Branch',
    enabled: true,
    runAtStartup: false,
    status: true,
    ifLines: ['Time is 6:30:00PM'],
    thenLines: ["Set 'Kitchen Dimmer' On"],
    elseLines: ["Set 'Kitchen Dimmer' Off"]
  }, lookup, { enableWorkflows: true });

  assert.equal(payloads.elsePayload, null);
  assert.equal(payloads.elseHandledInPrimary, true);
  assert.equal(payloads.mainPayload.trigger.type, 'schedule');
  assert.equal(payloads.mainPayload.trigger.conditions.cron, '* * * * *');
  assert.equal(payloads.mainPayload.actions[0].type, 'condition');
  assert.equal(payloads.mainPayload.actions[0].parameters.evaluator, 'isy_program_if');
  assert.equal(payloads.mainPayload.actions[0].parameters.edge, 'change');
  assert.ok(Array.isArray(payloads.mainPayload.actions[0].parameters.onFalseActions));
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions.length, 1);
});

test('_buildISYConditionExpression parses variable/program conditions and precedence', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map(),
    devicesById: new Map(),
    scenesByName: new Map(),
    programsByName: new Map([
      ['holiday lights', { id: '1001', name: 'Holiday Lights' }]
    ]),
    programsById: new Map([
      ['1001', { id: '1001', name: 'Holiday Lights' }]
    ])
  };

  const expression = insteonService._buildISYConditionExpression({
    ifLines: [
      '$counter > 0',
      "And Program 'Holiday Lights' is True",
      "Or $mode is 2"
    ]
  }, lookup);

  assert.ok(expression);
  assert.equal(expression.op, 'or');
  assert.equal(expression.conditions.length, 2);
  assert.equal(expression.conditions[0].op, 'and');
});

test('_translateISYProgramActionLines translates variables, program control, and repeat', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map(),
    devicesById: new Map(),
    scenesByName: new Map(),
    programsByName: new Map([
      ['timer program', { id: '2001', name: 'Timer Program' }]
    ]),
    programsById: new Map([
      ['2001', { id: '2001', name: 'Timer Program' }]
    ])
  };

  const translated = insteonService._translateISYProgramActionLines([
    '$counter += 1',
    "Run Program 'Timer Program' (Then Path)",
    'Repeat 2 times',
    'Wait 1 seconds',
    '$counter -= 1'
  ], lookup, {
    branch: 'then',
    ifExpression: {
      kind: 'isy_variable',
      name: 'counter',
      operator: '>',
      value: { kind: 'literal', value: 0 }
    }
  });

  assert.equal(translated.actions[0].type, 'variable_control');
  assert.equal(translated.actions[0].parameters.operation, 'add');
  assert.equal(translated.actions[1].type, 'workflow_control');
  assert.equal(translated.actions[1].parameters.operation, 'run_then');
  assert.equal(translated.actions[2].type, 'repeat');
  assert.equal(translated.actions[2].parameters.mode, 'for');
  assert.equal(translated.actions[2].parameters.actions.length, 2);
});

test('_translateISYProgramActionLines translates network resource statements into executable actions', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map(),
    devicesById: new Map(),
    scenesByName: new Map(),
    programsByName: new Map(),
    programsById: new Map(),
    resourcesByName: new Map([
      ['doorbell notify', {
        id: '5',
        name: 'Doorbell Notify',
        controlInfo: {
          protocol: 'https',
          host: 'api.example.com',
          port: 443,
          method: 'POST',
          path: '/v1/devices/notify',
          payload: '{"device":"front-door"}',
          timeout: 5000
        }
      }]
    ]),
    resourcesById: new Map([
      ['5', {
        id: '5',
        name: 'Doorbell Notify',
        controlInfo: {
          protocol: 'https',
          host: 'api.example.com',
          port: 443,
          method: 'POST',
          path: '/v1/devices/notify',
          payload: '{"device":"front-door"}',
          timeout: 5000
        }
      }],
      ['7', { id: '07', name: 'Webhook Ping' }],
      ['07', { id: '07', name: 'Webhook Ping' }]
    ])
  };

  const translated = insteonService._translateISYProgramActionLines([
    "Network Resource 'Doorbell Notify'",
    'Resource 7'
  ], lookup, { branch: 'then' });

  assert.equal(translated.actions.length, 2);
  assert.equal(translated.actions[0].type, 'http_request');
  assert.equal(translated.actions[0].target, 'https://api.example.com/v1/devices/notify');
  assert.equal(translated.actions[0].parameters.method, 'POST');
  assert.deepEqual(translated.actions[0].parameters.body, { device: 'front-door' });
  assert.equal(translated.actions[1].type, 'isy_network_resource');
  assert.equal(translated.actions[1].parameters.resourceId, '07');
  assert.equal(translated.untranslatedLines.length, 0);
});

test('_buildTopologyScenesFromISYGroups creates scene entries per controller', () => {
  const scenes = insteonService._buildTopologyScenesFromISYGroups([
    {
      address: '0010',
      name: 'Movie Scene',
      members: ['AABBCC', '112233'],
      controllers: ['AABBCC']
    }
  ]);

  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].controller, 'AABBCC');
  assert.equal(scenes[0].responders.length, 1);
  assert.equal(scenes[0].responders[0].id, '112233');
  assert.ok(Number.isInteger(scenes[0].group));
});
