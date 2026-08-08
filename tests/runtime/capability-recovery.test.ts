import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RECOVERY_ACTIONS,
  assertRecoveryAuthorized,
  buildCapabilityRecoverySnapshot,
  buildPatchHandoffArtifact,
  buildRecoveryAuditRecord,
  buildRuntimeMaintenanceStatus,
  applyRuntimeMaintenance,
  classifyFailure,
  detectDirtyPathConflicts,
  recoveryActionById,
} from '../../src/runtime/recovery';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
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

  it('classifies browser and external filesystem grants separately from generic policy denial', () => {
    expect(classifyFailure('WEB_TARGET_NOT_ALLOWED: docs.example.com')).toBe('browser_domain_grant_required');
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
  function tempRepo() {
    const root = mkdtempSync(join(tmpdir(), 'forge-maintenance-test-'));
    temporaryRoots.push(root);
    const controllerHome = join(root, '_controller_home');
    const localJobs = join(root, '.ai/harness/local-jobs');
    mkdirSync(localJobs, { recursive: true });
    return { root, controllerHome, localJobs, repository: { repoId: 'repo-test', canonicalRoot: root } };
  }

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

  it('quarantines unreadable Local Job entries', () => {
    const { controllerHome, localJobs, repository } = tempRepo();
    mkdirSync(join(localJobs, 'JOB-broken'), { recursive: true });
    const applied = applyRuntimeMaintenance(repository, controllerHome, {
      actionId: 'quarantine_unreadable_local_jobs',
      confirmMaintenance: true,
      minAgeMinutes: 0,
    });
    const legacyApplied = applied.applied.some((candidate) => candidate.applied && candidate.id === 'JOB-broken');
    const typedApplied = applied.runtimeStorageRepairApply?.applied.some((candidate) => candidate.status === 'applied' && candidate.path.includes('JOB-broken')) ?? false;
    expect(legacyApplied || typedApplied).toBe(true);
  });

  it('bulk-cancels stale nonterminal WorkContracts only during an explicitly confirmed full maintenance pass', () => {
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
      safe: true,
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
      applied: true,
    }));
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, 'work-stale-ready')?.status).toBe('cancelled');
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
