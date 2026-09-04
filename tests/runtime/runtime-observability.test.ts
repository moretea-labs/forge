import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { classifyFailure } from '../../src/runtime/recovery/classifier';
import { classifyRuntimeReadinessSemantics, evaluateRuntimeHealth, type RuntimeHealthObservations } from '../../src/runtime/health';
import {
  projectionBlocksReadiness,
  projectionObservation,
  readRepositoryProjectionSnapshot,
  rebuildRepositoryProjection,
  reconcileProjectionWithTaskLedger,
  type RepositoryRuntimeProjectionSnapshot,
} from '../../src/runtime/projections/materialized-view';
import { executionJobRoot, rebuildExecutionJobIndexes } from '../../src/runtime/execution/jobs/store';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';
import type { TaskLedgerProjection } from '../../src/cli/controller/task-ledger';
import { recordMcpIncident, recordMcpTiming } from '../../src/runtime/diagnostics/mcp-timing';
import { classifyForgeIncidentForRepair, maybeRegisterMcpIncidentRepair } from '../../src/runtime/diagnostics/incident-repair';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { createMcpToolContext as createMultiRepositoryContext } from '../../src/cli/mcp/multi-repository';
import { createForgeMcpServer } from '../../src/cli/mcp/server';
import { registerRepository } from '../../src/cli/repositories/registry';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { callRepositoryTool } from '../../src/cli/mcp/repository-tools';
import { buildRuntimeMaintenanceStatus } from '../../src/runtime/recovery';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';
import { acquireRuntimeOwnership, type RuntimeOwnershipHandle } from '../../src/runtime/root/ownership';
import { collectRuntimeSourceIdentity, rotateRuntimeGeneration } from '../../src/runtime/control-plane/runtime-generation';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { collectWorkLifecycleAttention } from '../../src/runtime/control-plane/execution/work-lifecycle-audit';
import { sampleRepositoryGitStatusForRepositories } from '../../src/runtime/projections/git-status-sampler';
import { createWorkContract, getWorkContract, listWorkContracts, recordWorkCompletionReceipt, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { listWorkContinuationSchedules } from '../../src/runtime/workflow/schedules/work-continuation';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { DEFAULT_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES } from '../../src/cli/mcp/toolset-names';
import { FORGE_VERSION } from '../../src/cli/controller/runtime-config';
import {
  PROCESS_RUNNER_RELEASE_CANARY_CHILD_ARG,
  processRunnerReleaseCanaryChildCommand,
} from '../../src/runtime/execution/process-runtime/canary';

function observations(overrides: Partial<RuntimeHealthObservations> = {}): RuntimeHealthObservations {
  return {
    daemon: { status: 'ready', heartbeatAgeMs: 0 },
    scheduler: { status: 'ready', heartbeatAgeMs: 0 },
    workers: { queueDepth: 0, runningWorkers: 0, activeLeases: 0 },
    projection: { readable: true, persisted: true },
    localBridge: {
      enabled: false,
      requiredForReadiness: false,
      mode: 'disabled',
      endpointReachable: true,
      expectedSurface: true,
    },
    runtimeStorage: { readable: true, ready: true },
    ...overrides,
  };
}

function projectionSnapshot(): RepositoryRuntimeProjectionSnapshot {
  return {
    projection: {
      schemaVersion: 1,
      repoId: 'repo-1',
      generatedAt: new Date(0).toISOString(),
      revision: 1,
      releaseFrozen: false,
      activeJobs: [],
      queueDepth: 0,
      runningWorkers: 0,
      activeLeases: 0,
      currentAttention: [],
      attention: [],
    },
    stale: false,
    persisted: true,
  };
}

function ledgerWithRunningTask(): TaskLedgerProjection {
  return {
    schemaVersion: 2,
    generatedAt: new Date(0).toISOString(),
    source: 'controller-task-ledger',
    counts: { running: 1 },
    declaredCounts: { running: 1 },
    archivedCounts: {},
    issueCount: 1,
    archivedIssueCount: 0,
    status: {
      kind: 'active_work',
      severity: 'info',
      label: 'Work in progress',
      reason: 'fixture',
      nextAction: 'fixture',
    },
    issues: [{
      id: 'I1',
      title: 'Fixture',
      isCurrent: true,
      taskCounts: { running: 1 },
      tasks: [{
        issueId: 'I1',
        taskId: 'T3',
        title: 'Running task',
        effectiveStatus: 'running',
        retryable: false,
        requiresExplicitRetry: false,
        dispatchable: false,
        queueable: false,
        multipleActiveRuns: false,
        allowedPaths: [],
        checks: [],
        runIds: [],
      }],
    }],
    attention: [],
    readyTasks: [],
    queueableTasks: [],
    recentEvents: [],
    suggestedNextActions: [],
    contextContract: {
      strategy: 'fixture',
      rawCodeRequiredForImplementation: true,
      notes: [],
    },
  };
}

/**
 * Local-dev Forge home with one canonical Runtime owner/status projection and a
 * registered repository. The fixture exercises the same ownership contract as
 * the production Runtime instead of writing the retired daemon status shape.
 */
function controllerFixture(): { controllerHome: string; repoRoot: string; ownership: RuntimeOwnershipHandle } {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-obs-ch-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-obs-repo-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: repoRoot, stdio: 'ignore' });
  rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(repoRoot));
  const now = new Date().toISOString();
  const runtimeInstanceId = 'runtime-observability';
  const ownership = acquireRuntimeOwnership(controllerHome, runtimeInstanceId);
  writeRuntimeStatusSnapshot(controllerHome, {
    schemaVersion: 1,
    runtimeInstanceId,
    pid: process.pid,
    releaseId: 'release-observability',
    artifactIdentity: 'artifact-observability',
    startedAt: now,
    updatedAt: now,
    readiness: {
      ready: true,
      reasonCodes: [],
      diagnostics: {
        database: { outcome: 'pass' },
        scheduler: { outcome: 'pass' },
        releaseCoherence: { outcome: 'pass' },
        mcpEndToEnd: { outcome: 'pass' },
      },
      observedAt: now,
    },
  });
  mkdirSync(join(controllerHome, 'scheduler'), { recursive: true });
  writeJsonAtomic(join(controllerHome, 'scheduler', 'state.json'), {
    schemaVersion: 1,
    updatedAt: now,
    loopStartedAt: now,
    lastHeartbeatAt: now,
    lastTickAt: now,
    lastDispatchAt: now,
    lastRepoDispatch: {},
  });
  return { controllerHome, repoRoot, ownership };
}

describe('runtime observability', () => {
  test('keeps legacy terminal execution attention in history without resurrecting it as a current release blocker', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-terminal-attention-ch-'));
    const repoId = 'repo-terminal-attention';
    try {
      const timestamp = new Date().toISOString();
      const legacy: ExecutionJob = {
        schemaVersion: 1,
        revision: 1,
        jobId: 'legacy-human-attention',
        repoId,
        type: 'check',
        status: 'human_attention_required',
        priority: 'P2',
        requestId: 'request-legacy-human-attention',
        semanticKey: 'test:legacy-human-attention',
        payload: { operation: 'run_check', target: 'mcp-tool' },
        origin: { surface: 'system', actor: 'test' },
        resourceClaims: [],
        dependencies: [],
        leaseRefs: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        queuedAt: timestamp,
        attempt: 1,
        maxAttempts: 1,
        evidenceIds: [],
        error: { code: 'LEGACY_ATTENTION', message: 'legacy terminal record intentionally omits finishedAt', retryable: false },
      };
      const records = join(executionJobRoot(controllerHome, repoId), 'records');
      mkdirSync(records, { recursive: true });
      writeFileSync(join(records, `${legacy.jobId}.json`), `${JSON.stringify(legacy)}\n`, 'utf8');
      rebuildExecutionJobIndexes(controllerHome, [repoId]);

      const snapshot = readRepositoryProjectionSnapshot(controllerHome, repoId);
      expect(snapshot.projection.attention).toContainEqual(expect.objectContaining({
        jobId: legacy.jobId,
        status: 'human_attention_required',
      }));
      expect(snapshot.projection.currentAttention).not.toContainEqual(expect.objectContaining({ jobId: legacy.jobId }));
      const health = evaluateRuntimeHealth(observations({
        workers: {
          queueDepth: snapshot.projection.queueDepth,
          runningWorkers: snapshot.projection.runningWorkers,
          activeLeases: snapshot.projection.activeLeases,
          activeAttentionCount: snapshot.projection.currentAttention.length,
        },
      }));
      expect(health.activeBlockers.map((item) => item.code)).not.toContain('ACTIVE_JOB_ATTENTION_REQUIRED');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('derives lifecycle attention for dirty unregistered worktrees and unintegrated Work branches', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-lifecycle-audit-ch-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-lifecycle-audit-repo-'));
    const worktreeRoot = join(tmpdir(), `forge-lifecycle-audit-worktree-${process.pid}-${Date.now()}`);
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'README.md'), 'base\n');
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'base'], { cwd: repoRoot, stdio: 'ignore' });
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
      const added = spawnSync('git', ['worktree', 'add', '-b', 'work/orphan-audit', worktreeRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(added.status).toBe(0);
      writeFileSync(join(worktreeRoot, 'delivered.txt'), 'unique\n');
      spawnSync('git', ['add', 'delivered.txt'], { cwd: worktreeRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'unique work'], { cwd: worktreeRoot, stdio: 'ignore' });
      writeFileSync(join(worktreeRoot, 'unfinished.txt'), 'dirty\n');

      const findings = collectWorkLifecycleAttention(controllerHome, repository);
      expect(findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'dirty_linked_worktree_unregistered' }),
        expect.objectContaining({ status: 'work_branch_not_integrated' }),
      ]));
      rebuildRepositoryProjection(controllerHome, repository.repoId);
      const projection = readRepositoryProjectionSnapshot(controllerHome, repository.repoId).projection;
      expect(projection.currentAttention).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'dirty_linked_worktree_unregistered' }),
        expect.objectContaining({ status: 'work_branch_not_integrated' }),
      ]));
      const health = evaluateRuntimeHealth(observations({
        workers: {
          queueDepth: projection.queueDepth,
          runningWorkers: projection.runningWorkers,
          activeLeases: projection.activeLeases,
          activeAttentionCount: projection.currentAttention.length,
        },
      }));
      expect(health.activeBlockers.map((item) => item.code)).toContain('ACTIVE_JOB_ATTENTION_REQUIRED');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', worktreeRoot], { cwd: repoRoot, stdio: 'ignore' });
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('keeps materialized lifecycle attention on projection hot reads without invoking Git', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-hot-projection-ch-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-hot-projection-repo-'));
    const fakeBin = mkdtempSync(join(tmpdir(), 'forge-hot-projection-bin-'));
    const marker = join(fakeBin, 'git-invoked.marker');
    const originalPath = process.env.PATH;
    const originalMarker = process.env.FORGE_TEST_GIT_MARKER;
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
      const lifecycleAttention = {
        jobId: 'lifecycle:test:materialized',
        status: 'terminal_work_cleanup_unsettled',
        message: 'materialized lifecycle fixture',
      };
      writeJsonAtomic(
        join(repositoryControllerRoot(controllerHome, repository.repoId), 'projections', 'runtime.json'),
        {
          schemaVersion: 1,
          repoId: repository.repoId,
          generatedAt: new Date().toISOString(),
          revision: 1,
          releaseFrozen: false,
          activeJobs: [],
          queueDepth: 0,
          runningWorkers: 0,
          activeLeases: 0,
          currentAttention: [lifecycleAttention],
          attention: [lifecycleAttention],
        },
      );
      const fakeGit = join(fakeBin, 'git');
      writeFileSync(fakeGit, `#!/usr/bin/env bash\nset -eu\nprintf 'git\\n' >> "$FORGE_TEST_GIT_MARKER"\nsleep 0.1\nexit 0\n`, 'utf8');
      chmodSync(fakeGit, 0o755);
      process.env.FORGE_TEST_GIT_MARKER = marker;
      process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

      const projection = readRepositoryProjectionSnapshot(controllerHome, repository.repoId).projection;
      expect(projection.currentAttention).toContainEqual(lifecycleAttention);
      expect(projection.attention).toContainEqual(lifecycleAttention);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      if (originalMarker === undefined) delete process.env.FORGE_TEST_GIT_MARKER;
      else process.env.FORGE_TEST_GIT_MARKER = originalMarker;
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('scheduler Git sampling yields the event loop while bounded Git subprocesses run', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-async-git-sample-ch-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-async-git-sample-repo-'));
    const fakeBin = mkdtempSync(join(tmpdir(), 'forge-async-git-sample-bin-'));
    const marker = join(fakeBin, 'git-invoked.marker');
    const originalPath = process.env.PATH;
    const originalMarker = process.env.FORGE_TEST_GIT_MARKER;
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
      const fakeGit = join(fakeBin, 'git');
      writeFileSync(fakeGit, `#!/usr/bin/env bash\nset -eu\nprintf 'git\\n' >> "$FORGE_TEST_GIT_MARKER"\nsleep 0.12\ncmd="\${3:-}"\ncase "$cmd" in\n  status) printf '## main\\n' ;;\n  branch) printf 'main\\n' ;;\n  rev-parse)\n    if [[ "\${4:-}" == '--verify' ]]; then printf '0123456789012345678901234567890123456789\\n'; else printf 'origin/main\\n'; fi ;;\nesac\nexit 0\n`, 'utf8');
      chmodSync(fakeGit, 0o755);
      process.env.FORGE_TEST_GIT_MARKER = marker;
      process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

      let timerFired = false;
      const timer = setTimeout(() => { timerFired = true; }, 20);
      const result = await sampleRepositoryGitStatusForRepositories(controllerHome, [repository]);
      clearTimeout(timer);
      expect(result.sampled).toBe(1);
      expect(result.failed).toEqual([]);
      expect(timerFired).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (originalMarker === undefined) delete process.env.FORGE_TEST_GIT_MARKER;
      else process.env.FORGE_TEST_GIT_MARKER = originalMarker;
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('audits immutable completion delivery and repository-owned legacy cleanup without false blockers', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-lifecycle-receipt-ch-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-lifecycle-receipt-repo-'));
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'README.md'), 'base\n');
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'base'], { cwd: repoRoot, stdio: 'ignore' });
      const mainRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
      const checkoutId = repository.checkouts[0]!.checkoutId;
      const now = new Date().toISOString();
      const store = { controllerHome, repoId: repository.repoId };

      const baseWork = (workId: string, status: 'ready' | 'cancelled' = 'ready') => createWorkContract(store, {
        workId,
        repoId: repository.repoId,
        checkoutId,
        mode: 'direct_control',
        objective: `audit fixture ${workId}`,
        acceptanceCriteria: [],
        constraints: { requireHandoffOnAmbiguity: true },
        requestedBy: 'system',
        allowedPaths: [],
        forbiddenPaths: [],
        checks: [],
        status,
      });
      const handle = (workId: string, finalization: WorkHandleState['finalization']): WorkHandleState => ({
        schemaVersion: 1,
        workId,
        sessionId: `session-${workId}`,
        principalId: 'test',
        repositoryId: repository.repoId,
        checkoutId,
        worktreePath: repoRoot,
        branch: 'main',
        managedWorktree: false,
        workContractId: workId,
        baseCommit: mainRevision,
        expectedHead: mainRevision,
        permissionSnapshotVersion: 1,
        state: 'prepared',
        createdAt: now,
        updatedAt: now,
        finalization,
      });
      const receipt = (workId: string, targetRevision: string) => ({
        schemaVersion: 1 as const,
        receiptId: `receipt-${workId}`,
        source: 'controller_work' as const,
        issueId: 'work',
        taskId: workId,
        workId,
        targetBranch: 'main',
        targetRevision,
        sourceRevision: 'legacy-source-revision-that-is-not-the-delivered-head',
        baseRevision: mainRevision,
        changedPaths: [],
        delivery: {
          kind: 'commit' as const,
          status: 'integrated' as const,
          strategy: 'already_integrated' as const,
          reachable: true,
          recordedAt: now,
        },
        cleanup: { status: 'complete' as const, warnings: [], blockers: [], recordedAt: now },
        verifiedAt: now,
        recordedAt: now,
      });

      const completedWorkId = 'work-completed-audit-fixture';
      baseWork(completedWorkId);
      writeWorkHandle(controllerHome, handle(completedWorkId, {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
      }));
      recordWorkCompletionReceipt(store, completedWorkId, receipt(completedWorkId, mainRevision), 'completed_changed');

      spawnSync('git', ['switch', '-c', 'receipt-unreachable'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'unreachable.txt'), 'unique\n');
      spawnSync('git', ['add', 'unreachable.txt'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'unreachable receipt'], { cwd: repoRoot, stdio: 'ignore' });
      const unreachableRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['switch', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      const unreachableWorkId = 'work-unreachable-receipt-fixture';
      baseWork(unreachableWorkId);
      writeWorkHandle(controllerHome, handle(unreachableWorkId, {
        validation: 'done',
        commit: 'done',
        merge: 'done',
        branchCleanup: 'done',
        worktreeCleanup: 'done',
      }));
      recordWorkCompletionReceipt(store, unreachableWorkId, receipt(unreachableWorkId, unreachableRevision), 'completed_changed');

      const failedCleanupWorkId = 'work-failed-cleanup-fixture';
      baseWork(failedCleanupWorkId, 'cancelled');
      writeWorkHandle(controllerHome, handle(failedCleanupWorkId, {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'failed',
        worktreeCleanup: 'pending',
      }));

      const findings = collectWorkLifecycleAttention(controllerHome, repository);
      expect(findings).not.toContainEqual(expect.objectContaining({
        jobId: `lifecycle:completion_receipt_source_mismatch:${completedWorkId}`,
      }));
      expect(findings).not.toContainEqual(expect.objectContaining({
        jobId: `lifecycle:terminal_work_cleanup_unsettled:${completedWorkId}`,
      }));
      expect(findings).toContainEqual(expect.objectContaining({
        jobId: `lifecycle:completion_receipt_target_not_integrated:${unreachableWorkId}`,
      }));
      expect(findings).toContainEqual(expect.objectContaining({
        jobId: `lifecycle:terminal_work_cleanup_unsettled:${failedCleanupWorkId}`,
      }));
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('treats patch-equivalent orphan Work branches as integrated while keeping unique patches blocking', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-lifecycle-cherry-ch-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-lifecycle-cherry-repo-'));
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'README.md'), 'base\n');
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'base'], { cwd: repoRoot, stdio: 'ignore' });
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });

      spawnSync('git', ['switch', '-c', 'work/patch-equivalent'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'delivered.txt'), 'delivered\n');
      spawnSync('git', ['add', 'delivered.txt'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'delivered patch'], { cwd: repoRoot, stdio: 'ignore' });
      const deliveredCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['switch', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['cherry-pick', deliveredCommit], { cwd: repoRoot, stdio: 'ignore' });

      spawnSync('git', ['switch', '-c', 'work/unique-patch'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'unique.txt'), 'unique\n');
      spawnSync('git', ['add', 'unique.txt'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'unique patch'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['switch', 'main'], { cwd: repoRoot, stdio: 'ignore' });

      const findings = collectWorkLifecycleAttention(controllerHome, repository);
      expect(findings).not.toContainEqual(expect.objectContaining({
        jobId: 'lifecycle:work_branch_not_integrated:work/patch-equivalent',
      }));
      expect(findings).toContainEqual(expect.objectContaining({
        jobId: 'lifecycle:work_branch_not_integrated:work/unique-patch',
      }));
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('keeps readiness true while exposing an unknown external endpoint', () => {
    const health = evaluateRuntimeHealth(observations({
      externalReachability: { status: 'unknown', detail: 'public endpoint probe is not configured' },
    }));

    expect(health.ready).toBe(true);
    expect(health.components.externalReachability).toMatchObject({ state: 'warning', ready: true });
    expect(health.warnings.map((item) => item.code)).toContain('EXTERNAL_ENDPOINT_UNKNOWN');
  });

  test('blocks readiness for a known unhealthy external endpoint', () => {
    const health = evaluateRuntimeHealth(observations({
      externalReachability: { status: 'unhealthy', detail: 'probe_timeout' },
    }));

    expect(health.ready).toBe(false);
    expect(health.activeBlockers.map((item) => item.code)).toContain('EXTERNAL_ENDPOINT_UNHEALTHY');
  });

  test('controller_ready remains ready without a configured public endpoint', async () => {
    const { controllerHome, repoRoot, ownership } = controllerFixture();
    try {
      const ctx = createMultiRepositoryContext({
        repo: repoRoot,
        profile: 'controller',
        toolset: 'full',
        controllerHome,
        runtimeSourceRoot: repoRoot,
      });
      const result = await callRuntimeTool(ctx, 'controller_ready', {});
      expect(result).toBeTruthy();
      const payload = JSON.parse(result!.content[0].text) as Record<string, unknown>;

      expect(payload.ready).toBe(true);
      const reasonCodes = payload.reasonCodes as string[];
      expect(reasonCodes).not.toContain('PUBLIC_STABLE_ENDPOINT_UNHEALTHY');
    } finally {
      ownership.release();
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports a running Task Ledger task without treating it as live worker ownership', () => {
    const snapshot = projectionSnapshot();
    const reconciliation = reconcileProjectionWithTaskLedger(snapshot, ledgerWithRunningTask());
    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      projectionRunningWorkers: 0,
      ledgerRunningTasks: 1,
    });
    expect('blocking' in reconciliation).toBe(false);
    expect(projectionBlocksReadiness(snapshot)).toBe(false);
    const observation = projectionObservation(snapshot, reconciliation);
    expect(observation.sourceReconciliation?.status).toBe('mismatch');
    const health = evaluateRuntimeHealth(observations({ projection: observation }));
    expect(health.ready).toBe(true);
    expect(health.warnings.map((item) => item.code)).toContain('PROJECTION_SOURCE_MISMATCH');
    expect(health.activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_SOURCE_MISMATCH');
  });

  test('keeps a non-blocking ledger contradiction diagnostic without changing projectionBlocksReadiness', () => {
    const snapshot = projectionSnapshot();
    const contradictory = { ...snapshot, projection: { ...snapshot.projection, runningWorkers: 2 } };
    const reconciliation = reconcileProjectionWithTaskLedger(contradictory, ledgerWithRunningTask());
    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      projectionRunningWorkers: 2,
      ledgerRunningTasks: 1,
    });
    expect(reconciliation.detail).toContain('runningWorkers=2');
    const observation = projectionObservation(contradictory, reconciliation);
    expect(observation.sourceReconciliation?.status).toBe('mismatch');
    expect(observation.sourceReconciliation?.detail).toBeTruthy();
    // The contradiction is diagnostic evidence; the readiness decision keeps its
    // original value (a fresh, non-stale snapshot is not blocking).
    expect(projectionBlocksReadiness(contradictory))
      .toBe(projectionBlocksReadiness(contradictory));
    expect(projectionBlocksReadiness(contradictory)).toBe(false);
    const health = evaluateRuntimeHealth(observations({ projection: observation }));
    expect(health.ready).toBe(true);
    expect(health.warnings.map((item) => item.code)).toContain('PROJECTION_SOURCE_MISMATCH');
    expect(health.activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_SOURCE_MISMATCH');
  });

  test('keeps global readiness available when one repository has workflow-only running state', () => {
    const healthy = projectionSnapshot();
    const workflowOnly = {
      ...projectionSnapshot(),
      projection: { ...projectionSnapshot().projection, repoId: 'repo-workflow-only' },
    };
    const reconciliation = reconcileProjectionWithTaskLedger(workflowOnly, ledgerWithRunningTask());
    const repositories = [
      { repoId: 'repo-healthy', snapshot: healthy },
      { repoId: 'repo-workflow-only', snapshot: workflowOnly },
    ];

    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      projectionRunningWorkers: 0,
      ledgerRunningTasks: 1,
    });
    expect(repositories.filter(({ snapshot }) => projectionBlocksReadiness(snapshot))).toEqual([]);
  });

  test('still blocks a stale projection when live execution invariants are at risk', () => {
    const snapshot = projectionSnapshot();
    const staleActiveSnapshot: RepositoryRuntimeProjectionSnapshot = {
      ...snapshot,
      stale: true,
      dirtySinceAt: new Date(Date.now() - 60_000).toISOString(),
      sourceRevisionChanged: true,
      projection: {
        ...snapshot.projection,
        activeJobs: [{
          jobId: 'job-live',
          type: 'agent-run',
          status: 'running',
          priority: 'P1',
          updatedAt: new Date().toISOString(),
          workerPid: process.pid,
        }],
        runningWorkers: 1,
      },
    };

    expect(projectionBlocksReadiness(staleActiveSnapshot)).toBe(true);
  });

  test('classifies bounded probe aborts separately from generic runtime failures', () => {
    expect(classifyFailure('probe_timeout: operation was aborted')).toBe('transient_probe_timeout');
    expect(classifyFailure('worker quit unexpectedly')).toBe('agent_runtime_failure');
  });

  test('persists request-level MCP timing and incident records with the same trace identity', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-observability-'));
    try {
      const traceId = 'trace-fixture';
      const requestId = 'request-fixture';
      recordMcpTiming(controllerHome, {
        tool: 'controller_ready',
        traceId,
        requestId,
        layer: 'public_gateway',
        startedAt: '2026-08-14T13:00:00.000Z',
        outcome: 'error',
        errorCode: 'PUBLIC_STABLE_ENDPOINT_UNHEALTHY',
        repoId: 'repo-fixture',
        workId: 'work-fixture',
        processId: 'proc-fixture',
        route: 'process_managed',
        totalToolDurationMs: 12,
      });
      recordMcpIncident(controllerHome, {
        traceId,
        requestId,
        tool: 'controller_ready',
        kind: 'tool_error',
        code: 'PUBLIC_STABLE_ENDPOINT_UNHEALTHY',
        message: 'fixture',
      });
      const timing = JSON.parse(readFileSync(join(controllerHome, 'audit', 'mcp-timings.jsonl'), 'utf8')) as Record<string, unknown>;
      const incident = JSON.parse(readFileSync(join(controllerHome, 'audit', 'mcp-incidents.jsonl'), 'utf8')) as Record<string, unknown>;
      expect(timing).toMatchObject({
        traceId,
        requestId,
        layer: 'public_gateway',
        startedAt: '2026-08-14T13:00:00.000Z',
        outcome: 'error',
        repoId: 'repo-fixture',
        workId: 'work-fixture',
        processId: 'proc-fixture',
        route: 'process_managed',
      });
      expect(incident).toMatchObject({ traceId, requestId, code: 'PUBLIC_STABLE_ENDPOINT_UNHEALTHY' });
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('promotes only recurrent source-authority-proven Forge incidents into one canonical repair Work', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-incident-repair-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-incident-repair-repo-'));
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'package.json'), '{\"name\":\"forge-incident-repair-fixture\",\"private\":true}\n');
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'fixture'], { cwd: repoRoot, stdio: 'ignore' });
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
      const makeIncident = (index: number) => ({
        traceId: `trace-recurrent-${index}`,
        requestId: `request-recurrent-${index}`,
        tool: index % 2 === 0 ? 'rh_work' : 'repository_command_execute',
        kind: 'tool_error' as const,
        code: 'CONTROLLER_AUTHENTICATED_SESSION_REQUIRED',
        message: 'reconnect or provide session_id through the authenticated MCP transport',
        repoId: 'repo-business-affected',
      });

      expect(classifyForgeIncidentForRepair(makeIncident(1))).toMatchObject({ eligible: true, rootCode: 'CONTROLLER_AUTHENTICATED_SESSION_REQUIRED' });
      expect(classifyForgeIncidentForRepair({ ...makeIncident(1), code: 'TOOL_NOT_FOUND' })).toMatchObject({ eligible: false });

      let repairWorkId: string | undefined;
      for (let index = 1; index <= 4; index += 1) {
        const incident = makeIncident(index);
        recordMcpIncident(controllerHome, incident);
        const result = maybeRegisterMcpIncidentRepair({ controllerHome, runtimeSourceRoot: repoRoot, incident });
        if (index < 3) {
          expect(result).toMatchObject({ eligible: true, recurrent: false, occurrenceCount: index });
          expect(result.workId).toBeUndefined();
          continue;
        }
        if (index === 3) {
          expect(result).toMatchObject({ eligible: true, recurrent: true, repairRepoId: repository.repoId, reusedExistingWork: false });
          expect(result.workId).toBeTruthy();
          expect(result.scheduleId).toBeTruthy();
          repairWorkId = result.workId;
        } else {
          expect(result).toMatchObject({ eligible: true, recurrent: true, workId: repairWorkId, reusedExistingWork: true });
        }
      }

      const works = listWorkContracts({ controllerHome, repoId: repository.repoId, status: 'all', limit: 100 })
        .filter((work) => work.requestId?.startsWith('forge-incident-repair:'));
      expect(works).toHaveLength(1);
      expect(works[0]).toMatchObject({
        workId: repairWorkId,
        requestedBy: 'system',
        workKind: 'repository_change',
        status: 'running',
      });
      expect(works[0]?.evidenceRefs.filter((entry) => entry.evidenceId?.startsWith('MCPINC-')).length).toBe(4);
      const schedules = listWorkContinuationSchedules(controllerHome, repository.repoId, { workId: repairWorkId });
      expect(schedules.schedules).toHaveLength(1);
      expect(schedules.schedules[0]).toMatchObject({
        enabled: true,
        trigger: { type: 'interval', everyMinutes: 5 },
        policy: { shadowMode: false },
        action: { operation: 'external_controller_wake', arguments: { work_id: repairWorkId, controller_type: 'chatgpt' } },
      });

      updateWorkContract({ controllerHome, repoId: repository.repoId }, repairWorkId!, { status: 'cancelled' });
      const recurrentAfterTerminal = makeIncident(5);
      recordMcpIncident(controllerHome, recurrentAfterTerminal);
      const successor = maybeRegisterMcpIncidentRepair({ controllerHome, runtimeSourceRoot: repoRoot, incident: recurrentAfterTerminal });
      expect(successor).toMatchObject({ eligible: true, recurrent: true, reusedExistingWork: false, repairRepoId: repository.repoId });
      expect(successor.workId).toBeTruthy();
      expect(successor.workId).not.toBe(repairWorkId);
      const generations = listWorkContracts({ controllerHome, repoId: repository.repoId, status: 'all', limit: 100 })
        .filter((work) => work.requestId?.startsWith('forge-incident-repair:'))
        .sort((left, right) => (left.requestId ?? '').localeCompare(right.requestId ?? ''));
      expect(generations).toHaveLength(2);
      expect(generations.map((work) => work.requestId?.split(':').at(-1))).toEqual(['g1', 'g2']);
      expect(getWorkContract({ controllerHome, repoId: repository.repoId }, successor.workId!)?.evidenceRefs)
        .toEqual(expect.arrayContaining([expect.objectContaining({ title: 'incident repair predecessor' })]));
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not promote recurrent incidents when Runtime source authority cannot be proven', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-incident-unmapped-controller-'));
    try {
      let latest;
      for (let index = 1; index <= 3; index += 1) {
        const incident = {
          traceId: `trace-unmapped-${index}`,
          requestId: `request-unmapped-${index}`,
          tool: 'rh_status',
          kind: 'exception' as const,
          code: 'MCP_REQUEST_EXCEPTION',
          message: 'Connection failed while contacting Canonical Runtime',
        };
        recordMcpIncident(controllerHome, incident);
        latest = maybeRegisterMcpIncidentRepair({ controllerHome, runtimeSourceRoot: join(controllerHome, 'unknown-release'), incident });
      }
      expect(latest).toMatchObject({ eligible: true, recurrent: true });
      expect(latest?.workId).toBeUndefined();
      expect(latest?.reason).toContain('source authority');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('serves the bounded default tools/list and retains explicit Advanced compatibility plus full fallback', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-core-tools-'));
    const listNames = async (toolset?: 'facade' | 'core' | 'advanced') => {
      const server = createForgeMcpServer({ controllerHome, profile: 'controller', ...(toolset ? { toolset } : {}) });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: `runtime-tools-${toolset ?? 'default'}`, version: '1.0.0' }, { capabilities: {} });
      let toolListChanged = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        toolListChanged += 1;
      });
      await client.connect(clientTransport);
      try {
        expect(client.getServerVersion()?.version).toBe(FORGE_VERSION);
        expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
        expect(toolListChanged).toBe(1);
        return (await client.listTools()).tools.map((tool) => tool.name);
      } finally {
        await client.close();
        await server.close();
      }
    };
    try {
      const defaultNames = await listNames();
      expect(defaultNames).toEqual([...DEFAULT_CONTROLLER_TOOL_NAMES]);
      expect(defaultNames).toEqual(expect.arrayContaining(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']));
      expect(defaultNames).toContain('repository_command_execute');
      expect(defaultNames).not.toContain('repository_git_status');
      expect(defaultNames).not.toContain('git_commit_paths');

      const facadeNames = await listNames('facade');
      expect(facadeNames).toEqual([...PREFERRED_FACADE_TOOL_NAMES]);
      expect(facadeNames).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
      expect(facadeNames).not.toContain('repository_command_execute');
      expect(facadeNames).not.toContain('run_check');

      const coreNames = await listNames('core');
      expect(coreNames).toEqual(defaultNames);

      const advancedNames = await listNames('advanced');
      expect(advancedNames).toEqual(defaultNames);
      expect(advancedNames).toContain('repository_command_execute');
      expect(advancedNames).not.toContain('verify_edit_session');
      // Full compatibility profile still exposes the atomic Git handlers.
      const fullServer = createForgeMcpServer({ controllerHome, profile: 'controller', toolset: 'full' });
      const [fullClientTransport, fullServerTransport] = InMemoryTransport.createLinkedPair();
      await fullServer.connect(fullServerTransport);
      const fullClient = new Client({ name: 'runtime-tools-full', version: '1.0.0' }, { capabilities: {} });
      await fullClient.connect(fullClientTransport);
      try {
        const fullNames = (await fullClient.listTools()).tools.map((tool) => tool.name);
        expect(fullNames).toContain('repository_git_status');
        expect(fullNames).toContain('git_commit_paths');
        expect(fullNames).toContain('verify_edit_session');
        expect(fullNames.length).toBeGreaterThan(defaultNames.length);
      } finally {
        await fullClient.close();
        await fullServer.close();
      }
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('writes the same trace identity into response metadata and incident records', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-trace-'));
    const server = createForgeMcpServer({ controllerHome, profile: 'controller', toolset: 'full' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'runtime-observability', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'no_such_runtime_tool', arguments: {} });
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      const meta = structured?.responseMeta as Record<string, unknown> | undefined;
      expect(meta?.traceId).toBeTruthy();
      const traceId = String(meta!.traceId);
      const incidents = readFileSync(join(controllerHome, 'audit', 'mcp-incidents.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as { traceId: string; code: string });
      expect(incidents.some((entry) => entry.traceId === traceId && entry.code === 'TOOL_NOT_FOUND')).toBe(true);
      const timings = readFileSync(join(controllerHome, 'audit', 'mcp-timings.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as { traceId: string; requestId?: string; layer?: string; startedAt?: string });
      const timing = timings.find((entry) => entry.traceId === traceId);
      expect(timing).toMatchObject({ layer: 'public_gateway' });
      expect(timing?.requestId).toBe(String(meta?.requestId ?? ''));
      expect(Number.isNaN(Date.parse(timing?.startedAt ?? ''))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('release canary targets the candidate Process Runner instead of the running Runtime executable', () => {
    const runnerPath = join(tmpdir(), 'candidate-release', 'process-runner.js');
    const command = processRunnerReleaseCanaryChildCommand(runnerPath);

    expect(command).toEqual({
      executable: runnerPath,
      args: [PROCESS_RUNNER_RELEASE_CANARY_CHILD_ARG],
    });
    expect(command.executable).not.toBe(process.execPath);
  });

  describe('executionReady / maintenanceHealthy / releaseReady semantics', () => {
    test('maintenance debt never downgrades execution readiness', () => {
      const health = evaluateRuntimeHealth(observations());
      expect(health.ready).toBe(true);
      expect(classifyRuntimeReadinessSemantics(health, { maintenanceHealthy: false })).toMatchObject({
        executionReady: true, maintenanceHealthy: false, releaseReady: true,
      });
    });

    test('durable queue debt downgrades release readiness but not ordinary execution', () => {
      const health = evaluateRuntimeHealth({
        ...observations(),
        workers: { queueDepth: 2, runningWorkers: 0, activeLeases: 0, activeAttentionCount: 0 },
      });
      expect(health.ready).toBe(false);
      const semantics = classifyRuntimeReadinessSemantics(health);
      expect(semantics.executionReady).toBe(true);
      expect(semantics.releaseReady).toBe(false);
    });

    test('real execution failures still downgrade execution readiness', () => {
      const health = evaluateRuntimeHealth({ ...observations(), daemon: { status: 'not_ready', error: 'runtime down' } });
      expect(health.ready).toBe(false);
      const semantics = classifyRuntimeReadinessSemantics(health);
      expect(semantics.executionReady).toBe(false);
      expect(semantics.releaseReady).toBe(false);
    });

    test('stale legacy metadata does not block ordinary read and command execution', async () => {
      const root = mkdtempSync(join(tmpdir(), 'forge-readiness-semantics-'));
      try {
        const controllerHome = join(root, 'controller-home');
        const repoRoot = join(root, 'repo');
        mkdirSync(controllerHome, { recursive: true });
        mkdirSync(repoRoot, { recursive: true });
        const git = (args: string[]) => {
          const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf-8' });
          if (result.status !== 0) throw new Error(result.stderr);
        };
        git(['init', '-b', 'main']);
        git(['config', 'user.email', 'forge@example.invalid']);
        git(['config', 'user.name', 'Forge Test']);
        writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
        git(['add', '.']);
        git(['commit', '-qm', 'initial']);

        const repository = registerRepository({ path: repoRoot, controllerHome });
        mkdirSync(join(repoRoot, '.ai', 'harness', 'local-jobs', 'stale-job'), { recursive: true });
        const maintenance = buildRuntimeMaintenanceStatus(repository, controllerHome, { maxCandidates: 10 });
        expect(maintenance.candidates.length).toBeGreaterThan(0);
        expect(maintenance.readyForExecution).toBe(false);

        const ctx = createMultiRepositoryContext({ repo: repoRoot, profile: 'controller', controllerHome });
        const read = await callRepositoryTool(controllerHome, 'read_repository_file', {
          repo_id: repository.repoId,
          path: 'README.md',
        }, ctx);
        expect(read).toBeTruthy();
        expect(JSON.parse(read?.content[0]?.text ?? '{}').content).toContain('fixture');

        const command = await callRepositoryTool(controllerHome, 'repository_command_execute', {
          repo_id: repository.repoId,
          command: ['git', 'status', '--short'],
          timeout_ms: 5_000,
        });
        expect(command?.isError).not.toBe(true);
        expect(JSON.parse(command?.content[0]?.text ?? '{}').accepted).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
