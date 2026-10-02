import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acknowledgeControllerRoundClaim,
  beginControllerRoundProviderDispatch,
  beginInitialControllerRoundDispatch,
  bindControllerSessionBinding,
  claimControllerSession,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getRequirementControllerRoundRelay,
  prepareControllerRoundOccurrence,
  reconcileControllerRoundAfterTerminalWork,
  releaseControllerSession,
  submitControllerRoundDisposition,
} from '../../packages/kernel/controller/api/index';
import { cancelWorkContract, createWorkContract, createWorkSemanticContext, getWorkContract, listWorkContracts } from '../../packages/kernel/work/api/index';
import { upsertChatgptControllerBinding } from '../../adapters/chatgpt/controller-binding-store';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import {
  createPlanContract,
  createPlanSemanticContext,
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

function enrollmentDependencies(enrollments: { count: number }) {
  return {
    authorizeWake: () => undefined,
    ensureSupervisorEnrollment: async () => {
      enrollments.count += 1;
      return { status: 'enrolled' as const, taskId: 'task-supervisor', effectId: 'effect-supervisor' };
    },
    hostForBinding: () => ({
      resume: async () => {
        throw new Error('Scheduler must not drive Browser delivery for a ChatGPT Work');
      },
    }),
  };
}

describe('autonomous Work liveness reconciliation', () => {
  test('materializes an ownerless Plan Work and enrolls the Workflow Supervisor', async () => {
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
    createRunningWork(controllerHome, {
      workId: 'WORK-A',
      requirementId: 'REQ-A',
      planId: 'PLAN-A',
      planStepId: 'stage-a',
    });
    bindReleasedChatgptController(controllerHome, 'WORK-A');

    const enrollments = { count: 0 };
    const input = {
      controllerHome,
      nowMs: Date.parse('2026-09-19T10:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: enrollmentDependencies(enrollments),
    };

    const first = await runSchedulerAutonomousContinuationReconciliation(input);
    expect(first).toMatchObject({ eligible: 1, supervisorEnrolled: 1, dispatched: 0, failed: 0 });
    expect(enrollments.count).toBe(1);
    expect(getControllerRoundRelay({ controllerHome, repoId: 'repo-a' }, 'WORK-A')?.status).toBe('dispatching');
  });

  test('enrolls Supervisor for an incomplete dispatching round when no provider effect physically started', async () => {
    const controllerHome = home();
    const store = { controllerHome, repoId: 'repo-a' };
    createWorkSemanticContext({ controllerHome, scopeKey: 'semantic' }, {
      workId: 'WORK-INCOMPLETE-DISPATCH', objective: 'Resume canonical semantic authority omitted by the repo projection.',
    });
    expect(listWorkContracts({ ...store, status: 'active' })).toEqual([]);
    expect(getWorkContract(store, 'WORK-INCOMPLETE-DISPATCH')?.semanticState).toBe('open');
    const binding = bindReleasedChatgptController(controllerHome, 'WORK-INCOMPLETE-DISPATCH');
    const prepared = prepareControllerRoundOccurrence(store, {
      occurrenceId: 'incomplete-dispatch-occurrence',
      workId: 'WORK-INCOMPLETE-DISPATCH',
      controllerBindingId: binding.bindingId,
    });
    expect(prepared.outcome).toBe('dispatched');
    const incomplete = getControllerRoundRelay(store, 'WORK-INCOMPLETE-DISPATCH');
    expect(incomplete?.status).toBe('dispatching');
    expect(incomplete?.providerDispatchStartedAt).toBeUndefined();
    expect(incomplete?.providerDispatchEffectId).toBeUndefined();

    const enrollments = { count: 0 };
    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.parse('2026-09-19T10:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: enrollmentDependencies(enrollments),
    });

    expect(result).toMatchObject({ eligible: 1, supervisorEnrolled: 1, dispatched: 0, failed: 0 });
    expect(enrollments.count).toBe(1);
    expect(getControllerRoundRelay(store, 'WORK-INCOMPLETE-DISPATCH')?.status).toBe('dispatching');
  });

  test('skips a dispatching round once provider dispatch has physically started', async () => {
    const controllerHome = home();
    const store = { controllerHome, repoId: 'repo-a' };
    const workId = 'WORK-PROVIDER-DISPATCH-STARTED';
    createRunningWork(controllerHome, { workId });
    const binding = bindReleasedChatgptController(controllerHome, workId);
    const prepared = prepareControllerRoundOccurrence(store, {
      occurrenceId: 'provider-dispatch-started-occurrence',
      workId,
      controllerBindingId: binding.bindingId,
    });
    expect(prepared.outcome).toBe('dispatched');
    const started = beginControllerRoundProviderDispatch(store, {
      workId,
      authorityId: prepared.relay.authorityId!,
      expectedUpdatedAt: prepared.relay.updatedAt,
      bindingId: binding.bindingId,
    });
    expect(started.status).toBe('dispatching');
    expect(started.providerDispatchStartedAt).toBeDefined();

    const enrollments = { count: 0 };
    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.parse('2026-09-19T10:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: enrollmentDependencies(enrollments),
    });

    expect(result).toMatchObject({
      eligible: 0,
      supervisorEnrolled: 0,
      dispatched: 0,
      failed: 0,
      skippedByReason: { controller_round_dispatching: 1 },
    });
    expect(enrollments.count).toBe(0);
    expect(getControllerRoundRelay(store, workId)?.providerDispatchStartedAt).toBe(started.providerDispatchStartedAt);
  });

  test('enrolls Supervisor for a planless ownerless Work without inventing Plan authority', async () => {
    const controllerHome = home();
    createRunningWork(controllerHome, { workId: 'WORK-PLAIN' });
    bindReleasedChatgptController(controllerHome, 'WORK-PLAIN');

    const enrollments = { count: 0 };
    const input = {
      controllerHome,
      nowMs: Date.parse('2026-09-19T10:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: enrollmentDependencies(enrollments),
    };

    const first = await runSchedulerAutonomousContinuationReconciliation(input);
    expect(first).toMatchObject({ eligible: 1, supervisorEnrolled: 1, dispatched: 0, failed: 0 });
    expect(enrollments.count).toBe(1);
  });

  test('thin Plan provenance never becomes Scheduler step authority and enrolls Supervisor', async () => {
    const controllerHome = home();
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-THIN-PLAN',
      title: 'Thin Plan liveness',
      outcomeStatement: 'Continue Work mechanically without PlanStep scheduling authority.',
    });
    createPlanSemanticContext({ controllerHome, repoId: 'repo-a' }, {
      planId: 'PLAN-THIN',
      repoId: 'repo-a',
      requirementId: 'REQ-THIN-PLAN',
      scopeKey: 'thin-plan-liveness',
      sourceBasisRevision: 'abc123',
      goal: 'Keep model-authored working memory without owning execution.',
      items: [{ id: 'item-a', objective: 'Describe the next useful slice.', dependencies: [] }],
    });
    createRunningWork(controllerHome, {
      workId: 'WORK-THIN-PLAN',
      requirementId: 'REQ-THIN-PLAN',
      planId: 'PLAN-THIN',
    });
    bindReleasedChatgptController(controllerHome, 'WORK-THIN-PLAN');

    const enrollments = { count: 0 };
    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.parse('2026-09-19T10:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: enrollmentDependencies(enrollments),
    });

    expect(result).toMatchObject({ eligible: 1, supervisorEnrolled: 1, dispatched: 0, failed: 0 });
    expect(result.skippedByReason['progression:PLAN_EMPTY'] ?? 0).toBe(0);
    expect(enrollments.count).toBe(1);
  });

  test('prepares the lower ControllerRound before Supervisor enrollment and retires a failed stale Requirement relay', async () => {
    const controllerHome = home();
    const store = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-SUPERVISOR',
      title: 'Supervisor Requirement',
      outcomeStatement: 'Continue the current plan without manual wakeups.',
    });

    createRunningWork(controllerHome, { workId: 'WORK-STALE', requirementId: 'REQ-SUPERVISOR' });
    const staleBinding = bindReleasedChatgptController(controllerHome, 'WORK-STALE');
    prepareControllerRoundOccurrence(store, {
      occurrenceId: 'stale-occurrence',
      workId: 'WORK-STALE',
      controllerBindingId: staleBinding.bindingId,
      relayScopeId: 'requirement:REQ-SUPERVISOR',
    });
    cancelWorkContract(store, 'WORK-STALE', { summary: 'Stale predecessor was semantically superseded.' });

    createPlanContract({ controllerHome, repoId: 'repo-a' }, {
      planId: 'PLAN-SUPERVISOR',
      repoId: 'repo-a',
      requirementId: 'REQ-SUPERVISOR',
      scopeKey: 'scope-supervisor',
      sourceRevision: 'abc123',
      goal: 'Continue one supervised stage.',
      nonGoals: [],
      assumptions: [],
      resolvedDecisions: [],
      stopConditions: [],
      replanConditions: [],
      steps: [{
        id: 'stage-current',
        objective: 'Execute the current stage.',
        dependencies: [],
        authoritativeFiles: [],
        allowedPaths: [],
        forbiddenPaths: [],
        checks: ['package:check:type'],
        acceptanceCriteria: ['Supervisor enrollment follows canonical ControllerRound preparation.'],
      }],
    });
    createRunningWork(controllerHome, {
      workId: 'WORK-CURRENT',
      requirementId: 'REQ-SUPERVISOR',
      planId: 'PLAN-SUPERVISOR',
      planStepId: 'stage-current',
    });
    bindReleasedChatgptController(controllerHome, 'WORK-CURRENT');

    let enrollments = 0;
    let providerDispatches = 0;
    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.parse('2026-09-20T06:40:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: {
        authorizeWake: () => undefined,
        ensureSupervisorEnrollment: async (_options, workId) => {
          const relay = getControllerRoundRelay(store, workId);
          expect(relay).toMatchObject({
            status: 'dispatching',
            originWorkId: 'WORK-CURRENT',
            relayScopeId: 'requirement:REQ-SUPERVISOR',
          });
          enrollments += 1;
          return { status: 'enrolled' as const, taskId: 'task-supervisor', effectId: 'effect-supervisor' };
        },
        hostForBinding: () => ({ resume: async () => { providerDispatches += 1; return { accepted: true }; } }),
      },
    });

    expect(result).toMatchObject({ eligible: 1, supervisorEnrolled: 1, dispatched: 0, failed: 0 });
    expect(enrollments).toBe(1);
    expect(providerDispatches).toBe(0);
    expect(getControllerRoundRelay(store, 'WORK-STALE')?.status).toBe('failed');
    expect(getControllerRoundRelay(store, 'WORK-CURRENT')?.status).toBe('dispatching');
  });

  test('bootstraps one dedicated fresh ChatGPT execution conversation when no conversation is bound yet', async () => {
    const controllerHome = home();
    const workId = 'WORK-FRESH-EXECUTION-TRANSPORT';
    const store = { controllerHome, repoId: 'repo-a' };
    createRunningWork(controllerHome, { workId });

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
      browserSessionId: 'prepared-fresh-session',
      title: 'dedicated execution transport',
      model: 'gpt-5.6',
      reasoning: 'high',
      tabPolicy: 'new',
      transportConversation: 'fresh',
    });
    bindControllerSessionBinding(store, { workId, sessionId: owner.sessionId, binding: adapter.binding });
    releaseControllerSession(store, workId, owner.controllerId);

    const relay = beginInitialControllerRoundDispatch(store, {
      workId,
      occurrenceId: 'launcher_start:WORK-FRESH-EXECUTION-TRANSPORT:proof',
      identity: {
        controllerId: 'controller-a',
        controllerType: 'chatgpt',
        sessionId: 'session-' + workId,
        principalId: 'controller-a',
        controllerInstanceId: 'runtime-a',
      },
    });
    expect(relay.status).toBe('dispatching');

    let enrollments = 0;
    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.parse('2026-09-28T14:45:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: {
        authorizeWake: () => undefined,
        ensureSupervisorEnrollment: async () => {
          enrollments += 1;
          return { status: 'enrolled' as const, taskId: 'task-fresh', effectId: 'effect-fresh' };
        },
      },
    });

    expect(result).toMatchObject({ eligible: 1, supervisorEnrolled: 1, dispatched: 0, failed: 0 });
    expect(enrollments).toBe(1);
    expect(getControllerRoundRelay(store, workId)).toMatchObject({ status: 'dispatching', originWorkId: workId });
  });

  test('Requirement relay lookup prefers a live relay over a newer retired terminal sibling', () => {
    const controllerHome = home();
    let now = '2026-09-20T07:00:00.000Z';
    const store = { controllerHome, repoId: 'repo-a', now: () => now };
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-RELAY-AUTHORITY',
      title: 'Requirement relay authority',
      outcomeStatement: 'Retired sibling relay must not shadow the live Requirement relay.',
    });

    createRunningWork(controllerHome, { workId: 'WORK-LIVE-RELAY', requirementId: 'REQ-RELAY-AUTHORITY' });
    const liveBinding = bindReleasedChatgptController(controllerHome, 'WORK-LIVE-RELAY');
    const live = prepareControllerRoundOccurrence(store, {
      occurrenceId: 'live-relay-occurrence',
      workId: 'WORK-LIVE-RELAY',
      controllerBindingId: liveBinding.bindingId,
      relayScopeId: 'requirement:REQ-RELAY-AUTHORITY',
    }).relay;
    expect(live.status).toBe('dispatching');

    now = '2026-09-20T07:01:00.000Z';
    createRunningWork(controllerHome, { workId: 'WORK-RETIRED-SIBLING', requirementId: 'REQ-RELAY-AUTHORITY' });
    const retiredBinding = bindReleasedChatgptController(controllerHome, 'WORK-RETIRED-SIBLING');
    prepareControllerRoundOccurrence(store, {
      occurrenceId: 'retired-relay-occurrence',
      workId: 'WORK-RETIRED-SIBLING',
      controllerBindingId: retiredBinding.bindingId,
      relayScopeId: 'requirement:REQ-RELAY-AUTHORITY',
    });
    cancelWorkContract(store, 'WORK-RETIRED-SIBLING', { summary: 'Retire the duplicate sibling carrier.' });
    reconcileControllerRoundAfterTerminalWork(store, { workId: 'WORK-RETIRED-SIBLING' });

    const selected = getRequirementControllerRoundRelay(store, 'REQ-RELAY-AUTHORITY');
    expect(selected).toMatchObject({
      originWorkId: 'WORK-LIVE-RELAY',
      status: 'dispatching',
      relayScopeId: 'requirement:REQ-RELAY-AUTHORITY',
    });
  });

  test('does not retry a ControllerRound that already exhausted its round budget', async () => {
    const controllerHome = home();
    const workId = 'WORK-ROUND-BUDGET-EXHAUSTED';
    const store = { controllerHome, repoId: 'repo-a' };
    createRunningWork(controllerHome, { workId });
    bindReleasedChatgptController(controllerHome, workId);

    const identity = {
      controllerId: 'controller-a',
      controllerType: 'chatgpt' as const,
      principalId: 'controller-a',
      controllerInstanceId: 'runtime-a',
    };
    const first = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { ...identity, sessionId: `session-${workId}` },
      maxRounds: 1,
      maxRepeatedState: 8,
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const session = claimControllerSession(store, {
      workId,
      ...identity,
      sessionId: `session-${workId}`,
      leaseMs: 60_000,
    });
    acknowledgeControllerRoundClaim(store, { workId, session });
    const blocked = submitControllerRoundDisposition(store, {
      workId,
      relayScopeId: first.relayScopeId,
      identity: { ...identity, sessionId: session.sessionId },
      disposition: 'continue_immediately',
    });
    releaseControllerSession(store, workId, identity.controllerId);
    expect(blocked).toMatchObject({
      status: 'blocked',
      roundCount: 2,
      maxRounds: 1,
      blockedReason: 'round_budget_exhausted:2>1',
    });

    let wakeAuthorizations = 0;
    const input = {
      controllerHome,
      nowMs: Date.parse('2026-09-28T09:00:00.000Z'),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: {
        authorizeWake: () => { wakeAuthorizations += 1; },
      },
    };

    const firstReconciliation = await runSchedulerAutonomousContinuationReconciliation(input);
    const secondReconciliation = await runSchedulerAutonomousContinuationReconciliation({
      ...input,
      nowMs: input.nowMs + 60_000,
    });

    expect(firstReconciliation).toMatchObject({ eligible: 0, dispatched: 0, failed: 0 });
    expect(secondReconciliation).toMatchObject({ eligible: 0, dispatched: 0, failed: 0 });
    expect(firstReconciliation.skippedByReason.controller_round_blocked).toBe(1);
    expect(secondReconciliation.skippedByReason.controller_round_blocked).toBe(1);
    expect(wakeAuthorizations).toBe(0);
    expect(getControllerRoundRelay(store, workId)).toMatchObject({
      status: 'blocked',
      roundCount: 2,
      blockedReason: 'round_budget_exhausted:2>1',
    });
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

    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.now(),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
    });

    expect(result.dispatched).toBe(0);
    expect(result.skippedByReason.active_controller_session).toBe(1);
  });

  test('does not dispatch while the Work has active execution', async () => {
    const controllerHome = home();
    createRunningWork(controllerHome, { workId: 'WORK-ACTIVE' });
    bindReleasedChatgptController(controllerHome, 'WORK-ACTIVE');

    const result = await runSchedulerAutonomousContinuationReconciliation({
      controllerHome,
      nowMs: Date.now(),
      repositories: [{ repoId: 'repo-a', canonicalRoot: controllerHome, localRoot: controllerHome }],
      dependencies: {
        hasActiveExecution: () => true,
      },
    });

    expect(result.dispatched).toBe(0);
    expect(result.skippedByReason.active_execution).toBe(1);
  });
});
