#!/usr/bin/env node

'use strict';

/**
 * Experimental codemod for CodeQL's js/tainted-format-string rule.
 *
 * Dynamic first arguments can make Node's console methods interpret attacker-
 * controlled percent tokens. Preserve the rendered message and any additional
 * Error/object arguments by inserting a constant "%s" format string.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const ts = require(path.join(projectRoot, 'client', 'node_modules', 'typescript'));
const consoleMethods = new Set(['debug', 'error', 'info', 'log', 'trace', 'warn']);
const args = process.argv.slice(2);
const shouldWrite = args.includes('--write');
const requestedFiles = args.filter((arg) => !arg.startsWith('--'));

function listTrackedSourceFiles() {
  const result = spawnSync('git', [
    'ls-files',
    '-z',
    '*.cjs',
    '*.js',
    '*.jsx',
    '*.mjs',
    '*.ts',
    '*.tsx'
  ], {
    cwd: projectRoot,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || 'Unable to list tracked source files');
  }

  return result.stdout.split('\0').filter(Boolean);
}

function getScriptKind(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.json':
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.JS;
  }
}

function isConsoleMethodCall(node) {
  if (!ts.isCallExpression(node) || node.arguments.length < 2) {
    return false;
  }

  const expression = node.expression;
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'console'
    && consoleMethods.has(expression.name.text);
}

function hasConstantFormatString(node) {
  const firstArgument = node.arguments[0];
  return ts.isStringLiteral(firstArgument)
    || ts.isNoSubstitutionTemplateLiteral(firstArgument);
}

function findInsertions(sourceFile) {
  const insertions = [];

  function visit(node) {
    if (isConsoleMethodCall(node) && !hasConstantFormatString(node)) {
      insertions.push(node.arguments[0].getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return insertions.sort((left, right) => right - left);
}

function rewriteFile(relativePath) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (path.relative(projectRoot, absolutePath).startsWith('..')) {
    throw new Error(`Refusing to read outside the repository: ${relativePath}`);
  }

  const source = fs.readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(relativePath)
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`Unable to parse ${relativePath}`);
  }

  const insertions = findInsertions(sourceFile);
  if (insertions.length === 0) {
    return 0;
  }

  if (shouldWrite) {
    let rewritten = source;
    for (const offset of insertions) {
      rewritten = `${rewritten.slice(0, offset)}'%s', ${rewritten.slice(offset)}`;
    }
    fs.writeFileSync(absolutePath, rewritten, 'utf8');
  }

  process.stdout.write(`${relativePath}: ${insertions.length}\n`);
  return insertions.length;
}

const files = requestedFiles.length > 0 ? requestedFiles : listTrackedSourceFiles();
let total = 0;
for (const file of files) {
  total += rewriteFile(file);
}

process.stdout.write(`Dynamic console format calls: ${total}\n`);
if (!shouldWrite && total > 0) {
  process.exitCode = 1;
}
