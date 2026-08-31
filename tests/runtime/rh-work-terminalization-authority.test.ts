import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { getRepository, reconcileRepositoryCheckouts, registerRepository, selectRepositoryCheckout, setRepositoryCheckoutLifecycle } from '../../src/cli/repositories/registry';
import { createWorkContract, getWorkContract, recordWorkCompletionReceipt, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { approvePlanContract, claimPlanStepForWork, completePlanStepForWork, createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { claimControllerSession, getControllerSession, releaseObservedControllerSession, resumeControllerSession, withControllerSessionTerminalizationFence } from '../../src/runtime/control-plane/facade/controller-session-store';
import { acknowledgeControllerRoundClaim, beginInitialControllerRoundDispatch, finishControllerRoundRelayDispatch } from '../../src/runtime/control-plane/facade/controller-round-relay';
import { ensureRepositoryWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-authority';
import { readWorkHandle, writeWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { resolveExplicitClaimedRepositoryWork } from '../../src/runtime/control-plane/execution/repository-work-attribution';
import { releasePreparedWorkOwnership } from '../../src/runtime/gateway/mcp/execution-tools';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { invalidateExecutionSession } from '../../src/runtime/control-plane/execution/session-store';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureManagedWorkspace } from '../../src/runtime/execution/managed-workspace';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
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
        controllerId: 'schedule:frozen-round',
        principalId: 'forge-scheduler',
        controllerInstanceId: runtimeInstanceId,
        sessionId: 'occurrence-frozen-round',
      },
    });
    expect(relay.authorityId).toBeTruthy();
    finishControllerRoundRelayDispatch(store, {
      workId,
      ok: true,
      browserSessionId: 'forge-chatgpt-bridge-frozen-round',
      conversationUrl: 'https://chatgpt.com/c/frozen-round',
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

  test('authenticated principal may use explicit opaque session when transport session is absent', async () => {
    const fx = fixture();
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

    const claimA = structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workA, session_id: 'opaque-a' },
    ));
    expect(claimA.status).toBe('ok');
    expect(getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workA)?.sessionId).toBe('opaque-a');

    const claimB = structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workB, session_id: 'opaque-b' },
    ));
    expect(claimB.status).toBe('ok');

    const foreignStop = structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workB, requested_by: 'chatgpt', reason: 'foreign explicit session', session_id: 'opaque-a' },
    ));
    expect(foreignStop.status).toBe('blocked');
    expect(foreignStop.summary).toContain('WORK_CONTROLLER_SCOPE_MISMATCH');

    const ownStop = structured(await callRuntimeTool(
      withoutTransport(),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workB, requested_by: 'chatgpt', reason: 'own explicit session', session_id: 'opaque-b' },
    ));
    expect(ownStop.status).toBe('ok');
  }, 15_000);

  test('terminalization requires an explicit exact-Work claim after transport rotation', async () => {
    const fx = fixture();
    const workId = 'work-claim-before-stale-stop';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const owner = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-a',
      controllerType: 'chatgpt',
      sessionId: 'transport-claimed',
      principalId: 'principal-a',
      controllerInstanceId: 'runtime-new',
      leaseMs: 60_000,
    });
    expect(owner.claimGeneration).toBe(1);

    const stale = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-stale', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'system', reason: 'launcher had not reached a new Controller claim' },
    ));
    expect(stale.status).toBe('blocked');
    expect(stale.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');

    const staleFinalize = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-stale-finalize', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt' },
    ));
    expect(staleFinalize.status).toBe('blocked');
    expect(staleFinalize.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');

    const rotatedWithoutClaim = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-rotated', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'chatgpt', reason: 'current owner semantic disposition' },
    ));
    expect(rotatedWithoutClaim.status).toBe('blocked');
    expect(rotatedWithoutClaim.summary).toContain('WORK_CONTROLLER_SCOPE_MISMATCH');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');

    const claimed = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-rotated', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workId },
    ));
    expect(claimed.status).toBe('ok');
    expect(getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.sessionId).toBe('transport-rotated');

    const current = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-rotated', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'chatgpt', reason: 'current owner semantic disposition' },
    ));
    expect(current.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('cancelled');
  }, 15_000);

  test('two same-principal controller scopes cannot terminally mutate each other', async () => {
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

    const foreignStop = structured(await callRuntimeTool(scopeA, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'stop', work_id: workB, requested_by: 'user', reason: 'foreign conversation directive',
    }));
    expect(foreignStop.status).toBe('blocked');
    expect(foreignStop.summary).toContain('WORK_CONTROLLER_SCOPE_MISMATCH');

    const foreignFinalize = structured(await callRuntimeTool(scopeA, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'finalize', work_id: workB, requested_by: 'chatgpt',
    }));
    expect(foreignFinalize.status).toBe('blocked');
    expect(foreignFinalize.summary).toContain('WORK_CONTROLLER_SCOPE_MISMATCH');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workA)?.status).toBe('ready');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workB)?.status).toBe('ready');

    const ownStopB = structured(await callRuntimeTool(scopeB, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'stop', work_id: workB, requested_by: 'user', reason: 'own conversation directive',
    }));
    expect(ownStopB.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workB)?.status).toBe('cancelled');

    const foreignStopA = structured(await callRuntimeTool(scopeB, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'stop', work_id: workA, requested_by: 'user', reason: 'foreign conversation directive',
    }));
    expect(foreignStopA.status).toBe('blocked');
    expect(foreignStopA.summary).toContain('WORK_CONTROLLER_SCOPE_MISMATCH');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workA)?.status).toBe('ready');

    const ownStopA = structured(await callRuntimeTool(scopeA, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'stop', work_id: workA, requested_by: 'user', reason: 'own conversation directive',
    }));
    expect(ownStopA.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workA)?.status).toBe('cancelled');
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
      const relay = beginInitialControllerRoundDispatch(store, {
        workId,
        identity: {
          controllerId: principalId,
          principalId,
          controllerInstanceId: runtimeInstanceId,
          sessionId: `launcher-${suffix}`,
        },
        relayScopeId: `goal:${workId}`,
        browserSessionId: `browser-${suffix}`,
        conversationUrl: `https://chatgpt.com/c/conversation-${suffix}`,
      });
      expect(relay.authorityId).toBeTruthy();
      finishControllerRoundRelayDispatch(store, {
        workId,
        ok: true,
        browserSessionId: `browser-${suffix}`,
        conversationUrl: `https://chatgpt.com/c/conversation-${suffix}`,
      });
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


  test('isolated WorkHandle preserves canonical source identity and adopts an unscoped clean descendant before finalization', async () => {
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

    writeFileSync(join(workspace.root!, 'src', 'index.ts'), 'export const ready = \"isolated-unscoped-delivery\";\n');
    execFileSync('git', ['add', 'src/index.ts'], { cwd: workspace.root! });
    execFileSync('git', ['commit', '-m', 'isolated unscoped delivery'], { cwd: workspace.root! });
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.root!, encoding: 'utf8' }).trim();
    expect(candidate).not.toBe(handle?.expectedHead);
    expect(readWorkHandle(fx.controllerHome, canonicalRepository.repoId, workId)?.expectedHead).toBe(workspace.baseRevision ?? undefined);

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
    execFileSync('git', ['add', 'src/index.ts'], { cwd: workspace.root! });
    execFileSync('git', ['commit', '-m', 'source repair from effect work'], { cwd: workspace.root! });
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.root!, encoding: 'utf8' }).trim();
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
