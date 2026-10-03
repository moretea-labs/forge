import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome, scopedOperationRoot, SEMANTIC_SCOPE_KEY } from '../../../../src/cli/repositories/controller-home';
import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../../../src/runtime/shared/json-files';
import {
  listControlPlaneRecordKeys,
  listControlPlaneRecords,
  listControlPlaneRecordsWithinTransaction,
  listControlPlaneRecordsExcludingPayloadTextValues,
  initializeControlPlanePayloadTextExclusionIndex,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import {
  MAX_IMPLEMENTATION_REVIEW_HISTORY,
  validateImplementationReviewRecord,
  type WorkImplementationReviewRecord,
} from '../domain/implementation-review';
import { phaseIndex, suggestedActionsForSemanticState, transitionPhaseEvidence, validateWorkSemanticTransition, validateWorkSemantics } from '../domain/state-machine';
import { normalizeWorkObjectiveRelationIds, validateWorkObjectiveRelationShape } from '../domain/objective-graph';
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
  isTerminalSemanticWorkState,
  TERMINAL_SEMANTIC_WORK_STATES,
  semanticScopeRefForWork,
} from '../domain/types';

import type { WorkContractStoreLocation, WorkContractStoreOptions } from '../ports/work-contract-store';
export type { WorkContractStoreLocation, WorkContractStoreOptions } from '../ports/work-contract-store';

export type CreateWorkContractInput = Omit<
  WorkContract,
  'schemaVersion' | 'semanticState' | 'createdAt' | 'updatedAt' | 'risk' | 'workKind' | 'dispatchState' | 'evidenceState' | 'completionOutcome' | 'phase' | 'phaseEvidence' | 'completionReceipt' | 'evidenceRefs' | 'handoffRefs' | 'suggestedNextActions' | 'policyDecisions' | 'checkRefs' | 'implementationReviews' | 'reconciliations' | 'worktreePolicy' | 'evidencePolicy' | 'approvalPolicy' | 'recoveryPolicy'
> & {
  risk?: WorkRisk;
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
  state?: SemanticWorkState | 'active' | 'all';
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

export interface WorkContractLineageSnapshot {
  contracts: WorkContract[];
  invalid: Array<{
    workId: string;
    parentWorkId?: string;
    predecessorWorkId?: string;
    supersedes: string[];
    supersededBy?: string;
    error: string;
  }>;
}

export interface WorkSemanticRevisionRecord extends WorkSemanticView {
  schemaVersion: 1;
  recordedAt: string;
}

export interface CreateWorkSemanticInput {
  workId: string;
  objective: string;
  requestId?: string;
  requirementId?: string;
  requirementRevision?: number;
  planId?: string;
  planRevision?: number;
  semanticParentWorkId?: string;
  dependsOnWorkIds?: string[];
  requestedBy?: 'chatgpt' | 'user' | 'system' | 'scheduler';
}

export interface ReviseWorkSemanticInput {
  expectedRevision: number;
  objective?: string;
  state?: SemanticWorkState;
  requirementRevision?: number;
  planRevision?: number;
  semanticParentWorkId?: string;
  dependsOnWorkIds?: string[];
  resultRefs?: string[];
}

interface WorkSemanticRevisionStore {
  schemaVersion: 1;
  records: WorkSemanticRevisionRecord[];
}

export interface WorkContractSummary {
  workId: string;
  repoId: string;
  /** The one thin authored Work state. */
  state: SemanticWorkState;
  phase: WorkContract['phase'];
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
  return { schemaVersion: 4, updatedAt, contracts: [] };
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
export function semanticWorkState(work: Pick<WorkContract, 'semanticState'>): SemanticWorkState {
  return work.semanticState;
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
    ...(work.semanticParentWorkId?.trim() ? { semanticParentWorkId: work.semanticParentWorkId.trim() } : {}),
    ...(normalizeWorkObjectiveRelationIds(work.dependsOnWorkIds).length > 0 ? { dependsOnWorkIds: normalizeWorkObjectiveRelationIds(work.dependsOnWorkIds) } : {}),
    resultRefs,
    createdAt: work.createdAt,
    updatedAt: work.semanticUpdatedAt ?? work.createdAt,
  };
}

function workSemanticRevisionKey(workId: string, revision: number): string {
  return `${sanitizeFileComponent(workId)}-r${revision}`;
}

function validateWorkObjectiveRelationIntegrity(candidate: WorkContract, contracts: readonly WorkContract[]): void {
  validateWorkObjectiveRelationShape(candidate);
  const parent = candidate.semanticParentWorkId?.trim();
  const dependencies = normalizeWorkObjectiveRelationIds(candidate.dependsOnWorkIds);
  if (!parent && dependencies.length === 0) return;
  const byId = new Map(contracts.map((contract) => [contract.workId, contract] as const));
  byId.set(candidate.workId, candidate);
  for (const relatedWorkId of [...(parent ? [parent] : []), ...dependencies]) {
    const related = byId.get(relatedWorkId);
    if (!related) throw new Error(`WORK_OBJECTIVE_RELATION_NOT_FOUND: ${relatedWorkId}`);
    if ((related.lifecycleRole ?? 'primary') !== 'primary') throw new Error(`WORK_OBJECTIVE_RELATION_TARGET_NOT_PRIMARY: ${relatedWorkId}`);
  }
  const seenParents = new Set<string>();
  let parentCursor = parent;
  while (parentCursor) {
    if (parentCursor === candidate.workId) throw new Error('WORK_SEMANTIC_PARENT_CYCLE');
    if (seenParents.has(parentCursor)) throw new Error('WORK_SEMANTIC_PARENT_TARGET_CYCLE');
    seenParents.add(parentCursor);
    parentCursor = byId.get(parentCursor)?.semanticParentWorkId?.trim();
  }
  const dependencyReachesCandidate = (workId: string, visiting: Set<string>): boolean => {
    if (workId === candidate.workId) return true;
    if (visiting.has(workId)) return false;
    visiting.add(workId);
    const work = byId.get(workId);
    if (!work) return false;
    return normalizeWorkObjectiveRelationIds(work.dependsOnWorkIds)
      .some((dependency) => dependencyReachesCandidate(dependency, visiting));
  };
  for (const dependency of dependencies) {
    if (dependencyReachesCandidate(dependency, new Set())) throw new Error('WORK_DEPENDENCY_CYCLE');
  }
}

function workSemanticRevisionStorePath(options: WorkContractStoreOptions): string {
  return join(workContractRoot(options), 'semantic-revisions.json');
}

function readWorkSemanticRevisionStore(options: WorkContractStoreOptions): WorkSemanticRevisionStore {
  return readJsonFile<WorkSemanticRevisionStore>(workSemanticRevisionStorePath(options), { schemaVersion: 1, records: [] });
}

function initialLifecycleForNewWork(): Pick<WorkContract, 'phase' | 'dispatchState' | 'evidenceState'> {
  return { phase: 'implementation', dispatchState: 'not_dispatched', evidenceState: 'none' };
}

function initialPhaseEvidenceForNewWork(
  input: Pick<WorkContract, 'phase' | 'evidenceRefs' | 'updatedAt'> & { phaseState?: WorkPhaseEvidenceState },
): WorkPhaseEvidenceMap {
  const currentIndex = phaseIndex(input.phase);
  return Object.fromEntries((['implementation', 'verification', 'review', 'delivery', 'cleanup'] as WorkPhase[]).map((phase) => {
    const index = phaseIndex(phase);
    const state: WorkPhaseEvidenceState = index < currentIndex
      ? 'satisfied'
      : index > currentIndex
        ? 'pending'
        : input.phaseState ?? 'active';
    return [phase, {
      state,
      source: 'recorded' as const,
      summary: index < currentIndex
        ? `Canonical Work was admitted after phase ${phase}.`
        : index > currentIndex
          ? `Waiting for Work phase ${phase}.`
          : `Canonical Work admitted in ${phase}.`,
      evidenceRefs: index <= currentIndex ? input.evidenceRefs.slice(0, 20) : [],
      recordedAt: input.updatedAt,
    } satisfies WorkPhaseEvidence];
  })) as WorkPhaseEvidenceMap;
}

function legacyPhaseEvidence(
  contract: Pick<WorkContract, 'phase' | 'evidenceRefs' | 'completionReceipt' | 'updatedAt'> & { legacyStatus?: 'open' | 'running' | 'blocked' | 'ready' | 'completed' | 'failed' | 'cancelled' },
  source: WorkPhaseEvidence['source'] = 'legacy_inferred',
): WorkPhaseEvidenceMap {
  const currentIndex = phaseIndex(contract.phase);
  const completedByReceipt = Boolean(contract.completionReceipt);
  return Object.fromEntries((['implementation', 'verification', 'review', 'delivery', 'cleanup'] as WorkPhase[]).map((phase) => {
    const index = phaseIndex(phase);
    let state: WorkPhaseEvidenceState = index < currentIndex ? 'satisfied' : index === currentIndex ? 'active' : 'pending';
    if (completedByReceipt) state = phase === 'review' ? 'skipped' : 'satisfied';
    else if (contract.legacyStatus === 'failed' && phase === contract.phase) state = 'failed';
    else if (contract.legacyStatus === 'cancelled' && phase === contract.phase) state = 'skipped';
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
  // One-way schema migration only: v1-v3 rows may still carry retired status.
  // v4 strips it permanently and keeps semanticState as the only Work lifecycle state.
  // Removal condition: once supported Controller Homes contain no schema<4 Work rows for one full release boundary, delete legacyStatus handling entirely.
  const legacyStatus = (legacy as WorkContract & { status?: 'open' | 'running' | 'blocked' | 'ready' | 'completed' | 'failed' | 'cancelled' }).status;
  const semanticState: SemanticWorkState = legacy.semanticState
    ?? (legacyStatus === 'completed' ? 'completed' : legacyStatus === 'cancelled' ? 'cancelled' : 'open');
  // Phase is a mechanical checkpoint projection only. A legacy row without a
  // persisted phase is admitted at the neutral first checkpoint; terminal
  // status never advances phase, and status is never a phase-transition authority.
  const phase = legacy.completionReceipt
    ? 'cleanup'
    : semanticState === 'completed'
      ? 'delivery'
      : legacy.phase ?? 'implementation';
  const legacyDefaults = legacyPhaseEvidence({
    phase,
    legacyStatus,
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
  const { status: _retiredStatus, ...legacyWithoutStatus } = legacy as WorkContract & { status?: unknown };
  void _retiredStatus;
  return validateWorkSemantics({
    ...legacyWithoutStatus,
    schemaVersion: 4,
    scopeRef: semanticScopeRefForWork(legacy),
    executionPlacement: executionPlacementForWork(legacy),
    semanticState,
    semanticRevision: legacy.semanticRevision && legacy.semanticRevision > 0 ? legacy.semanticRevision : 1,
    semanticUpdatedAt: legacy.semanticUpdatedAt ?? legacy.updatedAt,
    phase,
    phaseEvidence,
    risk: legacy.risk ?? 'medium',
    workKind: legacy.workKind ?? 'repository_change',
    dispatchState: legacy.dispatchState ?? 'not_dispatched',
    evidenceState: legacy.evidenceState ?? 'none',
    suggestedNextActions: suggestedActionsForSemanticState(semanticState, legacy.suggestedNextActions ?? []),
    implementationReviews: legacy.implementationReviews ?? [],
    reconciliations: legacy.reconciliations ?? [],
  });
}

function validateCanonicalWorkContract(contract: WorkContract): WorkContract {
  if (contract.schemaVersion !== 4) {
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
  return contract.schemaVersion !== 4
    || contract.semanticState === undefined
    || Object.prototype.hasOwnProperty.call(contract as object, 'status')
    || Boolean(legacyReviewGap);
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
  // v1-v3 rows are a one-way schema migration into v4. v4 rows are validated as-is;
  // retired status is never inferred or exposed during normal reads.
  // Removal condition: delete this migration branch after supported Controller Homes report zero schema<4 Work rows across one full release boundary.
  return { schemaVersion: 4, updatedAt: store.updatedAt, contracts: store.contracts.map(canonicalizeStoredWorkContract) };
}

export function readWorkContractStore(options: WorkContractStoreOptions): WorkContractStore {
  if (!sqliteBacked(options)) {
    const raw = readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options)));
    const normalized = normalizeWorkContractStore(raw);
    if (raw.schemaVersion !== 4 || raw.contracts.some(storedWorkContractNeedsMigration)) {
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
      schemaVersion: 4,
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
            schemaVersion: 4,
            value: contract,
            action: 'work_contract_schema_v4_migrated',
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
          schemaVersion: 4,
          value: contract,
          action: 'work_contract_legacy_import',
          expectedRevision: null,
        });
      }
    });
  }
  return normalized;
}

/**
 * Read valid Work rows without allowing an unrelated corrupt historical row to
 * poison a lineage-scoped ControllerRound projection. Invalid rows retain only
 * their identity and explicit lineage references so callers can fail closed if
 * the malformed row may belong to the requested lineage.
 */
export function readWorkContractLineageSnapshot(options: WorkContractStoreOptions): WorkContractLineageSnapshot {
  if (!sqliteBacked(options)) {
    const store = readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options)));
    const contracts: WorkContract[] = [];
    const invalid: WorkContractLineageSnapshot['invalid'] = [];
    for (const raw of store.contracts) {
      try {
        contracts.push(canonicalizeStoredWorkContract(raw));
      } catch (error) {
        invalid.push(lineageInvalidWork(raw, error));
      }
    }
    return { contracts, invalid };
  }

  const records = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: workContractStoreScopeKey(options),
    limit: 5_000,
  });
  if (records.length === 0) return { contracts: readWorkContractStore(options).contracts, invalid: [] };

  const contracts: WorkContract[] = [];
  const invalid: WorkContractLineageSnapshot['invalid'] = [];
  for (const record of records) {
    try {
      contracts.push(canonicalizeStoredWorkContract(record.value));
    } catch (error) {
      invalid.push(lineageInvalidWork(record.value, error, record.key));
    }
  }
  return { contracts, invalid };
}

function lineageInvalidWork(
  raw: WorkContract,
  error: unknown,
  recordKey?: string,
): WorkContractLineageSnapshot['invalid'][number] {
  const clean = (id: unknown): string | undefined => typeof id === 'string' && id.trim() ? id.trim() : undefined;
  return {
    workId: clean(raw.workId) ?? recordKey ?? '',
    ...(clean(raw.parentWorkId) ? { parentWorkId: clean(raw.parentWorkId) } : {}),
    ...(clean(raw.predecessorWorkId) ? { predecessorWorkId: clean(raw.predecessorWorkId) } : {}),
    supersedes: Array.isArray(raw.supersedes) ? raw.supersedes.map(clean).filter((id): id is string => Boolean(id)) : [],
    ...(clean(raw.supersededBy) ? { supersededBy: clean(raw.supersededBy) } : {}),
    error: error instanceof Error ? error.message : String(error),
  };
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
        schemaVersion: 4,
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

function withExactWorkContractWrite<T>(
  options: WorkContractStoreOptions,
  workIdInput: string,
  operation: () => T,
): T {
  if (!sqliteBacked(options)) return operation();
  const workId = sanitizeFileComponent(workIdInput);
  return withControllerLock(
    options.controllerHome,
    { scope: 'global', resource: `work-contract-${workId}` },
    `work-contract:${workId}`,
    operation,
    undefined,
    5_000,
  );
}


export function createWorkSemanticContext(options: WorkContractStoreOptions, input: CreateWorkSemanticInput): WorkContract {
  const semanticOptions = options.scopeKey?.trim() || !options.repoId?.trim()
    ? options
    : { ...options, scopeKey: options.repoId.trim() };
  return createWorkContract(semanticOptions, {
    workId: input.workId,
    repoId: options.repoId?.trim() ?? '',
    objective: input.objective,
    acceptanceCriteria: [],
    constraints: {},
    workKind: 'investigation',
    lifecycleRole: 'primary',
    requestedBy: input.requestedBy ?? 'chatgpt',
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    ...(input.requirementId?.trim() ? { requirementId: input.requirementId.trim() } : {}),
    ...(Number.isInteger(input.requirementRevision) ? { requirementRevision: input.requirementRevision } : {}),
    ...(input.planId?.trim() ? { planId: input.planId.trim() } : {}),
    ...(Number.isInteger(input.planRevision) ? { planRevision: input.planRevision } : {}),
    ...(input.semanticParentWorkId !== undefined ? { semanticParentWorkId: input.semanticParentWorkId.trim() || undefined } : {}),
    ...(input.dependsOnWorkIds !== undefined ? { dependsOnWorkIds: normalizeWorkObjectiveRelationIds(input.dependsOnWorkIds) } : {}),
    ...(input.requestId?.trim() ? { requestId: input.requestId.trim() } : {}),
  });
}

export function createWorkContract(options: WorkContractStoreOptions, input: CreateWorkContractInput): WorkContract {
  // Thin semantic Work is authored context. Repository execution and concurrency
  // are fenced by placement/resource ownership rather than a global migration gate.
  const runtimeInput = input as CreateWorkContractInput & Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(runtimeInput, 'status')) throw new Error('WORK_RETIRED_FIELD_REJECTED: status');
  for (const field of ['semanticState', 'semanticRevision', 'semanticUpdatedAt']) {
    if (Object.prototype.hasOwnProperty.call(runtimeInput, field)) throw new Error(`WORK_SEMANTIC_FIELDS_REQUIRE_REVISION_API: ${field}`);
  }
  if (input.completionReceipt || input.completionOutcome) {
    throw new Error('WORK_COMPLETION_REQUIRES_RECORD_API');
  }
  const create = (): WorkContract => {
    const at = input.createdAt ?? input.updatedAt ?? nowIso(options);
    const workId = sanitizeFileComponent(input.workId);
    const predecessorWorkId = input.predecessorWorkId ? sanitizeFileComponent(input.predecessorWorkId) : undefined;
    if (predecessorWorkId === workId) throw new Error('WORK_PREDECESSOR_SELF_REFERENCE');
    const contract: WorkContract = validateWorkSemantics({
      schemaVersion: 4,
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
      semanticState: 'open',
      acceptanceCriteria: (input.acceptanceCriteria ?? []).slice(0, 20).map((item) => item.slice(0, 500)),
      constraints: input.constraints ?? {},
      risk: input.risk ?? 'medium',
      engineeringContext: input.engineeringContext,
      workKind: input.workKind ?? 'repository_change',
      lifecycleRole: input.lifecycleRole ?? 'primary',
      parentWorkId: input.parentWorkId?.trim() || undefined,
      semanticParentWorkId: input.semanticParentWorkId?.trim() || undefined,
      dependsOnWorkIds: normalizeWorkObjectiveRelationIds(input.dependsOnWorkIds),
      predecessorWorkId: predecessorWorkId && predecessorWorkId !== 'unknown' ? predecessorWorkId : undefined,
      supersedes: input.supersedes?.map((value) => sanitizeFileComponent(value)).filter((value) => value !== 'unknown').slice(0, 50),
      supersededBy: input.supersededBy ? sanitizeFileComponent(input.supersededBy) : undefined,
      supersessionReason: input.supersessionReason?.trim().slice(0, 500),
      dispatchState: input.dispatchState ?? initialLifecycleForNewWork().dispatchState,
      evidenceState: input.evidenceState ?? initialLifecycleForNewWork().evidenceState,
      completionOutcome: input.completionOutcome,
      phase: input.phase ?? initialLifecycleForNewWork().phase,
      phaseEvidence: initialPhaseEvidenceForNewWork({
        phase: input.phase ?? initialLifecycleForNewWork().phase,
        evidenceRefs: input.evidenceRefs ?? [],
        updatedAt: input.updatedAt ?? at,
      }),
      completionReceipt: input.completionReceipt,
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
        required: input.constraints?.workspaceMode === 'isolated',
        reason: input.constraints?.workspaceMode === 'isolated'
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
        const scope = workContractStoreScopeKey(options);
        if (readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', scope, contract.workId)) {
          throw new Error(`work contract already exists: ${contract.workId}`);
        }
        if (contract.semanticParentWorkId?.trim() || contract.dependsOnWorkIds?.length) {
          const relationContracts = listControlPlaneRecordsWithinTransaction<WorkContract>(database, {
            namespace: 'work_contract', scope, limit: 5_000,
          }).map((record) => canonicalizeStoredWorkContract(record.value));
          validateWorkObjectiveRelationIntegrity(contract, relationContracts);
        }
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope,
          key: contract.workId,
          schemaVersion: 4,
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
    if (contract.semanticParentWorkId?.trim() || contract.dependsOnWorkIds?.length) {
      validateWorkObjectiveRelationIntegrity(contract, store.contracts);
    }
    const nextStore: WorkContractStore = {
      schemaVersion: 4,
      updatedAt: contract.updatedAt,
      contracts: [contract, ...store.contracts],
    };
    writeWorkContractStore(options, nextStore);
    return contract;
  };
  const relationAware = Boolean(input.semanticParentWorkId?.trim() || input.dependsOnWorkIds?.length);
  return withExactWorkContractWrite(options, input.workId, () => relationAware ? withWorkContractStoreWrite(options, create) : create());
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
    if (semanticWorkState(parent) !== 'open') throw new Error(`PARENT_WORK_TERMINAL: ${parentWorkId}:${semanticWorkState(parent)}`);
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
      constraints: input.constraints ?? {},
      allowedPaths: input.allowedPaths ?? [],
      forbiddenPaths: input.forbiddenPaths ?? [],
      checks: input.checks ?? [],
      requestedBy: input.requestedBy ?? 'chatgpt',
      requestId,
      submittedOperation: input.operation,
      suggestedNextActions: [],
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
  const state = options.state ?? 'active';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  if (state === 'active' && sqliteBacked(options)) {
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
      if (state === 'all') return true;
      if (state === 'active') return isCurrentWorkContract(contract);
      return semanticWorkState(contract) === state;
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
    namespace: 'work_contract', field: 'semanticState', excludedValues: TERMINAL_SEMANTIC_WORK_STATES,
  });
}

export function readActiveWorkCandidates(
  options: WorkContractStoreOptions & { limit?: number },
): ActiveWorkCandidateSnapshot {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 1_000), 1_000));
  if (!sqliteBacked(options)) {
    return { contracts: listWorkContracts({ ...options, state: 'active', limit }), invalid: [] };
  }
  const requestedScope = workContractStoreScopeKey(options);
  const records = listControlPlaneRecordsExcludingPayloadTextValues<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: requestedScope,
    field: 'semanticState',
    excludedValues: TERMINAL_SEMANTIC_WORK_STATES,
    limit: 5_000,
  });
  const semanticAuthorityWorkIds = requestedScope === SEMANTIC_SCOPE_KEY
    ? new Set<string>()
    : new Set(listControlPlaneRecordKeys(options.controllerHome, {
        namespace: 'work_contract',
        scope: SEMANTIC_SCOPE_KEY,
        limit: 5_000,
      }));
  const contracts: WorkContract[] = [];
  const invalid: InvalidActiveWorkCandidate[] = [];
  const migrations: Array<{ record: (typeof records)[number]; contract: WorkContract }> = [];
  for (const record of records) {
    // Exact Work reads already prefer semantic scope over repository-scoped
    // compatibility rows. Collection reads must preserve the same one-authority
    // rule or a stale open compatibility shadow can resurrect terminal Work.
    if (semanticAuthorityWorkIds.has(record.key)) continue;
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
          schemaVersion: 4,
          value: contract,
          action: 'work_contract_schema_v4_migrated',
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
  const authoritativeOptions = normalizedId
    ? authoritativeExistingWorkStoreOptions(options, normalizedId)
    : options;
  const records = sqliteBacked(authoritativeOptions)
    ? listControlPlaneRecords<WorkSemanticRevisionRecord>(authoritativeOptions.controllerHome, {
        namespace: 'work_semantic_revision', scope: workContractStoreScopeKey(authoritativeOptions), limit: 5_000,
      }).map((record) => record.value)
    : readWorkSemanticRevisionStore(authoritativeOptions).records;
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

function authoritativeExistingWorkStoreOptions(
  options: WorkContractStoreOptions,
  workIdInput: string,
): WorkContractStoreOptions {
  if (!sqliteBacked(options)) return options;
  const requestedScope = workContractStoreScopeKey(options);
  if (requestedScope === SEMANTIC_SCOPE_KEY) return options;
  const workId = sanitizeFileComponent(workIdInput);
  const semantic = readControlPlaneRecord<WorkContract>(
    options.controllerHome,
    'work_contract',
    SEMANTIC_SCOPE_KEY,
    workId,
  );
  return semantic ? { ...options, scopeKey: SEMANTIC_SCOPE_KEY } : options;
}

export function reviseWorkSemanticContext(
  options: WorkContractStoreOptions,
  workIdInput: string,
  input: ReviseWorkSemanticInput,
): WorkContract {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('WORK_EXPECTED_REVISION_INVALID');
  return withExactWorkContractWrite(options, workIdInput, () => {
    const authoritativeOptions = authoritativeExistingWorkStoreOptions(options, workIdInput);
    return withWorkContractStoreWrite(authoritativeOptions, () => {
    const workId = sanitizeFileComponent(workIdInput);
    const relationRevisionRequested = input.semanticParentWorkId !== undefined || input.dependsOnWorkIds !== undefined;
    const applyRevision = (current: WorkContract, at: string, relationContracts: readonly WorkContract[] = []): WorkContract => {
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
      if (currentSemanticState !== 'open' && (input.semanticParentWorkId !== undefined || input.dependsOnWorkIds !== undefined)) {
        throw new Error(`WORK_OBJECTIVE_RELATION_TERMINAL_IMMUTABLE:${workId}:${currentSemanticState}`);
      }
      const next = validateWorkSemantics({
        ...current,
        objective,
        semanticRevision: semanticRevision + 1,
        semanticUpdatedAt: at,
        semanticState: nextSemanticState,
        ...(input.requirementRevision !== undefined ? { requirementRevision: positiveRevision(input.requirementRevision, 'WORK_REQUIREMENT_REVISION_INVALID') } : {}),
        ...(input.planRevision !== undefined ? { planRevision: positiveRevision(input.planRevision, 'WORK_PLAN_REVISION_INVALID') } : {}),
        ...(input.semanticParentWorkId !== undefined ? { semanticParentWorkId: input.semanticParentWorkId.trim() || undefined } : {}),
        ...(input.dependsOnWorkIds !== undefined ? { dependsOnWorkIds: normalizeWorkObjectiveRelationIds(input.dependsOnWorkIds) } : {}),
        ...(input.resultRefs !== undefined ? { semanticResultRefs: [...new Set(input.resultRefs.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 100) } : {}),
        updatedAt: at,
      });
      if (relationRevisionRequested) validateWorkObjectiveRelationIntegrity(next, relationContracts);
      return next;
    };

    if (sqliteBacked(authoritativeOptions)) {
      return withControlPlaneTransaction(authoritativeOptions.controllerHome, (database) => {
        const scope = workContractStoreScopeKey(authoritativeOptions);
        const currentRecord = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', scope, workId);
        if (!currentRecord) throw new Error(`work contract not found: ${workId}`);
        const current = canonicalizeStoredWorkContract(currentRecord.value);
        const at = nowIso(authoritativeOptions);
        const relationContracts = relationRevisionRequested
          ? listControlPlaneRecordsWithinTransaction<WorkContract>(database, {
              namespace: 'work_contract', scope, limit: 5_000,
            }).map((record) => canonicalizeStoredWorkContract(record.value))
          : [];
        const next = applyRevision(current, at, relationContracts);
        const semanticRevision = currentWorkSemanticRevision(current);
        const revisionKey = workSemanticRevisionKey(workId, semanticRevision);
        if (!readControlPlaneRecordWithinTransaction<WorkSemanticRevisionRecord>(database, 'work_semantic_revision', scope, revisionKey)) {
          writeControlPlaneRecordWithinTransaction(database, {
            namespace: 'work_semantic_revision', scope, key: revisionKey, schemaVersion: 1,
            value: { schemaVersion: 1, ...workSemanticView(current), recordedAt: at },
            action: 'work_semantic_revision_archived', expectedRevision: null,
          });
        }
        return writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract', scope, key: workId, schemaVersion: 4,
          value: next, action: 'work_semantic_revised', expectedRevision: currentRecord.revision,
        }).value;
      });
    }

    // Semantic CAS validation must be side-effect free. The public read path may
    // persist a one-way legacy migration, so normalize the file-backed store only
    // in memory here and write it exactly once after the requested revision has
    // been validated successfully.
    const rawStore = readJsonFile<WorkContractStore>(
      workContractStorePath(authoritativeOptions),
      emptyWorkContractStore(nowIso(authoritativeOptions)),
    );
    const store = normalizeWorkContractStore(rawStore);
    const index = store.contracts.findIndex((contract) => contract.workId === workId);
    if (index < 0) throw new Error(`work contract not found: ${workId}`);
    const current = store.contracts[index]!;
    const at = nowIso(authoritativeOptions);
    const next = applyRevision(current, at, relationRevisionRequested ? store.contracts : []);
    const archived = { schemaVersion: 1 as const, ...workSemanticView(current), recordedAt: at };
    const history = readWorkSemanticRevisionStore(authoritativeOptions);
    if (!history.records.some((record) => record.workId === workId && record.revision === archived.revision)) {
      writeJsonAtomic(workSemanticRevisionStorePath(authoritativeOptions), { schemaVersion: 1, records: [...history.records, archived].slice(-5_000) });
    }
    const contracts = [...store.contracts];
    contracts[index] = next;
    writeWorkContractStore(authoritativeOptions, { schemaVersion: 4, updatedAt: at, contracts });
    return next;
    });
  });
}

function readExactSqliteWorkContract(
  options: WorkContractStoreOptions & { controllerHome: string },
  scope: string,
  sanitizedId: string,
): WorkContract | undefined {
  const exact = readControlPlaneRecord<WorkContract>(options.controllerHome, 'work_contract', scope, sanitizedId);
  if (!exact) return undefined;
  const canonical = canonicalizeStoredWorkContract(exact.value);
  if (storedWorkContractNeedsMigration(exact.value)) {
    withControlPlaneTransaction(options.controllerHome, (database) => {
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract',
        scope,
        key: canonical.workId,
        schemaVersion: 4,
        value: canonical,
        action: 'work_contract_schema_v4_migrated',
        expectedRevision: exact.revision,
      });
    });
  }
  return canonical;
}

export function getWorkContract(options: WorkContractStoreOptions, workId: string): WorkContract | undefined {
  const sanitizedId = sanitizeFileComponent(workId);
  if (!sqliteBacked(options)) {
    return readWorkContractStore(options).contracts.find((contract) => contract.workId === sanitizedId);
  }
  const requestedScope = workContractStoreScopeKey(options);
  if (requestedScope !== SEMANTIC_SCOPE_KEY) {
    const semantic = readExactSqliteWorkContract(options, SEMANTIC_SCOPE_KEY, sanitizedId);
    if (semantic) return semantic;
  }
  const exact = readExactSqliteWorkContract(options, requestedScope, sanitizedId);
  if (exact) return exact;

  // Preserve the one-time legacy import path only while this requested scope has
  // no per-Work rows. Canonical semantic rows are checked first and never copied
  // into repository scope; repository-scoped rows remain a read-only compatibility
  // fallback until their consumers are retired.
  const hasPerWorkRows = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: requestedScope,
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
      writeJsonAtomic(workContractStorePath(options), { schemaVersion: 4, updatedAt: at, contracts });
    } else {
      withControlPlaneTransaction(options.controllerHome, (database) => {
        for (const contract of [predecessorNext, successorNext]) {
          const current = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', workContractStoreScopeKey(options), contract.workId);
          if (!current) throw new Error(`WORK_LINEAGE_RECORD_MISSING: ${contract.workId}`);
          writeControlPlaneRecordWithinTransaction(database, { namespace: 'work_contract', scope: workContractStoreScopeKey(options), key: contract.workId, schemaVersion: 4, value: contract, action: 'work_contract_supersession_linked', expectedRevision: current.revision });
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
    state: semanticWorkState(contract),
    phase: contract.phase,
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
  allowImplementationReviewWrite = false,
  allowPhaseRegression = false,
): WorkContract {
  return withExactWorkContractWrite(options, workId, () => {
    const authoritativeOptions = authoritativeExistingWorkStoreOptions(options, workId);
    return withWorkContractStoreWrite(authoritativeOptions, () => {
    const sanitizedId = sanitizeFileComponent(workId);
    const exact = sqliteBacked(authoritativeOptions)
      ? readControlPlaneRecord<WorkContract>(
          authoritativeOptions.controllerHome,
          'work_contract',
          workContractStoreScopeKey(authoritativeOptions),
          sanitizedId,
        )
      : undefined;
    const store = exact ? undefined : readWorkContractStore(authoritativeOptions);
    const index = store?.contracts.findIndex((contract) => contract.workId === sanitizedId) ?? -1;
    if (!exact && index < 0) throw new Error(`work contract not found: ${sanitizedId}`);
    const at = nowIso(authoritativeOptions);
    // A per-Work SQLite row is the mutable authority. Do not normalize every
    // sibling just to update this row: malformed historical evidence must stay
    // visible and fenced, but cannot prevent a different terminal Work from
    // recording its physical cleanup.
    const current = exact
      ? canonicalizeStoredWorkContract(exact.value)
      : store!.contracts[index]!;
    const mutationPatch = typeof mutation === 'function' ? mutation(current, at) : mutation;
    if (!mutationPatch) return current;
    const placementChanged = (
      Object.prototype.hasOwnProperty.call(mutationPatch, 'checkoutId')
      && mutationPatch.checkoutId !== current.checkoutId
    ) || (
      Object.prototype.hasOwnProperty.call(mutationPatch, 'worktreeRef')
      && mutationPatch.worktreeRef !== current.worktreeRef
    ) || (
      Object.prototype.hasOwnProperty.call(mutationPatch, 'executionPlacement')
      && JSON.stringify(mutationPatch.executionPlacement) !== JSON.stringify(current.executionPlacement)
    );
    // executionConcurrency is only a projection of the concrete placement that
    // existed when an execution attempt was admitted. A checkout/worktree move
    // makes that projection stale; clear it centrally unless the same atomic
    // mutation explicitly supplies a replacement projection for the new target.
    const patch = placementChanged && !Object.prototype.hasOwnProperty.call(mutationPatch, 'executionConcurrency')
      ? { ...mutationPatch, executionConcurrency: undefined }
      : mutationPatch;
    if (Object.prototype.hasOwnProperty.call(patch, 'status')) throw new Error('WORK_RETIRED_FIELD_REJECTED: status');
    for (const field of ['semanticState', 'semanticRevision', 'semanticUpdatedAt']) {
      if (!allowLifecycleWrite && Object.prototype.hasOwnProperty.call(patch, field)) {
        throw new Error(`WORK_SEMANTIC_FIELDS_REQUIRE_REVISION_API: ${field}`);
      }
    }
    const writesCompletionReceipt = Object.prototype.hasOwnProperty.call(patch, 'completionReceipt');
    const changesCompletionOutcome = patch.completionOutcome !== undefined && patch.completionOutcome !== current.completionOutcome;
    const writesPhase = Object.prototype.hasOwnProperty.call(patch, 'phase') || Object.prototype.hasOwnProperty.call(patch, 'phaseEvidence');
    const writesLifecycle = writesPhase
      || Object.prototype.hasOwnProperty.call(patch, 'dispatchState')
      || Object.prototype.hasOwnProperty.call(patch, 'evidenceState')
      || Object.prototype.hasOwnProperty.call(patch, 'workKind');
    const writesImplementationReviews = Object.prototype.hasOwnProperty.call(patch, 'implementationReviews');
    if (!allowLifecycleWrite && writesLifecycle) throw new Error('WORK_LIFECYCLE_REQUIRES_TRANSITION_API');
    if (!allowImplementationReviewWrite && writesImplementationReviews) throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRES_RECORD_API');
    const projectedPhase = patch.phase ?? current.phase;
    const projectedPhaseEvidence = patch.phaseEvidence ?? current.phaseEvidence;
    if (!allowCompletionWrite && (writesCompletionReceipt || changesCompletionOutcome)) {
      throw new Error('WORK_COMPLETION_REQUIRES_RECORD_API');
    }
    if (writesCompletionReceipt && patch.completionReceipt === undefined && current.completionReceipt) {
      throw new Error('WORK_COMPLETION_RECEIPT_IMMUTABLE');
    }
    const next: WorkContract = validateWorkSemanticTransition(current, validateWorkSemantics({
    ...current,
    ...patch,
    schemaVersion: 4,
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
    suggestedNextActions: suggestedActionsForSemanticState(current.semanticState, patch.suggestedNextActions ?? current.suggestedNextActions),
    policyDecisions: (patch.policyDecisions ?? current.policyDecisions).slice(0, 20),
    checkRefs: (patch.checkRefs ?? current.checkRefs).slice(0, 50),
    implementationReviews: (patch.implementationReviews ?? current.implementationReviews ?? []).slice(-MAX_IMPLEMENTATION_REVIEW_HISTORY),
    reconciliations: (patch.reconciliations ?? current.reconciliations ?? []).slice(0, 20),
    objective: (patch.objective ?? current.objective).slice(0, 2_000),
    continuationPrompt: (patch.continuationPrompt ?? current.continuationPrompt)?.slice(0, 2_000),
    }), { allowPhaseRegression });
    if (exact && sqliteBacked(authoritativeOptions)) {
      withControlPlaneTransaction(authoritativeOptions.controllerHome, (database) => {
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: workContractStoreScopeKey(authoritativeOptions),
          key: next.workId,
          schemaVersion: 4,
          value: next,
          action: 'work_contract_updated',
          expectedRevision: exact.revision,
        });
      });
      return next;
    }
    const contracts = [...store!.contracts];
    contracts[index] = next;
    writeWorkContractStore(authoritativeOptions, { schemaVersion: 4, updatedAt: at, contracts });
    return next;
    });
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
 * its evidence stay durable for audit/recovery/retention, while semantic state and
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
  | 'semanticState'
  | 'semanticRevision'
  | 'semanticUpdatedAt'
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
    if (semanticWorkState(current) !== 'open' || current.completionReceipt || current.completionOutcome) {
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
    if (current.semanticState !== 'open') {
      throw new Error(`WORK_ACTIVATION_TERMINAL: ${workId}:${current.semanticState}`);
    }
    const phase = input.phase ?? current.phase;
    const phaseEvidence = transitionPhaseEvidence(current, phase, {
      state: 'active',
      summary: input.summary,
      recordedAt: at,
      source: 'recorded',
    });
    const evidenceState = input.evidenceState
      ?? (current.evidenceState === 'failed' ? 'partial' : current.evidenceState);
    return {
      phase,
      phaseEvidence,
      dispatchState: 'running',
      evidenceState,
      worktreeRef: input.worktreeRef ?? current.worktreeRef,
    };
  }, false, true, false, true);
}

export function failWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  input: { phase: WorkPhase; summary: string; evidenceRefs?: EvidenceRef[] },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    if (current.semanticState !== 'open') {
      throw new Error(`WORK_FAILURE_TERMINAL: ${workId}:${current.semanticState}`);
    }
    if (input.phase !== current.phase) {
      throw new Error(`WORK_FAILURE_PHASE_MISMATCH: ${workId}:expected=${current.phase}:actual=${input.phase}`);
    }
    const phaseEvidence = transitionPhaseEvidence(current, current.phase, {
      state: 'failed',
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
      recordedAt: at,
      source: 'recorded',
    });
    return {
      phase: current.phase,
      phaseEvidence,
      dispatchState: 'blocked',
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
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${sanitizeFileComponent(workId)}`);
  if (current.semanticState === 'completed') throw new Error(`WORK_CANCEL_COMPLETED: ${workId}`);
  if (current.semanticState === 'cancelled') return current;

  reviseWorkSemanticContext(options, workId, {
    expectedRevision: currentWorkSemanticRevision(current),
    state: 'cancelled',
  });

  return updateWorkContractInternal(options, workId, (cancelled, at) => {
    if (cancelled.semanticState !== 'cancelled') {
      throw new Error(`WORK_CANCEL_SEMANTIC_STATE_REQUIRED: ${workId}:${cancelled.semanticState}`);
    }
    const phaseEvidence = cancellationPhaseEvidence(cancelled, {
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
      recordedAt: at,
    });
    return {
      phase: cancelled.phase,
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
    if (current.semanticState !== 'cancelled') {
      throw new Error(`WORK_CANCELLED_CLEANUP_STATE_REQUIRED: ${workId}:${current.semanticState}`);
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
    state?: Exclude<WorkPhaseEvidenceState, 'pending'>;
    summary: string;
    evidenceRefs?: EvidenceRef[];
    dispatchState?: DispatchState;
    evidenceState?: EvidenceState;
  },
): WorkContract {
  return updateWorkContractInternal(options, workId, (current, at) => {
    const phaseEvidence = transitionPhaseEvidence(current, input.phase, {
      state: input.state,
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
      recordedAt: at,
    });
    return {
      phase: input.phase,
      phaseEvidence,
      dispatchState: input.dispatchState ?? current.dispatchState,
      evidenceState: input.evidenceState ?? current.evidenceState,
    };
  }, false, true, false, true);
}

/**
 * Append immutable historical review evidence. This is evidence storage only:
 * the decision never changes semantic state or phase and never authorizes delivery.
 */
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
    if (semanticWorkState(current) !== 'open') throw new Error(`WORK_IMPLEMENTATION_REVIEW_TERMINAL: ${workId}`);
    if (review.workId !== current.workId) throw new Error('WORK_IMPLEMENTATION_REVIEW_WORK_ID_MISMATCH');
    const history = [...(current.implementationReviews ?? []), review];
    if (history.length > MAX_IMPLEMENTATION_REVIEW_HISTORY) throw new Error('WORK_IMPLEMENTATION_REVIEW_HISTORY_LIMIT');
    return {
      implementationReviews: history,
    };
  }, false, false, true, false);
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
 * Semantic completion is exclusively reviseWorkSemanticContext/complete CAS.
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
      if (current.completionReceipt.receiptId === receipt.receiptId) return undefined;
      // Legacy field names store current mechanical delivery evidence. An open
      // semantic Work may legitimately deliver again after a retained production
      // canary repair. Terminal semantic Work keeps its delivery receipt immutable.
      if (semanticWorkState(current) !== 'open') throw new Error('WORK_COMPLETION_RECEIPT_ALREADY_RECORDED');
      if ((isRepositoryCompletionReceipt(receipt) || isDirectEditWorkCompletionReceipt(receipt)) && current.evidenceState !== 'valid') {
        throw new Error('WORK_DELIVERY_RECEIPT_REPLACEMENT_VALIDATION_REQUIRED');
      }
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
