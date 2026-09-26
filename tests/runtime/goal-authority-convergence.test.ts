import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createPlanContract,
  createPlanSemanticContext,
  getPlanContract,
  listPlanSemanticRevisionRecords,
  planSemanticView,
  revisePlanSemanticContext,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  createRequirement,
  listRequirementRevisionRecords,
  readRequirement,
  requirementSemanticView,
  reviseRequirementSemantic,
  updateRequirement,
} from '../../src/runtime/control-plane/persistence/requirement-store';
import { createWorkContract, recordWorkCompletionReceipt, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../packages/kernel/work/domain/implementation-review';

const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join('/tmp', 'forge-goal-authority-'));
  homes.push(value);
  return value;
}

function completionReceipt(workId: string, targetRevision: string) {
  return {
    schemaVersion: 1 as const,
    receiptId: `receipt-${workId}`,
    source: 'controller_work' as const,
    issueId: 'ISS-goal-authority',
    taskId: 'T1',
    workId,
    targetBranch: 'main',
    targetRevision,
    changedPaths: ['src/example.ts'],
    delivery: {
      kind: 'commit' as const,
      status: 'integrated' as const,
      strategy: 'edit_session_commit' as const,
      reachable: true,
      recordedAt: '2026-09-05T00:00:00.000Z',
    },
    cleanup: {
      status: 'complete' as const,
      warnings: [],
      blockers: [],
      recordedAt: '2026-09-05T00:00:00.000Z',
    },
    verifiedAt: '2026-09-05T00:00:00.000Z',
    recordedAt: '2026-09-05T00:00:00.000Z',
  };
}

function activateRequirement(controllerHome: string, requirementId: string) {
  createRequirement({ controllerHome }, {
    requirementId,
    title: 'Goal authority convergence',
    outcomeStatement: 'Only explicit Controller acceptance completes the Requirement.',
  });
  return updateRequirement({ controllerHome }, {
    requirementId,
    action: 'test_activate',
    mutate: (current) => ({ ...current, state: 'active' }),
  });
}

describe('Goal authority convergence', () => {
  test('persists thin Requirement/Plan semantic revisions with fail-closed CAS', () => {
    const controllerHome = home();
    const repoId = 'repo-semantic-revision';
    const requirementId = 'REQ-SEMANTIC-REVISION';
    const planId = 'PLAN-SEMANTIC-REVISION';
    const requirement = createRequirement({ controllerHome }, {
      requirementId,
      title: 'Original requirement',
      outcomeStatement: 'Original outcome',
      acceptanceCriteria: ['original acceptance'],
    });
    expect(requirementSemanticView(requirement)).toMatchObject({
      revision: 1, state: 'open', semanticScope: { kind: 'requirement', id: requirementId },
    });
    const revisedRequirement = reviseRequirementSemantic({ controllerHome }, requirementId, {
      expectedRevision: 1,
      title: 'Revised requirement',
      acceptanceCriteria: ['revised acceptance'],
    });
    const revisedRequirementSemantic = requirementSemanticView(revisedRequirement);
    expect(revisedRequirementSemantic).toMatchObject({ revision: 2, title: 'Revised requirement', state: 'open' });
    const mechanicallyUpdatedRequirement = updateRequirement({ controllerHome }, {
      requirementId,
      action: 'test_mechanical_wait',
      mutate: (current) => ({ ...current, state: 'waiting_for_user', needsAttention: true, attentionSummary: 'mechanical-only wait' }),
    });
    expect(requirementSemanticView(mechanicallyUpdatedRequirement)).toMatchObject({
      revision: 2, title: 'Revised requirement', state: 'open', updatedAt: revisedRequirementSemantic.updatedAt,
    });
    const explicitlyOpenedRequirement = reviseRequirementSemantic({ controllerHome }, requirementId, { expectedRevision: 2, state: 'open' });
    expect(explicitlyOpenedRequirement).toMatchObject({ state: 'active', needsAttention: false });
    expect(requirementSemanticView(explicitlyOpenedRequirement)).toMatchObject({ revision: 3, state: 'open' });
    expect(listRequirementRevisionRecords({ controllerHome }, requirementId)).toMatchObject([{ revision: 2, title: 'Revised requirement' }, { revision: 1, title: 'Original requirement' }]);
    expect(() => reviseRequirementSemantic({ controllerHome }, requirementId, { expectedRevision: 2, title: 'stale writer' }))
      .toThrow('REQUIREMENT_REVISION_CONFLICT');

    const planOptions = { controllerHome, repoId, now: () => '2026-09-24T04:58:00.000Z' };
    const plan = createPlanContract(planOptions, {
      planId,
      repoId,
      requirementId,
      scopeKey: 'semantic-revision',
      sourceRevision: 'source-a',
      goal: 'Original plan goal',
      steps: [{ id: 'item-a', objective: 'Keep one authored item.', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check-semantic-compatibility'], acceptanceCriteria: ['Legacy mechanical approval remains separate from semantic Plan content.'] }],
    });
    expect(planSemanticView(plan)).toMatchObject({
      revision: 1,
      semanticScope: { kind: 'requirement', id: requirementId },
      sourceBasisRevision: 'source-a',
    });
    expect(planSemanticView(plan)).not.toHaveProperty('repoId');
    const revisedPlan = revisePlanSemanticContext(planOptions, planId, {
      expectedRevision: 1,
      requirementBasisRevision: 3,
      sourceBasisRevision: 'source-b',
      goal: 'Revised plan goal',
      items: [{ id: 'item-b', objective: 'Replace the authored working-memory item.', dependencies: [] }],
    });
    expect(revisedPlan.revision).toBe(plan.revision);
    expect(planSemanticView(revisedPlan)).toMatchObject({
      revision: 2, requirementBasisRevision: 3, sourceBasisRevision: 'source-b', goal: 'Revised plan goal',
      items: [{ id: 'item-b', objective: 'Replace the authored working-memory item.', dependencies: [] }],
    });
    expect(listPlanSemanticRevisionRecords(planOptions, planId)).toMatchObject([{ revision: 1, sourceBasisRevision: 'source-a', goal: 'Original plan goal' }]);
    const revisedAfterAnotherSemanticRevision = revisePlanSemanticContext(planOptions, planId, {
      expectedRevision: 2,
      goal: 'Semantic revision after mechanical approval',
    });
    expect(revisedAfterAnotherSemanticRevision.status).toBe('draft');
    expect(planSemanticView(revisedAfterAnotherSemanticRevision)).toMatchObject({
      revision: 3,
      goal: 'Semantic revision after mechanical approval',
      sourceBasisRevision: 'source-b',
    });
    expect(() => revisePlanSemanticContext(planOptions, planId, { expectedRevision: 2, goal: 'stale writer' }))
      .toThrow('PLAN_REVISION_CONFLICT');
  });

  test('keeps Work delivery evidence separate from authored Plan and Requirement progress', () => {
    const controllerHome = home();
    const repoId = 'repo-goal-authority';
    const requirementId = 'REQ-GOAL-AUTHORITY';
    const planId = 'PLAN-GOAL-AUTHORITY';
    const workId = 'work-goal-authority';
    activateRequirement(controllerHome, requirementId);
    const planOptions = { controllerHome, repoId, now: () => '2026-09-05T00:00:00.000Z' };

    createPlanContract(planOptions, {
      planId,
      repoId,
      requirementId,
      scopeKey: 'goal-authority',
      sourceRevision: 'rev-a',
      goal: 'Deliver one source-changing slice then require semantic acceptance.',
      steps: [{
        id: 'step-a',
        objective: 'Advance source A to B.',
        dependencies: [],
        authoritativeFiles: ['src/example.ts'],
        allowedPaths: ['src/**'],
        forbiddenPaths: [],
        checks: ['package:check:type'],
        acceptanceCriteria: ['Controller reviews the exact delivered result.'],
      }],
    });
    createWorkContract({ controllerHome, repoId }, {
      workId,
      repoId,
      requirementId,
      planId,
      planStepId: 'step-a',
      planSourceRevision: 'rev-a',
      workKind: 'completed_no_change',
      objective: 'Advance source A to B.',
      acceptanceCriteria: ['Controller reviews the exact delivered result.'],
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: ['package:check:type'],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
      baseRevision: 'rev-a',
    });
    const recordedAt = '2026-09-05T00:00:00.000Z';
    transitionWorkContractPhase({ controllerHome, repoId }, workId, { status: 'running', phase: 'verification', state: 'satisfied', summary: 'Exact no-change delivery verified.' });
    requestWorkImplementationReview({ controllerHome, repoId }, workId, 'Delivery requires explicit implementation review before completion.');
    recordWorkImplementationReview({ controllerHome, repoId }, workId, {
      schemaVersion: 1,
      reviewId: 'REV-goal-authority',
      workId,
      reviewerPrincipalId: 'controller-a',
      reviewerControllerSessionId: 'transport-goal-authority',
      decision: 'approved',
      rationale: 'Exact delivered evidence reviewed before completion.',
      findings: [],
      sourceRevision: 'rev-b',
      workspaceFingerprint: `${workId}:content`,
      verificationWorkspaceFingerprint: `${workId}:verification`,
      changedPaths: [],
      changedPathDigest: implementationReviewChangedPathDigest([]),
      acceptanceCriteriaSummary: 'Controller reviews the exact delivered result.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt,
    });
    const completed = recordWorkCompletionReceipt({ controllerHome, repoId }, workId, {
      schemaVersion: 1,
      receiptId: `receipt-${workId}`,
      source: 'controller_work',
      issueId: workId,
      taskId: workId,
      workId,
      targetBranch: 'main',
      targetRevision: 'rev-b',
      changedPaths: [],
      delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
      cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
      verifiedAt: recordedAt,
      recordedAt,
    }, 'completed_no_change');
    expect(completed).toMatchObject({ semanticState: 'open', completionOutcome: 'completed_no_change' });

    // Work evidence advances nothing authored: the Plan item and Requirement stay
    // exactly as the model left them.
    const plan = getPlanContract(planOptions, planId)!;
    expect(plan.status).toBe('draft');
    expect(plan.steps[0]).toMatchObject({ id: 'step-a', status: 'pending' });
    expect(plan.steps[0]?.workId).toBeUndefined();
    expect(readRequirement({ controllerHome }, requirementId)!.value.state).toBe('active');

    // Physical Work evidence does not change authored Requirement semantics.
    // Only revisioned Requirement CAS may do so.
    const currentRequirement = requirementSemanticView(readRequirement({ controllerHome }, requirementId)!.value);
    const explicitlyCompleted = reviseRequirementSemantic({ controllerHome }, requirementId, {
      expectedRevision: currentRequirement.revision,
      state: 'completed',
    });
    expect(requirementSemanticView(explicitlyCompleted).state).toBe('completed');
  });

  test('terminal Requirement rejects new Plan admission', () => {
    const controllerHome = home();
    const repoId = 'repo-goal-terminal';
    const requirementId = 'REQ-GOAL-TERMINAL';
    activateRequirement(controllerHome, requirementId);
    updateRequirement({ controllerHome }, {
      requirementId,
      action: 'test_semantic_done',
      mutate: (current) => ({ ...current, state: 'done' }),
    });
    expect(() => createPlanContract({ controllerHome, repoId }, {
      planId: 'PLAN-AFTER-GOAL-COMPLETE',
      repoId,
      requirementId,
      scopeKey: 'after-goal-complete',
      sourceRevision: 'rev-a',
      goal: 'Must never materialize after terminal Requirement.',
      steps: [{
        id: 'step-a', objective: 'Forbidden successor.', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [],
        checks: ['package:check:type'], acceptanceCriteria: ['Must not be admitted.'],
      }],
    })).toThrow(/PLAN_REQUIREMENT_TERMINAL/);
  });

});
