import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildControllerContextPack } from '../../src/cli/controller/context-pack';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { filterGitIgnoredCodeGraphChanges, queryCodeGraphReadProvider, resolveCodeGraphBundledRuntime, type CodeGraphReadProviderResponse } from '../../src/runtime/context/codegraph-read-provider';

const roots: string[] = [];
afterEach(() => {
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
    const runtime = resolveCodeGraphBundledRuntime();
    expect(runtime.platformPackage).toBe(`@colbymchenry/codegraph-${process.platform}-${process.arch}`);
    expect(runtime.nodeExecutable).toContain('@colbymchenry/codegraph-');
    expect(runtime.sidecarPath).toEndWith('codegraph-sidecar.cjs');
    expect(runtime.libraryPath).toContain('@colbymchenry/codegraph-');
    expect(runtime.source).toBe('dependency');
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

  test('ranks an exact code query before saturated broad-token decoys', () => {
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
  });

  test('merges ready structural candidates but still returns current raw source through Forge policy', () => {
    const root = contextRepo();
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'How does runService work?',
      structuralContext: 'auto',
      maxFiles: 4,
    }, { queryCodeGraph: () => structuralResponse() });
    expect(pack.structuralContext).toMatchObject({ requestedMode: 'auto', status: 'ready', requiredSatisfied: true });
    const service = pack.files.find((file) => file.path === 'src/service.ts');
    expect(service?.reasons.some((reason) => reason.startsWith('codegraph:'))).toBe(true);
    expect(service?.snippets[0]?.content).toContain('return 42');
  });

  test('keeps bounded text fallback visible when required structural context is unavailable', () => {
    const root = contextRepo();
    const unavailable = structuralResponse({
      ok: false,
      status: 'unavailable',
      metadata: undefined,
      result: undefined,
      error: { code: 'CODEGRAPH_PLATFORM_BUNDLE_MISSING', message: 'not installed' },
    });
    const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
      description: 'runService',
      searchTerms: ['runService'],
      structuralContext: 'required',
    }, { queryCodeGraph: () => unavailable });
    expect(pack.structuralContext).toMatchObject({ requestedMode: 'required', status: 'unavailable', requiredSatisfied: false });
    expect(pack.next[0]).toContain('Structural context was required');
    expect(pack.files.some((file) => file.path === 'src/service.ts')).toBe(true);
  });

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
