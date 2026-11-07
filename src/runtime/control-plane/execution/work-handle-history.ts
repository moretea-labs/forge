import { getWorkContract } from '../../../../packages/kernel/work/api/index';
import {
  listWorkHandlesFailClosed,
  readWorkHandle,
  type WorkHandleState,
} from './work-handle-store';

const CURRENT_HISTORICAL_STATES = new Set<WorkHandleState['state']>([
  'prepared',
  'editing',
  'validating',
  'committed',
  'merged',
  'failed',
  'failed_terminal_cleanup',
]);

/**
 * Read-only compatibility lookup for historical WorkHandle inspection.
 *
 * This function grants no repository mutation authority, checkout ownership,
 * lifecycle transition, recovery, or liveness. Git/checkout/CAS/resource
 * authorities remain independent of historical Work records.
 */
export function resolveHistoricalWorkHandle(
  controllerHome: string,
  repositoryId: string,
  workId: string,
): WorkHandleState | undefined {
  const direct = readWorkHandle(controllerHome, repositoryId, workId);
  const contract = getWorkContract({ controllerHome, repoId: repositoryId }, workId);
  if (!contract) return direct;

  const checkoutId = contract.checkoutId?.trim();
  if (!checkoutId) return direct;

  const candidates = listWorkHandlesFailClosed(controllerHome, repositoryId)
    .filter((handle) =>
      (handle.workId === workId || handle.workContractId === workId)
      && handle.checkoutId === checkoutId
      && CURRENT_HISTORICAL_STATES.has(handle.state)
    );

  if (
    direct
    && direct.checkoutId === checkoutId
    && CURRENT_HISTORICAL_STATES.has(direct.state)
    && !candidates.some((candidate) => candidate.workId === direct.workId)
  ) {
    candidates.push(direct);
  }

  if (candidates.length === 0) return direct;
  if (candidates.length === 1) return candidates[0];

  throw new Error(
    `WORK_HANDLE_AMBIGUOUS: historical Work ${workId} has multiple recorded handles on checkout ${checkoutId}: ${candidates.map((handle) => handle.workId).join(', ')}`,
  );
}
