const VoiceDevice = require('../models/VoiceDevice');
const fs = require('fs').promises;
const path = require('path');
const { createWriteStream } = require('fs');
const crypto = require('crypto');
const { ZipFile } = require('yazl');
const eventStreamService = require('./eventStreamService');
const { getConfiguredPublicOrigin } = require('../utils/publicOrigin');

class RemoteUpdateService {
  constructor() {
    this.updatePackagePath = path.join(__dirname, '..', 'public', 'downloads', 'updates');
    this.remoteDevicePath = path.join(__dirname, '..', '..', 'remote-device');
    this.currentVersion = null;
  }

  normalizeVersion(version) {
    const raw = (version || '0.0.0').toString().trim().toLowerCase();
    const normalized = raw.replace(/^v/, '');
    const parts = normalized
      .split(/[.\-+_]/)
      .slice(0, 3)
      .map((part) => {
        const numeric = Number.parseInt(part.replace(/[^0-9]/g, ''), 10);
        return Number.isFinite(numeric) ? numeric : 0;
      });

    while (parts.length < 3) {
      parts.push(0);
    }

    return parts;
  }

  /**
   * Initialize the update service
   */
  async initialize() {
    console.log('Initializing Remote Update Service...');

    try {
      // Ensure update package directory exists
      await fs.mkdir(this.updatePackagePath, { recursive: true });

      // Load current version from remote-device package.json
      const packageJsonPath = path.join(this.remoteDevicePath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      this.currentVersion = packageJson.version;

      console.log(`Remote Update Service initialized. Current version: ${this.currentVersion}`);
    } catch (error) {
      console.error('Failed to initialize Remote Update Service:', error);
      throw error;
    }
  }

  /**
   * Get current remote device version
   */
  getCurrentVersion() {
    return this.currentVersion;
  }

  /**
   * Check if an update is available for a device
   */
  async checkForUpdates(deviceId) {
    console.log(`Checking for updates for device: ${deviceId}`);

    try {
      const device = await VoiceDevice.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      const deviceVersion = device.firmwareVersion || '0.0.0';
      const updateAvailable = this.compareVersions(this.currentVersion, deviceVersion) > 0;

      console.log(`Device ${device.name} - Current: ${deviceVersion}, Latest: ${this.currentVersion}, Update available: ${updateAvailable}`);

      return {
        updateAvailable,
        currentVersion: deviceVersion,
        latestVersion: this.currentVersion,
        deviceName: device.name
      };
    } catch (error) {
      console.error(`Error checking for updates for device ${deviceId}:`, error);
      throw error;
    }
  }

  /**
   * Compare two semantic versions
   * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1, v2) {
    const parts1 = this.normalizeVersion(v1);
    const parts2 = this.normalizeVersion(v2);

    for (let i = 0; i < 3; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;

      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }

    return 0;
  }

  /**
   * Generate an update package for remote devices
   */
  async generateUpdatePackage(force = false) {
    console.log('Generating remote device update package...');

    try {
      const version = this.currentVersion;
      const packageName = `homebrain-remote-v${version}.zip`;
      const packagePath = path.join(this.updatePackagePath, packageName);
      const checksumPath = path.join(this.updatePackagePath, `${packageName}.sha256`);

      const exists = await fs.access(packagePath).then(() => true).catch(() => false);
      if (exists && force) {
        console.log(`Force flag set; removing existing package ${packageName}`);
        try { await fs.unlink(packagePath); } catch (_) {}
        try { await fs.unlink(checksumPath); } catch (_) {}
      } else if (exists) {
        console.log(`Update package already exists: ${packageName}`);
        const checksum = await fs.readFile(checksumPath, 'utf8').catch(() => null);
        const stat = await fs.stat(packagePath);
        return {
          version,
          packageName,
          packagePath,
          checksumPath,
          checksum,
          size: stat.size
        };
      }

      // Create zip archive
      await this.createZipArchive(packagePath);

      // Generate checksum
      const checksum = await this.generateChecksum(packagePath);
      await fs.writeFile(checksumPath, checksum);
      const stat = await fs.stat(packagePath);

      // Verify integrity by reading back and comparing checksum
      const verifySum = await this.generateChecksum(packagePath);
      if (verifySum !== checksum) {
        throw new Error('Package checksum self-verify failed');
      }

      console.log(`Update package generated: ${packageName}`);
      console.log(`Checksum: ${checksum}`);

      void eventStreamService.publishSafe({
        type: 'remote_update.package_generated',
        source: 'remote_update',
        category: 'fleet',
        payload: {
          version,
          packageName,
          size: stat.size,
          checksum
        },
        tags: ['remote-update', 'package']
      });

      return {
        version,
        packageName,
        packagePath,
        checksumPath,
        checksum,
        size: stat.size
      };
    } catch (error) {
      console.error('Error generating update package:', error);

      void eventStreamService.publishSafe({
        type: 'remote_update.package_generation_failed',
        source: 'remote_update',
        category: 'fleet',
        severity: 'error',
        payload: {
          error: error.message || 'Unknown error'
        },
        tags: ['remote-update', 'package']
      });

      throw error;
    }
  }

  /**
   * Create a zip archive of the remote device code
   */
  async createZipArchive(outputPath) {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(outputPath);
      const zipfile = new ZipFile();

      output.on('close', async () => {
        try {
          const stats = await fs.stat(outputPath);
          console.log(`Archive created: ${stats.size} bytes`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      output.on('error', reject);
      zipfile.outputStream.on('error', reject);

      zipfile.outputStream.pipe(output);

      const filesToInclude = [
        'index.js',
        'package.json',
        'README.md',
        'updater.js',
        'feature_infer.py'
      ];

      for (const file of filesToInclude) {
        const filePath = path.join(this.remoteDevicePath, file);
        zipfile.addFile(filePath, file, { compress: true });
      }

      zipfile.end();
    });
  }

  /**
   * Generate SHA256 checksum for a file
   */
  async generateChecksum(filePath) {
    const fileBuffer = await fs.readFile(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
  }

  /**
   * Get update package info
   */
  async getUpdatePackageInfo() {
    const version = this.currentVersion;
    const packageName = `homebrain-remote-v${version}.zip`;
    const packagePath = path.join(this.updatePackagePath, packageName);
    const checksumPath = path.join(this.updatePackagePath, `${packageName}.sha256`);

    try {
      const [packageStats, checksum] = await Promise.all([
        fs.stat(packagePath),
        fs.readFile(checksumPath, 'utf8').catch(() => null)
      ]);

      return {
        version,
        packageName,
        packagePath,
        size: packageStats.size,
        checksum,
        downloadUrl: `/downloads/updates/${packageName}`
      };
    } catch (error) {
      // Package doesn't exist yet
      return null;
    }
  }

  /**
   * Initiate update for a specific device
   */
  async initiateUpdate(deviceId, voiceWebSocket, options = { force: false, baseUrl: null }) {
    console.log(`Initiating update for device: ${deviceId}${options.force ? ' (force)' : ''}`);

    try {
      const device = await VoiceDevice.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      // Check if device is online unless force requested
      if (device.status !== 'online' && !options.force) {
        throw new Error('Device is not online');
      }

      // Ensure update package exists and has a public download URL
      let packageInfo = await this.getUpdatePackageInfo();
      if (!packageInfo || options.force) {
        await this.generateUpdatePackage(Boolean(options.force));
        packageInfo = await this.getUpdatePackageInfo();
      }
      if (!packageInfo || !packageInfo.downloadUrl) {
        throw new Error('Update package is not available');
      }

      // Prepare update command
      const origin = options.baseUrl || getConfiguredPublicOrigin() || `http://localhost:${process.env.PORT || 3000}`;
      const updateCommand = {
        type: 'update_available',
        version: packageInfo.version,
        downloadUrl: `${origin}${packageInfo.downloadUrl}`,
        checksum: packageInfo.checksum,
        size: packageInfo.size,
        mandatory: Boolean(options.force)
      };

      // Send update command to device via WebSocket and verify delivery (with retries)
      const sockets = Array.isArray(voiceWebSocket) ? voiceWebSocket.filter(Boolean) : [voiceWebSocket].filter(Boolean);
      let sent = false;
      for (const ws of sockets) {
        if (!ws || sent) continue;
        for (let attempt = 1; attempt <= 5 && !sent; attempt++) {
          sent = Boolean(ws.sendMessage(deviceId, updateCommand));
          if (!sent) {
            console.warn(`Update send attempt ${attempt} failed for ${deviceId} on WS instance; retrying...`);
            await new Promise((r) => setTimeout(r, 400));
          }
        }
      }
      if (!sent) {
        try {
          const stats = typeof voiceWebSocket.getStats === 'function' ? voiceWebSocket.getStats() : null;
          console.warn('WebSocket stats at send failure:', stats);
        } catch (_) {}
        throw new Error('Device not connected to hub (WebSocket send failed)');
      }

      // Only mark as updating after the command was sent
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'updating',
        updateStatus: {
          status: 'downloading',
          version: packageInfo.version,
          startedAt: new Date()
        },
        'settings.updateStatus': {
          status: 'downloading',
          version: packageInfo.version,
          startedAt: new Date()
        }
      });

      void eventStreamService.publishSafe({
        type: 'remote_update.initiated',
        source: 'remote_update',
        category: 'fleet',
        payload: {
          deviceId: device._id.toString(),
          deviceName: device.name,
          room: device.room,
          fromVersion: device.firmwareVersion || '0.0.0',
          toVersion: packageInfo.version,
          force: Boolean(options.force)
        },
        tags: ['remote-update', 'fleet']
      });

      console.log(`Update initiated for device ${device.name} to version ${packageInfo.version}`);

      return {
        success: true,
        device: device.name,
        version: packageInfo.version,
        message: 'Update initiated successfully'
      };
    } catch (error) {
      console.error(`Error initiating update for device ${deviceId}:`, error);

      // Attempt to reset device status only if it exists and wasn't updating
      try {
        await VoiceDevice.findByIdAndUpdate(deviceId, {
          status: 'online',
          updateStatus: {
            status: 'failed',
            version: options?.version || this.currentVersion,
            error: error.message,
            failedAt: new Date()
          },
          'settings.updateStatus': {
            status: 'failed',
            error: error.message,
            failedAt: new Date()
          }
        });
      } catch (_) {}

      void eventStreamService.publishSafe({
        type: 'remote_update.initiation_failed',
        source: 'remote_update',
        category: 'fleet',
        severity: 'error',
        payload: {
          deviceId: String(deviceId),
          error: error.message || 'Unknown error'
        },
        tags: ['remote-update', 'fleet']
      });

      throw error;
    }
  }

  /**
   * Initiate update for all devices
   */
  async initiateUpdateForAll(voiceWebSocket, options = {}) {
    console.log('Initiating update for all devices...');

    try {
      const force = options.force === true;
      const onlyOutdated = options.onlyOutdated !== false;
      const baseUrl = options.baseUrl || null;
      const onlineDevices = await VoiceDevice.find({ status: 'online' });
      const devices = onlineDevices.filter((device) => {
        if (force || !onlyOutdated) {
          return true;
        }
        const installedVersion = device.firmwareVersion || '0.0.0';
        return this.compareVersions(this.currentVersion, installedVersion) > 0;
      });

      const results = [];
      for (const device of devices) {
        try {
          const result = await this.initiateUpdate(device._id.toString(), voiceWebSocket, {
            force,
            baseUrl
          });
          results.push(result);
        } catch (error) {
          console.error(`Failed to initiate update for device ${device.name}:`, error.message);
          results.push({
            success: false,
            deviceId: device._id.toString(),
            device: device.name,
            error: error.message
          });
        }
      }

      const summary = {
        totalOnlineDevices: onlineDevices.length,
        targetDevices: devices.length,
        initiated: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        skipped: onlineDevices.length - devices.length,
        latestVersion: this.currentVersion,
        results
      };

      void eventStreamService.publishSafe({
        type: 'remote_update.bulk_initiated',
        source: 'remote_update',
        category: 'fleet',
        payload: {
          totalOnlineDevices: summary.totalOnlineDevices,
          targetDevices: summary.targetDevices,
          initiated: summary.initiated,
          failed: summary.failed,
          skipped: summary.skipped,
          latestVersion: summary.latestVersion
        },
        tags: ['remote-update', 'fleet']
      });

      return summary;
    } catch (error) {
      console.error('Error initiating update for all devices:', error);

      void eventStreamService.publishSafe({
        type: 'remote_update.bulk_initiation_failed',
        source: 'remote_update',
        category: 'fleet',
        severity: 'error',
        payload: {
          error: error.message || 'Unknown error'
        },
        tags: ['remote-update', 'fleet']
      });

      throw error;
    }
  }

  /**
   * Update device update status
   */
  async updateDeviceStatus(deviceId, status, error = null, reportedVersion = null) {
    console.log(`Updating device ${deviceId} update status: ${status}`);

    try {
      const resolvedVersion = (reportedVersion || this.currentVersion || '').toString().trim() || this.currentVersion;
      const updateData = {
        updateStatus: {
          status,
          version: resolvedVersion,
          lastUpdated: new Date()
        },
        'settings.updateStatus.status': status,
        'settings.updateStatus.version': resolvedVersion,
        'settings.updateStatus.lastUpdated': new Date()
      };

      if (status === 'completed') {
        updateData.status = 'online';
        updateData.firmwareVersion = resolvedVersion;
        updateData.lastUpdate = new Date();
        updateData['updateStatus.completedAt'] = new Date();
        updateData['settings.updateStatus.completedAt'] = new Date();
      } else if (status === 'failed') {
        updateData.status = 'error';
        updateData['updateStatus.error'] = error;
        updateData['updateStatus.failedAt'] = new Date();
        updateData['settings.updateStatus.error'] = error;
        updateData['settings.updateStatus.failedAt'] = new Date();
      } else if (status === 'downloading') {
        updateData.status = 'updating';
        updateData['updateStatus.startedAt'] = new Date();
      } else if (status === 'installing') {
        updateData.status = 'updating';
      }

      await VoiceDevice.findByIdAndUpdate(deviceId, updateData);

      void eventStreamService.publishSafe({
        type: 'remote_update.device_status_changed',
        source: 'remote_update',
        category: 'fleet',
        severity: status === 'failed' ? 'error' : 'info',
        payload: {
          deviceId: String(deviceId),
          status,
          version: resolvedVersion,
          error: error || null
        },
        tags: ['remote-update', 'device-status']
      });

      console.log(`Device ${deviceId} status updated to: ${status}`);
    } catch (error) {
      console.error(`Error updating device status for ${deviceId}:`, error);
      throw error;
    }
  }

  /**
   * Get update statistics
   */
  async getUpdateStatistics() {
    console.log('Fetching update statistics...');

    try {
      const devices = await VoiceDevice.find({});

      const stats = {
        totalDevices: devices.length,
        currentVersion: this.currentVersion,
        upToDate: 0,
        outdated: 0,
        updating: 0,
        offline: 0,
        byVersion: {}
      };

      devices.forEach(device => {
        const version = device.firmwareVersion || '0.0.0';

        // Count by status
        if (device.status === 'updating') {
          stats.updating++;
        } else if (device.status === 'offline') {
          stats.offline++;
        } else if (this.compareVersions(version, this.currentVersion) >= 0) {
          stats.upToDate++;
        } else {
          stats.outdated++;
        }

        // Count by version
        stats.byVersion[version] = (stats.byVersion[version] || 0) + 1;
      });

      return stats;
    } catch (error) {
      console.error('Error fetching update statistics:', error);
      throw error;
    }
  }

  /**
   * Get devices needing update
   */
  async getDevicesNeedingUpdate() {
    console.log('Fetching devices needing update...');

    try {
      const devices = await VoiceDevice.find({});

      const outdatedDevices = devices.filter(device => {
        const version = device.firmwareVersion || '0.0.0';
        return this.compareVersions(this.currentVersion, version) > 0;
      });

      return outdatedDevices.map(device => ({
        id: device._id,
        name: device.name,
        room: device.room,
        currentVersion: device.firmwareVersion || '0.0.0',
        latestVersion: this.currentVersion,
        status: device.status,
        lastSeen: device.lastSeen
      }));
    } catch (error) {
      console.error('Error fetching devices needing update:', error);
      throw error;
    }
  }

  async getFleetStatus() {
    console.log('Fetching remote device fleet status...');
    try {
      const devices = await VoiceDevice.find({}).sort({ room: 1, name: 1 });
      const latestVersion = this.currentVersion || '0.0.0';
      const summary = {
        totalDevices: devices.length,
        onlineDevices: 0,
        offlineDevices: 0,
        updatingDevices: 0,
        upToDateDevices: 0,
        outdatedDevices: 0,
        upToDateOnline: 0,
        outdatedOnline: 0,
        latestVersion
      };

      const rows = devices.map((device) => {
        const installedVersion = device.firmwareVersion || '0.0.0';
        const isUpToDate = this.compareVersions(installedVersion, latestVersion) >= 0;
        const isOnline = device.status === 'online';
        const isUpdating = device.status === 'updating';
        const topLevelUpdateStatus = device?.updateStatus || {};
        const settingsUpdateStatus = device?.settings?.updateStatus || {};
        const persistedUpdateStatus = (
          topLevelUpdateStatus?.status && topLevelUpdateStatus.status !== 'idle'
        )
          ? topLevelUpdateStatus
          : { ...topLevelUpdateStatus, ...settingsUpdateStatus };

        if (isOnline) {
          summary.onlineDevices += 1;
        } else {
          summary.offlineDevices += 1;
        }

        if (isUpdating) {
          summary.updatingDevices += 1;
        }

        if (isUpToDate) {
          summary.upToDateDevices += 1;
          if (isOnline) {
            summary.upToDateOnline += 1;
          }
        } else {
          summary.outdatedDevices += 1;
          if (isOnline) {
            summary.outdatedOnline += 1;
          }
        }

        return {
          id: device._id.toString(),
          name: device.name,
          room: device.room,
          status: device.status,
          firmwareVersion: installedVersion,
          latestVersion,
          isOnline,
          isUpToDate,
          updateStatus: {
            status: persistedUpdateStatus.status || (isUpdating ? 'installing' : 'idle'),
            version: persistedUpdateStatus.version || null,
            startedAt: persistedUpdateStatus.startedAt || null,
            completedAt: persistedUpdateStatus.completedAt || null,
            failedAt: persistedUpdateStatus.failedAt || null,
            error: persistedUpdateStatus.error || null
          },
          lastSeen: device.lastSeen || null
        };
      });

      return {
        latestVersion,
        summary,
        devices: rows
      };
    } catch (error) {
      console.error('Error fetching remote fleet status:', error);
      throw error;
    }
  }
}

// Create singleton instance
const remoteUpdateService = new RemoteUpdateService();

module.exports = remoteUpdateService;
