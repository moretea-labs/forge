import { updateWorkContract } from '../../control-plane/facade/work-contract-store';
import {
  transitionWorkHandle,
  type WorkHandleState,
} from '../../control-plane/execution/work-handle-store';
import { processCheckCompletionReceipt } from '../../execution/process-runtime/check-receipt';
import { getProcessRecord } from '../../execution/process-runtime/store';

export interface WorkValidationReconciliation {
  handle: WorkHandleState;
  changed: boolean;
  outcome: 'not_validating' | 'running' | 'passed' | 'failed' | 'infrastructure_failure';
  summary?: string;
}

function updateContractAfterReconciliation(
  controllerHome: string,
  handle: WorkHandleState,
  outcome: WorkValidationReconciliation['outcome'],
): void {
  if (!handle.workContractId) return;
  updateWorkContract(
    { controllerHome, repoId: handle.repositoryId },
    handle.workContractId,
    outcome === 'failed'
      ? { status: 'failed', evidenceState: 'failed' }
      : outcome === 'passed'
        ? { status: 'running', evidenceState: 'valid' }
        : { status: 'running', evidenceState: 'partial' },
  );
}

/**
 * Converge a Work validation phase from durable Process receipts.
 *
 * No command is launched here. Missing/running bindings remain pending;
 * terminal infrastructure failures return the Work to its retryable phase;
 * accepted check failures are the only path to Work.failed.
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
    });
    updateContractAfterReconciliation(controllerHome, next, 'passed');
    return { handle: next, changed: true, outcome: 'passed' };
  }

  for (const checkId of run.requestedChecks) {
    const binding = run.processes[checkId];
    if (!binding) return { handle, changed: false, outcome: 'running' };
    const record = getProcessRecord(controllerHome, handle.repositoryId, binding.processId);
    if (!record) {
      const summary = `Validation process record is unavailable: ${binding.processId}`;
      const next = transitionWorkHandle(controllerHome, handle, run.resumeState, {
        finalization: { ...handle.finalization, validation: 'pending', lastError: summary },
        validationRun: undefined,
      });
      updateContractAfterReconciliation(controllerHome, next, 'infrastructure_failure');
      return { handle: next, changed: true, outcome: 'infrastructure_failure', summary };
    }
    if (record.status === 'starting' || record.status === 'running' || record.status === 'running_recovered') {
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
        const infrastructureFailure = receipt.status === 'timed_out' || receipt.status === 'cancelled';
        const next = transitionWorkHandle(
          controllerHome,
          handle,
          infrastructureFailure ? run.resumeState : 'failed',
          {
            finalization: {
              ...handle.finalization,
              validation: infrastructureFailure ? 'pending' : 'failed',
              lastError: receipt.summary,
            },
            validationRun: undefined,
            ...(infrastructureFailure ? {} : { failureReason: receipt.summary }),
          },
        );
        updateContractAfterReconciliation(
          controllerHome,
          next,
          infrastructureFailure ? 'infrastructure_failure' : 'failed',
        );
        return {
          handle: next,
          changed: true,
          outcome: infrastructureFailure ? 'infrastructure_failure' : 'failed',
          summary: receipt.summary,
        };
      }
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const next = transitionWorkHandle(controllerHome, handle, run.resumeState, {
        finalization: { ...handle.finalization, validation: 'pending', lastError: summary },
        validationRun: undefined,
      });
      updateContractAfterReconciliation(controllerHome, next, 'infrastructure_failure');
      return { handle: next, changed: true, outcome: 'infrastructure_failure', summary };
    }
  }

  const next = transitionWorkHandle(controllerHome, handle, run.resumeState, {
    finalization: { ...handle.finalization, validation: 'done', lastError: undefined },
    validationRun: undefined,
    failureReason: undefined,
  });
  updateContractAfterReconciliation(controllerHome, next, 'passed');
  return { handle: next, changed: true, outcome: 'passed' };
}
