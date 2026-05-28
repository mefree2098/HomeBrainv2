const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const directRadioProtocolCatalogService = require('../services/directRadioProtocolCatalogService');

test('direct radio protocol catalog summarizes installed and protocol-specific upstream databases', async () => {
  const summary = await directRadioProtocolCatalogService.getSummary();

  assert.equal(summary.zigbee.source, 'zigbee-herdsman-converters');
  assert.ok(summary.zigbee.definitionCount > 1000);
  assert.ok(summary.zigbee.vendorCount > 100);
  assert.ok(summary.zigbee.exposesCount > summary.zigbee.definitionCount);
  assert.equal(summary.zwave.source, '@zwave-js/config');
  assert.ok(summary.zwave.deviceConfigCount > 1000);
  assert.ok(summary.zwave.manufacturerCount > 100);
  assert.ok(summary.matter.standardDeviceTypeCount > 50);
  assert.equal(summary.thread.source, 'Thread Group Certified Products + Matter over Thread descriptors');
  assert.ok(summary.insteon.categoryCount >= 10);
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

test('Zigbee protocol catalog infers siren alarm and chime capabilities', () => {
  const features = directRadioProtocolCatalogService._test.inferZigbeeFeaturesFromExposes([
    { type: 'enum', name: 'warning_mode', property: 'warning_mode' },
    { type: 'enum', name: 'melody', property: 'melody' },
    { type: 'binary', name: 'tamper', property: 'tamper' }
  ], {
    model: 'SIRZB-110',
    vendor: 'Example',
    description: 'Zigbee siren alarm sounder'
  });

  assert.ok(features.includes('alarm'));
  assert.ok(features.includes('chime'));
  assert.ok(features.includes('tamper'));
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

test('Z-Wave protocol catalog infers siren alarm capabilities from config text', () => {
  const features = directRadioProtocolCatalogService._test.inferZWaveFeaturesFromText([
    'Aeotec Siren 6',
    'Z-Wave Plus siren with sound switch and chime tones'
  ]);

  assert.ok(features.includes('alarm'));
  assert.ok(features.includes('chime'));
});

test('Matter catalog matches runtime descriptors to standard device types and HomeBrain capabilities', async () => {
  const entry = await directRadioProtocolCatalogService.lookupMatterCatalogEntry({
    deviceTypeNames: ['DimmableLight'],
    clusterIds: [6, 8],
    basicInformation: {
      productName: 'Desk Lamp'
    }
  });

  assert.ok(entry);
  assert.equal(entry.protocol, 'matter');
  assert.equal(entry.deviceTypeName, 'DimmableLight');
  assert.ok(entry.homebrainFeatures.includes('switch'));
  assert.ok(entry.homebrainFeatures.includes('brightness'));
  assert.ok(entry.capabilities.some((capability) => capability.type === 'dimmer'));
});

test('INSTEON catalog matches DevCat/SubCat metadata to a controllable feature profile', () => {
  const entry = directRadioProtocolCatalogService.lookupInsteonCatalogEntry({
    deviceCategory: 0x01,
    subcategory: 0x2E,
    productKey: '2477D'
  });

  assert.ok(entry);
  assert.equal(entry.protocol, 'insteon');
  assert.equal(entry.categoryHex, '0x01');
  assert.ok(entry.homebrainFeatures.includes('switch'));
  assert.ok(entry.homebrainFeatures.includes('brightness'));
});

test('device library refresh stores only newly discovered external records', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-device-library-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(dataDir, 'matter-dcl-models.json'), JSON.stringify({
    models: [{ vid: 1, pid: 1, deviceTypeId: 257, productName: 'Existing Matter Plug' }]
  }), 'utf8');
  await fs.writeFile(path.join(dataDir, 'thread-certified-products.json'), JSON.stringify({
    products: [{ name: 'Existing Thread Sensor', description: 'Contact sensor' }]
  }), 'utf8');
  await fs.writeFile(path.join(dataDir, 'insteon-device-list.json'), JSON.stringify({
    devices: [{ deviceName: 'Existing Dimmer', productId: '2477D', devCat: '0x01', subCat: '0x2E' }]
  }), 'utf8');

  const fetchImpl = async (url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'on.dcl.csa-iot.org' && parsedUrl.pathname === '/dcl/model/models') {
      return {
        ok: true,
        json: async () => ({
          model: [
            { vid: 1, pid: 1, deviceTypeId: 257, productName: 'Existing Matter Plug' },
            { vid: 2, pid: 3, deviceTypeId: 266, productName: 'New Matter Lock' }
          ],
          pagination: {}
        })
      };
    }
    if (parsedUrl.hostname === 'threadgroup.org') {
      return {
        ok: true,
        text: async () => `
          <div id="prod-sec2"><h1>Existing Thread Sensor</h1><p>Contact sensor<br /></p></div>
          <div id="prod-sec2"><h1>New Thread Outlet</h1><p>Smart plug<br /></p></div>
        `
      };
    }
    if (parsedUrl.hostname === 'docs.google.com') {
      return {
        ok: true,
        text: async () => [
          'Device Name,Product ID,DevCat,SubCat,i1/i2,Firmware,IPK - Insteon,Label on,Purchase',
          ',,,,,,Product Key,Device,Date',
          'Existing Dimmer,2477D,0x01,0x2E,i2,0x45,0x000001,,',
          'New On Off Outlet,2663-222,0x02,0x39,i2cs,0x42,0x000002,,'
        ].join('\n')
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await directRadioProtocolCatalogService.refreshExternalCatalogs({
    force: true,
    dataDir,
    fetchImpl,
    timeoutMs: 0
  });

  assert.equal(result.success, true);
  assert.equal(result.sources.matter.addedCount, 1);
  assert.equal(result.sources.thread.addedCount, 1);
  assert.equal(result.sources.insteon.addedCount, 1);

  const status = directRadioProtocolCatalogService.getUpdateStatus({ dataDir });
  assert.equal(status.snapshots.matter.count, 2);
  assert.equal(status.snapshots.thread.count, 2);
  assert.equal(status.snapshots.insteon.count, 2);
});
