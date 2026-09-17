#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function evaluateAudit(report) {
  if (!report || report.error || report.auditReportVersion !== 2
      || !report.vulnerabilities || !report.metadata?.vulnerabilities
      || !Number.isInteger(report.metadata.vulnerabilities.total)) {
    throw new Error('npm audit did not return a complete vulnerability report');
  }
  const entries = Object.entries(report.vulnerabilities);
  if (entries.length !== report.metadata.vulnerabilities.total) {
    throw new Error('npm audit vulnerability totals do not match its entries');
  }
  return { unexpected: entries.map(([name, entry]) => `${name}: ${entry.severity || 'unknown severity'}`) };
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
  const { unexpected } = evaluateAudit(report);
  console.log(JSON.stringify(report, null, 2));
  if (unexpected.length) {
    throw new Error(`Unaccepted dependency vulnerabilities: ${unexpected.join('; ')}`);
  }
  console.log(`${project}: no known dependency vulnerabilities at any severity`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { evaluateAudit };
