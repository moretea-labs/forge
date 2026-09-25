import {
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
