const VoiceDevice = require('../models/VoiceDevice');

/**
 * Service for managing voice devices
 */
class VoiceDeviceService {
  
  /**
   * Get all voice devices
   * @returns {Promise<Array>} Array of voice devices
   */
  async getAllDevices() {
    console.log('VoiceDeviceService: Fetching all voice devices');
    try {
      const devices = await VoiceDevice.find()
        .select('name room deviceType status lastSeen batteryLevel powerSource connectionType ipAddress volume microphoneSensitivity firmwareVersion uptime settings audioStreamActive audioStreamStartedAt lastTranscriptText lastTranscriptAt lastTranscriptConfidence lastTranscriptProvider lastTranscriptModel lastTranscriptLanguage lastTranscriptError lastWakeWord lastWakeWordAt lastWakeWordConfidence')
        .sort({ room: 1, name: 1 });
      
      console.log(`VoiceDeviceService: Found ${devices.length} voice devices`);
      return devices;
    } catch (error) {
      console.error('VoiceDeviceService: Error fetching voice devices:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to fetch voice devices: ${error.message}`);
    }
  }

  /**
   * Get voice device by ID
   * @param {string} deviceId - The device ID
   * @returns {Promise<Object>} Voice device object
   */
  async getDeviceById(deviceId) {
    console.log(`VoiceDeviceService: Fetching voice device by ID: ${deviceId}`);
    try {
      const device = await VoiceDevice.findById(deviceId);
      
      if (!device) {
        console.warn(`VoiceDeviceService: Voice device not found with ID: ${deviceId}`);
        throw new Error('Voice device not found');
      }
      
      console.log(`VoiceDeviceService: Found voice device: ${device.name} in ${device.room}`);
      return device;
    } catch (error) {
      console.error('VoiceDeviceService: Error fetching voice device:', {
        deviceId,
        error: error.message
      });
      console.error(error.stack);
      
      if (error.message === 'Voice device not found') {
        throw error;
      }
      throw new Error(`Failed to fetch voice device: ${error.message}`);
    }
  }

  /**
   * Get voice system status
   * @returns {Promise<Object>} System status object
   */
  async getSystemStatus() {
    console.log('VoiceDeviceService: Getting voice system status');
    try {
      // Get device counts by status
      const deviceStats = await VoiceDevice.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      // Get total device count
      const totalDevices = await VoiceDevice.countDocuments();
      
      // Calculate status counts
      const statusCounts = deviceStats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {});

      const onlineDevices = statusCounts.online || 0;
      const offlineDevices = statusCounts.offline || 0;
      const errorDevices = statusCounts.error || 0;
      const updatingDevices = statusCounts.updating || 0;

      // Check if system is listening (at least one device is online)
      const listening = onlineDevices > 0;
      
      // Check if system is connected (more than half devices are online)
      const connected = totalDevices > 0 && (onlineDevices / totalDevices) >= 0.5;

      const status = {
        listening,
        connected,
        activeDevices: onlineDevices,
        totalDevices,
        deviceStats: {
          online: onlineDevices,
          offline: offlineDevices,
          error: errorDevices,
          updating: updatingDevices
        }
      };

      // Log a cleaner status summary instead of the full object
      console.log(`VoiceDeviceService: System status - ${onlineDevices}/${totalDevices} devices online, listening: ${listening}, connected: ${connected}`);
      return status;
    } catch (error) {
      console.error('VoiceDeviceService: Error getting system status:', error.message);
      console.error(error.stack);
      throw new Error(`Failed to get voice system status: ${error.message}`);
    }
  }

  /**
   * Diagnose voice device connectivity and functionality from real hub state.
   * @param {string} deviceId - The device ID to diagnose
   * @param {Object} options - Diagnostic context
   * @returns {Promise<Object>} Diagnostic result object
   */
  async diagnoseDevice(deviceId, options = {}) {
    console.log(`VoiceDeviceService: Diagnosing voice device: ${deviceId}`);
    try {
      const device = await this.getDeviceById(deviceId);

      const diagnostics = this.buildDeviceDiagnostics(device, options);
      const success = diagnostics.checks.websocketAuthenticated.ok && diagnostics.checks.heartbeatFresh.ok;
      const errors = Object.values(diagnostics.checks)
        .filter((check) => !check.ok && check.severity !== 'info')
        .map((check) => check.message);

      const testResults = {
        connectivity: diagnostics.checks.websocketAuthenticated.ok,
        audioInput: diagnostics.capabilities.audioInputAvailable,
        audioOutput: diagnostics.capabilities.audioOutputAvailable,
        wakeWordDetection: diagnostics.capabilities.wakeWordConfigured,
        latency: null,
        errors,
        checks: diagnostics.checks,
        websocket: diagnostics.websocket,
        heartbeat: diagnostics.heartbeat,
        onboarding: diagnostics.onboarding,
        updateStatus: diagnostics.updateStatus
      };

      const message = success
        ? 'Voice device diagnostics passed with an authenticated websocket and fresh heartbeat.'
        : `Voice device diagnostics failed: ${errors.join(', ') || 'no live authenticated websocket found'}`;

      const result = {
        success,
        message,
        deviceName: device.name,
        room: device.room,
        testResults,
        diagnostics
      };

      console.log(`VoiceDeviceService: Diagnostics completed for ${device.name}:`, result);
      return result;
      
    } catch (error) {
      console.error('VoiceDeviceService: Error diagnosing voice device:', {
        deviceId,
        error: error.message
      });
      console.error(error.stack);
      
      if (error.message === 'Voice device not found') {
        throw error;
      }
      throw new Error(`Failed to diagnose voice device: ${error.message}`);
    }
  }

  /**
   * Backward-compatible alias for routes and clients still calling this a test.
   */
  async testDevice(deviceId, options = {}) {
    return this.diagnoseDevice(deviceId, options);
  }

  buildDeviceDiagnostics(device, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const nowMs = now.getTime();
    const statsSources = Array.isArray(options.websocketStats) ? options.websocketStats : [];
    const deviceId = device._id.toString();
    const connection = statsSources
      .flatMap((stats) => Array.isArray(stats?.connections) ? stats.connections : [])
      .find((entry) => entry?.deviceId === deviceId) || null;
    const lastSeenMs = device.lastSeen ? new Date(device.lastSeen).getTime() : 0;
    const heartbeatAgeMs = lastSeenMs ? Math.max(0, nowMs - lastSeenMs) : null;
    const heartbeatFreshThresholdMs = Math.max(
      30_000,
      Number(options.heartbeatFreshThresholdMs || process.env.VOICE_DEVICE_HEARTBEAT_FRESH_MS || 90_000)
    );
    const settings = device.settings && typeof device.settings === 'object' ? device.settings : {};
    const registered = settings.registered === true;
    const hasDeviceToken = typeof settings.deviceTokenHash === 'string' && settings.deviceTokenHash.length > 0;
    const registrationExpiresAt = settings.registrationExpires ? new Date(settings.registrationExpires) : null;
    const claimTokenExpiresAt = settings.claimTokenExpires ? new Date(settings.claimTokenExpires) : null;
    const registrationExpired = Boolean(registrationExpiresAt && registrationExpiresAt.getTime() <= nowMs);
    const claimTokenExpired = Boolean(claimTokenExpiresAt && claimTokenExpiresAt.getTime() <= nowMs);
    const supportsAudioInput = ['speaker', 'microphone', 'hub', 'display'].includes(device.deviceType);
    const supportsAudioOutput = ['speaker', 'hub', 'display'].includes(device.deviceType);
    const wakeWordConfigured = device.wakeWordSupport !== false
      && Array.isArray(device.supportedWakeWords)
      && device.supportedWakeWords.length > 0;
    const websocketAuthenticated = Boolean(connection?.authenticated);
    const websocketConnected = Boolean(connection);
    const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= heartbeatFreshThresholdMs;
    const persistedUpdateStatus = device.updateStatus?.status && device.updateStatus.status !== 'idle'
      ? device.updateStatus
      : { ...(device.updateStatus || {}), ...(settings.updateStatus || {}) };

    const checks = {
      database: {
        ok: true,
        severity: 'info',
        message: 'Device record exists.'
      },
      activated: {
        ok: registered && hasDeviceToken,
        severity: 'error',
        message: registered && hasDeviceToken
          ? 'Device is activated and has a device token.'
          : 'Device is not activated with a device token.'
      },
      onboarding: {
        ok: registered || (!registrationExpired && !claimTokenExpired),
        severity: registered ? 'info' : 'warning',
        message: registered
          ? 'Onboarding credentials are not required after activation.'
          : registrationExpired || claimTokenExpired
            ? 'Onboarding credentials are expired; reissue onboarding before redeploying.'
            : 'Onboarding credentials are active.'
      },
      websocketConnected: {
        ok: websocketConnected,
        severity: 'error',
        message: websocketConnected
          ? 'A websocket connection is open.'
          : 'No live websocket connection is open.'
      },
      websocketAuthenticated: {
        ok: websocketAuthenticated,
        severity: 'error',
        message: websocketAuthenticated
          ? 'The websocket connection is authenticated.'
          : 'No authenticated websocket connection is present.'
      },
      heartbeatFresh: {
        ok: heartbeatFresh,
        severity: 'warning',
        message: heartbeatFresh
          ? `Last heartbeat is fresh (${heartbeatAgeMs}ms ago).`
          : heartbeatAgeMs === null
            ? 'Device has never reported a heartbeat.'
            : `Last heartbeat is stale (${heartbeatAgeMs}ms ago).`
      },
      wakeWordConfigured: {
        ok: wakeWordConfigured,
        severity: 'warning',
        message: wakeWordConfigured
          ? `Wake words configured: ${device.supportedWakeWords.join(', ')}.`
          : 'No wake words are configured for this device.'
      }
    };

    return {
      deviceId,
      generatedAt: now.toISOString(),
      status: device.status,
      onboarding: {
        registered,
        hasDeviceToken,
        lifecycleState: settings.lifecycle?.state || (registered ? 'activated' : 'unregistered'),
        registrationExpiresAt: registrationExpiresAt ? registrationExpiresAt.toISOString() : null,
        registrationExpired,
        claimTokenExpiresAt: claimTokenExpiresAt ? claimTokenExpiresAt.toISOString() : null,
        claimTokenExpired
      },
      websocket: {
        connected: websocketConnected,
        authenticated: websocketAuthenticated,
        lastPing: connection?.lastPing || null
      },
      heartbeat: {
        lastSeen: device.lastSeen || null,
        ageMs: heartbeatAgeMs,
        freshThresholdMs: heartbeatFreshThresholdMs,
        fresh: heartbeatFresh
      },
      capabilities: {
        supportsAudioInput,
        supportsAudioOutput,
        wakeWordConfigured,
        audioInputAvailable: websocketAuthenticated && supportsAudioInput,
        audioOutputAvailable: websocketAuthenticated && supportsAudioOutput
      },
      updateStatus: {
        status: persistedUpdateStatus.status || (device.status === 'updating' ? 'installing' : 'idle'),
        version: persistedUpdateStatus.version || null,
        error: persistedUpdateStatus.error || null,
        startedAt: persistedUpdateStatus.startedAt || null,
        completedAt: persistedUpdateStatus.completedAt || null,
        failedAt: persistedUpdateStatus.failedAt || null
      },
      checks
    };
  }

  /**
   * Update device status
   * @param {string} deviceId - The device ID
   * @param {string} status - New status (online, offline, error, updating)
   * @returns {Promise<Object>} Updated device object
   */
  async updateDeviceStatus(deviceId, status) {
    console.log(`VoiceDeviceService: Updating device ${deviceId} status to ${status}`);
    try {
      const device = await VoiceDevice.findByIdAndUpdate(
        deviceId,
        { 
          status,
          lastSeen: status === 'online' ? new Date() : undefined
        },
        { returnDocument: 'after' }
      );

      if (!device) {
        console.warn(`VoiceDeviceService: Voice device not found for status update: ${deviceId}`);
        throw new Error('Voice device not found');
      }

      console.log(`VoiceDeviceService: Updated status for ${device.name} to ${status}`);
      return device;
    } catch (error) {
      console.error(`VoiceDeviceService: Error updating device status ${deviceId}:`, error.message);
      console.error(error.stack);
      
      if (error.message === 'Voice device not found') {
        throw error;
      }
      throw new Error(`Failed to update device status: ${error.message}`);
    }
  }

  /**
   * Get devices by room
   * @param {string} room - Room name
   * @returns {Promise<Array>} Array of voice devices in the room
   */
  async getDevicesByRoom(room) {
    console.log(`VoiceDeviceService: Fetching voice devices in room: ${room}`);
    try {
      const devices = await VoiceDevice.find({ room })
        .select('name deviceType status lastSeen batteryLevel powerSource connectionType volume microphoneSensitivity')
        .sort({ name: 1 });
      
      console.log(`VoiceDeviceService: Found ${devices.length} voice devices in ${room}`);
      return devices;
    } catch (error) {
      console.error(`VoiceDeviceService: Error fetching devices in room ${room}:`, error.message);
      console.error(error.stack);
      throw new Error(`Failed to fetch devices in room: ${error.message}`);
    }
  }

  /**
   * Get devices by status
   * @param {string} status - Device status
   * @returns {Promise<Array>} Array of voice devices with the status
   */
  async getDevicesByStatus(status) {
    console.log(`VoiceDeviceService: Fetching voice devices with status: ${status}`);
    try {
      const devices = await VoiceDevice.find({ status })
        .select('name room deviceType lastSeen batteryLevel powerSource connectionType')
        .sort({ room: 1, name: 1 });
      
      console.log(`VoiceDeviceService: Found ${devices.length} voice devices with status ${status}`);
      return devices;
    } catch (error) {
      console.error(`VoiceDeviceService: Error fetching devices with status ${status}:`, error.message);
      console.error(error.stack);
      throw new Error(`Failed to fetch devices by status: ${error.message}`);
    }
  }
}

module.exports = new VoiceDeviceService();
