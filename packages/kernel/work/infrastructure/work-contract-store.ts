import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome, SEMANTIC_SCOPE_KEY } from '../../../../src/effects/controller-home';
import { readJsonFile, sanitizeFileComponent } from '../../../../src/runtime/shared/json-files';
import {
  listControlPlaneRecordKeys,
  listControlPlaneRecords,
  listControlPlaneRecordsWithinTransaction,
  listControlPlaneRecordsExcludingPayloadTextValues,
  initializeControlPlanePayloadTextExclusionIndex,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneReadDatabase,
} from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import { phaseIndex, suggestedActionsForSemanticState, validateWorkSemantics } from '../domain/state-machine';
import { normalizeWorkObjectiveRelationIds, validateWorkObjectiveRelationShape } from '../domain/objective-relations';
import {
  WORK_PHASES,
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

export interface ListWorkContractOptions extends WorkContractStoreOptions {
  state?: SemanticWorkState | 'active' | 'all';
  limit?: number;
  /** Explicit pagination for complete internal historical inventory. */
  offset?: number;
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
    requirementId?: string;
    semanticParentWorkId?: string;
    dependsOnWorkIds?: string[];
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
  const {
    status: _retiredStatus,
    allowedPaths: _retiredAllowedPaths,
    forbiddenPaths: _retiredForbiddenPaths,
    ...legacyWithoutRetiredFields
  } = legacy as WorkContract & { status?: unknown; allowedPaths?: unknown; forbiddenPaths?: unknown };
  void _retiredStatus;
  void _retiredAllowedPaths;
  void _retiredForbiddenPaths;
  // Before Work kind and completion outcome were made a single typed contract,
  // delivery-reconciliation records retained their operational label even after
  // a repository receipt proved that they advanced the target revision. The
  // current contract rightly rejects that combination. Preserve the receipt and
  // semantic terminal state, but migrate the obsolete label to the current
  // repository-change classification so terminal history remains readable and
  // cannot poison scheduler relay discovery forever.
  const workKind = legacy.workKind === 'reconciliation'
    && legacy.completionOutcome === 'completed_changed'
    && legacy.completionReceipt
    && isRepositoryCompletionReceipt(legacy.completionReceipt)
    ? 'repository_change' as const
    : legacy.workKind ?? 'repository_change';
  return validateWorkSemantics({
    ...legacyWithoutRetiredFields,
    schemaVersion: 4,
    scopeRef: semanticScopeRefForWork(legacy),
    executionPlacement: executionPlacementForWork(legacy),
    semanticState,
    semanticRevision: legacy.semanticRevision && legacy.semanticRevision > 0 ? legacy.semanticRevision : 1,
    semanticUpdatedAt: legacy.semanticUpdatedAt ?? legacy.updatedAt,
    phase,
    phaseEvidence,
    risk: legacy.risk ?? 'medium',
    workKind,
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

function storedWorkContractNeedsMigration(contract: WorkContract, persistedSchemaVersion: number = contract.schemaVersion): boolean {
  const phaseEvidence = contract.phaseEvidence as Partial<WorkPhaseEvidenceMap> | undefined;
  // Some pre-review-checkpoint rows were stamped with the current outer
  // schema while omitting only `review`. That exact historical shape remains
  // migration-compatible, but it must be persisted once rather than inferred
  // repeatedly by the normal read path.
  const legacyReviewGap = persistedSchemaVersion === 3
    && phaseEvidence
    && !phaseEvidence.review
    && phaseEvidence.implementation
    && phaseEvidence.verification
    && phaseEvidence.delivery
    && phaseEvidence.cleanup;
  return persistedSchemaVersion !== 4
    || contract.semanticState === undefined
    || Object.prototype.hasOwnProperty.call(contract as object, 'status')
    || Object.prototype.hasOwnProperty.call(contract as object, 'allowedPaths')
    || Object.prototype.hasOwnProperty.call(contract as object, 'forbiddenPaths')
    || Boolean(legacyReviewGap);
}

function workContractAtPersistedSchema(contract: WorkContract, persistedSchemaVersion: number): WorkContract {
  return contract.schemaVersion === persistedSchemaVersion
    ? contract
    : { ...contract, schemaVersion: persistedSchemaVersion as WorkContract['schemaVersion'] };
}

function canonicalizeStoredWorkContract(contract: WorkContract, persistedSchemaVersion: number = contract.schemaVersion): WorkContract {
  // The control-plane record envelope is the persisted schema authority. Some
  // historical writers advanced the payload first, leaving it stamped v4 under
  // a v3 envelope. Read it as the envelope declares so the one-way migration
  // repairs the whole stored row rather than accepting a partially migrated
  // contract indefinitely.
  const persisted = workContractAtPersistedSchema(contract, persistedSchemaVersion);
  return storedWorkContractNeedsMigration(persisted, persistedSchemaVersion)
    ? migrateLegacyWorkContract(persisted)
    : validateCanonicalWorkContract(persisted);
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
  // Normalize historical v1-v3 rows in memory only. Historical Work storage is
  // read-only; projected v4 shape is never committed by ordinary reads. Remove
  // this migration branch after supported Controller Homes report zero schema<4 rows.
  return { schemaVersion: 4, updatedAt: store.updatedAt, contracts: store.contracts.map((contract) => canonicalizeStoredWorkContract(contract)) };
}

export function readWorkContractStore(options: WorkContractStoreOptions): WorkContractStore {
  const records = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: workContractStoreScopeKey(options),
    limit: 5_000,
  });
  return normalizeWorkContractStore({
    schemaVersion: 4,
    updatedAt: records[0]?.updatedAt ?? nowIso(options),
    contracts: records.map((record) => workContractAtPersistedSchema(record.value, record.schemaVersion)),
  });
}

/**
 * Read valid Work rows without allowing an unrelated corrupt historical row to
 * poison a lineage-scoped ControllerRound projection. Invalid rows retain only
 * their identity and explicit lineage references so callers can fail closed if
 * the malformed row may belong to the requested lineage.
 */
export function readWorkContractLineageSnapshot(options: WorkContractStoreOptions): WorkContractLineageSnapshot {
  const records = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: workContractStoreScopeKey(options),
    limit: 5_000,
  });
  const contracts: WorkContract[] = [];
  const invalid: WorkContractLineageSnapshot['invalid'] = [];
  for (const record of records) {
    try {
      contracts.push(canonicalizeStoredWorkContract(record.value, record.schemaVersion));
    } catch (error) {
      invalid.push(lineageInvalidWork(record.value, error, record.key));
    }
  }
  return { contracts, invalid };
}

/** Fresh goal membership across this Controller Home; no migration, cache or lifecycle writes. */
export function readWorkGoalSnapshot(
  controllerHome: string,
  filter: { requirementId?: string; planId?: string },
): WorkContractLineageSnapshot & { truncated: boolean } {
  const requirementId = filter.requirementId?.trim() || null;
  const planId = filter.planId?.trim() || null;
  if (!requirementId && !planId) throw new Error('WORK_GOAL_ID_REQUIRED');
  const rows = withControlPlaneReadDatabase(controllerHome, (database) => {
    const statement = database.prepare(`
      SELECT record_key, schema_version, payload
      FROM control_plane_records current
      WHERE namespace = 'work_contract'
        AND (? IS NULL OR json_extract(payload, '$.requirementId') = ?)
        AND (? IS NULL OR json_extract(payload, '$.planId') = ?)
        AND (scope = ? OR NOT EXISTS (
          SELECT 1 FROM control_plane_records semantic
          WHERE semantic.namespace = 'work_contract' AND semantic.scope = ?
            AND semantic.record_key = current.record_key
        ))
      ORDER BY updated_at DESC, scope, record_key
      LIMIT 5001
    `);
    try {
      return statement.all(requirementId, requirementId, planId, planId, SEMANTIC_SCOPE_KEY, SEMANTIC_SCOPE_KEY) as Array<{
        record_key: string; schema_version: number; payload: string;
      }>;
    } finally { statement.finalize?.(); }
  });
  const contracts: WorkContract[] = [];
  const invalid: WorkContractLineageSnapshot['invalid'] = [];
  const identities = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (identities.has(row.record_key)) duplicates.add(row.record_key);
    identities.add(row.record_key);
  }
  for (const row of rows.slice(0, 5000)) {
    const raw = JSON.parse(row.payload) as WorkContract;
    try {
      if (duplicates.has(row.record_key)) throw new Error('WORK_GOAL_IDENTITY_AMBIGUOUS');
      contracts.push(canonicalizeStoredWorkContract(raw, row.schema_version));
    } catch (error) { invalid.push(lineageInvalidWork(raw, error, row.record_key)); }
  }
  return { contracts, invalid, truncated: rows.length > 5000 };
}

function lineageInvalidWork(
  raw: WorkContract,
  error: unknown,
  recordKey?: string,
): WorkContractLineageSnapshot['invalid'][number] {
  const clean = (id: unknown): string | undefined => typeof id === 'string' && id.trim() ? id.trim() : undefined;
  return {
    workId: clean(raw.workId) ?? recordKey ?? '',
    ...(clean(raw.requirementId) ? { requirementId: clean(raw.requirementId) } : {}),
    ...(clean(raw.semanticParentWorkId) ? { semanticParentWorkId: clean(raw.semanticParentWorkId) } : {}),
    dependsOnWorkIds: Array.isArray(raw.dependsOnWorkIds) ? raw.dependsOnWorkIds.map(clean).filter((id): id is string => Boolean(id)) : [],
    ...(clean(raw.parentWorkId) ? { parentWorkId: clean(raw.parentWorkId) } : {}),
    ...(clean(raw.predecessorWorkId) ? { predecessorWorkId: clean(raw.predecessorWorkId) } : {}),
    supersedes: Array.isArray(raw.supersedes) ? raw.supersedes.map(clean).filter((id): id is string => Boolean(id)) : [],
    ...(clean(raw.supersededBy) ? { supersededBy: clean(raw.supersededBy) } : {}),
    error: error instanceof Error ? error.message : String(error),
  };
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
  // Historical request-id lookup is read-only; missing index files simply mean no legacy mapping.
  const root = join(controllerHome, 'indexes', 'work-contracts', 'requests');
  return join(root, `${hash}.json`);
}

function readWorkRequestIndex(path: string, requestId: string): WorkRequestIndexRecord {
  let value: unknown;
  try { value = readJsonFile<unknown>(path); }
  catch { throw new Error(`WORK_REQUEST_INDEX_CORRUPT: ${requestId}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`WORK_REQUEST_INDEX_CORRUPT: ${requestId}`);
  }
  const record = value as Partial<WorkRequestIndexRecord>;
  if (record.requestId !== requestId || !record.repoId?.trim() || !record.workId?.trim() || !record.semanticKey?.trim()) {
    throw new Error(`WORK_REQUEST_INDEX_CORRUPT: ${requestId}`);
  }
  return record as WorkRequestIndexRecord;
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
  const record = readWorkRequestIndex(recordPath, normalizedRequestId);
  if (expectedRepoId && record.repoId !== expectedRepoId) {
    throw new Error(`REQUEST_ID_REPO_CONFLICT: ${normalizedRequestId} already belongs to repository ${record.repoId}`);
  }
  const work = getWorkContract({ controllerHome, repoId: record.repoId }, record.workId);
  if (!work) throw new Error(`WORK_ACCEPTANCE_LOST: request ${normalizedRequestId} is indexed without a readable WorkContract`);
  return work;
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
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  if (state === 'active' && offset > 0) throw new Error('WORK_ACTIVE_PAGINATION_UNSUPPORTED');
  if (state === 'active') {
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
      return semanticWorkState(contract) === state;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(offset, offset + limit);
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
  // Scheduler admission only projects historical rows; exact Work access owns
  // one-time schema persistence, so polling cannot advance Work revisions.
  const contracts: WorkContract[] = [];
  const invalid: InvalidActiveWorkCandidate[] = [];
  for (const record of records) {
    // Exact Work reads already prefer semantic scope over repository-scoped
    // compatibility rows. Collection reads must preserve the same one-authority
    // rule or a stale open compatibility shadow can resurrect terminal Work.
    if (semanticAuthorityWorkIds.has(record.key)) continue;
    const raw = record.value;
    if (!rawWorkMayBeCurrent(raw)) continue;
    try {
      const normalized = canonicalizeStoredWorkContract(raw, record.schemaVersion);
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
  const records = listControlPlaneRecords<WorkSemanticRevisionRecord>(authoritativeOptions.controllerHome, {
    namespace: 'work_semantic_revision', scope: workContractStoreScopeKey(authoritativeOptions), limit: 5_000,
  }).map((record) => record.value);
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

function readExactSqliteWorkContract(
  options: WorkContractStoreOptions & { controllerHome: string },
  scope: string,
  sanitizedId: string,
): WorkContract | undefined {
  const exact = readControlPlaneRecord<WorkContract>(options.controllerHome, 'work_contract', scope, sanitizedId);
  if (!exact) return undefined;
  const canonical = canonicalizeStoredWorkContract(exact.value, exact.schemaVersion);
  // A read must never advance a Work revision. The subsequent authorized
  // mutation carries this in-memory canonical form into its own CAS write.
  return canonical;
}

export function getWorkContract(options: WorkContractStoreOptions, workId: string): WorkContract | undefined {
  const sanitizedId = sanitizeFileComponent(workId);
  const requestedScope = workContractStoreScopeKey(options);
  if (requestedScope !== SEMANTIC_SCOPE_KEY) {
    const semantic = readExactSqliteWorkContract(options, SEMANTIC_SCOPE_KEY, sanitizedId);
    if (semantic) return semantic;
  }
  return readExactSqliteWorkContract(options, requestedScope, sanitizedId);
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
