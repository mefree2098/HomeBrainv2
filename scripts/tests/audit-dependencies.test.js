const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAudit } = require('../audit-dependencies');
const when = Date.parse('2026-09-10T00:00:00Z');
const report = (vulnerabilities = {}) => ({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } } });
const known = () => ({
  'adm-zip': { severity: 'moderate', via: [{ name: 'adm-zip', severity: 'moderate', url: 'https://github.com/advisories/GHSA-vwc7-r8mq-g2x9' }] },
  'onnxruntime-node': { severity: 'moderate', via: ['adm-zip'] }
});
test('clean reports pass without an exception', () => {
  assert.deepEqual(evaluateAudit(report(), '.'), { known: [], unexpected: [] });
});
test('only the exact existing advisory and dependency chain receive a temporary exception', () => {
  assert.equal(evaluateAudit(report(known()), 'remote-device', when).known.length, 2);
  assert.equal(evaluateAudit(report(known()), 'server', when).unexpected.length, 2);
  assert.equal(evaluateAudit(report(known()), 'remote-device', Date.parse('2026-10-10')).unexpected.length, 2);
});
test('new advisories and escalated severity cannot hide under an accepted package name', () => {
  const entries = known();
  entries['adm-zip'].via.push({ name: 'adm-zip', severity: 'moderate', url: 'https://github.com/advisories/OTHER' });
  assert.equal(evaluateAudit(report(entries), 'remote-device', when).unexpected.length, 2);
  const elevated = known(); elevated['adm-zip'].severity = 'high';
  assert.equal(evaluateAudit(report(elevated), 'remote-device', when).unexpected.length, 2);
});
test('failed, truncated and inconsistent reports fail closed', () => {
  for (const value of [null, {}, { error: { code: 'ENETWORK' } }, { ...report(), metadata: { vulnerabilities: { total: 1 } } }]) {
    assert.throws(() => evaluateAudit(value, 'remote-device', when));
  }
});
test('cyclic dependency chains are not accepted', () => {
  const entries = known(); entries['adm-zip'].via = ['onnxruntime-node'];
  assert.equal(evaluateAudit(report(entries), 'remote-device', when).unexpected.length, 2);
});
