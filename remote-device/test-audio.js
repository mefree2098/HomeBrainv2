#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ALLOWED_COMMANDS = new Set(['arecord', 'aplay']);

function normalizeInvocation(command, args = []) {
  if (!ALLOWED_COMMANDS.has(command) || !Array.isArray(args) || args.length > 16) {
    throw new Error('Unsupported audio diagnostic command');
  }
  return {
    command,
    args: args.map((arg) => {
      if (typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) {
        throw new Error('Invalid audio diagnostic argument');
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
    timeout: 30_000
  });
  return result.status === 0;
}

function commandExists(command) {
  if (!ALLOWED_COMMANDS.has(command)) return false;
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .some((directory) => {
      const candidate = path.join(directory, command);
      try {
        return fs.statSync(candidate).isFile() && (fs.accessSync(candidate, fs.constants.X_OK) === undefined);
      } catch (_error) {
        return false;
      }
    });
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

const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-audio-test-'));
const samplePath = path.join(sampleDir, 'sample.wav');
console.log('Recording a 3 second microphone sample...');
const recorded = run('arecord', ['-q', '-d', '3', '-f', 'cd', samplePath]);

if (!recorded || !fs.existsSync(samplePath)) {
  try {
    fs.rmSync(sampleDir, { recursive: true, force: true });
  } catch (_) {}
  console.error('Microphone sample failed. Check the selected ALSA capture device.');
  process.exit(1);
}

console.log('Playing the sample back...');
const played = run('aplay', ['-q', samplePath]);
try {
  fs.rmSync(sampleDir, { recursive: true, force: true });
} catch (_) {}

if (!played) {
  console.error('Playback failed. Check the selected ALSA playback device.');
  process.exit(1);
}

console.log('Audio diagnostic completed successfully.');
