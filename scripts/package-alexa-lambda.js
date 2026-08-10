#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const outputArgumentIndex = process.argv.indexOf('--output');
const configuredOutput = outputArgumentIndex >= 0
  ? process.argv[outputArgumentIndex + 1]
  : '/tmp/homebrain-alexa-lambda.zip';
const outputPath = path.resolve(configuredOutput || '');

const archiveRoots = [
  'lambda/package.json',
  'lambda/package-lock.json',
  'lambda/node_modules',
  'lambda/src',
  'shared/alexa'
];
const requiredEntries = [
  'lambda/src/handler.js',
  'lambda/src/brokerClient.js',
  'shared/alexa/messages.js',
  'lambda/node_modules/axios/package.json'
];

function fail(message) {
  console.error(`Alexa Lambda package failed: ${message}`);
  process.exit(1);
}

if (!outputPath.toLowerCase().endsWith('.zip')) {
  fail('the output path must end in .zip');
}

for (const relativePath of [...archiveRoots, ...requiredEntries]) {
  if (!fs.existsSync(path.join(repoRoot, relativePath))) {
    fail(`missing ${relativePath}; run npm run lambda-install first`);
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.rmSync(outputPath, { force: true });

const zipResult = spawnSync('zip', [
  '-q',
  '-X',
  '-r',
  outputPath,
  ...archiveRoots,
  '-x',
  '*/.DS_Store',
  '*/__MACOSX/*'
], {
  cwd: repoRoot,
  encoding: 'utf8'
});

if (zipResult.error) {
  fail(`could not run zip: ${zipResult.error.message}`);
}
if (zipResult.status !== 0) {
  fail(zipResult.stderr.trim() || `zip exited with status ${zipResult.status}`);
}

const listResult = spawnSync('unzip', ['-Z1', outputPath], {
  cwd: repoRoot,
  encoding: 'utf8'
});
if (listResult.error || listResult.status !== 0) {
  fail(listResult.error?.message || listResult.stderr.trim() || 'could not inspect the generated ZIP');
}

const entries = new Set(listResult.stdout.split(/\r?\n/).filter(Boolean));
for (const entry of requiredEntries) {
  if (!entries.has(entry)) {
    fail(`generated ZIP is missing ${entry}`);
  }
}

const archive = fs.readFileSync(outputPath);
const sizeMiB = archive.length / (1024 * 1024);
if (sizeMiB > 50) {
  fail(`generated ZIP is ${sizeMiB.toFixed(2)} MiB, above Lambda's 50 MiB direct-upload limit`);
}

const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
console.log(`Alexa Lambda ZIP: ${outputPath}`);
console.log(`Size: ${sizeMiB.toFixed(2)} MiB`);
console.log(`SHA-256: ${sha256}`);
