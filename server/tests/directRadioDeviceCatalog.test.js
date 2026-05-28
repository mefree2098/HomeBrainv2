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

test('direct radio catalog maps Kwikset SmartCode 916 locks with native PIN support', () => {
  const device = {
    _id: 'kwikset-916',
    name: 'Kwikset 99160-002 916 Z-Wave SmartCode Touchscreen Electronic Deadbolt',
    type: 'lock',
    brand: 'Kwikset',
    model: '99160-002 916 SmartCode',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-kwikset-916',
      smartThingsDeviceNetworkType: 'ZWAVE',
      smartThingsCapabilities: ['lock', 'lockCodes', 'battery', 'refresh'],
      smartThingsCategories: ['smartlock']
    }
  };

  const plan = buildMigrationPlan(device);

  assert.equal(inferProtocolFromSmartThings(device), 'zwave');
  assert.deepEqual(inferFeaturesFromSmartThings(device), ['battery', 'lock', 'lockCodes']);
  assert.equal(plan.supported, true);
  assert.equal(plan.recommendedProtocol, 'zwave');
  assert.equal(plan.targetSource, 'homebrain-zwave');
  assert.equal(plan.instructionProfile.key, 'zwave-lock-kwikset-smartcode');
  assert.ok(plan.instructionProfile.reference.includes('99160-002'));
  assert.ok(plan.featureSupport.some((feature) => feature.key === 'lockCodes' && feature.supported));
  assert.ok(plan.guidedSteps.some((step) => step.action === 'start_zwave_exclusion'));
  assert.ok(plan.guidedSteps.some((step) => step.action === 'start_direct_migration' && step.durationSeconds >= 240));
  const planText = [
    ...plan.manualSteps,
    ...plan.guidedSteps.flatMap((step) => step.instructions)
  ].join(' ');
  assert.ok(planText.includes('button A'));
  assert.ok(planText.includes('Program'));
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

test('direct radio catalog does not treat Energy Monitoring room names as Ring devices', () => {
  const device = {
    _id: 'meter-1',
    name: 'Panel A Energy Monitor',
    type: 'switch',
    room: 'Energy Monitoring',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-meter-1',
      smartThingsDeviceNetworkType: 'ZWAVE',
      smartThingsCapabilities: ['powerMeter', 'energyMeter', 'refresh'],
      smartThingsCategories: ['curbPowerMeter']
    }
  };

  assert.equal(isCloudOrVirtualOnly(device), false);
  const plan = buildMigrationPlan(device);
  assert.equal(plan.supported, true);
  assert.equal(plan.recommendedProtocol, 'zwave');
  assert.equal(plan.targetSource, 'homebrain-zwave');
  assert.ok(plan.featureSupport.some((feature) => feature.key === 'power' && feature.supported));
  assert.ok(plan.featureSupport.some((feature) => feature.key === 'energy' && feature.supported));
});

test('direct radio catalog honors SmartThings direct-radio network type before virtual room labels', () => {
  const device = {
    _id: 'cold-storage-switch',
    name: 'Cold Storage Switch',
    type: 'switch',
    room: 'Virtual Switches',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-cold-storage-switch',
      smartThingsDeviceNetworkType: 'ZWAVE',
      smartThingsCapabilities: ['switch', 'refresh'],
      smartThingsCategories: ['switch']
    }
  };

  assert.equal(isCloudOrVirtualOnly(device), false);
  const plan = buildMigrationPlan(device);
  assert.equal(plan.supported, true);
  assert.equal(plan.cloudOrVirtualOnly, false);
  assert.equal(plan.recommendedProtocol, 'zwave');
  assert.equal(plan.targetSource, 'homebrain-zwave');
  assert.ok(plan.guidedSteps.some((step) => step.action === 'start_zwave_exclusion'));
  assert.ok(!plan.warnings.some((warning) => warning.includes('cloud, virtual')));
});

test('direct radio catalog still blocks explicit SmartThings virtual network types', () => {
  const device = {
    _id: 'explicit-virtual-switch',
    name: 'Explicit Virtual Switch',
    type: 'switch',
    room: 'Virtual Switches',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-explicit-virtual-switch',
      smartThingsDeviceNetworkType: 'VIRTUAL',
      smartThingsCapabilities: ['switch'],
      smartThingsCategories: ['switch']
    }
  };

  assert.equal(isCloudOrVirtualOnly(device), true);
  const plan = buildMigrationPlan(device);
  assert.equal(plan.supported, false);
  assert.equal(plan.cloudOrVirtualOnly, true);
  assert.deepEqual(plan.guidedSteps, []);
  assert.equal(plan.instructionProfile, null);
});

test('direct radio catalog excludes non-radio SmartThings network types', () => {
  const device = {
    _id: 'hub-1',
    name: 'Janisary Hub',
    type: 'switch',
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-hub-1',
      smartThingsDeviceNetworkType: 'HUB',
      smartThingsCapabilities: ['switch']
    }
  };

  assert.equal(isCloudOrVirtualOnly(device), true);
  const plan = buildMigrationPlan(device);
  assert.equal(plan.supported, false);
  assert.deepEqual(plan.guidedSteps, []);
  assert.deepEqual(plan.manualSteps, []);
  assert.equal(plan.instructionProfile, null);
});
