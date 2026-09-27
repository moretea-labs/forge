import { createHash, randomUUID } from 'crypto';
import { globMatches } from '../../../cli/mcp/paths';
import {
  createHandoffItem,
  type HandoffInboxStoreOptions,
} from './handoff-inbox-store';
import { executionPlacement, readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import {
  applyEngineeringBlockerDisposition,
  buildEngineeringBlockerDispositionReceipt,
  buildEngineeringContextReceipt,
  engineeringWorkProfileForRisk,
  appendWorkEvidence,
  appendWorkHandoffRef,
  createWorkContract,
  failWorkContract,
  getWorkContract,
  semanticWorkState,
  listWorkContracts,
  readActiveWorkCandidates,
  recordWorkEvidenceState,
  recordWorkScopeEvidence,
  reviseWorkSemanticContext,
  summarizeWorkContract,
  transitionWorkContractPhase,
  updateWorkContract,
  type EngineeringAdmissionEvidence,
  type EvaluationPromotionReceipt,
  type WorkContractStoreOptions,
} from '../../../../packages/kernel/work/api/index';
import {
  getPlanContract,
  currentPlanSemanticRevision,
  type PlanContractStoreOptions,
} from './plan-contract-store';
import { withPrimaryWorkAdmissionLock } from './semantic-admission';
import { effectiveCurrentWorkVerificationRecords, evaluateWorkCompletionEvidence, evaluateWorkImplementationEvidence } from '../execution/work-evidence-policy';
import { hasSettledWorkDeliveryReceipt } from '../execution/work-completion-authority';
import { currentRequirementSemanticRevision, readRequirement } from '../persistence/requirement-store';
import {
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
  FacadeResult,
  PlanContract,
  PolicyDecision,
  SuggestedNextAction,
  WorkContract,
  WorkStartFacts,
  WorkKind,
  WorkRisk,
} from './types';
import { resolveWorkspaceAdmissionConstraint } from '../routing/workspace-admission';

export type GoalWorkloopOperation = 'start' | 'continue' | 'stop';

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
  /** Concrete mechanical request facts. This capability is itself the explicit durable-Work choice. */
  request: WorkStartFacts;
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
    classification: 'same_root_cause' | 'same_root_cause_scope_extension' | 'unrelated';
    rationale: string;
    semanticScopeKeys?: string[];
    /** Required for classification=unrelated: the exact Work that already owns the blocker. */
    linkedWorkId?: string;
  };
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
  if (input.workKind === 'read_only_review') return 'readonly';
  const risk = input.request.risk;
  if (input.request.secretAccess === true || input.request.destructive === true) return 'destructive';
  if (input.request.remoteWrite === true) return 'high';
  if (risk === 'readonly') return 'readonly';
  if (risk === 'destructive' || risk === 'destructive_remote' || risk === 'raw_secret_config') return 'destructive';
  if (risk === 'remote_write') return 'high';
  if (risk === 'local_repo_write') return 'low';
  if (risk === undefined) return 'low';
  return 'medium';
}

function resolvedWorkKindFor(input: GoalWorkloopStartInput): WorkKind {
  if (input.workKind) return input.workKind;
  if (input.request.requiresExternalEffect === true) {
    // Mechanical effect classification only: a remote effect differs from a local
    // effect in receipt identity. Predicted scope size is model strategy and is
    // never consulted; callers declare `work_kind` when a repository change is
    // also involved.
    return input.request.remoteWrite === true ? 'remote_effect' : 'local_effect';
  }
  return 'repository_change';
}

function suggestedForWorkIdentity(workId: string, checks: string[], extras: SuggestedNextAction[] = []): SuggestedNextAction[] {
  const semanticRead: SuggestedNextAction = {
    label: 'Read current Work semantic context',
    tool: 'rh_work',
    operation: 'work_get',
    payload: { work_id: workId },
    risk: 'readonly',
    confidence: 'high',
  };
  // Suggested actions expose facts/capabilities only. The model decides whether
  // implementation, checks, review, delivery, or semantic completion is next.
  return validateSuggestedNextActions([...extras, semanticRead], {
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
    && semanticWorkState(relatedLifecycleSource) !== 'open',
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
  // A read-only review is an explicit `work_kind`, or an explicit source-mutation
  // fence that proves no repository path may change. Forge never infers it from
  // caller hints about investigation depth or recovery needs.
  const typedReadOnlyReviewRequested = requestedWorkKind === undefined && explicitSourceMutationFence;
  const effectiveWorkKind = requestedWorkKind ?? (typedReadOnlyReviewRequested ? 'read_only_review' : undefined);
  const readOnlyReviewRequested = effectiveWorkKind === 'read_only_review';
  const readOnlyMutationConflict = readOnlyReviewRequested && (
    input.request.mutation === true
    || input.request.requiresExternalEffect === true
    || input.request.remoteWrite === true
    || input.request.destructive === true
  );
  if (readOnlyMutationConflict) {
    return buildFacadeResult({
      status: 'blocked',
      summary: 'READ_ONLY_REVIEW_MUTATION_CONFLICT: read_only_review cannot request repository mutation, external effects, remote writes, or destructive execution.',
      data: { executionStarted: false, workContractCreated: false, workKind: effectiveWorkKind },
    });
  }
  // A terminal continuation is not a new semantic request. Its durable predecessor
  // and Plan lineage already define the goal scope, while the successor Plan step
  // becomes the Work objective later in startGoalWorkloop.
  const routeObjective = input.objective.trim()
    || (input.workRelation === 'continue' && relatedLifecycleSource && semanticWorkState(relatedLifecycleSource) === 'completed'
      ? relatedLifecycleSource.objective.trim()
      : '');
  const effectiveRequest: WorkStartFacts = {
    ...input.request,
    objective: routeObjective,
    workspaceDirty: ctx.workspaceDirty ?? input.request.workspaceDirty,
    mutation: readOnlyReviewRequested ? false : input.request.mutation ?? input.request.risk !== 'readonly',
    risk: readOnlyReviewRequested ? 'readonly' : input.request.risk,
    approvalConfirmed: input.approvalConfirmed === true,
    requiresUserApproval: input.approvalConfirmed === true
      ? false
      : input.request.requiresUserApproval === true || strategyConflictRequiresApproval,
  };
  const evaluateAccessPolicy = () => evaluatePolicyGate({
    capabilityId: 'controller.work_contract',
    risk: effectiveRequest.risk
      ?? (input.request.secretAccess === true ? 'raw_secret_config'
        : input.request.destructive === true ? 'destructive'
          : input.request.remoteWrite === true ? 'remote_write'
            : input.request.requiresApproval === true || input.request.requiresUserApproval === true ? 'workspace_write'
              : 'workspace_write'),
    accessMode: input.constraints?.accessMode,
    approvalConfirmed: input.approvalConfirmed === true,
    dryRun: input.dryRun === true,
  });
  // Missing mechanical admission fields are reported to the caller verbatim.
  // Forge does not translate them into an engineering-mode recommendation.
  const missingContractFields: string[] = [];
  if (!input.request.scopeClear) missingContractFields.push('scopeSummary', 'acceptanceCriteria', 'allowedPaths');
  if (input.objective.trim().length === 0) missingContractFields.push('objective');

  const policy = evaluateAccessPolicy();
  const approvalRequired = policy.decision === 'approval_required';

  // Policy approval decisions stop before Work creation. Ordinary host-managed
  // local work reaches this point only after the Access Policy authorized it.
  const blockForHandoff =
    policy.decision === 'denied'
    || policy.decision === 'approval_required';

  if (blockForHandoff) {
    const handoff = createHandoffItem(ctx.handoffStore, {
      id: handoffIdFor('route'),
      repoId: ctx.repoId,
      title: 'Work blocked pending decision',
      severity: policy.decision === 'denied' ? 'blocked' : 'needs_review',
      creationReason: !input.request.scopeClear
        ? 'invalid_objective'
        : approvalRequired
          ? (input.request.destructive ? 'destructive_action_requires_confirmation' : 'policy_approval_required')
          : 'missing_authorization',
      reason: policy.reason,
      summary: `Execution blocked by access policy: ${policy.reason}`,
      currentState: {
        repoId: ctx.repoId,
        statusSummary: 'waiting for ChatGPT or user decision; no execution started',
        blockedBy: missingContractFields,
      },
      attemptedActions: ['work_start'],
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
            risk: input.request.destructive ? 'destructive' : 'workspace_write',
            payload: {
              objective: input.objective,
              acceptanceCriteria: input.acceptanceCriteria,
              allowedPaths: input.allowedPaths,
              forbiddenPaths: input.forbiddenPaths,
              checkIds: input.checks,
              scopeClear: input.request.scopeClear,
              requiresApproval: input.request.requiresApproval === true || input.request.requiresUserApproval === true,
              destructive: input.request.destructive === true,
              accessMode: input.constraints?.accessMode,
              workspaceMode: placementConstraint.workspaceMode,
              requireWorktree: placementConstraint.requireWorktree,
              directMainProhibited: placementConstraint.directMainProhibited,
              approvalConfirmed: true,
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
      summary: 'Blocked: no WorkContract created and no execution started until the policy decision is resolved.',
      data: {
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
    request: effectiveRequest,
    workKind: effectiveWorkKind,
  }, policy);
}

export function startGoalWorkloop(
  ctx: GoalWorkloopContext,
  input: GoalWorkloopStartInput,
  policy?: PolicyDecision,
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
    ));
  }
  const at = nowIso(ctx);
  let resolvedWorkKind: WorkKind;
  try {
    resolvedWorkKind = resolvedWorkKindFor(input);
  } catch (error) {
    return buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'WORK_KIND_RESOLUTION_INVALID',
      data: { executionStarted: false, workContractCreated: false },
      rawAvailable: false,
    });
  }
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
    && (input.request.mutation ?? input.request.risk !== 'readonly');
  // Engineering context is durable model/project guidance only. Safety and
  // capability admission is enforced by the concrete executor, never here.
  void engineeringMutation;
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
  const terminalContinuationSource = input.workRelation === 'continue'
    && relatedLifecycleSource
    && semanticWorkState(relatedLifecycleSource) !== 'open'
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
  const resolvedPlanStepId = input.planStepId?.trim() || undefined;
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
  // Plan and Plan item references are recorded provenance for this Work. They
  // never select the successor, own the scope, gate admission or require
  // acceptance; only the Plan's existence is validated so a Work cannot record a
  // reference to a Plan authority that does not exist.
  const plan = resolvedPlanId && ctx.planStore ? getPlanContract(ctx.planStore, resolvedPlanId) : undefined;
  if (resolvedPlanId && !plan) {
    return buildFacadeResult({
      status: 'blocked',
      summary: terminalContinuationSource?.planId
        ? `WORK_SUCCESSOR_PLAN_NOT_FOUND: ${terminalContinuationSource.planId}. Recover the durable Plan authority before creating a successor Work.`
        : `PLAN_NOT_FOUND: ${resolvedPlanId}. Recover or create the semantic Plan before using it as Work provenance.`,
      data: {
        executionStarted: false,
        workContractCreated: false,
        planId: resolvedPlanId,
        ...(terminalContinuationSource?.planId ? { predecessorWorkId: terminalContinuationSource.workId } : {}),
      },
    });
  }
  const requestedRequirementId = input.requirementId?.trim() || undefined;
  const predecessorRequirementId = terminalContinuationSource?.requirementId;
  if (predecessorRequirementId && requestedRequirementId && predecessorRequirementId !== requestedRequirementId) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_SUCCESSOR_REQUIREMENT_MISMATCH: predecessor ${terminalContinuationSource.workId} belongs to ${predecessorRequirementId}, not ${requestedRequirementId}.`,
      data: { executionStarted: false, workContractCreated: false, predecessorWorkId: terminalContinuationSource.workId, predecessorRequirementId, requestedRequirementId },
    });
  }
  // The Plan's Requirement tag is provenance metadata, not admission authority:
  // the caller's explicit Requirement (or the predecessor's) decides the Work.
  const effectiveRequirementId = requestedRequirementId || predecessorRequirementId;
  const effectiveRequirementRecord = effectiveRequirementId && ctx.workStore.controllerHome ? readRequirement({ controllerHome: ctx.workStore.controllerHome }, effectiveRequirementId) : undefined;
  if (
    effectiveRequirementId
    && ctx.workStore.controllerHome
    && !effectiveRequirementRecord
  ) {
    return buildFacadeResult({
      status: 'blocked',
      summary: `${plan ? 'PLAN' : 'WORK'}_REQUIREMENT_NOT_FOUND: ${effectiveRequirementId}. Create or reconcile the Requirement authority before admitting Work.`,
      data: { executionStarted: false, workContractCreated: false, requirementId: effectiveRequirementId, planId: plan?.planId },
    });
  }
  // Work scope is authored by the caller. A referenced Plan item contributes no
  // objective, paths, checks or acceptance criteria.
  const effectiveObjective = input.objective;
  const effectiveAcceptanceCriteria = input.acceptanceCriteria ?? [];
  const effectiveAllowedPaths = input.allowedPaths ?? [];
  const effectiveForbiddenPaths = input.forbiddenPaths ?? [];
  const effectiveChecks = input.checks ?? [];
  const normalized = normalizeCheckIds(effectiveChecks, available);
  const invalidLineageWork = activeAdmissionSnapshot.invalid.find((candidate) =>
    (input.relatedWorkId && candidate.workId === input.relatedWorkId));
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
    || input.workRelation === 'parallel';
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
  // Requirement membership is portfolio ownership, not semantic Work identity.
  // Only an explicit related Work may select an existing Work authority. A Plan
  // item never selects, owns or reuses Work. Siblings under one Requirement
  // remain unrelated for semantic admission and meet only in
  // placement/resource arbitration.
  const deterministicTarget = input.relatedWorkId ? explicitRelatedWork : undefined;
  const requestedRelation = input.workRelation;
  // Only strong semantic bindings participate in ownership resolution. An
  // unrelated active Work or a checkout writer is a placement fact, not a
  // semantic candidate for continue/extend/parallel/new_goal.
  const candidateWorks = [...new Map(
    [explicitRelatedWork]
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
          label: 'Inspect existing Work',
          tool: 'rh_work',
          operation: 'work_get',
          payload: { work_id: target.workId },
          risk: 'readonly',
          confidence: explicitRelatedWork ? 'high' : 'medium',
          reason: 'Resolve intent before execution; semantic Work inspection does not progress lifecycle state.',
        }]
      : [],
    rawAvailable: false,
  });

  if ((input.requestedBy ?? 'chatgpt') === 'scheduler') {
    return resolutionRequired(
      deterministicTarget
        ? `SCHEDULER_CONTINUATION_REQUIRED: scheduler-triggered execution must continue its bound Work ${deterministicTarget.workId}; it must not create a new durable Work.`
        : 'SCHEDULER_WORK_BINDING_REQUIRED: scheduler-triggered execution must bind and wake an existing durable Work; it must not invent a new Work from a prompt.',
    );
  }

  if ((requestedRelation === 'continue' || requestedRelation === 'extend') && !terminalContinuationSource) {
    if (!deterministicTarget) {
      return resolutionRequired(`${requestedRelation.toUpperCase()}_TARGET_REQUIRED: select related_work_id before execution.`);
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
      suggestedNextActions: [{ label: 'Read existing Work context', tool: 'rh_work', operation: 'work_get', payload: { work_id: selected.workId }, risk: 'readonly', confidence: 'high' }],
      rawAvailable: false,
    });
  }

  if (!requestedRelation && candidateWorks.length > 0) {
    return resolutionRequired(
      `WORK_ADMISSION_RESOLUTION_REQUIRED: ${candidateWorks.length} active Work candidate(s) exist. Classify this request as continue, extend, parallel, or new_goal before any durable Work is created.`,
    );
  }

  // Pure remote effects do not participate in repository workspace ownership.
  // Semantic WorkContract state is also not workspace-writer authority: an open Work
  // may be waiting, reviewing, or otherwise quiescent. Concrete mutation ownership is
  // fenced later by WorkHandle/Process Lease authority at the mutation boundary.
  // Admission isolates only for explicit placement, incompatible dirty paths, or an
  // explicitly parallel Work relation.
  const repositoryWorkspaceParticipant = resolvedWorkKind !== 'remote_effect';
  const trustedDirtyPaths = ctx.workspaceChangedPaths
    ? [...new Set(ctx.workspaceChangedPaths.map((path) => path.trim()).filter(Boolean))].sort()
    : undefined;
  const dirtyWorkspaceOwnershipConflict = repositoryWorkspaceParticipant
    && input.request.workspaceDirty === true
    && (
      !trustedDirtyPaths
      || trustedDirtyPaths.length === 0
      || effectiveAllowedPaths.length === 0
      || trustedDirtyPaths.some((path) => (
        effectiveForbiddenPaths.some((pattern) => globMatches(pattern, path))
        || !effectiveAllowedPaths.some((pattern) => globMatches(pattern, path))
      ))
    );
  const automaticRepositoryIsolation = repositoryWorkspaceParticipant && (
    dirtyWorkspaceOwnershipConflict
    || requestedRelation === 'parallel'
  );
  const needsWorktree = placementConstraint.requireWorktree
    || automaticRepositoryIsolation;
  const requestedWorkId = input.workId?.trim();
  if (requestedWorkId && !/^work-[a-z0-9][a-z0-9-]{0,199}$/i.test(requestedWorkId)) {
    return buildFacadeResult({
      status: 'blocked',
      summary: 'WORK_ID_INVALID: explicit Work ids must use the canonical work-<slug> form.',
      data: { executionStarted: false, workContractCreated: false },
    });
  }
  const generatedWorkId = requestedWorkId ?? workIdFor(effectiveObjective);
  const initialSuggestedNextActions = suggestedForWorkIdentity(
    generatedWorkId,
    normalized.validCheckIds,
    normalized.suggestedNextActions,
  );
  const remoteDeliveryRequired = resolvedWorkKind === 'repository_change'
    && input.request.requiresExternalEffect === true
    && input.request.remoteWrite === true;
  const effectiveConstraints: WorkContract['constraints'] = {
    ...canonicalConstraints,
    ...(needsWorktree ? { workspaceMode: 'isolated' as const, requireWorktree: true } : {}),
    ...(remoteDeliveryRequired ? { remoteDeliveryRequired: true } : {}),
  };
  const worktreeReason = placementConstraint.requireWorktree
    ? 'Typed workspace placement requires isolated execution.'
    : dirtyWorkspaceOwnershipConflict
      ? 'Trusted repository observation found dirty paths outside or ambiguous to the Work path fence; isolated placement prevents unrelated changes from entering Work ownership or verification.'
      : requestedRelation === 'parallel'
        ? 'Explicit parallel Work relation requires isolated placement.'
        : 'Current workspace is the stability-first default; isolation remains opt-in.';
  const forgeInstanceId = ctx.workStore.controllerHome
    ? readForgeInstanceIdentity(ctx.workStore.controllerHome)?.instanceId
    : undefined;
  const work = createWorkContract(ctx.workStore, {
    workId: generatedWorkId,
    repoId: ctx.repoId,
    checkoutId: needsWorktree ? undefined : ctx.checkoutId,
    executionPlacement: executionPlacement({
      ...(forgeInstanceId ? { forgeInstanceId } : {}),
      repositoryId: ctx.repoId,
      ...(!needsWorktree && ctx.checkoutId ? { checkoutId: ctx.checkoutId } : {}),
    }),
    principalId: ctx.principalId,
    controllerInstanceId: ctx.controllerInstanceId,
    baseRevision: ctx.sourceRevision,
    repositoryBaseState: ctx.sourceBaseState ?? (ctx.sourceRevision ? 'revision' : undefined),
    workspaceFingerprint: needsWorktree ? undefined : ctx.workspaceFingerprint,
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
    requirementRevision: effectiveRequirementRecord ? currentRequirementSemanticRevision(effectiveRequirementRecord.value) : undefined,
    predecessorWorkId: terminalContinuationSource?.workId,
    planId: resolvedPlanId,
    planRevision: plan ? currentPlanSemanticRevision(plan) : undefined,
    planStepId: resolvedPlanStepId,
    planSourceRevision: resolvedPlanStepId ? plan?.sourceRevision : undefined,
    scopeSummary: input.request.scopeClear ? 'scope declared at start' : 'scope incomplete',
    scopeEvidence: {
      initialLikelyPaths: [...new Set(input.initialLikelyPaths ?? effectiveAllowedPaths)].slice(0, 100),
      inspectedPaths: [],
      actualChangedPaths: [],
      recordedAt: at,
    },
    allowedPaths: effectiveAllowedPaths,
    forbiddenPaths: effectiveForbiddenPaths,
    checks: normalized.validCheckIds,
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
      required: input.request.requiresApproval === true || input.request.requiresUserApproval === true,
      reasons: input.request.requiresApproval || input.request.requiresUserApproval ? ['approval requested at start'] : [],
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

  return buildFacadeResult({
    status: 'ok',
    summary: terminalContinuationSource
      ? `Successor Work ${work.workId} continues semantic lineage from terminal ${terminalContinuationSource.workId}${resolvedPlanId && resolvedPlanStepId ? ` at ${resolvedPlanId}/${resolvedPlanStepId}` : ''}.`
      : `Work started as ${work.workId}.`,
    data: {
      // Caller-visible placement facts only. Execution mode tokens, route reasons
      // and RouteDecision are legacy orchestration metadata, not Work semantics.
      placement: {
        workContractCreated: true,
        worktreeRequired: work.worktreePolicy.required,
        isolated: work.worktreePolicy.required,
        requiresRecovery: work.recoveryPolicy.allowSelfHealing === true || false,
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

  if (semanticWorkState(work) !== 'open') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WorkContract ${work.workId} is terminal (${semanticWorkState(work)}); continue is not allowed.`,
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

  if (semanticWorkState(work) === 'open' && hasSettledWorkDeliveryReceipt(work)) {
    return buildFacadeResult({
      status: 'ok',
      summary: `Continue: physical delivery is settled for ${work.workId}; semantic Work remains open for explicit Controller judgment.`,
      data: {
        work: summarizeWorkContract(work),
        backgroundCompleted: false,
        nextStep: 'semantic_decision',
        deliverySettled: true,
        semanticWorkState: 'open',
      },
      evidenceRefs: work.evidenceRefs.slice(0, 5),
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
        // Forge does not decompose work on the model's behalf. An unrelated blocker
        // must name the Work that already owns it; the caller creates that Work
        // explicitly (rh_work start) and passes its exact id here.
        const declaredLinkedWorkId = input.engineeringBlocker.linkedWorkId?.trim();
        if (!declaredLinkedWorkId) {
          return buildFacadeResult({
            status: 'blocked',
            summary: 'ENGINEERING_BLOCKER_LINKED_WORK_REQUIRED: an unrelated blocker must name the Work that owns it via linked_work_id; Forge never creates a child Work automatically.',
            data: { work: summarizeWorkContract(work), linkedWorkCreated: false },
            suggestedNextActions: [{
              label: 'Start the owning Work explicitly',
              tool: 'rh_work',
              operation: 'start',
              payload: { objective: `Resolve unrelated blocker ${input.engineeringBlocker.blockerId}: ${input.engineeringBlocker.rationale}` },
              risk: 'readonly',
              confidence: 'medium',
            }],
          });
        }
        linkedWork = getWorkContract(ctx.workStore, declaredLinkedWorkId);
        if (!linkedWork) {
          return buildFacadeResult({
            status: 'blocked',
            summary: `ENGINEERING_BLOCKER_LINKED_WORK_UNKNOWN: ${declaredLinkedWorkId} is not a readable Work.`,
            data: { work: summarizeWorkContract(work), linkedWorkId: declaredLinkedWorkId, linkedWorkCreated: false },
          });
        }
        linkedWorkId = linkedWork.workId;
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
    if (blocker.action === 'extend_candidate') {
      work = appendWorkEvidence(ctx.workStore, work.workId, {
        title: 'same-root candidate scope extension',
        summary: `Blocker ${blocker.blockerId} remains inside the current architecture authority; continue the exact candidate without Design re-entry or sibling Work.`,
        detailLevel: 'summary',
      });
    } else {
      work = appendWorkEvidence(ctx.workStore, work.workId, {
        title: 'engineering blocker observation',
        summary: `Recorded ${blocker.classification} blocker ${blocker.blockerId}; it is model guidance, not a Work continuation gate.`,
        detailLevel: 'summary',
      });
    }
  }

  if ((input.reviewFindings?.length ?? 0) > 0 && work.workKind !== 'read_only_review') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `READ_ONLY_REVIEW_FINDINGS_KIND_REQUIRED: ${work.workId} is ${work.workKind}, not read_only_review.`,
      data: { work: summarizeWorkContract(work), reviewFindingsRecorded: false },
    });
  }
  const explicitPolicyScope = input.allowedPaths !== undefined
    || input.forbiddenPaths !== undefined
    || input.checks !== undefined;
  if (explicitPolicyScope) {
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

  const currentCheckRefs = effectiveCurrentWorkVerificationRecords(
    work,
    ctx.sourceRevision,
    ctx.workspaceFingerprint,
  );
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

  // Acceptance failure is a model/controller decision point, not a human blocker.
  // Do not manufacture Handoff/UserRequest state for repair vs re-scope.
  if (history.acceptanceFailures.length > 0 && !explicitAcceptanceRepair) {
    const failureReason = `Acceptance checks failed: ${history.acceptanceFailures.join(', ')}`;
    return buildFacadeResult({
      status: 'blocked',
      summary: `${failureReason}. The model must explicitly choose bounded repair or re-scope before continuing; no human Handoff was created.`,
      data: {
        work: summarizeWorkContract(work),
        acceptanceFailures: history.acceptanceFailures,
        infrastructureIssues: history.infrastructureIssues,
        backgroundCompleted: false,
        acceptanceFailureDecisionRequired: true,
      },
      evidenceRefs: work.evidenceRefs.slice(0, 5),
      suggestedNextActions: [{
        label: 'Inspect Work before repair or re-scope',
        tool: 'rh_context',
        operation: 'get',
        payload: { work_id: work.workId },
        risk: 'readonly',
        confidence: 'high',
        reason: 'Acceptance evidence is factual input; the model chooses the next capability without a Work lifecycle transition.',
      }],
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
    const suggested = validateSuggestedNextActions([{
      label: 'Inspect Work and check evidence',
      tool: 'rh_context',
      operation: 'get',
      payload: { work_id: work.workId },
      risk: 'readonly',
      confidence: 'high',
      reason: 'Registered checks are independent execution evidence; they do not progress Work lifecycle state.',
    }]).actions;
    const updated = updateWorkContract(ctx.workStore, work.workId, {
      suggestedNextActions: suggested,
      continuationPrompt: input.note
        ? `${work.continuationPrompt ?? ''}\nNote: ${input.note}`.slice(0, 2_000)
        : work.continuationPrompt,
    });
    return buildFacadeResult({
      status: 'ok',
      summary: `Registered check evidence is still missing for: ${remaining.join(', ')}. Run checks through the check capability; Work semantic state is unchanged.`,
      data: {
        work: summarizeWorkContract(updated),
        remainingChecks: remaining,
        backgroundCompleted: false,
        nextStep: 'run_check',
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

  // Completion evidence is observational. It cannot choose a review/finalize
  // transition or tell the model which capability to invoke next.
  const updated = updateWorkContract(ctx.workStore, work.workId, { suggestedNextActions: [] });
  return buildFacadeResult({ status: 'ok', summary: 'Continue: current Work evidence recorded.', data: { work: summarizeWorkContract(updated), backgroundCompleted: false }, suggestedNextActions: [] });
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
  if (semanticWorkState(work) === 'completed') {
    return buildFacadeResult({
      status: 'blocked',
      summary: `WORK_CANCEL_COMPLETED: ${work.workId}`,
      data: { work: summarizeWorkContract(work) },
    });
  }
  const semanticRevision = Number.isInteger(work.semanticRevision) && Number(work.semanticRevision) > 0
    ? Number(work.semanticRevision)
    : 1;
  const updated = reviseWorkSemanticContext(ctx.workStore, work.workId, {
    expectedRevision: semanticRevision,
    state: 'cancelled',
    resultRefs: work.evidenceRefs
      .flatMap((evidence) => [evidence.evidenceId, evidence.artifactId])
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  });
  const planId = updated.planId;
  const planStepId = updated.planStepId;
  let plan = planId && ctx.planStore
    ? getPlanContract(ctx.planStore, planId)
    : undefined;

  return buildFacadeResult({
    status: 'ok',
    summary: `WorkContract ${work.workId} cancelled/stopped. Evidence retained. Managed resource cleanup/retention is settled by the canonical Work finalization service.`,
    data: {
      work: summarizeWorkContract(updated),
      finalStatus: 'cancelled',
      evidenceRetained: true,
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
  /**
   * Evaluator-minted evidence for one exact candidate. Kept off the raw MCP
   * argument surface so callers cannot manufacture architecture evidence.
   */
  evaluationPromotionReceipt?: EvaluationPromotionReceipt;
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
        request: {
          objective: typeof args.objective === 'string' ? args.objective : undefined,
          scopeClear: args.scope_clear === undefined ? true : args.scope_clear === true,
          requiresRecovery: args.requires_recovery === true,
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
        if (classification !== 'same_root_cause' && classification !== 'same_root_cause_scope_extension' && classification !== 'unrelated') {
          return buildFacadeResult({ status: 'blocked', summary: 'ENGINEERING_BLOCKER_CLASSIFICATION_INVALID', data: { workId: String(args.work_id ?? '') } });
        }
        engineeringBlocker = {
          blockerId: String(rawBlocker.blocker_id ?? ''),
          classification,
          rationale: String(rawBlocker.rationale ?? ''),
          semanticScopeKeys: Array.isArray(rawBlocker.semantic_scope_keys) ? rawBlocker.semantic_scope_keys.map(String) : undefined,
          linkedWorkId: typeof rawBlocker.linked_work_id === 'string' ? rawBlocker.linked_work_id : undefined,
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
