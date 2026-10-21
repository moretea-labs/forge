#!/usr/bin/env node
// Structural dependency enforcement. Keep this checker separate from lifecycle decisions.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const ts = createRequire(import.meta.url)('typescript');
const debtFile = 'docs/architecture/kernel-legacy-edge-debt.json';
const debt = JSON.parse(readFileSync(join(root, debtFile), 'utf8'));
if (debt.version !== 1 || !Array.isArray(debt.edges)) throw new Error('invalid kernel legacy debt ledger');
const runtimeCliDebtFile = 'docs/architecture/runtime-cli-edge-debt.json';
const runtimeCliDebt = JSON.parse(readFileSync(join(root, runtimeCliDebtFile), 'utf8'));
if (runtimeCliDebt.version !== 1 || !Array.isArray(runtimeCliDebt.edges)) throw new Error('invalid runtime->cli debt ledger');
const sorted = [...debt.edges].sort();
if (new Set(sorted).size !== sorted.length || JSON.stringify(sorted) !== JSON.stringify(debt.edges)) {
  throw new Error(`${debtFile}: edges must be unique and sorted`);
}
const allowedDebt = new Set(debt.edges);
const usedDebt = new Set();
const runtimeCliSorted = [...runtimeCliDebt.edges].sort();
if (new Set(runtimeCliSorted).size !== runtimeCliSorted.length || JSON.stringify(runtimeCliSorted) !== JSON.stringify(runtimeCliDebt.edges)) {
  throw new Error(`${runtimeCliDebtFile}: edges must be unique and sorted`);
}
const allowedRuntimeCliDebt = new Set(runtimeCliDebt.edges);
const usedRuntimeCliDebt = new Set();
const failures = [];
const domainDependencies = new Map();
const posix = path => path.split(sep).join('/');

function filesWithin(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', 'dist', 'target', 'build'].includes(entry.name)) {
      results.push(...filesWithin(join(dir, entry.name)));
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}
function importsOf(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  const take = expr => {
    if (expr && ts.isStringLiteralLike(expr)) imports.push({
      path: expr.text,
      line: file.getLineAndCharacterOfPosition(expr.getStart(file)).line + 1,
    });
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) take(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) take(node.moduleReference.expression);
    if (ts.isCallExpression(node) && node.arguments.length === 1
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) take(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

for (const absolute of filesWithin(join(root, 'packages/kernel'))) {
  const source = posix(relative(root, absolute));
  const domain = source.split('/')[2];
  for (const item of importsOf(readFileSync(absolute, 'utf8'), source)) {
    if (!item.path.startsWith('.')) continue;
    const target = posix(relative(root, resolve(dirname(absolute), item.path)));
    const parts = target.split('/');
    const at = `${source}:${item.line}`;
    if (['adapters', 'apps', 'supervisor'].includes(parts[0])) {
      failures.push(`${at}: kernel must not import outward into ${target}`);
    } else if (parts[0] === 'src') {
      const key = `${source}|${item.path}`;
      if (allowedDebt.has(key) && source.includes('/infrastructure/')) usedDebt.add(key);
      else failures.push(`${at}: unapproved legacy kernel import ${target}; move the owner inward`);
    } else if (parts[0] === 'packages' && parts[1] === 'kernel' && parts[2] !== domain) {
      if (parts[3] !== 'api' || parts[4] !== 'index') {
        failures.push(`${at}: ${domain} imports ${parts[2]} internals; use its api/index`);
      } else {
        if (!domainDependencies.has(domain)) domainDependencies.set(domain, new Set());
        domainDependencies.get(domain).add(parts[2]);
      }
    }
  }
}
for (const edge of allowedDebt) {
  if (!usedDebt.has(edge)) failures.push(`${debtFile}: stale exception ${edge}; remove retired debt`);
}

// src/runtime must not reach back into src/cli. Existing reverse edges are
// shrinking migration debt recorded in runtime-cli-edge-debt.json; the shared
// neutral owners live under src/effects (path/storage contracts) and the
// kernel/adapter layers.
for (const absolute of filesWithin(join(root, 'src/runtime'))) {
  const source = posix(relative(root, absolute));
  if (source.endsWith('.test.ts')) continue;
  for (const item of importsOf(readFileSync(absolute, 'utf8'), source)) {
    if (!item.path.startsWith('.')) continue;
    const target = posix(relative(root, resolve(dirname(absolute), item.path)));
    if (target !== '' && !target.startsWith('src/cli/')) continue;
    const key = `${source}|${item.path}`;
    if (allowedRuntimeCliDebt.has(key)) usedRuntimeCliDebt.add(key);
    else failures.push(`${source}:${item.line}: unapproved src/runtime -> src/cli import ${target}; move the shared owner to a neutral module`);
  }
}
for (const edge of allowedRuntimeCliDebt) {
  if (!usedRuntimeCliDebt.has(edge)) failures.push(`${runtimeCliDebtFile}: stale exception ${edge}; remove retired debt`);
}

const visited = new Set();
const active = new Set();
function visit(domain, stack) {
  if (active.has(domain)) {
    failures.push(`kernel domain dependency cycle: ${[...stack, domain].join(' -> ')}`);
    return;
  }
  if (visited.has(domain)) return;
  active.add(domain);
  for (const next of domainDependencies.get(domain) || []) visit(next, [...stack, domain]);
  active.delete(domain);
  visited.add(domain);
}
for (const domain of domainDependencies.keys()) visit(domain, []);

if (failures.length) {
  console.error(`Module boundaries failed (${failures.length}):\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Module boundaries passed: ${allowedDebt.size} kernel legacy edges, ${allowedRuntimeCliDebt.size} runtime->cli legacy edges; no new edge permitted`);
}
