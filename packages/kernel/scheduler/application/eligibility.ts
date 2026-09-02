import { createHash, randomUUID } from 'crypto';
import type { RepositorySchedule, ScheduleTriggerContext } from '../domain/schedule';

export interface ScheduleTriggerEligibilityFacts {
  nowMs: number;
  force: boolean;
  context?: ScheduleTriggerContext;
  repositoryClean?: boolean;
  jobStatuses?: Readonly<Record<string, string | undefined>>;
}

export interface ScheduleTriggerEligibilityDecision {
  due: boolean;
  windowKey?: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export type ScheduleOccurrenceAdmissionKind =
  | 'eligible'
  | 'stop_condition'
  | 'active_occurrence'
  | 'failure_limit'
  | 'cooldown'
  | 'budget_exhausted';

export interface ScheduleOccurrenceAdmissionFacts {
  nowMs: number;
  force: boolean;
  stopReason?: string;
  activeOccurrenceCount: number;
  dailyRuntimeMinutes: number;
}

export interface ScheduleOccurrenceAdmissionDecision {
  kind: ScheduleOccurrenceAdmissionKind;
  reason?: string;
}

function normalizedWindow(minutes: number, at: number): string {
  return String(Math.floor(at / (Math.max(1, minutes) * 60_000)));
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function zonedDateParts(at: number, timezone = 'UTC'): ZonedDateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error(`SCHEDULE_TIMEZONE_INVALID: ${timezone}`);
  }
  const values = Object.fromEntries(formatter.formatToParts(new Date(at)).map((entry) => [entry.type, entry.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdays[String(values.weekday)] ?? 0,
  };
}

function fixedCronTime(expression: string | undefined): { minute: number; hour: number; day: string; month: string; weekday: string } | undefined {
  if (!expression) return undefined;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) return undefined;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return undefined;
  return { minute, hour, day: fields[2], month: fields[3], weekday: fields[4] };
}

function cronWindowKey(schedule: RepositorySchedule, at: number): string {
  const timezone = schedule.trigger.timezone ?? 'UTC';
  const parts = zonedDateParts(at, timezone);
  const fixed = fixedCronTime(schedule.trigger.cronExpression);
  if (fixed) {
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}@${String(fixed.hour).padStart(2, '0')}:${String(fixed.minute).padStart(2, '0')}[${timezone}]`;
  }
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}[${timezone}]`;
}

export function scheduleTriggerWindowKey(schedule: RepositorySchedule, context: ScheduleTriggerContext | undefined, at: number): string {
  if (context?.source === 'manual' && schedule.trigger.type !== 'manual') {
    const stableManualKey = context.eventId?.trim();
    return `manual:${stableManualKey || randomUUID()}`;
  }
  switch (schedule.trigger.type) {
    case 'cron':
      return cronWindowKey(schedule, at);
    case 'calendar':
      return schedule.trigger.calendarAt ?? new Date(at).toISOString().slice(0, 16);
    case 'repository-event':
      return context?.eventId?.trim() || `${context?.eventName ?? schedule.trigger.eventName ?? 'event'}:${normalizedWindow(1, at)}`;
    case 'dependency-checkpoint':
      return createHash('sha256').update(JSON.stringify(schedule.trigger.dependencyJobIds ?? [])).digest('hex').slice(0, 20);
    case 'manual':
      return context?.eventId?.trim() || normalizedWindow(1, at);
    case 'condition':
    case 'interval':
    default:
      return normalizedWindow(schedule.trigger.everyMinutes ?? 60, at);
  }
}

function cronFieldMatches(value: number, field: string, min: number, max: number): boolean {
  return field.split(',').some((part) => {
    const trimmed = part.trim();
    if (trimmed === '*') return true;
    const stepMatch = trimmed.match(/^\*\/(\d+)$/);
    if (stepMatch) return value % Math.max(1, Number(stepMatch[1])) === 0;
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const start = Math.max(min, Number(rangeMatch[1]));
      const end = Math.min(max, Number(rangeMatch[2]));
      const step = Math.max(1, Number(rangeMatch[3] ?? 1));
      return value >= start && value <= end && (value - start) % step === 0;
    }
    const exact = Number(trimmed);
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
  });
}

export function cronDue(expression: string | undefined, at: number, timezone = 'UTC', catchUpMinutes = 0): boolean {
  if (!expression) return false;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`SCHEDULE_CRON_INVALID: expected five fields, received ${fields.length}`);
  const parts = zonedDateParts(at, timezone);
  const calendarMatches = cronFieldMatches(parts.day, fields[2], 1, 31)
    && cronFieldMatches(parts.month, fields[3], 1, 12)
    && cronFieldMatches(parts.weekday, fields[4], 0, 6);
  if (!calendarMatches) return false;
  if (cronFieldMatches(parts.minute, fields[0], 0, 59) && cronFieldMatches(parts.hour, fields[1], 0, 23)) return true;
  const fixed = fixedCronTime(expression);
  if (!fixed || catchUpMinutes <= 0) return false;
  const scheduledMinute = fixed.hour * 60 + fixed.minute;
  const currentMinute = parts.hour * 60 + parts.minute;
  return currentMinute >= scheduledMinute && currentMinute - scheduledMinute <= Math.min(24 * 60, catchUpMinutes);
}

export function evaluateScheduleTriggerEligibility(
  schedule: RepositorySchedule,
  facts: ScheduleTriggerEligibilityFacts,
): ScheduleTriggerEligibilityDecision {
  if (!schedule.enabled && !facts.force) return { due: false, reason: 'Schedule is disabled.' };
  let due = false;
  let reason: string | undefined;
  let evidence: Record<string, unknown> | undefined;
  if (facts.force && schedule.trigger.type !== 'repository-event') {
    due = true;
  } else {
    switch (schedule.trigger.type) {
      case 'manual':
        due = facts.force;
        reason = due ? undefined : 'Manual Schedule requires an explicit trigger.';
        break;
      case 'interval':
        due = true;
        break;
      case 'cron':
        due = cronDue(schedule.trigger.cronExpression, facts.nowMs, schedule.trigger.timezone ?? 'UTC', schedule.trigger.catchUpMinutes ?? 0);
        reason = due ? undefined : `Cron expression is not due in the current ${schedule.trigger.timezone ?? 'UTC'} minute or catch-up window.`;
        break;
      case 'calendar': {
        const at = Date.parse(schedule.trigger.calendarAt ?? '');
        if (!Number.isFinite(at)) throw new Error('SCHEDULE_CALENDAR_INVALID: calendarAt must be an ISO-8601 timestamp');
        due = facts.nowMs >= at;
        reason = due ? undefined : 'Calendar trigger is not due yet.';
        evidence = { calendarAt: schedule.trigger.calendarAt };
        break;
      }
      case 'repository-event': {
        const expected = schedule.trigger.eventName?.trim();
        const actual = facts.context?.eventName?.trim();
        due = facts.context?.source === 'repository-event' && Boolean(actual) && (!expected || expected === actual);
        reason = due ? undefined : 'Repository event did not match this Schedule.';
        evidence = { expected, actual, eventId: facts.context?.eventId };
        break;
      }
      case 'dependency-checkpoint': {
        const ids = schedule.trigger.dependencyJobIds ?? [];
        if (ids.length === 0) throw new Error('SCHEDULE_DEPENDENCY_REQUIRED: dependency checkpoint has no Job ids');
        due = ids.every((jobId) => facts.jobStatuses?.[jobId] === 'succeeded');
        reason = due ? undefined : 'Dependency checkpoint is not ready.';
        evidence = { dependencies: ids.map((jobId) => ({ jobId, status: facts.jobStatuses?.[jobId] ?? 'missing' })) };
        break;
      }
      case 'condition': {
        const condition = schedule.trigger.condition;
        if (!condition) throw new Error('SCHEDULE_CONDITION_REQUIRED');
        if (condition.kind === 'repository_clean') {
          due = facts.repositoryClean === true;
          reason = due ? undefined : 'Repository is not clean.';
          evidence = { clean: facts.repositoryClean === true };
          break;
        }
        const status = condition.jobId ? facts.jobStatuses?.[condition.jobId] : undefined;
        const terminal = Boolean(status && ['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(status));
        due = condition.kind === 'job_succeeded' ? status === 'succeeded' : terminal;
        reason = due ? undefined : `Condition ${condition.kind} is not met.`;
        evidence = { jobId: condition.jobId, status: status ?? 'missing' };
        break;
      }
      default:
        due = false;
        reason = 'Unsupported Schedule trigger.';
    }
  }
  return {
    due,
    ...(due ? { windowKey: scheduleTriggerWindowKey(schedule, facts.context, facts.nowMs) } : {}),
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function evaluateScheduleOccurrenceAdmission(
  schedule: RepositorySchedule,
  facts: ScheduleOccurrenceAdmissionFacts,
): ScheduleOccurrenceAdmissionDecision {
  if (facts.stopReason) return { kind: 'stop_condition', reason: facts.stopReason };
  if (facts.activeOccurrenceCount >= schedule.policy.maxActiveOccurrences) {
    return { kind: 'active_occurrence', reason: 'Maximum active occurrences reached.' };
  }
  if (schedule.consecutiveFailures >= schedule.policy.maxFailures) {
    return { kind: 'failure_limit', reason: 'Schedule paused after repeated failures.' };
  }
  if (!facts.force && schedule.nextEligibleAt && Date.parse(schedule.nextEligibleAt) > facts.nowMs) {
    return { kind: 'cooldown', reason: `Schedule backoff remains active until ${schedule.nextEligibleAt}.` };
  }
  if (!facts.force && schedule.lastTriggeredAt && facts.nowMs - Date.parse(schedule.lastTriggeredAt) < schedule.policy.cooldownMinutes * 60_000) {
    return { kind: 'cooldown', reason: 'Schedule is cooling down.' };
  }
  if (facts.dailyRuntimeMinutes >= schedule.policy.dailyBudgetMinutes) {
    return { kind: 'budget_exhausted', reason: 'Daily schedule budget exhausted.' };
  }
  return { kind: 'eligible' };
}
