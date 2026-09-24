import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { projectAutonomousGoalProgression } from '../../packages/kernel/progression/api/index';
import { acceptRequirementOutcome } from '../../src/runtime/control-plane/facade/requirement-authority';
import {
  acceptPlanStepEvidence,
  approvePlanContract,
  claimPlanStepForWork,
  completePlanStepForWork,
  createPlanContract,
  getPlanExecutionBaselineRevision,
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
    expect(requirementSemanticView(requirement)).toMatchObject({ revision: 1, state: 'open' });
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
    expect(planSemanticView(plan)).toMatchObject({ revision: 1, sourceBasisRevision: 'source-a' });
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
    const semanticBeforeLegacyApproval = planSemanticView(revisedPlan);
    const mechanicallyApprovedPlan = approvePlanContract(planOptions, planId);
    expect(planSemanticView(mechanicallyApprovedPlan)).toEqual(semanticBeforeLegacyApproval);
    const revisedAfterMechanicalApproval = revisePlanSemanticContext(planOptions, planId, {
      expectedRevision: 2,
      goal: 'Semantic revision after mechanical approval',
    });
    expect(revisedAfterMechanicalApproval.status).toBe('approved');
    expect(planSemanticView(revisedAfterMechanicalApproval)).toMatchObject({
      revision: 3,
      goal: 'Semantic revision after mechanical approval',
      sourceBasisRevision: 'source-b',
    });
    expect(() => revisePlanSemanticContext(planOptions, planId, { expectedRevision: 2, goal: 'stale writer' }))
      .toThrow('PLAN_REVISION_CONFLICT');
  });

  test('distinguishes Work delivery source advance, Plan acceptance, Requirement acceptance, and unrelated drift', () => {
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
    approvePlanContract(planOptions, planId);
    claimPlanStepForWork(planOptions, { planId, stepId: 'step-a', workId, sourceRevision: 'rev-a' });
    const delivered = completePlanStepForWork(planOptions, {
      planId,
      stepId: 'step-a',
      work: {
        workId,
        status: 'completed',
        phase: 'cleanup',
        evidenceState: 'valid',
        completionOutcome: 'completed_changed',
        completionReceipt: completionReceipt(workId, 'rev-b'),
        evidenceRefs: [],
      },
    });
    const requirementBeforeAcceptance = readRequirement({ controllerHome }, requirementId)!.value;

    const deliveredSnapshot = {
      requirement: {
        requirementId,
        state: requirementBeforeAcceptance.state,
        revision: requirementBeforeAcceptance.revision,
      },
      plan: {
        planId,
        requirementId,
        sourceRevision: delivered.sourceRevision,
        status: delivered.status,
        steps: delivered.steps.map((step) => ({
          id: step.id,
          dependencies: step.dependencies,
          status: step.status,
          workId: step.workId,
        })),
      },
      currentSourceRevision: 'rev-b',
      works: [{
        workId,
        requirementId,
        planId,
        planStepId: 'step-a',
        status: 'completed' as const,
        baseRevision: 'rev-a',
        completionTargetRevision: 'rev-b',
      }],
      controllerRounds: [],
    };

    expect(projectAutonomousGoalProgression(deliveredSnapshot)).toMatchObject({
      kind: 'request_controller_acceptance',
      reasonCode: 'MACHINE_COMPLETE_REQUIRES_CONTROLLER_ACCEPTANCE',
      workId,
    });
    expect(projectAutonomousGoalProgression({ ...deliveredSnapshot, currentSourceRevision: 'rev-c' })).toMatchObject({
      kind: 'request_controller_acceptance',
      reasonCode: 'MACHINE_COMPLETE_REQUIRES_CONTROLLER_ACCEPTANCE',
      workId,
    });
    expect(projectAutonomousGoalProgression({
      ...deliveredSnapshot,
      works: [{ ...deliveredSnapshot.works[0], baseRevision: 'rev-other' }],
    })).toMatchObject({
      kind: 'request_controller_acceptance',
      reasonCode: 'MACHINE_COMPLETE_REQUIRES_CONTROLLER_ACCEPTANCE',
      workId,
    });
    expect(readRequirement({ controllerHome }, requirementId)!.value.state).toBe('active');

    const finalized = acceptPlanStepEvidence(planOptions, {
      planId,
      stepId: 'step-a',
      reviewer: 'controller-a',
      rationale: 'The delivered Work satisfies the approved Plan step.',
      acceptedSourceRevision: 'rev-b',
    });
    expect(finalized.status).toBe('finalized');
    // Plan semantic source remains the approved contract revision. Delivery
    // advancement is tracked by the separate execution baseline authority.
    expect(finalized.sourceRevision).toBe('rev-a');
    expect(getPlanExecutionBaselineRevision(planOptions, finalized)).toBe('rev-b');

    const requirementStillActive = readRequirement({ controllerHome }, requirementId)!.value;
    const finalizedDecision = projectAutonomousGoalProgression({
      ...deliveredSnapshot,
      requirement: {
        requirementId,
        state: requirementStillActive.state,
        revision: requirementStillActive.revision,
      },
      plan: {
        ...deliveredSnapshot.plan,
        sourceRevision: finalized.sourceRevision,
        executionBaselineRevision: getPlanExecutionBaselineRevision(planOptions, finalized),
        status: finalized.status,
        steps: finalized.steps.map((step) => ({
          id: step.id,
          dependencies: step.dependencies,
          status: step.status,
          workId: step.workId,
        })),
      },
    });
    expect(finalizedDecision).toMatchObject({
      kind: 'request_requirement_acceptance',
      reasonCode: 'PLAN_FINALIZED_REQUIRES_REQUIREMENT_ACCEPTANCE',
    });

    expect(() => acceptRequirementOutcome({ controllerHome, repoId }, {
      requirementId,
      workId,
      reviewer: 'controller-a',
      rationale: 'The finalized Plan evidence satisfies the Requirement outcome.',
    })).toThrow(/REQUIREMENT_ACCEPTANCE_WORK_NOT_FOUND|REQUIREMENT_ACCEPTANCE_GOAL_COMPLETE_REQUIRED/);
    expect(readRequirement({ controllerHome }, requirementId)!.value.state).toBe('active');
  });

  test('refuses Requirement acceptance while a current Plan slice is not finalized', () => {
    const controllerHome = home();
    const repoId = 'repo-goal-authority-parallel';
    const requirementId = 'REQ-GOAL-PARALLEL';
    activateRequirement(controllerHome, requirementId);
    const options = { controllerHome, repoId };
    createPlanContract(options, {
      planId: 'PLAN-GOAL-PENDING',
      repoId,
      requirementId,
      scopeKey: 'pending-slice',
      sourceRevision: 'rev-a',
      goal: 'Remain active.',
      steps: [{
        id: 'step-a',
        objective: 'Pending slice.',
        dependencies: [],
        authoritativeFiles: [],
        allowedPaths: [],
        forbiddenPaths: [],
        checks: ['package:check:type'],
        acceptanceCriteria: ['The pending slice remains incomplete.'],
      }],
    });
    approvePlanContract(options, 'PLAN-GOAL-PENDING');
    expect(() => acceptRequirementOutcome(options, {
      requirementId,
      workId: 'work-missing',
      reviewer: 'controller-a',
      rationale: 'Should not be accepted yet.',
    })).toThrow(/REQUIREMENT_ACCEPTANCE_PLAN_INCOMPLETE/);
    expect(readRequirement({ controllerHome }, requirementId)!.value.state).toBe('active');
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
