import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import { readOrImportControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';
import {
  type EvidenceRef,
  type CompletionOutcome,
  type DispatchState,
  type EvidenceState,
  type PolicyDecision,
  type SubmittedWorkOperation,
  type SuggestedNextAction,
  type VerificationRecord,
  type WorkReconciliationRecord,
  type WorkContract,
  type WorkContractStatus,
  type WorkKind,
  type WorkContractStore,
  isTerminalWorkContractStatus,
} from './types';

export interface WorkContractStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface WorkContractStoreOptions extends WorkContractStoreLocation {
  now?: () => string;
}

export type CreateWorkContractInput = Omit<
  WorkContract,
  'schemaVersion' | 'status' | 'createdAt' | 'updatedAt' | 'workKind' | 'dispatchState' | 'evidenceState' | 'completionOutcome' | 'evidenceRefs' | 'handoffRefs' | 'suggestedNextActions' | 'policyDecisions' | 'checkRefs' | 'reconciliations' | 'driver' | 'worktreePolicy' | 'evidencePolicy' | 'approvalPolicy' | 'recoveryPolicy'
> & {
  status?: WorkContractStatus;
  createdAt?: string;
  updatedAt?: string;
  workKind?: WorkKind;
  dispatchState?: DispatchState;
  evidenceState?: EvidenceState;
  completionOutcome?: CompletionOutcome;
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

function validateWorkSemantics(contract: WorkContract): WorkContract {
  const outcome = contract.completionOutcome;
  if (!outcome) return contract;
  if (contract.dispatchState !== 'terminal') {
    throw new Error(`WORK_SEMANTICS_INVALID: ${outcome} requires terminal dispatch`);
  }
  if (contract.evidenceState !== 'valid') {
    throw new Error(`WORK_SEMANTICS_INVALID: ${outcome} requires valid evidence`);
  }
  if (outcome === 'completed_changed' && contract.workKind !== 'repository_change') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_changed requires repository_change WorkKind');
  }
  if (outcome === 'completed_no_change' && contract.workKind !== 'completed_no_change') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_no_change requires completed_no_change WorkKind');
  }
  if (outcome === 'completed_remote' && contract.workKind !== 'remote_effect') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_remote requires remote_effect WorkKind');
  }
  if (outcome === 'superseded' && contract.workKind !== 'superseded') {
    throw new Error('WORK_SEMANTICS_INVALID: superseded requires superseded WorkKind');
  }
  return contract;
}

const DISPATCH_TRANSITIONS: Readonly<Record<DispatchState, readonly DispatchState[]>> = {
  not_dispatched: ['not_dispatched', 'claimed', 'launching', 'running', 'blocked', 'terminal'],
  claimed: ['claimed', 'launching', 'running', 'blocked', 'terminal'],
  launching: ['launching', 'running', 'blocked', 'terminal'],
  running: ['running', 'blocked', 'terminal'],
  blocked: ['blocked', 'claimed', 'launching', 'running', 'terminal'],
  terminal: ['terminal'],
};

const EVIDENCE_TRANSITIONS: Readonly<Record<EvidenceState, readonly EvidenceState[]>> = {
  none: ['none', 'partial', 'valid', 'failed'],
  partial: ['partial', 'valid', 'stale', 'contradictory', 'failed'],
  valid: ['valid', 'stale', 'contradictory', 'failed'],
  stale: ['stale', 'partial', 'valid', 'contradictory', 'failed'],
  contradictory: ['contradictory', 'partial', 'valid', 'failed'],
  failed: ['failed', 'partial', 'valid', 'contradictory'],
};

function validateWorkSemanticTransition(current: WorkContract, next: WorkContract): WorkContract {
  const retryingFailedWork = current.status === 'failed'
    && !current.completionOutcome
    && ['claimed', 'launching', 'running', 'blocked'].includes(next.dispatchState);
  if (!retryingFailedWork && !DISPATCH_TRANSITIONS[current.dispatchState].includes(next.dispatchState)) {
    throw new Error(`WORK_SEMANTICS_TRANSITION_INVALID: dispatch ${current.dispatchState} -> ${next.dispatchState}`);
  }
  if (!EVIDENCE_TRANSITIONS[current.evidenceState].includes(next.evidenceState)) {
    throw new Error(`WORK_SEMANTICS_TRANSITION_INVALID: evidence ${current.evidenceState} -> ${next.evidenceState}`);
  }
  if (current.completionOutcome && current.completionOutcome !== next.completionOutcome) {
    throw new Error(`WORK_SEMANTICS_TRANSITION_INVALID: completion outcome ${current.completionOutcome} is immutable`);
  }
  return next;
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
      const status = ({ pending: 'open', waiting_for_review: 'ready', succeeded: 'completed' } as Record<string, WorkContractStatus>)[String(legacy.status)] ?? legacy.status;
      return validateWorkSemantics({
        ...legacy,
        schemaVersion: legacy.schemaVersion ?? 1,
        status,
        workKind: legacy.workKind ?? 'repository_change',
        dispatchState: legacy.dispatchState ?? inferredDispatchState(status),
        evidenceState: legacy.evidenceState ?? inferredEvidenceState(status),
        reconciliations: legacy.reconciliations ?? [],
        driver: (legacy.driver as unknown as { preferred?: string } | undefined)?.preferred === 'codex_worker'
          ? { ...legacy.driver, preferred: 'external_controller', allowWorker: false }
          : legacy.driver,
      });
    }),
  };
}

export function readWorkContractStore(options: WorkContractStoreOptions): WorkContractStore {
  if (sqliteBacked(options)) {
    const legacyPath = workContractStorePath(options);
    const record = readOrImportControlPlaneRecord<WorkContractStore>(options.controllerHome, {
      namespace: 'work_contract_store',
      scope: options.repoId,
      key: 'index',
      schemaVersion: 2,
      readLegacy: () => readJsonFile<WorkContractStore>(legacyPath, emptyWorkContractStore(nowIso(options))),
    });
    return normalizeWorkContractStore(record?.value ?? emptyWorkContractStore(nowIso(options)));
  }
  return normalizeWorkContractStore(readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options))));
}

export function writeWorkContractStore(options: WorkContractStoreOptions, store: WorkContractStore): WorkContractStore {
  if (sqliteBacked(options)) {
    writeControlPlaneRecord(options.controllerHome, {
      namespace: 'work_contract_store',
      scope: options.repoId,
      key: 'index',
      schemaVersion: store.schemaVersion,
      value: store,
      action: 'work_contract_store_write',
    });
    return store;
  }
  writeJsonAtomic(workContractStorePath(options), store);
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
  return withWorkContractStoreWrite(options, () => {
    const at = input.createdAt ?? input.updatedAt ?? nowIso(options);
    const workId = sanitizeFileComponent(input.workId);
    const contract: WorkContract = validateWorkSemantics({
      schemaVersion: 2,
      workId,
      repoId: input.repoId,
      mode: input.mode,
      objective: input.objective.slice(0, 2_000),
      acceptanceCriteria: (input.acceptanceCriteria ?? []).slice(0, 20).map((item) => item.slice(0, 500)),
      constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
      workKind: input.workKind ?? 'repository_change',
      dispatchState: input.dispatchState ?? inferredDispatchState(input.status ?? 'open'),
      evidenceState: input.evidenceState ?? inferredEvidenceState(input.status ?? 'open'),
      completionOutcome: input.completionOutcome,
      status: input.status ?? 'open',
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
      issueId: input.issueId,
      taskId: input.taskId,
      planId: input.planId,
      planStepId: input.planStepId,
      planSourceRevision: input.planSourceRevision,
      scopeSummary: input.scopeSummary?.slice(0, 1_000),
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
      reconciliations: (input.reconciliations ?? []).slice(0, 20),
      continuationPrompt: input.continuationPrompt?.slice(0, 2_000),
      worktreeRef: input.worktreeRef,
      workerRef: input.workerRef,
      requestId: input.requestId?.trim() || undefined,
      submittedOperation: input.submittedOperation,
    });

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
  });
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

export interface AcceptSubmittedWorkInput {
  requestId: string;
  repoId: string;
  semanticKey: string;
  operation: SubmittedWorkOperation;
  objective?: string;
  mode?: WorkContract['mode'];
  requestedBy?: WorkContract['requestedBy'];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  checks?: string[];
  acceptanceCriteria?: string[];
  constraints?: WorkContract['constraints'];
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
 * Accept one work_submit operation as a WorkContract without creating ExecutionJobs.
 * Same controllerHome + requestId + semanticKey returns the original contract.
 */
export function acceptSubmittedWorkContract(
  controllerHome: string,
  input: AcceptSubmittedWorkInput,
  options: WorkContractStoreOptions = {},
): { contract: WorkContract; deduplicated: boolean } {
  const home = ensureControllerHome(controllerHome);
  const normalizedRequestId = input.requestId.trim();
  if (!normalizedRequestId) {
    throw new Error('INVALID_ARGUMENT: work_submit is missing required argument(s): request_id');
  }
  const normalizedSemanticKey = input.semanticKey.trim();
  if (!normalizedSemanticKey) {
    throw new Error('INVALID_ARGUMENT: work_submit requires a semantic operation key');
  }
  if (!input.repoId.trim()) {
    throw new Error('INVALID_ARGUMENT: work_submit is missing required argument(s): repo_id');
  }
  if (!input.operation?.name?.trim()) {
    throw new Error('INVALID_ARGUMENT: work_submit is missing required argument(s): operation');
  }

  const requestLockId = createHash('sha256').update(normalizedRequestId).digest('hex').slice(0, 24);
  return withControllerLock(home, { scope: 'global', resource: `work-request-${requestLockId}` }, `accept-work:${normalizedRequestId}`, () => {
    const recordPath = workRequestIndexPath(home, normalizedRequestId);
    if (existsSync(recordPath)) {
      const record = readJsonFile<WorkRequestIndexRecord>(recordPath);
      if (record.repoId !== input.repoId) {
        throw new Error(`REQUEST_ID_REPO_CONFLICT: ${normalizedRequestId} already belongs to repository ${record.repoId}`);
      }
      if (record.semanticKey !== normalizedSemanticKey) {
        throw new Error(`REQUEST_ID_CONFLICT: ${normalizedRequestId} already belongs to ${record.semanticKey}`);
      }
      const existing = getWorkContract({ controllerHome: home, repoId: record.repoId, now: options.now }, record.workId);
      if (!existing) {
        throw new Error(`WORK_ACCEPTANCE_LOST: request ${normalizedRequestId} is indexed without a readable WorkContract`);
      }
      return { contract: existing, deduplicated: true };
    }

    const contract = createWorkContract({ controllerHome: home, repoId: input.repoId, now: options.now }, {
      workId: `WORK-${Date.now()}-${randomUUID().slice(0, 8)}`,
      repoId: input.repoId,
      mode: input.mode ?? 'direct_control',
      objective: (input.objective ?? `Accepted operation ${input.operation.name}`).slice(0, 2_000),
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
      allowedPaths: input.allowedPaths ?? [],
      forbiddenPaths: input.forbiddenPaths ?? [],
      checks: input.checks ?? [],
      requestedBy: input.requestedBy ?? 'chatgpt',
      status: 'open',
      requestId: normalizedRequestId,
      submittedOperation: input.operation,
      driver: {
        preferred: 'external_controller',
        allowWorker: false,
        allowDirectEdit: input.operation.mode === 'readonly' || input.operation.mode === 'mutating',
      },
      suggestedNextActions: [{
        label: 'Claim controller ownership',
        tool: 'rh_work',
        operation: 'controller_claim',
        risk: 'readonly',
        confidence: 'high',
        reason: 'Claim this Work before launching an external SuperController or Process Runtime command.',
      }],
    });

    writeJsonAtomic(recordPath, {
      requestId: normalizedRequestId,
      repoId: input.repoId,
      workId: contract.workId,
      semanticKey: normalizedSemanticKey,
      createdAt: contract.createdAt,
    } satisfies WorkRequestIndexRecord);

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
    status: contract.status,
    objective: contract.objective.slice(0, 240),
    updatedAt: contract.updatedAt,
    handoffCount: contract.handoffRefs.length,
    evidenceCount: contract.evidenceRefs.length,
    checkCount: contract.checkRefs.length,
  };
}

export function updateWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  patch: Partial<Omit<WorkContract, 'schemaVersion' | 'workId' | 'repoId' | 'createdAt'>>,
): WorkContract {
  return withWorkContractStoreWrite(options, () => {
    const sanitizedId = sanitizeFileComponent(workId);
    const store = readWorkContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.workId === sanitizedId);
    if (index < 0) throw new Error(`work contract not found: ${sanitizedId}`);
    const at = nowIso(options);
    const current = store.contracts[index];
    const next: WorkContract = validateWorkSemanticTransition(current, validateWorkSemantics({
    ...current,
    ...patch,
    schemaVersion: 2,
    workId: current.workId,
    repoId: current.repoId,
    createdAt: current.createdAt,
    updatedAt: at,
    workKind: patch.workKind ?? current.workKind,
    dispatchState: patch.dispatchState ?? dispatchStateForStatusUpdate(current.dispatchState, patch.status),
    evidenceState: patch.evidenceState ?? current.evidenceState,
    completionOutcome: patch.completionOutcome ?? current.completionOutcome,
    evidenceRefs: (patch.evidenceRefs ?? current.evidenceRefs).slice(0, current.evidencePolicy.maxEvidenceRefs),
    handoffRefs: (patch.handoffRefs ?? current.handoffRefs).slice(0, 20),
    suggestedNextActions: (patch.suggestedNextActions ?? current.suggestedNextActions).slice(0, 8),
    policyDecisions: (patch.policyDecisions ?? current.policyDecisions).slice(0, 20),
    checkRefs: (patch.checkRefs ?? current.checkRefs).slice(0, 50),
    reconciliations: (patch.reconciliations ?? current.reconciliations ?? []).slice(0, 20),
    objective: (patch.objective ?? current.objective).slice(0, 2_000),
    continuationPrompt: (patch.continuationPrompt ?? current.continuationPrompt)?.slice(0, 2_000),
    }));
    const contracts = [...store.contracts];
    contracts[index] = next;
    writeWorkContractStore(options, { schemaVersion: 2, updatedAt: at, contracts });
    return next;
  });
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
