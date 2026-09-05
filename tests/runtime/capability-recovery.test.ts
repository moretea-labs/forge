import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
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
  applyStaleWorkContractMaintenanceCandidate,
  cleanupRuntimeQuarantine,
  classifyFailure,
  detectDirtyPathConflicts,
  recoveryActionById,
} from '../../src/runtime/recovery';
import { applyEditOperations, beginEditSession, getEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { createWorkContract, getWorkContract, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../src/runtime/control-plane/facade/work-implementation-review';
import { approvePlanContract, claimPlanStepForWork, createPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { claimControllerSession, releaseControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { applyControllerHomeMigration } from '../../src/runtime/control-plane/persistence/controller-home-migration';
import { writeWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import {
  applyExternalFilesystemGrant,
  buildWorkspaceAuthStatus,
  prepareWorkspaceAuthLogin,
  previewExternalFilesystemGrant,
  readExternalFilesystemSnapshot,
} from '../../src/runtime/safe-tooling';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    expect(snapshot.recommendedActions.map((action) => action.id)).toContain('recovery.reconcile_jobs');
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
      action: RECOVERY_ACTIONS.reconcileJobs,
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
    transitionWorkContractPhase(store, workId, { phase: 'verification', status: 'blocked', state: 'satisfied', summary: 'Implementation explicitly accepted before cleanup.' });
    requestWorkImplementationReview(store, workId, 'Maintenance fixture requires explicit implementation review before delivery.');
    const recordedAt = store.now?.() ?? '2026-01-01T00:00:00.000Z';
    recordWorkImplementationReview(store, workId, {
      schemaVersion: 1, reviewId: `review-${workId}`, workId,
      reviewerPrincipalId: 'principal-maintenance-test', reviewerControllerSessionId: 'controller-maintenance-test',
      decision: 'approved', rationale: 'Fixture explicitly approves the exact no-change implementation before delivery.', findings: [],
      sourceRevision: 'maintenance-fixture-source', workspaceFingerprint: `${workId}:workspace`, verificationWorkspaceFingerprint: `${workId}:verification`,
      changedPaths: [], changedPathDigest: implementationReviewChangedPathDigest([]), acceptanceCriteriaSummary: 'Maintenance lifecycle fixture is ready for delivery.',
      verificationEvidence: [], architectureEvidence: [], recordedAt,
    });
    transitionWorkContractPhase(store, workId, { phase: 'cleanup', status: 'blocked', state: 'satisfied', summary: 'Delivery explicitly accepted; only cleanup remains.' });
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
    createWorkContract({ controllerHome, repoId, now: () => '2026-01-01T00:00:00.000Z' }, {
      workId,
      repoId,
      mode: 'goal_workloop',
      objective: `stale managed ${source} work`,
      acceptanceCriteria: ['preserve unique source'],
      allowedPaths: ['**'],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'ready',
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

    const repoId = 'repo-maintenance-edit';
    const checkoutId = 'checkout-maintenance-edit';
    const workId = input.contractFree ? undefined : input.createWork === false ? 'work-missing' : `work-${input.workStatus ?? 'cancelled'}`;
    if (input.createWork !== false && workId) {
      createWorkContract({ controllerHome, repoId }, {
        workId,
        repoId,
        checkoutId,
        mode: 'direct_control',
        objective: 'Characterize stale Edit Session maintenance.',
        acceptanceCriteria: [],
        allowedPaths: ['src/**'],
        forbiddenPaths: [],
        checks: [],
        constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
        requestedBy: 'chatgpt',
        status: input.workStatus ?? 'cancelled',
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
      repository: { repoId, canonicalRoot: repoRoot, runtimeTempRoots: [runtimeTempRoot] },
      sessionId: session.sessionId,
    };
  }

  it('blocks false healthy readiness for retained Work left in a migrated Controller Home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-retained-migration-'));
    temporaryRoots.push(root);
    const sourceHome = join(root, 'source-controller');
    const controllerHome = join(root, 'current-controller');
    const repoRoot = join(root, 'repo');
    const retainedWorktree = join(root, '.forge', 'managed-worktrees', 'legacy-controller', 'repo-retained', 'work-retained');
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), '# retained\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
    mkdirSync(join(root, '.forge', 'managed-worktrees', 'legacy-controller', 'repo-retained'), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'work/retained', retainedWorktree, 'HEAD'], { cwd: repoRoot });
    writeFileSync(join(retainedWorktree, 'preserved.txt'), 'implementation in progress\n');

    createWorkContract({ controllerHome: sourceHome, repoId: 'repo-retained' }, {
      workId: 'work-retained-migrated', repoId: 'repo-retained', mode: 'goal_workloop',
      objective: 'Preserved implementation that must remain reviewable after Controller Home migration.',
      acceptanceCriteria: ['preserve implementation'], allowedPaths: ['**'], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'user', status: 'cancelled',
      checkoutId: 'checkout-retained', worktreeRef: retainedWorktree,
      continuationPrompt: 'Resume preserved implementation after migration.',
    });
    await applyControllerHomeMigration({ sourceHome, destinationHome: controllerHome });

    const status = buildRuntimeMaintenanceStatus({ repoId: 'repo-retained', canonicalRoot: repoRoot }, controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.readyForExecution).toBe(false);
    expect(status.summary.retainedMigratedWork).toBe(1);
    expect(status.candidates).toContainEqual(expect.objectContaining({
      kind: 'retained_migrated_work',
      id: 'work-retained-migrated',
      path: retainedWorktree,
      status: 'cancelled',
      safe: false,
      ownershipStatus: 'explicit',
      disposition: 'resume_or_supersede_review',
      continuationPrompt: 'Resume preserved implementation after migration.',
    }));
    expect(readFileSync(join(retainedWorktree, 'preserved.txt'), 'utf8')).toBe('implementation in progress\n');
  });

  it('does not block readiness for a migrated terminal Work whose worktreeRef is only an old repository root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-retained-repo-root-'));
    temporaryRoots.push(root);
    const sourceHome = join(root, 'source-controller');
    const controllerHome = join(root, 'current-controller');
    const repoRoot = join(root, 'repo');
    const oldRepositoryRoot = join(root, 'retired-repository-root');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(oldRepositoryRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), '# current\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });

    createWorkContract({ controllerHome: sourceHome, repoId: 'repo-retained-root' }, {
      workId: 'work-retained-repository-root', repoId: 'repo-retained-root', mode: 'goal_workloop',
      objective: 'Historical terminal Work whose legacy worktreeRef was the repository root.',
      acceptanceCriteria: [], allowedPaths: ['**'], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'user', status: 'cancelled',
      checkoutId: 'checkout-retained-root', worktreeRef: oldRepositoryRoot,
    });
    await applyControllerHomeMigration({ sourceHome, destinationHome: controllerHome });

    const status = buildRuntimeMaintenanceStatus({ repoId: 'repo-retained-root', canonicalRoot: repoRoot }, controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.summary.retainedMigratedWork).toBe(0);
    expect(status.candidates).not.toContainEqual(expect.objectContaining({
      kind: 'retained_migrated_work',
      id: 'work-retained-repository-root',
    }));
  });

  it('does not block readiness for an empty legacy managed-worktree directory with no Git marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-empty-managed-residue-'));
    temporaryRoots.push(root);
    const sourceHome = join(root, 'source-controller');
    const controllerHome = join(root, 'current-controller');
    const repoRoot = join(root, 'repo');
    const emptyManagedResidue = join(root, '.repo-harness', 'managed-worktrees', 'legacy-controller', 'repo-retained', 'campaign-empty');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(emptyManagedResidue, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), '# current\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });

    createWorkContract({ controllerHome: sourceHome, repoId: 'repo-empty-managed-residue' }, {
      workId: 'work-empty-managed-residue', repoId: 'repo-empty-managed-residue', mode: 'goal_workloop',
      objective: 'Historical Work whose managed directory is already empty and detached from Git.',
      acceptanceCriteria: [], allowedPaths: ['**'], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'user', status: 'cancelled',
      checkoutId: 'checkout-empty-residue', worktreeRef: emptyManagedResidue,
    });
    await applyControllerHomeMigration({ sourceHome, destinationHome: controllerHome });

    const status = buildRuntimeMaintenanceStatus({ repoId: 'repo-empty-managed-residue', canonicalRoot: repoRoot }, controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.summary.retainedMigratedWork).toBe(0);
    expect(status.candidates).not.toContainEqual(expect.objectContaining({
      kind: 'retained_migrated_work',
      id: 'work-empty-managed-residue',
    }));
  });

  it('does not flag a current Work-owned managed worktree as unowned lifecycle debt', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-owned-worktree-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    const worktree = join(root, '.forge', 'managed-worktrees', 'current-controller', 'repo-owned', 'work-owned');
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), '# owned\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
    mkdirSync(join(root, '.forge', 'managed-worktrees', 'current-controller', 'repo-owned'), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'work/owned', worktree, 'HEAD'], { cwd: repoRoot });
    createWorkContract({ controllerHome, repoId: 'repo-owned' }, {
      workId: 'work-owned-current', repoId: 'repo-owned', mode: 'goal_workloop', objective: 'Current owned worktree',
      acceptanceCriteria: [], allowedPaths: ['**'], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'user', status: 'running', checkoutId: 'checkout-owned', worktreeRef: worktree,
    });

    const status = buildRuntimeMaintenanceStatus({ repoId: 'repo-owned', canonicalRoot: repoRoot }, controllerHome, { minAgeMinutes: 60, maxCandidates: 50 });
    expect(status.candidates).not.toContainEqual(expect.objectContaining({ kind: 'unowned_managed_worktree', path: worktree }));
    expect(status.candidates).not.toContainEqual(expect.objectContaining({ kind: 'retained_migrated_work', path: worktree }));
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

  it('does not bulk-cancel stale Work whose semantic lifecycle is still unresolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-stale-work-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    const repository = { repoId: 'repo-stale-work', canonicalRoot: repoRoot };
    const oldAt = '2026-01-01T00:00:00.000Z';
    const work = createWorkContract({ controllerHome, repoId: repository.repoId, now: () => oldAt }, {
      workId: 'work-stale-ready',
      repoId: repository.repoId,
      mode: 'goal_workloop',
      objective: 'legacy ready work',
      acceptanceCriteria: ['historical'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'ready',
    });
    expect(work.status).toBe('ready');

    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(status.summary.staleWorkContracts).toBe(1);
    expect(status.candidates).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: 'work-stale-ready',
      safe: false,
      disposition: 'semantic_completion_required',
    }));

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: 1,
      maxCandidates: 50,
    });
    expect(applied.applied).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: 'work-stale-ready',
      applied: false,
      result: 'not_selected',
    }));
    const retained = getWorkContract({ controllerHome, repoId: repository.repoId }, 'work-stale-ready');
    expect(retained?.status).toBe('ready');
    expect(retained?.phase).not.toBe('cleanup');
    expect(retained?.phaseEvidence.delivery.state).toBe('pending');
    expect(retained?.phaseEvidence.cleanup.state).toBe('pending');
  });

  it('protects a stale no-authority Work when a recent successful write left dirty managed-worktree source', () => {
    const { controllerHome, repository, workId, worktree } = staleManagedWorkFixture('dirty');
    const writtenPath = join(worktree, 'docs', 'architecture', 'global-hook-runtime.md');

    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(status.summary.staleWorkContracts).toBe(1);
    expect(status.candidates).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: workId,
      path: worktree,
      safe: false,
      sourceState: 'dirty_worktree',
      disposition: 'source_preservation_required',
    }));
    expect(status.candidates.find((candidate) => candidate.id === workId)?.reason).toContain('durable metadata/process evidence is not a substitute');

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: 1,
      maxCandidates: 50,
    });
    expect(applied.applied).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: workId,
      applied: false,
      result: 'not_selected',
    }));
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('ready');
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(writtenPath, 'utf8')).toBe('# recent successful write\n');
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repository.canonicalRoot, encoding: 'utf8' })).toContain(worktree);
  });

  it('protects clean stale managed-worktree commits that are not integrated into the target branch', () => {
    const { controllerHome, repository, workId, worktree } = staleManagedWorkFixture('committed');
    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: workId,
      path: worktree,
      safe: false,
      sourceState: 'unintegrated_commits',
      disposition: 'source_preservation_required',
    }));

    applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: 1,
      maxCandidates: 50,
    });
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('ready');
    expect(existsSync(join(worktree, 'unique.txt'))).toBe(true);
  });

  it('uses an identity-matched durable WorkHandle head to reconcile an already-removed managed worktree', () => {
    const { controllerHome, repository, workId, worktree } = staleManagedWorkFixture('clean');
    const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository.canonicalRoot, encoding: 'utf8' }).trim();
    writeWorkHandle(controllerHome, {
      schemaVersion: 1,
      workId,
      workContractId: workId,
      sessionId: 'session-stale-removed',
      principalId: 'principal-stale-removed',
      repositoryId: repository.repoId,
      checkoutId: 'checkout-clean',
      worktreePath: worktree,
      branch: 'work/clean',
      managedWorktree: true,
      baseCommit: expectedHead,
      expectedHead,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      finalization: {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
      },
    });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repository.canonicalRoot });

    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: workId,
      safe: false,
      sourceState: 'clean_integrated',
      disposition: 'semantic_completion_required',
    }));
  });

  it('keeps a clean integrated stale Work nonterminal while semantic phases remain unresolved', () => {
    const { controllerHome, repository, workId } = staleManagedWorkFixture('clean');
    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    const candidate = status.candidates.find((entry) => entry.kind === 'stale_work_contract' && entry.id === workId);
    expect(candidate).toMatchObject({
      kind: 'stale_work_contract',
      id: workId,
      safe: false,
      sourceState: 'clean_integrated',
      disposition: 'semantic_completion_required',
    });

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: 1,
      maxCandidates: 50,
    });
    expect(applied.applied).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: workId,
      applied: false,
      result: 'not_selected',
    }));
    const directlyFenced = applyStaleWorkContractMaintenanceCandidate(repository, controllerHome, candidate!);
    expect(directlyFenced).toMatchObject({
      applied: false,
      safe: false,
      result: 'work_semantic_completion_required',
      disposition: 'semantic_completion_required',
    });
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('ready');
  });

  it('mechanically terminalizes only a cleanup-ready stale Work with no source debt', () => {
    const { controllerHome, repository, workId } = staleManagedWorkFixture('clean');
    const store = { controllerHome, repoId: repository.repoId, now: () => '2026-01-01T00:00:00.000Z' };
    advanceWorkToCleanup(store, workId);

    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: workId,
      safe: true,
      sourceState: 'clean_integrated',
      disposition: undefined,
    }));

    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'full_maintenance_pass',
      confirmMaintenance: true,
      minAgeMinutes: 1,
      maxCandidates: 50,
    });
    expect(applied.applied).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract',
      id: workId,
      applied: true,
      result: 'work_contract_cancelled_evidence_retained',
    }));
    const cancelled = getWorkContract({ controllerHome, repoId: repository.repoId }, workId);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.phaseEvidence.implementation.state).toBe('satisfied');
    expect(cancelled?.phaseEvidence.verification.state).toBe('satisfied');
    expect(cancelled?.phaseEvidence.delivery.state).toBe('satisfied');
  });

  it('rechecks managed-worktree source at apply time before stale cancellation', () => {
    const { controllerHome, repository, workId, worktree } = staleManagedWorkFixture('clean');
    const scanned = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    const candidate = scanned.candidates.find((entry) => entry.kind === 'stale_work_contract' && entry.id === workId);
    expect(candidate).toMatchObject({ safe: false, sourceState: 'clean_integrated', disposition: 'semantic_completion_required' });

    writeFileSync(join(worktree, 'late-write.txt'), 'written after maintenance scan\n');
    const fenced = applyStaleWorkContractMaintenanceCandidate(repository, controllerHome, candidate!);
    expect(fenced).toMatchObject({
      applied: false,
      safe: false,
      result: 'work_source_preserved:dirty_worktree',
      sourceState: 'dirty_worktree',
      disposition: 'source_preservation_required',
    });
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('ready');
    expect(readFileSync(join(worktree, 'late-write.txt'), 'utf8')).toBe('written after maintenance scan\n');
  });

  it('rechecks Work authority at apply time before cancelling a previously stale candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-work-apply-authority-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    const repository = { repoId: 'repo-work-apply-authority', canonicalRoot: repoRoot };
    const oldAt = '2026-01-01T00:00:00.000Z';
    const store = { controllerHome, repoId: repository.repoId, now: () => oldAt };
    createWorkContract(store, {
      workId: 'work-stale-then-claimed', repoId: repository.repoId, mode: 'goal_workloop', objective: 'stale before controller reclaim',
      acceptanceCriteria: ['preserve late authority'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'ready',
    });
    advanceWorkToCleanup(store, 'work-stale-then-claimed');

    const scanned = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    const candidate = scanned.candidates.find((entry) => entry.kind === 'stale_work_contract' && entry.id === 'work-stale-then-claimed');
    expect(candidate).toBeTruthy();

    claimControllerSession({ controllerHome, repoId: repository.repoId }, {
      workId: 'work-stale-then-claimed', controllerId: 'controller-late', controllerType: 'chatgpt', sessionId: 'mcp-late',
      principalId: 'principal-late', controllerInstanceId: 'runtime-late', leaseMs: 60_000,
    });
    const fenced = applyStaleWorkContractMaintenanceCandidate(repository, controllerHome, candidate!);
    expect(fenced.applied).toBe(false);
    expect(fenced.result).toBe('work_terminalization_fenced:active_controller_claim:claim_generation=1');
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, 'work-stale-then-claimed')?.status).toBe('blocked');

    releaseControllerSession({ controllerHome, repoId: repository.repoId }, 'work-stale-then-claimed', 'controller-late');
    const cancelled = applyStaleWorkContractMaintenanceCandidate(repository, controllerHome, candidate!);
    expect(cancelled.applied).toBe(true);
    expect(cancelled.result).toBe('work_contract_cancelled_evidence_retained');
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, 'work-stale-then-claimed')?.status).toBe('cancelled');
  });

  it('does not classify an old Work as stale while an active Plan still owns it', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-plan-authority-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    const repository = { repoId: 'repo-plan-owned-work', canonicalRoot: repoRoot };
    const oldAt = '2026-01-01T00:00:00.000Z';
    createWorkContract({ controllerHome, repoId: repository.repoId, now: () => oldAt }, {
      workId: 'work-plan-owned', repoId: repository.repoId, mode: 'goal_workloop', objective: 'authoritative old work',
      acceptanceCriteria: ['finish plan'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'ready',
    });
    createPlanContract({ controllerHome, repoId: repository.repoId, now: () => oldAt }, {
      planId: 'PLAN-owned', repoId: repository.repoId, scopeKey: 'owned-scope', sourceRevision: 'revision-a', goal: 'Own the old work',
      steps: [{ id: 'step-a', objective: 'Execute authoritative work', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['package:check:type'], acceptanceCriteria: ['finish plan'] }],
    });
    approvePlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-owned');
    claimPlanStepForWork({ controllerHome, repoId: repository.repoId }, { planId: 'PLAN-owned', stepId: 'step-a', workId: 'work-plan-owned', sourceRevision: 'revision-a' });

    const status = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(status.candidates).not.toContainEqual(expect.objectContaining({ kind: 'stale_work_contract', id: 'work-plan-owned' }));
    const applied = applyRuntimeMaintenance(repository, controllerHome, { actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 1, maxCandidates: 50 });
    expect(applied.applied).not.toContainEqual(expect.objectContaining({ kind: 'stale_work_contract', id: 'work-plan-owned' }));
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, 'work-plan-owned')?.status).toBe('ready');
  });

  it('treats a live Controller lease as lifecycle authority until the lease is released', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-controller-authority-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    const repository = { repoId: 'repo-controller-owned-work', canonicalRoot: repoRoot };
    const oldAt = '2026-01-01T00:00:00.000Z';
    const store = { controllerHome, repoId: repository.repoId, now: () => oldAt };
    createWorkContract(store, {
      workId: 'work-controller-owned', repoId: repository.repoId, mode: 'goal_workloop', objective: 'controller-owned old work',
      acceptanceCriteria: ['preserve ownership'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'ready',
    });
    advanceWorkToCleanup(store, 'work-controller-owned');
    claimControllerSession({ controllerHome, repoId: repository.repoId }, {
      workId: 'work-controller-owned', controllerId: 'controller-a', controllerType: 'chatgpt', sessionId: 'mcp-a',
      principalId: 'principal-a', controllerInstanceId: 'runtime-a', leaseMs: 60_000,
    });

    const active = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(active.candidates).not.toContainEqual(expect.objectContaining({ kind: 'stale_work_contract', id: 'work-controller-owned' }));
    releaseControllerSession({ controllerHome, repoId: repository.repoId }, 'work-controller-owned', 'controller-a');
    const released = buildRuntimeMaintenanceStatus(repository, controllerHome, { minAgeMinutes: 1, maxCandidates: 50 });
    expect(released.candidates).toContainEqual(expect.objectContaining({
      kind: 'stale_work_contract', id: 'work-controller-owned', safe: true,
    }));
  });

  it('reconciles committed Direct Edit metadata during maintenance discovery', () => {
    const fx = editFixture();
    execFileSync('git', ['add', 'src/session.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'commit edit session'], { cwd: fx.repoRoot });

    const status = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.summary.staleEditSessions).toBe(0);
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('finalized');
  });

  it('supersedes a terminal Work edit session when newer source replaced its after-image', () => {
    const fx = editFixture();
    writeFileSync(join(fx.repoRoot, 'src/session.ts'), 'export const sessionValue = 2;\n');

    expect(buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 }).summary.staleEditSessions).toBe(0);
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

  it('reconciles a committed contract-free Direct Edit Session without inventing Work ownership', () => {
    const fx = editFixture({ contractFree: true });
    execFileSync('git', ['add', 'src/session.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'commit contract-free direct edit'], { cwd: fx.repoRoot });

    const status = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.summary.staleEditSessions).toBe(0);
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('finalized');
  });

  it('inherits live Work lifecycle authority before classifying an old Edit Session as maintenance debt', () => {
    const fx = editFixture({ workStatus: 'running' });
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: 'work-running', controllerId: 'controller-edit-owner', controllerType: 'chatgpt', sessionId: 'mcp-edit-owner',
      principalId: 'principal-edit-owner', controllerInstanceId: 'runtime-edit-owner', leaseMs: 60_000,
    });

    const active = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(active.candidates).not.toContainEqual(expect.objectContaining({ kind: 'stale_edit_session', id: fx.sessionId }));

    releaseControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, 'work-running', 'controller-edit-owner');
    const released = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(released.candidates).toContainEqual(expect.objectContaining({ kind: 'stale_edit_session', id: fx.sessionId, safe: false }));
    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, {
      actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50,
    });
    expect(applied.applied.some((candidate) => candidate.id === fx.sessionId && candidate.applied)).toBe(false);
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('dirty');
  });

  it('keeps missing Work ownership as an unsafe stale Edit Session candidate', () => {
    const fx = editFixture({ createWork: false });
    const status = buildRuntimeMaintenanceStatus(fx.repository, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 50 });
    expect(status.candidates).toContainEqual(expect.objectContaining({ kind: 'stale_edit_session', id: fx.sessionId, safe: false }));
    const applied = applyRuntimeMaintenance(fx.repository, fx.controllerHome, {
      actionId: 'full_maintenance_pass', confirmMaintenance: true, minAgeMinutes: 0, maxCandidates: 50,
    });
    expect(applied.applied.some((candidate) => candidate.id === fx.sessionId && candidate.applied)).toBe(false);
    expect(getEditSession(fx.repoRoot, fx.sessionId).status).toBe('dirty');
  });

  it('rolls back an empty stale open session owned by terminal Work without touching source', () => {
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
