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
import type { PlanObligationDisposition } from '../../src/runtime/control-plane/facade/types';
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
  test('serial successor creation fails before predecessor supersession when obligations are uncovered', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    expect(listUnresolvedPlanObligations(predecessor).length).toBeGreaterThan(0);

    expect(() => admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
    })).toThrow('PLAN_OBLIGATION_CONTINUITY_REQUIRED');

    expect(getPlanContract(options, predecessor.planId)?.status).toBe('draft');
    expect(getPlanContract(options, 'PLAN-R2')).toBeUndefined();
  });

  test('explicit coverage allows serial replanning and preserves the supersession edge', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    const admitted = admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: successorDispositions(predecessor),
    });

    expect(admitted.plan?.planId).toBe('PLAN-R2');
    expect(admitted.plan?.supersedes).toEqual(['PLAN-R1']);
    expect(getPlanContract(options, 'PLAN-R1')).toMatchObject({ status: 'superseded', supersededBy: 'PLAN-R2' });
    expect(admitted.plan?.obligationDispositions?.length).toBe(listUnresolvedPlanObligations(predecessor).length);
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

  test('serial Plan replacement immediately retires predecessor-bound Work authority but keeps history', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-work-retirement-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Deliver the requirement through current Plan authority.',
    });
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    createWorkContract(options, {
      workId: 'WORK-R1', repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: 'stage-a',
      mode: 'goal_workloop', objective: 'Execute predecessor Plan stage.', acceptanceCriteria: ['Only current Plan Work remains active.'],
      allowedPaths: ['src/**'], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });

    const admitted = admitPlanContract(options, {
      ...input('PLAN-R2'), planRelation: 'extend', relatedPlanId: predecessor.planId,
      obligationDispositions: successorDispositions(predecessor),
    });
    expect(admitted.plan?.planId).toBe('PLAN-R2');
    expect(getWorkContract(options, 'WORK-R1')).toMatchObject({ status: 'cancelled', phase: 'cleanup', dispatchState: 'terminal' });
    expect(listWorkContracts({ ...options, status: 'active', limit: 20 }).map((work) => work.workId)).not.toContain('WORK-R1');
    expect(listWorkContracts({ ...options, status: 'all', limit: 20 }).map((work) => work.workId)).toContain('WORK-R1');
  });

  test('serial successor stages coherent active Work until approval and rebinds only an unchanged step contract', () => {
    for (const changed of [false, true]) {
      const controllerHome = mkdtempSync(join(tmpdir(), `forge-plan-active-carry-${changed ? 'changed' : 'same'}-`));
      roots.push(controllerHome);
      const options = { controllerHome, repoId: 'repo-a' };
      createRequirement({ controllerHome }, { requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Keep exact active Work through an obligation-only successor.' });
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
      const successor = input(`PLAN-R2-${changed}`);
      successor.sourceRevision = 'revision-c';
      if (changed) successor.steps[0]!.checks = ['package:check:main'];
      const admitted = admitPlanContract(options, { ...successor, planRelation: 'extend', relatedPlanId: executing.planId, obligationDispositions: successorDispositions(executing) }).plan!;
      expect(admitted).toMatchObject({ status: 'draft', supersedes: [executing.planId] });
      expect(getPlanContract(options, executing.planId)?.status).toBe('replanning');
      expect(getWorkContract(options, workId)).toMatchObject({ status: 'running', planId: executing.planId });
      const lateWorkId = !changed ? `WORK-LATE-${changed}` : undefined;
      if (lateWorkId) {
        createWorkContract(options, {
          workId: lateWorkId, repoId: 'repo-a', requirementId: 'REQ-A', planId: executing.planId, planStepId: step.id, planSourceRevision: executing.sourceRevision,
          baseRevision: executing.sourceRevision, mode: 'goal_workloop', workKind: 'repository_change', objective: step.objective,
          acceptanceCriteria: step.acceptanceCriteria, allowedPaths: step.allowedPaths, forbiddenPaths: step.forbiddenPaths, checks: step.checks,
          constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
        });
        expect(getWorkContract(options, lateWorkId)).toMatchObject({ status: 'running', planId: executing.planId });
      }
      const approved = approvePlanContract(options, admitted.planId);
      expect(getPlanContract(options, executing.planId)?.status).toBe('superseded');
      if (changed) {
        expect(approved).toMatchObject({ status: 'approved', steps: [{ status: 'ready' }] });
        expect(getWorkContract(options, workId)).toMatchObject({ status: 'cancelled', phase: 'cleanup', planId: executing.planId });
      } else {
        expect(approved).toMatchObject({ status: 'executing', steps: [{ status: 'executing', workId }] });
        expect(getWorkContract(options, workId)).toMatchObject({ status: 'running', planId: admitted.planId, planStepId: step.id, planSourceRevision: 'revision-c' });
      }
      expect(listWorkContracts({ ...options, status: 'all', limit: 20 }).filter((work) => work.workId === workId)).toHaveLength(1);
      if (lateWorkId) expect(getWorkContract(options, lateWorkId)).toMatchObject({ status: 'cancelled', phase: 'cleanup', planId: executing.planId });
    }
  });

  test('obligation-only successor reuses exact validating delivery after approval without replaying or rebinding terminal Work', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-delivery-carry-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    const { predecessor, workId } = deliveredValidatingPredecessor(options);
    const { successor, dispositions } = changedAcceptanceSuccessor(predecessor, 'PLAN-R2');

    const admitted = admitPlanContract(options, {
      ...successor, planRelation: 'extend', relatedPlanId: predecessor.planId, obligationDispositions: dispositions,
    }).plan!;
    expect(admitted).toMatchObject({ status: 'draft', steps: [{ id: 'stage-a', status: 'pending' }] });
    expect(admitted.deliveryCarries).toEqual([expect.objectContaining({
      predecessorPlanId: predecessor.planId, predecessorStepId: 'stage-a', successorStepId: 'stage-a', workId,
      completionReceiptId: `REC-${workId}`, deliveredSourceRevision: 'revision-b',
    })]);
    const { planId: _planId, repoId: _repoId, requirementId: _requirementId, ...repairInput } = successor;
    const repaired = repairDraftPlanContract(options, admitted.planId, {
      ...repairInput, obligationDispositions: dispositions, expectedSourceRevision: successor.sourceRevision,
    });
    expect(repaired.supersedes).toEqual([predecessor.planId]);
    expect(repaired.deliveryCarries).toEqual([expect.objectContaining({ workId, completionReceiptId: `REC-${workId}` })]);

    const approved = approvePlanContract(options, admitted.planId);
    expect(approved).toMatchObject({ status: 'verifying', steps: [{ id: 'stage-a', status: 'validating', workId }] });
    expect(approved.steps[0]?.evidenceRefs[0]).toMatchObject({ evidenceId: `REC-${workId}`, title: 'successor delivery carried' });
    expect(getWorkContract(options, workId)).toMatchObject({ status: 'completed', planId: predecessor.planId, planStepId: 'stage-a' });

    const accepted = acceptPlanStepEvidence(options, {
      planId: admitted.planId, stepId: 'stage-a', reviewer: 'chatgpt', rationale: 'Reviewed the successor criterion against the carried immutable delivery.',
    });
    expect(accepted).toMatchObject({ status: 'finalized', steps: [{ status: 'completed', workId }] });
    expect(listWorkContracts({ ...options, status: 'all', limit: 20 }).filter((work) => work.workId === workId)).toHaveLength(1);
  });

  test('delivery carry accepts a later successor source only with explicit delivered-revision containment proof', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-delivery-carry-ancestor-'));
    roots.push(controllerHome);
    const options = {
      controllerHome,
      repoId: 'repo-a',
      revisionContains: (ancestor: string, descendant: string) => ancestor === 'revision-b' && descendant === 'revision-c',
    };
    const { predecessor, workId } = deliveredValidatingPredecessor(options);
    const { successor, dispositions } = changedAcceptanceSuccessor(predecessor, 'PLAN-R2-later-source', 'revision-c');

    const admitted = admitPlanContract(options, {
      ...successor,
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    }).plan!;
    expect(admitted.deliveryCarries).toEqual([expect.objectContaining({
      workId,
      deliveredSourceRevision: 'revision-b',
    })]);
    const approved = approvePlanContract(options, admitted.planId);
    expect(approved).toMatchObject({
      status: 'verifying',
      sourceRevision: 'revision-c',
      steps: [{ status: 'validating', workId }],
    });
  });

  test('delivery carry revalidates containment at approval and fails closed when the proof disappears', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-delivery-carry-proof-loss-'));
    roots.push(controllerHome);
    let contained = true;
    const options = {
      controllerHome,
      repoId: 'repo-a',
      revisionContains: (ancestor: string, descendant: string) => contained && ancestor === 'revision-b' && descendant === 'revision-c',
    };
    const { predecessor } = deliveredValidatingPredecessor(options);
    const { successor, dispositions } = changedAcceptanceSuccessor(predecessor, 'PLAN-R2-proof-loss', 'revision-c');
    const admitted = admitPlanContract(options, {
      ...successor,
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    }).plan!;
    expect(admitted.deliveryCarries).toHaveLength(1);

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
      expect(admitted.deliveryCarries ?? []).toEqual([]);
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
        expect(admit().deliveryCarries ?? []).toEqual([]);
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
    expect(admitted.deliveryCarries ?? []).toEqual([]);
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
    expect(getWorkContract(options, 'WORK-LEGACY')).toMatchObject({ status: 'cancelled', dispatchState: 'terminal', phase: 'cleanup' });
    expect(retireTerminalPlanBoundWorkAuthorities(options)).toEqual([]);
  });
});
