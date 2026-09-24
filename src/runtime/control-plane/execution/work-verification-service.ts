import { createHash } from 'crypto';
import { resolve } from 'path';
import { controllerCheckExecutionIdentity, listControllerChecks, readLatestControllerCheckEvidence } from '../../../cli/controller/check-runner';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  DEFAULT_WORK_CHECK_LEASE_WAIT_MS,
  checkRequiresDurableWorkflow,
  getProcessRecord,
  isManagedProcessActive,
  listProcessRecords,
  processCheckCompletionReceipt,
  readPersistedCheckResultReceipt,
  runPersistedCheckViaProcessRuntime,
} from '../../execution/process-runtime';
import { projectTerminalCheckVerification } from '../../execution/process-runtime/check-result';
import { buildCheckExecutionSchedule } from '../../execution/process-runtime/check-scheduling';
import { ingestCheckCompletionGraceProcess } from '../persistence/operational-prior-store';
import { buildFacadeResult } from '../facade/facade-result';
import { classifyVerificationOutcome, normalizeCheckIds } from '../facade/check-normalization';
import { verifyGoalWorkloop } from '../facade/goal-workloop';
import type { FacadeResult, VerificationRecord, WorkContract } from '../facade/types';
import { evaluateWorkCompletionEvidence } from './work-evidence-policy';
import {
  implementationReviewChangedPathDigest,
  latestImplementationReview,
  normalizeImplementationReviewChangedPaths,
  workRequiresImplementationReview,
} from '../../../../packages/kernel/work/api/index';
import { executionIdentityForRepository } from './execution-identity';
import { commandFingerprint, effectiveVerificationEvidence, verificationInputFingerprint, workspaceValidationFingerprint } from './verification-evidence';
import { resolveWorkVerificationContext } from './work-verification-context';
import { listWorkBoundRepositoryProcessEvidence } from './work-process-evidence';
import { changedPaths as workChangedPaths, changedPathsFromUnbornBase } from './work-task-receipt';
import { readWorkHandle, workDeliveryBaseRevision } from './work-handle-store';

export interface ExecuteWorkVerificationInput {
  controllerHome: string;
  repository: RepositoryRecord;
  workId?: string;
  checkId?: string;
  requestId?: string;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  leaseWaitMs?: number;
  /** Exact terminal generic Check Processes to reconcile into this Work. */
  reconcileProcessIds?: readonly string[];
  simulate?: {
    infrastructureFailed?: boolean;
    checkFailed?: boolean;
    skipped?: boolean;
  };
}

export interface ExecuteWorkVerificationResult {
  facade: FacadeResult;
  isError: boolean;
}

function result(facade: FacadeResult, isError = false): ExecuteWorkVerificationResult {
  return { facade, isError };
}

/**
 * Derive the exact current implementation paths for the canonical Work
 * verifier. Review admission cannot rely on Work scope evidence alone: a
 * committed candidate in a managed checkout has no dirty-path signal, while
 * a target-only advance must not become part of the Work candidate.
 */
function trustedWorkspaceChangedPaths(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  work: WorkContract;
  verificationStatus: ReturnType<typeof repositoryGitStatus>;
}): string[] {
  const sourceRevision = input.verificationStatus.head;
  const handle = readWorkHandle(input.controllerHome, input.repository.repoId, input.work.workId);
  const deliveryBaseRevision = workDeliveryBaseRevision(handle ?? {}) ?? input.work.baseRevision;
  const committedPaths = deliveryBaseRevision && sourceRevision
    ? input.work.repositoryBaseState === 'unborn'
      ? changedPathsFromUnbornBase(input.repository.canonicalRoot, sourceRevision)
      : workChangedPaths(input.repository.canonicalRoot, deliveryBaseRevision, sourceRevision)
    : input.work.scopeEvidence?.actualChangedPaths ?? [];
  return [...new Set([
    ...committedPaths,
    ...input.verificationStatus.staged,
    ...input.verificationStatus.unstaged,
    ...input.verificationStatus.untracked,
  ])].map((path) => path.trim()).filter(Boolean).sort();
}

function currentReusableVerificationRecord(input: {
  workContract?: WorkContract;
  checkId: string;
  sourceRevision?: string;
  workspaceFingerprint: string;
  requestedChecks: string[];
}): VerificationRecord | undefined {
  if (!input.workContract || !input.sourceRevision) return undefined;
  return effectiveVerificationEvidence(input.workContract.checkRefs, {
    sourceRevision: input.sourceRevision,
    workspaceFingerprint: input.workspaceFingerprint,
    checkId: input.checkId,
    requestedChecks: input.requestedChecks,
  }).find((entry) =>
    entry.current
    && (entry.record.outcome === 'valid_pass' || entry.record.outcome === 'valid_fail')
    && Boolean(entry.record.receipt)
  )?.record;
}

function reusedVerificationResult(
  record: VerificationRecord,
  input: {
    workContract?: WorkContract;
    sourceRevision?: string;
    workspaceFingerprint: string;
    workspaceChangedPaths?: readonly string[];
  } = { workspaceFingerprint: '' },
  reconciledProcessIds: string[] = [],
): ExecuteWorkVerificationResult {
  const receipt = record.receipt!;
  const passed = record.outcome === 'valid_pass';
  let nextStep: 'review' | 'finalize' | 'continue' | undefined;
  if (passed && input.workContract && input.sourceRevision) {
    const currentChangedPaths = normalizeImplementationReviewChangedPaths(
      input.workspaceChangedPaths ?? input.workContract.scopeEvidence?.actualChangedPaths ?? [],
    );
    const completion = evaluateWorkCompletionEvidence(
      input.workContract,
      input.sourceRevision,
      input.workspaceFingerprint,
      [],
      currentChangedPaths,
    );
    if (completion.status === 'complete') {
      const latestReview = latestImplementationReview(input.workContract.implementationReviews);
      const approvedReviewRemainsAuthoritative = Boolean(
        input.workContract.phase === 'delivery'
        && input.workContract.phaseEvidence.review.state === 'satisfied'
        && latestReview?.decision === 'approved'
        && latestReview.sourceRevision === input.sourceRevision
        && latestReview.verificationWorkspaceFingerprint === input.workspaceFingerprint
        && latestReview.changedPathDigest === implementationReviewChangedPathDigest(currentChangedPaths)
      );
      nextStep = approvedReviewRemainsAuthoritative || !workRequiresImplementationReview(input.workContract.workKind, currentChangedPaths)
        ? 'finalize'
        : 'review';
    } else {
      nextStep = 'continue';
    }
  }
  return result(buildFacadeResult({
    status: passed ? 'ok' : 'failed',
    summary: `Reused exact current verification receipt for ${record.checkId}; no Process was re-executed.`,
    data: {
      verification: {
        checkId: record.checkId,
        outcome: record.outcome,
        isAcceptanceFailure: !passed,
        isInfrastructureIssue: false,
        executed: false,
        completed: true,
        reused: true,
        processId: receipt.processId,
        processStatus: receipt.runtimeStatus,
        ok: passed,
        evidenceReceiptId: receipt.receiptId,
        reconciledProcessIds,
        ...(nextStep ? { nextStep } : {}),
      },
      ...(nextStep ? { nextStep } : {}),
    },
    rawAvailable: false,
  }), !passed);
}

export interface ContentEquivalentWorkVerificationTransferPlan {
  transferredRecords: VerificationRecord[];
  reusableCheckIds: string[];
  invalidatedCheckIds: string[];
}

/**
 * Pure verification-transfer planner for a Forge-owned representation-only
 * commit. It never mutates Work authority. The caller must persist the complete
 * verification + derived-review + lifecycle transfer atomically.
 */
export function planWorkVerificationAcrossContentEquivalentCommit(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  preCommitSourceRevision: string;
  preCommitWorkspaceFingerprint: string;
  postCommitSourceRevision: string;
  postCommitWorkspaceFingerprint: string;
  recordedAt?: string;
}): ContentEquivalentWorkVerificationTransferPlan {
  const resolved = resolveWorkVerificationContext({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
  });
  if (!resolved.ok || !resolved.context.workContract) {
    throw new Error(`WORK_VERIFICATION_TRANSFER_CONTEXT_REQUIRED: ${input.workId}`);
  }
  const { workContract, repository, checks } = resolved.context;
  if (workContract.completionReceipt) throw new Error(`WORK_VERIFICATION_TRANSFER_WORK_TERMINAL: ${input.workId}`);
  const requestedChecks = workContract.checks;
  const checkById = new Map(listControllerChecks(repository.canonicalRoot).map((check) => [check.id, check] as const));
  const transferredRecords: VerificationRecord[] = [];
  const reusableCheckIds: string[] = [];
  const invalidatedCheckIds: string[] = [];
  const recordedAt = input.recordedAt ?? new Date().toISOString();

  for (const checkId of requestedChecks) {
    const check = checkById.get(checkId) ?? checks.find((entry) => entry.id === checkId);
    const sourcePass = effectiveVerificationEvidence(workContract.checkRefs, {
      sourceRevision: input.preCommitSourceRevision,
      workspaceFingerprint: input.preCommitWorkspaceFingerprint,
      checkId,
      requestedChecks,
    }).find((entry) => entry.current && entry.record.outcome === 'valid_pass' && Boolean(entry.record.receipt))?.record;
    if (!check || !sourcePass?.receipt || check.effects?.git !== undefined) {
      invalidatedCheckIds.push(checkId);
      continue;
    }
    let currentExecutionIdentity;
    try {
      currentExecutionIdentity = controllerCheckExecutionIdentity(repository.canonicalRoot, checkId);
    } catch {
      invalidatedCheckIds.push(checkId);
      continue;
    }
    const receipt = sourcePass.receipt;
    const definitionUnchanged = Boolean(receipt.checkDefinitionDigest)
      && receipt.checkDefinitionDigest === currentExecutionIdentity.definitionDigest;
    const contentInputsUnchanged = Boolean(receipt.checkRevision)
      && receipt.checkRevision === currentExecutionIdentity.revision;
    const environmentUnchanged = Boolean(receipt.checkEnvironmentFingerprint)
      && receipt.checkEnvironmentFingerprint === currentExecutionIdentity.environmentFingerprint;
    if (!definitionUnchanged || !contentInputsUnchanged || !environmentUnchanged) {
      invalidatedCheckIds.push(checkId);
      continue;
    }
    const transferred: VerificationRecord = {
      ...sourcePass,
      summary: `Verification authority transferred across a content-equivalent Forge commit for ${checkId}.`,
      recordedAt,
      sourceRevision: input.postCommitSourceRevision,
      workspaceFingerprint: input.postCommitWorkspaceFingerprint,
      verificationInputFingerprint: verificationInputFingerprint({
        sourceRevision: input.postCommitSourceRevision,
        workspaceFingerprint: input.postCommitWorkspaceFingerprint,
        checkId,
        requestedChecks,
      }),
      evidenceRef: {
        title: checkId,
        summary: 'Reused the exact persisted Process receipt after proving check definition, content inputs, environment, and non-Git read semantics are unchanged across the commit.',
        detailLevel: 'summary',
      },
    };
    transferredRecords.push(transferred);
    reusableCheckIds.push(checkId);
  }

  return { transferredRecords, reusableCheckIds, invalidatedCheckIds };
}

const MAX_WORK_VERIFY_BATCH_CHECKS = 32;

export interface ExecuteWorkVerificationBatchInput extends Omit<ExecuteWorkVerificationInput, 'checkId'> {
  checkIds: string[];
}

function boundedCheckSchedulingPayload(schedule: ReturnType<typeof buildCheckExecutionSchedule>) {
  return {
    waveCount: schedule.waves.length,
    maxParallel: schedule.maxParallel,
    waves: schedule.waves,
    conflicts: schedule.conflicts,
    invalidCheckIds: schedule.invalidCheckIds,
    guidance: schedule.guidance,
  };
}

/**
 * Canonical batch wrapper for rh_work verification. Scheduling remains advisory
 * and Process Runtime resource claims remain the execution/lease authority.
 * Every member still executes through executeWorkVerification so Work snapshot,
 * Failure Contract, VerificationRecord, and lifecycle semantics stay singular.
 */
export interface ReconcileTerminalWorkVerificationsResult {
  repository?: RepositoryRecord;
  verificationStatus?: ReturnType<typeof repositoryGitStatus>;
  sourceRevision?: string;
  workspaceFingerprint?: string;
  reconciledProcessIds: string[];
  workBoundProcessEvidenceIds: string[];
}

/**
 * Reconcile terminal Work-bound verification Processes into canonical Work
 * verification authority. MCP/other adapters may consume the resulting exact
 * repository/content identity, but Process scanning, semantic fingerprint
 * matching, receipt construction, terminal projection, and Work verification
 * mutation remain owned here.
 */
export function reconcileTerminalWorkVerifications(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  /** Explicit Process ids are required for generic run_check evidence. */
  reconcileProcessIds?: readonly string[];
}): ReconcileTerminalWorkVerificationsResult {
  const resolved = resolveWorkVerificationContext({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
  });
  if (!resolved.ok) return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };
  const { store, workContract, repository, checks: availableChecks } = resolved.context;
  if (!workContract || workContract.completionReceipt) return { reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };

  const verificationStatus = repositoryGitStatus(repository);
  const sourceRevision = verificationStatus.head ?? undefined;
  if (!sourceRevision) return { repository, verificationStatus, reconciledProcessIds: [], workBoundProcessEvidenceIds: [] };
  const workspaceFingerprint = workspaceValidationFingerprint(repository.canonicalRoot, verificationStatus);
  const workspaceChangedPaths = trustedWorkspaceChangedPaths({
    controllerHome: input.controllerHome,
    repository,
    work: workContract,
    verificationStatus,
  });
  const workBoundProcessEvidenceIds = (
    workContract.workKind === 'local_effect'
    || (workContract.workKind === 'repository_change' && workContract.checks.length === 0)
  )
    ? listWorkBoundRepositoryProcessEvidence({
        controllerHome: input.controllerHome,
        repoId: input.repository.repoId,
        checkoutId: repository.activeCheckoutId,
        workId: input.workId,
      }).map((evidence) => evidence.processId)
    : [];
  const workloopCtx = {
    workStore: store,
    handoffStore: store,
    repoId: input.repository.repoId,
    availableChecks,
    workspaceChangedPaths,
  };
  const seenChecks = new Set<string>();
  const reconciledProcessIds: string[] = [];
  const explicitProcessIds = new Set(
    (input.reconcileProcessIds ?? [])
      .map((processId) => processId.trim())
      .filter(Boolean)
      .slice(0, 32),
  );
  const recordsById = new Map(
    listProcessRecords(input.controllerHome, input.repository.repoId, 500).map((record) => [record.processId, record] as const),
  );
  // An explicitly named Process may be older than the bounded recent scan.
  // Fetching that one exact id preserves bounded reads without treating an
  // arbitrary caller-supplied receipt as authority.
  for (const processId of explicitProcessIds) {
    if (!recordsById.has(processId)) {
      const record = getProcessRecord(input.controllerHome, input.repository.repoId, processId);
      if (record) recordsById.set(processId, record);
    }
  }
  const candidates = [...recordsById.values()].filter((record) => {
    const workSnapshot = (
      record.workId === input.workId
      && record.checkoutId === repository.activeCheckoutId
      && !isManagedProcessActive(record)
      && record.origin?.workVerificationSnapshot === true
      && typeof record.origin?.checkId === 'string'
      && typeof record.origin?.requestSemanticFingerprint === 'string'
    );
    if (workSnapshot) return true;
    if (!explicitProcessIds.has(record.processId)) return false;

    // Generic run_check records have no Work owner. They are eligible only
    // when the caller names the exact terminal Process and the record proves
    // the same repository/checkout, canonical checkout root, checkout-scoped
    // Check execution, and check surface. The persisted semantic result is
    // validated below before any Work mutation.
    const executionIdentity = record.executionIdentity;
    return (
      record.repoId === repository.repoId
      && record.checkoutId === repository.activeCheckoutId
      && record.workId == null
      && !isManagedProcessActive(record)
      && record.origin?.surface === 'check'
      && typeof record.origin?.checkId === 'string'
      && executionIdentity?.repositoryId === repository.repoId
      && executionIdentity.checkoutId === repository.activeCheckoutId
      && resolve(executionIdentity.canonicalRoot) === resolve(repository.canonicalRoot)
      && record.checkExecution?.reuseScope === 'checkout'
      && record.checkExecution.scopeKey === `checkout:${repository.activeCheckoutId}`
    );
  });

  for (const record of candidates) {
    const checkId = record.origin?.checkId?.trim() ?? '';
    if (!checkId || seenChecks.has(checkId)) continue;
    seenChecks.add(checkId);
    const classified = classifyVerificationOutcome({ checkId, available: availableChecks });
    if (classified.outcome === 'invalid_check_id' || !classified.normalizedCheckId) continue;
    const normalizedCheckId = classified.normalizedCheckId;
    const requestedChecks = workContract.checks.length ? workContract.checks : [normalizedCheckId];
    const currentFingerprint = verificationInputFingerprint({
      sourceRevision,
      workspaceFingerprint,
      checkId: normalizedCheckId,
      requestedChecks,
    });
    const workSnapshot = record.workId === input.workId && record.origin?.workVerificationSnapshot === true;
    if (workSnapshot && (record.origin?.requestSemanticFingerprint !== currentFingerprint || !record.checkExecution)) continue;
    if (!workSnapshot) {
      const recordedExecution = record.checkExecution;
      if (!recordedExecution) continue;
      const currentExecution = controllerCheckExecutionIdentity(repository.canonicalRoot, normalizedCheckId);
      if (
        currentExecution.cacheKey !== recordedExecution.cacheKey
        || currentExecution.revision !== recordedExecution.revision
        || currentExecution.definitionDigest !== recordedExecution.definitionDigest
        || currentExecution.environmentFingerprint !== recordedExecution.environmentFingerprint
        || currentExecution.timeoutMs !== recordedExecution.timeoutMs
        || currentExecution.reuseScope !== recordedExecution.reuseScope
      ) continue;
      const structuredReceipt = readPersistedCheckResultReceipt(record.origin?.checkResultReceiptPath);
      if (
        !structuredReceipt
        || structuredReceipt.checkId !== normalizedCheckId
        || structuredReceipt.cacheKey !== recordedExecution.cacheKey
        || structuredReceipt.validatedRevision !== recordedExecution.revision
      ) continue;
    }
    const checkExecution = record.checkExecution;
    if (!checkExecution) continue;

    try {
      const receipt = processCheckCompletionReceipt(record, {
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        workId: input.workId,
        checkId: normalizedCheckId,
        processId: record.processId,
        requestId: record.origin?.requestId,
        checkExecution: {
          cacheKey: checkExecution.cacheKey,
          revision: checkExecution.revision,
          definitionDigest: checkExecution.definitionDigest,
          environmentFingerprint: checkExecution.environmentFingerprint,
          timeoutMs: checkExecution.timeoutMs,
          scopeKey: checkExecution.scopeKey,
        },
      });
      if (workContract.checkRefs.some((entry) => entry.receipt?.receiptId === receipt.receiptId)) continue;

      const legacyEvidence = record.origin?.checkResultReceiptPath
        ? undefined
        : readLatestControllerCheckEvidence(repository.canonicalRoot, normalizedCheckId);
      const projection = projectTerminalCheckVerification(record, normalizedCheckId, receipt, { legacyEvidence });
      verifyGoalWorkloop(workloopCtx, {
        workId: input.workId,
        checkId: normalizedCheckId,
        sourceRevision,
        workspaceFingerprint,
        verificationInputFingerprint: currentFingerprint,
        commandFingerprint: commandFingerprint(normalizedCheckId, receipt.commandId),
        receipt,
        infrastructureFailed: projection.isInfrastructureIssue,
        checkFailed: projection.isAcceptanceFailure,
      });
      reconciledProcessIds.push(record.processId);
    } catch {
      // Exact receipt/process identity is mandatory. Any malformed, stale, or
      // mismatched terminal Process remains non-authoritative and is ignored.
    }
  }

  return {
    repository,
    verificationStatus,
    sourceRevision,
    workspaceFingerprint,
    reconciledProcessIds,
    workBoundProcessEvidenceIds,
  };
}

export async function executeWorkVerificationBatch(input: ExecuteWorkVerificationBatchInput): Promise<ExecuteWorkVerificationResult> {
  const workId = input.workId?.trim() ?? '';
  const requestedCheckIds = [...new Set(input.checkIds.map((value) => value.trim()).filter(Boolean))];
  if (requestedCheckIds.length === 0) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: 'Work batch verification requires a non-empty check_ids array.',
      data: { batch: true, checkIds: [], verificationStarted: false },
      warnings: ['CHECK_IDS_REQUIRED: pass between 1 and 32 registered check ids.'],
    }), true);
  }
  if (requestedCheckIds.length > MAX_WORK_VERIFY_BATCH_CHECKS) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `Work batch verification accepts at most ${MAX_WORK_VERIFY_BATCH_CHECKS} distinct check ids.`,
      data: { batch: true, checkIds: requestedCheckIds.slice(0, MAX_WORK_VERIFY_BATCH_CHECKS), verificationStarted: false },
      warnings: ['CHECK_IDS_LIMIT_EXCEEDED'],
    }), true);
  }

  const resolvedVerification = resolveWorkVerificationContext({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId,
  });
  if (!resolvedVerification.ok) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `${resolvedVerification.code}: ${resolvedVerification.detail}`,
      data: { batch: true, checkIds: requestedCheckIds, verificationStarted: false },
      warnings: ['Work batch verification never falls back to a different checkout or check registry.'],
    }), true);
  }

  const { repository: verificationRepository, checks } = resolvedVerification.context;
  const checksById = new Map(checks.map((check) => [check.id, check] as const));
  const schedule = buildCheckExecutionSchedule({
    checks,
    requestedCheckIds,
    repoId: verificationRepository.repoId,
    checkoutId: verificationRepository.activeCheckoutId,
  });
  const checkScheduling = boundedCheckSchedulingPayload(schedule);
  if (schedule.invalidCheckIds.length > 0) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `Work batch verification contains unregistered checks: ${schedule.invalidCheckIds.join(', ')}`,
      data: { batch: true, checkIds: requestedCheckIds, checkScheduling, verificationStarted: false },
      warnings: ['INVALID_CHECK_IDS'],
    }), true);
  }
  const durableCheckIds = requestedCheckIds.filter((checkId) => checkRequiresDurableWorkflow(checksById.get(checkId)));
  if (durableCheckIds.length > 0) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: 'Work batch verification only launches ordinary focused checks; durable release or multi-phase checks must be verified individually.',
      data: { batch: true, checkIds: requestedCheckIds, durableCheckIds, checkScheduling, verificationStarted: false },
      warnings: ['BATCH_CONTAINS_DURABLE_CHECK'],
    }), true);
  }
  if (schedule.waves.length !== 1 || schedule.waves[0]?.checkIds.length !== requestedCheckIds.length) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: 'Requested Work checks span multiple resource-conflicting waves; submit one returned wave per verify call.',
      data: { batch: true, checkIds: requestedCheckIds, checkScheduling, verificationStarted: false },
      warnings: ['BATCH_SPANS_MULTIPLE_CHECK_WAVES'],
    }), true);
  }

  const baseRequestId = input.requestId?.trim() ?? '';
  const batchDigest = createHash('sha256').update(JSON.stringify(requestedCheckIds)).digest('hex').slice(0, 8);
  const executions = await Promise.all(requestedCheckIds.map((checkId, index) => executeWorkVerification({
    ...input,
    checkId,
    requestId: baseRequestId ? `${baseRequestId}:batch:${index + 1}:${batchDigest}` : undefined,
  })));
  const verifications: Array<Record<string, unknown> & { checkId: string; facadeStatus: FacadeResult['status']; isError: boolean }> = executions.map((execution, index) => {
    const data = execution.facade.data as Record<string, unknown>;
    const verification = data.verification && typeof data.verification === 'object' && !Array.isArray(data.verification)
      ? data.verification as Record<string, unknown>
      : {};
    return {
      checkId: requestedCheckIds[index],
      ...verification,
      facadeStatus: execution.facade.status,
      isError: execution.isError,
    };
  });
  const completed = verifications.every((verification) => verification.completed === true);
  const allPassed = completed && verifications.every((verification) => verification.outcome === 'valid_pass');
  const anyAcceptanceFailure = verifications.some((verification) => verification.outcome === 'valid_fail');
  const anyInfrastructureFailure = verifications.some((verification) => verification.outcome === 'infrastructure_failure');
  const anyBlocked = executions.some((execution) => execution.facade.status === 'blocked');
  const processIds = verifications
    .map((verification) => typeof verification.processId === 'string' ? verification.processId : '')
    .filter(Boolean);
  const facade = buildFacadeResult({
    status: anyAcceptanceFailure ? 'failed' : anyBlocked ? 'blocked' : 'ok',
    summary: completed
      ? allPassed
        ? `Work verification batch passed ${requestedCheckIds.length} checks.`
        : anyAcceptanceFailure
          ? 'Work verification batch completed with an acceptance failure.'
          : anyInfrastructureFailure
            ? 'Work verification batch completed with an infrastructure failure.'
            : 'Work verification batch completed.'
      : `Work verification batch launched ${requestedCheckIds.length} resource-compatible checks through Process Runtime.`,
    data: {
      batch: true,
      checkIds: requestedCheckIds,
      checkScheduling,
      verifications,
      processIds,
      completed,
      ...(completed ? { ok: allPassed } : {}),
    },
    warnings: anyInfrastructureFailure ? ['infrastructure_failure is distinct from acceptance failure'] : [],
    rawAvailable: false,
  });
  return result(facade, anyAcceptanceFailure || executions.some((execution) => execution.isError && execution.facade.status !== 'ok'));
}

/**
 * Canonical Work verification application service.
 *
 * Transports supply authenticated ownership proof when they want to execute a
 * durable-class check, but they never choose the Work checkout, check registry,
 * Process evidence identity, or acceptance/infrastructure classification.
 */
export async function executeWorkVerification(input: ExecuteWorkVerificationInput): Promise<ExecuteWorkVerificationResult> {
  const workId = input.workId?.trim() ?? '';
  const checkId = input.checkId?.trim() ?? '';
  const resolvedVerification = resolveWorkVerificationContext({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId,
  });
  if (!resolvedVerification.ok) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `${resolvedVerification.code}: ${resolvedVerification.detail}`,
      data: {
        verification: {
          checkId: checkId || undefined,
          outcome: 'infrastructure_failure',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
          doesNotRequestTaskChanges: true,
        },
      },
      warnings: ['Work verification never falls back to the canonical/main check registry when the Work-bound checkout is unavailable.'],
    }), true);
  }

  const { store, workContract, repository: verificationRepository, checks } = resolvedVerification.context;
  if (!checkId) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: 'Work verification requires a registered check_id.',
      data: {
        verification: {
          outcome: 'check_id_required',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
          doesNotRequestTaskChanges: true,
        },
        registeredCheckCount: checks.length,
      },
      warnings: ['CHECK_ID_REQUIRED: pass check_id for one registered repository check.'],
      suggestedNextActions: normalizeCheckIds(checks.slice(0, 3).map((check) => check.id), checks).suggestedNextActions,
    }), true);
  }

  const workloopCtx = {
    workStore: store,
    handoffStore: store,
    repoId: input.repository.repoId,
    availableChecks: checks,
    workspaceChangedPaths: workContract?.scopeEvidence?.actualChangedPaths,
  };
  if (workId && (!workContract || workContract.status === 'completed' || workContract.status === 'cancelled' || workContract.status === 'failed')) {
    const facade = verifyGoalWorkloop(workloopCtx, { workId, checkId });
    return result(facade, facade.status === 'failed');
  }

  const classified = classifyVerificationOutcome({ checkId, available: checks });
  if (classified.outcome === 'invalid_check_id') {
    if (workId) return result(verifyGoalWorkloop(workloopCtx, { workId, checkId }));
    return result(buildFacadeResult({
      status: 'ok',
      summary: classified.summary,
      data: {
        verification: {
          checkId,
          outcome: 'invalid_check_id',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
          doesNotRequestTaskChanges: true,
        },
        registeredCheckCount: checks.length,
      },
      warnings: classified.warnings,
      suggestedNextActions: normalizeCheckIds(checks.slice(0, 3).map((check) => check.id), checks).suggestedNextActions,
    }));
  }

  if (input.simulate) {
    if (!workId) {
      return result(buildFacadeResult({
        status: input.simulate.checkFailed ? 'failed' : 'ok',
        summary: 'Simulated verification without WorkContract.',
        data: {
          verification: {
            checkId: classified.normalizedCheckId,
            outcome: input.simulate.skipped ? 'skipped' : input.simulate.infrastructureFailed ? 'infrastructure_failure' : input.simulate.checkFailed ? 'valid_fail' : 'valid_pass',
            isAcceptanceFailure: input.simulate.checkFailed === true,
            simulated: true,
          },
        },
      }), input.simulate.checkFailed === true);
    }
    const facade = verifyGoalWorkloop(workloopCtx, {
      workId,
      checkId: classified.normalizedCheckId ?? checkId,
      infrastructureFailed: input.simulate.infrastructureFailed === true,
      checkFailed: input.simulate.checkFailed === true,
      skipped: input.simulate.skipped === true,
    });
    return result(facade, facade.status === 'failed');
  }

  try {
    const normalizedCheckId = classified.normalizedCheckId!;
    const verificationStatus = repositoryGitStatus(verificationRepository);
    const observedGitHead = verificationStatus.head;
    const workspaceFingerprint = workspaceValidationFingerprint(verificationRepository.canonicalRoot, verificationStatus);
    const workspaceChangedPaths = workContract
      ? trustedWorkspaceChangedPaths({
          controllerHome: input.controllerHome,
          repository: verificationRepository,
          work: workContract,
          verificationStatus,
        })
      : undefined;
    const exactWorkloopCtx = {
      ...workloopCtx,
      workspaceChangedPaths,
    };
    const requestedChecks = workContract?.checks.length ? workContract.checks : [normalizedCheckId];
    const verificationRequestFingerprint = observedGitHead ? verificationInputFingerprint({
      sourceRevision: observedGitHead,
      workspaceFingerprint,
      checkId: normalizedCheckId,
      requestedChecks,
    }) : undefined;

    const explicitReconciliationRequested = (input.reconcileProcessIds?.length ?? 0) > 0;
    const currentReceipt = currentReusableVerificationRecord({
      workContract: explicitReconciliationRequested ? undefined : workContract,
      checkId: normalizedCheckId,
      sourceRevision: observedGitHead ?? undefined,
      workspaceFingerprint,
      requestedChecks,
    });
    if (currentReceipt) {
      return reusedVerificationResult(currentReceipt, {
        workContract,
        sourceRevision: observedGitHead ?? undefined,
        workspaceFingerprint,
        workspaceChangedPaths,
      });
    }

    let reconciledProcessIds: string[] = [];
    if (workContract && observedGitHead) {
      const reconciled = reconcileTerminalWorkVerifications({
        controllerHome: input.controllerHome,
        repository: input.repository,
        workId: workContract.workId,
        reconcileProcessIds: input.reconcileProcessIds,
      });
      reconciledProcessIds = reconciled.reconciledProcessIds;
      if (reconciled.reconciledProcessIds.length > 0) {
        const refreshed = resolveWorkVerificationContext({
          controllerHome: input.controllerHome,
          repository: input.repository,
          workId: workContract.workId,
        });
        if (refreshed.ok) {
          const reconciledReceipt = currentReusableVerificationRecord({
            workContract: refreshed.context.workContract,
            checkId: normalizedCheckId,
            sourceRevision: observedGitHead,
            workspaceFingerprint,
            requestedChecks,
          });
          if (reconciledReceipt) {
            return reusedVerificationResult(reconciledReceipt, {
              workContract: refreshed.context.workContract,
              sourceRevision: observedGitHead,
              workspaceFingerprint,
              workspaceChangedPaths,
            }, reconciled.reconciledProcessIds);
          }
        }
      }
    }
    if (explicitReconciliationRequested) {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: 'No explicitly requested terminal Process could be reconciled into the exact Work verification authority.',
        data: {
          verification: {
            checkId: normalizedCheckId,
            outcome: 'reconciliation_not_authoritative',
            isAcceptanceFailure: false,
            isInfrastructureIssue: true,
            reconciledProcessIds,
          },
        },
        warnings: ['WORK_VERIFY_RECONCILIATION_NOT_AUTHORIZED: Forge did not re-execute the Check after explicit reconciliation failed.'],
      }), true);
    }

    const registeredCheck = checks.find((entry) => entry.id === normalizedCheckId);
    const durableClassCheck = checkRequiresDurableWorkflow(registeredCheck);
    const allowDurableCheckExecution = Boolean(
      durableClassCheck
      && workContract
      && workContract.checks.includes(normalizedCheckId)
      && !workContract.completionReceipt
      && workContract.status === 'running',
    );

    const executed = await runPersistedCheckViaProcessRuntime({
      controllerHome: input.controllerHome,
      repoId: verificationRepository.repoId,
      checkoutId: verificationRepository.activeCheckoutId,
      repoRoot: verificationRepository.canonicalRoot,
      executionIdentity: executionIdentityForRepository(verificationRepository, workId ? { workId } : {}),
      checkId: normalizedCheckId,
      timeoutMs: input.timeoutMs,
      interactiveWaitMs: input.interactiveWaitMs ?? 0,
      leaseWaitMs: input.leaseWaitMs ?? (workId ? DEFAULT_WORK_CHECK_LEASE_WAIT_MS : undefined),
      requestId: input.requestId,
      requestSemanticFingerprint: verificationRequestFingerprint,
      workId: workId || undefined,
      commandId: input.requestId,
      verificationSnapshot: workContract ? {
        workId: workContract.workId,
        allowedPaths: workContract.allowedPaths,
        forbiddenPaths: workContract.forbiddenPaths,
      } : undefined,
      allowDurableCheckExecution,
    });

    if (executed.mode === 'durable') {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: `Check ${normalizedCheckId} requires an explicit durable workflow; no acceptance result was recorded.`,
        data: {
          verification: {
            checkId: normalizedCheckId,
            outcome: 'deferred',
            isAcceptanceFailure: false,
            isInfrastructureIssue: false,
            durable: executed.durable,
            observedGitHead,
          },
        },
        suggestedNextActions: workId ? [{
          label: 'Continue Work with the durable check requirement',
          tool: 'rh_work',
          operation: 'continue',
          payload: { work_id: workId },
          risk: 'workspace_write',
          confidence: 'high',
        }] : [],
      }), true);
    }

    const handle = executed.process;
    if (!handle) throw new Error(`PROCESS_CHECK_HANDLE_MISSING: ${normalizedCheckId}`);
    const record = getProcessRecord(input.controllerHome, verificationRepository.repoId, handle.processId);
    const checkContentRevision = record?.checkExecution?.revision;
    if (!handle.completed) {
      return result(buildFacadeResult({
        status: 'ok',
        summary: `Check ${normalizedCheckId} is running through Process Runtime; continue other work and reattach to ${handle.processId}.`,
        data: {
          verification: {
            checkId: normalizedCheckId,
            outcome: 'running',
            isAcceptanceFailure: false,
            isInfrastructureIssue: false,
            executed: true,
            completed: false,
            processId: handle.processId,
            processStatus: handle.status,
            deduplicated: handle.deduplicated === true,
            semanticDeduplicated: handle.semanticDeduplicated === true,
            checkContentRevision,
            observedGitHead,
            verificationIsolation: workContract ? 'work_snapshot' : 'shared_checkout',
            revisionSemantics: 'checkContentRevision is a content-bound Check identity; observedGitHead is Git HEAD and is not interchangeable.',
          },
        },
        rawAvailable: false,
      }));
    }

    if (!record) throw new Error(`PROCESS_CHECK_RECORD_MISSING: ${handle.processId}`);
    const receipt = processCheckCompletionReceipt(record, {
      repoId: verificationRepository.repoId,
      checkId: normalizedCheckId,
      processId: handle.processId,
      ...(record.checkExecution ? {
        checkoutId: verificationRepository.activeCheckoutId,
        workId: workId || undefined,
        requestId: input.requestId,
        checkExecution: {
          cacheKey: record.checkExecution.cacheKey,
          revision: record.checkExecution.revision,
          definitionDigest: record.checkExecution.definitionDigest,
          environmentFingerprint: record.checkExecution.environmentFingerprint,
          timeoutMs: record.checkExecution.timeoutMs,
          scopeKey: record.checkExecution.scopeKey,
        },
      } : {}),
    });
    const structuredCheckResult = readPersistedCheckResultReceipt(record.origin?.checkResultReceiptPath);
    const legacyEvidence = record.origin?.checkResultReceiptPath
      ? undefined
      : readLatestControllerCheckEvidence(verificationRepository.canonicalRoot, normalizedCheckId);
    const projection = projectTerminalCheckVerification(record, normalizedCheckId, receipt, { legacyEvidence });
    const infrastructureFailed = projection.isInfrastructureIssue;
    const checkFailed = projection.isAcceptanceFailure;
    if (projection.outcome === 'valid_pass') {
      try {
        ingestCheckCompletionGraceProcess({
          controllerHome: input.controllerHome,
          repoId: verificationRepository.repoId,
          processId: receipt.processId,
        });
      } catch {
        // Operational Memory is a disposable derived optimization. Its failure
        // must never change Check/Work correctness or lifecycle truth.
      }
    }
    const commonVerification = {
      checkId: normalizedCheckId,
      outcome: projection.outcome,
      isAcceptanceFailure: projection.isAcceptanceFailure,
      isInfrastructureIssue: projection.isInfrastructureIssue,
      executed: true,
      completed: true,
      processId: receipt.processId,
      processStatus: receipt.runtimeStatus,
      ok: projection.outcome === 'valid_pass',
      processOk: receipt.ok,
      timedOut: receipt.timedOut,
      cancelled: receipt.cancelled,
      failureClass: projection.failureClass,
      deduplicated: handle.deduplicated === true,
      semanticDeduplicated: handle.semanticDeduplicated === true,
      checkContentRevision: receipt.checkRevision,
      observedGitHead,
      revisionSemantics: 'checkContentRevision is a content-bound Check identity; observedGitHead is Git HEAD and is not interchangeable.',
      evidenceArtifactPath: record.origin?.workVerificationSnapshot ? undefined : receipt.artifactPath,
      evidenceReceiptId: receipt.receiptId,
      checkResultReceiptId: structuredCheckResult?.receiptId,
      ...(projection.evidence.failureEvidence ? { failureEvidence: projection.evidence.failureEvidence } : {}),
      verificationIsolation: record.origin?.workVerificationSnapshot ? 'work_snapshot' : 'shared_checkout',
      boundedStatus: projection.boundedStatus,
      evidenceState: projection.evidence.state,
      ...(projection.infrastructureReason ? { infrastructureReason: projection.infrastructureReason } : {}),
      ...(record.error?.code ? { processErrorCode: record.error.code } : {}),
    };

    if (workId) {
      const sourceRevision = observedGitHead ?? undefined;
      const facade = verifyGoalWorkloop(exactWorkloopCtx, {
        workId,
        checkId: normalizedCheckId,
        sourceRevision,
        workspaceFingerprint,
        verificationInputFingerprint: sourceRevision ? verificationRequestFingerprint : undefined,
        commandFingerprint: commandFingerprint(normalizedCheckId, receipt.commandId),
        receipt,
        infrastructureFailed,
        checkFailed,
      });
      return result({
        ...facade,
        data: {
          ...(facade.data as Record<string, unknown>),
          verification: {
            ...(typeof facade.data.verification === 'object' && facade.data.verification ? facade.data.verification as Record<string, unknown> : {}),
            ...commonVerification,
          },
        },
        warnings: infrastructureFailed
          ? [...facade.warnings, projection.evidence.warning ?? 'infrastructure_failure is distinct from acceptance failure']
          : facade.warnings,
      }, facade.status === 'failed');
    }

    return result(buildFacadeResult({
      status: checkFailed ? 'failed' : 'ok',
      summary: infrastructureFailed
        ? `Infrastructure failure while running ${normalizedCheckId}; not an acceptance failure.`
        : receipt.ok
          ? `Check ${normalizedCheckId} passed with persisted Process evidence.`
          : `Check ${normalizedCheckId} failed acceptance.`,
      data: { verification: commonVerification },
      warnings: infrastructureFailed ? [projection.evidence.warning ?? 'infrastructure_failure is distinct from acceptance failure'] : [],
      rawAvailable: false,
    }), checkFailed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (workId) {
      const facade = verifyGoalWorkloop(workloopCtx, {
        workId,
        checkId: classified.normalizedCheckId ?? checkId,
        infrastructureFailed: true,
      });
      return result({
        ...facade,
        warnings: [...facade.warnings, `check_runner_error: ${message.slice(0, 200)}`],
        data: { ...(facade.data as Record<string, unknown>), isAcceptanceFailure: false },
      });
    }
    return result(buildFacadeResult({
      status: 'ok',
      summary: `Infrastructure failure invoking Process Runtime for ${classified.normalizedCheckId}; not acceptance failure.`,
      data: {
        verification: {
          checkId: classified.normalizedCheckId,
          outcome: 'infrastructure_failure',
          isAcceptanceFailure: false,
          isInfrastructureIssue: true,
        },
      },
      warnings: [`check_runner_error: ${message.slice(0, 200)}`],
      suggestedNextActions: [{
        label: 'Diagnose runtime (dry-run)',
        tool: 'rh_work',
        operation: 'repair',
        payload: { repair_operation: 'diagnose', dry_run: true },
        risk: 'readonly',
      }],
    }));
  }
}
