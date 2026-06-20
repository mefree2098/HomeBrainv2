const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('POST /service/start passes device and compute preferences to Whisper service', async (t) => {
  const authPath = require.resolve('../routes/middlewares/auth');
  const servicePath = require.resolve('../services/whisperService');
  const routePath = require.resolve('../routes/whisperRoutes');
  const originalAuth = require.cache[authPath];
  const originalService = require.cache[servicePath];
  const originalRoute = require.cache[routePath];
  const calls = [];

  t.after(() => {
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
    if (originalService) require.cache[servicePath] = originalService;
    else delete require.cache[servicePath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
  });

  delete require.cache[authPath];
  delete require.cache[servicePath];
  delete require.cache[routePath];
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      requireAdmin: () => (_req, _res, next) => next()
    }
  };
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
      startService: async (model, options) => {
        calls.push({ model, options });
        return { success: true, device: options.devicePreference, computeType: options.computePreference };
      }
    }
  };

  const app = express();
  app.use(express.json());
  app.use('/api/whisper', require('../routes/whisperRoutes'));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/whisper/service/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'small',
      devicePreference: ' cpu ',
      computePreference: ' float32 '
    })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, device: 'cpu', computeType: 'float32' });
  assert.deepEqual(calls, [
    {
      model: 'small',
      options: {
        devicePreference: 'cpu',
        computePreference: 'float32'
      }
    }
  ]);

  const rejected = await fetch(`http://127.0.0.1:${port}/api/whisper/service/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'small',
      devicePreference: 'cuda;rm -rf /'
    })
  });

  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: 'devicePreference is not supported' });
  assert.equal(calls.length, 1);
});
