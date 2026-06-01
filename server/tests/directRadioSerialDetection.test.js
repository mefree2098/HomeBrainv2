const test = require('node:test');
const assert = require('node:assert/strict');

const directRadioService = require('../services/directRadioService');

const {
  DirectRadioService,
  choosePortForProtocol,
  enrichSerialPortForDirectRadios,
  normalizeSerialPort,
  scorePortForProtocol
} = {
  DirectRadioService: directRadioService.DirectRadioService,
  ...directRadioService._test
};

test('direct radio serial scoring identifies SONOFF Zigbee and Zooz Z-Wave adapters separately', () => {
  const zigbee = enrichSerialPortForDirectRadios(normalizeSerialPort({
    path: '/dev/ttyUSB0',
    manufacturer: 'ITEAD',
    product: 'SONOFF Zigbee 3.0 USB Dongle Plus ZBDongle-P',
    vendorId: '10C4',
    productId: 'EA60'
  }, []));
  const zwave = enrichSerialPortForDirectRadios(normalizeSerialPort({
    path: '/dev/ttyACM0',
    manufacturer: 'Zooz',
    product: 'ZST39 LR 800 Series Z-Wave SerialAPI USB Stick',
    vendorId: '10C4',
    productId: 'EA60'
  }, []));

  assert.equal(zigbee.likelyZigbee, true);
  assert.equal(zigbee.likelyZWave, false);
  assert.equal(zigbee.preferredProtocol, 'zigbee');
  assert.equal(zwave.likelyZWave, true);
  assert.equal(zwave.likelyZigbee, false);
  assert.equal(zwave.preferredProtocol, 'zwave');
});

test('direct radio autodetection does not assign the same serial endpoint to both protocols', () => {
  const ports = [
    enrichSerialPortForDirectRadios(normalizeSerialPort({
      path: '/dev/ttyUSB0',
      product: 'SONOFF Zigbee 3.0 USB Dongle Plus ZBDongle-P'
    }, [])),
    enrichSerialPortForDirectRadios(normalizeSerialPort({
      path: '/dev/ttyACM0',
      product: 'Zooz ZST39 LR Z-Wave SerialAPI USB Stick'
    }, []))
  ];
  const used = new Set();
  const zigbee = choosePortForProtocol(ports, 'zigbee', used);
  used.add(zigbee.path);
  const zwave = choosePortForProtocol(ports, 'zwave', used);

  assert.equal(zigbee.path, '/dev/ttyUSB0');
  assert.equal(zwave.path, '/dev/ttyACM0');
  assert.notEqual(zigbee.path, zwave.path);
});

test('direct radio scoring recognizes stable Linux by-id Zigbee paths with separators', () => {
  const zigbee = enrichSerialPortForDirectRadios(normalizeSerialPort({
    path: '/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_2275350e6ca4ef119f8aaf8086a24396-if00-port0',
    manufacturer: 'ITead',
    vendorId: '10C4',
    productId: 'EA60',
    serialNumber: '2275350e6ca4ef119f8aaf8086a24396',
    pnpId: 'usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_2275350e6ca4ef119f8aaf8086a24396-if00-port0'
  }, []));

  assert.equal(zigbee.likelyZigbee, true);
  assert.equal(zigbee.likelyZWave, false);
  assert.equal(zigbee.likelyThread, false);
  assert.equal(zigbee.preferredProtocol, 'zigbee');
  assert.ok(zigbee.scores.zigbee >= 8);
});

test('direct radio scoring treats generic CP210x as weak without protocol identity', () => {
  const generic = normalizeSerialPort({
    path: '/dev/ttyUSB1',
    manufacturer: 'Silicon Labs',
    product: 'CP2102 USB to UART Bridge Controller',
    vendorId: '10C4',
    productId: 'EA60'
  }, []);

  assert.ok(scorePortForProtocol(generic, 'zigbee') > 0);
  assert.ok(scorePortForProtocol(generic, 'zigbee') < 8);
  assert.ok(scorePortForProtocol(generic, 'zwave') > 0);
  assert.ok(scorePortForProtocol(generic, 'zwave') < 8);
});

test('direct radio scoring reserves SONOFF MG24 sticks for Thread setup by default', () => {
  const mg24 = enrichSerialPortForDirectRadios(normalizeSerialPort({
    path: '/dev/ttyUSB2',
    manufacturer: 'SONOFF',
    product: 'SONOFF Dongle Plus MG24',
    pnpId: 'usb-SONOFF_SONOFF_Dongle_Plus_MG24_c4416e8b64f5ef11996896a29ed47d52-if00-port0',
    vendorId: '10C4',
    productId: 'EA60'
  }, []));

  assert.equal(mg24.likelyThread, true);
  assert.equal(mg24.likelyZigbee, false);
  assert.equal(mg24.preferredProtocol, null);
  assert.ok(scorePortForProtocol(mg24, 'zigbee') < 8);
});

test('direct radio status explains when HomeBrain sees serial endpoints but no native radio stick', async (t) => {
  const originalDirectEnabled = process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED;
  const originalZigbeePort = process.env.HOMEBRAIN_ZIGBEE_PORT;
  const originalZWavePort = process.env.HOMEBRAIN_ZWAVE_PORT;
  delete process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED;
  delete process.env.HOMEBRAIN_ZIGBEE_PORT;
  delete process.env.HOMEBRAIN_ZWAVE_PORT;
  t.after(() => {
    if (originalDirectEnabled === undefined) delete process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED;
    else process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED = originalDirectEnabled;
    if (originalZigbeePort === undefined) delete process.env.HOMEBRAIN_ZIGBEE_PORT;
    else process.env.HOMEBRAIN_ZIGBEE_PORT = originalZigbeePort;
    if (originalZWavePort === undefined) delete process.env.HOMEBRAIN_ZWAVE_PORT;
    else process.env.HOMEBRAIN_ZWAVE_PORT = originalZWavePort;
  });

  const service = new DirectRadioService();
  service.serialPorts = [
    enrichSerialPortForDirectRadios(normalizeSerialPort({
      path: '/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_AG0KWFQA-if00-port0',
      manufacturer: 'FTDI',
      product: 'FT232R USB UART',
      vendorId: '0403',
      productId: '6001'
    }, []))
  ];

  const status = await service.getStatus();

  assert.equal(status.controllers.zigbee.detectedPort, null);
  assert.equal(status.controllers.zwave.detectedPort, null);
  assert.ok(status.controllers.zigbee.diagnostics.some((entry) => /No Zigbee USB adapter detected/i.test(entry)));
  assert.ok(status.controllers.zwave.diagnostics.some((entry) => /No Z-Wave USB adapter detected/i.test(entry)));
  assert.ok(status.diagnostics.some((entry) => entry.includes('/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_AG0KWFQA-if00-port0')));
});

test('direct radio status tolerates Z-Wave node cache startup errors', async () => {
  const service = new DirectRadioService();
  service.zwave.started = true;
  service.detected.zwave = {
    path: '/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00'
  };
  service.zwave.driver = {
    controller: {}
  };
  Object.defineProperty(service.zwave.driver.controller, 'nodes', {
    get() {
      const error = new Error('The controller is not yet ready! (ZW0103)');
      error.code = 'ZW0103';
      throw error;
    }
  });

  const status = await service.getStatus();

  assert.equal(status.controllers.zwave.started, true);
  assert.equal(status.controllers.zwave.pairedNodeCount, 0);
  assert.deepEqual(status.controllers.zwave.nodes, []);
  assert.match(status.controllers.zwave.nodeCacheError, /not yet ready/i);
  assert.ok(status.controllers.zwave.diagnostics.some((entry) => /node cache is still starting/i.test(entry)));
});

test('direct radio status marks running Z-Wave controllers degraded when paired nodes are incomplete', async () => {
  const service = new DirectRadioService();
  service.zwave.started = true;
  service.detected.zwave = {
    path: '/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00'
  };
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, {
          id: 1,
          isControllerNode: true,
          ready: true,
          status: 4
        }],
        [6, {
          id: 6,
          isControllerNode: false,
          ready: true,
          status: 4,
          manufacturerId: 57,
          productType: 18770,
          productId: 12597,
          valueDB: { hasValue: () => true }
        }],
        [14, {
          id: 14,
          isControllerNode: false,
          ready: false,
          status: 3,
          interviewStage: 1,
          isListening: true,
          valueDB: { hasValue: () => false }
        }]
      ])
    }
  };

  const status = await service.getStatus();
  const zwave = status.controllers.zwave;

  assert.equal(zwave.started, true);
  assert.equal(zwave.degraded, true);
  assert.equal(zwave.nonControllerNodeCount, 2);
  assert.equal(zwave.onlineNodeCount, 1);
  assert.equal(zwave.incompleteNodeCount, 1);
  assert.equal(zwave.offlineNodeCount, 1);
  assert.deepEqual(zwave.degradedNodeIds, [14]);
  assert.deepEqual(zwave.nodeHealth.degradedNodeIds, [14]);
  assert.ok(zwave.diagnostics.some((entry) => /node health is degraded/i.test(entry)));
});
