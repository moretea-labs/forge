import { createHash } from 'crypto';
import {
  getEditSession,
  recordEditSessionProcessCheckReceipts,
  type EditSession,
} from '../../../cli/editing/edit-session';
import {
  controllerCheckExecutionIdentity,
  listControllerChecks,
} from '../../../cli/controller/check-runner';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { executionIdentityForRepository } from './execution-identity';
import { getWorkContract } from '../facade/work-contract-store';
import { verifyGoalWorkloop } from '../facade/goal-workloop';
import { commandFingerprint, verificationInputFingerprint, workspaceValidationFingerprint } from './verification-evidence';
import {
  claimsForCheck,
  getProcessRecord,
  processCheckCompletionReceipt,
  processCheckSemanticScopeKey,
  runPersistedCheckViaProcessRuntime,
  type ProcessCheckCompletionReceipt,
} from '../../execution/process-runtime';
import { resourceClaimsConflict } from '../../resources/claims/conflicts';
import {
  mutateControlPlaneRecord,
  readControlPlaneRecord,
} from '../persistence/sqlite-store';

const EDIT_VALIDATION_RUN_NAMESPACE = 'execution_edit_validation_run';
const EDIT_VALIDATION_INDEX_NAMESPACE = 'execution_edit_validation_index';
const EDIT_VALIDATION_INDEX_KEY = 'v1';

export interface EditValidationRunState {
  schemaVersion: 1;
  validationId: string;
  repositoryId: string;
  checkoutId: string;
  editSessionId: string;
  editRevision: number;
  requestId: string;
  /** Exact Work verification source identity captured before any lane starts. */
  sourceRevision?: string;
  workspaceFingerprint?: string;
  checkIds: string[];
  lanes: string[][];
  processes: Record<string, { processId: string; requestId: string }>;
  reviewer?: string;
  note?: string;
  timeoutMs?: number;
  leaseWaitMs: number;
  status: 'running' | 'completed' | 'failed';
  ok?: boolean;
  error?: { code: string; message: string };
  receipts?: ProcessCheckCompletionReceipt[];
  createdAt: string;
  updatedAt: string;
}

interface EditValidationIndex {
  schemaVersion: 1;
  updatedAt: string;
  validationIds: string[];
}

export interface EditValidationCoordinatorResult {
  accepted: boolean;
  mode: 'direct' | 'managed' | 'durable';
  path: 'process_direct' | 'process_managed' | 'durable';
  completed: boolean;
  ok?: boolean;
  sessionId: string;
  editRevision: number;
  validationRequestId: string;
  validationId: string;
  processes: Array<{ checkId: string; processId: string; requestId: string; completed?: boolean; ok?: boolean; status?: string }>;
  receipts?: ProcessCheckCompletionReceipt[];
  session?: EditSession;
  error?: { code: string; message: string };
  message?: string;
  suggestedOperation?: string;
  next: string;
  durableSideEffects: {
    executionJobCount: 0;
    localJobCount: 0;
    workerSpawnCount: 0;
    projectionUpdateCount: 0;
  };
}

export interface EditValidationStartInput {
  editSessionId: string;
  checkIds?: string[];
  requestId?: string;
  validationRequestId?: string;
  reviewer?: string;
  note?: string;
  timeoutMs?: number;
  leaseWaitMs?: number;
}

const ZERO_DURABLE_SIDE_EFFECTS = {
  executionJobCount: 0 as const,
  localJobCount: 0 as const,
  workerSpawnCount: 0 as const,
  projectionUpdateCount: 0 as const,
};

function now(): string {
  return new Date().toISOString();
}

function normalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validationId(repositoryId: string, editSessionId: string, editRevision: number, requestId: string): string {
  return `editval_${createHash('sha256')
    .update(`${repositoryId}\n${editSessionId}\n${editRevision}\n${requestId}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function readIndex(controllerHome: string, repositoryId: string): EditValidationIndex {
  return readControlPlaneRecord<EditValidationIndex>(
    controllerHome,
    EDIT_VALIDATION_INDEX_NAMESPACE,
    repositoryId,
    EDIT_VALIDATION_INDEX_KEY,
  )?.value ?? { schemaVersion: 1, updatedAt: now(), validationIds: [] };
}

function setIndexMembership(controllerHome: string, repositoryId: string, id: string, active: boolean): void {
  mutateControlPlaneRecord<EditValidationIndex>(controllerHome, {
    namespace: EDIT_VALIDATION_INDEX_NAMESPACE,
    scope: repositoryId,
    key: EDIT_VALIDATION_INDEX_KEY,
    schemaVersion: 1,
    action: active ? 'edit_validation_index_add' : 'edit_validation_index_remove',
    mutate: (current) => {
      const ids = new Set(current?.value.validationIds ?? []);
      if (active) ids.add(id); else ids.delete(id);
      return { schemaVersion: 1, updatedAt: now(), validationIds: [...ids].sort() };
    },
  });
}

function readRun(controllerHome: string, repositoryId: string, id: string): EditValidationRunState | undefined {
  return readControlPlaneRecord<EditValidationRunState>(
    controllerHome,
    EDIT_VALIDATION_RUN_NAMESPACE,
    repositoryId,
    id,
  )?.value;
}

function saveRun(controllerHome: string, run: EditValidationRunState): EditValidationRunState {
  const saved = mutateControlPlaneRecord<EditValidationRunState>(controllerHome, {
    namespace: EDIT_VALIDATION_RUN_NAMESPACE,
    scope: run.repositoryId,
    key: run.validationId,
    schemaVersion: 1,
    action: `edit_validation_${run.status}`,
    mutate: (current) => ({
      ...run,
      createdAt: current?.value.createdAt ?? run.createdAt,
      processes: { ...(current?.value.processes ?? {}), ...run.processes },
      updatedAt: now(),
    }),
  }).value;
  setIndexMembership(controllerHome, run.repositoryId, run.validationId, saved.status === 'running');
  return saved;
}

function checkLanes(repository: RepositoryRecord, checkIds: string[]): string[][] {
  const checks = new Map(listControllerChecks(repository.canonicalRoot).map((check) => [check.id, check] as const));
  const claimSets = checkIds.map((checkId) => {
    const check = checks.get(checkId);
    return claimsForCheck(
      checkId,
      check?.command,
      repository.repoId,
      repository.activeCheckoutId,
      check?.effects,
    );
  });
  const lanes: string[][] = [];
  const assigned = new Set<number>();
  for (let start = 0; start < checkIds.length; start += 1) {
    if (assigned.has(start)) continue;
    const lane: number[] = [];
    const queue = [start];
    assigned.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      lane.push(current);
      for (let candidate = 0; candidate < checkIds.length; candidate += 1) {
        if (assigned.has(candidate)) continue;
        const conflicts = claimSets[current]!.some((left) =>
          claimSets[candidate]!.some((right) => resourceClaimsConflict(left, right)));
        if (!conflicts) continue;
        assigned.add(candidate);
        queue.push(candidate);
      }
    }
    lanes.push(lane.sort((left, right) => left - right).map((index) => checkIds[index]!));
  }
  return lanes;
}

function processSummaries(controllerHome: string, run: EditValidationRunState): EditValidationCoordinatorResult['processes'] {
  return run.checkIds.flatMap((checkId) => {
    const binding = run.processes[checkId];
    if (!binding) return [];
    const record = getProcessRecord(controllerHome, run.repositoryId, binding.processId);
    return [{
      checkId,
      processId: binding.processId,
      requestId: binding.requestId,
      ...(record ? {
        completed: !['starting', 'running', 'running_recovered'].includes(record.status),
        ok: record.status === 'succeeded',
        status: record.status,
      } : {}),
    }];
  });
}

function coordinatorResult(
  controllerHome: string,
  run: EditValidationRunState,
  session?: EditSession,
): EditValidationCoordinatorResult {
  const failed = run.status === 'failed';
  const completed = run.status === 'completed' || failed;
  return {
    accepted: !failed,
    mode: failed || run.status === 'completed' ? 'direct' : 'managed',
    path: failed || run.status === 'completed' ? 'process_direct' : 'process_managed',
    completed,
    ...(run.ok !== undefined ? { ok: run.ok } : {}),
    sessionId: run.editSessionId,
    editRevision: run.editRevision,
    validationRequestId: run.requestId,
    validationId: run.validationId,
    processes: processSummaries(controllerHome, run),
    ...(run.receipts ? { receipts: run.receipts } : {}),
    ...(session ? { session } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.error ? { message: run.error.message } : {}),
    next: run.status === 'running'
      ? 'Validation is running in Process Runtime. Forge Scheduler will advance conflict lanes automatically; continue independent work and join once when validation becomes a real dependency.'
      : run.status === 'completed'
        ? 'Validation is complete for the exact edit revision.'
        : 'Validation could not continue. Inspect the structured error before retrying or changing the edit revision.',
    durableSideEffects: ZERO_DURABLE_SIDE_EFFECTS,
  };
}

function failedRun(
  controllerHome: string,
  run: EditValidationRunState,
  code: string,
  message: string,
): EditValidationCoordinatorResult {
  const failed = saveRun(controllerHome, {
    ...run,
    status: 'failed',
    ok: false,
    error: { code, message },
  });
  return coordinatorResult(controllerHome, failed);
}

export function resolveEditValidationRepository(
  repository: RepositoryRecord,
  editSessionId: string,
): { repository: RepositoryRecord; session: EditSession } {
  const checkoutIds = [...new Set([
    repository.activeCheckoutId,
    ...repository.checkouts.map((checkout) => checkout.checkoutId),
  ].filter(Boolean))];
  for (const checkoutId of checkoutIds) {
    let candidate: RepositoryRecord;
    try {
      candidate = selectRepositoryCheckout(repository, checkoutId);
    } catch {
      continue;
    }
    let session: EditSession;
    try {
      session = getEditSession(candidate.canonicalRoot, editSessionId);
    } catch (error) {
      if (error instanceof Error && error.message === `edit session not found: ${editSessionId}`) continue;
      throw error;
    }
    if (session.repoId && session.repoId !== candidate.repoId) {
      throw new Error(`EDIT_VALIDATION_SESSION_IDENTITY_MISMATCH: repoId ${session.repoId} != ${candidate.repoId}`);
    }
    if (session.checkoutId && session.checkoutId !== candidate.activeCheckoutId) {
      throw new Error(`EDIT_VALIDATION_SESSION_IDENTITY_MISMATCH: checkoutId ${session.checkoutId} != ${candidate.activeCheckoutId}`);
    }
    return { repository: candidate, session };
  }
  throw new Error(`edit session not found: ${editSessionId}`);
}

function validationRunRepository(
  repository: RepositoryRecord,
  run: EditValidationRunState,
): RepositoryRecord {
  if (run.repositoryId !== repository.repoId) {
    throw new Error(`EDIT_VALIDATION_REPOSITORY_MISMATCH: ${run.repositoryId} != ${repository.repoId}`);
  }
  const candidate = selectRepositoryCheckout(repository, run.checkoutId);
  const session = getEditSession(candidate.canonicalRoot, run.editSessionId);
  if (session.repoId && session.repoId !== run.repositoryId) {
    throw new Error(`EDIT_VALIDATION_SESSION_IDENTITY_MISMATCH: repoId ${session.repoId} != ${run.repositoryId}`);
  }
  if (session.checkoutId && session.checkoutId !== run.checkoutId) {
    throw new Error(`EDIT_VALIDATION_SESSION_IDENTITY_MISMATCH: checkoutId ${session.checkoutId} != ${run.checkoutId}`);
  }
  return candidate;
}

function receiptFor(
  controllerHome: string,
  repository: RepositoryRecord,
  run: EditValidationRunState,
  checkId: string,
): ProcessCheckCompletionReceipt {
  const binding = run.processes[checkId];
  if (!binding) throw new Error(`EDIT_VALIDATION_PROCESS_MISSING: ${checkId}`);
  const record = getProcessRecord(controllerHome, repository.repoId, binding.processId);
  if (!record) throw new Error(`EDIT_VALIDATION_PROCESS_RECORD_MISSING: ${binding.processId}`);
  const currentIdentity = record.checkExecution
    ? controllerCheckExecutionIdentity(repository.canonicalRoot, checkId, record.checkExecution.timeoutMs)
    : undefined;
  return processCheckCompletionReceipt(record, {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    workId: getEditSession(repository.canonicalRoot, run.editSessionId).workId,
    editSessionId: run.editSessionId,
    editRevision: run.editRevision,
    checkId,
    processId: binding.processId,
    ...(currentIdentity ? {
      checkExecution: {
        cacheKey: currentIdentity.cacheKey,
        revision: currentIdentity.revision,
        definitionDigest: currentIdentity.definitionDigest,
        environmentFingerprint: currentIdentity.environmentFingerprint,
        timeoutMs: currentIdentity.timeoutMs,
        scopeKey: processCheckSemanticScopeKey({
          checkoutId: repository.activeCheckoutId,
          workId: getEditSession(repository.canonicalRoot, run.editSessionId).workId,
          verificationBinding: {
            editSessionId: run.editSessionId,
            editRevision: run.editRevision,
          },
        }, currentIdentity.reuseScope),
      },
    } : {}),
  });
}

export async function reconcileEditValidationRun(
  controllerHome: string,
  repository: RepositoryRecord,
  runInput: EditValidationRunState,
): Promise<EditValidationCoordinatorResult> {
  let run = readRun(controllerHome, repository.repoId, runInput.validationId) ?? runInput;
  if (run.status !== 'running') return coordinatorResult(controllerHome, run);
  let validationRepository: RepositoryRecord;
  try {
    validationRepository = validationRunRepository(repository, run);
  } catch (error) {
    return failedRun(
      controllerHome,
      run,
      'EDIT_VALIDATION_CHECKOUT_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
  const session = getEditSession(validationRepository.canonicalRoot, run.editSessionId);
  if (session.currentRevision !== run.editRevision) {
    return failedRun(controllerHome, run, 'EDIT_VALIDATION_STALE_REVISION', `Validation targets revision ${run.editRevision}, current edit revision is ${session.currentRevision}.`);
  }

  const work = session.workId
    ? getWorkContract({ controllerHome, repoId: validationRepository.repoId }, session.workId)
    : undefined;
  if (session.workId && !work) {
    return failedRun(controllerHome, run, 'EDIT_VALIDATION_WORK_NOT_FOUND', `WorkContract ${session.workId} is unavailable for this Work-bound EditSession.`);
  }
  const status = repositoryGitStatus(validationRepository);
  const currentSourceRevision = status.head?.trim();
  const currentWorkspaceFingerprint = workspaceValidationFingerprint(validationRepository.canonicalRoot, status);
  if (session.workId && (!run.sourceRevision || !run.workspaceFingerprint)) {
    return failedRun(controllerHome, run, 'EDIT_VALIDATION_WORK_IDENTITY_REQUIRED', 'Work-bound Edit validation requires a persisted exact source revision and workspace fingerprint.');
  }
  if (run.sourceRevision && currentSourceRevision !== run.sourceRevision) {
    return failedRun(controllerHome, run, 'EDIT_VALIDATION_SOURCE_CHANGED', `Validation source changed from ${run.sourceRevision} to ${currentSourceRevision ?? 'unavailable'}.`);
  }
  if (run.workspaceFingerprint && currentWorkspaceFingerprint !== run.workspaceFingerprint) {
    return failedRun(controllerHome, run, 'EDIT_VALIDATION_WORKSPACE_CHANGED', 'Validation workspace changed after the persisted Process identity was captured.');
  }

  for (const lane of run.lanes) {
    for (const checkId of lane) {
      const binding = run.processes[checkId];
      if (binding) {
        const record = getProcessRecord(controllerHome, repository.repoId, binding.processId);
        if (!record) return failedRun(controllerHome, run, 'EDIT_VALIDATION_PROCESS_RECORD_MISSING', `Process record is unavailable: ${binding.processId}`);
        if (['starting', 'running', 'running_recovered'].includes(record.status)) break;
        continue;
      }

      const index = run.checkIds.indexOf(checkId);
      const checkRequestId = `${run.requestId}:check:${index + 1}:${createHash('sha256').update(checkId).digest('hex').slice(0, 12)}`;
      const facade = await runPersistedCheckViaProcessRuntime({
        controllerHome,
        repoId: validationRepository.repoId,
        checkoutId: validationRepository.activeCheckoutId,
        repoRoot: validationRepository.canonicalRoot,
        executionIdentity: executionIdentityForRepository(validationRepository, session.workId ? { workId: session.workId } : {}),
        checkId,
        timeoutMs: run.timeoutMs,
        interactiveWaitMs: 0,
        requestId: checkRequestId,
        requestSemanticFingerprint: session.workId && run.sourceRevision && run.workspaceFingerprint
          ? verificationInputFingerprint({
              sourceRevision: run.sourceRevision,
              workspaceFingerprint: run.workspaceFingerprint,
              checkId,
              requestedChecks: work?.checks.length ? work.checks : run.checkIds,
            })
          : undefined,
        workId: session.workId,
        commandId: checkRequestId,
        verificationBinding: {
          editSessionId: run.editSessionId,
          editRevision: run.editRevision,
          issueId: session.issueId,
          taskId: session.taskId,
        },
        verificationSnapshot: work ? {
          workId: work.workId,
          allowedPaths: work.allowedPaths,
          forbiddenPaths: work.forbiddenPaths,
        } : undefined,
        leaseWaitMs: run.leaseWaitMs,
      });
      if (facade.mode === 'durable' || !facade.process) {
        return failedRun(
          controllerHome,
          run,
          'EDIT_VALIDATION_DURABLE_CHECK_REQUIRED',
          facade.durable?.reason ?? `Check ${checkId} cannot run through Process Runtime.`,
        );
      }
      run = saveRun(controllerHome, {
        ...run,
        processes: {
          ...run.processes,
          [checkId]: { processId: facade.process.processId, requestId: checkRequestId },
        },
      });
      if (!facade.process.completed) break;
    }
  }

  const allBound = run.checkIds.every((checkId) => Boolean(run.processes[checkId]));
  if (!allBound) return coordinatorResult(controllerHome, run, session);
  const records = run.checkIds.map((checkId) => {
    const binding = run.processes[checkId]!;
    return getProcessRecord(controllerHome, repository.repoId, binding.processId);
  });
  if (records.some((record) => !record)) {
    return failedRun(controllerHome, run, 'EDIT_VALIDATION_PROCESS_RECORD_MISSING', 'One or more validation process records are unavailable.');
  }
  if (records.some((record) => ['starting', 'running', 'running_recovered'].includes(record!.status))) {
    return coordinatorResult(controllerHome, run, session);
  }

  try {
    const receipts = run.checkIds.map((checkId) => receiptFor(controllerHome, validationRepository, run, checkId));
    if (session.workId && work) {
      if (!run.sourceRevision || !run.workspaceFingerprint) throw new Error('EDIT_VALIDATION_WORK_IDENTITY_REQUIRED');
      const availableChecks = listControllerChecks(validationRepository.canonicalRoot);
      const workloopCtx = {
        workStore: { controllerHome, repoId: validationRepository.repoId },
        handoffStore: { controllerHome, repoId: validationRepository.repoId },
        repoId: validationRepository.repoId,
        availableChecks,
        sourceRevision: run.sourceRevision,
        workspaceFingerprint: run.workspaceFingerprint,
      };
      for (const receipt of receipts) {
        const checkId = receipt.checkId;
        const inputFingerprint = verificationInputFingerprint({
          sourceRevision: run.sourceRevision,
          workspaceFingerprint: run.workspaceFingerprint,
          checkId,
          requestedChecks: work.checks.length ? work.checks : run.checkIds,
        });
        const infrastructureFailed = receipt.timedOut || receipt.cancelled || (!receipt.ok && receipt.status !== 'failed');
        verifyGoalWorkloop(workloopCtx, {
          workId: session.workId,
          checkId,
          sourceRevision: run.sourceRevision,
          workspaceFingerprint: run.workspaceFingerprint,
          verificationInputFingerprint: inputFingerprint,
          commandFingerprint: commandFingerprint(checkId, receipt.commandId),
          receipt,
          infrastructureFailed,
          checkFailed: !receipt.ok && !infrastructureFailed,
        });
      }
    }
    const checked = recordEditSessionProcessCheckReceipts(validationRepository.canonicalRoot, run.editSessionId, {
      repoId: validationRepository.repoId,
      checkoutId: validationRepository.activeCheckoutId,
      receipts,
      reviewer: run.reviewer,
      note: run.note,
    });
    run = saveRun(controllerHome, {
      ...run,
      status: 'completed',
      ok: receipts.every((receipt) => receipt.ok),
      receipts,
      error: undefined,
    });
    return coordinatorResult(controllerHome, run, checked);
  } catch (error) {
    return failedRun(
      controllerHome,
      run,
      'EDIT_VALIDATION_RECEIPT_REJECTED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function startOrJoinEditValidation(
  controllerHome: string,
  repository: RepositoryRecord,
  input: EditValidationStartInput,
): Promise<EditValidationCoordinatorResult> {
  const resolved = resolveEditValidationRepository(repository, input.editSessionId);
  const validationRepository = resolved.repository;
  const session = resolved.session;
  const checkIds = normalized(input.checkIds ?? session.requestedChecks);
  const requestId = input.validationRequestId?.trim()
    || input.requestId?.trim()
    || `verify-edit:${session.sessionId}:r${session.currentRevision}:${createHash('sha256').update(JSON.stringify(checkIds)).digest('hex').slice(0, 16)}`;
  const id = validationId(repository.repoId, session.sessionId, session.currentRevision, requestId);
  const existing = readRun(controllerHome, repository.repoId, id);
  if (existing) {
    if (existing.checkIds.join('\n') !== checkIds.join('\n')) {
      return failedRun(controllerHome, existing, 'EDIT_VALIDATION_REQUEST_CONFLICT', 'The validation request id is already bound to a different check set.');
    }
    return reconcileEditValidationRun(controllerHome, validationRepository, existing);
  }

  if (checkIds.length === 0) {
    try {
      const checked = recordEditSessionProcessCheckReceipts(validationRepository.canonicalRoot, session.sessionId, {
        repoId: validationRepository.repoId,
        checkoutId: validationRepository.activeCheckoutId,
        receipts: [],
        reviewer: input.reviewer,
        note: input.note,
      });
      const completed = saveRun(controllerHome, {
        schemaVersion: 1,
        validationId: id,
        repositoryId: validationRepository.repoId,
        checkoutId: validationRepository.activeCheckoutId,
        editSessionId: session.sessionId,
        editRevision: session.currentRevision,
        requestId,
        checkIds,
        lanes: [],
        processes: {},
        reviewer: input.reviewer,
        note: input.note,
        timeoutMs: input.timeoutMs,
        leaseWaitMs: 0,
        status: 'completed',
        ok: true,
        receipts: [],
        createdAt: now(),
        updatedAt: now(),
      });
      return coordinatorResult(controllerHome, completed, checked);
    } catch (error) {
      const run: EditValidationRunState = {
        schemaVersion: 1,
        validationId: id,
        repositoryId: validationRepository.repoId,
        checkoutId: validationRepository.activeCheckoutId,
        editSessionId: session.sessionId,
        editRevision: session.currentRevision,
        requestId,
        checkIds,
        lanes: [],
        processes: {},
        reviewer: input.reviewer,
        note: input.note,
        timeoutMs: input.timeoutMs,
        leaseWaitMs: 0,
        status: 'running',
        createdAt: now(),
        updatedAt: now(),
      };
      return failedRun(controllerHome, run, 'EDIT_VALIDATION_EMPTY_RECEIPT_REJECTED', error instanceof Error ? error.message : String(error));
    }
  }

  const validationStatus = repositoryGitStatus(validationRepository);
  const validationSourceRevision = validationStatus.head?.trim();
  const validationWorkspaceFingerprint = workspaceValidationFingerprint(validationRepository.canonicalRoot, validationStatus);
  if (session.workId && !validationSourceRevision) {
    throw new Error('EDIT_VALIDATION_WORK_SOURCE_REVISION_REQUIRED');
  }
  const run = saveRun(controllerHome, {
    schemaVersion: 1,
    validationId: id,
    repositoryId: validationRepository.repoId,
    checkoutId: validationRepository.activeCheckoutId,
    editSessionId: session.sessionId,
    editRevision: session.currentRevision,
    requestId,
    sourceRevision: session.workId ? validationSourceRevision : undefined,
    workspaceFingerprint: session.workId ? validationWorkspaceFingerprint : undefined,
    checkIds,
    lanes: checkLanes(validationRepository, checkIds),
    processes: {},
    reviewer: input.reviewer,
    note: input.note,
    timeoutMs: input.timeoutMs,
    leaseWaitMs: typeof input.leaseWaitMs === 'number' && Number.isFinite(input.leaseWaitMs)
      ? Math.max(0, Math.min(Math.trunc(input.leaseWaitMs), 15_000))
      : 0,
    status: 'running',
    createdAt: now(),
    updatedAt: now(),
  });
  return reconcileEditValidationRun(controllerHome, validationRepository, run);
}

export interface PendingEditValidationSummary {
  repositoryId: string;
  examined: number;
  running: number;
  completed: number;
  failed: number;
  errors: Array<{ validationId: string; error: string }>;
  truncated: boolean;
}

export async function reconcilePendingEditValidations(
  controllerHome: string,
  repository: RepositoryRecord,
  limit = 200,
): Promise<PendingEditValidationSummary> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 2_000));
  const index = readIndex(controllerHome, repository.repoId);
  const ids = index.validationIds.slice(0, boundedLimit);
  const summary: PendingEditValidationSummary = {
    repositoryId: repository.repoId,
    examined: ids.length,
    running: 0,
    completed: 0,
    failed: 0,
    errors: [],
    truncated: index.validationIds.length > boundedLimit,
  };
  const stale: string[] = [];
  for (const id of ids) {
    const run = readRun(controllerHome, repository.repoId, id);
    if (!run || run.status !== 'running') {
      stale.push(id);
      continue;
    }
    try {
      const result = await reconcileEditValidationRun(controllerHome, repository, run);
      if (!result.completed) summary.running += 1;
      else if (result.ok === true) summary.completed += 1;
      else summary.failed += 1;
    } catch (error) {
      summary.errors.push({ validationId: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const id of stale) setIndexMembership(controllerHome, repository.repoId, id, false);
  return summary;
}
