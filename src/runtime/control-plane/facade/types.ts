import type {
  WorkContract,
  VerificationOutcome,
  FacadeDetailLevel,
  EvidenceRef,
  SuggestedNextAction,
  PolicyDecision,
} from '../../../../packages/kernel/work/domain/types';
export type {
  FacadeDetailLevel,
  EvidenceRef,
  SuggestedNextAction,
  PolicyDecision,
} from '../../../../packages/kernel/work/domain/types';
import {
  TERMINAL_PLAN_CONTRACT_STATUSES,
  type PlanContractStatus,
  type PlanStepStatus,
} from '../../../../packages/kernel/goal/api/index';
export {
  PLAN_CONTRACT_STATUSES,
  TERMINAL_PLAN_CONTRACT_STATUSES,
  PLAN_STEP_STATUSES,
  type PlanContractStatus,
  type PlanStepStatus,
} from '../../../../packages/kernel/goal/api/index';

export const FACADE_TOOLS = ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'] as const;
export type FacadeTool = (typeof FACADE_TOOLS)[number];
export type CapabilityExecutionSurface = FacadeTool | 'plugin_action_execute';

export const FACADE_STATUSES = ['ok', 'blocked', 'failed', 'approval_required', 'not_found'] as const;
export type FacadeStatus = (typeof FACADE_STATUSES)[number];


export const CAPABILITY_DOMAINS = ['repository', 'plugin', 'controller', 'evidence', 'maintenance'] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export const CAPABILITY_GROUPS = [
  'controller',
  'repository-core',
  'git',
  'issue-task',
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

export { HANDOFF_STATUSES, TERMINAL_HANDOFF_STATUSES, isTerminalHandoffStatus, type HandoffStatus } from '../../../../packages/protocols/handoff/index';
import type { HandoffStatus } from '../../../../packages/protocols/handoff/index';

// Kernel V2: Work domain contracts are owned by packages/kernel/work/domain.
export {
  WORK_CONTRACT_STATUSES,
  WORK_PHASES,
  WORK_PHASE_EVIDENCE_STATES,
  WORK_RISKS,
  TERMINAL_WORK_CONTRACT_STATUSES,
  WORK_KINDS,
  DISPATCH_STATES,
  EVIDENCE_STATES,
  COMPLETION_OUTCOMES,
  WORK_RECONCILIATION_METHODS,
  WORK_RECONCILIATION_OUTCOMES,
  VERIFICATION_OUTCOMES,
  isRepositoryCompletionReceipt,
  isReadOnlyReviewCompletionReceipt,
  isRemoteEffectCompletionReceipt,
  isDirectEditWorkCompletionReceipt,
  isTerminalWorkContractStatus,
} from '../../../../packages/kernel/work/domain/types';
export type {
  WorkContractStatus,
  WorkPhase,
  WorkPhaseEvidenceState,
  WorkPhaseEvidence,
  WorkPhaseEvidenceMap,
  WorkRisk,
  WorkKind,
  DispatchState,
  EvidenceState,
  CompletionOutcome,
  ReadOnlyReviewEvidence,
  WorkSemanticAcceptanceEvidence,
  ReadOnlyReviewCompletionReceipt,
  LocalEffectCompletionReceipt,
  RemoteEffectCompletionReceipt,
  DirectEditWorkCompletionReceipt,
  WorkCompletionReceipt,
  WorkReconciliationMethod,
  WorkReconciliationOutcome,
  VerificationOutcome,
  WorkContractConstraints,
  WorktreePolicy,
  EvidencePolicy,
  ApprovalPolicy,
  RecoveryPolicy,
  VerificationRecord,
  WorkReconciliationRecord,
  WorkContract,
  SubmittedWorkOperation,
  WorkContractStore,
} from '../../../../packages/kernel/work/domain/types';
export const HANDOFF_CREATION_REASONS = [
  'policy_approval_required',
  'ambiguous_outcome',
  'missing_authorization',
  'invalid_objective',
  'destructive_action_requires_confirmation',
] as const;
export type HandoffCreationReason = (typeof HANDOFF_CREATION_REASONS)[number];

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
  /** Canonical person-only blocker/decision authority when this legacy Handoff projects one. */
  canonicalUserRequestId?: string;
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

// Kernel V2: Controller session contracts are owned by packages/kernel/controller/domain.
export type {
  ControllerType,
  ControllerSession,
  ControllerSessionStore,
  ControllerBinding,
  ControllerLease,
  ControllerRoundContext,
} from '../../../../packages/kernel/controller/domain/types';
export interface PlanSemanticItem {
  id: string;
  objective: string;
  dependencies: string[];
}

export interface PlanSemanticContext {
  /** Requirement semantic revision used as planning provenance; never an execution gate. */
  requirementBasisRevision?: number;
  sourceBasisRevision: string;
  goal: string;
  nonGoals: string[];
  assumptions: string[];
  resolvedDecisions: string[];
  stopConditions: string[];
  replanConditions: string[];
  integrationStrategy?: string;
  items: PlanSemanticItem[];
}

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
export const PLAN_OBLIGATION_DISPOSITIONS = ['keep', 'change', 'defer', 'drop'] as const;
export type PlanObligationDispositionKind = (typeof PLAN_OBLIGATION_DISPOSITIONS)[number];

export interface PlanObligationDisposition {
  predecessorPlanId: string;
  obligationId: string;
  disposition: PlanObligationDispositionKind;
  /** Successor locations such as step:<id>, acceptance:<id>:<index>, resolved_decision:<index>. */
  successorRefs: string[];
  /** Required for CHANGE/DEFER/DROP. KEEP may omit it. */
  rationale?: string;
}

/**
 * Immutable provenance for one predecessor delivery that may be reused by a
 * successor Plan after approval. The Work itself remains historical and bound
 * to the predecessor Plan; this record never transfers execution authority.
 */
export interface PlanStepDeliveryCarry {
  predecessorPlanId: string;
  predecessorStepId: string;
  successorStepId: string;
  workId: string;
  completionReceiptId: string;
  deliveredSourceRevision: string;
  recordedAt: string;
}

/** Mutable only until approval. A stable Plan may stage at most one next revision;
 * the currently committed Plan fields remain authoritative until this draft is approved. */
export interface PlanRevisionDraft {
  revision: number;
  requestedRevisionLabel?: string;
  sourceRevision: string;
  goal: string;
  nonGoals: string[];
  assumptions: string[];
  resolvedDecisions: string[];
  stopConditions: string[];
  replanConditions: string[];
  integrationStrategy?: string;
  steps: PlanStep[];
  obligationDispositions?: PlanObligationDisposition[];
  deliveryCarries?: PlanStepDeliveryCarry[];
  createdAt: string;
  updatedAt: string;
}

/** Immutable audit snapshot of one committed Plan revision. Historical revisions
 * never own active scope, Work, scheduling, or admission authority. */
export interface PlanRevisionRecord {
  schemaVersion: 1;
  repoId: string;
  planId: string;
  revision: number;
  requirementId?: string;
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
  obligationDispositions?: PlanObligationDisposition[];
  recordedAt: string;
  reason?: string;
  /** Compatibility label supplied by older successor-Plan clients. It is not a Plan identity. */
  requestedRevisionLabel?: string;
}

export interface PlanContract {
  schemaVersion: 1;
  planId: string;
  /** Legacy PlanContract lifecycle revision retained during authority migration. */
  revision?: number;
  /** Thin model-authored Plan revision, independent from lifecycle/step execution updates. */
  semanticRevision?: number;
  /** Timestamp of the model-authored Plan content; lifecycle/step updates must not change it. */
  semanticUpdatedAt?: string;
  /** Thin model-authored working memory. Once present, legacy steps/status cannot rewrite semantic Plan content. */
  semanticContext?: PlanSemanticContext;
  repoId: string;
  /** Stable Requirement owner. Legacy plans may omit this until portfolio migration. */
  requirementId?: string;
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
  /** Historical predecessor Plans explicitly replaced by this Plan. */
  supersedes?: string[];
  supersededBy?: string;
  /** Bounded durable reason for the supersession edge. */
  supersessionReason?: string;
  /** Explicit reconciliation of unresolved predecessor obligations. */
  obligationDispositions?: PlanObligationDisposition[];
  /** Trusted, bounded delivery provenance derived only during canonical successor admission. */
  deliveryCarries?: PlanStepDeliveryCarry[];
  /** At most one staged next revision. It is not another active Plan authority. */
  pendingRevision?: PlanRevisionDraft;
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
  exposedVia: CapabilityExecutionSurface;
  schemaExposure: CapabilitySchemaExposure;
  summary: string;
  /** Provider-declared semantic capabilities implemented by this executable action. */
  semanticCapabilities?: string[];
}

export interface CapabilityGroupSummary {
  group: CapabilityGroup;
  capabilityCount: number;
  domains: CapabilityDomain[];
  executionSurfaces: CapabilityExecutionSurface[];
  facadeTools: FacadeTool[];
  operationClasses: CapabilityOperationClass[];
  risks: CapabilityRisk[];
  schemaExposures: CapabilitySchemaExposure[];
}

/**
 * Concrete mechanical facts about one Work start request. Forge validates and
 * persists these; it never derives engineering method, worker/provider choice,
 * verification, review, or completion from them. Choosing durable Work at all
 * is the caller's explicit decision to invoke this capability.
 */
export interface WorkStartFacts {
  objective?: string;
  scopeClear: boolean;
  mutation?: boolean;
  requiresRecovery?: boolean;
  /** True when the request causes an effect outside the checkout (plugin action, remote publish). */
  requiresExternalEffect?: boolean;
  requiresApproval?: boolean;
  requiresUserApproval?: boolean;
  approvalConfirmed?: boolean;
  destructive?: boolean;
  remoteWrite?: boolean;
  secretAccess?: boolean;
  risk?: CapabilityRisk;
  workspaceDirty?: boolean;
}
