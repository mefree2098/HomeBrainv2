#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const modulesToVerify = [
  { name: 'bcrypt', requirePath: 'bcrypt' },
  { name: 'serialport bindings', requirePath: '@serialport/bindings' }
];
const rebuildTargets = ['bcrypt', 'serialport', '@serialport/bindings'];

function canRequireModule(requirePath) {
  try {
    require(requirePath); // eslint-disable-line global-require, import/no-dynamic-require
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function needsNativeRebuild(error) {
  const message = String(error?.message || '');
  return (
    error?.code === 'ERR_DLOPEN_FAILED'
    || message.includes('NODE_MODULE_VERSION')
    || message.includes('was compiled against a different Node.js version')
    || message.includes('Could not locate the bindings file')
  );
}

function rebuildNativeModules() {
  console.log('Rebuilding native server modules for the active Node.js runtime...');
  const result = spawnSync('npm', ['rebuild', ...rebuildTargets], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  const failures = modulesToVerify
    .map((entry) => ({ ...entry, result: canRequireModule(entry.requirePath) }))
    .filter((entry) => !entry.result.ok);

  if (failures.length === 0) {
    console.log('Native server modules are compatible with the active Node.js runtime.');
    return;
  }

  const rebuildableFailures = failures.filter((entry) => needsNativeRebuild(entry.result.error));
  if (rebuildableFailures.length === 0) {
    for (const failure of failures) {
      console.error(`Failed to load native dependency "${failure.name}": ${failure.result.error?.message || failure.result.error}`);
    }
    process.exit(1);
  }

  rebuildNativeModules();

  const retryFailures = modulesToVerify
    .map((entry) => ({ ...entry, result: canRequireModule(entry.requirePath) }))
    .filter((entry) => !entry.result.ok);

  if (retryFailures.length > 0) {
    for (const failure of retryFailures) {
      console.error(`Native dependency "${failure.name}" still failed after rebuild: ${failure.result.error?.message || failure.result.error}`);
    }
    process.exit(1);
  }

  console.log('Native server modules rebuilt successfully for the active Node.js runtime.');
}

main();
