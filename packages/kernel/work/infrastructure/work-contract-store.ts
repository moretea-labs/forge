import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome, scopedOperationRoot } from '../../../../src/cli/repositories/controller-home';
import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../../../src/runtime/shared/json-files';
import {
  listControlPlaneRecords,
  listControlPlaneRecordsExcludingPayloadTextValues,
  initializeControlPlanePayloadTextExclusionIndex,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import {
  MAX_IMPLEMENTATION_REVIEW_HISTORY,
  authoritativeImplementationReviewVerificationEvidence,
  implementationReviewDecisionTarget,
  latestImplementationReview,
  normalizeImplementationReviewEvidence,
  validateImplementationReviewRecord,
  workRequiresImplementationReview,
  type WorkImplementationReviewRecord,
} from '../domain/implementation-review';
import { phaseIndex, suggestedActionsForStatus, transitionPhaseEvidence, validateWorkSemanticTransition, validateWorkSemantics } from '../domain/state-machine';
import {
  WORK_ADMISSION_POLICY_KEY,
  WORK_ADMISSION_POLICY_NAMESPACE,
  WORK_ADMISSION_POLICY_SCOPE,
  assertWorkAdmissionPolicyAllows,
  normalWorkAdmissionPolicy,
  type WorkAdmissionPolicy,
} from '../domain/admission-policy';
import {
  WORK_PHASES,
  type EvidenceRef,
  type CompletionOutcome,
  type DispatchState,
  type EvidenceState,
  type PolicyDecision,
  type SuggestedNextAction,
  type VerificationRecord,
  type WorkReconciliationRecord,
  type SubmittedWorkOperation,
  type WorkContract,
  type WorkContractStatus,
  type WorkSemanticView,
  type SemanticWorkState,
  type WorkRisk,
  type WorkKind,
  type WorkPhase,
  type WorkPhaseEvidence,
  type WorkPhaseEvidenceMap,
  type WorkPhaseEvidenceState,
  type WorkContractStore,
  executionPlacementForWork,
  isDirectEditWorkCompletionReceipt,
  isRepositoryCompletionReceipt,
  isTerminalWorkContractStatus,
  TERMINAL_WORK_CONTRACT_STATUSES,
  semanticScopeRefForWork,
} from '../domain/types';

import type { WorkContractStoreLocation, WorkContractStoreOptions } from '../ports/work-contract-store';
export type { WorkContractStoreLocation, WorkContractStoreOptions } from '../ports/work-contract-store';

export type CreateWorkContractInput = Omit<
  WorkContract,
  'schemaVersion' | 'status' | 'createdAt' | 'updatedAt' | 'risk' | 'workKind' | 'dispatchState' | 'evidenceState' | 'completionOutcome' | 'phase' | 'phaseEvidence' | 'completionReceipt' | 'evidenceRefs' | 'handoffRefs' | 'suggestedNextActions' | 'policyDecisions' | 'checkRefs' | 'implementationReviews' | 'reconciliations' | 'worktreePolicy' | 'evidencePolicy' | 'approvalPolicy' | 'recoveryPolicy'
> & {
  risk?: WorkRisk;
  status?: WorkContractStatus;
  createdAt?: string;
  updatedAt?: string;
  workKind?: WorkKind;
  dispatchState?: DispatchState;
  evidenceState?: EvidenceState;
  completionOutcome?: CompletionOutcome;
  phase?: WorkContract['phase'];
  completionReceipt?: WorkContract['completionReceipt'];
  evidenceRefs?: EvidenceRef[];
  handoffRefs?: string[];
  suggestedNextActions?: SuggestedNextAction[];
  policyDecisions?: PolicyDecision[];
  checkRefs?: VerificationRecord[];
  reconciliations?: WorkReconciliationRecord[];
  worktreePolicy?: WorkContract['worktreePolicy'];
  evidencePolicy?: WorkContract['evidencePolicy'];
  approvalPolicy?: WorkContract['approvalPolicy'];
  recoveryPolicy?: WorkContract['recoveryPolicy'];
};

export interface ListWorkContractOptions extends WorkContractStoreOptions {
  status?: WorkContractStatus | 'active' | 'all';
  limit?: number;
  detailLevel?: 'summary' | 'detail' | 'raw';
}

export interface InvalidActiveWorkCandidate {
  workId: string;
  updatedAt: string;
  checkoutId?: string;
  requirementId?: string;
  planId?: string;
  planStepId?: string;
  semanticScopeKeys: string[];
  isolation: 'shared' | 'isolated';
  error: string;
}

export interface ActiveWorkCandidateSnapshot {
  contracts: WorkContract[];
  invalid: InvalidActiveWorkCandidate[];
}

export interface WorkSemanticRevisionRecord extends WorkSemanticView {
  schemaVersion: 1;
  recordedAt: string;
}

export interface ReviseWorkSemanticInput {
  expectedRevision: number;
  objective?: string;
  state?: SemanticWorkState;
  requirementRevision?: number;
  planRevision?: number;
  resultRefs?: string[];
}

interface WorkSemanticRevisionStore {
  schemaVersion: 1;
  records: WorkSemanticRevisionRecord[];
}

export interface WorkContractSummary {
  workId: string;
  repoId: string;
  /** The one thin authored Work state. `phase`/`status` below are compatibility mechanical projections. */
  semanticState: SemanticWorkState;
  phase: WorkContract['phase'];
  status: WorkContractStatus;
  objective: string;
  updatedAt: string;
  handoffCount: number;
  evidenceCount: number;
  checkCount: number;
  engineering?: {
    profileVersion: string;
    riskClass: string;
    missingAdmissionEvidence: string[];
    missingCompletionEvidence: string[];
  };
}

function nowIso(options: WorkContractStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function workContractStoreScopeKey(location: WorkContractStoreLocation): string {
  const key = location.scopeKey?.trim() || location.repoId?.trim() || '';
  if (!key) throw new Error('WORK_STORE_SCOPE_REQUIRED: controllerHome requires scopeKey or repoId');
  return key;
}

export function workContractRoot(location: WorkContractStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome) {
    throw new Error('work contract store requires either root or controllerHome + scopeKey/repoId');
  }
  const root = join(scopedOperationRoot(location.controllerHome, workContractStoreScopeKey(location)), 'work-contracts');
  mkdirSync(root, { recursive: true });
  return root;
}

export function workContractStorePath(location: WorkContractStoreLocation): string {
  return join(workContractRoot(location), 'index.json');
}

export function emptyWorkContractStore(updatedAt: string): WorkContractStore {
  return { schemaVersion: 3, updatedAt, contracts: [] };
}

function currentWorkSemanticRevision(work: WorkContract): number {
  const revision = Number(work.semanticRevision);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}

/**
 * Resolve the one thin semantic Work state. An explicit authored state is
 * authoritative; a row that predates explicit semantic state derives only its
 * terminal projection from mechanically recorded completion/cancellation.
 * Execution/verification/review/delivery/cleanup vocabulary is never a semantic
 * state: a mechanically blocked or failed Work stays semantically `open` until
 * an explicit CAS close or cancellation.
 */
export function semanticWorkState(work: Pick<WorkContract, 'semanticRevision' | 'semanticState' | 'status'>): SemanticWorkState {
  if (work.semanticState === 'open' || work.semanticState === 'completed' || work.semanticState === 'cancelled') {
    return work.semanticState;
  }
  if (work.status === 'completed') return 'completed';
  if (work.status === 'cancelled') return 'cancelled';
  return 'open';
}

export function workSemanticView(work: WorkContract): WorkSemanticView {
  const resultRefs = [...new Set((work.semanticResultRefs ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
  return {
    workId: work.workId,
    revision: currentWorkSemanticRevision(work),
    semanticScope: semanticScopeRefForWork(work),
    objective: work.objective,
    state: semanticWorkState(work),
    ...(work.requirementId?.trim() ? { requirementId: work.requirementId.trim() } : {}),
    ...(Number.isInteger(work.requirementRevision) && Number(work.requirementRevision) > 0 ? { requirementRevision: Number(work.requirementRevision) } : {}),
    ...(work.planId?.trim() ? { planId: work.planId.trim() } : {}),
    ...(Number.isInteger(work.planRevision) && Number(work.planRevision) > 0 ? { planRevision: Number(work.planRevision) } : {}),
    resultRefs,
    createdAt: work.createdAt,
    updatedAt: work.semanticUpdatedAt ?? work.createdAt,
  };
}

function workSemanticRevisionKey(workId: string, revision: number): string {
  return `${sanitizeFileComponent(workId)}-r${revision}`;
}

function workSemanticRevisionStorePath(options: WorkContractStoreOptions): string {
  return join(workContractRoot(options), 'semantic-revisions.json');
}

function readWorkSemanticRevisionStore(options: WorkContractStoreOptions): WorkSemanticRevisionStore {
  return readJsonFile<WorkSemanticRevisionStore>(workSemanticRevisionStorePath(options), { schemaVersion: 1, records: [] });
}

function initialLifecycleForNewWork(status: WorkContractStatus): Pick<WorkContract, 'phase' | 'dispatchState' | 'evidenceState'> {
  if (status === 'completed') throw new Error('WORK_COMPLETION_REQUIRES_RECORD_API');
  if (status === 'running') return { phase: 'implementation', dispatchState: 'running', evidenceState: 'none' };
  if (status === 'ready') return { phase: 'verification', dispatchState: 'not_dispatched', evidenceState: 'none' };
  if (status === 'blocked') return { phase: 'implementation', dispatchState: 'blocked', evidenceState: 'none' };
  if (status === 'failed') return { phase: 'implementation', dispatchState: 'terminal', evidenceState: 'failed' };
  if (status === 'cancelled') return { phase: 'implementation', dispatchState: 'terminal', evidenceState: 'none' };
  return { phase: 'implementation', dispatchState: 'not_dispatched', evidenceState: 'none' };
}

function initialPhaseEvidenceForNewWork(
  input: Pick<WorkContract, 'phase' | 'status' | 'evidenceRefs' | 'updatedAt'>,
): WorkPhaseEvidenceMap {
  const currentIndex = phaseIndex(input.phase);
  return Object.fromEntries((['implementation', 'verification', 'review', 'delivery', 'cleanup'] as WorkPhase[]).map((phase) => {
    const index = phaseIndex(phase);
    const state: WorkPhaseEvidenceState = index < currentIndex
      ? 'satisfied'
      : index > currentIndex
        ? 'pending'
        : input.status === 'failed'
          ? 'failed'
          : input.status === 'cancelled'
            ? 'skipped'
            : input.status === 'blocked' || input.status === 'ready'
              ? 'blocked'
              : 'active';
    return [phase, {
      state,
      source: 'recorded' as const,
      summary: index < currentIndex
        ? `Canonical Work was admitted after phase ${phase}.`
        : index > currentIndex
          ? `Waiting for Work phase ${phase}.`
          : `Canonical Work admitted in ${phase} with status ${input.status}.`,
      evidenceRefs: index <= currentIndex ? input.evidenceRefs.slice(0, 20) : [],
      recordedAt: input.updatedAt,
    } satisfies WorkPhaseEvidence];
  })) as WorkPhaseEvidenceMap;
}

function legacyPhaseEvidence(
  contract: Pick<WorkContract, 'phase' | 'status' | 'evidenceRefs' | 'completionReceipt' | 'updatedAt'>,
  source: WorkPhaseEvidence['source'] = 'legacy_inferred',
): WorkPhaseEvidenceMap {
  const currentIndex = phaseIndex(contract.phase);
  const completedByReceipt = Boolean(contract.completionReceipt);
  return Object.fromEntries((['implementation', 'verification', 'review', 'delivery', 'cleanup'] as WorkPhase[]).map((phase) => {
    const index = phaseIndex(phase);
    let state: WorkPhaseEvidenceState = index < currentIndex ? 'satisfied' : index === currentIndex ? 'active' : 'pending';
    if (completedByReceipt) state = phase === 'review' ? 'skipped' : 'satisfied';
    else if (contract.status === 'failed' && phase === contract.phase) state = 'failed';
    else if (contract.status === 'cancelled' && phase === contract.phase) state = 'skipped';
    const receiptId = contract.completionReceipt && (phase === 'delivery' || phase === 'cleanup')
      ? contract.completionReceipt.receiptId
      : undefined;
    return [phase, {
      state,
      source: completedByReceipt ? 'recorded' : source,
      summary: completedByReceipt
        ? phase === 'review'
          ? `Legacy completed Work predates first-class implementation review; review phase is compatibility-skipped without synthesizing approval.`
          : `Phase ${phase} satisfied by Work completion receipt ${contract.completionReceipt!.receiptId}.`
        : index < currentIndex
          ? `Legacy Work advanced beyond ${phase}.`
          : `Legacy Work phase ${phase} is ${state}.`,
      evidenceRefs: contract.evidenceRefs.slice(0, 20),
      recordedAt: contract.updatedAt,
      ...(receiptId ? { receiptId } : {}),
    } satisfies WorkPhaseEvidence];
  })) as WorkPhaseEvidenceMap;
}

function sqliteBacked(options: WorkContractStoreOptions): options is WorkContractStoreOptions & { controllerHome: string } {
  // A caller-provided root is a test/portable compatibility store. Runtime
  // control-plane state uses one explicit scope key: semantic scope for authored
  // Work, repository scope for legacy/repository execution Work.
  return Boolean(!options.root && options.controllerHome?.trim() && (options.scopeKey?.trim() || options.repoId?.trim()));
}

function migrateLegacyWorkContract(legacy: WorkContract): WorkContract {
  const mappedStatus = ({ pending: 'open', waiting_for_review: 'ready', succeeded: 'completed' } as Record<string, WorkContractStatus>)[String(legacy.status)] ?? legacy.status;
  // Historical terminal labels without the Work-owned receipt are not
  // completion authority. Reopen them at delivery so callers can obtain an
  // exact receipt instead of projecting an unproven success.
  const status = mappedStatus === 'completed' && !legacy.completionReceipt ? 'ready' : mappedStatus;
  // Phase is a mechanical checkpoint projection only. A legacy row without a
  // persisted phase is admitted at the neutral first checkpoint; terminal
  // status never advances phase, and status is never a phase-transition authority.
  const phase = legacy.completionReceipt
    ? 'cleanup'
    : mappedStatus === 'completed'
      ? 'delivery'
      : legacy.phase ?? 'implementation';
  const legacyDefaults = legacyPhaseEvidence({
    phase,
    status,
    evidenceRefs: legacy.evidenceRefs ?? [],
    completionReceipt: legacy.completionReceipt,
    updatedAt: legacy.updatedAt,
  });
  const existingPhaseEvidence = legacy.phaseEvidence as Partial<WorkPhaseEvidenceMap> | undefined;
  const existingReview = existingPhaseEvidence?.review;
  const legacyReviewAdvancedPastCheckpoint = Boolean(
    existingReview
    && existingReview.source === 'legacy_inferred'
    && existingReview.state === 'pending'
    && phaseIndex(phase) > phaseIndex('review'),
  );
  const phaseEvidence: WorkPhaseEvidenceMap = existingPhaseEvidence
    ? {
        ...legacyDefaults,
        ...existingPhaseEvidence,
        review: existingReview
          ? legacyReviewAdvancedPastCheckpoint
            ? {
                ...existingReview,
                state: 'skipped' as const,
                summary: 'Legacy Work advanced beyond first-class implementation review before that checkpoint existed; compatibility-skipped without synthesizing Controller approval.',
              }
            : existingReview
          : {
              ...legacyDefaults.review,
              ...(phaseIndex(phase) > phaseIndex('review')
                ? {
                    state: 'skipped' as const,
                    summary: 'Legacy Work advanced beyond first-class implementation review; compatibility-skipped without synthesizing Controller approval.',
                  }
                : {}),
            },
      }
    : legacyDefaults;
  return validateWorkSemantics({
    ...legacy,
    schemaVersion: 3,
    scopeRef: semanticScopeRefForWork(legacy),
    executionPlacement: executionPlacementForWork(legacy),
    status,
    phase,
    phaseEvidence,
    risk: legacy.risk ?? 'medium',
    workKind: legacy.workKind ?? 'repository_change',
    dispatchState: legacy.dispatchState ?? 'not_dispatched',
    evidenceState: legacy.evidenceState ?? 'none',
    suggestedNextActions: suggestedActionsForStatus(status, legacy.suggestedNextActions ?? []),
    implementationReviews: legacy.implementationReviews ?? [],
    reconciliations: legacy.reconciliations ?? [],
  });
}

function validateCanonicalWorkContract(contract: WorkContract): WorkContract {
  if (contract.schemaVersion !== 3) {
    throw new Error(`WORK_CONTRACT_SCHEMA_MIGRATION_REQUIRED: ${contract.workId}:schema=${String(contract.schemaVersion)}`);
  }
  return validateWorkSemantics(contract);
}

function storedWorkContractNeedsMigration(contract: WorkContract): boolean {
  const phaseEvidence = contract.phaseEvidence as Partial<WorkPhaseEvidenceMap> | undefined;
  // Some pre-review-checkpoint rows were stamped with the current outer
  // schema while omitting only `review`. That exact historical shape remains
  // migration-compatible, but it must be persisted once rather than inferred
  // repeatedly by the normal read path.
  const legacyReviewGap = contract.schemaVersion === 3
    && phaseEvidence
    && !phaseEvidence.review
    && phaseEvidence.implementation
    && phaseEvidence.verification
    && phaseEvidence.delivery
    && phaseEvidence.cleanup;
  return contract.schemaVersion !== 3 || Boolean(legacyReviewGap);
}

function canonicalizeStoredWorkContract(contract: WorkContract): WorkContract {
  return storedWorkContractNeedsMigration(contract)
    ? migrateLegacyWorkContract(contract)
    : validateCanonicalWorkContract(contract);
}

/**
 * Normalize one row at a transaction boundary without reading or mutating a
 * second Work authority. Higher-level control-plane transactions use this to
 * validate legacy rows against the same canonical Work semantics as reads.
 */
export function canonicalizeWorkContractForAuthority(contract: WorkContract): WorkContract {
  return canonicalizeStoredWorkContract(contract);
}

function normalizeWorkContractStore(store: WorkContractStore): WorkContractStore {
  // v1/v2 compatibility is a one-way cutover. v3 records are validated as-is;
  // no current lifecycle field is inferred from status during normal reads.
  return { schemaVersion: 3, updatedAt: store.updatedAt, contracts: store.contracts.map(canonicalizeStoredWorkContract) };
}

export function readWorkContractStore(options: WorkContractStoreOptions): WorkContractStore {
  if (!sqliteBacked(options)) {
    const raw = readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options)));
    const normalized = normalizeWorkContractStore(raw);
    if (raw.schemaVersion !== 3 || raw.contracts.some(storedWorkContractNeedsMigration)) {
      writeJsonAtomic(workContractStorePath(options), normalized);
    }
    return normalized;
  }
  const records = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: workContractStoreScopeKey(options),
    limit: 5_000,
  });
  if (records.length > 0) {
    const normalized = normalizeWorkContractStore({
      schemaVersion: 3,
      updatedAt: records[0]?.updatedAt ?? nowIso(options),
      contracts: records.map((record) => record.value),
    });
    const legacyRows = records
      .map((record, index) => ({ record, contract: normalized.contracts[index]! }))
      .filter(({ record }) => storedWorkContractNeedsMigration(record.value));
    if (legacyRows.length > 0) {
      withControlPlaneTransaction(options.controllerHome, (database) => {
        for (const { record, contract } of legacyRows) {
          writeControlPlaneRecordWithinTransaction(database, {
            namespace: 'work_contract',
            scope: workContractStoreScopeKey(options),
            key: contract.workId,
            schemaVersion: 3,
            value: contract,
            action: 'work_contract_schema_v3_migrated',
            expectedRevision: record.revision,
          });
        }
      });
    }
    return normalized;
  }

  // One-time import only. Once a per-Work row exists, legacy index/file data is
  // never consulted again and is never written back.
  const legacyRecord = readControlPlaneRecord<WorkContractStore>(
    options.controllerHome,
    'work_contract_store',
    workContractStoreScopeKey(options),
    'index',
  );
  const legacy = legacyRecord?.value
    ?? readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options)));
  const normalized = normalizeWorkContractStore(legacy);
  if (normalized.contracts.length > 0) {
    withControlPlaneTransaction(options.controllerHome, (database) => {
      for (const contract of normalized.contracts) {
        if (readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', workContractStoreScopeKey(options), contract.workId)) continue;
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: workContractStoreScopeKey(options),
          key: contract.workId,
          schemaVersion: 3,
          value: contract,
          action: 'work_contract_legacy_import',
          expectedRevision: null,
        });
      }
    });
  }
  return normalized;
}

export function writeWorkContractStore(options: WorkContractStoreOptions, store: WorkContractStore): WorkContractStore {
  if (!sqliteBacked(options)) {
    writeJsonAtomic(workContractStorePath(options), store);
    return store;
  }
  withControlPlaneTransaction(options.controllerHome, (database) => {
    for (const contract of store.contracts) {
      const value = validateCanonicalWorkContract(contract);
      const current = readControlPlaneRecordWithinTransaction<WorkContract>(
        database,
        'work_contract',
        workContractStoreScopeKey(options),
        contract.workId,
      );
      // SQLite is authoritative per Work row. Aggregate-store callers may still
      // construct a complete compatibility snapshot, but unchanged siblings are
      // not authoritative mutations and must not advance revision/audit history.
      if (current && JSON.stringify(current.value) === JSON.stringify(value)) continue;
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract',
        scope: workContractStoreScopeKey(options),
        key: contract.workId,
        schemaVersion: 3,
        value,
        action: 'work_contract_write',
        expectedRevision: current?.revision ?? null,
      });
    }
  });
  return store;
}

function withWorkContractStoreWrite<T>(options: WorkContractStoreOptions, operation: () => T): T {
  if (!sqliteBacked(options)) return operation();
  return withControllerLock(
    options.controllerHome,
    { scope: 'global', resource: `work-contract-store-${sanitizeFileComponent(workContractStoreScopeKey(options))}` },
    `work-contract-store:${workContractStoreScopeKey(options)}`,
    operation,
    undefined,
    5_000,
  );
}


function assertCanonicalWorkAdmissionAllowed(
  options: WorkContractStoreOptions,
  input: { operation: 'create' | 'continue' | 'maintenance'; workId?: string },
): WorkAdmissionPolicy {
  if (!options.controllerHome) return normalWorkAdmissionPolicy(nowIso(options));
  const policy = readControlPlaneRecord<WorkAdmissionPolicy>(
    options.controllerHome,
    WORK_ADMISSION_POLICY_NAMESPACE,
    WORK_ADMISSION_POLICY_SCOPE,
    WORK_ADMISSION_POLICY_KEY,
  )?.value ?? normalWorkAdmissionPolicy(nowIso(options));
  return assertWorkAdmissionPolicyAllows(policy, input);
}

export function createWorkContract(options: WorkContractStoreOptions, input: CreateWorkContractInput): WorkContract {
  // Thin semantic Work is authored context, not admission-controlled execution.
  // Legacy/repository Work continues through the compatibility admission path.
  if (options.controllerHome && !options.scopeKey?.trim()) {
    assertCanonicalWorkAdmissionAllowed(options, { operation: 'create', workId: input.workId });
  }
  if (input.status === 'completed' || input.completionReceipt || input.completionOutcome) {
    throw new Error('WORK_COMPLETION_REQUIRES_RECORD_API');
  }
  const create = (): WorkContract => {
    const at = input.createdAt ?? input.updatedAt ?? nowIso(options);
    const workId = sanitizeFileComponent(input.workId);
    const predecessorWorkId = input.predecessorWorkId ? sanitizeFileComponent(input.predecessorWorkId) : undefined;
    if (predecessorWorkId === workId) throw new Error('WORK_PREDECESSOR_SELF_REFERENCE');
    const contract: WorkContract = validateWorkSemantics({
      schemaVersion: 3,
      workId,
      scopeRef: semanticScopeRefForWork({
        workId,
        scopeRef: input.scopeRef,
        requirementId: input.requirementId,
        planId: input.planId,
        planStepId: input.planStepId,
      }),
      executionPlacement: input.executionPlacement
        ?? (input.repoId?.trim() ? executionPlacementForWork({ repoId: input.repoId, checkoutId: input.checkoutId }) : undefined),
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      principalId: input.principalId,
      controllerInstanceId: input.controllerInstanceId,
      baseRevision: input.baseRevision,
      repositoryBaseState: input.repositoryBaseState,
      workspaceFingerprint: input.workspaceFingerprint,
      objective: input.objective.slice(0, 2_000),
      semanticRevision: 1,
      semanticUpdatedAt: input.updatedAt ?? at,
      semanticState: input.status === 'cancelled' ? 'cancelled' : 'open',
      acceptanceCriteria: (input.acceptanceCriteria ?? []).slice(0, 20).map((item) => item.slice(0, 500)),
      constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
      risk: input.risk ?? 'medium',
      engineeringContext: input.engineeringContext,
      workKind: input.workKind ?? 'repository_change',
      lifecycleRole: input.lifecycleRole ?? 'primary',
      parentWorkId: input.parentWorkId?.trim() || undefined,
      predecessorWorkId: predecessorWorkId && predecessorWorkId !== 'unknown' ? predecessorWorkId : undefined,
      supersedes: input.supersedes?.map((value) => sanitizeFileComponent(value)).filter((value) => value !== 'unknown').slice(0, 50),
      supersededBy: input.supersededBy ? sanitizeFileComponent(input.supersededBy) : undefined,
      supersessionReason: input.supersessionReason?.trim().slice(0, 500),
      dispatchState: input.dispatchState ?? initialLifecycleForNewWork(input.status ?? 'open').dispatchState,
      evidenceState: input.evidenceState ?? initialLifecycleForNewWork(input.status ?? 'open').evidenceState,
      completionOutcome: input.completionOutcome,
      phase: input.phase ?? initialLifecycleForNewWork(input.status ?? 'open').phase,
      phaseEvidence: initialPhaseEvidenceForNewWork({
        phase: input.phase ?? initialLifecycleForNewWork(input.status ?? 'open').phase,
        status: input.status ?? 'open',
        evidenceRefs: input.evidenceRefs ?? [],
        updatedAt: input.updatedAt ?? at,
      }),
      completionReceipt: input.completionReceipt,
      status: input.status ?? 'open',
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
      issueId: input.issueId,
      taskId: input.taskId,
      requirementId: input.requirementId,
      requirementRevision: input.requirementRevision,
      planId: input.planId,
      planRevision: input.planRevision,
      planStepId: input.planStepId,
      planSourceRevision: input.planSourceRevision,
      scopeSummary: input.scopeSummary?.slice(0, 1_000),
      scopeEvidence: input.scopeEvidence ? {
        initialLikelyPaths: [...new Set(input.scopeEvidence.initialLikelyPaths)].slice(0, 100),
        inspectedPaths: [...new Set(input.scopeEvidence.inspectedPaths)].slice(0, 500),
        actualChangedPaths: [...new Set(input.scopeEvidence.actualChangedPaths)].slice(0, 500),
        recordedAt: input.scopeEvidence.recordedAt,
      } : undefined,
      allowedPaths: (input.allowedPaths ?? []).slice(0, 50),
      forbiddenPaths: (input.forbiddenPaths ?? []).slice(0, 50),
      checks: (input.checks ?? []).slice(0, 30),
      worktreePolicy: input.worktreePolicy ?? {
        required: input.constraints?.requireWorktree === true || input.constraints?.workspaceMode === 'isolated',
        reason: input.constraints?.requireWorktree === true || input.constraints?.workspaceMode === 'isolated'
          ? 'Typed workspace placement requires an isolated worktree.'
          : undefined,
      },
      evidencePolicy: input.evidencePolicy ?? {
        defaultDetailLevel: 'summary',
        allowRawOptIn: true,
        maxEvidenceRefs: 20,
      },
      approvalPolicy: input.approvalPolicy ?? { required: false, reasons: [], confirmed: false },
      recoveryPolicy: input.recoveryPolicy ?? {
        allowSelfHealing: false,
        maxInfrastructureRetries: 0,
        handoffOnAmbiguity: true,
      },
      requestedBy: input.requestedBy ?? 'chatgpt',
      evidenceRefs: (input.evidenceRefs ?? []).slice(0, 20),
      handoffRefs: (input.handoffRefs ?? []).slice(0, 20),
      suggestedNextActions: (input.suggestedNextActions ?? []).slice(0, 8),
      policyDecisions: (input.policyDecisions ?? []).slice(0, 20),
      checkRefs: (input.checkRefs ?? []).slice(0, 50),
      implementationReviews: [],
      reconciliations: (input.reconciliations ?? []).slice(0, 20),
      continuationPrompt: input.continuationPrompt?.slice(0, 2_000),
      worktreeRef: input.worktreeRef,
      workerRef: input.workerRef,
      requestId: input.requestId?.trim() || undefined,
      submittedOperation: input.submittedOperation,
    });

    if (sqliteBacked(options)) {
      withControlPlaneTransaction(options.controllerHome, (database) => {
        if (readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', workContractStoreScopeKey(options), contract.workId)) {
          throw new Error(`work contract already exists: ${contract.workId}`);
        }
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: workContractStoreScopeKey(options),
          key: contract.workId,
          schemaVersion: 3,
          value: contract,
          action: 'work_contract_created',
          expectedRevision: null,
        });
      });
      return contract;
    }
    const store = readWorkContractStore(options);
    if (store.contracts.some((existing) => existing.workId === contract.workId)) {
      throw new Error(`work contract already exists: ${contract.workId}`);
    }
    const nextStore: WorkContractStore = {
      schemaVersion: 3,
      updatedAt: contract.updatedAt,
      contracts: [contract, ...store.contracts],
    };
    writeWorkContractStore(options, nextStore);
    return contract;
  };
  return create();
}

interface WorkRequestIndexRecord {
  requestId: string;
  repoId: string;
  workId: string;
  semanticKey: string;
  createdAt: string;
}

function workRequestIndexPath(controllerHome: string, requestId: string): string {
  const hash = createHash('sha256').update(requestId).digest('hex');
  const root = join(ensureControllerHome(controllerHome), 'indexes', 'work-contracts', 'requests');
  mkdirSync(root, { recursive: true });
  return join(root, `${hash}.json`);
}

export function getWorkContractByRequestId(
  controllerHome: string,
  requestId: string,
  expectedRepoId?: string,
): WorkContract | undefined {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) return undefined;
  const recordPath = workRequestIndexPath(controllerHome, normalizedRequestId);
  if (!existsSync(recordPath)) return undefined;
  try {
    const record = readJsonFile<WorkRequestIndexRecord>(recordPath);
    if (record.requestId !== normalizedRequestId) return undefined;
    if (expectedRepoId && record.repoId !== expectedRepoId) return undefined;
    return getWorkContract({ controllerHome, repoId: record.repoId }, record.workId);
  } catch {
    return undefined;
  }
}

/**
 * Create or reuse the execution-child Work used by typed callers. This is not
 * a generic MCP submission authority and never creates an ExecutionJob.
 */
export function acceptSubmittedWorkContract(
  controllerHome: string,
  input: AcceptSubmittedWorkInput,
  options: WorkContractStoreOptions = {},
): { contract: WorkContract; deduplicated: boolean } {
  const home = ensureControllerHome(controllerHome);
  const requestId = input.requestId.trim();
  const semanticKey = input.semanticKey.trim();
  if (!requestId) throw new Error('INVALID_ARGUMENT: typed execution is missing request_id');
  if (!semanticKey) throw new Error('INVALID_ARGUMENT: typed execution requires a semantic operation key');
  if (!input.repoId.trim()) throw new Error('INVALID_ARGUMENT: typed execution is missing repo_id');
  if (!input.operation?.name?.trim()) throw new Error('INVALID_ARGUMENT: typed execution is missing operation');
  const parentWorkId = input.parentWorkId?.trim() || undefined;
  if (parentWorkId) {
    const parent = getWorkContract({ controllerHome: home, repoId: input.repoId, now: options.now }, parentWorkId);
    if (!parent) throw new Error(`PARENT_WORK_NOT_FOUND: ${parentWorkId}`);
    if (isTerminalWorkContractStatus(parent.status)) throw new Error(`PARENT_WORK_TERMINAL: ${parentWorkId}:${parent.status}`);
    if ((parent.lifecycleRole ?? 'primary') !== 'primary') throw new Error(`PARENT_WORK_NOT_PRIMARY: ${parentWorkId}`);
  }
  const lockId = createHash('sha256').update(requestId).digest('hex').slice(0, 24);
  return withControllerLock(home, { scope: 'global', resource: `work-request-${lockId}` }, `accept-work:${requestId}`, () => {
    const recordPath = workRequestIndexPath(home, requestId);
    if (existsSync(recordPath)) {
      const record = readJsonFile<WorkRequestIndexRecord>(recordPath);
      if (record.repoId !== input.repoId) throw new Error(`REQUEST_ID_REPO_CONFLICT: ${requestId} already belongs to repository ${record.repoId}`);
      if (record.semanticKey !== semanticKey) throw new Error(`REQUEST_ID_CONFLICT: ${requestId} already belongs to ${record.semanticKey}`);
      const existing = getWorkContract({ controllerHome: home, repoId: record.repoId, now: options.now }, record.workId);
      if (!existing) throw new Error(`WORK_ACCEPTANCE_LOST: request ${requestId} is indexed without a readable WorkContract`);
      return { contract: existing, deduplicated: true };
    }
    const contract = createWorkContract({ controllerHome: home, repoId: input.repoId, now: options.now }, {
      workId: `WORK-${Date.now()}-${randomUUID().slice(0, 8)}`,
      repoId: input.repoId,
      principalId: input.principalId,
      controllerInstanceId: input.controllerInstanceId,
      lifecycleRole: 'execution_child',
      parentWorkId,
      objective: (input.objective ?? `Typed operation ${input.operation.name}`).slice(0, 2_000),
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      workKind: input.workKind,
      risk: input.risk,
      constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
      allowedPaths: input.allowedPaths ?? [],
      forbiddenPaths: input.forbiddenPaths ?? [],
      checks: input.checks ?? [],
      requestedBy: input.requestedBy ?? 'chatgpt',
      status: 'open',
      requestId,
      submittedOperation: input.operation,
      suggestedNextActions: [{
        label: 'Claim controller ownership',
        tool: 'rh_work',
        operation: 'controller_claim',
        risk: 'readonly',
        confidence: 'high',
        reason: 'Claim this Work before launching an external SuperController or Process Runtime command.',
      }],
    });
    writeJsonAtomic(recordPath, { requestId, repoId: input.repoId, workId: contract.workId, semanticKey, createdAt: contract.createdAt } satisfies WorkRequestIndexRecord);
    return { contract, deduplicated: false };
  });
}

export function isCurrentWorkContract(contract: WorkContract): boolean {
  return semanticWorkState(contract) === 'open'
    && !contract.supersededBy?.trim()
    && contract.workKind !== 'superseded'
    && contract.completionOutcome !== 'superseded';
}

export function listWorkContracts(options: ListWorkContractOptions): WorkContract[] {
  const status = options.status ?? 'active';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  if (status === 'active' && sqliteBacked(options)) {
    const active = readActiveWorkCandidates({ ...options, limit });
    if (active.invalid.length > 0) {
      // Preserve the aggregate list API's fail-closed semantics. Callers that
      // intentionally need row-isolated corruption diagnostics use
      // readActiveWorkCandidates() directly and can inspect every invalid row.
      throw new Error(active.invalid[0]!.error);
    }
    return active.contracts;
  }
  const store = readWorkContractStore(options);
  return store.contracts
    .filter((contract) => {
      if (status === 'all') return true;
      if (status === 'active') return isCurrentWorkContract(contract);
      return contract.status === status;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

function workExecutionSemanticScopeKeys(contract: WorkContract): string[] {
  const declared = contract.engineeringContext?.semanticScope?.keys
    ?.map((value) => value.trim())
    .filter(Boolean) ?? [];
  if (declared.length > 0) return [...new Set(declared)].sort();
  if (contract.planId?.trim() && contract.planStepId?.trim()) {
    return [`plan-step:${contract.planId.trim()}:${contract.planStepId.trim()}`];
  }
  return [`work:${contract.workId}`];
}

function workExecutionIsolation(contract: WorkContract): 'shared' | 'isolated' {
  return contract.worktreePolicy?.required === true
    || contract.constraints?.workspaceMode === 'isolated'
    || contract.constraints?.requireWorktree === true
    ? 'isolated'
    : 'shared';
}

function rawWorkMayBeCurrent(contract: WorkContract): boolean {
  return semanticWorkState(contract) === 'open'
    && !contract.supersededBy?.trim()
    && contract.workKind !== 'superseded'
    && contract.completionOutcome !== 'superseded';
}

/**
 * Row-isolated active Work admission projection. Canonical aggregate Work reads
 * remain strict. Each SQLite row is normalized independently so one malformed
 * legacy sibling cannot erase otherwise valid Work authority from control-plane
 * admission. Invalid active rows stay explicit and conservative by identity,
 * lineage, scope and isolation; they are never mutated or silently accepted.
 */
export function initializeWorkCandidateIndex(controllerHome: string): void {
  initializeControlPlanePayloadTextExclusionIndex(controllerHome, {
    namespace: 'work_contract', field: 'status', excludedValues: TERMINAL_WORK_CONTRACT_STATUSES,
  });
}

export function readActiveWorkCandidates(
  options: WorkContractStoreOptions & { limit?: number },
): ActiveWorkCandidateSnapshot {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 1_000), 1_000));
  if (!sqliteBacked(options)) {
    return { contracts: listWorkContracts({ ...options, status: 'active', limit }), invalid: [] };
  }
  const records = listControlPlaneRecordsExcludingPayloadTextValues<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: workContractStoreScopeKey(options),
    field: 'status',
    excludedValues: TERMINAL_WORK_CONTRACT_STATUSES,
    limit: 5_000,
  });
  const contracts: WorkContract[] = [];
  const invalid: InvalidActiveWorkCandidate[] = [];
  const migrations: Array<{ record: (typeof records)[number]; contract: WorkContract }> = [];
  for (const record of records) {
    const raw = record.value;
    if (!rawWorkMayBeCurrent(raw)) continue;
    try {
      const normalized = canonicalizeStoredWorkContract(raw);
      if (storedWorkContractNeedsMigration(raw)) migrations.push({ record, contract: normalized });
      if (isCurrentWorkContract(normalized)) contracts.push(normalized);
    } catch (error) {
      invalid.push({
        workId: raw.workId,
        updatedAt: raw.updatedAt,
        ...(raw.checkoutId?.trim() ? { checkoutId: raw.checkoutId.trim() } : {}),
        ...(raw.requirementId?.trim() ? { requirementId: raw.requirementId.trim() } : {}),
        ...(raw.planId?.trim() ? { planId: raw.planId.trim() } : {}),
        ...(raw.planStepId?.trim() ? { planStepId: raw.planStepId.trim() } : {}),
        semanticScopeKeys: workExecutionSemanticScopeKeys(raw),
        isolation: workExecutionIsolation(raw),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (migrations.length > 0) {
    withControlPlaneTransaction(options.controllerHome, (database) => {
      for (const { record, contract } of migrations) {
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: workContractStoreScopeKey(options),
          key: contract.workId,
          schemaVersion: 3,
          value: contract,
          action: 'work_contract_schema_v3_migrated',
          expectedRevision: record.revision,
        });
      }
    });
  }
  contracts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  invalid.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { contracts: contracts.slice(0, limit), invalid };
}

export function listWorkSemanticRevisionRecords(
  options: WorkContractStoreOptions,
  workId?: string,
  limit = 200,
): WorkSemanticRevisionRecord[] {
  const normalizedId = workId ? sanitizeFileComponent(workId) : undefined;
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
  const records = sqliteBacked(options)
    ? listControlPlaneRecords<WorkSemanticRevisionRecord>(options.controllerHome, {
        namespace: 'work_semantic_revision', scope: workContractStoreScopeKey(options), limit: 5_000,
      }).map((record) => record.value)
    : readWorkSemanticRevisionStore(options).records;
  return records
    .filter((record) => !normalizedId || record.workId === normalizedId)
    .map((record) => ({
      ...record,
      semanticScope: record.semanticScope ?? semanticScopeRefForWork({
        workId: record.workId,
        requirementId: record.requirementId,
        planId: record.planId,
        planStepId: undefined,
      }),
    }))
    .sort((left, right) => right.revision - left.revision)
    .slice(0, boundedLimit);
}

export function reviseWorkSemanticContext(
  options: WorkContractStoreOptions,
  workIdInput: string,
  input: ReviseWorkSemanticInput,
): WorkContract {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('WORK_EXPECTED_REVISION_INVALID');
  return withWorkContractStoreWrite(options, () => {
    const workId = sanitizeFileComponent(workIdInput);
    const applyRevision = (current: WorkContract, at: string): WorkContract => {
      const semanticRevision = currentWorkSemanticRevision(current);
      if (semanticRevision !== input.expectedRevision) {
        throw new Error(`WORK_REVISION_CONFLICT:${workId}:expected=${input.expectedRevision}:actual=${semanticRevision}`);
      }
      const currentSemanticState = semanticWorkState(current);
      if (currentSemanticState !== 'open' && input.state === 'open') {
        throw new Error(`WORK_SEMANTIC_REOPEN_FORBIDDEN:${workId}:${currentSemanticState}`);
      }
      const objective = input.objective === undefined ? current.objective : String(input.objective).trim().slice(0, 2_000);
      if (!objective) throw new Error('WORK_OBJECTIVE_REQUIRED');
      const positiveRevision = (value: number | undefined, code: string): number | undefined => {
        if (value === undefined) return undefined;
        if (!Number.isInteger(value) || value < 1) throw new Error(code);
        return value;
      };
      const nextSemanticState = input.state ?? currentSemanticState;
      return validateWorkSemantics({
        ...current,
        objective,
        semanticRevision: semanticRevision + 1,
        semanticUpdatedAt: at,
        semanticState: nextSemanticState,
        ...(nextSemanticState === 'completed' || nextSemanticState === 'cancelled'
          ? { status: nextSemanticState as 'completed' | 'cancelled' }
          : {}),
        ...(input.requirementRevision !== undefined ? { requirementRevision: positiveRevision(input.requirementRevision, 'WORK_REQUIREMENT_REVISION_INVALID') } : {}),
        ...(input.planRevision !== undefined ? { planRevision: positiveRevision(input.planRevision, 'WORK_PLAN_REVISION_INVALID') } : {}),
        ...(input.resultRefs !== undefined ? { semanticResultRefs: [...new Set(input.resultRefs.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 100) } : {}),
        updatedAt: at,
      });
    };

    if (sqliteBacked(options)) {
      return withControlPlaneTransaction(options.controllerHome, (database) => {
        const currentRecord = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', workContractStoreScopeKey(options), workId);
        if (!currentRecord) throw new Error(`work contract not found: ${workId}`);
        const current = canonicalizeStoredWorkContract(currentRecord.value);
        const at = nowIso(options);
        const next = applyRevision(current, at);
        const semanticRevision = currentWorkSemanticRevision(current);
        const revisionKey = workSemanticRevisionKey(workId, semanticRevision);
        if (!readControlPlaneRecordWithinTransaction<WorkSemanticRevisionRecord>(database, 'work_semantic_revision', workContractStoreScopeKey(options), revisionKey)) {
          writeControlPlaneRecordWithinTransaction(database, {
            namespace: 'work_semantic_revision', scope: workContractStoreScopeKey(options), key: revisionKey, schemaVersion: 1,
            value: { schemaVersion: 1, ...workSemanticView(current), recordedAt: at },
            action: 'work_semantic_revision_archived', expectedRevision: null,
          });
        }
        return writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract', scope: workContractStoreScopeKey(options), key: workId, schemaVersion: 3,
          value: next, action: 'work_semantic_revised', expectedRevision: currentRecord.revision,
        }).value;
      });
    }

    const store = readWorkContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.workId === workId);
    if (index < 0) throw new Error(`work contract not found: ${workId}`);
    const current = store.contracts[index]!;
    const at = nowIso(options);
    const next = applyRevision(current, at);
    const archived = { schemaVersion: 1 as const, ...workSemanticView(current), recordedAt: at };
    const history = readWorkSemanticRevisionStore(options);
    if (!history.records.some((record) => record.workId === workId && record.revision === archived.revision)) {
      writeJsonAtomic(workSemanticRevisionStorePath(options), { schemaVersion: 1, records: [...history.records, archived].slice(-5_000) });
    }
    const contracts = [...store.contracts];
    contracts[index] = next;
    writeWorkContractStore(options, { schemaVersion: 3, updatedAt: at, contracts });
    return next;
  });
}

export function getWorkContract(options: WorkContractStoreOptions, workId: string): WorkContract | undefined {
  const sanitizedId = sanitizeFileComponent(workId);
  if (!sqliteBacked(options)) {
    return readWorkContractStore(options).contracts.find((contract) => contract.workId === sanitizedId);
  }
  const exact = readControlPlaneRecord<WorkContract>(options.controllerHome, 'work_contract', workContractStoreScopeKey(options), sanitizedId);
  if (exact) {
    const canonical = canonicalizeStoredWorkContract(exact.value);
    if (storedWorkContractNeedsMigration(exact.value)) {
      withControlPlaneTransaction(options.controllerHome, (database) => {
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: workContractStoreScopeKey(options),
          key: canonical.workId,
          schemaVersion: 3,
          value: canonical,
          action: 'work_contract_schema_v3_migrated',
          expectedRevision: exact.revision,
        });
      });
    }
    return canonical;
  }
  // Preserve the one-time legacy import path only while this repository has no
  // per-Work rows. Once any per-Work row exists, absence of this exact key is
  // authoritative and unrelated rows must never be normalized for an exact get.
  const hasPerWorkRows = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: workContractStoreScopeKey(options),
    limit: 1,
  }).length > 0;
  if (hasPerWorkRows) return undefined;
  return readWorkContractStore(options).contracts.find((contract) => contract.workId === sanitizedId);
}

export interface SupersedeWorkContractInput {
  workId: string;
  supersededBy: string;
  reason: string;
}

function workSupersessionWouldCycle(contracts: WorkContract[], predecessorId: string, successorId: string): boolean {
  const byId = new Map(contracts.map((contract) => [contract.workId, contract]));
  const visited = new Set<string>();
  let cursorId: string | undefined = successorId;
  while (cursorId) {
    if (cursorId === predecessorId) return true;
    if (visited.has(cursorId)) return true;
    visited.add(cursorId);
    cursorId = byId.get(cursorId)?.supersededBy?.trim() || undefined;
  }
  return false;
}

/** Persist one explicit Work supersession edge without deleting or terminalizing either side. */
export function supersedeWorkContract(
  options: WorkContractStoreOptions,
  input: SupersedeWorkContractInput,
): { predecessor: WorkContract; successor: WorkContract } {
  return withWorkContractStoreWrite(options, () => {
    const predecessorId = sanitizeFileComponent(input.workId);
    const successorId = sanitizeFileComponent(input.supersededBy);
    if (!predecessorId || predecessorId === 'unknown' || !successorId || successorId === 'unknown') throw new Error('WORK_SUPERSESSION_IDS_REQUIRED');
    if (predecessorId === successorId) throw new Error('WORK_SUCCESSOR_ID_MUST_CHANGE');
    const store = readWorkContractStore(options);
    const predecessorIndex = store.contracts.findIndex((contract) => contract.workId === predecessorId);
    const successorIndex = store.contracts.findIndex((contract) => contract.workId === successorId);
    if (predecessorIndex < 0) throw new Error(`WORK_PREDECESSOR_NOT_FOUND: ${predecessorId}`);
    if (successorIndex < 0) throw new Error(`WORK_SUCCESSOR_NOT_FOUND: ${successorId}`);
    const predecessor = store.contracts[predecessorIndex]!;
    const successor = store.contracts[successorIndex]!;
    if (predecessor.supersededBy && predecessor.supersededBy !== successorId) throw new Error(`WORK_SUPERSESSION_CONFLICT: ${predecessorId}:existing=${predecessor.supersededBy}:requested=${successorId}`);
    if ((predecessor.supersedes ?? []).includes(successorId) || workSupersessionWouldCycle(store.contracts, predecessorId, successorId)) throw new Error(`WORK_SUPERSESSION_CYCLE: ${predecessorId}:${successorId}`);
    const at = nowIso(options);
    const reason = String(input.reason ?? '').trim().slice(0, 500);
    if (!reason) throw new Error('WORK_SUPERSESSION_REASON_REQUIRED');
    const predecessorNext = validateWorkSemantics({ ...predecessor, supersededBy: successorId, supersessionReason: reason, updatedAt: at });
    const successorNext = validateWorkSemantics({ ...successor, supersedes: [...new Set([...(successor.supersedes ?? []), predecessorId])], updatedAt: at });
    const contracts = [...store.contracts];
    contracts[predecessorIndex] = predecessorNext;
    contracts[successorIndex] = successorNext;
    if (!sqliteBacked(options)) {
      writeJsonAtomic(workContractStorePath(options), { schemaVersion: 3, updatedAt: at, contracts });
    } else {
      withControlPlaneTransaction(options.controllerHome, (database) => {
        for (const contract of [predecessorNext, successorNext]) {
          const current = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', workContractStoreScopeKey(options), contract.workId);
          if (!current) throw new Error(`WORK_LINEAGE_RECORD_MISSING: ${contract.workId}`);
          writeControlPlaneRecordWithinTransaction(database, { namespace: 'work_contract', scope: workContractStoreScopeKey(options), key: contract.workId, schemaVersion: 3, value: contract, action: 'work_contract_supersession_linked', expectedRevision: current.revision });
        }
      });
    }
    return { predecessor: predecessorNext, successor: successorNext };
  });
}

export function summarizeWorkContract(contract: WorkContract): WorkContractSummary {
  return {
    workId: contract.workId,
    repoId: contract.repoId,
    semanticState: semanticWorkState(contract),
    phase: contract.phase,
    status: contract.status,
    objective: contract.objective.slice(0, 240),
    updatedAt: contract.updatedAt,
    handoffCount: contract.handoffRefs.length,
    evidenceCount: contract.evidenceRefs.length,
    checkCount: contract.checkRefs.length,
    ...(contract.engineeringContext ? {
      engineering: {
        profileVersion: contract.engineeringContext.profileVersion,
        riskClass: contract.engineeringContext.riskClass,
        missingAdmissionEvidence: contract.engineeringContext.missingAdmissionEvidence,
        missingCompletionEvidence: contract.engineeringContext.missingCompletionEvidence,
      },
    } : {}),
  };
}

type WorkContractMutationPatch = Partial<Omit<WorkContract, 'schemaVersion' | 'workId' | 'repoId' | 'createdAt'>>;
type WorkContractMutation = WorkContractMutationPatch | ((current: WorkContract, recordedAt: string) => WorkContractMutationPatch | undefined);

function updateWorkContractInternal(
  options: WorkContractStoreOptions,
  workId: string,
  mutation: WorkContractMutation,
  allowCompletionWrite: boolean,
  allowLifecycleWrite = false,
  allowRetainedCancelledResume = false,
  allowImplementationReviewWrite = false,
  allowPhaseRegression = false,
): WorkContract {
  return withWorkContractStoreWrite(options, () => {
    const sanitizedId = sanitizeFileComponent(workId);
    const exact = sqliteBacked(options)
      ? readControlPlaneRecord<WorkContract>(options.controllerHome, 'work_contract', workContractStoreScopeKey(options), sanitizedId)
      : undefined;
    const store = exact ? undefined : readWorkContractStore(options);
    const index = store?.contracts.findIndex((contract) => contract.workId === sanitizedId) ?? -1;
    if (!exact && index < 0) throw new Error(`work contract not found: ${sanitizedId}`);
    const at = nowIso(options);
    // A per-Work SQLite row is the mutable authority.  Do not normalize every
    // sibling just to update this row: malformed historical evidence must stay
    // visible and fenced, but cannot prevent a different terminal Work from
    // recording its physical cleanup.
    const current = exact
      ? canonicalizeStoredWorkContract(exact.value)
      : store!.contracts[index]!;
    const patch = typeof mutation === 'function' ? mutation(current, at) : mutation;
    if (!patch) return current;
    if (options.controllerHome) {
      assertCanonicalWorkAdmissionAllowed(options, {
        operation: patch.status !== undefined && isTerminalWorkContractStatus(patch.status)
          ? 'maintenance'
          : 'continue',
        workId: sanitizedId,
      });
    }
    const writesCompletionReceipt = Object.prototype.hasOwnProperty.call(patch, 'completionReceipt');
    const changesCompletionOutcome = patch.completionOutcome !== undefined && patch.completionOutcome !== current.completionOutcome;
    const writesPhase = Object.prototype.hasOwnProperty.call(patch, 'phase') || Object.prototype.hasOwnProperty.call(patch, 'phaseEvidence');
    const writesLifecycle = writesPhase
      || Object.prototype.hasOwnProperty.call(patch, 'status')
      || Object.prototype.hasOwnProperty.call(patch, 'dispatchState')
      || Object.prototype.hasOwnProperty.call(patch, 'evidenceState')
      || Object.prototype.hasOwnProperty.call(patch, 'workKind');
    const writesImplementationReviews = Object.prototype.hasOwnProperty.call(patch, 'implementationReviews');
    if (!allowLifecycleWrite && writesLifecycle) throw new Error('WORK_LIFECYCLE_REQUIRES_TRANSITION_API');
    if (!allowImplementationReviewWrite && writesImplementationReviews) throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRES_RECORD_API');
    const projectedPhase = patch.phase ?? current.phase;
    const projectedPhaseEvidence = patch.phaseEvidence ?? current.phaseEvidence;
    if (!allowCompletionWrite && (writesCompletionReceipt || changesCompletionOutcome || (patch.status === 'completed' && current.status !== 'completed'))) {
      throw new Error('WORK_COMPLETION_REQUIRES_RECORD_API');
    }
    if (patch.status === 'completed' && !current.completionReceipt && !patch.completionReceipt) {
      throw new Error('WORK_COMPLETION_RECEIPT_REQUIRED');
    }
    if (writesCompletionReceipt && patch.completionReceipt === undefined && current.completionReceipt) {
      throw new Error('WORK_COMPLETION_RECEIPT_IMMUTABLE');
    }
    const next: WorkContract = validateWorkSemanticTransition(current, validateWorkSemantics({
    ...current,
    ...patch,
    schemaVersion: 3,
    workId: current.workId,
    repoId: current.repoId,
    createdAt: current.createdAt,
    updatedAt: at,
    risk: patch.risk ?? current.risk,
    workKind: patch.workKind ?? current.workKind,
    phase: projectedPhase,
    phaseEvidence: projectedPhaseEvidence,
    dispatchState: patch.dispatchState ?? current.dispatchState,
    evidenceState: patch.evidenceState ?? current.evidenceState,
    completionOutcome: patch.completionOutcome ?? current.completionOutcome,
    evidenceRefs: (patch.evidenceRefs ?? current.evidenceRefs).slice(0, current.evidencePolicy.maxEvidenceRefs),
    handoffRefs: (patch.handoffRefs ?? current.handoffRefs).slice(0, 20),
    suggestedNextActions: suggestedActionsForStatus(patch.status ?? current.status, patch.suggestedNextActions ?? current.suggestedNextActions),
    policyDecisions: (patch.policyDecisions ?? current.policyDecisions).slice(0, 20),
    checkRefs: (patch.checkRefs ?? current.checkRefs).slice(0, 50),
    implementationReviews: (patch.implementationReviews ?? current.implementationReviews ?? []).slice(-MAX_IMPLEMENTATION_REVIEW_HISTORY),
    reconciliations: (patch.reconciliations ?? current.reconciliations ?? []).slice(0, 20),
    objective: (patch.objective ?? current.objective).slice(0, 2_000),
    continuationPrompt: (patch.continuationPrompt ?? current.continuationPrompt)?.slice(0, 2_000),
    }), { allowRetainedCancelledResume, allowPhaseRegression });
    if (exact && sqliteBacked(options)) {
      withControlPlaneTransaction(options.controllerHome, (database) => {
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: workContractStoreScopeKey(options),
          key: next.workId,
          schemaVersion: 3,
          value: next,
          action: 'work_contract_updated',
          expectedRevision: exact.revision,
        });
      });
      return next;
    }
    const contracts = [...store!.contracts];
    contracts[index] = next;
    writeWorkContractStore(options, { schemaVersion: 3, updatedAt: at, contracts });
    return next;
  });
}


/**
 * Build the only permitted in-place Plan rebind for an active Work: the same
function cancellationPhaseEvidence(
  current: WorkContract,
  input: { summary: string; evidenceRefs?: EvidenceRef[]; recordedAt: string },
): WorkPhaseEvidenceMap {
  const evidenceRefs = (input.evidenceRefs ?? current.evidenceRefs).slice(0, current.evidencePolicy.maxEvidenceRefs);
  const existing = current.phaseEvidence[current.phase];
  if (!['pending', 'active'].includes(existing.state)) return current.phaseEvidence;
  return {
    ...current.phaseEvidence,
    [current.phase]: {
      state: 'skipped',
      source: 'recorded',
      summary: input.summary.trim().slice(0, 1_000) || 'Work cancelled.',
      evidenceRefs,
      recordedAt: input.recordedAt,
    },
  };
}

/**
 * Retire technical Work authority when its owning Plan is no longer current.
 *
 * This is authority retirement, not history deletion. The cancelled Work and
 * its evidence stay durable for audit/recovery/retention, while status and
 * dispatch become terminal immediately so schedulers, concurrency admission,
 * and UI current-state projections cannot keep executing an obsolete Plan.
 */
function cancellationPhaseEvidence(
  current: WorkContract,
  input: { summary: string; evidenceRefs?: EvidenceRef[]; recordedAt: string },
): WorkPhaseEvidenceMap {
  const evidenceRefs = (input.evidenceRefs ?? current.evidenceRefs).slice(0, current.evidencePolicy.maxEvidenceRefs);
  const existing = current.phaseEvidence[current.phase];
  if (!['pending', 'active'].includes(existing.state)) return current.phaseEvidence;
  return {
    ...current.phaseEvidence,
    [current.phase]: {
      state: 'skipped',
      source: 'recorded',
      summary: input.summary.trim().slice(0, 1_000) || 'Work cancelled.',
      evidenceRefs,
      recordedAt: input.recordedAt,
    },
  };
}

export type WorkContractMetadataPatch = Partial<Omit<
  WorkContract,
  | 'schemaVersion'
  | 'workId'
  | 'repoId'
  | 'createdAt'
  | 'updatedAt'
  | 'status'
  | 'phase'
  | 'phaseEvidence'
  | 'dispatchState'
  | 'evidenceState'
  | 'completionReceipt'
  | 'completionOutcome'
  | 'implementationReviews'
  | 'workKind'
>>;

export function updateWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  patch: WorkContractMetadataPatch,
): WorkContract {
  return updateWorkContractInternal(options, workId, patch, false);
}

/** Explicit semantic transition used only when an effect Work begins governed repository mutation. */
export function promoteWorkToRepositoryChange(
  options: WorkContractStoreOptions,
  workId: string,
): WorkContract {
  return updateWorkContractInternal(options, workId, (current) => {
    if (isTerminalWorkContractStatus(current.status) || current.completionReceipt || current.completionOutcome) {
      throw new Error(`WORK_KIND_PROMOTION_TERMINAL: ${workId}`);
    }
    if (current.workKind === 'repository_change') return undefined;
    if (current.workKind !== 'local_effect' && current.workKind !== 'remote_effect') {
      throw new Error(`WORK_KIND_PROMOTION_INVALID: ${workId}:${current.workKind}`);
    }
    return { workKind: 'repository_change' };
  }, false, true);
}

export function recordWorkEvidenceState(
  options: WorkContractStoreOptions,
  workId: string,
  evidenceState: EvidenceState,
): WorkContract {
  return updateWorkContractInternal(options, workId, { evidenceState }, false, true);
}

export function activateWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  input: {
    summary: string;
    phase?: WorkPhase;
    worktreeRef?: string;
    evidenceState?: EvidenceState;
  },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new Error(`WORK_ACTIVATION_TERMINAL: ${workId}:${current.status}`);
    }
    const phase = input.phase ?? current.phase;
    const phaseEvidence = transitionPhaseEvidence(current, phase, {
      status: 'running',
      summary: input.summary,
      recordedAt: at,
      source: 'recorded',
    });
    const evidenceState = input.evidenceState
      ?? (current.evidenceState === 'failed' ? 'partial' : current.evidenceState);
    return {
      status: 'running',
      phase,
      phaseEvidence,
      dispatchState: 'running',
      evidenceState,
      worktreeRef: input.worktreeRef ?? current.worktreeRef,
    };
  }, false, true, false, false, true);
}

export function failWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  input: { phase: WorkPhase; summary: string; evidenceRefs?: EvidenceRef[] },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new Error(`WORK_FAILURE_TERMINAL: ${workId}:${current.status}`);
    }
    if (input.phase !== current.phase) {
      throw new Error(`WORK_FAILURE_PHASE_MISMATCH: ${workId}:expected=${current.phase}:actual=${input.phase}`);
    }
    const phaseEvidence = transitionPhaseEvidence(current, current.phase, {
      status: 'failed',
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
      recordedAt: at,
      source: 'recorded',
    });
    return {
      status: 'failed',
      phase: current.phase,
      phaseEvidence,
      dispatchState: 'terminal',
      evidenceState: 'failed',
      ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
    };
  }, false, true);
}

export function cancelWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  input: { summary: string; evidenceRefs?: EvidenceRef[] },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (current.status === 'completed') throw new Error(`WORK_CANCEL_COMPLETED: ${workId}`);
    if (current.status === 'cancelled') return undefined;
    const phaseEvidence = cancellationPhaseEvidence(current, {
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
      recordedAt: at,
    });
    return {
      status: 'cancelled',
      phase: current.phase,
      phaseEvidence,
      dispatchState: 'terminal',
      ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      suggestedNextActions: [],
    };
  }, false, true);
}

/**
 * Record verified physical cleanup for an already-cancelled Work without
 * inventing semantic success. Phases that never ran are skipped, while prior
 * satisfied/skipped/blocked/failed evidence remains immutable. The cleanup
 * receipt is the authority for the only newly satisfied phase.
 */
export function recordCancelledWorkCleanupCompleted(
  options: WorkContractStoreOptions,
  workId: string,
  input: { summary: string; receiptId: string; evidenceRefs?: EvidenceRef[] },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (current.status !== 'cancelled') {
      throw new Error(`WORK_CANCELLED_CLEANUP_STATUS_REQUIRED: ${workId}:${current.status}`);
    }
    const summary = input.summary.trim().slice(0, 1_000);
    if (!summary) throw new Error('WORK_CANCELLED_CLEANUP_SUMMARY_REQUIRED');
    const receiptId = input.receiptId.trim();
    if (!receiptId) throw new Error('WORK_CANCELLED_CLEANUP_RECEIPT_REQUIRED');
    const evidenceRefs = (input.evidenceRefs ?? current.evidenceRefs).slice(0, current.evidencePolicy.maxEvidenceRefs);
    const phaseEvidence: WorkPhaseEvidenceMap = { ...current.phaseEvidence };
    for (const phase of WORK_PHASES) {
      if (phase === 'cleanup') continue;
      const existing = phaseEvidence[phase];
      if (!['pending', 'active'].includes(existing.state)) continue;
      phaseEvidence[phase] = {
        state: 'skipped',
        source: 'recorded',
        summary: `Skipped after Work cancellation: ${summary}`.slice(0, 1_000),
        evidenceRefs,
        recordedAt: at,
      };
    }
    phaseEvidence.cleanup = {
      state: 'satisfied',
      source: 'recorded',
      summary,
      evidenceRefs,
      recordedAt: at,
      receiptId,
    };
    return {
      phase: 'cleanup',
      phaseEvidence,
      dispatchState: 'terminal',
      evidenceRefs,
      suggestedNextActions: [],
    };
  }, false, true);
}

/**
 * Reopen one explicitly retained cancelled repository Work after the facade has
 * reauthenticated the same principal and revalidated physical Work ownership.
 * Generic mutation APIs intentionally cannot perform terminal -> running.
 */
export function resumeRetainedCancelledWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  input: {
    principalId: string;
    controllerInstanceId: string;
    summary: string;
    checkoutId?: string;
    worktreeRef?: string;
  },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (current.status !== 'cancelled' || current.dispatchState !== 'terminal') {
      throw new Error(`WORK_CANCELLED_RESUME_STATUS_INVALID: ${workId}`);
    }
    if (current.workKind !== 'repository_change') throw new Error(`WORK_CANCELLED_RESUME_KIND_INVALID: ${workId}`);
    if (current.completionReceipt || current.completionOutcome) throw new Error(`WORK_CANCELLED_RESUME_COMPLETION_CONFLICT: ${workId}`);
    if (current.phaseEvidence[current.phase].state !== 'skipped' || current.phaseEvidence[current.phase].source !== 'recorded') {
      throw new Error(`WORK_CANCELLED_RESUME_HISTORY_AMBIGUOUS: ${workId}`);
    }
    const originalPrincipal = current.principalId?.trim();
    if (!originalPrincipal || originalPrincipal !== input.principalId.trim()) {
      throw new Error(`WORK_CANCELLED_RESUME_PRINCIPAL_MISMATCH: ${workId}`);
    }
    const evidenceRefs = [...current.evidenceRefs, {
      title: 'explicit current-user Work reauthorization',
      summary: input.summary.trim().slice(0, 1_000),
      detailLevel: 'summary' as const,
    }].slice(-current.evidencePolicy.maxEvidenceRefs);
    const phaseEvidence = transitionPhaseEvidence({ ...current, evidenceRefs }, 'implementation', {
      status: 'running',
      summary: input.summary,
      evidenceRefs,
      recordedAt: at,
      source: 'recorded',
    });
    return {
      status: 'running',
      phase: 'implementation',
      phaseEvidence,
      dispatchState: 'running',
      evidenceRefs,
      checkoutId: input.checkoutId ?? current.checkoutId,
      worktreeRef: input.worktreeRef ?? current.worktreeRef,
      controllerInstanceId: input.controllerInstanceId,
      continuationPrompt: input.summary,
    };
  }, false, true, true, false, true);
}

/** Merge non-authoritative discovery/change evidence without changing policy fences. */
export function recordWorkScopeEvidence(
  options: WorkContractStoreOptions,
  workId: string,
  input: { initialLikelyPaths?: string[]; inspectedPaths?: string[]; actualChangedPaths?: string[] },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    const previous = current.scopeEvidence ?? {
      initialLikelyPaths: [], inspectedPaths: [], actualChangedPaths: [], recordedAt: current.createdAt,
    };
    return {
      scopeEvidence: {
        initialLikelyPaths: [...new Set([...previous.initialLikelyPaths, ...(input.initialLikelyPaths ?? [])])].slice(0, 100),
        inspectedPaths: [...new Set([...previous.inspectedPaths, ...(input.inspectedPaths ?? [])])].slice(0, 500),
        actualChangedPaths: [...new Set([...previous.actualChangedPaths, ...(input.actualChangedPaths ?? [])])].slice(0, 500),
        recordedAt: at,
      },
    };
  }, false);
}

export function transitionWorkContractPhase(
  options: WorkContractStoreOptions,
  workId: string,
  input: {
    phase: WorkPhase;
    status: WorkContractStatus;
    state?: Exclude<WorkPhaseEvidenceState, 'pending'>;
    summary: string;
    evidenceRefs?: EvidenceRef[];
    dispatchState?: DispatchState;
    evidenceState?: EvidenceState;
  },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (input.phase === 'review') {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRES_REQUEST_API');
    }
    if (input.phase === 'delivery'
      && current.phase !== 'delivery'
      && workRequiresImplementationReview(current.workKind, current.scopeEvidence?.actualChangedPaths ?? [], current.engineeringContext?.riskClass)) {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRES_RECORD_API');
    }
    const phaseEvidence = transitionPhaseEvidence(current, input.phase, {
      status: input.status,
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
      recordedAt: at,
    });
    if (
      input.phase === 'delivery'
      && current.phase !== 'delivery'
      && current.phaseEvidence.review.state !== 'satisfied'
      && !workRequiresImplementationReview(current.workKind, current.scopeEvidence?.actualChangedPaths ?? [], current.engineeringContext?.riskClass)
    ) {
      phaseEvidence.review = {
        state: 'skipped',
        source: 'recorded',
        summary: 'Implementation review is not required for this Work candidate under the current risk policy.',
        evidenceRefs: [],
        recordedAt: at,
      };
    }
    if (input.state) phaseEvidence[input.phase] = { ...phaseEvidence[input.phase], state: input.state };
    return {
      phase: input.phase,
      phaseEvidence,
      status: input.status,
      dispatchState: input.dispatchState ?? current.dispatchState,
      evidenceState: input.evidenceState ?? current.evidenceState,
    };
  }, false, true, false, false, true);
}

/** Enter the first-class implementation-review phase without recording a decision. */
export function requestWorkImplementationReview(
  options: WorkContractStoreOptions,
  workId: string,
  summary: string,
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (isTerminalWorkContractStatus(current.status)) throw new Error(`WORK_IMPLEMENTATION_REVIEW_TERMINAL: ${workId}`);
    if (current.phase !== 'verification' || current.phaseEvidence.verification.state !== 'satisfied') {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_VERIFIED_CANDIDATE_REQUIRED');
    }
    const phaseEvidence = transitionPhaseEvidence(current, 'review', {
      status: 'running',
      summary,
      recordedAt: at,
    });
    return {
      phase: 'review',
      phaseEvidence,
      status: 'running',
    };
  }, false, true);
}

/** The only writer for durable Controller implementation-review authority. */
export function recordWorkImplementationReview(
  options: WorkContractStoreOptions,
  workId: string,
  review: WorkImplementationReviewRecord,
): WorkContract {
  validateImplementationReviewRecord(review);
  if (review.derivation === 'content_equivalent_commit') {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_DERIVATION_REQUIRES_TRANSFER_API');
  }
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (isTerminalWorkContractStatus(current.status)) throw new Error(`WORK_IMPLEMENTATION_REVIEW_TERMINAL: ${workId}`);
    if (review.workId !== current.workId) throw new Error('WORK_IMPLEMENTATION_REVIEW_WORK_ID_MISMATCH');
    if (current.phase !== 'review') {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_PHASE_REQUIRED');
    }
    const target = implementationReviewDecisionTarget(review.decision);
    const history = [...(current.implementationReviews ?? []), review];
    if (history.length > MAX_IMPLEMENTATION_REVIEW_HISTORY) throw new Error('WORK_IMPLEMENTATION_REVIEW_HISTORY_LIMIT');
    const phaseEvidence = transitionPhaseEvidence(current, target.phase, {
      status: target.status,
      summary: `Implementation review ${review.reviewId}: ${review.decision}. ${review.rationale}`,
      recordedAt: at,
    });
    if (review.decision === 'approved') {
      phaseEvidence.review = {
        state: 'satisfied',
        source: 'recorded',
        summary: `Controller approved exact implementation candidate in ${review.reviewId}.`,
        evidenceRefs: current.evidenceRefs.slice(0, 20),
        recordedAt: review.recordedAt,
      };
    } else if (review.decision === 'blocked') {
      phaseEvidence.review = { ...phaseEvidence.review, state: 'blocked', recordedAt: review.recordedAt };
    }
    return {
      phase: target.phase,
      phaseEvidence,
      status: target.status,
      dispatchState: target.status === 'blocked'
        ? 'blocked'
        : current.dispatchState === 'blocked'
          ? 'running'
          : current.dispatchState,
      implementationReviews: history,
    };
  }, false, true, false, true, review.decision === 'changes_required');
}

export interface ContentEquivalentCommitAuthorityTransferInput {
  transferredVerificationRecords: VerificationRecord[];
  derivedReview: WorkImplementationReviewRecord;
}

/**
 * Persist the representation-only commit authority transfer in one Work-store
 * transaction. The immutable parent review plus exact post-commit verification
 * evidence authorize this write; mutable lifecycle phase is only a projection.
 */
export function recordContentEquivalentCommitAuthorityTransfer(
  options: WorkContractStoreOptions,
  workId: string,
  input: ContentEquivalentCommitAuthorityTransferInput,
): WorkContract {
  return withWorkContractStoreWrite(options, () => {
    const sanitizedId = sanitizeFileComponent(workId);
    if (options.controllerHome) assertCanonicalWorkAdmissionAllowed(options, { operation: 'continue', workId: sanitizedId });
    const store = readWorkContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.workId === sanitizedId);
    if (index < 0) throw new Error(`work contract not found: ${sanitizedId}`);
    const current = store.contracts[index]!;
    if (current.completionReceipt || isTerminalWorkContractStatus(current.status)) {
      throw new Error(`WORK_IMPLEMENTATION_REVIEW_TRANSFER_TERMINAL: ${sanitizedId}`);
    }

    const review = input.derivedReview;
    validateImplementationReviewRecord(review);
    if (review.workId !== current.workId) throw new Error('WORK_IMPLEMENTATION_REVIEW_WORK_ID_MISMATCH');
    if (review.derivation !== 'content_equivalent_commit'
      || review.decision !== 'approved'
      || !review.derivedFromReviewId) {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_DERIVATION_REQUIRED');
    }
    const parent = latestImplementationReview(current.implementationReviews);
    if (!parent || parent.reviewId !== review.derivedFromReviewId || parent.decision !== 'approved') {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_PARENT_REQUIRED');
    }
    if (!['verification', 'review', 'delivery'].includes(current.phase)) {
      throw new Error(`WORK_IMPLEMENTATION_REVIEW_TRANSFER_PHASE_INVALID: ${current.phase}`);
    }

    const requestedCheckIds = new Set(current.checks);
    for (const record of input.transferredVerificationRecords) {
      if (!requestedCheckIds.has(record.checkId)) {
        throw new Error(`WORK_VERIFICATION_TRANSFER_UNDECLARED_CHECK: ${record.checkId}`);
      }
    }
    const transferredVerificationRecords = input.transferredVerificationRecords.filter((record) =>
      !current.checkRefs.some((existing) => sameSuccessfulVerificationExecutionFact(existing, record)));
    const checkRefs = [...transferredVerificationRecords, ...current.checkRefs].slice(0, 50);
    const postVerification = authoritativeImplementationReviewVerificationEvidence({
      repoId: current.repoId,
      workId: current.workId,
      requiredCheckIds: current.checks,
      records: checkRefs,
      sourceRevision: review.sourceRevision,
      workspaceFingerprint: review.verificationWorkspaceFingerprint,
    });
    if (postVerification.missingCheckIds.length > 0) {
      throw new Error(`WORK_IMPLEMENTATION_REVIEW_TRANSFER_VERIFICATION_REQUIRED: ${postVerification.missingCheckIds.join(', ')}`);
    }
    const expectedEvidence = normalizeImplementationReviewEvidence(review.verificationEvidence);
    if (JSON.stringify(postVerification.evidence) !== JSON.stringify(expectedEvidence)) {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_VERIFICATION_IDENTITY_MISMATCH');
    }

    const history = [...current.implementationReviews, review];
    if (history.length > MAX_IMPLEMENTATION_REVIEW_HISTORY) throw new Error('WORK_IMPLEMENTATION_REVIEW_HISTORY_LIMIT');
    const at = nowIso(options);
    const summary = `Transferred verification and implementation-review authority to content-equivalent commit ${review.sourceRevision}.`;
    const phaseEvidence = transitionPhaseEvidence(current, 'delivery', {
      status: 'running',
      summary,
      evidenceRefs: current.evidenceRefs,
      recordedAt: at,
    });
    phaseEvidence.verification = {
      ...phaseEvidence.verification,
      state: 'satisfied',
      source: 'recorded',
      summary: `Exact post-commit verification authority supports derived review ${review.reviewId}.`,
      evidenceRefs: current.evidenceRefs.slice(0, 20),
      recordedAt: review.recordedAt,
    };
    phaseEvidence.review = {
      state: 'satisfied',
      source: 'recorded',
      summary: `Controller approval ${parent.reviewId} was transferred as ${review.reviewId} after content-equivalence proof.`,
      evidenceRefs: current.evidenceRefs.slice(0, 20),
      recordedAt: review.recordedAt,
    };
    const next = validateWorkSemanticTransition(current, validateWorkSemantics({
      ...current,
      updatedAt: at,
      status: 'running',
      phase: 'delivery',
      phaseEvidence,
      evidenceState: 'valid',
      checkRefs,
      implementationReviews: history,
    }));
    const contracts = [...store.contracts];
    contracts[index] = next;
    writeWorkContractStore(options, { schemaVersion: 3, updatedAt: at, contracts });
    return next;
  });
}

/**
 * Repair only the lifecycle projection for an already-durable exact approved
 * implementation review. This never appends or derives review authority. The
 * caller must first independently prove that the immutable delivery candidate
 * still matches the durable review/check boundary.
 */
export function reconcileApprovedWorkImplementationReviewProjection(
  options: WorkContractStoreOptions,
  workId: string,
  expected: { reviewId: string; sourceRevision: string; changedPathDigest: string },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (current.completionReceipt) return undefined;
    if (isTerminalWorkContractStatus(current.status)) throw new Error(`WORK_IMPLEMENTATION_REVIEW_PROJECTION_TERMINAL: ${workId}`);
    const review = latestImplementationReview(current.implementationReviews);
    if (!review || review.decision !== 'approved') throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRED');
    if (review.reviewId !== expected.reviewId
      || review.sourceRevision !== expected.sourceRevision
      || review.changedPathDigest !== expected.changedPathDigest) {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_PROJECTION_IDENTITY_MISMATCH');
    }
    if (current.phase === 'delivery' && current.phaseEvidence.review.state === 'satisfied') return undefined;
    if (!['verification', 'review', 'delivery'].includes(current.phase)) {
      throw new Error(`WORK_IMPLEMENTATION_REVIEW_PROJECTION_PHASE_INVALID: ${current.phase}`);
    }
    const summary = `Recovered lifecycle projection from durable approved implementation review ${review.reviewId}; review authority was not rewritten.`;
    const phaseEvidence = transitionPhaseEvidence(current, 'delivery', {
      status: 'running',
      summary,
      evidenceRefs: current.evidenceRefs,
      recordedAt: at,
    });
    phaseEvidence.review = {
      state: 'satisfied',
      source: 'recorded',
      summary: `Controller approved exact implementation candidate in ${review.reviewId}.`,
      evidenceRefs: current.evidenceRefs.slice(0, 20),
      recordedAt: review.recordedAt,
    };
    return {
      phase: 'delivery',
      phaseEvidence,
      status: 'running',
    };
  }, false, true);
}

export function appendWorkEvidence(
  options: WorkContractStoreOptions,
  workId: string,
  evidence: EvidenceRef,
): WorkContract {
  return updateWorkContractInternal(options, workId, (current) => ({
    evidenceRefs: [evidence, ...current.evidenceRefs].slice(0, current.evidencePolicy.maxEvidenceRefs),
  }), false);
}

export function appendWorkHandoffRef(
  options: WorkContractStoreOptions,
  workId: string,
  handoffId: string,
): WorkContract {
  const sanitizedHandoffId = sanitizeFileComponent(handoffId);
  return updateWorkContractInternal(options, workId, (current) => ({
    handoffRefs: [sanitizedHandoffId, ...current.handoffRefs.filter((id) => id !== sanitizedHandoffId)].slice(0, 20),
  }), false);
}

function sameSuccessfulVerificationExecutionFact(left: VerificationRecord, right: VerificationRecord): boolean {
  const a = left.receipt;
  const b = right.receipt;
  if (left.outcome !== 'valid_pass' || right.outcome !== 'valid_pass' || !a || !b) return false;
  if (!left.sourceRevision || !right.sourceRevision || left.sourceRevision !== right.sourceRevision) return false;
  if (!left.workspaceFingerprint || !right.workspaceFingerprint || left.workspaceFingerprint !== right.workspaceFingerprint) return false;
  if (left.checkId !== right.checkId || a.processId !== b.processId) return false;
  if (!a.checkCacheKey || !a.checkRevision || !a.checkDefinitionDigest || !a.checkEnvironmentFingerprint) return false;
  if (!b.checkCacheKey || !b.checkRevision || !b.checkDefinitionDigest || !b.checkEnvironmentFingerprint) return false;
  return a.checkCacheKey === b.checkCacheKey
    && a.checkRevision === b.checkRevision
    && a.checkDefinitionDigest === b.checkDefinitionDigest
    && a.checkEnvironmentFingerprint === b.checkEnvironmentFingerprint;
}

export function appendVerificationRecord(
  options: WorkContractStoreOptions,
  workId: string,
  record: VerificationRecord,
): WorkContract {
  return updateWorkContractInternal(options, workId, (current) => {
    // Re-consuming the exact same successful Process against the exact same
    // source/workspace is request provenance, not a new Work verification fact.
    // Keep the original durable VerificationRecord so an approved review remains
    // bound to one stable evidence identity. A changed source/workspace, Process,
    // Check definition, environment, or cache identity still appends normally.
    if (current.checkRefs.some((existing) => sameSuccessfulVerificationExecutionFact(existing, record))) {
      return undefined;
    }
    return { checkRefs: [record, ...current.checkRefs].slice(0, 50) };
  }, false);
}

/**
 * Legacy field name retained for storage compatibility. This records durable
 * delivery/effect evidence only. It MUST NOT complete semantic Work, advance a
 * Work lifecycle/phase, satisfy review policy, or infer the next action.
 * Semantic completion is exclusively reviseWorkSemanticContext/work_complete CAS.
 */
export function recordWorkCompletionReceipt(
  options: WorkContractStoreOptions,
  workId: string,
  receipt: NonNullable<WorkContract['completionReceipt']>,
  completionOutcome: NonNullable<WorkContract['completionOutcome']>,
  _completionWorkKind?: WorkKind,
): WorkContract {
  return updateWorkContractInternal(options, workId, (current) => {
    if (receipt.workId !== current.workId) throw new Error('WORK_COMPLETION_RECEIPT_IDENTITY_MISMATCH');
    if (current.completionReceipt) {
      if (current.completionReceipt.receiptId !== receipt.receiptId) throw new Error('WORK_COMPLETION_RECEIPT_ALREADY_RECORDED');
      return undefined;
    }
    const recordedAt = receipt.recordedAt;
    const receiptChangedPaths = isRepositoryCompletionReceipt(receipt) || isDirectEditWorkCompletionReceipt(receipt)
      ? receipt.changedPaths
      : [];
    return {
      completionOutcome,
      completionReceipt: receipt,
      scopeEvidence: {
        initialLikelyPaths: current.scopeEvidence?.initialLikelyPaths ?? current.allowedPaths,
        inspectedPaths: current.scopeEvidence?.inspectedPaths ?? [],
        actualChangedPaths: [...new Set(receiptChangedPaths)].slice(0, 500),
        recordedAt,
      },
    };
  }, true, false);
}
export interface AcceptSubmittedWorkInput {
  requestId: string;
  repoId: string;
  parentWorkId?: string;
  semanticKey: string;
  operation: SubmittedWorkOperation;
  objective?: string;
  requestedBy?: WorkContract['requestedBy'];
  principalId?: string;
  controllerInstanceId?: string;
  workKind?: WorkKind;
  risk?: WorkRisk;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  acceptanceCriteria?: string[];
  constraints?: WorkContract['constraints'];
}
