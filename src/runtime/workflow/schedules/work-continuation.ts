import { createHash } from 'crypto';
import { getWorkContract, isTerminalWorkContractStatus, type WorkContract } from '../../../../packages/kernel/work/api/index';
import { getRetainedControllerSession, type ControllerType } from '../../../../packages/kernel/controller/api/index';
import { ensureScheduledControllerBinding } from '../../../../adapters/scheduler/controller-binding';
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

export interface WorkContinuationScheduleInput {
  workId?: string;
  scheduleMode?: WorkScheduleMode;
  controllerType?: ContinuationControllerType;
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
  if (isTerminalWorkContractStatus(work.status)) throw new Error(`WORK_ALREADY_TERMINAL: ${work.workId}:${work.status}`);
  return work;
}

function continuationSchedule(schedule: RepositorySchedule): RepositorySchedule {
  if (!['external_controller_wake', 'browser_probe'].includes(schedule.action.operation)) {
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

function providerSeedArguments(input: WorkContinuationScheduleInput, controllerType: ContinuationControllerType): Record<string, unknown> {
  const workId = input.workId?.trim();
  return {
    ...(workId ? { work_id: workId } : {}),
    controller_type: controllerType,
    ...(input.executable?.trim() ? { executable: input.executable.trim() } : {}),
    ...(input.launchArgs ? { launch_args: input.launchArgs.map(String) } : {}),
    ...(input.launchReservationMs !== undefined ? { launch_reservation_ms: input.launchReservationMs } : {}),
    ...(input.handoffId?.trim() ? { handoff_id: input.handoffId.trim() } : {}),
    ...(input.browserSessionId?.trim() ? { browser_session_id: input.browserSessionId.trim() } : {}),
    ...(input.conversationUrl?.trim() ? { conversation_url: input.conversationUrl.trim() } : {}),
  };
}

function exactContinuationArguments(input: {
  workId: string;
  controllerType: ContinuationControllerType;
  controllerSessionId: string;
  controllerBindingId: string;
  continuationHint?: string;
}): Record<string, unknown> {
  return {
    work_id: input.workId,
    controller_type: input.controllerType,
    controller_session_id: input.controllerSessionId,
    controller_binding_id: input.controllerBindingId,
    ...(input.continuationHint?.trim() ? { continuation_hint: input.continuationHint.trim() } : {}),
  };
}

function probeArguments(input: WorkContinuationScheduleInput, controllerType: ContinuationControllerType, keepaliveOnly: boolean): Record<string, unknown> {
  if (!input.probeUrl?.trim() && !input.probeBrowserSessionId?.trim()) {
    throw new Error('SCHEDULE_BROWSER_PROBE_TARGET_REQUIRED');
  }
  return {
    ...providerSeedArguments(input, controllerType),
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
  const requestedWorkId = input.workId?.trim();
  const requestedControllerType = input.controllerType;
  if (!requestedWorkId && scheduleMode !== 'browser_keepalive') throw new Error('WORK_ID_REQUIRED');
  const work = requestedWorkId ? activeWork(controllerHome, repoId, requestedWorkId) : undefined;
  const retainedSession = scheduleMode === 'continuation' && work
    ? getRetainedControllerSession({ controllerHome, repoId }, work.workId)
    : undefined;
  if (scheduleMode === 'continuation' && !retainedSession) {
    throw new Error(`SCHEDULE_CONTINUATION_CONTROLLER_SESSION_REQUIRED: ${work!.workId}`);
  }
  const controllerType = (retainedSession?.controllerType ?? requestedControllerType ?? 'chatgpt') as ContinuationControllerType;
  if (controllerType === 'human') throw new Error('SCHEDULE_CONTINUATION_HUMAN_HOST_UNSUPPORTED');
  if (requestedControllerType && retainedSession && requestedControllerType !== retainedSession.controllerType) {
    throw new Error(`SCHEDULE_CONTINUATION_CONTROLLER_TYPE_MISMATCH: ${work!.workId}:expected=${retainedSession.controllerType}:requested=${requestedControllerType}`);
  }
  if (!requestedWorkId && scheduleMode === 'browser_keepalive' && controllerType !== 'chatgpt') throw new Error('STANDALONE_BROWSER_KEEPALIVE_CHATGPT_REQUIRED');
  const trigger = normalizedTrigger(input);
  const operation = scheduleMode === 'continuation' ? 'external_controller_wake' : 'browser_probe';
  const name = input.scheduleName?.trim()
    || (scheduleMode === 'browser_watch' ? `Watch external state for Work ${work!.workId}`
      : scheduleMode === 'browser_keepalive'
        ? (work ? `Keep browser session alive for Work ${work.workId}` : 'Keep browser session alive')
        : `Continue Work ${work!.workId}`);
  const controllerBinding = scheduleMode === 'continuation'
    ? ensureScheduledControllerBinding(
        { controllerHome, repoId },
        {
          workId: work!.workId,
          session: retainedSession!,
          scheduleName: name,
          args: providerSeedArguments(input, controllerType),
        },
      )
    : undefined;
  const actionArguments = scheduleMode === 'continuation'
    ? exactContinuationArguments({
        workId: work!.workId,
        controllerType,
        controllerSessionId: retainedSession!.sessionId,
        controllerBindingId: controllerBinding!.bindingId,
        continuationHint: input.continuationPrompt,
      })
    : probeArguments(input, controllerType, scheduleMode === 'browser_keepalive');
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

  // A durable Work has one authoritative continuation lane. Changing cadence,
  // prompt, controller, or policy updates that lane instead of minting another
  // Workflow. Browser watches/keepalives are intentionally excluded because one
  // Work may legitimately observe several independent external targets.
  if (scheduleMode === 'continuation') {
    const existing = listSchedules(controllerHome, repoId)
      .filter((candidate) => candidate.action.operation === 'external_controller_wake')
      .filter((candidate) => candidate.action.arguments?.work_id === work!.workId);
    const authoritative = [...existing].reverse().find((candidate) => candidate.enabled) ?? existing.at(-1);
    if (authoritative) {
      const schedule = saveSchedule(controllerHome, {
        ...authoritative,
        name,
        enabled: true,
        trigger,
        policy,
        action: { operation, target: 'runtime', arguments: actionArguments, resourceClaims: [] },
        stopConditions,
        pausedReason: undefined,
      });
      for (const duplicate of existing) {
        if (duplicate.scheduleId === schedule.scheduleId || !duplicate.enabled) continue;
        saveSchedule(controllerHome, {
          ...duplicate,
          enabled: false,
          pausedReason: `Superseded by authoritative continuation ${schedule.scheduleId} for Work ${work!.workId}.`,
        });
      }
      return { schedule, work };
    }
  }

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
      : `browser-keepalive:${repoId}:${createHash('sha256').update(semantic).digest('hex').slice(0, 16)}`);
  const schedule = createSchedule(controllerHome, {
    requestId,
    repoId,
    name,
    enabled: true,
    trigger,
    policy,
    // Work-bound continuation schedules persist only exact Work/ControllerSession/ControllerBinding identities.
    // Browser/process launch metadata lives in ControllerHost adapter stores; browser probes remain adapter actions.
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
    .filter((entry) => ['external_controller_wake', 'browser_probe'].includes(entry.action.operation))
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
