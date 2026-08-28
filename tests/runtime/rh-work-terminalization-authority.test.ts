import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract, getWorkContract, recordWorkCompletionReceipt, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { approvePlanContract, claimPlanStepForWork, completePlanStepForWork, createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { claimControllerSession, getControllerSession, resumeControllerSession, withControllerSessionTerminalizationFence } from '../../src/runtime/control-plane/facade/controller-session-store';
import { releasePreparedWorkOwnership } from '../../src/runtime/gateway/mcp/execution-tools';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

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
  test('claim-before-stale-stop is rejected while the current owner may stop across transport rotation', async () => {
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

    const current = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-rotated', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'chatgpt', reason: 'current owner semantic disposition' },
    ));
    expect(current.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('cancelled');
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

  test('claim generation is fenced atomically and explicit unclaimed user stop remains valid', async () => {
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
    const explicit = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-user', 'transport-user', 'runtime-user'),
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

});
