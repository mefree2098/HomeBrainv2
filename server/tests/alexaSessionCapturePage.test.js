const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const capturePagePath = path.resolve(__dirname, '../../client/public/alexa-session-capture.html');
const captureScriptPath = path.resolve(__dirname, '../../client/public/alexa-session-capture.js');

function renderCapturePage() {
  const elements = new Map();
  const timers = [];
  const messages = [];
  const listeners = {};
  const window = {
    location: {
      origin: 'https://homebrain.example.com',
      search: '?captureId=test&token=test-token&receiver=https://homebrain.example.com/complete&status=https://homebrain.example.com/status'
    },
    addEventListener: (type, callback) => { listeners[type] = callback; },
    postMessage: (message) => { messages.push(message); }
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          textContent: '',
          classList: { add() {}, remove() {} },
          addEventListener(type, callback) { this[type] = callback; }
        });
      }
      return elements.get(id);
    }
  };
  vm.runInNewContext(fs.readFileSync(captureScriptPath, 'utf8'), {
    window, document, URLSearchParams,
    fetch: async () => ({ json: async () => ({ capture: { status: 'pending' } }) }),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); }
  });
  return { elements, timers, messages, listeners, window };
}

test('Alexa session capture page uses an external script allowed by production CSP', () => {
  const html = fs.readFileSync(capturePagePath, 'utf8');
  const inlineScriptPattern = /<script\b(?![^>]*\bsrc=)[^>]*>/i;

  assert.equal(inlineScriptPattern.test(html), false);
  assert.match(html, /<script\b[^>]*\bsrc="\/alexa-session-capture\.js"[^>]*\bdefer\b[^>]*><\/script>/i);
  assert.equal(fs.existsSync(captureScriptPath), true);
});

test('pending capture polls preserve the missing-helper error and cannot pretend to open login', async () => {
  const page = renderCapturePage();
  await new Promise(setImmediate);
  page.timers.find((timer) => timer.delay === 1400).callback();
  const poll = page.timers.find((timer) => timer.delay !== 1400);
  assert.ok(poll.delay >= 5000, 'both capture polling streams must fit the shared rate limit');
  await poll.callback();
  assert.equal(page.elements.get('status-title').textContent, 'Helper extension was not detected');
  page.elements.get('open-login').click();
  assert.equal(page.messages.length, 0);
  assert.equal(page.elements.get('status-title').textContent, 'Helper extension was not detected');
});

test('a helper announcement from the same window and origin starts capture and updates pending status', async () => {
  const page = renderCapturePage();
  await new Promise(setImmediate);
  const data = { type: 'homebrain-alexa-session-capture:helper-available', version: '1.0.0' };
  page.listeners.message({ source: page.window, origin: 'https://other.example.com', data });
  assert.equal(page.messages.length, 0);
  page.listeners.message({ source: page.window, origin: page.window.location.origin, data });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].type, 'homebrain-alexa-session-capture:start');
  assert.equal(page.messages[0].payload.loginUrl, 'https://alexa.amazon.com/');
  await page.timers.find((timer) => timer.delay !== 1400).callback();
  assert.equal(page.elements.get('status-title').textContent, 'Waiting for Alexa login...');
});

test('pending server polls retain nonsecret helper progress', async () => {
  const page = renderCapturePage();
  await new Promise(setImmediate);
  const event = (data) => page.listeners.message({ source: page.window, origin: page.window.location.origin, data });
  event({ type: 'homebrain-alexa-session-capture:helper-available' });
  event({ type: 'homebrain-alexa-session-capture:progress', message: 'Waiting for Amazon session cookies: csrf.', missingCookieNames: ['csrf'] });
  await page.timers.find((timer) => timer.delay !== 1400).callback();
  assert.equal(page.elements.get('status-copy').textContent, 'Waiting for Amazon session cookies: csrf.');
  assert.equal(page.elements.get('details').textContent, 'csrf');
});
