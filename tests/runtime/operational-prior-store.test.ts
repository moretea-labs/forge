import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CHECK_COMPLETION_GRACE_MAX_MS,
  OPERATIONAL_MEMORY_NAMESPACE,
  dropOperationalMemoryNamespace,
  ingestCheckCompletionGraceProcess,
  resolveCheckCompletionGraceWaitMs,
} from '../../src/runtime/control-plane/persistence/operational-prior-store';
import {
  ControlPlaneConflictError,
  deleteControlPlaneRecord,
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import { durationAwareInteractiveWaitMs } from '../../src/runtime/execution/process-runtime/interactive-admission';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function controllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-operational-memory-'));
  roots.push(root);
  return root;
}

function processRecord(input: { id: string; durationMs: number; environment?: string; status?: 'succeeded' | 'failed' }) {
  const started = Date.parse('2026-09-03T00:00:00.000Z');
  const status = input.status ?? 'succeeded';
  return {
    schemaVersion: 1,
    controllerHome: '/tmp/fixture-controller',
    repoId: 'repo-fixture',
    checkoutId: 'checkout-fixture',
    processId: input.id,
    commandId: `cmd-${input.id}`,
    status,
    command: { kind: 'argv', executable: 'bun', args: ['test'], cwd: '/tmp/repo' },
    origin: { surface: 'check', checkId: 'package:check:type', requestId: `req-${input.id}` },
    checkExecution: {
      cacheKey: `cache-${input.id}`,
      revision: 'revision-a',
      definitionDigest: 'definition-a',
      environmentFingerprint: input.environment ?? 'env-a',
      timeoutMs: 10000,
      reuseScope: 'repository',
      scopeKey: 'repo-fixture',
    },
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started + input.durationMs).toISOString(),
    updatedAt: new Date(started + input.durationMs).toISOString(),
    exitCode: status === 'succeeded' ? 0 : 1,
    timedOut: false,
    cancelled: false,
    terminalWritten: true,
    leaseRefs: [],
    leasesReleased: true,
  } as any;
}

function deps(records: Map<string, any>) {
  return {
    loadProcessRecord: (_controllerHome: string, _repoId: string, processId: string) => records.get(processId),
    now: () => new Date('2026-09-03T00:00:01.000Z'),
  };
}

describe('Stage7F bounded operational Memory', () => {
  test('activates only after three exact retained successful receipts and stays capped at the existing 250ms grace', () => {
    const home = controllerHome();
    const records = new Map<string, any>([
      ['p1', processRecord({ id: 'p1', durationMs: 80 })],
      ['p2', processRecord({ id: 'p2', durationMs: 120 })],
      ['p3', processRecord({ id: 'p3', durationMs: 160 })],
    ]);
    expect(ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p1' }, deps(records))).toMatchObject({ stored: true, readiness: 'insufficient_samples', sampleCount: 1 });
    expect(ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p2' }, deps(records))).toMatchObject({ stored: true, readiness: 'insufficient_samples', sampleCount: 2 });
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBeUndefined();
    expect(ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p3' }, deps(records))).toMatchObject({ stored: true, readiness: 'shadow_candidate', sampleCount: 3 });
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBe(CHECK_COMPLETION_GRACE_MAX_MS);
  });

  test('hard-invalidates by environment and deletes derived state when any support Process evidence is gone', () => {
    const home = controllerHome();
    const records = new Map<string, any>(['p1','p2','p3'].map((id, index) => [id, processRecord({ id, durationMs: 100 + index * 10 })]));
    for (const id of records.keys()) ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: id }, deps(records));
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-b' }, deps(records))).toBeUndefined();
    records.delete('p2');
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBeUndefined();
    expect(listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })).toHaveLength(0);
  });

  test('hard-invalidates when a retained Process id resolves to a different completion receipt', () => {
    const home = controllerHome();
    const records = new Map<string, any>(['p1','p2','p3'].map((id, index) => [id, processRecord({ id, durationMs: 100 + index * 10 })]));
    for (const id of records.keys()) ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: id }, deps(records));
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBe(CHECK_COMPLETION_GRACE_MAX_MS);

    records.set('p2', processRecord({ id: 'p2', durationMs: 220 }));

    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBeUndefined();
    expect(listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })).toHaveLength(0);
  });

  test('drop-and-rebuild reproduces the same bounded consumer decision from retained authoritative Process evidence', () => {
    const home = controllerHome();
    const records = new Map<string, any>(['p1','p2','p3'].map((id, index) => [id, processRecord({ id, durationMs: 90 + index * 20 })]));
    for (const id of records.keys()) ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: id }, deps(records));
    const before = resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records));
    expect(dropOperationalMemoryNamespace(home, 'repo-fixture')).toBe(1);
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBeUndefined();
    for (const id of records.keys()) ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: id }, deps(records));
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBe(before);
  });

  test('drop removes the full operational memory namespace beyond one bounded list page', () => {
    const home = controllerHome();
    for (let index = 0; index < 5_001; index += 1) {
      writeControlPlaneRecord(home, {
        namespace: OPERATIONAL_MEMORY_NAMESPACE,
        scope: 'repo-fixture',
        key: `bulk-${String(index).padStart(4, '0')}`,
        schemaVersion: 1,
        value: { index },
        action: 'test_bulk_seed',
      });
    }

    expect(dropOperationalMemoryNamespace(home, 'repo-fixture')).toBe(5_001);
    expect(listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture', limit: 5_000 })).toHaveLength(0);
  });

  test('deduplicated receipt ingestion does not rewrite the same derived SQLite record', () => {
    const home = controllerHome();
    const records = new Map<string, any>([['p1', processRecord({ id: 'p1', durationMs: 80 })]]);
    ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p1' }, deps(records));
    const first = listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })[0];
    ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p1' }, deps(records));
    const second = listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })[0];
    expect(second.revision).toBe(first.revision);
  });

  test('corrupt derived payload fails open and cannot break run_check policy resolution', () => {
    const home = controllerHome();
    const records = new Map<string, any>([['p1', processRecord({ id: 'p1', durationMs: 80 })]]);
    ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p1' }, deps(records));
    const stored = listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })[0];
    writeControlPlaneRecord(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture', key: stored.key, schemaVersion: 1, value: { schemaVersion: 1, support: [null] }, action: 'test_corruption' });
    expect(() => resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).not.toThrow();
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, deps(records))).toBeUndefined();
  });

  test('oversized or internally inconsistent derived support fails open before replaying Process evidence', () => {
    const home = controllerHome();
    const records = new Map<string, any>([['p1', processRecord({ id: 'p1', durationMs: 80 })]]);
    ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p1' }, deps(records));
    const stored = listControlPlaneRecords<any>(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })[0];
    const originalSupport = stored.value.support[0];
    writeControlPlaneRecord(home, {
      namespace: OPERATIONAL_MEMORY_NAMESPACE,
      scope: 'repo-fixture',
      key: stored.key,
      schemaVersion: 1,
      value: {
        ...stored.value,
        support: Array.from({ length: 33 }, (_, index) => ({ ...originalSupport, processId: `oversized-${index}` })),
      },
      action: 'test_oversized_corruption',
    });
    let loads = 0;
    const guardedDeps = {
      ...deps(records),
      loadProcessRecord: (_controllerHome: string, _repoId: string, processId: string) => {
        loads += 1;
        return records.get(processId);
      },
    };
    expect(resolveCheckCompletionGraceWaitMs({ controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a' }, guardedDeps)).toBeUndefined();
    expect(loads).toBe(0);
    expect(listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })).toHaveLength(0);
  });

  test('raw failed Process receipts do not become latency learning evidence', () => {
    const home = controllerHome();
    const records = new Map<string, any>([['failed', processRecord({ id: 'failed', durationMs: 20, status: 'failed' })]]);
    expect(ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'failed' }, deps(records))).toEqual({ stored: false });
    expect(listControlPlaneRecords(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' })).toHaveLength(0);
  });

  test('explicit interactive wait remains authoritative over any learned completion grace', () => {
    expect(durationAwareInteractiveWaitMs(['bun', 'test'], 0, CHECK_COMPLETION_GRACE_MAX_MS)).toBe(0);
    expect(durationAwareInteractiveWaitMs(['bun', 'test'], 73, CHECK_COMPLETION_GRACE_MAX_MS)).toBe(73);
  });

  test('revision-fenced deletion cannot remove a newer concurrent Controller record', () => {
    const home = controllerHome();
    const first = writeControlPlaneRecord(home, { namespace: 'fixture', scope: 'repo', key: 'key', schemaVersion: 1, value: { value: 1 } });
    const newer = writeControlPlaneRecord(home, { namespace: 'fixture', scope: 'repo', key: 'key', schemaVersion: 1, value: { value: 2 }, expectedRevision: first.revision });
    expect(() => deleteControlPlaneRecord(home, {
      namespace: 'fixture', scope: 'repo', key: 'key', action: 'fixture_stale_delete', expectedRevision: first.revision,
    })).toThrow(ControlPlaneConflictError);
    expect(readControlPlaneRecord<{ value: number }>(home, 'fixture', 'repo', 'key')).toMatchObject({ revision: newer.revision, value: { value: 2 } });
  });

  test('operational Memory materialization does not overwrite a newer concurrent refresh', () => {
    const home = controllerHome();
    const records = new Map<string, any>([
      ['p1', processRecord({ id: 'p1', durationMs: 80 })],
      ['p2', processRecord({ id: 'p2', durationMs: 120 })],
    ]);
    expect(ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p1' }, deps(records))).toMatchObject({ stored: true, sampleCount: 1 });
    const [stored] = listControlPlaneRecords<any>(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' });
    expect(stored).toBeDefined();
    let refreshed = false;
    const racingDeps = {
      ...deps(records),
      loadProcessRecord: (_controllerHome: string, _repoId: string, processId: string) => {
        if (!refreshed && processId === 'p1') {
          refreshed = true;
          writeControlPlaneRecord(home, {
            namespace: OPERATIONAL_MEMORY_NAMESPACE,
            scope: 'repo-fixture',
            key: stored!.key,
            schemaVersion: stored!.schemaVersion,
            value: stored!.value,
            action: 'test_concurrent_refresh',
            expectedRevision: stored!.revision,
          });
        }
        return records.get(processId);
      },
    };
    expect(() => ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p2' }, racingDeps)).toThrow(ControlPlaneConflictError);
    const preserved = readControlPlaneRecord<any>(home, OPERATIONAL_MEMORY_NAMESPACE, 'repo-fixture', stored!.key);
    expect(preserved).toMatchObject({ revision: stored!.revision + 1, value: stored!.value });
  });

  test('operational Memory invalidation cannot delete a newer concurrent replacement', () => {
    const home = controllerHome();
    const records = new Map<string, any>([['p1', processRecord({ id: 'p1', durationMs: 80 })]]);
    expect(ingestCheckCompletionGraceProcess({ controllerHome: home, repoId: 'repo-fixture', processId: 'p1' }, deps(records))).toMatchObject({ stored: true, sampleCount: 1 });
    const [stored] = listControlPlaneRecords<any>(home, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: 'repo-fixture' });
    expect(stored).toBeDefined();
    let replaced = false;
    const racingDeps = {
      ...deps(new Map()),
      loadProcessRecord: () => {
        if (!replaced) {
          replaced = true;
          writeControlPlaneRecord(home, {
            namespace: OPERATIONAL_MEMORY_NAMESPACE,
            scope: 'repo-fixture',
            key: stored!.key,
            schemaVersion: stored!.schemaVersion,
            value: stored!.value,
            action: 'test_concurrent_replacement',
            expectedRevision: stored!.revision,
          });
        }
        return undefined;
      },
    };
    expect(resolveCheckCompletionGraceWaitMs({
      controllerHome: home, repoId: 'repo-fixture', checkId: 'package:check:type', environmentFingerprint: 'env-a',
    }, racingDeps)).toBeUndefined();
    const preserved = readControlPlaneRecord<any>(home, OPERATIONAL_MEMORY_NAMESPACE, 'repo-fixture', stored!.key);
    expect(preserved).toMatchObject({ revision: stored!.revision + 1, value: stored!.value });
  });

  test('generic Controller record deletion preserves monotonic audit revision across recreation', () => {
    const home = controllerHome();
    const first = writeControlPlaneRecord(home, { namespace: 'fixture', scope: 'repo', key: 'key', schemaVersion: 1, value: { value: 1 } });
    expect(first.revision).toBe(1);
    expect(deleteControlPlaneRecord(home, { namespace: 'fixture', scope: 'repo', key: 'key', action: 'fixture_delete' })).toBe(true);
    expect(readControlPlaneRecord(home, 'fixture', 'repo', 'key')).toBeUndefined();
    const recreated = writeControlPlaneRecord(home, { namespace: 'fixture', scope: 'repo', key: 'key', schemaVersion: 1, value: { value: 2 } });
    expect(recreated.revision).toBe(3);
  });
});
