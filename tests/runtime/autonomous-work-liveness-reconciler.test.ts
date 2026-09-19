import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bindControllerSessionBinding,
  claimControllerSession,
  getControllerRoundRelay,
  releaseControllerSession,
  type ControllerHost,
} from '../../packages/kernel/controller/api/index';
import { createWorkContract } from '../../packages/kernel/work/api/index';
import { upsertChatgptControllerBinding } from '../../adapters/chatgpt/controller-binding-store';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import {
  approvePlanContract,
  claimPlanStepForWork,
  createPlanContract,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import { runSchedulerAutonomousContinuationReconciliation } from '../../src/runtime/control-plane/global-scheduler/autonomous-continuation';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-autonomous-liveness-'));
  roots.push(value);
  return value;
}

function createRunningWork(controllerHome: string, input: { workId: string; planId?: string; planStepId?: string; requirementId?: string }) {
  return createWorkContract({ controllerHome, repoId: 'repo-a' }, {
    workId: input.workId,
    repoId: 'repo-a',
    mode: 'goal_workloop',
    objective: 'Execute ' + input.workId,
    acceptanceCriteria: ['Work continues until an explicit semantic stop.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
    baseRevision: 'abc123',
    planSourceRevision: input.planId ? 'abc123' : undefined,
    requirementId: input.requirementId,
    planId: input.planId,
    planStepId: input.planStepId,
  } as Parameters<typeof createWorkContract>[1]);
}

function bindReleasedChatgptController(controllerHome: string, workId: string) {
  const store = { controllerHome, repoId: 'repo-a' };
  const owner = claimControllerSession(store, {
    workId,
    controllerId: 'controller-a',
    controllerType: 'chatgpt',
    sessionId: 'session-' + workId,
    principalId: 'controller-a',
    controllerInstanceId: 'runtime-a',
    leaseMs: 60_000,
  });
  const adapter = upsertChatgptControllerBinding(store, {
    workId,
    sessionId: owner.sessionId,
    title: 'autonomous liveness test',
    model: 'gpt-5.6',
    reasoning: 'high',
    tabPolicy: 'auto',
  });
  bindControllerSessionBinding(store, { workId, sessionId: owner.sessionId, binding: adapter.binding });
  releaseControllerSession(store, workId, owner.controllerId);
  return adapter.binding;
}

function dependencies(host: ControllerHost) {
  return {
    authorizeWake: () => undefined,
    boundaryForWork: () => ({ status: 'not_eligible' as const }),
    hostForBinding: () => host,
  };
}

describe('autonomous Work liveness reconciliation', () => {
  test('materializes an ownerless Plan Work once and repeated reconciliation cannot duplicate provider dispatch', async () => {
    const controllerHome = home();
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-A',
      title: 'Requirement A',
      outcomeStatement: 'Complete the active plan.',
    });
    createPlanContract({ controllerHome, repoId: 'repo-a' }, {
      planId: 'PLAN-A',
      repoId: 'repo-a',
      requirementId: 'REQ-A',
      scopeKey: 'scope-a',
      sourceRevision: 'abc123',
      goal: 'Complete one stage.',
      nonGoals: [],
      assumptions: [],
      resolvedDecisions: [],
      stopConditions: [],
      replanConditions: [],
      steps: [{
        id: 'stage-a',
        objective: 'Execute one stage.',
        dependencies: [],
        authoritativeFiles: [],
        allowedPaths: [],
        forbiddenPaths: [],
        checks: ['package:check:type'],
        acceptanceCriteria: ['Stage continues automatically.'],
      }],
    });
    approvePlanContract({ controllerHome, repoId: 'repo-a' }, 'PLAN-A');
    createRunningWork(controllerHome, {
      workId: 'WORK-A',
      requirementId: 'REQ-A',
      planId: 'PLAN-A',
      planStepId: 'stage-a',
    });
    claimPlanStepForWork(
      { controllerHome, repoId: 'repo-a' },
      { planId: 'PLAN-A', stepId: 'stage-a', workId: 'WORK-A', sourceRevision: 'abc123' },
    );
    bindReleasedChatgptController(controllerHome, 'WORK-A');

    let providerDispatches = 0;
    const host: ControllerHost = {
      resume: async () => {
        providerDispatches += 1;
        return { accepted: true, dispatchId: 'dispatch-' + providerDispatches };
      },
    };
    const input = {
      controllerHome,
      nowMs: Date.parse('2026-09-19T10:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: dependencies(host),
    };

    const first = await runSchedulerAutonomousContinuationReconciliation(input);
    expect(first).toMatchObject({ eligible: 1, dispatched: 1, failed: 0 });
    expect(providerDispatches).toBe(1);
    expect(getControllerRoundRelay({ controllerHome, repoId: 'repo-a' }, 'WORK-A')?.status).toBe('dispatched');

    const second = await runSchedulerAutonomousContinuationReconciliation(input);
    expect(second.dispatched).toBe(0);
    expect(second.skippedByReason['progression:CONTROLLER_ROUND_IN_FLIGHT']).toBe(1);
    expect(providerDispatches).toBe(1);
  });

  test('materializes a planless ownerless Work without inventing Plan authority', async () => {
    const controllerHome = home();
    createRunningWork(controllerHome, { workId: 'WORK-PLAIN' });
    bindReleasedChatgptController(controllerHome, 'WORK-PLAIN');

    let providerDispatches = 0;
    const host: ControllerHost = {
      resume: async () => {
        providerDispatches += 1;
        return { accepted: true, dispatchId: 'dispatch-planless' };
      },
    };
    const input = {
      controllerHome,
      nowMs: Date.parse('2026-09-19T10:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: dependencies(host),
    };

    const first = await runSchedulerAutonomousContinuationReconciliation(input);
    expect(first).toMatchObject({ eligible: 1, dispatched: 1, failed: 0 });
    const second = await runSchedulerAutonomousContinuationReconciliation(input);
    expect(second.dispatched).toBe(0);
    expect(second.skippedByReason.controller_round_present).toBe(1);
    expect(providerDispatches).toBe(1);
  });

  test('does not dispatch while a live Controller still owns the Work', async () => {
    const controllerHome = home();
    createRunningWork(controllerHome, { workId: 'WORK-LIVE' });
    const store = { controllerHome, repoId: 'repo-a' };
    const owner = claimControllerSession(store, {
      workId: 'WORK-LIVE',
      controllerId: 'controller-live',
      controllerType: 'chatgpt',
      sessionId: 'session-live',
      principalId: 'controller-live',
      controllerInstanceId: 'runtime-live',
      leaseMs: 60_000,
    });
    const adapter = upsertChatgptControllerBinding(store, {
      workId: 'WORK-LIVE',
      sessionId: owner.sessionId,
      model: 'gpt-5.6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    bindControllerSessionBinding(store, { workId: 'WORK-LIVE', sessionId: owner.sessionId, binding: adapter.binding });

    let providerDispatches = 0;
    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.now(),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: dependencies({ resume: async () => { providerDispatches += 1; return { accepted: true }; } }),
    });

    expect(result.dispatched).toBe(0);
    expect(result.skippedByReason.active_controller_session).toBe(1);
    expect(providerDispatches).toBe(0);
  });

  test('does not dispatch while the Work has active execution', async () => {
    const controllerHome = home();
    createRunningWork(controllerHome, { workId: 'WORK-ACTIVE' });
    bindReleasedChatgptController(controllerHome, 'WORK-ACTIVE');

    let providerDispatches = 0;
    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.now(),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: {
        ...dependencies({ resume: async () => { providerDispatches += 1; return { accepted: true }; } }),
        hasActiveExecution: () => true,
      },
    });

    expect(result.dispatched).toBe(0);
    expect(result.skippedByReason.active_execution).toBe(1);
    expect(providerDispatches).toBe(0);
  });
});
