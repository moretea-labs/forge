import type { RepositoryRecord } from '../repositories/types';
import { listAssistantRoutines } from '../../runtime/assistant/store';
import { runAssistantRoutineNow } from '../../runtime/assistant/intent';
import { getAssistantRoutineScheduleBinding, updateAssistantRoutineLifecycle } from '../../runtime/assistant/schedule-binding';
import { evaluateSchedule } from '../../runtime/workflow/schedules/engine';
import { getSchedule, listOccurrences, listSchedules, saveSchedule } from '../../runtime/workflow/schedules/store';
import type { RepositorySchedule, ScheduleOccurrence } from '../../runtime/workflow/schedules/types';

export interface ConsoleAutomationView {
  id: string;
  source: 'schedule' | 'routine';
  repoId: string;
  repositoryName: string;
  name: string;
  summary?: string;
  status: 'enabled' | 'paused' | 'attention' | 'disabled';
  schedule: string;
  timezone?: string;
  delivery?: string;
  lastRunAt?: string;
  lastResult?: string;
  nextRunHint?: string;
  pausedReason?: string;
  actions: Array<'run' | 'pause' | 'resume'>;
}

function triggerLabel(schedule: RepositorySchedule): string {
  const trigger = schedule.trigger;
  switch (trigger.type) {
    case 'interval': return `Every ${trigger.everyMinutes ?? '?'} min`;
    case 'cron': return `Cron ${trigger.cronExpression ?? '—'}`;
    case 'calendar': return trigger.calendarAt ? `At ${trigger.calendarAt}` : 'Calendar';
    case 'condition': return `Watch ${trigger.condition?.kind ?? 'condition'}`;
    case 'repository-event': return `On ${trigger.eventName ?? 'repository event'}`;
    case 'dependency-checkpoint': return 'Dependency checkpoint';
    case 'manual': return 'Manual';
  }
}

function nextScheduleHint(schedule: RepositorySchedule): string | undefined {
  if (!schedule.enabled) return undefined;
  if (schedule.nextEligibleAt) return schedule.nextEligibleAt;
  if (schedule.trigger.type === 'calendar') return schedule.trigger.calendarAt;
  if (schedule.trigger.type === 'interval' && schedule.trigger.everyMinutes) {
    const base = Date.parse(schedule.lastTriggeredAt ?? schedule.createdAt);
    if (Number.isFinite(base)) {
      const next = base + schedule.trigger.everyMinutes * 60_000;
      return next > Date.now() ? new Date(next).toISOString() : 'Due on next scheduler tick';
    }
  }
  if (schedule.trigger.type === 'cron') return 'Scheduler-calculated';
  if (schedule.trigger.type === 'condition') return 'When condition matches';
  return undefined;
}

function safeBoundSchedule(controllerHome: string, repoId: string, scheduleId?: string): RepositorySchedule | undefined {
  if (!scheduleId) return undefined;
  try { return getSchedule(controllerHome, repoId, scheduleId); } catch { return undefined; }
}

function occurrenceResult(occurrence?: ScheduleOccurrence): string | undefined {
  if (!occurrence) return undefined;
  if (occurrence.decision === 'nothing_to_do') return 'No action needed';
  if (occurrence.status === 'failed') return 'Failed';
  if (occurrence.status === 'succeeded') return 'Succeeded';
  if (occurrence.status === 'running' || occurrence.status === 'queued' || occurrence.status === 'created') return 'Running';
  return occurrence.status;
}

export function listConsoleAutomations(controllerHome: string, repositories: RepositoryRecord[]): ConsoleAutomationView[] {
  const items: ConsoleAutomationView[] = [];
  for (const repository of repositories.filter((entry) => entry.enabled && !entry.removedAt)) {
    const routines = listAssistantRoutines(repository.canonicalRoot).routines;
    const bindings = new Map(routines.map((routine) => [routine.routineId, getAssistantRoutineScheduleBinding(repository.canonicalRoot, routine.routineId)]));
    const boundScheduleIds = new Set([...bindings.values()].flatMap((binding) => binding ? [binding.scheduleId] : []));

    for (const schedule of listSchedules(controllerHome, repository.repoId)) {
      if (boundScheduleIds.has(schedule.scheduleId)) continue;
      const last = listOccurrences(controllerHome, repository.repoId, schedule.scheduleId, 1)[0];
      const status: ConsoleAutomationView['status'] = schedule.enabled ? 'enabled' : schedule.pausedReason ? 'attention' : 'paused';
      items.push({
        id: schedule.scheduleId,
        source: 'schedule',
        repoId: repository.repoId,
        repositoryName: repository.displayName,
        name: schedule.name,
        summary: schedule.action.operation,
        status,
        schedule: triggerLabel(schedule),
        timezone: schedule.trigger.timezone,
        lastRunAt: last?.updatedAt ?? schedule.lastTriggeredAt,
        lastResult: occurrenceResult(last),
        nextRunHint: nextScheduleHint(schedule),
        pausedReason: schedule.pausedReason,
        actions: schedule.enabled ? ['run', 'pause'] : ['resume'],
      });
    }

    for (const routine of routines) {
      const binding = bindings.get(routine.routineId);
      const boundSchedule = safeBoundSchedule(controllerHome, repository.repoId, binding?.scheduleId);
      const last = boundSchedule ? listOccurrences(controllerHome, repository.repoId, boundSchedule.scheduleId, 1)[0] : undefined;
      const scheduleAttention = routine.status === 'enabled' && boundSchedule && !boundSchedule.enabled && Boolean(boundSchedule.pausedReason);
      const status: ConsoleAutomationView['status'] = scheduleAttention ? 'attention' : routine.status === 'enabled' ? 'enabled' : routine.status === 'paused' ? 'paused' : 'disabled';
      items.push({
        id: routine.routineId,
        source: 'routine',
        repoId: repository.repoId,
        repositoryName: repository.displayName,
        name: routine.name,
        summary: routine.naturalLanguageGoal,
        status,
        schedule: routine.scheduleText,
        timezone: routine.timezone,
        delivery: routine.output === 'assistant_inbox' ? 'Assistant inbox' : routine.output === 'gmail_draft' ? 'Gmail draft' : 'None',
        lastRunAt: last?.updatedAt ?? routine.lastRunAt,
        lastResult: occurrenceResult(last) ?? (routine.lastRunAt ? 'Triggered' : undefined),
        nextRunHint: boundSchedule ? nextScheduleHint(boundSchedule) : routine.nextRunHint,
        pausedReason: boundSchedule?.pausedReason,
        actions: scheduleAttention ? ['resume'] : routine.status === 'enabled' ? ['run', 'pause'] : routine.status === 'paused' ? ['resume'] : [],
      });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeConsoleAutomations(items: ConsoleAutomationView[]) {
  return {
    total: items.length,
    enabled: items.filter((item) => item.status === 'enabled').length,
    paused: items.filter((item) => item.status === 'paused' || item.status === 'disabled').length,
    needsAttention: items.filter((item) => item.status === 'attention').length,
  };
}

export async function applyConsoleAutomationAction(
  controllerHome: string,
  repositories: RepositoryRecord[],
  source: string,
  repoId: string,
  id: string,
  action: string,
): Promise<unknown> {
  const repository = repositories.find((entry) => entry.repoId === repoId && entry.enabled && !entry.removedAt);
  if (!repository) throw new Error(`REPOSITORY_NOT_FOUND: ${repoId}`);
  if (source === 'routine') {
    if (action === 'run') return runAssistantRoutineNow(controllerHome, repository, id);
    if (action === 'pause') return updateAssistantRoutineLifecycle(controllerHome, repository, id, 'paused');
    if (action === 'resume') return updateAssistantRoutineLifecycle(controllerHome, repository, id, 'enabled');
    throw new Error(`AUTOMATION_ACTION_UNSUPPORTED: routine/${action}`);
  }
  if (source === 'schedule') {
    const schedule = getSchedule(controllerHome, repoId, id);
    if (action === 'pause') return saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: undefined });
    if (action === 'resume') return saveSchedule(controllerHome, { ...schedule, enabled: true, pausedReason: undefined, consecutiveFailures: 0 });
    if (action === 'run') return evaluateSchedule(controllerHome, schedule, true, { source: 'manual' });
    throw new Error(`AUTOMATION_ACTION_UNSUPPORTED: schedule/${action}`);
  }
  throw new Error(`AUTOMATION_SOURCE_UNSUPPORTED: ${source}`);
}
