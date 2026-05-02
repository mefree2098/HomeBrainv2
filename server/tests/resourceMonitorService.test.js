const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const {
  ResourceMonitorService,
  buildMemoryUsageFromMemInfo,
  parseLinuxMemInfo,
  parseJetsonGpuLoad,
  parseProcessList,
  parseTegrastatsGpuPercent
} = require('../services/resourceMonitorService');

function createMissingFileError() {
  const error = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
}

test('parseJetsonGpuLoad normalizes Jetson sysfs load values', () => {
  assert.equal(parseJetsonGpuLoad('523\n'), 52.3);
  assert.equal(parseJetsonGpuLoad('82\n'), 82);
  assert.equal(parseJetsonGpuLoad('not-a-number'), null);
});

test('parseTegrastatsGpuPercent extracts GR3D load percentages', () => {
  assert.equal(parseTegrastatsGpuPercent('RAM 220/4096MB GR3D_FREQ 76%@1109 APE 25'), 76);
  assert.equal(parseTegrastatsGpuPercent('RAM 220/4096MB CPU [1%@729]'), null);
});

test('buildMemoryUsageFromMemInfo uses MemAvailable instead of raw free memory on Linux', () => {
  const memInfo = [
    'MemTotal:        8000000 kB',
    'MemFree:          500000 kB',
    'MemAvailable:    2500000 kB',
    'Buffers:          100000 kB',
    'Cached:          1200000 kB',
    'SReclaimable:     200000 kB',
    'SwapTotal:       1000000 kB',
    'SwapFree:         750000 kB'
  ].join('\n');

  const parsed = parseLinuxMemInfo(memInfo);
  assert.equal(parsed.MemTotal, 8_000_000 * 1024);
  assert.equal(parsed.MemAvailable, 2_500_000 * 1024);

  const memory = buildMemoryUsageFromMemInfo(memInfo);
  assert.equal(memory.source, 'proc-meminfo');
  assert.equal(memory.total, 8_000_000 * 1024);
  assert.equal(memory.free, 2_500_000 * 1024);
  assert.equal(memory.systemFree, 500_000 * 1024);
  assert.equal(memory.used, 5_500_000 * 1024);
  assert.equal(memory.usagePercent, 68.75);
  assert.equal(memory.swapUsed, 250_000 * 1024);
});

test('getMemoryUsage reads Linux MemAvailable when procfs is present', () => {
  const service = new ResourceMonitorService({
    platform: () => 'linux',
    readFileSync: (filePath) => {
      assert.equal(filePath, '/proc/meminfo');
      return 'MemTotal: 4096000 kB\nMemFree: 128000 kB\nMemAvailable: 1024000 kB\n';
    }
  });

  const memory = service.getMemoryUsage();

  assert.equal(memory.source, 'proc-meminfo');
  assert.equal(memory.freeGB, 0.98);
  assert.equal(memory.usagePercent, 75);
});

test('parseProcessList returns the highest-memory process rows', () => {
  const rows = parseProcessList([
    'PID PPID RSS VSZ %CPU %MEM COMMAND',
    '101 1 524288 1048576 12.5 6.4 /usr/bin/node server.js',
    '202 1 262144 2097152 2.1 3.2 /usr/bin/mongod --config /etc/mongod.conf'
  ].join('\n'), 1);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 101);
  assert.equal(rows[0].command, 'node');
  assert.equal(rows[0].executable, '/usr/bin/node');
  assert.equal(rows[0].commandLine, '/usr/bin/node server.js');
  assert.equal(rows[0].rssBytes, 524288 * 1024);
  assert.equal(rows[0].cpuPercent, 12.5);
  assert.equal(rows[0].memoryPercent, 6.4);
});

test('parseProcessList keeps spaced command lines from shifting numeric columns', () => {
  const rows = parseProcessList([
    'PID PPID RSS VSZ %CPU %MEM COMMAND',
    '303 1 131072 524288 4.9 1.6 PM2 v6.0.14: God Daemon (/home/matt/.pm2)'
  ].join('\n'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 303);
  assert.equal(rows[0].command, 'PM2');
  assert.equal(rows[0].commandLine, 'PM2 v6.0.14: God Daemon (/home/matt/.pm2)');
  assert.equal(rows[0].cpuPercent, 4.9);
  assert.equal(rows[0].memoryPercent, 1.6);
});

test('getGPUUsage reads Orin GPU load from modern sysfs paths', async () => {
  const orinPath = '/sys/devices/platform/17000000.ga10b/load';
  const service = new ResourceMonitorService({
    readFile: async (filePath) => {
      if (filePath === orinPath) {
        return '523\n';
      }

      throw createMissingFileError();
    },
    readdir: async () => [],
    execAsync: async () => {
      throw new Error('tegrastats should not run when sysfs already worked');
    }
  });

  const gpu = await service.getGPUUsage();

  assert.equal(gpu.available, true);
  assert.equal(gpu.detected, true);
  assert.equal(gpu.usagePercent, 52.3);
  assert.equal(gpu.type, 'NVIDIA Jetson Orin GPU');
  assert.equal(gpu.source, orinPath);
});

test('getGPUUsage falls back to tegrastats when sysfs probes are unavailable', async () => {
  const service = new ResourceMonitorService({
    readFile: async () => {
      throw createMissingFileError();
    },
    readdir: async () => [],
    execAsync: async () => ({
      stdout: 'RAM 220/4096MB CPU [1%@729] GR3D_FREQ 76%@1109 EMC_FREQ 12%@2133'
    })
  });

  const gpu = await service.getGPUUsage();

  assert.equal(gpu.available, true);
  assert.equal(gpu.detected, true);
  assert.equal(gpu.usagePercent, 76);
  assert.equal(gpu.type, 'NVIDIA Jetson (tegrastats)');
  assert.equal(gpu.source, 'tegrastats');
});

test('getGPUUsage still reports GPU presence on Jetson when telemetry is unavailable', async () => {
  const service = new ResourceMonitorService({
    readFile: async () => {
      throw createMissingFileError();
    },
    readdir: async () => [],
    execAsync: async () => ({ stdout: '' })
  });

  service.getSystemInfo = async () => ({
    isJetson: true,
    jetsonModel: 'NVIDIA Jetson Orin Nano Developer Kit'
  });

  const gpu = await service.getGPUUsage();

  assert.equal(gpu.available, false);
  assert.equal(gpu.detected, true);
  assert.equal(gpu.usagePercent, 0);
  assert.equal(gpu.type, 'NVIDIA Jetson Orin Nano Developer Kit');
  assert.equal(gpu.source, 'detected-only');
  assert.equal(gpu.message, 'GPU detected, but utilization telemetry is unavailable');
});

test('getSystemInfo derives Jetson model from the device tree', async (t) => {
  const originalPlatform = os.platform;
  const originalArch = os.arch;
  const originalHostname = os.hostname;
  const originalRelease = os.release;

  os.platform = () => 'linux';
  os.arch = () => 'arm64';
  os.hostname = () => 'homebrain-jetson';
  os.release = () => '6.8.0';

  t.after(() => {
    os.platform = originalPlatform;
    os.arch = originalArch;
    os.hostname = originalHostname;
    os.release = originalRelease;
  });

  const service = new ResourceMonitorService({
    readFile: async (filePath) => {
      if (filePath === '/proc/device-tree/model') {
        return 'NVIDIA Jetson Orin Nano Developer Kit\0';
      }

      if (filePath === '/etc/nv_tegra_release') {
        return '# R36 (release), REVISION: 4.3';
      }

      throw createMissingFileError();
    },
    readdir: async () => [],
    execAsync: async () => ({
      stdout: 'PRETTY_NAME="Ubuntu 22.04.4 LTS"\n'
    })
  });

  const systemInfo = await service.getSystemInfo();

  assert.equal(systemInfo.platform, 'linux');
  assert.equal(systemInfo.arch, 'arm64');
  assert.equal(systemInfo.hostname, 'homebrain-jetson');
  assert.equal(systemInfo.isJetson, true);
  assert.equal(systemInfo.jetsonModel, 'NVIDIA Jetson Orin Nano Developer Kit');
  assert.equal(systemInfo.jetsonRelease, '# R36 (release), REVISION: 4.3');
  assert.equal(systemInfo.osName, 'Ubuntu 22.04.4 LTS');
});

test('getDiskUsage targets the platform storage path instead of the root filesystem', async () => {
  const commands = [];
  const service = new ResourceMonitorService({
    stat: async (filePath) => {
      if (filePath === '/mnt/nvme/homebrain') {
        return {};
      }

      const error = createMissingFileError();
      throw error;
    },
    execAsync: async (command) => {
      commands.push(command);
      return {
        stdout: '/dev/nvme0n1p1 976762584 262144000 714618584 27% /mnt/nvme\n'
      };
    }
  });

  const disk = await service.getDiskUsage({ targetPath: '/mnt/nvme/homebrain/server/runtime' });

  assert.equal(commands.length, 1);
  assert.equal(commands[0], "df -kP '/mnt/nvme/homebrain' | tail -1");
  assert.equal(disk.filesystem, '/dev/nvme0n1p1');
  assert.equal(disk.mountedOn, '/mnt/nvme');
  assert.equal(disk.targetPath, '/mnt/nvme/homebrain');
  assert.equal(disk.usagePercent, 27);
  assert.equal(disk.total, '932Gi');
  assert.equal(disk.available, '682Gi');
  assert.equal(disk.totalGB, 931.51);
  assert.equal(disk.availableGB, 681.51);
});
