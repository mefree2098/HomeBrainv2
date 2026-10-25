const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helper = path.resolve(__dirname, '../assets/alexa-session-helper');

function fixture(initialCookies, options = {}) {
  let cookies = initialCookies;
  const captureId = 'capture-fixture-1234';
  const token = 'fixture-token-123456789012345678901234567890';
  const origin = 'https://homebrain.example.com';
  const page = `${origin}/alexa-session-capture.html?captureId=${captureId}&token=${token}`;
  const payload = { captureId, token, receiverUrl: `${origin}/api/alexa/session-capture/${captureId}/complete`, loginUrl: 'https://alexa.amazon.com/', serviceHost: 'pitangui.amazon.com', amazonPage: 'amazon.com' };
  const sender = { id: 'reviewed-helper', frameId: 0, tab: { id: 99, url: page }, url: page };
  const intervals = new Map();
  const timeouts = new Map();
  const windows = [];
  const posts = [];
  const requests = [];
  const workerRequests = [];
  const cookieQueries = [];
  let workerMessage;
  let contentMessage;
  let removed;
  let clock = 0;
  let cookieReads = 0;
  const runtime = { id: sender.id, getManifest: () => ({ version: '1.0.2', content_scripts: [{ matches: [`${origin}/*`] }] }) };
  const location = new URL(page);
  vm.runInNewContext(fs.readFileSync(path.join(helper, 'content.js'), 'utf8'), {
    URLSearchParams, AbortSignal,
    window: { location, addEventListener() {}, postMessage: (message) => { posts.push(message); } },
    setTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    chrome: { runtime: { ...runtime, onMessage: { addListener: (callback) => { contentMessage = callback; } } } }
  });
  const chrome = {
    runtime: { ...runtime, onMessage: { addListener: (callback) => { workerMessage = callback; } } },
    cookies: { getAll: async (query) => {
      cookieReads += 1;
      cookieQueries.push(query);
      return query.partitionKey ? (options.partitionedCookies || []) : cookies;
    } },
    windows: { create: async (options) => { windows.push(options); } },
    tabs: {
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 99);
        return new Promise((resolve) => {
          const asynchronous = contentMessage(message, { id: runtime.id }, resolve);
          if (!asynchronous) resolve(undefined);
        });
      },
      onRemoved: { addListener: (callback) => { removed = callback; } }
    },
    webNavigation: { onCompleted: { addListener() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(helper, 'background.js'), 'utf8'), {
    chrome, URL, AbortController, Date: { now: () => clock }, navigator: { userAgent: 'test helper' },
    setTimeout: (callback, ms) => { const id = Symbol(); timeouts.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (callback) => { const id = Symbol(); intervals.set(id, callback); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    fetch: async (url, request) => {
      workerRequests.push({ url, options: request });
      assert.equal(request.method, 'GET', 'The worker must not post session cookies cross-origin');
      if (options.bootstrapFetch) return options.bootstrapFetch(url, request);
      if (options.bootstrapCookies) cookies = options.bootstrapCookies;
      return { body: { cancel: async () => {} } };
    }
  });
  return {
    payload, sender, windows, posts, requests, workerRequests, cookieQueries, intervals, timeouts,
    start: (overrides = {}, actor = sender) => new Promise((resolve) => workerMessage({ type: 'START_ALEXA_SESSION_CAPTURE', payload: { ...payload, ...overrides } }, actor, resolve)),
    close: (id = 99) => removed(id),
    advance: (ms) => { clock += ms; },
    cookieReads: () => cookieReads,
    setCookies: (nextCookies) => { cookies = nextCookies; },
    contentMessage
  };
}

const cookie = (name) => ({ domain: '.amazon.com', path: '/', name, value: `fixture-secret-${name}` });

test('helper returns cookies only through its same-origin content script without exposing them to page messages', async () => {
  const f = fixture(['session-id', 'session-token', 'csrf'].map(cookie));
  assert.equal((await f.start()).success, true);
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 1);
  assert.equal(f.workerRequests.length, 0);
  assert.equal(f.requests[0].url, f.payload.receiverUrl);
  assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.equal(JSON.parse(f.requests[0].options.body).token, f.payload.token);
  assert.match(JSON.parse(f.requests[0].options.body).cookie, /fixture-secret-csrf/);
  assert.equal(JSON.stringify(f.posts).includes('fixture-secret-'), false);
  assert.equal(f.intervals.size, 0);
});

test('helper reports missing cookie names without revealing cookie values and expires collection', async () => {
  const f = fixture(['session-id', 'session-token'].map(cookie));
  await f.start();
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 0);
  const progress = f.posts.find((p) => p.type === 'homebrain-alexa-session-capture:progress');
  assert.deepEqual(Array.from(progress.missingCookieNames), ['csrf']);
  assert.equal(JSON.stringify(f.posts).includes('fixture-secret-'), false);
  const reads = f.cookieReads();
  f.advance(10 * 60 * 1000);
  await [...f.intervals.values()][0]();
  assert.equal(f.cookieReads(), reads);
  assert.equal(f.intervals.size, 0);
});

test('helper obtains Amazon-issued CSRF through a read-only bootstrap before returning the session', async () => {
  const f = fixture(['session-id', 'session-token'].map(cookie), {
    bootstrapCookies: ['session-id', 'session-token', 'csrf'].map(cookie)
  });
  await f.start();
  await new Promise(setImmediate);
  assert.equal(f.workerRequests.length, 1);
  const request = f.workerRequests[0];
  assert.equal(request.url, 'https://pitangui.amazon.com/api/language');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers.Cookie, undefined);
  assert.equal(request.options.body, undefined);
  assert.equal(f.requests.length, 1);
  assert.match(JSON.parse(f.requests[0].options.body).cookie, /csrf=fixture-secret-csrf/);
  assert.equal(JSON.stringify(f.posts).includes('fixture-secret-'), false);
});

test('helper reads Amazon first-party partitioned cookies without expanding permissions or bootstrapping a ready session', async () => {
  const f = fixture(['session-id', 'session-token'].map(cookie), { partitionedCookies: [cookie('csrf')] });
  await f.start();
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 1);
  assert.equal(f.workerRequests.length, 0);
  const partitions = f.cookieQueries.filter((query) => query.partitionKey).map((query) => query.partitionKey);
  assert.ok(partitions.length > 0);
  for (const key of partitions) {
    assert.equal(key.topLevelSite, 'https://amazon.com');
    assert.equal(key.hasCrossSiteAncestor, false);
  }
});

test('bootstrap is bounded to fixed Amazon read endpoints and does not invent a missing CSRF cookie', async () => {
  const f = fixture(['session-id', 'session-token'].map(cookie));
  await f.start();
  await new Promise(setImmediate);
  assert.equal(f.workerRequests.length, 6);
  for (const request of f.workerRequests) {
    const url = new URL(request.url);
    assert.ok(['pitangui.amazon.com', 'alexa.amazon.com'].includes(url.hostname));
    assert.ok(['/api/language', '/api/devices-v2/device', '/api/strings'].includes(url.pathname));
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.body, undefined);
  }
  await [...f.intervals.values()][0]();
  assert.equal(f.workerRequests.length, 6, 'Do not repeat a bootstrap pass for unchanged credentials');
  assert.equal(f.requests.length, 0, 'Do not return a session without an actual CSRF cookie');
  assert.equal(JSON.stringify(f.posts).includes('fixture-secret-'), false);
});

test('closing capture aborts a pending bootstrap and concurrent polls do not duplicate requests', async () => {
  let finish;
  const f = fixture(['session-id', 'session-token'].map(cookie), {
    bootstrapFetch: () => new Promise((resolve) => { finish = resolve; })
  });
  await f.start();
  await new Promise(setImmediate);
  assert.equal(f.workerRequests.length, 1);
  await [...f.intervals.values()][0]();
  assert.equal(f.workerRequests.length, 1);
  const reads = f.cookieReads();
  const signal = f.workerRequests[0].options.signal;
  f.close();
  assert.equal(signal.aborted, true);
  finish({ body: { cancel: async () => {} } });
  await new Promise(setImmediate);
  assert.equal(f.cookieReads(), reads);
  assert.equal(f.requests.length, 0);
  assert.equal(f.intervals.size, 0);
});

test('a stalled bootstrap request times out, and the helper retains the CSRF requirement after bounded retries', async () => {
  const f = fixture(['session-id', 'session-token'].map(cookie), {
    bootstrapFetch: (_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });
  await f.start();
  await new Promise(setImmediate);
  for (let index = 0; index < 6; index += 1) {
    assert.equal(f.workerRequests.length, index + 1);
    assert.equal(f.timeouts.size, 1);
    const timeout = [...f.timeouts.values()][0];
    assert.equal(timeout.ms, 8000);
    timeout.callback();
    await new Promise(setImmediate);
  }
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.workerRequests.every((r) => r.options.signal.aborted), true);
});

test('a session that becomes ready after capture expiry is not returned to HomeBrain', async () => {
  let finish;
  const f = fixture(['session-id', 'session-token'].map(cookie), {
    bootstrapFetch: () => new Promise((resolve) => { finish = resolve; })
  });
  await f.start();
  await new Promise(setImmediate);
  f.advance(10 * 60 * 1000);
  f.setCookies(['session-id', 'session-token', 'csrf'].map(cookie));
  finish({ body: { cancel: async () => {} } });
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timeouts.size, 0);
});

test('helper rejects a different receiver, nonce, sender, frame or non-Amazon login before reading cookies', async () => {
  const cases = [
    [{ receiverUrl: 'https://other.example.com/complete' }],
    [{ token: 'different-token' }],
    [{ loginUrl: 'https://other.example.com/' }],
    [{}, { id: 'other-extension', frameId: 0, tab: { id: 99 } }],
    [{}, { id: 'reviewed-helper', frameId: 1, tab: { id: 99 } }]
  ];
  for (const [payload, sender] of cases) {
    const f = fixture(['session-id', 'session-token', 'csrf'].map(cookie));
    assert.equal((await f.start(payload, sender || f.sender)).success, false);
    assert.equal(f.cookieReads(), 0);
    assert.equal(f.windows.length, 0);
  }
});

test('helper rejects a different HomeBrain host even when its receiver and nonce match that page', async () => {
  const f = fixture(['session-id', 'session-token', 'csrf'].map(cookie));
  const url = `https://other.example.com/alexa-session-capture.html?captureId=${f.payload.captureId}&token=${f.payload.token}`;
  const result = await f.start({ receiverUrl: `https://other.example.com/api/alexa/session-capture/${f.payload.captureId}/complete` }, { ...f.sender, url, tab: { id: 99, url } });
  assert.equal(result.success, false);
  assert.equal(f.cookieReads(), 0);
});

test('closing the capture tab stops cookie collection', async () => {
  const f = fixture([]);
  await f.start();
  await new Promise(setImmediate);
  assert.equal(f.intervals.size, 1);
  f.close(100);
  assert.equal(f.intervals.size, 1);
  f.close();
  assert.equal(f.intervals.size, 0);
});

test('content script refuses a cross-origin or mismatched-nonce return', () => {
  const f = fixture([]);
  for (const message of [
    { receiverUrl: 'https://other.example.com/complete', payload: { token: f.payload.token } },
    { receiverUrl: f.payload.receiverUrl, payload: { token: 'different-token' } }
  ]) {
    let response;
    const asynchronous = f.contentMessage({ type: 'COMPLETE_ALEXA_SESSION_CAPTURE', captureId: f.payload.captureId, ...message }, { id: f.sender.id }, (r) => { response = r; });
    assert.equal(asynchronous, false);
    assert.equal(response.success, false);
  }
  assert.equal(f.requests.length, 0);
});

test('downloaded helper is bound to its HomeBrain host without additional localhost recipients', () => {
  const { buildHelperManifest } = require('../routes/alexaRoutes');
  const manifest = JSON.parse(buildHelperManifest({ protocol: 'https', headers: { host: 'homebrain.example.com' } }));
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://homebrain.example.com/*']);
  assert.equal(manifest.host_permissions.some((entry) => /localhost|127\.0\.0\.1/.test(entry)), false);
  assert.equal(manifest.host_permissions.includes('https://homebrain.example.com/*'), true);
  assert.throws(() => buildHelperManifest({ protocol: 'http', headers: { host: 'homebrain.example.com' } }), /secure HomeBrain origin/);
  const local = JSON.parse(buildHelperManifest({ protocol: 'http', headers: { host: 'localhost:3000' } }));
  assert.deepEqual(local.content_scripts[0].matches, ['http://localhost/*']);
});
