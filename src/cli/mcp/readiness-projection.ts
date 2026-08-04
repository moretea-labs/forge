import type { TaskLedgerProjection } from '../controller/task-ledger';
import {
  reconcileProjectionWithTaskLedger,
  type RepositoryRuntimeProjectionSnapshot,
} from '../../runtime/projections/materialized-view';

/**
 * Readiness must stay independent from the legacy Issue/Task board after the
 * Requirement portfolio cutover. The persisted runtime projection remains the
 * readiness source; Task Ledger comparison is optional diagnostic evidence.
 */
export function reconcileReadinessProjectionSource(
  snapshot: RepositoryRuntimeProjectionSnapshot,
  ledger?: TaskLedgerProjection,
) {
  if (!ledger) {
    return {
      status: 'unknown' as const,
      projectionRunningWorkers: Math.max(0, snapshot.projection.runningWorkers),
      detail: 'legacy task ledger retired; readiness uses persisted projection state',
    };
  }
  return reconcileProjectionWithTaskLedger(snapshot, ledger);
}
