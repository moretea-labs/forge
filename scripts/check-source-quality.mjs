#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { committedSourceCandidate, materializeCommittedSourceCandidate } from './testing/source-quality-candidate.ts';
import { fileURLToPath } from 'node:url';
import { collectChangedPaths, existingChangedFiles } from './testing/test-governance.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const baseRef = process.env.TEST_BASE_REF?.trim();
// Publication of an already-committed main candidate checks Git objects at the
// pinned revision, not uncommitted edits by other Writers. Pre-commit/local
// checks still inspect the actual working source.
const committedMode = Boolean(baseRef && process.env.FORGE_CHECK_SOURCE_QUALITY_MODE === 'committed');
const candidate = committedMode
  ? committedSourceCandidate(ROOT, baseRef, process.env.FORGE_CHECK_CANDIDATE_SHA || 'HEAD')
  : undefined;
const changed = new Set(candidate?.paths ?? collectChangedPaths(ROOT, baseRef ? { baseRef } : {}));
if (changed.size === 0 && !baseRef) {
  const lastCommitPaths = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  for (const path of lastCommitPaths.split(String.fromCharCode(0))) {
    if (path) changed.add(path);
  }
}

const sourcePaths = (candidate ? [...changed] : existingChangedFiles(ROOT, changed))
  .filter((path) => /\.(?:[cm]?[jt]sx?|jsonc?|json5|css|html|graphql|swift|rs|sh|bash|zsh)$/i.test(path))
  .filter(
    (path) => !/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml)$/i.test(path),
  )
  .sort();

if (sourcePaths.length === 0) {
  console.log('[source-quality] no changed source files; skipped');
  process.exit(0);
}

const checkRoot = candidate ? materializeCommittedSourceCandidate(ROOT, candidate.revision, sourcePaths) : ROOT;
const biomeFiles = sourcePaths.filter((path) => /\.(?:[cm]?[jt]sx?|jsonc?|json5|css|html|graphql)$/i.test(path));
const swiftFiles = sourcePaths.filter((path) => path.endsWith('.swift'));
const rustFiles = sourcePaths.filter((path) => path.endsWith('.rs'));
const shellFiles = sourcePaths.filter((path) => /\.(?:sh|bash|zsh)$/i.test(path));
const failures = [];

function runTool(label, command, args, stdio = 'inherit') {
  const result = spawnSync(command, args, { cwd: checkRoot, stdio });
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
    if (candidate) {
      runTool('Biome format/lint/complexity', resolve(ROOT, 'node_modules', '.bin', 'biome'), [
        'ci',
        '--vcs-enabled=false',
        '--reporter=summary',
        ...biomeFiles,
      ]);
    } else {
      runTool('Biome format/lint/complexity', 'bun', ['x', 'biome', 'ci', '--reporter=summary', ...biomeFiles]);
    }
  }
}

// These two desktop Swift files predate a swift-format baseline. Their
// large existing indentation/spacing debt is not an authorization for an
// unrelated whole-file rewrite. Require syntax parsing here; other Swift
// sources still use strict formatting.
const legacySwiftPaths = new Set([
  'apps/desktop-native/Sources/ForgeNative/ForgeNativeApp.swift',
  'apps/desktop-native/Sources/ForgeNative/ZenModeView.swift',
]);
if (swiftFiles.length > 0) {
  const strictSwiftFiles = swiftFiles.filter((path) => !legacySwiftPaths.has(path));
  const legacySwiftFiles = swiftFiles.filter((path) => legacySwiftPaths.has(path));
  const onMac = process.platform === 'darwin';
  if (strictSwiftFiles.length > 0) {
    // Ubuntu runner Swift 6 exposes the formatter as `swift format`, while
    // Xcode resolves the same tool through `xcrun swift-format` on macOS.
    runTool('Swift formatting', onMac ? 'xcrun' : 'swift', [
      ...(onMac ? ['swift-format'] : ['format']),
      'lint',
      '--strict',
      ...strictSwiftFiles,
    ]);
  }
  for (const path of legacySwiftFiles) {
    runTool('Legacy Swift syntax', onMac ? 'xcrun' : 'swiftc', [
      ...(onMac ? ['swiftc'] : []),
      '-frontend',
      '-parse',
      path,
    ]);
  }
}

if (rustFiles.length > 0) {
  // The desktop crate declares edition 2021. Raw rustfmt otherwise defaults to
  // Rust 2015 and rejects valid async syntax on Linux CI.
  const legacyDesktopMain = 'apps/desktop/src-tauri/src/main.rs';
  const strictRustFiles = rustFiles.filter((path) => path !== legacyDesktopMain);
  if (strictRustFiles.length > 0) {
    runTool('Rust formatting', 'rustfmt', [
      '--edition',
      '2021',
      '--config',
      'skip_children=true',
      '--check',
      ...strictRustFiles,
    ]);
  }
  // The existing Desktop main.rs predates a rustfmt baseline (thousands of
  // unrelated style differences). Check that it parses without forcing an
  // unrelated mass rewrite; all other Rust files retain strict formatting.
  if (rustFiles.includes(legacyDesktopMain)) {
    runTool(
      'Rust parsing',
      'rustfmt',
      ['--edition', '2021', '--config', 'skip_children=true', '--emit', 'stdout', '--quiet', legacyDesktopMain],
      ['ignore', 'ignore', 'inherit'],
    );
  }
}

if (shellFiles.length > 0) {
  runTool('Shell formatting', 'shfmt', ['-d', '-i', '2', ...shellFiles]);
  runTool('ShellCheck', 'shellcheck', ['--severity=style', ...shellFiles]);
}

if (candidate) rmSync(checkRoot, { recursive: true, force: true });
if (failures.length > 0) {
  console.error('[source-quality] FAILED: ' + failures.join(', '));
  process.exitCode = 1;
} else {
  console.log(
    '[source-quality] PASS (' +
      sourcePaths.length +
      ' changed source files' +
      (candidate ? ` at committed ${candidate.revision.slice(0, 12)}` : '') +
      ')',
  );
}
