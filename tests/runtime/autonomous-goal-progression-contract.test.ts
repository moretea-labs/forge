import { describe, expect, test } from 'bun:test';
import {
  projectAutonomousGoalProgression,
  type AutonomousGoalProgressionSnapshot,
} from '../../packages/kernel/progression/api/index';

function snapshot(overrides: Partial<AutonomousGoalProgressionSnapshot> = {}): AutonomousGoalProgressionSnapshot {
  return {
    requirement: { requirementId: 'REQ-1', state: 'active', revision: 3 },
    plan: {
      planId: 'PLAN-1',
      requirementId: 'REQ-1',
      sourceRevision: 'rev-1',
      status: 'executing',
      steps: [
        { id: 'A', dependencies: [], status: 'executing', workId: 'WORK-A' },
        { id: 'B', dependencies: ['A'], status: 'pending' },
      ],
    },
    currentSourceRevision: 'rev-1',
    works: [{ workId: 'WORK-A', requirementId: 'REQ-1', planId: 'PLAN-1', planStepId: 'A', status: 'running' }],
    controllerRounds: [],
    ...overrides,
  };
}

describe('Autonomous Goal Progression projector', () => {
  test('continues an active Work when no controller round is in flight', () => {
    const result = projectAutonomousGoalProgression(snapshot());
    expect(result.kind).toBe('continue_current_work');
    expect(result.reasonCode).toBe('WORK_READY_TO_CONTINUE');
    expect(result.workId).toBe('WORK-A');
  });

  test('waits instead of double-dispatching an in-flight controller round', () => {
    const result = projectAutonomousGoalProgression(snapshot({
      controllerRounds: [{ originWorkId: 'WORK-A', status: 'dispatched', roundCount: 4 }],
    }));
    expect(result.kind).toBe('wait_current_work');
    expect(result.reasonCode).toBe('CONTROLLER_ROUND_IN_FLIGHT');
  });

  test('never converts machine completion into Plan semantic acceptance', () => {
    const base = snapshot();
    const result = projectAutonomousGoalProgression(snapshot({
      plan: { ...base.plan, steps: [{ id: 'A', dependencies: [], status: 'validating', workId: 'WORK-A' }] },
      works: [{ workId: 'WORK-A', requirementId: 'REQ-1', planId: 'PLAN-1', planStepId: 'A', status: 'completed' }],
    }));
    expect(result.kind).toBe('request_controller_acceptance');
    expect(result.reasonCode).toBe('MACHINE_COMPLETE_REQUIRES_CONTROLLER_ACCEPTANCE');
  });

  test('starts exactly one dependency-ready step only after predecessor acceptance', () => {
    const base = snapshot();
    const result = projectAutonomousGoalProgression(snapshot({
      plan: {
        ...base.plan,
        steps: [
          { id: 'A', dependencies: [], status: 'completed', workId: 'WORK-A' },
          { id: 'B', dependencies: ['A'], status: 'ready' },
        ],
      },
      works: [{ workId: 'WORK-A', requirementId: 'REQ-1', planId: 'PLAN-1', planStepId: 'A', status: 'completed' }],
    }));
    expect(result.kind).toBe('start_next_plan_step');
    expect(result.planStepId).toBe('B');
  });

  test('waits for unmet dependencies rather than inventing readiness', () => {
    const base = snapshot();
    const result = projectAutonomousGoalProgression(snapshot({
      plan: {
        ...base.plan,
        steps: [
          { id: 'A', dependencies: [], status: 'executing', workId: 'WORK-A' },
          { id: 'B', dependencies: ['A'], status: 'pending' },
        ],
      },
      works: [{ workId: 'WORK-A', requirementId: 'REQ-1', planId: 'PLAN-1', planStepId: 'A', status: 'blocked' }],
    }));
    expect(result.kind).toBe('wait_current_work');
  });

  test('fails closed if dependency-ready state has not been projected by Plan authority', () => {
    const base = snapshot();
    const result = projectAutonomousGoalProgression(snapshot({
      plan: {
        ...base.plan,
        steps: [
          { id: 'A', dependencies: [], status: 'completed', workId: 'WORK-A' },
          { id: 'B', dependencies: ['A'], status: 'pending' },
        ],
      },
      works: [{ workId: 'WORK-A', requirementId: 'REQ-1', planId: 'PLAN-1', planStepId: 'A', status: 'completed' }],
    }));
    expect(result.kind).toBe('blocked_invalid_state');
    expect(result.reasonCode).toBe('PLAN_STEP_READINESS_NOT_PROJECTED');
  });

  test('requests replan on source drift and reconciles a failed Work before replanning', () => {
    expect(projectAutonomousGoalProgression(snapshot({ currentSourceRevision: 'rev-2' })).kind).toBe('request_replan');
    expect(projectAutonomousGoalProgression(snapshot({
      works: [{ workId: 'WORK-A', requirementId: 'REQ-1', planId: 'PLAN-1', planStepId: 'A', status: 'failed' }],
    }))).toMatchObject({
      kind: 'blocked_invalid_state',
      reasonCode: 'PLAN_STEP_TERMINAL_WORK_RECONCILIATION_REQUIRED',
      workId: 'WORK-A',
    });
    expect(projectAutonomousGoalProgression(snapshot({
      plan: {
        planId: 'PLAN-1',
        requirementId: 'REQ-1',
        sourceRevision: 'rev-1',
        status: 'replanning',
        steps: [
          { id: 'A', dependencies: [], status: 'ready' },
          { id: 'B', dependencies: ['A'], status: 'pending' },
        ],
      },
      works: [{ workId: 'WORK-A', requirementId: 'REQ-1', planId: 'PLAN-1', planStepId: 'A', status: 'failed' }],
    }))).toMatchObject({ kind: 'request_replan', reasonCode: 'PLAN_REPLAN_REQUIRED' });
  });

  test('preserves explicit user-only waits', () => {
    const result = projectAutonomousGoalProgression(snapshot({
      requirement: { requirementId: 'REQ-1', state: 'waiting_for_user', revision: 4 },
    }));
    expect(result.kind).toBe('wait_for_user');
  });

  test('projects explicit Requirement acceptance after canonical finalized Plan steps', () => {
    const base = snapshot();
    const result = projectAutonomousGoalProgression(snapshot({
      plan: {
        ...base.plan,
        status: 'finalized',
        steps: [
          { id: 'A', dependencies: [], status: 'completed', workId: 'WORK-A' },
          { id: 'B', dependencies: ['A'], status: 'completed', workId: 'WORK-B' },
        ],
      },
      works: [],
    }));
    expect(result.kind).toBe('request_requirement_acceptance');
    expect(result.reasonCode).toBe('PLAN_FINALIZED_REQUIRES_REQUIREMENT_ACCEPTANCE');
  });

  test('does not arbitrarily select among multiple ready steps', () => {
    const base = snapshot();
    const result = projectAutonomousGoalProgression(snapshot({
      plan: {
        ...base.plan,
        steps: [
          { id: 'A', dependencies: [], status: 'completed' },
          { id: 'B', dependencies: ['A'], status: 'ready' },
          { id: 'C', dependencies: ['A'], status: 'ready' },
        ],
      },
      works: [],
    }));
    expect(result.kind).toBe('blocked_invalid_state');
    expect(result.reasonCode).toBe('MULTIPLE_READY_PLAN_STEPS');
  });

  test('returns the same replay identity for the same canonical snapshot', () => {
    const first = projectAutonomousGoalProgression(snapshot());
    const second = projectAutonomousGoalProgression(snapshot());
    expect(second).toEqual(first);
  });
});
