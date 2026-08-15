import {
  getWorkContract,
  transitionWorkContractPhase,
  updateWorkContract,
} from '../facade/work-contract-store';
import {
  listValidatingWorkHandles,
  transitionWorkHandle,
  type WorkHandleState,
} from './work-handle-store';
import { processCheckCompletionReceipt } from '../../execution/process-runtime/check-receipt';
import { processCheckSemanticScopeKey } from '../../execution/process-runtime/check-facade';
import { getProcessRecord } from '../../execution/process-runtime/store';
import { controllerCheckExecutionIdentity } from '../../../cli/controller/check-runner';

export type WorkValidationOutcome =
  | 'not_validating'
  | 'running'
  | 'passed'
  | 'failed'
  | 'infrastructure_failure';

export interface WorkValidationReconciliation {
  handle: WorkHandleState;
  changed: boolean;
  outcome: WorkValidationOutcome;
  summary?: string;
}

export function hasCurrentWorkValidationAuthority(input: {
  finalizationValidation: WorkHandleState['finalization']['validation'];
  validatedInputFingerprint?: string;
  evidenceState: string;
  expectedFingerprint: string;
}): boolean {
  return input.finalizationValidation === 'done'
    && input.evidenceState === 'valid'
    && input.validatedInputFingerprint === input.expectedFingerprint;
}

/**
 * A new validation run invalidates delivery authority without deleting or
 * rewriting the prior receipts. `stale` is the only valid transition from an
 * already-valid evidence set; all other retryable states converge through
 * `partial`.
 */
export function markWorkValidationPending(controllerHome: string, handle: WorkHandleState): void {
  const contractId = handle.workContractId;
  if (!contractId) return;
  const options = { controllerHome, repoId: handle.repositoryId };
  const contract = getWorkContract(options, contractId);
  if (!contract || contract.completionReceipt) return;
  const evidenceState = contract.evidenceState === 'valid' || contract.evidenceState === 'stale'
    ? 'stale'
    : 'partial';
  if (contract.evidenceState !== evidenceState) updateWorkContract(options, contractId, { evidenceState });
}

/**
 * Project durable validation evidence into the Work-owned contract lifecycle.
 * Process and Check records contribute evidence only; they never become a
 * second completion or lifecycle authority.
 */
export function projectWorkValidationOutcome(
  controllerHome: string,
  handle: WorkHandleState,
  outcome: Exclude<WorkValidationOutcome, 'not_validating' | 'running'>,
  summary?: string,
): void {
  const contractId = handle.workContractId;
  if (!contractId) return;
  const options = { controllerHome, repoId: handle.repositoryId };
  const contract = getWorkContract(options, contractId);
  if (!contract || contract.completionReceipt) return;

  if (outcome === 'passed') {
    transitionWorkContractPhase(options, contractId, {
      phase: 'delivery',
      status: 'running',
      state: 'active',
      summary: summary ?? 'All requested validation receipts passed; delivery is next.',
      evidenceRefs: contract.evidenceRefs,
    });
    updateWorkContract(options, contractId, { evidenceState: 'valid' });
    return;
  }

  if (outcome === 'failed') {
    transitionWorkContractPhase(options, contractId, {
      phase: 'cleanup',
      status: 'failed',
      state: 'failed',
      summary: summary ?? 'A requested validation check failed; terminal cleanup is next.',
      evidenceRefs: contract.evidenceRefs,
    });
    updateWorkContract(options, contractId, { evidenceState: 'failed' });
    return;
  }

  transitionWorkContractPhase(options, contractId, {
    phase: 'cleanup',
    status: 'failed',
    state: 'failed',
    summary: summary ?? 'Validation infrastructure failed; terminal cleanup is required without treating this as an acceptance failure.',
    evidenceRefs: contract.evidenceRefs,
  });
  updateWorkContract(options, contractId, {
    evidenceState: contract.evidenceState === 'valid' || contract.evidenceState === 'stale' ? 'stale' : 'partial',
  });
}

function settleInfrastructureFailure(
  controllerHome: string,
  handle: WorkHandleState,
  summary: string,
): WorkValidationReconciliation {
  const next = transitionWorkHandle(controllerHome, handle, 'failed', {
    finalization: { ...handle.finalization, validation: 'failed', lastError: summary },
    validationRun: undefined,
    failureReason: summary,
  });
  projectWorkValidationOutcome(controllerHome, next, 'infrastructure_failure', summary);
  return { handle: next, changed: true, outcome: 'infrastructure_failure', summary };
}

/**
 * Converge a persisted Work validation run from durable Process receipts.
 *
 * No command is launched here. Missing/running bindings stay pending; timeout,
 * cancellation, missing process state, or malformed receipt makes the Work
 * terminally failed for cleanup without classifying it as an acceptance failure.
 */
export function reconcileWorkValidation(
  controllerHome: string,
  handle: WorkHandleState,
): WorkValidationReconciliation {
  const run = handle.validationRun;
  if (handle.state !== 'validating' || !run) {
    return { handle, changed: false, outcome: 'not_validating' };
  }

  if (run.requestedChecks.length === 0) {
    const next = transitionWorkHandle(controllerHome, handle, run.resumeState, {
      finalization: { ...handle.finalization, validation: 'done', lastError: undefined },
      validationRun: undefined,
      validatedInputFingerprint: run.fingerprint,
      failureReason: undefined,
    });
    projectWorkValidationOutcome(controllerHome, next, 'passed', 'No validation checks were required.');
    return { handle: next, changed: true, outcome: 'passed' };
  }

  for (const checkId of run.requestedChecks) {
    const binding = run.processes[checkId];
    if (!binding) return { handle, changed: false, outcome: 'running' };
    const record = getProcessRecord(controllerHome, handle.repositoryId, binding.processId);
    if (!record) {
      return settleInfrastructureFailure(
        controllerHome,
        handle,
        `Validation process record is unavailable: ${binding.processId}`,
      );
    }
    if (record.status === 'running' || record.status === 'starting' || record.status === 'running_recovered') {
      return { handle, changed: false, outcome: 'running' };
    }

    try {
      const currentIdentity = record.checkExecution
        ? controllerCheckExecutionIdentity(handle.worktreePath, checkId, record.checkExecution.timeoutMs)
        : undefined;
      const receipt = processCheckCompletionReceipt(record, {
        repoId: handle.repositoryId,
        checkoutId: handle.checkoutId,
        workId: handle.workId,
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
              checkoutId: handle.checkoutId,
              workId: handle.workId,
              verificationBinding: { executionSessionId: handle.sessionId },
            }, currentIdentity.reuseScope),
          },
        } : {}),
      });
      if (!receipt.ok) {
        if (receipt.status === 'timed_out' || receipt.status === 'cancelled') {
          return settleInfrastructureFailure(controllerHome, handle, receipt.summary);
        }
        const next = transitionWorkHandle(controllerHome, handle, 'failed', {
          finalization: { ...handle.finalization, validation: 'failed', lastError: receipt.summary },
          validationRun: undefined,
          failureReason: receipt.summary,
        });
        projectWorkValidationOutcome(controllerHome, next, 'failed', receipt.summary);
        return { handle: next, changed: true, outcome: 'failed', summary: receipt.summary };
      }
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      return settleInfrastructureFailure(controllerHome, handle, summary);
    }
  }

  const next = transitionWorkHandle(controllerHome, handle, run.resumeState, {
    finalization: { ...handle.finalization, validation: 'done', lastError: undefined },
    validationRun: undefined,
    validatedInputFingerprint: run.fingerprint,
    failureReason: undefined,
  });
  projectWorkValidationOutcome(controllerHome, next, 'passed', 'All requested validation receipts passed.');
  return { handle: next, changed: true, outcome: 'passed' };
}

export interface PendingWorkValidationReconciliationSummary {
  repositoryId: string;
  examined: number;
  validating: number;
  changed: number;
  running: number;
  passed: number;
  failed: number;
  infrastructureFailure: number;
  errors: Array<{ workId: string; error: string }>;
  truncated: boolean;
}

/**
 * Scheduler-safe convergence for validation Processes that were already
 * launched by a Work. This function never launches commands and never waits
 * for a Process. It only projects terminal receipts into Work state, allowing
 * long checks to finish without ChatGPT polling.
 */
export function reconcilePendingWorkValidations(
  controllerHome: string,
  repositoryId: string,
  limit = 500,
): PendingWorkValidationReconciliationSummary {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 5_000));
  const validating = listValidatingWorkHandles(controllerHome, repositoryId, boundedLimit);
  const handles = validating;
  const summary: PendingWorkValidationReconciliationSummary = {
    repositoryId,
    examined: handles.length,
    validating: validating.length,
    changed: 0,
    running: 0,
    passed: 0,
    failed: 0,
    infrastructureFailure: 0,
    errors: [],
    truncated: handles.length >= boundedLimit,
  };
  for (const handle of validating) {
    try {
      const reconciled = reconcileWorkValidation(controllerHome, handle);
      if (reconciled.changed) summary.changed += 1;
      if (reconciled.outcome === 'running') summary.running += 1;
      else if (reconciled.outcome === 'passed') summary.passed += 1;
      else if (reconciled.outcome === 'failed') summary.failed += 1;
      else if (reconciled.outcome === 'infrastructure_failure') summary.infrastructureFailure += 1;
    } catch (error) {
      summary.errors.push({
        workId: handle.workId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
