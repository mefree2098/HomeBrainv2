const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class ResourceMonitorService {
  constructor() {
    this.history = [];
    this.maxHistorySize = 100; // Keep last 100 readings
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
      const { stdout } = await execAsync('df -h / | tail -1');
      const parts = stdout.trim().split(/\s+/);

      // Parse df output: Filesystem Size Used Avail Use% Mounted
      const totalSize = parts[1];
      const used = parts[2];
      const available = parts[3];
      const usagePercent = parseInt(parts[4].replace('%', ''));

      // Get more detailed disk info
      let diskDetails = {};
      try {
        const { stdout: dfBytes } = await execAsync('df -B1 / | tail -1');
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
  async getGPUUsage() {
    try {
      // Try to get Jetson GPU stats
      try {
        const { stdout } = await execAsync('cat /sys/devices/gpu.0/load');
        const gpuLoad = parseInt(stdout.trim()) / 10; // Convert to percentage

        return {
          available: true,
          usagePercent: parseFloat(gpuLoad.toFixed(2)),
          type: 'NVIDIA Jetson'
        };
      } catch (err) {
        // Try tegrastats for Jetson
        try {
          const { stdout } = await execAsync('tegrastats --interval 500 | head -1', { timeout: 1000 });
          // Parse tegrastats output - this is a simplified parser
          const gpuMatch = stdout.match(/GR3D_FREQ\s+(\d+)%/);
          if (gpuMatch) {
            return {
              available: true,
              usagePercent: parseFloat(gpuMatch[1]),
              type: 'NVIDIA Jetson (Tegra)'
            };
          }
        } catch (tegraErr) {
          // GPU stats not available
        }
      }

      return {
        available: false,
        usagePercent: 0,
        type: 'N/A',
        message: 'GPU monitoring not available'
      };
    } catch (error) {
      console.error('Error getting GPU usage:', error);
      return {
        available: false,
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
          const { stdout: type } = await execAsync(`cat /sys/class/thermal/thermal_zone${i}/type 2>/dev/null`);
          const { stdout: temp } = await execAsync(`cat /sys/class/thermal/thermal_zone${i}/temp 2>/dev/null`);

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
          const { stdout: osInfo } = await execAsync('cat /etc/os-release 2>/dev/null || echo ""');
          const osLines = osInfo.split('\n');
          const osName = osLines.find(l => l.startsWith('PRETTY_NAME='))?.split('=')[1]?.replace(/"/g, '') || 'Linux';

          // Check if Jetson
          let isJetson = false;
          let jetsonModel = null;
          try {
            const { stdout } = await execAsync('cat /etc/nv_tegra_release 2>/dev/null || cat /proc/device-tree/model 2>/dev/null || echo ""');
            if (stdout.toLowerCase().includes('jetson')) {
              isJetson = true;
              jetsonModel = stdout.trim();
            }
          } catch (err) {
            // Not a Jetson
          }

          detailedInfo = {
            osName,
            isJetson,
            jetsonModel
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

module.exports = new ResourceMonitorService();
