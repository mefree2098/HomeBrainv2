#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALLOWED_COMMANDS = new Set(['aplay', 'arecord', 'sudo']);

function normalizeInvocation(command, args = []) {
  if (!ALLOWED_COMMANDS.has(command) || !Array.isArray(args) || args.length > 16) {
    throw new Error('Unsupported audio setup command');
  }
  return {
    command,
    args: args.map((arg) => {
      if (typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) {
        throw new Error('Invalid audio setup argument');
      }
      return arg;
    })
  };
}

function run(command, args = [], options = {}) {
  const invocation = normalizeInvocation(command, args);
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- command is allowlisted, argv is bounded, and shell execution is disabled.
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: options.stdio || 'inherit',
    encoding: 'utf8',
    shell: false,
    timeout: 60_000
  });
  return result.status === 0;
}

function listCards(command) {
  const invocation = normalizeInvocation(command, ['-l']);
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- command is allowlisted, argv is fixed, and shell execution is disabled.
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000
  });
  if (result.status !== 0) {
    return [];
  }

  const cards = new Set();
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^card\s+(\d+):/);
    if (match) {
      cards.add(match[1]);
    }
  }
  return Array.from(cards);
}

console.log('HomeBrain remote audio setup');

if (process.platform !== 'linux') {
  console.error('Audio setup is only supported on Linux.');
  process.exit(1);
}

if (process.getuid && process.getuid() === 0) {
  console.error('Run this script as the listener user, not root.');
  process.exit(1);
}

const captureCards = listCards('arecord');
const playbackCards = listCards('aplay');
const sharedCard = captureCards.find((card) => playbackCards.includes(card));
const captureCard = sharedCard || captureCards[0] || '0';
const playbackCard = sharedCard || playbackCards[0] || '0';

const asoundConf = `# HomeBrain Remote Device Audio Configuration
pcm.!default {
    type asym
    playback.pcm "plughw:${playbackCard},0"
    capture.pcm "plughw:${captureCard},0"
}

ctl.!default {
    type hw
    card ${playbackCard}
}
`;

console.log(`Selected playback card ${playbackCard}, capture card ${captureCard}.`);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-audio-'));
const tmpPath = path.join(tmpDir, 'asound.conf');
fs.writeFileSync(tmpPath, asoundConf, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

const installed = run('sudo', ['cp', tmpPath, '/etc/asound.conf']);
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {}

if (!installed) {
  console.error('Failed to install /etc/asound.conf.');
  process.exit(1);
}

const currentUser = process.env.SUDO_USER || process.env.USER;
if (currentUser && /^[a-z_][a-z0-9_-]{0,31}$/i.test(currentUser)) {
  run('sudo', ['usermod', '-a', '-G', 'audio', currentUser]);
} else {
  console.warn('Could not determine the current user; skipped audio group update.');
}
console.log('Audio setup completed. Log out and back in, or reboot, for audio group changes to apply.');
