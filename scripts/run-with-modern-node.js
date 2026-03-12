#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function parseVersion(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`
  };
}

function compareVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isProjectSupported(version) {
  // Matches strictest project dependencies:
  // - Vite/@vitejs/plugin-react: ^20.19.0 || >=22.12.0
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 22) return version.minor >= 12;
  return version.major >= 23;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveReal(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function getNodeVersion(nodeBin) {
  const result = spawnSync(nodeBin, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.status !== 0) return null;
  return parseVersion((result.stdout || '').trim());
}

function getCandidates() {
  const candidates = new Set();
  const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node';
  const addCandidate = (candidatePath) => {
    if (!candidatePath) return;
    if (!isExecutable(candidatePath)) return;
    candidates.add(resolveReal(candidatePath));
  };

  addCandidate(process.execPath);

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    addCandidate(path.join(entry, nodeExecutable));
  }

  if (process.platform !== 'win32') {
    addCandidate('/usr/bin/node');
    addCandidate('/usr/local/bin/node');
  }

  return [...candidates];
}

function selectNodeBinary() {
  const candidates = getCandidates();
  const inspected = [];
  let bestSupported = null;
  let bestPreferredSupported = null;
  let bestAny = null;
  const preferredMajor = Number(process.env.HOMEBRAIN_PREFERRED_NODE_MAJOR || 22);

  for (const bin of candidates) {
    const version = getNodeVersion(bin);
    if (!version) {
      inspected.push({ bin, version: null, supported: false });
      continue;
    }

    const supported = isProjectSupported(version);
    inspected.push({ bin, version, supported });

    if (!bestAny || compareVersion(version, bestAny.version) > 0) {
      bestAny = { bin, version };
    }

    if (supported && (!bestSupported || compareVersion(version, bestSupported.version) > 0)) {
      bestSupported = { bin, version };
    }

    if (
      supported
      && Number.isFinite(preferredMajor)
      && version.major === preferredMajor
      && (!bestPreferredSupported || compareVersion(version, bestPreferredSupported.version) > 0)
    ) {
      bestPreferredSupported = { bin, version };
    }
  }

  return {
    selected: bestPreferredSupported || bestSupported || null,
    inspected,
    bestAny,
    preferredMajor
  };
}

function formatInspected(inspected) {
  if (!inspected.length) return '  (no Node binaries found)';
  return inspected
    .map((item) => {
      const version = item.version ? item.version.raw : 'unknown';
      const tag = item.supported ? 'supported' : 'unsupported';
      return `  - ${item.bin} (${version}, ${tag})`;
    })
    .join('\n');
}

function resolveCommand(command, selectedBin) {
  const dir = path.dirname(selectedBin);
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  if (command === 'node') {
    return selectedBin;
  }

  if (command === 'npm') {
    const npmInSameDir = path.join(dir, npmName);
    if (isExecutable(npmInSameDir)) {
      return npmInSameDir;
    }
  }

  return command;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/run-with-modern-node.js <command> [args...]');
    process.exit(1);
  }

  const { selected, inspected, bestAny, preferredMajor } = selectNodeBinary();
  if (!selected) {
    const latest = bestAny ? `${bestAny.version.raw} at ${bestAny.bin}` : 'none';
    console.error('HomeBrain requires Node ^20.19.0 or >=22.12.0.');
    if (Number.isFinite(preferredMajor)) {
      console.error(`Preferred major version: ${preferredMajor}.`);
    }
    console.error(`Best detected Node: ${latest}`);
    console.error('Detected binaries:');
    console.error(formatInspected(inspected));
    process.exit(1);
  }

  const command = resolveCommand(args[0], selected.bin);
  const commandArgs = args.slice(1);
  const nodeDir = path.dirname(selected.bin);
  const env = {
    ...process.env,
    PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}`
  };

  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env
  });

  child.on('error', (error) => {
    console.error(`Failed to start command "${args.join(' ')}": ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });
}

main();
