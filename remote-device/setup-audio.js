#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || 'inherit',
    encoding: 'utf8'
  });
  return result.status === 0;
}

function listCards(command) {
  const result = spawnSync(command, ['-l'], { encoding: 'utf8' });
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
const tmpPath = `/tmp/homebrain-asound-${Date.now()}.conf`;
fs.writeFileSync(tmpPath, asoundConf);

const installed = run('sudo', ['cp', tmpPath, '/etc/asound.conf']);
try {
  fs.unlinkSync(tmpPath);
} catch (_) {}

if (!installed) {
  console.error('Failed to install /etc/asound.conf.');
  process.exit(1);
}

const currentUser = process.env.SUDO_USER || process.env.USER;
if (currentUser) {
  run('sudo', ['usermod', '-a', '-G', 'audio', currentUser]);
} else {
  console.warn('Could not determine the current user; skipped audio group update.');
}
console.log('Audio setup completed. Log out and back in, or reboot, for audio group changes to apply.');
