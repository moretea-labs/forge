import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acceptPlanStepEvidence,
  admitPlanContract,
  approvePlanContract,
  claimPlanStepForWork,
  completePlanStepForWork,
  createPlanContract,
  getPlanContract,
  listUnresolvedPlanObligations,
  repairDraftPlanContract,
  retireTerminalPlanBoundWorkAuthorities,
  type CreatePlanContractInput,
  type PlanContractStoreOptions,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import type { PlanContract, PlanObligationDisposition } from '../../src/runtime/control-plane/facade/types';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  createWorkContract,
  getWorkContract,
  implementationReviewChangedPathDigest,
  listWorkContracts,
  recordWorkCompletionReceipt,
  recordWorkImplementationReview,
  requestWorkImplementationReview,
  transitionWorkContractPhase,
  type WorkContract,
} from '../../packages/kernel/work/api/index';

const roots: string[] = [];
function store(): PlanContractStoreOptions {
  const root = mkdtempSync(join(tmpdir(), 'forge-plan-obligation-'));
  roots.push(root);
  return { root };
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function input(planId: string): CreatePlanContractInput {
  return {
    planId,
    repoId: 'repo-a',
    requirementId: 'REQ-A',
    scopeKey: 'kernel-v2',
    sourceRevision: 'revision-a',
    goal: `${planId} preserves the intended V2 outcome.`,
    nonGoals: ['Do not create a second semantic authority.'],
    assumptions: ['The predecessor source identity is still valid.'],
    resolvedDecisions: ['Runtime mutable state belongs to Controller Home.'],
    stopConditions: ['Stop if a second writer appears.'],
    replanConditions: ['Replan when authority assumptions materially change.'],
    integrationStrategy: 'Preserve authority while replacing the plan contract.',
    steps: [{
      id: 'stage-a',
      objective: 'Converge one bounded architecture slice.',
      dependencies: [],
      authoritativeFiles: ['src/runtime/example.ts'],
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: ['package:check:type'],
      acceptanceCriteria: ['The architecture slice keeps one writer.', 'Lifecycle cleanup remains explicit.'],
    }],
  };
}

function successorDispositions(predecessor: ReturnType<typeof createPlanContract>): PlanObligationDisposition[] {
  return listUnresolvedPlanObligations(predecessor).map((obligation) => ({
    predecessorPlanId: predecessor.planId,
    obligationId: obligation.obligationId,
    disposition: 'keep' as const,
    successorRefs: ['goal'],
  }));
}

function changedAcceptanceSuccessor(predecessor: ReturnType<typeof createPlanContract>, planId: string, sourceRevision = 'revision-b') {
  const successor = input(planId);
  successor.sourceRevision = sourceRevision;
  successor.steps[0]!.acceptanceCriteria = ['The architecture slice keeps one writer.', 'Lifecycle inventory remains explicit.'];
  const dispositions = listUnresolvedPlanObligations(predecessor).map((obligation): PlanObligationDisposition => {
    if (obligation.sourceRef === 'step:stage-a:acceptance:1') {
      return {
        predecessorPlanId: predecessor.planId,
        obligationId: obligation.obligationId,
        disposition: 'change',
        successorRefs: ['step:stage-a:acceptance:1'],
        rationale: 'Narrow the semantic criterion without changing the delivered execution contract.',
      };
    }
    return {
      predecessorPlanId: predecessor.planId,
      obligationId: obligation.obligationId,
      disposition: 'keep',
      successorRefs: [obligation.sourceRef],
    };
  });
  return { successor, dispositions };
}

function deliveredValidatingPredecessor(options: { controllerHome: string; repoId: string }, planId = 'PLAN-R1', deliveredRevision = 'revision-b') {
  createRequirement({ controllerHome: options.controllerHome }, {
    requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Reuse exact delivery without replaying Work.',
  });
  const predecessor = createPlanContract(options, input(planId));
  approvePlanContract(options, predecessor.planId);
  const workId = `WORK-${planId}`;
  createWorkContract(options, {
    workId, repoId: options.repoId, requirementId: 'REQ-A', planId: predecessor.planId, planStepId: 'stage-a', planSourceRevision: predecessor.sourceRevision,
    baseRevision: predecessor.sourceRevision, mode: 'goal_workloop', workKind: 'repository_change', objective: predecessor.steps[0]!.objective,
    acceptanceCriteria: predecessor.steps[0]!.acceptanceCriteria, allowedPaths: predecessor.steps[0]!.allowedPaths,
    forbiddenPaths: predecessor.steps[0]!.forbiddenPaths, checks: predecessor.steps[0]!.checks,
    constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
  });
  claimPlanStepForWork(options, { planId: predecessor.planId, stepId: 'stage-a', workId, sourceRevision: predecessor.sourceRevision });
  transitionWorkContractPhase(options, workId, {
    status: 'running', phase: 'verification', state: 'satisfied', summary: 'Exact successor-carry fixture verified before implementation review.',
  });
  requestWorkImplementationReview(options, workId, 'Exact repository-change fixture requires Controller implementation review.');
  recordWorkImplementationReview(options, workId, {
    schemaVersion: 1, reviewId: `REV-${workId}`, workId, reviewerPrincipalId: 'chatgpt-principal', reviewerControllerSessionId: 'mcp-test',
    decision: 'approved', rationale: 'The exact delivered repository-change fixture is approved for successor carry testing.', findings: [],
    sourceRevision: deliveredRevision, workspaceFingerprint: `workspace-${workId}`, verificationWorkspaceFingerprint: `verification-${workId}`,
    changedPaths: ['src/runtime/fixture.ts'], changedPathDigest: implementationReviewChangedPathDigest(['src/runtime/fixture.ts']),
    acceptanceCriteriaSummary: 'Plan successor may reuse only this exact delivered Work.', verificationEvidence: [], architectureEvidence: [],
    recordedAt: '2026-09-05T00:00:00.000Z',
  });
  const completed = recordWorkCompletionReceipt(options, workId, {
    schemaVersion: 1, receiptId: `REC-${workId}`, source: 'controller_work', issueId: 'work', taskId: workId, workId,
    targetBranch: 'main', targetRevision: deliveredRevision, sourceRevision: deliveredRevision, baseRevision: predecessor.sourceRevision, changedPaths: ['src/runtime/fixture.ts'],
    delivery: { kind: 'commit', status: 'integrated', strategy: 'already_integrated', reachable: true, recordedAt: '2026-09-05T00:00:00.000Z' },
    cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt: '2026-09-05T00:00:00.000Z' },
    verifiedAt: '2026-09-05T00:00:00.000Z', recordedAt: '2026-09-05T00:00:00.000Z',
  }, 'completed_changed');
  const validating = completePlanStepForWork(options, { planId: predecessor.planId, stepId: 'stage-a', work: completed });
  return { predecessor: validating, workId };
}

function overwriteWork(options: { controllerHome: string; repoId: string }, workId: string, mutate: (work: WorkContract) => WorkContract): void {
  const stored = readControlPlaneRecord<WorkContract>(options.controllerHome, 'work_contract', options.repoId, workId)!;
  writeControlPlaneRecord(options.controllerHome, {
    namespace: 'work_contract', scope: options.repoId, key: workId, schemaVersion: 2,
    value: mutate(stored.value), action: 'test_corrupt_terminal_work', expectedRevision: stored.revision,
  });
}

describe('Plan obligation continuity', () => {
  test('draft revision fails closed when predecessor obligations are uncovered', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    expect(listUnresolvedPlanObligations(predecessor).length).toBeGreaterThan(0);

    expect(() => admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
    })).toThrow('PLAN_OBLIGATION_CONTINUITY_REQUIRED');

    expect(getPlanContract(options, predecessor.planId)).toMatchObject({ planId: 'PLAN-R1', revision: 1, status: 'draft' });
    expect(getPlanContract(options, 'PLAN-R2')).toBeUndefined();
  });

  test('explicit coverage revises a draft in place without creating Plan lineage', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    const dispositions = successorDispositions(predecessor);
    const admitted = admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    });

    expect(admitted.plan).toMatchObject({ planId: 'PLAN-R1', revision: 1, status: 'draft', goal: 'PLAN-R2 preserves the intended V2 outcome.' });
    expect(admitted.plan?.supersedes).toBeUndefined();
    expect(admitted.plan?.obligationDispositions?.length).toBe(listUnresolvedPlanObligations(predecessor).length);
    expect(getPlanContract(options, 'PLAN-R2')).toBeUndefined();
  });

  test('coverage cannot point at invented successor locations', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    const dispositions = successorDispositions(predecessor);
    dispositions[0] = { ...dispositions[0]!, successorRefs: ['step:not-real'] };

    expect(() => admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    })).toThrow('references unknown successor_ref');
  });

  test('semantic changes, deferrals, and drops require Controller rationale', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    const dispositions = successorDispositions(predecessor);
    dispositions[0] = {
      ...dispositions[0]!,
      disposition: 'change' as const,
      successorRefs: ['goal'],
    };

    expect(() => admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    })).toThrow('change requires rationale');
  });

  test('approved revision retires a bound Work only when its frozen execution contract changes', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-work-retirement-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Deliver the requirement through current Plan authority.',
    });
    const draft = createPlanContract(options, input('PLAN-R1'));
    const predecessor = approvePlanContract(options, draft.planId);
    const step = predecessor.steps[0]!;
    createWorkContract(options, {
      workId: 'WORK-R1', repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: step.id,
      planSourceRevision: predecessor.sourceRevision, baseRevision: predecessor.sourceRevision,
      mode: 'goal_workloop', objective: step.objective, acceptanceCriteria: step.acceptanceCriteria,
      allowedPaths: step.allowedPaths, forbiddenPaths: step.forbiddenPaths, checks: step.checks,
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const executing = claimPlanStepForWork(options, { planId: predecessor.planId, stepId: step.id, workId: 'WORK-R1', sourceRevision: predecessor.sourceRevision });
    const revision = input('PLAN-R2');
    revision.sourceRevision = 'revision-b';
    revision.steps[0]!.checks = ['package:check:main'];

    const staged = admitPlanContract(options, {
      ...revision, planRelation: 'extend', relatedPlanId: executing.planId,
      obligationDispositions: successorDispositions(executing),
    }).plan!;
    expect(staged).toMatchObject({ planId: executing.planId, revision: 1, status: 'replanning', pendingRevision: { revision: 2, requestedRevisionLabel: 'PLAN-R2' } });
    expect(getWorkContract(options, 'WORK-R1')).toMatchObject({ status: 'running', planId: executing.planId });

    const approved = approvePlanContract(options, staged.planId);
    expect(approved).toMatchObject({ planId: executing.planId, revision: 2, status: 'approved', steps: [{ status: 'ready' }] });
    expect(getWorkContract(options, 'WORK-R1')).toMatchObject({ status: 'cancelled', phase: 'implementation', dispatchState: 'terminal', planId: executing.planId, phaseEvidence: { implementation: { state: 'skipped' }, cleanup: { state: 'pending' } } });
    expect(listWorkContracts({ ...options, status: 'active', limit: 20 }).map((work) => work.workId)).not.toContain('WORK-R1');
    expect(listWorkContracts({ ...options, status: 'all', limit: 20 }).map((work) => work.workId)).toContain('WORK-R1');
    expect(getPlanContract(options, 'PLAN-R2')).toBeUndefined();
  });

  test('staged Plan revision preserves only the exact bound Work when the execution contract is unchanged', () => {
    for (const changed of [false, true]) {
      const controllerHome = mkdtempSync(join(tmpdir(), `forge-plan-active-carry-${changed ? 'changed' : 'same'}-`));
      roots.push(controllerHome);
      const options = { controllerHome, repoId: 'repo-a' };
      createRequirement({ controllerHome }, { requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Keep exact active Work through an approved Plan revision.' });
      const predecessorDraft = createPlanContract(options, input(`PLAN-R1-${changed}`));
      const predecessor = approvePlanContract(options, predecessorDraft.planId);
      const step = predecessor.steps[0]!;
      const workId = `WORK-ACTIVE-${changed}`;
      createWorkContract(options, {
        workId, repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: step.id, planSourceRevision: predecessor.sourceRevision,
        baseRevision: predecessor.sourceRevision, mode: 'goal_workloop', workKind: 'repository_change', objective: step.objective,
        acceptanceCriteria: step.acceptanceCriteria, allowedPaths: step.allowedPaths, forbiddenPaths: step.forbiddenPaths, checks: step.checks,
        constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
      });
      const executing = claimPlanStepForWork(options, { planId: predecessor.planId, stepId: step.id, workId, sourceRevision: predecessor.sourceRevision });
      const revision = input(`PLAN-R2-${changed}`);
      revision.sourceRevision = 'revision-c';
      if (changed) revision.steps[0]!.checks = ['package:check:main'];
      const admitted = admitPlanContract(options, { ...revision, planRelation: 'extend', relatedPlanId: executing.planId, obligationDispositions: successorDispositions(executing) }).plan!;
      expect(admitted).toMatchObject({ planId: executing.planId, revision: 1, status: 'replanning', pendingRevision: { revision: 2, sourceRevision: 'revision-c' } });
      expect(getPlanContract(options, revision.planId)).toBeUndefined();
      expect(getWorkContract(options, workId)).toMatchObject({ status: 'running', planId: executing.planId });
      const repaired = repairDraftPlanContract(options, admitted.planId, {
        ...revision,
        expectedSourceRevision: revision.sourceRevision,
        obligationDispositions: successorDispositions(executing),
      });
      expect(repaired).toMatchObject({ planId: executing.planId, status: 'replanning', pendingRevision: { revision: 2, sourceRevision: 'revision-c' } });
      const lateWorkId = !changed ? `WORK-LATE-${changed}` : undefined;
      if (lateWorkId) {
        createWorkContract(options, {
          workId: lateWorkId, repoId: 'repo-a', requirementId: 'REQ-A', planId: executing.planId, planStepId: step.id, planSourceRevision: executing.sourceRevision,
          baseRevision: executing.sourceRevision, mode: 'goal_workloop', workKind: 'repository_change', objective: step.objective,
          acceptanceCriteria: step.acceptanceCriteria, allowedPaths: step.allowedPaths, forbiddenPaths: step.forbiddenPaths, checks: step.checks,
          constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
        });
      }
      const approved = approvePlanContract(options, admitted.planId);
      expect(approved.planId).toBe(executing.planId);
      expect(approved.revision).toBe(2);
      if (changed) {
        expect(approved).toMatchObject({ status: 'approved', steps: [{ status: 'ready' }] });
        expect(getWorkContract(options, workId)).toMatchObject({ status: 'cancelled', phase: 'implementation', planId: executing.planId, phaseEvidence: { implementation: { state: 'skipped' }, cleanup: { state: 'pending' } } });
      } else {
        expect(approved).toMatchObject({ status: 'executing', steps: [{ status: 'executing', workId }] });
        expect(getWorkContract(options, workId)).toMatchObject({ status: 'running', planId: executing.planId, planStepId: step.id, planSourceRevision: 'revision-c' });
      }
      expect(listWorkContracts({ ...options, status: 'all', limit: 20 }).filter((work) => work.workId === workId)).toHaveLength(1);
      if (lateWorkId) expect(getWorkContract(options, lateWorkId)).toMatchObject({ status: 'cancelled', phase: 'implementation', planId: executing.planId, phaseEvidence: { implementation: { state: 'skipped' }, cleanup: { state: 'pending' } } });
    }
  });

  test('pending revision repair still rejects an unrelated nonterminal Plan that owns the same scope', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-draft-repair-unrelated-scope-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, { requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Keep one exact Plan scope authority.' });
    const predecessorDraft = createPlanContract(options, input('PLAN-R1-scope'));
    const predecessor = approvePlanContract(options, predecessorDraft.planId);
    const step = predecessor.steps[0]!;
    createWorkContract(options, {
      workId: 'WORK-SCOPE', repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: step.id, planSourceRevision: predecessor.sourceRevision,
      baseRevision: predecessor.sourceRevision, mode: 'goal_workloop', workKind: 'repository_change', objective: step.objective,
      acceptanceCriteria: step.acceptanceCriteria, allowedPaths: step.allowedPaths, forbiddenPaths: step.forbiddenPaths, checks: step.checks,
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const executing = claimPlanStepForWork(options, { planId: predecessor.planId, stepId: step.id, workId: 'WORK-SCOPE', sourceRevision: predecessor.sourceRevision });
    const revision = input('PLAN-R2-scope');
    revision.sourceRevision = 'revision-c';
    const dispositions = successorDispositions(executing);
    const admitted = admitPlanContract(options, {
      ...revision, planRelation: 'extend', relatedPlanId: executing.planId, obligationDispositions: dispositions,
    }).plan!;
    const unrelated = createPlanContract(options, { ...input('PLAN-OTHER-scope'), scopeKey: 'unrelated-scope', sourceRevision: 'revision-other' });
    const storedUnrelated = readControlPlaneRecord<PlanContract>(controllerHome, 'plan_contract', options.repoId, unrelated.planId)!;
    writeControlPlaneRecord(controllerHome, {
      namespace: 'plan_contract', scope: options.repoId, key: unrelated.planId, schemaVersion: 1,
      value: { ...storedUnrelated.value, scopeKey: revision.scopeKey },
      action: 'test_seed_historical_same_scope_conflict', expectedRevision: storedUnrelated.revision,
    });

    expect(() => repairDraftPlanContract(options, admitted.planId, {
      ...revision, expectedSourceRevision: revision.sourceRevision, obligationDispositions: dispositions,
    })).toThrow('PLAN_SCOPE_ALREADY_OWNED: kernel-v2:PLAN-OTHER-scope');
    expect(getPlanContract(options, admitted.planId)).toMatchObject({ planId: executing.planId, status: 'replanning', pendingRevision: { revision: 2 } });
  });

  test('pending revision repair validates obligation continuity before mutating the staged revision', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-draft-repair-continuity-first-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, { requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Never repair stale revision continuity into Plan state.' });
    const predecessorDraft = createPlanContract(options, input('PLAN-R1-continuity'));
    const predecessor = approvePlanContract(options, predecessorDraft.planId);
    const step = predecessor.steps[0]!;
    createWorkContract(options, {
      workId: 'WORK-CONTINUITY', repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: step.id, planSourceRevision: predecessor.sourceRevision,
      baseRevision: predecessor.sourceRevision, mode: 'goal_workloop', workKind: 'repository_change', objective: step.objective,
      acceptanceCriteria: step.acceptanceCriteria, allowedPaths: step.allowedPaths, forbiddenPaths: step.forbiddenPaths, checks: step.checks,
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const executing = claimPlanStepForWork(options, { planId: predecessor.planId, stepId: step.id, workId: 'WORK-CONTINUITY', sourceRevision: predecessor.sourceRevision });
    const revision = input('PLAN-R2-continuity');
    revision.sourceRevision = 'revision-c';
    const dispositions = successorDispositions(executing);
    const admitted = admitPlanContract(options, {
      ...revision, planRelation: 'extend', relatedPlanId: executing.planId, obligationDispositions: dispositions,
    }).plan!;
    const stale = dispositions.map((entry, index) => index === 0 ? { ...entry, obligationId: 'obl_stale_not_authoritative' } : entry);

    expect(() => repairDraftPlanContract(options, admitted.planId, {
      ...revision, expectedSourceRevision: revision.sourceRevision, obligationDispositions: stale,
    })).toThrow('PLAN_DRAFT_REPAIR_INVALID: unknown predecessor obligation');
    expect(getPlanContract(options, admitted.planId)?.pendingRevision?.obligationDispositions).toEqual(dispositions);
  });

  test('pending revision repair retires only obligations resolved after revision staging', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-repair-resolved-obligations-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    const { predecessor, workId } = deliveredValidatingPredecessor(options, 'PLAN-R1-resolved');
    const revision = input('PLAN-R2-resolved');
    revision.sourceRevision = 'revision-b';
    const dispositions = successorDispositions(predecessor);
    const admitted = admitPlanContract(options, {
      ...revision,
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    }).plan!;
    expect(admitted).toMatchObject({ planId: predecessor.planId, status: 'replanning', pendingRevision: { revision: 2, sourceRevision: 'revision-b' } });

    const acceptedCurrent = acceptPlanStepEvidence(options, {
      planId: predecessor.planId,
      stepId: 'stage-a',
      reviewer: 'chatgpt',
      rationale: 'The current revision delivery is semantically accepted after the next revision was staged.',
    });
    expect(acceptedCurrent).toMatchObject({ status: 'replanning', steps: [{ status: 'completed', workId }] });
    const unresolvedIds = new Set(listUnresolvedPlanObligations(acceptedCurrent).map((obligation) => obligation.obligationId));
    const resolvedStepIds = dispositions
      .map((disposition) => disposition.obligationId)
      .filter((obligationId) => !unresolvedIds.has(obligationId));
    expect(resolvedStepIds).toHaveLength(3);

    const { planId: _planId, repoId: _repoId, requirementId: _requirementId, ...repairInput } = revision;
    const repaired = repairDraftPlanContract(options, admitted.planId, {
      ...repairInput,
      sourceRevision: 'revision-c',
      obligationDispositions: admitted.pendingRevision?.obligationDispositions,
      expectedSourceRevision: admitted.pendingRevision!.sourceRevision,
    });
    expect(repaired).toMatchObject({ planId: admitted.planId, status: 'replanning', pendingRevision: { revision: 2, sourceRevision: 'revision-c' } });
    expect(repaired.pendingRevision?.obligationDispositions?.some((entry) => resolvedStepIds.includes(entry.obligationId))).toBe(false);
    for (const obligation of listUnresolvedPlanObligations(acceptedCurrent)) {
      expect(repaired.pendingRevision?.obligationDispositions).toContainEqual(expect.objectContaining({
        predecessorPlanId: predecessor.planId,
        obligationId: obligation.obligationId,
      }));
    }
    expect(repaired.pendingRevision?.deliveryCarries ?? []).toEqual([]);
    expect(approvePlanContract(options, repaired.planId)).toMatchObject({ planId: predecessor.planId, revision: 2, status: 'ready_to_finalize', steps: [{ status: 'completed', workId }] });
  });

  test('pending revision repair rejects stale dispositions when current revision obligation content changes', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-repair-changed-obligation-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    const { predecessor } = deliveredValidatingPredecessor(options, 'PLAN-R1-changed');
    const revision = input('PLAN-R2-changed');
    revision.sourceRevision = 'revision-b';
    const dispositions = successorDispositions(predecessor);
    const admitted = admitPlanContract(options, {
      ...revision,
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    }).plan!;
    const acceptedCurrent = acceptPlanStepEvidence(options, {
      planId: predecessor.planId,
      stepId: 'stage-a',
      reviewer: 'chatgpt',
      rationale: 'Complete the current revision before simulating an illegal semantic mutation.',
    });
    const stored = readControlPlaneRecord<typeof acceptedCurrent>(controllerHome, 'plan_contract', 'repo-a', predecessor.planId)!;
    writeControlPlaneRecord(controllerHome, {
      namespace: 'plan_contract',
      scope: 'repo-a',
      key: predecessor.planId,
      schemaVersion: 1,
      value: {
        ...stored.value,
        steps: stored.value.steps.map((step) => step.id === 'stage-a'
          ? { ...step, objective: 'A materially changed predecessor obligation.' }
          : step),
        updatedAt: '2026-09-06T00:00:00.000Z',
      },
      action: 'test_change_completed_predecessor_obligation',
      expectedRevision: stored.revision,
    });

    const { planId: _planId, repoId: _repoId, requirementId: _requirementId, ...repairInput } = revision;
    expect(() => repairDraftPlanContract(options, admitted.planId, {
      ...repairInput,
      sourceRevision: 'revision-c',
      obligationDispositions: admitted.pendingRevision?.obligationDispositions,
      expectedSourceRevision: admitted.pendingRevision!.sourceRevision,
    })).toThrow('PLAN_DRAFT_REPAIR_INVALID: unknown predecessor obligation');
  });

  test('obligation-only revision reuses exact validating delivery after approval without replaying terminal Work', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-delivery-carry-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    const { predecessor, workId } = deliveredValidatingPredecessor(options);
    const { successor: revision, dispositions } = changedAcceptanceSuccessor(predecessor, 'PLAN-R2');

    const admitted = admitPlanContract(options, {
      ...revision, planRelation: 'extend', relatedPlanId: predecessor.planId, obligationDispositions: dispositions,
    }).plan!;
    expect(admitted).toMatchObject({ planId: predecessor.planId, status: 'replanning', pendingRevision: { revision: 2, requestedRevisionLabel: 'PLAN-R2' } });
    expect(admitted.pendingRevision?.deliveryCarries).toEqual([expect.objectContaining({
      predecessorPlanId: predecessor.planId, predecessorStepId: 'stage-a', successorStepId: 'stage-a', workId,
      completionReceiptId: `REC-${workId}`, deliveredSourceRevision: 'revision-b',
    })]);
    const { planId: _planId, repoId: _repoId, requirementId: _requirementId, ...repairInput } = revision;
    const repaired = repairDraftPlanContract(options, admitted.planId, {
      ...repairInput, obligationDispositions: dispositions, expectedSourceRevision: revision.sourceRevision,
    });
    expect(repaired.pendingRevision?.deliveryCarries).toEqual([expect.objectContaining({ workId, completionReceiptId: `REC-${workId}` })]);

    const approved = approvePlanContract(options, admitted.planId);
    expect(approved).toMatchObject({ planId: predecessor.planId, revision: 2, status: 'verifying', steps: [{ id: 'stage-a', status: 'validating', workId }] });
    expect(getWorkContract(options, workId)).toMatchObject({ status: 'completed', planId: predecessor.planId, planStepId: 'stage-a' });
    expect(getPlanContract(options, 'PLAN-R2')).toBeUndefined();

    const accepted = acceptPlanStepEvidence(options, {
      planId: admitted.planId, stepId: 'stage-a', reviewer: 'chatgpt', rationale: 'Reviewed the revised criterion against the carried immutable delivery.',
    });
    expect(accepted).toMatchObject({ status: 'finalized', steps: [{ status: 'completed', workId }] });
    expect(listWorkContracts({ ...options, status: 'all', limit: 20 }).filter((work) => work.workId === workId)).toHaveLength(1);
  });

  test('delivery carry accepts a later revision source only with explicit delivered-revision containment proof', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-delivery-carry-ancestor-'));
    roots.push(controllerHome);
    const options = {
      controllerHome,
      repoId: 'repo-a',
      revisionContains: (ancestor: string, descendant: string) => ancestor === 'revision-b' && descendant === 'revision-c',
    };
    const { predecessor, workId } = deliveredValidatingPredecessor(options);
    const { successor: revision, dispositions } = changedAcceptanceSuccessor(predecessor, 'PLAN-R2-later-source', 'revision-c');

    const admitted = admitPlanContract(options, {
      ...revision,
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    }).plan!;
    expect(admitted.pendingRevision?.deliveryCarries).toEqual([expect.objectContaining({
      workId,
      deliveredSourceRevision: 'revision-b',
    })]);
    const approved = approvePlanContract(options, admitted.planId);
    expect(approved).toMatchObject({
      planId: predecessor.planId,
      revision: 2,
      status: 'verifying',
      sourceRevision: 'revision-c',
      steps: [{ status: 'validating', workId }],
    });
  });

  test('revision approval revalidates delivery containment and fails closed when proof disappears', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-delivery-carry-proof-loss-'));
    roots.push(controllerHome);
    let contained = true;
    const options = {
      controllerHome,
      repoId: 'repo-a',
      revisionContains: (ancestor: string, descendant: string) => contained && ancestor === 'revision-b' && descendant === 'revision-c',
    };
    const { predecessor } = deliveredValidatingPredecessor(options);
    const { successor: revision, dispositions } = changedAcceptanceSuccessor(predecessor, 'PLAN-R2-proof-loss', 'revision-c');
    const admitted = admitPlanContract(options, {
      ...revision,
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    }).plan!;
    expect(admitted.pendingRevision?.deliveryCarries).toHaveLength(1);

    contained = false;
    expect(() => approvePlanContract(options, admitted.planId)).toThrow('PLAN_DELIVERY_CARRY_INVALID');
  });

  test('delivery carry rejects changed execution contract and source mismatch', () => {
    for (const variant of ['checks', 'allowed_paths', 'source'] as const) {
      const controllerHome = mkdtempSync(join(tmpdir(), `forge-plan-delivery-carry-${variant}-`));
      roots.push(controllerHome);
      const options = { controllerHome, repoId: 'repo-a' };
      const { predecessor } = deliveredValidatingPredecessor(options);
      const { successor, dispositions } = changedAcceptanceSuccessor(predecessor, `PLAN-R2-${variant}`, variant === 'source' ? 'revision-c' : 'revision-b');
      if (variant === 'checks') successor.steps[0]!.checks = ['package:check:main'];
      if (variant === 'allowed_paths') successor.steps[0]!.allowedPaths = ['different/**'];
      const admitted = admitPlanContract(options, {
        ...successor, planRelation: 'extend', relatedPlanId: predecessor.planId, obligationDispositions: dispositions,
      }).plan!;
      expect(admitted.pendingRevision?.deliveryCarries ?? []).toEqual([]);
      const approved = approvePlanContract(options, admitted.planId);
      expect(approved).toMatchObject({ status: 'approved', steps: [{ status: 'ready' }] });
      expect(approved.steps[0]?.workId).toBeUndefined();
    }
  });

  test('delivery carry rejects failed, cancelled, or receipt-less historical Work even when predecessor projection says validating', () => {
    for (const variant of ['failed', 'cancelled', 'missing_receipt'] as const) {
      const controllerHome = mkdtempSync(join(tmpdir(), `forge-plan-delivery-carry-${variant}-`));
      roots.push(controllerHome);
      const options = { controllerHome, repoId: 'repo-a' };
      const { predecessor, workId } = deliveredValidatingPredecessor(options);
      overwriteWork(options, workId, (work) => variant === 'missing_receipt'
        ? { ...work, completionReceipt: undefined }
        : { ...work, status: variant, dispatchState: 'terminal', evidenceState: 'failed', completionOutcome: undefined, completionReceipt: undefined });
      const { successor, dispositions } = changedAcceptanceSuccessor(predecessor, `PLAN-R2-${variant}`);
      const admit = () => admitPlanContract(options, {
        ...successor, planRelation: 'extend', relatedPlanId: predecessor.planId, obligationDispositions: dispositions,
      }).plan!;
      if (variant === 'missing_receipt') {
        expect(admit).toThrow();
      } else {
        expect(admit().pendingRevision?.deliveryCarries ?? []).toEqual([]);
      }
    }
  });

  test('delivery carry does not accept an un-reconciled acceptance broadening', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-delivery-carry-broadening-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    const { predecessor } = deliveredValidatingPredecessor(options);
    const successor = input('PLAN-R2-broadened');
    successor.sourceRevision = 'revision-b';
    successor.steps[0]!.acceptanceCriteria = [...successor.steps[0]!.acceptanceCriteria, 'A new semantic obligation is accepted.'];
    const admitted = admitPlanContract(options, {
      ...successor, planRelation: 'extend', relatedPlanId: predecessor.planId,
      obligationDispositions: successorDispositions(predecessor),
    }).plan!;
    expect(admitted.pendingRevision?.deliveryCarries ?? []).toEqual([]);
  });

  test('maintenance retires legacy active Work whose Plan was already terminal', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-work-maintenance-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Keep only current Plan authority executable.',
    });
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    createWorkContract(options, {
      workId: 'WORK-LEGACY', repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: 'stage-a',
      mode: 'goal_workloop', objective: 'Legacy Work left running by an older Runtime.', acceptanceCriteria: ['Maintenance retires stale authority.'],
      allowedPaths: ['src/**'], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const stored = readControlPlaneRecord<typeof predecessor>(controllerHome, 'plan_contract', 'repo-a', predecessor.planId)!;
    writeControlPlaneRecord(controllerHome, {
      namespace: 'plan_contract', scope: 'repo-a', key: predecessor.planId, schemaVersion: 1,
      value: { ...stored.value, status: 'cancelled' as const, updatedAt: '2026-09-04T00:00:00.000Z' },
      action: 'test_legacy_terminal_plan', expectedRevision: stored.revision,
    });

    expect(retireTerminalPlanBoundWorkAuthorities(options)).toEqual(['WORK-LEGACY']);
    expect(getWorkContract(options, 'WORK-LEGACY')).toMatchObject({ status: 'cancelled', dispatchState: 'terminal', phase: 'implementation', phaseEvidence: { implementation: { state: 'skipped' }, cleanup: { state: 'pending' } } });
    expect(retireTerminalPlanBoundWorkAuthorities(options)).toEqual([]);
  });
});
