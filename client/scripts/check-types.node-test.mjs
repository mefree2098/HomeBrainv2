import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiagnostics, compareDiagnostics } from './check-types.mjs';

test('typecheck ratchet rejects new signatures and additional copies of existing errors', () => {
  assert.deepEqual(compareDiagnostics({ known: 2, newError: 1 }, { known: 1 }).added, [['known', 2], ['newError', 1]]);
});
test('typecheck ratchet requires resolved errors to be removed from the baseline', () => {
  assert.deepEqual(compareDiagnostics({ known: 1 }, { known: 2, fixed: 1 }), { added: [], removed: [['known', 2], ['fixed', 1]] });
  assert.deepEqual(compareDiagnostics({ known: 1 }, { known: 1 }), { added: [], removed: [] });
});

test('real compiler diagnostics are repeatable across line movement and detect duplicate errors', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-type-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [config, file] of [['app', 'source.ts'], ['node', 'node.ts']]) {
    fs.writeFileSync(path.join(root, `tsconfig.${config}.json`), JSON.stringify({ files: [file], compilerOptions: { strict: true, types: [], skipLibCheck: true } }));
  }
  const source = "const value: number = 'wrong';\n";
  fs.writeFileSync(path.join(root, 'source.ts'), source);
  fs.writeFileSync(path.join(root, 'node.ts'), 'export {};');
  const baseline = collectDiagnostics(root);
  assert.equal(Object.values(baseline).reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(collectDiagnostics(root), baseline);
  fs.writeFileSync(path.join(root, 'source.ts'), `\n\n${source}`);
  assert.deepEqual(collectDiagnostics(root), baseline);
  fs.writeFileSync(path.join(root, 'source.ts'), `${source}function another() {\n${source}}`);
  assert.equal(compareDiagnostics(collectDiagnostics(root), baseline).added.length, 1);
});
