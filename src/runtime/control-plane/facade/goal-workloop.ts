import { randomUUID } from 'crypto';
import {
  createHandoffItem,
  listHandoffItems,
  type HandoffInboxStoreOptions,
} from './handoff-inbox-store';
import { getControllerSession } from './controller-session-store';
import {
  appendVerificationRecord,
  appendWorkEvidence,
  appendWorkHandoffRef,
  createWorkContract,
  getWorkContract,
  listWorkContracts,
  recordWorkScopeEvidence,
  summarizeWorkContract,
  transitionWorkContractPhase,
  updateWorkContract,
  type WorkContractStoreOptions,
} from './work-contract-store';
import {
  claimPlanStepForWork,
  completePlanStepForWork,
  getPlanContract,
  type PlanContractStoreOptions,
} from './plan-contract-store';
import { withPrimaryWorkAdmissionLock } from './semantic-admission';
import { readRequirement } from '../persistence/requirement-store';
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
  WorkKind,
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
  /** Current net repository paths changed from the Work base plus dirty checkout paths. */
  workspaceChangedPaths?: readonly string[];
  now?: () => string;
  /** True only while a Gateway caller holds the cross-process primary Work admission lock. */
  semanticAdmissionLocked?: boolean;
  materializeIsolatedWorkspace?: (input: { workId: string; title: string; baseRef?: string; needsDependencies?: boolean }) => { checkoutId: string; root: string; baseRevision?: string | null; managed: true };
}

export type WorkAdmissionRelation = 'continue' | 'extend' | 'parallel' | 'new_goal';

export interface GoalWorkloopStartInput {
  objective: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  /** Non-authoritative first-pass discovery candidates. */
  initialLikelyPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  constraints?: WorkContract['constraints'];
  modeInput: ExecutionModeSelectionInput;
  requestedBy?: WorkContract['requestedBy'];
  relatedWorkId?: string;
  workRelation?: WorkAdmissionRelation;
  requirementId?: string;
  taskId?: string;
  issueId?: string;
  approvalConfirmed?: boolean;
  dryRun?: boolean;
  forceMode?: WorkContract['mode'];
  planId?: string;
  planStepId?: string;
  /** Explicit technical evidence shape chosen by the semantic Controller. Never inferred from objective/check text. */
  workKind?: Extract<WorkKind, 'repository_change' | 'completed_no_change' | 'investigation' | 'reconciliation'>;
}

export interface GoalWorkloopContinueInput {
  workId: string;
  note?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  additionalLikelyPaths?: string[];
  inspectedPaths?: string[];
  /** Explicit Controller decision after deterministic acceptance failure; never inferred from note text. */
  acceptanceFailureDecision?: 'repair' | 'rescope';
}

export interface GoalWorkloopVerifyInput {
  workId: string;
  checkId: string;
  /** Exact Git revision observed by the authoritative Work-bound verification Process. */
  sourceRevision?: string;
  /** Exact dirty-workspace content identity observed by the authoritative check. */
  workspaceFingerprint?: string;
  /** Stable semantic check-input identity used for exact evidence reuse. */
  verificationInputFingerprint?: string;
  /** Bounded command/invocation audit identity; not part of reusable semantic inputs. */
  commandFingerprint?: string;
  /** Persistence-safe Process receipt. Accepted only when its Work/repo/check identity matches this verification. */
  receipt?: VerificationRecord['receipt'];
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

function suggestedForWorkIdentity(workId: string, checks: string[], extras: SuggestedNextAction[] = []): SuggestedNextAction[] {
  const base: SuggestedNextAction[] = [
    {
      label: 'Continue workloop',
      tool: 'rh_work',
      operation: 'continue',
      payload: { work_id: workId },
      risk: 'readonly',
      confidence: 'high',
    },
    {
      label: 'Verify registered checks',
      tool: 'rh_work',
      operation: 'verify',
      payload: { work_id: workId, check_id: checks[0] },
      risk: 'workspace_write',
      confidence: checks[0] ? 'high' : 'low',
    },
    {
      label: 'Finalize when ready',
      tool: 'rh_work',
      operation: 'finalize',
      payload: { work_id: workId },
      risk: 'readonly',
      confidence: 'medium',
    },
  ];
  return validateSuggestedNextActions([...extras, ...base], {
    validCheckIds: checks,
  }).actions;
}

function suggestedForWork(work: WorkContract, extras: SuggestedNextAction[] = []): SuggestedNextAction[] {
  return suggestedForWorkIdentity(work.workId, work.checks, extras);
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

function verificationRecordAppliesToCurrentWorkspace(
  record: VerificationRecord,
  currentRevision?: string,
  currentWorkspaceFingerprint?: string,
): boolean {
  if (currentRevision && record.sourceRevision && record.sourceRevision !== currentRevision) return false;
  if (
    currentWorkspaceFingerprint
    && record.workspaceFingerprint
    && record.workspaceFingerprint !== currentWorkspaceFingerprint
  ) return false;
  return true;
}

function isAuthoritativeCurrentWorkVerification(
  work: WorkContract,
  record: VerificationRecord,
  currentRevision?: string,
): boolean {
  const receipt = record.receipt;
  return Boolean(
    currentRevision
    && record.outcome === 'valid_pass'
    && record.sourceRevision === currentRevision
    && receipt
    && receipt.repoId === work.repoId
    && receipt.workId === work.workId
    && receipt.checkId === record.checkId
    && receipt.ok === true
    && receipt.timedOut === false
    && receipt.cancelled === false,
  );
}

interface WorkImplementationEvidenceEvaluation {
  status: 'complete' | 'incomplete';
  changedPaths: string[];
  reasons: string[];
}

function evaluateWorkImplementationEvidence(
  work: WorkContract,
  currentWorkspaceChangedPaths: readonly string[] = [],
): WorkImplementationEvidenceEvaluation {
  if (work.workKind !== 'repository_change') {
    return { status: 'complete', changedPaths: [], reasons: [] };
  }

  const changedPaths = [...new Set(currentWorkspaceChangedPaths.map((path) => path.trim()).filter(Boolean))].sort();
  if (changedPaths.length > 0) {
    return { status: 'complete', changedPaths, reasons: [] };
  }

  return {
    status: 'incomplete',
    changedPaths: [],
    reasons: ['Repository-change Work has no current net source changes relative to its base revision. Verification evidence cannot substitute for implementation evidence.'],
  };
}

function evaluateWorkCompletionEvidence(
  work: WorkContract,
  currentRevision?: string,
  currentWorkspaceFingerprint?: string,
): WorkCompletionEvidenceEvaluation {
  const applicableCheckRefs = work.checkRefs.filter((record) =>
    verificationRecordAppliesToCurrentWorkspace(record, currentRevision, currentWorkspaceFingerprint));
  const history = reconcileVerificationHistory(
    applicableCheckRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  );
  const missingChecks = work.checks.filter((checkId) => !history.validPasses.includes(checkId));
  const durableResultEvidence = work.evidenceRefs.some((evidence) => Boolean(evidence.evidenceId || evidence.artifactId))
    || applicableCheckRefs.some((record) => isAuthoritativeCurrentWorkVerification(work, record, currentRevision));
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
    const staleWorkVerification = work.checkRefs.some((record) =>
      Boolean(record.receipt)
      && !verificationRecordAppliesToCurrentWorkspace(record, currentRevision, currentWorkspaceFingerprint));
    reasons.push(staleWorkVerification
      ? 'Work-bound verification evidence is stale for the current source/workspace identity.'
      : 'No durable result evidence (evidenceId, artifactId, or current Work-bound verification receipt) was recorded for this no-check WorkContract.');
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
  if (effectiveModeInput.explicitMode === 'scale' && (!input.planId || !input.planStepId || !ctx.planStore)) {
    return buildFacadeResult({
      status: 'blocked',
      summary: 'SCALE_PLAN_REQUIRED: explicit Scale execution requires a bound approved PlanContract step.',
      data: { executionStarted: false, workContractCreated: false, planRequired: true, explicitMode: 'scale' },
    });
  }
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
  let mode = applyForcedMode(selectedMode);

  // Route Policy is the sole execution-depth authority. Existing Work is
  // ownership context, not a reason to upgrade an otherwise Direct operation
  // into Durable Work. Explicit Work/Plan ownership is resolved only after a
  // durable route has already been selected; checkout writer conflicts affect
  // placement, not semantic task identity.

  if (mode.mode === 'direct_control') {
    const available = ctx.availableChecks ?? [];
    const normalized = normalizeCheckIds(input.checks ?? [], available);
    // Explicit ownership may annotate a Direct operation, but it never changes
    // the RouteDecision. The actual repository mutation can pass this Work id
    // to repository_safe_patch_apply / repository_command_execute for evidence
    // attribution while staying on the Direct/Process path.
    const directOwnershipCandidates = input.relatedWorkId || (input.planId && input.planStepId)
      ? listWorkContracts({ ...ctx.workStore, status: 'active', limit: 100 })
          .filter((candidate) => (candidate.lifecycleRole ?? 'primary') === 'primary')
      : [];
    const directPlan = input.planId && ctx.planStore ? getPlanContract(ctx.planStore, input.planId) : undefined;
    const directPlanStep = directPlan && input.planStepId ? directPlan.steps.find((step) => step.id === input.planStepId) : undefined;
    const directOwner = (input.relatedWorkId
      ? directOwnershipCandidates.find((candidate) => candidate.workId === input.relatedWorkId)
      : undefined)
      ?? (directPlanStep?.workId
        ? directOwnershipCandidates.find((candidate) => candidate.workId === directPlanStep.workId)
        : undefined);
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
        ...(directOwner ? {
          ownership: {
            workId: directOwner.workId,
            relation: input.workRelation ?? 'continue',
            executionDepthPreserved: true,
          },
        } : {}),
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
  const hasStrongAdmissionBinding = Boolean(input.planId || input.planStepId || input.requirementId || input.relatedWorkId || input.workRelation);
  if (hasStrongAdmissionBinding && !ctx.semanticAdmissionLocked) {
    return withPrimaryWorkAdmissionLock(ctx.workStore, () => startGoalWorkloop(
      { ...ctx, semanticAdmissionLocked: true },
      input,
      policy,
      executionMode,
      routeDecision,
    ));
  }
  const at = nowIso(ctx);
  const available = ctx.availableChecks ?? [];
  const workspaceMode = input.constraints?.workspaceMode ?? 'auto';
  const activeWorks = listWorkContracts({ ...ctx.workStore, status: 'active', limit: 100 })
    .filter((candidate) => (candidate.lifecycleRole ?? 'primary') === 'primary');
  const workspaceOwner = ctx.checkoutId
    ? activeWorks.find((candidate) => candidate.checkoutId === ctx.checkoutId
      && candidate.worktreePolicy.required !== true
      && !candidate.worktreeRef)
    : undefined;
  const explicitRelatedWork = input.relatedWorkId
    ? activeWorks.find((candidate) => candidate.workId === input.relatedWorkId)
    : undefined;
  const plan = input.planId && ctx.planStore ? getPlanContract(ctx.planStore, input.planId) : undefined;
  const planStep = plan && input.planStepId ? plan.steps.find((step) => step.id === input.planStepId) : undefined;
  const requestedRequirementId = input.requirementId?.trim() || undefined;
  if (plan && requestedRequirementId && requestedRequirementId !== plan.requirementId) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `PLAN_REQUIREMENT_MISMATCH: ${plan.planId} is bound to ${plan.requirementId ?? 'no Requirement'}, not ${requestedRequirementId}. Use the Plan relationship authority or replan explicitly.`,
      data: { executionStarted: false, workContractCreated: false, planId: plan.planId, planRequirementId: plan.requirementId, requestedRequirementId },
    });
  }
  const effectiveRequirementId = requestedRequirementId || plan?.requirementId;
  if (
    effectiveRequirementId
    && ctx.workStore.controllerHome
    && !readRequirement({ controllerHome: ctx.workStore.controllerHome }, effectiveRequirementId)
  ) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `${plan ? 'PLAN' : 'WORK'}_REQUIREMENT_NOT_FOUND: ${effectiveRequirementId}. Create or reconcile the Requirement authority before admitting Work.`,
      data: { executionStarted: false, workContractCreated: false, requirementId: effectiveRequirementId, planId: plan?.planId },
    });
  }
  const sameStringSet = (provided: string[] | undefined, frozen: string[]): boolean => {
    if (provided === undefined) return true;
    const actual = [...new Set(provided)].sort();
    const expected = [...new Set(frozen)].sort();
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  };
  if (planStep) {
    const mismatches = [
      !sameStringSet(input.acceptanceCriteria, planStep.acceptanceCriteria) && 'acceptance_criteria',
      !sameStringSet(input.allowedPaths, planStep.allowedPaths) && 'allowed_paths',
      !sameStringSet(input.forbiddenPaths, planStep.forbiddenPaths) && 'forbidden_paths',
      !sameStringSet(input.checks, planStep.checks) && 'check_ids',
    ].filter((value): value is string => Boolean(value));
    if (mismatches.length > 0) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_WORK_CONTRACT_MISMATCH: ${input.planId}/${input.planStepId} conflicts with frozen Plan step field(s): ${mismatches.join(', ')}. Replan instead of widening or narrowing Work admission.`,
        data: { executionStarted: false, workContractCreated: false, planId: input.planId, planStepId: input.planStepId, mismatches },
      });
    }
  }
  const effectiveAcceptanceCriteria = planStep?.acceptanceCriteria ?? input.acceptanceCriteria ?? [];
  const effectiveAllowedPaths = planStep?.allowedPaths ?? input.allowedPaths ?? [];
  const effectiveForbiddenPaths = planStep?.forbiddenPaths ?? input.forbiddenPaths ?? [];
  const effectiveChecks = planStep?.checks ?? input.checks ?? [];
  const normalized = normalizeCheckIds(effectiveChecks, available);
  const boundPlanStepWorks = input.planId && input.planStepId
    ? activeWorks.filter((candidate) => candidate.planId === input.planId && candidate.planStepId === input.planStepId)
    : [];
  const explicitPlanStepWork = planStep?.workId ? activeWorks.find((candidate) => candidate.workId === planStep.workId) : undefined;
  const planStepWork = explicitPlanStepWork ?? (boundPlanStepWorks.length === 1 ? boundPlanStepWorks[0] : undefined);
  const requirementWorks = effectiveRequirementId
    ? activeWorks.filter((candidate) => candidate.requirementId === effectiveRequirementId)
    : [];
  const deterministicTarget = input.relatedWorkId
    ? explicitRelatedWork
    : planStepWork ?? (requirementWorks.length === 1 ? requirementWorks[0] : undefined);
  const requestedRelation = input.workRelation ?? (input.modeInput.requiresParallelism === true ? 'parallel' : undefined);
  // Only strong semantic bindings participate in ownership resolution. An
  // unrelated active Work or a checkout writer is a placement fact, not a
  // semantic candidate for continue/extend/parallel/new_goal.
  const candidateWorks = [...new Map(
    [explicitRelatedWork, planStepWork, ...boundPlanStepWorks, ...requirementWorks]
      .filter((candidate): candidate is WorkContract => Boolean(candidate))
      .map((candidate) => [candidate.workId, candidate]),
  ).values()].slice(0, 8);

  const resolutionRequired = (reason: string, target = deterministicTarget): FacadeResult => buildFacadeResult({
    status: 'ok',
    summary: reason,
    data: {
      executionStarted: false,
      workContractCreated: false,
      admissionDecision: 'resolution_required',
      resolutionRequired: true,
      requestedBy: input.requestedBy ?? 'chatgpt',
      ...(target ? { recommendedWork: summarizeWorkContract(target) } : {}),
      candidates: candidateWorks.map(summarizeWorkContract),
      allowedRelations: ['continue', 'extend', 'parallel', 'new_goal'],
    },
    evidenceRefs: target?.evidenceRefs ?? [],
    suggestedNextActions: target
      ? [{
          label: 'Continue existing Work',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: target.workId },
          risk: 'readonly',
          confidence: planStepWork || explicitRelatedWork ? 'high' : 'medium',
          reason: 'Resolve intent before execution; do not create a second Work until the relationship is explicit.',
        }]
      : [],
    rawAvailable: false,
  });

  if (boundPlanStepWorks.length > 1) {
    return resolutionRequired(`PLAN_STEP_MULTIPLE_PRIMARY_WORKS: ${input.planId}/${input.planStepId} has ${boundPlanStepWorks.length} active primary Work records and requires repair before execution.`);
  }
  if (planStep?.workId && !explicitPlanStepWork) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `PLAN_STEP_BOUND_WORK_MISSING: ${input.planId}/${input.planStepId} is bound to ${planStep.workId}, but that Work is not active. Repair the exact binding; do not create a replacement Work.`,
      data: { executionStarted: false, workContractCreated: false, planId: input.planId, planStepId: input.planStepId, boundWorkId: planStep.workId, repairRequired: true },
      suggestedNextActions: [{
        label: 'Diagnose exact Plan step binding',
        tool: 'rh_work',
        operation: 'repair',
        payload: { plan_id: input.planId, plan_step_id: input.planStepId, repair_operation: 'diagnose', dry_run: true },
        risk: 'readonly',
        confidence: 'high',
        reason: 'The Plan step has an exact Work identity but the active Work view cannot resolve it. Diagnose that binding before any replacement Work can be admitted.',
      }],
      rawAvailable: false,
    });
  }

  if ((input.requestedBy ?? 'chatgpt') === 'scheduler') {
    return resolutionRequired(
      deterministicTarget
        ? `SCHEDULER_CONTINUATION_REQUIRED: scheduler-triggered execution must continue its bound Work ${deterministicTarget.workId}; it must not create a new durable Work.`
        : 'SCHEDULER_WORK_BINDING_REQUIRED: scheduler-triggered execution must bind and wake an existing durable Work; it must not invent a new Work from a prompt.',
    );
  }

  if (planStepWork && !requestedRelation) {
    return buildFacadeResult({
      status: 'ok',
      summary: `PLAN_STEP_REUSES_ACTIVE_WORK: ${input.planId}/${input.planStepId} already executes as ${planStepWork.workId}; reuse that Work instead of creating another.`,
      data: {
        executionStarted: false,
        workContractCreated: false,
        admissionDecision: 'reuse_existing',
        resolutionRequired: false,
        work: summarizeWorkContract(planStepWork),
      },
      evidenceRefs: planStepWork.evidenceRefs,
      suggestedNextActions: [{ label: 'Continue existing Work', tool: 'rh_work', operation: 'continue', payload: { work_id: planStepWork.workId }, risk: 'readonly', confidence: 'high' }],
      rawAvailable: false,
    });
  }

  if (requestedRelation === 'continue' || requestedRelation === 'extend') {
    if (!deterministicTarget) {
      return resolutionRequired(`${requestedRelation.toUpperCase()}_TARGET_REQUIRED: select related_work_id or bind the request to an active Plan/Requirement before execution.`);
    }
    if (requestedRelation === 'extend' && deterministicTarget.planId) {
      return resolutionRequired(
        `PLAN_EXTENSION_REQUIRES_REPLAN: Work ${deterministicTarget.workId} is governed by Plan ${deterministicTarget.planId}; record additional discovery in scopeEvidence, but update the authoritative Plan before widening policy or acceptance scope.`,
        deterministicTarget,
      );
    }
    const selected = requestedRelation === 'extend'
      ? updateWorkContract(ctx.workStore, deterministicTarget.workId, {
          acceptanceCriteria: [...new Set([...deterministicTarget.acceptanceCriteria, ...(input.acceptanceCriteria ?? [])])].slice(0, 30),
          allowedPaths: [...new Set([...deterministicTarget.allowedPaths, ...(input.allowedPaths ?? [])])].slice(0, 50),
          forbiddenPaths: [...new Set([...deterministicTarget.forbiddenPaths, ...(input.forbiddenPaths ?? [])])].slice(0, 50),
          checks: [...new Set([...deterministicTarget.checks, ...normalized.validCheckIds])].slice(0, 30),
          scopeEvidence: {
            initialLikelyPaths: [...new Set([
              ...(deterministicTarget.scopeEvidence?.initialLikelyPaths ?? deterministicTarget.allowedPaths),
              ...(input.initialLikelyPaths ?? input.allowedPaths ?? []),
            ])].slice(0, 100),
            inspectedPaths: deterministicTarget.scopeEvidence?.inspectedPaths ?? [],
            actualChangedPaths: deterministicTarget.scopeEvidence?.actualChangedPaths ?? [],
            recordedAt: at,
          },
          scopeSummary: `Extended serially: ${input.objective}`.slice(0, 500),
          continuationPrompt: `Continue work ${ctx.repoId}: ${deterministicTarget.objective.slice(0, 160)}. Additional requested scope: ${input.objective.slice(0, 500)}`,
        })
      : deterministicTarget;
    return buildFacadeResult({
      status: 'ok',
      summary: `${requestedRelation === 'extend' ? 'Existing Work extended' : 'Existing Work selected'}: ${selected.workId}. No new WorkContract was created.`,
      data: {
        executionStarted: false,
        workContractCreated: false,
        admissionDecision: requestedRelation === 'extend' ? 'extend_existing' : 'reuse_existing',
        resolutionRequired: false,
        work: summarizeWorkContract(selected),
      },
      evidenceRefs: selected.evidenceRefs,
      suggestedNextActions: [{ label: 'Continue existing Work', tool: 'rh_work', operation: 'continue', payload: { work_id: selected.workId }, risk: 'readonly', confidence: 'high' }],
      rawAvailable: false,
    });
  }

  if (!requestedRelation && candidateWorks.length > 0) {
    return resolutionRequired(
      `WORK_ADMISSION_RESOLUTION_REQUIRED: ${candidateWorks.length} active Work candidate(s) exist. Classify this request as continue, extend, parallel, or new_goal before any durable Work is created.`,
    );
  }

  const placementConflict = Boolean(workspaceOwner);
  const needsWorktree = executionMode === 'goal_workloop' && (input.constraints?.requireWorktree
    ?? (workspaceMode === 'isolated'
      || placementConflict
      || input.modeInput.requiresParallelism === true
      || (workspaceMode === 'auto' && routeDecision.requiresIsolation === true)));
  if (!needsWorktree && workspaceOwner) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORKSPACE_OWNERSHIP_INVARIANT: unresolved admission reached checkout ${ctx.checkoutId} while active Work ${workspaceOwner.workId} owns it. This is an internal routing invariant, not a normal fallback path.`,
      data: {
        executionStarted: false,
        workContractCreated: false,
        conflictType: 'workspace_single_writer_invariant',
        existingWork: summarizeWorkContract(workspaceOwner),
      },
      evidenceRefs: workspaceOwner.evidenceRefs,
      rawAvailable: false,
    });
  }
  const generatedWorkId = workIdFor(input.objective);
  if (input.planId || input.planStepId) {
    if (!input.planId || !input.planStepId || !ctx.planStore || !ctx.sourceRevision || !plan || !planStep) {
      return buildFacadeResult({ status: 'blocked', summary: 'PLAN_CONTEXT_REQUIRED: plan_id, plan_step_id, an executable Plan step and a current source revision are required.', data: { executionStarted: false } });
    }
    if (plan.status !== 'approved' && plan.status !== 'executing') {
      return buildFacadeResult({ status: 'blocked', summary: `PLAN_NOT_EXECUTABLE: ${plan.planId} is ${plan.status}`, data: { executionStarted: false, planId: plan.planId } });
    }
    if (plan.sourceRevision !== ctx.sourceRevision) {
      const invalidated = claimPlanStepForWork(ctx.planStore, {
        planId: input.planId,
        stepId: input.planStepId,
        workId: generatedWorkId,
        sourceRevision: ctx.sourceRevision,
      });
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_SOURCE_DRIFT: ${invalidated.planId} was invalidated because its source revision no longer matches. Replan before execution.`,
        data: { planId: invalidated.planId, executionStarted: false, workContractCreated: false, replanRequired: true },
      });
    }
    const unresolved = planStep.dependencies.filter((dependency) => plan.steps.find((candidate) => candidate.id === dependency)?.status !== 'completed');
    if (unresolved.length > 0) {
      return buildFacadeResult({ status: 'blocked', summary: `PLAN_STEP_DEPENDENCIES_PENDING: ${unresolved.join(', ')}`, data: { executionStarted: false, workContractCreated: false, planId: plan.planId, planStepId: planStep.id } });
    }
    if (planStep.status === 'completed') {
      return buildFacadeResult({ status: 'blocked', summary: `PLAN_STEP_ALREADY_COMPLETED: ${planStep.id}`, data: { executionStarted: false, workContractCreated: false, planId: plan.planId, planStepId: planStep.id } });
    }
  }
  const initialSuggestedNextActions = suggestedForWorkIdentity(
    generatedWorkId,
    normalized.validCheckIds,
    normalized.suggestedNextActions,
  );
  const repositoryChangeIntent = input.workKind === 'repository_change'
    || effectiveAllowedPaths.length > 0
    || (input.initialLikelyPaths?.length ?? 0) > 0
    || (input.modeInput.expectedFiles ?? 0) > 0
    || (input.modeInput.expectedChangedLines ?? 0) > 0;
  const resolvedWorkKind = input.workKind ?? (
    input.modeInput.requiresExternalEffect === true
    && input.modeInput.remoteWrite === true
    && !repositoryChangeIntent
      ? 'remote_effect'
      : 'repository_change'
  );
  const remoteDeliveryRequired = resolvedWorkKind === 'repository_change'
    && input.modeInput.requiresExternalEffect === true
    && input.modeInput.remoteWrite === true;
  const work = createWorkContract(ctx.workStore, {
    workId: generatedWorkId,
    repoId: ctx.repoId,
    checkoutId: needsWorktree ? undefined : ctx.checkoutId,
    principalId: ctx.principalId,
    controllerInstanceId: ctx.controllerInstanceId,
    baseRevision: ctx.sourceRevision,
    workspaceFingerprint: needsWorktree ? undefined : ctx.workspaceFingerprint,
    routeDecisionFingerprint: routeDecision.inputFingerprint,
    routeDecision,
    mode: executionMode,
    objective: input.objective,
    acceptanceCriteria: effectiveAcceptanceCriteria,
    constraints: {
      ...(input.constraints ?? { requireHandoffOnAmbiguity: true }),
      ...(remoteDeliveryRequired ? { remoteDeliveryRequired: true } : {}),
    },
    risk: workRiskFor(input),
    // Remote delivery is a risk/effect dimension, not a reason to erase a
    // repository-change Work's semantic identity. Pure external actions with no
    // repository-change signal remain remote_effect and keep plugin receipt semantics.
    workKind: resolvedWorkKind,
    status: 'running',
    phase: 'implementation',
    issueId: input.issueId,
    taskId: input.taskId,
    requirementId: effectiveRequirementId,
    planId: input.planId,
    planStepId: input.planStepId,
    planSourceRevision: input.planId ? ctx.sourceRevision : undefined,
    scopeSummary: input.modeInput.scopeClear ? 'scope declared at start' : 'scope incomplete',
    scopeEvidence: {
      initialLikelyPaths: [...new Set(input.initialLikelyPaths ?? effectiveAllowedPaths)].slice(0, 100),
      inspectedPaths: [],
      actualChangedPaths: [],
      recordedAt: at,
    },
    allowedPaths: effectiveAllowedPaths,
    forbiddenPaths: effectiveForbiddenPaths,
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
    worktreeRef: undefined,
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
    suggestedNextActions: initialSuggestedNextActions,
    continuationPrompt: `Continue work ${ctx.repoId}: ${input.objective.slice(0, 200)}`,
  });

  if (input.planId && input.planStepId && ctx.planStore && ctx.sourceRevision) {
    try {
      const claimed = claimPlanStepForWork(ctx.planStore, {
        planId: input.planId,
        stepId: input.planStepId,
        workId: work.workId,
        sourceRevision: ctx.sourceRevision,
      });
      if (claimed.status === 'invalidated_by_drift') {
        return buildFacadeResult({
          status: 'blocked',
          summary: `PLAN_SOURCE_DRIFT: ${claimed.planId} was invalidated because its source revision no longer matches. Repair or replan before execution.`,
          data: { executionStarted: false, workContractCreated: true, work: summarizeWorkContract(work), planId: claimed.planId, canonicalWorkRetained: true, replanRequired: true },
        });
      }
    } catch (error) {
      return buildFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : 'PLAN_STEP_CLAIM_FAILED',
        data: { planId: input.planId, planStepId: input.planStepId, executionStarted: false, workContractCreated: true, work: summarizeWorkContract(work), canonicalWorkRetained: true },
      });
    }
  }

  return buildFacadeResult({
    status: 'ok',
    summary: executionMode === 'direct_control'
      ? `Direct-control Work lineage started as ${work.workId}.`
      : `Goal workloop started as ${work.workId}.`,
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
      work: summarizeWorkContract(work),
      worktreeRequired: work.worktreePolicy.required,
      normalizedChecks: normalized,
      policy,
    },
    evidenceRefs: work.evidenceRefs,
    warnings: normalized.warnings,
    suggestedNextActions: initialSuggestedNextActions,
    rawAvailable: false,
  });
}

export function continueGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopContinueInput): FacadeResult {
  let work = getWorkContract(ctx.workStore, input.workId);
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

  const explicitPolicyScope = input.allowedPaths !== undefined
    || input.forbiddenPaths !== undefined
    || input.checks !== undefined;
  if (explicitPolicyScope) {
    if (work.planId) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_EXTENSION_REQUIRES_REPLAN: Work ${work.workId} is governed by Plan ${work.planId}; continue cannot widen frozen policy scope. Replan the authoritative Plan instead.`,
        data: { work: summarizeWorkContract(work), planId: work.planId, policyScopeUpdated: false },
      });
    }
    const normalizedChecks = normalizeCheckIds(input.checks ?? [], ctx.availableChecks ?? []);
    if (normalizedChecks.invalidCheckIds.length > 0) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `WORK_CHECKS_INVALID: ${normalizedChecks.invalidCheckIds.join(', ')}. Work scope was not updated.`,
        data: { work: summarizeWorkContract(work), policyScopeUpdated: false, normalizedChecks },
      });
    }
    work = updateWorkContract(ctx.workStore, work.workId, {
      allowedPaths: [...new Set([...work.allowedPaths, ...(input.allowedPaths ?? [])])].slice(0, 50),
      forbiddenPaths: [...new Set([...work.forbiddenPaths, ...(input.forbiddenPaths ?? [])])].slice(0, 50),
      checks: [...new Set([...work.checks, ...normalizedChecks.validCheckIds])].slice(0, 30),
      scopeEvidence: {
        initialLikelyPaths: [...new Set([
          ...(work.scopeEvidence?.initialLikelyPaths ?? work.allowedPaths),
          ...(input.allowedPaths ?? []),
        ])].slice(0, 100),
        inspectedPaths: work.scopeEvidence?.inspectedPaths ?? [],
        actualChangedPaths: work.scopeEvidence?.actualChangedPaths ?? [],
        recordedAt: nowIso(ctx),
      },
      scopeSummary: `Continue adopted explicit policy scope for ${work.workId}.`.slice(0, 500),
    });
  }

  if ((input.additionalLikelyPaths?.length ?? 0) > 0 || (input.inspectedPaths?.length ?? 0) > 0) {
    work = recordWorkScopeEvidence(ctx.workStore, work.workId, {
      initialLikelyPaths: input.additionalLikelyPaths,
      inspectedPaths: input.inspectedPaths,
    });
  }

  const currentCheckRefs = work.checkRefs.filter((record) =>
    verificationRecordAppliesToCurrentWorkspace(record, ctx.sourceRevision, ctx.workspaceFingerprint));
  const history = reconcileVerificationHistory(
    currentCheckRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  );

  const explicitAcceptanceRepair = history.acceptanceFailures.length > 0
    && (input.acceptanceFailureDecision === 'repair' || input.acceptanceFailureDecision === 'rescope');
  if (explicitAcceptanceRepair) {
    const decision = input.acceptanceFailureDecision!;
    work = appendWorkEvidence(ctx.workStore, work.workId, {
      title: 'Controller acceptance-failure continuation decision',
      summary: `Controller explicitly chose bounded ${decision} after deterministic acceptance failure: ${history.acceptanceFailures.join(', ')}.`,
      detailLevel: 'summary',
    });
    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'running',
      phase: 'implementation',
      state: 'active',
      summary: `Controller chose bounded ${decision} after acceptance failure; implementation may resume before re-verification.`,
      evidenceRefs: work.evidenceRefs,
    });
    work = getWorkContract(ctx.workStore, work.workId) ?? work;
    return buildFacadeResult({
      status: 'ok',
      summary: `Continue accepted explicit bounded ${decision} decision after acceptance failure; implementation may resume.`,
      data: {
        work: summarizeWorkContract(work),
        acceptanceFailures: history.acceptanceFailures,
        infrastructureIssues: history.infrastructureIssues,
        backgroundCompleted: false,
        nextStep: 'execute',
        acceptanceFailureDecision: decision,
      },
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      suggestedNextActions: suggestedForWork(work),
    });
  }

  // Ambiguous acceptance failure without an explicit bounded Controller decision →
  // ask once per distinct failure evidence. Repeated continue calls must not
  // manufacture an unbounded handoff loop. A resolved handoff remains the decision
  // authority until newer valid-fail evidence; an unresolved matching handoff is reused.
  if (history.acceptanceFailures.length > 0 && !explicitAcceptanceRepair && work.recoveryPolicy.handoffOnAmbiguity) {
    const failureReason = `Acceptance checks failed: ${history.acceptanceFailures.join(', ')}`;
    const latestFailureAt = work.checkRefs
      .filter((record) => record.outcome === 'valid_fail' && history.acceptanceFailures.includes(record.checkId))
      .map((record) => record.recordedAt)
      .sort((left, right) => right.localeCompare(left))[0];
    const matchingHandoffs = listHandoffItems({ ...ctx.handoffStore, status: 'all', limit: 100 })
      .filter((item) => (
        item.workId === input.workId
        && item.creationReason === 'ambiguous_outcome'
        && item.title === 'Acceptance failure needs review'
        && item.reason === failureReason
        && (!latestFailureAt || item.createdAt >= latestFailureAt)
      ));
    const activeHandoff = matchingHandoffs.find((item) => item.status === 'pending' || item.status === 'acknowledged');
    if (activeHandoff) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `Continue remains paused for ChatGPT review through existing handoff ${activeHandoff.id}.`,
        data: {
          work: summarizeWorkContract(work),
          handoffId: activeHandoff.id,
          acceptanceFailures: history.acceptanceFailures,
          infrastructureIssues: history.infrastructureIssues,
          backgroundCompleted: false,
        },
        evidenceRefs: work.evidenceRefs.slice(0, 5),
        suggestedNextActions: [{
          label: 'Get handoff',
          tool: 'rh_inbox',
          operation: 'get',
          payload: { handoff_id: activeHandoff.id },
          risk: 'readonly',
          confidence: 'high',
        }],
      });
    }

    const resolvedHandoff = matchingHandoffs.find((item) => item.status === 'resolved');
    if (!resolvedHandoff) {
      const continuation = buildWorkContinuationSnapshot(work);
      const handoff = createHandoffItem(ctx.handoffStore, {
        id: handoffIdFor('continue'),
        repoId: ctx.repoId,
        workId: work.workId,
        title: 'Acceptance failure needs review',
        severity: 'needs_review',
        creationReason: 'ambiguous_outcome',
        reason: failureReason,
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

    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'running',
      phase: 'verification',
      state: 'active',
      summary: `Resolved acceptance-failure handoff ${resolvedHandoff.id} authorizes bounded continuation to re-verification.`,
      evidenceRefs: work.evidenceRefs,
    });
    work = getWorkContract(ctx.workStore, work.workId) ?? work;
    return buildFacadeResult({
      status: 'ok',
      summary: `Continue accepted resolved acceptance-failure handoff ${resolvedHandoff.id}; re-verification may resume.`,
      data: {
        work: summarizeWorkContract(work),
        handoffId: resolvedHandoff.id,
        acceptanceFailures: history.acceptanceFailures,
        infrastructureIssues: history.infrastructureIssues,
        backgroundCompleted: false,
        nextStep: 'verify',
        remainingChecks: history.acceptanceFailures,
      },
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      suggestedNextActions: suggestedForWork(work),
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

  const implementationEvidence = evaluateWorkImplementationEvidence(work, ctx.workspaceChangedPaths);
  if (implementationEvidence.status !== 'complete') {
    const suggested = validateSuggestedNextActions([
      {
        label: 'Implement the repository change before verification',
        tool: 'rh_context',
        operation: 'get',
        payload: { work_id: work.workId },
        risk: 'readonly',
        confidence: 'high',
        reason: 'Verification proves behavior only after the repository-change Work has current source changes.',
      },
    ]).actions;
    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'running',
      phase: 'implementation',
      state: 'active',
      summary: implementationEvidence.reasons.join(' '),
      evidenceRefs: work.evidenceRefs,
    });
    const updated = updateWorkContract(ctx.workStore, work.workId, { suggestedNextActions: suggested });
    return buildFacadeResult({
      status: 'blocked',
      summary: `Continue requires implementation before verification. ${implementationEvidence.reasons.join(' ')}`,
      data: {
        work: summarizeWorkContract(updated),
        backgroundCompleted: false,
        nextStep: 'execute',
        implementationEvidencePresent: false,
        workspaceChangedPaths: implementationEvidence.changedPaths,
      },
      suggestedNextActions: suggested,
    });
  }

  if (implementationEvidence.changedPaths.length > 0) {
    recordWorkScopeEvidence(ctx.workStore, work.workId, {
      actualChangedPaths: implementationEvidence.changedPaths,
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

  const completionEvidence = evaluateWorkCompletionEvidence(work, ctx.sourceRevision, ctx.workspaceFingerprint);
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
  if (work.status === 'completed' || work.status === 'cancelled' || work.status === 'failed') {
    const resolvedCheckId = classified.normalizedCheckId ?? classified.checkId;
    const existing = [...work.checkRefs].reverse().find((record) => record.checkId === resolvedCheckId);
    const completed = work.status === 'completed';
    return buildFacadeResult({
      status: completed ? 'ok' : 'blocked',
      summary: `WorkContract ${work.workId} is terminal (${work.status}); verification was not re-executed.`,
      data: {
        work: summarizeWorkContract(work),
        verification: {
          checkId: resolvedCheckId,
          ...(existing ? { outcome: existing.outcome } : {}),
          terminal: true,
          idempotent: true,
          reexecuted: false,
          isAcceptanceFailure: existing?.outcome === 'valid_fail',
          isInfrastructureIssue: existing?.outcome === 'invalid_check_id' || existing?.outcome === 'infrastructure_failure',
          doesNotRequestTaskChanges: existing?.outcome !== 'valid_fail',
        },
        backgroundCompleted: false,
      },
      evidenceRefs: existing?.evidenceRef ? [existing.evidenceRef] : [],
      warnings: classified.warnings,
      suggestedNextActions: [{ label: 'Inspect work via context', tool: 'rh_context', operation: 'get', payload: { work_id: work.workId }, risk: 'readonly', confidence: 'high' }],
    });
  }

  const at = nowIso(ctx);
  const resolvedCheckId = classified.normalizedCheckId ?? classified.checkId;
  const receipt = input.receipt
    && input.receipt.repoId === work.repoId
    && input.receipt.workId === work.workId
    && input.receipt.checkId === resolvedCheckId
    ? input.receipt
    : undefined;
  const sourceRevision = receipt && input.sourceRevision?.trim() ? input.sourceRevision.trim() : undefined;
  const verificationSummary = receipt
    ? `${classified.summary} Durable Process receipt ${receipt.receiptId}.`
    : classified.summary;
  const record: VerificationRecord = {
    checkId: resolvedCheckId,
    outcome: classified.outcome,
    summary: verificationSummary,
    recordedAt: at,
    sourceRevision,
    workspaceFingerprint: receipt && sourceRevision ? input.workspaceFingerprint : undefined,
    verificationInputFingerprint: receipt && sourceRevision ? input.verificationInputFingerprint : undefined,
    commandFingerprint: receipt && sourceRevision ? input.commandFingerprint : undefined,
    startedAt: receipt?.startedAt,
    completedAt: receipt?.finishedAt,
    receipt,
    evidenceRef: {
      title: `verification:${classified.outcome}`,
      summary: verificationSummary,
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

  const completionEvidence = classified.outcome === 'valid_pass'
    ? evaluateWorkCompletionEvidence(updated, sourceRevision, input.workspaceFingerprint)
    : undefined;
  const validPassReadyToFinalize = completionEvidence?.status === 'complete';
  const suggested = validateSuggestedNextActions(
    classified.outcome === 'valid_pass'
      ? [{
          label: validPassReadyToFinalize ? 'Finalize work' : 'Continue workloop',
          tool: 'rh_work',
          operation: validPassReadyToFinalize ? 'finalize' : 'continue',
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
      ...(classified.outcome === 'valid_pass'
        ? { nextStep: validPassReadyToFinalize ? 'finalize' : 'continue' }
        : {}),
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

  const completionEvidence = evaluateWorkCompletionEvidence(work, ctx.sourceRevision, ctx.workspaceFingerprint);
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

  const owner = ctx.workStore.controllerHome
    ? getControllerSession({ controllerHome: ctx.workStore.controllerHome, repoId: ctx.repoId }, work.workId)
    : undefined;
  if (owner) {
    const ownerPrincipal = owner.principalId?.trim() || owner.controllerId;
    const ownerInstanceId = owner.controllerInstanceId?.trim();
    const callerPrincipal = ctx.principalId?.trim();
    const callerInstanceId = ctx.controllerInstanceId?.trim();
    const sameAuthority = Boolean(
      callerPrincipal
      && ownerPrincipal === callerPrincipal
      && (!ownerInstanceId || ownerInstanceId === callerInstanceId),
    );
    if (!sameAuthority) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `WORK_TERMINALIZATION_ACTIVE_CONTROLLER_FENCE: ${work.workId} has a newer active Controller claim generation ${owner.claimGeneration ?? 1}.`,
        data: {
          work: summarizeWorkContract(work),
          activeController: {
            controllerId: owner.controllerId,
            principalId: ownerPrincipal,
            controllerInstanceId: owner.controllerInstanceId,
            sessionId: owner.sessionId,
            claimGeneration: owner.claimGeneration ?? 1,
          },
          finalStatus: work.status,
        },
      });
    }
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
  const planId = updated.planId;
  const planStepId = updated.planStepId;
  let plan = planId && ctx.planStore
    ? getPlanContract(ctx.planStore, planId)
    : undefined;
  if (plan && planId && planStepId && ctx.planStore) {
    const step = plan.steps.find((entry) => entry.id === planStepId);
    if (step?.workId === updated.workId) {
      plan = completePlanStepForWork(ctx.planStore, { planId, stepId: planStepId, work: updated });
    }
  }

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
      ...(plan ? { plan } : {}),
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
        initialLikelyPaths: Array.isArray(args.initial_likely_paths) ? args.initial_likely_paths.map(String) : undefined,
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
          explicitMode: args.mode === 'scale' ? 'scale' : undefined,
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
        relatedWorkId: typeof args.related_work_id === 'string' ? args.related_work_id : undefined,
        workRelation: args.work_relation === 'continue' || args.work_relation === 'extend' || args.work_relation === 'parallel' || args.work_relation === 'new_goal'
          ? args.work_relation
          : undefined,
        requirementId: typeof args.requirement_id === 'string' ? args.requirement_id : undefined,
        planId: typeof args.plan_id === 'string' ? args.plan_id : undefined,
        planStepId: typeof args.plan_step_id === 'string' ? args.plan_step_id : undefined,
        workKind: args.work_kind === 'repository_change'
          || args.work_kind === 'completed_no_change'
          || args.work_kind === 'investigation'
          || args.work_kind === 'reconciliation'
          ? args.work_kind
          : undefined,
      });
    case 'continue':
      return continueGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        note: typeof args.note === 'string' ? args.note : undefined,
        allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
        forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
        checks: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
        additionalLikelyPaths: Array.isArray(args.additional_likely_paths) ? args.additional_likely_paths.map(String) : undefined,
        inspectedPaths: Array.isArray(args.inspected_paths) ? args.inspected_paths.map(String) : undefined,
        acceptanceFailureDecision: args.acceptance_failure_decision === 'repair' || args.acceptance_failure_decision === 'rescope'
          ? args.acceptance_failure_decision
          : undefined,
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
