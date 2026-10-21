import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildControllerContextPack, buildControllerContextPackAsync, type ControllerContextPackOptions } from '../../src/cli/controller/context-pack';
import { getMcpPolicy } from '../../adapters/mcp/policy';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test('does not treat exact-known lexical hit caps as omitted evidence when the file is fully materialized', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-exact-known-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  const lines = Array.from({ length: 80 }, (_, index) => `export const ENTRY_MARKER_${index} = 'ENTRY_MARKER';`);
  writeFileSync(join(root, 'src/exact.ts'), `${lines.join('\n')}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect ENTRY_MARKER in the exact known implementation file.',
    searchTerms: ['ENTRY_MARKER'],
    knownPaths: ['src/exact.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 4,
  });

  expect(pack.search.truncated).toBe(true);
  expect(pack.search.evidenceTruncated).toBe(false);
  expect(pack.coverage.exactKnownPaths).toEqual({ requested: ['src/exact.ts'], materialized: ['src/exact.ts'], missing: [] });
  expect(pack.coverage.materialization.completeFiles).toBeGreaterThan(0);
  expect(pack.readiness.retrieval).toMatchObject({ searchTruncated: false, omittedCandidateCount: 0, policyDeniedCandidateCount: 0, likelyRelatedNotInspectedCount: 0 });
  expect(pack.readiness.unresolvedReasonCodes).not.toContain('retrieval_truncated');
  expect(pack.readiness.status).toBe('ready');
  expect(pack.readiness.readyForHighConfidenceMutation).toBe(true);
});


test('treats lossless exact-known window materialization as sufficient despite lexical hit truncation', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-exact-window-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  const lines = [
    ...Array.from({ length: 45 }, (_, index) => `export const PRE_${index} = ${index};`),
    ...Array.from({ length: 80 }, (_, index) => `export const WINDOW_MARKER_${index} = 'WINDOW_MARKER';`),
    ...Array.from({ length: 45 }, (_, index) => `export const POST_${index} = ${index};`),
  ];
  writeFileSync(join(root, 'src/exact-window.ts'), `${lines.join('\n')}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect WINDOW_MARKER in the exact known implementation file.',
    searchTerms: ['WINDOW_MARKER'],
    knownPaths: ['src/exact-window.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 2,
    maxCharsPerSnippet: 2400,
  });

  expect(pack.search.truncated).toBe(true);
  expect(pack.files[0]?.snippets.length).toBeGreaterThan(0);
  expect(pack.files[0]?.snippets.every((snippet) => !snippet.truncated)).toBe(true);
  // Implementation retrieval is lexical by default: it must not launch a
  // second TypeScript compiler sidecar just to bound ordinary source windows.
  expect(pack.files[0]?.snippets.every((snippet) => snippet.materialization === 'line_window')).toBe(true);
  const reviewed = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect WINDOW_MARKER in the exact known implementation file.',
    searchTerms: ['WINDOW_MARKER'],
    knownPaths: ['src/exact-window.ts'],
    retrievalMode: 'review',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 2,
    maxCharsPerSnippet: 2400,
  });
  expect(reviewed.files[0]?.snippets.some((snippet) => snippet.materialization === 'symbol')).toBe(true);
  expect(pack.readiness.unresolvedReasonCodes).not.toContain('retrieval_truncated');
  expect(pack.readiness.status).toBe('ready');
  expect(pack.readiness.readyForHighConfidenceMutation).toBe(true);
});

test('retains separate explicit code symbols in sync and async discovery beyond the inventory cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-multi-symbol-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 840; index += 1) {
    writeFileSync(join(root, `src/a-noise-${String(index).padStart(2, '0')}.ts`), `export const inspect = ${index};\n`);
  }
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(join(root, `src/b-prefix-${index}.ts`), `export const inspectResourceLeaseLegacy${index} = inspectWorkHandleLegacy${index};\n`);
  }
  writeFileSync(join(root, 'src/zz-first.ts'), 'export function inspectResourceLease() { return 1; }\n');
  writeFileSync(join(root, 'src/zz-second.ts'), 'export function inspectWorkHandle() { return 2; }\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const options = {
    description: 'inspect the two implementation symbols',
    searchTerms: ['inspect inspectResourceLease inspectWorkHandle'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 2,
    maxSnippets: 2,
  } satisfies ControllerContextPackOptions;
  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), options);
  expect(pack.files.map((file) => file.path)).toEqual(['src/zz-first.ts', 'src/zz-second.ts']);
  expect(pack.files.every((file) => file.reasons.some((reason) => reason.startsWith('search:inspect')))).toBe(true);
  expect(pack.search.scannedFiles).toBeLessThan(30);
  const asyncPack = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), options);
  expect(asyncPack.files.map((file) => file.path)).toEqual(pack.files.map((file) => file.path));
  expect(asyncPack.search.scannedFiles).toBeLessThan(30);
});

test('ranks the full natural-language discovery result before applying the bounded candidate budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-discovery-ranking-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(join(root, `src/a-noise-${String(index).padStart(2, '0')}.ts`), "export const unrelated = 'App Store Connect';\n");
  }
  writeFileSync(join(root, 'src/z-release-rejection.ts'), "export const releaseSubmission = 'App Store Connect release rejection submission';\n");
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'App Store Connect release rejection submission',
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 4,
    maxSnippets: 4,
  });

  expect(pack.files.map((file) => file.path)).toContain('src/z-release-rejection.ts');
  expect(pack.files[0]?.path).toBe('src/z-release-rejection.ts');
});
