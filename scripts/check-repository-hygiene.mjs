#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map((line) => line.trim()).filter(Boolean);
const failures = [];

for (const prefix of ['evals/', 'references/', 'recovery/']) {
  const hits = tracked.filter((path) => path.startsWith(prefix));
  if (hits.length) failures.push(`retired tracked root ${prefix}: ${hits.slice(0, 5).join(', ')}`);
}
for (const exact of ['scripts/run-skill-evals.ts']) {
  if (tracked.includes(exact)) failures.push(`retired tracked file: ${exact}`);
}

const sourcePollution = [
  '.ai/harness/local-jobs-archive',
  '.ai/harness/jobs-archive',
  '.ai/harness/checks/gates',
  '.forge/tools',
  '.forge/tmp',
  '.forge/assistant',
];
for (const relativePath of sourcePollution) {
  if (existsSync(join(ROOT, relativePath))) failures.push(`runtime/cache data must not live in source tree: ${relativePath}`);
}
for (const relativePath of ['.forge/browser', '.forge/interactions']) {
  const path = join(ROOT, relativePath);
  if (!existsSync(path)) continue;
  try {
    if (!lstatSync(path).isSymbolicLink()) failures.push(`provider runtime data must be Controller-Home-backed (symlink or absent): ${relativePath}`);
  } catch {
    failures.push(`cannot inspect runtime path: ${relativePath}`);
  }
}

const packageJson = readFileSync(join(ROOT, 'package.json'), 'utf8');
if (packageJson.includes('benchmark:skills') || packageJson.includes('run-skill-evals')) {
  failures.push('legacy skill benchmark entrypoint is still exposed by package.json');
}
const cleanupSource = readFileSync(join(ROOT, 'src/runtime/maintenance/cleanup.ts'), 'utf8');
if (cleanupSource.includes(".ai/harness/local-jobs-archive") || cleanupSource.includes(".ai/harness/jobs-archive")) {
  failures.push('runtime cleanup must not create archive namespaces inside repository source');
}
const gateSource = readFileSync(join(ROOT, 'scripts/run-governed-gate.ts'), 'utf8');
if (gateSource.includes("join(ROOT, '.ai/harness/checks/gates')")) {
  failures.push('governed gate receipts must use Controller Home cache, not repository source');
}

if (failures.length) {
  console.error('[repository-hygiene] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[repository-hygiene] ok');
