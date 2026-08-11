#!/usr/bin/env node

/**
 * HomeBrain Remote Device Updater
 * Handles automatic updates for remote devices
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_UPDATE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_ARCHIVE_LIST_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MANAGED_FILES = Object.freeze([
  'index.js',
  'package.json',
  'package-lock.json',
  'README.md',
  'updater.js',
  'feature_infer.py'
]);

function isLocalOrPrivateHostname(hostname) {
  let value = String(hostname || '').trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return true;
  if (!value.includes('.') && !value.includes(':')) return true;
  if (net.isIPv4(value)) {
    const octets = value.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (net.isIPv6(value)) {
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  }
  return false;
}

function normalizeSha256(value) {
  const checksum = String(value || '').trim().toLowerCase();
  if (checksum.length !== 64) return '';
  for (const character of checksum) {
    const isDigit = character >= '0' && character <= '9';
    const isHexLetter = character >= 'a' && character <= 'f';
    if (!isDigit && !isHexLetter) return '';
  }
  return checksum;
}

function normalizeArchiveEntry(value) {
  const entry = String(value || '').trim();
  if (!entry || entry.length > 512 || entry.includes('\0') || entry.includes('\\')) return '';
  if (path.posix.isAbsolute(entry)) return '';
  const normalized = path.posix.normalize(entry);
  if (normalized === '..' || normalized.startsWith('../')) return '';
  return normalized;
}

class RemoteDeviceUpdater {
  constructor(options = {}) {
    this.installDir = path.resolve(options.installDir || process.cwd());
    this.backupDir = path.join(this.installDir, '.backup');
    this.tempDir = path.join(this.installDir, '.temp');
    this.allowedOrigin = options.allowedOrigin ? new URL(options.allowedOrigin).origin : '';
    this.maxDownloadBytes = Number.isFinite(Number(options.maxDownloadBytes))
      ? Math.max(1024, Math.min(DEFAULT_MAX_UPDATE_BYTES, Math.round(Number(options.maxDownloadBytes))))
      : DEFAULT_MAX_UPDATE_BYTES;
    this.currentVersion = null;
  }

  parseDownloadUrl(downloadUrl) {
    let parsed;
    try {
      parsed = new URL(String(downloadUrl || '').trim());
    } catch (_error) {
      throw new Error('Update download URL is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Update download URL must use http or https');
    }
    if (parsed.username || parsed.password) {
      throw new Error('Update download URL must not include credentials');
    }
    if (this.allowedOrigin && parsed.origin !== this.allowedOrigin) {
      throw new Error('Update download URL must use the configured HomeBrain origin');
    }
    if (!this.allowedOrigin && parsed.protocol !== 'https:' && !isLocalOrPrivateHostname(parsed.hostname)) {
      throw new Error('Public update download URLs must use HTTPS');
    }
    parsed.hash = '';
    return parsed;
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
    const parsedUrl = this.parseDownloadUrl(downloadUrl);
    const normalizedChecksum = normalizeSha256(expectedChecksum);
    if (!normalizedChecksum) {
      throw new Error('A valid SHA-256 checksum is required for updates');
    }
    console.log(`Downloading update from: ${parsedUrl.origin}${parsedUrl.pathname}`);

    const updateFilePath = path.join(this.tempDir, 'update.zip');
    await fs.promises.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    await fs.promises.rm(updateFilePath, { force: true });

    return new Promise((resolve, reject) => {
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const file = fs.createWriteStream(updateFilePath, { flags: 'wx', mode: 0o600 });
      let receivedBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        file.destroy();
        fs.promises.rm(updateFilePath, { force: true }).finally(() => reject(error));
      };

      file.on('error', fail);

      const request = protocol.get(parsedUrl, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > this.maxDownloadBytes) {
          response.destroy();
          fail(new Error('Update package exceeds the download size limit'));
          return;
        }

        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > this.maxDownloadBytes) {
            response.destroy(new Error('Update package exceeds the download size limit'));
          }
        });
        response.on('error', fail);
        response.pipe(file);

        file.on('finish', async () => {
          if (settled) return;

          try {
            if (!file.closed) {
              await new Promise((closeResolve) => file.once('close', closeResolve));
            }
            // Verify checksum
            const actualChecksum = await this.calculateChecksum(updateFilePath);

            const expectedBuffer = Buffer.from(normalizedChecksum, 'hex');
            const actualBuffer = Buffer.from(actualChecksum, 'hex');
            if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
              throw new Error('Checksum verification failed');
            }

            settled = true;
            console.log('Download completed and verified successfully');
            resolve(updateFilePath);
          } catch (error) {
            fail(error);
          }
        });
      });

      request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        request.destroy(new Error('Update download timed out'));
      });
      request.on('error', fail);
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
        await fs.promises.rm(this.backupDir, { recursive: true, force: true });
      }

      // Create new backup directory
      fs.mkdirSync(this.backupDir, { recursive: true });

      // Files to backup
      const filesToBackup = [...MANAGED_FILES, 'config.json'];

      // Copy files
      for (const file of filesToBackup) {
        const srcPath = path.join(this.installDir, file);
        const destPath = path.join(this.backupDir, file);

        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }

      // Backup node_modules package list
      const { stdout } = await execFileAsync('npm', ['list', '--json', '--depth=0'], {
        cwd: this.installDir,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024
      });
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
        await fs.promises.rm(extractDir, { recursive: true, force: true });
      }

      // Create extract directory
      fs.mkdirSync(extractDir, { recursive: true });

      const listOptions = {
        timeout: 30_000,
        maxBuffer: MAX_ARCHIVE_LIST_BYTES
      };
      const [{ stdout: namesOutput }, { stdout: detailsOutput }, { stdout: sizesOutput }] = await Promise.all([
        execFileAsync('unzip', ['-Z1', updateFilePath], listOptions),
        execFileAsync('unzip', ['-Z', '-l', updateFilePath], listOptions),
        execFileAsync('unzip', ['-l', updateFilePath], listOptions)
      ]);
      const entries = namesOutput.split('\n').map((entry) => entry.trim()).filter(Boolean);
      if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
        throw new Error('Update archive has an invalid number of entries');
      }
      for (const entry of entries) {
        if (!normalizeArchiveEntry(entry)) {
          throw new Error(`Update archive contains an unsafe path: ${entry}`);
        }
      }
      if (detailsOutput.split('\n').some((line) => line.trimStart().startsWith('l'))) {
        throw new Error('Update archive must not contain symbolic links');
      }

      let totalUncompressedBytes = 0;
      for (const line of sizesOutput.split('\n')) {
        const firstField = line.trim().split(' ', 1)[0];
        if (firstField && [...firstField].every((character) => character >= '0' && character <= '9')) {
          totalUncompressedBytes += Number(firstField);
        }
      }
      const maxUncompressedBytes = Math.min(512 * 1024 * 1024, this.maxDownloadBytes * 4);
      if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > maxUncompressedBytes) {
        throw new Error('Update archive exceeds the extracted size limit');
      }

      // Extract only after validating paths, entry types, and expanded size.
      await execFileAsync('unzip', ['-o', updateFilePath, '-d', extractDir], {
        timeout: 120_000,
        maxBuffer: MAX_ARCHIVE_LIST_BYTES
      });

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
      const filesToUpdate = MANAGED_FILES;

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
          const sourceStats = await fs.promises.lstat(srcPath);
          if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
            throw new Error(`Update entry is not a regular file: ${file}`);
          }
          const stagingPath = `${destPath}.update`;
          await fs.promises.copyFile(srcPath, stagingPath);
          await fs.promises.chmod(stagingPath, sourceStats.mode & 0o777);
          await fs.promises.rename(stagingPath, destPath);
          console.log(`Updated: ${file}`);
        }
      }

      // Update dependencies only if necessary
      if (depsChanged) {
        const hasLockfile = fs.existsSync(path.join(this.installDir, 'package-lock.json'));
        const installArgs = hasLockfile
          ? ['ci', '--no-audit', '--no-fund']
          : ['install', '--no-audit', '--no-fund'];
        console.log(`Dependencies changed; running npm ${installArgs.join(' ')}...`);
        await execFileAsync('npm', installArgs, {
          cwd: this.installDir,
          timeout: 10 * 60_000,
          maxBuffer: 16 * 1024 * 1024
        });
      } else {
        console.log('Dependencies unchanged; skipping dependency install');
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
      const filesToRestore = [...MANAGED_FILES, 'config.json'];

      // Restore files
      for (const file of filesToRestore) {
        const srcPath = path.join(this.backupDir, file);
        const destPath = path.join(this.installDir, file);

        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }

      // Restore dependencies
      const hasLockfile = fs.existsSync(path.join(this.installDir, 'package-lock.json'));
      const installArgs = hasLockfile
        ? ['ci', '--no-audit', '--no-fund']
        : ['install', '--no-audit', '--no-fund'];
      await execFileAsync('npm', installArgs, {
        cwd: this.installDir,
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024
      });

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
        await fs.promises.rm(this.tempDir, { recursive: true, force: true });
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
module.exports.__private__ = {
  isLocalOrPrivateHostname,
  normalizeArchiveEntry,
  normalizeSha256
};

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
