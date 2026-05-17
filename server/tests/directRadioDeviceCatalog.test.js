const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMigrationPlan,
  inferFeaturesFromSmartThings,
  inferProtocolFromSmartThings,
  isCloudOrVirtualOnly
} = require('../services/directRadioDeviceCatalog');

test('direct radio catalog maps Z-Wave lock migration with battery support', () => {
  const device = {
    _id: 'lock-1',
    name: 'Front Deadbolt',
    type: 'lock',
    brand: 'Schlage',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-lock-1',
      smartThingsCapabilities: ['lock', 'lockCodes', 'battery'],
      smartThingsCategories: ['Lock']
    }
  };

  assert.equal(inferProtocolFromSmartThings(device), 'zwave');
  assert.deepEqual(inferFeaturesFromSmartThings(device), ['battery', 'lock', 'lockCodes']);

  const plan = buildMigrationPlan(device);
  assert.equal(plan.recommendedProtocol, 'zwave');
  assert.equal(plan.targetSource, 'homebrain-zwave');
  assert.equal(plan.supported, true);
  assert.ok(plan.warnings.some((warning) => warning.includes('Door locks')));
  assert.ok(plan.featureSupport.some((feature) => feature.key === 'battery' && feature.supported));
  assert.equal(plan.instructionProfile.key, 'zwave-lock-schlage-connect');
  assert.deepEqual(plan.guidedSteps.map((step) => step.action).slice(0, 4), [
    'start_zwave_exclusion',
    'user_confirm',
    'start_direct_migration',
    'user_confirm'
  ]);
  assert.ok(plan.guidedSteps.some((step) => step.instructions.some((instruction) => instruction.includes('programming code'))));
  assert.ok(!plan.manualSteps.join(' ').includes('manufacturer instructions'));
});

test('direct radio catalog maps SmartThings multipurpose sensors toward Zigbee', () => {
  const device = {
    _id: 'sensor-1',
    name: 'Back Door Multipurpose Sensor',
    type: 'sensor',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-sensor-1',
      smartThingsDeviceTypeName: 'SmartThings Multipurpose Sensor',
      smartThingsCapabilities: ['contactSensor', 'temperatureMeasurement', 'threeAxis', 'accelerationSensor', 'battery']
    }
  };

  const plan = buildMigrationPlan(device);
  assert.equal(plan.recommendedProtocol, 'zigbee');
  assert.equal(plan.targetSource, 'homebrain-zigbee');
  assert.deepEqual(plan.features, ['acceleration', 'axis', 'battery', 'contact', 'temperature']);
  assert.ok(plan.guidedSteps.some((step) => step.action === 'start_direct_migration'));
  assert.ok(plan.guidedSteps.some((step) => step.instructions.some((instruction) => instruction.includes('Connect button'))));
  assert.ok(plan.manualSteps.some((step) => step.includes('Zigbee pairing') || step.includes('Connect button')));
});

test('direct radio catalog leaves cloud and virtual SmartThings helpers out of native migration', () => {
  const device = {
    _id: 'virtual-1',
    name: 'SmartThings Home Monitor Virtual Switch',
    type: 'switch',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-virtual-1',
      smartThingsDeviceNetworkType: 'CLOUD',
      smartThingsCapabilities: ['switch']
    }
  };

  assert.equal(isCloudOrVirtualOnly(device), true);
  const plan = buildMigrationPlan(device);
  assert.equal(plan.supported, false);
  assert.deepEqual(plan.guidedSteps, []);
  assert.deepEqual(plan.manualSteps, []);
  assert.equal(plan.instructionProfile, null);
  assert.ok(plan.warnings.some((warning) => warning.includes('cloud, virtual')));
});
