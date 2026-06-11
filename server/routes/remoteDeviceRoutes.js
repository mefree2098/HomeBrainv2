const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const VoiceDevice = require('../models/VoiceDevice');
const { requireUser, requireAdmin } = require('./middlewares/auth');
const crypto = require('crypto');
const wakeWordAssets = require('../utils/wakeWordAssets');
const WakeWordModel = require('../models/WakeWordModel');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const elevenLabsService = require('../services/elevenLabsService');
const voiceAcknowledgmentService = require('../services/voiceAcknowledgmentService');
const eventStreamService = require('../services/eventStreamService');
const { getRequestOrigin, toWebSocketOrigin } = require('../utils/publicOrigin');
const {
  issueDeviceToken,
  issueDeviceClaimToken,
  buildOnboardingSettings,
  applyDeviceActivation,
  applyOnboardingReissue,
  validateDeviceCredentials,
  validateDeviceAccess: validateVoiceDeviceAccess,
  getAuthorizedDevice
} = require('../services/voiceDeviceLifecycleService');

const execFileAsync = promisify(execFile);
const admin = requireAdmin();
const onboardingMutationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
const REMOTE_SETUP_PACKAGE_NAME = 'homebrain-remote-setup.tar.gz';
const REMOTE_SETUP_PACKAGE_DIR = path.join(__dirname, '..', 'public', 'downloads');
const REMOTE_SETUP_PACKAGE_PATH = path.join(REMOTE_SETUP_PACKAGE_DIR, REMOTE_SETUP_PACKAGE_NAME);
const REMOTE_SETUP_SOURCE_DIR = path.join(__dirname, '..', '..', 'remote-device');
const REMOTE_SETUP_FILES = [
  'index.js',
  'package.json',
  'install.sh',
  'README.md',
  'updater.js',
  'feature_infer.py',
  'test-audio.js',
  'setup-audio.js'
];
const BOOTSTRAP_RATE_LIMIT_WINDOW_MS = Math.max(
  1_000,
  Number(process.env.REMOTE_BOOTSTRAP_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)
);
const BOOTSTRAP_RATE_LIMIT_MAX_PER_IP = Math.max(
  1,
  Number(process.env.REMOTE_BOOTSTRAP_RATE_LIMIT_MAX_PER_IP || 30)
);
const BOOTSTRAP_RATE_LIMIT_MAX_PER_DEVICE = Math.max(
  1,
  Number(process.env.REMOTE_BOOTSTRAP_RATE_LIMIT_MAX_PER_DEVICE || 20)
);
const BOOTSTRAP_INVALID_ATTEMPT_MAX = Math.max(
  1,
  Number(process.env.REMOTE_BOOTSTRAP_INVALID_ATTEMPT_MAX || 8)
);
const bootstrapIpAccessWindow = new Map();
const bootstrapDeviceAccessWindow = new Map();
const bootstrapInvalidAttemptWindow = new Map();

const shellQuote = (value) => `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;

function consumeSlidingWindow(map, key, limit, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const existing = map.get(key) || [];
  const active = existing.filter((timestamp) => timestamp > cutoff);

  if (active.length === 0) {
    map.delete(key);
  } else {
    map.set(key, active);
  }

  if (active.length >= limit) {
    const retryAfterMs = Math.max((active[0] + windowMs) - now, 1_000);
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
    };
  }

  active.push(now);
  map.set(key, active);
  return { allowed: true, retryAfterSeconds: 0 };
}

function getRequesterIp(req) {
  const candidate = req.ip || req.socket?.remoteAddress || 'unknown';
  return String(candidate).replace(/^::ffff:/, '');
}

function sendBootstrapRateLimited(res, retryAfterSeconds, message) {
  const retryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds
    : 60;
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(429).type('text/plain').send(message || 'Too many bootstrap requests. Please retry later.');
}

function getCredentialValue(req, headerName, bodyNames = [], queryNames = []) {
  const headerValue = req.get(headerName);
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  for (const name of bodyNames) {
    const value = req.body?.[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  for (const name of queryNames) {
    const value = req.query?.[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function getDeviceCredentialsFromRequest(req) {
  return {
    registrationCode: getCredentialValue(
      req,
      'X-HomeBrain-Registration-Code',
      ['registrationCode'],
      ['code', 'registrationCode']
    ),
    claimToken: getCredentialValue(
      req,
      'X-HomeBrain-Claim-Token',
      ['claimToken'],
      ['claim', 'claimToken']
    ),
    deviceToken: getCredentialValue(
      req,
      'X-HomeBrain-Device-Token',
      ['deviceToken'],
      ['deviceToken']
    )
  };
}

function sanitizeDeviceForRemote(device) {
  if (!device) {
    return null;
  }

  return {
    _id: device._id,
    name: device.name,
    room: device.room,
    deviceType: device.deviceType,
    status: device.status,
    supportedWakeWords: device.supportedWakeWords,
    volume: device.volume,
    microphoneSensitivity: device.microphoneSensitivity,
    firmwareVersion: device.firmwareVersion,
    lastSeen: device.lastSeen,
    registered: device.settings?.registered === true
  };
}

function buildRemoteDeviceConfig(device, req) {
  const defaultThreshold = typeof device.settings?.wakeWordThreshold === 'number'
    ? device.settings.wakeWordThreshold
    : 0.5;

  return {
    deviceId: device._id,
    name: device.name,
    room: device.room,
    wakeWords: device.supportedWakeWords,
    volume: device.volume,
    microphoneSensitivity: device.microphoneSensitivity,
    hubUrl: `${toWebSocketOrigin(getRequestOrigin(req))}/ws/voice-device/${device._id}`,
    settings: {
      audioSampleRate: 16000,
      audioChannels: 1,
      wakeWordThreshold: defaultThreshold,
      recordingTimeout: 30000
    }
  };
}

async function getLatestRemoteSetupSourceMtimeMs() {
  const sourceStats = await Promise.all(
    REMOTE_SETUP_FILES.map(async (file) => {
      try {
        return await fsPromises.stat(path.join(REMOTE_SETUP_SOURCE_DIR, file));
      } catch {
        return null;
      }
    })
  );

  return sourceStats.reduce((latest, stat) => (
    stat ? Math.max(latest, stat.mtimeMs) : latest
  ), 0);
}

async function ensureRemoteSetupPackage() {
  await fsPromises.mkdir(REMOTE_SETUP_PACKAGE_DIR, { recursive: true });

  const latestSourceMtimeMs = await getLatestRemoteSetupSourceMtimeMs();
  const existingStat = await fsPromises.stat(REMOTE_SETUP_PACKAGE_PATH).catch(() => null);
  if (existingStat && existingStat.mtimeMs >= latestSourceMtimeMs) {
    return REMOTE_SETUP_PACKAGE_PATH;
  }

  const stagingRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'homebrain-remote-'));
  const stagingDir = path.join(stagingRoot, 'homebrain-remote');

  try {
    await fsPromises.mkdir(stagingDir, { recursive: true });

    for (const file of REMOTE_SETUP_FILES) {
      const sourcePath = path.join(REMOTE_SETUP_SOURCE_DIR, file);
      const targetPath = path.join(stagingDir, file);
      await fsPromises.copyFile(sourcePath, targetPath);
    }

    await execFileAsync('tar', [
      '-czf',
      REMOTE_SETUP_PACKAGE_PATH,
      '-C',
      stagingRoot,
      'homebrain-remote'
    ]);
  } finally {
    await fsPromises.rm(stagingRoot, { recursive: true, force: true });
  }

  return REMOTE_SETUP_PACKAGE_PATH;
}

// Description: Register a new remote device
// Endpoint: POST /api/remote-devices/register
// Request: { name: string, room: string, deviceType?: string, macAddress?: string }
// Response: { success: boolean, device: object, registrationCode: string }
router.post('/register', admin, async (req, res) => {
  console.log('POST /api/remote-devices/register - Registering new remote device');

  try {
    const { name, room, deviceType = 'speaker', macAddress } = req.body;

    if (!name || !room) {
      console.warn('POST /api/remote-devices/register - Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Name and room are required'
      });
    }

    // Generate unique registration material and device ID
    const deviceId = crypto.randomUUID();
    const onboarding = buildOnboardingSettings({}, { state: 'registered' });

    // Create new voice device
    const device = new VoiceDevice({
      name: name.trim(),
      room: room.trim(),
      deviceType,
      status: 'offline',
      serialNumber: macAddress || deviceId,
      supportedWakeWords: ['Anna', 'Henry', 'Home Brain'],
      settings: onboarding.settings
    });

    await device.save();

    void eventStreamService.publishSafe({
      type: 'remote_device.registered',
      source: 'remote_device',
      category: 'fleet',
      payload: {
        deviceId: device._id.toString(),
        name: device.name,
        room: device.room,
        deviceType: device.deviceType
      },
      tags: ['remote-device', 'registration']
    });

    console.log(`POST /api/remote-devices/register - Successfully registered device: ${device.name} (${device._id})`);
    res.status(201).json({
      success: true,
      device: sanitizeDeviceForRemote(device),
      registrationCode: onboarding.registrationCode,
      registrationExpires: onboarding.registrationExpires,
      claimToken: onboarding.claimToken,
      claimTokenExpires: onboarding.claimTokenExpires,
      message: 'Device registered successfully. Use the registration code to complete setup.'
    });

  } catch (error) {
    console.error('POST /api/remote-devices/register - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to register device'
    });
  }
});

router.get('/:deviceId/bootstrap.sh', async (req, res) => {
  const { deviceId } = req.params;
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const claim = typeof req.query.claim === 'string' ? req.query.claim : '';
  const requesterIp = getRequesterIp(req);
  const ipWindowKey = requesterIp;
  const deviceWindowKey = deviceId;
  const invalidAttemptKey = `${deviceId}:${requesterIp}`;

  try {
    const ipRateLimit = consumeSlidingWindow(
      bootstrapIpAccessWindow,
      ipWindowKey,
      BOOTSTRAP_RATE_LIMIT_MAX_PER_IP,
      BOOTSTRAP_RATE_LIMIT_WINDOW_MS
    );
    if (!ipRateLimit.allowed) {
      return sendBootstrapRateLimited(
        res,
        ipRateLimit.retryAfterSeconds,
        'Too many bootstrap requests from this network. Please wait and retry.'
      );
    }

    const deviceRateLimit = consumeSlidingWindow(
      bootstrapDeviceAccessWindow,
      deviceWindowKey,
      BOOTSTRAP_RATE_LIMIT_MAX_PER_DEVICE,
      BOOTSTRAP_RATE_LIMIT_WINDOW_MS
    );
    if (!deviceRateLimit.allowed) {
      return sendBootstrapRateLimited(
        res,
        deviceRateLimit.retryAfterSeconds,
        'Too many bootstrap requests for this device. Please wait and retry.'
      );
    }

    const access = await validateVoiceDeviceAccess(deviceId, {
      registrationCode: code,
      claimToken: claim
    }, {
      allowDeviceToken: false
    });
    if (!access.authorized) {
      const invalidAttemptLimit = consumeSlidingWindow(
        bootstrapInvalidAttemptWindow,
        invalidAttemptKey,
        BOOTSTRAP_INVALID_ATTEMPT_MAX,
        BOOTSTRAP_RATE_LIMIT_WINDOW_MS
      );
      if (!invalidAttemptLimit.allowed) {
        return sendBootstrapRateLimited(
          res,
          invalidAttemptLimit.retryAfterSeconds,
          'Too many invalid bootstrap attempts. Please wait before retrying.'
        );
      }
      return res.status(403).type('text/plain').send('Invalid device credentials');
    }
    const device = access.device;
    bootstrapInvalidAttemptWindow.delete(invalidAttemptKey);

    await ensureRemoteSetupPackage();

    const hubOrigin = getRequestOrigin(req);
    const safeHubOrigin = shellQuote(hubOrigin);
    const safeRegistrationCode = shellQuote(access.method === 'registrationCode'
      ? (device.settings?.registrationCode || code)
      : '');
    const safeClaimToken = shellQuote(access.method === 'claimToken' ? claim : '');
    const safeDeviceId = shellQuote(device._id.toString());
    const archiveUrl = `${hubOrigin}/downloads/${REMOTE_SETUP_PACKAGE_NAME}`;

    const script = `#!/usr/bin/env bash
set -euo pipefail

HUB_URL=${safeHubOrigin}
REGISTRATION_CODE=${safeRegistrationCode}
CLAIM_TOKEN=${safeClaimToken}
DEVICE_ID=${safeDeviceId}
ARCHIVE_URL=${shellQuote(archiveUrl)}
INSTALL_DIR="\${HOME}/homebrain-remote"
TMP_DIR="$(mktemp -d /tmp/homebrain-remote-setup-XXXXXX)"

cleanup() {
  rm -rf "\${TMP_DIR}"
}
trap cleanup EXIT

if ! command -v curl >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y curl
fi

echo "[HomeBrain] Downloading remote listener package..."
curl -fsSL "\${ARCHIVE_URL}" -o "\${TMP_DIR}/homebrain-remote-setup.tar.gz"

mkdir -p "\${INSTALL_DIR}"
tar -xzf "\${TMP_DIR}/homebrain-remote-setup.tar.gz" -C "\${INSTALL_DIR}" --strip-components=1

cd "\${INSTALL_DIR}"
chmod +x ./install.sh
./install.sh

if [ -n "\${CLAIM_TOKEN}" ]; then
  ./register.sh --claim-token "\${CLAIM_TOKEN}" --device-id "\${DEVICE_ID}" --hub "\${HUB_URL}"
else
  ./register.sh --registration-code "\${REGISTRATION_CODE}" --device-id "\${DEVICE_ID}" --hub "\${HUB_URL}"
fi
sudo systemctl enable homebrain-remote >/dev/null 2>&1 || true
sudo systemctl restart homebrain-remote

echo "[HomeBrain] Installation complete for device: ${device.name}"
echo "[HomeBrain] Check status: sudo systemctl status homebrain-remote --no-pager"
echo "[HomeBrain] Follow logs: sudo journalctl -u homebrain-remote -f"
`;

    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(script);
  } catch (error) {
    console.error(`GET /api/remote-devices/${deviceId}/bootstrap.sh - Error:`, error.message);
    console.error(error.stack);
    return res.status(500).type('text/plain').send('Failed to generate bootstrap script');
  }
});

router.get('/:deviceId/cloud-init.yaml', async (req, res) => {
  const { deviceId } = req.params;
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const claim = typeof req.query.claim === 'string' ? req.query.claim : '';
  const requesterIp = getRequesterIp(req);
  const ipWindowKey = requesterIp;
  const deviceWindowKey = deviceId;
  const invalidAttemptKey = `${deviceId}:${requesterIp}`;

  try {
    const ipRateLimit = consumeSlidingWindow(
      bootstrapIpAccessWindow,
      ipWindowKey,
      BOOTSTRAP_RATE_LIMIT_MAX_PER_IP,
      BOOTSTRAP_RATE_LIMIT_WINDOW_MS
    );
    if (!ipRateLimit.allowed) {
      return sendBootstrapRateLimited(
        res,
        ipRateLimit.retryAfterSeconds,
        'Too many cloud-init requests from this network. Please wait and retry.'
      );
    }

    const deviceRateLimit = consumeSlidingWindow(
      bootstrapDeviceAccessWindow,
      deviceWindowKey,
      BOOTSTRAP_RATE_LIMIT_MAX_PER_DEVICE,
      BOOTSTRAP_RATE_LIMIT_WINDOW_MS
    );
    if (!deviceRateLimit.allowed) {
      return sendBootstrapRateLimited(
        res,
        deviceRateLimit.retryAfterSeconds,
        'Too many cloud-init requests for this device. Please wait and retry.'
      );
    }

    const access = await validateVoiceDeviceAccess(deviceId, {
      registrationCode: code,
      claimToken: claim
    }, {
      allowDeviceToken: false
    });
    if (!access.authorized) {
      const invalidAttemptLimit = consumeSlidingWindow(
        bootstrapInvalidAttemptWindow,
        invalidAttemptKey,
        BOOTSTRAP_INVALID_ATTEMPT_MAX,
        BOOTSTRAP_RATE_LIMIT_WINDOW_MS
      );
      if (!invalidAttemptLimit.allowed) {
        return sendBootstrapRateLimited(
          res,
          invalidAttemptLimit.retryAfterSeconds,
          'Too many invalid cloud-init attempts. Please wait before retrying.'
        );
      }
      return res.status(403).type('text/plain').send('Invalid device credentials');
    }
    const device = access.device;
    bootstrapInvalidAttemptWindow.delete(invalidAttemptKey);

    const hubOrigin = getRequestOrigin(req);
    const credentialQuery = access.method === 'claimToken'
      ? `claim=${encodeURIComponent(claim)}`
      : `code=${encodeURIComponent(device.settings?.registrationCode || code)}`;
    const bootstrapUrl = `${hubOrigin}/api/remote-devices/${deviceId}/bootstrap.sh?${credentialQuery}`;
    const hostLabel = (device.name || 'listener')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);

    const cloudInit = `#cloud-config
hostname: homebrain-${hostLabel || 'listener'}
package_update: true
packages:
  - curl
runcmd:
  - [ bash, -lc, "curl -fsSL '${bootstrapUrl}' | bash" ]
final_message: "HomeBrain listener bootstrap completed."
`;

    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(cloudInit);
  } catch (error) {
    console.error(`GET /api/remote-devices/${deviceId}/cloud-init.yaml - Error:`, error.message);
    return res.status(500).type('text/plain').send('Failed to generate cloud-init user-data');
  }
});

router.get('/:deviceId/wake-words', async (req, res) => {
  const { deviceId } = req.params;
  const { platform, arch } = req.query;

  try {
    const device = await getAuthorizedDevice(deviceId, getDeviceCredentialsFromRequest(req));
    if (!device) {
      return res.status(403).json({
        success: false,
        message: 'Invalid device credentials'
      });
    }

    const assets = wakeWordAssets.getAssetsForWakeWords(device.supportedWakeWords, {
      platform,
      arch,
      allowGeneric: true
    });

    const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);
    const metadataBySlug = {};
    try {
      const slugs = assets.map((asset) => asset.slug);
      if (slugs.length) {
        const models = await WakeWordModel.find({ slug: { $in: slugs } });
        models.forEach((model) => {
          metadataBySlug[model.slug] = model.metadata || {};
        });
      }
    } catch (error) {
      console.warn(`Failed to load wake word metadata for device ${device.name}:`, error.message);
    }

    res.status(200).json({
      success: true,
      wakeWords: device.supportedWakeWords,
      assets: assets.map((asset) => ({
        label: asset.label,
        slug: asset.slug,
        fileName: asset.fileName,
        size: asset.size,
        checksum: asset.checksum,
        updatedAt: asset.updatedAt,
        downloadPath: `/api/remote-devices/${deviceId}/wake-words/${asset.slug}`,
        platform: asset.platform,
        arch: asset.arch,
        engine: asset.engine,
        format: asset.format,
        sensitivity: asset.sensitivity != null ? clampValue(asset.sensitivity, 0, 1) : undefined,
        threshold: clampValue(
          typeof asset.threshold === 'number'
            ? asset.threshold
            : typeof metadataBySlug[asset.slug]?.threshold === 'number'
              ? metadataBySlug[asset.slug].threshold
              : 0.55,
          0,
          1
        ),
        metadata: metadataBySlug[asset.slug] || {}
      }))
    });

  } catch (error) {
    console.error(`GET /api/remote-devices/${deviceId}/wake-words - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch wake word assets'
    });
  }
});

// Stream TTS audio for a device using ElevenLabs with device validation
router.get('/:deviceId/tts', async (req, res) => {
  const { deviceId } = req.params;
  const { text, voiceId } = req.query;

  try {
    const device = await getAuthorizedDevice(deviceId, getDeviceCredentialsFromRequest(req));
    if (!device) {
      return res.status(403).json({ success: false, message: 'Invalid device credentials' });
    }
    if (!text || !voiceId) {
      return res.status(400).json({ success: false, message: 'Missing text or voiceId' });
    }

    const cachedAudioPath = await voiceAcknowledgmentService.findCachedAudio(String(voiceId), String(text));
    if (cachedAudioPath) {
      const stat = await fsPromises.stat(cachedAudioPath);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'no-store');
      const cachedStream = fs.createReadStream(cachedAudioPath);
      cachedStream.on('error', () => {
        res.status(500).end();
      });
      cachedStream.pipe(res);
      return;
    }

    const speech = await elevenLabsService.textToSpeechDetailed(String(text), String(voiceId));
    const audioBuffer = speech.audioBuffer;

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-ElevenLabs-Cache', speech.cacheHit ? 'hit' : 'miss');
    res.setHeader('X-ElevenLabs-Emotion-Tagging', speech.tagger?.status || 'unknown');
    res.status(200).send(audioBuffer);
  } catch (error) {
    console.error(`GET /api/remote-devices/${deviceId}/tts - Error:`, error.message);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate TTS' });
  }
});

router.get('/:deviceId/wake-words/:slug', async (req, res) => {
  const { deviceId, slug } = req.params;
  const { platform, arch } = req.query;

  try {
    const device = await getAuthorizedDevice(deviceId, getDeviceCredentialsFromRequest(req));
    if (!device) {
      return res.status(403).json({
        success: false,
        message: 'Invalid device credentials'
      });
    }

    const normalisedSlug = slug.toLowerCase().replace(/\.(ppn|tflite|onnx)$/i, '');
    const asset = wakeWordAssets.getAssetForWakeWord(normalisedSlug, {
      slug: normalisedSlug,
      platform,
      arch,
      allowGeneric: true
    });

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: `Wake word asset not found for slug: ${normalisedSlug}`
      });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', asset.size);
    res.setHeader('ETag', asset.checksum);
    res.setHeader('Content-Disposition', `attachment; filename="${asset.fileName}"`);
    res.setHeader('X-Wake-Word-Format', asset.format || path.extname(asset.fileName).slice(1));
    res.setHeader('X-Wake-Word-Engine', asset.engine || 'openwakeword');

    const readStream = fs.createReadStream(asset.absolutePath);
    readStream.on('error', (streamError) => {
      console.error(`Failed to stream wake word asset ${asset.fileName}:`, streamError.message);
      res.status(500).end();
    });

    readStream.pipe(res);

  } catch (error) {
    console.error(`GET /api/remote-devices/${deviceId}/wake-words/${slug} - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to download wake word asset'
    });
  }
});

// Description: Complete device registration with onboarding credentials
// Endpoint: POST /api/remote-devices/activate
// Request: { registrationCode?: string, claimToken?: string, deviceId?: string, ipAddress?: string, firmwareVersion?: string }
// Response: { success: boolean, device: object, hubUrl: string }
router.post('/activate', onboardingMutationRateLimit, async (req, res) => {
  console.log('POST /api/remote-devices/activate - Activating device with onboarding credentials');

  try {
    const { registrationCode, claimToken, deviceId, ipAddress, firmwareVersion } = req.body;
    const normalizedRegistrationCode = typeof registrationCode === 'string' ? registrationCode.trim() : '';
    const normalizedClaimToken = typeof claimToken === 'string' ? claimToken.trim() : '';
    const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';

    if (!normalizedRegistrationCode && !normalizedClaimToken) {
      console.warn('POST /api/remote-devices/activate - Missing onboarding credentials');
      return res.status(400).json({
        success: false,
        message: 'Registration code or claim token is required'
      });
    }

    let device = null;
    let accessMethod = null;

    if (normalizedClaimToken) {
      if (!normalizedDeviceId) {
        return res.status(400).json({
          success: false,
          message: 'Device ID is required when activating with a claim token'
        });
      }

      const claimAccess = await validateVoiceDeviceAccess(
        normalizedDeviceId,
        { claimToken: normalizedClaimToken },
        { allowRegistrationCode: false, allowDeviceToken: false }
      );
      if (claimAccess.authorized) {
        device = claimAccess.device;
        accessMethod = claimAccess.method;
      }
    }

    if (!device && normalizedRegistrationCode) {
      const candidate = await VoiceDevice.findOne({
        'settings.registrationCode': normalizedRegistrationCode,
        'settings.registered': false
      });
      const registrationAccess = validateDeviceCredentials(
        candidate,
        { registrationCode: normalizedRegistrationCode },
        { allowClaimToken: false, allowDeviceToken: false }
      );
      if (registrationAccess.authorized) {
        device = candidate;
        accessMethod = registrationAccess.method;
      }
    }

    if (!device) {
      console.warn('POST /api/remote-devices/activate - Invalid or expired onboarding credentials');
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired onboarding credentials'
      });
    }

    const issuedDeviceToken = issueDeviceToken();
    applyDeviceActivation(device, issuedDeviceToken, {
      ipAddress,
      firmwareVersion
    });

    await device.save();

    void eventStreamService.publishSafe({
      type: 'remote_device.activated',
      source: 'remote_device',
      category: 'fleet',
      payload: {
        deviceId: device._id.toString(),
        name: device.name,
        room: device.room,
        firmwareVersion: device.firmwareVersion || null,
        ipAddress: device.ipAddress || null,
        accessMethod
      },
      tags: ['remote-device', 'activation']
    });

    const hubUrl = `${toWebSocketOrigin(getRequestOrigin(req))}/ws/voice-device?deviceId=${device._id}`;

    console.log(`POST /api/remote-devices/activate - Successfully activated device: ${device.name} (${device._id})`);
    res.status(200).json({
      success: true,
      device: sanitizeDeviceForRemote(device),
      deviceToken: issuedDeviceToken.deviceToken,
      hubUrl: hubUrl,
      message: 'Device activated successfully'
    });

  } catch (error) {
    console.error('POST /api/remote-devices/activate - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to activate device'
    });
  }
});

router.post('/:deviceId/onboarding/reissue', onboardingMutationRateLimit, admin, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await VoiceDevice.findById(deviceId);
    if (!device) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    const onboarding = applyOnboardingReissue(device);
    await device.save();

    void eventStreamService.publishSafe({
      type: 'remote_device.onboarding_reissued',
      source: 'remote_device',
      category: 'security',
      payload: {
        deviceId: device._id.toString(),
        name: device.name,
        expiresAt: onboarding.registrationExpires
      },
      tags: ['remote-device', 'security', 'registration']
    });

    return res.status(200).json({
      success: true,
      device: sanitizeDeviceForRemote(device),
      registrationCode: onboarding.registrationCode,
      registrationExpires: onboarding.registrationExpires,
      claimToken: onboarding.claimToken,
      claimTokenExpires: onboarding.claimTokenExpires,
      message: 'Device onboarding credentials reissued. Re-run the generated installer on the listener.'
    });
  } catch (error) {
    console.error('POST /api/remote-devices/:deviceId/onboarding/reissue - Error:', {
      deviceId,
      error: error.message
    });
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to reissue onboarding credentials'
    });
  }
});

router.post('/:deviceId/claim-token/rotate', onboardingMutationRateLimit, admin, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await VoiceDevice.findById(deviceId);
    if (!device) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    if (device.settings?.registered === true) {
      return res.status(409).json({
        success: false,
        message: 'Device is already activated. Use onboarding reissue before redeploying a registered listener.'
      });
    }

    const issued = issueDeviceClaimToken();
    device.settings = {
      ...(device.settings || {}),
      claimToken: issued.claimToken,
      claimTokenExpires: issued.claimTokenExpires
    };
    await device.save();

    void eventStreamService.publishSafe({
      type: 'remote_device.claim_token_rotated',
      source: 'remote_device',
      category: 'security',
      payload: {
        deviceId: device._id.toString(),
        name: device.name,
        expiresAt: issued.claimTokenExpires
      },
      tags: ['remote-device', 'security']
    });

    return res.status(200).json({
      success: true,
      claimToken: issued.claimToken,
      claimTokenExpires: issued.claimTokenExpires
    });
  } catch (error) {
    console.error('POST /api/remote-devices/:deviceId/claim-token/rotate - Error:', {
      deviceId,
      error: error.message
    });
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to rotate claim token'
    });
  }
});

// Description: Get device status and configuration by device ID
// Endpoint: GET /api/remote-devices/:deviceId/config
// Request: {}
// Response: { success: boolean, device: object, config: object }
router.get('/:deviceId/config', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`GET /api/remote-devices/${deviceId}/config - Fetching device configuration`);

  try {
    const device = await getAuthorizedDevice(deviceId, getDeviceCredentialsFromRequest(req));

    if (!device) {
      console.warn(`GET /api/remote-devices/${deviceId}/config - Invalid device credentials`);
      return res.status(403).json({
        success: false,
        message: 'Invalid device credentials'
      });
    }

    const config = buildRemoteDeviceConfig(device, req);

    console.log(`GET /api/remote-devices/${deviceId}/config - Successfully fetched configuration for ${device.name}`);
    res.status(200).json({
      success: true,
      device: sanitizeDeviceForRemote(device),
      config: config
    });

  } catch (error) {
    console.error(`GET /api/remote-devices/${deviceId}/config - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch device configuration'
    });
  }
});

// Description: Update device status and metrics
// Endpoint: POST /api/remote-devices/:deviceId/heartbeat
// Request: { status?: string, batteryLevel?: number, uptime?: number, lastInteraction?: string }
// Response: { success: boolean, message: string }
router.post('/:deviceId/heartbeat', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`POST /api/remote-devices/${deviceId}/heartbeat - Updating device heartbeat`);

  try {
    const { status, batteryLevel, uptime, lastInteraction } = req.body;
    const existingDevice = await getAuthorizedDevice(deviceId, getDeviceCredentialsFromRequest(req));
    if (!existingDevice) {
      console.warn(`POST /api/remote-devices/${deviceId}/heartbeat - Invalid device credentials`);
      return res.status(403).json({
        success: false,
        message: 'Invalid device credentials'
      });
    }

    const updateData = {
      lastSeen: new Date(),
    };

    if (status) updateData.status = status;
    if (typeof batteryLevel === 'number') updateData.batteryLevel = batteryLevel;
    if (typeof uptime === 'number') updateData.uptime = uptime;
    if (lastInteraction) updateData.lastInteraction = new Date(lastInteraction);

    const device = await VoiceDevice.findByIdAndUpdate(
      deviceId,
      updateData,
      { returnDocument: 'after' }
    );

    if (!device) {
      console.warn(`POST /api/remote-devices/${deviceId}/heartbeat - Device not found`);
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    console.log(`POST /api/remote-devices/${deviceId}/heartbeat - Successfully updated heartbeat for ${device.name}`);
    res.status(200).json({
      success: true,
      message: 'Heartbeat updated successfully'
    });

  } catch (error) {
    console.error(`POST /api/remote-devices/${deviceId}/heartbeat - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update device heartbeat'
    });
  }
});

// Description: Get setup instructions for remote devices
// Endpoint: GET /api/remote-devices/setup-instructions
// Request: {}
// Response: { success: boolean, instructions: object }
router.get('/setup-instructions', admin, async (req, res) => {
  console.log('GET /api/remote-devices/setup-instructions - Fetching setup instructions');

  try {
    await ensureRemoteSetupPackage();

    const origin = getRequestOrigin(req);
    const instructions = {
      overview: 'Set up a Linux remote listener with a single command. Raspberry Pi is the most common target.',
      requirements: [
        '64-bit Debian or Ubuntu based Linux device (Raspberry Pi OS Lite, Ubuntu Server, or similar)',
        'A local user account with sudo access',
        'Working network connection to the HomeBrain hub',
        'Microphone + speaker hardware configured'
      ],
      steps: [
        {
          title: 'Run the one-command installer',
          description: 'After registering a device in the UI, run the generated command on the listener device.',
          commands: [
            'curl -fsSL <HUB_URL>/api/remote-devices/<DEVICE_ID>/bootstrap.sh?claim=<CLAIM_TOKEN> | bash'
          ]
        },
        {
          title: 'Optional: zero-touch with cloud-init',
          description: 'Use the generated cloud-init URL in Raspberry Pi Imager advanced options for first-boot Raspberry Pi automation.',
          commands: [
            'curl -fsSL <HUB_URL>/api/remote-devices/<DEVICE_ID>/cloud-init.yaml?claim=<CLAIM_TOKEN>'
          ]
        },
        {
          title: 'Monitor startup status',
          description: 'Verify the service came online and connected to the hub.',
          commands: [
            'sudo systemctl status homebrain-remote --no-pager',
            'sudo journalctl -u homebrain-remote -f'
          ]
        }
      ],
      bootstrapUrlTemplate: `${origin}/api/remote-devices/<DEVICE_ID>/bootstrap.sh?code=<REGISTRATION_CODE>`,
      bootstrapClaimUrlTemplate: `${origin}/api/remote-devices/<DEVICE_ID>/bootstrap.sh?claim=<CLAIM_TOKEN>`,
      quickInstallCommandTemplate: `curl -fsSL ${origin}/api/remote-devices/<DEVICE_ID>/bootstrap.sh?code=<REGISTRATION_CODE> | bash`,
      quickInstallClaimCommandTemplate: `curl -fsSL ${origin}/api/remote-devices/<DEVICE_ID>/bootstrap.sh?claim=<CLAIM_TOKEN> | bash`,
      cloudInitUrlTemplate: `${origin}/api/remote-devices/<DEVICE_ID>/cloud-init.yaml?claim=<CLAIM_TOKEN>`,
      downloadUrl: `${origin}/downloads/homebrain-remote-setup.sh`,
      configTemplate: {
        hubUrl: origin,
        audioConfig: {
          sampleRate: 16000,
          channels: 1,
          recordingDevice: 'default',
          playbackDevice: 'default'
        }
      }
    };

    console.log('GET /api/remote-devices/setup-instructions - Successfully generated setup instructions');
    res.status(200).json({
      success: true,
      instructions: instructions
    });

  } catch (error) {
    console.error('GET /api/remote-devices/setup-instructions - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch setup instructions'
    });
  }
});

// Description: Delete/unregister a remote device
// Endpoint: DELETE /api/remote-devices/:deviceId
// Request: {}
// Response: { success: boolean, message: string }
router.delete('/:deviceId', admin, async (req, res) => {
  const { deviceId } = req.params;
  console.log(`DELETE /api/remote-devices/${deviceId} - Deleting remote device`);

  try {
    const device = await VoiceDevice.findByIdAndDelete(deviceId);

    if (!device) {
      console.warn(`DELETE /api/remote-devices/${deviceId} - Device not found`);
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    console.log(`DELETE /api/remote-devices/${deviceId} - Successfully deleted device: ${device.name}`);

    void eventStreamService.publishSafe({
      type: 'remote_device.deleted',
      source: 'remote_device',
      category: 'fleet',
      severity: 'warn',
      payload: {
        deviceId: device._id.toString(),
        name: device.name,
        room: device.room
      },
      tags: ['remote-device', 'lifecycle']
    });

    res.status(200).json({
      success: true,
      message: 'Device deleted successfully'
    });

  } catch (error) {
    console.error(`DELETE /api/remote-devices/${deviceId} - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete device'
    });
  }
});

module.exports = router;
