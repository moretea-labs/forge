#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const SOURCE_EXCLUDES = [
  '.ai/', '.forge/', '_ops/', 'node_modules/', 'dist/', 'coverage/',
  'tmp/', 'temp/', 'tasks/', 'plans/', 'references/',
];

function sourceTreeDigest() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  const listed = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], { cwd: ROOT, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  const paths = listed.toString('utf8').split('\0')
    .filter((path) => path && !SOURCE_EXCLUDES.some((prefix) => path.startsWith(prefix)))
    .sort();
  const digest = createHash('sha256')
    .update('forge-portable-package-source-v1\0')
    .update(head)
    .update('\0');
  for (const path of paths) {
    const absolute = resolve(ROOT, path);
    digest.update(path).update('\0');
    try {
      const stat = lstatSync(absolute);
      digest.update(String(stat.mode)).update('\0');
      if (stat.isSymbolicLink()) digest.update('symlink:').update(readlinkSync(absolute));
      else if (stat.isFile()) digest.update(readFileSync(absolute));
      else digest.update('non-file');
    } catch (_error) {
      digest.update('missing');
    }
    digest.update('\0');
  }
  return digest.digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  const before = sourceTreeDigest();
  const testFiles = readdirSync(join(ROOT, 'tests/node'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join('tests/node', name));
  if (testFiles.length === 0) throw new Error('No portable Node smoke tests were found');

  if (run(process.execPath, ['--test', ...testFiles]) !== 0) return 1;
  if (run(NPM, ['run', 'smoke:tarball-install']) !== 0) return 1;

  const after = sourceTreeDigest();
  if (before !== after) {
    process.stderr.write('[portable-package] ERROR: source changed during validation; result is stale and must be rerun.\n');
    return 1;
  }
  process.stdout.write('[portable-package] PASS: source digest remained stable throughout validation.\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write('[portable-package] ERROR: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
