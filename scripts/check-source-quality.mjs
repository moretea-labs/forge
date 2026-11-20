#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChangedPaths } from '../src/testing/test-governance.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const baseRef = process.env.TEST_BASE_REF?.trim();
const changed = new Set(collectChangedPaths(ROOT, baseRef ? { baseRef } : {}));
if (changed.size === 0) {
  const lastCommitPaths = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  for (const path of lastCommitPaths.split(String.fromCharCode(0))) {
    if (path) changed.add(path);
  }
}

const sourcePaths = [...changed]
  .filter((path) => /\.(?:[cm]?[jt]sx?|jsonc?|json5|css|html|graphql|swift|rs|sh|bash|zsh)$/i.test(path))
  .filter(
    (path) => !/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml)$/i.test(path),
  )
  .sort();

if (sourcePaths.length === 0) {
  console.log('[source-quality] no changed source files; skipped');
  process.exit(0);
}

const biomeFiles = sourcePaths.filter((path) => /\.(?:[cm]?[jt]sx?|jsonc?|json5|css|html|graphql)$/i.test(path));
const swiftFiles = sourcePaths.filter((path) => path.endsWith('.swift'));
const rustFiles = sourcePaths.filter((path) => path.endsWith('.rs'));
const shellFiles = sourcePaths.filter((path) => /\.(?:sh|bash|zsh)$/i.test(path));
const failures = [];

function runTool(label, command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    console.error('[source-quality] BLOCKED: ' + label + ' could not run: ' + result.error.message);
    failures.push(label);
    return;
  }
  if (result.status !== 0) failures.push(label);
}

if (biomeFiles.length > 0) {
  const biomePackage = resolve(ROOT, 'node_modules', '@biomejs', 'biome', 'package.json');
  if (!existsSync(biomePackage)) {
    console.error('[source-quality] BLOCKED: pinned @biomejs/biome dev dependency is not installed');
    failures.push('Biome');
  } else {
    runTool('Biome format/lint/complexity', 'bun', ['x', 'biome', 'ci', '--reporter=summary', ...biomeFiles]);
  }
}

if (swiftFiles.length > 0) {
  runTool('Swift formatting', 'swift-format', ['lint', '--strict', ...swiftFiles]);
}

if (rustFiles.length > 0) {
  runTool('Rust formatting', 'rustfmt', ['--check', ...rustFiles]);
}

if (shellFiles.length > 0) {
  runTool('Shell formatting', 'shfmt', ['-d', '-i', '2', ...shellFiles]);
  runTool('ShellCheck', 'shellcheck', ['--severity=style', ...shellFiles]);
}

if (failures.length > 0) {
  console.error('[source-quality] FAILED: ' + failures.join(', '));
  process.exitCode = 1;
} else {
  console.log('[source-quality] PASS (' + sourcePaths.length + ' changed source files)');
}
