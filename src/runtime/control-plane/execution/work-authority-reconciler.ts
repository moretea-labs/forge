import { listControllerSessions } from '../../../../packages/kernel/controller/api/index';
import { listSchedules, listActiveOccurrences } from '../../../../packages/kernel/scheduler/api/index';
import { listWorkContracts, updateWorkContract } from '../../../../packages/kernel/work/api/index';
import { listActiveLeases } from '../../resources/leases/store';
import { listProcessRecords } from '../../execution/process-runtime/store';
import { isManagedProcessActive } from '../../execution/process-runtime/types';
import { listPlanContracts } from '../facade/plan-contract-store';
import { listWorkHandles, type WorkHandleState } from './work-handle-store';

const DEFAULT_OWNERLESS_WORK_GRACE_MS = 2 * 60 * 60_000;
const TERMINAL_HANDLE_STATES = new Set<WorkHandleState['state']>(['cleaned', 'failed', 'failed_terminal_cleanup']);

export interface OwnerlessWorkAuthorityReconcileOptions {
  controllerHome: string;
  repoId: string;
  nowMs?: number;
  graceMs?: number;
}

export interface OwnerlessWorkAuthorityReconcileResult {
  scanned: number;
  retired: number;
  workIds: string[];
  skippedByReason: Record<string, number>;
}

function scheduleOwnsWork(schedule: ReturnType<typeof listSchedules>[number], workId: string): boolean {
  if (schedule.action.resourceClaims?.some((claim) => claim.workId === workId)) return true;
  const args = schedule.action.arguments ?? {};
  return args.workId === workId || args.work_id === workId;
}

function skip(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/**
 * Retire only exact Work authority that has lost every durable continuation owner.
 *
 * This deliberately does not resurrect the retired repository-wide stale Work
 * reconciler. Liveness is evaluated per Work. Current Plan authority, an active
 * Controller session, Work-bound lease, Schedule/occurrence, or active Process
 * protects the Work. Blocked Work is also retained unless its WorkHandle is
 * already terminal, because blocked may be an intentional user/dependency wait.
 *
 * Retiring authority cancels the Work but keeps its SQLite history. Filesystem
 * cleanup and later physical retention/GC remain separate phases.
 */
export function reconcileOwnerlessWorkAuthorities(
  options: OwnerlessWorkAuthorityReconcileOptions,
): OwnerlessWorkAuthorityReconcileResult {
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = Math.max(5 * 60_000, Math.trunc(options.graceMs ?? DEFAULT_OWNERLESS_WORK_GRACE_MS));
  const works = listWorkContracts({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 });
  const currentPlanIds = new Set(listPlanContracts({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 }).map((plan) => plan.planId));
  const activeSessionWorkIds = new Set(listControllerSessions({ controllerHome: options.controllerHome, repoId: options.repoId }).map((session) => session.workId));
  const activeLeaseWorkIds = new Set(listActiveLeases(options.controllerHome, options.repoId).map((lease) => lease.workId).filter((workId): workId is string => Boolean(workId)));
  const schedules = listSchedules(options.controllerHome, options.repoId);
  const activeOccurrenceScheduleIds = new Set(listActiveOccurrences(options.controllerHome, options.repoId).map((occurrence) => occurrence.scheduleId));
  const liveScheduledWorkIds = new Set(schedules
    .filter((schedule) => schedule.enabled || activeOccurrenceScheduleIds.has(schedule.scheduleId))
    .flatMap((schedule) => works.filter((work) => scheduleOwnsWork(schedule, work.workId)).map((work) => work.workId)));
  const activeProcessWorkIds = new Set(listProcessRecords(options.controllerHome, options.repoId, 5_000)
    .filter((record) => record.workId && isManagedProcessActive(record))
    .map((record) => record.workId!));
  const handles = new Map(listWorkHandles(options.controllerHome, options.repoId, 5_000)
    .map((handle) => [handle.workContractId ?? handle.workId, handle] as const));

  const skippedByReason: Record<string, number> = {};
  const retired: string[] = [];
  for (const work of works) {
    if (work.planId && currentPlanIds.has(work.planId)) { skip(skippedByReason, 'current_plan'); continue; }
    if (activeSessionWorkIds.has(work.workId)) { skip(skippedByReason, 'active_controller_session'); continue; }
    if (activeLeaseWorkIds.has(work.workId)) { skip(skippedByReason, 'active_lease'); continue; }
    if (liveScheduledWorkIds.has(work.workId)) { skip(skippedByReason, 'active_schedule'); continue; }
    if (activeProcessWorkIds.has(work.workId)) { skip(skippedByReason, 'active_process'); continue; }

    const handle = handles.get(work.workId);
    const terminalHandleMismatch = Boolean(handle && TERMINAL_HANDLE_STATES.has(handle.state));
    if (work.status === 'blocked' && !terminalHandleMismatch) { skip(skippedByReason, 'blocked_wait'); continue; }
    const updatedMs = Date.parse(work.updatedAt);
    if (!Number.isFinite(updatedMs)) { skip(skippedByReason, 'invalid_updated_at'); continue; }
    if (!terminalHandleMismatch && nowMs - updatedMs < graceMs) { skip(skippedByReason, 'grace_period'); continue; }

    const reason = terminalHandleMismatch
      ? `WorkHandle is already ${handle!.state} while Work remained ${work.status}.`
      : `Work has no current Plan, Controller session, Work-bound lease, Schedule/occurrence, or active Process after ${Math.round(graceMs / 60_000)} minutes.`;
    updateWorkContract({ controllerHome: options.controllerHome, repoId: options.repoId }, work.workId, {
      status: 'cancelled',
      evidenceRefs: [{
        title: 'ownerless Work authority retired',
        summary: reason,
        detailLevel: 'summary',
      }, ...work.evidenceRefs],
      suggestedNextActions: [],
      continuationPrompt: `Runtime maintenance retired ownerless Work authority ${work.workId}. Historical evidence is retained; create or continue current Requirement/Plan authority instead of reviving stale execution state.`,
    });
    retired.push(work.workId);
  }

  return {
    scanned: works.length,
    retired: retired.length,
    workIds: retired.sort(),
    skippedByReason,
  };
}
