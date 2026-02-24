const express = require('express');
const router = express.Router();
const VoiceDevice = require('../models/VoiceDevice');
const { requireUser } = require('./middlewares/auth');
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

const execFileAsync = promisify(execFile);
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
  'feature_infer.py'
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
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function sendBootstrapRateLimited(res, retryAfterSeconds, message) {
  const retryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds
    : 60;
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(429).type('text/plain').send(message || 'Too many bootstrap requests. Please retry later.');
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
router.post('/register', requireUser(), async (req, res) => {
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

    // Generate unique registration code and device ID
    const registrationCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const deviceId = crypto.randomUUID();

    // Create new voice device
    const device = new VoiceDevice({
      name: name.trim(),
      room: room.trim(),
      deviceType,
      status: 'offline',
      serialNumber: macAddress || deviceId,
      supportedWakeWords: ['Anna', 'Henry', 'Home Brain'],
      settings: {
        registrationCode,
        registered: false,
        registrationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      }
    });

    await device.save();

    console.log(`POST /api/remote-devices/register - Successfully registered device: ${device.name} (${device._id})`);
    res.status(201).json({
      success: true,
      device: device,
      registrationCode: registrationCode,
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

async function validateDeviceAccess(deviceId, registrationCode) {
  if (!registrationCode) {
    return null;
  }

  const device = await VoiceDevice.findById(deviceId);
  if (!device) {
    return null;
  }

  if (device.settings?.registrationCode !== registrationCode) {
    return null;
  }

  return device;
}

router.get('/:deviceId/bootstrap.sh', async (req, res) => {
  const { deviceId } = req.params;
  const code = typeof req.query.code === 'string' ? req.query.code : '';
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

    const device = await validateDeviceAccess(deviceId, code);
    if (!device) {
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
    bootstrapInvalidAttemptWindow.delete(invalidAttemptKey);

    await ensureRemoteSetupPackage();

    const hubOrigin = `${req.protocol}://${req.get('host')}`;
    const safeHubOrigin = shellQuote(hubOrigin);
    const safeRegistrationCode = shellQuote(device.settings?.registrationCode || code);
    const archiveUrl = `${hubOrigin}/downloads/${REMOTE_SETUP_PACKAGE_NAME}`;

    const script = `#!/usr/bin/env bash
set -euo pipefail

HUB_URL=${safeHubOrigin}
REGISTRATION_CODE=${safeRegistrationCode}
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

./register.sh "\${REGISTRATION_CODE}" "\${HUB_URL}"
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

router.get('/:deviceId/wake-words', async (req, res) => {
  const { deviceId } = req.params;
  const { code, platform, arch } = req.query;

  try {
    const device = await validateDeviceAccess(deviceId, code);
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
  const { code, text, voiceId } = req.query;

  try {
    const device = await validateDeviceAccess(deviceId, code);
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

    const audioBuffer = await elevenLabsService.textToSpeech(String(text), String(voiceId));

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(audioBuffer);
  } catch (error) {
    console.error(`GET /api/remote-devices/${deviceId}/tts - Error:`, error.message);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate TTS' });
  }
});

router.get('/:deviceId/wake-words/:slug', async (req, res) => {
  const { deviceId, slug } = req.params;
  const { code, platform, arch } = req.query;

  try {
    const device = await validateDeviceAccess(deviceId, code);
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

// Description: Complete device registration with code
// Endpoint: POST /api/remote-devices/activate
// Request: { registrationCode: string, ipAddress?: string, firmwareVersion?: string }
// Response: { success: boolean, device: object, hubUrl: string }
router.post('/activate', async (req, res) => {
  console.log('POST /api/remote-devices/activate - Activating device with registration code');

  try {
    const { registrationCode, ipAddress, firmwareVersion } = req.body;

    if (!registrationCode) {
      console.warn('POST /api/remote-devices/activate - Missing registration code');
      return res.status(400).json({
        success: false,
        message: 'Registration code is required'
      });
    }

    // Find device with matching registration code
    const device = await VoiceDevice.findOne({
      'settings.registrationCode': registrationCode,
      'settings.registered': false,
      'settings.registrationExpires': { $gt: new Date() }
    });

    if (!device) {
      console.warn(`POST /api/remote-devices/activate - Invalid or expired registration code: ${registrationCode}`);
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired registration code'
      });
    }

    // Activate the device
    device.status = 'online';
    device.ipAddress = ipAddress;
    device.firmwareVersion = firmwareVersion;
    device.settings.registered = true;
    device.lastSeen = new Date();

    await device.save();

    // Generate hub WebSocket URL
    const hubUrl = `ws://${req.get('host')}/ws/voice-device?deviceId=${device._id}`;

    console.log(`POST /api/remote-devices/activate - Successfully activated device: ${device.name} (${device._id})`);
    res.status(200).json({
      success: true,
      device: device,
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

// Description: Get device status and configuration by device ID
// Endpoint: GET /api/remote-devices/:deviceId/config
// Request: {}
// Response: { success: boolean, device: object, config: object }
router.get('/:deviceId/config', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`GET /api/remote-devices/${deviceId}/config - Fetching device configuration`);

  try {
    const device = await VoiceDevice.findById(deviceId);

    if (!device) {
      console.warn(`GET /api/remote-devices/${deviceId}/config - Device not found`);
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    // Generate configuration for remote device
    const config = {
      deviceId: device._id,
      name: device.name,
      room: device.room,
      wakeWords: device.supportedWakeWords,
      volume: device.volume,
      microphoneSensitivity: device.microphoneSensitivity,
      hubUrl: `ws://${req.get('host')}/ws/voice-device/${device._id}`,
      settings: {
        audioSampleRate: 16000,
        audioChannels: 1,
        wakeWordThreshold: 0.5,
        recordingTimeout: 30000, // 30 seconds
      }
    };

    console.log(`GET /api/remote-devices/${deviceId}/config - Successfully fetched configuration for ${device.name}`);
    res.status(200).json({
      success: true,
      device: device,
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
      { new: true }
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
router.get('/setup-instructions', requireUser(), async (req, res) => {
  console.log('GET /api/remote-devices/setup-instructions - Fetching setup instructions');

  try {
    await ensureRemoteSetupPackage();

    const origin = `${req.protocol}://${req.get('host')}`;
    const instructions = {
      overview: 'Set up a Raspberry Pi as a HomeBrain remote listener with a single command.',
      requirements: [
        'Raspberry Pi 4/5 (Raspberry Pi OS Lite recommended)',
        'A local user account with sudo access',
        'Working network connection to the HomeBrain hub',
        'Microphone + speaker hardware configured'
      ],
      steps: [
        {
          title: 'Run the one-command installer',
          description: 'After registering a device in the UI, run the generated command on the Pi.',
          commands: [
            'curl -fsSL <HUB_URL>/api/remote-devices/<DEVICE_ID>/bootstrap.sh?code=<REGISTRATION_CODE> | bash'
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
      quickInstallCommandTemplate: `curl -fsSL ${origin}/api/remote-devices/<DEVICE_ID>/bootstrap.sh?code=<REGISTRATION_CODE> | bash`,
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
router.delete('/:deviceId', requireUser(), async (req, res) => {
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
