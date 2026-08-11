'use strict';

// Phase 0c coverage: ensureControllerConfig must never silently regenerate a
// random Zigbee network key when a prior network exists, because that forces
// zigbee-herdsman to form a new network and unpairs every device. It should
// recover credentials from the coordinator backup, and refuse (flag a reset
// risk) when a prior network exists but is unrecoverable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must point the data dir at a temp location BEFORE requiring the service,
// because the module resolves its data paths at load time.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-radio-cfg-'));
process.env.HOMEBRAIN_DIRECT_RADIO_DATA_DIR = TMP_DATA_DIR;

const ZIGBEE_DIR = path.join(TMP_DATA_DIR, 'zigbee');
const CONFIG_PATH = path.join(TMP_DATA_DIR, 'controller-config.json');
fs.mkdirSync(ZIGBEE_DIR, { recursive: true });

const directRadioService = require('../services/directRadioService');

const SAMPLE_BACKUP = {
  metadata: { format: 'zigbee-herdsman', version: 1 },
  coordinator_ieee: '0x00124b0000000000',
  pan_id: '1a62',
  extended_pan_id: 'dddddddddddddddd',
  channel: 20,
  network_key: { key: '0123456789abcdef0123456789abcdef', frame_counter: 100, sequence_number: 0 } // gitleaks:allow
};

function clearState() {
  for (const file of [
    CONFIG_PATH,
    path.join(ZIGBEE_DIR, 'coordinator-backup.json'),
    path.join(ZIGBEE_DIR, 'database.db')
  ]) {
    try { fs.rmSync(file, { force: true }); } catch (_error) { /* ignore */ }
  }
}

test('parseHexBytes validates length and charset', () => {
  assert.deepStrictEqual(directRadioService.parseHexBytes('0a0b', 2), [0x0a, 0x0b]);
  assert.deepStrictEqual(directRadioService.parseHexBytes('0xA0B1', 2), [0xa0, 0xb1]);
  assert.strictEqual(directRadioService.parseHexBytes('0a0b', 3), null);
  assert.strictEqual(directRadioService.parseHexBytes('xyz0', 2), null);
  assert.strictEqual(directRadioService.parseHexBytes(null, 2), null);
});

test('deriveZigbeeNetworkFromBackup parses a valid herdsman backup', () => {
  const net = directRadioService.deriveZigbeeNetworkFromBackup(SAMPLE_BACKUP);
  assert.ok(net, 'derived a network');
  assert.strictEqual(net.panID, 0x1a62);
  assert.deepStrictEqual(net.extendedPanID, [0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd]);
  assert.strictEqual(net.networkKey.length, 16);
  assert.strictEqual(net.networkKey[0], 0x01);
  assert.strictEqual(net.networkKey[15], 0xef);
  assert.deepStrictEqual(net.channelList, [20]);
  assert.strictEqual(directRadioService.isCompleteZigbeeNetwork(net), true);
});

test('deriveZigbeeNetworkFromBackup rejects malformed backups', () => {
  assert.strictEqual(directRadioService.deriveZigbeeNetworkFromBackup(null), null);
  assert.strictEqual(directRadioService.deriveZigbeeNetworkFromBackup({}), null);
  assert.strictEqual(
    directRadioService.deriveZigbeeNetworkFromBackup({ ...SAMPLE_BACKUP, network_key: { key: 'tooshort' } }),
    null
  );
  assert.strictEqual(
    directRadioService.deriveZigbeeNetworkFromBackup({ ...SAMPLE_BACKUP, extended_pan_id: 'zz' }),
    null
  );
});

test('ensureControllerConfig recovers credentials from the coordinator backup instead of regenerating', async () => {
  clearState();
  fs.writeFileSync(path.join(ZIGBEE_DIR, 'coordinator-backup.json'), JSON.stringify(SAMPLE_BACKUP));

  const config = await directRadioService.ensureControllerConfig();

  assert.strictEqual(directRadioService.zigbee.networkRecovered, true, 'flagged as recovered');
  assert.strictEqual(directRadioService.zigbee.networkResetRisk, false);
  assert.strictEqual(config.zigbee.panID, 0x1a62, 'used backup PAN ID, not a random one');
  assert.strictEqual(config.zigbee.networkKey[0], 0x01, 'used backup network key');

  const persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.strictEqual(persisted.zigbee.panID, 0x1a62, 'healed the config file with recovered creds');
});

test('ensureControllerConfig refuses to mint a new key when a prior network is unrecoverable', async () => {
  clearState();
  // A non-empty herdsman database implies a prior paired network, but there is
  // no backup and no config to recover credentials from.
  fs.writeFileSync(path.join(ZIGBEE_DIR, 'database.db'), '{"id":1,"type":"Coordinator"}\n');

  const config = await directRadioService.ensureControllerConfig();

  assert.strictEqual(directRadioService.zigbee.networkResetRisk, true, 'flagged reset risk');
  assert.ok(!directRadioService.isCompleteZigbeeNetwork(config.zigbee), 'did not produce usable random creds');

  const persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.ok(
    !persisted.zigbee || !directRadioService.isCompleteZigbeeNetwork(persisted.zigbee),
    'did not persist random zigbee credentials'
  );
});

test('ensureControllerConfig generates fresh credentials on a clean first-time setup', async () => {
  clearState();

  const config = await directRadioService.ensureControllerConfig();

  assert.strictEqual(directRadioService.zigbee.networkResetRisk, false);
  assert.strictEqual(directRadioService.zigbee.networkRecovered, false);
  assert.strictEqual(directRadioService.isCompleteZigbeeNetwork(config.zigbee), true, 'generated complete creds');
  assert.ok(config.zwave.securityKeys.S2_AccessControl, 'z-wave keys still present');
});
