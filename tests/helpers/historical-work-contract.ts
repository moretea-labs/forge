import {
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  WORK_PHASES,
  type WorkPhase,
  type WorkPhaseEvidenceMap,
  type SemanticWorkState,
  type WorkRisk,
  type WorkKind,
  type DispatchState,
  type EvidenceState,
  type CompletionOutcome,
  type WorkCompletionReceipt,
  type ReadOnlyReviewEvidence,
  type WorkSemanticAcceptanceEvidence,
  type EvidenceRef,
  type SuggestedNextAction,
  type PolicyDecision,
  type VerificationRecord,
  type WorkReconciliationRecord,
  type SubmittedWorkOperation,
  type WorktreePolicy,
  type EvidencePolicy,
  type ApprovalPolicy,
  type RecoveryPolicy,
} from './historical-work-domain';
import type { ExecutionPlacement, ScopeRef } from '../../packages/kernel/identity/api/index';
import type { WorkAccessMode } from '../../packages/kernel/work/domain/execution-snapshot';
import type { WorkImplementationReviewRecord } from '../../packages/kernel/work/domain/implementation-review';
import type { EngineeringContextReceipt } from '../../packages/kernel/work/domain/engineering-contracts';

/** Test-only schema for archived Work bytes. NEVER export this from production. */
export interface WorkContractConstraints {
  maxChangedFiles?: number;
  maxChangedLines?: number;
  allowCommit?: boolean;
  allowMerge?: boolean;
  allowCleanup?: boolean;
  allowDestructive?: boolean;
  /** Immutable execution-policy snapshot captured when work starts. */
  accessMode?: WorkAccessMode;
  /** Explicit repository placement. `auto` is retained as the legacy durable-Work isolated/frozen-base default. */
  workspaceMode?: 'current' | 'isolated' | 'auto';
  /** True when a change alters the agreed architecture direction rather than only implementation details. */
  architectureStrategyChange?: boolean;
  /** True when the proposed change weakens the thin-harness / high-performance execution policy. */
  conflictsWithThinHarnessPolicy?: boolean;
  /** True when the change alters the default routing or execution mode visible to users. */
  changesDefaultExecutionStrategy?: boolean;
  /** Repository-change delivery must publish the exact integrated revision before Work terminalization. */
  remoteDeliveryRequired?: boolean;
}

export interface WorkContract {
  schemaVersion: 1 | 2 | 3 | 4;
  workId: string;
  /** Portable semantic scope. New records derive this from Requirement/Plan/Work identity, never local repository registration. */
  scopeRef?: ScopeRef;
  /** Replaceable node-local execution placement; never part of semantic Work identity. */
  executionPlacement?: ExecutionPlacement;
  /** Repository relationship used for local execution lookup; never semantic lifecycle authority. */
  repoId: string;
  /** Optional checkout relationship for local execution placement. */
  checkoutId?: string;
  principalId?: string;
  controllerInstanceId?: string;
  baseRevision?: string;
  /** Authoritative repository baseline captured at Work admission. Absent means legacy/unknown, never implicitly unborn. */
  repositoryBaseState?: 'revision' | 'unborn';
  workspaceFingerprint?: string;
  objective: string;
  /** Independent authored-context revision. Mechanical Work writes never use the SQLite row revision as semantic CAS. */
  semanticRevision?: number;
  /** Timestamp of the authored semantic content; mechanical Work writes must not change it. */
  semanticUpdatedAt?: string;
  /** The single authored Work lifecycle state. Execution/runtime conditions never add states here. */
  semanticState: SemanticWorkState;
  /** Optional provenance links to the Requirement/Plan semantic revisions used when this Work was authored. */
  requirementRevision?: number;
  planRevision?: number;
  /** Model/user-selected semantic result references, separate from mechanical evidence and delivery receipts. */
  semanticResultRefs?: string[];
  acceptanceCriteria: string[];
  constraints: WorkContractConstraints;
  /** Risk is immutable contract input and is projected to legacy Task reads. */
  risk: WorkRisk;
  /** Versioned engineering-governance requirements and exact source-bound evidence state for this Work. */
  engineeringContext?: EngineeringContextReceipt;
  /** Repository-execution phase observation. Never semantic Work authority. */
  phase: WorkPhase;
  /** Mechanical phase evidence for execution/delivery observation only. */
  phaseEvidence: WorkPhaseEvidenceMap;
  /** Execution/result classification. Semantic Work identity/state never depends on this field. */
  workKind: WorkKind;
  /** Primary is an objective-level business execution lane; execution_child is a resumable low-level operation handle owned by a primary Work or standalone caller. */
  lifecycleRole?: 'primary' | 'execution_child';
  /** Optional objective-level parent when this Work is only an execution child. */
  parentWorkId?: string;
  /** Objective decomposition parent for primary semantic Work. Never execution ownership or continuation lineage. */
  semanticParentWorkId?: string;
  /** Explicit objective ordering dependencies for primary semantic Work. Never inferred from Plan items. */
  dependsOnWorkIds?: string[];
  /** Immediate prior primary Work in the same semantic continuation lineage. Relationship evidence only; never execution or deletion authority. */
  predecessorWorkId?: string;
  /** Historical predecessors explicitly replaced by this Work. Relationship evidence only; never deletion authority. */
  supersedes?: string[];
  /** Current successor that replaced this Work. Presence makes this Work historical even before cleanup terminalizes it. */
  supersededBy?: string;
  /** Bounded durable reason for the supersession edge. */
  supersessionReason?: string;
  /** Mechanical execution/evidence projections; none may advance semanticState. */
  dispatchState: DispatchState;
  evidenceState: EvidenceState;
  completionOutcome?: CompletionOutcome;
  createdAt: string;
  updatedAt: string;
  /** Optional historical Issue/Task relationship identifiers; never lifecycle authority. */
  issueId?: string;
  taskId?: string;
  /** Stable Requirement authority that this Work may complete. */
  requirementId?: string;
  /** Work-owned delivery/effect receipt. It never determines semantic completion. */
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
  checks: string[];
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

/** Test-only records. No production WorkContract store/API remains. */
export interface HistoricalWorkStoreOptions {
  controllerHome: string;
  repoId?: string;
  scopeKey?: string;
  now?: () => string;
}

export type HistoricalWorkInput = Partial<WorkContract> &
  Pick<WorkContract, 'workId' | 'repoId' | 'objective'> & {
    allowedPaths?: string[];
    forbiddenPaths?: string[];
  };

function scope(options: HistoricalWorkStoreOptions): string {
  const value = options.scopeKey?.trim() || options.repoId?.trim() || '';
  if (!value) throw new Error('TEST_HISTORICAL_WORK_SCOPE_REQUIRED');
  return value;
}

function phaseEvidence(phase: WorkPhase, at: string, refs: WorkContract['evidenceRefs']): WorkPhaseEvidenceMap {
  const current = WORK_PHASES.indexOf(phase);
  return Object.fromEntries(
    WORK_PHASES.map((candidate, index) => [
      candidate,
      {
        state: index < current ? 'satisfied' : index === current ? 'active' : 'pending',
        source: 'recorded',
        summary:
          index < current
            ? `Historical fixture advanced past ${candidate}.`
            : index === current
              ? `Historical fixture recorded in ${candidate}.`
              : `Historical fixture waiting for ${candidate}.`,
        evidenceRefs: index <= current ? refs.slice(0, 20) : [],
        recordedAt: at,
      },
    ]),
  ) as WorkPhaseEvidenceMap;
}

function historicalContract(input: HistoricalWorkInput, at: string): WorkContract {
  const { allowedPaths: _allowedPaths, forbiddenPaths: _forbiddenPaths, ...historical } = input;
  const refs = input.evidenceRefs ?? [];
  const phase = input.phase ?? 'implementation';
  const defaults: WorkContract = {
    schemaVersion: 4,
    workId: input.workId,
    repoId: input.repoId,
    objective: input.objective,
    semanticRevision: 1,
    semanticUpdatedAt: at,
    semanticState: 'open',
    acceptanceCriteria: [],
    constraints: {},
    risk: 'medium',
    phase,
    phaseEvidence: phaseEvidence(phase, at, refs),
    workKind: 'repository_change',
    dispatchState: 'not_dispatched',
    evidenceState: 'none',
    createdAt: at,
    updatedAt: at,
    checks: [],
    worktreePolicy: { required: false },
    evidencePolicy: {
      defaultDetailLevel: 'summary',
      allowRawOptIn: true,
      maxEvidenceRefs: 20,
    },
    approvalPolicy: { required: false, reasons: [], confirmed: false },
    recoveryPolicy: {
      allowSelfHealing: false,
      maxInfrastructureRetries: 0,
      handoffOnAmbiguity: true,
    },
    requestedBy: 'chatgpt',
    evidenceRefs: [],
    handoffRefs: [],
    suggestedNextActions: [],
    policyDecisions: [],
    checkRefs: [],
    implementationReviews: [],
    reconciliations: [],
  };
  const value: WorkContract = {
    ...defaults,
    ...historical,
    workId: input.workId,
    repoId: input.repoId,
    objective: input.objective,
    semanticUpdatedAt: input.semanticUpdatedAt ?? at,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    constraints: input.constraints ?? {},
    phaseEvidence: input.phaseEvidence ?? phaseEvidence(phase, at, refs),
    createdAt: input.createdAt ?? at,
    updatedAt: input.updatedAt ?? at,
    checks: input.checks ?? [],
    evidenceRefs: refs,
    handoffRefs: input.handoffRefs ?? [],
    suggestedNextActions: input.suggestedNextActions ?? [],
    policyDecisions: input.policyDecisions ?? [],
    checkRefs: input.checkRefs ?? [],
    implementationReviews: input.implementationReviews ?? [],
    reconciliations: input.reconciliations ?? [],
  };
  return value;
}

/** Test-only physical read, not a runtime admission or Work API. */
export function readHistoricalWorkContract(
  options: HistoricalWorkStoreOptions,
  workId: string,
): WorkContract | undefined {
  return readControlPlaneRecord<WorkContract>(options.controllerHome, 'work_contract', scope(options), workId)?.value;
}

/** Test fixture only: inserts one immutable historical Work row. */
export function seedHistoricalWorkContract(
  options: HistoricalWorkStoreOptions,
  input: HistoricalWorkInput,
): WorkContract {
  const at = input.createdAt ?? input.updatedAt ?? options.now?.() ?? new Date().toISOString();
  const value = historicalContract(input, at);
  writeControlPlaneRecord(options.controllerHome, {
    namespace: 'work_contract',
    scope: scope(options),
    key: value.workId,
    schemaVersion: 4,
    value,
    action: 'test_seed_historical_work_contract',
    expectedRevision: null,
  });
  return value;
}

/** Test fixture only: replaces an existing historical Work row by exact SQLite revision. */
export function replaceHistoricalWorkContract(
  options: HistoricalWorkStoreOptions,
  input: Partial<WorkContract> & Pick<WorkContract, 'workId'>,
): WorkContract {
  const record = readControlPlaneRecord<WorkContract>(
    options.controllerHome,
    'work_contract',
    scope(options),
    input.workId,
  );
  if (!record) throw new Error(`TEST_HISTORICAL_WORK_NOT_FOUND: ${input.workId}`);
  const at = input.updatedAt ?? options.now?.() ?? new Date().toISOString();
  const value = historicalContract({ ...record.value, ...input }, at);
  writeControlPlaneRecord(options.controllerHome, {
    namespace: 'work_contract',
    scope: scope(options),
    key: value.workId,
    schemaVersion: 4,
    value,
    action: 'test_replace_historical_work_contract',
    expectedRevision: record.revision,
  });
  return value;
}
