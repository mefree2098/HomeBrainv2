#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || 'inherit',
    encoding: 'utf8'
  });
  return result.status === 0;
}

function commandExists(command) {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

console.log('HomeBrain remote audio diagnostic');
console.log('');

const required = ['arecord', 'aplay'];
const missing = required.filter((command) => !commandExists(command));
if (missing.length) {
  console.error(`Missing required audio utilities: ${missing.join(', ')}`);
  console.error('Install ALSA utilities first: sudo apt-get install -y alsa-utils');
  process.exit(1);
}

console.log('Capture devices:');
run('arecord', ['-l']);
console.log('');
console.log('Playback devices:');
run('aplay', ['-l']);
console.log('');

const samplePath = path.join(os.tmpdir(), `homebrain-audio-test-${Date.now()}.wav`);
console.log('Recording a 3 second microphone sample...');
const recorded = run('arecord', ['-q', '-d', '3', '-f', 'cd', samplePath]);

if (!recorded || !fs.existsSync(samplePath)) {
  console.error('Microphone sample failed. Check the selected ALSA capture device.');
  process.exit(1);
}

console.log('Playing the sample back...');
const played = run('aplay', ['-q', samplePath]);
try {
  fs.unlinkSync(samplePath);
} catch (_) {}

if (!played) {
  console.error('Playback failed. Check the selected ALSA playback device.');
  process.exit(1);
}

console.log('Audio diagnostic completed successfully.');
