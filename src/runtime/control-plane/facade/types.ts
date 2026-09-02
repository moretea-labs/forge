import type {
  WorkContract,
  VerificationOutcome,
  ExecutionMode,
  FacadeDetailLevel,
  EvidenceRef,
  SuggestedNextAction,
  PolicyDecision,
} from '../../../../packages/kernel/work/domain/types';
export type {
  ExecutionMode,
  FacadeDetailLevel,
  EvidenceRef,
  SuggestedNextAction,
  PolicyDecision,
} from '../../../../packages/kernel/work/domain/types';
import { decideRoute, type ExplicitTaskMode, type RouteDecision, type RoutePolicyInput } from '../routing/route-policy';

export const EXECUTION_MODES = ['direct_control', 'goal_workloop', 'handoff_only'] as const;
const _executionModesTypeCheck: readonly ExecutionMode[] = EXECUTION_MODES;

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
  WorkContractDriverPolicy,
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
  'repeated_infrastructure_failure',
  'codex_worker_requires_review',
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

// Kernel V2: Controller session contracts are owned by packages/kernel/controller/domain.
export type {
  ControllerType,
  ControllerSession,
  ControllerSessionStore,
  ControllerBinding,
  ControllerLease,
  ControllerRoundContext,
} from '../../../../packages/kernel/controller/domain/types';
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

export interface ExecutionModeSelectionInput {
  objective?: string;
  expectedFiles?: number;
  expectedChangedLines?: number;
  scopeClear: boolean;
  knownPaths?: string[];
  workspaceDirty?: boolean;
  workspaceFingerprint?: string;
  checkoutId?: string;
  /** Canonical typed placement constraint; never inferred from objective text. */
  workspacePlacement?: 'current' | 'isolated' | 'auto';
  /** Admission fence that has precedence over explicit Direct routing. */
  directMainProhibited?: boolean;
  requiresInvestigation?: boolean;
  requiresLongRunningChecks?: boolean;
  requiresParallelism?: boolean;
  explicitMode?: ExplicitTaskMode;
  needsDependencies?: boolean;
  requiresRecovery?: boolean;
  /** True only when the user explicitly requested an agent/worker executor. Complexity alone must not enable workers. */
  requiresWorker?: boolean;
  requiresExternalEffect?: boolean;
  requiresApproval?: boolean;
  requiresUserApproval?: boolean;
  approvalConfirmed?: boolean;
  destructive?: boolean;
  remoteWrite?: boolean;
  secretAccess?: boolean;
  mutation?: boolean;
  risk?: CapabilityRisk;
  /** Migration/testing escape hatch: adapters must return this exact policy decision. */
  routePolicyInput?: RoutePolicyInput;
}

export interface ExecutionModeSelection {
  mode: ExecutionMode;
  reason: string;
  missingContractFields: string[];
  createWorkContract: boolean;
  createHandoff: boolean;
  requiresWork: boolean;
  routeDecision: RouteDecision;
}

export function isTerminalHandoffStatus(status: HandoffStatus): boolean {
  return TERMINAL_HANDOFF_STATUSES.includes(status);
}



/** @deprecated Compatibility adapter. Route Policy is the sole routing authority. */
export function selectExecutionMode(input: ExecutionModeSelectionInput): ExecutionModeSelection {
  const missingContractFields: string[] = [];
  if (!input.scopeClear) missingContractFields.push('scopeSummary', 'acceptanceCriteria', 'allowedPaths');
  if (input.objective !== undefined && input.objective.trim().length === 0) missingContractFields.push('objective');
  const routeDecision = decideRoute(input.routePolicyInput ?? {
    intent: {
      objective: input.objective ?? (input.scopeClear ? 'bounded repository work' : ''),
      scopeClear: input.scopeClear,
      mutation: input.mutation ?? input.risk !== 'readonly',
      expectedFiles: input.expectedFiles,
      expectedChangedLines: input.expectedChangedLines,
      requiresInvestigation: input.requiresInvestigation,
      requiresLongRunningChecks: input.requiresLongRunningChecks,
      requiresParallelism: input.requiresParallelism,
      explicitMode: input.explicitMode,
      needsDependencies: input.needsDependencies,
      agentRequested: input.requiresWorker,
    },
    workspace: {
      knownPaths: input.knownPaths,
      dirty: input.workspaceDirty,
      checkoutId: input.checkoutId,
      fingerprint: input.workspaceFingerprint,
      placement: input.workspacePlacement,
      directMainProhibited: input.directMainProhibited,
    },
    policy: {
      risk: input.risk,
      requiresApproval: input.requiresApproval,
      requiresUserApproval: input.requiresUserApproval,
      approvalConfirmed: input.approvalConfirmed,
      destructive: input.destructive,
      remoteWrite: input.remoteWrite,
      secretAccess: input.secretAccess,
    },
    capabilities: {
      requiresWorker: input.requiresWorker,
      requiresExternalEffect: input.requiresExternalEffect,
    },
    recovery: {
      required: input.requiresRecovery,
    },
  });
  return {
    mode: routeDecision.executionMode,
    reason: routeDecision.reasons.map((reason) => reason.message).join(' '),
    missingContractFields: routeDecision.executionMode === 'handoff_only' && missingContractFields.length > 0 ? missingContractFields : [],
    createWorkContract: routeDecision.requiresWork,
    createHandoff: routeDecision.createHandoff,
    requiresWork: routeDecision.requiresWork,
    routeDecision,
  };
}
