const express = require('express');
const router = express.Router();
const VoiceDevice = require('../models/VoiceDevice');
const { requireUser } = require('./middlewares/auth');
const crypto = require('crypto');
const wakeWordAssets = require('../utils/wakeWordAssets');
const fs = require('fs');

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
        arch: asset.arch
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

    const normalisedSlug = slug.toLowerCase().replace(/\.ppn$/i, '');
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
    const instructions = {
      overview: 'Set up a Raspberry Pi as a remote voice device for HomeBrain',
      requirements: [
        'Raspberry Pi 3B+ or newer',
        'MicroSD card (16GB or larger)',
        'USB microphone or HAT with microphone',
        'Speakers or headphones',
        'WiFi connection'
      ],
      steps: [
        {
          title: 'Prepare Raspberry Pi',
          description: 'Install Raspberry Pi OS and enable SSH',
          commands: [
            'sudo apt update && sudo apt upgrade -y',
            'sudo apt install git nodejs npm python3-pip -y'
          ]
        },
        {
          title: 'Download HomeBrain Remote',
          description: 'Download and install the remote device software',
          commands: [
            'git clone https://github.com/homebrain/remote-device.git',
            'cd remote-device',
            'npm install'
          ]
        },
        {
          title: 'Configure Audio',
          description: 'Set up microphone and speakers',
          commands: [
            'arecord -l  # List recording devices',
            'aplay -l   # List playback devices',
            'sudo nano /etc/asound.conf  # Configure default audio devices'
          ]
        },
        {
          title: 'Register Device',
          description: 'Use the HomeBrain interface to register your device and get a registration code'
        },
        {
          title: 'Start Remote Service',
          description: 'Start the remote device service with your registration code',
          commands: [
            'npm start -- --register <REGISTRATION_CODE>'
          ]
        }
      ],
      downloadUrl: `http://${req.get('host')}/downloads/homebrain-remote-setup.sh`,
      configTemplate: {
        hubUrl: `http://${req.get('host')}`,
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
