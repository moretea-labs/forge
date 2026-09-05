import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  GlobalScheduler,
  selectSchedulerSourceScanRepositories,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { planSchedulerSourceSampling } from '../../src/runtime/control-plane/global-scheduler/source-scan';
import type { SchedulerPeriodicCleanupSpawnResult } from '../../src/runtime/control-plane/global-scheduler/periodic-cleanup-process';
import {
  cleanupControllerRuntimeState,
  runtimeCleanupLogPath,
  type RuntimeCleanupReport,
} from '../../src/runtime/control-plane/runtime-cleanup';
import { applyRuntimeCleanup, previewRuntimeCleanup } from '../../src/runtime/maintenance/cleanup';
import { codegraphRepositoryCacheRoot, createCodegraphCacheLocator } from '../../src/runtime/context/codegraph-cache-boundary';
import {
  activateConvergenceWorkAdmission,
  activateExclusiveWorkAdmission,
} from '../../src/runtime/control-plane/facade/work-admission-policy';
import { markRepositoryProjectionDirty, repositoryProjectionIsDirty } from '../../src/runtime/projections/invalidation';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { registerRepository, removeRepository } from '../../src/cli/repositories/registry';
import { cleanupRetiredRepositoryNamespaces } from '../../src/runtime/control-plane/repository-namespace-retention';
import { resolveGitExecutable } from '../../src/effects/git-executable';
import { ensureManagedWorkspace } from '../../src/runtime/execution/managed-workspace';
import { cleanupStaleWorkVerificationSnapshots } from '../../src/runtime/control-plane/execution/work-verification-snapshot';
import { cleanupTerminalEditSessionRecords } from '../../src/cli/editing/edit-session';
import { ensureRepositoryRuntimeStorage } from '../../src/cli/repositories/runtime-storage';
import { createSchedule, saveOccurrence } from '../../packages/kernel/scheduler/api/index';
import { createWorkContract } from '../../packages/kernel/work/api/index';

const homes: string[] = [];

function controllerHome(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-runtime-cleanup-'));
  homes.push(value);
  return value;
}

function cleanupEntries(home: string): RuntimeCleanupReport[] {
  const path = runtimeCleanupLogPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeCleanupReport);
}

function writeDaemonState(home: string, pid: number): void {
  mkdirSync(join(home, 'daemon'), { recursive: true });
  writeFileSync(join(home, 'daemon', 'controller.pid'), `${pid}\n`, 'utf8');
  writeFileSync(join(home, 'daemon', 'state.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    pid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function age(path: string, ageMs = 8 * 60 * 60_000): void {
  const old = new Date(Date.now() - ageMs);
  utimesSync(path, old, old);
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('runtime cleanup', () => {
  test('verification snapshot retention protects active Work and reclaims only stale bounded evidence', () => {
    const home = controllerHome();
    const root = join(repositoryControllerRoot(home, 'repo-snapshots'), 'verification-snapshots');
    const active = join(root, 'snapshot-active-a');
    const stale = join(root, 'snapshot-stale-b');
    const fresh = join(root, 'snapshot-fresh-c');
    for (const path of [active, stale, fresh]) mkdirSync(join(path, '.ai/harness/controller'), { recursive: true });
    writeFileSync(join(active, '.ai/harness/controller/work-verification-snapshot.json'), JSON.stringify({ schemaVersion: 1, workId: 'work-active' }));
    writeFileSync(join(stale, '.ai/harness/controller/work-verification-snapshot.json'), JSON.stringify({ schemaVersion: 1, workId: 'work-stale' }));
    writeFileSync(join(fresh, '.ai/harness/controller/work-verification-snapshot.json'), JSON.stringify({ schemaVersion: 1, workId: 'work-fresh' }));
    writeFileSync(join(stale, 'payload.bin'), 'reclaim-me');
    age(active); age(stale);

    const report = cleanupStaleWorkVerificationSnapshots(home, 'repo-snapshots', { protectedWorkIds: ['work-active'], maxEntries: 10, maxRemovals: 10 });

    expect(existsSync(active)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(report.protected).toBe(1);
    expect(report.skippedByReason.active_work).toBe(1);
    expect(report.removedPaths).toEqual(['snapshot-stale-b']);
    expect(report.reclaimedBytes).toBeGreaterThanOrEqual(Buffer.byteLength('reclaim-me'));
    expect(report.policyVersion).toBe('runtime-lifecycle-retention-v1');
  });

  test('scheduler history retention physically bounds unindexed terminal occurrence evidence and protects active state', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-scheduler-retention-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.name', 'Test']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.email', 'test@example.com']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'README.md'), 'scheduler retention\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'README.md']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'scheduler-retention' });
    const schedule = createSchedule(home, {
      requestId: 'scheduler-retention-request', repoId: repository.repoId, name: 'scheduler retention', enabled: true,
      trigger: { type: 'manual' },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: true },
      action: { operation: 'runtime_maintenance_apply', target: 'runtime', arguments: {} }, stopConditions: [],
    });
    const now = new Date().toISOString();
    saveOccurrence(home, {
      schemaVersion: 1, revision: 0, occurrenceId: 'OCC-ACTIVE', scheduleId: schedule.scheduleId, repoId: repository.repoId,
      windowKey: 'active', status: 'running', decision: 'execute', createdAt: now, updatedAt: now,
    });

    const schedules = join(repositoryControllerRoot(home, repository.repoId), 'schedules');
    const occurrenceRoot = join(schedules, 'occurrences');
    const decisionRoot = join(schedules, 'decisions');
    mkdirSync(occurrenceRoot, { recursive: true });
    mkdirSync(decisionRoot, { recursive: true });
    const staleOccurrence = join(occurrenceRoot, 'OCC-STALE.json');
    const unindexedActive = join(occurrenceRoot, 'OCC-UNINDEXED-ACTIVE.json');
    const staleDecision = join(decisionRoot, 'DEC-STALE.json');
    writeFileSync(staleOccurrence, JSON.stringify({
      schemaVersion: 1, revision: 1, occurrenceId: 'OCC-STALE', scheduleId: schedule.scheduleId, repoId: repository.repoId,
      windowKey: 'stale', status: 'succeeded', decision: 'execute', createdAt: now, updatedAt: now,
    }));
    writeFileSync(unindexedActive, JSON.stringify({
      schemaVersion: 1, revision: 1, occurrenceId: 'OCC-UNINDEXED-ACTIVE', scheduleId: schedule.scheduleId, repoId: repository.repoId,
      windowKey: 'active-unindexed', status: 'running', decision: 'execute', createdAt: now, updatedAt: now,
    }));
    writeFileSync(staleDecision, JSON.stringify({
      schemaVersion: 1, revision: 1, decisionId: 'DEC-STALE', occurrenceId: 'OCC-STALE', scheduleId: schedule.scheduleId,
      repoId: repository.repoId, requestId: `${schedule.requestId}:stale`, decision: 'execute', createdAt: now,
    }));

    const report = cleanupControllerRuntimeState(home, { reason: 'manual', maxEntries: 200, maxRemovals: 20 });

    expect(existsSync(join(occurrenceRoot, 'OCC-ACTIVE.json'))).toBe(true);
    expect(existsSync(unindexedActive)).toBe(true);
    expect(existsSync(staleOccurrence)).toBe(false);
    expect(existsSync(staleDecision)).toBe(false);
    expect(report.removedScheduleOccurrencePaths).toContain(`repositories/${repository.repoId}/schedules/occurrences/OCC-STALE.json`);
    expect(report.removedScheduleDecisionPaths).toContain(`repositories/${repository.repoId}/schedules/decisions/DEC-STALE.json`);
    expect(report.lifecycleMetrics.reclaimedByClass.scheduler_occurrence_history.count).toBe(2);
    expect(report.lifecycleMetrics.reclaimedByClass.scheduler_occurrence_history.bytes).toBeGreaterThan(0);
    expect(report.lifecycleMetrics.reclaimedByClass.scheduler_occurrence_history.unknownByteCount).toBe(0);
    expect(report.cycle.skippedByReason.scheduler_active_occurrence_unindexed).toBeGreaterThanOrEqual(1);
  });

  test('retires only explicit disposable Controller Home children for a removed repository and preserves semantic/audit history', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-namespace-retention-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.name', 'Test']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.email', 'test@example.com']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'README.md'), 'namespace retention\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'README.md']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'namespace-retention' });
    const namespace = repositoryControllerRoot(home, repository.repoId);
    mkdirSync(join(namespace, 'indexes'), { recursive: true });
    writeFileSync(join(namespace, 'indexes', 'stale.bin'), 'rebuildable');
    mkdirSync(join(namespace, 'audit'), { recursive: true });
    writeFileSync(join(namespace, 'audit', 'keep.jsonl'), '{\"history\":true}\n');
    mkdirSync(join(namespace, 'controller'), { recursive: true });
    writeFileSync(join(namespace, 'controller', 'keep.json'), '{}');
    mkdirSync(join(namespace, 'jobs'), { recursive: true });
    writeFileSync(join(namespace, 'jobs', 'keep.json'), '{}');
    removeRepository(repository.repoId, home);

    const report = cleanupControllerRuntimeState(home, {
      reason: 'manual',
      nowMs: Date.now() + 2 * 60_000,
      repositoryNamespaceRetentionMs: 60_000,
      maxEntries: 500,
      maxRemovals: 50,
    });

    expect(existsSync(join(namespace, 'indexes'))).toBe(false);
    expect(existsSync(join(namespace, 'audit', 'keep.jsonl'))).toBe(true);
    expect(existsSync(join(namespace, 'controller', 'keep.json'))).toBe(true);
    expect(existsSync(join(namespace, 'jobs', 'keep.json'))).toBe(true);
    expect(report.removedRepositoryNamespacePaths).toContain(`repositories/${repository.repoId}/indexes`);
    expect(report.lifecycleMetrics.reclaimedByClass.repository_controller_home_namespace.count).toBeGreaterThan(0);
  });

  test('repository namespace retirement fails closed while a Work remains active', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-namespace-active-work-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.name', 'Test']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.email', 'test@example.com']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'README.md'), 'active work protection\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'README.md']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'namespace-active-work' });
    createWorkContract({ controllerHome: home, repoId: repository.repoId }, {
      workId: 'WORK-NAMESPACE-ACTIVE', repoId: repository.repoId, checkoutId: repository.checkouts[0]!.checkoutId,
      mode: 'goal_workloop', objective: 'protect namespace while Work is active',
      acceptanceCriteria: [], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'system', status: 'ready',
    });
    const namespace = repositoryControllerRoot(home, repository.repoId);
    mkdirSync(join(namespace, 'indexes'), { recursive: true });
    writeFileSync(join(namespace, 'indexes', 'active.bin'), 'keep');
    removeRepository(repository.repoId, home);

    const report = cleanupRetiredRepositoryNamespaces(home, {
      nowMs: Date.now() + 2 * 60_000, graceMs: 60_000, maxEntries: 100, maxRemovals: 20,
    });

    expect(existsSync(join(namespace, 'indexes', 'active.bin'))).toBe(true);
    expect(report.removedPaths).toEqual([]);
    expect(report.skippedByReason.active_work).toBeGreaterThanOrEqual(1);
  });

  test('repository namespace retirement honors a zero removal budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-namespace-zero-budget-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'README.md'), 'zero budget\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'README.md']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'namespace-zero-budget' });
    const namespace = repositoryControllerRoot(home, repository.repoId);
    mkdirSync(join(namespace, 'indexes'), { recursive: true });
    writeFileSync(join(namespace, 'indexes', 'stale.bin'), 'keep');
    removeRepository(repository.repoId, home);

    const report = cleanupRetiredRepositoryNamespaces(home, {
      nowMs: Date.now() + 2 * 60_000, graceMs: 60_000, maxEntries: 100, maxRemovals: 0,
    });

    expect(existsSync(join(namespace, 'indexes', 'stale.bin'))).toBe(true);
    expect(report.removedPaths).toEqual([]);
    expect(report.budgetExhausted).toBe(true);
    expect(report.skippedByReason.cleanup_budget_exhausted).toBeGreaterThanOrEqual(1);
  });

  test('central cleanup protects active checkout CodeGraph caches and reclaims retired rebuildable cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-codegraph-retention-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.name', 'Test']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.email', 'test@example.com']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'README.md'), 'codegraph retention\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'README.md']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'codegraph-retention' });
    const active = codegraphRepositoryCacheRoot(home, repository.canonicalRoot);
    const retiredRoot = join(root, 'retired-worktree');
    const retired = codegraphRepositoryCacheRoot(home, retiredRoot);
    for (const path of [active, retired]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'index.bin'), 'cache');
      age(path);
    }

    const liveLocator = createCodegraphCacheLocator(repository.canonicalRoot, home, { createTarget: false });
    expect(liveLocator).not.toBeNull();
    const deadLocator = join(repositoryRoot, '.codegraph-forge-99999999-deadbeef');
    symlinkSync(active, deadLocator, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const report = cleanupControllerRuntimeState(home, {
        reason: 'manual',
        nowMs: Date.now(),
        maxEntries: 200,
        maxRemovals: 20,
        codegraphCacheRetentionMs: 60_000,
      });

      expect(existsSync(active)).toBe(true);
      expect(existsSync(retired)).toBe(false);
      expect(existsSync(deadLocator)).toBe(false);
      expect(existsSync(liveLocator!.path)).toBe(true);
      expect(report.removedCodegraphLocatorPaths).toContain(join(realpathSync(repositoryRoot), '.codegraph-forge-99999999-deadbeef'));
      expect(report.removedCodegraphCachePaths).toContain(`tool-cache/codegraph/${retired.split('/').pop()}`);
      expect(report.lifecycleMetrics.reclaimedByClass.codegraph_cache.count).toBe(1);
      expect(report.lifecycleMetrics.reclaimedByClass.codegraph_cache.bytes).toBeGreaterThan(0);
      expect(report.cycle.skippedByReason.codegraph_cache_active_locator).toBeGreaterThanOrEqual(1);
    } finally {
      liveLocator?.release();
    }
  });

  test('edit-session retention keeps active authority and bounds terminal Controller Home artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-edit-session-retention-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.name', 'Test']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.email', 'test@example.com']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'README.md'), 'edit session retention\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'README.md']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'edit-session-retention' });
    createWorkContract({ controllerHome: home, repoId: repository.repoId }, {
      workId: 'WORK-ACTIVE', repoId: repository.repoId, checkoutId: repository.checkouts[0]!.checkoutId,
      mode: 'goal_workloop', objective: 'protect terminal edit-session evidence while Work remains active',
      acceptanceCriteria: [], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'system', status: 'ready',
    });
    const storage = ensureRepositoryRuntimeStorage(repository, home);
    expect(storage.readyForExecution).toBe(true);
    const editRoot = join(repositoryRoot, '.ai', 'harness', 'edit-sessions');
    const nowMs = Date.now();
    const old = new Date(nowMs - 8 * 24 * 60 * 60_000).toISOString();
    const writeSession = (sessionId: string, status: string, workId?: string) => {
      const dir = join(editRoot, sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'session.json'), JSON.stringify({ schemaVersion: 3, sessionId, purpose: sessionId, status, workId, createdAt: old, updatedAt: old }));
      writeFileSync(join(dir, 'changes.patch'), `${sessionId}\n`);
      return dir;
    };
    const stale = writeSession('EDIT-1000-stale', 'finalized');
    const protectedByWork = writeSession('EDIT-1001-protected', 'finalized', 'WORK-ACTIVE');
    const open = writeSession('EDIT-1002-open', 'open');

    const direct = cleanupTerminalEditSessionRecords(repositoryRoot, {
      nowMs, retentionMs: 24 * 60 * 60_000, maxRetained: 200, maxEntries: 100, maxRemovals: 10,
      protectedWorkIds: ['WORK-ACTIVE'],
    });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(protectedByWork)).toBe(true);
    expect(existsSync(open)).toBe(true);
    expect(direct.skippedByReason.active_work).toBe(1);
    expect(direct.skippedByReason.active_session).toBe(1);

    const central = writeSession('EDIT-1003-central', 'superseded');
    const report = cleanupControllerRuntimeState(home, {
      reason: 'manual', nowMs, maxEntries: 200, maxRemovals: 20,
      editSessionRetentionMs: 24 * 60 * 60_000, editSessionMaxRetained: 200,
    });
    expect(existsSync(central)).toBe(false);
    expect(existsSync(protectedByWork)).toBe(true);
    expect(existsSync(open)).toBe(true);
    expect(report.removedEditSessionPaths).toContain(`repositories/${repository.repoId}/edit-sessions/EDIT-1003-central`);
    expect(report.lifecycleMetrics.reclaimedByClass.edit_session.count).toBe(1);
    expect(report.lifecycleMetrics.reclaimedByClass.edit_session.bytes).toBeGreaterThan(0);
    expect(report.lifecycleMetrics.reclaimedByClass.edit_session.unknownByteCount).toBe(0);
  });

  test('emits versioned lifecycle reclaim metrics by resource class without changing cleanup authority', () => {
    const home = controllerHome();
    mkdirSync(join(home, 'daemon'), { recursive: true });
    const stale = join(home, 'daemon', 'lifecycle-metric.tmp');
    writeFileSync(stale, 'measured-retention-bytes\n', 'utf8');
    age(stale);

    const report = cleanupControllerRuntimeState(home, { reason: 'manual', maxEntries: 100, maxRemovals: 10 });

    expect(report.policyVersion).toBe('runtime-lifecycle-retention-v1');
    expect(report.lifecycleMetrics.reclaimedByClass.runtime_temp.count).toBeGreaterThanOrEqual(1);
    expect(report.lifecycleMetrics.reclaimedByClass.runtime_temp.bytes).toBeGreaterThanOrEqual(Buffer.byteLength('measured-retention-bytes\n'));
    expect(report.lifecycleMetrics.reclaimedByClass.runtime_temp.unknownByteCount).toBe(0);
    expect(report.lifecycleMetrics.reclaimedCount).toBeGreaterThanOrEqual(1);
    expect(report.lifecycleMetrics.reclaimedBytes).toBeGreaterThanOrEqual(Buffer.byteLength('measured-retention-bytes\n'));
    expect(existsSync(stale)).toBe(false);
  });

  test('protects the current Controller PID even when command identity differs', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_001);

    const report = cleanupControllerRuntimeState(home, {
      protectedControllerPid: 41_001,
      inspectProcess: () => ({ alive: true, commandLine: '/usr/bin/sleep 100' }),
    });

    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(true);
    expect(report.removedPidFiles).toEqual([]);
    expect(report.skippedPidFiles).toContain('daemon/controller.pid');
  });

  test('protects an immutable release daemon.js process for the exact Controller Home', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_004);

    const report = cleanupControllerRuntimeState(home, {
      inspectProcess: () => ({
        alive: true,
        commandLine: `/opt/forge/releases/release-1/daemon.js --controller-home ${home} --owner-epoch 42`,
      }),
    });

    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(true);
    expect(report.removedPidFiles).toEqual([]);
    expect(report.skippedPidFiles).toContain('daemon/controller.pid');
    const state = JSON.parse(readFileSync(join(home, 'daemon', 'state.json'), 'utf8')) as { status: string };
    expect(state.status).toBe('ready');
  });

  test('does not accept a bundled daemon command for a sibling Controller Home', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_005);

    const report = cleanupControllerRuntimeState(home, {
      inspectProcess: () => ({
        alive: true,
        commandLine: `/opt/forge/releases/release-1/daemon.js --controller-home ${home}-other --owner-epoch 42`,
      }),
    });

    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(false);
    expect(report.removedPidFiles).toContain('daemon/controller.pid');
  });

  test('removes a reused PID reference without signaling the unrelated live process', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_002);
    let inspections = 0;

    const report = cleanupControllerRuntimeState(home, {
      inspectProcess: () => {
        inspections += 1;
        return { alive: true, commandLine: '/usr/bin/sleep 100' };
      },
    });

    expect(inspections).toBe(1);
    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(false);
    expect(report.removedPidFiles).toContain('daemon/controller.pid');
    const state = JSON.parse(readFileSync(join(home, 'daemon', 'state.json'), 'utf8')) as { status: string };
    expect(state.status).toBe('stopped');
  });

  test('fails closed when a live PID command identity cannot be inspected', () => {
    const home = controllerHome();
    writeDaemonState(home, 41_003);

    const report = cleanupControllerRuntimeState(home, {
      inspectProcess: () => ({ alive: true }),
    });

    expect(existsSync(join(home, 'daemon', 'controller.pid'))).toBe(true);
    expect(report.skippedPidFiles).toContain('daemon/controller.pid');
    expect(report.errors.some((entry) => entry.includes('command identity is unavailable'))).toBe(true);
  });

  test('scheduler periodic cleanup removes expired temp state and orphaned worktrees without touching active ones', async () => {
    const home = controllerHome();
    const activeWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-active');
    const orphanWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-orphaned');
    const runMetaPath = join(home, 'repositories', 'repo-a', 'runs', 'RUN-active', 'meta.json');
    const staleTempPath = join(home, 'repositories', 'repo-a', 'execution-jobs', 'records', 'job.json.123.tmp');
    mkdirSync(activeWorktree, { recursive: true });
    mkdirSync(orphanWorktree, { recursive: true });
    mkdirSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-active'), { recursive: true });
    mkdirSync(join(home, 'repositories', 'repo-a', 'execution-jobs', 'records'), { recursive: true });
    writeFileSync(runMetaPath, `${JSON.stringify({
      schemaVersion: 3,
      runId: 'RUN-active',
      issueId: 'ISS-1',
      taskId: 'T1',
      agent: 'codex',
      provider: 'local',
      executionMode: 'worktree',
      status: 'running',
      repoRoot: '/repo',
      worktree: activeWorktree,
      branch: 'controller/branch',
      baseRevision: 'HEAD',
      promptPath: 'prompt.md',
      stdoutPath: 'stdout.log',
      stderrPath: 'stderr.log',
      resultPath: 'result.json',
      eventsPath: 'events.jsonl',
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    writeFileSync(staleTempPath, 'temporary\n', 'utf8');
    age(activeWorktree);
    age(orphanWorktree);
    age(staleTempPath);

    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    await scheduler.tick();

    expect(existsSync(activeWorktree)).toBe(true);
    expect(existsSync(orphanWorktree)).toBe(false);
    expect(existsSync(staleTempPath)).toBe(false);

    const periodic = cleanupEntries(home).find((entry) => entry.reason === 'periodic');
    expect(periodic?.removedWorktrees).toContain('repositories/repo-a/worktrees/RUN-orphaned');
    expect(periodic?.removedTemporaryPaths).toContain('repositories/repo-a/execution-jobs/records/job.json.123.tmp');
    expect(periodic?.skippedActiveWorktrees).toContain('repositories/repo-a/worktrees/RUN-active');
  });

  test('periodic cleanup migrates an idle legacy physical node_modules copy to canonical dependency reuse', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-dependency-migration-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.name', 'Test']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.email', 'test@example.com']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'package.json'), '{"name":"fixture","private":true,"dependencies":{"commander":"1.0.0"}}\n');
    writeFileSync(join(repositoryRoot, 'bun.lock'), '# lock\n');
    mkdirSync(join(repositoryRoot, 'node_modules', 'commander'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'node_modules', 'commander', 'package.json'), '{"name":"commander"}\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'package.json', 'bun.lock']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'dependency-migration' });
    const workspace = ensureManagedWorkspace(home, repository, { requestId: 'dependency-migration', title: 'dependency migration' });
    const dependencyPath = join(workspace.root!, 'node_modules');
    rmSync(dependencyPath, { recursive: true, force: true });
    mkdirSync(join(dependencyPath, 'legacy-copy'), { recursive: true });
    writeFileSync(join(dependencyPath, 'legacy-copy', 'marker'), 'legacy\n');

    const report = cleanupControllerRuntimeState(home, { reason: 'periodic', maxEntries: 200, maxRemovals: 20, periodicSequence: 0 });
    expect(lstatSync(dependencyPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(dependencyPath)).toBe(realpathSync(join(repositoryRoot, 'node_modules')));
    expect(report.migratedDependencyPaths.some((entry) => entry.includes('node_modules'))).toBe(true);
  });

  test('periodic cleanup preserves a legacy physical dependency copy while its checkout has an active workspace lease', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-dependency-lease-'));
    homes.push(root);
    const home = join(root, 'controller');
    const repositoryRoot = join(root, 'repository');
    mkdirSync(repositoryRoot, { recursive: true });
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'init', '-b', 'main']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.name', 'Test']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'config', 'user.email', 'test@example.com']).status).toBe(0);
    writeFileSync(join(repositoryRoot, 'package.json'), '{"name":"fixture","private":true,"dependencies":{"commander":"1.0.0"}}\n');
    writeFileSync(join(repositoryRoot, 'bun.lock'), '# lock\n');
    mkdirSync(join(repositoryRoot, 'node_modules', 'commander'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'node_modules', 'commander', 'package.json'), '{"name":"commander"}\n');
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'package.json', 'bun.lock']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome: home, displayName: 'dependency-lease' });
    const workspace = ensureManagedWorkspace(home, repository, { requestId: 'dependency-lease', title: 'dependency lease' });
    const dependencyPath = join(workspace.root!, 'node_modules');
    rmSync(dependencyPath, { recursive: true, force: true });
    mkdirSync(join(dependencyPath, 'legacy-copy'), { recursive: true });
    writeFileSync(join(dependencyPath, 'legacy-copy', 'marker'), 'legacy\n');
    const leaseRoot = join(repositoryControllerRoot(home, repository.repoId), 'leases', 'active');
    mkdirSync(leaseRoot, { recursive: true });
    const now = Date.now();
    writeFileSync(join(leaseRoot, 'LEASE-active.json'), JSON.stringify({
      schemaVersion: 1, leaseId: 'LEASE-active', repoId: repository.repoId, checkoutId: workspace.checkoutId,
      resourceKey: `workspace:${workspace.checkoutId}`, mode: 'read', ownerJobId: 'job-active', fencingToken: 1,
      acquiredAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    }));

    const report = cleanupControllerRuntimeState(home, { reason: 'periodic', maxEntries: 200, maxRemovals: 20, periodicSequence: 0 });
    expect(lstatSync(dependencyPath).isDirectory()).toBe(true);
    expect(lstatSync(dependencyPath).isSymbolicLink()).toBe(false);
    expect(report.migratedDependencyPaths).toEqual([]);
    expect(report.cycle.skippedByReason.dependency_active_owner).toBeGreaterThanOrEqual(1);
  });

  test('malformed Run metadata prevents worktree deletion for that repository', () => {
    const home = controllerHome();
    const worktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-unknown');
    const runRoot = join(home, 'repositories', 'repo-a', 'runs', 'RUN-broken');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, 'meta.json'), '{not-json', 'utf8');
    age(worktree);

    const report = cleanupControllerRuntimeState(home, { maxEntries: 100 });

    expect(existsSync(worktree)).toBe(true);
    expect(report.skippedActiveWorktrees).toContain('repositories/repo-a/worktrees/RUN-unknown');
    expect(report.errors.some((entry) => entry.includes('unreadable Run metadata'))).toBe(true);
  });

  test('stops scanning at the configured budget and records truncation', () => {
    const home = controllerHome();
    const records = join(home, 'repositories', 'repo-a', 'execution-jobs', 'records');
    mkdirSync(records, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      const path = join(records, `record-${index}.tmp`);
      writeFileSync(path, 'temporary\n', 'utf8');
      age(path);
    }

    const report = cleanupControllerRuntimeState(home, { maxEntries: 3 });

    // Reference, worktree, and temp phases each receive the configured budget.
    expect(report.inspectedPaths).toBeLessThanOrEqual(9);
    expect(report.budgetExhausted).toBe(true);
    expect(cleanupEntries(home).at(-1)?.budgetExhausted).toBe(true);
  });

  test('bounds removals with a cycle-wide budget and reports the reason', () => {
    const home = controllerHome();
    mkdirSync(join(home, 'daemon'), { recursive: true });
    const first = join(home, 'daemon', 'first.tmp');
    const second = join(home, 'daemon', 'second.tmp');
    writeFileSync(first, 'temporary\n', 'utf8');
    writeFileSync(second, 'temporary\n', 'utf8');
    age(first);
    age(second);

    const report = cleanupControllerRuntimeState(home, { maxEntries: 100, maxRemovals: 1 });

    expect(report.removedTemporaryPaths.length).toBe(1);
    expect(report.cycle.budgetExhausted).toBe(true);
    expect(report.cycle.skippedByReason.cleanup_budget_exhausted).toBeGreaterThan(0);
  });

  test('terminal cancelled Runs release worktrees while unknown Runs remain protected', () => {
    const home = controllerHome();
    const cancelledWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-cancelled');
    const unknownWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-unknown');
    const activeWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-active');
    mkdirSync(cancelledWorktree, { recursive: true });
    mkdirSync(unknownWorktree, { recursive: true });
    mkdirSync(activeWorktree, { recursive: true });
    mkdirSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-cancelled'), { recursive: true });
    mkdirSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-unknown'), { recursive: true });
    mkdirSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-active'), { recursive: true });
    writeFileSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-cancelled', 'meta.json'), `${JSON.stringify({
      schemaVersion: 3,
      runId: 'RUN-cancelled',
      issueId: 'ISS-1',
      taskId: 'T1',
      agent: 'codex',
      provider: 'local',
      executionMode: 'worktree',
      status: 'cancelled',
      repoRoot: '/repo',
      worktree: cancelledWorktree,
      branch: 'controller/cancelled',
      baseRevision: 'HEAD',
      promptPath: 'prompt.md',
      stdoutPath: 'stdout.log',
      stderrPath: 'stderr.log',
      resultPath: 'result.json',
      eventsPath: 'events.jsonl',
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    writeFileSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-unknown', 'meta.json'), `${JSON.stringify({
      schemaVersion: 3,
      runId: 'RUN-unknown',
      issueId: 'ISS-1',
      taskId: 'T1b',
      agent: 'codex',
      provider: 'local',
      executionMode: 'worktree',
      status: 'unknown',
      repoRoot: '/repo',
      worktree: unknownWorktree,
      branch: 'controller/unknown',
      baseRevision: 'HEAD',
      promptPath: 'prompt.md',
      stdoutPath: 'stdout.log',
      stderrPath: 'stderr.log',
      resultPath: 'result.json',
      eventsPath: 'events.jsonl',
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    writeFileSync(join(home, 'repositories', 'repo-a', 'runs', 'RUN-active', 'meta.json'), `${JSON.stringify({
      schemaVersion: 3,
      runId: 'RUN-active',
      issueId: 'ISS-1',
      taskId: 'T2',
      agent: 'codex',
      provider: 'local',
      executionMode: 'worktree',
      status: 'waiting_for_user',
      repoRoot: '/repo',
      worktree: activeWorktree,
      branch: 'controller/active',
      baseRevision: 'HEAD',
      promptPath: 'prompt.md',
      stdoutPath: 'stdout.log',
      stderrPath: 'stderr.log',
      resultPath: 'result.json',
      eventsPath: 'events.jsonl',
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    age(cancelledWorktree);
    age(unknownWorktree);
    age(activeWorktree);

    const report = cleanupControllerRuntimeState(home, { maxEntries: 100 });

    expect(existsSync(cancelledWorktree)).toBe(false);
    expect(existsSync(unknownWorktree)).toBe(true);
    expect(existsSync(activeWorktree)).toBe(true);
    expect(report.removedWorktrees).toContain('repositories/repo-a/worktrees/RUN-cancelled');
    expect(report.removedWorktrees).not.toContain('repositories/repo-a/worktrees/RUN-unknown');
    expect(report.skippedActiveWorktrees).toContain('repositories/repo-a/worktrees/RUN-unknown');
    expect(report.skippedActiveWorktrees).toContain('repositories/repo-a/worktrees/RUN-active');
  });

  test('worktree cleanup is not starved by high-cardinality permanent job records', () => {
    const home = controllerHome();
    const orphanWorktree = join(home, 'repositories', 'repo-a', 'worktrees', 'RUN-orphaned');
    const records = join(home, 'repositories', 'repo-a', 'execution-jobs', 'records');
    mkdirSync(orphanWorktree, { recursive: true });
    mkdirSync(records, { recursive: true });
    for (let index = 0; index < 80; index += 1) {
      writeFileSync(join(records, `EJOB-${index}.json`), '{}\n', 'utf8');
    }
    age(orphanWorktree);

    const report = cleanupControllerRuntimeState(home, { maxEntries: 40 });

    expect(existsSync(orphanWorktree)).toBe(false);
    expect(report.removedWorktrees).toContain('repositories/repo-a/worktrees/RUN-orphaned');
  });

  test('no-op periodic cleanup does not append audit noise for budget exhaustion alone', () => {
    const home = controllerHome();
    const records = join(home, 'repositories', 'repo-a', 'execution-jobs', 'records');
    mkdirSync(records, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(records, `record-${index}.json`), '{}\n', 'utf8');
    }

    const report = cleanupControllerRuntimeState(home, {
      reason: 'periodic',
      maxEntries: 3,
    });

    expect(report.budgetExhausted).toBe(true);
    expect(report.removedWorktrees).toEqual([]);
    expect(report.removedTemporaryPaths).toEqual([]);
    expect(existsSync(runtimeCleanupLogPath(home))).toBe(false);
  });

  test('removes terminal legacy runtime state only after Controller Home relocation and never creates repo archives', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-cleanup-relocated-repo-'));
    const controllerStore = mkdtempSync(join(tmpdir(), 'forge-cleanup-relocated-controller-'));
    homes.push(repoRoot, controllerStore);
    const harnessRoot = join(repoRoot, '.ai', 'harness');
    const localJobsTarget = join(controllerStore, 'local-jobs');
    mkdirSync(harnessRoot, { recursive: true });
    mkdirSync(localJobsTarget, { recursive: true });
    symlinkSync(localJobsTarget, join(harnessRoot, 'local-jobs'), process.platform === 'win32' ? 'junction' : 'dir');
    const jobRoot = join(localJobsTarget, 'JOB-terminal');
    mkdirSync(jobRoot, { recursive: true });
    writeFileSync(join(jobRoot, 'job.json'), JSON.stringify({ jobId: 'JOB-terminal', status: 'succeeded' }));
    age(jobRoot);

    const result = applyRuntimeCleanup(repoRoot, {
      includeTempDirs: false,
      includeLegacyRuns: false,
      includeHistoricalAttention: false,
      includeTerminalLocalJobs: true,
      minAgeMinutes: 1,
      maxCandidates: 10,
      maxRemovals: 10,
      confirmCleanup: true,
    });

    expect(result.applied.some((candidate) => candidate.id === 'JOB-terminal' && candidate.applied)).toBe(true);
    expect(existsSync(jobRoot)).toBe(false);
    expect(existsSync(join(repoRoot, '.ai/harness/local-jobs-archive'))).toBe(false);
  });

  test('refuses to remove terminal Local Jobs while runtime storage is still physically repository-local', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-cleanup-repo-local-'));
    homes.push(repoRoot);
    const jobRoot = join(repoRoot, '.ai', 'harness', 'local-jobs', 'JOB-local');
    mkdirSync(jobRoot, { recursive: true });
    writeFileSync(join(jobRoot, 'job.json'), JSON.stringify({ jobId: 'JOB-local', status: 'succeeded' }));
    age(jobRoot);

    const preview = previewRuntimeCleanup(repoRoot, {
      includeTempDirs: false,
      includeLegacyRuns: false,
      includeHistoricalAttention: false,
      includeTerminalLocalJobs: true,
      minAgeMinutes: 1,
    });

    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.safe).toBe(false);
    expect(preview.candidates[0]?.reason).toContain('relocated to Controller Home');
  });

  test('bounds cleanup preview candidates and reports truncation', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-cleanup-preview-'));
    homes.push(repoRoot);
    const jobsRoot = join(repoRoot, '.ai/harness/local-jobs');
    mkdirSync(jobsRoot, { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      const jobRoot = join(jobsRoot, `JOB-${index + 1}`);
      mkdirSync(jobRoot, { recursive: true });
      writeFileSync(join(jobRoot, 'job.json'), JSON.stringify({ jobId: `JOB-${index + 1}`, status: 'succeeded' }));
      age(jobRoot);
    }

    const preview = previewRuntimeCleanup(repoRoot, {
      includeTempDirs: false,
      includeLegacyRuns: false,
      includeHistoricalAttention: false,
      includeTerminalLocalJobs: true,
      maxCandidates: 3,
    });

    expect(preview.candidates).toHaveLength(3);
    expect(preview.truncated.candidates).toBe(true);
  });

  test('source scan selection prefers active repositories and bounds the idle safety scan', () => {
    const repositories = [
      { repoId: 'repo-a' },
      { repoId: 'repo-b' },
      { repoId: 'repo-c' },
    ];
    const now = 10 * 60_000;
    expect(selectSchedulerSourceScanRepositories(
      repositories,
      new Set(['repo-b', 'repo-c']),
      now,
      now,
    ).map((repository) => repository.repoId)).toEqual(['repo-b', 'repo-c']);
    expect(selectSchedulerSourceScanRepositories(
      repositories,
      new Set(),
      now,
      now,
    )).toEqual([]);
    expect(selectSchedulerSourceScanRepositories(
      repositories,
      new Set(),
      now,
      now - 60_000,
    )).toHaveLength(1);

    expect(planSchedulerSourceSampling({
      repositories,
      activeRepoIds: new Set(['repo-a']),
      nowMs: now,
      lastSourceScanAt: now,
      lastGitStatusSampleAt: now - 5_000,
    })).toMatchObject({
      sourceScanRepositories: [{ repoId: 'repo-a' }],
      shouldSample: true,
      avoidedRepositoryCount: 2,
    });
  });

  test('canonical scheduler isolates periodic cleanup instead of running synchronous cleanup on the event loop', async () => {
    const home = controllerHome();
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 }, { isolatePeriodicCleanup: true });
    let inlineCleanupCalls = 0;
    let launches = 0;
    const now = Date.now();
    const internal = scheduler as unknown as {
      runtimeCleanup: () => void;
      periodicCleanupSpawn: () => SchedulerPeriodicCleanupSpawnResult;
      repositoryList: () => Array<{ repoId: string; enabled: boolean; canonicalRoot: string; removedAt?: string }>;
      lastSourceScanAt: number;
      lastGitStatusSampleAt: number;
      workValidationReconcile: () => { errors: unknown[] };
      editValidationReconcile: () => Promise<{ errors: unknown[] }>;
    };
    internal.runtimeCleanup = () => { inlineCleanupCalls += 1; };
    internal.periodicCleanupSpawn = () => {
      launches += 1;
      return { ok: false, startupError: 'synthetic isolated cleanup launch' };
    };
    internal.repositoryList = () => [];
    internal.lastSourceScanAt = now;
    internal.lastGitStatusSampleAt = now;
    internal.workValidationReconcile = () => ({ errors: [] });
    internal.editValidationReconcile = async () => ({ errors: [] });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await expect(scheduler.tick()).resolves.toEqual({ activeJobs: 0 });
    } finally {
      console.error = originalError;
    }
    expect(launches).toBe(1);
    expect(inlineCleanupCalls).toBe(0);
  });

  test('periodic scheduler cleanup runs Process GC for only one enabled repository', async () => {
    const home = controllerHome();
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    const processGcRepos: string[] = [];
    const now = Date.now();
    const internal = scheduler as unknown as {
      runtimeCleanup: () => void;
      terminalWorkCleanup: () => Promise<void>;
      processGc: (options: { repoId: string }) => { ok: boolean };
      workValidationReconcile: (controllerHome: string, repoId: string, limit: number) => { errors: unknown[] };
      editValidationReconcile: (controllerHome: string, repository: { repoId: string }, limit: number) => Promise<{ errors: unknown[] }>;
      repositoryList: () => Array<{ repoId: string; enabled: boolean; canonicalRoot: string; removedAt?: string }>;
      lastSourceScanAt: number;
      lastGitStatusSampleAt: number;
    };
    internal.runtimeCleanup = () => undefined;
    internal.terminalWorkCleanup = async () => undefined;
    internal.processGc = (options) => {
      processGcRepos.push(options.repoId);
      return { ok: true };
    };
    const validationRepos: string[] = [];
    internal.workValidationReconcile = (_controllerHome, repoId) => {
      validationRepos.push(repoId);
      return { errors: [] };
    };
    const editValidationRepos: string[] = [];
    internal.editValidationReconcile = async (_controllerHome, repository) => {
      editValidationRepos.push(repository.repoId);
      return { errors: [] };
    };
    internal.repositoryList = () => [
      { repoId: 'repo-a', enabled: true, canonicalRoot: home },
      { repoId: 'repo-b', enabled: true, canonicalRoot: home },
      { repoId: 'repo-disabled', enabled: false, canonicalRoot: home },
    ];
    internal.lastSourceScanAt = now;
    internal.lastGitStatusSampleAt = now;

    await scheduler.tick();
    expect(processGcRepos).toHaveLength(1);
    expect(['repo-a', 'repo-b']).toContain(processGcRepos[0]!);
    expect(validationRepos.sort()).toEqual(['repo-a', 'repo-b']);
    expect(editValidationRepos.sort()).toEqual(['repo-a', 'repo-b']);
  });

  test('refreshes dirty repository projections even when exclusive Work admission disables dispatch', async () => {
    const home = controllerHome();
    const root = mkdtempSync(join(tmpdir(), 'forge-projection-refresh-disabled-dispatch-'));
    homes.push(root);
    const at = new Date().toISOString();
    const repository: RepositoryRecord = {
      schemaVersion: 1,
      repoId: 'repo-projection-refresh-disabled-dispatch',
      displayName: 'projection refresh disabled dispatch',
      localRoot: root,
      canonicalRoot: root,
      activeCheckoutId: 'checkout-main',
      checkouts: [{
        checkoutId: 'checkout-main', localRoot: root, canonicalRoot: root, worktree: false,
        branch: 'main', createdAt: at, updatedAt: at, lastSeenAt: at,
      }],
      repositoryType: 'git',
      enabled: true,
      createdAt: at,
      updatedAt: at,
      lastSeenAt: at,
      configurationPath: join(root, '.ai', 'harness', 'repository.json'),
      stateStorageStrategy: 'controller-home',
    };
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    const internal = scheduler as unknown as {
      repositoryList: () => RepositoryRecord[];
      lastSourceScanAt: number;
      lastGitStatusSampleAt: number;
      runtimeCleanup: () => void;
      terminalWorkCleanup: () => Promise<void>;
      processGc: () => { ok: boolean };
      workValidationReconcile: () => { errors: unknown[] };
      editValidationReconcile: () => Promise<{ errors: unknown[] }>;
    };
    internal.repositoryList = () => [repository];
    internal.lastSourceScanAt = 0;
    internal.lastGitStatusSampleAt = 0;
    internal.runtimeCleanup = () => undefined;
    internal.terminalWorkCleanup = async () => undefined;
    internal.processGc = () => ({ ok: true });
    internal.workValidationReconcile = () => ({ errors: [] });
    internal.editValidationReconcile = async () => ({ errors: [] });
    activateExclusiveWorkAdmission(home, { allowedWorkId: 'work-exclusive', reason: 'test exclusive admission' });
    markRepositoryProjectionDirty(home, repository.repoId, 'source-scan-test', { sourceRevision: 'abc123' });
    expect(repositoryProjectionIsDirty(home, repository.repoId)).toBe(true);

    await expect(scheduler.tick()).resolves.toEqual({ activeJobs: 0 });

    expect(repositoryProjectionIsDirty(home, repository.repoId)).toBe(false);
  });

  test('convergence admission keeps scheduler advancement active for existing Work', async () => {
    const home = controllerHome();
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    const internal = scheduler as unknown as { lastScheduleTick: number };
    activateConvergenceWorkAdmission(home, { reason: 'Drain existing Work without admitting new Work.' });

    expect(internal.lastScheduleTick).toBe(0);
    await expect(scheduler.tick()).resolves.toEqual({ activeJobs: 0 });
    expect(internal.lastScheduleTick).toBeGreaterThan(0);
  });

  test('refreshes a dirty projection before its idle round-robin source-scan slot', async () => {
    const home = controllerHome();
    const now = Date.now();
    const makeRepository = (repoId: string): RepositoryRecord => {
      const root = mkdtempSync(join(tmpdir(), `${repoId}-`));
      homes.push(root);
      const at = new Date(now).toISOString();
      return {
        schemaVersion: 1,
        repoId,
        displayName: repoId,
        localRoot: root,
        canonicalRoot: root,
        activeCheckoutId: 'checkout-main',
        checkouts: [{
          checkoutId: 'checkout-main', localRoot: root, canonicalRoot: root, worktree: false,
          branch: 'main', createdAt: at, updatedAt: at, lastSeenAt: at,
        }],
        repositoryType: 'git',
        enabled: true,
        createdAt: at,
        updatedAt: at,
        lastSeenAt: at,
        configurationPath: join(root, '.ai', 'harness', 'repository.json'),
        stateStorageStrategy: 'controller-home',
      };
    };
    const repositoryA = makeRepository('repo-idle-a');
    const repositoryB = makeRepository('repo-idle-b');
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    const internal = scheduler as unknown as {
      repositoryList: () => RepositoryRecord[];
      lastSourceScanAt: number;
      lastGitStatusSampleAt: number;
      runtimeCleanup: () => void;
      terminalWorkCleanup: () => Promise<void>;
      processGc: () => { ok: boolean };
      workValidationReconcile: () => { errors: unknown[] };
      editValidationReconcile: () => Promise<{ errors: unknown[] }>;
    };
    internal.repositoryList = () => [repositoryA, repositoryB];
    // Idle safety scan is deliberately not due. Old behavior therefore had no
    // projection refresh target and left repo-idle-b dirty past the grace window.
    internal.lastSourceScanAt = now;
    internal.lastGitStatusSampleAt = now;
    internal.runtimeCleanup = () => undefined;
    internal.terminalWorkCleanup = async () => undefined;
    internal.processGc = () => ({ ok: true });
    internal.workValidationReconcile = () => ({ errors: [] });
    internal.editValidationReconcile = async () => ({ errors: [] });
    activateExclusiveWorkAdmission(home, { allowedWorkId: 'work-exclusive', reason: 'test targeted dirty projection maintenance' });
    markRepositoryProjectionDirty(home, repositoryB.repoId, 'source-change-before-idle-slot', { sourceRevision: 'def456' });
    expect(selectSchedulerSourceScanRepositories([repositoryA, repositoryB], new Set(), now, now)).toEqual([]);
    expect(repositoryProjectionIsDirty(home, repositoryB.repoId)).toBe(true);

    await expect(scheduler.tick()).resolves.toEqual({ activeJobs: 0 });

    expect(repositoryProjectionIsDirty(home, repositoryB.repoId)).toBe(false);
  });

  test('a Work concurrency reconciliation failure is isolated per repository and does not interrupt the scheduler tick', async () => {
    const home = controllerHome();
    const now = Date.now();
    const makeRepository = (repoId: string): RepositoryRecord => {
      const root = mkdtempSync(join(tmpdir(), `${repoId}-`));
      homes.push(root);
      const at = new Date(now).toISOString();
      return {
        schemaVersion: 1,
        repoId,
        displayName: repoId,
        localRoot: root,
        canonicalRoot: root,
        activeCheckoutId: 'checkout-main',
        checkouts: [{
          checkoutId: 'checkout-main', localRoot: root, canonicalRoot: root, worktree: false,
          branch: 'main', createdAt: at, updatedAt: at, lastSeenAt: at,
        }],
        repositoryType: 'git',
        enabled: true,
        createdAt: at,
        updatedAt: at,
        lastSeenAt: at,
        configurationPath: join(root, '.ai', 'harness', 'repository.json'),
        stateStorageStrategy: 'controller-home',
      };
    };
    const repositoryA = makeRepository('repo-concurrency-invalid');
    const repositoryB = makeRepository('repo-concurrency-healthy');
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    const observed: string[] = [];
    const internal = scheduler as unknown as {
      repositoryList: () => RepositoryRecord[];
      lastSourceScanAt: number;
      lastGitStatusSampleAt: number;
      runtimeCleanup: () => void;
      terminalWorkCleanup: () => Promise<void>;
      processGc: () => { ok: boolean };
      workExecutionConcurrencyReconcile: (input: { repoId: string }) => { scanned: number; waiting: number; cleared: number; workIds: string[] };
      workValidationReconcile: () => { errors: unknown[] };
      editValidationReconcile: () => Promise<{ errors: unknown[] }>;
    };
    internal.repositoryList = () => [repositoryA, repositoryB];
    internal.lastSourceScanAt = now;
    internal.lastGitStatusSampleAt = now;
    internal.runtimeCleanup = () => undefined;
    internal.terminalWorkCleanup = async () => undefined;
    internal.processGc = () => ({ ok: true });
    internal.workExecutionConcurrencyReconcile = ({ repoId }) => {
      observed.push(repoId);
      if (repoId === repositoryA.repoId) throw new Error('WORK_PHASE_EVIDENCE_PREVIOUS_NOT_SATISFIED: review');
      return { scanned: 0, waiting: 0, cleared: 0, workIds: [] };
    };
    internal.workValidationReconcile = () => ({ errors: [] });
    internal.editValidationReconcile = async () => ({ errors: [] });
    activateExclusiveWorkAdmission(home, { allowedWorkId: 'work-exclusive', reason: 'test concurrency reconciliation isolation' });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await expect(scheduler.tick()).resolves.toEqual({ activeJobs: 0 });
    } finally {
      console.error = originalError;
    }
    expect(observed).toEqual([repositoryA.repoId, repositoryB.repoId]);
  });

  test('a cleanup failure does not interrupt the scheduler tick', async () => {
    const home = controllerHome();
    const scheduler = new GlobalScheduler(home, { pollIntervalMs: 1 });
    const internal = scheduler as unknown as {
      runtimeCleanup: () => never;
      terminalWorkCleanup: () => Promise<never>;
      processGc: () => { ok: boolean; error?: string };
    };
    internal.runtimeCleanup = () => {
      throw new Error('synthetic cleanup failure');
    };
    internal.terminalWorkCleanup = async () => {
      throw new Error('synthetic terminal Work cleanup failure');
    };
    internal.processGc = () => ({ ok: false, error: 'synthetic Process GC failure' });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await expect(scheduler.tick()).resolves.toEqual({ activeJobs: 0 });
    } finally {
      console.error = originalError;
    }
  });
});

