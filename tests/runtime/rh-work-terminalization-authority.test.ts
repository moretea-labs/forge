import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { getRepository, reconcileRepositoryCheckouts, registerRepository, selectRepositoryCheckout, setRepositoryCheckoutLifecycle } from '../../src/cli/repositories/registry';
import { createWorkContract, getWorkContract, recordWorkCompletionReceipt, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../src/runtime/control-plane/facade/work-implementation-review';
import { approvePlanContract, claimPlanStepForWork, completePlanStepForWork, createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { claimControllerSession, getControllerSession, releaseObservedControllerSession, resumeControllerSession, withControllerSessionTerminalizationFence } from '../../src/runtime/control-plane/facade/controller-session-store';
import { acknowledgeControllerRoundClaim, beginInitialControllerRoundDispatch, finishControllerRoundRelayDispatch, getControllerRoundRelay, readControllerRoundSemanticStateFingerprint, submitControllerRoundDisposition } from '../../src/runtime/control-plane/facade/controller-round-relay';
import { ensureRepositoryWorkHandle, reconcileRepositoryWorkHandlePlacement } from '../../src/runtime/control-plane/execution/work-handle-authority';
import { ensureRunningRepositoryWorkCheckout } from '../../src/runtime/control-plane/execution/retained-work-resume';
import { cleanupTerminalWork } from '../../src/runtime/control-plane/execution/work-terminal-cleanup';

import { readWorkHandle, writeWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { resolveExplicitClaimedRepositoryWork } from '../../src/runtime/control-plane/execution/repository-work-attribution';
import { releasePreparedWorkOwnership } from '../../src/runtime/gateway/mcp/execution-tools';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { invalidateExecutionSession } from '../../src/runtime/control-plane/execution/session-store';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureManagedWorkspace } from '../../src/runtime/execution/managed-workspace';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import { executeRepositoryCommandViaProcessRuntime, waitRepositoryCommandProcess } from '../../src/runtime/execution/process-runtime/command-facade';
import { executionIdentityForWork } from '../../src/runtime/control-plane/execution/execution-identity';
import { bindControllerSessionBinding, getControllerSessionBinding, getControllerWorkBinding } from '../../packages/kernel/controller/api/index';
import { resumeScheduledControllerContinuation } from '../../packages/kernel/scheduler/api/index';
import { upsertChatgptControllerBinding } from '../../adapters/chatgpt/controller-binding-store';
import { createWorkContinuationSchedule } from '../../src/runtime/workflow/schedules/work-continuation';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-terminalization-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-terminalization-home-'));
  roots.push(repoRoot, controllerHome);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Terminalization fixture' });
  return { repoRoot, controllerHome, repository };
}

function ctx(
  controllerHome: string,
  repository: ReturnType<typeof registerRepository>,
  principalId: string,
  sessionId: string,
  controllerInstanceId: string,
): MultiRepositoryMcpToolContext {
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    principalId,
    sessionId,
    controllerInstanceId,
    controllerType: 'chatgpt',
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function publishCurrentRuntime(controllerHome: string, runtimeInstanceId: string): void {
  const ownership = acquireRuntimeOwnership(controllerHome, runtimeInstanceId);
  const now = new Date().toISOString();
  writeRuntimeStatusSnapshot(controllerHome, {
    schemaVersion: 1,
    runtimeInstanceId,
    pid: ownership.record.pid,
    releaseId: 'release-continuity-test',
    artifactIdentity: 'artifact-continuity-test',
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
}

function createReadyWork(controllerHome: string, repoId: string, workId: string): void {
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    mode: 'goal_workloop',
    objective: 'terminalization authority regression',
    acceptanceCriteria: ['preserve current controller authority'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'ready',
  });
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, any>;
}

describe('rh_work terminalization authority', () => {
  test('continue upgrades only a proven legacy false-negative managed WorkHandle placement', async () => {
    const fx = fixture();
    const workId = 'work-legacy-managed-placement-reconcile';
    const caller = {
      principalId: 'principal-legacy-managed-placement',
      sessionId: 'transport-legacy-managed-placement',
      controllerInstanceId: 'runtime-legacy-managed-placement',
    };
    const branch = 'work/legacy-managed-placement';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: workId,
      title: 'Legacy managed placement reconciliation',
      branchName: branch,
    });
    expect(workspace.root).toBeTruthy();
    expect(workspace.checkoutId).toBeTruthy();
    const baseRevision = workspace.baseRevision!;
    const now = new Date().toISOString();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      baseRevision,
      mode: 'goal_workloop',
      objective: 'Reconcile a legacy false-negative managed WorkHandle.',
      acceptanceCriteria: [],
      constraints: { requireWorktree: true, directMainProhibited: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'implementation',
      worktreeRef: workspace.root,
      scopeEvidence: { initialLikelyPaths: [], inspectedPaths: [], actualChangedPaths: [], recordedAt: now },
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      workContractId: workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      sourceCheckoutId: workspace.checkoutId!,
      worktreePath: workspace.root!,
      branch,
      managedWorktree: false,
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: baseRevision,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    });
    claimControllerSession(store, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });

    const continued = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'continue', work_id: workId },
    ));
    expect(continued.data?.ownershipResumed).toBe(true);
    const repaired = readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)!;
    expect(repaired.managedWorktree).toBe(true);
    expect(repaired.sourceCheckoutId).toBe(fx.repository.activeCheckoutId);
    expect(repaired.checkoutId).toBe(workspace.checkoutId!);
    expect(repaired.worktreePath).toBe(workspace.root!);
    expect(repaired.branch).toBe(branch);

    const directWorkId = 'work-direct-placement-remains-direct';
    createWorkContract(store, {
      workId: directWorkId,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      baseRevision,
      mode: 'goal_workloop',
      objective: 'Keep a direct canonical WorkHandle direct.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'implementation',
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId: directWorkId,
      workContractId: directWorkId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      sourceCheckoutId: fx.repository.activeCheckoutId,
      worktreePath: fx.repoRoot,
      branch: 'main',
      managedWorktree: false,
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: baseRevision,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    });
    expect(reconcileRepositoryWorkHandlePlacement({
      controllerHome: fx.controllerHome,
      repositoryId: fx.repository.repoId,
      workId: directWorkId,
    })?.managedWorktree).toBe(false);
  }, 15_000);

  test('continue reconstructs the same running Work before preserving the repository implementation gate', async () => {
    const fx = fixture();
    const workId = 'work-running-checkout-runtime-recovery';
    const caller = {
      principalId: 'principal-running-checkout-runtime-recovery',
      sessionId: 'transport-running-checkout-runtime-recovery',
      controllerInstanceId: 'runtime-running-checkout-runtime-recovery',
    };
    const branch = 'work/running-checkout-runtime-recovery';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: workId,
      title: 'Running checkout runtime recovery',
      branchName: branch,
    });
    expect(workspace.root).toBeTruthy();
    expect(workspace.checkoutId).toBeTruthy();
    const baseRevision = workspace.baseRevision!;
    const now = new Date().toISOString();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      baseRevision,
      mode: 'goal_workloop',
      objective: 'Recover the same running Work after a zero-delta checkout disappears.',
      acceptanceCriteria: [],
      constraints: { requireWorktree: true, directMainProhibited: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'implementation',
      worktreeRef: workspace.root,
      scopeEvidence: {
        initialLikelyPaths: [],
        inspectedPaths: [],
        actualChangedPaths: [],
        recordedAt: now,
      },
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      workContractId: workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      sourceCheckoutId: fx.repository.activeCheckoutId,
      worktreePath: workspace.root!,
      branch,
      managedWorktree: true,
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: baseRevision,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
      },
    });
    claimControllerSession(store, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });

    const oldCheckoutId = workspace.checkoutId!;
    const oldWorktree = workspace.root!;
    execFileSync('git', ['worktree', 'remove', '--force', oldWorktree], { cwd: fx.repoRoot });
    expect(reconcileRepositoryCheckouts(fx.repository.repoId, fx.controllerHome).archivedCheckoutIds).toContain(oldCheckoutId);
    expect(existsSync(oldWorktree)).toBe(false);

    const continued = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'continue', work_id: workId },
    ));
    expect(continued.status).toBe('blocked');
    expect(continued.summary).toContain('Continue requires implementation before verification');
    expect(continued.data?.reconstructedRunningCheckout).toBe(true);
    expect(continued.data?.ownershipResumed).toBe(true);
    expect(continued.data?.nextStep).toBe('execute');

    const work = getWorkContract(store, workId)!;
    const handle = readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)!;
    expect(work.status).toBe('running');
    expect(work.checkoutId).toBeDefined();
    expect(work.worktreeRef).toBeDefined();
    expect(work.checkoutId).not.toBe(oldCheckoutId);
    expect(work.worktreeRef).not.toBe(oldWorktree);
    expect(existsSync(work.worktreeRef!)).toBe(true);
    expect(handle.checkoutId).toBe(work.checkoutId!);
    expect(handle.worktreePath).toBe(work.worktreeRef!);
    expect(handle.baseCommit).toBe(baseRevision);
    expect(handle.expectedHead).toBe(baseRevision);
  }, 15_000);

  test('blocked delivery rehydrates the exact archived candidate and invalidates old delivery authority', async () => {
    const fx = fixture();
    const workId = 'work-archived-blocked-delivery-recovery';
    const caller = {
      principalId: 'principal-archived-blocked-delivery',
      sessionId: 'transport-archived-blocked-delivery',
      controllerInstanceId: 'runtime-archived-blocked-delivery',
    };
    const branch = 'work/archived-blocked-delivery';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: workId,
      title: 'Archived blocked delivery recovery',
      branchName: branch,
    });
    const baseRevision = workspace.baseRevision!;
    writeFileSync(join(workspace.root!, 'src', 'index.ts'), 'export const ready = "archived-candidate";\n');
    execFileSync('git', ['add', 'src/index.ts'], { cwd: workspace.root! });
    execFileSync('git', ['commit', '-m', 'archived blocked delivery candidate'], { cwd: workspace.root! });
    const candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.root!, encoding: 'utf8' }).trim();
    expect(candidateRevision).not.toBe(baseRevision);

    const now = new Date().toISOString();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      baseRevision,
      mode: 'goal_workloop',
      objective: 'Deliver an exact committed candidate after a temporary target blocker clears.',
      acceptanceCriteria: [],
      constraints: { requireWorktree: true, directMainProhibited: true },
      allowedPaths: ['src/index.ts'],
      forbiddenPaths: [],
      checks: ['package:check:type'],
      requestedBy: 'chatgpt',
      status: 'blocked',
      phase: 'delivery',
      evidenceState: 'valid',
      worktreeRef: workspace.root,
      scopeEvidence: {
        initialLikelyPaths: ['src/index.ts'],
        inspectedPaths: ['src/index.ts'],
        actualChangedPaths: ['src/index.ts'],
        recordedAt: now,
      },
    });
    let handle = writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      workContractId: workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      sourceCheckoutId: fx.repository.activeCheckoutId,
      worktreePath: workspace.root!,
      branch,
      managedWorktree: true,
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: candidateRevision,
      permissionSnapshotVersion: 1,
      state: 'committed',
      createdAt: now,
      updatedAt: now,
      validatedInputFingerprint: 'old-validation-authority',
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: {
        validation: 'done',
        commit: 'done',
        merge: 'failed',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
        lastError: 'target temporarily blocked',
      },
    });

    const cleaned = await cleanupTerminalWork({
      controllerHome: fx.controllerHome,
      handle,
      targetBranch: 'main',
      deleteBranch: true,
      terminalOutcome: 'blocked_terminal',
      failureReason: 'target temporarily blocked',
    });
    expect(cleaned.handle.state).toBe('cleaned');
    expect(cleaned.receipt.complete).toBe(true);
    expect(cleaned.receipt.branchCleanup).toMatchObject({ status: 'archived', uniqueCommits: 1 });
    expect(cleaned.receipt.preservation.bundlePath).toBeTruthy();
    expect(cleaned.receipt.preservation.bundleSha256).toBeTruthy();
    expect(existsSync(workspace.root!)).toBe(false);

    const tampered = writeWorkHandle(fx.controllerHome, {
      ...cleaned.handle,
      cleanupReceipt: {
        ...cleaned.receipt,
        preservation: { ...cleaned.receipt.preservation, bundleSha256: '0'.repeat(64) },
      },
    });
    expect(() => ensureRunningRepositoryWorkCheckout({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      workId,
      identity: caller,
    })).toThrow('WORK_CONTINUE_ARCHIVED_DELIVERY_BUNDLE_DIGEST_MISMATCH');
    writeWorkHandle(fx.controllerHome, {
      ...tampered,
      cleanupReceipt: cleaned.receipt,
    });

    const recovered = ensureRunningRepositoryWorkCheckout({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      workId,
      identity: caller,
    });
    expect(recovered.reconstructedCheckout).toBe(true);
    const work = getWorkContract(store, workId)!;
    handle = readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)!;
    expect(work.status).toBe('running');
    expect(work.phase).toBe('verification');
    expect(work.evidenceState).toBe('stale');
    expect(work.checkoutId).not.toBe(workspace.checkoutId!);
    expect(work.worktreeRef).not.toBe(workspace.root!);
    expect(handle.state).toBe('validating');
    expect(handle.baseCommit).toBe(baseRevision);
    expect(handle.deliveryBaseCommit).toBe(baseRevision);
    expect(handle.expectedHead).toBe(candidateRevision);
    expect(handle.deliveryTargetBranch).toBe('main');
    expect(handle.validatedInputFingerprint).toBeUndefined();
    expect(handle.cleanupReceipt).toBeUndefined();
    expect(handle.finalization).toMatchObject({
      validation: 'pending',
      commit: 'done',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    });
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work.worktreeRef!, encoding: 'utf8' }).trim()).toBe(candidateRevision);
  }, 20_000);

  test('continue fails closed and preserves dirty source when the running Work checkout is archived but still present', async () => {
    const fx = fixture();
    const workId = 'work-running-dirty-checkout-runtime-recovery';
    const caller = {
      principalId: 'principal-running-dirty-checkout-runtime-recovery',
      sessionId: 'transport-running-dirty-checkout-runtime-recovery',
      controllerInstanceId: 'runtime-running-dirty-checkout-runtime-recovery',
    };
    const branch = 'work/running-dirty-checkout-runtime-recovery';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: workId,
      title: 'Running dirty checkout runtime recovery',
      branchName: branch,
    });
    expect(workspace.root).toBeTruthy();
    expect(workspace.checkoutId).toBeTruthy();
    const baseRevision = workspace.baseRevision!;
    const now = new Date().toISOString();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      baseRevision,
      mode: 'goal_workloop',
      objective: 'Preserve dirty source when an active Work checkout is archived.',
      acceptanceCriteria: [],
      constraints: { requireWorktree: true, directMainProhibited: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'implementation',
      worktreeRef: workspace.root,
      scopeEvidence: {
        initialLikelyPaths: [],
        inspectedPaths: [],
        actualChangedPaths: [],
        recordedAt: now,
      },
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      workContractId: workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      sourceCheckoutId: fx.repository.activeCheckoutId,
      worktreePath: workspace.root!,
      branch,
      managedWorktree: true,
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: baseRevision,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
      },
    });
    claimControllerSession(store, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });

    const retainedPath = workspace.root!;
    writeFileSync(join(retainedPath, 'src', 'index.ts'), 'export const ready = false;\n');
    setRepositoryCheckoutLifecycle({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      lifecycle: 'archived',
      reason: 'test archived checkout with retained dirty source',
    });

    const continued = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'continue', work_id: workId },
    ));
    expect(continued.status).toBe('blocked');
    expect(continued.summary).toContain('WORK_CONTINUE_ZERO_DELTA_PHYSICAL_CONFLICT');
    expect(existsSync(retainedPath)).toBe(true);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: retainedPath, encoding: 'utf8' })).toContain('src/index.ts');
    expect(getWorkContract(store, workId)?.checkoutId).toBe(workspace.checkoutId!);
  }, 15_000);

  test('frozen rh_work schema can claim, verify, continue, and release only with the exact relay capability', async () => {
    const fx = fixture();
    const workId = 'work-frozen-round-compatibility';
    const runtimeInstanceId = 'runtime-frozen-round';
    const principalId = 'principal-frozen-round';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    publishCurrentRuntime(fx.controllerHome, runtimeInstanceId);
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const relay = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:frozen-round', controllerType: 'chatgpt',
        principalId: 'forge-scheduler',
        controllerInstanceId: runtimeInstanceId,
        sessionId: 'occurrence-frozen-round',
      },
    });
    expect(relay.authorityId).toBeTruthy();
    finishControllerRoundRelayDispatch(store, {
      workId,
      ok: true,
      bindingId: `chatgpt:${fx.repository.repoId}:${workId}`,

    });
    const caller = ctx(fx.controllerHome, fx.repository, principalId, 'transport-frozen-round', runtimeInstanceId);
    const wrongAuthority = relay.authorityId === 'cra_00000000000000000000000000000000'
      ? 'cra_11111111111111111111111111111111'
      : 'cra_00000000000000000000000000000000';

    const wrong = structured(await callRuntimeTool(caller, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'repair',
      work_id: workId,
      capability_id: `controller.round:controller_claim:${wrongAuthority}:${relay.relayScopeId}`,
    }));
    expect(wrong.status).toBe('blocked');
    expect(wrong.summary).toContain('WORK_CONTROLLER_ROUND_AUTHORITY_MISMATCH');

    const claimed = structured(await callRuntimeTool(caller, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'repair',
      work_id: workId,
      capability_id: `controller.round:controller_claim:${relay.authorityId}:${relay.relayScopeId}`,
    }));
    expect(claimed.status).toBe('ok');
    expect(getControllerSession(store, workId)?.sessionId).toBe('transport-frozen-round');

    const wrongVerify = structured(await callRuntimeTool(caller, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'repair',
      work_id: workId,
      capability_id: `controller.round:verify:${wrongAuthority}:${relay.relayScopeId}`,
      check_id: 'missing-check',
      simulate_check: true,
    }));
    expect(wrongVerify.status).toBe('blocked');
    expect(wrongVerify.summary).toContain('WORK_CONTROLLER_ROUND_AUTHORITY_MISMATCH');

    const continued = structured(await callRuntimeTool(caller, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'repair',
      work_id: workId,
      capability_id: `controller.round:continue:${relay.authorityId}:${relay.relayScopeId}`,
    }));
    expect(continued.status).toBe('blocked');
    expect(continued.data.ownershipResumed).toBe(true);
    expect(continued.data.nextStep).toBe('execute');
    expect(continued.summary).not.toMatch(/AUTHORITY_MISMATCH|RELAY_SCOPE_MISMATCH/);

    const released = structured(await callRuntimeTool(caller, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'repair',
      work_id: workId,
      capability_id: `controller.round:controller_release:${relay.authorityId}:${relay.relayScopeId}`,
      reason: 'Frozen-schema controller round completed its bounded attempt.',
    }));
    expect(released.status).toBe('ok');
  }, 15_000);

  test('direct Work authority follows the authenticated principal/runtime across explicit and MCP transport rotation', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const workA = 'work-explicit-session-a';
    const workB = 'work-explicit-session-b';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workA);
    createReadyWork(fx.controllerHome, fx.repository.repoId, workB);

    const withoutTransport = () => ({
      ...ctx(fx.controllerHome, fx.repository, 'principal-explicit-session', 'placeholder', 'runtime-explicit-session'),
      sessionId: undefined,
    }) as unknown as MultiRepositoryMcpToolContext;

    const missing = structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workA },
    ));
    expect(missing.status).toBe('blocked');
    expect(missing.summary).toContain('CONTROLLER_AUTHENTICATED_SESSION_REQUIRED');

    expect(structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workA, session_id: 'opaque-a' },
    )).status).toBe('ok');
    expect(structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workB, session_id: 'opaque-b' },
    )).status).toBe('ok');

    // Explicit session_id is the transport binding when no MCP transport exists;
    // it is not a durable conversation/scope authority. The exact Work plus the
    // authenticated principal/current Runtime owns the direct mutation.
    const rotatedStopB = structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workB, requested_by: 'chatgpt', reason: 'same owner via replacement explicit transport', session_id: 'opaque-a' },
    ));
    expect(rotatedStopB.status).toBe('ok');
    expect(getWorkContract(store, workB)?.status).toBe('cancelled');

    const rotatedStopA = structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workA, requested_by: 'chatgpt', reason: 'same owner via another replacement explicit transport', session_id: 'opaque-b' },
    ));
    expect(rotatedStopA.status).toBe('ok');
    expect(getWorkContract(store, workA)?.status).toBe('cancelled');
  }, 15_000);

  test('same-Runtime direct Work authority survives transport rollover while stale Runtime remains fenced', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const workId = 'work-claim-before-stale-stop';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);

    const claimed = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-claimed', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workId },
    ));
    expect(claimed.status).toBe('ok');
    expect(String(claimed.data?.controllerAuthorityId ?? '')).toStartWith('ctrl_');
    const owner = getControllerSession(store, workId)!;
    expect(owner.authorityDigest).toBeTruthy();
    expect(owner.claimGeneration).toBe(1);

    const stale = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-stale', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'system', reason: 'stale Runtime must not take ownership' },
    ));
    expect(stale.status).toBe('blocked');
    expect(stale.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getWorkContract(store, workId)?.status).toBe('ready');

    const staleFinalize = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-stale-finalize', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt' },
    ));
    expect(staleFinalize.status).toBe('blocked');
    expect(staleFinalize.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getWorkContract(store, workId)?.status).toBe('ready');

    const continued = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-continued', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'continue', work_id: workId, requested_by: 'chatgpt' },
    ));
    expect(continued.summary).not.toContain('WORK_CONTROLLER_SCOPE_MISMATCH');
    expect(getControllerSession(store, workId)).toMatchObject({
      principalId: 'principal-a',
      sessionId: 'transport-continued',
      controllerInstanceId: 'runtime-new',
      claimGeneration: owner.claimGeneration,
    });

    const rotatedStop = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-rotated', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'chatgpt', reason: 'same durable owner after another transport rollover' },
    ));
    expect(rotatedStop.status).toBe('ok');
    expect(getWorkContract(store, workId)?.status).toBe('cancelled');
  }, 15_000);

  test('same-principal same-Runtime direct Work ownership is Work-scoped, not transport-scoped', async () => {
    const fx = fixture();
    const workA = 'work-controller-scope-a';
    const workB = 'work-controller-scope-b';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workA);
    createReadyWork(fx.controllerHome, fx.repository.repoId, workB);
    const principal = 'principal-shared';
    const runtime = 'runtime-shared';
    const scopeA = ctx(fx.controllerHome, fx.repository, principal, 'transport-scope-a', runtime);
    const scopeB = ctx(fx.controllerHome, fx.repository, principal, 'transport-scope-b', runtime);

    expect(structured(await callRuntimeTool(scopeA, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workA,
    })).status).toBe('ok');
    expect(structured(await callRuntimeTool(scopeB, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workB,
    })).status).toBe('ok');

    // Direct Work ownership is selected by exact Work identity plus authenticated
    // Controller/Runtime epoch. A transient transport/conversation is not a second
    // semantic scope authority.
    const stopBFromReplacementTransport = structured(await callRuntimeTool(scopeA, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'stop', work_id: workB, requested_by: 'user', reason: 'same durable owner through replacement transport',
    }));
    expect(stopBFromReplacementTransport.status).toBe('ok');

    const stopAFromReplacementTransport = structured(await callRuntimeTool(scopeB, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'stop', work_id: workA, requested_by: 'user', reason: 'same durable owner through another replacement transport',
    }));
    expect(stopAFromReplacementTransport.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workA)?.status).toBe('cancelled');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workB)?.status).toBe('cancelled');
  }, 15_000);

  test('ControllerBinding and scheduled continuation remain Work-scoped across ControllerSession rollover', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const workId = 'work-durable-controller-binding';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);

    const ownerA = claimControllerSession(store, {
      workId,
      controllerId: 'principal-binding',
      controllerType: 'chatgpt',
      sessionId: 'transport-binding-a',
      principalId: 'principal-binding',
      controllerInstanceId: 'runtime-binding',
      leaseMs: 60_000,
    });
    const adapterA = upsertChatgptControllerBinding(store, {
      workId,
      sessionId: ownerA.sessionId,
      title: 'durable interaction target',
      model: 'gpt-5.6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    bindControllerSessionBinding(store, { workId, sessionId: ownerA.sessionId, binding: adapterA.binding });

    const { schedule } = createWorkContinuationSchedule(fx.controllerHome, fx.repository.repoId, {
      workId,
      scheduleMode: 'continuation',
      controllerType: 'chatgpt',
      triggerType: 'manual',
      shadowMode: false,
    });
    expect(schedule.action.arguments).toMatchObject({
      work_id: workId,
      controller_type: 'chatgpt',
      controller_binding_id: adapterA.binding.bindingId,
    });
    expect(schedule.action.arguments).not.toHaveProperty('controller_session_id');

    const ownerB = resumeControllerSession(store, {
      workId,
      controllerId: ownerA.controllerId,
      controllerType: ownerA.controllerType,
      sessionId: 'transport-binding-b',
      principalId: ownerA.principalId!,
      controllerInstanceId: ownerA.controllerInstanceId!,
      leaseMs: 60_000,
    });
    expect(ownerB.claimGeneration).toBe(ownerA.claimGeneration);

    const adapterB = upsertChatgptControllerBinding(store, {
      workId,
      sessionId: ownerB.sessionId,
      title: 'durable interaction target',
      model: 'gpt-5.6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    expect(adapterB.binding.bindingId).toBe(adapterA.binding.bindingId);
    bindControllerSessionBinding(store, { workId, sessionId: ownerB.sessionId, binding: adapterB.binding });

    expect(getControllerSessionBinding(store, workId, ownerA.sessionId)?.binding.bindingId).toBe(adapterA.binding.bindingId);
    expect(getControllerWorkBinding(store, workId)).toMatchObject({
      latestSessionId: ownerB.sessionId,
      binding: { bindingId: adapterA.binding.bindingId, hostKind: 'chatgpt' },
    });

    const dispatched = await resumeScheduledControllerContinuation(store, {
      scheduleId: schedule.scheduleId,
      occurrenceId: 'occ-binding-rollover',
      workId,
      controllerBindingId: adapterA.binding.bindingId,
    }, {
      resume: async (binding, context) => ({
        accepted: binding.bindingId === adapterA.binding.bindingId && context.workId === workId,
        dispatchId: 'provider-dispatch-after-session-rollover',
      }),
    });
    expect(dispatched.dispatch).toMatchObject({
      status: 'dispatched',
      workId,
      controllerSessionId: ownerB.sessionId,
      controllerBindingId: adapterA.binding.bindingId,
      hostDispatchId: 'provider-dispatch-after-session-rollover',
    });
    expect(getControllerRoundRelay(store, workId)).toMatchObject({
      lifecycleStage: 'dispatch_confirmed',
      providerDispatchReceiptId: 'provider-dispatch-after-session-rollover',
    });
  }, 15_000);

  test('scheduled provider user blocker becomes durable wait_for_user and same occurrence never re-dispatches', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const workId = 'work-scheduled-provider-wait-for-user';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const owner = claimControllerSession(store, {
      workId,
      controllerId: 'principal-provider-wait',
      controllerType: 'chatgpt',
      sessionId: 'transport-provider-wait',
      principalId: 'principal-provider-wait',
      controllerInstanceId: 'runtime-provider-wait',
      leaseMs: 60_000,
    });
    const adapter = upsertChatgptControllerBinding(store, {
      workId,
      sessionId: owner.sessionId,
      title: 'provider wait-for-user target',
      model: 'gpt-5.6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    bindControllerSessionBinding(store, { workId, sessionId: owner.sessionId, binding: adapter.binding });
    const { schedule } = createWorkContinuationSchedule(fx.controllerHome, fx.repository.repoId, {
      workId, scheduleMode: 'continuation', controllerType: 'chatgpt', triggerType: 'manual', shadowMode: false,
    });
    let resumeCalls = 0;
    const host = {
      resume: async () => {
        resumeCalls += 1;
        const handoffId = 'hnd-provider-login-required';
        createHandoffItem(store, {
          id: handoffId,
          repoId: fx.repository.repoId,
          workId,
          title: 'provider login required',
          severity: 'needs_review',
          reason: 'CHATGPT_AUTOMATION_LOGIN_REQUIRED',
          creationReason: 'missing_authorization',
          summary: 'login required',
          currentState: { repoId: fx.repository.repoId, workId, statusSummary: 'waiting for login' },
          evidenceRefs: [],
          recommendedDecision: 'login',
          recommendedPrompt: 'login then resume',
          suggestedNextActions: [],
        });
        return { accepted: false, waitForUser: true, handoffId, reason: 'CHATGPT_AUTOMATION_LOGIN_REQUIRED' };
      },
    };
    const input = {
      scheduleId: schedule.scheduleId, occurrenceId: 'occ-provider-wait-for-user', workId, controllerBindingId: adapter.binding.bindingId,
    };
    const first = await resumeScheduledControllerContinuation(store, input, host);
    expect(first.dispatch).toMatchObject({ status: 'wait_for_user', handoffId: 'hnd-provider-login-required', reason: 'CHATGPT_AUTOMATION_LOGIN_REQUIRED' });
    expect(getControllerRoundRelay(store, workId)).toMatchObject({
      status: 'waiting_for_user',
      blockedReason: 'provider_user_action_required',
      handoffId: 'hnd-provider-login-required',
      lastError: 'CHATGPT_AUTOMATION_LOGIN_REQUIRED',
    });
    const replay = await resumeScheduledControllerContinuation(store, input, host);
    expect(replay.reused).toBe(true);
    expect(replay.dispatch.status).toBe('wait_for_user');
    expect(resumeCalls).toBe(1);
  }, 15_000);

  test('semantic wait suppresses unchanged scheduled provider dispatch and wakes once after semantic state changes', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const workId = 'work-scheduled-semantic-wait';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const owner = claimControllerSession(store, {
      workId,
      controllerId: 'principal-semantic-wait',
      controllerType: 'chatgpt',
      sessionId: 'transport-semantic-wait',
      principalId: 'principal-semantic-wait',
      controllerInstanceId: 'runtime-semantic-wait',
      leaseMs: 60_000,
    });
    const adapter = upsertChatgptControllerBinding(store, {
      workId,
      sessionId: owner.sessionId,
      title: 'semantic wait target',
      model: 'gpt-5.6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    bindControllerSessionBinding(store, { workId, sessionId: owner.sessionId, binding: adapter.binding });
    const { schedule } = createWorkContinuationSchedule(fx.controllerHome, fx.repository.repoId, {
      workId, scheduleMode: 'continuation', controllerType: 'chatgpt', triggerType: 'manual', shadowMode: false,
    });
    const relayScopeId = `goal:${workId}`;
    beginInitialControllerRoundDispatch(store, {
      workId,
      relayScopeId,
      bindingId: adapter.binding.bindingId,
      identity: {
        controllerId: owner.controllerId,
        controllerType: owner.controllerType,
        principalId: owner.principalId!,
        controllerInstanceId: owner.controllerInstanceId!,
        sessionId: owner.sessionId,
      },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true, bindingId: adapter.binding.bindingId, providerDispatchReceiptId: 'dispatch-before-wait' });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: owner })?.status).toBe('claimed');
    const waiting = submitControllerRoundDisposition(store, {
      workId,
      relayScopeId,
      identity: {
        controllerId: owner.controllerId,
        controllerType: owner.controllerType,
        principalId: owner.principalId!,
        controllerInstanceId: owner.controllerInstanceId!,
        sessionId: owner.sessionId,
      },
      disposition: 'wait',
    });
    expect(waiting.status).toBe('waiting');
    const baselineFingerprint = readControllerRoundSemanticStateFingerprint(store, workId);
    expect(baselineFingerprint).toBe(waiting.stateFingerprint);

    // Persistence churn alone must not wake a semantic wait.
    updateWorkContract(store, workId, {});
    expect(readControllerRoundSemanticStateFingerprint(store, workId)).toBe(baselineFingerprint);
    let resumeCalls = 0;
    const host = {
      resume: async () => {
        resumeCalls += 1;
        return { accepted: true, dispatchId: `dispatch-${resumeCalls}` };
      },
    };
    const unchanged = await resumeScheduledControllerContinuation(store, {
      scheduleId: schedule.scheduleId,
      occurrenceId: 'occ-semantic-wait-unchanged',
      workId,
      controllerBindingId: adapter.binding.bindingId,
      relayScopeId,
    }, host);
    expect(unchanged.dispatch).toMatchObject({ status: 'semantic_wait', workId, relayScopeId });
    expect(resumeCalls).toBe(0);
    expect(getControllerRoundRelay(store, workId)?.status).toBe('waiting');

    // A meaningful Work state change opens exactly one successor round.
    updateWorkContract(store, workId, { evidenceState: 'partial' });
    expect(readControllerRoundSemanticStateFingerprint(store, workId)).not.toBe(baselineFingerprint);
    const changed = await resumeScheduledControllerContinuation(store, {
      scheduleId: schedule.scheduleId,
      occurrenceId: 'occ-semantic-wait-changed',
      workId,
      controllerBindingId: adapter.binding.bindingId,
      relayScopeId,
    }, host);
    expect(changed.dispatch).toMatchObject({ status: 'dispatched', hostDispatchId: 'dispatch-1' });
    expect(resumeCalls).toBe(1);
    expect(getControllerRoundRelay(store, workId)).toMatchObject({ status: 'dispatched', providerDispatchReceiptId: 'dispatch-1' });
  }, 15_000);

  test('Work-bound controller capability survives execution-session invalidation and transport rotation without collapsing same-principal conversations', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const principalId = 'principal-direct-connector';
    const runtimeInstanceId = 'runtime-direct-connector';
    const workId = 'work-direct-connector-rollover';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);

    const claimed = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-call-1', runtimeInstanceId),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workId },
    ));
    expect(claimed.status).toBe('ok');
    const authorityId = String(claimed.data?.controllerAuthorityId ?? '');
    expect(authorityId).toStartWith('ctrl_');
    expect(getControllerSession(store, workId)?.sessionId).toBe('transport-call-1');
    expect(getControllerSession(store, workId)?.authorityDigest).toBeTruthy();
    expect(JSON.stringify(getControllerSession(store, workId))).not.toContain(authorityId);

    invalidateExecutionSession(fx.controllerHome, 'transport-call-1', 'mcp_transport_principal_capacity');

    const foreign = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-call-2', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workId,
        session_id: 'ctrl_foreign_conversation_capability',
        requested_by: 'chatgpt',
        reason: 'same principal but different conversation capability',
      },
    ));
    expect(foreign.status).toBe('blocked');
    expect(foreign.summary).toContain('WORK_CONTROLLER_SCOPE_MISMATCH');
    expect(getWorkContract(store, workId)?.status).toBe('ready');

    const ownStop = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-call-3', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workId,
        session_id: authorityId,
        requested_by: 'chatgpt',
        reason: 'same conversation after connector transport rotation and prior execution-session invalidation',
      },
    ));
    expect(ownStop.status).toBe('ok');
    expect(getWorkContract(store, workId)?.status).toBe('cancelled');
  }, 15_000);

  test('explicit user recovery can rekey only a direct exact-Work authority after capability loss without weakening normal transport fencing', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const principalId = 'principal-direct-authority-recovery';
    const runtimeInstanceId = 'runtime-direct-authority-recovery';
    const workId = 'work-direct-authority-recovery';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    publishCurrentRuntime(fx.controllerHome, runtimeInstanceId);

    const initial = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-recovery-1', runtimeInstanceId),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workId },
    ));
    const initialAuthority = String(initial.data?.controllerAuthorityId ?? '');
    expect(initial.status).toBe('ok');
    expect(initialAuthority).toStartWith('ctrl_');

    const ordinaryRotatedClaim = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-recovery-2', runtimeInstanceId),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workId },
    ));
    expect(ordinaryRotatedClaim.status).toBe('blocked');
    expect(ordinaryRotatedClaim.summary).toContain('WORK_CONTROLLER_SCOPE_MISMATCH');

    const automatedRecovery = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-recovery-2', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'repair',
        work_id: workId,
        capability_id: `controller.authority.recover:${workId}`,
        requested_by: 'chatgpt',
      },
    ));
    expect(automatedRecovery.status).toBe('blocked');
    expect(automatedRecovery.summary).toContain('WORK_CONTROLLER_AUTHORITY_RECOVERY_USER_REQUIRED');

    const recovered = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-recovery-2', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'repair',
        work_id: workId,
        capability_id: `controller.authority.recover:${workId}`,
        requested_by: 'user',
      },
    ));
    const recoveredAuthority = String(recovered.data?.controllerAuthorityId ?? '');
    expect(recovered.status).toBe('ok');
    expect(recovered.data?.authorityRecovered).toBe(true);
    expect(recoveredAuthority).toStartWith('ctrl_');
    expect(recoveredAuthority).not.toBe(initialAuthority);
    expect(getControllerSession(store, workId)?.sessionId).toBe('transport-recovery-2');
    expect(JSON.stringify(getControllerSession(store, workId))).not.toContain(recoveredAuthority);

    const finalStop = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-recovery-3', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workId,
        controller_authority_id: recoveredAuthority,
        requested_by: 'chatgpt',
        reason: 'exact recovered direct authority survives another transport rotation',
      },
    ));
    expect(finalStop.status).toBe('ok');
    expect(getWorkContract(store, workId)?.status).toBe('cancelled');
  }, 15_000);

  test('same-principal concurrent ChatGPT conversations cannot claim or stop each other while the owning round survives transport rotation', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const principalId = 'principal-shared-conversations';
    const runtimeInstanceId = 'runtime-shared-conversations';
    const workA = 'work-conversation-a';
    const workB = 'work-conversation-b';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workA);
    createReadyWork(fx.controllerHome, fx.repository.repoId, workB);

    const beginRound = (workId: string, suffix: string) => {
      const bindingId = `chatgpt:${fx.repository.repoId}:${workId}`;
      const relay = beginInitialControllerRoundDispatch(store, {
        workId,
        identity: {
          controllerId: principalId,
          controllerType: 'chatgpt',
          principalId,
          controllerInstanceId: runtimeInstanceId,
          sessionId: `launcher-${suffix}`,
        },
        relayScopeId: `goal:${workId}`,
        bindingId,
      });
      expect(relay.authorityId).toBeTruthy();
      finishControllerRoundRelayDispatch(store, { workId, ok: true, bindingId });
      const owner = claimControllerSession(store, {
        workId,
        controllerId: principalId,
        controllerType: 'chatgpt',
        sessionId: `transport-${suffix}`,
        principalId,
        controllerInstanceId: runtimeInstanceId,
        leaseMs: 60_000,
      });
      acknowledgeControllerRoundClaim(store, { workId, session: owner });
      return relay;
    };

    const relayA = beginRound(workA, 'a');
    const relayB = beginRound(workB, 'b');

    const foreignClaim = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-b', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'controller_claim',
        work_id: workA,
        relay_scope_id: relayB.relayScopeId,
        controller_authority_id: relayB.authorityId,
      },
    ));
    expect(foreignClaim.status).toBe('blocked');
    expect(foreignClaim.summary).toContain('WORK_CONTROLLER_RELAY_SCOPE_MISMATCH');
    expect(getControllerSession(store, workA)?.sessionId).toBe('transport-a');

    const foreignStopWithForeignScope = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-b', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workA,
        requested_by: 'chatgpt',
        reason: 'directive from unrelated conversation',
        relay_scope_id: relayB.relayScopeId,
        controller_authority_id: relayB.authorityId,
      },
    ));
    expect(foreignStopWithForeignScope.status).toBe('blocked');
    expect(foreignStopWithForeignScope.summary).toContain('WORK_CONTROLLER_RELAY_SCOPE_MISMATCH');

    // Scope is intentionally predictable for semantic grouping. It is not the
    // authority secret: even a foreign round that knows A's scope still fails
    // without A's opaque per-round capability.
    const foreignStopWithKnownTargetScope = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-b', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workA,
        requested_by: 'chatgpt',
        reason: 'foreign conversation knows target Work and relay scope',
        relay_scope_id: relayA.relayScopeId,
        controller_authority_id: relayB.authorityId,
      },
    ));
    expect(foreignStopWithKnownTargetScope.status).toBe('blocked');
    expect(foreignStopWithKnownTargetScope.summary).toContain('WORK_CONTROLLER_ROUND_AUTHORITY_MISMATCH');
    expect(getWorkContract(store, workA)?.status).toBe('ready');
    expect(getWorkContract(store, workB)?.status).toBe('ready');
    expect(getControllerSession(store, workA)?.sessionId).toBe('transport-a');

    const owningClaimAfterTransportRotation = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-a-rotated', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'controller_claim',
        work_id: workA,
        relay_scope_id: relayA.relayScopeId,
        controller_authority_id: relayA.authorityId,
      },
    ));
    expect(owningClaimAfterTransportRotation.status).toBe('ok');
    expect(getControllerSession(store, workA)?.sessionId).toBe('transport-a-rotated');
    const owningGeneration = getControllerSession(store, workA)?.claimGeneration;

    // Real ChatGPT MCP calls can rotate transport again between the successful
    // claim and the immediately following terminalization call. The exact same
    // upgraded relay-round capability must authorize only this transient rebind.
    const owningStopAfterTransportRotation = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-a-terminal', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workA,
        requested_by: 'chatgpt',
        reason: 'owning conversation semantic stop after another MCP transport rotation',
        relay_scope_id: relayA.relayScopeId,
        controller_authority_id: relayA.authorityId,
      },
    ));
    expect(owningStopAfterTransportRotation.status).toBe('ok');
    expect(getWorkContract(store, workA)?.status).toBe('cancelled');
    expect(getControllerSession(store, workA)?.sessionId).toBe('transport-a-terminal');
    expect(getControllerSession(store, workA)?.claimGeneration).toBe(owningGeneration);
    expect(getWorkContract(store, workB)?.status).toBe('ready');

    // Frozen MCP clients may expose only session_id. The exact relay authority
    // remains the secret fence while relay scope is derived from the exact Work.
    const frozenClaimB = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-b-frozen-claim', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'controller_claim',
        work_id: workB,
        session_id: relayB.authorityId,
      },
    ));
    expect(frozenClaimB.status).toBe('ok');
    expect(getControllerSession(store, workB)?.sessionId).toBe('transport-b-frozen-claim');

    const wrongFrozenStopB = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-b-frozen-wrong', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workB,
        session_id: relayA.authorityId,
        requested_by: 'chatgpt',
        reason: 'wrong frozen relay authority',
      },
    ));
    expect(wrongFrozenStopB.status).toBe('blocked');
    expect(wrongFrozenStopB.summary).toContain('WORK_CONTROLLER_ROUND_AUTHORITY_MISMATCH');
    expect(getWorkContract(store, workB)?.status).toBe('ready');

    const frozenStopB = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, principalId, 'transport-b-frozen-stop', runtimeInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'stop',
        work_id: workB,
        session_id: relayB.authorityId,
        requested_by: 'chatgpt',
        reason: 'own frozen relay authority after transport rotation',
      },
    ));
    expect(frozenStopB.status).toBe('ok');
    expect(getWorkContract(store, workB)?.status).toBe('cancelled');
    expect(getControllerSession(store, workB)?.sessionId).toBe('transport-b-frozen-stop');
  }, 15_000);

  test('terminal cleanup resolves legacy exact-id WorkHandles without workContractId', async () => {
    const fx = fixture();
    const workId = 'work-legacy-handle-terminal-cleanup';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const caller = {
      principalId: 'principal-legacy-cleanup',
      sessionId: 'transport-legacy-cleanup',
      controllerInstanceId: 'runtime-legacy-cleanup',
    };
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });
    const now = new Date().toISOString();
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      worktreePath: fx.repoRoot,
      branch: 'main',
      managedWorktree: false,
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim(),
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      finalization: {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
      },
    });

    const stopped = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'user', reason: 'legacy exact-id cleanup regression' },
    ));

    expect(stopped.status).toBe('ok');
    expect(stopped.summary).not.toContain('WORK_CONTROLLER_CLAIM_TERMINAL');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('cancelled');
  }, 15_000);

  test('scheduler continuation cannot steal a same-principal Codex Work through a ChatGPT transport', async () => {
    const fx = fixture();
    const workId = 'work-scheduler-preserves-codex-owner';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const owner = claimControllerSession(store, {
      workId,
      controllerId: 'principal-shared',
      controllerType: 'codex',
      sessionId: 'codex-session',
      principalId: 'principal-shared',
      controllerInstanceId: 'runtime-shared',
      leaseMs: 60_000,
    });

    const continued = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-shared', 'chatgpt-session', 'runtime-shared'),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'continue',
        work_id: workId,
        requested_by: 'scheduler',
      },
    ));

    expect(continued.status).toBe('blocked');
    expect(continued.summary).toContain('WORK_CONTROLLER_TYPE_MISMATCH');
    expect(continued.data?.ownershipResumed).toBe(false);
    expect(getControllerSession(store, workId)).toMatchObject({
      controllerId: owner.controllerId,
      controllerType: 'codex',
      sessionId: 'codex-session',
      claimGeneration: owner.claimGeneration,
    });
  }, 15_000);

  test('controller release survives transport session rollover for the same authenticated controller authority', async () => {
    const fx = fixture();
    const workId = 'work-release-transport-rollover';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-rollover',
      controllerType: 'chatgpt',
      sessionId: 'transport-before-rollover',
      principalId: 'principal-rollover',
      controllerInstanceId: 'runtime-stable',
      leaseMs: 60_000,
    });

    const unrelated = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-other', 'transport-after-rollover-other', 'runtime-stable'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_release', work_id: workId, session_id: 'transport-before-rollover' },
    ));
    expect(unrelated.status).toBe('blocked');
    expect(unrelated.summary).toContain('WORK_CONTROLLER_OWNER_MISMATCH');
    expect(getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)).toBeTruthy();

    const released = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-rollover', 'transport-after-rollover', 'runtime-stable'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_release', work_id: workId, session_id: 'transport-before-rollover' },
    ));
    expect(released.status).toBe('ok');
    expect(getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)).toBeUndefined();
  }, 15_000);

  test('current canonical Runtime migrates the same principal before release while the old Runtime stays fenced', async () => {
    const fx = fixture();
    const workId = 'work-runtime-migration-release';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const first = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-migrate',
      controllerType: 'chatgpt',
      sessionId: 'transport-old-runtime',
      principalId: 'principal-migrate',
      controllerInstanceId: 'runtime-old',
      leaseMs: 60_000,
    });
    publishCurrentRuntime(fx.controllerHome, 'runtime-new');

    const released = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-migrate', 'transport-new-runtime', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_release', work_id: workId },
    ));
    expect(released.status).toBe('ok');
    expect(first.claimGeneration).toBe(1);
    expect(getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)).toBeUndefined();
  }, 15_000);

  test('release of an observed controller session is claim-generation fenced against a newer ownership epoch', () => {
    const fx = fixture();
    const workId = 'work-observed-release-generation-fence';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const observed = claimControllerSession(store, {
      workId,
      controllerId: 'principal-observed',
      controllerType: 'chatgpt',
      sessionId: 'transport-observed',
      principalId: 'principal-observed',
      controllerInstanceId: 'runtime-observed',
      leaseMs: 60_000,
    });
    const newer = resumeControllerSession(store, {
      workId,
      controllerId: observed.controllerId,
      controllerType: observed.controllerType,
      sessionId: 'transport-newer',
      principalId: 'principal-observed',
      controllerInstanceId: 'runtime-newer',
      expectedClaimGeneration: observed.claimGeneration,
      leaseMs: 60_000,
    });

    const released = releaseObservedControllerSession(store, {
      workId,
      actor: 'test-observed-release',
      owner: observed,
    });
    expect(released.allowed).toBe(false);
    if (released.allowed) throw new Error('expected stale observed release to be fenced');
    expect(released.reason).toBe('stale_controller_authority');
    expect(getControllerSession(store, workId)?.claimGeneration).toBe(newer.claimGeneration);
    expect(getControllerSession(store, workId)?.controllerInstanceId).toBe('runtime-newer');
  });

  test('stale controller release cannot clear a newer ownership epoch', async () => {
    const fx = fixture();
    const workId = 'work-stale-release';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const first = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-release',
      controllerType: 'chatgpt',
      sessionId: 'transport-old',
      principalId: 'principal-release',
      controllerInstanceId: 'runtime-old',
      leaseMs: 60_000,
    });
    const newer = resumeControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: first.controllerId,
      controllerType: first.controllerType,
      sessionId: 'transport-new',
      principalId: 'principal-release',
      controllerInstanceId: 'runtime-new',
      expectedClaimGeneration: first.claimGeneration,
      leaseMs: 60_000,
    });
    expect(newer.claimGeneration).toBe((first.claimGeneration ?? 1) + 1);

    const staleRelease = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-release', 'transport-stale-release', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_release', work_id: workId },
    ));
    expect(staleRelease.status).toBe('blocked');
    expect(staleRelease.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.controllerInstanceId).toBe('runtime-new');

    const staleStop = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-release', 'transport-stale-stop', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'system', reason: 'stale launcher cleanup' },
    ));
    expect(staleStop.status).toBe('blocked');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');
  }, 15_000);

  test('stale legacy cleanup cannot release a newer ownership epoch', () => {
    const fx = fixture();
    const workId = 'work-stale-legacy-cleanup';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const first = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-cleanup',
      controllerType: 'chatgpt',
      sessionId: 'transport-old-cleanup',
      principalId: 'principal-cleanup',
      controllerInstanceId: 'runtime-old',
      leaseMs: 60_000,
    });
    const newer = resumeControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: first.controllerId,
      controllerType: first.controllerType,
      sessionId: 'transport-new-cleanup',
      principalId: 'principal-cleanup',
      controllerInstanceId: 'runtime-new',
      expectedClaimGeneration: first.claimGeneration,
      leaseMs: 60_000,
    });

    expect(() => releasePreparedWorkOwnership(
      ctx(fx.controllerHome, fx.repository, 'principal-cleanup', 'transport-stale-cleanup', 'runtime-old'),
      { workId, workContractId: workId, repositoryId: fx.repository.repoId } as any,
    )).toThrow('WORK_CONTROLLER_INSTANCE_MISMATCH');

    const retained = getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId);
    expect(retained?.controllerInstanceId).toBe('runtime-new');
    expect(retained?.claimGeneration).toBe(newer.claimGeneration);
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');
  });

  test('default controller ownership lasts one hour while explicit shorter leases remain bounded', () => {
    const fx = fixture();
    const defaultWorkId = 'work-default-one-hour-lease';
    createReadyWork(fx.controllerHome, fx.repository.repoId, defaultWorkId);
    const owner = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: defaultWorkId,
      controllerId: 'principal-default-lease',
      controllerType: 'chatgpt',
      sessionId: 'transport-default-lease',
      principalId: 'principal-default-lease',
      controllerInstanceId: 'runtime-default-lease',
    });
    expect(Date.parse(owner.leaseExpiresAt) - Date.parse(owner.claimedAt)).toBe(60 * 60_000);

    const shortWorkId = 'work-explicit-short-lease';
    createReadyWork(fx.controllerHome, fx.repository.repoId, shortWorkId);
    const shortOwner = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: shortWorkId,
      controllerId: 'principal-short-lease',
      controllerType: 'chatgpt',
      sessionId: 'transport-short-lease',
      principalId: 'principal-short-lease',
      controllerInstanceId: 'runtime-short-lease',
      leaseMs: 60_000,
    });
    expect(Date.parse(shortOwner.leaseExpiresAt) - Date.parse(shortOwner.claimedAt)).toBe(60_000);
  });

  test('claim generation is fenced atomically and explicit user stop requires a target Work claim', async () => {
    const fx = fixture();
    const workId = 'work-generation-fence';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const owner = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-b',
      controllerType: 'chatgpt',
      sessionId: 'transport-b',
      principalId: 'principal-b',
      controllerInstanceId: 'runtime-b',
      leaseMs: 60_000,
    });
    const staleGeneration = withControllerSessionTerminalizationFence(
      { controllerHome: fx.controllerHome, repoId: fx.repository.repoId },
      {
        workId,
        actor: 'regression-stale-generation',
        authority: {
          controllerId: owner.controllerId,
          controllerType: owner.controllerType,
          principalId: owner.principalId!,
          controllerInstanceId: owner.controllerInstanceId!,
          claimGeneration: (owner.claimGeneration ?? 1) + 1,
        },
      },
      () => transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId, {
        phase: 'cleanup',
        status: 'cancelled',
        state: 'skipped',
        summary: 'must not run',
      }),
    );
    expect(staleGeneration.allowed).toBe(false);
    if (!staleGeneration.allowed) expect(staleGeneration.reason).toBe('stale_controller_authority');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');

    const explicitWorkId = 'work-explicit-user-stop';
    createReadyWork(fx.controllerHome, fx.repository.repoId, explicitWorkId);
    const explicitContext = ctx(fx.controllerHome, fx.repository, 'principal-user', 'transport-user', 'runtime-user');
    const unclaimed = structured(await callRuntimeTool(
      explicitContext,
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: explicitWorkId, requested_by: 'user', reason: 'explicit user stop' },
    ));
    expect(unclaimed.status).toBe('blocked');
    expect(unclaimed.summary).toContain('WORK_CONTROLLER_OWNER_REQUIRED');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, explicitWorkId)?.status).toBe('ready');

    const explicitClaim = structured(await callRuntimeTool(
      explicitContext,
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: explicitWorkId },
    ));
    expect(explicitClaim.status).toBe('ok');
    const explicit = structured(await callRuntimeTool(
      explicitContext,
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: explicitWorkId, requested_by: 'user', reason: 'explicit user stop' },
    ));
    expect(explicit.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, explicitWorkId)?.status).toBe('cancelled');
  }, 15_000);

  test('finalize leaves Plan semantic acceptance explicit and does not unlock dependent steps', async () => {
    const fx = fixture();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const planId = 'plan-explicit-semantic-acceptance';
    const workId = 'work-canary-subpart-only';
    createPlanContract(store, {
      planId,
      repoId: fx.repository.repoId,
      scopeKey: 'explicit-semantic-acceptance',
      sourceRevision: targetRevision,
      goal: 'require Controller review after Work finalization',
      steps: [
        {
          id: 'release-gate',
          objective: 'combine a canary sub-part with independent stabilization evidence',
          dependencies: [],
          authoritativeFiles: [],
          allowedPaths: [],
          forbiddenPaths: [],
          checks: ['package:check:main'],
          acceptanceCriteria: ['canary Work is delivered', 'stabilization supervisor has two timer-origin wakes'],
        },
        {
          id: 'publish',
          objective: 'remain blocked until semantic acceptance',
          dependencies: ['release-gate'],
          authoritativeFiles: [],
          allowedPaths: [],
          forbiddenPaths: [],
          checks: ['package:check:release'],
          acceptanceCriteria: ['release gate is semantically accepted'],
        },
      ],
    });
    approvePlanContract(store, planId);
    createWorkContract(store, {
      workId,
      repoId: fx.repository.repoId,
      mode: 'goal_workloop',
      objective: 'deliver only the canary sub-part',
      acceptanceCriteria: ['canary Work completion receipt exists'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'ready',
      workKind: 'completed_no_change',
      planId,
      planStepId: 'release-gate',
      planSourceRevision: targetRevision,
    });
    claimPlanStepForWork(store, { planId, stepId: 'release-gate', workId, sourceRevision: targetRevision });
    const recordedAt = '2026-08-27T07:00:00.000Z';
    transitionWorkContractPhase(store, workId, { status: 'running', phase: 'verification', state: 'satisfied', summary: 'Exact no-change Plan candidate verified.' });
    requestWorkImplementationReview(store, workId, 'Plan candidate requires explicit implementation review before completion.');
    recordWorkImplementationReview(store, workId, {
      schemaVersion: 1,
      reviewId: 'REV-canary-subpart-only',
      workId,
      reviewerPrincipalId: 'principal-semantic-reviewer',
      reviewerControllerSessionId: 'transport-finalize',
      decision: 'approved',
      rationale: 'The exact no-change canary candidate is reviewed before physical Work completion; Plan semantic acceptance remains separate.',
      findings: [],
      sourceRevision: targetRevision,
      workspaceFingerprint: 'plan-no-change-content',
      verificationWorkspaceFingerprint: 'plan-no-change-verification',
      changedPaths: [],
      changedPathDigest: implementationReviewChangedPathDigest([]),
      acceptanceCriteriaSummary: 'Canary Work completion receipt exists.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt,
    });
    const completed = recordWorkCompletionReceipt(store, workId, {
      schemaVersion: 1,
      receiptId: 'receipt-canary-subpart-only',
      source: 'controller_work',
      issueId: 'release-gate',
      taskId: 'canary-subpart',
      workId,
      targetBranch: 'main',
      targetRevision,
      changedPaths: [],
      delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
      cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
      verifiedAt: recordedAt,
      recordedAt,
    }, 'completed_no_change');
    completePlanStepForWork(store, { planId, stepId: 'release-gate', work: completed });
    expect(getPlanContract(store, planId)?.steps[0]?.status).toBe('validating');

    const finalized = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-semantic-reviewer', 'transport-finalize', 'runtime-finalize'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt' },
    ));
    expect(finalized.status).toBe('ok');
    expect(finalized.data.semanticAcceptanceRecorded).not.toBe(true);
    expect(getPlanContract(store, planId)).toMatchObject({
      status: 'verifying',
      steps: [
        { id: 'release-gate', status: 'validating' },
        { id: 'publish', status: 'pending' },
      ],
    });
    expect(() => claimPlanStepForWork(store, {
      planId,
      stepId: 'publish',
      workId: 'work-publish-premature',
      sourceRevision: targetRevision,
    })).toThrow(/PLAN_NOT_EXECUTABLE: plan-explicit-semantic-acceptance is verifying/);

    const accepted = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-semantic-reviewer', 'transport-accept', 'runtime-finalize'),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'plan_accept_step',
        plan_id: planId,
        plan_step_id: 'release-gate',
        acceptance_rationale: 'Reviewed the Work receipt and the independent stabilization evidence required by the whole release gate.',
      },
    ));
    expect(accepted.status).toBe('ok');
    expect(accepted.data.semanticAcceptanceRecorded).toBe(true);
    expect(getPlanContract(store, planId)?.steps[0]?.status).toBe('completed');
  }, 15_000);


  test('local_effect continue re-derives exact Work-bound repository Process evidence without substituting for checks', async () => {
    const fx = fixture();
    const workId = 'work-local-effect-process-semantic-evidence';
    const criterion = 'A durable repository process result is reviewed.';
    const caller = {
      principalId: 'principal-local-effect-process-evidence',
      sessionId: 'transport-local-effect-process-evidence',
      controllerInstanceId: 'runtime-local-effect-process-evidence',
    };
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: 'local-effect-process-semantic-evidence',
      title: 'Local Effect Process Semantic Evidence',
      branchName: 'work/local-effect-process-semantic-evidence',
    });
    expect(workspace.mode).toBe('isolated');
    expect(workspace.root).toBeTruthy();
    expect(workspace.checkoutId).toBeTruthy();
    createWorkContract(store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      worktreeRef: workspace.root,
      mode: 'goal_workloop',
      objective: 'Review an exact durable repository Process as a local effect result.',
      acceptanceCriteria: [criterion],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: ['fixture-release-check'],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'local_effect',
      status: 'running',
      phase: 'implementation',
    });
    claimControllerSession(store, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });

    const now = new Date().toISOString();
    const processId = 'proc-local-effect-process-semantic-evidence';
    const process: ManagedProcessRecord = {
      schemaVersion: 1,
      processId,
      repoId: fx.repository.repoId,
      checkoutId: workspace.checkoutId!,
      workId,
      commandId: 'command-local-effect-process-semantic-evidence',
      controllerHome: fx.controllerHome,
      status: 'succeeded',
      route: 'managed',
      command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: workspace.root! },
      origin: {
        surface: 'command',
        toolName: 'repository_command_execute',
        requestId: 'request-local-effect-process-semantic-evidence',
        correlationId: workId,
      },
      resourceClaims: [],
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
      exitCode: 0,
      terminalFenceToken: 1,
      terminalWritten: true,
      leaseReleaseState: 'released',
      leasesReleased: true,
    };
    createProcessRecord(process);

    const unknown = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'continue',
        work_id: workId,
        acceptance_evidence: [{ criterion, evidence_ids: ['proc-unrelated'], rationale: 'This id is not owned by the Work.' }],
      },
    ));
    expect(unknown.status).toBe('blocked');
    expect(unknown.summary).toContain('WORK_SEMANTIC_ACCEPTANCE_EVIDENCE_UNKNOWN');

    const rotatedSessionId = 'transport-local-effect-process-evidence-rotated';
    const reviewed = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, caller.principalId, rotatedSessionId, caller.controllerInstanceId),
      'rh_work',
      {
        repo_id: fx.repository.repoId,
        operation: 'continue',
        work_id: workId,
        acceptance_evidence: [{
          criterion,
          evidence_ids: [processId],
          rationale: 'The canonical Process store proves this exact successful terminal repository command belongs to the Work and checkout.',
        }],
      },
    ));
    expect(reviewed.status).toBe('ok');
    expect(reviewed.data?.nextStep).toBe('verify');
    expect(reviewed.data?.remainingChecks).toEqual(['fixture-release-check']);
    expect(getWorkContract(store, workId)?.semanticAcceptanceEvidence).toEqual([
      expect.objectContaining({ criterion, evidenceIds: [processId] }),
    ]);
    expect(getControllerSession(store, workId)).toMatchObject({
      principalId: caller.principalId,
      sessionId: rotatedSessionId,
      controllerInstanceId: caller.controllerInstanceId,
    });
  }, 15_000);

  test('local_effect semantic finalize reconciles and removes its managed worktree', async () => {
    const fx = fixture();
    const workId = 'work-local-effect-terminal-cleanup';
    const caller = {
      principalId: 'principal-local-effect-cleanup',
      sessionId: 'transport-local-effect-cleanup',
      controllerInstanceId: 'runtime-local-effect-cleanup',
    };
    const branch = 'work/local-effect-terminal-cleanup';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: 'local-effect-terminal-cleanup',
      title: 'Local Effect Terminal Cleanup',
      branchName: branch,
    });
    expect(workspace.mode).toBe('isolated');
    expect(workspace.root).toBeTruthy();
    expect(workspace.checkoutId).toBeTruthy();
    expect(existsSync(workspace.root!)).toBe(true);
    const repository = getRepository(fx.repository.repoId, fx.controllerHome);
    const now = new Date().toISOString();
    const evidenceId = 'PLG-local-effect-terminal-cleanup';
    createWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: workspace.checkoutId!,
      baseRevision: workspace.baseRevision ?? undefined,
      mode: 'goal_workloop',
      objective: 'Complete a local effect and cleanup its isolated worktree.',
      acceptanceCriteria: ['A durable local effect receipt is reviewed.'],
      allowedPaths: [],
      forbiddenPaths: ['**/*'],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'local_effect',
      status: 'running',
      phase: 'implementation',
      worktreeRef: workspace.root,
      evidenceRefs: [{ evidenceId, title: 'typed local effect', summary: 'Durable local effect receipt.', detailLevel: 'summary' }],
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: repository.repoId,
      checkoutId: workspace.checkoutId!,
      worktreePath: workspace.root!,
      branch,
      sourceCheckoutId: repository.activeCheckoutId,
      workContractId: workId,
      baseCommit: workspace.baseRevision ?? undefined,
      deliveryBaseCommit: workspace.baseRevision ?? undefined,
      expectedHead: workspace.baseRevision ?? undefined,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      managedWorktree: true,
      createdAt: now,
      updatedAt: now,
      finalization: {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
      },
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
    });

    const reviewed = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'continue',
        work_id: workId,
        acceptance_evidence: [{
          criterion: 'A durable local effect receipt is reviewed.',
          evidence_ids: [evidenceId],
          rationale: 'The exact durable receipt is attributed to this Work.',
        }],
      },
    ));
    if (reviewed.status !== 'ok') throw new Error(`REVIEW_DIAGNOSTIC:${JSON.stringify(reviewed)}`);
    expect(reviewed.status).toBe('ok');

    const finalized = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'finalize',
        work_id: workId,
        requested_by: 'chatgpt',
        commit: false,
        merge: false,
        cleanup: true,
      },
    ));

    expect(finalized.status).toBe('ok');
    expect(finalized.data.lifecycleClosed).toBe(true);
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, workId)).toMatchObject({
      status: 'completed',
      workKind: 'local_effect',
      completionOutcome: 'completed_local',
    });
    expect(readWorkHandle(fx.controllerHome, repository.repoId, workId)?.finalization.worktreeCleanup).toBe('done');
    expect(existsSync(workspace.root!)).toBe(false);
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fx.repoRoot, encoding: 'utf8' })).not.toContain(workspace.root!);
  }, 15_000);


  test('isolated WorkHandle preserves canonical source identity and adopts a Work-attributed clean descendant before finalization', async () => {
    const fx = fixture();
    const workId = 'work-isolated-unscoped-head-adoption';
    const caller = {
      principalId: 'principal-isolated-unscoped-head',
      sessionId: 'transport-isolated-unscoped-head',
      controllerInstanceId: 'runtime-isolated-unscoped-head',
    };
    const branch = 'work/isolated-unscoped-head-adoption';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: 'isolated-unscoped-head-adoption',
      title: 'Isolated Unscoped Head Adoption',
      branchName: branch,
    });
    const canonicalRepository = getRepository(fx.repository.repoId, fx.controllerHome);
    createWorkContract({ controllerHome: fx.controllerHome, repoId: canonicalRepository.repoId }, {
      workId,
      repoId: canonicalRepository.repoId,
      checkoutId: workspace.checkoutId!,
      baseRevision: workspace.baseRevision ?? undefined,
      mode: 'goal_workloop',
      objective: 'Adopt a clean committed successor for an isolated repository-scoped Work.',
      acceptanceCriteria: ['The exact clean descendant is delivered.'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'repository_change',
      status: 'running',
      phase: 'implementation',
      worktreeRef: workspace.root,
    });
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: canonicalRepository.repoId }, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });

    const selectedWorktree = selectRepositoryCheckout(canonicalRepository, workspace.checkoutId!);
    const handle = ensureRepositoryWorkHandle({
      controllerHome: fx.controllerHome,
      repository: selectedWorktree,
      workId,
      identity: { sessionId: caller.sessionId, principalId: caller.principalId },
    });
    expect(handle).toMatchObject({
      checkoutId: workspace.checkoutId,
      worktreePath: workspace.root,
      sourceCheckoutId: canonicalRepository.activeCheckoutId,
      managedWorktree: true,
      expectedHead: workspace.baseRevision,
    });

    writeFileSync(join(workspace.root!, 'src', 'index.ts'), 'export const ready = \"isolated-work-attributed-delivery\";\n');
    const committed = await executeRepositoryCommandViaProcessRuntime({
      controllerHome: fx.controllerHome,
      repository: selectedWorktree,
      command: ['git', 'commit', '--only', '-m', 'isolated work-attributed delivery', '--', 'src/index.ts'],
      timeoutMs: 10_000,
      workId,
      executionIdentity: executionIdentityForWork(selectedWorktree, handle!),
    });
    const committedTerminal = committed.process?.completed
      ? committed.process
      : committed.process
        ? await waitRepositoryCommandProcess(fx.controllerHome, canonicalRepository.repoId, committed.process.processId, { timeoutMs: 10_000 })
        : undefined;
    expect(committedTerminal?.ok ?? committed.ok).toBe(true);
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.root!, encoding: 'utf8' }).trim();
    expect(candidate).not.toBe(workspace.baseRevision ?? undefined);
    expect(readWorkHandle(fx.controllerHome, canonicalRepository.repoId, workId)?.expectedHead).toBe(candidate);

    const admitted = structured(await callRuntimeTool(
      ctx(fx.controllerHome, canonicalRepository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: canonicalRepository.repoId, checkout_id: workspace.checkoutId, operation: 'continue', work_id: workId, requested_by: 'chatgpt' },
    ));
    expect(admitted.status).toBe('ok');
    expect(admitted.data.nextStep).toBe('review');

    const reviewed = structured(await callRuntimeTool(
      ctx(fx.controllerHome, canonicalRepository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: canonicalRepository.repoId, checkout_id: workspace.checkoutId, operation: 'review', work_id: workId, requested_by: 'chatgpt', review_decision: 'approved', review_rationale: 'Exact verified committed descendant reviewed before delivery.' },
    ));
    expect(reviewed.status).toBe('ok');

    const finalized = structured(await callRuntimeTool(
      ctx(fx.controllerHome, canonicalRepository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: canonicalRepository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt', cleanup: true },
    ));
    expect(finalized.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: canonicalRepository.repoId }, workId)).toMatchObject({
      status: 'completed',
      workKind: 'repository_change',
      completionOutcome: 'completed_changed',
    });
    expect(execFileSync('git', ['rev-parse', 'main'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe(candidate);
    expect(existsSync(workspace.root!)).toBe(false);
  }, 20_000);

  test('local_effect with committed repository delta is delivered physically before cleanup instead of emitting LFX', async () => {
    const fx = fixture();
    const workId = 'work-local-effect-acquired-source-delta';
    const caller = {
      principalId: 'principal-local-effect-source-delta',
      sessionId: 'transport-local-effect-source-delta',
      controllerInstanceId: 'runtime-local-effect-source-delta',
    };
    const branch = 'work/local-effect-acquired-source-delta';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: 'local-effect-acquired-source-delta',
      title: 'Local Effect Acquired Source Delta',
      branchName: branch,
    });
    const repository = getRepository(fx.repository.repoId, fx.controllerHome);
    const now = new Date().toISOString();
    createWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: workspace.checkoutId!,
      baseRevision: workspace.baseRevision ?? undefined,
      mode: 'goal_workloop',
      objective: 'An initially effect-only Work discovered a real source repair.',
      acceptanceCriteria: ['The source repair is integrated before cleanup.'],
      allowedPaths: ['src/index.ts'],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'local_effect',
      status: 'running',
      phase: 'implementation',
      worktreeRef: workspace.root,
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: repository.repoId,
      checkoutId: workspace.checkoutId!,
      worktreePath: workspace.root!,
      branch,
      sourceCheckoutId: repository.activeCheckoutId,
      workContractId: workId,
      baseCommit: workspace.baseRevision ?? undefined,
      deliveryBaseCommit: workspace.baseRevision ?? undefined,
      expectedHead: workspace.baseRevision ?? undefined,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      managedWorktree: true,
      createdAt: now,
      updatedAt: now,
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
    });
    writeFileSync(join(workspace.root!, 'src', 'index.ts'), 'export const ready = "physically-delivered";\n');
    const preparedHandle = readWorkHandle(fx.controllerHome, repository.repoId, workId)!;
    const selectedWorktree = selectRepositoryCheckout(repository, workspace.checkoutId!);
    const committed = await executeRepositoryCommandViaProcessRuntime({
      controllerHome: fx.controllerHome,
      repository: selectedWorktree,
      command: ['git', 'commit', '--only', '-m', 'source repair from effect work', '--', 'src/index.ts'],
      timeoutMs: 10_000,
      workId,
      executionIdentity: executionIdentityForWork(selectedWorktree, preparedHandle),
    });
    const committedTerminal = committed.process?.completed
      ? committed.process
      : committed.process
        ? await waitRepositoryCommandProcess(fx.controllerHome, repository.repoId, committed.process.processId, { timeoutMs: 10_000 })
        : undefined;
    expect(committedTerminal?.ok ?? committed.ok).toBe(true);
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.root!, encoding: 'utf8' }).trim();
    expect(readWorkHandle(fx.controllerHome, repository.repoId, workId)?.expectedHead).toBe(candidate);
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });

    const admitted = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: repository.repoId, checkout_id: workspace.checkoutId, operation: 'continue', work_id: workId, requested_by: 'chatgpt' },
    ));
    expect(admitted.status).toBe('ok');
    expect(admitted.data.nextStep).toBe('review');

    const reviewed = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: repository.repoId, checkout_id: workspace.checkoutId, operation: 'review', work_id: workId, requested_by: 'chatgpt', review_decision: 'approved', review_rationale: 'Verified source delta discovered by effect Work is explicitly reviewed before physical delivery.' },
    ));
    expect(reviewed.status).toBe('ok');

    const finalized = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt', cleanup: true },
    ));

    expect(finalized.status).toBe('ok');
    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, workId)!;
    expect(completed).toMatchObject({ status: 'completed', workKind: 'repository_change', completionOutcome: 'completed_changed' });
    expect(completed.completionReceipt?.source).not.toBe('local_effect');
    expect(execFileSync('git', ['rev-parse', 'main'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe(candidate);
    expect(existsSync(workspace.root!)).toBe(false);
  }, 20_000);

  test('pure remote_effect may complete from an exact trusted Work-attributed git push Process receipt', async () => {
    const fx = fixture();
    const workId = 'work-remote-effect-git-push-process';
    const caller = {
      principalId: 'principal-remote-effect-process',
      sessionId: 'transport-remote-effect-process',
      controllerInstanceId: 'runtime-remote-effect-process',
    };
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, {
      requestId: 'remote-effect-git-push-process',
      title: 'Remote Effect Git Push Process',
      branchName: 'work/remote-effect-git-push-process',
    });
    const repository = getRepository(fx.repository.repoId, fx.controllerHome);
    const now = new Date().toISOString();
    createWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: workspace.checkoutId!,
      baseRevision: workspace.baseRevision ?? undefined,
      mode: 'goal_workloop',
      objective: 'Deliver an already-validated revision to a Git remote.',
      acceptanceCriteria: ['The exact governed git push succeeds.'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'remote_effect',
      status: 'running',
      phase: 'implementation',
      worktreeRef: workspace.root,
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId,
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      repositoryId: repository.repoId,
      checkoutId: workspace.checkoutId!,
      worktreePath: workspace.root!,
      branch: 'work/remote-effect-git-push-process',
      sourceCheckoutId: repository.activeCheckoutId,
      workContractId: workId,
      baseCommit: workspace.baseRevision ?? undefined,
      deliveryBaseCommit: workspace.baseRevision ?? undefined,
      expectedHead: workspace.baseRevision ?? undefined,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      managedWorktree: true,
      createdAt: now,
      updatedAt: now,
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
    });
    const processId = 'proc-remote-effect-git-push-process';
    createProcessRecord({
      schemaVersion: 1,
      processId,
      repoId: repository.repoId,
      checkoutId: workspace.checkoutId!,
      workId,
      commandId: 'command-remote-effect-git-push-process',
      controllerHome: fx.controllerHome,
      status: 'succeeded',
      route: 'managed',
      command: { kind: 'argv', executable: '/usr/bin/git', args: ['push', 'origin', 'HEAD:refs/heads/proof'], cwd: workspace.root! },
      origin: { surface: 'command', toolName: 'repository_command_execute', requestId: 'request-remote-effect-git-push-process', correlationId: workId },
      resourceClaims: [{ resourceKey: `remote:${repository.repoId}`, mode: 'exclusive', repoId: repository.repoId, checkoutId: workspace.checkoutId!, workId }],
      identity: { pid: 7301, processStartTime: 'trusted-git-push', executableFingerprint: 'git-push-fingerprint', processGroupId: 7301 },
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
      exitCode: 0,
      terminalFenceToken: 1,
      terminalWritten: true,
      leaseReleaseState: 'released',
      leasesReleased: true,
    });
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId,
      controllerId: caller.principalId,
      controllerType: 'chatgpt',
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
      leaseMs: 60_000,
    });

    const finalized = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt', cleanup: true },
    ));
    expect(finalized.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, workId)).toMatchObject({
      status: 'completed',
      workKind: 'remote_effect',
      completionOutcome: 'completed_remote',
      completionReceipt: { source: 'remote_effect', authority: 'repository_process', processId, receiptId: processId },
    });
    expect(existsSync(workspace.root!)).toBe(false);
  }, 20_000);

  test('no-change finalization proves target reachability before removing a managed worktree', async () => {
    const fx = fixture();
    const workId = 'work-no-change-target-preflight';
    const caller = { principalId: 'principal-no-change-preflight', sessionId: 'transport-no-change-preflight', controllerInstanceId: 'runtime-no-change-preflight' };
    execFileSync('git', ['switch', '--orphan', 'unrelated-target'], { cwd: fx.repoRoot });
    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'unrelated root\n');
    execFileSync('git', ['add', '.'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-m', 'unrelated root'], { cwd: fx.repoRoot });
    execFileSync('git', ['switch', 'main'], { cwd: fx.repoRoot });

    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, { requestId: workId, title: 'No Change Target Preflight', branchName: 'work/no-change-target-preflight' });
    const repository = getRepository(fx.repository.repoId, fx.controllerHome);
    const now = new Date().toISOString();
    createWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId, repoId: repository.repoId, checkoutId: workspace.checkoutId!, baseRevision: workspace.baseRevision ?? undefined,
      mode: 'goal_workloop', objective: 'Prove no-change target before cleanup.', acceptanceCriteria: ['No source delta is delivered only to the intended target.'],
      allowedPaths: [], forbiddenPaths: ['**'], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt',
      workKind: 'investigation', status: 'running', phase: 'verification', worktreeRef: workspace.root,
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1, workId, sessionId: caller.sessionId, principalId: caller.principalId, repositoryId: repository.repoId,
      checkoutId: workspace.checkoutId!, worktreePath: workspace.root!, branch: 'work/no-change-target-preflight', sourceCheckoutId: repository.activeCheckoutId,
      workContractId: workId, baseCommit: workspace.baseRevision ?? undefined, deliveryBaseCommit: workspace.baseRevision ?? undefined,
      expectedHead: workspace.baseRevision ?? undefined, permissionSnapshotVersion: 1, state: 'prepared', managedWorktree: true, createdAt: now, updatedAt: now,
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
    });
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId, controllerId: caller.principalId, controllerType: 'chatgpt', sessionId: caller.sessionId, principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId, leaseMs: 60_000,
    });

    const finalized = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt', completion_outcome: 'completed_no_change', no_change_evidence: 'Exact source remained unchanged.', cleanup: true, target_branch: 'unrelated-target' },
    ));
    expect(finalized.status).not.toBe('ok');
    expect((finalized.error as { code?: string } | undefined)?.code).toBe('WORK_COMPLETION_RECEIPT_DELIVERY_NOT_PROVEN');
    expect(existsSync(workspace.root!)).toBe(true);
    expect(selectRepositoryCheckout(getRepository(repository.repoId, fx.controllerHome), workspace.checkoutId!).activeCheckoutId).toBe(workspace.checkoutId!);
  }, 20_000);

  test('no-change finalization can settle from retained validation after a prior cleanup already removed the worktree', async () => {
    const fx = fixture();
    const workId = 'work-no-change-removed-worktree-retry';
    const caller = { principalId: 'principal-no-change-retry', sessionId: 'transport-no-change-retry', controllerInstanceId: 'runtime-no-change-retry' };
    const branch = 'work/no-change-removed-worktree-retry';
    const workspace = ensureManagedWorkspace(fx.controllerHome, fx.repository, { requestId: workId, title: 'No Change Removed Worktree Retry', branchName: branch });
    const repository = getRepository(fx.repository.repoId, fx.controllerHome);
    const base = workspace.baseRevision!;
    const now = new Date().toISOString();
    createWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId, repoId: repository.repoId, checkoutId: workspace.checkoutId!, baseRevision: base, mode: 'goal_workloop', objective: 'Recover an already-cleaned no-change delivery.',
      acceptanceCriteria: ['Existing no-change evidence terminalizes the same Work.'], allowedPaths: [], forbiddenPaths: ['**'], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', workKind: 'investigation', status: 'running', phase: 'delivery', worktreeRef: workspace.root,
    });
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1, workId, sessionId: caller.sessionId, principalId: caller.principalId, repositoryId: repository.repoId,
      checkoutId: workspace.checkoutId!, worktreePath: workspace.root!, branch, sourceCheckoutId: repository.activeCheckoutId, workContractId: workId,
      baseCommit: base, deliveryBaseCommit: base, expectedHead: base, permissionSnapshotVersion: 1, state: 'merged', managedWorktree: true,
      validatedInputFingerprint: 'retained-no-change-validation', createdAt: now, updatedAt: now,
      finalization: { validation: 'done', commit: 'skipped', merge: 'skipped', branchCleanup: 'pending', worktreeCleanup: 'done' },
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
    });
    execFileSync('git', ['worktree', 'remove', '--force', workspace.root!], { cwd: fx.repoRoot });
    setRepositoryCheckoutLifecycle({ controllerHome: fx.controllerHome, repoId: repository.repoId, checkoutId: workspace.checkoutId!, lifecycle: 'removed', reason: 'simulate crash after durable worktree cleanup' });
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: repository.repoId }, {
      workId, controllerId: caller.principalId, controllerType: 'chatgpt', sessionId: caller.sessionId, principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId, leaseMs: 60_000,
    });

    const finalized = structured(await callRuntimeTool(
      ctx(fx.controllerHome, repository, caller.principalId, caller.sessionId, caller.controllerInstanceId),
      'rh_work',
      { repo_id: repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt', completion_outcome: 'completed_no_change', no_change_evidence: 'Retained validation proves the exact no-change candidate.', cleanup: true, target_branch: 'main' },
    ));
    expect(finalized.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: repository.repoId }, workId)).toMatchObject({
      status: 'completed', completionOutcome: 'completed_no_change', completionReceipt: { targetBranch: 'main', sourceRevision: base, changedPaths: [] },
    });
    expect(existsSync(workspace.root!)).toBe(false);
  }, 20_000);

  test('exact rh_work repair does not run broad maintenance against unrelated stale Work', async () => {
    const fx = fixture();
    const targetWorkId = 'work-exact-repair-target';
    createReadyWork(fx.controllerHome, fx.repository.repoId, targetWorkId);

    const staleWorkId = 'work-unrelated-stale-maintenance';
    const stale = ensureManagedWorkspace(fx.controllerHome, fx.repository, { requestId: staleWorkId, title: 'Unrelated Stale Maintenance', branchName: 'work/unrelated-stale-maintenance' });
    const oldStore = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId, now: () => '2026-01-01T00:00:00.000Z' };
    createWorkContract(oldStore, {
      workId: staleWorkId, repoId: fx.repository.repoId, checkoutId: stale.checkoutId!, baseRevision: stale.baseRevision ?? undefined,
      mode: 'goal_workloop', objective: 'Unrelated stale cleanup candidate.', acceptanceCriteria: ['Remain untouched by exact repair.'],
      allowedPaths: ['**'], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', workKind: 'investigation', status: 'ready', worktreeRef: stale.root,
    });
    transitionWorkContractPhase(oldStore, staleWorkId, { phase: 'verification', status: 'blocked', state: 'satisfied', summary: 'Implementation accepted.' });
    transitionWorkContractPhase(oldStore, staleWorkId, { phase: 'delivery', status: 'blocked', state: 'satisfied', summary: 'Verification accepted.' });
    transitionWorkContractPhase(oldStore, staleWorkId, { phase: 'cleanup', status: 'blocked', summary: 'Only cleanup remains.' });

    const repaired = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-exact-repair', 'transport-exact-repair', 'runtime-exact-repair'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'repair', work_id: targetWorkId, repair_operation: 'repair', dry_run: false, min_age_minutes: 1 },
    ));
    expect(repaired.data?.actionId).not.toBe('full_maintenance_pass');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, staleWorkId)?.status).toBe('blocked');
    expect(existsSync(stale.root!)).toBe(true);
  }, 20_000);

  test('WORK_CHECKOUT_MISMATCH reports both resolved and expected Work checkout identities', () => {
    const fx = fixture();
    const workId = 'work-checkout-mismatch-diagnostic';
    const expectedCheckoutId = 'checkout-work-expected';
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: expectedCheckoutId,
      mode: 'goal_workloop',
      objective: 'Preserve exact Work checkout attribution.',
      acceptanceCriteria: ['Mismatch diagnostics identify the retry target.'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running', phase: 'implementation',
    });
    claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-checkout-mismatch',
      controllerType: 'chatgpt',
      sessionId: 'transport-checkout-mismatch',
      principalId: 'principal-checkout-mismatch',
      controllerInstanceId: 'runtime-checkout-mismatch',
      leaseMs: 60_000,
    });

    expect(() => resolveExplicitClaimedRepositoryWork(
      fx.controllerHome,
      { repoId: fx.repository.repoId, activeCheckoutId: fx.repository.activeCheckoutId },
      { principalId: 'principal-checkout-mismatch', sessionId: 'transport-checkout-mismatch', controllerInstanceId: 'runtime-checkout-mismatch' },
      workId,
    )).toThrow(`resolved_checkout=${fx.repository.activeCheckoutId}; expected_work_checkout=${expectedCheckoutId}; retry with checkout_id=${expectedCheckoutId}`);
  });

});
