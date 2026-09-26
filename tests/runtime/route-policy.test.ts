import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyEditOperations, beginEditSession, finalizeEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { registerRepository } from '../../src/cli/repositories/registry';
import { ensureRepositoryRuntimeStorageBinding } from '../../src/cli/repositories/runtime-storage';
import { continueGoalWorkloop, finalizeGoalWorkloop, routeWorkStart, runGoalWorkloop, verifyGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
import { runGoalWorkloop as runGoalWorkloopWithAccess } from '../../src/runtime/control-plane/facade/goal-workloop-access';
import { createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { appendWorkEvidence, createWorkContract, getWorkContract, listWorkContracts, recordWorkCompletionReceipt, recordWorkImplementationReview, recordWorkScopeEvidence, requestWorkImplementationReview, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { selectExecutionMode } from '../../src/runtime/control-plane/facade/types';
import { implementationReviewChangedPathDigest } from '../../packages/kernel/work/domain/implementation-review';
import { buildEvaluationPromotionReceipt, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
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
  const current = getWorkContract(workStore, workId)!;
  reviseWorkSemanticContext(workStore, workId, {
    expectedRevision: current.semanticRevision ?? 1,
    state: 'completed',
  });
}

function sharedInput(overrides: Partial<RoutePolicyInput> = {}): RoutePolicyInput {
  return {
    intent: {
      objective: 'Apply a bounded repository fix',
      scopeClear: true,
      mutation: true,
    },
    workspace: { knownPaths: ['src/example.ts'], checkoutId: 'checkout-a', fingerprint: 'workspace-a' },
    policy: { risk: 'local_repo_write' },
    capabilities: {},
    recovery: {},
    ...overrides,
  };
}
test('trusted evaluation promotion receipt becomes exact implementation-review architecture evidence and survives finalize comparison', () => {
  const root = temp('promotion-review-evidence-');
  const workStore = { root: join(root, 'work') };
  const handoffStore = { root: join(root, 'handoff') };
  const sourceRevision = 'a'.repeat(40);
  const workId = 'work-promotion-review-evidence';
  createWorkContract(workStore, {
    workId,
    repoId: 'repo-promotion-review-evidence',
    mode: 'goal_workloop',
    objective: 'Review an evaluator-proven candidate without creating a second lifecycle.',
    acceptanceCriteria: [],
    constraints: { workspaceMode: 'current', requireWorktree: false },
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    requestedBy: 'chatgpt',
    status: 'running',
    workKind: 'completed_no_change',
  });
  transitionWorkContractPhase(workStore, workId, {
    status: 'running',
    phase: 'verification',
    state: 'satisfied',
    summary: 'Exact no-change candidate verified.',
  });
  requestWorkImplementationReview(workStore, workId, 'Evaluator-proven candidate requires Controller review.');

  const receipt = buildEvaluationPromotionReceipt({
    schemaVersion: 'forge-evaluation-promotion-receipt/v1',
    authority: 'evaluation_evidence_only',
    baseline: {
      schemaVersion: 'forge-candidate-identity/v1',
      candidateId: 'baseline',
      versionLabel: 'baseline',
      artifactDigest: 'sha256:baseline',
      sourceRevision: 'b'.repeat(40),
      executionSurface: 'public_mcp',
    },
    candidate: {
      schemaVersion: 'forge-candidate-identity/v1',
      candidateId: 'candidate',
      versionLabel: 'candidate',
      artifactDigest: 'sha256:candidate',
      sourceRevision,
      executionSurface: 'public_mcp',
    },
    evidence: {
      paired: {
        protocolDigest: 'sha256:paired-protocol',
        environmentFingerprint: 'sha256:environment',
        pairCount: 3,
        evidenceDigest: 'sha256:paired-evidence',
      },
      shadow: {
        protocolDigest: 'sha256:shadow-protocol',
        pairedScenarioCount: 2,
        evidenceDigest: 'sha256:shadow-evidence',
      },
    },
  });
  const context = {
    workStore,
    handoffStore,
    repoId: 'repo-promotion-review-evidence',
    principalId: 'principal-reviewer',
    sourceRevision,
    workspaceFingerprint: 'workspace-verification',
    implementationReviewWorkspaceFingerprint: 'workspace-review',
    workspaceChangedPaths: [],
  };

  const reviewed = runGoalWorkloop(context, 'review', {
    work_id: workId,
    review_decision: 'approved',
    review_rationale: 'Exact evaluator-proven candidate is approved.',
  }, { evaluationPromotionReceipt: receipt });
  expect(reviewed.status).toBe('ok');
  const stored = getWorkContract(workStore, workId)!;
  expect(stored.implementationReviews.at(-1)?.architectureEvidence).toEqual([{
    evidenceId: receipt.receiptId,
    digest: receipt.receiptId.slice('evaluation-promotion:'.length),
  }]);

  const finalized = finalizeGoalWorkloop(context, { workId });
  expect(finalized.summary).not.toContain('WORK_IMPLEMENTATION_REVIEW_STALE');
  expect(finalized.summary).not.toContain('WORK_IMPLEMENTATION_REVIEW_REQUIRED');

  const staleWorkId = 'work-promotion-review-stale';
  createWorkContract(workStore, {
    workId: staleWorkId,
    repoId: 'repo-promotion-review-evidence',
    mode: 'goal_workloop',
    objective: 'Reject promotion evidence from another candidate revision.',
    acceptanceCriteria: [],
    constraints: { workspaceMode: 'current', requireWorktree: false },
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    requestedBy: 'chatgpt',
    status: 'running',
    workKind: 'completed_no_change',
  });
  transitionWorkContractPhase(workStore, staleWorkId, {
    status: 'running',
    phase: 'verification',
    state: 'satisfied',
    summary: 'Candidate verified.',
  });
  requestWorkImplementationReview(workStore, staleWorkId, 'Review required.');
  const mismatched = runGoalWorkloop({ ...context, sourceRevision: 'c'.repeat(40) }, 'review', {
    work_id: staleWorkId,
    review_decision: 'approved',
    review_rationale: 'Must not accept evidence for another revision.',
  }, { evaluationPromotionReceipt: receipt });
  expect(mismatched.status).toBe('blocked');
  expect(mismatched.summary).toContain('EVALUATION_PROMOTION_RECEIPT_CANDIDATE_SOURCE_MISMATCH');
});

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
    expect(continued.data).toMatchObject({ nextStep: 'finalize' });
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
  test('keeps readonly investigation on the direct fast path without durable Work', () => {
    const decision = decideRoute(sharedInput({
      intent: {
        objective: 'Investigate a cross-module regression without mutating yet',
        scopeClear: true,
        mutation: false,
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
      },
      policy: { risk: 'local_repo_write' },
    }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresIsolation: false });
  });
  test('never promotes a single deliverable from predicted file or line count alone', () => {
    const decision = decideRoute(sharedInput({
      intent: { objective: 'Refactor one large but continuously owned subsystem', scopeClear: true, mutation: true },
      workspace: { checkoutId: 'checkout-a', fingerprint: 'workspace-a' },
    }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false });
  });
  test('never promotes ordinary long checks from duration alone', () => {
    const decision = decideRoute(sharedInput({
      intent: { objective: 'Run the focused integration check after one local edit', scopeClear: true, mutation: true },
    }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresRecovery: false });
    expect(decision.reasons.some((reason) => reason.code === 'long_checks')).toBe(false);
  });
  test('parallelism alone never implies isolation', () => {
    const readonly = decideRoute(sharedInput({
      intent: { objective: 'Search several independent areas in the same checkout', scopeClear: true, mutation: false },
      policy: { risk: 'readonly' },
    }));
    expect(readonly).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresIsolation: false, requiresWork: false });
    const mutating = decideRoute(sharedInput({
      intent: { objective: 'Apply two independent low-risk edits in the same checkout', scopeClear: true, mutation: true },
      policy: { risk: 'local_repo_write' },
    }));
    expect(mutating).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresIsolation: false });
    expect(mutating.reasons.some((reason) => reason.code === 'independent_deliverables')).toBe(false);
  });
  test('preserves explicit Plan mode through the access facade without forcing isolation', () => {
    const root = temp('route-plan-access-');
    const result = runGoalWorkloopWithAccess({
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
    }, 'start', {
      objective: 'Deliver one approved Plan step on the current checkout',
      mode: 'plan',
      scope_clear: true,
      expected_files: 2,
      expected_changed_lines: 80,
      allowed_paths: ['src/**'],
    });
    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      workContractCreated: true,
      worktreeRequired: false,
      placement: { workContractCreated: true, worktreeRequired: false, isolated: false },
    });
  });

  test('typed isolated placement is reported as an isolation constraint without choosing method or Work depth', () => {
    const decision = decideRoute(sharedInput({
      intent: { objective: 'Apply one isolated edit', scopeClear: true, mutation: true },
      workspace: { knownPaths: ['src/example.ts'], placement: 'isolated', directMainProhibited: true },
    }));
    expect(decision).toMatchObject({
      executionMode: 'direct_control',
      executionPath: 'fast',
      requiresWork: false,
      requiresIsolation: true,
    });
    expect(decision.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['placement_isolated', 'direct_main_prohibited']));
  });

  test('routeWorkStart canonicalizes typed isolated placement without any mode-override token', () => {
    // Explicit placement behavior remains covered below. Dirty canonical checkout
    // isolation for durable Work has a separate regression because the
    // current-checkout lane intentionally keeps its dirty-workspace semantics.

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
      routeDecision: { requiresIsolation: true, executionMode: 'direct_control' },
    });
    expect(stored?.checkoutId).toBeUndefined();
  });

  test('durable Goal Work stays on current mainline when every trusted dirty path is inside its declared scope', () => {
    const root = temp('route-dirty-goal-same-scope-');
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-dirty-goal-same-scope',
      checkoutId: 'checkout-main',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
      workspaceDirty: true,
      workspaceChangedPaths: ['AGENTS.md'],
    };
    const started = routeWorkStart(context, {
      objective: 'Persist one already-owned mainline governance edit',
      allowedPaths: ['AGENTS.md'],
      constraints: { workspaceMode: 'current', requireWorktree: false },
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
    expect(started.data).toMatchObject({ workContractCreated: true, worktreeRequired: false });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(getWorkContract(context.workStore, workId!)).toMatchObject({
      mode: 'goal_workloop',
      constraints: { workspaceMode: 'current', requireWorktree: false },
      worktreePolicy: { required: false },
    });
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
      intent: { objective: 'Keep a bounded mutation on the dirty current checkout', scopeClear: true, mutation: true },
      workspace: { knownPaths: ['src/example.ts'], dirty: true },
    }));
    expect(direct).toMatchObject({ executionMode: 'direct_control', requiresIsolation: false, requiresWork: false });
  });

  test('preserves typed isolated placement across an approval handoff replay', () => {
    const root = temp('route-isolated-approval-');
    const repoId = 'repo-isolated-approval';
    const handoffStore = { controllerHome: join(root, 'controller-home'), repoId };
    const result = routeWorkStart({
      workStore: { root: join(root, 'work') },
      handoffStore,
      repoId,
    }, {
      objective: 'Apply an isolated change after explicit approval',
      constraints: { workspaceMode: 'isolated', directMainProhibited: true },
      modeInput: { scopeClear: true, mutation: true, destructive: true, risk: 'destructive' },
    });
    expect(result.status).toBe('approval_required');
    const handoffId = (result.data as { handoffId?: string }).handoffId;
    expect(handoffId).toBeTruthy();
    const handoff = getHandoffItem(handoffStore, handoffId!);
    expect(handoff?.approvalAction?.payload).toMatchObject({
      workspaceMode: 'isolated',
      requireWorktree: true,
      directMainProhibited: true,
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

  test('requires an explicit parallel Work relation instead of inferred deliverable fan-out', () => {
    // Deliverable count and predicted size no longer create durable Work or isolation.
    const bare = decideRoute(sharedInput({
      intent: { objective: 'Coordinate two tiny independent deliverables', scopeClear: true, mutation: true },
    }));
    expect(bare).toMatchObject({ executionMode: 'direct_control', executionPath: 'fast', requiresWork: false, requiresIsolation: false });

    const root = temp('route-parallel-relation-');
    const parallel = routeWorkStart({
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-parallel-relation',
      checkoutId: 'checkout-main',
      sourceRevision: 'revision-a',
    }, {
      objective: 'Run two explicitly parallel repository changes',
      workRelation: 'parallel',
      modeInput: { scopeClear: true, mutation: true, risk: 'local_repo_write' },
    });
    expect(parallel.status).toBe('ok');
    expect(parallel.data).toMatchObject({ workContractCreated: true, worktreeRequired: true });
  });
  test('keeps Agent/provider preference separate from Work topology', () => {
    expect(decideRoute(sharedInput({
      intent: { objective: 'Delegate a small bounded implementation', scopeClear: true, mutation: true },
      capabilities: { requiresWorker: true },
    }))).toMatchObject({ workMode: 'direct_edit', executionPath: 'fast', requiresWork: false });
    expect(decideRoute(sharedInput({
      intent: { objective: 'Delegate a large single deliverable', scopeClear: true, mutation: true },
      capabilities: { requiresWorker: true },
    }))).toMatchObject({ workMode: 'direct_edit', executionPath: 'fast', requiresWork: false });
  });
  test('allows explicitly chosen Work execution without a Plan while an explicit Plan remains optional', () => {
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
    expect(result.summary).toContain('Work started');
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
      work_kind: 'repository_change',
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
      work_kind: 'repository_change',
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
      work_kind: 'repository_change',
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
      workKind: 'repository_change',
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
      // Predicted scope size never classifies the Work; the caller declares it.
      workKind: 'repository_change',
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

    const dirtyRemoteStore = { root: join(root, 'dirty-remote-work') };
    const dirtyRemote = routeWorkStart({ ...context, workStore: dirtyRemoteStore }, {
      objective: 'Perform one pure remote action while the repository checkout is dirty',
      workKind: 'remote_effect',
      acceptanceCriteria: ['Remote action receipt exists'],
      modeInput: {
        scopeClear: true, mutation: true, workspaceDirty: true, requiresRecovery: true,
        requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write',
      },
    });
    const dirtyRemoteId = (dirtyRemote.data as { work?: { workId?: string } }).work?.workId;
    expect(dirtyRemote.status).toBe('ok');
    expect(dirtyRemoteId).toBeTruthy();
    expect(getWorkContract(dirtyRemoteStore, dirtyRemoteId!)).toMatchObject({
      workKind: 'remote_effect',
      checkoutId: 'checkout-a',
      constraints: { workspaceMode: 'auto', requireWorktree: false },
      worktreePolicy: { required: false },
    });

    const isolatedRemoteStore = { root: join(root, 'isolated-remote-work') };
    const isolatedRemote = routeWorkStart({ ...context, workStore: isolatedRemoteStore }, {
      objective: 'Perform one remote action with an explicit isolated workspace contract',
      workKind: 'remote_effect',
      acceptanceCriteria: ['Remote action receipt exists'],
      constraints: { workspaceMode: 'isolated', requireWorktree: true },
      modeInput: {
        scopeClear: true, mutation: true, requiresRecovery: true,
        requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write',
      },
    });
    const isolatedRemoteId = (isolatedRemote.data as { work?: { workId?: string } }).work?.workId;
    expect(isolatedRemote.status).toBe('ok');
    expect(isolatedRemoteId).toBeTruthy();
    expect(getWorkContract(isolatedRemoteStore, isolatedRemoteId!)).toMatchObject({
      workKind: 'remote_effect',
      constraints: { workspaceMode: 'isolated', requireWorktree: true },
      worktreePolicy: { required: true },
    });

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
    expect(blockedLocalFinalize.summary).toContain('no concrete delivery/effect receipt');
    appendWorkEvidence(localStore, localId!, {
      evidenceId: 'OCC-SCH-local-effect-timer-1',
      title: 'scheduled continuation dispatched',
      summary: 'A real timer-origin continuation occurrence completed.',
      detailLevel: 'summary',
    });
    const evidenceOnlyLocalFinalize = finalizeGoalWorkloop(localContext, { workId: localId! });
    expect(evidenceOnlyLocalFinalize.status).toBe('ok');
    expect(evidenceOnlyLocalFinalize.data).toMatchObject({ deliverySettled: true });
    expect(getWorkContract(localStore, localId!)).toMatchObject({
      semanticState: 'open',
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

  test('never classifies Work kind from predicted scope size and fails closed on an ambiguous external effect', () => {
    const root = temp('route-work-kind-explicit-');
    const workStore = { root: join(root, 'work') };
    const context = {
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-work-kind-explicit',
      checkoutId: 'checkout-a',
      sourceRevision: 'revision-a',
    };
    // Predicted scope size plus an external effect is ambiguous: Forge refuses to
    // guess between a pure effect and implementation+publish, and creates no Work.
    const ambiguous = routeWorkStart(context, {
      objective: 'Publish one repository revision without declaring its Work kind',
      modeInput: {
        scopeClear: true, mutation: true, expectedFiles: 3, expectedChangedLines: 120,
        requiresRecovery: true, requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write',
      },
    });
    expect(ambiguous.status).toBe('blocked');
    expect(ambiguous.summary).toContain('WORK_KIND_REQUIRED_FOR_EXTERNAL_EFFECT_WITH_PREDICTED_SCOPE');
    expect(listWorkContracts({ ...workStore, status: 'all' })).toHaveLength(0);

    // A pure effect with no predicted scope stays an effect Work with no worktree.
    const pure = routeWorkStart(context, {
      objective: 'Perform one external remote action',
      modeInput: {
        scopeClear: true, mutation: true, requiresRecovery: true,
        requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write',
      },
    });
    const pureId = (pure.data as { work?: { workId?: string } }).work?.workId;
    expect(pure.status).toBe('ok');
    expect(getWorkContract(workStore, pureId!)).toMatchObject({ workKind: 'remote_effect', worktreePolicy: { required: false } });

    // The same external effect used for local Runtime work stays a local effect.
    const local = routeWorkStart(context, {
      objective: 'Activate one local Runtime release and verify its readiness',
      modeInput: {
        scopeClear: true, mutation: true, requiresRecovery: true,
        requiresExternalEffect: true, remoteWrite: false, risk: 'workspace_write',
      },
    });
    const localId = (local.data as { work?: { workId?: string } }).work?.workId;
    expect(local.status).toBe('ok');
    expect(getWorkContract(workStore, localId!)).toMatchObject({ workKind: 'local_effect' });
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
    expect(result.summary).toContain('Work started');
    expect(result.summary).not.toContain('PLAN_REQUIRED');
    expect(result.data).toMatchObject({ workContractCreated: true });
    expect(workId).toBeTruthy();
    expect(getWorkContract(workStore, workId!)).toMatchObject({ requirementId: 'REQ-route-a' });
    expect(getWorkContract(workStore, workId!)?.planId).toBeUndefined();
  });

  test('does not treat an open semantic Work as shared-checkout writer ownership', () => {
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
    expect(independent.data).toMatchObject({ workContractCreated: true, worktreeRequired: false });
    const independentWorkId = (independent.data as { work?: { workId?: string } }).work?.workId;
    expect(independentWorkId).toBeTruthy();
    expect(independentWorkId).not.toBe(firstWorkId);
    const admitted = getWorkContract({ root: join(root, 'work') }, independentWorkId!);
    expect(admitted).toMatchObject({
      checkoutId: 'checkout-a',
      constraints: { workspaceMode: 'auto', requireWorktree: false },
      worktreePolicy: { required: false },
    });
    expect(admitted?.worktreeRef).toBeUndefined();
    expect(materializationCount).toBe(0);

    const external = routeWorkStart(context, {
      objective: 'Perform an unrelated pure remote action without repository source ownership',
      relatedWorkId: firstWorkId,
      workRelation: 'new_goal',
      workKind: 'remote_effect',
      acceptanceCriteria: ['Remote action receipt exists'],
      modeInput: {
        scopeClear: true, mutation: true, requiresRecovery: true, requiresExternalEffect: true,
        remoteWrite: true, risk: 'remote_write',
      },
    });
    const externalWorkId = (external.data as { work?: { workId?: string } }).work?.workId;
    expect(external.status).toBe('ok');
    expect(externalWorkId).toBeTruthy();
    expect(getWorkContract({ root: join(root, 'work') }, externalWorkId!)).toMatchObject({
      workKind: 'remote_effect',
      checkoutId: 'checkout-a',
      constraints: { workspaceMode: 'auto', requireWorktree: false },
      worktreePolicy: { required: false },
    });

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

  test('treats every rh_work start as an explicit durable Work choice rather than an implicit direct lane', () => {
    const root = temp('route-explicit-work-');
    const context = {
      workStore: { root: join(root, 'work') },
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-explicit-work',
      checkoutId: 'checkout-a',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      sourceRevision: 'revision-a',
      availableChecks: [{ id: 'package:check:type' }],
    };
    const modeInput = { scopeClear: true, mutation: true, risk: 'local_repo_write' as const };
    const first = routeWorkStart(context, { objective: 'Own the long-running repository change', modeInput });
    const firstId = (first.data as { work?: { workId?: string } }).work?.workId;
    expect(first.status).toBe('ok');
    expect(firstId).toBeTruthy();

    const unrelated = routeWorkStart(context, { objective: 'Start another independent repository change', modeInput });
    expect(unrelated.status).toBe('ok');
    expect(unrelated.data).toMatchObject({ workContractCreated: true });
    const unrelatedId = (unrelated.data as { work?: { workId?: string } }).work?.workId;
    expect(unrelatedId).toBeTruthy();
    expect(unrelatedId).not.toBe(firstId);

    const continued = routeWorkStart(context, {
      objective: 'Continue the first Work',
      relatedWorkId: firstId,
      workRelation: 'continue',
      modeInput,
    });
    expect(continued.data).toMatchObject({ workContractCreated: false, admissionDecision: 'reuse_existing', work: { workId: firstId } });
  });
  test('Requirement membership alone never aliases unrelated Work authorities', () => {
    const root = temp('route-semantic-admission-requirement-siblings-');
    const workStore = { root: join(root, 'work') };
    const handoffStore = { root: join(root, 'handoff') };
    const modeInput = { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' as const };
    const siblings = Array.from({ length: 8 }, (_, index) => routeWorkStart({
      workStore, handoffStore, repoId: 'repo-a', checkoutId: `shared-${index}`, sourceRevision: 'revision-a',
    }, {
      objective: `Deliver independent slice ${index} under one portfolio Requirement`,
      requirementId: 'REQ-shared-admission', modeInput,
    }));
    const siblingIds = siblings.map((result) => (result.data as { work?: { workId?: string }; workContractCreated?: boolean }).work?.workId);
    expect(siblings.every((result) => (result.data as { workContractCreated?: boolean }).workContractCreated === true)).toBe(true);
    expect(siblingIds.every(Boolean)).toBe(true);
    expect(new Set(siblingIds).size).toBe(8);
    expect(siblings.every((result) => String((result.data as { admissionDecision?: string }).admissionDecision) !== 'resolution_required')).toBe(true);

    const firstWorkId = siblingIds[0]!;
    const continued = routeWorkStart({ workStore, handoffStore, repoId: 'repo-a', checkoutId: 'shared-0', sourceRevision: 'revision-a' }, {
      objective: 'Continue the explicitly selected first slice', requirementId: 'REQ-shared-admission',
      relatedWorkId: firstWorkId, workRelation: 'continue', modeInput,
    });
    expect(continued.data).toMatchObject({ workContractCreated: false, admissionDecision: 'reuse_existing', work: { workId: firstWorkId } });
  });

  test('ignores low-level execution-child Work when resolving a new business task', () => {
    const root = temp('route-execution-child-admission-');
    const workStore = { root: join(root, 'work') };
    createWorkContract(workStore, {
      workId: 'WORK-child', repoId: 'repo-a', mode: 'direct_control', lifecycleRole: 'execution_child',
      objective: 'Accepted operation run_check', acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true }, allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'system',
    });
    const result = routeWorkStart({
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      sourceRevision: 'revision-a',
    }, {
      objective: 'Make one independent tiny product edit',
      modeInput: { scopeClear: true, mutation: true, risk: 'local_repo_write' },
    });
    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({ workContractCreated: true });
    const workId = (result.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    expect(workId).not.toBe('WORK-child');
  });
  test('never lets scheduler-origin start invent a new durable Work', () => { const root = temp('route-scheduler-admission-'); const result = routeWorkStart({ workStore: { root: join(root, 'work') }, handoffStore: { root: join(root, 'handoff') }, repoId: 'repo-a', checkoutId: 'checkout-a', sourceRevision: 'revision-a' }, { objective: 'Wake scheduled maintenance', requestedBy: 'scheduler', modeInput: { scopeClear: true, mutation: true, expectedFiles: 4, expectedChangedLines: 200, requiresRecovery: true, risk: 'local_repo_write' }, }); expect(result.status).toBe('ok'); expect(result.summary).toContain('SCHEDULER_WORK_BINDING_REQUIRED'); expect(result.data).toMatchObject({ executionStarted: false, workContractCreated: false, admissionDecision: 'resolution_required' }); });
  test('records Plan provenance without granting a Plan item any execution authority', () => {
    const root = temp('route-plan-provenance-');
    const planStore = { root: join(root, 'plan') };
    const workStore = { root: join(root, 'work') };
    createPlanContract(planStore, {
      planId: 'plan-provenance', repoId: 'repo-a', scopeKey: 'provenance', sourceRevision: 'revision-a',
      goal: 'Authored Plan content stays descriptive working memory.',
      steps: [
        {
          id: 'blocked-step', objective: 'Plan-declared objective', dependencies: ['missing-step'], authoritativeFiles: [],
          allowedPaths: ['plan/only/**'], forbiddenPaths: ['plan/forbidden/**'], checks: ['plan:not-registered'],
          acceptanceCriteria: ['Plan-declared acceptance'],
        },
      ],
    });
    // The Plan is deliberately left as an unapproved draft whose only item has an
    // unmet dependency and an unregistered check. Neither Plan approval nor Plan
    // item state may gate ordinary Work admission.
    const result = routeWorkStart({
      workStore, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'controller-a', sourceRevision: 'revision-a',
      availableChecks: [{ id: 'package:check:type' }],
    }, {
      objective: 'Implement the caller-authored slice', planId: 'plan-provenance', planStepId: 'blocked-step',
      allowedPaths: ['src/runtime/**'], checks: ['package:check:type'], acceptanceCriteria: ['caller acceptance'],
      modeInput: { scopeClear: true, mutation: true, expectedFiles: 2, expectedChangedLines: 40, requiresRecovery: true, risk: 'local_repo_write' },
    });
    expect(result.status).toBe('ok');
    const workId = (result.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    // Work scope is authored by the caller; the Plan item contributes nothing.
    expect(getWorkContract(workStore, workId!)).toMatchObject({
      planId: 'plan-provenance', planStepId: 'blocked-step', planSourceRevision: 'revision-a',
      objective: 'Implement the caller-authored slice',
      acceptanceCriteria: ['caller acceptance'],
      allowedPaths: ['src/runtime/**'],
      checks: ['package:check:type'],
    });
    // Plan and item state stay exactly as authored: no claim, no status promotion,
    // no Work link, no execution baseline.
    const plan = getPlanContract(planStore, 'plan-provenance')!;
    expect(plan.status).toBe('draft');
    expect(plan.steps[0]).toMatchObject({ id: 'blocked-step', status: 'pending' });
    expect(plan.steps[0]?.workId).toBeUndefined();
  });

  test('continues a terminal Work without Plan successor selection or Plan acceptance', () => {
    const root = temp('route-plan-successor-');
    const planStore = { root: join(root, 'plan') };
    const workStore = { root: join(root, 'work') };
    createPlanContract(planStore, {
      planId: 'plan-successor', repoId: 'repo-a', requirementId: 'REQ-successor', scopeKey: 'successor-lineage', sourceRevision: 'revision-a',
      goal: 'Deliver two durable slices',
      steps: [
        { id: 'step-a', objective: 'Plan first slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['plan first slice delivered'] },
        { id: 'step-b', objective: 'Plan second slice', dependencies: ['step-a'], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:successor'], acceptanceCriteria: ['plan second slice delivered'] },
      ],
    });
    const context = {
      workStore, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'runtime-a', sourceRevision: 'revision-a',
      availableChecks: [{ id: 'check:successor' }],
    };
    const first = routeWorkStart(context, {
      objective: 'Deliver the caller-authored first slice', planId: 'plan-successor', planStepId: 'step-a', requirementId: 'REQ-successor',
      workKind: 'completed_no_change',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const firstWorkId = (first.data as { work?: { workId?: string } }).work?.workId;
    expect(firstWorkId).toBeTruthy();
    completeNoChangePlanWork(workStore, firstWorkId!, 'REV-successor-first');

    // The successor is chosen by the caller, not by Plan dependency/acceptance state.
    const successor = routeWorkStart(context, {
      objective: 'Deliver the caller-authored second slice', relatedWorkId: firstWorkId, workRelation: 'continue',
      acceptanceCriteria: ['caller second slice delivered'],
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    expect(successor.status).toBe('ok');
    const successorWorkId = (successor.data as { work?: { workId?: string } }).work?.workId;
    expect(successorWorkId).toBeTruthy();
    expect(successorWorkId).not.toBe(firstWorkId);
    expect(getWorkContract(workStore, successorWorkId!)).toMatchObject({
      predecessorWorkId: firstWorkId,
      requirementId: 'REQ-successor',
      planId: 'plan-successor',
      objective: 'Deliver the caller-authored second slice',
      acceptanceCriteria: ['caller second slice delivered'],
    });
    expect(getWorkContract(workStore, successorWorkId!)?.planStepId).toBeUndefined();
    // Plan content is untouched by Work continuation.
    const plan = getPlanContract(planStore, 'plan-successor')!;
    expect(plan.steps[0]).toMatchObject({ id: 'step-a', status: 'pending' });
    expect(plan.steps[1]).toMatchObject({ id: 'step-b', status: 'pending' });
    expect(plan.steps.some((step) => step.workId)).toBe(false);
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

  test('never requires Plan approval or Plan acceptance to finish an ordinary Work', () => {
    const root = temp('route-plan-acceptance-');
    const planStore = { root: join(root, 'plan') };
    const workStore = { root: join(root, 'work') };
    createPlanContract(planStore, {
      planId: 'plan-final-step', repoId: 'repo-a', requirementId: 'REQ-final-step', scopeKey: 'final-step', sourceRevision: 'revision-a',
      goal: 'Complete one authored slice without Plan lifecycle gates',
      steps: [
        { id: 'only-step', objective: 'Plan single slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['check:final'], acceptanceCriteria: ['plan slice delivered'] },
      ],
    });
    const context = {
      workStore, handoffStore: { root: join(root, 'handoff') }, planStore,
      repoId: 'repo-a', checkoutId: 'checkout-a', principalId: 'principal-a', controllerInstanceId: 'runtime-a', sourceRevision: 'revision-a',
      availableChecks: [{ id: 'check:final' }],
    };
    const started = routeWorkStart(context, {
      objective: 'Deliver the authored single slice', planId: 'plan-final-step', planStepId: 'only-step', workKind: 'completed_no_change',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(started.status).toBe('ok');
    expect(workId).toBeTruthy();
    completeNoChangePlanWork(workStore, workId!, 'REV-final-step');

    // A terminal Plan-provenance Work continues (or stops) on caller intent. No
    // Plan acceptance transition and no Plan successor selection is required.
    const continued = routeWorkStart(context, {
      objective: 'Continue the same goal with caller-authored scope', relatedWorkId: workId, workRelation: 'continue',
      modeInput: { scopeClear: true, mutation: false, requiresRecovery: true, risk: 'readonly' },
    });
    expect(continued.status).toBe('ok');
    // Authored Plan item progress is never promoted by approval, Work execution
    // or continuation.
    expect(getPlanContract(planStore, 'plan-final-step')?.steps[0]).toMatchObject({ id: 'only-step', status: 'pending' });
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
      intent: { objective: 'Implement the change', scopeClear: true, mutation: true },
      capabilities: {
        providers: [
          { providerId: 'codex', kind: 'local_cli', status: 'unavailable', capabilities: ['code_patch'], directDispatch: true },
          { providerId: 'claude', kind: 'remote_api', status: 'ready', capabilities: ['code_patch'], directDispatch: true },
        ],
      },
    }));
    expect(decision.selectedProviderId).toBe('claude');
    expect(decision.alternatives).toEqual(['claude']);
  });
  test('ranks eligible providers deterministically from mechanical readiness, not task semantics', () => {
    const providers = [
      { providerId: 'provider-b', kind: 'remote_api' as const, status: 'ready', capabilities: ['code_patch'], directDispatch: true },
      { providerId: 'provider-a', kind: 'local_cli' as const, status: 'ready', capabilities: ['code_patch'], directDispatch: true },
    ];
    const semanticOnly = sharedInput({
      intent: { objective: 'Plan, review and repair a failing build', scopeClear: true, mutation: true },
      capabilities: { providers },
    });
    // Multiple mechanically eligible providers remain alternatives until the caller/model chooses one.
    const first = decideRoute(semanticOnly);
    const second = decideRoute({ ...semanticOnly, intent: { objective: 'Ship a release', scopeClear: true, mutation: true } });
    expect(first.selectedProviderId).toBeNull();
    expect(second.selectedProviderId).toBeNull();
    expect(first.alternatives).toEqual(['provider-a', 'provider-b']);
    expect(second.alternatives).toEqual(first.alternatives);
    expect(first.alternatives).toEqual(['provider-a', 'provider-b']);

    // An explicit operator preference remains a placement/configuration fact.
    const preferred = decideRoute({
      ...semanticOnly,
      intent: { objective: 'Plan, review and repair a failing build', scopeClear: true, mutation: true, preferredProviderId: 'provider-b' },
    });
    expect(preferred.selectedProviderId).toBe('provider-b');
    const forbidden = decideRoute({
      ...semanticOnly,
      intent: { objective: 'Plan, review and repair a failing build', scopeClear: true, mutation: true, forbiddenProviderIds: ['provider-a'] },
    });
    expect(forbidden.selectedProviderId).toBe('provider-b');
    expect(forbidden.alternatives).toEqual(['provider-b']);
  });
  test('keeps dirty-workspace mutation direct while preserving scope evidence', () => {
    const decision = decideRoute(sharedInput({ workspace: { dirty: true, checkoutId: 'checkout-a', fingerprint: 'dirty-a' } }));
    expect(decision).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresIsolation: false, createHandoff: false });
    expect(decision.reasons.map((reason) => reason.code)).toContain('dirty_workspace_preserve_existing_changes');
  });
  test('derives no routing authority from workspace path sets and leaves assurance to the edit/diff gate', () => {
    // Route Policy exposes auth/provider/placement facts only. Path-based
    // protected-path classification was retired; real assurance is owned by the
    // EditSession diff gate (covered in the EditSession identity suite below).
    const releaseSensitive = decideRoute(sharedInput({
      intent: { objective: 'Update a workflow file', scopeClear: true, mutation: true },
      workspace: { knownPaths: ['.github/workflows/ci.yml', 'app.xcodeproj/project.pbxproj'], dirty: false },
    }));
    const ordinary = decideRoute(sharedInput({
      intent: { objective: 'Update a workflow file', scopeClear: true, mutation: true },
      workspace: { knownPaths: ['src/example.ts'], dirty: false },
    }));
    expect(releaseSensitive).toMatchObject({ executionMode: 'direct_control', workMode: 'direct_edit', executionPath: 'fast', requiresWork: false });
    expect(releaseSensitive.reasons.map((reason) => reason.code)).toEqual(ordinary.reasons.map((reason) => reason.code));
    expect(releaseSensitive.reasons.some((reason) => reason.code === 'protected_path')).toBe(false);
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

  test('verify advances a fully verified no-review Work directly to delivery without an extra continue', () => {
    const root = temp('route-verify-auto-delivery-');
    const workStore = { root: join(root, 'work') };
    const context = {
      workStore,
      handoffStore: { root: join(root, 'handoff') },
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      sourceRevision: 'revision-a',
      workspaceFingerprint: 'workspace-a',
      workspaceChangedPaths: [] as string[],
      availableChecks: [{ id: 'check:baseline' }],
    };
    const work = createWorkContract(workStore, {
      workId: 'work-verify-auto-delivery',
      repoId: 'repo-a',
      checkoutId: 'checkout-a',
      mode: 'goal_workloop',
      objective: 'Reconcile already-delivered evidence without source changes.',
      acceptanceCriteria: ['Exact verification is sufficient.'],
      constraints: { requireHandoffOnAmbiguity: true },
      workKind: 'reconciliation',
      checks: ['check:baseline'],
      allowedPaths: [],
      forbiddenPaths: [],
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const recordedAt = '2026-09-20T00:00:00.000Z';
    const verified = verifyGoalWorkloop(context, {
      workId: work.workId,
      checkId: 'check:baseline',
      sourceRevision: 'revision-a',
      workspaceFingerprint: 'workspace-a',
      verificationInputFingerprint: 'verify-auto-delivery-input',
      receipt: {
        schemaVersion: 1,
        receiptId: 'receipt-verify-auto-delivery',
        resultDigest: 'digest-verify-auto-delivery',
        repoId: 'repo-a',
        checkoutId: 'checkout-a',
        workId: work.workId,
        checkId: 'check:baseline',
        processId: 'process-verify-auto-delivery',
        status: 'passed',
        runtimeStatus: 'succeeded',
        ok: true,
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        artifactPath: '.ai/harness/checks/verify-auto-delivery.json',
        summary: 'passed',
        startedAt: recordedAt,
        finishedAt: recordedAt,
      },
    });

    expect(verified).toMatchObject({ status: 'ok', data: { nextStep: 'finalize' } });
    expect(getWorkContract(workStore, work.workId)).toMatchObject({
      status: 'running',
      phase: 'delivery',
      evidenceState: 'valid',
      phaseEvidence: {
        verification: { state: 'satisfied' },
        review: { state: 'skipped' },
      },
    });
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
        mutation: true, scopeClear: true, objective: 'Apply a bounded repository fix',
      },
    });
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.policyVersion).toBe(second.policyVersion);
  });
});
describe('EditSession identity and post-diff assurance', () => {
  function gitRepo() {
    const root = temp('route-edit-');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'README.md'), '# Test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const controllerHome = temp('route-edit-controller-');
    const repository = registerRepository({ path: root, controllerHome, repoIdOverride: 'repo-a' });
    ensureRepositoryRuntimeStorageBinding(repository, 'edit-sessions', controllerHome);
    return { root, repository };
  }
  test('blocks patch execution when workspace fingerprint changes', () => {
    const { root, repository } = gitRepo();
    const session = beginEditSession(root, {
      purpose: 'Bound edit', allowedPaths: ['src/**'],
      binding: { workId: 'work-a', repoId: repository.repoId, checkoutId: repository.activeCheckoutId, principalId: 'principal-a' },
    });
    writeFileSync(join(root, 'outside.txt'), 'unowned change\n');
    expect(() => applyEditOperations(root, getMcpPolicy('executor'), session.sessionId, [
      { type: 'create', path: 'src/example.ts', content: 'export const value = 1;\n' },
    ], {
      binding: { workId: 'work-a', repoId: repository.repoId, checkoutId: repository.activeCheckoutId, principalId: 'principal-a' },
    })).toThrow('EDIT_SESSION_WORKSPACE_FINGERPRINT_CHANGED');
  });
  test('raises assurance when the real diff touches a protected path', () => {
    const { root, repository } = gitRepo();
    const session = beginEditSession(root, {
      purpose: 'Workflow edit', allowedPaths: ['.github/**'],
      binding: { workId: 'work-a', repoId: repository.repoId, checkoutId: repository.activeCheckoutId, principalId: 'principal-a' },
    });
    const updated = applyEditOperations(root, getMcpPolicy('controller'), session.sessionId, [
      { type: 'create', path: '.github/protected.yml', content: 'name: checks\n' },
    ], {
      binding: { workId: 'work-a', repoId: repository.repoId, checkoutId: repository.activeCheckoutId, principalId: 'principal-a' },
    });
    expect(updated.assurance).toMatchObject({ semanticRisk: 'high', approvalRequired: true, verificationDepth: 'architecture' });
    expect(updated.requestedChecks).toContain('package:check:runtime-architecture');
    expect(() => finalizeEditSession(root, session.sessionId, {
      binding: { workId: 'work-a', repoId: repository.repoId, checkoutId: repository.activeCheckoutId, principalId: 'principal-a' },
    })).toThrow('EDIT_SESSION_APPROVAL_REQUIRED');
    expect(readFileSync(join(root, '.github/protected.yml'), 'utf8')).toContain('checks');
  });
});
