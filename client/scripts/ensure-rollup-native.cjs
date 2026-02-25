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

function installPackages(packageSpecs) {
  if (!Array.isArray(packageSpecs) || packageSpecs.length === 0) {
    return;
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', ...packageSpecs];
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

function shouldInstall(probeSpecifier) {
  try {
    resolveFromCwd(probeSpecifier);
    return false;
  } catch {
    return true;
  }
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

  const esbuildVersion = getPackageVersion('esbuild');
  const candidates = [
    {
      packageName: rollupNativePackage,
      version: rollupVersion,
      label: 'rollup-fix',
      probeSpecifier: rollupNativePackage
    },
    {
      packageName: '@esbuild/linux-arm64',
      version: esbuildVersion,
      label: 'esbuild-fix',
      probeSpecifier: '@esbuild/linux-arm64/bin/esbuild'
    }
  ];

  const missing = candidates
    .filter((item) => item.version && shouldInstall(item.probeSpecifier))
    .map((item) => ({
      ...item,
      target: `${item.packageName}@${item.version}`
    }));

  if (missing.length === 0) {
    return;
  }

  for (const item of missing) {
    console.log(`[${item.label}] Missing ${item.packageName}. Installing ${item.target}...`);
  }

  installPackages(missing.map((item) => item.target));

  for (const item of missing) {
    if (shouldInstall(item.probeSpecifier)) {
      throw new Error(`Install verification failed for ${item.packageName}`);
    }
    console.log(`[${item.label}] Installed ${item.target}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[native-deps-fix] Failed: ${error.message}`);
  process.exit(1);
}
