const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAudit } = require('../audit-dependencies');
const report = (vulnerabilities = {}) => ({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } } });

test('clean reports pass', () => {
  assert.deepEqual(evaluateAudit(report()), { unexpected: [] });
});

test('the former adm-zip exception now fails for both direct and transitive findings', () => {
  const entries = {
    'adm-zip': { severity: 'moderate', via: [{ name: 'adm-zip', severity: 'moderate', url: 'https://github.com/advisories/GHSA-vwc7-r8mq-g2x9' }] },
    'onnxruntime-node': { severity: 'moderate', via: ['adm-zip'] }
  };
  assert.deepEqual(evaluateAudit(report(entries)).unexpected, ['adm-zip: moderate', 'onnxruntime-node: moderate']);
});

test('findings at every severity fail the audit', () => {
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    assert.deepEqual(evaluateAudit(report({ dependency: { severity } })).unexpected, [`dependency: ${severity}`]);
  }
});

test('failed, truncated and inconsistent reports fail closed', () => {
  for (const value of [null, {}, { error: { code: 'ENETWORK' } }, { ...report(), metadata: { vulnerabilities: { total: 1 } } }]) {
    assert.throws(() => evaluateAudit(value));
  }
});
