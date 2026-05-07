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
