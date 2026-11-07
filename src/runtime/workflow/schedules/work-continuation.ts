import { createHash } from 'crypto';
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

export type BrowserObservationControllerType = 'chatgpt' | 'codex' | 'claude' | 'grok';
export type BrowserObservationScheduleMode = 'browser_watch' | 'browser_keepalive';

const CONTROLLER_PROGRESSION_OPERATION = 'controller_progression';
const LEGACY_EXTERNAL_CONTROLLER_WAKE_OPERATION = 'external_controller_wake';

function isLegacyWorkContinuationOperation(operation: string): boolean {
  return operation === CONTROLLER_PROGRESSION_OPERATION || operation === LEGACY_EXTERNAL_CONTROLLER_WAKE_OPERATION;
}

export interface BrowserObservationScheduleInput {
  scheduleMode?: BrowserObservationScheduleMode;
  controllerType?: BrowserObservationControllerType;
  authorizationGrantRefs?: string[];
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

export interface BrowserObservationScheduleListOptions {
  historicalWorkId?: string;
  includeOccurrences?: boolean;
}

function browserSchedule(schedule: RepositorySchedule): RepositorySchedule {
  if (!isLegacyWorkContinuationOperation(schedule.action.operation) && schedule.action.operation !== 'browser_probe') {
    throw new Error(`SCHEDULE_NOT_BROWSER_OBSERVATION: ${schedule.scheduleId}`);
  }
  return schedule;
}

function normalizedTrigger(input: BrowserObservationScheduleInput): ScheduleTrigger {
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

function probeArguments(input: BrowserObservationScheduleInput, controllerType: BrowserObservationControllerType, keepaliveOnly: boolean): Record<string, unknown> {
  if (!input.probeUrl?.trim() && !input.probeBrowserSessionId?.trim()) throw new Error('SCHEDULE_BROWSER_PROBE_TARGET_REQUIRED');
  return {
    controller_type: controllerType,
    ...(input.authorizationGrantRefs?.length ? { authorization_grant_refs: [...new Set(input.authorizationGrantRefs.map(String).map(value => value.trim()).filter(Boolean))] } : {}),
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
    keepalive_only: keepaliveOnly,
    wake_on_change: !keepaliveOnly,
  };
}

export function createBrowserObservationSchedule(controllerHome: string, repoId: string, input: BrowserObservationScheduleInput): { schedule: RepositorySchedule } {
  const scheduleMode = input.scheduleMode ?? 'browser_watch';
  const controllerType = input.controllerType ?? 'chatgpt';
  if (scheduleMode === 'browser_keepalive' && controllerType !== 'chatgpt') throw new Error('STANDALONE_BROWSER_KEEPALIVE_CHATGPT_REQUIRED');
  const trigger = normalizedTrigger(input);
  const operation = 'browser_probe';
  const name = input.scheduleName?.trim() || (scheduleMode === 'browser_watch' ? 'Watch browser state' : 'Keep browser session alive');
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
  const stopConditions = input.stopConditions ?? ['human_review_required', 'external_blocker'];
  const semantic = JSON.stringify({ repoId, controllerType, scheduleMode, trigger, name, actionArguments, policy, stopConditions });
  const requestId = input.requestId?.trim() || `browser-probe:${repoId}:${createHash('sha256').update(semantic).digest('hex').slice(0, 16)}`;
  const schedule = createSchedule(controllerHome, {
    requestId, repoId, name, enabled: true, trigger, policy,
    action: { operation, target: 'runtime', arguments: actionArguments, resourceClaims: [] },
    stopConditions,
  });
  return { schedule };
}

export function listBrowserObservationSchedules(controllerHome: string, repoId: string, options: BrowserObservationScheduleListOptions = {}): { schedules: RepositorySchedule[]; occurrences?: ScheduleOccurrence[] } {
  const schedules = listSchedules(controllerHome, repoId)
    .filter(entry => isLegacyWorkContinuationOperation(entry.action.operation) || entry.action.operation === 'browser_probe')
    .filter(entry => !options.historicalWorkId || entry.action.arguments?.work_id === options.historicalWorkId);
  if (!options.includeOccurrences) return { schedules };
  const scheduleIds = new Set(schedules.map(entry => entry.scheduleId));
  return { schedules, occurrences: listOccurrences(controllerHome, repoId, undefined, 100).filter(entry => scheduleIds.has(entry.scheduleId)) };
}

export function getBrowserObservationSchedule(controllerHome: string, repoId: string, scheduleId: string, includeOccurrences = false): { schedule: RepositorySchedule; occurrences?: ScheduleOccurrence[] } {
  const schedule = browserSchedule(getSchedule(controllerHome, repoId, scheduleId));
  return { schedule, ...(includeOccurrences ? { occurrences: listOccurrences(controllerHome, repoId, schedule.scheduleId, 50) } : {}) };
}

export function pauseBrowserObservationSchedule(controllerHome: string, repoId: string, scheduleId: string, reason?: string): RepositorySchedule {
  const schedule = browserSchedule(getSchedule(controllerHome, repoId, scheduleId));
  return saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: reason?.trim() || 'Paused through scheduler facade.' });
}

export function resumeBrowserObservationSchedule(controllerHome: string, repoId: string, scheduleId: string): RepositorySchedule {
  const schedule = browserSchedule(getSchedule(controllerHome, repoId, scheduleId));
  if (isLegacyWorkContinuationOperation(schedule.action.operation) || (typeof schedule.action.arguments?.work_id === 'string' && schedule.action.arguments.work_id.trim())) {
    throw new Error('WORK_BOUND_SCHEDULE_RESUME_RETIRED');
  }
  return saveSchedule(controllerHome, { ...schedule, enabled: true, pausedReason: undefined, consecutiveFailures: 0, nextEligibleAt: undefined });
}

export async function triggerBrowserObservationSchedule(controllerHome: string, repoId: string, scheduleId: string, context: ScheduleTriggerContext = { source: 'manual' }): Promise<ScheduleOccurrence | undefined> {
  const schedule = browserSchedule(getSchedule(controllerHome, repoId, scheduleId));
  if (isLegacyWorkContinuationOperation(schedule.action.operation) || (typeof schedule.action.arguments?.work_id === 'string' && schedule.action.arguments.work_id.trim())) {
    throw new Error('WORK_BOUND_SCHEDULE_TRIGGER_RETIRED');
  }
  return evaluateSchedule(controllerHome, schedule, true, context);
}
