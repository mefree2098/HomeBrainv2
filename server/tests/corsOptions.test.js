const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');

const {
  buildAllowedOrigins,
  buildCorsOptions,
  getRequestOrigin
} = require('../config/corsOptions');

function createRequest({ protocol = 'http', host = '192.168.1.41:3000' } = {}) {
  return {
    protocol,
    get(header) {
      return header.toLowerCase() === 'host' ? host : undefined;
    }
  };
}

function checkOrigin(options, origin) {
  return new Promise((resolve) => {
    options.origin(origin, (error, allowed) => resolve({ error, allowed }));
  });
}

test('Express serves a browser module request from the app same origin', async (t) => {
  const app = express();
  app.use(cors((req, callback) => {
    callback(null, buildCorsOptions(req, { NODE_ENV: 'production' }));
  }));
  app.get('/assets/app.js', (_req, res) => {
    res.type('text/javascript').send('export const ready = true;');
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/assets/app.js`, {
    headers: { Origin: origin }
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(await response.text(), 'export const ready = true;');
});

test('production CORS allows the request same origin on a LAN address', async () => {
  const req = createRequest();
  const options = buildCorsOptions(req, { NODE_ENV: 'production' });
  const result = await checkOrigin(options, 'http://192.168.1.41:3000');

  assert.equal(getRequestOrigin(req), 'http://192.168.1.41:3000');
  assert.equal(result.error, null);
  assert.equal(result.allowed, true);
});

test('production CORS allows the same HTTPS origin behind the trusted proxy', async () => {
  const req = createRequest({ protocol: 'https', host: 'homebrain.example.com' });
  const options = buildCorsOptions(req, { NODE_ENV: 'production' });
  const result = await checkOrigin(options, 'https://homebrain.example.com');

  assert.equal(result.error, null);
  assert.equal(result.allowed, true);
});

test('production CORS still rejects an unconfigured cross origin', async () => {
  const options = buildCorsOptions(createRequest(), { NODE_ENV: 'production' });
  const result = await checkOrigin(options, 'https://untrusted.example');

  assert.equal(result.allowed, undefined);
  assert.equal(result.error?.status, 403);
  assert.equal(result.error?.message, 'CORS origin not allowed');
});

test('production CORS retains configured cross-origin clients', async () => {
  const env = {
    NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://admin.example.com, https://mobile.example.com/'
  };
  const options = buildCorsOptions(createRequest(), env);
  const result = await checkOrigin(options, 'https://mobile.example.com');

  assert.deepEqual(buildAllowedOrigins(env), [
    'https://admin.example.com',
    'https://mobile.example.com'
  ]);
  assert.equal(result.error, null);
  assert.equal(result.allowed, true);
});

test('CORS allows requests without an Origin header', async () => {
  const options = buildCorsOptions(createRequest(), { NODE_ENV: 'production' });
  const result = await checkOrigin(options, undefined);

  assert.equal(result.error, null);
  assert.equal(result.allowed, true);
});
