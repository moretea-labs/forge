import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  continueGoalWorkloop,
  finalizeGoalWorkloop,
  routeWorkStart,
  startGoalWorkloop,
  stopGoalWorkloop,
  verifyGoalWorkloop,
} from '../../src/runtime/control-plane/facade/goal-workloop';
import { appendWorkEvidence, getWorkContract, listWorkContracts, reconcileStaleWorkContracts, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { approvePlanContract, createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-goal-workloop-'));
  roots.push(root);
  const workRoot = join(root, 'work');
  const handoffRoot = join(root, 'handoff');
  let tick = 0;
  const now = () => `2026-07-09T01:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`;
  return {
    ctx: {
      workStore: { root: workRoot, now },
      handoffStore: { root: handoffRoot, now },
      repoId: 'repo_test',
      availableChecks: [{ id: 'package:check:type' }, { id: 'package:test' }],
      now,
    },
  };
}

describe('goal workloop engine', () => {
  test('small tasks select direct_control and do not create WorkContract', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: 'Fix typo in README',
      checks: ['typecheck'],
      modeInput: {
        scopeClear: true,
        expectedFiles: 1,
        expectedChangedLines: 5,
      },
    });

    expect(result.data).toMatchObject({
      workContractCreated: false,
      directControlPreserved: true,
    });
    expect((result.data as { mode: { mode: string } }).mode.mode).toBe('direct_control');
    expect(listWorkContracts({ ...ctx.workStore, status: 'all' })).toEqual([]);
    expect(result.suggestedNextActions.some((action) => action.tool === 'rh_work')).toBe(true);
  });

  test('long tasks select goal_workloop and create WorkContract', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: 'Refactor control plane facade routing and recovery',
      acceptanceCriteria: ['typecheck passes', 'targeted tests pass'],
      checks: ['typecheck', 'package:test'],
      allowedPaths: ['src/runtime/control-plane/facade/**'],
      modeInput: {
        scopeClear: true,
        expectedFiles: 10,
        expectedChangedLines: 500,
        requiresLongRunningChecks: true,
      },
    });

    expect(result.status).toBe('ok');
    expect((result.data as { workContractCreated: boolean }).workContractCreated).toBe(true);
    const contracts = listWorkContracts({ ...ctx.workStore, status: 'all' });
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      mode: 'goal_workloop',
      status: 'running',
      repoId: 'repo_test',
    });
    expect(contracts[0]!.checks).toContain('package:check:type');
    expect(contracts[0]!.evidenceRefs.length).toBeGreaterThan(0);
    expect(contracts[0]!.worktreePolicy.required).toBe(false);
    expect(contracts[0]!.driver).toEqual({
      preferred: 'direct_edit',
      allowWorker: false,
      allowDirectEdit: true,
    });
  });

  test('agent workers are opt-in and enabled only by an explicit worker request', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: 'Use Codex to implement the requested refactor',
      acceptanceCriteria: ['targeted tests pass'],
      modeInput: {
        scopeClear: true,
        expectedFiles: 6,
        expectedChangedLines: 300,
        requiresWorker: true,
      },
    });

    expect(result.status).toBe('ok');
    const [contract] = listWorkContracts({ ...ctx.workStore, status: 'all' });
    expect(contract?.driver).toEqual({
      preferred: 'external_controller',
      allowWorker: false,
      allowDirectEdit: false,
    });
  });

  test('runtime complex work requires an approved matching Plan step and completes that step with Work evidence', () => {
    const { ctx } = fixture();
    const planStore = { root: join((ctx.workStore as { root: string }).root, '..', 'plans'), now: ctx.now };
    const plan = createPlanContract(planStore, {
      planId: 'plan-bound-work',
      repoId: ctx.repoId,
      scopeKey: 'facade-goal-workloop',
      sourceRevision: 'head-1',
      goal: 'Bind a complex workloop to an approved plan.',
      steps: [{
        id: 'implement', objective: 'Implement the bounded change.', dependencies: [],
        authoritativeFiles: ['src/runtime/control-plane/facade/goal-workloop.ts'],
        allowedPaths: ['src/runtime/control-plane/facade/'], forbiddenPaths: [],
        checks: ['package:check:type'], acceptanceCriteria: ['The contract is bound to this plan step.'],
      }],
    });
    approvePlanContract(planStore, plan.planId);
    const guardedCtx = { ...ctx, planStore, sourceRevision: 'head-1', requirePlanForGoalWorkloop: true };

    const missing = routeWorkStart(guardedCtx, {
      objective: 'Complex work without a plan',
      modeInput: { scopeClear: true, expectedFiles: 8, expectedChangedLines: 300 },
    });
    expect(missing.status).toBe('blocked');

    const started = routeWorkStart(guardedCtx, {
      objective: 'Complex work with a plan', planId: plan.planId, planStepId: 'implement',
      checks: ['package:check:type'],
      modeInput: { scopeClear: true, expectedFiles: 8, expectedChangedLines: 300 },
    });
    expect(started.status).toBe('ok');
    const workId = (started.data as { work: { workId: string } }).work.workId;
    expect(getWorkContract(ctx.workStore, workId)).toMatchObject({ planId: plan.planId, planStepId: 'implement', planSourceRevision: 'head-1' });
    expect(getPlanContract(planStore, plan.planId)?.steps[0]).toMatchObject({ status: 'executing', workId });

    verifyGoalWorkloop(guardedCtx, { workId, checkId: 'package:check:type' });
    finalizeGoalWorkloop(guardedCtx, { workId });
    expect(getPlanContract(planStore, plan.planId)?.steps[0]).toMatchObject({ status: 'completed', workId });
  });

  test('source drift invalidates the plan and creates no WorkContract', () => {
    const { ctx } = fixture();
    const planStore = { root: join((ctx.workStore as { root: string }).root, '..', 'plans-drift'), now: ctx.now };
    const plan = createPlanContract(planStore, {
      planId: 'plan-drift', repoId: ctx.repoId, scopeKey: 'facade-drift', sourceRevision: 'old-head', goal: 'Reject stale work.',
      steps: [{ id: 'implement', objective: 'Implement.', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['package:test'], acceptanceCriteria: ['No stale work starts.'] }],
    });
    approvePlanContract(planStore, plan.planId);
    const result = routeWorkStart({ ...ctx, planStore, sourceRevision: 'new-head', requirePlanForGoalWorkloop: true }, {
      objective: 'Stale complex work', planId: plan.planId, planStepId: 'implement',
      modeInput: { scopeClear: true, expectedFiles: 8, expectedChangedLines: 300 },
    });
    expect(result.status).toBe('blocked');
    expect(listWorkContracts({ ...ctx.workStore, status: 'all' })).toEqual([]);
    expect(getPlanContract(planStore, plan.planId)?.status).toBe('invalidated_by_drift');
  });

  test('high-risk missing-authorization tasks create handoff_only without WorkContract', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: 'Force push main and rotate secrets',
      modeInput: {
        scopeClear: true,
        destructive: true,
        secretAccess: true,
        requiresApproval: true,
        requiresUserApproval: true,
      },
    });

    expect((result.data as { workContractCreated: boolean }).workContractCreated).toBe(false);
    expect((result.data as { mode: { mode: string } }).mode.mode).toBe('handoff_only');
    expect(listWorkContracts({ ...ctx.workStore, status: 'all' })).toEqual([]);
    expect(listHandoffItems({ ...ctx.handoffStore, status: 'pending' }).length).toBe(1);
    expect(result.status === 'blocked' || result.status === 'approval_required').toBe(true);
  });

  test('underspecified objective creates handoff and does not continue execution', () => {
    const { ctx } = fixture();
    const result = routeWorkStart(ctx, {
      objective: '',
      modeInput: {
        scopeClear: false,
      },
    });
    expect((result.data as { mode: { mode: string } }).mode.mode).toBe('handoff_only');
    expect(listWorkContracts({ ...ctx.workStore, status: 'all' })).toEqual([]);
    expect(listHandoffItems(ctx.handoffStore).length).toBe(1);
  });

  test('verify invalid check id is not acceptance failure; valid pass can supersede', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Implement workloop verify path',
      checks: ['package:check:type'],
      modeInput: { scopeClear: true, expectedFiles: 8, expectedChangedLines: 300 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;

    const invalid = verifyGoalWorkloop(ctx, { workId, checkId: 'docs' });
    expect(invalid.status).toBe('ok');
    expect((invalid.data as { verification: { outcome: string; isAcceptanceFailure: boolean } }).verification).toMatchObject({
      outcome: 'invalid_check_id',
      isAcceptanceFailure: false,
    });

    const infra = verifyGoalWorkloop(ctx, {
      workId,
      checkId: 'package:check:type',
      infrastructureFailed: true,
    });
    expect((infra.data as { verification: { outcome: string; isAcceptanceFailure: boolean } }).verification).toMatchObject({
      outcome: 'infrastructure_failure',
      isAcceptanceFailure: false,
    });

    const pass = verifyGoalWorkloop(ctx, { workId, checkId: 'typecheck' });
    expect((pass.data as { verification: { outcome: string } }).verification.outcome).toBe('valid_pass');

    const work = getWorkContract(ctx.workStore, workId)!;
    expect(work.checkRefs.some((record) => record.outcome === 'superseded')).toBe(true);
    expect(work.checkRefs.some((record) => record.outcome === 'valid_pass')).toBe(true);
    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('blocked');
    expect((finalized.data as { invalidCheckIds: string[] }).invalidCheckIds).toEqual(['docs']);
  });

  test('continue after acceptance failure creates handoff and does not pretend background completion', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Failing path review',
      checks: ['package:test'],
      modeInput: { scopeClear: true, expectedFiles: 6, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    verifyGoalWorkloop(ctx, { workId, checkId: 'package:test', checkFailed: true });
    const cont = continueGoalWorkloop(ctx, { workId });
    expect(cont.status).toBe('blocked');
    expect((cont.data as { backgroundCompleted: boolean }).backgroundCompleted).toBe(false);
    const handoffs = listHandoffItems(ctx.handoffStore);
    expect(handoffs.length).toBe(1);
    expect(handoffs[0]?.currentState).toMatchObject({
      workSemantics: { status: 'running', dispatchState: 'running', evidenceState: 'none' },
      reconciliationRequired: false,
      nextSafeAction: expect.any(String),
    });
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('ready');
  });

  test('finalize succeeds when checks pass; stop retains evidence', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Happy path finalize',
      checks: ['package:check:type'],
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 220 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    verifyGoalWorkloop(ctx, { workId, checkId: 'package:check:type' });
    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect((finalized.data as { finalStatus: string }).finalStatus).toBe('completed');
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('completed');

    const started2 = startGoalWorkloop(ctx, {
      objective: 'Stop path',
      checks: ['package:test'],
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 220 },
    });
    const workId2 = (started2.data as { work: { workId: string } }).work.workId;
    const stopped = stopGoalWorkloop(ctx, { workId: workId2, reason: 'user cancelled' });
    expect((stopped.data as { finalStatus: string; evidenceRetained: boolean }).finalStatus).toBe('cancelled');
    expect((stopped.data as { evidenceRetained: boolean }).evidenceRetained).toBe(true);
    expect((stopped.data as { worktreeDeleted: boolean }).worktreeDeleted).toBe(false);
    expect(getWorkContract(ctx.workStore, workId2)?.evidenceRefs.length).toBeGreaterThan(0);
  });
  test('work contract alone cannot continue or finalize as successful execution', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Create orchestration state only',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;

    const continued = continueGoalWorkloop(ctx, { workId });
    expect(continued.status).toBe('blocked');
    expect((continued.data as { executionEvidencePresent: boolean }).executionEvidencePresent).toBe(false);

    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('blocked');
    expect((finalized.data as { finalStatus: string }).finalStatus).toBe('ready');
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('ready');
  });

  test('generic delegate evidence without a patch, worker, worktree, or check cannot unlock success', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Delegate investigation without implementation output',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    appendWorkEvidence(ctx.workStore, workId, {
      title: 'codex worker evidence',
      summary: 'Codex produced bounded output but no patch proposal.',
      detailLevel: 'summary',
    });

    const continued = continueGoalWorkloop(ctx, { workId });
    expect(continued.status).toBe('blocked');
    expect((continued.data as { executionEvidencePresent: boolean }).executionEvidencePresent).toBe(false);

    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('blocked');
    expect((finalized.data as { finalStatus: string }).finalStatus).toBe('ready');
  });

  test('workerRef and worktreeRef alone cannot unlock completion', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Weak reference only',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    updateWorkContract(ctx.workStore, workId, {
      workerRef: 'codex:proposal-only',
      worktreeRef: '/tmp/proposal-worktree',
    });

    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('blocked');
    expect((finalized.data as { finalStatus: string }).finalStatus).toBe('ready');
    expect((finalized.data as { ignoredWeakReferences: { workerRef: boolean; worktreeRef: boolean } }).ignoredWeakReferences).toEqual({
      workerRef: true,
      worktreeRef: true,
    });
  });

  test('blank invalid check compatibility noise does not block declared valid passes', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Recover from a compatibility verify request with no check id',
      checks: ['package:check:type'],
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;

    const invalid = verifyGoalWorkloop(ctx, { workId, checkId: '' });
    expect((invalid.data as { verification: { outcome: string } }).verification.outcome).toBe('invalid_check_id');
    verifyGoalWorkloop(ctx, { workId, checkId: 'package:check:type' });

    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('ok');
    expect((finalized.data as { finalStatus: string; invalidCheckIds: string[] }).finalStatus).toBe('completed');
  });

  test('partial declared check success cannot finalize', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Partial checks',
      checks: ['package:check:type', 'package:test'],
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    verifyGoalWorkloop(ctx, { workId, checkId: 'package:check:type' });

    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('blocked');
    expect((finalized.data as { missingChecks: string[] }).missingChecks).toEqual(['package:test']);
  });

  test('no-check result work requires durable artifact evidence', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Durable read-only result',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250, requiresInvestigation: true },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    appendWorkEvidence(ctx.workStore, workId, {
      artifactId: 'ART-investigation-result',
      title: 'investigation result',
      summary: 'Bounded investigation conclusion persisted as an artifact.',
      detailLevel: 'summary',
    });

    const finalized = finalizeGoalWorkloop(ctx, { workId });
    expect(finalized.status).toBe('ok');
    expect((finalized.data as { finalStatus: string }).finalStatus).toBe('completed');
  });

  test('successful completion preserves access and approval snapshots', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Preserve authorization boundaries',
      checks: ['package:check:type'],
      constraints: {
        accessMode: 'request',
        allowDestructive: false,
        allowMerge: false,
      },
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    const before = getWorkContract(ctx.workStore, workId)!;
    verifyGoalWorkloop(ctx, { workId, checkId: 'package:check:type' });
    const finalized = finalizeGoalWorkloop(ctx, { workId });
    const after = getWorkContract(ctx.workStore, workId)!;

    expect(finalized.status).toBe('ok');
    expect(after.constraints.accessMode).toBe('request');
    expect(after.constraints.allowDestructive).toBe(false);
    expect(after.constraints.allowMerge).toBe(false);
    expect(after.approvalPolicy).toEqual(before.approvalPolicy);
  });

  test('reconciles stale running work only when no execution owner remains', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Stale recoverable work',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;

    const owned = reconcileStaleWorkContracts(ctx.workStore, {
      activeExecutionJobs: 1,
      activeLocalJobs: 0,
      activeLeases: 0,
      staleAfterMs: 60_000,
      now: '2026-07-09T03:00:00.000Z',
    });
    expect(owned.reconciled).toBe(0);
    expect(owned.skippedForActiveOwnership).toBe(true);
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('running');

    const reconciled = reconcileStaleWorkContracts(ctx.workStore, {
      activeExecutionJobs: 0,
      activeLocalJobs: 0,
      activeLeases: 0,
      staleAfterMs: 60_000,
      now: '2026-07-09T03:00:00.000Z',
    });
    expect(reconciled.workIds).toEqual([workId]);
    expect(reconciled.paused).toBe(1);
    expect(reconciled.cancelled).toBe(0);
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('blocked');
    expect(getWorkContract(ctx.workStore, workId)?.evidenceRefs[0]?.title).toBe('runtime reconciliation required');
  });

  test('cancels a previously reconciled orphan only after its checkout is unavailable', () => {
    const { ctx } = fixture();
    const started = startGoalWorkloop(ctx, {
      objective: 'Orphaned isolated work',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const workId = (started.data as { work: { workId: string } }).work.workId;
    updateWorkContract(ctx.workStore, workId, { worktreeRef: '/tmp/archived-worktree' });

    reconcileStaleWorkContracts(ctx.workStore, {
      activeExecutionJobs: 0,
      activeLocalJobs: 0,
      activeLeases: 0,
      staleAfterMs: 60_000,
      now: '2026-07-09T03:00:00.000Z',
      worktreeAvailability: () => 'inactive',
    });
    const cancelled = reconcileStaleWorkContracts(ctx.workStore, {
      activeExecutionJobs: 0,
      activeLocalJobs: 0,
      activeLeases: 0,
      staleAfterMs: 60_000,
      now: '2026-07-09T05:00:00.000Z',
      worktreeAvailability: () => 'inactive',
    });

    expect(cancelled.cancelled).toBe(1);
    expect(cancelled.paused).toBe(0);
    expect(getWorkContract(ctx.workStore, workId)?.status).toBe('cancelled');
    expect(getWorkContract(ctx.workStore, workId)?.evidenceRefs[0]?.title)
      .toBe('runtime reconciliation cancelled orphaned work');
  });

  test('keeps reconciled work reviewable when durable output exists or checkout remains active', () => {
    const { ctx } = fixture();
    const artifactWork = startGoalWorkloop(ctx, {
      objective: 'Reviewable artifact work',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const artifactWorkId = (artifactWork.data as { work: { workId: string } }).work.workId;
    updateWorkContract(ctx.workStore, artifactWorkId, { worktreeRef: '/tmp/missing-artifact-worktree' });
    appendWorkEvidence(ctx.workStore, artifactWorkId, {
      artifactId: 'ART-reviewable-output',
      title: 'implementation result',
      summary: 'Durable result still requires review.',
    });

    const activeWork = startGoalWorkloop(ctx, {
      objective: 'Active checkout work',
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const activeWorkId = (activeWork.data as { work: { workId: string } }).work.workId;
    updateWorkContract(ctx.workStore, activeWorkId, { worktreeRef: '/tmp/active-worktree' });

    reconcileStaleWorkContracts(ctx.workStore, {
      activeExecutionJobs: 0,
      activeLocalJobs: 0,
      activeLeases: 0,
      staleAfterMs: 60_000,
      now: '2026-07-09T03:00:00.000Z',
      worktreeAvailability: (ref) => ref.includes('active') ? 'active' : 'missing',
    });
    const retained = reconcileStaleWorkContracts(ctx.workStore, {
      activeExecutionJobs: 0,
      activeLocalJobs: 0,
      activeLeases: 0,
      staleAfterMs: 60_000,
      now: '2026-07-09T05:00:00.000Z',
      worktreeAvailability: (ref) => ref.includes('active') ? 'active' : 'missing',
    });

    expect(retained.cancelled).toBe(0);
    expect(getWorkContract(ctx.workStore, artifactWorkId)?.status).toBe('blocked');
    expect(getWorkContract(ctx.workStore, activeWorkId)?.status).toBe('blocked');
  });

  test('isolated worktree is opt-in or selected only for parallel work', () => {
    const { ctx } = fixture();
    const isolated = startGoalWorkloop(ctx, {
      objective: 'Explicit isolated task',
      constraints: { workspaceMode: 'isolated' },
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250 },
    });
    const isolatedId = (isolated.data as { work: { workId: string } }).work.workId;
    expect(getWorkContract(ctx.workStore, isolatedId)?.worktreePolicy.required).toBe(true);

    const parallel = startGoalWorkloop(ctx, {
      objective: 'Parallel task',
      constraints: { workspaceMode: 'auto' },
      modeInput: { scopeClear: true, expectedFiles: 5, expectedChangedLines: 250, requiresParallelism: true },
    });
    const parallelId = (parallel.data as { work: { workId: string } }).work.workId;
    expect(getWorkContract(ctx.workStore, parallelId)?.worktreePolicy.required).toBe(true);
  });

});
