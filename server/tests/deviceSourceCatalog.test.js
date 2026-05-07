const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDeviceSourceFilterQuery,
  buildDeviceSourceOptions,
  canonicalizeDeviceSource,
  getDeviceSource,
  getDeviceSourceFacets,
  getDeviceSourceLabel
} = require('../services/deviceSourceCatalog');

test('device source catalog exposes native radio, Thread, and Matter options even before devices exist', () => {
  const options = buildDeviceSourceOptions([]);
  const values = options.map((option) => option.value);
  const labels = options.map((option) => option.label);

  assert.equal(values.includes('homebrain-zigbee'), true);
  assert.equal(values.includes('homebrain-zwave'), true);
  assert.equal(values.includes('homebrain-thread'), true);
  assert.equal(values.includes('homebrain-matter'), true);
  assert.equal(labels.includes('Zigbee'), true);
  assert.equal(labels.includes('Z-Wave'), true);
  assert.equal(labels.includes('Thread'), true);
  assert.equal(labels.includes('Matter'), true);
});

test('device source catalog canonicalizes source aliases and infers native protocols', () => {
  assert.equal(canonicalizeDeviceSource('zigbee'), 'homebrain-zigbee');
  assert.equal(canonicalizeDeviceSource('z-wave'), 'homebrain-zwave');
  assert.equal(canonicalizeDeviceSource('thread'), 'homebrain-thread');
  assert.equal(canonicalizeDeviceSource('matter'), 'homebrain-matter');
  assert.equal(getDeviceSourceLabel('homebrain-zwave'), 'Z-Wave');

  assert.equal(getDeviceSource({
    properties: {
      homebrainDirect: { protocol: 'zigbee' }
    }
  }), 'homebrain-zigbee');

  assert.equal(getDeviceSource({
    properties: {
      matter: { nodeId: '123', endpointId: 1, transport: 'thread' }
    }
  }), 'homebrain-matter');

  assert.deepEqual(getDeviceSourceFacets({
    properties: {
      source: 'homebrain-matter',
      matter: { nodeId: '123', endpointId: 1, transport: 'thread' }
    }
  }).sort(), ['homebrain-matter', 'homebrain-thread']);
});

test('device source filter query supports aliases and Thread transport facets', () => {
  const matterQuery = buildDeviceSourceFilterQuery('matter');
  assert.equal(matterQuery.$or.some((entry) => entry['properties.source'] instanceof RegExp), true);
  assert.equal(matterQuery.$or.some((entry) => entry['properties.matter.nodeId']), true);
  assert.equal(matterQuery.$or.some((entry) => entry['properties.matterNodeId']), true);

  const threadQuery = buildDeviceSourceFilterQuery('thread');
  assert.equal(threadQuery.$or.some((entry) => entry['properties.matter.transport'] instanceof RegExp), true);
  assert.equal(threadQuery.$or.some((entry) => entry['properties.source'] instanceof RegExp), true);

  const zwaveQuery = buildDeviceSourceFilterQuery('z-wave');
  assert.equal(zwaveQuery.$or.some((entry) => entry['properties.homebrainDirect.protocol'] instanceof RegExp), true);

  const localQuery = buildDeviceSourceFilterQuery('local');
  const inferredSourceExclusions = JSON.stringify(localQuery);
  assert.match(inferredSourceExclusions, /homebrainDirect/);
  assert.match(inferredSourceExclusions, /smartThingsDeviceId/);
  assert.match(inferredSourceExclusions, /matterNodeId/);
});
