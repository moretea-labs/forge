import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assessWorkMode } from '../../src/cli/controller/work-mode';
import { applyEditOperations, beginEditSession, finalizeEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { routeWorkStart } from '../../src/runtime/control-plane/facade/goal-workloop';
import { approvePlanContract, createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { selectExecutionMode } from '../../src/runtime/control-plane/facade/types';
import { routeExecutor } from '../../src/runtime/control-plane/goal-loop/executor-router';
import { decideRoute, type RoutePolicyInput } from '../../src/runtime/control-plane/routing/route-policy';
const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function sharedInput(overrides: Partial<RoutePolicyInput> = {}): RoutePolicyInput {
  return {
    intent: {
      objective: 'Apply a bounded repository fix',
      scopeClear: true,
      mutation: true,
      expectedFiles: 2,
      expectedChangedLines: 80,
    },
    workspace: { knownPaths: ['src/example.ts'], checkoutId: 'checkout-a', fingerprint: 'workspace-a' },
    policy: { risk: 'local_repo_write' },
    capabilities: {},
    recovery: {},
    ...overrides,
  };
}
function executorInput(routePolicyInput: RoutePolicyInput) {
  return {
    routePolicyInput,
    goal: {
      goalId: 'goal-a',
      repoId: 'repo-a',
      mode: 'supervised' as const,
      status: 'ready' as const,
      objective: routePolicyInput.intent.objective,
      constraints: {},
      allowedExecutors: [],
      forbiddenExecutors: [],
      repairAttempts: 0,
      retryBudget: 1,
    },
    taskIntent: 'code_implementation' as const,
    risk: 'local_repo_write' as const,
    providers: [],
  };
}
describe('single Route Policy authority', () => {
  test('returns the identical replayable RouteDecision through all three legacy adapters', () => {
    const input = sharedInput();
    const cli = assessWorkMode({ description: input.intent.objective, routePolicyInput: input }).routeDecision;
    const facade = selectExecutionMode({ scopeClear: true, routePolicyInput: input }).routeDecision;
    const goal = routeExecutor(executorInput(input)).routeDecision;
    expect(cli).toEqual(facade);
    expect(goal).toEqual(facade);
    expect(cli.inputFingerprint).toHaveLength(64);
    expect(JSON.parse(JSON.stringify(cli))).toEqual(cli);
  });
  test('keeps simple mutation direct without persistent Work lineage', () => {
    expect(decideRoute(sharedInput())).toMatchObject({
      executionMode: 'direct_control',
      executionPath: 'fast',
      requiresWork: false,
      requiresIsolation: false,
    });
    expect(decideRoute(sharedInput({
      intent: { objective: 'Read repository status', scopeClear: true, mutation: false },
      policy: { risk: 'readonly' },
    }))).toMatchObject({ executionMode: 'direct_control', requiresWork: false });
  });
  test('keeps standard dependency lockfile updates on bounded direct routing', () => {
    for (const path of ['frontend/package-lock.json', 'bun.lock', 'packages/app/pnpm-lock.yaml', 'web/yarn.lock']) {
      const decision = decideRoute(sharedInput({
        intent: { objective: 'Refresh dependency lockfile', scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 60 },
        workspace: { knownPaths: [path], checkoutId: 'checkout-a', fingerprint: 'workspace-a' },
      }));
      expect(decision.executionMode).toBe('direct_control');
      expect(decision.reasons.some((reason) => reason.code === 'protected_path')).toBe(false);
    }
  });
  test('labels complex single-owner durable work as bounded_work without Issue or Plan', () => {
    const assessment = assessWorkMode({
      description: 'Refactor one routing subsystem with investigation and resumable checks',
      knownPaths: ['src/runtime/control-plane/routing/route-policy.ts'],
      expectedFiles: 8,
      expectedChangedLines: 500,
      requiresInvestigation: true,
      requiresRecovery: true,
      risk: 'medium',
    });
    expect(assessment).toMatchObject({
      recommendedMode: 'bounded_work',
      executionPath: 'durable',
      issueRequired: false,
    });
    expect(assessment.routeDecision).toMatchObject({
      executionMode: 'goal_workloop',
      workMode: 'bounded_work',
      executionPath: 'durable',
      requiresWork: true,
    });
    expect(assessment.nextTools).toContain('rh_work(operation=start)');
  });
  test('keeps readonly investigation on the direct fast path without durable Work', () => {
    const decision = decideRoute(sharedInput({
      intent: {
        objective: 'Investigate a cross-module regression without mutating yet',
        scopeClear: true,
        mutation: false,
        expectedFiles: 6,
        expectedChangedLines: 0,
        requiresInvestigation: true,
      },
      policy: { risk: 'readonly' },
    }));
    expect(decision).toMatchObject({
      executionMode: 'direct_control',
      workMode: 'direct_edit',
      executionPath: 'fast',
      requiresWork: false,
      requiresIsolation: false,
    });
  });
  test('keeps small mutations with investigation on direct_edit fast', () => {
    const decision = decideRoute(sharedInput({
      intent: {
        objective: 'Search call sites then fix one focused helper',
        scopeClear: true,
        mutation: true,
        expectedFiles: 3,
        expectedChangedLines: 120,
        requiresInvestigation: true,
      },
      policy: { risk: 'local_repo_write' },
    }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresIsolation: false });
  });
  test('parallelism alone never implies isolation', () => {
    const readonly = decideRoute(sharedInput({
      intent: { objective: 'Search several independent areas in the same checkout', scopeClear: true, mutation: false, requiresParallelism: true },
      policy: { risk: 'readonly' },
    }));
    expect(readonly).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresIsolation: false, requiresWork: false });
    const mutating = decideRoute(sharedInput({
      intent: { objective: 'Apply two independent low-risk edits in the same checkout', scopeClear: true, mutation: true, expectedFiles: 2, expectedChangedLines: 60, requiresParallelism: true, independentTaskCount: 2 },
      policy: { risk: 'local_repo_write' },
    }));
    expect(mutating).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresIsolation: false });
    expect(mutating.reasons.some((reason) => reason.code === 'independent_deliverables')).toBe(false);
  });
  test('gives every explicit task mode executable behavior instead of a label', () => {
    const expected = {
      direct: { workMode: 'direct_edit', executionPath: 'fast', mutationPhase: 'execute', structuralContext: 'off' },
      plan: { workMode: 'bounded_work', executionPath: 'durable', mutationPhase: 'plan_only', structuralContext: 'required' },
      debug: { workMode: 'bounded_work', executionPath: 'durable', mutationPhase: 'diagnose_first', structuralContext: 'required' },
      review: { workMode: 'bounded_work', executionPath: 'durable', mutationPhase: 'read_only', structuralContext: 'off' },
      release: { workMode: 'bounded_work', executionPath: 'durable', mutationPhase: 'release_gate', structuralContext: 'off' },
      scale: { workMode: 'bounded_work', executionPath: 'durable', mutationPhase: 'benchmark', structuralContext: 'off' },
    } as const;
    for (const mode of Object.keys(expected) as Array<keyof typeof expected>) {
      const contract = expected[mode];
      const assessment = assessWorkMode({
        description: `Exercise -${mode} behavior`,
        knownPaths: ['src/example.ts'],
        expectedFiles: mode === 'direct' ? 1 : 30,
        expectedChangedLines: mode === 'direct' ? 2 : 3_000,
        explicitMode: `-${mode}` as `-${keyof typeof expected}`,
        risk: 'low',
      });
      expect(assessment.explicitMode).toBe(mode);
      expect(assessment.taskMode).toBe(mode);
      expect(assessment.routeDecision.workMode).toBe(contract.workMode);
      expect(assessment.executionPath).toBe(contract.executionPath);
      expect(assessment.modeBehavior.mutationPhase).toBe(contract.mutationPhase);
      expect(assessment.modeBehavior.structuralContext).toBe(contract.structuralContext);
      expect(assessment.modeBehavior.workflow.length).toBeGreaterThan(2);
      expect(assessment.routeDecision.reasons.some((reason) => reason.code === `explicit_${mode}`)).toBe(true);
    }
  });
  test('explicit mode overrides heuristics but never authorization or dirty-workspace gates', () => {
    const direct = assessWorkMode({
      description: 'Explicitly keep this supervised operation direct',
      knownPaths: Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`),
      expectedFiles: 20,
      expectedChangedLines: 3_000,
      requiresInvestigation: true,
      requiresParallelism: true,
      explicitMode: 'direct',
      risk: 'low',
    });
    expect(direct.routeDecision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', requiresIsolation: false });
    const blocked = decideRoute(sharedInput({
      intent: { objective: 'Unsafe direct remote mutation', scopeClear: true, mutation: true, explicitMode: 'direct' },
      policy: { risk: 'remote_write', remoteWrite: true, requiresApproval: true, approvalConfirmed: false },
    }));
    expect(blocked).toMatchObject({ executionMode: 'handoff_only', approvalState: 'normal_authorization_required' });
    const dirty = decideRoute(sharedInput({
      intent: { objective: 'Dirty direct mutation', scopeClear: true, mutation: true, explicitMode: 'direct' },
      workspace: { knownPaths: ['src/example.ts'], dirty: true },
    }));
    expect(dirty).toMatchObject({ executionMode: 'handoff_only', requiresIsolation: true });
  });
  test('routes independent deliverables through durable bounded Work without a separate lifecycle', () => {
    const decision = decideRoute(sharedInput({
      intent: {
        objective: 'Deliver three independent migration slices',
        scopeClear: true,
        mutation: true,
        expectedFiles: 9,
        expectedChangedLines: 600,
        requiresIndependentDeliverables: true,
        independentTaskCount: 3,
        agentRequested: false,
      },
    }));
    expect(decision).toMatchObject({
      executionMode: 'goal_workloop',
      workMode: 'bounded_work',
      executionPath: 'durable',
      requiresWork: true,
    });
  });
  test('keeps independent deliverables on Goal Workloop even when individually tiny', () => {
    expect(decideRoute(sharedInput({
      intent: {
        objective: 'Coordinate two tiny independent deliverables',
        scopeClear: true,
        mutation: true,
        expectedFiles: 2,
        expectedChangedLines: 40,
        requiresIndependentDeliverables: true,
        independentTaskCount: 2,
      },
    }))).toMatchObject({
      executionMode: 'goal_workloop',
      workMode: 'bounded_work',
      executionPath: 'durable',
    });
  });
  test('keeps Agent preference subordinate to routing tier topology', () => {
    expect(decideRoute(sharedInput({
      intent: {
        objective: 'Delegate a small bounded implementation',
        scopeClear: true,
        mutation: true,
        expectedFiles: 2,
        expectedChangedLines: 80,
        agentRequested: true,
      },
    }))).toMatchObject({ workMode: 'quick_agent', executionPath: 'durable', requiresWork: true });
    expect(decideRoute(sharedInput({
      intent: {
        objective: 'Delegate a large single deliverable',
        scopeClear: true,
        mutation: true,
        expectedFiles: 12,
        expectedChangedLines: 1_800,
        agentRequested: true,
      },
    }))).toMatchObject({ workMode: 'issue_task', executionPath: 'durable' });
  });
  test('allows complex Goal Workloop execution without a Plan while explicit Plan remains optional', () => {
    const root = temp('route-workloop-');
    const result = routeWorkStart({
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
      availableChecks: [{ id: 'package:check:type' }],
    }, {
      objective: 'Refactor the durable routing layer',
      acceptanceCriteria: ['One route authority'],
      allowedPaths: ['src/runtime/control-plane/**'],
      checks: ['package:check:type'],
      modeInput: {
        scopeClear: true,
        mutation: true,
        expectedFiles: 8,
        expectedChangedLines: 500,
        requiresInvestigation: true,
        requiresRecovery: true,
        risk: 'local_repo_write',
      },
    });
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('Goal workloop started');
    expect(result.summary).not.toContain('PLAN_REQUIRED');
    expect(result.data).toMatchObject({ workContractCreated: true });
  });
  test('resolves active Work before creation and routes explicit parallel work to isolation', () => { const root = temp('route-work-admission-'); const context = { workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'controller-a', sourceRevision: 'revision-a', }; const modeInput = { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' as const }; const first = routeWorkStart(context, { objective: 'Implement the primary repository change', modeInput }); expect(first.status).toBe('ok'); const firstWorkId = (first.data as { work?: { workId?: string } }).work?.workId; expect(firstWorkId).toBeTruthy(); const unresolved = routeWorkStart(context, { objective: 'Add another repository change', modeInput }); expect(unresolved.status).toBe('ok'); expect(unresolved.data).toMatchObject({ executionStarted: false, workContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true }); expect((unresolved.data as { candidates?: Array<{ workId?: string }> }).candidates).toContainEqual(expect.objectContaining({ workId: firstWorkId })); const reused = routeWorkStart(context, { objective: 'Continue the primary change', relatedWorkId: firstWorkId, workRelation: 'continue', modeInput }); expect(reused.status).toBe('ok'); expect(reused.data).toMatchObject({ workContractCreated: false, admissionDecision: 'reuse_existing', work: { workId: firstWorkId } }); const extended = routeWorkStart(context, { objective: 'Also cover the new acceptance case', relatedWorkId: firstWorkId, workRelation: 'extend', acceptanceCriteria: ['New acceptance case'], allowedPaths: ['src/new/**'], modeInput }); expect(extended.status).toBe('ok'); expect(extended.data).toMatchObject({ workContractCreated: false, admissionDecision: 'extend_existing', work: { workId: firstWorkId } }); expect(getWorkContract({ root: join(root, 'work') }, firstWorkId!)).toMatchObject({ acceptanceCriteria: ['New acceptance case'], allowedPaths: ['src/new/**'] }); const parallel = routeWorkStart(context, { objective: 'Run an independent parallel change', workRelation: 'parallel', modeInput }); expect(parallel.status).toBe('ok'); expect(parallel.data).toMatchObject({ workContractCreated: true, worktreeRequired: true }); });
  test('resolves active Work before a small mutation can take the Direct fast path', () => { const root = temp('route-direct-admission-'); const context = { workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'controller-a', sourceRevision: 'revision-a', }; const durable = routeWorkStart(context, { objective: 'Own the long-running repository change', modeInput: { scopeClear: true, mutation: true, expectedFiles: 5, expectedChangedLines: 250, requiresRecovery: true, risk: 'local_repo_write' }, }); const workId = (durable.data as { work?: { workId?: string } }).work?.workId; expect(workId).toBeTruthy(); const ambiguousSmallEdit = routeWorkStart(context, { objective: 'Make one tiny related edit', modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 5, risk: 'local_repo_write' }, }); expect(ambiguousSmallEdit.status).toBe('ok'); expect(ambiguousSmallEdit.data).toMatchObject({ workContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true }); expect(ambiguousSmallEdit.summary).not.toContain('Direct control recommended'); const continuedSmallEdit = routeWorkStart(context, { objective: 'Make one tiny related edit', relatedWorkId: workId, workRelation: 'continue', modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 5, risk: 'local_repo_write' }, }); expect(continuedSmallEdit.data).toMatchObject({ workContractCreated: false, admissionDecision: 'reuse_existing', work: { workId } }); const separateSmallEdit = routeWorkStart(context, { objective: 'Make an independent tiny fix concurrently', workRelation: 'new_goal', modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 5, risk: 'local_repo_write' }, }); expect(separateSmallEdit.status).toBe('ok'); expect(separateSmallEdit.data).toMatchObject({ workContractCreated: true, worktreeRequired: true }); });
  test('ignores low-level execution-child Work when resolving a new business task', () => { const root = temp('route-execution-child-admission-'); const workStore = { root: join(root, 'work') }; createWorkContract(workStore, { workId: 'WORK-child', repoId: 'repo-a', mode: 'direct_control', lifecycleRole: 'execution_child', objective: 'Accepted operation run_check', acceptanceCriteria: [], constraints: { requireHandoffOnAmbiguity: true }, allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'system', }); const result = routeWorkStart({ workStore, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', sourceRevision: 'revision-a' }, { objective: 'Make one independent tiny product edit', modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 4, risk: 'local_repo_write' }, }); expect(result.status).toBe('ok'); expect(result.summary).toContain('Direct control recommended'); expect(result.data).toMatchObject({ directControlPreserved: true, workContractCreated: false }); });
  test('never lets scheduler-origin start invent a new durable Work', () => { const root = temp('route-scheduler-admission-'); const result = routeWorkStart({ workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', sourceRevision: 'revision-a' }, { objective: 'Wake scheduled maintenance', requestedBy: 'scheduler', modeInput: { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' }, }); expect(result.status).toBe('ok'); expect(result.summary).toContain('SCHEDULER_WORK_BINDING_REQUIRED'); expect(result.data).toMatchObject({ executionStarted: false, workContractCreated: false, admissionDecision: 'resolution_required' }); });
  test('still binds an explicitly approved Plan step while old Plan and Work shapes remain readable', () => {
    const root = temp('route-planned-workloop-');
    const planStore = { root: join(root, 'plan') };
    createPlanContract(planStore, {
      planId: 'plan-a', repoId: 'repo-a', scopeKey: 'route-policy', sourceRevision: 'revision-a', goal: 'Review the routing strategy first',
      steps: [{
        id: 'step-a', objective: 'Implement the approved route policy', dependencies: [], authoritativeFiles: [],
        allowedPaths: ['src/runtime/control-plane/**'], forbiddenPaths: [], checks: ['package:check:type'],
        acceptanceCriteria: ['One route authority'],
      }],
    });
    approvePlanContract(planStore, 'plan-a');
    const result = routeWorkStart({
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a', availableChecks: [{ id: 'package:check:type' }],
    }, {
      objective: 'Implement the approved route policy', planId: 'plan-a', planStepId: 'step-a',
      acceptanceCriteria: ['One route authority'], allowedPaths: ['src/runtime/control-plane/**'], checks: ['package:check:type'],
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 8, expectedChangedLines: 500, requiresRecovery: true, risk: 'local_repo_write' },
    });
    const workId = (result.data as { work?: { workId?: string } }).work?.workId;
    expect(result.status).toBe('ok');
    expect(workId).toBeTruthy();
    expect(getPlanContract(planStore, 'plan-a')?.steps[0]).toMatchObject({ status: 'executing', workId });
    expect(getWorkContract({ root: join(root, 'work') }, workId!)).toMatchObject({
      repoId: 'repo-a', planId: 'plan-a', planStepId: 'step-a', mode: 'goal_workloop',
    });
    const resumed = routeWorkStart({
      workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-b', controllerInstanceId: 'controller-b', sourceRevision: 'revision-a',
    }, {
      objective: 'Implement the approved route policy', planId: 'plan-a', planStepId: 'step-a',
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 8, expectedChangedLines: 500, requiresRecovery: true, risk: 'local_repo_write' },
    });
    expect(resumed.status).toBe('ok');
    expect(resumed.summary).toContain('PLAN_STEP_REUSES_ACTIVE_WORK');
    expect(resumed.data).toMatchObject({ workContractCreated: false, admissionDecision: 'reuse_existing', work: { workId } });
  });
  test('does not let missing Plan bypass policy, destructive, or remote-write approval', () => {
    expect(decideRoute(sharedInput({
      policy: { risk: 'destructive', destructive: true, requiresApproval: true },
    }))).toMatchObject({ executionMode: 'handoff_only', requiresApproval: true, createHandoff: true });
    expect(decideRoute(sharedInput({
      policy: { risk: 'remote_write', remoteWrite: true, requiresApproval: true },
    }))).toMatchObject({ executionMode: 'handoff_only', requiresApproval: true, createHandoff: true });
  });
  test('uses deterministic provider fallback and never selects unavailable providers', () => {
    const decision = decideRoute(sharedInput({
      intent: {
        objective: 'Implement the change', scopeClear: true, mutation: true,
        taskIntent: 'code_implementation', agentRequested: true,
      },
      capabilities: {
        providers: [
          { providerId: 'codex', kind: 'local_cli', status: 'unavailable', capabilities: ['code_patch'], directDispatch: true },
          { providerId: 'claude', kind: 'remote_api', status: 'ready', capabilities: ['code_patch'], directDispatch: true },
        ],
        routingOrders: { implementation: ['codex', 'claude'] },
      },
    }));
    expect(decision.selectedProviderId).toBe('claude');
    expect(decision.alternatives).toEqual(['claude']);
  });
  test('blocks implicit dirty-workspace adoption', () => {
    const decision = decideRoute(sharedInput({ workspace: { dirty: true, checkoutId: 'checkout-a', fingerprint: 'dirty-a' } }));
    expect(decision).toMatchObject({ executionMode: 'handoff_only', requiresIsolation: true, createHandoff: true });
    expect(decision.reasons.map((reason) => reason.code)).toContain('dirty_workspace_requires_explicit_adoption');
  });
  test('produces a stable fingerprint independent of object insertion order', () => {
    const first = decideRoute(sharedInput());
    const second = decideRoute({
      recovery: {}, capabilities: {}, policy: { risk: 'local_repo_write' },
      workspace: { fingerprint: 'workspace-a', checkoutId: 'checkout-a', knownPaths: ['src/example.ts'] },
      intent: {
        expectedChangedLines: 80, expectedFiles: 2, mutation: true,
        scopeClear: true, objective: 'Apply a bounded repository fix',
      },
    });
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.policyVersion).toBe(second.policyVersion);
  });
});
describe('EditSession identity and post-diff assurance', () => {
  function gitRepo(): string {
    const root = temp('route-edit-');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'README.md'), '# Test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    return root;
  }
  test('blocks patch execution when workspace fingerprint changes', () => {
    const root = gitRepo();
    const session = beginEditSession(root, {
      purpose: 'Bound edit', allowedPaths: ['src/**'],
      binding: { workId: 'work-a', repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a' },
    });
    writeFileSync(join(root, 'outside.txt'), 'unowned change\n');
    expect(() => applyEditOperations(root, getMcpPolicy('executor'), session.sessionId, [
      { type: 'create', path: 'src/example.ts', content: 'export const value = 1;\n' },
    ], {
      binding: { workId: 'work-a', repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a' },
    })).toThrow('EDIT_SESSION_WORKSPACE_FINGERPRINT_CHANGED');
  });
  test('raises assurance when the real diff touches a protected path', () => {
    const root = gitRepo();
    const session = beginEditSession(root, {
      purpose: 'Workflow edit', allowedPaths: ['.github/**'],
      binding: { workId: 'work-a', repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a' },
    });
    const updated = applyEditOperations(root, getMcpPolicy('controller'), session.sessionId, [
      { type: 'create', path: '.github/protected.yml', content: 'name: checks\n' },
    ], {
      binding: { workId: 'work-a', repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a' },
    });
    expect(updated.assurance).toMatchObject({ semanticRisk: 'high', approvalRequired: true, verificationDepth: 'architecture' });
    expect(updated.requestedChecks).toContain('package:check:runtime-architecture');
    expect(() => finalizeEditSession(root, session.sessionId, {
      binding: { workId: 'work-a', repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a' },
    })).toThrow('EDIT_SESSION_APPROVAL_REQUIRED');
    expect(readFileSync(join(root, '.github/protected.yml'), 'utf8')).toContain('checks');
  });
});
