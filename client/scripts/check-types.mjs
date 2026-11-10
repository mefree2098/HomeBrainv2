import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(clientRoot, 'typecheck-baseline.json');

export function collectDiagnostics(root = clientRoot) {
  const counts = {};
  for (const configName of ['tsconfig.app.json', 'tsconfig.node.json']) {
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, configName), { noEmit: true }, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); }
    });
    if (!parsed) throw new Error(`Cannot parse ${configName}`);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    for (const diagnostic of [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const file = diagnostic.file;
      const line = file && diagnostic.start != null ? file.getLineAndCharacterOfPosition(diagnostic.start).line : null;
      const source = line == null ? '' : file.text.split(/\r?\n/)[line].trim();
      // Include source text and multiplicity, so line movement is harmless but
      // adding another occurrence cannot hide behind an existing diagnostic.
      const key = JSON.stringify([
        file ? path.relative(root, file.fileName).split(path.sep).join('/') : configName,
        diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '), source
      ]);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

export function compareDiagnostics(current, allowed) {
  const added = Object.entries(current).filter(([key, count]) => count > (allowed[key] || 0));
  const removed = Object.entries(allowed).filter(([key, count]) => count > (current[key] || 0));
  return { added, removed };
}

export function run(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--update')) throw new Error('Usage: check-types.mjs [--update]');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const baselineRef = process.env.HOMEBRAIN_TYPE_BASELINE_REF;
  if (baselineRef && !/^0+$/.test(baselineRef)) {
    if (!/^[a-f\d]{40}$/i.test(baselineRef)) throw new Error('The baseline comparison requires an exact Git commit');
    const exists = spawnSync('git', ['cat-file', '-e', `${baselineRef}^{commit}`], { cwd: clientRoot, encoding: 'utf8' });
    if (exists.status !== 0) throw new Error('Cannot load the base commit for the TypeScript gate');
    const previous = spawnSync('git', ['show', `${baselineRef}:client/typecheck-baseline.json`], { cwd: clientRoot, encoding: 'utf8' });
    // The first adoption has no baseline in its parent. Subsequent baselines
    // may remove entries, but never add or increase accepted errors.
    if (previous.status === 0 && compareDiagnostics(baseline.diagnostics, JSON.parse(previous.stdout).diagnostics).added.length) {
      throw new Error('The TypeScript baseline may only shrink');
    }
  }
  const current = collectDiagnostics();
  const { added, removed } = compareDiagnostics(current, baseline.diagnostics);
  if (added.length) {
    for (const [key, count] of added) console.error(`New TypeScript error (${count}): ${key}`);
    return 1;
  }
  if (args.includes('--update')) {
    fs.writeFileSync(baselinePath, `${JSON.stringify({ version: 1, diagnostics: current }, null, 2)}\n`);
  } else if (removed.length) {
    console.error('TypeScript errors were fixed. Run npm run typecheck:update to shrink the baseline.');
    return 1;
  }
  console.log(`TypeScript gate passed: ${Object.values(current).reduce((sum, count) => sum + count, 0)} existing diagnostics; no new errors.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
