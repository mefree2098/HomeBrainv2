const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const VoiceDevice = require('../models/VoiceDevice');
const router = require('../routes/reachyMiniRoutes');
const packageService = require('../services/reachyMiniPackageService');
const reachyMiniService = require('../services/reachyMiniService');
const reachySnapshotService = require('../services/reachySnapshotService');
const { hashDeviceToken } = require('../services/voiceDeviceLifecycleService');
const {
  buildOnboardingDelivery,
  createReachyPackage,
  getOnboardingHeaderCredentials
} = router;

const DEVICE_ID = '507f1f77bcf86cd799439011';

function jpeg(width = 32, height = 16) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    0x12, 0x34,
    0xff, 0xd9
  ]);
}

function fakeRequest(headers = {}, query = {}) {
  return {
    protocol: 'https',
    headers: { host: 'homebrain.test' },
    params: { deviceId: DEVICE_ID },
    query,
    body: {},
    get(name) {
      if (name.toLowerCase() === 'host') return 'homebrain.test';
      return headers[name.toLowerCase()];
    }
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    contentType: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function routeHandler(routePath, method = 'get') {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods?.[method]
  ));
  assert.ok(layer, `route ${method.toUpperCase()} ${routePath} exists`);
  return layer.route.stack.at(-1).handle;
}

function invokeRateLimiter(limiter, ip) {
  return new Promise((resolve, reject) => {
    const req = {
      ip,
      headers: {},
      socket: { remoteAddress: ip },
      app: { get: () => false }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      send(body) { resolve({ limited: true, statusCode: this.statusCode, body }); },
      json(body) { resolve({ limited: true, statusCode: this.statusCode, body }); }
    };
    try {
      Promise.resolve(limiter(req, res, () => resolve({ limited: false, statusCode: res.statusCode })))
        .catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

test('onboarding delivery never embeds a claim token in URL, script, or command', () => {
  const delivery = buildOnboardingDelivery(fakeRequest(), { _id: DEVICE_ID });
  const serialized = JSON.stringify(delivery);
  assert.equal(serialized.includes('super-secret-claim'), false);
  assert.equal(delivery.bootstrapUrl.includes('?'), false);
  assert.equal(delivery.packageUrl.includes('?'), false);
  assert.match(delivery.installCommand, /read -rsp/);
  assert.match(delivery.installCommand, /X-HomeBrain-Claim-Token/);
  assert.match(delivery.installCommand, /-o "\$HB_BOOTSTRAP"/);
  assert.doesNotMatch(delivery.installCommand, /\|\s*bash/);
});

test('onboarding package credentials are header-only and ignore query secrets', () => {
  const credentials = getOnboardingHeaderCredentials(fakeRequest(
    { 'x-homebrain-claim-token': 'header-secret' },
    { claim: 'query-secret', claimToken: 'query-secret-2' }
  ));
  assert.deepEqual(credentials, {
    registrationCode: '',
    claimToken: 'header-secret',
    deviceToken: ''
  });
  assert.deepEqual(getOnboardingHeaderCredentials(fakeRequest({}, { claim: 'query-only' })), {
    registrationCode: '',
    claimToken: '',
    deviceToken: ''
  });
});

test('bootstrap route authorizes header claim and generated script retains no secret', async (t) => {
  const originalFindById = VoiceDevice.findById;
  t.after(() => { VoiceDevice.findById = originalFindById; });
  VoiceDevice.findById = async () => ({
    _id: DEVICE_ID,
    deviceType: 'robot',
    settings: {
      registered: false,
      claimToken: 'header-secret',
      claimTokenExpires: new Date(Date.now() + 60_000)
    }
  });
  const handler = routeHandler('/:deviceId/bootstrap.sh');
  const allowed = fakeResponse();
  await handler(fakeRequest({ 'x-homebrain-claim-token': 'header-secret' }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.match(allowed.body, /HOMEBRAIN_CLAIM_TOKEN:\?Set HOMEBRAIN_CLAIM_TOKEN/);
  assert.match(allowed.body, /X-HomeBrain-Claim-Token: \$\{HOMEBRAIN_CLAIM_TOKEN\}/);
  assert.equal(allowed.body.includes('header-secret'), false);
  assert.doesNotMatch(allowed.body, /\?claim=/);

  const rejected = fakeResponse();
  await handler(fakeRequest({}, { claim: 'header-secret' }), rejected);
  assert.equal(rejected.statusCode, 403);
});

test('delivered install command never runs bash when bootstrap download fails', async (t) => {
  const temporary = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'reachy-install-command-test-'));
  t.after(() => fsPromises.rm(temporary, { recursive: true, force: true }));
  const bashLog = path.join(temporary, 'bash-called');
  const curlStub = path.join(temporary, 'curl');
  const bashStub = path.join(temporary, 'bash');
  await fsPromises.writeFile(curlStub, '#!/bin/sh\nexit 22\n', { mode: 0o700 });
  await fsPromises.writeFile(bashStub, `#!/bin/sh\necho called > '${bashLog}'\n`, { mode: 0o700 });
  const delivery = buildOnboardingDelivery(fakeRequest(), { _id: DEVICE_ID });
  const result = spawnSync('/bin/bash', ['-c', delivery.installCommand], {
    input: 'entered-secret\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` }
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(bashLog), false);
});

test('bootstrap archive is built only from the verified package manifest', async (t) => {
  const generated = await createReachyPackage();
  t.after(() => fsPromises.rm(generated.temporaryRoot, { recursive: true, force: true }));
  const manifest = await packageService.buildManifest();
  const archived = execFileSync('tar', ['-tzf', generated.archivePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean);
  const archivedFiles = archived.filter((entry) => !manifest.files.some((file) => file.path.startsWith(`${entry}/`)));
  for (const file of manifest.files) assert.equal(archived.includes(file.path), true, file.path);
  assert.equal(archived.some((entry) => /(?:\.ruff_cache|\.pytest_cache|__pycache__|tests|\.coverage|dist|build)/.test(entry)), false);
  assert.equal(archivedFiles.every((entry) => manifest.files.some((file) => file.path === entry)), true);
});

test('static companion fleet route is declared before dynamic device routes', () => {
  const fleetIndex = router.stack.findIndex((layer) => layer.route?.path === '/companion/status');
  const dynamicIndex = router.stack.findIndex((layer) => (
    Array.isArray(layer.route?.path) && layer.route.path.includes('/:deviceId')
  ));
  assert.ok(fleetIndex >= 0);
  assert.ok(dynamicIndex >= 0);
  assert.ok(fleetIndex < dynamicIndex);
});

test('emergency stop retains an independent budget after ordinary command quota exhaustion', async (t) => {
  const ip = '203.0.113.42';
  t.after(() => {
    router.commandRateLimit.resetKey(ip);
    router.stopRateLimit.resetKey(ip);
  });
  router.commandRateLimit.resetKey(ip);
  router.stopRateLimit.resetKey(ip);

  let ordinary;
  for (let index = 0; index <= 120; index += 1) {
    ordinary = await invokeRateLimiter(router.commandRateLimit, ip);
  }
  assert.equal(ordinary.limited, true);
  assert.equal(ordinary.statusCode, 429);

  const emergencyStop = await invokeRateLimiter(router.stopRateLimit, ip);
  assert.equal(emergencyStop.limited, false);
  assert.equal(emergencyStop.statusCode, 200);
});

test('snapshot upload rejects privacy disable between permission read admission and store reservation', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const originalGetCommandStatus = reachyMiniService.getCommandStatus;
  t.after(async () => {
    VoiceDevice.findById = originalFindById;
    reachyMiniService.getCommandStatus = originalGetCommandStatus;
    await reachySnapshotService.cleanup();
  });
  await reachySnapshotService.cleanup();

  let releaseDeviceRead;
  let deviceReadStartedResolve;
  const deviceReadStarted = new Promise((resolve) => { deviceReadStartedResolve = resolve; });
  const heldDeviceRead = new Promise((resolve) => { releaseDeviceRead = resolve; });
  VoiceDevice.findById = async () => {
    deviceReadStartedResolve();
    await heldDeviceRead;
    return {
      _id: DEVICE_ID,
      deviceType: 'robot',
      settings: {
        registered: true,
        deviceTokenHash: hashDeviceToken('device-secret'),
        reachy: {
          privacyFault: null,
          safeSettings: { cameraEnabled: true, snapshotEnabled: true }
        }
      }
    };
  };
  reachyMiniService.getCommandStatus = () => ({
    commandId: 'snapshot-command',
    command: 'snapshot',
    status: 'started',
    terminal: false
  });

  const buffer = jpeg();
  const snapshotId = crypto.randomUUID();
  const req = fakeRequest({
    'x-homebrain-device-token': 'device-secret',
    'content-type': 'image/jpeg',
    'content-length': String(buffer.length)
  });
  req.params.snapshotId = snapshotId;
  req.body = buffer;
  const res = fakeResponse();
  const uploading = routeHandler('/:deviceId/snapshots/:snapshotId', 'post')(req, res);

  await deviceReadStarted;
  await reachySnapshotService.removeDevice(DEVICE_ID);
  releaseDeviceRead();
  await uploading;

  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /revoked before upload/i);
  assert.equal(reachySnapshotService.snapshots.has(snapshotId), false);
});

test('snapshot routes fail closed on a physical privacy fault and purge stored images', async (t) => {
  const originalGetRobot = reachyMiniService.getRobot;
  const originalTake = reachySnapshotService.take;
  t.after(() => {
    reachyMiniService.getRobot = originalGetRobot;
    reachySnapshotService.take = originalTake;
  });
  reachyMiniService.getRobot = async () => ({
    settings: {
      reachy: {
        privacyFault: 'camera shutdown could not be confirmed',
        safeSettings: { cameraEnabled: true, snapshotEnabled: true }
      }
    }
  });
  let takeCalled = false;
  reachySnapshotService.take = async () => { takeCalled = true; };
  const req = fakeRequest();
  req.params.snapshotId = crypto.randomUUID();
  const res = fakeResponse();

  await routeHandler('/:deviceId/snapshots/:snapshotId')(req, res);

  assert.equal(res.statusCode, 503);
  assert.match(res.body.message, /privacy state cannot be confirmed/i);
  assert.equal(takeCalled, false);
});

test('snapshot upload accepts only an active nonterminal snapshot command', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const originalGetCommandStatus = reachyMiniService.getCommandStatus;
  t.after(() => {
    VoiceDevice.findById = originalFindById;
    reachyMiniService.getCommandStatus = originalGetCommandStatus;
  });
  VoiceDevice.findById = async () => ({
    _id: DEVICE_ID,
    deviceType: 'robot',
    settings: {
      registered: true,
      deviceTokenHash: hashDeviceToken('device-secret'),
      reachy: {
        privacyFault: null,
        safeSettings: { cameraEnabled: true, snapshotEnabled: true }
      }
    }
  });
  reachyMiniService.getCommandStatus = () => ({
    command: 'snapshot',
    status: 'completed',
    terminal: true
  });
  const buffer = jpeg();
  const req = fakeRequest({
    'x-homebrain-device-token': 'device-secret',
    'content-type': 'image/jpeg',
    'content-length': String(buffer.length)
  });
  req.params.snapshotId = crypto.randomUUID();
  req.body = buffer;
  const res = fakeResponse();

  await routeHandler('/:deviceId/snapshots/:snapshotId', 'post')(req, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /active successful snapshot command/i);
});

test('snapshot retrieval rechecks current privacy permission and purges revoked images', async (t) => {
  const originalGetRobot = reachyMiniService.getRobot;
  const originalTake = reachySnapshotService.take;
  const originalRemoveDevice = reachySnapshotService.removeDevice;
  t.after(() => {
    reachyMiniService.getRobot = originalGetRobot;
    reachySnapshotService.take = originalTake;
    reachySnapshotService.removeDevice = originalRemoveDevice;
  });
  let takeCalled = false;
  let purgedDevice = null;
  reachyMiniService.getRobot = async () => ({
    settings: { reachy: { safeSettings: { cameraEnabled: false, snapshotEnabled: false } } }
  });
  reachySnapshotService.take = async () => { takeCalled = true; };
  reachySnapshotService.removeDevice = async (deviceId) => { purgedDevice = deviceId; };

  const request = fakeRequest();
  request.params.snapshotId = 'snapshot-id';
  const response = fakeResponse();
  await routeHandler('/:deviceId/snapshots/:snapshotId')(request, response);

  assert.equal(response.statusCode, 403);
  assert.equal(takeCalled, false);
  assert.equal(purgedDevice, DEVICE_ID);
});
