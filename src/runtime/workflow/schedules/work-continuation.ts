import { createHash } from 'crypto';
import { getWorkContract, semanticWorkState, type WorkContract } from '../../../../packages/kernel/work/api/index';
import type { ControllerType } from '../../../../packages/kernel/controller/api/index';

import { assertAutomatedOperationAllowed } from '../../control-plane/governance/external-effects';
import { evaluateSchedule } from './engine';
import {
  createSchedule,
  getSchedule,
  listOccurrences,
  listSchedules,
  saveSchedule,
} from '../../../../packages/kernel/scheduler/api/index';
import type {
  RepositorySchedule,
  ScheduleCondition,
  ScheduleOccurrence,
  ScheduleTrigger,
  ScheduleTriggerContext,
  ScheduleTriggerType,
} from '../../../../packages/kernel/scheduler/api/index';

export type ContinuationControllerType = Exclude<ControllerType, 'human'>;
export type WorkScheduleMode = 'continuation' | 'browser_watch' | 'browser_keepalive';

const CONTROLLER_PROGRESSION_OPERATION = 'controller_progression';
const LEGACY_EXTERNAL_CONTROLLER_WAKE_OPERATION = 'external_controller_wake';

// Historical Schedule actions remain readable so the canonical Scheduler can
// disable them once, but no caller can create, resume, or dispatch them.
function isWorkContinuationOperation(operation: string): boolean {
  return operation === CONTROLLER_PROGRESSION_OPERATION || operation === LEGACY_EXTERNAL_CONTROLLER_WAKE_OPERATION;
}

export interface WorkContinuationScheduleInput {
  workId?: string;
  scheduleMode?: WorkScheduleMode;
  controllerType?: ContinuationControllerType;
  /** Exact interactive Browser grants to carry into the scheduled Controller binding. */
  authorizationGrantRefs?: string[];
  executable?: string;
  launchArgs?: string[];
  launchReservationMs?: number;
  handoffId?: string;
  browserSessionId?: string;
  conversationUrl?: string;
  continuationPrompt?: string;
  probeUrl?: string;
  probeBrowserSessionId?: string;
  probeSelector?: string;
  probeMaxChars?: number;
  probeTimeoutMs?: number;
  includeTerms?: string[];
  ignorePatterns?: string[];
  loginUrlTerms?: string[];
  loginTextTerms?: string[];
  wakeOnFirstObservation?: boolean;
  wakeOnAuthRequired?: boolean;
  authRequiredPrompt?: string;
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
  if (semanticWorkState(work) !== 'open') throw new Error(`WORK_ALREADY_TERMINAL: ${work.workId}:${semanticWorkState(work)}`);
  return work;
}

function continuationSchedule(schedule: RepositorySchedule): RepositorySchedule {
  if (!isWorkContinuationOperation(schedule.action.operation) && schedule.action.operation !== 'browser_probe') {
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

function probeArguments(input: WorkContinuationScheduleInput, controllerType: ContinuationControllerType, keepaliveOnly: boolean): Record<string, unknown> {
  if (!input.probeUrl?.trim() && !input.probeBrowserSessionId?.trim()) {
    throw new Error('SCHEDULE_BROWSER_PROBE_TARGET_REQUIRED');
  }
  return {
    ...(input.workId?.trim() ? { work_id: input.workId.trim() } : {}),
    controller_type: controllerType,
    ...(input.authorizationGrantRefs?.length
      ? { authorization_grant_refs: [...new Set(input.authorizationGrantRefs.map(String).map(value => value.trim()).filter(Boolean))] }
      : {}),
    ...(input.probeUrl?.trim() ? { probe_url: input.probeUrl.trim() } : {}),
    ...(input.probeBrowserSessionId?.trim() ? { probe_session_id: input.probeBrowserSessionId.trim() } : {}),
    ...(input.probeSelector?.trim() ? { selector: input.probeSelector.trim() } : {}),
    ...(input.probeMaxChars !== undefined ? { max_chars: Math.max(256, Math.min(Math.trunc(input.probeMaxChars), 100_000)) } : {}),
    ...(input.probeTimeoutMs !== undefined ? { timeout_ms: Math.max(1_000, Math.min(Math.trunc(input.probeTimeoutMs), 120_000)) } : {}),
    ...(input.includeTerms ? { include_terms: input.includeTerms.map(String).filter(Boolean) } : {}),
    ...(input.ignorePatterns ? { ignore_patterns: input.ignorePatterns.map(String).filter(Boolean) } : {}),
    ...(input.loginUrlTerms ? { login_url_terms: input.loginUrlTerms.map(String).filter(Boolean) } : {}),
    ...(input.loginTextTerms ? { login_text_terms: input.loginTextTerms.map(String).filter(Boolean) } : {}),
    ...(input.wakeOnFirstObservation === true ? { wake_on_first_observation: true } : {}),
    ...(input.wakeOnAuthRequired === false ? { wake_on_auth_required: false } : {}),
    ...(input.authRequiredPrompt?.trim() ? { auth_required_prompt: input.authRequiredPrompt.trim() } : {}),
    keepalive_only: keepaliveOnly,
    wake_on_change: !keepaliveOnly,
  };
}

export function createWorkContinuationSchedule(
  controllerHome: string,
  repoId: string,
  input: WorkContinuationScheduleInput,
): { schedule: RepositorySchedule; work?: WorkContract } {
  const scheduleMode = input.scheduleMode ?? 'continuation';
  if (scheduleMode === 'continuation') throw new Error('SCHEDULE_AUTONOMOUS_CONTINUATION_RETIRED');
  if (input.continuationPrompt?.trim() || input.authRequiredPrompt?.trim()
    || input.executable?.trim() || input.launchArgs?.length || input.launchReservationMs !== undefined
    || input.handoffId?.trim() || input.conversationUrl?.trim()) {
    throw new Error('SCHEDULE_AUTONOMOUS_MODEL_LAUNCH_FIELDS_RETIRED');
  }
  const requestedWorkId = input.workId?.trim();
  const work = requestedWorkId ? activeWork(controllerHome, repoId, requestedWorkId) : undefined;
  // A Schedule is a separate capability: its browser observation is not a
  // Controller session and must never enroll, rearm, or dispatch model turns.
  const controllerType = input.controllerType ?? 'chatgpt';
  if (!requestedWorkId && scheduleMode === 'browser_keepalive' && controllerType !== 'chatgpt') {
    throw new Error('STANDALONE_BROWSER_KEEPALIVE_CHATGPT_REQUIRED');
  }
  const trigger = normalizedTrigger(input);
  const operation = 'browser_probe';
  const name = input.scheduleName?.trim() || (scheduleMode === 'browser_watch'
    ? (work ? ['Watch external state for Work', work.workId].join(' ') : 'Watch browser state')
    : (work ? ['Keep browser session alive for Work', work.workId].join(' ') : 'Keep browser session alive'));
  const actionArguments = probeArguments(input, controllerType, scheduleMode === 'browser_keepalive');
  assertAutomatedOperationAllowed(operation, actionArguments);
  const policy = {
    maxActiveOccurrences: 1,
    maxFailures: input.maxFailures !== undefined ? Math.max(1, Math.trunc(input.maxFailures)) : 3,
    cooldownMinutes: input.cooldownMinutes !== undefined ? Math.max(0, Math.trunc(input.cooldownMinutes)) : 120,
    dailyBudgetMinutes: input.dailyBudgetMinutes !== undefined ? Math.max(1, Math.trunc(input.dailyBudgetMinutes)) : 180,
    shadowMode: input.shadowMode !== false,
    backoffBaseMinutes: input.backoffBaseMinutes !== undefined ? Math.max(1, Math.trunc(input.backoffBaseMinutes)) : 5,
    backoffMaxMinutes: input.backoffMaxMinutes !== undefined ? Math.max(1, Math.trunc(input.backoffMaxMinutes)) : 24 * 60,
  };
  const stopConditions = input.stopConditions ?? (work ? ['work_terminal', 'human_review_required', 'external_blocker'] : []);

  const semantic = JSON.stringify({
    repoId,
    workId: work?.workId,
    controllerType,
    scheduleMode,
    trigger,
    name,
    actionArguments,
    policy,
    stopConditions,
  });
  const requestId = input.requestId?.trim()
    || (work
      ? `work-continuation:${repoId}:${work.workId}:${createHash('sha256').update(semantic).digest('hex').slice(0, 16)}`
      : `browser-probe:${repoId}:${createHash('sha256').update(semantic).digest('hex').slice(0, 16)}`);
  const schedule = createSchedule(controllerHome, {
    requestId,
    repoId,
    name,
    enabled: true,
    trigger,
    policy,
    // Browser probes are bounded Scheduler observations; no Controller binding
    // or Work is required to create or execute them.
    action: { operation, target: 'runtime', arguments: actionArguments, resourceClaims: [] },
    stopConditions,
  });
  return { schedule, work };
}

export function listWorkContinuationSchedules(
  controllerHome: string,
  repoId: string,
  options: WorkContinuationScheduleListOptions = {},
): { schedules: RepositorySchedule[]; occurrences?: ScheduleOccurrence[] } {
  const schedules = listSchedules(controllerHome, repoId)
    .filter((entry) => isWorkContinuationOperation(entry.action.operation) || entry.action.operation === 'browser_probe')
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
  if (isWorkContinuationOperation(schedule.action.operation)) {
    throw new Error('SCHEDULE_AUTONOMOUS_CONTINUATION_RETIRED');
  }
  const workId = typeof schedule.action.arguments?.work_id === 'string' ? schedule.action.arguments.work_id : '';
  if (workId) activeWork(controllerHome, repoId, workId);
  return saveSchedule(controllerHome, {
    ...schedule,
    enabled: true,
    pausedReason: undefined,
    consecutiveFailures: 0,
    nextEligibleAt: undefined,
  });
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
