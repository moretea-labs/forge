import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from '../../../../src/cli/repositories/controller-home';
import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../../../src/runtime/shared/json-files';
import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import { assertWorkAdmissionAllowed } from '../../../../src/runtime/control-plane/facade/work-admission-policy';
import {
  MAX_IMPLEMENTATION_REVIEW_HISTORY,
  implementationReviewDecisionTarget,
  latestImplementationReview,
  validateImplementationReviewRecord,
  workRequiresImplementationReview,
  type WorkImplementationReviewRecord,
} from '../domain/implementation-review';
import { phaseIndex, suggestedActionsForStatus, transitionPhaseEvidence, validateWorkSemanticTransition, validateWorkSemantics } from '../domain/state-machine';
import {
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
  type WorkRisk,
  type WorkKind,
  type WorkPhase,
  type WorkPhaseEvidence,
  type WorkPhaseEvidenceMap,
  type WorkPhaseEvidenceState,
  type WorkContractStore,
  isDirectEditWorkCompletionReceipt,
  isRepositoryCompletionReceipt,
  isTerminalWorkContractStatus,
} from '../domain/types';

import type { WorkContractStoreLocation, WorkContractStoreOptions } from '../ports/work-contract-store';
export type { WorkContractStoreLocation, WorkContractStoreOptions } from '../ports/work-contract-store';

export type CreateWorkContractInput = Omit<
  WorkContract,
  'schemaVersion' | 'status' | 'createdAt' | 'updatedAt' | 'risk' | 'workKind' | 'dispatchState' | 'evidenceState' | 'completionOutcome' | 'phase' | 'phaseEvidence' | 'completionReceipt' | 'evidenceRefs' | 'handoffRefs' | 'suggestedNextActions' | 'policyDecisions' | 'checkRefs' | 'implementationReviews' | 'reconciliations' | 'driver' | 'worktreePolicy' | 'evidencePolicy' | 'approvalPolicy' | 'recoveryPolicy'
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
  driver?: WorkContract['driver'];
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

export type WorktreeAvailability = 'active' | 'inactive' | 'missing' | 'unknown';

export interface WorkContractReconciliationInput {
  activeExecutionJobs: number;
  activeLocalJobs: number;
  activeLeases: number;
  staleAfterMs?: number;
  now?: string;
  worktreeAvailability?: (worktreeRef: string) => WorktreeAvailability;
}

export interface WorkContractReconciliationResult {
  scanned: number;
  reconciled: number;
  paused: number;
  cancelled: number;
  skippedForActiveOwnership: boolean;
  workIds: string[];
}

export interface WorkContractSummary {
  workId: string;
  repoId: string;
  mode: WorkContract['mode'];
  phase: WorkContract['phase'];
  status: WorkContractStatus;
  objective: string;
  updatedAt: string;
  handoffCount: number;
  evidenceCount: number;
  checkCount: number;
}

function nowIso(options: WorkContractStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function workContractRoot(location: WorkContractStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome || !location.repoId) {
    throw new Error('work contract store requires either root or controllerHome + repoId');
  }
  const root = join(repositoryControllerRoot(location.controllerHome, location.repoId), 'work-contracts');
  mkdirSync(root, { recursive: true });
  return root;
}

export function workContractStorePath(location: WorkContractStoreLocation): string {
  return join(workContractRoot(location), 'index.json');
}

export function emptyWorkContractStore(updatedAt: string): WorkContractStore {
  return { schemaVersion: 2, updatedAt, contracts: [] };
}

function inferredDispatchState(status: WorkContractStatus): DispatchState {
  if (status === 'open' || status === 'ready') return 'not_dispatched';
  if (status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  return 'terminal';
}

function inferredPhase(status: WorkContractStatus): WorkContract['phase'] {
  if (status === 'ready') return 'verification';
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return 'cleanup';
  return 'implementation';
}

/** Legacy status writes are normalized into the bounded Work phase projection. */
function phaseForStatusUpdate(current: WorkContract['phase'], status: WorkContractStatus | undefined): WorkContract['phase'] {
  if (!status) return current;
  if (status === 'ready') return 'verification';
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return 'cleanup';
  return current;
}

function dispatchStateForStatusUpdate(current: DispatchState, status: WorkContractStatus | undefined): DispatchState {
  // `ready` means evidence/approval readiness in the legacy projection; it
  // does not mean a running dispatch was never launched.
  if (!status || status === 'ready') return current;
  return inferredDispatchState(status);
}

function inferredEvidenceState(status: WorkContractStatus): EvidenceState {
  if (status === 'failed') return 'failed';
  // A legacy completed status never proves that its evidence remains current.
  if (status === 'completed') return 'partial';
  return 'none';
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

function sqliteBacked(options: WorkContractStoreOptions): options is WorkContractStoreOptions & { controllerHome: string; repoId: string } {
  // A caller-provided root is a test/portable compatibility store.  Runtime
  // controller state always carries controllerHome + repoId and is SQLite.
  return Boolean(!options.root && options.controllerHome?.trim() && options.repoId?.trim());
}

function normalizeWorkContractStore(store: WorkContractStore): WorkContractStore {
  // Read legacy facade records without retaining the old state machine.
  return {
    ...store,
    contracts: store.contracts.map((legacy) => {
      const mappedStatus = ({ pending: 'open', waiting_for_review: 'ready', succeeded: 'completed' } as Record<string, WorkContractStatus>)[String(legacy.status)] ?? legacy.status;
      // Historical terminal labels without the Work-owned receipt are not
      // completion authority. Reopen them at delivery so callers can obtain an
      // exact receipt instead of projecting an unproven success.
      const status = mappedStatus === 'completed' && !legacy.completionReceipt ? 'ready' : mappedStatus;
      const phase = legacy.completionReceipt
        ? 'cleanup'
        : mappedStatus === 'completed'
          ? 'delivery'
          : legacy.phase ?? inferredPhase(status);
      return validateWorkSemantics({
        ...legacy,
        schemaVersion: legacy.schemaVersion ?? 1,
        status,
        phase,
        phaseEvidence: legacy.phaseEvidence ?? legacyPhaseEvidence({
          phase,
          status,
          evidenceRefs: legacy.evidenceRefs ?? [],
          completionReceipt: legacy.completionReceipt,
          updatedAt: legacy.updatedAt,
        }),
        risk: legacy.risk ?? 'medium',
        workKind: legacy.workKind ?? 'repository_change',
        dispatchState: legacy.dispatchState ?? inferredDispatchState(status),
        evidenceState: legacy.evidenceState ?? inferredEvidenceState(status),
        suggestedNextActions: suggestedActionsForStatus(status, legacy.suggestedNextActions ?? []),
        implementationReviews: legacy.implementationReviews ?? [],
        reconciliations: legacy.reconciliations ?? [],
        driver: (legacy.driver as unknown as { preferred?: string } | undefined)?.preferred === 'codex_worker'
          ? { ...legacy.driver, preferred: 'external_controller', allowWorker: false }
          : legacy.driver,
      });
    }),
  };
}

export function readWorkContractStore(options: WorkContractStoreOptions): WorkContractStore {
  if (!sqliteBacked(options)) {
    return normalizeWorkContractStore(readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options))));
  }
  const records = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: options.repoId,
    limit: 5_000,
  });
  if (records.length > 0) {
    return normalizeWorkContractStore({
      schemaVersion: 2,
      updatedAt: records[0]?.updatedAt ?? nowIso(options),
      contracts: records.map((record) => record.value),
    });
  }

  // One-time import only. Once a per-Work row exists, legacy index/file data is
  // never consulted again and is never written back.
  const legacyRecord = readControlPlaneRecord<WorkContractStore>(
    options.controllerHome,
    'work_contract_store',
    options.repoId,
    'index',
  );
  const legacy = legacyRecord?.value
    ?? readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options)));
  const normalized = normalizeWorkContractStore(legacy);
  if (normalized.contracts.length > 0) {
    withControlPlaneTransaction(options.controllerHome, (database) => {
      for (const contract of normalized.contracts) {
        if (readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', options.repoId, contract.workId)) continue;
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: options.repoId,
          key: contract.workId,
          schemaVersion: 2,
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
      const current = readControlPlaneRecordWithinTransaction<WorkContract>(
        database,
        'work_contract',
        options.repoId,
        contract.workId,
      );
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract',
        scope: options.repoId,
        key: contract.workId,
        schemaVersion: 2,
        value: contract,
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
    { scope: 'global', resource: `work-contract-store-${sanitizeFileComponent(options.repoId)}` },
    `work-contract-store:${options.repoId}`,
    operation,
    undefined,
    5_000,
  );
}

function defaultDriver(mode: WorkContract['mode']): WorkContract['driver'] {
  if (mode === 'direct_control') {
    return { preferred: 'direct_edit', allowWorker: false, allowDirectEdit: true };
  }
  if (mode === 'handoff_only') {
    return { preferred: 'handoff_only', allowWorker: false, allowDirectEdit: false };
  }
  return { preferred: 'direct_edit', allowWorker: false, allowDirectEdit: true };
}

export function createWorkContract(options: WorkContractStoreOptions, input: CreateWorkContractInput): WorkContract {
  if (options.controllerHome) {
    assertWorkAdmissionAllowed(options.controllerHome, { operation: 'create', workId: input.workId });
  }
  if (input.status === 'completed' || input.completionReceipt || input.completionOutcome) {
    throw new Error('WORK_COMPLETION_REQUIRES_RECORD_API');
  }
  const create = (): WorkContract => {
    const at = input.createdAt ?? input.updatedAt ?? nowIso(options);
    const workId = sanitizeFileComponent(input.workId);
    const contract: WorkContract = validateWorkSemantics({
      schemaVersion: 2,
      workId,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      principalId: input.principalId,
      controllerInstanceId: input.controllerInstanceId,
      baseRevision: input.baseRevision,
      repositoryBaseState: input.repositoryBaseState,
      workspaceFingerprint: input.workspaceFingerprint,
      routeDecisionFingerprint: input.routeDecisionFingerprint,
      routeDecision: input.routeDecision,
      mode: input.mode,
      objective: input.objective.slice(0, 2_000),
      acceptanceCriteria: (input.acceptanceCriteria ?? []).slice(0, 20).map((item) => item.slice(0, 500)),
      constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
      risk: input.risk ?? 'medium',
      workKind: input.workKind ?? 'repository_change',
      lifecycleRole: input.lifecycleRole ?? 'primary',
      parentWorkId: input.parentWorkId?.trim() || undefined,
      dispatchState: input.dispatchState ?? inferredDispatchState(input.status ?? 'open'),
      evidenceState: input.evidenceState ?? inferredEvidenceState(input.status ?? 'open'),
      completionOutcome: input.completionOutcome,
      phase: input.phase ?? inferredPhase(input.status ?? 'open'),
      phaseEvidence: legacyPhaseEvidence({
        phase: input.phase ?? inferredPhase(input.status ?? 'open'),
        status: input.status ?? 'open',
        evidenceRefs: input.evidenceRefs ?? [],
        completionReceipt: input.completionReceipt,
        updatedAt: input.updatedAt ?? at,
      }, 'recorded'),
      completionReceipt: input.completionReceipt,
      status: input.status ?? 'open',
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
      issueId: input.issueId,
      taskId: input.taskId,
      requirementId: input.requirementId,
      planId: input.planId,
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
      driver: input.driver ?? defaultDriver(input.mode),
      worktreePolicy: input.worktreePolicy ?? {
        required: input.mode === 'goal_workloop',
        reason: input.mode === 'goal_workloop' ? 'Goal workloop defaults to isolated worktree execution.' : undefined,
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
        if (readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', options.repoId, contract.workId)) {
          throw new Error(`work contract already exists: ${contract.workId}`);
        }
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'work_contract',
          scope: options.repoId,
          key: contract.workId,
          schemaVersion: 2,
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
      schemaVersion: 2,
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
      mode: input.mode ?? 'direct_control',
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
      driver: { preferred: 'external_controller', allowWorker: false, allowDirectEdit: input.operation.mode === 'readonly' || input.operation.mode === 'mutating' },
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

export function listWorkContracts(options: ListWorkContractOptions): WorkContract[] {
  const store = readWorkContractStore(options);
  const status = options.status ?? 'active';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  return store.contracts
    .filter((contract) => {
      if (status === 'all') return true;
      if (status === 'active') return !isTerminalWorkContractStatus(contract.status);
      return contract.status === status;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

const RECONCILIATION_EVIDENCE_TITLE = 'runtime reconciliation required';
const SYSTEM_ONLY_EVIDENCE_TITLES = new Set([
  RECONCILIATION_EVIDENCE_TITLE,
  'work contract created',
]);

function wasPausedByRuntimeReconciliation(contract: WorkContract): boolean {
  return contract.evidenceRefs.some((evidence) => evidence.title === RECONCILIATION_EVIDENCE_TITLE);
}

function hasReviewableWorkOutput(contract: WorkContract): boolean {
  if (contract.checkRefs.length > 0 || contract.handoffRefs.length > 0) return true;
  if ((contract.scopeEvidence?.inspectedPaths.length ?? 0) > 0) return true;
  if ((contract.readOnlyReviewEvidence?.inspectedPaths.length ?? 0) > 0 || (contract.readOnlyReviewEvidence?.findings.length ?? 0) > 0) return true;
  return contract.evidenceRefs.some((evidence) =>
    Boolean(evidence.artifactId || evidence.evidenceId)
    || !SYSTEM_ONLY_EVIDENCE_TITLES.has(evidence.title));
}

function unavailableReconciledWorktree(
  contract: WorkContract,
  input: WorkContractReconciliationInput,
): boolean {
  if (!contract.worktreeRef) return true;
  const availability = input.worktreeAvailability?.(contract.worktreeRef) ?? 'unknown';
  return availability === 'inactive' || availability === 'missing';
}

export function reconcileStaleWorkContracts(
  options: WorkContractStoreOptions,
  input: WorkContractReconciliationInput,
): WorkContractReconciliationResult {
  return withWorkContractStoreWrite(options, () => reconcileStaleWorkContractsLocked(options, input));
}

function reconcileStaleWorkContractsLocked(
  options: WorkContractStoreOptions,
  input: WorkContractReconciliationInput,
): WorkContractReconciliationResult {
  const store = readWorkContractStore(options);
  const running = store.contracts.filter((contract) => contract.status === 'running');
  const reconciledReviews = store.contracts.filter((contract) =>
    contract.status === 'blocked' && wasPausedByRuntimeReconciliation(contract));
  const candidates = [...running, ...reconciledReviews];
  const activeOwnership = input.activeExecutionJobs > 0 || input.activeLocalJobs > 0 || input.activeLeases > 0;
  if (activeOwnership || candidates.length === 0) {
    return {
      scanned: candidates.length,
      reconciled: 0,
      paused: 0,
      cancelled: 0,
      skippedForActiveOwnership: activeOwnership,
      workIds: [],
    };
  }

  const now = input.now ?? nowIso(options);
  const nowMs = Date.parse(now);
  const staleAfterMs = Math.max(60_000, Math.trunc(input.staleAfterMs ?? 30 * 60_000));
  if (!Number.isFinite(nowMs)) {
    return {
      scanned: candidates.length,
      reconciled: 0,
      paused: 0,
      cancelled: 0,
      skippedForActiveOwnership: false,
      workIds: [],
    };
  }

  const workIds: string[] = [];
  let paused = 0;
  let cancelled = 0;
  const contracts = store.contracts.map((contract) => {
    if (contract.status !== 'running' && contract.status !== 'blocked') return contract;
    const updatedMs = Date.parse(contract.updatedAt);
    if (!Number.isFinite(updatedMs) || nowMs - updatedMs < staleAfterMs) return contract;

    const shouldCancel = contract.status === 'blocked'
      && wasPausedByRuntimeReconciliation(contract)
      && !hasReviewableWorkOutput(contract)
      && unavailableReconciledWorktree(contract, input);
    if (shouldCancel) {
      workIds.push(contract.workId);
      cancelled += 1;
      const evidence: EvidenceRef = {
        title: 'runtime reconciliation cancelled orphaned work',
        summary: contract.worktreeRef
          ? 'Work remained ownerless without reviewable output and its isolated checkout is no longer recoverable.'
          : 'Work remained ownerless without reviewable output and has no recoverable worktree reference.',
        detailLevel: 'summary',
      };
      return {
        ...contract,
        status: 'cancelled' as const,
        updatedAt: now,
        evidenceRefs: [evidence, ...contract.evidenceRefs].slice(0, contract.evidencePolicy.maxEvidenceRefs),
        suggestedNextActions: [],
        continuationPrompt: `Runtime reconciliation cancelled orphaned work ${contract.workId}; no reviewable output or recoverable checkout remains.`.slice(0, 2_000),
      };
    }

    if (contract.status !== 'running') return contract;
    workIds.push(contract.workId);
    paused += 1;
    const evidence: EvidenceRef = {
      title: RECONCILIATION_EVIDENCE_TITLE,
      summary: 'Work was marked running but no active Execution Job, Local Job, or lease owns this repository. Automatic replay was not attempted.',
      detailLevel: 'summary',
    };
    const inspectAction: SuggestedNextAction = {
      label: 'Inspect reconciled work',
      tool: 'rh_context',
      operation: 'get',
      payload: { work_id: contract.workId },
      risk: 'readonly',
      confidence: 'high',
      reason: 'Review retained evidence before continuing, finalizing, or stopping this stale work.',
    };
    return {
      ...contract,
      status: 'blocked' as const,
      updatedAt: now,
      evidenceRefs: [evidence, ...contract.evidenceRefs].slice(0, contract.evidencePolicy.maxEvidenceRefs),
      suggestedNextActions: [inspectAction, ...contract.suggestedNextActions]
        .filter((action, index, actions) => actions.findIndex((candidate) => candidate.tool === action.tool && candidate.operation === action.operation) === index)
        .slice(0, 8),
      continuationPrompt: `Runtime reconciliation paused stale running work ${contract.workId}; inspect evidence and decide whether to continue, finalize, or stop.`.slice(0, 2_000),
    };
  });

  if (workIds.length > 0) {
    writeWorkContractStore(options, { schemaVersion: 2, updatedAt: now, contracts });
  }
  return {
    scanned: candidates.length,
    reconciled: workIds.length,
    paused,
    cancelled,
    skippedForActiveOwnership: false,
    workIds,
  };
}

export function getWorkContract(options: WorkContractStoreOptions, workId: string): WorkContract | undefined {
  const sanitizedId = sanitizeFileComponent(workId);
  return readWorkContractStore(options).contracts.find((contract) => contract.workId === sanitizedId);
}

export function summarizeWorkContract(contract: WorkContract): WorkContractSummary {
  return {
    workId: contract.workId,
    repoId: contract.repoId,
    mode: contract.mode,
    phase: contract.phase,
    status: contract.status,
    objective: contract.objective.slice(0, 240),
    updatedAt: contract.updatedAt,
    handoffCount: contract.handoffRefs.length,
    evidenceCount: contract.evidenceRefs.length,
    checkCount: contract.checkRefs.length,
  };
}

function updateWorkContractInternal(
  options: WorkContractStoreOptions,
  workId: string,
  patch: Partial<Omit<WorkContract, 'schemaVersion' | 'workId' | 'repoId' | 'createdAt'>>,
  allowCompletionWrite: boolean,
  allowPhaseWrite = false,
  allowRetainedCancelledResume = false,
  allowImplementationReviewWrite = false,
): WorkContract {
  return withWorkContractStoreWrite(options, () => {
    const sanitizedId = sanitizeFileComponent(workId);
    const store = readWorkContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.workId === sanitizedId);
    if (index < 0) throw new Error(`work contract not found: ${sanitizedId}`);
    const at = nowIso(options);
    const current = store.contracts[index];
    if (options.controllerHome) {
      assertWorkAdmissionAllowed(options.controllerHome, {
        operation: patch.status !== undefined && isTerminalWorkContractStatus(patch.status)
          ? 'maintenance'
          : 'continue',
        workId: sanitizedId,
      });
    }
    const writesCompletionReceipt = Object.prototype.hasOwnProperty.call(patch, 'completionReceipt');
    const changesCompletionOutcome = patch.completionOutcome !== undefined && patch.completionOutcome !== current.completionOutcome;
    const writesPhase = Object.prototype.hasOwnProperty.call(patch, 'phase') || Object.prototype.hasOwnProperty.call(patch, 'phaseEvidence');
    const writesImplementationReviews = Object.prototype.hasOwnProperty.call(patch, 'implementationReviews');
    if (!allowPhaseWrite && writesPhase) throw new Error('WORK_PHASE_REQUIRES_TRANSITION_API');
    if (!allowImplementationReviewWrite && writesImplementationReviews) throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRES_RECORD_API');
    const projectedPhase = patch.phase ?? phaseForStatusUpdate(current.phase, patch.status);
    const projectedPhaseEvidence = patch.phaseEvidence ?? (
      patch.status !== undefined && projectedPhase !== current.phase
        ? transitionPhaseEvidence(current, projectedPhase, {
            status: patch.status,
            summary: `Compatibility status transition ${current.status} -> ${patch.status}.`,
            evidenceRefs: patch.evidenceRefs ?? current.evidenceRefs,
            recordedAt: at,
          })
        : current.phaseEvidence
    );
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
    schemaVersion: 2,
    workId: current.workId,
    repoId: current.repoId,
    createdAt: current.createdAt,
    updatedAt: at,
    risk: patch.risk ?? current.risk,
    workKind: patch.workKind ?? current.workKind,
    phase: projectedPhase,
    phaseEvidence: projectedPhaseEvidence,
    dispatchState: patch.dispatchState ?? dispatchStateForStatusUpdate(current.dispatchState, patch.status),
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
    }), { allowRetainedCancelledResume });
    const contracts = [...store.contracts];
    contracts[index] = next;
    writeWorkContractStore(options, { schemaVersion: 2, updatedAt: at, contracts });
    return next;
  });
}

export function updateWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  patch: Partial<Omit<WorkContract, 'schemaVersion' | 'workId' | 'repoId' | 'createdAt'>>,
): WorkContract {
  return updateWorkContractInternal(options, workId, patch, false);
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
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  if (current.status !== 'cancelled' || current.dispatchState !== 'terminal' || current.phase !== 'cleanup') {
    throw new Error(`WORK_CANCELLED_RESUME_STATUS_INVALID: ${workId}`);
  }
  if (current.workKind !== 'repository_change') throw new Error(`WORK_CANCELLED_RESUME_KIND_INVALID: ${workId}`);
  if (current.completionReceipt || current.completionOutcome) throw new Error(`WORK_CANCELLED_RESUME_COMPLETION_CONFLICT: ${workId}`);
  if (current.phaseEvidence.cleanup.state !== 'skipped' || current.phaseEvidence.cleanup.source !== 'recorded') {
    throw new Error(`WORK_CANCELLED_RESUME_HISTORY_AMBIGUOUS: ${workId}`);
  }
  const originalPrincipal = current.principalId?.trim();
  if (!originalPrincipal || originalPrincipal !== input.principalId.trim()) {
    throw new Error(`WORK_CANCELLED_RESUME_PRINCIPAL_MISMATCH: ${workId}`);
  }
  const at = nowIso(options);
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
  return updateWorkContractInternal(options, workId, {
    status: 'running',
    phase: 'implementation',
    phaseEvidence,
    dispatchState: 'running',
    evidenceRefs,
    checkoutId: input.checkoutId ?? current.checkoutId,
    worktreeRef: input.worktreeRef ?? current.worktreeRef,
    controllerInstanceId: input.controllerInstanceId,
    continuationPrompt: input.summary,
  }, false, true, true);
}

/** Merge non-authoritative discovery/change evidence without changing policy fences. */
export function recordWorkScopeEvidence(
  options: WorkContractStoreOptions,
  workId: string,
  input: { initialLikelyPaths?: string[]; inspectedPaths?: string[]; actualChangedPaths?: string[] },
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  const previous = current.scopeEvidence ?? {
    initialLikelyPaths: [], inspectedPaths: [], actualChangedPaths: [], recordedAt: current.createdAt,
  };
  return updateWorkContract(options, workId, {
    scopeEvidence: {
      initialLikelyPaths: [...new Set([...previous.initialLikelyPaths, ...(input.initialLikelyPaths ?? [])])].slice(0, 100),
      inspectedPaths: [...new Set([...previous.inspectedPaths, ...(input.inspectedPaths ?? [])])].slice(0, 500),
      actualChangedPaths: [...new Set([...previous.actualChangedPaths, ...(input.actualChangedPaths ?? [])])].slice(0, 500),
      recordedAt: nowIso(options),
    },
  });
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
  },
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  const at = nowIso(options);
  if (input.phase === 'review') {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRES_REQUEST_API');
  }
  if (input.phase === 'delivery'
    && current.phase !== 'delivery'
    && workRequiresImplementationReview(current.workKind, current.scopeEvidence?.actualChangedPaths ?? [])) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRES_RECORD_API');
  }
  const phaseEvidence = transitionPhaseEvidence(current, input.phase, {
    status: input.status,
    summary: input.summary,
    evidenceRefs: input.evidenceRefs,
    recordedAt: at,
  });
  if (input.state) phaseEvidence[input.phase] = { ...phaseEvidence[input.phase], state: input.state };
  return updateWorkContractInternal(options, workId, {
    phase: input.phase,
    phaseEvidence,
    status: input.status,
  }, false, true);
}

/** Enter the first-class implementation-review phase without recording a decision. */
export function requestWorkImplementationReview(
  options: WorkContractStoreOptions,
  workId: string,
  summary: string,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  if (isTerminalWorkContractStatus(current.status)) throw new Error(`WORK_IMPLEMENTATION_REVIEW_TERMINAL: ${workId}`);
  if (current.phase !== 'verification' || current.phaseEvidence.verification.state !== 'satisfied') {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_VERIFIED_CANDIDATE_REQUIRED');
  }
  const at = nowIso(options);
  const phaseEvidence = transitionPhaseEvidence(current, 'review', {
    status: 'running',
    summary,
    recordedAt: at,
  });
  return updateWorkContractInternal(options, workId, {
    phase: 'review',
    phaseEvidence,
    status: 'running',
  }, false, true);
}

/** The only writer for durable Controller implementation-review authority. */
export function recordWorkImplementationReview(
  options: WorkContractStoreOptions,
  workId: string,
  review: WorkImplementationReviewRecord,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  if (isTerminalWorkContractStatus(current.status)) throw new Error(`WORK_IMPLEMENTATION_REVIEW_TERMINAL: ${workId}`);
  if (review.workId !== current.workId) throw new Error('WORK_IMPLEMENTATION_REVIEW_WORK_ID_MISMATCH');
  validateImplementationReviewRecord(review);
  if (review.derivation === 'content_equivalent_commit') {
    const parent = latestImplementationReview(current.implementationReviews);
    if (current.phase !== 'delivery'
      || !review.derivedFromReviewId
      || parent?.reviewId !== review.derivedFromReviewId
      || parent.decision !== 'approved') {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_DERIVATION_PHASE_REQUIRED');
    }
  } else if (current.phase !== 'review') {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_PHASE_REQUIRED');
  }
  const target = implementationReviewDecisionTarget(review.decision);
  const at = nowIso(options);
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
  return updateWorkContractInternal(options, workId, {
    phase: target.phase,
    phaseEvidence,
    status: target.status,
    implementationReviews: history,
  }, false, true, false, true);
}

export function appendWorkEvidence(
  options: WorkContractStoreOptions,
  workId: string,
  evidence: EvidenceRef,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  return updateWorkContract(options, workId, {
    evidenceRefs: [evidence, ...current.evidenceRefs].slice(0, current.evidencePolicy.maxEvidenceRefs),
  });
}

export function appendWorkHandoffRef(
  options: WorkContractStoreOptions,
  workId: string,
  handoffId: string,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  const handoffRefs = [sanitizeFileComponent(handoffId), ...current.handoffRefs.filter((id) => id !== sanitizeFileComponent(handoffId))].slice(0, 20);
  return updateWorkContract(options, workId, { handoffRefs });
}

export function appendVerificationRecord(
  options: WorkContractStoreOptions,
  workId: string,
  record: VerificationRecord,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  const checkRefs = [record, ...current.checkRefs].slice(0, 50);
  return updateWorkContract(options, workId, { checkRefs });
}

/**
 * The only supported path for turning Work evidence into a completion receipt.
 * Task/Run/Process callers may supply evidence, but they cannot manufacture a
 * receipt or a terminal Work projection without this identity and cleanup gate.
 */
export function recordWorkCompletionReceipt(
  options: WorkContractStoreOptions,
  workId: string,
  receipt: NonNullable<WorkContract['completionReceipt']>,
  completionOutcome: NonNullable<WorkContract['completionOutcome']>,
  completionWorkKind?: WorkKind,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  if (receipt.workId !== current.workId) throw new Error('WORK_COMPLETION_RECEIPT_IDENTITY_MISMATCH');
  if (current.completionReceipt) {
    if (current.completionReceipt.receiptId !== receipt.receiptId) throw new Error('WORK_COMPLETION_RECEIPT_ALREADY_RECORDED');
    return current;
  }
  const recordedAt = receipt.recordedAt;
  const receiptChangedPaths = isRepositoryCompletionReceipt(receipt) || isDirectEditWorkCompletionReceipt(receipt)
    ? receipt.changedPaths
    : [];
  const historicalReconciliationException = isDirectEditWorkCompletionReceipt(receipt)
    && Boolean(receipt.reconciliationId?.trim())
    && current.reconciliations.some((entry) => entry.reconciliationId === receipt.reconciliationId && entry.outcome === 'accepted_equivalence');
  const reviewRequired = workRequiresImplementationReview(completionWorkKind ?? current.workKind, receiptChangedPaths);
  if (reviewRequired && !historicalReconciliationException && !['satisfied', 'skipped'].includes(current.phaseEvidence.review.state)) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRED');
  }
  const phaseEvidence: WorkPhaseEvidenceMap = {
    ...current.phaseEvidence,
    implementation: { ...current.phaseEvidence.implementation, state: 'satisfied' },
    verification: { ...current.phaseEvidence.verification, state: 'satisfied' },
    review: reviewRequired
      ? historicalReconciliationException
        ? { state: 'skipped', source: 'recorded', summary: `Historical reviewed reconciliation ${receipt.reconciliationId} is the narrow compatibility authority for this already-delivered Direct Edit Work.`, evidenceRefs: current.evidenceRefs.slice(0, 20), recordedAt }
        : { ...current.phaseEvidence.review, state: 'satisfied' }
      : { state: 'skipped', source: 'recorded', summary: 'Implementation review is not required for this source-free Work completion.', evidenceRefs: [], recordedAt },
    delivery: { state: 'satisfied', source: 'recorded', summary: `Phase delivery accepted by Work completion receipt ${receipt.receiptId}.`, evidenceRefs: current.evidenceRefs.slice(0, 20), recordedAt, receiptId: receipt.receiptId },
    cleanup: { state: 'satisfied', source: 'recorded', summary: `Phase cleanup accepted by Work completion receipt ${receipt.receiptId}.`, evidenceRefs: current.evidenceRefs.slice(0, 20), recordedAt, receiptId: receipt.receiptId },
  };
  return updateWorkContractInternal(options, current.workId, {
    phase: 'cleanup',
    phaseEvidence,
    status: 'completed',
    dispatchState: 'terminal',
    evidenceState: 'valid',
    completionOutcome,
    ...(completionWorkKind ? { workKind: completionWorkKind } : {}),
    completionReceipt: receipt,
    scopeEvidence: {
      initialLikelyPaths: current.scopeEvidence?.initialLikelyPaths ?? current.allowedPaths,
      inspectedPaths: current.scopeEvidence?.inspectedPaths ?? [],
      actualChangedPaths: [...new Set(receiptChangedPaths)].slice(0, 500),
      recordedAt,
    },
  }, true, true);
}
export interface AcceptSubmittedWorkInput {
  requestId: string;
  repoId: string;
  parentWorkId?: string;
  semanticKey: string;
  operation: SubmittedWorkOperation;
  objective?: string;
  mode?: WorkContract['mode'];
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
