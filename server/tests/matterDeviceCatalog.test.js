const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MATTER_SOURCE,
  inferFeaturesFromMatterDescriptor,
  inferHomeBrainTypeFromFeatures
} = require('../services/matterDeviceCatalog');
const matterService = require('../services/matterService');

test('Matter catalog maps Thread contact sensors with battery support', () => {
  const descriptor = {
    name: 'Back Door Contact',
    productName: 'Matter Contact Sensor',
    endpointName: 'Contact endpoint',
    deviceTypeNames: ['Contact Sensor'],
    clusterIds: [29, 47, 69],
    clusterNames: ['Descriptor', 'PowerSource', 'BooleanState']
  };

  const features = inferFeaturesFromMatterDescriptor(descriptor);
  assert.equal(MATTER_SOURCE, 'homebrain-matter');
  assert.deepEqual(features, ['battery', 'contact']);
  assert.equal(inferHomeBrainTypeFromFeatures(features, descriptor), 'sensor');
});

test('Matter catalog maps lights, locks, thermostat, energy and camera capabilities', () => {
  assert.equal(inferHomeBrainTypeFromFeatures(
    inferFeaturesFromMatterDescriptor({ deviceTypeNames: ['Extended Color Light'], clusterIds: [6, 8, 768] }),
    { deviceTypeNames: ['Extended Color Light'] }
  ), 'light');

  assert.equal(inferHomeBrainTypeFromFeatures(
    inferFeaturesFromMatterDescriptor({ productName: 'Matter Door Lock', clusterIds: [257, 47] }),
    { productName: 'Matter Door Lock' }
  ), 'lock');

  assert.equal(inferHomeBrainTypeFromFeatures(
    inferFeaturesFromMatterDescriptor({ productName: 'Matter Thermostat', clusterIds: [513, 1026] }),
    { productName: 'Matter Thermostat' }
  ), 'thermostat');

  assert.deepEqual(
    inferFeaturesFromMatterDescriptor({ productName: 'Energy Plug', clusterIds: [6, 144, 145] }),
    ['energy', 'power', 'switch']
  );

  assert.equal(inferHomeBrainTypeFromFeatures(
    inferFeaturesFromMatterDescriptor({ productName: 'Matter Camera', deviceTypeNames: ['Camera'] }),
    { productName: 'Matter Camera' }
  ), 'camera');
});

test('Matter service detects SONOFF MG24 serial ports and parses known addresses', () => {
  assert.equal(matterService._test.looksLikeSonoffMg24Port({
    path: '/dev/ttyUSB0',
    manufacturer: 'Silicon Labs',
    productId: 'ea60',
    friendlyName: 'SONOFF Dongle Plus MG24'
  }), true);

  assert.equal(matterService._test.looksLikeSonoffMg24Port({
    path: '/dev/ttyACM0',
    manufacturer: 'Zooz',
    friendlyName: 'Zooz ZST10 Z-Wave'
  }), false);
  assert.equal(matterService._test.looksLikeSonoffMg24Port({
    path: '/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_2275350e6ca4ef119f8aaf8086a24396-if00-port0',
    manufacturer: 'ITead',
    pnpId: 'usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_2275350e6ca4ef119f8aaf8086a24396-if00-port0',
    vendorId: '10c4',
    productId: 'ea60'
  }), false);
  assert.equal(matterService._test.looksLikeSonoffMg24Port({
    stablePath: '/dev/serial/by-id/usb-SONOFF_SONOFF_Dongle_Plus_MG24_c4416e8b64f5ef11996896a29ed47d52-if00-port0',
    manufacturer: 'SONOFF',
    pnpId: 'usb-SONOFF_SONOFF_Dongle_Plus_MG24_c4416e8b64f5ef11996896a29ed47d52-if00-port0',
    vendorId: '10c4',
    productId: 'ea60'
  }), true);
  assert.equal(matterService._test.serialPortMatchesPath({
    path: '/dev/serial/by-id/usb-SONOFF_SONOFF_Dongle_Plus_MG24_c4416e8b64f5ef11996896a29ed47d52-if00-port0',
    rawPath: '/dev/ttyUSB2',
    realPath: '/dev/ttyUSB2'
  }, '/dev/ttyUSB2'), true);

  assert.deepEqual(matterService._test.parseKnownAddress('192.168.1.50:5540'), {
    ip: '192.168.1.50',
    port: 5540,
    type: 'udp'
  });
});

test('Matter service supports serialport v8 and v10 module shapes', async () => {
  const legacyPorts = [{ path: '/dev/ttyUSB0' }];
  const modernPorts = [{ path: '/dev/ttyACM0' }];
  const legacyList = matterService._test.getSerialPortListFunction({
    list: async () => legacyPorts
  });
  const modernList = matterService._test.getSerialPortListFunction({
    SerialPort: {
      list: async () => modernPorts
    }
  });

  assert.deepEqual(await legacyList(), legacyPorts);
  assert.deepEqual(await modernList(), modernPorts);
});

test('Matter service constrains OTBR REST URLs to local and private networks', () => {
  assert.equal(matterService._test.isAllowedLocalOtbrHost('127.0.0.1'), true);
  assert.equal(matterService._test.isAllowedLocalOtbrHost('192.168.1.40'), true);
  assert.equal(matterService._test.isAllowedLocalOtbrHost('homebrain.local'), true);
  assert.equal(matterService._test.isAllowedLocalOtbrHost('example.com'), false);
  assert.equal(
    matterService._test.normalizeOtbrRestUrl('https://user:pass@example.com:8081/a?secret=1#frag'),
    'http://127.0.0.1:8081'
  );
  assert.equal(
    matterService._test.normalizeOtbrRestUrl('http://192.168.1.40:8081/node/'),
    'http://192.168.1.40:8081/node'
  );
});

test('Matter service guards Thread firmware flashing inputs and command construction', () => {
  assert.equal(matterService._test.normalizeThreadFirmwareFlashConfirmation('FLASH OPENTHREAD RCP'), true);
  assert.equal(matterService._test.normalizeThreadFirmwareFlashConfirmation('flash openthread rcp'), true);
  assert.equal(matterService._test.normalizeThreadFirmwareFlashConfirmation('FLASH ZIGBEE'), false);
  assert.equal(matterService._test.normalizeThreadOtbrConfirmation('START THREAD BORDER ROUTER'), true);
  assert.equal(matterService._test.normalizeThreadOtbrConfirmation('start thread border router'), true);
  assert.equal(matterService._test.normalizeThreadOtbrConfirmation('START ZIGBEE'), false);

  assert.equal(matterService._test.sanitizeFirmwareFileName('../OpenThread RCP.gbl'), 'OpenThread_RCP.gbl');
  assert.throws(
    () => matterService._test.sanitizeFirmwareFileName('zigbee.bin'),
    /Thread firmware must be a Silicon Labs \.gbl image/
  );

  assert.equal(
    matterService._test.isTrustedSonoffFirmwareUrl(
      'https://dongle.sonoff.tech/dongle-flasher/dongle-hardware/donglepmg24_mg24_openthread_stable_2.4.4_460800.gbl'
    ),
    true
  );
  assert.equal(
    matterService._test.isTrustedSonoffFirmwareUrl('http://dongle.sonoff.tech/dongle-flasher/dongle-hardware/ot-rcp.gbl'),
    false
  );
  assert.equal(
    matterService._test.isTrustedSonoffFirmwareUrl('https://example.com/dongle-flasher/dongle-hardware/ot-rcp.gbl'),
    false
  );

  assert.deepEqual(
    matterService._test.splitCommandSpec('python3 -m universal_silabs_flasher'),
    ['python3', '-m', 'universal_silabs_flasher']
  );

  assert.deepEqual(
    matterService._test.buildUniversalSilabsFlasherArgs({
      devicePath: '/dev/serial/by-id/usb-SONOFF_MG24',
      firmwarePath: '/tmp/openthread.gbl',
      verbose: true
    }),
    [
      '--verbose',
      '--device',
      '/dev/serial/by-id/usb-SONOFF_MG24',
      '--bootloader-reset',
      'rts_dtr',
      'flash',
      '--firmware',
      '/tmp/openthread.gbl'
    ]
  );

  assert.equal(
    matterService._test.buildOtbrRadioUrl('/dev/serial/by-id/usb-SONOFF_MG24', '460800'),
    'spinel+hdlc+uart:///dev/serial/by-id/usb-SONOFF_MG24?uart-baudrate=460800'
  );
  assert.equal(
    matterService._test.buildOtbrRadioUrl('/dev/ttyUSB2', 'bad'),
    'spinel+hdlc+uart:///dev/ttyUSB2?uart-baudrate=460800'
  );
  assert.equal(
    matterService._test.parseHexDatasetFromText('Done\n0e080000000000010000\n'),
    '0e080000000000010000'
  );
  assert.equal(
    matterService._test.normalizeThreadOtbrState('detached\r\nDone'),
    'detached'
  );
  assert.equal(
    matterService._test.isThreadOtbrAttachedState('detached\r\nDone'),
    false
  );
  assert.equal(
    matterService._test.isThreadOtbrAttachedState('leader\r\nDone'),
    true
  );
  assert.deepEqual(
    matterService._test.resolveThreadActiveDataset({
      configuredDataset: '',
      otbrDataset: '',
      hostDataset: '0e080000000000010000'
    }),
    {
      dataset: '0e080000000000010000',
      source: 'otbr-host'
    }
  );
  assert.equal(
    matterService._test.matterControllerStoreMayContainPairedNodes([
      'root.commissioning.passcode',
      'fabrics.fabrics'
    ]),
    false
  );
  assert.equal(
    matterService._test.matterControllerStoreMayContainPairedNodes([
      'peers.1234.commissioningClient.peerAddress'
    ]),
    true
  );
  assert.throws(
    () => matterService._test.buildOtbrRadioUrl('/tmp/ttyUSB2', '460800'),
    /OTBR radio device must be a local/
  );
});

test('Matter controller diagnostics preserve nested initialization failures', () => {
  const cause = new Error('EADDRINUSE 5353');
  cause.code = 'EADDRINUSE';
  const error = new Error('MatterController unavailable due to initialization error', { cause });
  const detail = matterService._test.serializeMatterControllerError(error);

  assert.equal(detail.message, 'MatterController unavailable due to initialization error');
  assert.equal(detail.cause.message, 'EADDRINUSE 5353');
  assert.equal(detail.cause.code, 'EADDRINUSE');
  assert.equal(
    matterService._test.summarizeMatterControllerError(error),
    'MatterController unavailable due to initialization error: EADDRINUSE 5353'
  );
});

test('Matter Thread setup guidance marks completed OpenThread flash before OTBR starts', () => {
  const port = {
    path: '/dev/serial/by-id/usb-SONOFF_MG24',
    stablePath: '/dev/serial/by-id/usb-SONOFF_MG24'
  };
  const guidance = matterService._test.buildThreadSetupGuidance({
    expectedPorts: [port],
    selectedPort: port,
    otbr: {
      online: false,
      dataset: '',
      baseUrl: 'http://127.0.0.1:8081'
    },
    activeDataset: '',
    firmwareFlash: {
      tool: {
        available: true,
        canAutoInstall: true
      },
      recentJobs: [
        {
          status: 'completed',
          devicePath: port.path,
          firmware: {
            firmwareType: 'OpenThread',
            version: '2.4.4'
          }
        }
      ]
    }
  });

  const flashAction = guidance.actions.find((action) => action.id === 'flash-openthread-rcp');
  const otbrAction = guidance.actions.find((action) => action.id === 'start-otbr');

  assert.equal(flashAction.status, 'complete');
  assert.match(flashAction.detail, /OpenThread RCP firmware 2\.4\.4 was flashed successfully/);
  assert.equal(otbrAction.status, 'required');
  assert.match(otbrAction.detail, /HomeBrain-managed OTBR/);
  assert.equal(guidance.otbr.serverSideConfirmation, 'START THREAD BORDER ROUTER');
});

test('Matter Thread setup guidance requires OTBR to attach before commissioning is ready', () => {
  const port = {
    path: '/dev/serial/by-id/usb-SONOFF_MG24',
    stablePath: '/dev/serial/by-id/usb-SONOFF_MG24'
  };
  const guidance = matterService._test.buildThreadSetupGuidance({
    expectedPorts: [port],
    selectedPort: port,
    otbr: {
      online: true,
      dataset: '0e080000000000010000',
      baseUrl: 'http://127.0.0.1:8081'
    },
    otbrHost: {
      state: 'detached'
    },
    activeDataset: '0e080000000000010000',
    firmwareFlash: {
      tool: {
        available: true,
        canAutoInstall: true
      }
    }
  });

  const otbrAction = guidance.actions.find((action) => action.id === 'start-otbr');
  const attachAction = guidance.actions.find((action) => action.id === 'attach-thread-network');

  assert.equal(otbrAction.status, 'required');
  assert.match(otbrAction.detail, /Thread is detached/);
  assert.equal(attachAction.status, 'required');
  assert.match(attachAction.detail, /cannot be commissioned/);
});

test('Matter Thread setup guidance surfaces no-BBR host fallback', () => {
  const port = {
    path: '/dev/serial/by-id/usb-SONOFF_MG24',
    stablePath: '/dev/serial/by-id/usb-SONOFF_MG24'
  };
  const guidance = matterService._test.buildThreadSetupGuidance({
    expectedPorts: [port],
    selectedPort: port,
    otbr: {
      online: true,
      dataset: '0e080000000000010000',
      baseUrl: 'http://127.0.0.1:8081'
    },
    otbrHost: {
      state: 'leader',
      ipv6Mroute: 'unsupported',
      backboneRouterMode: 'no-bbr'
    },
    activeDataset: '0e080000000000010000',
    firmwareFlash: {
      tool: {
        available: true,
        canAutoInstall: true
      }
    }
  });

  const backboneAction = guidance.actions.find((action) => action.id === 'host-backbone-router');

  assert.equal(backboneAction.status, 'limited');
  assert.match(backboneAction.detail, /without Thread 1\.2 Backbone Router/);
});

test('persisted Thread flash jobs are normalized for restart-safe status checks', () => {
  const completed = matterService._test.normalizePersistedThreadFirmwareFlashJob({
    id: 'thread-flash-test',
    status: 'completed',
    phase: 'completed',
    createdAt: '2026-05-09T18:00:00.000Z',
    devicePath: '/dev/serial/by-id/usb-SONOFF_MG24',
    firmware: {
      firmwareType: 'OpenThread',
      version: '2.4.4'
    },
    logs: Array.from({ length: 300 }, (_, index) => ({ line: `line ${index}` }))
  });

  assert.equal(completed.id, 'thread-flash-test');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.firmware.version, '2.4.4');
  assert.equal(completed.logs.length, 250);

  const missingId = matterService._test.normalizePersistedThreadFirmwareFlashJob({
    status: 'completed'
  });
  assert.equal(missingId, null);
});

test('Matter service selects the latest SONOFF OpenThread firmware for the connected PMG24 stick', () => {
  const port = {
    stablePath: '/dev/serial/by-id/usb-SONOFF_SONOFF_Dongle_Plus_MG24_c4416e8b64f5ef11996896a29ed47d52-if00-port0',
    rawPath: '/dev/ttyUSB2',
    manufacturer: 'SONOFF',
    serialNumber: 'c4416e8b64f5ef11996896a29ed47d52',
    pnpId: 'usb-SONOFF_SONOFF_Dongle_Plus_MG24_c4416e8b64f5ef11996896a29ed47d52-if00-port0',
    vendorId: '10c4',
    productId: 'ea60'
  };
  const target = matterService._test.inferSonoffThreadFirmwareTarget(port);
  assert.deepEqual(target, {
    dongleType: 'Dongle-PMG24',
    chipModel: 'mg24',
    productName: 'SONOFF Dongle Plus MG24',
    firmwareType: 'OpenThread',
    evidence: ['stablePath', 'pnpId', 'serialNumber', 'manufacturer']
  });

  const latest = matterService._test.selectLatestSonoffThreadFirmware([
    {
      name: 'donglepmg24_mg24_openthread_stable_2.4.3_460800.gbl',
      dongleType: 'Dongle-PMG24',
      chipModel: 'mg24',
      firmwareType: 'OpenThread',
      firmwareDesc: 'stable',
      version: '2.4.3',
      baudRate: '460800'
    },
    {
      name: 'donglepmg24_mg24_openthread_stable_2.4.4_460800.gbl',
      dongleType: 'Dongle-PMG24',
      chipModel: 'mg24',
      firmwareType: 'OpenThread',
      firmwareDesc: 'stable',
      version: '2.4.4',
      baudRate: '460800'
    },
    {
      name: 'donglem_mg24_openthread_stable_1.0.0_115200_2.4.4.gbl',
      dongleType: 'Dongle-M',
      chipModel: 'mg24',
      firmwareType: 'OpenThread',
      firmwareDesc: 'stable',
      version: '1.0.0',
      baudRate: '115200',
      sdkVersion: '2.4.4'
    }
  ], target);

  assert.equal(latest.name, 'donglepmg24_mg24_openthread_stable_2.4.4_460800.gbl');
  assert.equal(latest.dongleType, 'Dongle-PMG24');
  assert.equal(latest.firmwareType, 'OpenThread');
  assert.equal(latest.url, 'https://dongle.sonoff.tech/dongle-flasher/dongle-hardware/donglepmg24_mg24_openthread_stable_2.4.4_460800.gbl');
});
