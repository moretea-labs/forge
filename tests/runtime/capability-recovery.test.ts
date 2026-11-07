import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RECOVERY_ACTIONS,
  AUTOMATIC_RUNTIME_MAINTENANCE_ACTION_ALLOWLIST,
  assertRecoveryAuthorized,
  buildCapabilityRecoverySnapshot,
  buildPatchHandoffArtifact,
  buildRecoveryAuditRecord,
  buildRuntimeMaintenanceStatus,
  applyRuntimeMaintenance,
  cleanupRuntimeQuarantine,
  runtimeLegacyCheckQuarantineRoot,
  classifyFailure,
  detectDirtyPathConflicts,
  recoveryActionById,
} from '../../src/runtime/recovery';
import { applyEditOperations, beginEditSession, getEditSession } from '../../src/cli/editing/edit-session';
import { addRepositoryCheckout, getRepository, registerRepository } from '../../src/cli/repositories/registry';
import { ensureRepositoryRuntimeStorageBinding } from '../../src/cli/repositories/runtime-storage';
import { getMcpPolicy } from '../../adapters/mcp/policy';
import { applyControllerHomeMigration } from '../../src/runtime/control-plane/persistence/controller-home-migration';
import { assertOwnedResourceCleanupTarget, getOwnedResource, recordOwnedResource } from '../../packages/kernel/identity/api/index';
import { managedBranchOwnedResourceId, managedBranchOwnedResourceLocator, managedWorkspaceOwnedResourceId } from '../../src/runtime/execution/managed-workspace';
import { recordIosTestEvidenceOwner } from '../../src/runtime/control-plane/generated-cache-retention';
import {
  applyExternalFilesystemGrant,
  buildWorkspaceAuthStatus,
  prepareWorkspaceAuthLogin,
  previewExternalFilesystemGrant,
  readExternalFilesystemSnapshot,
} from '../../src/runtime/safe-tooling';
import { replaceHistoricalWorkContract, seedHistoricalWorkContract } from '../helpers/historical-work-contract';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createCancelledWork(
  options: Parameters<typeof seedHistoricalWorkContract>[0],
  input: Parameters<typeof seedHistoricalWorkContract>[1],
) {
  return seedHistoricalWorkContract(options, { ...input, semanticState: 'cancelled' });
}

describe('capability recovery classifier', () => {
  it('classifies platform blocks without treating them as local failures', () => {
    expect(classifyFailure("This tool call was blocked by OpenAI's safety checks.")).toBe('platform_blocked');
  });

  it('classifies auth and agent runtime failures', () => {
    expect(classifyFailure('Transport channel closed, when Auth(AuthorizationRequired)')).toBe('auth_required');
    expect(classifyFailure('timeout waiting for child process to exit')).toBe('agent_runtime_failure');
  });

  it('classifies recent controller run failure samples into stable recovery classes', () => {
    expect(classifyFailure('Controller process 86981 is no longer running')).toBe('agent_runtime_failure');
    expect(classifyFailure('实现完成，但自动集成需要处理：7 edit operations failed precondition checks')).toBe('dirty_worktree_conflict');
    expect(classifyFailure('Response payload is not completed: ContentLengthError: Not enough data to satisfy content length header.')).toBe('agent_runtime_failure');
    expect(classifyFailure("You've hit your usage limit. Upgrade to Pro, purchase more credits or try again later.")).toBe('user_action_required');
  });

  it('classifies runtime storage local-job blockers distinctly', () => {
    expect(classifyFailure('RUNTIME_STORAGE_NOT_READY: local-jobs: active or unreadable Local Jobs must finish before runtime storage can be relocated')).toBe('local_jobs_legacy_active');
  });

  it('classifies external filesystem grants separately from generic policy denial', () => {
    expect(classifyFailure('Browser action forbidden by policy')).toBe('policy_denied');
    expect(classifyFailure('SELECTED_PATH_SCOPE_DENIED: /Users/me/Downloads/file.txt escapes the selected repository')).toBe('external_filesystem_grant_required');
  });
});

describe('capability recovery probe', () => {
  it('reports ready when local capabilities are healthy', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      queueDepth: 0,
      runningWorkers: 0,
      activeLeases: 0,
      localBridgeRunning: true,
      connectorHealthy: true,
      runtimeProjectionStale: false,
      runtimeProjectionPersisted: true,
      commandPreviewAvailable: true,
      commandExecuteAvailable: true,
      issueToolsAvailable: true,
      jobToolsAvailable: true,
      pluginStates: [{ pluginId: 'github', enabled: true, healthState: 'ready', ready: true }],
    });

    expect(snapshot.overallState).toBe('ready');
    expect(snapshot.fallbackRequired).toBe(false);
  });

  it('turns missing Runtime source snapshot into one external lifecycle handoff', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-08-07T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      queueDepth: 0,
      runningWorkers: 0,
      activeLeases: 0,
      localBridgeRunning: true,
      connectorHealthy: true,
      runtimeProjectionStale: false,
      runtimeProjectionPersisted: true,
      runtimeSourceCoherence: {
        ready: false,
        code: 'RUNTIME_SOURCE_SNAPSHOT_MISSING',
        reasons: ['Controller runtime source snapshot is missing'],
        summary: 'Controller runtime source snapshot is missing.',
      },
      commandPreviewAvailable: true,
      commandExecuteAvailable: true,
      issueToolsAvailable: true,
      jobToolsAvailable: true,
    });

    const source = snapshot.capabilities.find((capability) => capability.id === 'runtime.source_coherence');
    expect(snapshot.overallState).toBe('blocked');
    expect(snapshot.fallbackRequired).toBe(true);
    expect(source?.class).toBe('external_lifecycle_required');
    expect(source?.suggestedActions).toEqual([]);
    expect(snapshot.externalLifecycleHandoff).toMatchObject({
      owner: 'external_runtime_lifecycle',
      target: 'forge-runtime',
      reasonCode: 'RUNTIME_SOURCE_SNAPSHOT_MISSING',
      requiredAction: 'restart_existing_single_runtime',
    });
    expect(snapshot.externalLifecycleHandoff?.constraints.join(' ')).toContain('second Runtime');
    expect(snapshot.recommendedActions.map((action) => action.id)).not.toContain('recovery.restart_controller');
  });

  it('routes platform blocks to patch handoff instead of restart loops', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      localBridgeRunning: true,
      connectorHealthy: true,
      commandPreviewAvailable: true,
      commandExecuteAvailable: false,
      issueToolsAvailable: false,
      jobToolsAvailable: false,
      recentErrors: ["This tool call was blocked by OpenAI's safety checks."],
    });

    const actionIds = snapshot.recommendedActions.map((action) => action.id);
    expect(snapshot.platformBlocked).toBe(true);
    expect(snapshot.fallbackRequired).toBe(true);
    expect(actionIds).toContain('recovery.create_patch_handoff');
    expect(actionIds).not.toContain('recovery.restart_controller');
  });

  it('routes edit precondition failures to patch handoff instead of overwriting dirty paths', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-08T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      localBridgeRunning: true,
      connectorHealthy: true,
      commandPreviewAvailable: true,
      commandExecuteAvailable: true,
      issueToolsAvailable: true,
      jobToolsAvailable: true,
      executionJobs: [{ status: 'waiting_for_user', error: '实现完成，但自动集成需要处理：7 edit operations failed precondition checks' }],
    });

    const recentFailures = snapshot.capabilities.find((capability) => capability.id === 'recent.failures');
    const actionIds = snapshot.recommendedActions.map((action) => action.id);
    expect(recentFailures?.class).toBe('dirty_worktree_conflict');
    expect(actionIds).toContain('recovery.create_patch_handoff');
    expect(actionIds).not.toContain('recovery.restart_controller');
  });

  it('routes runtime storage blockers to the maintenance executor', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      localBridgeRunning: true,
      connectorHealthy: true,
      runtimeStorageReady: false,
      runtimeStorageWarnings: ['local-jobs: active or unreadable Local Jobs must finish before runtime storage can be relocated'],
      commandPreviewAvailable: true,
      commandExecuteAvailable: false,
      recentErrors: ['RUNTIME_STORAGE_NOT_READY: local-jobs: active or unreadable Local Jobs must finish before runtime storage can be relocated'],
    });

    const actionIds = snapshot.recommendedActions.map((action) => action.id);
    expect(snapshot.capabilities.find((capability) => capability.id === 'runtime.storage')?.class).toBe('local_jobs_legacy_active');
    expect(actionIds).toContain('recovery.local_jobs_reconcile');
    expect(actionIds).toContain('recovery.runtime_storage_finalize_relocation');
    expect(snapshot.notes.join(' ')).toContain('runtime_maintenance_apply');
  });

  it('routes plugin auth failures to the Workspace auth handoff', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      localBridgeRunning: true,
      connectorHealthy: true,
      pluginStates: [{ pluginId: 'gmail', enabled: true, healthState: 'error', ready: false, errors: ['Set one of FORGE_GMAIL_ACCESS_TOKEN before invoking gmail Google Workspace actions.'] }],
    });

    expect(snapshot.recommendedActions.map((action) => action.id)).toContain('recovery.workspace_auth_login_prepare');
  });

  it('detects stale worker state as recoverable runtime state', () => {
    const snapshot = buildCapabilityRecoverySnapshot({
      generatedAt: '2026-07-05T00:00:00.000Z',
      daemonStatus: 'ready',
      schedulerStatus: 'ready',
      queueDepth: 2,
      runningWorkers: 0,
      activeLeases: 1,
      localBridgeRunning: true,
      connectorHealthy: true,
    });

    expect(snapshot.capabilities.find((capability) => capability.id === 'worker.loop')?.class).toBe('stale_runtime_state');
    expect(snapshot.recommendedActions.map((action) => action.id)).toContain('recovery.local_jobs_reconcile');
  });
});

describe('authorized recovery actions', () => {
  it('requires explicit authorization for mutating recovery', () => {
    expect(() => assertRecoveryAuthorized(RECOVERY_ACTIONS.rebuildProjection)).toThrow('RECOVERY_AUTHORIZATION_REQUIRED');
    expect(() => assertRecoveryAuthorized(RECOVERY_ACTIONS.rebuildProjection, RECOVERY_ACTIONS.rebuildProjection.id)).not.toThrow();
    expect(() => assertRecoveryAuthorized(RECOVERY_ACTIONS.cleanupApply)).toThrow('RECOVERY_AUTHORIZATION_REQUIRED');
    expect(() => assertRecoveryAuthorized(RECOVERY_ACTIONS.cleanupApply, RECOVERY_ACTIONS.cleanupApply.id)).not.toThrow();
  });

  it('does not resolve deleted Runtime lifecycle or autonomous source-repair actions', () => {
    expect(recoveryActionById('recovery.restart_controller')).toBeUndefined();
    expect(recoveryActionById('recovery.restart_local_bridge')).toBeUndefined();
    expect(recoveryActionById('recovery.create_self_fix_task')).toBeUndefined();
  });

  it('builds audit evidence records', () => {
    const record = buildRecoveryAuditRecord({
      actor: 'test',
      action: RECOVERY_ACTIONS.localJobsReconcile,
      result: 'planned',
      reason: 'stale lease evidence',
      affectedPaths: ['.ai/harness/jobs'],
      at: '2026-07-05T00:00:00.000Z',
    });

    expect(record.id).toMatch(/^REC-/);
    expect(record.confirmation).toBe('authorization');
    expect(record.affectedPaths).toEqual(['.ai/harness/jobs']);
  });
});


describe('runtime maintenance executor', () => {
  function advanceWorkToCleanup(store: { controllerHome: string; repoId: string; now?: () => string }, workId: string): void {
    replaceHistoricalWorkContract(store, {
      workId,
      phase: 'cleanup',
      phaseEvidence: {
        implementation: { state: 'satisfied', source: 'recorded', summary: 'Historical fixture implementation complete.', evidenceRefs: [], recordedAt: store.now?.() ?? '2026-01-01T00:00:00.000Z' },
        verification: { state: 'satisfied', source: 'recorded', summary: 'Historical fixture verification complete.', evidenceRefs: [], recordedAt: store.now?.() ?? '2026-01-01T00:00:00.000Z' },
        review: { state: 'satisfied', source: 'recorded', summary: 'Historical fixture review complete.', evidenceRefs: [], recordedAt: store.now?.() ?? '2026-01-01T00:00:00.000Z' },
        delivery: { state: 'satisfied', source: 'recorded', summary: 'Historical fixture delivery complete.', evidenceRefs: [], recordedAt: store.now?.() ?? '2026-01-01T00:00:00.000Z' },
        cleanup: { state: 'satisfied', source: 'recorded', summary: 'Historical fixture cleanup state.', evidenceRefs: [], recordedAt: store.now?.() ?? '2026-01-01T00:00:00.000Z' },
      },
    });
  }
  function tempRepo() {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-test-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, '_controller_home');
    const localJobs = join(root, '.ai/harness/local-jobs');
    mkdirSync(localJobs, { recursive: true });
    return { root, controllerHome, localJobs, repository: { repoId: 'repo-test', canonicalRoot: root } };
  }

  function staleManagedWorkFixture(source: 'clean' | 'dirty' | 'committed') {
    const root = mkdtempSync(join(tmpdir(), `forge-maintenance-stale-managed-${source}-`));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    const repoId = `repo-stale-managed-${source}`;
    const workId = `work-stale-managed-${source}`;
    const worktree = join(root, '.forge', 'controller', 'managed-worktrees', repoId, `work-${source}`);
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), '# stale managed work\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    mkdirSync(join(root, '.forge', 'controller', 'managed-worktrees', repoId), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', `work/${source}`, worktree, 'HEAD'], { cwd: repoRoot });
    seedHistoricalWorkContract({ controllerHome, repoId, now: () => '2026-01-01T00:00:00.000Z' }, {
      workId,
      repoId,
      objective: `stale managed ${source} work`,
      acceptanceCriteria: ['preserve unique source'],
      allowedPaths: ['**'],
      forbiddenPaths: [],
      checks: [],
      constraints: {},
      requestedBy: 'chatgpt',
      phase: 'verification',
      checkoutId: `checkout-${source}`,
      worktreeRef: worktree,
      baseRevision,
    });
    if (source === 'dirty') {
      mkdirSync(join(worktree, 'docs', 'architecture'), { recursive: true });
      writeFileSync(join(worktree, 'docs', 'architecture', 'global-hook-runtime.md'), '# recent successful write\n');
    } else if (source === 'committed') {
      writeFileSync(join(worktree, 'unique.txt'), 'unique commit\n');
      execFileSync('git', ['add', 'unique.txt'], { cwd: worktree });
      execFileSync('git', ['commit', '-qm', 'unique stale work source'], { cwd: worktree });
    }
    return {
      controllerHome,
      repoRoot,
      repository: { repoId, canonicalRoot: repoRoot, defaultBranch: 'main' },
      workId,
      worktree,
    };
  }


  function editFixture(input: { workStatus?: 'cancelled' | 'running'; createWork?: boolean; applyEdit?: boolean; contractFree?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-edit-session-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    const runtimeTempRoot = join(root, 'system-temp');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(runtimeTempRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'README.md'), '# Test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });

    const registered = registerRepository({ path: repoRoot, displayName: 'maintenance-edit', controllerHome });
    const repoId = registered.repoId;
    const checkoutId = registered.activeCheckoutId;
    ensureRepositoryRuntimeStorageBinding(registered, 'edit-sessions', controllerHome);
    const requestedWorkState = input.workStatus ?? 'cancelled';
    const workId = input.contractFree ? undefined : input.createWork === false ? 'work-missing' : `work-${requestedWorkState}`;
    if (input.createWork !== false && workId) {
      seedHistoricalWorkContract({ controllerHome, repoId }, {
        workId,
        repoId,
        checkoutId,
        objective: 'Characterize stale Edit Session maintenance.',
        acceptanceCriteria: [],
        allowedPaths: ['src/**'],
        forbiddenPaths: [],
        checks: [],
        constraints: { workspaceMode: 'current' },
        requestedBy: 'chatgpt',
        ...(requestedWorkState === 'running' ? { dispatchState: 'running' as const } : {}),
        ...(requestedWorkState === 'cancelled' ? { semanticState: 'cancelled' as const } : {}),
      });
    }
    const binding = { workId, repoId, checkoutId, principalId: 'principal-test', controllerInstanceId: 'controller-instance-test' };
    const session = beginEditSession(repoRoot, {
      purpose: 'Stale Edit Session maintenance fixture',
      allowedPaths: ['src/**'],
      binding,
    });
    if (input.applyEdit !== false) {
      applyEditOperations(repoRoot, getMcpPolicy('controller'), session.sessionId, [
        { type: 'create', path: 'src/session.ts', content: 'export const sessionValue = 1;\n' },
      ], { binding });
    }
    return {
      controllerHome,
      repoRoot,
      repository: { ...registered, runtimeTempRoots: [runtimeTempRoot] },
      sessionId: session.sessionId,
    };
  }

  it('reconciles a clean integrated managed worktree from canonical OwnedResource authority when its WorkContract is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-owned-resource-worktree-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), '# owned resource worktree\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });

    const registered = registerRepository({ path: repoRoot, displayName: 'owned-resource-worktree', controllerHome });
    const branch = 'work/owned-resource-orphan';
    const worktree = join(controllerHome, 'managed-worktrees', registered.repoId, 'work-owned-resource-orphan');
    mkdirSync(join(controllerHome, 'managed-worktrees', registered.repoId), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD'], { cwd: repoRoot });
    const withCheckout = addRepositoryCheckout({ repoId: registered.repoId, path: worktree, controllerHome });
    const checkout = withCheckout.checkouts.find((candidate) => candidate.checkoutId !== registered.activeCheckoutId && candidate.worktree);
    if (!checkout) throw new Error('owned-resource worktree fixture checkout missing');

    const registeredWorktree = checkout.canonicalRoot;
    recordOwnedResource(controllerHome, {
      resourceId: managedWorkspaceOwnedResourceId(registered.repoId, checkout.checkoutId),
      kind: 'worktree',
      targetRef: registeredWorktree,
      creator: 'forge:managed-workspace',
      associatedWorkId: 'work-contract-intentionally-absent',
      repoId: registered.repoId,
      retentionIntent: 'temporary',
    });
    recordOwnedResource(controllerHome, {
      resourceId: managedBranchOwnedResourceId(registered.repoId, checkout.checkoutId),
      kind: 'git_branch',
      targetRef: branch,
      locator: managedBranchOwnedResourceLocator(repoRoot, checkout.checkoutId, branch),
      creator: 'forge:managed-workspace',
      associatedWorkId: 'work-contract-intentionally-absent',
      repoId: registered.repoId,
      retentionIntent: 'retain_on_failure',
    });

    const repository = { repoId: registered.repoId, canonicalRoot: registered.canonicalRoot, defaultBranch: 'main' };
    const before = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(before.candidates).toContainEqual(expect.objectContaining({
      kind: 'unowned_managed_worktree',
      path: registeredWorktree,
      safe: true,
      ownershipStatus: 'explicit',
      sourceState: 'clean_integrated',
    }));

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: 0,
      maxCandidates: 50,
    });
    expect(applied.applied).toContainEqual(expect.objectContaining({
      kind: 'unowned_managed_worktree',
      path: registeredWorktree,
      applied: true,
      result: 'owned_managed_worktree_detached',
    }));
    expect(existsSync(worktree)).toBe(false);
    expect(execFileSync('git', ['branch', '--list', branch], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('');
    expect(getRepository(registered.repoId, controllerHome, { includeRemoved: true }).checkouts.find((candidate) => candidate.checkoutId === checkout.checkoutId)?.lifecycle).toBe('removed');
    expect(getOwnedResource(controllerHome, managedWorkspaceOwnedResourceId(registered.repoId, checkout.checkoutId))?.status).toBe('released');
    expect(getOwnedResource(controllerHome, managedBranchOwnedResourceId(registered.repoId, checkout.checkoutId))?.status).toBe('released');
    expect(applied.summary.unownedManagedWorktrees).toBe(0);
  });

  it('terminalizes stale active Local Jobs without using Local Job tickets', () => {
    const { controllerHome, localJobs, repository } = tempRepo();
    const jobDir = join(localJobs, 'JOB-stale');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, 'job.json'), `${JSON.stringify({
      schemaVersion: 1,
      jobId: 'JOB-stale',
      action: 'repository-command',
      status: 'running',
      createdAt: '2026-07-05T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
      workerPid: 99999999,
    }, null, 2)}
`);

    const before = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 0 });
    expect(before.recommendedActions).toContain('local_jobs_reconcile');
    expect(JSON.stringify(before)).not.toContain('restartEscalation');
    expect(JSON.stringify(before)).not.toContain('controller:restart');

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'local_jobs_reconcile',
      confirmMaintenance: true,
      minAgeMinutes: 0,
    });
    expect(applied.applied.some((candidate) => candidate.applied && candidate.id === 'JOB-stale')).toBe(true);
    const stored = JSON.parse(readFileSync(join(jobDir, 'job.json'), 'utf8')) as { status: string; error: string };
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatch(/runtime maintenance|Runtime storage repair/);
  });

  it('quarantines unreadable Local Job entries only in Controller Home', () => {
    const { root, controllerHome, localJobs, repository } = tempRepo();
    mkdirSync(join(localJobs, 'JOB-broken'), { recursive: true });
    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'quarantine_unreadable_local_jobs',
      confirmMaintenance: true,
      minAgeMinutes: 0,
    });
    const legacyApplied = applied.applied.some((candidate) => candidate.applied && candidate.id === 'JOB-broken');
    const typedApplied = applied.runtimeStorageRepairApply?.applied.some((candidate) => candidate.status === 'applied' && candidate.path.includes('JOB-broken')) ?? false;
    expect(legacyApplied || typedApplied).toBe(true);
    const quarantineRoot = join(controllerHome, 'repositories', repository.repoId, 'quarantine', 'local-jobs');
    expect(readdirSync(quarantineRoot).some((entry) => entry.includes('JOB-broken'))).toBe(true);
    expect(existsSync(join(root, '.ai', 'harness', 'local-jobs-quarantine'))).toBe(false);
    expect(existsSync(join(root, '.ai', 'harness', 'quarantine', 'local-jobs'))).toBe(false);
    const auditPath = applied.runtimeStorageRepairApply?.auditPath;
    expect(auditPath).toMatch(/^repositories\/repo-test\/audit\/runtime-storage-repair\.jsonl$/);
    expect(existsSync(join(controllerHome, auditPath!))).toBe(true);
  });

  it('migrates legacy quarantine without following symlinks and bounds stale retained evidence', () => {
    const { root, controllerHome, repository } = tempRepo();
    const legacy = join(root, '.ai', 'harness', 'local-jobs-quarantine');
    const staleEntry = join(legacy, 'old-evidence');
    mkdirSync(staleEntry, { recursive: true });
    writeFileSync(join(staleEntry, 'payload.log'), 'stale diagnostic evidence\n');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(staleEntry, old, old);

    const outside = join(root, 'outside-quarantine-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'must-survive.txt'), 'user-owned\n');
    const symlinkRoot = join(root, '.ai', 'harness', 'quarantine', 'local-jobs');
    mkdirSync(join(root, '.ai', 'harness', 'quarantine'), { recursive: true });
    symlinkSync(outside, symlinkRoot, 'dir');

    const report = cleanupRuntimeQuarantine(controllerHome, repository.repoId, root, {
      nowMs: Date.now(), retentionMs: 60_000, maxRetainedEntries: 10,
      maxRetainedBytes: 1024 * 1024, maxEntries: 20, maxRemovals: 20,
    });
    expect(report.policyVersion).toBe('runtime-quarantine-retention-v1');
    expect(report.migratedLegacyCount).toBe(2);
    expect(report.removedCount).toBe(1);
    expect(report.reclaimedBytes).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(symlinkRoot)).toBe(false);
    expect(readFileSync(join(outside, 'must-survive.txt'), 'utf8')).toBe('user-owned\n');
    const quarantineRoot = join(controllerHome, 'repositories', repository.repoId, 'quarantine', 'local-jobs');
    expect(readdirSync(quarantineRoot).some((entry) => entry.startsWith('legacy-root-local-jobs'))).toBe(true);

    const again = cleanupRuntimeQuarantine(controllerHome, repository.repoId, root, {
      nowMs: Date.now(), retentionMs: 60_000, maxEntries: 20, maxRemovals: 20,
    });
    expect(again.migratedLegacyCount).toBe(0);
    expect(again.removedCount).toBe(0);
  });

  it('bounds retired legacy-check quarantine with the shared maintenance budget', () => {
    const { controllerHome, repository } = tempRepo();
    const legacyChecks = runtimeLegacyCheckQuarantineRoot(controllerHome, repository.repoId);
    const stale = join(legacyChecks, 'old-check-bytes');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'latest.json'), '{"legacy":true}\n');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(stale, old, old);

    const report = cleanupRuntimeQuarantine(controllerHome, repository.repoId, repository.canonicalRoot, {
      nowMs: Date.now(),
      retentionMs: 60_000,
      maxRetainedEntries: 10,
      maxRetainedBytes: 1024 * 1024,
      maxEntries: 20,
      maxRemovals: 1,
      additionalRoots: [legacyChecks],
    });

    expect(report.roots).toContain(legacyChecks);
    expect(report.removedCount).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it('rotates explicit generated-cache maintenance past a saturated checkout scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-cache-rotation-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
    const registered = registerRepository({ path: repoRoot, displayName: 'cache-rotation', controllerHome });
    const worktree = join(root, 'worktree');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'test/cache-rotation', worktree, 'HEAD'], { cwd: repoRoot });
    addRepositoryCheckout({ repoId: registered.repoId, path: worktree, controllerHome });

    // Exhaust the explicit pass's minimum 1,000-entry budget in the first root.
    const noiseRoot = join(repoRoot, '.repo-harness');
    for (let i = 0; i < 1_005; i++) mkdirSync(join(noiseRoot, `noise-${i.toString().padStart(4, '0')}`), { recursive: true });
    const cache = join(worktree, '.repo-harness', 'ios-build', 'DerivedData');
    mkdirSync(join(cache, 'Build'), { recursive: true });
    writeFileSync(join(cache, 'info.plist'), 'rebuildable Xcode cache fixture');
    writeFileSync(join(cache, 'Build', 'compiled.bin'), 'rebuildable');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(cache, 'Build'), old, old);
    utimesSync(cache, old, old);

    const currentMinute = Math.floor(Date.now() / 60_000);
    const firstMinute = currentMinute + (currentMinute % 2);
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(firstMinute * 60_000);
      const first = applyRuntimeMaintenance(registered, controllerHome, {
        actionId: 'full_maintenance_pass', confirmMaintenance: true, maxCandidates: 1,
      });
      expect(first.generatedCacheGc?.rootsInspected).toBe(1);
      expect(first.generatedCacheGc?.budgetExhausted).toBe(true);
      expect(existsSync(join(cache, 'Build'))).toBe(true);

      // The next minute must visit the other checkout instead of repeatedly
      // scanning the saturated canonical root.
      now.mockReturnValue((firstMinute + 1) * 60_000);
      const second = applyRuntimeMaintenance(registered, controllerHome, {
        actionId: 'full_maintenance_pass', confirmMaintenance: true, maxCandidates: 1,
      });
      const targetSuffix = ':.repo-harness/ios-build/DerivedData/Build';
      const wasRemoved = second.generatedCacheGc?.removedPaths.some((path) => path.endsWith(targetSuffix));
      const wasRetained = second.generatedCacheGc?.retainedPaths.some((path) => path.endsWith(targetSuffix));
      // A concurrent Xcode suite may legitimately hold this cache while the
      // maintenance test runs. In either case we must reach the second root.
      expect(wasRemoved || wasRetained).toBe(true);
      expect(second.generatedCacheGc?.errors).toEqual([]);
      if (wasRetained) {
        expect(second.generatedCacheGc?.skippedByReason.active_process).toBeGreaterThan(0);
      }
      expect(existsSync(join(cache, 'Build'))).toBe(!wasRemoved);
      expect(existsSync(join(cache, 'info.plist'))).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps maintenance discovery read-only and reconciles committed Direct Edit metadata only during explicit maintenance', () => {
    const fx = editFixture();
    execFileSync('git', ['add', 'src/session.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'commit edit session'], { cwd: fx.repoRoot });

    const before = getEditSession(fx.repoRoot, fx.sessionId);
    const status = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({ kind: 'stale_edit_session', id: fx.sessionId, safe: true }));
    expect(getEditSession(fx.repoRoot, fx.sessionId)).toEqual(before);

    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, { actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50 });
    expect(applied.applied).toContainEqual(expect.objectContaining({ id: fx.sessionId, applied: true, result: 'edit_session_finalized' }));
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('finalized');
  });

  it('keeps supersession reconciliation out of status reads and applies it only during explicit maintenance', () => {
    const fx = editFixture();
    writeFileSync(join(fx.repoRoot, 'src/session.ts'), 'export const sessionValue = 2;\n');

    const before = getEditSession(fx.repoRoot, fx.sessionId);
    const status = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({ kind: 'stale_edit_session', id: fx.sessionId, safe: true }));
    expect(getEditSession(fx.repoRoot, fx.sessionId)).toEqual(before);

    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, { actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50 });
    expect(applied.applied).toContainEqual(expect.objectContaining({ id: fx.sessionId, applied: true, result: 'edit_session_superseded' }));
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('superseded');
    expect(readFileSync(join(fx.repoRoot, 'src/session.ts'), 'utf8')).toBe('export const sessionValue = 2;\n');
  });

  it('fails closed without changing source when a terminal Work edit session still owns unique uncommitted content', () => {
    const fx = editFixture();
    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, {
      actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50,
    });
    expect(applied.applied).toContainEqual(expect.objectContaining({
      id: fx.sessionId,
      applied: false,
      error: expect.stringContaining('unique uncommitted changes'),
    }));
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('dirty');
    expect(readFileSync(join(fx.repoRoot, 'src/session.ts'), 'utf8')).toBe('export const sessionValue = 1;\n');
  });

  it('keeps contract-free Direct Edit discovery read-only and reconciles it during explicit maintenance', () => {
    const fx = editFixture({ contractFree: true });
    execFileSync('git', ['add', 'src/session.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'commit contract-free direct edit'], { cwd: fx.repoRoot });

    const before = getEditSession(fx.repoRoot, fx.sessionId);
    const status = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({ kind: 'stale_edit_session', id: fx.sessionId, safe: true }));
    expect(getEditSession(fx.repoRoot, fx.sessionId)).toEqual(before);
    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, { actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50 });
    expect(applied.applied).toContainEqual(expect.objectContaining({ id: fx.sessionId, applied: true, result: 'edit_session_finalized' }));
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('finalized');
  });


  it('treats historical Work ownership as provenance while EditSession source safety remains authoritative', () => {
    const fx = editFixture({ createWork: false });
    const status = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({ kind: 'stale_edit_session', id: fx.sessionId, safe: true }));
    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, {
      actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50,
    });
    expect(applied.applied.some((candidate) => candidate.id === fx.sessionId && candidate.applied)).toBe(false);
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('dirty');
  });

  it('rolls back an empty stale open session regardless of historical Work provenance', () => {
    const fx = editFixture({ applyEdit: false });
    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, {
      actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50,
    });
    expect(applied.applied).toContainEqual(expect.objectContaining({ id: fx.sessionId, applied: true, result: 'edit_session_rolled_back' }));
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('rolled_back');
    expect(existsSync(join(fx.repoRoot, 'src/session.ts'))).toBe(false);
  });

  it('keeps stale Edit Session cleanup exclusive to explicit full maintenance', () => {
    const fx = editFixture();
    expect(AUTOMATIC_RUNTIME_MAINTENANCE_ACTION_ALLOWLIST.has('full_maintenance_pass')).toBe(false);
    expect(AUTOMATIC_RUNTIME_MAINTENANCE_ACTION_ALLOWLIST.has('local_jobs_reconcile')).toBe(true);
    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, {
      actionId: 'local_jobs_reconcile', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50,
    });
    expect(applied.applied.some((candidate) => candidate.id === fx.sessionId && candidate.applied)).toBe(false);
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('dirty');
  });

  it('treats the default Forge temp namespace as mechanically owned without explicit roots', () => {
    const { controllerHome, repository } = tempRepo();
    const previousTmpdir = process.env.TMPDIR;
    const defaultTempRoot = mkdtempSync(join(tmpdir(), 'forge-maintenance-default-temp-root-'));
    temporaryRoots.push(defaultTempRoot);
    const staleEntry = join(defaultTempRoot, 'forge-default-stale-entry');
    const foreignEntry = join(defaultTempRoot, 'foreign-default-stale-entry');
    mkdirSync(staleEntry, { recursive: true });
    mkdirSync(foreignEntry, { recursive: true });
    const old = new Date(Date.now() - 26 * 60 * 60 * 1_000);
    utimesSync(staleEntry, old, old);
    utimesSync(foreignEntry, old, old);

    try {
      process.env.TMPDIR = defaultTempRoot;
      const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 0, maxCandidates: 200 });
      expect(status.candidates).toContainEqual(expect.objectContaining({
        kind: 'stale_runtime_temp_entry',
        path: staleEntry,
        safe: true,
        ownershipStatus: 'explicit',
      }));
      expect(status.candidates).not.toContainEqual(expect.objectContaining({ path: foreignEntry }));
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  it('removes only stale direct forge temp entries during full maintenance', () => {
    const { root, controllerHome, repository } = tempRepo();
    const runtimeTempRoot = join(root, 'system-temp');
    mkdirSync(runtimeTempRoot, { recursive: true });
    const staleEntry = join(runtimeTempRoot, 'forge-old-entry');
    const recentEntry = join(runtimeTempRoot, 'forge-recent-entry');
    const target = join(runtimeTempRoot, 'target.txt');
    const symbolicLink = join(runtimeTempRoot, 'forge-symlink');
    mkdirSync(staleEntry, { recursive: true });
    mkdirSync(recentEntry, { recursive: true });
    writeFileSync(target, 'preserve');
    symlinkSync(target, symbolicLink);
    const old = new Date(Date.now() - 26 * 60 * 60 * 1_000);
    utimesSync(staleEntry, old, old);

    const boundedRepository = { ...repository, runtimeTempRoots: [runtimeTempRoot] };
    const status = buildRuntimeMaintenanceStatus(boundedRepository, controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.readyForExecution).toBe(true);
    expect(status.summary.staleRuntimeTempEntries).toBe(1);
    expect(status.candidates.filter((candidate) => candidate.kind === 'stale_runtime_temp_entry').map((candidate) => candidate.path)).toEqual([staleEntry]);

    const applied = applyRuntimeMaintenance(boundedRepository, controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: 0,
      maxCandidates: 50,
    });
    expect(applied.applied.some((candidate) => candidate.kind === 'stale_runtime_temp_entry' && candidate.applied)).toBe(true);
    expect(existsSync(staleEntry)).toBe(false);
    expect(existsSync(recentEntry)).toBe(true);
    expect(existsSync(symbolicLink)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('preserve');
  });
});

describe('auth and external filesystem handoffs', () => {
  it('summarizes Gmail auth without exposing secrets and prepares login guidance', () => {
    const status = buildWorkspaceAuthStatus([{
      schemaVersion: 1,
      manifestVersion: 1,
      revision: 1,
      pluginId: 'gmail',
      provider: 'google',
      displayName: 'Gmail',
      pluginVersion: '1.0.0',
      authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: [] },
      enabled: true,
      lifecycle: { state: 'error', reason: 'token missing' },
      health: { state: 'error', checkedAt: '2026-07-05T00:00:00.000Z', ready: false, probed: true, errors: ['access token missing'], warnings: [] },
      permissions: [],
      capabilities: [],
      actions: [],
      updatedAt: '2026-07-05T00:00:00.000Z',
    }]);
    expect((status.actionRequired as unknown[]).length).toBe(1);
    expect(JSON.stringify(status)).not.toContain('secret');
    const login = prepareWorkspaceAuthLogin({ service: 'gmail' }) as { tokenEnvironmentVariables: string[]; safety: { credentialMaterialPersisted: boolean } };
    expect(login.tokenEnvironmentVariables).toContain('FORGE_GMAIL_ACCESS_TOKEN');
    expect(login.safety.credentialMaterialPersisted).toBe(false);
  });

  it('previews, applies, and reads bounded external filesystem targets', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-external-fs-repo-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'forge-external-fs-target-'));
    temporaryRoots.push(repoRoot, externalRoot);
    writeFileSync(join(externalRoot, 'note.txt'), 'hello external');
    const preview = previewExternalFilesystemGrant(repoRoot, {
      grant_key: 'notes',
      root_path: externalRoot,
      reason: 'test fixture',
    });
    expect(preview.accepted).toBe(true);
    const applied = applyExternalFilesystemGrant(repoRoot, {
      grant_key: 'notes',
      root_path: externalRoot,
      reason: 'test fixture',
      preview_ticket_id: preview.previewTicketId,
      confirm_authorization: true,
    });
    expect(applied.grant.key).toBe('notes');
    const snapshot = readExternalFilesystemSnapshot(repoRoot, { target_key: 'notes', path: 'note.txt' });
    expect(snapshot.kind).toBe('file');
    expect(snapshot.text).toBe('hello external');
  });
});

describe('sandbox patch handoff artifact', () => {
  it('deduplicates touched paths and records a stable diff hash', () => {
    const artifact = buildPatchHandoffArtifact({
      issueId: 'ISS-1',
      taskId: 'T1',
      baseHead: 'abc123',
      branch: 'worktree/recovery',
      diff: 'diff --git a/a b/a\n',
      touchedPaths: ['src/a.ts', 'src/a.ts'],
      checks: [{ id: 'package:check:type', status: 'passed' }],
      actor: 'codex',
      source: 'blocked-chatgpt-session',
      createdAt: '2026-07-05T00:00:00.000Z',
    });

    expect(artifact.id).toMatch(/^PATCH-/);
    expect(artifact.touchedPaths).toEqual(['src/a.ts']);
    expect(artifact.checks).toEqual([{ id: 'package:check:type', status: 'passed' }]);
    expect(artifact.provenance).toEqual({ actor: 'codex', workspace: 'isolated_worktree', source: 'blocked-chatgpt-session' });
    expect(artifact.integration.safeToApply).toBe(true);
  });

  it('detects dirty path conflicts before integration', () => {
    expect(detectDirtyPathConflicts(['src/a.ts', 'src/b.ts'], ['src/b.ts'])).toEqual(['src/b.ts']);
  });
});

describe('owned worktree identity across macOS remounts', () => {
  it('pins replay provenance and verifies disk identity despite a supplied fingerprint', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-resource-replay-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const input = { resourceId: 'pinned-replay', kind: 'worktree' as const, targetRef: worktree,
      creator: 'forge:managed-workspace', repoId: 'repo-original', associatedWorkId: 'work-original' };
    const original = recordOwnedResource(controllerHome, input);
    expect(recordOwnedResource(controllerHome, input)).toEqual(original);
    for (const change of [{ creator: 'other' }, { repoId: 'other' }, { associatedWorkId: 'other' }, { associatedRequirementId: 'other' }]) {
      expect(() => recordOwnedResource(controllerHome, { ...input, ...change })).toThrow('OWNED_RESOURCE_IDENTITY_CONFLICT');
      expect(getOwnedResource(controllerHome, original.resourceId)).toEqual(original);
    }
    const target = { resourceId: original.resourceId, kind: 'worktree' as const, targetRef: worktree };
    expect(() => assertOwnedResourceCleanupTarget(controllerHome, { ...target, identityFingerprint: 'wrong' }))
      .toThrow('OWNED_RESOURCE_IDENTITY_FINGERPRINT_MISMATCH');
    // A caller's copy of the stored witness must not bypass a fresh disk check.
    rmSync(worktree, { recursive: true });
    writeFileSync(worktree, 'replacement file');
    expect(() => assertOwnedResourceCleanupTarget(controllerHome, { ...target, identityFingerprint: original.identityFingerprint }))
      .toThrow('OWNED_RESOURCE_IDENTITY_FINGERPRINT_MISMATCH');
  });

  it('rejects historical device witnesses without volume proof and preserves their records', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-remount-identity-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const resource = recordOwnedResource(controllerHome, {
      resourceId: 'remount-device-witness',
      kind: 'worktree',
      targetRef: worktree,
      creator: 'forge:managed-workspace',
      retentionIntent: 'temporary',
    });
    const canonicalPath = realpathSync(worktree);
    const stat = lstatSync(canonicalPath);
    const majorBase = Math.floor(stat.dev / 0x1000000) * 0x1000000;
    const priorDevice = majorBase + ((stat.dev - majorBase + 3) % 256);
    const fingerprint = (device: number, ino: number): string => createHash('sha256').update([
      resource.ownerForgeInstanceId,
      'filesystem_path',
      canonicalPath,
      String(device),
      String(ino),
      'directory',
    ].join('\0')).digest('hex');
    const resourceFile = join(controllerHome, 'owned-resources', 'remount-device-witness.json');
    const writeWitness = (identityFingerprint: string, createdAt = resource.provenance.createdAt): void => {
      writeFileSync(resourceFile, JSON.stringify({
        ...resource,
        provenance: { ...resource.provenance, createdAt },
        identityFingerprint,
      }));
    };

    writeWitness(fingerprint(priorDevice, stat.ino));
    const originalWitnessBytes = readFileSync(resourceFile, 'utf8');
    const replay = () => recordOwnedResource(controllerHome, {
      resourceId: resource.resourceId,
      kind: 'worktree',
      targetRef: worktree,
      creator: 'forge:managed-workspace',
      retentionIntent: 'temporary',
    });
    expect(replay).toThrow('OWNED_RESOURCE_IDENTITY_CONFLICT');
    expect(readFileSync(resourceFile, 'utf8')).toBe(originalWitnessBytes);
    const cleanupTarget = {
      resourceId: resource.resourceId,
      kind: 'worktree' as const,
      targetRef: worktree,
    };
    expect(() => assertOwnedResourceCleanupTarget(controllerHome, cleanupTarget))
      .toThrow('OWNED_RESOURCE_IDENTITY_FINGERPRINT_MISMATCH');

    // An old device number cannot disguise a different inode.
    writeWitness(fingerprint(priorDevice, stat.ino + 1));
    expect(() => assertOwnedResourceCleanupTarget(controllerHome, cleanupTarget))
      .toThrow('OWNED_RESOURCE_IDENTITY_FINGERPRINT_MISMATCH');
    expect(replay).toThrow('OWNED_RESOURCE_IDENTITY_CONFLICT');

    if (process.platform === 'darwin') {
      // An old witness is not authority to revive a released resource.
      writeFileSync(resourceFile, JSON.stringify({
        ...resource,
        identityFingerprint: resource.identityFingerprint,
        status: 'released',
      }));
      expect(replay).toThrow('OWNED_RESOURCE_REUSE_REQUIRES_NEW_ID');

      // Resuming an adopted/non-cleanup-capable resource cannot grant deletion authority.
      writeFileSync(resourceFile, JSON.stringify({
        ...resource,
        identityFingerprint: resource.identityFingerprint,
        cleanupCapable: false,
      }));
      expect(replay).toThrow('OWNED_RESOURCE_CLEANUP_AUTHORITY_ESCALATION_FORBIDDEN');
    }

    // Even a valid device/inode hash for a newly created directory must not
    // inherit a resource record that predates the replacement.
    rmSync(worktree, { recursive: true });
    mkdirSync(worktree);
    const replacement = lstatSync(worktree);
    writeWitness(fingerprint(priorDevice, replacement.ino), '2000-01-01T00:00:00.000Z');
    expect(() => assertOwnedResourceCleanupTarget(controllerHome, cleanupTarget))
      .toThrow('OWNED_RESOURCE_IDENTITY_FINGERPRINT_MISMATCH');
    expect(replay).toThrow('OWNED_RESOURCE_IDENTITY_CONFLICT');
  });
});
