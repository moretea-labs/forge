import type { ProcessCheckReceiptEvidence } from '../../evidence/process-check-receipt';
import type { CompletionReceipt } from '../../../cli/controller/types';
import type { AccessMode } from '../governance/access-policy';

export const EXECUTION_MODES = ['direct_control', 'goal_workloop', 'handoff_only'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const FACADE_TOOLS = ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'] as const;
export type FacadeTool = (typeof FACADE_TOOLS)[number];

export const FACADE_STATUSES = ['ok', 'blocked', 'failed', 'approval_required', 'not_found'] as const;
export type FacadeStatus = (typeof FACADE_STATUSES)[number];

export type FacadeDetailLevel = 'summary' | 'detail' | 'raw';

export const CAPABILITY_DOMAINS = ['repository', 'plugin', 'controller', 'evidence', 'maintenance'] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export const CAPABILITY_GROUPS = [
  'controller',
  'repository-core',
  'git',
  'issue-task',
  'campaign',
  'browser',
  'ios',
  'plugin',
  'evidence',
  'runtime-maintenance',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export const CAPABILITY_SCHEMA_EXPOSURES = ['stable_static', 'plugin_manifest'] as const;
export type CapabilitySchemaExposure = (typeof CAPABILITY_SCHEMA_EXPOSURES)[number];

export const CAPABILITY_OPERATION_CLASSES = ['read', 'write', 'execute', 'verify', 'finalize'] as const;
export type CapabilityOperationClass = (typeof CAPABILITY_OPERATION_CLASSES)[number];

export const CAPABILITY_RISKS = [
  'readonly',
  'local_repo_write',
  'workspace_write',
  'remote_write',
  'destructive_remote',
  'destructive',
  'raw_secret_config',
  'unknown',
] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];

export const POLICY_DECISIONS = ['allowed', 'approval_required', 'denied', 'dry_run_only'] as const;
export type PolicyDecisionKind = (typeof POLICY_DECISIONS)[number];

export const HANDOFF_SEVERITIES = ['info', 'needs_review', 'blocked', 'failed', 'ready_to_continue'] as const;
export type HandoffSeverity = (typeof HANDOFF_SEVERITIES)[number];

export const HANDOFF_STATUSES = [
  'pending',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed',
  'superseded',
  'expired',
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const TERMINAL_HANDOFF_STATUSES: readonly HandoffStatus[] = [
  'resolved',
  'dismissed',
  'superseded',
  'expired',
] as const;

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
export const WORK_PHASES = ['implementation', 'verification', 'delivery', 'cleanup'] as const;
export type WorkPhase = (typeof WORK_PHASES)[number];

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
  'investigation',
  'remote_effect',
  'reconciliation',
  'superseded',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const DISPATCH_STATES = ['not_dispatched', 'claimed', 'launching', 'running', 'blocked', 'terminal'] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const EVIDENCE_STATES = ['none', 'partial', 'valid', 'stale', 'contradictory', 'failed'] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const COMPLETION_OUTCOMES = ['completed_changed', 'completed_no_change', 'completed_remote', 'superseded'] as const;
export type CompletionOutcome = (typeof COMPLETION_OUTCOMES)[number];

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

export const HANDOFF_CREATION_REASONS = [
  'policy_approval_required',
  'ambiguous_outcome',
  'missing_authorization',
  'invalid_objective',
  'repeated_infrastructure_failure',
  'codex_worker_requires_review',
  'destructive_action_requires_confirmation',
] as const;
export type HandoffCreationReason = (typeof HANDOFF_CREATION_REASONS)[number];

export interface EvidenceRef {
  evidenceId?: string;
  artifactId?: string;
  title: string;
  summary?: string;
  detailLevel?: FacadeDetailLevel;
}

export interface SuggestedNextAction {
  label: string;
  tool: FacadeTool;
  operation: string;
  payload?: Record<string, unknown>;
  risk: CapabilityRisk;
  confidence?: 'low' | 'medium' | 'high';
  reason?: string;
  fallback?: string;
}

export interface FacadeResult<TData = Record<string, unknown>> {
  schemaVersion: 1;
  status: FacadeStatus;
  summary: string;
  data: TData;
  evidenceRefs: EvidenceRef[];
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
  rawAvailable: boolean;
  detailLevel: FacadeDetailLevel;
}

export interface HandoffCurrentState {
  repoId: string;
  issueId?: string;
  taskId?: string;
  workId?: string;
  mode?: ExecutionMode;
  statusSummary: string;
  blockedBy?: string[];
  changedFiles?: string[];
  checks?: Array<{ checkId: string; ok: boolean; summary?: string; outcome?: VerificationOutcome }>;
  /** Bounded durable Work semantics for a fresh controller session. */
  workSemantics?: Pick<WorkContract, 'phase' | 'status' | 'workKind' | 'dispatchState' | 'evidenceState' | 'completionOutcome'>;
  reconciliationRequired?: boolean;
  nextSafeAction?: string;
}

export interface HandoffApprovalAction {
  operation: 'start' | 'repair';
  label: string;
  summary: string;
  risk: CapabilityRisk;
  payload: Record<string, unknown>;
}

export interface HandoffItem {
  schemaVersion: 1;
  id: string;
  repoId: string;
  workId?: string;
  issueId?: string;
  taskId?: string;
  title: string;
  severity: HandoffSeverity;
  status: HandoffStatus;
  reason: string;
  creationReason?: HandoffCreationReason;
  summary: string;
  currentState: HandoffCurrentState;
  attemptedActions?: string[];
  evidenceRefs: EvidenceRef[];
  blockingDecision?: string;
  recommendedDecision: string;
  recommendedPrompt: string;
  recommendedContinuationPrompt?: string;
  /** Exact action that may run after explicit approval. Absent on legacy/non-executable handoffs. */
  approvalAction?: HandoffApprovalAction;
  suggestedNextActions: SuggestedNextAction[];
  decision?: string;
  resolver?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffInboxStore {
  schemaVersion: 1;
  updatedAt: string;
  items: HandoffItem[];
}

export interface WorkContractConstraints {
  maxChangedFiles?: number;
  maxChangedLines?: number;
  allowCommit?: boolean;
  allowMerge?: boolean;
  allowCleanup?: boolean;
  allowDestructive?: boolean;
  requireHandoffOnAmbiguity?: boolean;
  /** Immutable execution-policy snapshot captured when work starts. */
  accessMode?: AccessMode;
  /** current is the stability-first default; isolated is opt-in or used for explicit parallelism. */
  workspaceMode?: 'current' | 'isolated' | 'auto';
  requireWorktree?: boolean;
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
  repoId: string;
  mode: ExecutionMode;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContractConstraints;
  /** Risk is immutable contract input and is projected to legacy Task reads. */
  risk: WorkRisk;
  /** Technical phase; Requirement owns the user lifecycle. */
  phase: WorkPhase;
  /** Explicit v2 execution semantics. `status` is retained for compatibility. */
  workKind: WorkKind;
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
  completionReceipt?: CompletionReceipt;
  /** Provenance for complex work dispatched from a durable PlanContract step. */
  planId?: string;
  planStepId?: string;
  planSourceRevision?: string;
  scopeSummary?: string;
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
  /** Reviewed historical/manual integration exceptions, retained for audit. */
  reconciliations: WorkReconciliationRecord[];
  continuationPrompt?: string;
  worktreeRef?: string;
  workerRef?: string;
  /** Stable idempotency key when this Work was accepted via work_submit. */
  requestId?: string;
  /** Accepted Kernel operation envelope. Does not imply ExecutionJob creation. */
  submittedOperation?: SubmittedWorkOperation;
}

/** Operation metadata retained on WorkContracts accepted through work_submit. */
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

export interface WorkContractStore {
  schemaVersion: 1 | 2;
  updatedAt: string;
  contracts: WorkContract[];
}

export type ControllerType = 'chatgpt' | 'codex' | 'grok' | 'claude' | 'human';

export interface ControllerSession {
  schemaVersion: 1;
  workId: string;
  controllerId: string;
  controllerType: ControllerType;
  sessionId: string;
  /** Authenticated authority that owned the claim; legacy records may omit it. */
  principalId?: string;
  /** Controller process/epoch that admitted the transport session. */
  controllerInstanceId?: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface ControllerSessionStore {
  schemaVersion: 1;
  updatedAt: string;
  sessions: ControllerSession[];
}

export const PLAN_CONTRACT_STATUSES = [
  'draft',
  'inspecting',
  'reviewing',
  'approved',
  'executing',
  'replanning',
  'verifying',
  'ready_to_finalize',
  'finalized',
  'superseded',
  'cancelled',
  'invalidated_by_drift',
] as const;
export type PlanContractStatus = (typeof PLAN_CONTRACT_STATUSES)[number];

export const TERMINAL_PLAN_CONTRACT_STATUSES: readonly PlanContractStatus[] = [
  'finalized',
  'superseded',
  'cancelled',
  'invalidated_by_drift',
];

export const PLAN_STEP_STATUSES = ['pending', 'ready', 'executing', 'validating', 'completed'] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface PlanStep {
  id: string;
  objective: string;
  dependencies: string[];
  authoritativeFiles: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  checks: string[];
  acceptanceCriteria: string[];
  status: PlanStepStatus;
  /** Work currently executing this step, when materialized. */
  workId?: string;
  evidenceRefs: EvidenceRef[];
}

/**
 * A durable pre-execution decision record. WorkContract remains the unit that
 * owns dispatch, workspace, worker, and verification lifecycle.
 */
export interface PlanContract {
  schemaVersion: 1;
  planId: string;
  repoId: string;
  scopeKey: string;
  sourceRevision: string;
  goal: string;
  nonGoals: string[];
  assumptions: string[];
  resolvedDecisions: string[];
  stopConditions: string[];
  replanConditions: string[];
  integrationStrategy?: string;
  status: PlanContractStatus;
  steps: PlanStep[];
  evidenceRefs: EvidenceRef[];
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanContractStore {
  schemaVersion: 1;
  updatedAt: string;
  contracts: PlanContract[];
}

export function isTerminalPlanContractStatus(status: PlanContractStatus): boolean {
  return TERMINAL_PLAN_CONTRACT_STATUSES.includes(status);
}

export interface CapabilityDescriptor {
  capabilityId: string;
  domain: CapabilityDomain;
  group: CapabilityGroup;
  operationClass: CapabilityOperationClass;
  risk: CapabilityRisk;
  exposedVia: FacadeTool;
  schemaExposure: CapabilitySchemaExposure;
  summary: string;
}

export interface CapabilityGroupSummary {
  group: CapabilityGroup;
  capabilityCount: number;
  domains: CapabilityDomain[];
  facadeTools: FacadeTool[];
  operationClasses: CapabilityOperationClass[];
  risks: CapabilityRisk[];
  schemaExposures: CapabilitySchemaExposure[];
}

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  capabilityId?: string;
  approvalRequestId?: string;
  requiredConfirmationText?: string;
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
}

export interface ExecutionModeSelectionInput {
  objective?: string;
  expectedFiles?: number;
  expectedChangedLines?: number;
  scopeClear: boolean;
  requiresInvestigation?: boolean;
  requiresLongRunningChecks?: boolean;
  requiresParallelism?: boolean;
  needsDependencies?: boolean;
  requiresRecovery?: boolean;
  /** True only when the user explicitly requested an agent/worker executor. Complexity alone must not enable workers. */
  requiresWorker?: boolean;
  requiresExternalEffect?: boolean;
  requiresApproval?: boolean;
  requiresUserApproval?: boolean;
  destructive?: boolean;
  remoteWrite?: boolean;
  secretAccess?: boolean;
  risk?: CapabilityRisk;
}

export interface ExecutionModeSelection {
  mode: ExecutionMode;
  reason: string;
  missingContractFields: string[];
  createWorkContract: boolean;
  createHandoff: boolean;
}

export function isTerminalHandoffStatus(status: HandoffStatus): boolean {
  return TERMINAL_HANDOFF_STATUSES.includes(status);
}

export function isTerminalWorkContractStatus(status: WorkContractStatus): boolean {
  return TERMINAL_WORK_CONTRACT_STATUSES.includes(status);
}

export function selectExecutionMode(input: ExecutionModeSelectionInput): ExecutionModeSelection {
  const expectedFiles = input.expectedFiles ?? 0;
  const expectedChangedLines = input.expectedChangedLines ?? 0;
  const requiresApproval = input.requiresApproval === true || input.requiresUserApproval === true;
  const highRisk =
    input.destructive === true
    || input.remoteWrite === true
    || input.secretAccess === true
    || input.risk === 'destructive'
    || input.risk === 'destructive_remote'
    || input.risk === 'remote_write'
    || input.risk === 'raw_secret_config';

  const objectiveClear = input.scopeClear && (input.objective === undefined || input.objective.trim().length > 0);
  const missingContractFields: string[] = [];
  if (!input.scopeClear) missingContractFields.push('scopeSummary', 'acceptanceCriteria', 'allowedPaths');
  if (input.objective !== undefined && input.objective.trim().length === 0) missingContractFields.push('objective');

  if (!objectiveClear || (highRisk && requiresApproval && !input.scopeClear)) {
    return {
      mode: 'handoff_only',
      reason: 'The request is underspecified, high-risk without clear scope, or missing authorization and needs ChatGPT or user clarification before execution.',
      missingContractFields: missingContractFields.length ? missingContractFields : ['scopeSummary'],
      createWorkContract: false,
      createHandoff: true,
    };
  }

  if (highRisk && requiresApproval) {
    return {
      mode: 'handoff_only',
      reason: 'High-risk side effects require explicit authorization before any work contract or direct edit starts.',
      missingContractFields: [],
      createWorkContract: false,
      createHandoff: true,
    };
  }

  const complex =
    input.requiresRecovery === true
    || input.requiresWorker === true
    || input.requiresExternalEffect === true
    || input.requiresInvestigation === true
    || input.requiresLongRunningChecks === true
    || input.requiresParallelism === true
    || input.needsDependencies === true
    || requiresApproval
    || expectedFiles > 3
    || expectedChangedLines > 200;

  if (!complex) {
    return {
      mode: 'direct_control',
      reason: 'Small, clear, supervised work should stay on the fast direct-control path.',
      missingContractFields: [],
      createWorkContract: false,
      createHandoff: false,
    };
  }

  return {
    mode: 'goal_workloop',
    reason: 'The request benefits from recovery, isolation, worker execution, approval, investigation, or background continuation.',
    missingContractFields: [],
    createWorkContract: true,
    createHandoff: false,
  };
}
