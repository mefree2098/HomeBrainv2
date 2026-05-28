const test = require('node:test');
const assert = require('node:assert/strict');

const directRadioProtocolCatalogService = require('../services/directRadioProtocolCatalogService');

test('direct radio protocol catalog summarizes installed Zigbee and Z-Wave upstream databases', async () => {
  const summary = await directRadioProtocolCatalogService.getSummary();

  assert.equal(summary.zigbee.source, 'zigbee-herdsman-converters');
  assert.ok(summary.zigbee.definitionCount > 1000);
  assert.ok(summary.zigbee.vendorCount > 100);
  assert.ok(summary.zigbee.exposesCount > summary.zigbee.definitionCount);
  assert.equal(summary.zwave.source, '@zwave-js/config');
  assert.ok(summary.zwave.deviceConfigCount > 1000);
  assert.ok(summary.zwave.manufacturerCount > 100);
});

test('Zigbee catalog exposes converter metadata and HomeBrain capabilities for Innr SP 224', () => {
  const catalog = directRadioProtocolCatalogService.searchZigbeeCatalog({
    model: 'SP 224',
    includeExposes: true,
    limit: 5
  });

  const entry = catalog.entries.find((candidate) => candidate.model === 'SP 224');
  assert.ok(entry);
  assert.equal(entry.vendor, 'Innr');
  assert.ok(entry.homebrainFeatures.includes('switch'));
  assert.ok(entry.capabilities.some((capability) => capability.type === 'switch'));
  assert.ok(entry.exposes.some((expose) => expose.type === 'switch'));
  assert.ok(entry.toZigbee.some((converter) => converter.keys.includes('state')));
});

test('Z-Wave catalog lookup expands config parameters and association metadata for ZW4008 switches', async () => {
  const entry = await directRadioProtocolCatalogService.lookupZWaveCatalogEntry({
    manufacturerId: '0x041b',
    productType: '0x4952',
    productId: '0x3036'
  });

  assert.ok(entry);
  assert.equal(entry.manufacturer, 'Resideo');
  assert.match(entry.label, /ZW4008/);
  assert.ok(entry.homebrainFeatures.includes('switch'));
  assert.ok(entry.configParameters.some((parameter) => parameter.label === 'LED Light'));
  assert.ok(entry.associations.some((association) => association.label === 'Lifeline'));
  const manualUrl = new URL(entry.metadata.manual);
  assert.equal(manualUrl.hostname, 'products.z-wavealliance.org');
});
