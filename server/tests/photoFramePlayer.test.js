const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeConfig } = require('../services/photoFrameConfig');

const source = fs.readFileSync(path.join(__dirname, '../assets/photo-frame-player/player.js'), 'utf8');
const FRAME = '123456789012345678901234';
const TOKEN = 'a'.repeat(64);
const CREDENTIALS = 'homebrain.frame.credentials.v1';
const MANIFEST = 'homebrain.frame.manifest.v1';

async function openOfflinePlayer(fragment) {
  const config = normalizeConfig();
  for (const overlay of Object.values(config.overlays)) overlay.enabled = false;
  const manifest = { frameId: FRAME, config, photos: [], values: {}, generatedAt: new Date().toISOString() };
  const storage = new Map([
    [CREDENTIALS, JSON.stringify({ frameId: FRAME, token: TOKEN })],
    [MANIFEST, JSON.stringify(manifest)]
  ]);
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, className: '', textContent: '', hidden: false, addEventListener() {} });
      return elements.get(id);
    }
  };
  const window = { addEventListener() {}, AbortController };
  const location = { href: 'http://frame.test/api/photo-frames/player/' + fragment, origin: 'http://frame.test', hash: fragment, pathname: '/api/photo-frames/player/', search: '' };
  let fragmentRemoved = false;
  vm.runInNewContext(source, {
    window, document, location, URL, URLSearchParams, AbortController,
    innerWidth: 1280, innerHeight: 800,
    history: { replaceState() { fragmentRemoved = true; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async () => { throw new Error('Hub offline'); },
    setInterval() {}, setTimeout() {}, clearTimeout() {}
  });
  await new Promise(resolve => setImmediate(resolve));
  return { storage, elements, status: window.HomeBrainFrameStatus(), fragmentRemoved };
}

test('native relaunch with the same pairing fragment restores the saved layout while offline', async () => {
  const result = await openOfflinePlayer(`#frame=${FRAME}&token=${TOKEN}`);
  assert.equal(result.status.frameId, FRAME);
  assert.equal(result.elements.get('canvas').style.width, '1280px');
  assert.match(result.elements.get('connection').textContent, /showing cached photos/);
  assert.ok(result.storage.has(MANIFEST));
  assert.equal(result.fragmentRemoved, true);
});

test('a replacement credential discards the previous cached layout before contacting an offline hub', async () => {
  for (const fragment of [
    `#frame=${FRAME}&token=${'b'.repeat(64)}`,
    `#frame=123456789012345678901235&token=${TOKEN}`
  ]) {
    const result = await openOfflinePlayer(fragment);
    assert.equal(result.status.frameId, null);
    assert.equal(result.storage.has(MANIFEST), false);
    assert.match(result.elements.get('connection').textContent, /Connecting to HomeBrain/);
  }
});
