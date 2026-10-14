const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/photo-frame-player/security.js'), 'utf8');

function player({ preview = false, pinRequired = true, alarmState = 'disarmed' } = {}) {
  const elements = new Map(); const intervals = []; const requests = [];
  let now = 1000; let revoked = 0; let rejectPin = false; let offline = false;
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.textContent = ''; this.listeners = {}; this.children = []; this.isConnected = true; }
    addEventListener(event, handler) { this.listeners[event] = handler; }
    setAttribute(name, value) { this[name] = value; }
    appendChild(child) { this.children.push(child); }
    get firstElementChild() { return this.children[0]; }
    focus() { document.activeElement = this; }
    async click() { if (!this.disabled) await this.listeners.click?.(); }
  }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); } };
  const info = () => ({ alarmState, available: true, pinSettings: { requireForArm: pinRequired, requireForDisarm: pinRequired } });
  const window = {};
  vm.runInNewContext(source, {
    window, document, AbortController,
    Date: { now: () => now },
    localStorage: { setItem() { throw new Error('PIN must never be persisted'); } },
    setInterval(callback) { intervals.push(callback); }, setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      if (offline) throw new Error('Hub offline');
      if (options.method === 'POST' && rejectPin) return { ok: false, status: 401, json: async () => ({ success: false, message: 'Invalid security PIN' }) };
      if (options.method === 'POST') alarmState = options.body.includes('disarm') ? 'disarmed' : 'armedStay';
      return { ok: true, json: async () => ({ success: true, security: info() }) };
    }
  });
  const ui = window.HomeBrainFrameSecurity({ preview, getCredentials: () => ({ frameId: '123456789012345678901234', token: 'a'.repeat(64) }), getPreviewStatus: info, onRevoked: async () => { revoked++; } });
  const element = id => document.getElementById(id);
  async function open() { ui.update(true, false); ui.open(); await new Promise(resolve => setImmediate(resolve)); }
  async function digits(value) {
    for (const digit of value) await element('security-keypad').children.find(button => button.textContent === digit).click();
  }
  return { ui, element, requests, open, digits, revoked: () => revoked, rejectPin: value => { rejectPin = value; }, offline: () => { offline = true; }, expire: () => { now += 31000; intervals.forEach(callback => callback()); } };
}

test('preview controls show the center PIN pad and never send network commands', async () => {
  const p = player({ preview: true }); await p.open(); await p.element('security-arm-stay').click();
  assert.equal(p.element('security-pin').hidden, false); await p.digits('1234');
  assert.equal(p.element('security-pin-dots').textContent, '••••');
  await p.element('security-submit').click(); assert.deepEqual(p.requests, []);
  assert.equal(p.element('security-pin-dots').textContent, ''); assert.match(p.element('security-message').textContent, /No security command/);
});

test('touch commands require confirmation; PIN rejection clears digits and preserves frame pairing', async () => {
  const p = player({ alarmState: 'armedAway' }); await p.open(); await p.element('security-disarm').click();
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
  assert.equal(p.element('security-submit').disabled, true); await p.digits('1234'); p.rejectPin(true);
  await p.element('security-submit').click(); assert.equal(p.revoked(), 0);
  assert.equal(p.element('security-pin-dots').textContent, ''); assert.equal(p.element('security-submit').disabled, true);
  const sent = p.requests.find(r => r.method === 'POST'); assert.deepEqual(sent.body, { action: 'disarm', pin: '1234' });
  assert.equal(sent.credentials, 'omit'); assert.equal(sent.redirect, 'error'); assert.equal(sent.headers.Authorization, undefined);
  p.rejectPin(false); await p.digits('1234'); await p.element('security-submit').click();
  assert.equal(p.element('security-state').textContent, 'Disarmed'); assert.equal(p.element('security-confirm').hidden, true);
});

test('PIN-disabled platforms use confirmation without a keypad or a fabricated PIN', async () => {
  const p = player({ pinRequired: false }); await p.open(); await p.element('security-arm-away').click();
  assert.equal(p.element('security-pin').hidden, true); assert.equal(p.element('security-submit').disabled, false);
  await p.element('security-submit').click(); assert.deepEqual(p.requests.find(r => r.method === 'POST').body, { action: 'armAway' });
});

test('closing, inactivity, or disabling security clears an entered PIN without sending a command', async () => {
  for (const finish of [p => p.element('security-cancel').click(), p => p.expire(), p => p.ui.update(false, false)]) {
    const p = player(); await p.open(); await p.element('security-arm-stay').click(); await p.digits('1234');
    await finish(p); assert.equal(p.element('security-modal').hidden, true); assert.equal(p.element('security-pin-dots').textContent, '');
    assert.equal(p.requests.filter(r => r.method === 'POST').length, 0);
  }
});

test('offline security cannot submit a command while cached photos remain available', async () => {
  const p = player(); p.offline(); await p.open();
  assert.equal(p.element('security-arm-stay').disabled, true); assert.equal(p.element('security-disarm').disabled, true);
  await p.element('security-arm-stay').click(); await p.element('security-submit').click();
  assert.equal(p.requests.filter(r => r.method === 'POST').length, 0); assert.match(p.element('security-message').textContent, /Hub offline/);
});
