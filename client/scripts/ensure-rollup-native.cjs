#!/usr/bin/env node

const { execFileSync } = require('child_process');

function isMusl() {
  try {
    if (process.report && typeof process.report.getReport === 'function') {
      const report = process.report.getReport();
      if (report?.header?.glibcVersionRuntime) {
        return false;
      }
    }
  } catch {
    // Ignore report parsing errors and fall through to ldd check.
  }

  try {
    const output = execFileSync('ldd', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return output.toLowerCase().includes('musl');
  } catch {
    // If we cannot determine libc, assume glibc on standard Linux distros.
    return false;
  }
}

function resolveFromCwd(specifier) {
  return require.resolve(specifier, { paths: [process.cwd()] });
}

function installPackage(pkgWithVersion) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', pkgWithVersion];
  execFileSync(npmCmd, args, {
    cwd: process.cwd(),
    stdio: 'inherit'
  });
}

function main() {
  // This issue is relevant to Linux ARM64 deploy hosts (Jetson/RPi class).
  if (process.platform !== 'linux' || process.arch !== 'arm64') {
    return;
  }

  let rollupVersion;
  try {
    const rollupPkgPath = resolveFromCwd('rollup/package.json');
    rollupVersion = require(rollupPkgPath).version;
  } catch {
    // Rollup is not installed yet (or not needed for this install).
    return;
  }

  const packageName = isMusl()
    ? '@rollup/rollup-linux-arm64-musl'
    : '@rollup/rollup-linux-arm64-gnu';

  try {
    resolveFromCwd(packageName);
    return;
  } catch {
    // Missing optional native package; install exact Rollup-matching version.
  }

  const target = `${packageName}@${rollupVersion}`;
  console.log(`[rollup-fix] Missing ${packageName}. Installing ${target}...`);
  installPackage(target);

  // Verify install succeeded so downstream build errors are explicit.
  resolveFromCwd(packageName);
  console.log(`[rollup-fix] Installed ${target}`);
}

try {
  main();
} catch (error) {
  console.error(`[rollup-fix] Failed: ${error.message}`);
  process.exit(1);
}

