import {
  isDirectEditWorkCompletionReceipt,
  isRepositoryCompletionReceipt,
  recordWorkCompletionReceipt,
  type WorkContractStoreOptions,
} from '../../../../packages/kernel/work/api/index';
import type { WorkContract, WorkKind } from '../facade/types';

/**
 * Record physical delivery/effect evidence without changing semantic Work state.
 * The historical completionReceipt/completionOutcome field names are retained as
 * storage compatibility only. Model/user completion is work_complete CAS.
 */
export function recordWorkDeliveryReceipt(
  options: WorkContractStoreOptions,
  workId: string,
  receipt: NonNullable<WorkContract['completionReceipt']>,
  completionOutcome: NonNullable<WorkContract['completionOutcome']>,
  completionWorkKind?: WorkKind,
): WorkContract {
  return recordWorkCompletionReceipt(options, workId, receipt, completionOutcome, completionWorkKind);
}

/**
 * True only when the mechanical delivery/effect has durably settled and no
 * resource blocker remains. Semantic Work completion is deliberately separate:
 * an open Work with this evidence still requires explicit work_complete CAS.
 */
export function hasSettledWorkDeliveryReceipt(
  work: Pick<WorkContract, 'completionReceipt'>,
): boolean {
  const receipt = work.completionReceipt;
  if (!receipt) return false;
  if (isRepositoryCompletionReceipt(receipt) || isDirectEditWorkCompletionReceipt(receipt)) {
    return receipt.delivery.status === 'integrated'
      && receipt.delivery.reachable === true
      && receipt.cleanup.status === 'complete'
      && receipt.cleanup.blockers.length === 0;
  }
  return true;
}
