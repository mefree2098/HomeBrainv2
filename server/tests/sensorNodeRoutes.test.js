'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const users = require('../services/userService');
const oidc = require('../services/oidcService');
const { createSensorNodeRouter } = require('../routes/sensorNodeRoutes');

test('Sensor Fleet HTTP boundaries separate administrators from device credentials', async (t) => {
  const oldGet = users.get, oldOidc = oidc.verifyIssuedAccessToken, oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const id = '507f1f77bcf86cd799439011';
  const user = { _id: id, role: 'admin', isActive: true, isReadOnly: false,
    isReviewSandbox: false, platforms: { homebrain: true } };
  users.get = async () => user;
  oidc.verifyIssuedAccessToken = async () => { throw Object.assign(new Error('Invalid token'), { status: 401 }); };
  const calls = [];
  let failure;
  const record = (operation, ...args) => {
    calls.push({ operation, args });
    if (failure) throw failure;
    return {};
  };
  const checkDevice = (token) => {
    if (token !== 'test-device-token') throw Object.assign(new Error('Invalid sensor device token.'), { status: 401 });
  };
  const service = {
    listNodes: async () => { record('list'); return []; },
    registerNode: async (...args) => record('register', ...args),
    onboardNode: async (...args) => record('onboard', ...args),
    rotateSetupCode: async (...args) => record('rotate', ...args),
    deleteNode: async (...args) => record('delete', ...args),
    activateNode: async (nodeId, setupCode) => {
      if (setupCode !== 'test-setup-code') throw Object.assign(new Error('Invalid sensor setup code.'), { status: 401 });
      return record('activate', nodeId);
    },
    getRuntimeConfig: async (nodeId, token) => { checkDevice(token); return record('config', nodeId); },
    ingestReading: async (nodeId, token, payload) => { checkDevice(token); return record('readings', nodeId, payload); }
  };
  const app = express();
  app.use(express.json());
  app.use('/api/sensor-nodes', createSensorNodeRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    users.get = oldGet; oidc.verifyIssuedAccessToken = oldOidc;
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  });
  const base = `http://127.0.0.1:${server.address().port}/api/sensor-nodes`;
  const bearer = jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const send = (path, method = 'GET', headers = {}, body) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body && method !== 'GET' && method !== 'HEAD' ? { body: JSON.stringify(body) } : {})
  });
  const adminHeaders = { Authorization: `Bearer ${bearer}` };
  await t.test('anonymous users and sensor credentials cannot administer the fleet', async () => {
    for (const [path, method] of [['', 'GET'], ['', 'POST'], ['/onboard', 'POST'], [`/${id}`, 'DELETE'], [`/${id}/setup-code/rotate`, 'POST']]) {
      const response = await send(path, method, { Authorization: 'Sensor test-device-token' }, {});
      assert.equal(response.status, 401);
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    assert.equal(calls.length, 0);
  });
  await t.test('account and sandbox restrictions apply before fleet access', async () => {
    user.role = 'user'; assert.equal((await send('', 'GET', adminHeaders)).status, 403); user.role = 'admin';
    user.isActive = false; assert.equal((await send('', 'GET', adminHeaders)).status, 403); user.isActive = true;
    user.platforms.homebrain = false; assert.equal((await send('', 'GET', adminHeaders)).status, 403); user.platforms.homebrain = true;
    user.isReviewSandbox = true; assert.equal((await send('', 'GET', adminHeaders)).status, 403); user.isReviewSandbox = false;
    user.isReadOnly = true; assert.equal((await send('', 'POST', adminHeaders, {})).status, 403); user.isReadOnly = false;
    assert.equal(calls.length, 0);
    assert.equal((await send('', 'GET', adminHeaders)).status, 200);
  });
  await t.test('devices require a setup code or device token on the appropriate endpoint', async () => {
    assert.equal((await send(`/${id}/activate`, 'POST', {}, {})).status, 401);
    assert.equal((await send(`/${id}/activate`, 'POST', { 'X-HomeBrain-Sensor-Setup': 'test-setup-code' }, {})).status, 200);
    assert.equal((await send(`/${id}/config`, 'GET', adminHeaders)).status, 401);
    assert.equal((await send(`/${id}/config?token=test-device-token`)).status, 401);
    assert.equal((await send(`/${id}/config`, 'GET', { Authorization: 'Sensor test-device-token' })).status, 200);
    assert.equal((await send(`/${id}/readings`, 'POST', {}, { readings: { temperature_c: 20 } })).status, 401);
    assert.equal((await send(`/${id}/readings`, 'POST', { Authorization: 'Sensor test-device-token' }, { readings: { temperature_c: 20 } })).status, 202);
  });
  await t.test('Bluetooth registration requires an administrator and is never cacheable', async () => {
    user.role = 'user';
    assert.equal((await send('/onboard', 'POST', adminHeaders, {})).status, 403);
    user.role = 'admin';
    const payload = { hardwareId: 'XIAO-C6-001122AABBCC', profile: 'presence' };
    const response = await send('/onboard', 'POST', adminHeaders, payload);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(calls.at(-1).args[0], payload);
    assert.equal(calls.at(-1).operation, 'onboard');
  });
  await t.test('invalid IDs and internal failures cannot disclose private storage details', async () => {
    assert.equal((await send('/invalid/config')).status, 400);
    failure = new Error('private database path and token hash');
    const response = await send('', 'GET', adminHeaders);
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes('private database'), false);
  });
});
