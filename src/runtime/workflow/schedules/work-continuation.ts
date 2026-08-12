import { createHash } from 'crypto';
import { getWorkContract, isTerminalWorkContractStatus, type WorkContract } from '../../control-plane/facade';
import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import { evaluateSchedule } from './engine';
import {
  createSchedule,
  getSchedule,
  listOccurrences,
  listSchedules,
  saveSchedule,
} from './store';
import type {
  RepositorySchedule,
  ScheduleCondition,
  ScheduleOccurrence,
  ScheduleTrigger,
  ScheduleTriggerContext,
  ScheduleTriggerType,
} from './types';

export type ContinuationControllerType = 'chatgpt' | 'codex' | 'claude' | 'grok';

export interface WorkContinuationScheduleInput {
  workId: string;
  controllerType?: ContinuationControllerType;
  executable?: string;
  launchArgs?: string[];
  launchReservationMs?: number;
  handoffId?: string;
  browserSessionId?: string;
  conversationUrl?: string;
  continuationPrompt?: string;
  scheduleName?: string;
  requestId?: string;
  triggerType?: ScheduleTriggerType;
  everyMinutes?: number;
  cronExpression?: string;
  timezone?: string;
  catchUpMinutes?: number;
  calendarAt?: string;
  condition?: ScheduleCondition;
  eventName?: string;
  dependencyJobIds?: string[];
  maxFailures?: number;
  cooldownMinutes?: number;
  dailyBudgetMinutes?: number;
  shadowMode?: boolean;
  backoffBaseMinutes?: number;
  backoffMaxMinutes?: number;
  stopConditions?: string[];
}

export interface WorkContinuationScheduleListOptions {
  workId?: string;
  includeOccurrences?: boolean;
}

function requiredWork(controllerHome: string, repoId: string, workId: string): WorkContract {
  const normalized = workId.trim();
  if (!normalized) throw new Error('WORK_ID_REQUIRED');
  const work = getWorkContract({ controllerHome, repoId }, normalized);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${normalized}`);
  return work;
}

function activeWork(controllerHome: string, repoId: string, workId: string): WorkContract {
  const work = requiredWork(controllerHome, repoId, workId);
  if (isTerminalWorkContractStatus(work.status)) throw new Error(`WORK_ALREADY_TERMINAL: ${work.workId}:${work.status}`);
  return work;
}

function continuationSchedule(schedule: RepositorySchedule): RepositorySchedule {
  if (schedule.action.operation !== 'external_controller_wake') {
    throw new Error(`SCHEDULE_NOT_WORK_CONTINUATION: ${schedule.scheduleId}`);
  }
  return schedule;
}

function normalizedTrigger(input: WorkContinuationScheduleInput): ScheduleTrigger {
  const type = input.triggerType ?? (input.everyMinutes !== undefined ? 'interval' : 'manual');
  return {
    type,
    everyMinutes: input.everyMinutes !== undefined ? Math.max(1, Math.trunc(input.everyMinutes)) : undefined,
    cronExpression: input.cronExpression,
    timezone: input.timezone,
    catchUpMinutes: input.catchUpMinutes !== undefined ? Math.max(0, Math.trunc(input.catchUpMinutes)) : undefined,
    calendarAt: input.calendarAt,
    condition: input.condition,
    eventName: input.eventName,
    dependencyJobIds: input.dependencyJobIds,
  };
}

function wakeArguments(input: WorkContinuationScheduleInput, controllerType: ContinuationControllerType): Record<string, unknown> {
  return {
    work_id: input.workId.trim(),
    controller_type: controllerType,
    ...(input.executable?.trim() ? { executable: input.executable.trim() } : {}),
    ...(input.launchArgs ? { launch_args: input.launchArgs.map(String) } : {}),
    ...(input.launchReservationMs !== undefined ? { launch_reservation_ms: input.launchReservationMs } : {}),
    ...(input.handoffId?.trim() ? { handoff_id: input.handoffId.trim() } : {}),
    ...(input.browserSessionId?.trim() ? { browser_session_id: input.browserSessionId.trim() } : {}),
    ...(input.conversationUrl?.trim() ? { conversation_url: input.conversationUrl.trim() } : {}),
    ...(input.continuationPrompt?.trim() ? { continuation_prompt: input.continuationPrompt.trim() } : {}),
  };
}

export function createWorkContinuationSchedule(
  controllerHome: string,
  repoId: string,
  input: WorkContinuationScheduleInput,
): { schedule: RepositorySchedule; work: WorkContract } {
  const work = activeWork(controllerHome, repoId, input.workId);
  const controllerType = input.controllerType ?? 'chatgpt';
  const trigger = normalizedTrigger(input);
  const actionArguments = wakeArguments(input, controllerType);
  assertAutomatedOperationAllowed('external_controller_wake', actionArguments);
  const name = input.scheduleName?.trim() || `Continue Work ${work.workId}`;
  const semantic = JSON.stringify({
    repoId,
    workId: work.workId,
    controllerType,
    trigger,
    name,
    actionArguments,
    policy: {
      maxFailures: input.maxFailures,
      cooldownMinutes: input.cooldownMinutes,
      dailyBudgetMinutes: input.dailyBudgetMinutes,
      shadowMode: input.shadowMode,
      backoffBaseMinutes: input.backoffBaseMinutes,
      backoffMaxMinutes: input.backoffMaxMinutes,
    },
    stopConditions: input.stopConditions,
  });
  const requestId = input.requestId?.trim()
    || `work-continuation:${repoId}:${work.workId}:${createHash('sha256').update(semantic).digest('hex').slice(0, 16)}`;
  const schedule = createSchedule(controllerHome, {
    requestId,
    repoId,
    name,
    enabled: true,
    trigger,
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: input.maxFailures !== undefined ? Math.max(1, Math.trunc(input.maxFailures)) : 3,
      cooldownMinutes: input.cooldownMinutes !== undefined ? Math.max(0, Math.trunc(input.cooldownMinutes)) : 120,
      dailyBudgetMinutes: input.dailyBudgetMinutes !== undefined ? Math.max(1, Math.trunc(input.dailyBudgetMinutes)) : 180,
      shadowMode: input.shadowMode !== false,
      backoffBaseMinutes: input.backoffBaseMinutes !== undefined ? Math.max(1, Math.trunc(input.backoffBaseMinutes)) : 5,
      backoffMaxMinutes: input.backoffMaxMinutes !== undefined ? Math.max(1, Math.trunc(input.backoffMaxMinutes)) : 24 * 60,
    },
    // The schedule only wakes a Controller. The Controller acquires Work/resource
    // ownership separately, so the wake itself must not claim repository writes.
    action: { operation: 'external_controller_wake', target: 'runtime', arguments: actionArguments, resourceClaims: [] },
    stopConditions: input.stopConditions ?? ['work_terminal', 'human_review_required', 'external_blocker'],
  });
  return { schedule, work };
}

export function listWorkContinuationSchedules(
  controllerHome: string,
  repoId: string,
  options: WorkContinuationScheduleListOptions = {},
): { schedules: RepositorySchedule[]; occurrences?: ScheduleOccurrence[] } {
  const schedules = listSchedules(controllerHome, repoId)
    .filter((entry) => entry.action.operation === 'external_controller_wake')
    .filter((entry) => !options.workId || entry.action.arguments?.work_id === options.workId);
  if (!options.includeOccurrences) return { schedules };
  const scheduleIds = new Set(schedules.map((entry) => entry.scheduleId));
  const occurrences = listOccurrences(controllerHome, repoId, undefined, 100)
    .filter((entry) => scheduleIds.has(entry.scheduleId));
  return { schedules, occurrences };
}

export function getWorkContinuationSchedule(
  controllerHome: string,
  repoId: string,
  scheduleId: string,
  includeOccurrences = false,
): { schedule: RepositorySchedule; occurrences?: ScheduleOccurrence[] } {
  const schedule = continuationSchedule(getSchedule(controllerHome, repoId, scheduleId));
  return {
    schedule,
    ...(includeOccurrences ? { occurrences: listOccurrences(controllerHome, repoId, schedule.scheduleId, 50) } : {}),
  };
}

export function pauseWorkContinuationSchedule(
  controllerHome: string,
  repoId: string,
  scheduleId: string,
  reason?: string,
): RepositorySchedule {
  const schedule = continuationSchedule(getSchedule(controllerHome, repoId, scheduleId));
  return saveSchedule(controllerHome, {
    ...schedule,
    enabled: false,
    pausedReason: reason?.trim() || 'Paused through rh_work.',
  });
}

export function resumeWorkContinuationSchedule(controllerHome: string, repoId: string, scheduleId: string): RepositorySchedule {
  const schedule = continuationSchedule(getSchedule(controllerHome, repoId, scheduleId));
  const workId = typeof schedule.action.arguments?.work_id === 'string' ? schedule.action.arguments.work_id : '';
  activeWork(controllerHome, repoId, workId);
  return saveSchedule(controllerHome, { ...schedule, enabled: true, pausedReason: undefined });
}

export async function triggerWorkContinuationSchedule(
  controllerHome: string,
  repoId: string,
  scheduleId: string,
  context: ScheduleTriggerContext = { source: 'manual' },
): Promise<ScheduleOccurrence | undefined> {
  const schedule = continuationSchedule(getSchedule(controllerHome, repoId, scheduleId));
  return evaluateSchedule(controllerHome, schedule, true, context);
}
