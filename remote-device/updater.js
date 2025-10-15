#!/usr/bin/env node

/**
 * HomeBrain Remote Device Updater
 * Handles automatic updates for remote devices
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class RemoteDeviceUpdater {
  constructor() {
    this.installDir = process.cwd();
    this.backupDir = path.join(this.installDir, '.backup');
    this.tempDir = path.join(this.installDir, '.temp');
    this.currentVersion = null;
  }

  /**
   * Initialize updater
   */
  async initialize() {
    console.log('Initializing HomeBrain Remote Device Updater...');

    try {
      // Load current version
      const packageJsonPath = path.join(this.installDir, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      this.currentVersion = packageJson.version;

      console.log(`Current version: ${this.currentVersion}`);

      // Ensure temp directory exists
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      console.log('Updater initialized successfully');
    } catch (error) {
      console.error('Failed to initialize updater:', error);
      throw error;
    }
  }

  /**
   * Download update package
   */
  async downloadUpdate(downloadUrl, expectedChecksum) {
    console.log(`Downloading update from: ${downloadUrl}`);

    const updateFilePath = path.join(this.tempDir, 'update.zip');

    return new Promise((resolve, reject) => {
      const protocol = downloadUrl.startsWith('https') ? https : http;

      const file = fs.createWriteStream(updateFilePath);

      protocol.get(downloadUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', async () => {
          file.close();

          try {
            // Verify checksum
            const actualChecksum = await this.calculateChecksum(updateFilePath);

            if (expectedChecksum && actualChecksum !== expectedChecksum) {
              fs.unlinkSync(updateFilePath);
              reject(new Error('Checksum verification failed'));
              return;
            }

            console.log('Download completed and verified successfully');
            resolve(updateFilePath);
          } catch (error) {
            reject(error);
          }
        });

      }).on('error', (error) => {
        fs.unlinkSync(updateFilePath);
        reject(error);
      });
    });
  }

  /**
   * Calculate SHA256 checksum for a file
   */
  async calculateChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (error) => reject(error));
    });
  }

  /**
   * Create backup of current installation
   */
  async createBackup() {
    console.log('Creating backup of current installation...');

    try {
      // Remove old backup if exists
      if (fs.existsSync(this.backupDir)) {
        await execAsync(`rm -rf "${this.backupDir}"`);
      }

      // Create new backup directory
      fs.mkdirSync(this.backupDir, { recursive: true });

      // Files to backup
      const filesToBackup = [
        'index.js',
        'package.json',
        'config.json',
        'README.md'
      ];

      // Copy files
      for (const file of filesToBackup) {
        const srcPath = path.join(this.installDir, file);
        const destPath = path.join(this.backupDir, file);

        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }

      // Backup node_modules package list
      const { stdout } = await execAsync('npm list --json --depth=0');
      fs.writeFileSync(
        path.join(this.backupDir, 'package-list.json'),
        stdout
      );

      console.log('Backup created successfully');
    } catch (error) {
      console.error('Failed to create backup:', error);
      throw error;
    }
  }

  /**
   * Extract update package
   */
  async extractUpdate(updateFilePath) {
    console.log('Extracting update package...');

    try {
      const extractDir = path.join(this.tempDir, 'extract');

      // Remove old extract directory
      if (fs.existsSync(extractDir)) {
        await execAsync(`rm -rf "${extractDir}"`);
      }

      // Create extract directory
      fs.mkdirSync(extractDir, { recursive: true });

      // Extract zip file
      await execAsync(`unzip -o "${updateFilePath}" -d "${extractDir}"`);

      console.log('Update package extracted successfully');
      return extractDir;
    } catch (error) {
      console.error('Failed to extract update:', error);
      throw error;
    }
  }

  /**
   * Install update
   */
  async installUpdate(extractDir) {
    console.log('Installing update...');

    try {
      // Files to update
      const filesToUpdate = [
        'index.js',
        'package.json',
        'README.md',
        'updater.js',
        'feature_infer.py'
      ];

      // Determine if dependencies changed by comparing package.json
      let depsChanged = false;
      try {
        const oldPkg = JSON.parse(fs.readFileSync(path.join(this.installDir, 'package.json'), 'utf8'));
        const newPkg = JSON.parse(fs.readFileSync(path.join(extractDir, 'package.json'), 'utf8'));
        const pick = (o) => ({ ...(o.dependencies||{}), ...(o.optionalDependencies||{}), ...(o.peerDependencies||{}) });
        const oldDeps = JSON.stringify(pick(oldPkg));
        const newDeps = JSON.stringify(pick(newPkg));
        depsChanged = oldDeps !== newDeps;
      } catch (_) {
        // If we can't compare, assume changed
        depsChanged = true;
      }

      // Copy updated files
      for (const file of filesToUpdate) {
        const srcPath = path.join(extractDir, file);
        const destPath = path.join(this.installDir, file);

        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          console.log(`Updated: ${file}`);
        }
      }

      // Update dependencies only if necessary
      if (depsChanged) {
        console.log('Dependencies changed; running npm install...');
        await execAsync('npm install', { cwd: this.installDir });
      } else {
        console.log('Dependencies unchanged; skipping npm install');
      }

      console.log('Update installed successfully');
    } catch (error) {
      console.error('Failed to install update:', error);
      throw error;
    }
  }

  /**
   * Restore from backup
   */
  async restoreBackup() {
    console.log('Restoring from backup...');

    try {
      if (!fs.existsSync(this.backupDir)) {
        throw new Error('Backup directory not found');
      }

      // Files to restore
      const filesToRestore = [
        'index.js',
        'package.json',
        'README.md'
      ];

      // Restore files
      for (const file of filesToRestore) {
        const srcPath = path.join(this.backupDir, file);
        const destPath = path.join(this.installDir, file);

        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }

      // Restore dependencies
      await execAsync('npm install', { cwd: this.installDir });

      console.log('Backup restored successfully');
    } catch (error) {
      console.error('Failed to restore backup:', error);
      throw error;
    }
  }

  /**
   * Cleanup temp files
   */
  async cleanup() {
    console.log('Cleaning up temporary files...');

    try {
      if (fs.existsSync(this.tempDir)) {
        await execAsync(`rm -rf "${this.tempDir}"`);
      }

      console.log('Cleanup completed');
    } catch (error) {
      console.warn('Cleanup failed:', error.message);
    }
  }

  /**
   * Perform full update process
   */
  async performUpdate(downloadUrl, expectedChecksum, version) {
    console.log('='.repeat(50));
    console.log('Starting HomeBrain Remote Device Update');
    console.log('='.repeat(50));
    console.log(`Current version: ${this.currentVersion}`);
    console.log(`Target version: ${version}`);
    console.log('');

    try {
      // Step 1: Create backup
      console.log('[1/5] Creating backup...');
      await this.createBackup();

      // Step 2: Download update
      console.log('[2/5] Downloading update...');
      const updateFilePath = await this.downloadUpdate(downloadUrl, expectedChecksum);

      // Step 3: Extract update
      console.log('[3/5] Extracting update...');
      const extractDir = await this.extractUpdate(updateFilePath);

      // Step 4: Install update
      console.log('[4/5] Installing update...');
      await this.installUpdate(extractDir);

      // Step 5: Cleanup
      console.log('[5/5] Cleaning up...');
      await this.cleanup();

      console.log('');
      console.log('='.repeat(50));
      console.log('Update completed successfully!');
      console.log('='.repeat(50));
      console.log('The device will restart in 5 seconds...');
      console.log('');

      return {
        success: true,
        oldVersion: this.currentVersion,
        newVersion: version
      };

    } catch (error) {
      console.error('');
      console.error('='.repeat(50));
      console.error('Update failed!');
      console.error('='.repeat(50));
      console.error('Error:', error.message);
      console.error('');

      // Attempt to restore backup
      try {
        console.log('Attempting to restore backup...');
        await this.restoreBackup();
        console.log('Backup restored successfully');
      } catch (restoreError) {
        console.error('Failed to restore backup:', restoreError.message);
        console.error('Manual intervention may be required!');
      }

      await this.cleanup();

      throw error;
    }
  }

  /**
   * Restart device service
   */
  async restartDevice() {
    console.log('Restarting device service...');

    setTimeout(() => {
      process.exit(0);
    }, 5000);
  }
}

// Export for use as a module
module.exports = RemoteDeviceUpdater;

// Allow running as standalone script
if (require.main === module) {
  const [,, downloadUrl, checksum, version] = process.argv;

  if (!downloadUrl || !checksum || !version) {
    console.error('Usage: node updater.js <download_url> <checksum> <version>');
    process.exit(1);
  }

  const updater = new RemoteDeviceUpdater();

  (async () => {
    try {
      await updater.initialize();
      await updater.performUpdate(downloadUrl, checksum, version);
      await updater.restartDevice();
    } catch (error) {
      console.error('Update failed:', error);
      process.exit(1);
    }
  })();
}
