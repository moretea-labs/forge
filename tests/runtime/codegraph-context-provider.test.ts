import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AUTO_STRUCTURAL_PREFETCH_BUDGET_MS, AUTO_STRUCTURAL_PREFETCH_TIMEOUT_MS, buildControllerContextPack, buildControllerContextPackAsync } from '../../src/cli/controller/context-pack';
import { structuralIntentQuery } from '../../src/cli/controller/context/query-planning';
import { clearSourceSymbolIndexCacheForTest, materializeSource, sourceSymbolIndexCacheSnapshotForTest } from '../../src/cli/controller/context/source-materializer';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { clearAllSessionCachesForTest } from '../../src/cli/repository/session-cache';
import {
  clearCodeGraphReadProviderSessionsForTest,
  codeGraphReadProviderSessionSnapshotForTest,
  filterGitIgnoredCodeGraphChanges,
  queryCodeGraphReadProvider,
  queryCodeGraphReadProviderAsync,
  resolveCodeGraphBundledRuntime,
  type CodeGraphReadProviderResponse,
} from '../../src/runtime/context/codegraph-read-provider';

const roots: string[] = [];
afterEach(async () => {
  clearAllSessionCachesForTest();
  clearSourceSymbolIndexCacheForTest();
  await clearCodeGraphReadProviderSessionsForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function contextRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-codegraph-context-pack-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/service.ts'), 'export function runService() { return 42; }\n');
  writeFileSync(join(root, 'README.md'), '# Context test\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

function structuralResponse(overrides: Partial<CodeGraphReadProviderResponse> = {}): CodeGraphReadProviderResponse {
  return {
    schemaVersion: 1,
    provider: 'codegraph',
    operation: 'context',
    ok: true,
    status: 'ready',
    metadata: {
      initialized: true,
      lastIndexedAt: 1,
      buildVersion: '1.0.1',
      extractionVersion: 1,
      staleEngine: false,
      changedFiles: { added: [], modified: [], removed: [] },
    },
    result: {
      nodes: [{ id: 'node-service', kind: 'function', name: 'runService', qualifiedName: 'src/service.ts::runService', filePath: 'src/service.ts', language: 'typescript', startLine: 1, endLine: 1 }],
      entryPoints: [{ id: 'node-service', kind: 'function', name: 'runService', qualifiedName: 'src/service.ts::runService', filePath: 'src/service.ts', language: 'typescript', startLine: 1, endLine: 1 }],
      relatedFiles: ['src/service.ts'],
      truncated: false,
    },
    timingsMs: { total: 2, process: 1, open: 0.5, query: 0.5 },
    ...overrides,
  };
}

describe('CodeGraph read provider', () => {
  test('resolves the matching self-contained CodeGraph runtime without using the Forge Node baseline', () => {
    const runtime = resolveCodeGraphBundledRuntime({ runtimeRoot: join(tmpdir(), 'forge-codegraph-no-release') });
    expect(runtime.platformPackage).toBe(`@colbymchenry/codegraph-${process.platform}-${process.arch}`);
    expect(runtime.nodeExecutable).toContain('@colbymchenry/codegraph-');
    expect(runtime.sidecarPath).toEndWith('codegraph-sidecar.cjs');
    expect(runtime.libraryPath).toContain('@colbymchenry/codegraph-');
    expect(runtime.source).toBe('dependency');
  });

  test('uses the Runtime-authority release path for a co-located CodeGraph runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-codegraph-release-env-'));
    roots.push(root);
    writeFileSync(join(root, 'codegraph-node'), 'node');
    chmodSync(join(root, 'codegraph-node'), 0o700);
    writeFileSync(join(root, 'codegraph-sidecar.cjs'), 'sidecar');
    mkdirSync(join(root, 'codegraph-lib', 'dist'), { recursive: true });
    writeFileSync(join(root, 'codegraph-lib', 'dist', 'index.js'), 'library');
    const previous = process.env.FORGE_RELEASE_PATH;
    process.env.FORGE_RELEASE_PATH = root;
    try {
      expect(resolveCodeGraphBundledRuntime()).toMatchObject({
        nodeExecutable: join(root, 'codegraph-node'),
        sidecarPath: join(root, 'codegraph-sidecar.cjs'),
        libraryPath: join(root, 'codegraph-lib', 'dist', 'index.js'),
        source: 'release',
      });
    } finally {
      if (previous === undefined) delete process.env.FORGE_RELEASE_PATH;
      else process.env.FORGE_RELEASE_PATH = previous;
    }
  });

  test('publishes supported CodeGraph platform bundles as optional runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../..', 'package.json'), 'utf8')) as {
      optionalDependencies?: Record<string, string>;
    };
    for (const target of [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]) {
      expect(manifest.optionalDependencies?.[`@colbymchenry/codegraph-${target}`]).toBe('1.0.1');
    }
  });

  test('prefers one complete co-located immutable-release CodeGraph runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-codegraph-release-'));
    roots.push(root);
    writeFileSync(join(root, 'codegraph-node'), 'node');
    chmodSync(join(root, 'codegraph-node'), 0o700);
    writeFileSync(join(root, 'codegraph-sidecar.cjs'), 'sidecar');
    mkdirSync(join(root, 'codegraph-lib', 'dist'), { recursive: true });
    writeFileSync(join(root, 'codegraph-lib', 'dist', 'index.js'), 'library');
    expect(resolveCodeGraphBundledRuntime({ runtimeRoot: root })).toMatchObject({
      nodeExecutable: join(root, 'codegraph-node'),
      sidecarPath: join(root, 'codegraph-sidecar.cjs'),
      libraryPath: join(root, 'codegraph-lib', 'dist', 'index.js'),
      source: 'release',
    });
  });

  test('fails closed before spawning for operations outside the read-only protocol', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-codegraph-invalid-'));
    roots.push(root);
    const response = queryCodeGraphReadProvider(root, { operation: 'sync' as never });
    expect(response).toMatchObject({ ok: false, status: 'degraded', error: { code: 'CODEGRAPH_OPERATION_NOT_ALLOWED' } });
  });

  test('reuses one Runtime-owned async sidecar without caching structural results', async () => {
    const root = contextRepo();
    const first = await queryCodeGraphReadProviderAsync(root, { operation: 'status' });
    const second = await queryCodeGraphReadProviderAsync(root, { operation: 'status' });
    expect(first).toMatchObject({ provider: 'codegraph', operation: 'status', status: 'unavailable' });
    expect(second).toMatchObject({ provider: 'codegraph', operation: 'status', status: 'unavailable' });
    expect(codeGraphReadProviderSessionSnapshotForTest()).toEqual({
      active: 1,
      spawns: 1,
      reuses: 1,
      requests: 2,
    });
  });

  test('does not make a structural index stale for Git-ignored operational paths', () => {
    const root = contextRepo();
    writeFileSync(join(root, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'ignore operational files'], { cwd: root });
    const metadata = filterGitIgnoredCodeGraphChanges(root, {
      initialized: true,
      lastIndexedAt: 1,
      buildVersion: '1.0.1',
      extractionVersion: 24,
      staleEngine: false,
      changedFiles: {
        added: ['ignored/generated.js'],
        modified: ['src/service.ts'],
        removed: ['ignored/old.js'],
      },
    });
    expect(metadata.changedFiles).toEqual({ added: [], modified: ['src/service.ts'], removed: [] });
    expect(metadata.ignoredChangedFileCount).toBe(2);
  });

  test('reports an uninitialized project without creating a CodeGraph index', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-codegraph-empty-'));
    roots.push(root);
    const response = queryCodeGraphReadProvider(root, { operation: 'status' });
    expect(response).toMatchObject({ ok: false, status: 'unavailable', metadata: { initialized: false } });
  });

  test('keeps short structural intents exact and compacts long intents around code anchors', () => {
    const short = 'callRuntimeTool MCP dispatch';
    expect(structuralIntentQuery(short)).toBe(short);

    const long = 'Investigate the current Runtime MCP dispatch implementation and impact closure. Find the authoritative implementation of callRuntimeTool in src/runtime/gateway/mcp/runtime-tools.ts, all relevant dispatch and execution paths, current callers, compatibility delegates, related tests, and any duplicate or legacy mechanism that could remain reachable after a change.';
    const compact = structuralIntentQuery(long);
    expect(compact.length).toBeLessThan(long.length);
    expect(compact).toContain('callRuntimeTool');
    expect(compact).toContain('src/runtime/gateway/mcp/runtime-tools.ts');
    expect(compact).not.toContain('compatibility delegates');
  });

  test('does no CodeGraph work when structural context is omitted/default-off', () => {
    const root = contextRepo();
    let calls = 0;
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'run service',
      searchTerms: ['runService'],
    }, {
      queryCodeGraph: () => {
        calls += 1;
        throw new Error('provider must not be called');
      },
    });
    expect(calls).toBe(0);
    expect(pack.structuralContext).toMatchObject({ requestedMode: 'off', status: 'disabled', requiredSatisfied: true });
    expect(pack.impactContext).toMatchObject({ status: 'not_requested', freshness: { structuralStatus: 'disabled', changedFileCount: 0 } });
  });

  test('scans lexical candidates once for multiple Context Pack search terms', () => {
    const root = contextRepo();
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      searchTerms: ['runService', 'return 42'],
      includeGlobs: ['src/**'],
      structuralContext: 'off',
    });
    expect(pack.files.some((file) => file.path === 'src/service.ts')).toBe(true);
    expect(pack.files.find((file) => file.path === 'src/service.ts')?.reasons).toEqual(
      expect.arrayContaining(['search:runService', 'search:return 42']),
    );
    expect(pack.search.scannedFiles).toBe(1);
  });

  test('scopes implementation lexical retrieval to exact known files', () => {
    const root = contextRepo();
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(root, `src/decoy-${index}.ts`), `export const runServiceDecoy${index} = true;\n`);
    }
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      searchTerms: ['runService'],
      knownPaths: ['src/service.ts'],
      structuralContext: 'off',
      retrievalMode: 'implementation',
    });
    expect(pack.files[0]?.path).toBe('src/service.ts');
    expect(pack.files[0]?.reasons).toEqual(expect.arrayContaining(['explicit-known-path', 'search:runService']));
    expect(pack.search.scannedFiles).toBe(2); // one known-path expansion + one targeted lexical read
  });

  test('keeps async first-pass lexical prefetch scoped to exact known implementation files', async () => {
    const root = contextRepo();
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(join(root, `src/async-decoy-${index}.ts`), `export const runServiceAsyncDecoy${index} = true;\n`);
    }
    const pack = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      searchTerms: ['runService'],
      knownPaths: ['src/service.ts'],
      structuralContext: 'off',
      retrievalMode: 'implementation',
      session: { sessionId: 'async-exact-known-scope', repoId: 'repo-a', checkoutId: 'checkout-a' },
    });
    expect(pack.timingsMs.parallelFirstPass).toBe(true);
    expect(pack.files[0]?.path).toBe('src/service.ts');
    expect(pack.files[0]?.reasons).toEqual(expect.arrayContaining(['explicit-known-path', 'search:runService']));
    expect(pack.search.scannedFiles).toBe(2); // one known-path expansion + one targeted lexical read
    expect(pack.search.cacheHit).toBe(true); // sync materialization consumes the targeted async prefetch result
  });

  test('resolves root-to-nearest AGENTS.md and CLAUDE.md guidance without consuming exact source budget', () => {
    const root = contextRepo();
    mkdirSync(join(root, 'src/feature'), { recursive: true });
    mkdirSync(join(root, 'sibling'), { recursive: true });
    writeFileSync(join(root, 'src/feature/deep.ts'), 'export const deepTarget = true;\n');
    writeFileSync(join(root, 'AGENTS.md'), 'root agent guidance\n');
    writeFileSync(join(root, 'src/CLAUDE.md'), 'src claude guidance\n');
    writeFileSync(join(root, 'src/feature/AGENTS.md'), 'feature agent guidance\n');
    writeFileSync(join(root, 'sibling/AGENTS.md'), 'sibling guidance must not apply\n');

    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      knownPaths: ['src/feature/deep.ts'],
      structuralContext: 'off',
      maxFiles: 1,
      maxSnippets: 1,
    });

    expect(pack.files.map((file) => file.path)).toEqual(['src/feature/deep.ts']);
    expect(pack.limits).toMatchObject({ requestedMaxFiles: 1, maxFiles: 1 });
    expect(pack.instructionContext).toMatchObject({
      status: 'ready',
      authority: 'guidance_only',
      targetPaths: ['src/feature/deep.ts'],
      truncated: false,
    });
    expect(pack.instructionContext.contracts.map((entry) => entry.path)).toEqual([
      'AGENTS.md',
      'src/CLAUDE.md',
      'src/feature/AGENTS.md',
    ]);
    expect(pack.instructionContext.contracts.map((entry) => entry.content)).toEqual([
      'root agent guidance\n',
      'src claude guidance\n',
      'feature agent guidance\n',
    ]);
    expect(pack.instructionContext.contracts.some((entry) => entry.path === 'sibling/AGENTS.md')).toBe(false);
    expect(pack.contextContract.semanticSufficiencyAuthority).toBe('chatgpt');
    expect(pack.contextContract.notes.some((note) => note.includes('guidance-only evidence'))).toBe(true);
    expect(pack.instructionContext.contracts.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(48_000);
  });

  test('resolves guidance for a structurally selected source path without widening to sibling contracts', () => {
    const root = contextRepo();
    mkdirSync(join(root, 'src/feature'), { recursive: true });
    mkdirSync(join(root, 'src/other'), { recursive: true });
    writeFileSync(join(root, 'src/feature/deep.ts'), 'export function deepRun() { return 1; }\n');
    writeFileSync(join(root, 'AGENTS.md'), 'root guidance\n');
    writeFileSync(join(root, 'src/feature/CLAUDE.md'), 'feature guidance\n');
    writeFileSync(join(root, 'src/other/AGENTS.md'), 'other guidance\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'nested guidance'], { cwd: root });

    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'deepRun implementation',
      structuralContext: 'auto',
      maxFiles: 2,
    }, {
      queryCodeGraph: (_repoRoot, request) => request.operation === 'file_dependencies'
        ? structuralResponse({ operation: 'file_dependencies', result: { filePath: 'src/feature/deep.ts', dependencies: [], dependents: [] } })
        : structuralResponse({
            result: {
              nodes: [{ id: 'node-deep', kind: 'function', name: 'deepRun', qualifiedName: 'src/feature/deep.ts::deepRun', filePath: 'src/feature/deep.ts', language: 'typescript', startLine: 1, endLine: 1 }],
              entryPoints: [{ id: 'node-deep', kind: 'function', name: 'deepRun', qualifiedName: 'src/feature/deep.ts::deepRun', filePath: 'src/feature/deep.ts', language: 'typescript', startLine: 1, endLine: 1 }],
              relatedFiles: ['src/feature/deep.ts'],
              truncated: false,
            },
          }),
    });

    expect(pack.files.some((file) => file.path === 'src/feature/deep.ts')).toBe(true);
    expect(pack.instructionContext.targetPaths).toContain('src/feature/deep.ts');
    expect(pack.instructionContext.contracts.map((entry) => entry.path)).toEqual(['AGENTS.md', 'src/feature/CLAUDE.md']);
    expect(pack.instructionContext.contracts.some((entry) => entry.path === 'src/other/AGENTS.md')).toBe(false);
  });

  test('reserves file and snippet budget for every exact known file', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'src/alpha.ts'), 'export const alpha = true;\n');
    writeFileSync(join(root, 'src/beta.ts'), 'export const beta = true;\n');
    const exactPaths = ['src/service.ts', 'src/alpha.ts', 'src/beta.ts'];
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      knownPaths: exactPaths,
      structuralContext: 'off',
      maxFiles: 1,
      maxSnippets: 1,
    });
    expect(pack.files.map((file) => file.path).sort()).toEqual([...exactPaths].sort());
    expect(pack.coverage.exactKnownPaths).toEqual({
      requested: exactPaths,
      materialized: expect.arrayContaining(exactPaths),
      missing: [],
    });
    expect(pack.limits).toMatchObject({
      requestedMaxFiles: 1,
      requestedMaxSnippets: 1,
      maxFiles: 3,
      maxSnippets: 3,
      reservedExactKnownFiles: 3,
    });
  });

  test('skips Git gitlink directories during sync and async Context lexical discovery', async () => {
    const root = contextRepo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    mkdirSync(join(root, 'vendor', 'gitlink'), { recursive: true });
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/gitlink`], { cwd: root });
    const options = {
      searchTerms: ['runService'],
      knownPaths: ['src', 'missing-context-file.ts'],
      structuralContext: 'off' as const,
      retrievalMode: 'debug' as const,
      maxFiles: 8,
      maxSnippets: 16,
    };

    const syncPack = buildControllerContextPack(root, getMcpPolicy('controller'), options);
    expect(syncPack.files.some((file) => file.path === 'src/service.ts')).toBe(true);
    expect(syncPack.deniedPaths).toContainEqual({ path: 'missing-context-file.ts', reason: 'path does not exist: missing-context-file.ts' });

    const asyncPack = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      ...options,
      session: { sessionId: 'gitlink-directory-inventory', repoId: 'repo-a', checkoutId: 'checkout-a' },
    });
    expect(asyncPack.files.some((file) => file.path === 'src/service.ts')).toBe(true);
    expect(asyncPack.deniedPaths).toContainEqual({ path: 'missing-context-file.ts', reason: 'path does not exist: missing-context-file.ts' });
  });

  test('does not let a known directory starve an exact known file', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'zeta.ts'), 'export const zeta = true;\n');
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      knownPaths: ['src', 'zeta.ts'],
      structuralContext: 'off',
      maxFiles: 1,
      maxSnippets: 1,
    });
    expect(pack.files.map((file) => file.path)).toEqual(['zeta.ts']);
    expect(pack.coverage.exactKnownPaths).toEqual({
      requested: ['zeta.ts'],
      materialized: ['zeta.ts'],
      missing: [],
    });
    expect(pack.limits).toMatchObject({
      maxFiles: 1,
      maxSnippets: 1,
      reservedExactKnownFiles: 1,
    });
    expect(pack.omitted).toContainEqual({ path: 'src/service.ts', reason: 'max_files' });
  });

  test('reuses lexical and source materialization across progressive session calls', () => {
    const root = contextRepo();
    const session = { sessionId: 'context-session-a', repoId: 'repo-a', checkoutId: 'checkout-a' };
    const options = {
      searchTerms: ['runService'],
      includeGlobs: ['src/**'],
      structuralContext: 'off' as const,
      session,
    };
    const first = buildControllerContextPack(root, getMcpPolicy('controller'), options);
    const second = buildControllerContextPack(root, getMcpPolicy('controller'), options);
    expect(first.cache).toMatchObject({ sessionBound: true, lexicalHit: false, rangeHits: 0, reused: false });
    expect(second.cache).toMatchObject({ sessionBound: true, lexicalHit: true, rangeHits: 1, rangeMisses: 0, reused: true });
    expect(second.search.cacheHit).toBe(true);
    expect(second.coverage.inspectedFiles).toContain('src/service.ts');
  });

  test('reuses a content-addressed source symbol index and misses after the file SHA changes', () => {
    const root = contextRepo();
    const path = 'src/large-cache-target.ts';
    const source = [
      ...Array.from({ length: 260 }, (_, index) => `export const prefix${index} = ${index};`),
      'export function cachedFunction() {',
      '  const cacheNeedle = 1;',
      '  return cacheNeedle;',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(root, path), source);
    clearSourceSymbolIndexCacheForTest();
    const options = {
      repoRoot: root,
      policy: getMcpPolicy('controller'),
      path,
      hitLines: [262],
      reasons: ['cache-test'],
      maxSnippets: 2,
      maxCharsPerSnippet: 50_000,
    };

    const first = materializeSource(options);
    expect(first[0]?.materialization).toBe('symbol');
    expect(sourceSymbolIndexCacheSnapshotForTest()).toEqual({ entries: 1, hits: 0, misses: 1 });

    const second = materializeSource(options);
    expect(second[0]?.content).toBe(first[0]?.content);
    expect(sourceSymbolIndexCacheSnapshotForTest()).toEqual({ entries: 1, hits: 1, misses: 1 });

    writeFileSync(join(root, path), `${source}\nexport const changedAfterCache = true;\n`);
    materializeSource(options);
    expect(sourceSymbolIndexCacheSnapshotForTest()).toEqual({ entries: 2, hits: 1, misses: 2 });
  });

  test('materializes a complete matched function instead of a fixed line window', () => {
    const root = contextRepo();
    const prefix = Array.from({ length: 250 }, (_, index) => `export const prefix${index} = ${index};`);
    const body = Array.from({ length: 80 }, (_, index) => index === 40
      ? '  const semanticNeedle = "inside-long-function";'
      : `  const local${index} = ${index};`);
    writeFileSync(join(root, 'src/large-service.ts'), [
      ...prefix,
      'export function completeLongFunction() {',
      ...body,
      '  return semanticNeedle;',
      '}',
      '',
    ].join('\n'));
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      searchTerms: ['semanticNeedle'],
      knownPaths: ['src/large-service.ts'],
      structuralContext: 'off',
      maxCharsPerSnippet: 50_000,
    });
    const snippet = pack.files[0]?.snippets[0];
    expect(snippet).toMatchObject({
      materialization: 'symbol',
      symbol: { kind: 'function', name: 'completeLongFunction' },
    });
    expect(snippet?.content).toContain('export function completeLongFunction()');
    expect(snippet?.content).toContain('return semanticNeedle;');
    expect((snippet?.endLine ?? 0) - (snippet?.startLine ?? 0)).toBeGreaterThan(80);
    expect(pack.coverage.materialization.symbols).toBe(1);
  });

  test('keeps broad lexical discovery when an exact known file is paired with impact analysis', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'src/reminder.ts'), 'export const scheduleReminder = true;\n');
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      searchTerms: ['runService'],
      knownPaths: ['src/service.ts'],
      impactDomains: ['scheduler'],
      structuralContext: 'off',
      retrievalMode: 'implementation',
    });
    expect(pack.search.scannedFiles).toBeGreaterThan(2);
    expect(pack.files.some((file) => file.path === 'src/reminder.ts')).toBe(true);
  });

  test('expands GPT-selected impact domains in one bounded lexical pass without claiming semantic completeness', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'src/medication-plan.ts'), 'export const medicationPlan = { time: "09:30" };\n');
    writeFileSync(join(root, 'src/reminder-scheduler.ts'), 'export function scheduleReminder() { return medicationPlanTime; }\n');
    writeFileSync(join(root, 'src/notification.ts'), 'export function pushNotification() { return true; }\n');
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'change medicationPlan effective time',
      searchTerms: ['medicationPlan'],
      includeGlobs: ['src/**'],
      impactDomains: ['scheduler', 'notification', 'concurrency'],
      structuralContext: 'off',
      maxFiles: 6,
    });
    expect(pack.search.impactDomains).toEqual(['scheduler', 'notification', 'concurrency']);
    expect(pack.search.terms[0]).toBe('medicationPlan');
    expect(pack.search.impactCoverage.find((entry) => entry.domain === 'scheduler')).toMatchObject({ status: 'selected' });
    expect(pack.search.impactCoverage.find((entry) => entry.domain === 'notification')).toMatchObject({ status: 'selected' });
    expect(pack.search.impactCoverage.find((entry) => entry.domain === 'concurrency')).toMatchObject({ status: 'no_evidence' });
    expect(pack.files.find((file) => file.path === 'src/reminder-scheduler.ts')?.reasons.some((reason) => reason.startsWith('impact:scheduler:'))).toBe(true);
    expect(pack.files.find((file) => file.path === 'src/notification.ts')?.reasons.some((reason) => reason.startsWith('impact:notification:'))).toBe(true);
    expect(pack.contextContract.semanticSufficiencyAuthority).toBe('chatgpt');
    expect(pack.contextContract.expansionSignals).toContain('impact_domain_without_evidence:concurrency');
  });

  test('keeps optional auto structural prefetch within a small first-call budget and a separate hard provider timeout', () => {
    expect(AUTO_STRUCTURAL_PREFETCH_BUDGET_MS).toBe(100);
    expect(AUTO_STRUCTURAL_PREFETCH_TIMEOUT_MS).toBe(1_000);
  });

  test('defers slow auto structural enrichment without cancelling warm-cache population', async () => {
    const root = contextRepo();
    const session = { sessionId: 'context-auto-budget', repoId: 'repo-a', checkoutId: 'checkout-a' };
    let asyncCalls = 0;
    const delayedMs = AUTO_STRUCTURAL_PREFETCH_BUDGET_MS * 3;
    const queryCodeGraphAsync = async () => {
      asyncCalls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayedMs));
      return structuralResponse();
    };
    const queryCodeGraph = (_repoRoot: string, request: Parameters<typeof queryCodeGraphReadProvider>[1]) => request.operation === 'file_dependencies'
      ? structuralResponse({ operation: 'file_dependencies', result: { filePath: request.filePath, dependencies: [], dependents: [] } })
      : structuralResponse();

    const firstStartedAt = performance.now();
    const first = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      description: 'runService',
      searchTerms: ['runService'],
      structuralContext: 'auto',
      session,
    }, { queryCodeGraph, queryCodeGraphAsync });
    const firstElapsedMs = performance.now() - firstStartedAt;
    expect(first.structuralContext).toMatchObject({ requestedMode: 'auto', status: 'degraded', requiredSatisfied: true });
    expect(first.structuralContext.fallbackReason).toContain('CODEGRAPH_PREFETCH_DEFERRED');
    expect(first.timingsMs.structuralPrefetchBudgetMs).toBe(AUTO_STRUCTURAL_PREFETCH_BUDGET_MS);
    expect(first.timingsMs.structuralPrefetchDeferred).toBe(true);
    expect(firstElapsedMs).toBeLessThan(delayedMs);

    const immediateStartedAt = performance.now();
    const immediate = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      description: 'runService',
      searchTerms: ['runService'],
      structuralContext: 'auto',
      session,
    }, { queryCodeGraph, queryCodeGraphAsync });
    expect(immediate.structuralContext.status).toBe('degraded');
    expect(immediate.timingsMs.structuralPrefetchDeferred).toBe(true);
    expect(immediate.timingsMs.structuralPrefetchReusedInFlight).toBe(true);
    expect(performance.now() - immediateStartedAt).toBeLessThan(AUTO_STRUCTURAL_PREFETCH_BUDGET_MS);
    expect(asyncCalls).toBe(1);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayedMs + 25));
    const second = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      description: 'runService',
      searchTerms: ['runService'],
      structuralContext: 'auto',
      session,
    }, { queryCodeGraph, queryCodeGraphAsync });
    expect(second.structuralContext.status).toBe('ready');
    expect(second.cache.structuralHits).toBeGreaterThan(0);
    expect(second.timingsMs.structuralPrefetchDeferred).toBe(false);
    expect(asyncCalls).toBe(1);
  });

  test('required structural mode still waits for the requested structural evidence', async () => {
    const root = contextRepo();
    const session = { sessionId: 'context-required-wait', repoId: 'repo-a', checkoutId: 'checkout-a' };
    const delayedMs = AUTO_STRUCTURAL_PREFETCH_BUDGET_MS + 50;
    const queryCodeGraphAsync = async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayedMs));
      return structuralResponse();
    };
    const queryCodeGraph = (_repoRoot: string, request: Parameters<typeof queryCodeGraphReadProvider>[1]) => request.operation === 'file_dependencies'
      ? structuralResponse({ operation: 'file_dependencies', result: { filePath: request.filePath, dependencies: [], dependents: [] } })
      : structuralResponse();
    const pack = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      description: 'runService',
      searchTerms: ['runService'],
      structuralContext: 'required',
      session,
    }, { queryCodeGraph, queryCodeGraphAsync });
    expect(pack.structuralContext).toMatchObject({ requestedMode: 'required', status: 'ready', requiredSatisfied: true });
    expect(pack.timingsMs.structuralPrefetchDeferred).toBe(false);
    expect(pack.timingsMs.parallelPrefetch ?? 0).toBeGreaterThanOrEqual(AUTO_STRUCTURAL_PREFETCH_BUDGET_MS);
  });

  test('does not let an in-flight auto request weaken required structural semantics', async () => {
    const root = contextRepo();
    const session = { sessionId: 'context-mode-fence', repoId: 'repo-a', checkoutId: 'checkout-a' };
    let autoCalls = 0;
    let requiredCalls = 0;
    const queryCodeGraphAsync = async (_repoRoot: string, _request: Parameters<typeof queryCodeGraphReadProvider>[1], options: { timeoutMs?: number } = {}) => {
      if (options.timeoutMs === AUTO_STRUCTURAL_PREFETCH_TIMEOUT_MS) {
        autoCalls += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, AUTO_STRUCTURAL_PREFETCH_BUDGET_MS * 3));
      } else {
        requiredCalls += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      return structuralResponse();
    };
    const queryCodeGraph = (_repoRoot: string, request: Parameters<typeof queryCodeGraphReadProvider>[1]) => request.operation === 'file_dependencies'
      ? structuralResponse({ operation: 'file_dependencies', result: { filePath: request.filePath, dependencies: [], dependents: [] } })
      : structuralResponse();
    const auto = buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      description: 'runService', searchTerms: ['runService'], structuralContext: 'auto', session,
    }, { queryCodeGraph, queryCodeGraphAsync });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const required = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      description: 'runService', searchTerms: ['runService'], structuralContext: 'required', session,
    }, { queryCodeGraph, queryCodeGraphAsync });
    expect(required.structuralContext).toMatchObject({ requestedMode: 'required', status: 'ready', requiredSatisfied: true });
    expect(required.timingsMs.structuralPrefetchReusedInFlight).toBe(false);
    expect(autoCalls).toBe(1);
    expect(requiredCalls).toBe(1);
    await auto;
  });

  test('ranks an exact code query before saturated broad-token decoys', async () => {
    const root = contextRepo();
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(root, `src/a-decoy-${String(index).padStart(2, '0')}.ts`), `export const classifyCommandRoute${index} = true;\n`);
    }
    writeFileSync(join(root, 'src/z-target.ts'), 'export function classifyRepositoryCommandRoute() { return true; }\n');
    const query = 'classifyRepositoryCommandRoute';
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: query,
      searchTerms: [query],
      includeGlobs: ['src/**/*.ts'],
      maxFiles: 1,
      maxSnippets: 2,
    });
    expect(pack.search.terms[0]).toBe(query);
    expect(pack.files[0]?.path).toBe('src/z-target.ts');
    expect(pack.files[0]?.reasons).toContain(`search:${query}`);
    const asyncPack = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), {
      description: query,
      searchTerms: [query],
      includeGlobs: ['src/**/*.ts'],
      maxFiles: 1,
      maxSnippets: 2,
      session: { sessionId: 'exact-code-query', repoId: 'repo-a', checkoutId: 'checkout-a' },
    });
    expect(asyncPack.files[0]?.path).toBe('src/z-target.ts');

    const pascalRoot = contextRepo();
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(pascalRoot, `src/b-client-decoy-${String(index).padStart(2, '0')}.ts`), `export const ClientDecoy${index} = true;\n`);
    }
    writeFileSync(join(pascalRoot, 'src/z-client-target.ts'), 'export class Client { readonly connected = true; }\n');
    const pascalQuery = 'Client';
    const pascalPack = buildControllerContextPack(pascalRoot, getMcpPolicy('controller'), {
      description: pascalQuery,
      searchTerms: [pascalQuery],
      includeGlobs: ['src/**/*.ts'],
      maxFiles: 1,
      maxSnippets: 2,
    });
    expect(pascalPack.files[0]?.path).toBe('src/z-client-target.ts');
    const asyncPascalPack = await buildControllerContextPackAsync(pascalRoot, getMcpPolicy('controller'), {
      description: pascalQuery,
      searchTerms: [pascalQuery],
      includeGlobs: ['src/**/*.ts'],
      maxFiles: 1,
      maxSnippets: 2,
      session: { sessionId: 'exact-pascal-query', repoId: 'repo-a', checkoutId: 'checkout-a' },
    });
    expect(asyncPascalPack.files[0]?.path).toBe('src/z-client-target.ts');
  });

  test('builds bounded impact context from ready structural entry points and file dependents', () => { const root = contextRepo(); writeFileSync(join(root, 'src/helper.ts'), 'export const helper = true;\n'); mkdirSync(join(root, 'tests'), { recursive: true }); writeFileSync(join(root, 'tests/service.test.ts'), "import { runService } from '../src/service';\nvoid runService();\n"); const pack = buildControllerContextPack(root, getMcpPolicy('controller'), { description: 'How does runService work?', structuralContext: 'auto', maxFiles: 6 }, { queryCodeGraph: (_repoRoot, request) => request.operation === 'file_dependencies' ? structuralResponse({ operation: 'file_dependencies', result: { filePath: 'src/service.ts', dependencies: ['src/helper.ts'], dependents: ['tests/service.test.ts'] } }) : structuralResponse() }); expect(pack.structuralContext).toMatchObject({ requestedMode: 'auto', status: 'ready', requiredSatisfied: true }); expect(pack.impactContext).toMatchObject({ status: 'ready', confidence: 'high', primaryTargets: ['src/service.ts'], relevantTests: ['tests/service.test.ts'], freshness: { structuralStatus: 'ready', changedFileCount: 0 } }); expect(pack.impactContext.mustInspect).toEqual(expect.arrayContaining(['src/service.ts', 'src/helper.ts', 'tests/service.test.ts'])); expect(pack.impactContext.relationSources).toEqual(expect.arrayContaining(['codegraph', 'lexical'])); expect(pack.files.find((file) => file.path === 'src/helper.ts')?.reasons).toContain('codegraph:dependency:src/service.ts'); expect(pack.files.find((file) => file.path === 'tests/service.test.ts')?.reasons).toContain('codegraph:dependent:src/service.ts'); const service = pack.files.find((file) => file.path === 'src/service.ts'); expect(service?.reasons.some((reason) => reason.startsWith('codegraph:'))).toBe(true); expect(service?.snippets[0]?.content).toContain('return 42'); });

  test('reuses structural queries in the same progressive session', () => {
    const root = contextRepo();
    const session = { sessionId: 'context-session-graph', repoId: 'repo-a', checkoutId: 'checkout-a' };
    let calls = 0;
    const queryCodeGraph = (_repoRoot: string, request: Parameters<typeof queryCodeGraphReadProvider>[1]) => {
      calls += 1;
      return request.operation === 'file_dependencies'
        ? structuralResponse({ operation: 'file_dependencies', result: { filePath: 'src/service.ts', dependencies: [], dependents: [] } })
        : structuralResponse();
    };
    const options = { description: 'runService', structuralContext: 'auto' as const, session };
    const first = buildControllerContextPack(root, getMcpPolicy('controller'), options, { queryCodeGraph });
    const firstCalls = calls;
    const second = buildControllerContextPack(root, getMcpPolicy('controller'), options, { queryCodeGraph });
    expect(firstCalls).toBeGreaterThan(0);
    expect(calls).toBe(firstCalls);
    expect(first.cache.structuralMisses).toBe(firstCalls);
    expect(first.cache.structuralHits).toBeGreaterThan(0);
    expect(second.cache.structuralMisses).toBe(0);
    expect(second.cache.structuralHits).toBeGreaterThanOrEqual(firstCalls);
    expect(second.cache.reused).toBe(true);
  });

  test('filters unrelated mobile and scratch graph entry points from runtime impact authority', () => {
    const root = contextRepo();
    mkdirSync(join(root, 'src/runtime'), { recursive: true });
    mkdirSync(join(root, 'scratch/ios'), { recursive: true });
    writeFileSync(join(root, 'src/runtime/router.ts'), 'export function routeRuntime() { return true; }\n');
    writeFileSync(join(root, 'scratch/ios/device.ts'), 'export function routeDevice() { return true; }\n');
    const runtimeNode = { id: 'runtime', kind: 'function', name: 'routeRuntime', qualifiedName: 'routeRuntime', filePath: 'src/runtime/router.ts', language: 'typescript', startLine: 1, endLine: 1 };
    const mobileNode = { id: 'mobile', kind: 'function', name: 'routeDevice', qualifiedName: 'routeDevice', filePath: 'scratch/ios/device.ts', language: 'typescript', startLine: 1, endLine: 1 };
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'runtime command routing',
      structuralContext: 'auto',
    }, {
      queryCodeGraph: (_repoRoot, request) => request.operation === 'file_dependencies'
        ? structuralResponse({ operation: 'file_dependencies', result: { filePath: request.filePath, dependencies: [], dependents: [] } })
        : structuralResponse({ result: { nodes: [mobileNode, runtimeNode], entryPoints: [mobileNode, runtimeNode], relatedFiles: [mobileNode.filePath, runtimeNode.filePath], truncated: false } }),
    });
    expect(pack.impactContext.primaryTargets).toEqual(['src/runtime/router.ts']);
    expect(pack.structuralContext.entryPoints.map((entry) => entry.filePath)).not.toContain('scratch/ios/device.ts');
  });

  test('keeps bounded text fallback visible when required structural context is unavailable', () => { const root = contextRepo(); const unavailable = structuralResponse({ ok: false, status: 'unavailable', metadata: undefined, result: undefined, error: { code: 'CODEGRAPH_PLATFORM_BUNDLE_MISSING', message: 'not installed' } }); const pack = buildControllerContextPack(root, getMcpPolicy('controller'), { description: 'runService', searchTerms: ['runService'], structuralContext: 'required' }, { queryCodeGraph: () => unavailable }); expect(pack.structuralContext).toMatchObject({ requestedMode: 'required', status: 'unavailable', requiredSatisfied: false }); expect(pack.impactContext).toMatchObject({ status: 'degraded', confidence: 'medium' }); expect(pack.readiness).toMatchObject({ status: 'insufficient', structural: { requested: 'required', status: 'unavailable', requiredSatisfied: false }, readyForHighConfidenceMutation: false }); expect(pack.readiness.unresolvedReasonCodes).toContain('required_structural_context_unsatisfied'); expect(pack.impactContext.coverageGaps).toContain('structural_provider_unavailable'); expect(pack.next[0]).toContain('Structural context was required'); expect(pack.files.some((file) => file.path === 'src/service.ts')).toBe(true); });

  test('materializes source-derived Wave 2 and Wave 3 evidence in one context-pack call', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'src/service.ts'), "import { helper } from './helper';\nexport const ENTRY_MARKER = helper();\n");
    writeFileSync(join(root, 'src/helper.ts'), "import { deepValue } from './deep';\nexport function helper() { return deepValue; }\n");
    writeFileSync(join(root, 'src/deep.ts'), 'export const deepValue = 42;\n');
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests/helper.test.ts'), "import { helper } from '../src/helper';\nvoid helper;\n");
    const serviceNode = { id: 'node-service', kind: 'function', name: 'ENTRY_MARKER', qualifiedName: 'src/service.ts::ENTRY_MARKER', filePath: 'src/service.ts', language: 'typescript', startLine: 2, endLine: 2 };
    const calls: string[] = [];
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), { description: 'Trace ENTRY_MARKER implementation and its related tests', searchTerms: ['ENTRY_MARKER'], retrievalMode: 'review', structuralContext: 'auto', maxFiles: 6, maxSnippets: 12 }, {
      queryCodeGraph: (_repoRoot, request) => {
        if (request.operation !== 'file_dependencies') return structuralResponse({ result: { nodes: [serviceNode], entryPoints: [serviceNode], relatedFiles: ['src/service.ts'], truncated: false } });
        calls.push(request.filePath ?? '');
        if (request.filePath === 'src/helper.ts') return structuralResponse({ operation: 'file_dependencies', result: { filePath: 'src/helper.ts', dependencies: [], dependents: ['tests/helper.test.ts'] } });
        return structuralResponse({ operation: 'file_dependencies', result: { filePath: request.filePath, dependencies: [], dependents: [] } });
      },
    });
    expect(calls).toEqual(expect.arrayContaining(['src/service.ts', 'src/helper.ts']));
    expect(pack.expansion).toMatchObject({ waveCount: 3, expansionPerformed: true, expansionBudgetUsed: 3 });
    expect(pack.expansion.materializedPaths).toEqual(expect.arrayContaining(['src/helper.ts', 'src/deep.ts', 'tests/helper.test.ts']));
    expect(pack.files.find((file) => file.path === 'src/helper.ts')?.reasons).toContain('source-reference:src/service.ts');
    expect(pack.files.find((file) => file.path === 'src/deep.ts')?.reasons).toContain('source-reference:src/helper.ts');
    expect(pack.files.find((file) => file.path === 'tests/helper.test.ts')?.reasons).toContain('codegraph:dependent:src/helper.ts');
    expect(pack.impactContext.relevantTests).toContain('tests/helper.test.ts');
    expect(pack.timingsMs.waveCount).toBe(3);
  });

  test('does not add an adaptive wave for simple structural-off local retrieval', () => {
    const root = contextRepo();
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), { searchTerms: ['runService'], structuralContext: 'off', maxFiles: 4 });
    expect(pack.expansion).toMatchObject({ waveCount: 1, expansionPerformed: false, expansionBudgetUsed: 0 });
    expect(pack.readiness.structural).toMatchObject({ requested: 'off', status: 'disabled', requiredSatisfied: true });
  });

  test('allows default implementation retrieval to close concrete source relationships in the same request', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'src/service.ts'), "import { helper } from './helper';\nexport function runService() { return helper(); }\n");
    writeFileSync(join(root, 'src/helper.ts'), 'export function helper() { return 42; }\n');
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'Implement runService safely with current structural evidence',
      searchTerms: ['runService'],
      retrievalMode: 'implementation',
      structuralContext: 'auto',
      maxFiles: 4,
      maxSnippets: 8,
    }, {
      queryCodeGraph: (_repoRoot, request) => request.operation === 'file_dependencies'
        ? structuralResponse({ operation: 'file_dependencies', result: { filePath: request.filePath, dependencies: [], dependents: [] } })
        : structuralResponse(),
    });
    expect(pack.expansion.expansionPerformed).toBe(true);
    expect(pack.expansion.materializedPaths).toContain('src/helper.ts');
    expect(pack.files.find((file) => file.path === 'src/helper.ts')?.reasons).toContain('source-reference:src/service.ts');
  });

  test('keeps unmaterialized expansion evidence explicit when the bounded file budget is exhausted', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'src/service.ts'), "import './alpha';\nimport './beta';\nexport const ENTRY_MARKER = true;\n");
    writeFileSync(join(root, 'src/alpha.ts'), 'export const alpha = true;\n');
    writeFileSync(join(root, 'src/beta.ts'), 'export const beta = true;\n');
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), { description: 'Review ENTRY_MARKER', searchTerms: ['ENTRY_MARKER'], retrievalMode: 'review', structuralContext: 'off', maxFiles: 2, maxSnippets: 4 });
    expect(pack.expansion.expansionPerformed).toBe(true);
    expect(pack.expansion.discoveredPaths).toEqual(expect.arrayContaining(['src/alpha.ts', 'src/beta.ts']));
    expect(pack.contextContract.expansionSignals).toContain('evidence_expansion_budget_exhausted');
    expect(pack.readiness.unresolvedReasonCodes).toContain('expansion_budget_exhausted');
    expect(pack.coverage.likelyRelatedNotInspected.length).toBeGreaterThan(0);
    expect(pack.readiness).toMatchObject({ status: 'insufficient', readyForHighConfidenceMutation: false });
  });

  test('keeps stale structural relationships diagnostic-only instead of promoting them into source selection', () => {
    const root = contextRepo();
    writeFileSync(join(root, 'src/stale-only.ts'), 'export const staleOnly = true;\n');
    writeFileSync(join(root, 'src/provider-changed.ts'), 'export const providerChanged = true;\n');
    const staleNode = {
      id: 'stale-node',
      kind: 'function',
      name: 'staleOnly',
      qualifiedName: 'src/stale-only.ts::staleOnly',
      filePath: 'src/stale-only.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const stale = structuralResponse({
      status: 'stale',
      metadata: {
        initialized: true,
        lastIndexedAt: 1,
        buildVersion: '1.0.1',
        extractionVersion: 1,
        staleEngine: false,
        changedFiles: { added: [], modified: ['src/provider-changed.ts'], removed: [] },
      },
      result: {
        nodes: [staleNode],
        entryPoints: [staleNode],
        relatedFiles: ['src/stale-only.ts', 'src/provider-changed.ts'],
        truncated: false,
      },
    });
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'runService',
      searchTerms: ['runService'],
      structuralContext: 'required',
      maxFiles: 4,
    }, { queryCodeGraph: () => stale });
    expect(pack.structuralContext).toMatchObject({ status: 'stale', requiredSatisfied: false });
    expect(pack.structuralContext.overlayChangedFiles).toContain('src/provider-changed.ts');
    expect(pack.impactContext.primaryTargets).toEqual([]);
    expect(pack.impactContext.structuralHints).toEqual(expect.arrayContaining(['src/stale-only.ts', 'src/provider-changed.ts']));
    expect(pack.files.some((file) => file.path === 'src/stale-only.ts')).toBe(false);
    expect(pack.files.some((file) => file.path === 'src/provider-changed.ts')).toBe(false);
    expect(pack.files.some((file) => file.reasons.some((reason) => reason.startsWith('codegraph:')))).toBe(false);
    expect(pack.files.find((file) => file.path === 'src/service.ts')?.reasons).toContain('search:runService');
  });

  test('runs lexical fallback when stale required structural candidates already saturate discovery', () => {
    const root = contextRepo();
    const noiseFiles = Array.from({ length: 16 }, (_, index) => `noise/changed-${index}.ts`);
    mkdirSync(join(root, 'noise'), { recursive: true });
    for (const path of noiseFiles) writeFileSync(join(root, path), `export const changed${path.match(/\d+/)?.[0] ?? 'x'} = true;\n`);
    const stale = structuralResponse({
      status: 'stale',
      metadata: {
        initialized: true,
        lastIndexedAt: 1,
        buildVersion: '1.0.1',
        extractionVersion: 1,
        staleEngine: false,
        changedFiles: { added: noiseFiles, modified: [], removed: [] },
      },
      result: { nodes: [], entryPoints: [], relatedFiles: [], truncated: false },
    });
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'runService',
      searchTerms: ['runService'],
      structuralContext: 'required',
      maxFiles: 4,
    }, { queryCodeGraph: () => stale });
    expect(pack.structuralContext).toMatchObject({ requestedMode: 'required', status: 'stale', requiredSatisfied: false });
    expect(pack.readiness).toMatchObject({ status: 'insufficient', readyForHighConfidenceMutation: false });
    expect(pack.readiness.unresolvedReasonCodes).toContain('required_structural_context_unsatisfied');
    expect(pack.search.scannedFiles).toBeGreaterThan(0);
    expect(pack.files[0]?.path).toBe('src/service.ts');
    expect(pack.files[0]?.reasons).toContain('search:runService');
  });

  test('reuses a repository CodeGraph as explicit baseline while current worktree changes stay raw/lexical', () => { const root = contextRepo(); const baselineRoot = mkdtempSync(join(tmpdir(), 'forge-codegraph-baseline-')); roots.push(baselineRoot); execFileSync('git', ['clone', '-q', root, baselineRoot]); writeFileSync(join(root, 'src/service.ts'), 'export function runService() { return 43; }\n'); const queriedRoots: string[] = []; const pack = buildControllerContextPack(root, getMcpPolicy('controller'), { description: 'runService', structuralContext: 'required', structuralIndexRoot: baselineRoot }, { queryCodeGraph: (queryRoot, request) => { queriedRoots.push(queryRoot); return request.operation === 'file_dependencies' ? structuralResponse({ operation: 'file_dependencies', result: { filePath: 'src/service.ts', dependencies: [], dependents: [] } }) : structuralResponse(); } }); expect(new Set(queriedRoots)).toEqual(new Set([baselineRoot])); expect(pack.structuralContext).toMatchObject({ indexSource: 'repository_baseline', status: 'stale', requiredSatisfied: false, baselineRevisionMatches: true }); expect(pack.structuralContext.overlayChangedFiles).toContain('src/service.ts'); expect(pack.impactContext).toMatchObject({ primaryTargets: [], structuralHints: ['src/service.ts'], mustInspect: [] }); expect(pack.impactContext.coverageGaps).toContain('structural_repository_baseline_overlay'); expect(pack.impactContext.freshness).toMatchObject({ indexSource: 'repository_baseline', overlayChangedFileCount: 1, baselineRevisionMatches: true }); expect(pack.files.find((file) => file.path === 'src/service.ts')?.reasons).toContain('worktree:changed-file'); expect(pack.files.find((file) => file.path === 'src/service.ts')?.snippets[0]?.content).toContain('return 43'); });

  test('rechecks graph-selected paths through Forge policy before returning source', () => {
    const root = contextRepo();
    const outside = structuralResponse({
      result: {
        nodes: [{ id: 'outside', kind: 'function', name: 'outside', qualifiedName: '../outside.ts::outside', filePath: '../outside.ts', language: 'typescript', startLine: 1, endLine: 1 }],
        entryPoints: [],
        relatedFiles: ['../outside.ts'],
        truncated: false,
      },
    });
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'outside',
      structuralContext: 'auto',
    }, { queryCodeGraph: () => outside });
    expect(pack.files.some((file) => file.path === '../outside.ts')).toBe(false);
    expect(pack.deniedPaths.some((entry) => entry.path.includes('outside.ts'))).toBe(true);
  });

  test('queries the existing Forge index read-only when it is present', () => {
    const dbPath = join(process.cwd(), '.codegraph', 'codegraph.db');
    let before: number;
    try {
      before = statSync(dbPath).mtimeMs;
    } catch {
      return;
    }
    const response = queryCodeGraphReadProvider(process.cwd(), {
      operation: 'context',
      query: 'buildControllerContextPack repository context',
      maxNodes: 24,
      limit: 8,
    }, { timeoutMs: 30_000 });
    expect(response.ok).toBe(true);
    expect(['ready', 'stale']).toContain(response.status);
    expect(Array.isArray(response.result?.nodes)).toBe(true);
    expect((response.result?.nodes as unknown[]).length).toBeGreaterThan(0);
    expect(statSync(dbPath).mtimeMs).toBe(before);
  });
});
