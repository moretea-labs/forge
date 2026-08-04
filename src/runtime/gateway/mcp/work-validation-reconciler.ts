import {
  getWorkContract,
  transitionWorkContractPhase,
  updateWorkContract,
} from '../../control-plane/facade/work-contract-store';
import {
  transitionWorkHandle,
  type WorkHandleState,
} from '../../control-plane/execution/work-handle-store';
import { processCheckCompletionReceipt } from '../../execution/process-runtime/check-receipt';
import { getProcessRecord } from '../../execution/process-runtime/store';

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
      phase: 'verification',
      status: 'failed',
      state: 'failed',
      summary: summary ?? 'A requested validation check failed.',
      evidenceRefs: contract.evidenceRefs,
    });
    updateWorkContract(options, contractId, { evidenceState: 'failed' });
    return;
  }

  transitionWorkContractPhase(options, contractId, {
    phase: 'implementation',
    status: 'running',
    state: 'active',
    summary: summary ?? 'Validation infrastructure did not produce an accepted result; retry is required.',
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
  const run = handle.validationRun!;
  const next = transitionWorkHandle(controllerHome, handle, run.resumeState, {
    finalization: { ...handle.finalization, validation: 'pending', lastError: summary },
    validationRun: undefined,
    failureReason: undefined,
  });
  projectWorkValidationOutcome(controllerHome, next, 'infrastructure_failure', summary);
  return { handle: next, changed: true, outcome: 'infrastructure_failure', summary };
}

/**
 * Converge a persisted Work validation run from durable Process receipts.
 *
 * No command is launched here. Missing/running bindings stay pending; timeout,
 * cancellation, missing process state, or malformed receipt returns the Work to
 * its retryable phase; only an accepted failed check makes the Work failed.
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
    if (record.status === 'running') {
      return { handle, changed: false, outcome: 'running' };
    }

    try {
      const receipt = processCheckCompletionReceipt(record, {
        repoId: handle.repositoryId,
        checkoutId: handle.checkoutId,
        workId: handle.workId,
        executionSessionId: handle.sessionId,
        checkId,
        processId: binding.processId,
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
