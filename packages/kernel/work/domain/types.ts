import type { ExecutionPlacement, ScopeRef } from '../../identity/api/index';
import type { ProcessCheckReceiptEvidence } from './check-receipt';
import type { WorkAccessMode, WorkRouteDecisionSnapshot } from './execution-snapshot';
import type { RepositoryCompletionReceipt } from './repository-completion-receipt';
import type { WorkImplementationReviewRecord } from './implementation-review';
import type { EngineeringContextReceipt } from './engineering-contracts';

/** Work-persisted orchestration metadata is Kernel-owned; facade is a consumer. */
export type ExecutionMode = 'direct_control' | 'goal_workloop' | 'handoff_only';
export type FacadeDetailLevel = 'summary' | 'detail' | 'raw';
export interface EvidenceRef {
  evidenceId?: string;
  artifactId?: string;
  title: string;
  summary?: string;
  detailLevel?: FacadeDetailLevel;
}
export interface SuggestedNextAction {
  label: string;
  tool: 'rh_access' | 'rh_status' | 'rh_inbox' | 'rh_context' | 'rh_work';
  operation: string;
  payload?: Record<string, unknown>;
  risk: 'readonly' | 'local_repo_write' | 'workspace_write' | 'remote_write' | 'destructive_remote' | 'destructive' | 'raw_secret_config' | 'unknown';
  confidence?: 'low' | 'medium' | 'high';
  reason?: string;
  fallback?: string;
}
export interface PolicyDecision {
  decision: 'allowed' | 'approval_required' | 'denied' | 'dry_run_only';
  reason: string;
  capabilityId?: string;
  approvalRequestId?: string;
  requiredConfirmationText?: string;
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
}

/** Canonical Kernel Work domain contracts. */
export const WORK_CONTRACT_STATUSES = [
  'open',
  'running',
  'blocked',
  'ready',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkContractStatus = (typeof WORK_CONTRACT_STATUSES)[number];

/**
 * Work execution phases are intentionally small and technical. User-facing
 * Requirement lifecycle belongs to Requirement, not this projection.
 */
export const WORK_PHASES = ['implementation', 'verification', 'review', 'delivery', 'cleanup'] as const;
export type WorkPhase = (typeof WORK_PHASES)[number];

export const WORK_PHASE_EVIDENCE_STATES = ['pending', 'active', 'satisfied', 'blocked', 'failed', 'skipped'] as const;
export type WorkPhaseEvidenceState = (typeof WORK_PHASE_EVIDENCE_STATES)[number];

/** Durable evidence checkpoint for one technical Work phase. */
export interface WorkPhaseEvidence {
  state: WorkPhaseEvidenceState;
  source?: 'recorded' | 'legacy_inferred';
  summary: string;
  evidenceRefs: EvidenceRef[];
  recordedAt: string;
  receiptId?: string;
}

export type WorkPhaseEvidenceMap = Record<WorkPhase, WorkPhaseEvidence>;

/** Risk is part of the Work contract, never of a mutable Task projection. */
export const WORK_RISKS = ['readonly', 'low', 'medium', 'high', 'destructive'] as const;
export type WorkRisk = (typeof WORK_RISKS)[number];

export const TERMINAL_WORK_CONTRACT_STATUSES: readonly WorkContractStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

/** Independent semantic axes; `status` remains a compatibility projection. */
export const WORK_KINDS = [
  'repository_change',
  'completed_no_change',
  'read_only_review',
  'investigation',
  'local_effect',
  'remote_effect',
  'reconciliation',
  'superseded',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const DISPATCH_STATES = ['not_dispatched', 'claimed', 'launching', 'running', 'blocked', 'terminal'] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const EVIDENCE_STATES = ['none', 'partial', 'valid', 'stale', 'contradictory', 'failed'] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const COMPLETION_OUTCOMES = ['completed_changed', 'completed_no_change', 'completed_local', 'completed_remote', 'superseded'] as const;
export type CompletionOutcome = (typeof COMPLETION_OUTCOMES)[number];

/** Source-bound semantic evidence accumulated by a recoverable read-only review. */
export interface ReadOnlyReviewEvidence {
  sourceRevision: string;
  workspaceFingerprint?: string;
  inspectedPaths: string[];
  findings: string[];
  recordedAt: string;
}

/** Controller-reviewed binding from one exact Work acceptance criterion to durable evidence. */
export interface WorkSemanticAcceptanceEvidence {
  criterion: string;
  evidenceIds: string[];
  rationale: string;
  recordedAt: string;
}

/**
 * Terminal authority for a clean read-only review. This deliberately does not
 * impersonate repository delivery: it proves the reviewed source stayed at the
 * frozen base revision with no workspace delta and records the bounded review
 * scope that justified completed_no_change.
 */
export interface ReadOnlyReviewCompletionReceipt {
  schemaVersion: 1;
  receiptId: string;
  source: 'read_only_review';
  workId: string;
  baseRevision: string;
  sourceRevision: string;
  workspaceFingerprint?: string;
  /** Explicit unchanged-workspace proof captured by the trusted finalizer. Must be empty. */
  workspaceChangedPaths: string[];
  inspectedPaths: string[];
  findingCount: 0;
  recordedAt: string;
}

/**
 * Terminal receipt for a bounded Controller-local side effect that is not a
 * repository delivery. Repository Task/Issue completion keeps using the
 * historical Git-oriented CompletionReceipt unchanged.
 */
export interface LocalEffectCompletionReceipt {
  schemaVersion: 1;
  receiptId: string;
  source: 'local_effect';
  workId: string;
  operation: string;
  target: {
    kind: 'workspace_target' | 'controller_local';
    id: string;
    identityFingerprint?: string;
  };
  changed: boolean;
  recordedAt: string;
}

/** Durable completion authority for one typed remote effect. */
export interface RemoteEffectCompletionReceipt {
  schemaVersion: 1;
  /** Plugin receipts retain their PLG-* id; repository Process effects use their canonical Process id. */
  receiptId: string;
  source: 'remote_effect';
  workId: string;
  /** Historical receipts omit this field and are interpreted as plugin_action. */
  authority?: 'plugin_action' | 'repository_process';
  pluginId?: string;
  actionId: string;
  requestId: string;
  semanticKey: string;
  resultDigest: string;
  processId?: string;
  recordedAt: string;
}

/**
 * Completion authority for a standalone Direct Edit that is not bound to the
 * retired Issue/Task completion model. Normal completion proves one finalized
 * edit session at an exact reachable Git revision. Historical completion may
 * instead reference one explicit reviewed reconciliation after exact revision,
 * path-scope, verification, reachability, and cleanup proof checks.
 */
export interface DirectEditWorkCompletionReceipt {
  schemaVersion: 1;
  receiptId: string;
  source: 'direct_edit_work';
  workId: string;
  editSessionId?: string;
  reconciliationId?: string;
  targetBranch: string;
  targetRevision: string;
  sourceRevision?: string;
  baseRevision?: string;
  changedPaths: string[];
  delivery: RepositoryCompletionReceipt['delivery'];
  cleanup: RepositoryCompletionReceipt['cleanup'];
  verifiedAt: string;
  recordedAt: string;
}

export type WorkCompletionReceipt = RepositoryCompletionReceipt | DirectEditWorkCompletionReceipt | ReadOnlyReviewCompletionReceipt | LocalEffectCompletionReceipt | RemoteEffectCompletionReceipt;

export function isRepositoryCompletionReceipt(
  receipt: WorkCompletionReceipt,
): receipt is RepositoryCompletionReceipt {
  return receipt.source !== 'local_effect'
    && receipt.source !== 'remote_effect'
    && receipt.source !== 'direct_edit_work'
    && receipt.source !== 'read_only_review';
}

export function isReadOnlyReviewCompletionReceipt(
  receipt: WorkCompletionReceipt,
): receipt is ReadOnlyReviewCompletionReceipt {
  return receipt.source === 'read_only_review';
}

export function isRemoteEffectCompletionReceipt(
  receipt: WorkCompletionReceipt,
): receipt is RemoteEffectCompletionReceipt {
  return receipt.source === 'remote_effect';
}

export function isDirectEditWorkCompletionReceipt(
  receipt: WorkCompletionReceipt,
): receipt is DirectEditWorkCompletionReceipt {
  return receipt.source === 'direct_edit_work';
}

/** A reviewed exception for historical/manual integration; never inferred automatically. */
export const WORK_RECONCILIATION_METHODS = ['exact_commit', 'owned_path_tree', 'reviewed_patch_identity'] as const;
export type WorkReconciliationMethod = (typeof WORK_RECONCILIATION_METHODS)[number];

export const WORK_RECONCILIATION_OUTCOMES = ['accepted_equivalence', 'rejected_equivalence', 'superseded'] as const;
export type WorkReconciliationOutcome = (typeof WORK_RECONCILIATION_OUTCOMES)[number];

export const VERIFICATION_OUTCOMES = [
  'valid_pass',
  'valid_fail',
  'invalid_check_id',
  'infrastructure_failure',
  'skipped',
  'superseded',
] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface WorkContractConstraints {
  maxChangedFiles?: number;
  maxChangedLines?: number;
  allowCommit?: boolean;
  allowMerge?: boolean;
  allowCleanup?: boolean;
  allowDestructive?: boolean;
  requireHandoffOnAmbiguity?: boolean;
  /** Immutable execution-policy snapshot captured when work starts. */
  accessMode?: WorkAccessMode;
  /** current is the stability-first default; isolated is opt-in or used for explicit parallelism. */
  workspaceMode?: 'current' | 'isolated' | 'auto';
  requireWorktree?: boolean;
  /** Admission fence: repository mutation must not use the Direct Control/current-main lane. */
  directMainProhibited?: boolean;
  /** True when a change alters the agreed architecture direction rather than only implementation details. */
  architectureStrategyChange?: boolean;
  /** True when the proposed change weakens the thin-harness / high-performance execution policy. */
  conflictsWithThinHarnessPolicy?: boolean;
  /** True when the change alters the default routing or execution mode visible to users. */
  changesDefaultExecutionStrategy?: boolean;
  /** Repository-change delivery must publish the exact integrated revision before Work terminalization. */
  remoteDeliveryRequired?: boolean;
}

export interface WorkContractDriverPolicy {
  preferred: 'direct_edit' | 'isolated_worktree' | 'external_controller' | 'handoff_only';
  allowWorker: boolean;
  allowDirectEdit: boolean;
}

export interface WorktreePolicy {
  required: boolean;
  reason?: string;
  ref?: string;
}

export interface EvidencePolicy {
  defaultDetailLevel: FacadeDetailLevel;
  allowRawOptIn: boolean;
  maxEvidenceRefs: number;
}

export interface ApprovalPolicy {
  required: boolean;
  reasons: string[];
  confirmed: boolean;
}

export interface RecoveryPolicy {
  allowSelfHealing: boolean;
  maxInfrastructureRetries: number;
  handoffOnAmbiguity: boolean;
}

export interface VerificationRecord {
  checkId: string;
  outcome: VerificationOutcome;
  summary: string;
  recordedAt: string;
  /** Exact checked revision. Absence denotes legacy/non-authoritative evidence. */
  sourceRevision?: string;
  /** Exact dirty-workspace content identity observed by the check. */
  workspaceFingerprint?: string;
  /** Hash of the check inputs that must match before this result can be reused. */
  verificationInputFingerprint?: string;
  /** Bounded identity of the command/configuration that produced the result. */
  commandFingerprint?: string;
  resultArtifactId?: string;
  startedAt?: string;
  completedAt?: string;
  supersedes?: string;
  staleReason?: string;
  evidenceRef?: EvidenceRef;
  receipt?: ProcessCheckReceiptEvidence;
}

/**
 * Durable human-reviewed reconciliation for a Work whose original finalization
 * facts cannot be recovered. It records an exception; it is not completion
 * evidence by itself.
 */
export interface WorkReconciliationRecord {
  schemaVersion: 1;
  reconciliationId: string;
  originalExpectedRevision: string;
  observedTargetRevision: string;
  baseRevision: string;
  targetBranch: string;
  reachable: boolean;
  method: WorkReconciliationMethod;
  comparedPaths: string[];
  reviewer: string;
  reviewedAt: string;
  unrecoverableStages: string[];
  cleanupOwnershipProof: string;
  rationale: string;
  outcome: WorkReconciliationOutcome;
}

export interface WorkContract {
  schemaVersion: 1 | 2;
  workId: string;
  /** Portable semantic scope. New records derive this from Requirement/Plan/Work identity, never local repository registration. */
  scopeRef?: ScopeRef;
  /** Replaceable node-local placement. repoId/checkoutId below remain compatibility fields during V2 migration. */
  executionPlacement?: ExecutionPlacement;
  /** @deprecated Node-local placement compatibility field; do not use as semantic Work identity. */
  repoId: string;
  /** @deprecated Node-local placement compatibility field. Optional only for legacy/current-workspace records. */
  checkoutId?: string;
  principalId?: string;
  controllerInstanceId?: string;
  baseRevision?: string;
  /** Authoritative repository baseline captured at Work admission. Absent means legacy/unknown, never implicitly unborn. */
  repositoryBaseState?: 'revision' | 'unborn';
  workspaceFingerprint?: string;
  routeDecisionFingerprint?: string;
  routeDecision?: WorkRouteDecisionSnapshot;
  mode: ExecutionMode;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContractConstraints;
  /** Risk is immutable contract input and is projected to legacy Task reads. */
  risk: WorkRisk;
  /** Versioned engineering-governance requirements and exact source-bound evidence state for this Work. */
  engineeringContext?: EngineeringContextReceipt;
  /** Technical phase; Requirement owns the user lifecycle. */
  phase: WorkPhase;
  /** Work-owned phase checkpoints. Task/Run/Process records may contribute evidence but cannot write this map directly. */
  phaseEvidence: WorkPhaseEvidenceMap;
  /** Explicit v2 execution semantics. `status` is retained for compatibility. */
  workKind: WorkKind;
  /** Primary is an objective-level business execution lane; execution_child is a resumable low-level operation handle owned by a primary Work or standalone caller. */
  lifecycleRole?: 'primary' | 'execution_child';
  /** Optional objective-level parent when this Work is only an execution child. */
  parentWorkId?: string;
  /** Immediate prior primary Work in the same semantic continuation lineage. Relationship evidence only; never execution or deletion authority. */
  predecessorWorkId?: string;
  /** Historical predecessors explicitly replaced by this Work. Relationship evidence only; never deletion authority. */
  supersedes?: string[];
  /** Current successor that replaced this Work. Presence makes this Work historical even before cleanup terminalizes it. */
  supersededBy?: string;
  /** Bounded durable reason for the supersession edge. */
  supersessionReason?: string;
  dispatchState: DispatchState;
  evidenceState: EvidenceState;
  completionOutcome?: CompletionOutcome;
  status: WorkContractStatus;
  createdAt: string;
  updatedAt: string;
  /** @deprecated Prefer Requirement/Plan/Work links; kept for compatibility reads only. */
  issueId?: string;
  taskId?: string;
  /** Stable Requirement authority that this Work may complete. */
  requirementId?: string;
  /** Work-owned completion receipt. Legacy Task receipts are projections only. */
  completionReceipt?: WorkCompletionReceipt;
  /** Provenance for complex work dispatched from a durable PlanContract step. */
  planId?: string;
  planStepId?: string;
  planSourceRevision?: string;
  scopeSummary?: string;
  /**
   * Discovery evidence, never an authorization boundary. Initial guesses,
   * inspected paths, and observed changes remain distinct so early retrieval
   * cannot masquerade as complete implementation scope.
   */
  scopeEvidence?: {
    initialLikelyPaths: string[];
    inspectedPaths: string[];
    actualChangedPaths: string[];
    recordedAt: string;
  };
  /** Source-bound semantic findings/scope for first-class recoverable read-only review Work. */
  readOnlyReviewEvidence?: ReadOnlyReviewEvidence;
  /** Explicit Controller-reviewed acceptance bindings. Mechanical evidence attribution alone never writes this field. */
  semanticAcceptanceEvidence?: WorkSemanticAcceptanceEvidence[];
  /** Explicit policy fence. This is not semantic completeness evidence. */
  allowedPaths: string[];
  forbiddenPaths: string[];
  checks: string[];
  driver: WorkContractDriverPolicy;
  worktreePolicy: WorktreePolicy;
  evidencePolicy: EvidencePolicy;
  approvalPolicy: ApprovalPolicy;
  recoveryPolicy: RecoveryPolicy;
  requestedBy: 'chatgpt' | 'user' | 'system' | 'scheduler';
  evidenceRefs: EvidenceRef[];
  handoffRefs: string[];
  suggestedNextActions: SuggestedNextAction[];
  policyDecisions: PolicyDecision[];
  checkRefs: VerificationRecord[];
  /** Append-only Controller implementation-review authority. Generic mutation APIs cannot write this history. */
  implementationReviews: WorkImplementationReviewRecord[];
  /** Reviewed historical/manual integration exceptions, retained for audit. */
  reconciliations: WorkReconciliationRecord[];
  continuationPrompt?: string;
  worktreeRef?: string;
  workerRef?: string;
  requestId?: string;
  /** Typed execution metadata; it does not imply ExecutionJob creation. */
  submittedOperation?: SubmittedWorkOperation;
}

/** Typed execution metadata retained on execution-child WorkContracts. */
export interface SubmittedWorkOperation {
  name: string;
  semanticKey: string;
  argumentHash: string;
  mode: 'readonly' | 'mutating' | 'remote_write' | 'destructive';
  idempotent: boolean;
  replayable: boolean;
  resourceClaims: Array<{
    resourceKey: string;
    mode: string;
    quantity?: number;
  }>;
}

/** Resolve portable semantic scope without consulting node-local repository identity. */
export function semanticScopeRefForWork(
  work: Pick<WorkContract, 'workId' | 'scopeRef' | 'requirementId' | 'planId' | 'planStepId'>,
): ScopeRef {
  if (work.scopeRef) return work.scopeRef;
  if (work.requirementId?.trim()) return { schemaVersion: 1, kind: 'requirement', id: work.requirementId.trim() };
  if (work.planId?.trim() && work.planStepId?.trim()) {
    return { schemaVersion: 1, kind: 'plan_step', id: `${work.planId.trim()}:${work.planStepId.trim()}` };
  }
  if (work.planId?.trim()) return { schemaVersion: 1, kind: 'plan', id: work.planId.trim() };
  return { schemaVersion: 1, kind: 'work', id: work.workId.trim() };
}

/** Resolve replaceable execution placement from explicit V2 placement or compatibility fields. */
export function executionPlacementForWork(
  work: Pick<WorkContract, 'executionPlacement' | 'repoId' | 'checkoutId'>,
): ExecutionPlacement {
  if (work.executionPlacement) return work.executionPlacement;
  return {
    schemaVersion: 1,
    repositoryId: work.repoId,
    ...(work.checkoutId?.trim() ? { checkoutId: work.checkoutId.trim() } : {}),
  };
}

export interface WorkContractStore {
  schemaVersion: 1 | 2;
  updatedAt: string;
  contracts: WorkContract[];
}

export function isTerminalWorkContractStatus(status: WorkContractStatus): boolean {
  return TERMINAL_WORK_CONTRACT_STATUSES.includes(status);
}
