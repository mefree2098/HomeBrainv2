#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Explicit, expiring exception for the PRE-EXISTING ONNX installer dependency.
// This is not a clean audit. Do not extend without re-reviewing the upstream fix.
const KNOWN_ADVISORY = 'https://github.com/advisories/GHSA-vwc7-r8mq-g2x9';
const EXPIRES_AT = Date.parse('2026-10-10T00:00:00Z');

function evaluateAudit(report, project, now = Date.now()) {
  if (!report || report.error || report.auditReportVersion !== 2
      || !report.vulnerabilities || !report.metadata?.vulnerabilities
      || !Number.isInteger(report.metadata.vulnerabilities.total)) {
    throw new Error('npm audit did not return a complete vulnerability report');
  }
  const entries = Object.entries(report.vulnerabilities);
  if (entries.length !== report.metadata.vulnerabilities.total) {
    throw new Error('npm audit vulnerability totals do not match its entries');
  }
  const known = [];
  const unexpected = [];
  const followsKnownAdvisory = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    const entry = report.vulnerabilities[name];
    if (!entry || !['adm-zip', 'onnxruntime-node'].includes(name)
        || entry.severity !== 'moderate' || !Array.isArray(entry.via) || !entry.via.length) return false;
    return entry.via.every((cause) => typeof cause === 'string'
      ? followsKnownAdvisory(cause, new Set(seen))
      : cause?.url === KNOWN_ADVISORY && cause?.severity === 'moderate' && cause?.name === 'adm-zip');
  };
  for (const [name, entry] of entries) {
    if (project === 'remote-device' && now < EXPIRES_AT && followsKnownAdvisory(name)) {
      known.push(`${name}: ${KNOWN_ADVISORY}`);
    } else {
      unexpected.push(`${name}: ${entry.severity || 'unknown severity'}`);
    }
  }
  return { known, unexpected };
}

function main() {
  const project = path.relative(path.resolve(__dirname, '..'), process.cwd()).split(path.sep).join('/') || '.';
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: process.env
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error('npm audit could not complete; refusing to treat a scan failure as success');
  }
  const report = JSON.parse(result.stdout);
  const { known, unexpected } = evaluateAudit(report, project);
  console.log(JSON.stringify(report, null, 2));
  if (known.length) {
    console.log('PRE-EXISTING EXCEPTION (not vulnerability-free), expires 2026-10-10:');
    known.forEach((entry) => console.log(entry));
  }
  if (unexpected.length) {
    throw new Error(`Unaccepted dependency vulnerabilities: ${unexpected.join('; ')}`);
  }
  console.log(`${project}: no unaccepted dependency vulnerabilities at any severity`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { evaluateAudit };
