import { listControllerSessions } from '../../../../packages/kernel/controller/api/index';
import { listSchedules, listActiveOccurrences } from '../../../../packages/kernel/scheduler/api/index';
import { listWorkContracts } from '../../../../packages/kernel/work/api/index';
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
 * Observe exact Work that has lost every durable continuation owner.
 *
 * Liveness facts are mechanical evidence only. They may drive resource cleanup
 * or diagnostics, but they never decide semantic Work cancellation/completion.
 * Open Work remains model/user-owned working context until an explicit semantic
 * CAS transition closes it.
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

    // Absence of a runtime owner is not semantic cancellation authority.
    // Keep the Work open and surface the observation to cleanup/status callers.
    skip(skippedByReason, terminalHandleMismatch ? 'terminal_handle_semantic_work_open' : 'semantic_work_open_ownerless');
    continue;
  }

  return {
    scanned: works.length,
    retired: retired.length,
    workIds: retired.sort(),
    skippedByReason,
  };
}
