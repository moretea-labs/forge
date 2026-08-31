import type { ExecutionJob } from '../../execution/jobs/types';
import type { ScheduleDecisionType, ScheduleOccurrence } from './types';
import {
  getOccurrence,
  getSchedule,
  recordScheduleOccurrenceHandoff,
  saveOccurrence,
  updateSchedule,
  type ScheduleOccurrenceHandoffInput,
} from './store';

const TERMINAL_OCCURRENCE_STATUSES = new Set<ScheduleOccurrence['status']>(['dispatched', 'succeeded', 'failed', 'shadowed', 'skipped']);

function computeScheduleBackoff(schedule: ReturnType<typeof getSchedule>, nextFailures: number): string {
  const backoffBase = Math.max(1, schedule.policy.backoffBaseMinutes ?? schedule.policy.cooldownMinutes ?? 1);
  const backoffMax = Math.max(backoffBase, schedule.policy.backoffMaxMinutes ?? 24 * 60);
  // Persistent readiness failures may span hours or days. Cap the exponent so
  // the calculation stays bounded even while the observable failure count grows.
  const exponent = Math.min(16, Math.max(0, nextFailures - 1));
  const backoffMinutes = Math.min(backoffMax, backoffBase * (2 ** exponent));
  return new Date(Date.now() + backoffMinutes * 60_000).toISOString();
}

function computeScheduleFailureState(schedule: ReturnType<typeof getSchedule>, nextFailures: number): Pick<ReturnType<typeof getSchedule>, 'consecutiveFailures' | 'nextEligibleAt' | 'enabled' | 'pausedReason'> {
  const shouldPause = nextFailures >= schedule.policy.maxFailures;
  return {
    consecutiveFailures: nextFailures,
    nextEligibleAt: computeScheduleBackoff(schedule, nextFailures),
    enabled: shouldPause ? false : schedule.enabled,
    pausedReason: shouldPause ? 'Maximum consecutive failures reached.' : schedule.enabled ? undefined : schedule.pausedReason,
  };
}

export function applyScheduleFailure(
  controllerHome: string,
  scheduleId: string,
  repoId: string,
  occurrenceId: string,
  options: {
    outcome: 'failed' | 'skipped';
    decision?: ScheduleDecisionType;
    reason: string;
    countFailure?: boolean;
    pauseReason?: string;
    handoff?: ScheduleOccurrenceHandoffInput;
  },
): { schedule: ReturnType<typeof getSchedule>; occurrence?: ScheduleOccurrence } {
  const schedule = getSchedule(controllerHome, repoId, scheduleId);
  const occurrence = getOccurrence(controllerHome, repoId, occurrenceId);
  let nextOccurrence = occurrence;
  if (occurrence && !TERMINAL_OCCURRENCE_STATUSES.has(occurrence.status)) {
    nextOccurrence = saveOccurrence(controllerHome, {
      ...occurrence,
      status: options.outcome,
      decision: options.decision ?? occurrence.decision,
      reason: options.reason,
    });
  }
  if (nextOccurrence && options.handoff) {
    nextOccurrence = recordScheduleOccurrenceHandoff(controllerHome, schedule, nextOccurrence, options.handoff);
  }

  const countFailure = options.countFailure !== false;
  const nextSchedule = options.pauseReason
    ? updateSchedule(controllerHome, repoId, scheduleId, (current) => ({
      enabled: false,
      pausedReason: options.pauseReason,
      nextEligibleAt: undefined,
      consecutiveFailures: countFailure ? current.consecutiveFailures + 1 : current.consecutiveFailures,
    }))
    : countFailure
      ? updateSchedule(controllerHome, repoId, scheduleId, (current) => computeScheduleFailureState(current, current.consecutiveFailures + 1))
      : getSchedule(controllerHome, repoId, scheduleId);
  return { schedule: nextSchedule, occurrence: nextOccurrence };
}

export function applyScheduleRetryableFailure(
  controllerHome: string,
  scheduleId: string,
  repoId: string,
  occurrenceId: string,
  options: {
    outcome: 'failed' | 'skipped';
    decision: ScheduleDecisionType;
    reason: string;
    countFailure?: boolean;
  },
): { schedule: ReturnType<typeof getSchedule>; occurrence?: ScheduleOccurrence } {
  const occurrence = getOccurrence(controllerHome, repoId, occurrenceId);
  let nextOccurrence = occurrence;
  if (occurrence && !TERMINAL_OCCURRENCE_STATUSES.has(occurrence.status)) {
    nextOccurrence = saveOccurrence(controllerHome, {
      ...occurrence,
      status: options.outcome,
      decision: options.decision,
      reason: options.reason,
    });
  }
  const countFailure = options.countFailure !== false;
  const nextSchedule = updateSchedule(controllerHome, repoId, scheduleId, (current) => {
    const nextFailures = countFailure ? current.consecutiveFailures + 1 : current.consecutiveFailures;
    const failureState = countFailure && current.enabled
      ? computeScheduleFailureState(current, nextFailures)
      : {
        consecutiveFailures: nextFailures,
        nextEligibleAt: countFailure
          ? current.nextEligibleAt
          : computeScheduleBackoff(current, Math.max(1, nextFailures)),
        enabled: current.enabled,
        pausedReason: current.enabled ? undefined : current.pausedReason,
      };
    // One transient fault backs off and re-arms. Repeated faults have crossed
    // the already-declared failure budget and must stop before they consume
    // further controller sessions or browser interactions.
    return failureState;
  });
  return { schedule: nextSchedule, occurrence: nextOccurrence };
}

export function markScheduledExecutionRunning(controllerHome: string, job: ExecutionJob): void {
  if (job.type !== 'scheduled-occurrence') return;
  const occurrenceId = typeof job.payload.occurrenceId === 'string' ? job.payload.occurrenceId : undefined;
  if (!occurrenceId) return;
  try {
    const occurrence = getOccurrence(controllerHome, job.repoId, occurrenceId);
    if (occurrence && occurrence.status === 'queued') {
      saveOccurrence(controllerHome, { ...occurrence, status: 'running', decision: 'execute', reason: 'Scheduled Worker started.' });
    }
  } catch {
    // The durable Job remains authoritative if an old occurrence was removed.
  }
}

/**
 * Keep an occurrence and its owning schedule consistent with the terminal
 * state of the durable ExecutionJob that implements it. This is deliberately
 * idempotent so both the Worker and the Reconciler may call it safely.
 */
export function settleScheduledExecution(
  controllerHome: string,
  job: ExecutionJob,
  outcome: 'succeeded' | 'failed',
  reason: string,
): void {
  if (job.type !== 'scheduled-occurrence') return;
  const scheduleId = typeof job.payload.scheduleId === 'string' ? job.payload.scheduleId : undefined;
  const occurrenceId = typeof job.payload.occurrenceId === 'string' ? job.payload.occurrenceId : undefined;
  if (!scheduleId || !occurrenceId) return;
  try {
    const occurrence = getOccurrence(controllerHome, job.repoId, occurrenceId);
    if (occurrence && !['succeeded', 'failed', 'shadowed', 'skipped'].includes(occurrence.status)) {
      saveOccurrence(controllerHome, {
        ...occurrence,
        status: outcome,
        decision: 'execute',
        reason,
      });
    }
    if (outcome === 'failed') {
      applyScheduleFailure(controllerHome, scheduleId, job.repoId, occurrenceId, {
        outcome,
        decision: 'execute',
        reason,
        handoff: {
          title: `Scheduled maintenance occurrence ${occurrenceId} failed`,
          summary: 'A bounded live maintenance occurrence failed and requires review before the schedule continues unattended.',
          reason,
          creationReason: 'repeated_infrastructure_failure',
          blockingDecision: 'Review the failed maintenance occurrence and decide whether the schedule should continue automatically.',
          recommendedDecision: 'Inspect the failed occurrence, fix the runtime blocker, then re-enable or retrigger the schedule intentionally.',
          recommendedPrompt: `Review schedule occurrence ${occurrenceId} for ${scheduleId}, inspect the failed runtime maintenance action, and decide whether to resume automatic maintenance.`,
          statusSummary: 'Scheduled maintenance execution failed.',
          blockedBy: ['scheduled_execution_failed'],
          attemptedActions: [
            `job:${job.jobId}`,
            `operation:${String(job.payload.operation ?? 'unknown')}`,
          ],
        },
      });
      return;
    }
    updateSchedule(controllerHome, job.repoId, scheduleId, (current) => ({
      consecutiveFailures: 0,
      nextEligibleAt: undefined,
      ...(current.enabled ? { pausedReason: undefined } : {}),
    }));
  } catch {
    // Job terminal state remains authoritative even if an old schedule record
    // has already been removed. Reconciliation must not be blocked by it.
  }
}
