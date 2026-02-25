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

function getPackageVersion(packageName) {
  try {
    const pkgPath = resolveFromCwd(`${packageName}/package.json`);
    return require(pkgPath).version;
  } catch {
    return null;
  }
}

function ensurePackage(packageName, version, label) {
  return ensurePackageWithProbe(packageName, version, label, packageName);
}

function ensurePackageWithProbe(packageName, version, label, probeSpecifier) {
  if (!version) {
    return;
  }

  try {
    resolveFromCwd(probeSpecifier);
    return;
  } catch {
    // Missing package for current platform. Install it below.
  }

  const target = `${packageName}@${version}`;
  console.log(`[${label}] Missing ${packageName}. Installing ${target}...`);
  installPackage(target);

  try {
    resolveFromCwd(probeSpecifier);
  } catch {
    throw new Error(`Install verification failed for ${packageName}`);
  }

  console.log(`[${label}] Installed ${target}`);
}

function main() {
  // This issue is relevant to Linux ARM64 deploy hosts (Jetson/RPi class).
  if (process.platform !== 'linux' || process.arch !== 'arm64') {
    return;
  }

  const rollupVersion = getPackageVersion('rollup');
  const rollupNativePackage = isMusl()
    ? '@rollup/rollup-linux-arm64-musl'
    : '@rollup/rollup-linux-arm64-gnu';
  ensurePackage(rollupNativePackage, rollupVersion, 'rollup-fix');

  const esbuildVersion = getPackageVersion('esbuild');
  ensurePackageWithProbe(
    '@esbuild/linux-arm64',
    esbuildVersion,
    'esbuild-fix',
    '@esbuild/linux-arm64/bin/esbuild'
  );
}

try {
  main();
} catch (error) {
  console.error(`[native-deps-fix] Failed: ${error.message}`);
  process.exit(1);
}
