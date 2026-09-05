import { createHash, randomUUID } from 'crypto';
import {
  createHandoffItem,
  listHandoffItems,
  type HandoffInboxStoreOptions,
} from './handoff-inbox-store';
import { getControllerSession } from '../../../../packages/kernel/controller/api/index';
import { projectAutonomousGoalProgression, type ProgressionWorkSnapshot } from '../../../../packages/kernel/progression/api/index';
import {
  applyEngineeringBlockerDisposition,
  buildEngineeringBlockerDispositionReceipt,
  buildEngineeringContextReceipt,
  engineeringWorkProfileForRisk,
  evaluateEngineeringAdmission,
  appendVerificationRecord,
  appendWorkEvidence,
  appendWorkHandoffRef,
  createWorkContract,
  getWorkContract,
  isTerminalWorkContractStatus,
  listWorkContracts,
  readActiveWorkCandidates,
  recordWorkScopeEvidence,
  recordWorkImplementationReview,
  requestWorkImplementationReview,
  summarizeWorkContract,
  transitionWorkContractPhase,
  updateWorkContract,
  type EngineeringAdmissionEvidence,
  type WorkContractStoreOptions,
} from '../../../../packages/kernel/work/api/index';
import {
  claimPlanStepForWork,
  completePlanStepForWork,
  getPlanContract,
  type PlanContractStoreOptions,
} from './plan-contract-store';
import { withPrimaryWorkAdmissionLock } from './semantic-admission';
import { completeWorkWithReceipt } from '../execution/work-completion-authority';
import { evaluateReadOnlyReviewSourceIdentity, evaluateWorkCompletionEvidence, evaluateWorkImplementationEvidence, verificationRecordAppliesToCurrentWorkspace } from '../execution/work-evidence-policy';
import { readRequirement } from '../persistence/requirement-store';
import {
  classifyVerificationOutcome,
  normalizeCheckIds,
  reconcileVerificationHistory,
  type CheckDefinitionLike,
} from './check-normalization';
import { evaluatePolicyGate } from './policy-gate';
import {
  assertImplementationReviewPreDeliveryBoundary,
  authoritativeImplementationReviewVerificationEvidence,
  implementationReviewChangedPathDigest,
  latestImplementationReview,
  normalizeImplementationReviewChangedPaths,
  workRequiresImplementationReview,
  type ImplementationReviewDecision,
  type ImplementationReviewCandidateIdentity,
  type WorkImplementationReviewFinding,
  type WorkImplementationReviewRecord,
} from '../../../../packages/kernel/work/api/index';
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
import { resolveWorkspaceAdmissionConstraint } from '../routing/workspace-admission';
import { resolveContextPlane, type ContextScope } from '../../context/context-plane';

export type GoalWorkloopOperation = 'start' | 'continue' | 'verify' | 'review' | 'finalize' | 'stop';

export interface GoalWorkloopContext {
  workStore: WorkContractStoreOptions;
  handoffStore: HandoffInboxStoreOptions;
  repoId: string;
  availableChecks?: readonly CheckDefinitionLike[];
  planStore?: PlanContractStoreOptions;
  sourceRevision?: string;
  /** Explicit only when repository observation proves the Work started from a revision or an unborn HEAD. */
  sourceBaseState?: 'revision' | 'unborn';
  checkoutId?: string;
  principalId?: string;
  controllerInstanceId?: string;
  workspaceFingerprint?: string;
  /** Trusted repository observation for placement admission. Never accept this as caller-supplied semantic authority. */
  workspaceDirty?: boolean;
  /** Stage-insensitive Git-canonical identity of the exact current review candidate. Derived by the trusted repository adapter. */
  implementationReviewWorkspaceFingerprint?: string;
  /** Current net repository paths changed from the Work base plus dirty checkout paths. */
  workspaceChangedPaths?: readonly string[];
  /** Durable terminal repository Process ids explicitly bound to this Work + checkout. */
  workBoundProcessEvidenceIds?: readonly string[];
  now?: () => string;
  /** True only while a Gateway caller holds the cross-process primary Work admission lock. */
  semanticAdmissionLocked?: boolean;
  materializeIsolatedWorkspace?: (input: { workId: string; title: string; baseRef?: string; needsDependencies?: boolean }) => { checkoutId: string; root: string; baseRevision?: string | null; managed: true };
}

export type WorkAdmissionRelation = 'continue' | 'extend' | 'parallel' | 'new_goal';

export interface GoalWorkloopStartInput {
  objective: string;
  /** Optional exact durable identity reserved by the admission authority before creation. */
  workId?: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  /** Non-authoritative first-pass discovery candidates. */
  initialLikelyPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  constraints?: WorkContract['constraints'];
  modeInput: ExecutionModeSelectionInput;
  requestedBy?: WorkContract['requestedBy'];
  /** Stable durable admission identity for system-originated Work such as recurrent incident repair. */
  requestId?: string;
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
  workKind?: Extract<WorkKind, 'repository_change' | 'completed_no_change' | 'read_only_review' | 'investigation' | 'local_effect' | 'remote_effect' | 'reconciliation'>;
  /** Trusted source-bound evidence resolved by Forge evidence authorities before admission. Never populate this field from raw caller-supplied receipt ids. */
  verifiedEngineeringEvidence?: EngineeringAdmissionEvidence;
}

export interface GoalWorkloopAcceptanceEvidenceBinding {
  criterion: string;
  evidenceIds: string[];
  rationale: string;
}

export interface GoalWorkloopContinueInput {
  workId: string;
  note?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  additionalLikelyPaths?: string[];
  inspectedPaths?: string[];
  /** Concise semantic findings discovered by a first-class read-only review. */
  reviewFindings?: string[];
  /** Explicit Controller-reviewed bindings from exact declared criteria to durable Work evidence. */
  acceptanceEvidence?: GoalWorkloopAcceptanceEvidenceBinding[];
  /** Explicit Controller decision after deterministic acceptance failure; never inferred from note text. */
  acceptanceFailureDecision?: 'repair' | 'rescope';
  /** Trusted refreshed engineering evidence minted by Runtime composition, never copied from raw caller receipt ids. */
  verifiedEngineeringEvidence?: EngineeringAdmissionEvidence;
  /** Semantic Controller blocker classification; Forge derives the permitted action and persists the receipt. */
  engineeringBlocker?: {
    blockerId: string;
    classification: 'same_root_cause' | 'unrelated';
    rationale: string;
    semanticScopeKeys?: string[];
  };
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

export interface GoalWorkloopReviewInput {
  workId: string;
  decision: ImplementationReviewDecision;
  rationale: string;
  findings?: WorkImplementationReviewFinding[];
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

function currentImplementationReviewCandidate(
  ctx: GoalWorkloopContext,
  work: WorkContract,
): ImplementationReviewCandidateIdentity {
  const sourceRevision = ctx.sourceRevision?.trim() ?? '';
  const verificationWorkspaceFingerprint = ctx.workspaceFingerprint?.trim() ?? '';
  const workspaceFingerprint = ctx.implementationReviewWorkspaceFingerprint?.trim() ?? '';
  const changedPaths = normalizeImplementationReviewChangedPaths(
    ctx.workspaceChangedPaths ?? work.scopeEvidence?.actualChangedPaths ?? [],
  );
  if (!sourceRevision || !verificationWorkspaceFingerprint || !workspaceFingerprint) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_SOURCE_IDENTITY_REQUIRED');
  }
  const verification = authoritativeImplementationReviewVerificationEvidence({
    repoId: work.repoId,
    workId: work.workId,
    requiredCheckIds: work.checks,
    records: work.checkRefs,
    sourceRevision,
    workspaceFingerprint: verificationWorkspaceFingerprint,
  });
  if (verification.missingCheckIds.length > 0) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_VERIFICATION_REQUIRED: ${verification.missingCheckIds.join(', ')}`);
  }
  return {
    sourceRevision,
    workspaceFingerprint,
    verificationWorkspaceFingerprint,
    changedPaths,
    verificationEvidence: verification.evidence,
    architectureEvidence: [],
  };
}

function implementationReviewAcceptanceSummary(work: WorkContract): string {
  const summary = work.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean).join(' | ');
  return (summary || 'No explicit acceptance criteria; reviewer assessed the Work objective and exact current implementation evidence.').slice(0, 2_000);
}

function implementationReviewSuggestedAction(workId: string): SuggestedNextAction {
  return {
    label: 'Review implementation',
    tool: 'rh_work',
    operation: 'review',
    payload: { work_id: workId },
    risk: 'workspace_write',
    confidence: 'high',
    reason: 'Verification is complete; an explicit Controller implementation decision is required before delivery.',
  };
}

function workIdFor(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'work';
  return `work-${slug}-${randomUUID().slice(0, 8)}`;
}

function linkedEngineeringBlockerWorkId(parentWorkId: string, blockerId: string): string {
  const digest = createHash('sha256').update(`${parentWorkId}\0${blockerId.trim()}`).digest('hex').slice(0, 24);
  return `work-linked-engineering-blocker-${digest}`;
}

function handoffIdFor(prefix: string): string {
  return `hnd-${prefix}-${randomUUID().slice(0, 8)}`;
}

function workRiskFor(input: GoalWorkloopStartInput): WorkRisk {
  if (input.workKind === 'read_only_review') return 'readonly';
  const risk = input.modeInput.risk;
  if (input.modeInput.secretAccess === true || input.modeInput.destructive === true) return 'destructive';
  if (input.modeInput.remoteWrite === true) return 'high';
  if (risk === 'readonly') return 'readonly';
  if (risk === 'destructive' || risk === 'destructive_remote' || risk === 'raw_secret_config') return 'destructive';
  if (risk === 'remote_write') return 'high';
  if (risk === 'local_repo_write') return 'low';
  return 'medium';
}

function resolvedWorkKindFor(input: GoalWorkloopStartInput): WorkKind {
  if (input.workKind) return input.workKind;
  // allowed_paths and discovery hints do not prove repository mutation. External
  // effects become repository_change only when source-change intent is explicit.
  const repositoryChangeIntent = (input.modeInput.expectedFiles ?? 0) > 0
    || (input.modeInput.expectedChangedLines ?? 0) > 0;
  const typedRecoverableReadOnlyReview = input.modeInput.mutation === false
    && input.modeInput.requiresInvestigation === true
    && input.modeInput.requiresRecovery === true;
  if (typedRecoverableReadOnlyReview) return 'read_only_review';
  if (input.modeInput.requiresExternalEffect === true && !repositoryChangeIntent) {
    return input.modeInput.remoteWrite === true ? 'remote_effect' : 'local_effect';
  }
  return 'repository_change';
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

/**
 * Mode selection for facade routing. Direct control never creates a WorkContract.
 * Goal workloop creates one. Handoff-only creates a handoff and stops.
 */
export function routeWorkStart(
  ctx: GoalWorkloopContext,
  input: GoalWorkloopStartInput,
): FacadeResult {
  const placementResolution = resolveWorkspaceAdmissionConstraint(input.constraints);
  if (placementResolution.ok === false) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `${placementResolution.code}: ${placementResolution.message}`,
      data: { executionStarted: false, workContractCreated: false, placementConstraintConflict: true },
      rawAvailable: false,
    });
  }
  const placementConstraint = placementResolution.constraint;
  const canonicalConstraints: WorkContract['constraints'] = {
    ...(input.constraints ?? {}),
    workspaceMode: placementConstraint.workspaceMode,
    requireWorktree: placementConstraint.requireWorktree,
    directMainProhibited: placementConstraint.directMainProhibited,
  };
  const strategyConflictRequiresApproval = input.constraints?.architectureStrategyChange === true
    || input.constraints?.conflictsWithThinHarnessPolicy === true
    || input.constraints?.changesDefaultExecutionStrategy === true;
  let relatedLifecycleSource: WorkContract | undefined;
  if (input.relatedWorkId) {
    try {
      relatedLifecycleSource = getWorkContract(ctx.workStore, input.relatedWorkId);
    } catch (error) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `WORK_RELATED_CONTRACT_INVALID: ${input.relatedWorkId} is malformed and cannot authorize a Work relationship.`,
        data: {
          executionStarted: false,
          workContractCreated: false,
          invalidWorkId: input.relatedWorkId,
          invalidWorkError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  const inheritedReadOnlyReview = Boolean(
    input.workKind === undefined
    && input.workRelation === 'new_goal'
    && relatedLifecycleSource?.workKind === 'read_only_review'
    && (relatedLifecycleSource.status === 'cancelled' || relatedLifecycleSource.status === 'completed' || relatedLifecycleSource.status === 'failed'),
  );
  if (
    inheritedReadOnlyReview
    && relatedLifecycleSource?.baseRevision
    && ctx.sourceRevision
    && relatedLifecycleSource.baseRevision !== ctx.sourceRevision
  ) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `READ_ONLY_REVIEW_REPLACEMENT_SOURCE_DRIFT: replacement source ${ctx.sourceRevision} does not match frozen review base ${relatedLifecycleSource.baseRevision}.`,
      data: { executionStarted: false, workContractCreated: false, relatedWorkId: relatedLifecycleSource.workId, sourceDrift: true },
    });
  }
  const requestedWorkKind = input.workKind ?? (inheritedReadOnlyReview ? 'read_only_review' : undefined);
  const explicitSourceMutationFence = input.allowedPaths !== undefined
    && input.allowedPaths.length === 0
    && (input.forbiddenPaths ?? []).some((value) => {
      const normalized = value.trim().replace(/\\/g, '/');
      return normalized === '*' || normalized === '**' || normalized === '**/*';
    });
  const typedReadOnlyReviewRequested = requestedWorkKind === undefined
    && (
      explicitSourceMutationFence
      || (
        (input.modeInput.mutation === false || (input.modeInput.mutation === undefined && input.modeInput.risk === 'readonly'))
        && input.modeInput.requiresInvestigation === true
        && input.modeInput.requiresRecovery === true
      )
    );
  const effectiveWorkKind = requestedWorkKind ?? (typedReadOnlyReviewRequested ? 'read_only_review' : undefined);
  const readOnlyReviewRequested = effectiveWorkKind === 'read_only_review';
  const readOnlyMutationConflict = readOnlyReviewRequested && (
    input.modeInput.mutation === true
    || (input.modeInput.expectedFiles ?? 0) > 0
    || (input.modeInput.expectedChangedLines ?? 0) > 0
    || input.modeInput.requiresExternalEffect === true
    || input.modeInput.remoteWrite === true
    || input.modeInput.destructive === true
  );
  if (readOnlyMutationConflict) {
    return buildFacadeResult({
      status: 'blocked',
      summary: 'READ_ONLY_REVIEW_MUTATION_CONFLICT: read_only_review cannot request repository mutation, external effects, remote writes, or destructive execution.',
      data: { executionStarted: false, workContractCreated: false, workKind: effectiveWorkKind },
    });
  }
  const contextScopes: ContextScope[] = [];
  if (input.requirementId?.trim()) contextScopes.push({ schemaVersion: 1, kind: 'requirement', id: input.requirementId.trim() });
  if (input.planId?.trim()) contextScopes.push({ schemaVersion: 1, kind: 'plan', id: input.planId.trim() });
  if (input.relatedWorkId?.trim()) contextScopes.push({ schemaVersion: 1, kind: 'work', id: input.relatedWorkId.trim() });
  const resolvedContext = ctx.workStore.controllerHome
    ? resolveContextPlane({
        controllerHome: ctx.workStore.controllerHome,
        scopes: contextScopes,
        intent: input.modeInput.routePolicyInput?.intent.taskIntent ?? 'implementation',
        now: nowIso(ctx),
      })
    : undefined;
  const effectiveModeInput: ExecutionModeSelectionInput = {
    ...input.modeInput,
    contextRouteHints: input.modeInput.contextRouteHints ?? resolvedContext?.routeHints,
    objective: input.objective,
    knownPaths: input.allowedPaths,
    workspacePlacement: placementConstraint.workspaceMode,
    directMainProhibited: placementConstraint.directMainProhibited,
    workspaceDirty: ctx.workspaceDirty ?? input.modeInput.workspaceDirty,
    mutation: readOnlyReviewRequested ? false : input.modeInput.mutation ?? input.modeInput.risk !== 'readonly',
    risk: readOnlyReviewRequested ? 'readonly' : input.modeInput.risk,
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
    risk: effectiveModeInput.risk
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
  if (input.forceMode === 'direct_control' && selectedMode.routeDecision.requiresIsolation) {
    return buildFacadeResult({
      status: 'blocked',
      summary: 'WORKSPACE_PLACEMENT_DIRECT_CONTROL_FORBIDDEN: typed placement requires isolation, so force_mode=direct_control cannot override admission policy.',
      data: { executionStarted: false, workContractCreated: false, routeDecision: selectedMode.routeDecision },
      rawAvailable: false,
    });
  }
  let policy = evaluateAccessPolicy(selectedMode);
  if (policy.decision === 'allowed' && effectiveModeInput.requiresUserApproval !== true) {
    selectedMode = selectExecutionMode({ ...effectiveModeInput, approvalConfirmed: true });
    policy = evaluateAccessPolicy(selectedMode);
  }
  let mode = applyForcedMode(selectedMode);
  const routeApprovalRequired = mode.routeDecision.requiresApproval
    && mode.routeDecision.waitForUser
    && mode.routeDecision.approvalState !== 'blocked_by_policy';
  const approvalRequired = policy.decision === 'approval_required' || routeApprovalRequired;

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
    const directAdmissionSnapshot = input.relatedWorkId || (input.planId && input.planStepId)
      ? readActiveWorkCandidates({ ...ctx.workStore, limit: 100 })
      : { contracts: [], invalid: [] };
    const invalidDirectOwner = directAdmissionSnapshot.invalid.find((candidate) =>
      candidate.workId === input.relatedWorkId
      || (input.planId && input.planStepId && candidate.planId === input.planId && candidate.planStepId === input.planStepId));
    if (invalidDirectOwner) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `WORK_ADMISSION_INVALID_OWNER: ${invalidDirectOwner.workId} is malformed and cannot be used as Direct Control ownership authority.`,
        data: { executionStarted: false, workContractCreated: false, invalidWorkId: invalidDirectOwner.workId, invalidWorkError: invalidDirectOwner.error },
      });
    }
    const directOwnershipCandidates = directAdmissionSnapshot.contracts
      .filter((candidate) => (candidate.lifecycleRole ?? 'primary') === 'primary');
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
        : approvalRequired
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
      blockingDecision: approvalRequired
        ? 'Approve side effects or restate a safer objective.'
        : 'Clarify objective, scope, and acceptance criteria.',
      recommendedDecision: 'Provide a clear objective and authorization, or cancel the request.',
      recommendedPrompt: `Resolve handoff and restate work for repo ${ctx.repoId}.`,
      recommendedContinuationPrompt: `After approval, start the approved work for ${ctx.repoId}.`,
      approvalAction: approvalRequired
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
              workspaceMode: placementConstraint.workspaceMode,
              requireWorktree: placementConstraint.requireWorktree,
              directMainProhibited: placementConstraint.directMainProhibited,
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
      status: policy.decision === 'denied' ? 'blocked' : approvalRequired ? 'approval_required' : 'blocked',
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

  return startGoalWorkloop(ctx, {
    ...input,
    constraints: canonicalConstraints,
    modeInput: effectiveModeInput,
    workKind: effectiveWorkKind,
  }, policy, 'goal_workloop', mode.routeDecision);
}

export function startGoalWorkloop(
  ctx: GoalWorkloopContext,
  input: GoalWorkloopStartInput,
  policy?: PolicyDecision,
  executionMode: 'direct_control' | 'goal_workloop' = 'goal_workloop',
  routeDecision = selectExecutionMode({ ...input.modeInput, objective: input.objective, knownPaths: input.allowedPaths }).routeDecision,
): FacadeResult {
  const placementResolution = resolveWorkspaceAdmissionConstraint(input.constraints);
  if (placementResolution.ok === false) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `${placementResolution.code}: ${placementResolution.message}`,
      data: { executionStarted: false, workContractCreated: false, placementConstraintConflict: true },
      rawAvailable: false,
    });
  }
  const placementConstraint = placementResolution.constraint;
  const canonicalConstraints: WorkContract['constraints'] = {
    ...(input.constraints ?? {}),
    workspaceMode: placementConstraint.workspaceMode,
    requireWorktree: placementConstraint.requireWorktree,
    directMainProhibited: placementConstraint.directMainProhibited,
  };
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
  const resolvedWorkKind = resolvedWorkKindFor(input);
  const workRisk = workRiskFor(input);
  // External-effect risk is governed by authorization/confirmation/receipt
  // semantics. Engineering admission is specifically for repository mutation.
  const engineeringRisk: WorkRisk = resolvedWorkKind === 'repository_change' ? workRisk : 'readonly';
  const engineeringProfile = engineeringWorkProfileForRisk(engineeringRisk);
  const engineeringSourceIdentity = ctx.sourceRevision?.trim()
    ? { kind: 'revision' as const, revision: ctx.sourceRevision.trim() }
    : ctx.sourceBaseState === 'unborn'
      ? { kind: 'unborn' as const }
      : { kind: 'unknown' as const };
  let engineeringContext;
  try {
    engineeringContext = buildEngineeringContextReceipt({
      risk: engineeringRisk,
      sourceIdentity: engineeringSourceIdentity,
      evidence: input.verifiedEngineeringEvidence,
      recordedAt: at,
    });
  } catch (error) {
    return buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'ENGINEERING_CONTEXT_INVALID',
      data: { executionStarted: false, workContractCreated: false, engineeringProfile },
    });
  }
  const engineeringMutation = resolvedWorkKind === 'repository_change'
    && (input.modeInput.mutation ?? input.modeInput.risk !== 'readonly');
  const engineeringAdmission = evaluateEngineeringAdmission({
    profile: engineeringProfile,
    receipt: engineeringContext,
    mutation: engineeringMutation,
  });
  if (!engineeringAdmission.allowed) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `${engineeringAdmission.code}: ${engineeringProfile.riskClass} mutation is missing required pre-mutation engineering evidence.`,
      data: {
        executionStarted: false,
        workContractCreated: false,
        engineeringProfile,
        engineeringContext,
        missingEngineeringEvidence: engineeringAdmission.missing,
      },
    });
  }
  const available = ctx.availableChecks ?? [];
  const workspaceMode = placementConstraint.workspaceMode;
  const activeAdmissionSnapshot = readActiveWorkCandidates({ ...ctx.workStore, limit: 100 });
  const activeWorks = activeAdmissionSnapshot.contracts
    .filter((candidate) => (candidate.lifecycleRole ?? 'primary') === 'primary');
  const invalidRelatedWork = input.relatedWorkId
    ? activeAdmissionSnapshot.invalid.find((candidate) => candidate.workId === input.relatedWorkId)
    : undefined;
  if (invalidRelatedWork) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_RELATED_CONTRACT_INVALID: ${invalidRelatedWork.workId} is malformed and cannot authorize a Work relationship.`,
      data: { executionStarted: false, workContractCreated: false, invalidWorkId: invalidRelatedWork.workId, invalidWorkError: invalidRelatedWork.error },
    });
  }
  const relatedLifecycleSource = input.relatedWorkId
    ? getWorkContract(ctx.workStore, input.relatedWorkId)
    : undefined;
  const workspaceOwner = ctx.checkoutId
    ? activeWorks.find((candidate) => candidate.checkoutId === ctx.checkoutId
      && candidate.worktreePolicy.required !== true
      && !candidate.worktreeRef)
    : undefined;
  const terminalContinuationSource = input.workRelation === 'continue'
    && relatedLifecycleSource
    && isTerminalWorkContractStatus(relatedLifecycleSource.status)
    ? relatedLifecycleSource
    : undefined;
  if (terminalContinuationSource && !terminalContinuationSource.requirementId && !terminalContinuationSource.planId) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_SUCCESSOR_SEMANTIC_SCOPE_REQUIRED: ${terminalContinuationSource.workId} is terminal but has no Requirement/Plan lineage. Use new_goal or bind an explicit durable semantic authority instead of guessing continuity.`,
      data: { executionStarted: false, workContractCreated: false, relatedWorkId: terminalContinuationSource.workId },
    });
  }
  const explicitRelatedWork = input.relatedWorkId
    ? activeWorks.find((candidate) => candidate.workId === input.relatedWorkId)
    : undefined;

  let resolvedPlanId = input.planId?.trim() || undefined;
  let resolvedPlanStepId = input.planStepId?.trim() || undefined;
  if (terminalContinuationSource?.planId) {
    if (resolvedPlanId && resolvedPlanId !== terminalContinuationSource.planId) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `WORK_SUCCESSOR_PLAN_MISMATCH: predecessor ${terminalContinuationSource.workId} belongs to ${terminalContinuationSource.planId}, not ${resolvedPlanId}. Supersede/replan explicitly instead of silently moving continuation authority.`,
        data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, predecessorPlanId: terminalContinuationSource.planId, requestedPlanId: resolvedPlanId },
      });
    }
    resolvedPlanId = terminalContinuationSource.planId;
  }
  const plan = resolvedPlanId && ctx.planStore ? getPlanContract(ctx.planStore, resolvedPlanId) : undefined;
  if (terminalContinuationSource?.planId && !plan) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_SUCCESSOR_PLAN_NOT_FOUND: ${terminalContinuationSource.planId}. Recover the durable Plan authority before creating a successor Work.`,
      data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, planId: terminalContinuationSource.planId },
    });
  }
  if (terminalContinuationSource?.planStepId && plan && !resolvedPlanStepId) {
    const predecessorStep = plan.steps.find((step) => step.id === terminalContinuationSource.planStepId);
    if (!predecessorStep) {
      return buildFacadeResult({
        status: 'blocked',
        summary: `WORK_SUCCESSOR_PLAN_STEP_NOT_FOUND: predecessor ${terminalContinuationSource.workId} references ${terminalContinuationSource.planStepId}.`,
        data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, predecessorPlanStepId: terminalContinuationSource.planStepId },
      });
    }
    const requirementRecord = plan.requirementId && ctx.workStore.controllerHome
      ? readRequirement({ controllerHome: ctx.workStore.controllerHome }, plan.requirementId)
      : undefined;
    const progressionWorks: ProgressionWorkSnapshot[] = plan.steps
      .flatMap((candidate) => candidate.workId ? [getWorkContract(ctx.workStore, candidate.workId)] : [])
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .map((candidate) => ({
        workId: candidate.workId,
        requirementId: candidate.requirementId,
        planId: candidate.planId,
        planStepId: candidate.planStepId,
        status: candidate.status,
        baseRevision: candidate.baseRevision,
        completionTargetRevision: candidate.completionReceipt && 'targetRevision' in candidate.completionReceipt
          ? candidate.completionReceipt.targetRevision
          : undefined,
      }));
    const progression = projectAutonomousGoalProgression({
      requirement: {
        requirementId: plan.requirementId ?? terminalContinuationSource.requirementId ?? `plan:${plan.planId}`,
        state: requirementRecord?.value.state ?? 'active',
        revision: requirementRecord?.revision ?? 0,
      },
      plan: {
        planId: plan.planId,
        requirementId: plan.requirementId,
        sourceRevision: plan.sourceRevision,
        status: plan.status,
        steps: plan.steps.map((candidate) => ({ id: candidate.id, dependencies: candidate.dependencies, status: candidate.status, workId: candidate.workId })),
      },
      currentSourceRevision: ctx.sourceRevision ?? plan.sourceRevision,
      works: progressionWorks,
      controllerRounds: [],
    });
    if (progression.kind === 'request_controller_acceptance') {
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_SEMANTIC_ACCEPTANCE_REQUIRED: ${plan.planId}/${progression.planStepId ?? predecessorStep.id} has machine-complete delivery. Accept the delivered step before advancing the same semantic goal.`,
        data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, planStepId: progression.planStepId ?? predecessorStep.id, semanticAcceptanceRequired: true, progression },
      });
    }
    if (progression.reasonCode === 'PLAN_STEP_TERMINAL_WORK_RECONCILIATION_REQUIRED') {
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_STEP_TERMINAL_WORK_RECONCILIATION_REQUIRED: ${plan.planId}/${progression.planStepId ?? predecessorStep.id} must project terminal Work ${terminalContinuationSource.workId} before semantic progression.`,
        data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, planStepId: progression.planStepId ?? predecessorStep.id, repairRequired: true, progression },
      });
    }
    if (progression.kind === 'start_next_plan_step' && progression.planStepId) {
      resolvedPlanStepId = progression.planStepId;
    } else if (progression.kind === 'request_requirement_acceptance') {
      return buildFacadeResult({
        status: 'ok',
        summary: `CONTINUATION_REQUIREMENT_ACCEPTANCE_REQUIRED: ${plan.planId} is finalized; the semantic Controller must record goal_complete before the Requirement becomes done.`,
        data: { executionStarted: false, workContractCreated: false, admissionDecision: 'requirement_acceptance_required', requirementAcceptanceRequired: true, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, requirementId: plan.requirementId, progression },
      });
    } else if (progression.kind === 'goal_complete') {
      return buildFacadeResult({
        status: 'ok',
        summary: `CONTINUATION_GOAL_COMPLETE: ${plan.planId} Requirement is already semantically complete; no successor Work was created.`,
        data: { executionStarted: false, workContractCreated: false, admissionDecision: 'goal_complete', goalComplete: true, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, requirementId: plan.requirementId, progression },
      });
    } else if (progression.reasonCode === 'MULTIPLE_READY_PLAN_STEPS') {
      const candidates = (progression.dependencyStepIds ?? [])
        .map((stepId) => plan.steps.find((candidate) => candidate.id === stepId))
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
      return buildFacadeResult({
        status: 'ok',
        summary: `PLAN_SUCCESSOR_STEP_RESOLUTION_REQUIRED: ${plan.planId} has ${candidates.length} executable successor steps. The semantic Controller must select one; Forge will not invent ordering.`,
        data: { executionStarted: false, workContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, candidatePlanSteps: candidates.map((candidate) => ({ id: candidate.id, objective: candidate.objective })), progression },
      });
    } else if (progression.kind === 'request_replan') {
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_SUCCESSOR_REPLAN_REQUIRED: ${plan.planId} ${progression.reasonCode}.`,
        data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, progression },
      });
    } else if (progression.kind !== 'start_next_plan_step') {
      return buildFacadeResult({
        status: 'blocked',
        summary: `PLAN_SUCCESSOR_PROGRESSION_BLOCKED: ${plan.planId} ${progression.reasonCode}.`,
        data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, planId: plan.planId, progression },
      });
    }
  }
  const planStep = plan && resolvedPlanStepId ? plan.steps.find((step) => step.id === resolvedPlanStepId) : undefined;
  const requestedRequirementId = input.requirementId?.trim() || undefined;
  const predecessorRequirementId = terminalContinuationSource?.requirementId;
  if (predecessorRequirementId && requestedRequirementId && predecessorRequirementId !== requestedRequirementId) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_SUCCESSOR_REQUIREMENT_MISMATCH: predecessor ${terminalContinuationSource.workId} belongs to ${predecessorRequirementId}, not ${requestedRequirementId}.`,
      data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, predecessorRequirementId, requestedRequirementId },
    });
  }
  if (plan && requestedRequirementId && requestedRequirementId !== plan.requirementId) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `PLAN_REQUIREMENT_MISMATCH: ${plan.planId} is bound to ${plan.requirementId ?? 'no Requirement'}, not ${requestedRequirementId}. Use the Plan relationship authority or replan explicitly.`,
      data: { executionStarted: false, workContractCreated: false, planId: plan.planId, planRequirementId: plan.requirementId, requestedRequirementId },
    });
  }
  if (plan?.requirementId && predecessorRequirementId && plan.requirementId !== predecessorRequirementId) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_SUCCESSOR_PLAN_REQUIREMENT_MISMATCH: predecessor ${terminalContinuationSource!.workId} belongs to ${predecessorRequirementId}, while ${plan.planId} belongs to ${plan.requirementId}.`,
      data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource!.workId, predecessorRequirementId, planId: plan.planId, planRequirementId: plan.requirementId },
    });
  }
  const effectiveRequirementId = requestedRequirementId || plan?.requirementId || predecessorRequirementId;
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
        summary: `PLAN_STEP_WORK_CONTRACT_MISMATCH: ${resolvedPlanId}/${resolvedPlanStepId} conflicts with frozen Plan step field(s): ${mismatches.join(', ')}. Replan instead of widening or narrowing Work admission.`,
        data: { executionStarted: false, workContractCreated: false, planId: resolvedPlanId, planStepId: resolvedPlanStepId, mismatches },
      });
    }
  }
  const effectiveObjective = planStep?.objective ?? input.objective;
  const effectiveAcceptanceCriteria = planStep?.acceptanceCriteria ?? input.acceptanceCriteria ?? [];
  const effectiveAllowedPaths = planStep?.allowedPaths ?? input.allowedPaths ?? [];
  const effectiveForbiddenPaths = planStep?.forbiddenPaths ?? input.forbiddenPaths ?? [];
  const effectiveChecks = planStep?.checks ?? input.checks ?? [];
  const normalized = normalizeCheckIds(effectiveChecks, available);
  const invalidLineageWork = activeAdmissionSnapshot.invalid.find((candidate) =>
    (resolvedPlanId && resolvedPlanStepId && candidate.planId === resolvedPlanId && candidate.planStepId === resolvedPlanStepId)
    || (effectiveRequirementId && candidate.requirementId === effectiveRequirementId));
  if (invalidLineageWork) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_ADMISSION_INVALID_SEMANTIC_AUTHORITY: ${invalidLineageWork.workId} is malformed but still claims the requested durable Plan/Requirement lineage. Repair that exact authority before creating a sibling Work.`,
      data: {
        executionStarted: false,
        workContractCreated: false,
        invalidWorkId: invalidLineageWork.workId,
        invalidWorkError: invalidLineageWork.error,
        planId: resolvedPlanId,
        planStepId: resolvedPlanStepId,
        requirementId: effectiveRequirementId,
      },
    });
  }
  const newWorkWillBeIsolated = placementConstraint.requireWorktree
    || placementConstraint.workspaceMode === 'isolated'
    || input.modeInput.requiresParallelism === true
    || routeDecision.requiresIsolation === true;
  const invalidSharedWorkspaceOwner = !newWorkWillBeIsolated
    ? activeAdmissionSnapshot.invalid.find((candidate) => candidate.isolation === 'shared'
      && (!candidate.checkoutId || candidate.checkoutId === ctx.checkoutId))
    : undefined;
  if (invalidSharedWorkspaceOwner) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_ADMISSION_INVALID_WORKSPACE_AUTHORITY: ${invalidSharedWorkspaceOwner.workId} is malformed and may still own the shared checkout; isolated placement or exact authority repair is required.`,
      data: { executionStarted: false, workContractCreated: false, invalidWorkId: invalidSharedWorkspaceOwner.workId, invalidWorkError: invalidSharedWorkspaceOwner.error },
    });
  }
  const boundPlanStepWorks = resolvedPlanId && resolvedPlanStepId
    ? activeWorks.filter((candidate) => candidate.planId === resolvedPlanId && candidate.planStepId === resolvedPlanStepId)
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
    return resolutionRequired(`PLAN_STEP_MULTIPLE_PRIMARY_WORKS: ${resolvedPlanId}/${resolvedPlanStepId} has ${boundPlanStepWorks.length} active primary Work records and requires repair before execution.`);
  }
  if (terminalContinuationSource && requestedRelation === 'continue' && planStepWork) {
    if (planStepWork.predecessorWorkId !== terminalContinuationSource.workId) {
      return resolutionRequired(
        `PLAN_STEP_SUCCESSOR_LINEAGE_CONFLICT: ${resolvedPlanId}/${resolvedPlanStepId} is already owned by ${planStepWork.workId}, but its predecessor is ${planStepWork.predecessorWorkId ?? 'none'} rather than ${terminalContinuationSource.workId}.`,
        planStepWork,
      );
    }
    return buildFacadeResult({
      status: 'ok',
      summary: `PLAN_STEP_REUSES_SUCCESSOR_WORK: ${resolvedPlanId}/${resolvedPlanStepId} already continues terminal ${terminalContinuationSource.workId} as ${planStepWork.workId}.`,
      data: {
        executionStarted: false,
        workContractCreated: false,
        admissionDecision: 'reuse_existing',
        resolutionRequired: false,
        predecessorWorkId: terminalContinuationSource.workId,
        work: summarizeWorkContract(planStepWork),
      },
      evidenceRefs: planStepWork.evidenceRefs,
      suggestedNextActions: [{ label: 'Continue successor Work', tool: 'rh_work', operation: 'continue', payload: { work_id: planStepWork.workId }, risk: 'readonly', confidence: 'high' }],
      rawAvailable: false,
    });
  }

  if (planStep?.workId && !explicitPlanStepWork) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `PLAN_STEP_BOUND_WORK_MISSING: ${resolvedPlanId}/${resolvedPlanStepId} is bound to ${planStep.workId}, but that Work is not active. Repair the exact binding; do not create a replacement Work.`,
      data: { executionStarted: false, workContractCreated: false, planId: resolvedPlanId, planStepId: resolvedPlanStepId, boundWorkId: planStep.workId, repairRequired: true },
      suggestedNextActions: [{
        label: 'Diagnose exact Plan step binding',
        tool: 'rh_work',
        operation: 'repair',
        payload: { plan_id: resolvedPlanId, plan_step_id: resolvedPlanStepId, repair_operation: 'diagnose', dry_run: true },
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
      summary: `PLAN_STEP_REUSES_ACTIVE_WORK: ${resolvedPlanId}/${resolvedPlanStepId} already executes as ${planStepWork.workId}; reuse that Work instead of creating another.`,
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

  if ((requestedRelation === 'continue' || requestedRelation === 'extend') && !terminalContinuationSource) {
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
  const needsWorktree = executionMode === 'goal_workloop' && (placementConstraint.requireWorktree
    || placementConflict
    || input.modeInput.workspaceDirty === true
    || input.modeInput.requiresParallelism === true
    || routeDecision.requiresIsolation === true);
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
  const requestedWorkId = input.workId?.trim();
  if (requestedWorkId && !/^work-[a-z0-9][a-z0-9-]{0,199}$/i.test(requestedWorkId)) {
    return buildFacadeResult({
      status: 'blocked',
      summary: 'WORK_ID_INVALID: explicit Work ids must use the canonical work-<slug> form.',
      data: { executionStarted: false, workContractCreated: false },
    });
  }
  const generatedWorkId = requestedWorkId ?? workIdFor(effectiveObjective);
  if (resolvedPlanId || resolvedPlanStepId) {
    if (!resolvedPlanId || !resolvedPlanStepId || !ctx.planStore || !ctx.sourceRevision || !plan || !planStep) {
      return buildFacadeResult({ status: 'blocked', summary: 'PLAN_CONTEXT_REQUIRED: plan_id, plan_step_id, an executable Plan step and a current source revision are required.', data: { executionStarted: false } });
    }
    if (plan.status !== 'approved' && plan.status !== 'executing') {
      return buildFacadeResult({ status: 'blocked', summary: `PLAN_NOT_EXECUTABLE: ${plan.planId} is ${plan.status}`, data: { executionStarted: false, planId: plan.planId } });
    }
    if (plan.sourceRevision !== ctx.sourceRevision) {
      const invalidated = claimPlanStepForWork(ctx.planStore, {
        planId: resolvedPlanId,
        stepId: resolvedPlanStepId,
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
  const remoteDeliveryRequired = resolvedWorkKind === 'repository_change'
    && input.modeInput.requiresExternalEffect === true
    && input.modeInput.remoteWrite === true;
  const effectiveConstraints: WorkContract['constraints'] = {
    ...canonicalConstraints,
    ...(needsWorktree ? { workspaceMode: 'isolated' as const, requireWorktree: true } : {}),
    ...(remoteDeliveryRequired ? { remoteDeliveryRequired: true } : {}),
  };
  const worktreeReason = input.modeInput.workspaceDirty === true
    ? 'Trusted repository observation found the current checkout dirty; durable Goal Work is isolated so unrelated changes cannot enter Work ownership or verification.'
    : placementConflict
      ? 'The selected checkout is already owned by another active Work; this Work requires isolated placement.'
      : input.modeInput.requiresParallelism === true
        ? 'Parallel Work requires isolated placement.'
        : routeDecision.requiresIsolation === true || placementConstraint.requireWorktree
          ? 'Typed placement or Route Policy requires isolated execution.'
          : 'Current workspace is the stability-first default; isolation remains opt-in.';
  const work = createWorkContract(ctx.workStore, {
    workId: generatedWorkId,
    repoId: ctx.repoId,
    checkoutId: needsWorktree ? undefined : ctx.checkoutId,
    principalId: ctx.principalId,
    controllerInstanceId: ctx.controllerInstanceId,
    baseRevision: ctx.sourceRevision,
    repositoryBaseState: ctx.sourceBaseState ?? (ctx.sourceRevision ? 'revision' : undefined),
    workspaceFingerprint: needsWorktree ? undefined : ctx.workspaceFingerprint,
    routeDecisionFingerprint: routeDecision.inputFingerprint,
    routeDecision,
    mode: executionMode,
    objective: effectiveObjective,
    acceptanceCriteria: effectiveAcceptanceCriteria,
    constraints: effectiveConstraints,
    risk: workRisk,
    engineeringContext,
    // Remote delivery is a risk/effect dimension, not a reason to erase a
    // repository-change Work's semantic identity. Pure external actions with no
    // repository-change signal remain remote_effect and keep plugin receipt semantics.
    workKind: resolvedWorkKind,
    status: 'running',
    phase: 'implementation',
    issueId: input.issueId,
    taskId: input.taskId,
    requirementId: effectiveRequirementId,
    predecessorWorkId: terminalContinuationSource?.workId,
    planId: resolvedPlanId,
    planStepId: resolvedPlanStepId,
    planSourceRevision: resolvedPlanId ? ctx.sourceRevision : undefined,
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
      reason: worktreeReason,
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
    requestId: input.requestId?.trim() || undefined,
    evidenceRefs: [initialEvidence(effectiveObjective)],
    policyDecisions: policy ? [policy] : [],
    suggestedNextActions: initialSuggestedNextActions,
    continuationPrompt: `Continue work ${ctx.repoId}: ${effectiveObjective.slice(0, 200)}`,
  });

  if (resolvedPlanId && resolvedPlanStepId && ctx.planStore && ctx.sourceRevision) {
    try {
      const claimed = claimPlanStepForWork(ctx.planStore, {
        planId: resolvedPlanId,
        stepId: resolvedPlanStepId,
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
        data: { planId: resolvedPlanId, planStepId: resolvedPlanStepId, executionStarted: false, workContractCreated: true, work: summarizeWorkContract(work), canonicalWorkRetained: true },
      });
    }
  }

  return buildFacadeResult({
    status: 'ok',
    summary: terminalContinuationSource
      ? `Successor Work ${work.workId} continues semantic lineage from terminal ${terminalContinuationSource.workId}${resolvedPlanId && resolvedPlanStepId ? ` at ${resolvedPlanId}/${resolvedPlanStepId}` : ''}.`
      : executionMode === 'direct_control'
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

  if (input.verifiedEngineeringEvidence) {
    const sourceIdentity = ctx.sourceRevision?.trim()
      ? { kind: 'revision' as const, revision: ctx.sourceRevision.trim() }
      : ctx.sourceBaseState === 'unborn'
        ? { kind: 'unborn' as const }
        : { kind: 'unknown' as const };
    let refreshedEngineeringContext;
    try {
      refreshedEngineeringContext = buildEngineeringContextReceipt({
        risk: work.risk,
        sourceIdentity,
        evidence: input.verifiedEngineeringEvidence,
        recordedAt: nowIso(ctx),
      });
    } catch (error) {
      return buildFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : 'ENGINEERING_CONTEXT_INVALID',
        data: { work: summarizeWorkContract(work), engineeringEvidenceUpdated: false },
      });
    }
    const priorDesign = work.engineeringContext?.evidence.designDecisionReceipt;
    if (work.engineeringContext?.designState === 'revisit_required' && priorDesign) {
      const nextDesign = refreshedEngineeringContext.evidence.designDecisionReceipt;
      if (!nextDesign || nextDesign.supersedesReceiptId !== priorDesign.receiptId) {
        return buildFacadeResult({
          status: 'blocked',
          summary: 'ENGINEERING_DESIGN_SUPERSESSION_REQUIRED: same-root-cause re-entry requires a new design receipt that explicitly supersedes the prior design.',
          data: { work: summarizeWorkContract(work), priorDesignReceiptId: priorDesign.receiptId },
        });
      }
    }
    work = updateWorkContract(ctx.workStore, work.workId, { engineeringContext: refreshedEngineeringContext });
  }

  if (input.engineeringBlocker) {
    if (!work.engineeringContext || work.engineeringContext.sourceIdentity.kind !== 'revision') {
      return buildFacadeResult({ status: 'blocked', summary: 'ENGINEERING_BLOCKER_SOURCE_IDENTITY_REQUIRED', data: { work: summarizeWorkContract(work) } });
    }
    let blocker;
    let linkedWork: WorkContract | undefined;
    try {
      let linkedWorkId: string | undefined;
      if (input.engineeringBlocker.classification === 'unrelated') {
        linkedWorkId = linkedEngineeringBlockerWorkId(work.workId, input.engineeringBlocker.blockerId);
        linkedWork = getWorkContract(ctx.workStore, linkedWorkId);
        if (!linkedWork) {
          const linked = routeWorkStart(ctx, {
            workId: linkedWorkId,
            objective: `Resolve unrelated blocker ${input.engineeringBlocker.blockerId}: ${input.engineeringBlocker.rationale}`,
            acceptanceCriteria: [
              `Resolve blocker ${input.engineeringBlocker.blockerId} without widening Work ${work.workId}.`,
              'Return bounded evidence or a precise wake/blocker condition to the owning Controller.',
            ],
            allowedPaths: [],
            initialLikelyPaths: [],
            forbiddenPaths: [],
            checks: [],
            modeInput: {
              scopeClear: false,
              mutation: false,
              requiresInvestigation: true,
              requiresRecovery: true,
              requiresParallelism: true,
            },
            requestedBy: 'chatgpt',
            relatedWorkId: work.workId,
            workRelation: 'parallel',
            requirementId: work.requirementId,
            workKind: 'investigation',
            constraints: { accessMode: work.constraints.accessMode },
          });
          linkedWork = getWorkContract(ctx.workStore, linkedWorkId);
          if (linked.status !== 'ok' || !linkedWork) {
            return buildFacadeResult({
              status: 'blocked',
              summary: `ENGINEERING_LINKED_WORK_ADMISSION_FAILED: ${linked.summary}`,
              data: { work: summarizeWorkContract(work), linkedWorkId, linkedWorkCreated: false },
            });
          }
        }
      }
      blocker = buildEngineeringBlockerDispositionReceipt({
        sourceRevision: work.engineeringContext.sourceIdentity.revision,
        blockerId: input.engineeringBlocker.blockerId,
        classification: input.engineeringBlocker.classification,
        semanticScopeKeys: input.engineeringBlocker.semanticScopeKeys ?? work.engineeringContext.semanticScope?.keys ?? [],
        ...(linkedWork ? { linkedWorkId: linkedWork.workId } : {}),
        rationale: input.engineeringBlocker.rationale,
        recordedAt: nowIso(ctx),
      });
      const nextEngineering = applyEngineeringBlockerDisposition(work.engineeringContext, blocker);
      work = updateWorkContract(ctx.workStore, work.workId, { engineeringContext: nextEngineering });
    } catch (error) {
      return buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'ENGINEERING_BLOCKER_INVALID', data: { work: summarizeWorkContract(work) } });
    }
    const returnToDesign = blocker.action === 'return_to_design';
    return buildFacadeResult({
      status: 'blocked',
      summary: returnToDesign
        ? `Same-root-cause blocker ${blocker.blockerId} requires Product/Design re-entry before further mutation.`
        : `Unrelated blocker ${blocker.blockerId} is linked to ${blocker.linkedWorkId}; current Work semantic scope is unchanged.`,
      data: {
        work: summarizeWorkContract(work),
        engineeringBlocker: blocker,
        ...(linkedWork ? { linkedWork: summarizeWorkContract(linkedWork), linkedWorkCreated: true } : {}),
        nextStep: blocker.action,
      },
      suggestedNextActions: returnToDesign
        ? [{ label: 'Refresh design evidence', tool: 'rh_context', operation: 'get', payload: { work_id: work.workId }, risk: 'readonly' }]
        : linkedWork
          ? [{ label: 'Continue linked Work', tool: 'rh_work', operation: 'continue', payload: { work_id: linkedWork.workId }, risk: 'workspace_write' }]
          : [],
    });
  }

  if ((input.reviewFindings?.length ?? 0) > 0 && work.workKind !== 'read_only_review') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `READ_ONLY_REVIEW_FINDINGS_KIND_REQUIRED: ${work.workId} is ${work.workKind}, not read_only_review.`,
      data: { work: summarizeWorkContract(work), reviewFindingsRecorded: false },
    });
  }
  if (work.workKind === 'read_only_review') {
    const sourceIdentity = evaluateReadOnlyReviewSourceIdentity(work, ctx.sourceRevision, ctx.workspaceChangedPaths);
    if (sourceIdentity.status !== 'complete') {
      return buildFacadeResult({
        status: 'blocked',
        summary: `READ_ONLY_REVIEW_SOURCE_IDENTITY_REQUIRED: ${sourceIdentity.reasons.join(' ')}`,
        data: { work: summarizeWorkContract(work), sourceIdentityProven: false },
      });
    }
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
  if ((input.acceptanceEvidence?.length ?? 0) > 0) {
    if (work.workKind !== 'local_effect') {
      return buildFacadeResult({
        status: 'blocked',
        summary: `WORK_SEMANTIC_ACCEPTANCE_LOCAL_EFFECT_REQUIRED: ${work.workId} is ${work.workKind}.`,
        data: { work: summarizeWorkContract(work), semanticAcceptanceRecorded: false },
      });
    }
    const declaredCriteria = new Map(work.acceptanceCriteria.map((criterion) => [criterion.trim(), criterion]));
    const availableEvidenceIds = new Set([
      ...work.evidenceRefs.flatMap((evidence) => [evidence.evidenceId, evidence.artifactId])
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
      ...(ctx.workBoundProcessEvidenceIds ?? []).map((value) => value.trim()).filter(Boolean),
    ]);
    const normalizedBindings: Array<{ criterion: string; evidenceIds: string[]; rationale: string }> = [];
    for (const binding of input.acceptanceEvidence ?? []) {
      const requestedCriterion = binding.criterion.trim();
      const criterion = declaredCriteria.get(requestedCriterion);
      if (!criterion) {
        return buildFacadeResult({
          status: 'blocked',
          summary: `WORK_SEMANTIC_ACCEPTANCE_CRITERION_UNKNOWN: ${requestedCriterion || '<empty>'}.`,
          data: { work: summarizeWorkContract(work), semanticAcceptanceRecorded: false },
        });
      }
      const evidenceIds = [...new Set(binding.evidenceIds.map((value) => value.trim()).filter(Boolean))];
      if (evidenceIds.length === 0) {
        return buildFacadeResult({
          status: 'blocked',
          summary: `WORK_SEMANTIC_ACCEPTANCE_EVIDENCE_REQUIRED: ${criterion}.`,
          data: { work: summarizeWorkContract(work), semanticAcceptanceRecorded: false },
        });
      }
      const unknownEvidenceIds = evidenceIds.filter((evidenceId) => !availableEvidenceIds.has(evidenceId));
      if (unknownEvidenceIds.length > 0) {
        return buildFacadeResult({
          status: 'blocked',
          summary: `WORK_SEMANTIC_ACCEPTANCE_EVIDENCE_UNKNOWN: ${unknownEvidenceIds.join(', ')}.`,
          data: { work: summarizeWorkContract(work), semanticAcceptanceRecorded: false },
        });
      }
      const rationale = binding.rationale.trim();
      if (!rationale) {
        return buildFacadeResult({
          status: 'blocked',
          summary: `WORK_SEMANTIC_ACCEPTANCE_RATIONALE_REQUIRED: ${criterion}.`,
          data: { work: summarizeWorkContract(work), semanticAcceptanceRecorded: false },
        });
      }
      normalizedBindings.push({ criterion, evidenceIds, rationale: rationale.slice(0, 1_000) });
    }
    const recordedAt = nowIso(ctx);
    const byCriterion = new Map((work.semanticAcceptanceEvidence ?? []).map((review) => [review.criterion, review]));
    for (const binding of normalizedBindings) {
      const previous = byCriterion.get(binding.criterion);
      byCriterion.set(binding.criterion, {
        criterion: binding.criterion,
        evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), ...binding.evidenceIds])].slice(0, 50),
        rationale: binding.rationale,
        recordedAt,
      });
    }
    work = updateWorkContract(ctx.workStore, work.workId, {
      semanticAcceptanceEvidence: [...byCriterion.values()].slice(0, 20),
    });
    work = appendWorkEvidence(ctx.workStore, work.workId, {
      title: 'Controller semantic acceptance review',
      summary: `Controller reviewed ${normalizedBindings.length} exact acceptance criterion binding(s) against durable Work evidence.`,
      detailLevel: 'summary',
    });
  }

  if (work.workKind === 'read_only_review' && ((input.inspectedPaths?.length ?? 0) > 0 || input.reviewFindings !== undefined)) {
    const findings = [...new Set([
      ...(work.readOnlyReviewEvidence?.findings ?? []),
      ...(input.reviewFindings ?? []).map((finding) => finding.trim()).filter(Boolean),
    ])].slice(0, 50);
    const inspectedPaths = [...new Set(work.scopeEvidence?.inspectedPaths ?? [])].slice(0, 200);
    work = updateWorkContract(ctx.workStore, work.workId, {
      readOnlyReviewEvidence: {
        sourceRevision: ctx.sourceRevision!,
        ...(ctx.workspaceFingerprint ? { workspaceFingerprint: ctx.workspaceFingerprint } : {}),
        inspectedPaths,
        findings,
        recordedAt: nowIso(ctx),
      },
    });
    for (const finding of input.reviewFindings ?? []) {
      const summary = finding.trim();
      if (!summary) continue;
      work = appendWorkEvidence(ctx.workStore, work.workId, {
        title: 'read-only review finding',
        summary: summary.slice(0, 1_500),
        detailLevel: 'summary',
      });
    }
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
        nextStep: work.workKind === 'read_only_review' ? 'review' : 'execute',
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

  const completionEvidence = evaluateWorkCompletionEvidence(
    work,
    ctx.sourceRevision,
    ctx.workspaceFingerprint,
    ctx.workBoundProcessEvidenceIds,
    ctx.workspaceChangedPaths,
  );
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
      phase: work.workKind === 'read_only_review' ? 'verification' : 'implementation',
      state: 'active',
      summary: work.workKind === 'read_only_review'
        ? `Read-only review completion evidence is incomplete: ${completionEvidence.reasons.join(' ')}`
        : `Meaningful implementation evidence is still missing: ${completionEvidence.reasons.join(' ')}`,
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
        executionEvidencePresent: Boolean(ctx.workBoundProcessEvidenceIds?.length),
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

  const changedPaths = normalizeImplementationReviewChangedPaths(ctx.workspaceChangedPaths ?? work.scopeEvidence?.actualChangedPaths ?? []);
  if (workRequiresImplementationReview(work.workKind, changedPaths)) {
    recordWorkScopeEvidence(ctx.workStore, work.workId, { actualChangedPaths: changedPaths });
    transitionWorkContractPhase(ctx.workStore, work.workId, {
      status: 'running',
      phase: 'verification',
      state: 'satisfied',
      summary: 'Exact Work completion evidence proves the current candidate is verified and eligible for implementation review.',
      evidenceRefs: work.evidenceRefs,
    });
    requestWorkImplementationReview(ctx.workStore, work.workId, 'Implementation and verification evidence are complete; explicit Controller implementation review is required before delivery.');
    const suggested = validateSuggestedNextActions([implementationReviewSuggestedAction(work.workId)]).actions;
    const updated = updateWorkContract(ctx.workStore, work.workId, { suggestedNextActions: suggested });
    return buildFacadeResult({
      status: 'ok',
      summary: 'Continue: implementation and verification evidence are complete; explicit implementation review is next.',
      data: { work: summarizeWorkContract(updated), backgroundCompleted: false, nextStep: 'review' },
      suggestedNextActions: suggested,
    });
  }
  const suggested = validateSuggestedNextActions([{
    label: 'Finalize work', tool: 'rh_work', operation: 'finalize', payload: { work_id: work.workId }, risk: 'readonly', confidence: 'high',
  }]).actions;
  transitionWorkContractPhase(ctx.workStore, work.workId, {
    status: 'running', phase: 'delivery', state: 'active',
    summary: 'Source-free Work evidence is complete; implementation review is not required and semantic finalization is next.', evidenceRefs: work.evidenceRefs,
  });
  const updated = updateWorkContract(ctx.workStore, work.workId, { suggestedNextActions: suggested });
  return buildFacadeResult({ status: 'ok', summary: 'Continue: evidence is complete; ready to finalize.', data: { work: summarizeWorkContract(updated), backgroundCompleted: false, nextStep: 'finalize' }, suggestedNextActions: suggested });
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
  const validPassReadyForNextBoundary = completionEvidence?.status === 'complete';
  const currentChangedPaths = normalizeImplementationReviewChangedPaths(ctx.workspaceChangedPaths ?? updated.scopeEvidence?.actualChangedPaths ?? []);
  const latestReview = latestImplementationReview(updated.implementationReviews);
  const approvedReviewRemainsAuthoritative = Boolean(
    validPassReadyForNextBoundary
    && updated.phase === 'delivery'
    && updated.phaseEvidence.review.state === 'satisfied'
    && latestReview?.decision === 'approved'
    && sourceRevision
    && input.workspaceFingerprint
    && latestReview.sourceRevision === sourceRevision
    && latestReview.verificationWorkspaceFingerprint === input.workspaceFingerprint
    && latestReview.changedPathDigest === implementationReviewChangedPathDigest(currentChangedPaths)
  );
  const reviewRequiredAfterPass = validPassReadyForNextBoundary
    && !approvedReviewRemainsAuthoritative
    && workRequiresImplementationReview(updated.workKind, currentChangedPaths);
  if (approvedReviewRemainsAuthoritative && updated.evidenceState !== 'valid') {
    updateWorkContract(ctx.workStore, updated.workId, { evidenceState: 'valid' });
  }
  if (reviewRequiredAfterPass) {
    recordWorkScopeEvidence(ctx.workStore, updated.workId, { actualChangedPaths: [...(ctx.workspaceChangedPaths ?? [])] });
    transitionWorkContractPhase(ctx.workStore, updated.workId, {
      status: 'running',
      phase: 'verification',
      state: 'satisfied',
      summary: 'All required exact Work verification receipts are current; implementation review admission is now allowed.',
      evidenceRefs: updated.evidenceRefs,
    });
    requestWorkImplementationReview(ctx.workStore, updated.workId, 'Verification is complete; explicit Controller implementation review is required before delivery.');
  }
  const suggested = validateSuggestedNextActions(
    classified.outcome === 'valid_pass'
      ? [reviewRequiredAfterPass
          ? implementationReviewSuggestedAction(work.workId)
          : {
              label: validPassReadyForNextBoundary ? 'Finalize work' : 'Continue workloop',
              tool: 'rh_work',
              operation: validPassReadyForNextBoundary ? 'finalize' : 'continue',
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
        ? { nextStep: reviewRequiredAfterPass ? 'review' : validPassReadyForNextBoundary ? 'finalize' : 'continue' }
        : {}),
    },
    warnings: classified.warnings,
    evidenceRefs: record.evidenceRef ? [record.evidenceRef] : [],
    suggestedNextActions: suggested,
  });
}

export function reviewGoalWorkloop(ctx: GoalWorkloopContext, input: GoalWorkloopReviewInput): FacadeResult {
  let work = getWorkContract(ctx.workStore, input.workId);
  if (!work) return buildFacadeResult({ status: 'not_found', summary: `WorkContract ${input.workId} not found.`, data: { workId: input.workId } });
  if (work.status === 'completed' || work.status === 'cancelled' || work.status === 'failed') {
    return buildFacadeResult({ status: 'blocked', summary: `WorkContract ${work.workId} is terminal (${work.status}); implementation review was not recorded.`, data: { work: summarizeWorkContract(work) } });
  }
  const reviewerPrincipalId = ctx.principalId?.trim() ?? '';
  if (!reviewerPrincipalId) {
    return buildFacadeResult({ status: 'blocked', summary: 'WORK_IMPLEMENTATION_REVIEW_REVIEWER_REQUIRED: authenticated reviewer principal is required.', data: { work: summarizeWorkContract(work) } });
  }
  if (!input.rationale?.trim()) {
    return buildFacadeResult({ status: 'blocked', summary: 'WORK_IMPLEMENTATION_REVIEW_RATIONALE_REQUIRED: explicit review rationale is required.', data: { work: summarizeWorkContract(work) } });
  }
  try {
    const candidate = currentImplementationReviewCandidate(ctx, work);
    recordWorkScopeEvidence(ctx.workStore, work.workId, { actualChangedPaths: [...candidate.changedPaths] });
    work = getWorkContract(ctx.workStore, work.workId) ?? work;
    if (work.phase !== 'review') {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_PHASE_REQUIRED: verify or continue the exact candidate into review before recording a decision.');
    }
    const at = nowIso(ctx);
    const review: WorkImplementationReviewRecord = {
      schemaVersion: 1,
      reviewId: `impl-review-${randomUUID().slice(0, 12)}`,
      workId: work.workId,
      reviewerPrincipalId,
      decision: input.decision,
      rationale: input.rationale.trim().slice(0, 4_000),
      findings: (input.findings ?? []).slice(0, 100).map((finding) => ({
        severity: finding.severity,
        category: finding.category.trim().slice(0, 160),
        summary: finding.summary.trim().slice(0, 1_000),
        ...(finding.path?.trim() ? { path: finding.path.trim() } : {}),
        ...(finding.symbol?.trim() ? { symbol: finding.symbol.trim().slice(0, 240) } : {}),
      })),
      sourceRevision: candidate.sourceRevision,
      workspaceFingerprint: candidate.workspaceFingerprint,
      verificationWorkspaceFingerprint: candidate.verificationWorkspaceFingerprint,
      changedPaths: [...candidate.changedPaths],
      changedPathDigest: implementationReviewChangedPathDigest(candidate.changedPaths),
      acceptanceCriteriaSummary: implementationReviewAcceptanceSummary(work),
      verificationEvidence: [...candidate.verificationEvidence],
      architectureEvidence: [...(candidate.architectureEvidence ?? [])],
      recordedAt: at,
    };
    const updated = recordWorkImplementationReview(ctx.workStore, work.workId, review);
    const suggested = validateSuggestedNextActions(input.decision === 'approved'
      ? [{ label: 'Finalize reviewed work', tool: 'rh_work', operation: 'finalize', payload: { work_id: work.workId }, risk: 'workspace_write', confidence: 'high' }]
      : input.decision === 'changes_required'
        ? [{ label: 'Continue implementation repairs', tool: 'rh_work', operation: 'continue', payload: { work_id: work.workId }, risk: 'workspace_write', confidence: 'high' }]
        : [{ label: 'Inspect blocked review evidence', tool: 'rh_context', operation: 'get', payload: { work_id: work.workId }, risk: 'readonly', confidence: 'high' }]).actions;
    const persisted = updateWorkContract(ctx.workStore, work.workId, { suggestedNextActions: suggested });
    return buildFacadeResult({
      status: input.decision === 'blocked' ? 'blocked' : 'ok',
      summary: `Implementation review ${review.reviewId}: ${input.decision}.`,
      data: { work: summarizeWorkContract(persisted), review, nextStep: input.decision === 'approved' ? 'finalize' : input.decision === 'changes_required' ? 'continue' : 'blocked' },
      suggestedNextActions: suggested,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildFacadeResult({ status: 'blocked', summary: message, data: { work: summarizeWorkContract(work) }, suggestedNextActions: suggestedForWork(work) });
  }
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

  const currentChangedPaths = normalizeImplementationReviewChangedPaths(ctx.workspaceChangedPaths ?? work.scopeEvidence?.actualChangedPaths ?? []);
  if (workRequiresImplementationReview(work.workKind, currentChangedPaths)) {
    try {
      const candidate = currentImplementationReviewCandidate(ctx, work);
      assertImplementationReviewPreDeliveryBoundary({
        repoId: work.repoId,
        workId: work.workId,
        workKind: work.workKind,
        reviews: work.implementationReviews,
        candidate,
        requiredCheckIds: work.checks,
        verificationRecords: work.checkRefs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reviewDecisionBlocked = /WORK_IMPLEMENTATION_REVIEW_(REQUIRED|STALE|CHANGES_REQUIRED|BLOCKED)/.test(message);
      if (reviewDecisionBlocked) {
        transitionWorkContractPhase(ctx.workStore, work.workId, {
          status: 'running',
          phase: 'verification',
          state: 'satisfied',
          summary: `Current exact verification remains authoritative, but implementation review must be renewed before delivery: ${message}`,
          evidenceRefs: work.evidenceRefs,
        });
        requestWorkImplementationReview(ctx.workStore, work.workId, `Pre-delivery implementation review gate requires a renewed Controller decision: ${message}`);
        const suggested = validateSuggestedNextActions([implementationReviewSuggestedAction(work.workId)]).actions;
        const updated = updateWorkContract(ctx.workStore, work.workId, { suggestedNextActions: suggested });
        return buildFacadeResult({
          status: 'blocked',
          summary: message,
          data: { work: summarizeWorkContract(updated), nextStep: 'review' },
          suggestedNextActions: suggested,
        });
      }
      transitionWorkContractPhase(ctx.workStore, work.workId, {
        status: 'running',
        phase: 'verification',
        state: 'active',
        summary: `Pre-delivery review could not prove an exact verified candidate: ${message}`,
        evidenceRefs: work.evidenceRefs,
      });
      const suggested = validateSuggestedNextActions([{
        label: 'Verify exact candidate',
        tool: 'rh_work',
        operation: 'verify',
        payload: { work_id: work.workId, check_id: work.checks[0] },
        risk: 'workspace_write',
        confidence: work.checks[0] ? 'high' : 'medium',
      }], { validCheckIds: work.checks }).actions;
      const updated = updateWorkContract(ctx.workStore, work.workId, { suggestedNextActions: suggested });
      return buildFacadeResult({
        status: 'blocked',
        summary: message,
        data: { work: summarizeWorkContract(updated), nextStep: 'verify' },
        suggestedNextActions: suggested,
      });
    }
  }

  const completionEvidence = evaluateWorkCompletionEvidence(
    work,
    ctx.sourceRevision,
    ctx.workspaceFingerprint,
    ctx.workBoundProcessEvidenceIds,
    ctx.workspaceChangedPaths,
  );
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

  // Read-only review completion is semantic no-change authority, not Git delivery.
  // The exact source/workspace fence is re-evaluated above at finalize time; only
  // a clean review with persisted inspected paths and zero findings can close.
  if (work.workKind === 'read_only_review' && !work.completionReceipt) {
    const reviewEvidence = work.readOnlyReviewEvidence!;
    const recordedAt = nowIso(ctx);
    const completed = completeWorkWithReceipt(
      ctx.workStore,
      work.workId,
      {
        schemaVersion: 1,
        receiptId: `ROR-WORK-${randomUUID()}`,
        source: 'read_only_review',
        workId: work.workId,
        baseRevision: work.baseRevision!,
        sourceRevision: ctx.sourceRevision!,
        ...(ctx.workspaceFingerprint ? { workspaceFingerprint: ctx.workspaceFingerprint } : {}),
        workspaceChangedPaths: [],
        inspectedPaths: reviewEvidence.inspectedPaths,
        findingCount: 0,
        recordedAt,
      },
      'completed_no_change',
      'read_only_review',
    );
    if (completed.planId && completed.planStepId && ctx.planStore) {
      completePlanStepForWork(ctx.planStore, { planId: completed.planId, stepId: completed.planStepId, work: completed });
    }
    return buildFacadeResult({
      status: 'ok',
      summary: `Finalize result: clean read-only review completed with no source change for ${work.workId}.`,
      data: {
        work: summarizeWorkContract(completed),
        finalStatus: 'completed',
        completionOutcome: 'completed_no_change',
        completionReceipt: completed.completionReceipt,
        inspectedPathCount: reviewEvidence.inspectedPaths.length,
        hiddenFailure: false,
      },
      evidenceRefs: completed.evidenceRefs.slice(0, 5),
      suggestedNextActions: [{ label: 'Read controller status', tool: 'rh_status', operation: 'get', risk: 'readonly' }],
    });
  }

  // For a controller-local effect Work, the semantic Controller's explicit
  // finalize call is the terminalization decision, but it is admissible only
  // after durable result evidence exists. Record one canonical Work receipt here
  // instead of routing an effect-only Work through Git delivery. Remote effects
  // remain bound to their durable plugin action receipt in the plugin layer.
  if (work.workKind === 'local_effect' && !work.completionReceipt && completionEvidence.durableResultEvidence) {
    const recordedAt = nowIso(ctx);
    const completed = completeWorkWithReceipt(
      ctx.workStore,
      work.workId,
      {
        schemaVersion: 1,
        receiptId: `LFX-WORK-${randomUUID()}`,
        source: 'local_effect',
        workId: work.workId,
        operation: 'controller_work/local_effect',
        target: { kind: 'controller_local', id: work.workId },
        changed: true,
        recordedAt,
      },
      'completed_local',
      'local_effect',
    );
    if (completed.planId && completed.planStepId && ctx.planStore) {
      completePlanStepForWork(ctx.planStore, { planId: completed.planId, stepId: completed.planStepId, work: completed });
    }
    return buildFacadeResult({
      status: 'ok',
      summary: `Finalize result: succeeded for ${work.workId}.`,
      data: {
        work: summarizeWorkContract(completed),
        finalStatus: 'completed',
        completionReceipt: completed.completionReceipt,
        validPasses: history.validPasses,
        hiddenFailure: false,
      },
      evidenceRefs: completed.evidenceRefs.slice(0, 5),
      suggestedNextActions: [{ label: 'Read controller status', tool: 'rh_status', operation: 'get', risk: 'readonly' }],
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

export interface GoalWorkloopTrustedInput {
  /** Runtime-composed source-bound evidence. This channel is intentionally separate from raw MCP/tool arguments. */
  verifiedEngineeringEvidence?: EngineeringAdmissionEvidence;
}

export function runGoalWorkloop(
  ctx: GoalWorkloopContext,
  operation: GoalWorkloopOperation,
  args: Record<string, unknown>,
  trusted: GoalWorkloopTrustedInput = {},
): FacadeResult {
  switch (operation) {
    case 'start':
      return routeWorkStart(ctx, {
        objective: String(args.objective ?? ''),
        workId: typeof args.work_id === 'string' ? args.work_id : undefined,
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
        verifiedEngineeringEvidence: trusted.verifiedEngineeringEvidence,
        workKind: args.work_kind === 'repository_change'
          || args.work_kind === 'completed_no_change'
          || args.work_kind === 'read_only_review'
          || args.work_kind === 'investigation'
          || args.work_kind === 'local_effect'
          || args.work_kind === 'remote_effect'
          || args.work_kind === 'reconciliation'
          ? args.work_kind
          : undefined,
      });
    case 'continue': {
      let engineeringBlocker: GoalWorkloopContinueInput['engineeringBlocker'];
      if (args.engineering_blocker !== undefined) {
        if (!args.engineering_blocker || typeof args.engineering_blocker !== 'object' || Array.isArray(args.engineering_blocker)) {
          return buildFacadeResult({ status: 'blocked', summary: 'ENGINEERING_BLOCKER_INVALID', data: { workId: String(args.work_id ?? '') } });
        }
        const rawBlocker = args.engineering_blocker as Record<string, unknown>;
        const classification = rawBlocker.classification;
        if (classification !== 'same_root_cause' && classification !== 'unrelated') {
          return buildFacadeResult({ status: 'blocked', summary: 'ENGINEERING_BLOCKER_CLASSIFICATION_INVALID', data: { workId: String(args.work_id ?? '') } });
        }
        engineeringBlocker = {
          blockerId: String(rawBlocker.blocker_id ?? ''),
          classification,
          rationale: String(rawBlocker.rationale ?? ''),
          semanticScopeKeys: Array.isArray(rawBlocker.semantic_scope_keys) ? rawBlocker.semantic_scope_keys.map(String) : undefined,
        };
      }
      return continueGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        note: typeof args.note === 'string' ? args.note : undefined,
        allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
        forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
        checks: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
        additionalLikelyPaths: Array.isArray(args.additional_likely_paths) ? args.additional_likely_paths.map(String) : undefined,
        inspectedPaths: Array.isArray(args.inspected_paths) ? args.inspected_paths.map(String) : undefined,
        reviewFindings: Array.isArray(args.review_findings) ? args.review_findings.map(String) : undefined,
        acceptanceEvidence: Array.isArray(args.acceptance_evidence)
          ? args.acceptance_evidence.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object').map((value) => ({
              criterion: typeof value.criterion === 'string' ? value.criterion : '',
              evidenceIds: Array.isArray(value.evidence_ids) ? value.evidence_ids.map(String) : [],
              rationale: typeof value.rationale === 'string' ? value.rationale : '',
            }))
          : undefined,
        acceptanceFailureDecision: args.acceptance_failure_decision === 'repair' || args.acceptance_failure_decision === 'rescope'
          ? args.acceptance_failure_decision
          : undefined,
        verifiedEngineeringEvidence: trusted.verifiedEngineeringEvidence,
        engineeringBlocker,
      });
    }
    case 'verify':
      return verifyGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        checkId: String(args.check_id ?? args.checkId ?? ''),
        infrastructureFailed: args.infrastructure_failed === true,
        checkFailed: args.check_failed === true,
        skipped: args.skipped === true,
      });
    case 'review': {
      if (args.review_decision !== 'approved' && args.review_decision !== 'changes_required' && args.review_decision !== 'blocked') {
        return buildFacadeResult({
          status: 'blocked',
          summary: 'WORK_IMPLEMENTATION_REVIEW_DECISION_REQUIRED: operation=review requires an explicit approved, changes_required, or blocked decision.',
          data: { workId: String(args.work_id ?? '') },
        });
      }
      return reviewGoalWorkloop(ctx, {
        workId: String(args.work_id ?? ''),
        decision: args.review_decision,
        rationale: typeof args.review_rationale === 'string' ? args.review_rationale : '',
        findings: Array.isArray(args.implementation_review_findings)
          ? args.implementation_review_findings
              .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
              .map((value) => ({
                severity: value.severity === 'critical' || value.severity === 'high' || value.severity === 'medium' || value.severity === 'low' || value.severity === 'info' ? value.severity : 'info',
                category: typeof value.category === 'string' ? value.category : '',
                summary: typeof value.summary === 'string' ? value.summary : '',
                ...(typeof value.path === 'string' ? { path: value.path } : {}),
                ...(typeof value.symbol === 'string' ? { symbol: value.symbol } : {}),
              }))
          : undefined,
      });
    }
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
