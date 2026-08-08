import { randomUUID } from 'crypto';
import {
  createHandoffItem,
  type HandoffInboxStoreOptions,
} from './handoff-inbox-store';
import {
  appendVerificationRecord,
  appendWorkEvidence,
  appendWorkHandoffRef,
  createWorkContract,
  getWorkContract,
  summarizeWorkContract,
  transitionWorkContractPhase,
  updateWorkContract,
  type WorkContractStoreOptions,
} from './work-contract-store';
import {
  claimPlanStepForWork,
  completePlanStepForWork,
  type PlanContractStoreOptions,
} from './plan-contract-store';
import {
  classifyVerificationOutcome,
  normalizeCheckIds,
  reconcileVerificationHistory,
  type CheckDefinitionLike,
} from './check-normalization';
import { evaluatePolicyGate } from './policy-gate';
import { buildFacadeResult } from './facade-result';
import { validateSuggestedNextActions } from './suggested-actions';
import { buildWorkContinuationSnapshot } from './work-continuation';
import type {
  CapabilityRisk,
  EvidenceRef,
  ExecutionModeSelectionInput,
  FacadeResult,
  PlanContract,
  PolicyDecision,
  SuggestedNextAction,
  VerificationRecord,
  WorkContract,
  WorkRisk,
} from './types';
import { selectExecutionMode } from './types';

export type GoalWorkloopOperation = 'start' | 'continue' | 'verify' | 'finalize' | 'stop';

export interface GoalWorkloopContext {
  workStore: WorkContractStoreOptions;
  handoffStore: HandoffInboxStoreOptions;
  repoId: string;
  availableChecks?: readonly CheckDefinitionLike[];
  planStore?: PlanContractStoreOptions;
  sourceRevision?: string;
  checkoutId?: string;
  principalId?: string;
  controllerInstanceId?: string;
  workspaceFingerprint?: string;
  now?: () => string;
}

export interface GoalWorkloopStartInput {
  objective: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  constraints?: WorkContract['constraints'];
  modeInput: ExecutionModeSelectionInput;
  requestedBy?: WorkContract['requestedBy'];
  taskId?: string;
  issueId?: string;
  approvalConfirmed?: boolean;
  dryRun?: boolean;
  forceMode?: WorkContract['mode'];
  planId?: string;
  planStepId?: string;
}

export interface GoalWorkloopContinueInput {
  workId: string;
  note?: string;
}

export interface GoalWorkloopVerifyInput {
  workId: string;
  checkId: string;
  /** When true, simulate infrastructure failure rather than acceptance fail. */
  infrastructureFailed?: boolean;
  /** When true and check is valid, record acceptance failure. */
  checkFailed?: boolean;
  /** When true, skip without acceptance implication. */
  skipped?: boolean;
}

export interface GoalWorkloopFinalizeInput {
  workId: string;
  forceFailed?: boolean;
}

export interface GoalWorkloopStopInput {
  workId: string;
  reason?: string;
  /** Destructive worktree cleanup requires explicit authorization. */
  authorizeDestructiveCleanup?: boolean;
}

function nowIso(ctx: GoalWorkloopContext): string {
  return ctx.now?.() ?? new Date().toISOString();
}

function workIdFor(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'work';
  return `work-${slug}-${randomUUID().slice(0, 8)}`;
}

function handoffIdFor(prefix: string): string {
  return `hnd-${prefix}-${randomUUID().slice(0, 8)}`;
}

function workRiskFor(input: GoalWorkloopStartInput): WorkRisk {
  const risk = input.modeInput.risk;
  if (input.modeInput.secretAccess === true || input.modeInput.destructive === true) return 'destructive';
  if (input.modeInput.remoteWrite === true) return 'high';
  if (risk === 'readonly') return 'readonly';
  if (risk === 'destructive' || risk === 'destructive_remote' || risk === 'raw_secret_config') return 'destructive';
  if (risk === 'remote_write') return 'high';
  if (risk === 'local_repo_write') return 'low';
  return 'medium';
}

function suggestedForWork(work: WorkContract, extras: SuggestedNextAction[] = []): SuggestedNextAction[] {
  const base: SuggestedNextAction[] = [
    {
      label: 'Continue workloop',
      tool: 'rh_work',
      operation: 'continue',
      payload: { work_id: work.workId },
      risk: 'readonly',
      confidence: 'high',
    },
    {
      label: 'Verify registered checks',
      tool: 'rh_work',
      operation: 'verify',
      payload: { work_id: work.workId, check_id: work.checks[0] },
      risk: 'workspace_write',
      confidence: work.checks[0] ? 'high' : 'low',
    },
    {
      label: 'Finalize when ready',
      tool: 'rh_work',
      operation: 'finalize',
      payload: { work_id: work.workId },
      risk: 'readonly',
      confidence: 'medium',
    },
  ];
  return validateSuggestedNextActions([...extras, ...base], {
    validCheckIds: work.checks,
  }).actions;
}

function initialEvidence(objective: string): EvidenceRef {
  return {
    title: 'work contract created',
    summary: `Initial WorkContract for: ${objective.slice(0, 200)}`,
    detailLevel: 'summary',
  };
}

type ReconciledVerificationHistory = ReturnType<typeof reconcileVerificationHistory>;

interface WorkCompletionEvidenceEvaluation {
  status: 'complete' | 'failed' | 'incomplete';
  history: ReconciledVerificationHistory;
  missingChecks: string[];
  durableResultEvidence: boolean;
  reasons: string[];
}

function evaluateWorkCompletionEvidence(
  work: WorkContract,
  history: ReconciledVerificationHistory = reconcileVerificationHistory(
    work.checkRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  ),
): WorkCompletionEvidenceEvaluation {
  const missingChecks = work.checks.filter((checkId) => !history.validPasses.includes(checkId));
  const durableResultEvidence = work.evidenceRefs.some((evidence) => Boolean(evidence.evidenceId || evidence.artifactId));
  const reasons: string[] = [];

  if (history.acceptanceFailures.length > 0) {
    reasons.push(`Acceptance checks failed: ${history.acceptanceFailures.join(', ')}.`);
    return { status: 'failed', history, missingChecks, durableResultEvidence, reasons };
  }
  if (history.infrastructureIssues.length > 0) {
    reasons.push(`Infrastructure issues remain: ${history.infrastructureIssues.join(', ')}.`);
  }
  if (history.invalidCheckIds.length > 0) {
    reasons.push(`Invalid check ids remain: ${history.invalidCheckIds.join(', ')}.`);
  }
  if (missingChecks.length > 0) {
    reasons.push(`Declared checks are missing valid_pass evidence: ${missingChecks.join(', ')}.`);
  }
  if (work.checks.length === 0 && !durableResultEvidence) {
    reasons.push('No durable result evidence (evidenceId or artifactId) was recorded for this no-check WorkContract.');
  }

  const complete = history.infrastructureIssues.length === 0
    && history.invalidCheckIds.length === 0
    && missingChecks.length === 0
    && (work.checks.length > 0 || durableResultEvidence);
  return {
    status: complete ? 'complete' : 'incomplete',
    history,
    missingChecks,
    durableResultEvidence,
    reasons,
  };
}

/**
 * Mode selection for facade routing. Direct control never creates a WorkContract.
 * Goal workloop creates one. Handoff-only creates a handoff and stops.
 */
export function routeWorkStart(
  ctx: GoalWorkloopContext,
  input: GoalWorkloopStartInput,
): FacadeResult {
  const strategyConflictRequiresApproval = input.constraints?.architectureStrategyChange === true
    || input.constraints?.conflictsWithThinHarnessPolicy === true
    || input.constraints?.changesDefaultExecutionStrategy === true;
  const effectiveModeInput: ExecutionModeSelectionInput = {
    ...input.modeInput,
    objective: input.objective,
    knownPaths: input.allowedPaths,
    mutation: input.modeInput.mutation ?? input.modeInput.risk !== 'readonly',
    approvalConfirmed: input.approvalConfirmed === true,
    requiresUserApproval: input.approvalConfirmed === true
      ? false
      : input.modeInput.requiresUserApproval === true || strategyConflictRequiresApproval,
  };
  const applyForcedMode = (selected: ReturnType<typeof selectExecutionMode>) => input.forceMode
    ? {
        ...selected,
        mode: input.forceMode,
        reason: `Forced mode: ${input.forceMode}. ${selected.reason}`,
        createWorkContract: input.forceMode === 'handoff_only' ? false : selected.requiresWork,
        createHandoff: input.forceMode === 'handoff_only',
      }
    : selected;
  const evaluateAccessPolicy = (selected: ReturnType<typeof selectExecutionMode>) => evaluatePolicyGate({
    capabilityId: selected.mode === 'direct_control' ? 'repository.direct_edit' : selected.mode === 'goal_workloop' ? 'controller.goal_workloop' : 'controller.handoff_inbox',
    risk: input.modeInput.risk
      ?? (input.modeInput.secretAccess === true ? 'raw_secret_config'
        : input.modeInput.destructive === true ? 'destructive'
          : input.modeInput.remoteWrite === true ? 'remote_write'
            : input.modeInput.requiresApproval === true || input.modeInput.requiresUserApproval === true ? 'workspace_write'
              : selected.mode === 'direct_control' ? 'local_repo_write'
                : selected.mode === 'goal_workloop' ? 'workspace_write'
                  : 'readonly'),
    accessMode: input.constraints?.accessMode,
    approvalConfirmed: input.approvalConfirmed === true,
    dryRun: input.dryRun === true,
    directEditBoundary: {
      scopeClear: effectiveModeInput.scopeClear,
      maxChangedFiles: effectiveModeInput.expectedFiles,
      maxChangedLines: effectiveModeInput.expectedChangedLines,
      pathsExplicit: effectiveModeInput.scopeClear,
    },
  });

  let selectedMode = selectExecutionMode(effectiveModeInput);
  let policy = evaluateAccessPolicy(selectedMode);
  if (policy.decision === 'allowed' && effectiveModeInput.requiresUserApproval !== true) {
    selectedMode = selectExecutionMode({ ...effectiveModeInput, approvalConfirmed: true });
    policy = evaluateAccessPolicy(selectedMode);
  }
  const mode = applyForcedMode(selectedMode);

  if (mode.mode === 'direct_control' && mode.createWorkContract) {
    return startGoalWorkloop(ctx, input, policy, 'direct_control', mode.routeDecision);
  }

  if (mode.mode === 'direct_control') {
    const available = ctx.availableChecks ?? [];
    const normalized = normalizeCheckIds(input.checks ?? [], available);
    const suggested = validateSuggestedNextActions([
      {
        label: 'Apply bounded direct edit',
        tool: 'rh_work',
        operation: 'start',
        payload: { mode: 'direct_control', objective: input.objective.slice(0, 200) },
        risk: 'local_repo_write',
        confidence: 'high',
        reason: 'Small supervised task stays on Direct Control; no WorkContract created.',
      },
      ...normalized.suggestedNextActions,
      {
        label: 'Read repository context',
        tool: 'rh_context',
        operation: 'get',
        risk: 'readonly',
        confidence: 'medium',
      },
    ], { validCheckIds: normalized.validCheckIds }).actions;

    return buildFacadeResult({
      status: policy.decision === 'denied' ? 'blocked' : 'ok',
      summary: `Direct control recommended. No WorkContract created. ${mode.reason}`,
      data: {
        mode,
        policy,
        workContractCreated: false,
        directControlPreserved: true,
        objective: input.objective.slice(0, 1_000),
        normalizedChecks: normalized,
      },
      warnings: [...policy.warnings, ...normalized.warnings],
      suggestedNextActions: suggested,
      rawAvailable: false,
    });
  }

  // Policy approval decisions stop before Work creation. Ordinary host-managed local work
  // reaches this point only after the same Route Policy has been replayed with the Access
  // Policy's explicit allowed decision as authorization evidence.
  const blockForHandoff =
    mode.mode === 'handoff_only'
    || policy.decision === 'denied'
    || policy.decision === 'approval_required';

  if (blockForHandoff) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffIdFor('route'),
      repoId: ctx.repoId,
      title: 'Work blocked pending decision',
      severity: policy.decision === 'denied' ? 'blocked' : 'needs_review',
      creationReason: !input.modeInput.scopeClear
        ? 'invalid_objective'
        : policy.decision === 'approval_required'
          ? (input.modeInput.destructive ? 'destructive_action_requires_confirmation' : 'policy_approval_required')
          : 'missing_authorization',
      reason: mode.reason,
      summary: `Handoff-only routing: ${mode.reason}`,
      currentState: {
        repoId: ctx.repoId,
        mode: 'handoff_only',
        statusSummary: 'waiting for ChatGPT or user decision; no execution started',
        blockedBy: mode.missingContractFields,
      },
      attemptedActions: ['route_execution_mode'],
      evidenceRefs: [],
      blockingDecision: policy.decision === 'approval_required'
        ? 'Approve side effects or restate a safer objective.'
        : 'Clarify objective, scope, and acceptance criteria.',
      recommendedDecision: 'Provide a clear objective and authorization, or cancel the request.',
      recommendedPrompt: `Resolve handoff and restate work for repo ${ctx.repoId}.`,
      recommendedContinuationPrompt: `After approval, start the approved work for ${ctx.repoId}.`,
      approvalAction: policy.decision === 'approval_required'
        ? {
            operation: 'start',
            label: 'Approve and start work',
            summary: 'Create the work contract with the original scope and explicit approval.',
            risk: input.modeInput.destructive ? 'destructive' : 'workspace_write',
            payload: {
              objective: input.objective,
              acceptanceCriteria: input.acceptanceCriteria,
              allowedPaths: input.allowedPaths,
              forbiddenPaths: input.forbiddenPaths,
              checkIds: input.checks,
              expectedFiles: input.modeInput.expectedFiles,
              expectedChangedLines: input.modeInput.expectedChangedLines,
              scopeClear: input.modeInput.scopeClear,
              requiresInvestigation: input.modeInput.requiresInvestigation,
              requiresLongRunningChecks: input.modeInput.requiresLongRunningChecks,
              requiresWorker: input.modeInput.requiresWorker,
              requiresApproval: input.modeInput.requiresApproval === true || input.modeInput.requiresUserApproval === true,
              destructive: input.modeInput.destructive === true,
              accessMode: input.constraints?.accessMode,
              approvalConfirmed: true,
              forceMode: 'goal_workloop',
            },
          }
        : undefined,
      suggestedNextActions: [
        {
          label: 'Review handoff inbox',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
          confidence: 'high',
        },
      ],
    });

    return buildFacadeResult({
      status: policy.decision === 'denied' ? 'blocked' : policy.decision === 'approval_required' ? 'approval_required' : 'blocked',
      summary: `Handoff-only: no WorkContract created and no execution started. ${mode.reason}`,
      data: {
        mode,
        policy,
        workContractCreated: false,
        handoffId: handoff.id,
        handoff: {
          id: handoff.id,
          status: handoff.status,
          reason: handoff.reason,
          blockingDecision: handoff.blockingDecision,
        },
      },
      warnings: policy.warnings,
      suggestedNextActions: [
        {
          label: 'Read handoff',
          tool: 'rh_inbox',
          operation: 'get',
          payload: { handoff_id: handoff.id },
          risk: 'readonly',
          confidence: 'high',
        },
      ],
      evidenceRefs: [],
      rawAvailable: false,
    });
  }

  return startGoalWorkloop(ctx, input, policy, 'goal_workloop', mode.routeDecision);
}

export function startGoalWorkloop(
  ctx: GoalWorkloopContext,
  input: GoalWorkloopStartInput,
  policy?: PolicyDecision,
  executionMode: 'direct_control' | 'goal_workloop' = 'goal_workloop',
  routeDecision = selectExecutionMode({ ...input.modeInput, objective: input.objective, knownPaths: input.allowedPaths }).routeDecision,
): FacadeResult {
  const at = nowIso(ctx);
  const available = ctx.availableChecks ?? [];
  const normalized = normalizeCheckIds(input.checks ?? [], available);
  const workspaceMode = input.constraints?.workspaceMode ?? 'auto';
  const needsWorktree = executionMode === 'goal_workloop' && (input.constraints?.requireWorktree
    ?? (workspaceMode === 'isolated'
      || (workspaceMode === 'auto' && input.modeInput.requiresParallelism === true)));
  const generatedWorkId = workIdFor(input.objective);
  if (input.planId || input.planStepId) {
    if (!input.planId || !input.planStepId || !ctx.planStore || !ctx.sourceRevision) {
      return buildFacadeResult({ status: 'blocked', summary: 'PLAN_CONTEXT_REQUIRED: plan_id, plan_step_id and a current source revision are required.', data: { executionStarted: false } });
    }
    let claimed: PlanContract;
    try {
      claimed = claimPlanStepForWork(ctx.planStore, {
        planId: input.planId,
        stepId: input.planStepId,
        workId: generatedWorkId,
        sourceRevision: ctx.sourceRevision,
      });
    } catch (error) {
      return buildFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : 'PLAN_STEP_CLAIM_FAILED',
        data: { planId: input.planId, planStepId: input.planStepId, executionStarted: false },
      });
    }
    if (claimed.status === 'invalidated_by_drift') {
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_SOURCE_DRIFT: ${claimed.planId} was invalidated because its source revision no longer matches. Replan before execution.`,
        data: { planId: claimed.planId, executionStarted: false, replanRequired: true },
      });
    }
  }
  const work = createWorkContract(ctx.workStore, {
    workId: generatedWorkId,
    repoId: ctx.repoId,
    checkoutId: ctx.checkoutId,
    principalId: ctx.principalId,
    controllerInstanceId: ctx.controllerInstanceId,
    baseRevision: ctx.sourceRevision,
    workspaceFingerprint: ctx.workspaceFingerprint,
    routeDecisionFingerprint: routeDecision.inputFingerprint,
    routeDecision,
    mode: executionMode,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
    risk: workRiskFor(input),
    status: 'running',
    phase: 'implementation',
    issueId: input.issueId,
    taskId: input.taskId,
    planId: input.planId,
    planStepId: input.planStepId,
    planSourceRevision: input.planId ? ctx.sourceRevision : undefined,
    scopeSummary: input.modeInput.scopeClear ? 'scope declared at start' : 'scope incomplete',
    allowedPaths: input.allowedPaths ?? [],
    forbiddenPaths: input.forbiddenPaths ?? [],
    checks: normalized.validCheckIds,
    driver: {
      preferred: executionMode === 'direct_control'
        ? 'direct_edit'
        : input.modeInput.requiresWorker === true ? 'external_controller' : needsWorktree ? 'isolated_worktree' : 'direct_edit',
      allowWorker: false,
      allowDirectEdit: executionMode === 'direct_control' || (input.modeInput.requiresWorker !== true && !needsWorktree),
    },
    worktreePolicy: {
      required: needsWorktree,
      reason: needsWorktree
        ? 'Isolation was explicitly requested or required for parallel execution.'
        : 'Current workspace is the stability-first default; isolation remains opt-in.',
    },
    evidencePolicy: {
      defaultDetailLevel: 'summary',
      allowRawOptIn: true,
      maxEvidenceRefs: 20,
    },
    approvalPolicy: {
      required: input.modeInput.requiresApproval === true || input.modeInput.requiresUserApproval === true,
      reasons: input.modeInput.requiresApproval || input.modeInput.requiresUserApproval ? ['approval requested at start'] : [],
      confirmed: input.approvalConfirmed === true,
    },
    recoveryPolicy: {
      allowSelfHealing: false,
      maxInfrastructureRetries: 0,
      handoffOnAmbiguity: true,
    },
    requestedBy: input.requestedBy ?? 'chatgpt',
    evidenceRefs: [initialEvidence(input.objective)],
    policyDecisions: policy ? [policy] : [],
    suggestedNextActions: [],
    continuationPrompt: `Continue work ${ctx.repoId}: ${input.objective.slice(0, 200)}`,
  });

  const suggested = suggestedForWork(work, normalized.suggestedNextActions);
  const updated = updateWorkContract(ctx.workStore, work.workId, {
    suggestedNextActions: suggested,
    updatedAt: at,
  });

  return buildFacadeResult({
    status: 'ok',
    summary: executionMode === 'direct_control'
      ? `Direct-control Work lineage started as ${updated.workId}.`
      : `Goal workloop started as ${updated.workId}.`,
    data: {
      mode: {
        mode: executionMode,
        reason: executionMode === 'direct_control'
          ? 'A lightweight WorkContract records the mutation while execution stays on Direct Control.'
          : 'WorkContract created for multi-step recoverable work.',
        createWorkContract: true,
        createHandoff: false,
        missingContractFields: [],
        requiresWork: true,
        routeDecision,
      },
      workContractCreated: true,
      work: summarizeWorkContract(updated),
      worktreeRequired: updated.worktreePolicy.required,
      normalizedChecks: normalized,
      policy,
    },
    evidenceRefs: updated.evidenceRefs,
    warnings: normalized.warnings,
    suggestedNextActions: suggested,
    rawAvailable: false,
  });
}

export function continueGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopContinueInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
      suggestedNextActions: [{ label: 'List work status', tool: 'rh_status', operation: 'get', risk: 'readonly' }],
    });
  }

  if (work.status === 'cancelled' || work.status === 'completed' || work.status === 'failed') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WorkContract ${work.workId} is terminal (${work.status}); continue is not allowed.`,
      data: { work: summarizeWorkContract(work) },
      suggestedNextActions: [
        {
          label: 'Inspect work via context',
          tool: 'rh_context',
          operation: 'get',
          payload: { work_id: work.workId },
          risk: 'readonly',
        },
      ],
    });
  }

  const history = reconcileVerificationHistory(
    work.checkRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  );

  // Ambiguous: acceptance failure present → handoff for ChatGPT review rather than pretend progress.
  if (history.acceptanceFailures.length > 0 && work.recoveryPolicy.handoffOnAmbiguity) {
    const continuation = buildWorkContinuationSnapshot(work);
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffIdFor('continue'),
      repoId: ctx.repoId,
      workId: work.workId,
      title: 'Acceptance failure needs review',
      severity: 'needs_review',
      creationReason: 'ambiguous_outcome',
      reason: `Acceptance checks failed: ${history.acceptanceFailures.join(', ')}`,
      summary: 'Continue paused; ChatGPT must decide repair vs re-scope.',
      currentState: {
        repoId: ctx.repoId,
        workId: work.workId,
        mode: work.mode,
        statusSummary: 'waiting_for_review after acceptance failure',
        checks: history.acceptanceFailures.map((checkId) => ({ checkId, ok: false, outcome: 'valid_fail' as const })),
        workSemantics: continuation.semantics,
        reconciliationRequired: continuation.reconciliationRequired,
        nextSafeAction: continuation.nextSafeAction,
      },
      attemptedActions: ['continue'],
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      blockingDecision: 'Decide whether to repair code, adjust acceptance criteria, or stop.',
      recommendedDecision: 'Inspect evidence and either repair or stop the workloop.',
      recommendedPrompt: work.continuationPrompt ?? `Continue from work ${work.workId}.`,
      recommendedContinuationPrompt: continuation.continuationPrompt,
      suggestedNextActions: [
        {
          label: 'Read work context',
          tool: 'rh_context',
          operation: 'get',
          payload: { work_id: work.workId },
          risk: 'readonly',
        },
      ],
    });
    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'ready',
      phase: 'verification',
      state: 'blocked',
      summary: `Acceptance failure requires review through handoff ${handoff.id}.`,
      evidenceRefs: work.evidenceRefs,
    });
    const updated = appendWorkHandoffRef(ctx.workStore, work.workId, handoff.id);

    return buildFacadeResult({
      status: 'blocked',
      summary: `Continue paused for ChatGPT review; handoff ${handoff.id} created. No background execution pretended.`,
      data: {
        work: summarizeWorkContract(updated),
        handoffId: handoff.id,
        acceptanceFailures: history.acceptanceFailures,
        infrastructureIssues: history.infrastructureIssues,
        backgroundCompleted: false,
      },
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      suggestedNextActions: [
        {
          label: 'Get handoff',
          tool: 'rh_inbox',
          operation: 'get',
          payload: { handoff_id: handoff.id },
          risk: 'readonly',
          confidence: 'high',
        },
      ],
    });
  }

  // Infrastructure issues: suggest self-healing, not acceptance failure.
  if (history.infrastructureIssues.length > 0) {
    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'running',
      phase: 'implementation',
      state: 'active',
      summary: `Infrastructure issues require repair: ${history.infrastructureIssues.join(', ')}.`,
      evidenceRefs: work.evidenceRefs,
    });
    const updated = updateWorkContract(ctx.workStore, work.workId, {
      suggestedNextActions: [
        {
          label: 'Diagnose runtime (dry-run)',
          tool: 'rh_work',
          operation: 'repair',
          payload: { work_id: work.workId, repair_operation: 'diagnose', dry_run: true },
          risk: 'readonly',
          confidence: 'high',
          reason: 'Infrastructure failure is not an acceptance failure.',
        },
        ...suggestedForWork(work),
      ],
    });
    return buildFacadeResult({
      status: 'ok',
      summary: `Continue: infrastructure issues detected for ${history.infrastructureIssues.join(', ')}; suggest self-healing, not acceptance failure.`,
      data: {
        work: summarizeWorkContract(updated),
        infrastructureIssues: history.infrastructureIssues,
        acceptanceFailures: [],
        backgroundCompleted: false,
        nextStep: 'repair_or_reverify',
      },
      warnings: ['infrastructure_failure ≠ acceptance_failure'],
      suggestedNextActions: updated.suggestedNextActions,
    });
  }

  if (work.checks.length > 0 && history.validPasses.length < work.checks.length) {
    const remaining = work.checks.filter((checkId) => !history.validPasses.includes(checkId));
    const suggested = validateSuggestedNextActions(
      remaining.map((checkId) => ({
        label: `Verify ${checkId}`,
        tool: 'rh_work' as const,
        operation: 'verify',
        payload: { work_id: work.workId, check_id: checkId },
        risk: 'workspace_write' as const,
        confidence: 'high' as const,
      })),
      { validCheckIds: work.checks },
    ).actions;
    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'running',
      phase: 'verification',
      state: 'active',
      summary: `Verification remains for: ${remaining.join(', ')}.`,
      evidenceRefs: work.evidenceRefs,
    });
    const updated = updateWorkContract(ctx.workStore, work.workId, {
      suggestedNextActions: suggested,
      continuationPrompt: input.note
        ? `${work.continuationPrompt ?? ''}\nNote: ${input.note}`.slice(0, 2_000)
        : work.continuationPrompt,
    });
    return buildFacadeResult({
      status: 'ok',
      summary: `Continue: next step is verification of ${remaining[0]}. No background work was completed.`,
      data: {
        work: summarizeWorkContract(updated),
        remainingChecks: remaining,
        backgroundCompleted: false,
        nextStep: 'verify',
      },
      suggestedNextActions: suggested,
    });
  }

  const completionEvidence = evaluateWorkCompletionEvidence(work, history);
  if (completionEvidence.status !== 'complete') {
    const suggested = validateSuggestedNextActions([
      {
        label: 'Read repository context before executing',
        tool: 'rh_context',
        operation: 'get',
        payload: { work_id: work.workId },
        risk: 'readonly',
        confidence: 'high',
        reason: 'A WorkContract is orchestration state, not proof that source changes or an agent run occurred.',
      },
    ]).actions;
    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'running',
      phase: 'implementation',
      state: 'active',
      summary: `Meaningful implementation evidence is still missing: ${completionEvidence.reasons.join(' ')}`,
      evidenceRefs: work.evidenceRefs,
    });
    const updated = updateWorkContract(ctx.workStore, work.workId, {
      suggestedNextActions: suggested,
    });
    return buildFacadeResult({
      status: 'blocked',
      summary: `Continue requires meaningful completion evidence. ${completionEvidence.reasons.join(' ')}`,
      data: {
        work: summarizeWorkContract(updated),
        backgroundCompleted: false,
        nextStep: 'execute',
        executionEvidencePresent: false,
        missingChecks: completionEvidence.missingChecks,
        durableResultEvidence: completionEvidence.durableResultEvidence,
        ignoredWeakReferences: {
          workerRef: Boolean(work.workerRef),
          worktreeRef: Boolean(work.worktreeRef),
        },
      },
      suggestedNextActions: suggested,
    });
  }

  const suggested = validateSuggestedNextActions([
    {
      label: 'Finalize work',
      tool: 'rh_work',
      operation: 'finalize',
      payload: { work_id: work.workId },
      risk: 'readonly',
      confidence: 'high',
    },
  ]).actions;
  transitionWorkContractPhase(ctx.workStore, work.workId, {
    status: 'running',
    phase: 'delivery',
    state: 'active',
    summary: 'Implementation and verification evidence are sufficient; exact delivery and cleanup receipt is next.',
    evidenceRefs: work.evidenceRefs,
  });
  const updated = updateWorkContract(ctx.workStore, work.workId, {
    suggestedNextActions: suggested,
  });
  return buildFacadeResult({
    status: 'ok',
    summary: `Continue: checks satisfied or none required; ready to finalize after ChatGPT review.`,
    data: {
      work: summarizeWorkContract(updated),
      backgroundCompleted: false,
      nextStep: 'finalize',
    },
    suggestedNextActions: suggested,
  });
}

export function verifyGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopVerifyInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
    });
  }

  const available = ctx.availableChecks ?? work.checks.map((id) => ({ id }));
  const classified = classifyVerificationOutcome({
    checkId: input.checkId,
    available,
    infrastructureFailed: input.infrastructureFailed,
    checkFailed: input.checkFailed,
    skipped: input.skipped,
  });

  const at = nowIso(ctx);
  const record: VerificationRecord = {
    checkId: classified.normalizedCheckId ?? classified.checkId,
    outcome: classified.outcome,
    summary: classified.summary,
    recordedAt: at,
    evidenceRef: {
      title: `verification:${classified.outcome}`,
      summary: classified.summary,
      detailLevel: 'summary',
    },
  };

  // Supersede prior invalid/infrastructure noise when a valid outcome arrives for the same check.
  let checkRefs = work.checkRefs;
  if (classified.outcome === 'valid_pass' || classified.outcome === 'valid_fail') {
    checkRefs = work.checkRefs.map((existing) => {
      if (
        existing.checkId === record.checkId
        && (existing.outcome === 'invalid_check_id' || existing.outcome === 'infrastructure_failure')
      ) {
        return { ...existing, outcome: 'superseded' as const, summary: `Superseded by ${classified.outcome} at ${at}` };
      }
      return existing;
    });
    updateWorkContract(ctx.workStore, work.workId, { checkRefs });
  }

  const updated = appendVerificationRecord(ctx.workStore, work.workId, record);
  if (record.evidenceRef) appendWorkEvidence(ctx.workStore, work.workId, record.evidenceRef);

  const status =
    classified.outcome === 'invalid_check_id' || classified.outcome === 'infrastructure_failure'
      ? 'ok'
      : classified.outcome === 'valid_fail'
        ? 'failed'
        : 'ok';

  const suggested = validateSuggestedNextActions(
    classified.outcome === 'valid_pass'
      ? [{
          label: 'Continue workloop',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: work.workId },
          risk: 'readonly',
          confidence: 'high',
        }]
      : classified.outcome === 'valid_fail'
        ? [{
            label: 'Continue for review handoff',
            tool: 'rh_work',
            operation: 'continue',
            payload: { work_id: work.workId },
            risk: 'readonly',
            confidence: 'high',
          }]
        : [{
            label: 'Diagnose infrastructure (dry-run)',
            tool: 'rh_work',
            operation: 'repair',
            payload: { work_id: work.workId, repair_operation: 'diagnose', dry_run: true },
            risk: 'readonly',
            confidence: 'high',
          }],
    { validCheckIds: work.checks },
  ).actions;

  return buildFacadeResult({
    status: status === 'failed' ? 'failed' : 'ok',
    summary: classified.summary,
    data: {
      work: summarizeWorkContract(updated),
      verification: {
        checkId: record.checkId,
        outcome: classified.outcome,
        isAcceptanceFailure: classified.isAcceptanceFailure,
        isInfrastructureIssue: classified.isInfrastructureIssue,
        // Explicitly separate pollution classes for ChatGPT.
        doesNotRequestTaskChanges: !classified.isAcceptanceFailure,
      },
      backgroundCompleted: false,
    },
    warnings: classified.warnings,
    evidenceRefs: record.evidenceRef ? [record.evidenceRef] : [],
    suggestedNextActions: suggested,
  });
}

export function finalizeGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopFinalizeInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
    });
  }

  if (work.status === 'cancelled') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WorkContract ${work.workId} was cancelled; finalize is not allowed.`,
      data: { work: summarizeWorkContract(work) },
    });
  }

  // A Work-owned completion receipt is the strongest delivery/cleanup authority.
  // Physical finalization records status=completed + receipt atomically. A facade
  // retry must be idempotent and must never re-run weaker pre-delivery evidence
  // evaluation that could attempt to demote an already completed Work.
  if (work.status === 'completed' && work.completionReceipt) {
    if (work.planId && work.planStepId && ctx.planStore) {
      completePlanStepForWork(ctx.planStore, { planId: work.planId, stepId: work.planStepId, work });
    }
    return buildFacadeResult({
      status: 'ok',
      summary: `Finalize result: succeeded for ${work.workId}.`,
      data: {
        work: summarizeWorkContract(work),
        finalStatus: 'completed',
        completionReceipt: work.completionReceipt,
        idempotent: true,
        hiddenFailure: false,
      },
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      suggestedNextActions: [{ label: 'Read controller status', tool: 'rh_status', operation: 'get', risk: 'readonly' }],
    });
  }

  const completionEvidence = evaluateWorkCompletionEvidence(work);
  const history = completionEvidence.history;

  if (input.forceFailed || completionEvidence.status === 'failed') {
    const updated = transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'failed',
      phase: 'cleanup',
      state: 'failed',
      summary: `Work failed acceptance/finalization: ${history.acceptanceFailures.join(', ') || 'forced failure'}.`,
      evidenceRefs: work.evidenceRefs,
    });
    if (updated.planId && updated.planStepId && ctx.planStore) {
      completePlanStepForWork(ctx.planStore, { planId: updated.planId, stepId: updated.planStepId, work: updated });
    }
    return buildFacadeResult({
      status: 'failed',
      summary: `Finalize result: failed. Acceptance failures: ${history.acceptanceFailures.join(', ') || 'forced'}.`,
      data: {
        work: summarizeWorkContract(updated),
        finalStatus: 'failed',
        acceptanceFailures: history.acceptanceFailures,
        infrastructureIssues: history.infrastructureIssues,
        invalidCheckIds: history.invalidCheckIds,
        // Failures are not hidden.
        hiddenFailure: false,
      },
      suggestedNextActions: [
        {
          label: 'List handoffs',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
        },
      ],
    });
  }

  // Weak refs, partial checks, invalid ids, and infrastructure issues never imply successful completion.
  if (completionEvidence.status === 'incomplete') {
    const updated = transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'ready',
      phase: 'verification',
      state: 'blocked',
      summary: `Completion evidence remains incomplete: ${completionEvidence.reasons.join(' ')}`,
      evidenceRefs: work.evidenceRefs,
    });
    return buildFacadeResult({
      status: 'blocked',
      summary: `Finalize result: waiting_for_review. ${completionEvidence.reasons.join(' ')}`,
      data: {
        work: summarizeWorkContract(updated),
        finalStatus: 'ready',
        infrastructureIssues: history.infrastructureIssues,
        invalidCheckIds: history.invalidCheckIds,
        validPasses: history.validPasses,
        missingChecks: completionEvidence.missingChecks,
        durableResultEvidence: completionEvidence.durableResultEvidence,
        ignoredWeakReferences: {
          workerRef: Boolean(work.workerRef),
          worktreeRef: Boolean(work.worktreeRef),
        },
        hiddenFailure: false,
      },
      suggestedNextActions: [
        {
          label: 'Continue workloop',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: work.workId },
          risk: 'readonly',
        },
      ],
    });
  }

  // Checks and result evidence are necessary but not sufficient. Delivery and
  // cleanup must produce the exact Work-owned receipt before Work can become
  // terminal; a Run exit or a missing receipt is never completion authority.
  if (!work.completionReceipt) {
    const updated = transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'ready',
      phase: 'delivery',
      state: 'blocked',
      summary: 'Exact delivery and cleanup completion receipt is required.',
      evidenceRefs: work.evidenceRefs,
    });
    return buildFacadeResult({
      status: 'blocked',
      summary: `Finalize blocked for ${work.workId}: an exact delivery and cleanup completion receipt is required.`,
      data: { work: summarizeWorkContract(updated), finalStatus: 'ready', completionReceiptRequired: true },
      suggestedNextActions: [{ label: 'Complete Work delivery and cleanup', tool: 'rh_work', operation: 'finalize', payload: { work_id: work.workId }, risk: 'local_repo_write' }],
    });
  }

  const updated = getWorkContract(ctx.workStore, work.workId)!;
  if (updated.planId && updated.planStepId && ctx.planStore) {
    completePlanStepForWork(ctx.planStore, { planId: updated.planId, stepId: updated.planStepId, work: updated });
  }
  return buildFacadeResult({
    status: 'ok',
    summary: `Finalize result: succeeded for ${work.workId}.`,
    data: {
      work: summarizeWorkContract(updated),
      finalStatus: 'completed',
      validPasses: history.validPasses,
      hiddenFailure: false,
    },
    evidenceRefs: work.evidenceRefs.slice(0, 5),
    suggestedNextActions: [
      {
        label: 'Read controller status',
        tool: 'rh_status',
        operation: 'get',
        risk: 'readonly',
      },
    ],
  });
}

export function stopGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopStopInput): FacadeResult {
  const work = getWorkContract(ctx.workStore, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
    });
  }

  const destructiveCleanup = input.authorizeDestructiveCleanup === true;
  transitionWorkContractPhase(ctx.workStore, work.workId, {
    status: 'cancelled',
    phase: 'cleanup',
    state: 'skipped',
    summary: input.reason ? `Stopped: ${input.reason}` : 'Work stopped without destructive cleanup.',
    evidenceRefs: work.evidenceRefs,
  });
  const updated = updateWorkContract(ctx.workStore, work.workId, {
    continuationPrompt: input.reason
      ? `Stopped: ${input.reason}`.slice(0, 2_000)
      : work.continuationPrompt,
    // Authorization is not proof of cleanup. Preserve the reference until a real
    // cleanup handler verifies ownership, cleanliness and successful removal.
    worktreeRef: work.worktreeRef,
  });

  return buildFacadeResult({
    status: 'ok',
    summary: `WorkContract ${work.workId} cancelled/stopped. Evidence retained. Worktree cleanup ${destructiveCleanup ? 'authorized but pending verification' : 'not performed'}.`,
    data: {
      work: summarizeWorkContract(updated),
      finalStatus: 'cancelled',
      evidenceRetained: true,
      worktreeDeleted: false,
      cleanupPending: destructiveCleanup && Boolean(work.worktreeRef),
      destructiveCleanupAuthorized: destructiveCleanup,
    },
    evidenceRefs: work.evidenceRefs.slice(0, 5),
    suggestedNextActions: [
      {
        label: 'List pending handoffs',
        tool: 'rh_inbox',
        operation: 'list',
        risk: 'readonly',
      },
    ],
  });
}

export function runGoalWorkloop(
  ctx: GoalWorkloopContext,
  operation: GoalWorkloopOperation,
  args: Record<string, unknown>,
): FacadeResult {
  switch (operation) {
    case 'start':
      return routeWorkStart(ctx, {
        objective: String(args.objective ?? ''),
        acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
        allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
        forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
        checks: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
        modeInput: {
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          expectedFiles: typeof args.expected_files === 'number' ? args.expected_files : undefined,
          expectedChangedLines: typeof args.expected_changed_lines === 'number' ? args.expected_changed_lines : undefined,
          scopeClear: args.scope_clear === undefined ? true : args.scope_clear === true,
          requiresInvestigation: args.requires_investigation === true,
          requiresLongRunningChecks: args.requires_long_running_checks === true,
          requiresParallelism: args.requires_parallelism === true,
          needsDependencies: args.needs_dependencies === true,
          requiresRecovery: args.requires_recovery === true,
          requiresWorker: args.requires_worker === true,
          requiresExternalEffect: args.requires_external_effect === true,
          requiresApproval: args.requires_approval === true,
          requiresUserApproval: args.requires_user_approval === true,
          destructive: args.destructive === true,
          remoteWrite: args.remote_write === true,
          secretAccess: args.secret_access === true,
          risk: typeof args.risk === 'string' ? args.risk as CapabilityRisk : undefined,
        },
        requestedBy: args.requested_by === 'user' || args.requested_by === 'system' || args.requested_by === 'scheduler' ? args.requested_by : 'chatgpt',
        taskId: typeof args.task_id === 'string' ? args.task_id : undefined,
        issueId: typeof args.issue_id === 'string' ? args.issue_id : undefined,
        approvalConfirmed: args.approval_confirmed === true,
        dryRun: args.dry_run === true,
        forceMode: args.force_mode === 'direct_control' || args.force_mode === 'goal_workloop' || args.force_mode === 'handoff_only'
          ? args.force_mode
          : undefined,
        planId: typeof args.plan_id === 'string' ? args.plan_id : undefined,
        planStepId: typeof args.plan_step_id === 'string' ? args.plan_step_id : undefined,
      });
    case 'continue':
      return continueGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        note: typeof args.note === 'string' ? args.note : undefined,
      });
    case 'verify':
      return verifyGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        checkId: String(args.check_id ?? args.checkId ?? ''),
        infrastructureFailed: args.infrastructure_failed === true,
        checkFailed: args.check_failed === true,
        skipped: args.skipped === true,
      });
    case 'finalize':
      return finalizeGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        forceFailed: args.force_failed === true,
      });
    case 'stop':
      return stopGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        authorizeDestructiveCleanup: args.authorize_destructive_cleanup === true,
      });
    default:
      return buildFacadeResult({
        status: 'failed',
        summary: `Unknown goal workloop operation: ${String(operation)}`,
        data: { operation },
      });
  }
}
