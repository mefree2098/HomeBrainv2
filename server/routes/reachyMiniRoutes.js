const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const reachyMiniService = require('../services/reachyMiniService');
const reachyMiniPackageService = require('../services/reachyMiniPackageService');
const reachySnapshotService = require('../services/reachySnapshotService');
const { requireUser, requireAdmin } = require('./middlewares/auth');
const { validateDeviceAccess } = require('../services/voiceDeviceLifecycleService');
const { getRequestOrigin, toWebSocketOrigin } = require('../utils/publicOrigin');

const router = express.Router();
const execFileAsync = promisify(execFile);
const user = requireUser();
const admin = requireAdmin();

const onboardingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many Reachy onboarding requests. Please retry later.' }
});
const commandRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Reachy command rate limit exceeded. Please retry shortly.' }
});
// Emergency stop has an independent, high-ceiling budget so ordinary motion,
// speech, or UI traffic can never consume the ability to preempt hardware.
const stopRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Reachy emergency-stop rate limit exceeded.' }
});
const snapshotUploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Reachy snapshot upload rate limit exceeded.' }
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function getOnboardingHeaderCredentials(req) {
  return {
    registrationCode: trimString(req.get('X-HomeBrain-Registration-Code')),
    claimToken: trimString(req.get('X-HomeBrain-Claim-Token')),
    deviceToken: trimString(req.get('X-HomeBrain-Device-Token'))
  };
}

async function authorizeSteadyReachyDevice(req, res) {
  const access = await validateDeviceAccess(req.params.deviceId, {
    deviceToken: trimString(req.get('X-HomeBrain-Device-Token'))
  }, {
    allowRegistrationCode: false,
    allowClaimToken: false,
    allowDeviceToken: true
  });
  if (!access.authorized || access.device?.deviceType !== 'robot') {
    res.status(403).json({ success: false, message: 'Invalid Reachy device token' });
    return null;
  }
  return access.device;
}

function responseStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function sendError(res, error, fallback) {
  const status = responseStatus(error);
  if (status >= 500) {
    console.error(`ReachyMiniRoutes: ${fallback}:`, error.message);
  }
  return res.status(status).json({
    success: false,
    message: error.message || fallback,
    ...(error.code ? { code: error.code } : {})
  });
}

function buildOnboardingDelivery(req, device) {
  const origin = getRequestOrigin(req);
  const deviceId = device._id.toString();
  const bootstrapUrl = `${origin}/api/reachy-mini/${deviceId}/bootstrap.sh`;
  return {
    bootstrapUrl,
    packageUrl: `${origin}/api/reachy-mini/${deviceId}/package`,
    installCommand: `(set -eu; umask 077; IFS= read -rsp 'Reachy claim token: ' HOMEBRAIN_CLAIM_TOKEN; echo; export HOMEBRAIN_CLAIM_TOKEN; HB_BOOTSTRAP="$(mktemp)"; trap 'rm -f "$HB_BOOTSTRAP"; unset HOMEBRAIN_CLAIM_TOKEN' EXIT; curl --fail --silent --show-error -H "X-HomeBrain-Claim-Token: \${HOMEBRAIN_CLAIM_TOKEN}" -o "$HB_BOOTSTRAP" ${shellQuote(bootstrapUrl)}; bash "$HB_BOOTSTRAP")`
  };
}

async function createReachyPackage() {
  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'homebrain-reachy-package-'));
  const packageRoot = path.join(temporaryRoot, 'payload');
  const archivePath = path.join(temporaryRoot, 'homebrain-reachy-mini-app.tar.gz');
  try {
    await fsPromises.mkdir(packageRoot, { mode: 0o700 });
    const manifest = await reachyMiniPackageService.buildManifest({ force: true });
    for (const entry of manifest.files) {
      const file = await reachyMiniPackageService.resolveFile(entry.path);
      const target = path.join(packageRoot, ...entry.path.split('/'));
      await fsPromises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsPromises.writeFile(target, file.buffer, { flag: 'wx', mode: 0o600 });
    }
    await execFileAsync('tar', [
      '-czf',
      archivePath,
      '-C',
      packageRoot,
      '.'
    ]);
    return { temporaryRoot, archivePath };
  } catch (error) {
    await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

router.get(['/status', '/status/'], user, async (_req, res) => {
  try {
    const robots = await reachyMiniService.getRobots();
    return res.status(200).json({
      success: true,
      configured: robots.length > 0,
      connected: robots.some((robot) => robot.online),
      count: robots.length,
      onlineCount: robots.filter((robot) => robot.online).length,
      robots
    });
  } catch (error) {
    return sendError(res, error, 'Failed to load Reachy Mini status');
  }
});

async function listRobots(_req, res) {
  try {
    const robots = await reachyMiniService.getRobots();
    return res.status(200).json({ success: true, robots, devices: robots, count: robots.length });
  } catch (error) {
    return sendError(res, error, 'Failed to list Reachy Mini devices');
  }
}
router.get(['/', '/devices', '/devices/'], user, listRobots);

router.post(['/register', '/devices'], onboardingRateLimit, admin, async (req, res) => {
  try {
    const result = await reachyMiniService.registerRobot(req.body || {});
    const robot = reachyMiniService.sanitizeRobot(result.device);
    const delivery = buildOnboardingDelivery(req, result.device);
    return res.status(201).json({
      success: true,
      robot,
      device: robot,
      registrationCode: result.onboarding.registrationCode,
      registrationExpires: result.onboarding.registrationExpires,
      claimToken: result.onboarding.claimToken,
      claimTokenExpires: result.onboarding.claimTokenExpires,
      ...delivery
    });
  } catch (error) {
    return sendError(res, error, 'Failed to register Reachy Mini');
  }
});

router.post('/activate', onboardingRateLimit, async (req, res) => {
  try {
    const result = await reachyMiniService.activateRobot(req.body || {});
    const device = reachyMiniService.sanitizeRobot(result.device);
    const origin = getRequestOrigin(req);
    return res.status(200).json({
      success: true,
      robot: device,
      device,
      deviceToken: result.deviceToken,
      hubUrl: `${toWebSocketOrigin(origin)}/ws/voice-device?deviceId=${device.id}`,
      ttsBaseUrl: `${origin}/api/remote-devices/${device.id}/tts`,
      message: 'Reachy Mini activated successfully'
    });
  } catch (error) {
    return sendError(res, error, 'Failed to activate Reachy Mini');
  }
});

// Fleet routes must remain above every dynamic /:deviceId route. Besides
// making routing intent explicit, this prevents future wildcard aliases from
// treating the literal "companion" segment as a device ID.
router.get('/companion/status', admin, async (_req, res) => {
  try {
    const fleet = await reachyMiniService.getCompanionFleetStatus();
    return res.status(200).json({ success: true, ...fleet });
  } catch (error) {
    return sendError(res, error, 'Failed to load Reachy companion fleet status');
  }
});

router.post('/companion/check', onboardingRateLimit, admin, async (req, res) => {
  if (trimString(req.body?.deviceId)) {
    req.params.deviceId = trimString(req.body.deviceId);
    return checkCompanion(req, res);
  }
  try {
    const fleet = await reachyMiniService.getCompanionFleetStatus({ force: true });
    for (const device of fleet.devices) {
      if (device.deviceId) await reachyMiniService.checkCompanionUpdate(device.deviceId, { force: true });
    }
    return res.status(200).json({ success: true, ...(await reachyMiniService.getCompanionFleetStatus()) });
  } catch (error) {
    return sendError(res, error, 'Failed to check Reachy companion fleet updates');
  }
});

router.post('/companion/update', onboardingRateLimit, admin, async (req, res) => {
  if (trimString(req.body?.deviceId)) {
    req.params.deviceId = trimString(req.body.deviceId);
    return updateCompanion(req, res);
  }
  try {
    const fleet = await reachyMiniService.getCompanionFleetStatus({ force: true });
    const updates = [];
    for (const device of fleet.devices) {
      if (!device.deviceId || (!device.updateAvailable && req.body?.force !== true)) continue;
      updates.push(await reachyMiniService.requestCompanionUpdate(device.deviceId, {
        force: req.body?.force === true,
        actorUserId: req.user?._id,
        manifestUrl: `/api/reachy-mini/${device.deviceId}/companion/manifest`
      }));
    }
    if (updates.length === 0) {
      return res.status(200).json({ success: true, accepted: false, reason: 'no_eligible_updates', updates: [] });
    }
    return res.status(202).json({ success: true, accepted: true, updates });
  } catch (error) {
    return sendError(res, error, 'Failed to update Reachy companion fleet');
  }
});

router.get('/:deviceId/package', onboardingRateLimit, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const access = await validateDeviceAccess(deviceId, getOnboardingHeaderCredentials(req));
    if (!access.authorized || access.device?.deviceType !== 'robot') {
      return res.status(403).json({ success: false, message: 'Invalid Reachy device credentials' });
    }
    const generated = await createReachyPackage();
    const cleanup = () => {
      fsPromises.rm(generated.temporaryRoot, { recursive: true, force: true }).catch(() => {});
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="homebrain-reachy-mini-app.tar.gz"');
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(generated.archivePath);
    stream.on('error', (error) => {
      cleanup();
      if (!res.headersSent) sendError(res, error, 'Failed to stream Reachy app package');
      else res.end();
    });
    return stream.pipe(res);
  } catch (error) {
    return sendError(res, error, 'Failed to build Reachy app package');
  }
});

router.get('/:deviceId/bootstrap.sh', onboardingRateLimit, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const credentials = getOnboardingHeaderCredentials(req);
    const access = await validateDeviceAccess(deviceId, credentials, { allowDeviceToken: false });
    if (!access.authorized || access.device?.deviceType !== 'robot') {
      return res.status(403).type('text/plain').send('Invalid or expired Reachy onboarding credentials');
    }
    const origin = getRequestOrigin(req);
    const packageUrl = `${origin}/api/reachy-mini/${deviceId}/package`;
    const allowInsecure = origin.startsWith('http://') ? 'true' : 'false';
    const insecureArgument = allowInsecure === 'true' ? ' --allow-insecure-http' : '';
    const script = `#!/usr/bin/env bash
set -euo pipefail
umask 077

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${'$'}TMP_DIR"' EXIT

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
: "\${HOMEBRAIN_CLAIM_TOKEN:?Set HOMEBRAIN_CLAIM_TOKEN before running this bootstrap}"

curl --fail --silent --show-error -H "X-HomeBrain-Claim-Token: \${HOMEBRAIN_CLAIM_TOKEN}" ${shellQuote(packageUrl)} -o "\${TMP_DIR}/app.tar.gz"
mkdir -p "\${TMP_DIR}/app"
tar -xzf "\${TMP_DIR}/app.tar.gz" -C "\${TMP_DIR}/app"
test -f "\${TMP_DIR}/app/install.sh" || { echo "Reachy package is missing install.sh" >&2; exit 1; }

export HOMEBRAIN_HUB_URL=${shellQuote(origin)}
export HOMEBRAIN_DEVICE_ID=${shellQuote(deviceId)}
bash "\${TMP_DIR}/app/install.sh"${insecureArgument}
unset HOMEBRAIN_CLAIM_TOKEN

echo "HomeBrain Reachy app installed successfully."
echo "The app is installed in Reachy's managed /venvs/apps_venv environment."
`;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('text/x-shellscript').send(script);
  } catch (error) {
    console.error('ReachyMiniRoutes: bootstrap generation failed:', error.message);
    return res.status(responseStatus(error)).type('text/plain').send(error.message || 'Failed to build bootstrap script');
  }
});

async function getRobot(req, res) {
  try {
    const device = await reachyMiniService.getRobot(req.params.deviceId);
    const robot = reachyMiniService.sanitizeRobot(device);
    return res.status(200).json({ success: true, robot, device: robot });
  } catch (error) {
    return sendError(res, error, 'Failed to load Reachy Mini');
  }
}
router.get(['/devices/:deviceId', '/:deviceId'], user, getRobot);

async function reissue(req, res) {
  try {
    const result = await reachyMiniService.reissueOnboarding(req.params.deviceId);
    const robot = reachyMiniService.sanitizeRobot(result.device);
    const delivery = buildOnboardingDelivery(req, result.device);
    return res.status(200).json({
      success: true,
      robot,
      device: robot,
      registrationCode: result.onboarding.registrationCode,
      registrationExpires: result.onboarding.registrationExpires,
      claimToken: result.onboarding.claimToken,
      claimTokenExpires: result.onboarding.claimTokenExpires,
      ...delivery
    });
  } catch (error) {
    return sendError(res, error, 'Failed to reissue Reachy onboarding');
  }
}
router.post(['/:deviceId/reissue', '/:deviceId/onboarding/reissue'], onboardingRateLimit, admin, reissue);

router.patch(['/:deviceId/settings', '/devices/:deviceId/settings'], admin, async (req, res) => {
  try {
    const device = await reachyMiniService.updateSettings(req.params.deviceId, req.body || {});
    return res.status(200).json({ success: true, robot: reachyMiniService.sanitizeRobot(device) });
  } catch (error) {
    return sendError(res, error, 'Failed to update Reachy settings');
  }
});

router.post(['/:deviceId/commands', '/:deviceId/command'], commandRateLimit, admin, async (req, res) => {
  try {
    const command = await reachyMiniService.dispatchCommand(
      req.params.deviceId,
      req.body?.command,
      req.body?.parameters || {},
      { source: 'api', actorUserId: req.user?._id }
    );
    return res.status(202).json({ success: true, command });
  } catch (error) {
    return sendError(res, error, 'Failed to send Reachy command');
  }
});

router.get('/:deviceId/commands/:commandId', admin, async (req, res) => {
  try {
    const command = reachyMiniService.getCommandStatus(req.params.deviceId, req.params.commandId);
    return res.status(200).json({ success: true, command });
  } catch (error) {
    return sendError(res, error, 'Failed to load Reachy command status');
  }
});

router.post('/:deviceId/speak', commandRateLimit, admin, async (req, res) => {
  try {
    const result = await reachyMiniService.speak(req.params.deviceId, req.body?.text, {
      voiceId: req.body?.voiceId,
      actorUserId: req.user?._id
    });
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Failed to send Reachy speech');
  }
});

router.post('/:deviceId/stop', stopRateLimit, admin, async (req, res) => {
  try {
    const command = await reachyMiniService.dispatchCommand(req.params.deviceId, 'stop', {}, {
      source: 'api', actorUserId: req.user?._id
    });
    return res.status(202).json({ success: true, command });
  } catch (error) {
    return sendError(res, error, 'Failed to stop Reachy motion');
  }
});

router.post('/:deviceId/release', commandRateLimit, admin, async (req, res) => {
  try {
    const command = await reachyMiniService.dispatchCommand(req.params.deviceId, 'release_app', {}, {
      source: 'api', actorUserId: req.user?._id
    });
    return res.status(202).json({ success: true, command });
  } catch (error) {
    return sendError(res, error, 'Failed to release Reachy app control');
  }
});

router.post(
  '/:deviceId/snapshots/:snapshotId',
  snapshotUploadRateLimit,
  express.raw({ type: 'image/jpeg', limit: 2 * 1024 * 1024 }),
  async (req, res) => {
    // Bind the upload to the privacy generation that existed before the
    // asynchronous credential/permission read. A concurrent disable advances
    // this epoch and makes store() fail closed even if this DB snapshot is old.
    const expectedDeviceEpoch = reachySnapshotService.getDeviceEpoch(req.params.deviceId);
    try {
      const device = await authorizeSteadyReachyDevice(req, res);
      if (!device) return undefined;
      if (String(req.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'image/jpeg') {
        return res.status(415).json({ success: false, message: 'Snapshot Content-Type must be image/jpeg' });
      }
      const declaredLength = Number(req.get('Content-Length'));
      if (!Number.isInteger(declaredLength) || declaredLength < 1 || !Buffer.isBuffer(req.body) || declaredLength !== req.body.length) {
        return res.status(400).json({ success: false, message: 'Snapshot requires an exact Content-Length header' });
      }
      const reachySettings = device.settings?.reachy || {};
      if (trimString(reachySettings.privacyFault)) {
        await reachySnapshotService.removeDevice(req.params.deviceId);
        return res.status(503).json({
          success: false,
          message: 'Snapshots are unavailable while Reachy physical privacy state cannot be confirmed'
        });
      }
      const safeSettings = reachySettings.safeSettings || {};
      if (safeSettings.cameraEnabled !== true || safeSettings.snapshotEnabled !== true) {
        return res.status(403).json({ success: false, message: 'Snapshots are disabled in Reachy privacy settings' });
      }
      const command = reachyMiniService.getCommandStatus(req.params.deviceId, req.params.snapshotId);
      if (
        command.command !== 'snapshot'
        || command.terminal === true
        || !['sent', 'accepted', 'started'].includes(command.status)
      ) {
        return res.status(409).json({ success: false, message: 'Snapshot does not correlate to an active successful snapshot command' });
      }
      const snapshot = await reachySnapshotService.store({
        deviceId: req.params.deviceId,
        snapshotId: req.params.snapshotId,
        buffer: req.body,
        capturedAt: req.get('X-Reachy-Captured-At'),
        expectedDeviceEpoch
      });
      return res.status(201).json({ success: true, snapshot });
    } catch (error) {
      return sendError(res, error, 'Failed to store Reachy snapshot');
    }
  }
);

router.get('/:deviceId/snapshots/:snapshotId', admin, async (req, res) => {
  try {
    const device = await reachyMiniService.getRobot(req.params.deviceId);
    const reachySettings = device.settings?.reachy || {};
    if (trimString(reachySettings.privacyFault)) {
      await reachySnapshotService.removeDevice(req.params.deviceId);
      return res.status(503).json({
        success: false,
        message: 'Snapshots are unavailable while Reachy physical privacy state cannot be confirmed'
      });
    }
    const safeSettings = reachySettings.safeSettings || {};
    if (safeSettings.cameraEnabled !== true || safeSettings.snapshotEnabled !== true) {
      await reachySnapshotService.removeDevice(req.params.deviceId);
      return res.status(403).json({ success: false, message: 'Snapshots are disabled in Reachy privacy settings' });
    }
    const { snapshot, buffer } = await reachySnapshotService.take(req.params.deviceId, req.params.snapshotId);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Reachy-Snapshot-Id', snapshot.id);
    if (snapshot.capturedAt) res.setHeader('X-Reachy-Captured-At', snapshot.capturedAt);
    return res.status(200).send(buffer);
  } catch (error) {
    return sendError(res, error, 'Failed to read Reachy snapshot');
  }
});

router.get('/:deviceId/companion/manifest', async (req, res) => {
  try {
    const device = await authorizeSteadyReachyDevice(req, res);
    if (!device) return undefined;
    const manifest = await reachyMiniPackageService.buildManifest({ runtimeOnly: true });
    const files = manifest.files.map((file) => ({
      ...file,
      downloadUrl: `/api/reachy-mini/${req.params.deviceId}/companion/files?path=${encodeURIComponent(file.path)}`
    }));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      schemaVersion: manifest.schemaVersion,
      artifact: manifest.artifact,
      version: manifest.version,
      aggregateSha256: manifest.aggregateSha256,
      compatibility: manifest.compatibility,
      files
    });
  } catch (error) {
    return sendError(res, error, 'Failed to build Reachy companion manifest');
  }
});

router.get('/:deviceId/companion/files', async (req, res) => {
  try {
    const device = await authorizeSteadyReachyDevice(req, res);
    if (!device) return undefined;
    const file = await reachyMiniPackageService.resolveFile(trimString(req.query?.path), { runtimeOnly: true });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('ETag', `"${file.sha256}"`);
    res.setHeader('X-Content-SHA256', file.sha256);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(file.buffer);
  } catch (error) {
    return sendError(res, error, 'Failed to download Reachy package file');
  }
});

async function companionStatusForDevice(req, res) {
  try {
    const companion = await reachyMiniService.getCompanionStatus(req.params.deviceId);
    return res.status(200).json({ success: true, companion, ...companion });
  } catch (error) {
    return sendError(res, error, 'Failed to load Reachy companion status');
  }
}
router.get('/:deviceId/companion/status', admin, companionStatusForDevice);

async function checkCompanion(req, res) {
  try {
    const companion = await reachyMiniService.checkCompanionUpdate(req.params.deviceId, { force: true });
    return res.status(200).json({ success: true, companion, ...companion });
  } catch (error) {
    return sendError(res, error, 'Failed to check Reachy companion update');
  }
}
router.post('/:deviceId/companion/check', onboardingRateLimit, admin, checkCompanion);

async function updateCompanion(req, res) {
  try {
    const companion = await reachyMiniService.requestCompanionUpdate(req.params.deviceId, {
      force: req.body?.force === true,
      actorUserId: req.user?._id,
      manifestUrl: `/api/reachy-mini/${req.params.deviceId}/companion/manifest`
    });
    return res.status(companion.accepted === false ? 200 : 202).json({ success: true, companion, ...companion });
  } catch (error) {
    return sendError(res, error, 'Failed to update Reachy companion');
  }
}
router.post('/:deviceId/companion/update', onboardingRateLimit, admin, updateCompanion);

router.delete(['/:deviceId', '/devices/:deviceId'], admin, async (req, res) => {
  try {
    const result = await reachyMiniService.deleteRobot(req.params.deviceId, {
      actorUserId: req.user?._id
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Failed to remove Reachy Mini');
  }
});

module.exports = router;
module.exports.createReachyPackage = createReachyPackage;
module.exports.buildOnboardingDelivery = buildOnboardingDelivery;
module.exports.getOnboardingHeaderCredentials = getOnboardingHeaderCredentials;
module.exports.commandRateLimit = commandRateLimit;
module.exports.stopRateLimit = stopRateLimit;
