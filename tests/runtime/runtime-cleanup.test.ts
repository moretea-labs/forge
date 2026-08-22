import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GlobalScheduler,
  selectSchedulerSourceScanRepositories,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { planSchedulerSourceSampling } from '../../src/runtime/control-plane/global-scheduler/source-scan';
import {
  cleanupControllerRuntimeState,
  runtimeCleanupLogPath,
  type RuntimeCleanupReport,
} from '../../src/runtime/control-plane/runtime-cleanup';
import { previewRuntimeCleanup } from '../../src/runtime/maintenance/cleanup';
import { activateExclusiveWorkAdmission } from '../../src/runtime/control-plane/facade/work-admission-policy';
import { markRepositoryProjectionDirty, repositoryProjectionIsDirty } from '../../src/runtime/projections/invalidation';
import type { RepositoryRecord } from '../../src/cli/repositories/types';

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
      repositoryList: () => Array<{ repoId: string; enabled: boolean; removedAt?: string }>;
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
      { repoId: 'repo-a', enabled: true },
      { repoId: 'repo-b', enabled: true },
      { repoId: 'repo-disabled', enabled: false },
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

