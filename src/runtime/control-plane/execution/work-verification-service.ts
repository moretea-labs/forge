import { createHash } from 'crypto';
import { controllerCheckExecutionIdentity, listControllerChecks, readLatestControllerCheckEvidence } from '../../../cli/controller/check-runner';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  DEFAULT_WORK_CHECK_LEASE_WAIT_MS,
  checkRequiresDurableWorkflow,
  getProcessRecord,
  processCheckCompletionReceipt,
  readPersistedCheckResultReceipt,
  runPersistedCheckViaProcessRuntime,
} from '../../execution/process-runtime';
import { classifyPersistedCheckTerminalEvidence } from '../../execution/process-runtime/check-result';
import { buildCheckExecutionSchedule } from '../../execution/process-runtime/check-scheduling';
import { ingestCheckCompletionGraceProcess } from '../persistence/operational-prior-store';
import { buildFacadeResult } from '../facade/facade-result';
import { classifyVerificationOutcome, normalizeCheckIds } from '../facade/check-normalization';
import { verifyGoalWorkloop } from '../facade/goal-workloop';
import type { FacadeResult, VerificationRecord, WorkContract } from '../facade/types';
import { executionIdentityForRepository } from './execution-identity';
import { commandFingerprint, effectiveVerificationEvidence, verificationInputFingerprint, workspaceValidationFingerprint } from './verification-evidence';
import { resolveWorkVerificationContext } from './work-verification-context';

export interface ExecuteWorkVerificationInput {
  controllerHome: string;
  repository: RepositoryRecord;
  workId?: string;
  checkId?: string;
  requestId?: string;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  leaseWaitMs?: number;
  simulate?: {
    infrastructureFailed?: boolean;
    checkFailed?: boolean;
    skipped?: boolean;
  };
  /** Caller-supplied exact ownership proof for durable-class checks. */
  allowDurableCheckExecution?: (input: { work: WorkContract; checkId: string }) => boolean;
}

export interface ExecuteWorkVerificationResult {
  facade: FacadeResult;
  isError: boolean;
}

function result(facade: FacadeResult, isError = false): ExecuteWorkVerificationResult {
  return { facade, isError };
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
    const requestedChecks = workContract?.checks.length ? workContract.checks : [normalizedCheckId];
    const verificationRequestFingerprint = observedGitHead ? verificationInputFingerprint({
      sourceRevision: observedGitHead,
      workspaceFingerprint,
      checkId: normalizedCheckId,
      requestedChecks,
    }) : undefined;
    const registeredCheck = checks.find((entry) => entry.id === normalizedCheckId);
    const durableClassCheck = checkRequiresDurableWorkflow(registeredCheck);
    const allowDurableCheckExecution = Boolean(
      durableClassCheck
      && workContract
      && workContract.checks.includes(normalizedCheckId)
      && !workContract.completionReceipt
      && workContract.status === 'running'
      && input.allowDurableCheckExecution?.({ work: workContract, checkId: normalizedCheckId }),
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
    const evidenceState = classifyPersistedCheckTerminalEvidence(record, normalizedCheckId, { legacyEvidence });
    const failureClass = evidenceState.failureClass;
    const infrastructureFailed = receipt.timedOut
      || receipt.cancelled
      || evidenceState.state !== 'matched'
      || (!receipt.ok && failureClass !== 'acceptance_failure');
    const checkFailed = !receipt.ok && !infrastructureFailed;
    if (receipt.ok && evidenceState.state === 'matched') {
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
      outcome: infrastructureFailed ? 'infrastructure_failure' : receipt.ok ? 'valid_pass' : 'valid_fail',
      isAcceptanceFailure: checkFailed,
      isInfrastructureIssue: infrastructureFailed,
      executed: true,
      completed: true,
      processId: receipt.processId,
      processStatus: receipt.runtimeStatus,
      ok: receipt.ok,
      timedOut: receipt.timedOut,
      cancelled: receipt.cancelled,
      failureClass: infrastructureFailed ? 'infrastructure_failure' : failureClass,
      deduplicated: handle.deduplicated === true,
      semanticDeduplicated: handle.semanticDeduplicated === true,
      checkContentRevision: receipt.checkRevision,
      observedGitHead,
      revisionSemantics: 'checkContentRevision is a content-bound Check identity; observedGitHead is Git HEAD and is not interchangeable.',
      evidenceArtifactPath: record.origin?.workVerificationSnapshot ? undefined : receipt.artifactPath,
      evidenceReceiptId: receipt.receiptId,
      checkResultReceiptId: structuredCheckResult?.receiptId,
      ...(evidenceState.failureEvidence ? { failureEvidence: evidenceState.failureEvidence } : {}),
      verificationIsolation: record.origin?.workVerificationSnapshot ? 'work_snapshot' : 'shared_checkout',
      boundedStatus: receipt.ok ? 'pass' : infrastructureFailed ? 'infrastructure_failure' : 'fail',
      evidenceState: evidenceState.state,
      ...(evidenceState.infrastructureReason ? { infrastructureReason: evidenceState.infrastructureReason } : {}),
      ...(record.error?.code ? { processErrorCode: record.error.code } : {}),
    };

    if (workId) {
      const sourceRevision = observedGitHead ?? undefined;
      const facade = verifyGoalWorkloop(workloopCtx, {
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
          ? [...facade.warnings, evidenceState.warning ?? 'infrastructure_failure is distinct from acceptance failure']
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
      warnings: infrastructureFailed ? [evidenceState.warning ?? 'infrastructure_failure is distinct from acceptance failure'] : [],
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
