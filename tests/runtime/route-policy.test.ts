import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assessWorkMode } from '../../src/cli/controller/work-mode';
import { applyEditOperations, beginEditSession, finalizeEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { continueGoalWorkloop, finalizeGoalWorkloop, routeWorkStart, runGoalWorkloop, verifyGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
import { acceptPlanStepEvidence, approvePlanContract, completePlanStepForWork, createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { appendWorkEvidence, createWorkContract, getWorkContract, listWorkContracts, recordWorkCompletionReceipt, recordWorkImplementationReview, recordWorkScopeEvidence, requestWorkImplementationReview, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { selectExecutionMode } from '../../src/runtime/control-plane/facade/types';
import { implementationReviewChangedPathDigest } from '../../src/runtime/control-plane/facade/work-implementation-review';
import { getHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { decideRoute, type RoutePolicyInput } from '../../src/runtime/control-plane/routing/route-policy';
import { trustedEngineeringEvidence } from '../helpers/engineering-evidence';
const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function highEngineeringEvidence(sourceRevision = 'revision-a') {
  return trustedEngineeringEvidence(sourceRevision);
}

function completeNoChangePlanWork(workStore: { root: string }, workId: string, reviewId: string): void {
  const recordedAt = '2026-09-02T00:00:00.000Z';
  transitionWorkContractPhase(workStore, workId, { status: 'running', phase: 'verification', state: 'satisfied', summary: 'Exact no-change Plan slice verified.' });
  requestWorkImplementationReview(workStore, workId, 'Plan slice requires explicit Controller review before completion.');
  recordWorkImplementationReview(workStore, workId, {
    schemaVersion: 1,
    reviewId,
    workId,
    reviewerPrincipalId: 'principal-a',
    reviewerControllerSessionId: 'transport-plan-successor',
    decision: 'approved',
    rationale: 'The exact no-change Plan slice is reviewed before successor admission.',
    findings: [],
    sourceRevision: 'revision-a',
    workspaceFingerprint: `${workId}:content`,
    verificationWorkspaceFingerprint: `${workId}:verification`,
    changedPaths: [],
    changedPathDigest: implementationReviewChangedPathDigest([]),
    acceptanceCriteriaSummary: 'Plan slice delivery is ready for semantic acceptance.',
    verificationEvidence: [],
    architectureEvidence: [],
    recordedAt,
  });
  recordWorkCompletionReceipt(workStore, workId, {
    schemaVersion: 1, receiptId: `receipt-${reviewId}`, source: 'controller_work', issueId: workId, taskId: workId, workId,
    targetBranch: 'kernel-v2/architecture', targetRevision: 'revision-a', changedPaths: [],
    delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
    cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
    verifiedAt: recordedAt, recordedAt,
  }, 'completed_no_change', 'completed_no_change');
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
describe('single Route Policy authority', () => {
  test('advances a no-check repository Work only with source changes plus exact durable Process evidence', () => {
    const root = temp('forge-no-check-process-evidence-');
    const workStore = { root: join(root, 'work') };
    const context = {
      workStore,
      handoffStore: { root: join(root, 'handoffs') },
      repoId: 'repo-no-check-process-evidence',
      availableChecks: [],
      sourceRevision: 'revision-a',
      workspaceFingerprint: 'workspace-a',
      workspaceChangedPaths: ['src/example.ts'],
    };
    const started = routeWorkStart(context, {
      objective: 'Apply and validate one bounded repository repair without a named check.',
      acceptanceCriteria: ['The repository repair has durable Work-bound execution evidence.'],
      modeInput: {
        scopeClear: true,
        mutation: true,
        expectedFiles: 1,
        expectedChangedLines: 20,
        requiresRecovery: true,
        risk: 'local_repo_write',
      },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();

    const blocked = continueGoalWorkloop(context, { workId: workId! });
    expect(blocked.status).toBe('blocked');
    expect(blocked.summary).toContain('No durable result evidence');

    const continued = continueGoalWorkloop({
      ...context,
      workBoundProcessEvidenceIds: ['proc-exact-work-bound-success'],
    }, { workId: workId! });
    expect(continued.status).toBe('ok');
    expect(continued.data).toMatchObject({ nextStep: 'review' });
  });
  test('returns the identical replayable RouteDecision through the remaining adapters', () => {
    const input = sharedInput();
    const cli = assessWorkMode({ description: input.intent.objective, routePolicyInput: input }).routeDecision;
    const facade = selectExecutionMode({ scopeClear: true, routePolicyInput: input }).routeDecision;
    expect(cli).toEqual(facade);
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
  test('never promotes a single deliverable from predicted file or line count alone', () => {
    const decision = decideRoute(sharedInput({
      intent: {
        objective: 'Refactor one large but continuously owned subsystem',
        scopeClear: true,
        mutation: true,
        expectedFiles: 80,
        expectedChangedLines: 12_000,
        requiresInvestigation: true,
      },
      workspace: { knownPaths: [], checkoutId: 'checkout-a', fingerprint: 'workspace-a' },
    }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false });
  });
  test('never promotes ordinary long checks from duration alone', () => {
    const decision = decideRoute(sharedInput({
      intent: {
        objective: 'Run the focused integration check after one local edit',
        scopeClear: true,
        mutation: true,
        requiresLongRunningChecks: true,
      },
    }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresRecovery: false });
    expect(decision.reasons).toContainEqual(expect.objectContaining({ code: 'long_checks' }));
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
      debug: { workMode: 'direct_edit', executionPath: 'fast', mutationPhase: 'diagnose_first', structuralContext: 'required' },
      review: { workMode: 'direct_edit', executionPath: 'fast', mutationPhase: 'read_only', structuralContext: 'off' },
      release: { workMode: 'bounded_work', executionPath: 'durable', mutationPhase: 'release_gate', structuralContext: 'off' },
      scale: { workMode: 'bounded_work', executionPath: 'durable', mutationPhase: 'coordinate', structuralContext: 'off' },
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
      if (mode === 'scale') {
        expect(assessment.modeBehavior.planRequired).toBe(true);
        expect(assessment.modeBehavior.worktreeRequired).toBe(true);
      }
      expect(assessment.modeBehavior.workflow.length).toBeGreaterThan(2);
      expect(assessment.routeDecision.reasons.some((reason) => reason.code === `explicit_${mode}`)).toBe(true);
    }
  });
  test('typed isolated placement overrides an explicit Direct routing preference before admission', () => {
    const decision = decideRoute(sharedInput({
      intent: { objective: 'Apply one isolated edit', scopeClear: true, mutation: true, explicitMode: 'direct' },
      workspace: { knownPaths: ['src/example.ts'], placement: 'isolated', directMainProhibited: true },
    }));
    expect(decision).toMatchObject({
      executionMode: 'goal_workloop',
      executionPath: 'durable',
      requiresWork: true,
      requiresIsolation: true,
    });
    expect(decision.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['placement_isolated', 'direct_main_prohibited']));
  });

  test('routeWorkStart canonicalizes typed isolated placement and refuses force_mode Direct downgrade', () => {
    // Explicit placement behavior remains covered below. Dirty canonical checkout
    // isolation for durable Goal Work has a separate regression because fast
    // Direct Control intentionally keeps its existing dirty-workspace semantics.

    const root = temp('route-isolated-placement-');
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-isolated-placement',
      checkoutId: 'checkout-main',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
    };
    const input = {
      objective: 'Apply one explicitly isolated repository repair',
      constraints: { workspaceMode: 'isolated' as const, directMainProhibited: true },
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 5, risk: 'local_repo_write' as const },
    };
    const started = routeWorkStart(context, input);
    expect(started.status).toBe('ok');
    expect(started.data).toMatchObject({ workContractCreated: true, worktreeRequired: true });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    const stored = getWorkContract(context.workStore, workId!);
    expect(stored).toMatchObject({
      constraints: { workspaceMode: 'isolated', requireWorktree: true, directMainProhibited: true },
      worktreePolicy: { required: true },
      routeDecision: { requiresIsolation: true, executionMode: 'goal_workloop' },
    });
    expect(stored?.checkoutId).toBeUndefined();

    const forced = routeWorkStart({ ...context, workStore: { root: join(root, 'forced-work') }, handoffStore: { root: join(root, 'forced-handoff') } }, {
      ...input,
      forceMode: 'direct_control',
    });
    expect(forced.status).toBe('blocked');
    expect(forced.summary).toContain('WORKSPACE_PLACEMENT_DIRECT_CONTROL_FORBIDDEN');
    expect(forced.data).toMatchObject({ executionStarted: false, workContractCreated: false });
  });

  test('durable Goal Work isolates a trusted dirty canonical checkout without changing fast Direct Control routing', () => {
    const root = temp('route-dirty-goal-isolation-');
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-dirty-goal-isolation',
      checkoutId: 'checkout-main',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
      workspaceDirty: true,
    };
    const started = routeWorkStart(context, {
      objective: 'Run one recoverable repository repair without absorbing unrelated dirty changes',
      modeInput: {
        scopeClear: true,
        mutation: true,
        requiresRecovery: true,
        expectedFiles: 1,
        expectedChangedLines: 5,
        risk: 'local_repo_write',
      },
    });
    expect(started.status).toBe('ok');
    expect(started.data).toMatchObject({ workContractCreated: true, worktreeRequired: true });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    const stored = getWorkContract(context.workStore, workId!);
    expect(stored).toMatchObject({
      mode: 'goal_workloop',
      constraints: { workspaceMode: 'isolated', requireWorktree: true },
      worktreePolicy: { required: true },
    });
    expect(stored?.routeDecision?.reasons.map((reason) => reason.code)).toContain('dirty_workspace_preserve_existing_changes');

    const direct = decideRoute(sharedInput({
      intent: { objective: 'Keep a bounded direct mutation on the dirty current checkout', scopeClear: true, mutation: true, explicitMode: 'direct' },
      workspace: { knownPaths: ['src/example.ts'], dirty: true },
    }));
    expect(direct).toMatchObject({ executionMode: 'direct_control', requiresIsolation: false, requiresWork: false });
  });

  test('preserves typed isolated placement across an approval handoff replay', () => {
    const root = temp('route-isolated-approval-');
    const handoffStore = { root: join(root, 'handoff') };
    const result = routeWorkStart({
      workStore: { root: join(root, 'work') },
      handoffStore,
      repoId: 'repo-isolated-approval',
    }, {
      objective: 'Apply an isolated change after explicit approval',
      constraints: { workspaceMode: 'isolated', directMainProhibited: true },
      modeInput: { scopeClear: true, mutation: true, requiresUserApproval: true, risk: 'workspace_write' },
    });
    expect(result.status).toBe('approval_required');
    const handoffId = (result.data as { handoffId?: string }).handoffId;
    expect(handoffId).toBeTruthy();
    const handoff = getHandoffItem(handoffStore, handoffId!);
    expect(handoff?.approvalAction?.payload).toMatchObject({
      workspaceMode: 'isolated',
      requireWorktree: true,
      directMainProhibited: true,
      forceMode: 'goal_workloop',
    });
  });

  test('rejects contradictory typed workspace placement instead of guessing a lane', () => {
    const root = temp('route-placement-conflict-');
    const result = routeWorkStart({
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-placement-conflict',
    }, {
      objective: 'Conflicting placement request',
      constraints: { workspaceMode: 'current', requireWorktree: true },
      modeInput: { scopeClear: true, mutation: true, risk: 'local_repo_write' },
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('WORKSPACE_PLACEMENT_CONSTRAINT_CONFLICT');
    expect(result.data).toMatchObject({ executionStarted: false, workContractCreated: false, placementConstraintConflict: true });
  });

  test('explicit mode overrides heuristics while authorization remains authoritative and dirty evidence stays direct', () => {
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
    expect(dirty).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresIsolation: false });
    expect(dirty.reasons.map((reason) => reason.code)).toContain('dirty_workspace_preserve_existing_changes');
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
  test('does not let caller-supplied engineering receipt ids self-authorize high-risk repository-change admission', () => {
    const root = temp('route-engineering-admission-');
    const context = {
      workStore: { root: join(root, 'blocked-work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
    };
    const blocked = runGoalWorkloop(context, 'start', {
      objective: 'Publish one high-risk repository change with an external delivery effect',
      scope_clear: true,
      expected_files: 1,
      requires_recovery: true,
      requires_external_effect: true,
      remote_write: true,
      risk: 'remote_write',
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.summary).toContain('ENGINEERING_ADMISSION_EVIDENCE_REQUIRED');
    expect(blocked.data).toMatchObject({ workContractCreated: false, missingEngineeringEvidence: ['project_contract', 'context_closure', 'product_dod', 'design_decision', 'independent_critique'] });
    expect(listWorkContracts({ root: join(root, 'blocked-work'), status: 'all' })).toHaveLength(0);

    const claimed = runGoalWorkloop({ ...context, workStore: { root: join(root, 'claimed-work') } }, 'start', {
      objective: 'Publish one high-risk repository change with an external delivery effect',
      scope_clear: true,
      expected_files: 1,
      requires_recovery: true,
      requires_external_effect: true,
      remote_write: true,
      risk: 'remote_write',
      // Frozen/unknown clients may still send this property at runtime, but the
      // stable facade schema does not expose it and the parser must ignore it.
      engineering_evidence: {
        project_contract_receipt: {
          schema_version: 1, contract_path: '.forge/project-engineering.json', project_id: 'forged',
          contract_id: 'forged', contract_version: '1', source_revision: 'revision-a',
          content_digest: 'a'.repeat(64), loaded_at: '2026-09-03T00:00:00.000Z',
        },
        context_closure_receipt_id: 'invented-context',
        product_dod_receipt_id: 'invented-dod',
        design_decision_receipt_id: 'invented-design',
        independent_critique_receipt_id: 'invented-critique',
      },
    });
    expect(claimed.status).toBe('blocked');
    expect(claimed.summary).toContain('ENGINEERING_ADMISSION_EVIDENCE_REQUIRED');
    expect(listWorkContracts({ root: join(root, 'claimed-work'), status: 'all' })).toHaveLength(0);

    const hiddenFieldStore = { root: join(root, 'hidden-field-work') };
    const hiddenField = runGoalWorkloop({ ...context, workStore: hiddenFieldStore }, 'start', {
      objective: 'Attempt hidden trusted evidence injection for repository change',
      acceptance_criteria: ['Raw args cannot cross the trusted evidence boundary'],
      scope_clear: true,
      mutation: true,
      expected_files: 1,
      requires_recovery: true,
      requires_external_effect: true,
      remote_write: true,
      risk: 'remote_write',
      __verified_engineering_evidence: highEngineeringEvidence(),
    });
    expect(hiddenField.status).toBe('blocked');
    expect(hiddenField.summary).toContain('ENGINEERING_ADMISSION_EVIDENCE_REQUIRED');
    expect(listWorkContracts({ ...hiddenFieldStore, status: 'all' })).toHaveLength(0);

    const trustedStore = { root: join(root, 'trusted-work') };
    const trusted = routeWorkStart({ ...context, workStore: trustedStore }, {
      objective: 'Run one internally verified high-risk repository change with remote delivery',
      acceptanceCriteria: ['Verified engineering evidence is persisted'],
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, requiresRecovery: true, requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write' },
      verifiedEngineeringEvidence: highEngineeringEvidence(),
    });
    expect(trusted.status).toBe('ok');
    const trustedWorkId = (trusted.data as { work?: { workId?: string } }).work?.workId;
    expect(trustedWorkId).toBeTruthy();
    expect(getWorkContract(trustedStore, trustedWorkId!)).toMatchObject({
      risk: 'high',
      engineeringContext: {
        riskClass: 'high',
        missingAdmissionEvidence: [],
        projectContractReceipt: { sourceRevision: 'revision-a', contractId: 'forge-test-engineering' },
      },
    });
  });

  test('persists exact remote delivery for repository-change Work without converting pure remote effects', () => {
    const root = temp('route-remote-delivery-work-');
    const workStore = { root: join(root, 'work') };
    const context = {
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
    };
    const mixed = routeWorkStart(context, {
      objective: 'Implement and publish one repository revision',
      verifiedEngineeringEvidence: highEngineeringEvidence(),
      allowedPaths: ['src/runtime/**'],
      acceptanceCriteria: ['Exact integrated revision is published'],
      modeInput: {
        scopeClear: true, mutation: true, expectedFiles: 3, expectedChangedLines: 120,
        requiresRecovery: true, requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write',
      },
    });
    const mixedId = (mixed.data as { work?: { workId?: string } }).work?.workId;
    expect(mixedId).toBeTruthy();
    expect(getWorkContract(workStore, mixedId!)).toMatchObject({
      workKind: 'repository_change',
      constraints: { remoteDeliveryRequired: true },
    });

    const pure = routeWorkStart({ ...context, workStore: { root: join(root, 'pure-work') } }, {
      objective: 'Perform one external remote action',
      verifiedEngineeringEvidence: highEngineeringEvidence(),
      acceptanceCriteria: ['Remote action receipt exists'],
      modeInput: {
        scopeClear: true, mutation: true, requiresRecovery: true,
        requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write',
      },
    });
    const pureId = (pure.data as { work?: { workId?: string } }).work?.workId;
    expect(pureId).toBeTruthy();
    expect(getWorkContract({ root: join(root, 'pure-work') }, pureId!)).toMatchObject({ workKind: 'remote_effect' });
    expect(getWorkContract({ root: join(root, 'pure-work') }, pureId!)?.constraints.remoteDeliveryRequired).toBeUndefined();

    const localStore = { root: join(root, 'local-effect-work') };
    const local = routeWorkStart({ ...context, workStore: localStore }, {
      objective: 'Activate one local Runtime release and verify its readiness',
      acceptanceCriteria: ['Local Runtime activation receipt exists'],
      // These are policy fences for optional evidence/docs, not proof of a source mutation.
      allowedPaths: ['scripts/**', 'docs/operations/**'],
      initialLikelyPaths: ['scripts/activate-source-baseline.ts'],
      modeInput: {
        scopeClear: true, mutation: true, requiresRecovery: true,
        requiresExternalEffect: true, remoteWrite: false, risk: 'workspace_write',
      },
    });
    const localId = (local.data as { work?: { workId?: string } }).work?.workId;
    expect(localId).toBeTruthy();
    expect(getWorkContract(localStore, localId!)).toMatchObject({ workKind: 'local_effect' });
    const localContext = { ...context, workStore: localStore, workspaceFingerprint: 'workspace-a' };
    const blockedLocalFinalize = finalizeGoalWorkloop(localContext, { workId: localId! });
    expect(blockedLocalFinalize.status).toBe('blocked');
    expect(blockedLocalFinalize.summary).toContain('No durable result evidence');
    appendWorkEvidence(localStore, localId!, {
      evidenceId: 'OCC-SCH-local-effect-timer-1',
      title: 'scheduled continuation dispatched',
      summary: 'A real timer-origin continuation occurrence completed.',
      detailLevel: 'summary',
    });
    const evidenceOnlyLocalFinalize = finalizeGoalWorkloop(localContext, { workId: localId! });
    expect(evidenceOnlyLocalFinalize.status).toBe('blocked');
    expect(evidenceOnlyLocalFinalize.summary).toContain('Controller-reviewed semantic acceptance evidence is incomplete');
    const reviewedLocal = continueGoalWorkloop(localContext, {
      workId: localId!,
      acceptanceEvidence: [{
        criterion: 'Local Runtime activation receipt exists',
        evidenceIds: ['OCC-SCH-local-effect-timer-1'],
        rationale: 'The durable timer-origin result evidence was explicitly reviewed against the declared local-effect criterion.',
      }],
    });
    expect(reviewedLocal.status).toBe('ok');
    const completedLocal = finalizeGoalWorkloop(localContext, { workId: localId! });
    expect(completedLocal.status).toBe('ok');
    expect(getWorkContract(localStore, localId!)).toMatchObject({
      status: 'completed',
      workKind: 'local_effect',
      completionOutcome: 'completed_local',
      completionReceipt: {
        source: 'local_effect',
        workId: localId,
        operation: 'controller_work/local_effect',
        target: { kind: 'controller_local', id: localId },
      },
    });

    const explicitStore = { root: join(root, 'explicit-repository-work') };
    const explicitRepositoryChange = routeWorkStart({ ...context, workStore: explicitStore }, {
      objective: 'Implement locally and then run a local external verification effect',
      workKind: 'repository_change',
      allowedPaths: ['src/runtime/**'],
      acceptanceCriteria: ['Source change and local effect are both verified'],
      modeInput: {
        scopeClear: true, mutation: true, requiresRecovery: true,
        requiresExternalEffect: true, remoteWrite: false, risk: 'local_repo_write',
      },
    });
    const explicitId = (explicitRepositoryChange.data as { work?: { workId?: string } }).work?.workId;
    expect(explicitId).toBeTruthy();
    expect(getWorkContract(explicitStore, explicitId!)).toMatchObject({ workKind: 'repository_change' });
  });

  test('allows Requirement-bound durable Work without forcing a Plan', () => {
    const root = temp('route-requirement-workloop-');
    const workStore = { root: join(root, 'work') };
    const result = routeWorkStart({
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
    }, {
      objective: 'Implement one durable slice under an existing Requirement',
      requirementId: 'REQ-route-a',
      acceptanceCriteria: ['Requirement slice is complete'],
      allowedPaths: ['src/runtime/control-plane/**'],
      checks: [],
      modeInput: {
        scopeClear: true,
        mutation: true,
        expectedFiles: 4,
        expectedChangedLines: 200,
        requiresRecovery: true,
        risk: 'local_repo_write',
      },
    });
    const workId = (result.data as { work?: { workId?: string } }).work?.workId;
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('Goal workloop started');
    expect(result.summary).not.toContain('PLAN_REQUIRED');
    expect(result.data).toMatchObject({ workContractCreated: true });
    expect(workId).toBeTruthy();
    expect(getWorkContract(workStore, workId!)).toMatchObject({ requirementId: 'REQ-route-a' });
    expect(getWorkContract(workStore, workId!)?.planId).toBeUndefined();
  });

  test('persists semantic ownership before placement when another durable Work is active', () => {
    const root = temp('route-work-admission-');
    let materializationCount = 0;
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
      materializeIsolatedWorkspace: ({ workId }: { workId: string }) => {
        materializationCount += 1;
        return { checkoutId: `isolated-${workId}`, root: join(root, workId), baseRevision: 'revision-a', managed: true as const };
      },
    };
    const modeInput = { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' as const };
    const first = routeWorkStart(context, { objective: 'Implement the primary repository change', modeInput });
    expect(first.status).toBe('ok');
    const firstWorkId = (first.data as { work?: { workId?: string } }).work?.workId;
    expect(firstWorkId).toBeTruthy();

    const independent = routeWorkStart(context, { objective: 'Add another independent repository change', modeInput });
    expect(independent.status).toBe('ok');
    expect(independent.data).toMatchObject({ workContractCreated: true, worktreeRequired: true });
    const independentWorkId = (independent.data as { work?: { workId?: string } }).work?.workId;
    expect(independentWorkId).toBeTruthy();
    expect(independentWorkId).not.toBe(firstWorkId);
    const admitted = getWorkContract({ root: join(root, 'work') }, independentWorkId!);
    expect(admitted).toMatchObject({ worktreePolicy: { required: true } });
    expect(admitted?.checkoutId).toBeUndefined();
    expect(admitted?.worktreeRef).toBeUndefined();
    expect(materializationCount).toBe(0);

    const reused = routeWorkStart(context, { objective: 'Continue the primary change', relatedWorkId: firstWorkId, workRelation: 'continue', modeInput });
    expect(reused.status).toBe('ok');
    expect(reused.data).toMatchObject({ workContractCreated: false, admissionDecision: 'reuse_existing', work: { workId: firstWorkId } });
    const extended = routeWorkStart(context, { objective: 'Also cover the new acceptance case', relatedWorkId: firstWorkId, workRelation: 'extend', acceptanceCriteria: ['New acceptance case'], allowedPaths: ['src/new/**'], modeInput });
    expect(extended.status).toBe('ok');
    expect(extended.data).toMatchObject({ workContractCreated: false, admissionDecision: 'extend_existing', work: { workId: firstWorkId } });
    expect(getWorkContract({ root: join(root, 'work') }, firstWorkId!)).toMatchObject({ acceptanceCriteria: ['New acceptance case'], allowedPaths: ['src/new/**'] });
  });
  test('does not silently replace an explicit related Work target with a Requirement candidate', () => {
    const root = temp('route-explicit-related-target-');
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      sourceRevision: 'revision-a',
    };
    const modeInput = { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' as const };
    const first = routeWorkStart(context, { objective: 'Own the shared requirement', requirementId: 'REQ-explicit-target', modeInput });
    expect(first.status).toBe('ok');
    const firstWorkId = (first.data as { work?: { workId?: string } }).work?.workId;
    expect(firstWorkId).toBeTruthy();
    const missingExplicit = routeWorkStart(context, {
      objective: 'Continue an explicitly selected Work',
      requirementId: 'REQ-explicit-target',
      relatedWorkId: 'work-does-not-exist',
      workRelation: 'continue',
      modeInput,
    });
    expect(missingExplicit.status).toBe('ok');
    expect(missingExplicit.summary).toContain('CONTINUE_TARGET_REQUIRED');
    expect(missingExplicit.data).toMatchObject({ workContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true });
    expect((missingExplicit.data as { recommendedWork?: unknown }).recommendedWork).toBeUndefined();
    expect(getWorkContract(context.workStore, firstWorkId!)).toBeTruthy();
  });

  test('preserves the Direct fast path with unrelated active Work while retaining explicit ownership metadata', () => { const root = temp('route-direct-admission-'); const context = { workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'controller-a', sourceRevision: 'revision-a', materializeIsolatedWorkspace: ({ workId }: { workId: string }) => ({ checkoutId: `isolated-${workId}`, root: join(root, workId), baseRevision: 'revision-a', managed: true as const }) }; const durable = routeWorkStart(context, { objective: 'Own the long-running repository change', modeInput: { scopeClear: true, mutation: true, expectedFiles: 5, expectedChangedLines: 250, requiresRecovery: true, risk: 'local_repo_write' }, }); const workId = (durable.data as { work?: { workId?: string } }).work?.workId; expect(workId).toBeTruthy(); const independentSmallEdit = routeWorkStart(context, { objective: 'Make one tiny independent edit', modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 5, risk: 'local_repo_write' }, }); expect(independentSmallEdit.status).toBe('ok'); expect(independentSmallEdit.summary).toContain('Direct control recommended'); expect(independentSmallEdit.data).toMatchObject({ directControlPreserved: true, workContractCreated: false }); const ownedSmallEdit = routeWorkStart(context, { objective: 'Make one tiny edit owned by the existing Work', relatedWorkId: workId, workRelation: 'continue', modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 5, risk: 'local_repo_write' }, }); expect(ownedSmallEdit.summary).toContain('Direct control recommended'); expect(ownedSmallEdit.data).toMatchObject({ directControlPreserved: true, workContractCreated: false, ownership: { workId, relation: 'continue', executionDepthPreserved: true } }); });
  test('keeps one shared Requirement authority across 32 admissions while admitting 32 independent Requirements', () => {
    const root = temp('route-semantic-admission-cardinality-');
    const workStore = { root: join(root, 'work') };
    const handoffStore = { root: join(root, 'handoff') };
    const modeInput = { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' as const };
    const shared = Array.from({ length: 32 }, (_, index) => routeWorkStart({
      workStore,
      handoffStore,
      repoId: 'repo-a',
      checkoutId: `shared-${index}`,
      sourceRevision: 'revision-a',
    }, {
      objective: 'Own the shared semantic admission requirement',
      requirementId: 'REQ-shared-admission',
      modeInput,
    }));
    const sharedCreated = shared.filter((result) => (result.data as { workContractCreated?: boolean }).workContractCreated === true);
    expect(sharedCreated).toHaveLength(1);
    const sharedAuthorityIds = new Set(shared.flatMap((result) => {
      const data = result.data as { work?: { workId?: string }; recommendedWork?: { workId?: string }; candidates?: Array<{ workId?: string }> };
      const workId = data.work?.workId ?? data.recommendedWork?.workId ?? data.candidates?.[0]?.workId;
      return workId ? [workId] : [];
    }));
    expect(sharedAuthorityIds.size).toBe(1);
    expect(shared.slice(1).every((result) => ['resolution_required', 'reuse_existing'].includes(String((result.data as { admissionDecision?: string }).admissionDecision)))).toBe(true);

    const independent = Array.from({ length: 32 }, (_, index) => routeWorkStart({
      workStore,
      handoffStore,
      repoId: 'repo-a',
      checkoutId: `independent-${index}`,
      sourceRevision: 'revision-a',
    }, {
      objective: `Own independent semantic admission requirement ${index}`,
      requirementId: `REQ-independent-admission-${index}`,
      modeInput,
    }));
    const independentIds = independent.map((result) => (result.data as { work?: { workId?: string }; workContractCreated?: boolean }).work?.workId);
    expect(independent.every((result) => (result.data as { workContractCreated?: boolean }).workContractCreated === true)).toBe(true);
    expect(independentIds.every(Boolean)).toBe(true);
    expect(new Set(independentIds).size).toBe(32);
  });

  test('ignores low-level execution-child Work when resolving a new business task', () => { const root = temp('route-execution-child-admission-'); const workStore = { root: join(root, 'work') }; createWorkContract(workStore, { workId: 'WORK-child', repoId: 'repo-a', mode: 'direct_control', lifecycleRole: 'execution_child', objective: 'Accepted operation run_check', acceptanceCriteria: [], constraints: { requireHandoffOnAmbiguity: true }, allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'system', }); const result = routeWorkStart({ workStore, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', sourceRevision: 'revision-a' }, { objective: 'Make one independent tiny product edit', modeInput: { scopeClear: true, mutation: true, expectedFiles: 1, expectedChangedLines: 4, risk: 'local_repo_write' }, }); expect(result.status).toBe('ok'); expect(result.summary).toContain('Direct control recommended'); expect(result.data).toMatchObject({ directControlPreserved: true, workContractCreated: false }); });
  test('never lets scheduler-origin start invent a new durable Work', () => { const root = temp('route-scheduler-admission-'); const result = routeWorkStart({ workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', sourceRevision: 'revision-a' }, { objective: 'Wake scheduled maintenance', requestedBy: 'scheduler', modeInput: { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' }, }); expect(result.status).toBe('ok'); expect(result.summary).toContain('SCHEDULER_WORK_BINDING_REQUIRED'); expect(result.data).toMatchObject({ executionStarted: false, workContractCreated: false, admissionDecision: 'resolution_required' }); });
  test('still binds an explicitly approved Plan step while old Plan and Work shapes remain readable', () => {
    const root = temp('route-planned-workloop-');
    const planStore = { root: join(root, 'plan') };
    createPlanContract(planStore, {
      planId: 'plan-a', repoId: 'repo-a', requirementId: 'REQ-plan-a', scopeKey: 'route-policy', sourceRevision: 'revision-a', goal: 'Review the routing strategy first',
      steps: [{
        id: 'step-a', objective: 'Implement the approved route policy', dependencies: [], authoritativeFiles: [],
        allowedPaths: ['src/runtime/control-plane/**'], forbiddenPaths: ['src/private/**'], checks: ['package:check:type'],
        acceptanceCriteria: ['One route authority'],
      }],
    });
    const context = {
      workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a', availableChecks: [{ id: 'package:check:type' }],
    };
    const draftAttempt = routeWorkStart(context, {
      objective: 'Implement the approved route policy', planId: 'plan-a', planStepId: 'step-a',
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 8, expectedChangedLines: 500, requiresRecovery: true, risk: 'local_repo_write' },
    });
    expect(draftAttempt.status).toBe('blocked');
    expect(draftAttempt.summary).toContain('PLAN_NOT_EXECUTABLE');
    expect(draftAttempt.data).toMatchObject({ executionStarted: false, planId: 'plan-a' });
    expect((draftAttempt.data as { work?: unknown }).work).toBeUndefined();

    approvePlanContract(planStore, 'plan-a');
    const requirementMismatch = routeWorkStart(context, {
      objective: 'Implement the approved route policy', planId: 'plan-a', planStepId: 'step-a', requirementId: 'REQ-other',
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 8, expectedChangedLines: 500, requiresRecovery: true, risk: 'local_repo_write' },
    });
    expect(requirementMismatch.status).toBe('blocked');
    expect(requirementMismatch.summary).toContain('PLAN_REQUIREMENT_MISMATCH');
    expect(requirementMismatch.data).toMatchObject({ workContractCreated: false, planRequirementId: 'REQ-plan-a', requestedRequirementId: 'REQ-other' });

    const mismatch = routeWorkStart(context, {
      objective: 'Implement the approved route policy', planId: 'plan-a', planStepId: 'step-a', allowedPaths: ['src/other/**'],
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 8, expectedChangedLines: 500, requiresRecovery: true, risk: 'local_repo_write' },
    });
    expect(mismatch.summary).toContain('PLAN_STEP_WORK_CONTRACT_MISMATCH'); expect(mismatch.data).toMatchObject({ executionStarted: false, workContractCreated: false });
    const result = routeWorkStart(context, {
      objective: 'Implement the approved route policy', planId: 'plan-a', planStepId: 'step-a',
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 8, expectedChangedLines: 500, requiresRecovery: true, risk: 'local_repo_write' },
    });
    const workId = (result.data as { work?: { workId?: string } }).work?.workId;
    expect(result.status).toBe('ok');
    expect(workId).toBeTruthy();
    expect(getPlanContract(planStore, 'plan-a')?.steps[0]).toMatchObject({ status: 'executing', workId });
    expect(getWorkContract({ root: join(root, 'work') }, workId!)).toMatchObject({
      repoId: 'repo-a', planId: 'plan-a', planStepId: 'step-a', mode: 'goal_workloop',
      acceptanceCriteria: ['One route authority'], allowedPaths: ['src/runtime/control-plane/**'], forbiddenPaths: ['src/private/**'], checks: ['package:check:type'],
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
  test('continues an accepted Plan goal into one explicit successor Work without inheriting transport identity', () => {
    const root = temp('route-plan-successor-work-');
    const planStore = { root: join(root, 'plan') };
    const workStore = { root: join(root, 'work') };
    createPlanContract(planStore, {
      planId: 'plan-successor', repoId: 'repo-a', requirementId: 'REQ-successor', scopeKey: 'successor-lineage', sourceRevision: 'revision-a', goal: 'Deliver two durable slices',
      steps: [
        { id: 'step-a', objective: 'Deliver first slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['first slice delivered'] },
        { id: 'step-b', objective: 'Deliver second slice', dependencies: ['step-a'], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['second slice delivered'] },
      ],
    });
    approvePlanContract(planStore, 'plan-successor');
    const context = {
      workStore, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'runtime-a', sourceRevision: 'revision-a', availableChecks: [{ id: 'check:successor' }],
    };
    const first = routeWorkStart(context, {
      objective: 'Deliver first slice', planId: 'plan-successor', planStepId: 'step-a', workKind: 'completed_no_change',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const firstWorkId = (first.data as { work?: { workId?: string } }).work?.workId;
    expect(firstWorkId).toBeTruthy();
    completeNoChangePlanWork(workStore, firstWorkId!, 'REV-successor-first');
    completePlanStepForWork(planStore, { planId: 'plan-successor', stepId: 'step-a', work: getWorkContract(workStore, firstWorkId!)! });

    const beforeAcceptance = routeWorkStart(context, {
      objective: 'Continue the same durable goal', relatedWorkId: firstWorkId, workRelation: 'continue',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    expect(beforeAcceptance.status).toBe('blocked');
    expect(beforeAcceptance.summary).toContain('PLAN_STEP_SEMANTIC_ACCEPTANCE_REQUIRED');
    expect((beforeAcceptance.data as { workContractCreated?: boolean }).workContractCreated).toBe(false);

    acceptPlanStepEvidence(planStore, {
      planId: 'plan-successor', stepId: 'step-a', reviewer: 'principal-a', rationale: 'First slice evidence satisfies the approved Plan step.', acceptedSourceRevision: 'revision-a',
    });
    const successor = routeWorkStart(context, {
      objective: 'Continue the same durable goal', relatedWorkId: firstWorkId, workRelation: 'continue',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const successorWorkId = (successor.data as { work?: { workId?: string } }).work?.workId;
    expect(successor.status).toBe('ok');
    expect(successor.summary).toContain('continues semantic lineage');
    expect(successorWorkId).toBeTruthy();
    expect(successorWorkId).not.toBe(firstWorkId);
    expect(getWorkContract(workStore, successorWorkId!)).toMatchObject({
      predecessorWorkId: firstWorkId,
      requirementId: 'REQ-successor',
      planId: 'plan-successor',
      planStepId: 'step-b',
      objective: 'Deliver second slice',
      acceptanceCriteria: ['second slice delivered'],
    });
    expect(getPlanContract(planStore, 'plan-successor')?.steps[1]).toMatchObject({ status: 'executing', workId: successorWorkId });
  });

  test('requires Controller resolution when a terminal Plan Work has multiple executable successor steps', () => {
    const root = temp('route-plan-successor-ambiguous-');
    const planStore = { root: join(root, 'plan') };
    const workStore = { root: join(root, 'work') };
    createPlanContract(planStore, {
      planId: 'plan-ambiguous-successor', repoId: 'repo-a', requirementId: 'REQ-ambiguous-successor', scopeKey: 'ambiguous-successor', sourceRevision: 'revision-a', goal: 'Allow two parallel next slices',
      steps: [
        { id: 'step-a', objective: 'Deliver root slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['root delivered'] },
        { id: 'step-b', objective: 'Deliver branch B', dependencies: ['step-a'], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['B delivered'] },
        { id: 'step-c', objective: 'Deliver branch C', dependencies: ['step-a'], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['C delivered'] },
      ],
    });
    approvePlanContract(planStore, 'plan-ambiguous-successor');
    const context = {
      workStore, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'runtime-a', sourceRevision: 'revision-a', availableChecks: [{ id: 'check:successor' }],
    };
    const first = routeWorkStart(context, {
      objective: 'Deliver root slice', planId: 'plan-ambiguous-successor', planStepId: 'step-a', workKind: 'completed_no_change',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const firstWorkId = (first.data as { work?: { workId?: string } }).work?.workId!;
    completeNoChangePlanWork(workStore, firstWorkId, 'REV-ambiguous-root');
    completePlanStepForWork(planStore, { planId: 'plan-ambiguous-successor', stepId: 'step-a', work: getWorkContract(workStore, firstWorkId)! });
    acceptPlanStepEvidence(planStore, {
      planId: 'plan-ambiguous-successor', stepId: 'step-a', reviewer: 'principal-a', rationale: 'Root slice accepted.', acceptedSourceRevision: 'revision-a',
    });

    const ambiguous = routeWorkStart(context, {
      objective: 'Continue the same durable goal', relatedWorkId: firstWorkId, workRelation: 'continue',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    expect(ambiguous.status).toBe('ok');
    expect(ambiguous.summary).toContain('PLAN_SUCCESSOR_STEP_RESOLUTION_REQUIRED');
    expect(ambiguous.data).toMatchObject({
      executionStarted: false,
      workContractCreated: false,
      admissionDecision: 'resolution_required',
      resolutionRequired: true,
      predecessorWorkId: firstWorkId,
      planId: 'plan-ambiguous-successor',
    });
    expect((ambiguous.data as { candidatePlanSteps?: Array<{ id: string }> }).candidatePlanSteps?.map((step) => step.id).sort()).toEqual(['step-b', 'step-c']);
  });

  test('continues a terminal Requirement-only Work without inventing a Plan or reusing the terminal Work id', () => {
    const root = temp('route-requirement-successor-');
    const workStore = { root: join(root, 'work') };
    const predecessor = createWorkContract(workStore, {
      workId: 'work-requirement-predecessor', repoId: 'repo-a', mode: 'goal_workloop', objective: 'Finish first Requirement slice',
      acceptanceCriteria: ['first slice attempted'], constraints: { requireHandoffOnAmbiguity: true }, risk: 'readonly', workKind: 'completed_no_change',
      status: 'cancelled', requirementId: 'REQ-requirement-successor', checks: [], allowedPaths: [], forbiddenPaths: [], requestedBy: 'chatgpt',
    });
    const successor = routeWorkStart({
      workStore, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', sourceRevision: 'revision-b',
    }, {
      objective: 'Continue remaining Requirement work', relatedWorkId: predecessor.workId, workRelation: 'continue',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const successorWorkId = (successor.data as { work?: { workId?: string } }).work?.workId;
    expect(successor.status).toBe('ok');
    expect(successorWorkId).toBeTruthy();
    expect(successorWorkId).not.toBe(predecessor.workId);
    const successorWork = getWorkContract(workStore, successorWorkId!)!;
    expect(successorWork).toMatchObject({
      predecessorWorkId: predecessor.workId,
      requirementId: 'REQ-requirement-successor',
      objective: 'Continue remaining Requirement work',
    });
    expect(successorWork).not.toHaveProperty('planId');
    expect(successorWork).not.toHaveProperty('planStepId');
  });

  test('requires explicit Requirement acceptance instead of creating another Work after the final accepted Plan step', () => {
    const root = temp('route-plan-goal-complete-');
    const planStore = { root: join(root, 'plan') };
    const workStore = { root: join(root, 'work') };
    createPlanContract(planStore, {
      planId: 'plan-goal-complete', repoId: 'repo-a', requirementId: 'REQ-goal-complete', scopeKey: 'goal-complete', sourceRevision: 'revision-a', goal: 'Finish one durable slice',
      steps: [{ id: 'only-step', objective: 'Deliver only slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['only slice delivered'] }],
    });
    approvePlanContract(planStore, 'plan-goal-complete');
    const context = {
      workStore, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'runtime-a', sourceRevision: 'revision-a', availableChecks: [{ id: 'check:successor' }],
    };
    const first = routeWorkStart(context, {
      objective: 'Deliver only slice', planId: 'plan-goal-complete', planStepId: 'only-step', workKind: 'completed_no_change',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const firstWorkId = (first.data as { work?: { workId?: string } }).work?.workId!;
    completeNoChangePlanWork(workStore, firstWorkId, 'REV-goal-complete');
    completePlanStepForWork(planStore, { planId: 'plan-goal-complete', stepId: 'only-step', work: getWorkContract(workStore, firstWorkId)! });
    acceptPlanStepEvidence(planStore, {
      planId: 'plan-goal-complete', stepId: 'only-step', reviewer: 'principal-a', rationale: 'Final slice accepted.', acceptedSourceRevision: 'revision-a',
    });
    expect(getPlanContract(planStore, 'plan-goal-complete')?.status).toBe('finalized');

    const completed = routeWorkStart(context, {
      objective: 'Continue same goal', relatedWorkId: firstWorkId, workRelation: 'continue',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    expect(completed.status).toBe('ok');
    expect(completed.summary).toContain('CONTINUATION_REQUIREMENT_ACCEPTANCE_REQUIRED');
    expect(completed.data).toMatchObject({
      executionStarted: false,
      workContractCreated: false,
      admissionDecision: 'requirement_acceptance_required',
      requirementAcceptanceRequired: true,
      predecessorWorkId: firstWorkId,
      planId: 'plan-goal-complete',
      requirementId: 'REQ-goal-complete',
      progression: { kind: 'request_requirement_acceptance', reasonCode: 'PLAN_FINALIZED_REQUIRES_REQUIREMENT_ACCEPTANCE' },
    });
  });

  test('keeps predicted, inspected, and actual scope evidence separate from policy fences', () => {
    const root = temp('route-scope-evidence-');
    const store = { root: join(root, 'work') };
    createWorkContract(store, {
      workId: 'WORK-scope', repoId: 'repo-a', mode: 'goal_workloop', objective: 'Discover and edit the correct runtime paths',
      acceptanceCriteria: [], constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: ['src/runtime/**'], forbiddenPaths: ['src/runtime/secrets/**'], checks: [], requestedBy: 'chatgpt',
      scopeEvidence: {
        initialLikelyPaths: ['src/runtime/first.ts'], inspectedPaths: [], actualChangedPaths: [], recordedAt: '2026-08-18T00:00:00.000Z',
      },
    });
    recordWorkScopeEvidence(store, 'WORK-scope', {
      inspectedPaths: ['src/runtime/first.ts', 'src/runtime/related.ts'],
      actualChangedPaths: ['src/runtime/related.ts'],
    });
    expect(getWorkContract(store, 'WORK-scope')).toMatchObject({
      allowedPaths: ['src/runtime/**'],
      forbiddenPaths: ['src/runtime/secrets/**'],
      scopeEvidence: {
        initialLikelyPaths: ['src/runtime/first.ts'],
        inspectedPaths: ['src/runtime/first.ts', 'src/runtime/related.ts'],
        actualChangedPaths: ['src/runtime/related.ts'],
      },
    });
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
  test('keeps dirty-workspace mutation direct while preserving scope evidence', () => {
    const decision = decideRoute(sharedInput({ workspace: { dirty: true, checkoutId: 'checkout-a', fingerprint: 'dirty-a' } }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresIsolation: false, createHandoff: false });
    expect(decision.reasons.map((reason) => reason.code)).toContain('dirty_workspace_preserve_existing_changes');
  });
  test('keeps protected-path work direct and leaves assurance to the edit/diff gate', () => {
    const decision = decideRoute(sharedInput({
      intent: { objective: 'Update a workflow file', scopeClear: true, mutation: true },
      workspace: { knownPaths: ['.github/workflows/ci.yml'], dirty: false },
    }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false });
    expect(decision.reasons.map((reason) => reason.code)).toContain('protected_path');
  });
  test('lets ChatGPT explicitly run no-change verification without inventing a repository diff', () => {
    const root = temp('route-no-change-verification-');
    const workStore = { root: join(root, 'work') };
    const context = {
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      sourceRevision: 'revision-a',
      workspaceChangedPaths: [] as string[],
      availableChecks: [{ id: 'check:baseline' }],
    };
    const started = routeWorkStart(context, {
      objective: 'Verify the clean stable baseline without changing source',
      workKind: 'completed_no_change',
      checks: ['check:baseline'],
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    expect(getWorkContract(workStore, workId!)).toMatchObject({
      workKind: 'completed_no_change', status: 'running', phase: 'implementation',
    });

    const continued = continueGoalWorkloop(context, { workId: workId! });
    expect(continued.status).toBe('ok');
    expect(continued.data).toMatchObject({ nextStep: 'verify', remainingChecks: ['check:baseline'] });
    expect(getWorkContract(workStore, workId!)).toMatchObject({ status: 'running', phase: 'verification' });
  });

  test('keeps terminal completed Work verification idempotent without appending late failure evidence', () => {
    const root = temp('route-terminal-verify-');
    const workStore = { root: join(root, 'work') };
    const context = {
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-removed',
      sourceRevision: 'revision-a',
      workspaceChangedPaths: [] as string[],
      availableChecks: [{ id: 'check:baseline' }],
    };
    const work = createWorkContract(workStore, {
      workId: 'work-terminal-verify',
      repoId: 'repo-a',
      checkoutId: 'checkout-removed',
      mode: 'goal_workloop',
      objective: 'Verify a completed no-change baseline',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      workKind: 'completed_no_change',
      checks: [],
      allowedPaths: [],
      forbiddenPaths: [],
      requestedBy: 'chatgpt',
    });
    completeNoChangePlanWork(workStore, work.workId, 'REV-terminal-verify');

    const before = getWorkContract(workStore, work.workId)!;
    const verified = verifyGoalWorkloop(context, { workId: work.workId, checkId: 'check:baseline', infrastructureFailed: true });
    const after = getWorkContract(workStore, work.workId)!;
    expect(verified.status).toBe('ok');
    expect(verified.summary).toContain('verification was not re-executed');
    expect(verified.data).toMatchObject({ verification: { terminal: true, idempotent: true, reexecuted: false } });
    expect(after.status).toBe('completed');
    expect(after.checkRefs).toEqual(before.checkRefs);
    expect(after.evidenceRefs).toEqual(before.evidenceRefs);
  });

  test('keeps the repository-change implementation gate strict when ChatGPT does not select no-change work', () => {
    const root = temp('route-repository-change-evidence-');
    const workStore = { root: join(root, 'work') };
    const context = {
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      sourceRevision: 'revision-a',
      workspaceChangedPaths: [] as string[],
      availableChecks: [{ id: 'check:baseline' }],
    };
    const started = routeWorkStart(context, {
      objective: 'Implement a repository change and verify it',
      checks: ['check:baseline'],
      modeInput: { scopeClear: true, mutation: true, requiresRecovery: true, risk: 'local_repo_write' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    const continued = continueGoalWorkloop(context, { workId: workId! });
    expect(continued.status).toBe('blocked');
    expect(continued.summary).toContain('no current net source changes');
    expect(getWorkContract(workStore, workId!)).toMatchObject({ workKind: 'repository_change', status: 'running', phase: 'implementation' });
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
