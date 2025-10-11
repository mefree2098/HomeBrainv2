const VoiceDevice = require('../models/VoiceDevice');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const { createWriteStream } = require('fs');
const crypto = require('crypto');

class RemoteUpdateService {
  constructor() {
    this.updatePackagePath = path.join(__dirname, '..', 'public', 'downloads', 'updates');
    this.remoteDevicePath = path.join(__dirname, '..', '..', 'remote-device');
    this.currentVersion = null;
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
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

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
  async generateUpdatePackage() {
    console.log('Generating remote device update package...');

    try {
      const version = this.currentVersion;
      const packageName = `homebrain-remote-v${version}.zip`;
      const packagePath = path.join(this.updatePackagePath, packageName);
      const checksumPath = path.join(this.updatePackagePath, `${packageName}.sha256`);

      // Check if package already exists
      try {
        await fs.access(packagePath);
        console.log(`Update package already exists: ${packageName}`);
        return {
          version,
          packageName,
          packagePath,
          checksumPath
        };
      } catch (err) {
        // Package doesn't exist, create it
      }

      // Create zip archive
      await this.createZipArchive(packagePath);

      // Generate checksum
      const checksum = await this.generateChecksum(packagePath);
      await fs.writeFile(checksumPath, checksum);

      console.log(`Update package generated: ${packageName}`);
      console.log(`Checksum: ${checksum}`);

      return {
        version,
        packageName,
        packagePath,
        checksumPath,
        checksum
      };
    } catch (error) {
      console.error('Error generating update package:', error);
      throw error;
    }
  }

  /**
   * Create a zip archive of the remote device code
   */
  async createZipArchive(outputPath) {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        console.log(`Archive created: ${archive.pointer()} bytes`);
        resolve();
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);

      // Add remote device files
      const filesToInclude = [
        'index.js',
        'package.json',
        'README.md',
        'updater.js'
      ];

      filesToInclude.forEach(file => {
        const filePath = path.join(this.remoteDevicePath, file);
        archive.file(filePath, { name: file });
      });

      archive.finalize();
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
  async initiateUpdate(deviceId, voiceWebSocket) {
    console.log(`Initiating update for device: ${deviceId}`);

    try {
      const device = await VoiceDevice.findById(deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      // Check if device is online
      if (device.status !== 'online') {
        throw new Error('Device is not online');
      }

      // Generate update package if needed
      const packageInfo = await this.generateUpdatePackage();

      // Update device status
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'updating',
        'settings.updateStatus': {
          status: 'initiated',
          version: packageInfo.version,
          startedAt: new Date()
        }
      });

      // Send update command to device via WebSocket
      const updateCommand = {
        type: 'update_available',
        version: packageInfo.version,
        downloadUrl: `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}${packageInfo.downloadUrl}`,
        checksum: packageInfo.checksum,
        size: packageInfo.size,
        mandatory: false
      };

      if (voiceWebSocket) {
        voiceWebSocket.sendMessage(deviceId, updateCommand);
      }

      console.log(`Update initiated for device ${device.name} to version ${packageInfo.version}`);

      return {
        success: true,
        device: device.name,
        version: packageInfo.version,
        message: 'Update initiated successfully'
      };
    } catch (error) {
      console.error(`Error initiating update for device ${deviceId}:`, error);

      // Reset device status on error
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'online',
        'settings.updateStatus': {
          status: 'failed',
          error: error.message,
          failedAt: new Date()
        }
      });

      throw error;
    }
  }

  /**
   * Initiate update for all devices
   */
  async initiateUpdateForAll(voiceWebSocket) {
    console.log('Initiating update for all devices...');

    try {
      const devices = await VoiceDevice.find({ status: 'online' });

      const results = [];
      for (const device of devices) {
        try {
          const result = await this.initiateUpdate(device._id.toString(), voiceWebSocket);
          results.push(result);
        } catch (error) {
          console.error(`Failed to initiate update for device ${device.name}:`, error.message);
          results.push({
            success: false,
            device: device.name,
            error: error.message
          });
        }
      }

      return {
        totalDevices: devices.length,
        initiated: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      };
    } catch (error) {
      console.error('Error initiating update for all devices:', error);
      throw error;
    }
  }

  /**
   * Update device update status
   */
  async updateDeviceStatus(deviceId, status, error = null) {
    console.log(`Updating device ${deviceId} update status: ${status}`);

    try {
      const updateData = {
        'settings.updateStatus.status': status,
        'settings.updateStatus.lastUpdated': new Date()
      };

      if (status === 'completed') {
        updateData.status = 'online';
        updateData.firmwareVersion = this.currentVersion;
        updateData['settings.updateStatus.completedAt'] = new Date();
      } else if (status === 'failed') {
        updateData.status = 'error';
        updateData['settings.updateStatus.error'] = error;
        updateData['settings.updateStatus.failedAt'] = new Date();
      } else if (status === 'downloading') {
        updateData.status = 'updating';
      } else if (status === 'installing') {
        updateData.status = 'updating';
      }

      await VoiceDevice.findByIdAndUpdate(deviceId, updateData);

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
        } else if (this.compareVersions(version, this.currentVersion) === 0) {
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
}

// Create singleton instance
const remoteUpdateService = new RemoteUpdateService();

module.exports = remoteUpdateService;
