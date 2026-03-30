const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const DEFAULT_GPU_LOAD_PATHS = [
  '/sys/devices/gpu.0/load',
  '/sys/devices/platform/17000000.ga10b/load',
  '/sys/devices/platform/17000000.gv11b/load',
  '/sys/class/devfreq/17000000.ga10b/device/load',
  '/sys/class/devfreq/17000000.gv11b/device/load'
];

function clampPercent(value) {
  return parseFloat(Math.max(0, Math.min(100, value)).toFixed(2));
}

function parseJetsonGpuLoad(rawValue) {
  const trimmed = String(rawValue || '').trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return clampPercent(parsed > 100 ? parsed / 10 : parsed);
}

function parseTegrastatsGpuPercent(rawOutput) {
  const output = String(rawOutput || '');
  const gpuMatch = output.match(/GR3D_FREQ\s+(\d+)%/i);
  if (!gpuMatch) {
    return null;
  }

  const parsed = Number.parseInt(gpuMatch[1], 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return clampPercent(parsed);
}

function inferJetsonGpuTypeFromPath(filePath) {
  if (/ga10b/i.test(filePath)) {
    return 'NVIDIA Jetson Orin GPU';
  }

  if (/gv11b/i.test(filePath)) {
    return 'NVIDIA Jetson Xavier GPU';
  }

  return 'NVIDIA Jetson GPU';
}

class ResourceMonitorService {
  constructor(dependencies = {}) {
    this.history = [];
    this.maxHistorySize = 100; // Keep last 100 readings
    this.execAsync = dependencies.execAsync || execAsync;
    this.readFile = dependencies.readFile || fs.readFile.bind(fs);
    this.readdir = dependencies.readdir || fs.readdir.bind(fs);
  }

  /**
   * Get CPU utilization percentage
   */
  async getCPUUsage() {
    try {
      const cpus = os.cpus();
      const numCpus = cpus.length;

      // Calculate CPU usage
      let totalIdle = 0;
      let totalTick = 0;

      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
      });

      const idle = totalIdle / numCpus;
      const total = totalTick / numCpus;
      const usagePercent = 100 - ~~(100 * idle / total);

      return {
        usagePercent: parseFloat(usagePercent.toFixed(2)),
        cores: numCpus,
        model: cpus[0]?.model || 'Unknown',
        speed: cpus[0]?.speed || 0
      };
    } catch (error) {
      console.error('Error getting CPU usage:', error);
      return {
        usagePercent: 0,
        cores: 0,
        model: 'Unknown',
        speed: 0,
        error: error.message
      };
    }
  }

  /**
   * Get memory utilization
   */
  getMemoryUsage() {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const usagePercent = (usedMem / totalMem) * 100;

      return {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usagePercent: parseFloat(usagePercent.toFixed(2)),
        totalGB: parseFloat((totalMem / (1024 ** 3)).toFixed(2)),
        usedGB: parseFloat((usedMem / (1024 ** 3)).toFixed(2)),
        freeGB: parseFloat((freeMem / (1024 ** 3)).toFixed(2))
      };
    } catch (error) {
      console.error('Error getting memory usage:', error);
      return {
        total: 0,
        used: 0,
        free: 0,
        usagePercent: 0,
        totalGB: 0,
        usedGB: 0,
        freeGB: 0,
        error: error.message
      };
    }
  }

  /**
   * Get disk utilization
   */
  async getDiskUsage() {
    try {
      // Use df command to get disk usage
      const { stdout } = await this.execAsync('df -h / | tail -1');
      const parts = stdout.trim().split(/\s+/);

      // Parse df output: Filesystem Size Used Avail Use% Mounted
      const totalSize = parts[1];
      const used = parts[2];
      const available = parts[3];
      const usagePercent = parseInt(parts[4].replace('%', ''));

      // Get more detailed disk info
      let diskDetails = {};
      try {
        const { stdout: dfBytes } = await this.execAsync('df -B1 / | tail -1');
        const bytesParts = dfBytes.trim().split(/\s+/);
        diskDetails = {
          totalBytes: parseInt(bytesParts[1]),
          usedBytes: parseInt(bytesParts[2]),
          availableBytes: parseInt(bytesParts[3]),
          totalGB: parseFloat((parseInt(bytesParts[1]) / (1024 ** 3)).toFixed(2)),
          usedGB: parseFloat((parseInt(bytesParts[2]) / (1024 ** 3)).toFixed(2)),
          availableGB: parseFloat((parseInt(bytesParts[3]) / (1024 ** 3)).toFixed(2))
        };
      } catch (err) {
        console.error('Error getting detailed disk info:', err);
      }

      return {
        total: totalSize,
        used: used,
        available: available,
        usagePercent: usagePercent,
        ...diskDetails
      };
    } catch (error) {
      console.error('Error getting disk usage:', error);
      return {
        total: 'Unknown',
        used: 'Unknown',
        available: 'Unknown',
        usagePercent: 0,
        error: error.message
      };
    }
  }

  /**
   * Get GPU utilization (for Jetson devices)
   */
  async getJetsonGpuLoadPaths() {
    const candidates = new Set(DEFAULT_GPU_LOAD_PATHS);

    try {
      const devfreqEntries = await this.readdir('/sys/class/devfreq');
      devfreqEntries
        .filter((entry) => /(ga10b|gv11b|gpu)/i.test(entry))
        .forEach((entry) => {
          candidates.add(path.join('/sys/class/devfreq', entry, 'device', 'load'));
          candidates.add(path.join('/sys/class/devfreq', entry, 'load'));
        });
    } catch (_error) {
      // Ignore missing devfreq directories on non-Jetson systems.
    }

    return Array.from(candidates);
  }

  async readGPUUsageFromSysfs() {
    const candidatePaths = await this.getJetsonGpuLoadPaths();

    for (const candidatePath of candidatePaths) {
      try {
        const rawValue = await this.readFile(candidatePath, 'utf8');
        const usagePercent = parseJetsonGpuLoad(rawValue);
        if (usagePercent === null) {
          continue;
        }

        return {
          usagePercent,
          type: inferJetsonGpuTypeFromPath(candidatePath),
          source: candidatePath
        };
      } catch (_error) {
        // Ignore missing or unreadable probe paths and continue probing.
      }
    }

    return null;
  }

  async readGPUUsageFromTegrastats() {
    try {
      const { stdout } = await this.execAsync(
        `sh -lc 'for bin in /usr/bin/tegrastats /bin/tegrastats "$(command -v tegrastats 2>/dev/null)"; do
          if [ -n "$bin" ] && [ -x "$bin" ]; then
            "$bin" --interval 500 2>&1 | head -n 1
            exit 0
          fi
        done'`,
        { timeout: 2000 }
      );

      const usagePercent = parseTegrastatsGpuPercent(stdout);
      if (usagePercent === null) {
        return null;
      }

      return {
        usagePercent,
        type: 'NVIDIA Jetson (tegrastats)',
        source: 'tegrastats'
      };
    } catch (_error) {
      return null;
    }
  }

  async getGPUUsage() {
    try {
      const sysfsGpu = await this.readGPUUsageFromSysfs();
      if (sysfsGpu) {
        return {
          available: true,
          detected: true,
          usagePercent: sysfsGpu.usagePercent,
          type: sysfsGpu.type,
          source: sysfsGpu.source
        };
      }

      const tegrastatsGpu = await this.readGPUUsageFromTegrastats();
      if (tegrastatsGpu) {
        return {
          available: true,
          detected: true,
          usagePercent: tegrastatsGpu.usagePercent,
          type: tegrastatsGpu.type,
          source: tegrastatsGpu.source
        };
      }

      const systemInfo = await this.getSystemInfo();
      if (systemInfo.isJetson) {
        return {
          available: false,
          detected: true,
          usagePercent: 0,
          type: systemInfo.jetsonModel || 'NVIDIA Jetson GPU',
          source: 'detected-only',
          message: 'GPU detected, but utilization telemetry is unavailable'
        };
      }

      return {
        available: false,
        detected: false,
        usagePercent: 0,
        type: 'N/A',
        message: 'GPU monitoring not available'
      };
    } catch (error) {
      console.error('Error getting GPU usage:', error);
      return {
        available: false,
        detected: false,
        usagePercent: 0,
        type: 'N/A',
        error: error.message
      };
    }
  }

  /**
   * Get system temperature (for Jetson devices)
   */
  async getTemperature() {
    try {
      // Try to read thermal zones
      const thermalZones = [];

      for (let i = 0; i < 10; i++) {
        try {
          const { stdout: type } = await this.execAsync(`cat /sys/class/thermal/thermal_zone${i}/type 2>/dev/null`);
          const { stdout: temp } = await this.execAsync(`cat /sys/class/thermal/thermal_zone${i}/temp 2>/dev/null`);

          thermalZones.push({
            name: type.trim(),
            temperature: parseFloat((parseInt(temp.trim()) / 1000).toFixed(1)),
            unit: '°C'
          });
        } catch (err) {
          // No more thermal zones
          break;
        }
      }

      if (thermalZones.length > 0) {
        // Get average and max temp
        const temps = thermalZones.map(z => z.temperature);
        const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
        const maxTemp = Math.max(...temps);

        return {
          available: true,
          zones: thermalZones,
          average: parseFloat(avgTemp.toFixed(1)),
          maximum: maxTemp,
          unit: '°C'
        };
      }

      return {
        available: false,
        message: 'Temperature sensors not available'
      };
    } catch (error) {
      console.error('Error getting temperature:', error);
      return {
        available: false,
        error: error.message
      };
    }
  }

  /**
   * Get system uptime
   */
  getUptime() {
    try {
      const uptimeSeconds = os.uptime();
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);

      return {
        seconds: uptimeSeconds,
        formatted: `${days}d ${hours}h ${minutes}m`,
        days,
        hours,
        minutes
      };
    } catch (error) {
      console.error('Error getting uptime:', error);
      return {
        seconds: 0,
        formatted: 'Unknown',
        error: error.message
      };
    }
  }

  /**
   * Get system information
   */
  async getSystemInfo() {
    try {
      const platform = os.platform();
      const arch = os.arch();
      const hostname = os.hostname();
      const release = os.release();

      // Try to get more detailed info
      let detailedInfo = {};

      if (platform === 'linux') {
        try {
          // Get OS info
          const { stdout: osInfo } = await this.execAsync('cat /etc/os-release 2>/dev/null || echo ""');
          const osLines = osInfo.split('\n');
          const osName = osLines.find(l => l.startsWith('PRETTY_NAME='))?.split('=')[1]?.replace(/"/g, '') || 'Linux';

          // Check if Jetson
          let isJetson = false;
          let jetsonModel = null;
          let jetsonRelease = null;

          try {
            const model = (await this.readFile('/proc/device-tree/model', 'utf8')).replace(/\0/g, '').trim();
            if (model) {
              jetsonModel = model;
            }
          } catch (_error) {
            // Model file is not available on this platform.
          }

          try {
            const release = (await this.readFile('/etc/nv_tegra_release', 'utf8')).trim();
            if (release) {
              jetsonRelease = release;
            }
          } catch (_error) {
            // Release file is not available on this platform.
          }

          if (jetsonModel?.toLowerCase().includes('jetson') || jetsonModel || jetsonRelease) {
            isJetson = true;
          }

          detailedInfo = {
            osName,
            isJetson,
            jetsonModel,
            jetsonRelease
          };
        } catch (err) {
          console.error('Error getting detailed system info:', err);
        }
      }

      return {
        platform,
        arch,
        hostname,
        release,
        type: os.type(),
        ...detailedInfo
      };
    } catch (error) {
      console.error('Error getting system info:', error);
      return {
        platform: 'Unknown',
        arch: 'Unknown',
        hostname: 'Unknown',
        error: error.message
      };
    }
  }

  /**
   * Get comprehensive system utilization
   */
  async getUtilization() {
    try {
      console.log('Collecting system resource utilization...');

      const cpu = await this.getCPUUsage();
      const memory = this.getMemoryUsage();
      const disk = await this.getDiskUsage();
      const gpu = await this.getGPUUsage();
      const temperature = await this.getTemperature();
      const uptime = this.getUptime();
      const systemInfo = await this.getSystemInfo();

      const snapshot = {
        timestamp: new Date(),
        cpu,
        memory,
        disk,
        gpu,
        temperature,
        uptime,
        systemInfo
      };

      // Add to history
      this.addToHistory(snapshot);

      return snapshot;
    } catch (error) {
      console.error('Error getting system utilization:', error);
      throw error;
    }
  }

  /**
   * Add snapshot to history
   */
  addToHistory(snapshot) {
    this.history.push(snapshot);

    // Keep only last N entries
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get historical data
   */
  getHistory(limit = 100) {
    const requestedLimit = Math.min(limit, this.history.length);
    return this.history.slice(-requestedLimit);
  }

  /**
   * Clear history
   */
  clearHistory() {
    this.history = [];
    return { success: true, message: 'History cleared' };
  }

  /**
   * Get process information
   */
  async getProcessInfo() {
    try {
      const processMemory = process.memoryUsage();

      return {
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: processMemory.rss,
          heapTotal: processMemory.heapTotal,
          heapUsed: processMemory.heapUsed,
          external: processMemory.external,
          rssGB: parseFloat((processMemory.rss / (1024 ** 3)).toFixed(3)),
          heapUsedGB: parseFloat((processMemory.heapUsed / (1024 ** 3)).toFixed(3))
        },
        cpuUsage: process.cpuUsage()
      };
    } catch (error) {
      console.error('Error getting process info:', error);
      throw error;
    }
  }
}

const resourceMonitorService = new ResourceMonitorService();

module.exports = resourceMonitorService;
module.exports.ResourceMonitorService = ResourceMonitorService;
module.exports.parseJetsonGpuLoad = parseJetsonGpuLoad;
module.exports.parseTegrastatsGpuPercent = parseTegrastatsGpuPercent;
