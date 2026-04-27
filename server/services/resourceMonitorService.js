const fs = require('node:fs/promises');
const fsSync = require('node:fs');
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
const DISK_USAGE_PATH_ENV_KEYS = [
  'HOMEBRAIN_DISK_USAGE_PATH',
  'HOMEBRAIN_STORAGE_PATH',
  'AXIOM_DISK_USAGE_PATH',
  'AXIOM_STORAGE_PATH'
];
const DEFAULT_PLATFORM_DISK_PATH = path.resolve(__dirname, '..', '..');
const PROC_MEMINFO_PATH = '/proc/meminfo';

function clampPercent(value) {
  return parseFloat(Math.max(0, Math.min(100, value)).toFixed(2));
}

function quoteShellPath(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function formatDiskLabel(bytes) {
  const numeric = Number(bytes);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 'Unknown';
  }

  if (numeric < 1024) {
    return `${Math.round(numeric)}B`;
  }

  const units = ['Ki', 'Mi', 'Gi', 'Ti', 'Pi'];
  let value = numeric / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 ? 0 : 1;
  return `${Number(value.toFixed(digits))}${units[unitIndex]}`;
}

function roundGB(bytes) {
  return parseFloat((bytes / (1024 ** 3)).toFixed(2));
}

function parseLinuxMemInfo(rawValue) {
  const entries = {};
  String(rawValue || '').split('\n').forEach((line) => {
    const match = line.match(/^([^:]+):\s+(\d+)\s*kB/i);
    if (!match) {
      return;
    }

    entries[match[1]] = Number.parseInt(match[2], 10) * 1024;
  });
  return entries;
}

function buildMemoryUsageSnapshot({
  total,
  available,
  systemFree = available,
  buffers = 0,
  cached = 0,
  sReclaimable = 0,
  swapTotal = 0,
  swapFree = 0,
  source = 'os'
}) {
  const totalMem = Math.max(0, Number(total) || 0);
  const availableMem = Math.max(0, Math.min(totalMem, Number(available) || 0));
  const usedMem = Math.max(0, totalMem - availableMem);
  const usagePercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
  const safeSwapTotal = Math.max(0, Number(swapTotal) || 0);
  const safeSwapFree = Math.max(0, Math.min(safeSwapTotal, Number(swapFree) || 0));
  const swapUsed = Math.max(0, safeSwapTotal - safeSwapFree);

  return {
    total: totalMem,
    used: usedMem,
    free: availableMem,
    available: availableMem,
    systemFree: Math.max(0, Number(systemFree) || 0),
    buffers: Math.max(0, Number(buffers) || 0),
    cached: Math.max(0, Number(cached) || 0),
    sReclaimable: Math.max(0, Number(sReclaimable) || 0),
    swapTotal: safeSwapTotal,
    swapFree: safeSwapFree,
    swapUsed,
    usagePercent: parseFloat(usagePercent.toFixed(2)),
    swapUsagePercent: safeSwapTotal > 0 ? parseFloat(((swapUsed / safeSwapTotal) * 100).toFixed(2)) : 0,
    totalGB: roundGB(totalMem),
    usedGB: roundGB(usedMem),
    freeGB: roundGB(availableMem),
    availableGB: roundGB(availableMem),
    systemFreeGB: roundGB(Math.max(0, Number(systemFree) || 0)),
    source
  };
}

function buildMemoryUsageFromMemInfo(rawValue) {
  const memInfo = parseLinuxMemInfo(rawValue);
  const total = memInfo.MemTotal;

  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  return buildMemoryUsageSnapshot({
    total,
    available: memInfo.MemAvailable ?? memInfo.MemFree ?? 0,
    systemFree: memInfo.MemFree ?? 0,
    buffers: memInfo.Buffers ?? 0,
    cached: memInfo.Cached ?? 0,
    sReclaimable: memInfo.SReclaimable ?? 0,
    swapTotal: memInfo.SwapTotal ?? 0,
    swapFree: memInfo.SwapFree ?? 0,
    source: 'proc-meminfo'
  });
}

function parseProcessList(rawValue, limit = 10) {
  const maxRows = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));

  return String(rawValue || '')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 7)
    .map((parts) => {
      const [pid, ppid, command, rss, vsz, cpuPercent, memoryPercent] = parts;
      const rssKB = Number.parseInt(rss, 10) || 0;
      const vszKB = Number.parseInt(vsz, 10) || 0;

      return {
        pid: Number.parseInt(pid, 10) || 0,
        ppid: Number.parseInt(ppid, 10) || 0,
        command,
        rssKB,
        rssBytes: rssKB * 1024,
        rssGB: parseFloat(((rssKB * 1024) / (1024 ** 3)).toFixed(3)),
        vszKB,
        vszBytes: vszKB * 1024,
        cpuPercent: Number.parseFloat(cpuPercent) || 0,
        memoryPercent: Number.parseFloat(memoryPercent) || 0
      };
    })
    .filter((entry) => entry.pid > 0)
    .slice(0, maxRows);
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
    this.readFileSync = dependencies.readFileSync || fsSync.readFileSync.bind(fsSync);
    this.readdir = dependencies.readdir || fs.readdir.bind(fs);
    this.stat = dependencies.stat || fs.stat.bind(fs);
    this.platform = dependencies.platform || os.platform.bind(os);
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
      if (this.platform() === 'linux') {
        try {
          const memInfoUsage = buildMemoryUsageFromMemInfo(this.readFileSync(PROC_MEMINFO_PATH, 'utf8'));
          if (memInfoUsage) {
            return memInfoUsage;
          }
        } catch (_error) {
          // Fall back to Node's portable memory counters when /proc is unavailable.
        }
      }

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      return buildMemoryUsageSnapshot({
        total: totalMem,
        available: freeMem,
        source: 'os'
      });
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
  async resolveExistingDiskPath(candidatePath) {
    const trimmed = String(candidatePath || '').trim();
    if (!trimmed) {
      return null;
    }

    let currentPath = path.resolve(trimmed);

    // Walk up to the nearest existing parent so deployment paths can be configured
    // before the final subdirectory exists.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.stat(currentPath);
        return currentPath;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
          throw error;
        }
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return null;
      }
      currentPath = parentPath;
    }
  }

  async resolveDiskUsageTargetPath(preferredPath = null) {
    const candidatePaths = [
      preferredPath,
      ...DISK_USAGE_PATH_ENV_KEYS.map((key) => process.env[key]),
      DEFAULT_PLATFORM_DISK_PATH,
      process.cwd(),
      os.homedir(),
      '/'
    ];

    const visited = new Set();

    for (const candidatePath of candidatePaths) {
      const normalized = String(candidatePath || '').trim();
      if (!normalized || visited.has(normalized)) {
        continue;
      }
      visited.add(normalized);

      // eslint-disable-next-line no-await-in-loop
      const existingPath = await this.resolveExistingDiskPath(normalized);
      if (existingPath) {
        return existingPath;
      }
    }

    return '/';
  }

  async getDiskUsage(options = {}) {
    try {
      const preferredPath = typeof options === 'string'
        ? options
        : (options?.targetPath || options?.path || null);
      const targetPath = await this.resolveDiskUsageTargetPath(preferredPath);
      const { stdout } = await this.execAsync(`df -kP ${quoteShellPath(targetPath)} | tail -1`);
      const parts = stdout.trim().split(/\s+/);

      const filesystem = parts[0] || 'Unknown';
      const totalBytes = (Number.parseInt(parts[1], 10) || 0) * 1024;
      const usedBytes = (Number.parseInt(parts[2], 10) || 0) * 1024;
      const availableBytes = (Number.parseInt(parts[3], 10) || 0) * 1024;
      const usagePercent = Number.parseInt(String(parts[4] || '0').replace('%', ''), 10) || 0;
      const mountedOn = parts.slice(5).join(' ') || '';

      return {
        total: formatDiskLabel(totalBytes),
        used: formatDiskLabel(usedBytes),
        available: formatDiskLabel(availableBytes),
        usagePercent,
        totalBytes,
        usedBytes,
        availableBytes,
        totalGB: parseFloat((totalBytes / (1024 ** 3)).toFixed(2)),
        usedGB: parseFloat((usedBytes / (1024 ** 3)).toFixed(2)),
        availableGB: parseFloat((availableBytes / (1024 ** 3)).toFixed(2)),
        filesystem,
        mountedOn,
        targetPath
      };
    } catch (error) {
      console.error('Error getting disk usage:', error);
      return {
        total: 'Unknown',
        used: 'Unknown',
        available: 'Unknown',
        usagePercent: 0,
        filesystem: 'Unknown',
        mountedOn: '',
        targetPath: '',
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
      const thermalZones = [];

      for (let i = 0; i < 10; i++) {
        try {
          const zonePath = `/sys/class/thermal/thermal_zone${i}`;
          const [type, temp] = await Promise.all([
            this.readFile(path.join(zonePath, 'type'), 'utf8'),
            this.readFile(path.join(zonePath, 'temp'), 'utf8')
          ]);
          const parsedTemperature = Number.parseInt(String(temp).trim(), 10) / 1000;

          if (!Number.isFinite(parsedTemperature)) {
            continue;
          }

          thermalZones.push({
            name: String(type).trim(),
            temperature: parseFloat(parsedTemperature.toFixed(1)),
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
      const heapUsagePercent = processMemory.heapTotal > 0
        ? parseFloat(((processMemory.heapUsed / processMemory.heapTotal) * 100).toFixed(2))
        : 0;

      return {
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: processMemory.rss,
          heapTotal: processMemory.heapTotal,
          heapUsed: processMemory.heapUsed,
          external: processMemory.external,
          arrayBuffers: processMemory.arrayBuffers || 0,
          rssGB: parseFloat((processMemory.rss / (1024 ** 3)).toFixed(3)),
          heapTotalGB: parseFloat((processMemory.heapTotal / (1024 ** 3)).toFixed(3)),
          heapUsedGB: parseFloat((processMemory.heapUsed / (1024 ** 3)).toFixed(3)),
          externalGB: parseFloat((processMemory.external / (1024 ** 3)).toFixed(3)),
          heapUsagePercent
        },
        cpuUsage: process.cpuUsage()
      };
    } catch (error) {
      console.error('Error getting process info:', error);
      throw error;
    }
  }

  async getProcessBreakdown(options = {}) {
    const limit = Math.max(1, Math.min(50, Number.parseInt(options?.limit, 10) || 10));
    const command = this.platform() === 'linux'
      ? 'ps -eo pid,ppid,comm,rss,vsz,pcpu,pmem --sort=-rss'
      : 'ps -axo pid,ppid,comm,rss,vsz,%cpu,%mem -r';

    try {
      const { stdout } = await this.execAsync(command, {
        timeout: 2000,
        maxBuffer: 128 * 1024
      });

      return {
        processes: parseProcessList(stdout, limit),
        limit
      };
    } catch (error) {
      console.error('Error getting process breakdown:', error);
      return {
        processes: [],
        limit,
        error: error.message
      };
    }
  }
}

const resourceMonitorService = new ResourceMonitorService();

module.exports = resourceMonitorService;
module.exports.ResourceMonitorService = ResourceMonitorService;
module.exports.parseJetsonGpuLoad = parseJetsonGpuLoad;
module.exports.parseTegrastatsGpuPercent = parseTegrastatsGpuPercent;
module.exports.parseLinuxMemInfo = parseLinuxMemInfo;
module.exports.buildMemoryUsageFromMemInfo = buildMemoryUsageFromMemInfo;
module.exports.parseProcessList = parseProcessList;
