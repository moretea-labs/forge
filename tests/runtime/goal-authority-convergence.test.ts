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
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  createRequirement,
  readRequirement,
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
      kind: 'request_replan',
      reasonCode: 'PLAN_SOURCE_DRIFT',
    });
    expect(projectAutonomousGoalProgression({
      ...deliveredSnapshot,
      works: [{ ...deliveredSnapshot.works[0], baseRevision: 'rev-other' }],
    })).toMatchObject({ kind: 'request_replan', reasonCode: 'PLAN_SOURCE_DRIFT' });
    expect(readRequirement({ controllerHome }, requirementId)!.value.state).toBe('active');

    const finalized = acceptPlanStepEvidence(planOptions, {
      planId,
      stepId: 'step-a',
      reviewer: 'controller-a',
      rationale: 'The delivered Work satisfies the approved Plan step.',
      acceptedSourceRevision: 'rev-b',
    });
    expect(finalized.status).toBe('finalized');
    expect(finalized.sourceRevision).toBe('rev-b');

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
