const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const {
  ResourceMonitorService,
  parseJetsonGpuLoad,
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
