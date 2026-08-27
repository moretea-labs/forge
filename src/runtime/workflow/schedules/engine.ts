import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRepository } from '../../../cli/repositories/registry';
import { findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../execution/jobs/store';
import { executionJobBelongsToWork, workHasActiveExecution } from '../../execution/work-activity';
import { readRepositoryProjection } from '../../projections/materialized-view';
import {
  applyRuntimeMaintenance,
  previewAutomaticRuntimeMaintenance,
  type RuntimeMaintenanceActionId,
} from '../../recovery/maintenance-executor';
import { appendWorkEvidence, controllerSessionBlocksRecovery, getControllerSession, getWorkContract, isTerminalWorkContractStatus, listHandoffItems } from '../../control-plane/facade';
import { launchSuperController } from '../../control-plane/launcher/thin-launcher';
import { getExternalControllerLaunchReservation } from '../../control-plane/launcher/launch-reservation-store';
import { runStandaloneChatgptPrompt, runWorkChatgptContinuation } from '../../control-plane/launcher/chatgpt-work-continuation';
import {
  beginInitialControllerRoundDispatch,
  buildControllerRoundRelayPrompt,
  finishControllerRoundRelayDispatch,
} from '../../control-plane/facade/controller-round-relay';
import {
  getOccurrence,
  getSchedule,
  listActiveOccurrences,
  listOccurrences,
  recordScheduleOccurrenceHandoff,
  listSchedules,
  saveOccurrence,
  saveSchedule,
  saveScheduleDecision,
} from './store';
import { applyScheduleFailure, applyScheduleRetryableFailure } from './settlement';
import { classifyScheduledBrowserObservation, executeScheduledBrowserProbe } from './browser-probe';
import { executeScheduledGithubIssueWatch } from './github-issue-watch';
import type {
  RepositorySchedule,
  ScheduleDecisionType,
  ScheduleOccurrence,
  ScheduleTriggerContext,
} from './types';

const execFileAsync = promisify(execFile);
const LIVE_MAINTENANCE_OPERATION = 'runtime_maintenance_apply';
const EXTERNAL_CONTROLLER_WAKE_OPERATION = 'external_controller_wake';
const BROWSER_PROBE_OPERATION = 'browser_probe';
const GITHUB_ISSUE_WATCH_OPERATION = 'github_issue_watch';

function isDeterministicSchedule(schedule: RepositorySchedule): boolean {
  // Kernel executes only typed, bounded dispatch operations.
  return schedule.action.operation === LIVE_MAINTENANCE_OPERATION
    || schedule.action.operation === EXTERNAL_CONTROLLER_WAKE_OPERATION
    || schedule.action.operation === BROWSER_PROBE_OPERATION
    || schedule.action.operation === GITHUB_ISSUE_WATCH_OPERATION;
}

function retiredScheduleReason(schedule: RepositorySchedule): string | undefined {
  if (schedule.action.operation === 'chatgpt_browser_prompt') return 'RETIRED_WORK_FREE_PROMPT_SCHEDULE';
  if (schedule.action.operation === 'assistant_routine_execute') return 'RETIRED_PERSONAL_ASSISTANT_SCHEDULE';
  if ((schedule.trigger.condition as { kind?: string } | undefined)?.kind === 'candidate_observation_threshold') {
    return 'RETIRED_CANDIDATE_FINDING_SCHEDULE';
  }
  return undefined;
}

function normalizedWindow(minutes: number, at = Date.now()): string {
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

function cronWindowKey(schedule: RepositorySchedule, at = Date.now()): string {
  const timezone = schedule.trigger.timezone ?? 'UTC';
  const parts = zonedDateParts(at, timezone);
  const fixed = fixedCronTime(schedule.trigger.cronExpression);
  if (fixed) {
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}@${String(fixed.hour).padStart(2, '0')}:${String(fixed.minute).padStart(2, '0')}[${timezone}]`;
  }
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}[${timezone}]`;
}

function triggerWindowKey(schedule: RepositorySchedule, context: ScheduleTriggerContext | undefined, at = Date.now()): string {
  // Explicit control-plane triggers use a separate identity namespace from timer/cron windows.
  // A caller-supplied event/request id is the stable retry key; otherwise each manual trigger is distinct.
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

export function cronDue(
  expression: string | undefined,
  at = Date.now(),
  timezone = 'UTC',
  catchUpMinutes = 0,
): boolean {
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

async function workspaceDirty(controllerHome: string, repoId: string): Promise<boolean> {
  try {
    const repository = getRepository(repoId, controllerHome, { includeRemoved: true });
    const result = await execFileAsync('git', ['-C', repository.canonicalRoot, 'status', '--porcelain=v1'], {
      encoding: 'utf8', timeout: 1_500, maxBuffer: 256 * 1024,
    });
    return Boolean(result.stdout.trim());
  } catch {
    return true;
  }
}

async function triggerDue(
  controllerHome: string,
  schedule: RepositorySchedule,
  force: boolean,
  context?: ScheduleTriggerContext,
): Promise<{ due: boolean; reason?: string; evidence?: Record<string, unknown> }> {
  if (force && schedule.trigger.type !== 'repository-event') return { due: true };
  switch (schedule.trigger.type) {
    case 'manual':
      return { due: force, reason: force ? undefined : 'Manual Schedule requires an explicit trigger.' };
    case 'interval':
      return { due: true };
    case 'cron':
      return {
        due: cronDue(schedule.trigger.cronExpression, Date.now(), schedule.trigger.timezone ?? 'UTC', schedule.trigger.catchUpMinutes ?? 0),
        reason: `Cron expression is not due in the current ${schedule.trigger.timezone ?? 'UTC'} minute or catch-up window.`,
      };
    case 'calendar': {
      const at = Date.parse(schedule.trigger.calendarAt ?? '');
      if (!Number.isFinite(at)) throw new Error('SCHEDULE_CALENDAR_INVALID: calendarAt must be an ISO-8601 timestamp');
      return { due: Date.now() >= at, reason: 'Calendar trigger is not due yet.', evidence: { calendarAt: schedule.trigger.calendarAt } };
    }
    case 'repository-event': {
      const expected = schedule.trigger.eventName?.trim();
      const actual = context?.eventName?.trim();
      const due = context?.source === 'repository-event' && Boolean(actual) && (!expected || expected === actual);
      return { due, reason: due ? undefined : 'Repository event did not match this Schedule.', evidence: { expected, actual, eventId: context?.eventId } };
    }
    case 'dependency-checkpoint': {
      const dependencyJobIds = schedule.trigger.dependencyJobIds ?? [];
      if (dependencyJobIds.length === 0) throw new Error('SCHEDULE_DEPENDENCY_REQUIRED: dependency checkpoint has no Job ids');
      const jobs = dependencyJobIds.map((jobId) => findExecutionJob(controllerHome, jobId));
      const due = jobs.every((job) => job?.status === 'succeeded');
      return {
        due,
        reason: due ? undefined : 'Dependency checkpoint is not ready.',
        evidence: { dependencies: dependencyJobIds.map((jobId, index) => ({ jobId, status: jobs[index]?.status ?? 'missing' })) },
      };
    }
    case 'condition': {
      const condition = schedule.trigger.condition;
      if (!condition) throw new Error('SCHEDULE_CONDITION_REQUIRED');
      if (condition.kind === 'repository_clean') {
        const clean = !(await workspaceDirty(controllerHome, schedule.repoId));
        return { due: clean, reason: clean ? undefined : 'Repository is not clean.', evidence: { clean } };
      }
      if (condition.kind === 'job_succeeded' || condition.kind === 'job_terminal') {
        const job = condition.jobId ? findExecutionJob(controllerHome, condition.jobId) : undefined;
        const terminal = Boolean(job && ['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(job.status));
        const due = condition.kind === 'job_succeeded' ? job?.status === 'succeeded' : terminal;
        return { due, reason: due ? undefined : `Condition ${condition.kind} is not met.`, evidence: { jobId: condition.jobId, status: job?.status ?? 'missing' } };
      }
    }
    default:
      return { due: false, reason: 'Unsupported Schedule trigger.' };
  }
}

function workBoundScheduleWorkId(schedule: RepositorySchedule): string | undefined {
  if (schedule.action.operation !== EXTERNAL_CONTROLLER_WAKE_OPERATION
    && schedule.action.operation !== BROWSER_PROBE_OPERATION) return undefined;
  const value = schedule.action.arguments?.work_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function stopReason(controllerHome: string, schedule: RepositorySchedule): Promise<string | undefined> {
  const projection = readRepositoryProjection(controllerHome, schedule.repoId);
  const workId = workBoundScheduleWorkId(schedule);
  const work = workId ? getWorkContract({ controllerHome, repoId: schedule.repoId }, workId) : undefined;
  if (schedule.stopConditions.includes('human_review_required')) {
    if (workId) {
      const activeHandoff = listHandoffItems({ controllerHome, repoId: schedule.repoId, status: 'active', limit: 100 })
        .find((item) => item.workId === workId);
      if (activeHandoff) return `Work ${workId} has active Handoff ${activeHandoff.id} requiring review.`;
    } else if (projection.currentAttention.length > 0) {
      return 'Repository has jobs requiring human attention.';
    }
  }
  if (schedule.stopConditions.includes('release_ready') && projection.releaseFrozen) return 'Repository is in release freeze.';
  if (schedule.stopConditions.includes('external_blocker')) {
    try {
      const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
      if (!repository.enabled || repository.removedAt) return 'Repository is disabled or removed.';
    } catch {
      return 'Repository registry is unavailable.';
    }
    const recentInfrastructureFailure = listExecutionJobs(controllerHome, schedule.repoId, 20).find((job) => {
      if (!['failed', 'timed_out', 'orphaned'].includes(job.status) || !job.error) return false;
      if (workId) {
        if (!work || Date.parse(job.createdAt) < Date.parse(work.createdAt)) return false;
        if (!executionJobBelongsToWork(job, workId)) return false;
      }
      if (job.error.retryable) return true;
      return /(?:network|connection|upstream|external|remote|github|tunnel|502|503|timeout)/i.test(`${job.error.code} ${job.error.message}`);
    });
    if (recentInfrastructureFailure) return `External or infrastructure blocker detected from Job ${recentInfrastructureFailure.jobId}.`;
  }
  if (projection.activeJobs.some((job) => job.status === 'waiting_for_release_barrier')) return 'Repository is waiting on a release barrier.';
  if (schedule.action.operation !== LIVE_MAINTENANCE_OPERATION
    && schedule.action.resourceClaims?.some((claim) => claim.mode !== 'read')
    && await workspaceDirty(controllerHome, schedule.repoId)) {
    return 'Workspace is dirty; automatic write occurrence was suppressed.';
  }
  return undefined;
}

function dailyRuntimeMinutes(controllerHome: string, occurrences: ScheduleOccurrence[]): number {
  const today = new Date().toISOString().slice(0, 10);
  return occurrences
    .filter((entry) => entry.createdAt.startsWith(today) && ['succeeded', 'failed', 'queued', 'running'].includes(entry.status))
    .reduce((total, entry) => {
      if (entry.jobId) {
        const job = findExecutionJob(controllerHome, entry.jobId);
        if (job) {
          const started = Date.parse(job.startedAt ?? job.createdAt);
          const finished = Date.parse(job.finishedAt ?? new Date().toISOString());
          return total + Math.max(1, Math.ceil(Math.max(0, finished - started) / 60_000));
        }
      }
      const started = Date.parse(entry.createdAt);
      const finished = Date.parse(entry.updatedAt ?? entry.createdAt);
      return total + Math.max(1, Math.ceil(Math.max(0, finished - started) / 60_000));
    }, 0);
}

function occurrenceDecisionEvidence(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined));
}

function isLiveMaintenanceSchedule(schedule: RepositorySchedule): boolean {
  return schedule.action.operation === LIVE_MAINTENANCE_OPERATION;
}

function decideOccurrence(
  controllerHome: string,
  schedule: RepositorySchedule,
  occurrence: ScheduleOccurrence,
  decision: ScheduleDecisionType,
  status: ScheduleOccurrence['status'],
  reason?: string,
  evidence?: Record<string, unknown>,
): ScheduleOccurrence {
  const decisionId = `DEC-${occurrence.occurrenceId}`;
  saveScheduleDecision(controllerHome, {
    schemaVersion: 1,
    revision: 1,
    decisionId,
    occurrenceId: occurrence.occurrenceId,
    scheduleId: occurrence.scheduleId,
    repoId: occurrence.repoId,
    requestId: `${schedule.requestId}:${occurrence.windowKey}`,
    decision,
    reason,
    triggerContext: occurrence.triggerContext,
    evidence,
    createdAt: new Date().toISOString(),
  });
  return saveOccurrence(controllerHome, { ...occurrence, decision, decisionId, status, reason });
}

export type ChatgptWakeFailureClass = 'retryable_readiness' | 'semantic_wait' | 'user_action_required' | 'ordinary_failure';

export function classifyChatgptWakeFailure(reason: string): ChatgptWakeFailureClass {
  const normalized = reason.toUpperCase();
  if (
    normalized.includes('CHATGPT_AUTOMATION_LOGIN_REQUIRED')
    || normalized.includes('PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED')
    || normalized.includes('AUTHENTICATION_REQUIRED')
    || normalized.includes('CONSENT_REQUIRED')
  ) return 'user_action_required';
  if (normalized.includes('REPEATED_STATE:')) return 'semantic_wait';
  const retryableMarkers = [
    'PLUGIN_BROWSER_ATTACH_UNAVAILABLE',
    'PLUGIN_BROWSER_DEPENDENCY_UNAVAILABLE',
    'PLUGIN_BROWSER_NODE_HOST_UNAVAILABLE',
    'PLUGIN_BROWSER_NODE_UNAVAILABLE',
    'PLUGIN_BROWSER_ACTIVE_TAB_UNAVAILABLE',
    'PLUGIN_BROWSER_SESSION_STATE_LOST',
    'PLUGIN_SESSION_NOT_FOUND',
    'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNAVAILABLE',
    'CHATGPT_CONTROLLER_BROWSER_ROOT_UNAVAILABLE',
    'CHATGPT_CONTROLLER_BROWSER_FAILED',
    'CHATGPT_AUTOMATION_COMPOSER_UNAVAILABLE',
    'CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE',
    'CHATGPT_AUTOMATION_REPLACEMENT_SESSION_NOT_CONFIRMED',
    'HTTP 502',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
  ];
  if (retryableMarkers.some((marker) => normalized.includes(marker))) return 'retryable_readiness';
  return 'ordinary_failure';
}

function externalControllerLaunchArgs(args: Record<string, unknown>, controllerType: string): string[] {
  const launchArgs = Array.isArray(args.launch_args) ? args.launch_args.map(String) : [];
  if (controllerType !== 'chatgpt') return launchArgs;
  const explicit = new Set(launchArgs.filter((value) => value.startsWith('--')).map((value) => value.split('=', 1)[0]));
  const add = (flag: string, value: unknown) => {
    if (explicit.has(flag) || typeof value !== 'string' || !value.trim()) return;
    launchArgs.push(flag, value.trim());
  };
  add('--model', args.model);
  add('--reasoning', args.reasoning);
  add('--tab-policy', args.tab_policy);
  return launchArgs;
}

async function executeExternalControllerWake(
  controllerHome: string,
  schedule: RepositorySchedule,
  occurrence: ScheduleOccurrence,
  timestamp: string,
  args: Record<string, unknown>,
  extraEvidence: Record<string, unknown> = {},
  options: { transientWakeFailure?: boolean } = {},
): Promise<ScheduleOccurrence> {
  const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const controllerType = typeof args.controller_type === 'string' ? args.controller_type.trim() : 'chatgpt';
  if (!workId) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', 'EXTERNAL_CONTROLLER_WAKE_WORK_ID_REQUIRED');
  }
  if (!['chatgpt', 'codex', 'claude', 'grok'].includes(controllerType)) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', 'EXTERNAL_CONTROLLER_WAKE_TYPE_INVALID');
  }
  const workStore = { controllerHome, repoId: schedule.repoId };
  const work = getWorkContract(workStore, workId);
  if (!work) {
    saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: `Work ${workId} no longer exists.`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId });
    return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', `EXTERNAL_CONTROLLER_WAKE_WORK_NOT_FOUND:${workId}`);
  }
  if (isTerminalWorkContractStatus(work.status)) {
    saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: `Work ${workId} is terminal (${work.status}).`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId });
    return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} is terminal (${work.status}); automatic continuation stopped.`);
  }
  const existingOwner = getControllerSession(workStore, workId);
  const occurrenceNowMs = Date.parse(timestamp);
  const nowMs = Number.isFinite(occurrenceNowMs) ? occurrenceNowMs : Date.now();
  if (workHasActiveExecution(controllerHome, schedule.repoId, workId)) {
    saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId });
    return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} has active execution; duplicate Controller wake suppressed.`);
  }
  if (existingOwner && controllerSessionBlocksRecovery(workStore, workId, { nowMs })) {
    saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId });
    return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} has a recently active Controller ${existingOwner.controllerId}.`);
  }
  const launchReservation = getExternalControllerLaunchReservation(workStore, workId);
  if (launchReservation) {
    saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId });
    return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} already has a pending external Controller launch ${launchReservation.reservationId}.`);
  }
  const wakeDecision = decideOccurrence(
    controllerHome,
    schedule,
    occurrence,
    'execute',
    'running',
    'Deterministic external Controller wake is starting through Thin Launcher.',
    occurrenceDecisionEvidence({
      operation: schedule.action.operation,
      workId,
      controllerType,
      ...(controllerType === 'chatgpt' ? {
        model: typeof args.model === 'string' ? args.model : 'gpt-5.6',
        reasoning: typeof args.reasoning === 'string' ? args.reasoning : 'high',
        tabPolicy: typeof args.tab_policy === 'string' ? args.tab_policy : 'auto',
      } : {}),
      ...extraEvidence,
    }),
  );
  try {
    const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
    const continuationPrompt = typeof args.continuation_prompt === 'string'
      ? args.continuation_prompt
      : `Scheduled continuation ${occurrence.occurrenceId} from ${schedule.scheduleId}. Read current Forge state and continue only the bounded Work objective.`;
    if (controllerType === 'chatgpt') {
      const reasoning = args.reasoning === 'medium' || args.reasoning === 'xhigh' ? args.reasoning : 'high';
      const tabPolicy = args.tab_policy === 'reuse' || args.tab_policy === 'new' ? args.tab_policy : 'auto';
      let relay;
      try {
        relay = beginInitialControllerRoundDispatch(workStore, {
          workId,
          identity: {
            controllerId: `schedule:${schedule.scheduleId}`,
            principalId: 'forge-scheduler',
            controllerInstanceId: 'forge-runtime-scheduler',
            sessionId: occurrence.occurrenceId,
          },
          requirementId: work.requirementId,
          browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
          conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
        });
        if (relay.status === 'blocked') throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED: ${relay.blockedReason ?? relay.relayScopeId}`);
        const relayPrompt = `${buildControllerRoundRelayPrompt(workStore, relay)}\n\nScheduled continuation hint: ${continuationPrompt}`;
        const dispatched = await runWorkChatgptContinuation({
          controllerHome,
          repoId: schedule.repoId,
          repoRoot: repository.canonicalRoot,
          workId,
          prompt: relayPrompt,
          title: schedule.name,
          browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
          conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
          model: typeof args.model === 'string' ? args.model : 'gpt-5.6',
          reasoning,
          tabPolicy,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        });
        if (dispatched.status === 'failed') throw new Error(dispatched.error?.message ?? 'CHATGPT_WORK_CONTINUATION_FAILED');
        const completedRelay = finishControllerRoundRelayDispatch(workStore, {
          workId,
          ok: true,
          browserSessionId: dispatched.browserSessionId,
          conversationUrl: dispatched.conversationUrl,
        });
        const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
        saveSchedule(controllerHome, {
          ...latest,
          lastTriggeredAt: timestamp,
          lastOccurrenceId: occurrence.occurrenceId,
          consecutiveFailures: 0,
          nextEligibleAt: undefined,
          pausedReason: undefined,
        });
        const succeededOccurrence = saveOccurrence(controllerHome, {
          ...wakeDecision,
          status: 'succeeded',
          reason: `ChatGPT dispatch action succeeded via ${dispatched.browserSessionId}; relay ${completedRelay?.relayScopeId ?? relay.relayScopeId} remains dispatched until the new Controller claims Work ${workId}.`,
        });
        appendWorkEvidence(workStore, workId, {
          evidenceId: succeededOccurrence.occurrenceId,
          title: 'scheduled ChatGPT continuation dispatched',
          summary: `Schedule ${schedule.scheduleId} timer occurrence ${succeededOccurrence.occurrenceId} dispatched the Work-bound ChatGPT continuation successfully.`,
          detailLevel: 'summary',
        });
        return succeededOccurrence;
      } catch (error) {
        if (relay) {
          finishControllerRoundRelayDispatch(workStore, {
            workId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (error instanceof Error && error.message.startsWith('CONTROLLER_RELAY_ROUND_ALREADY_OPEN:')) {
          const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
          saveSchedule(controllerHome, { ...latest, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId });
          return decideOccurrence(controllerHome, schedule, wakeDecision, 'nothing_to_do', 'skipped', `Work ${workId} already has an open ChatGPT controller round awaiting claim or disposition.`);
        }
        throw error;
      }
    }
    const launched = await launchSuperController({
      work: { controllerHome, repoId: schedule.repoId },
      handoff: { controllerHome, repoId: schedule.repoId },
    }, {
      controllerType: controllerType as 'codex' | 'claude' | 'grok',
      executable: typeof args.executable === 'string' ? args.executable : undefined,
      args: externalControllerLaunchArgs(args, controllerType),
      workId,
      handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
      browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
      conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
      launchReservationMs: typeof args.launch_reservation_ms === 'number' ? args.launch_reservation_ms : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
      continuationPrompt,
      cwd: repository.canonicalRoot,
    });
    const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
    saveSchedule(controllerHome, {
      ...latest,
      lastTriggeredAt: timestamp,
      lastOccurrenceId: occurrence.occurrenceId,
      consecutiveFailures: 0,
      nextEligibleAt: undefined,
      pausedReason: undefined,
    });
    return saveOccurrence(controllerHome, {
      ...wakeDecision,
      status: 'succeeded',
      reason: `External Controller wake started ${launched.controllerType} pid=${String(launched.pid ?? 'unknown')} for Work ${workId}.`,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureClass = controllerType === 'chatgpt' ? classifyChatgptWakeFailure(reason) : 'ordinary_failure';
    if (options.transientWakeFailure || failureClass === 'retryable_readiness' || failureClass === 'semantic_wait') {
      const semanticWait = failureClass === 'semantic_wait';
      const deferred = applyScheduleRetryableFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
        outcome: semanticWait ? 'skipped' : 'failed',
        decision: semanticWait ? 'nothing_to_do' : 'execute',
        reason: semanticWait
          ? `Controller wake deferred until durable state changes; schedule remains active: ${reason}`
          : `Controller wake deferred by transient readiness; schedule remains active with bounded backoff: ${reason}`,
        countFailure: !semanticWait,
      });
      const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
      saveSchedule(controllerHome, {
        ...latest,
        lastTriggeredAt: timestamp,
        lastOccurrenceId: occurrence.occurrenceId,
      });
      return deferred.occurrence ?? saveOccurrence(controllerHome, {
        ...wakeDecision,
        status: semanticWait ? 'skipped' : 'failed',
        decision: semanticWait ? 'nothing_to_do' : 'execute',
        reason,
      });
    }
    const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
      outcome: 'failed',
      decision: 'execute',
      reason,
      ...(failureClass === 'user_action_required' ? { pauseReason: reason } : {}),
      handoff: {
        title: `External Controller wake ${occurrence.occurrenceId} failed`,
        summary: 'Forge recorded the schedule trigger but could not wake the configured external Controller.',
        reason,
        creationReason: 'repeated_infrastructure_failure',
        blockingDecision: 'Repair the external Controller/browser launch path or update the saved session reference.',
        recommendedDecision: 'Inspect launcher/browser readiness, then retrigger this bounded continuation.',
        recommendedPrompt: `Resume Work ${workId} manually, inspect failed wake occurrence ${occurrence.occurrenceId}, and repair the configured external Controller launch path before unattended continuation resumes.`,
        statusSummary: 'Scheduled external Controller wake failed.',
        blockedBy: ['external_controller_wake_failed'],
        attemptedActions: [`schedule:${schedule.scheduleId}`, `work:${workId}`, `controller:${controllerType}`],
      },
    });
    const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
    saveSchedule(controllerHome, { ...latest, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId });
    return failed.occurrence ?? saveOccurrence(controllerHome, { ...wakeDecision, status: 'failed', reason });
  }
}

export async function evaluateSchedule(
  controllerHome: string,
  schedule: RepositorySchedule,
  force = false,
  triggerContext?: ScheduleTriggerContext,
): Promise<ScheduleOccurrence | undefined> {
  // Preserve retired schedule records as evidence, but do not create a new
  // occurrence or resume a controller/external action from their old payload.
  if (retiredScheduleReason(schedule)) return undefined;
  if (!schedule.enabled && !force) return undefined;
  const due = await triggerDue(controllerHome, schedule, force, triggerContext);
  if (!due.due) return undefined;

  const key = triggerWindowKey(schedule, triggerContext);
  const occurrenceId = `OCC-${schedule.scheduleId}-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  const existing = getOccurrence(controllerHome, schedule.repoId, occurrenceId);
  if (existing) return existing;
  const timestamp = new Date().toISOString();
  const occurrence: ScheduleOccurrence = saveOccurrence(controllerHome, {
    schemaVersion: 1,
    revision: 0,
    occurrenceId,
    scheduleId: schedule.scheduleId,
    repoId: schedule.repoId,
    windowKey: key,
    status: 'created',
    decision: 'nothing_to_do',
    triggerContext: triggerContext ?? { source: force ? 'manual' : 'timer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  // Semantic / model-backed schedules only record a trigger + Handoff.
  // Deterministic allowlisted operations continue into the local engine path.
  if (!isDeterministicSchedule(schedule)) {
    const externalControllerHandoff = recordScheduleOccurrenceHandoff(
      controllerHome,
      schedule,
      decideOccurrence(
        controllerHome,
        schedule,
        occurrence,
        'operation_blocked',
        'skipped',
        'Schedule execution is external-controller-owned; no ExecutionJob was created.',
        occurrenceDecisionEvidence({ operation: schedule.action.operation, trigger: occurrence.triggerContext?.source }),
      ),
      {
        title: `Schedule ${schedule.name} requires an external Controller`,
        summary: 'The scheduled trigger was recorded without dispatching a Kernel Job.',
        reason: 'Schedule execution is external-controller-owned.',
        creationReason: 'ambiguous_outcome',
        blockingDecision: 'Claim or create the related Work before executing the scheduled operation.',
        recommendedDecision: 'Review the trigger evidence and continue it through an explicitly claimed external Controller session.',
        recommendedPrompt: `Review schedule ${schedule.scheduleId} occurrence ${occurrence.occurrenceId}; create or claim Work for ${schedule.action.operation} and continue through Process Runtime or Thin Launcher.`,
        statusSummary: 'Schedule trigger is waiting for external Controller ownership.',
        blockedBy: ['external_controller_required'],
        attemptedActions: [`operation:${schedule.action.operation}`],
      },
    );
    saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
    return externalControllerHandoff;
  }

  const recent = listOccurrences(controllerHome, schedule.repoId, schedule.scheduleId, 1000);
  const stop = await stopReason(controllerHome, schedule);
  if (stop) {
    const stopped = decideOccurrence(controllerHome, schedule, occurrence, 'stopped', 'skipped', stop);
    if (!isLiveMaintenanceSchedule(schedule)) return stopped;
    const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
      outcome: 'skipped',
      decision: 'stopped',
      reason: stop,
      countFailure: false,
      pauseReason: stop,
      handoff: {
        title: `Scheduled maintenance occurrence ${occurrence.occurrenceId} stopped`,
        summary: 'A live maintenance occurrence was blocked by an explicit schedule stop condition and requires review before automation resumes.',
        reason: stop,
        creationReason: 'ambiguous_outcome',
        blockingDecision: 'Review the stop condition and decide whether automatic maintenance should stay paused.',
        recommendedDecision: 'Resolve the stop condition, then explicitly re-enable or retrigger the maintenance schedule.',
        recommendedPrompt: `Review maintenance schedule ${schedule.scheduleId} for repo ${schedule.repoId}, inspect stop condition ${stop}, and decide whether to resume the schedule.`,
        statusSummary: 'Scheduled maintenance occurrence stopped before dispatch.',
        blockedBy: ['schedule_stop_condition'],
        attemptedActions: [`schedule:${schedule.scheduleId}`, `operation:${schedule.action.operation}`],
      },
    });
    return failed.occurrence ?? stopped;
  }

  const active = listActiveOccurrences(controllerHome, schedule.repoId, schedule.scheduleId)
    .filter((entry) => entry.occurrenceId !== occurrence.occurrenceId);
  if (active.length >= schedule.policy.maxActiveOccurrences) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'active_occurrence', 'skipped', 'Maximum active occurrences reached.');
  }
  if (schedule.consecutiveFailures >= schedule.policy.maxFailures) {
    saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: 'Maximum consecutive failures reached.' });
    return decideOccurrence(controllerHome, schedule, occurrence, 'stopped', 'skipped', 'Schedule paused after repeated failures.');
  }
  if (schedule.nextEligibleAt && Date.parse(schedule.nextEligibleAt) > Date.now() && !force) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'cooldown', 'skipped', `Schedule backoff remains active until ${schedule.nextEligibleAt}.`);
  }
  if (schedule.lastTriggeredAt && Date.now() - Date.parse(schedule.lastTriggeredAt) < schedule.policy.cooldownMinutes * 60_000 && !force) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'cooldown', 'skipped', 'Schedule is cooling down.');
  }
  if (dailyRuntimeMinutes(controllerHome, recent) >= schedule.policy.dailyBudgetMinutes) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'budget_exhausted', 'skipped', 'Daily schedule budget exhausted.');
  }
  if (schedule.policy.shadowMode) {
    if (isLiveMaintenanceSchedule(schedule)) {
      const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
      const preview = previewAutomaticRuntimeMaintenance(repository, controllerHome, schedule.action.arguments);
      if (!preview.allowed) {
        const decision = preview.blockedPermanently ? 'operation_blocked' : 'maintenance_not_ready';
        const blocked = decideOccurrence(controllerHome, schedule, occurrence, decision, 'skipped', preview.blockedReason, occurrenceDecisionEvidence({
          actionId: preview.actionId,
          safeCandidates: preview.selectedCandidateIds.length,
          typedSafeCandidates: preview.selectedTypedCandidateIds.length,
        }));
        const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
          outcome: 'skipped',
          decision,
          reason: preview.blockedReason ?? 'Automatic maintenance preview blocked the occurrence.',
          countFailure: !preview.blockedPermanently,
          pauseReason: preview.blockedPermanently ? preview.blockedReason : undefined,
          handoff: {
            title: `Scheduled maintenance occurrence ${occurrence.occurrenceId} blocked`,
            summary: 'A bounded live maintenance occurrence was blocked before dispatch and requires a human decision.',
            reason: preview.blockedReason ?? 'Automatic maintenance preview blocked the occurrence.',
            creationReason: preview.blockedPermanently ? 'missing_authorization' : 'ambiguous_outcome',
            blockingDecision: preview.blockedPermanently
              ? 'Fix the schedule operation or authorization before automatic maintenance can resume.'
              : 'Inspect runtime maintenance readiness before allowing another unattended attempt.',
            recommendedDecision: preview.blockedPermanently
              ? 'Correct the automatic maintenance configuration and re-enable the schedule deliberately.'
              : 'Review the maintenance preview, resolve the blocker, and then retrigger the schedule intentionally.',
            recommendedPrompt: `Review blocked maintenance occurrence ${occurrence.occurrenceId} for schedule ${schedule.scheduleId}. Determine whether the schedule configuration or runtime maintenance readiness should be corrected before retrying.`,
            statusSummary: 'Scheduled maintenance occurrence blocked before dispatch.',
            blockedBy: [decision],
            attemptedActions: [`schedule:${schedule.scheduleId}`, `operation:${schedule.action.operation}`],
          },
        });
        return failed.occurrence ?? blocked;
      }
      if (preview.noOp) {
        return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', 'Automatic maintenance preview found nothing safe to repair.', occurrenceDecisionEvidence({
          actionId: preview.actionId,
          readyForExecution: preview.status.readyForExecution,
        }));
      }
      saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
      return decideOccurrence(controllerHome, schedule, occurrence, 'would_execute', 'shadowed', 'Shadow mode records the live maintenance decision without applying it.', occurrenceDecisionEvidence({
        actionId: preview.actionId,
        safeCandidates: preview.selectedCandidateIds.length,
        typedSafeCandidates: preview.selectedTypedCandidateIds.length,
      }));
    }
    saveSchedule(controllerHome, { ...schedule, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
    return decideOccurrence(controllerHome, schedule, occurrence, 'would_execute', 'shadowed', 'Shadow mode records the decision without modifying the repository.', due.evidence);
  }

  if (isLiveMaintenanceSchedule(schedule)) {
    const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
    const preview = previewAutomaticRuntimeMaintenance(repository, controllerHome, schedule.action.arguments);
    if (!preview.allowed) {
      const decision = preview.blockedPermanently ? 'operation_blocked' : 'maintenance_not_ready';
      const blocked = decideOccurrence(controllerHome, schedule, occurrence, decision, 'skipped', preview.blockedReason, occurrenceDecisionEvidence({
        actionId: preview.actionId,
        safeCandidates: preview.selectedCandidateIds.length,
        typedSafeCandidates: preview.selectedTypedCandidateIds.length,
      }));
      const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
        outcome: 'skipped',
        decision,
        reason: preview.blockedReason ?? 'Automatic maintenance preview blocked the occurrence.',
        countFailure: !preview.blockedPermanently,
        pauseReason: preview.blockedPermanently ? preview.blockedReason : undefined,
        handoff: {
          title: `Scheduled maintenance occurrence ${occurrence.occurrenceId} blocked`,
          summary: 'A bounded live maintenance occurrence was blocked before dispatch and requires a human decision.',
          reason: preview.blockedReason ?? 'Automatic maintenance preview blocked the occurrence.',
          creationReason: preview.blockedPermanently ? 'missing_authorization' : 'ambiguous_outcome',
          blockingDecision: preview.blockedPermanently
            ? 'Fix the schedule operation or authorization before automatic maintenance can resume.'
            : 'Inspect runtime maintenance readiness before allowing another unattended attempt.',
          recommendedDecision: preview.blockedPermanently
            ? 'Correct the automatic maintenance configuration and re-enable the schedule deliberately.'
            : 'Review the maintenance preview, resolve the blocker, and then retrigger the schedule intentionally.',
          recommendedPrompt: `Review blocked maintenance occurrence ${occurrence.occurrenceId} for schedule ${schedule.scheduleId}. Determine whether the schedule configuration or runtime maintenance readiness should be corrected before retrying.`,
          statusSummary: 'Scheduled maintenance occurrence blocked before dispatch.',
          blockedBy: [decision],
          attemptedActions: [`schedule:${schedule.scheduleId}`, `operation:${schedule.action.operation}`],
        },
      });
      return failed.occurrence ?? blocked;
    }
    if (preview.noOp) {
      return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', 'Automatic maintenance preview found nothing safe to repair.', occurrenceDecisionEvidence({
        actionId: preview.actionId,
        readyForExecution: preview.status.readyForExecution,
      }));
    }
  }

  const args = schedule.action.arguments ?? {};
  if (schedule.action.operation === EXTERNAL_CONTROLLER_WAKE_OPERATION) {
    return executeExternalControllerWake(controllerHome, schedule, occurrence, timestamp, args);
  }

  if (schedule.action.operation === GITHUB_ISSUE_WATCH_OPERATION) {
    try {
      const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
      const observation = await executeScheduledGithubIssueWatch({ repoRoot: repository.canonicalRoot, args, observedAt: timestamp });
      const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
      const evidence = occurrenceDecisionEvidence({
        githubRepository: typeof args.github_repository === 'string' ? args.github_repository : undefined,
        observationStatus: observation.status,
        observedIssueCount: observation.issues.length,
        changedIssueNumbers: observation.changedOpenIssues.map((issue) => issue.number),
      });
      const persistObservation = () => saveSchedule(controllerHome, {
        ...getSchedule(controllerHome, schedule.repoId, schedule.scheduleId),
        action: {
          ...latest.action,
          arguments: { ...(latest.action.arguments ?? {}), issue_watch_state: observation.nextState, issue_watch_since: undefined },
        },
        lastTriggeredAt: timestamp,
        lastOccurrenceId: occurrenceId,
        lastObservationAt: timestamp,
        lastObservationStatus: observation.status,
        lastObservationChangedAt: observation.shouldWake ? timestamp : latest.lastObservationChangedAt,
        consecutiveFailures: 0,
        consecutiveNoops: observation.shouldWake ? 0 : (latest.consecutiveNoops ?? 0) + 1,
        nextEligibleAt: undefined,
        pausedReason: undefined,
      });
      if (!observation.shouldWake) {
        const observedSchedule = persistObservation();
        const reason = observation.status === 'baseline'
          ? 'GitHub issue watcher baseline recorded; no Controller wake was emitted.'
          : 'GitHub issue watcher found no new, reopened, or updated open issue.';
        return decideOccurrence(controllerHome, observedSchedule, occurrence, 'nothing_to_do', 'skipped', reason, evidence);
      }
      const issueSummary = observation.changedOpenIssues.slice(0, 10)
        .map((issue) => `#${issue.number} ${issue.title}`)
        .join('; ');
      const wakeArgs = {
        ...args,
        continuation_prompt: typeof args.continuation_prompt === 'string'
          ? `${args.continuation_prompt}\n\nGitHub issue watcher detected: ${issueSummary}`
          : `GitHub issue watcher detected actionable issue changes: ${issueSummary}. Read current Work/Plan/evidence and process these issues through the bounded repair workflow.`,
      };
      const wake = await executeExternalControllerWake(controllerHome, schedule, occurrence, timestamp, wakeArgs, evidence, { transientWakeFailure: true });
      if (wake.status !== 'failed') persistObservation();
      return wake;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
        outcome: 'failed',
        decision: 'execute',
        reason,
        handoff: {
          title: `GitHub issue watcher occurrence ${occurrence.occurrenceId} failed`,
          summary: 'The local GitHub issue poll failed before Forge could compare issue state.',
          reason,
          creationReason: 'repeated_infrastructure_failure',
          blockingDecision: 'Repair GitHub CLI authentication/connectivity before unattended issue monitoring resumes.',
          recommendedDecision: 'Restore gh read access, then retrigger the watcher.',
          recommendedPrompt: `Inspect GitHub issue watcher occurrence ${occurrence.occurrenceId} and restore the local read-only gh issue polling path.`,
          statusSummary: 'GitHub issue watcher poll failed.',
          blockedBy: ['github_issue_watch_failed'],
          attemptedActions: [`schedule:${schedule.scheduleId}`, 'gh:api:issues'],
        },
      });
      return failed.occurrence ?? occurrence;
    }
  }

  if (schedule.action.operation === BROWSER_PROBE_OPERATION) {
    const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
    const keepaliveOnly = args.keepalive_only === true;
    if (!workId && !keepaliveOnly) {
      return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', 'SCHEDULE_BROWSER_PROBE_WORK_ID_REQUIRED');
    }
    if (workId) {
      const workStore = { controllerHome, repoId: schedule.repoId };
      const work = getWorkContract(workStore, workId);
      if (!work) {
        saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: `Work ${workId} no longer exists.`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
        return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', `SCHEDULE_BROWSER_PROBE_WORK_NOT_FOUND:${workId}`);
      }
      if (isTerminalWorkContractStatus(work.status)) {
        saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: `Work ${workId} is terminal (${work.status}).`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
        return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} is terminal (${work.status}); browser watcher stopped before probing.`);
      }
    }

    try {
      const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
      const probe = await executeScheduledBrowserProbe({ controllerHome, repository, occurrenceId, args });
      const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
      const observationEvidence = occurrenceDecisionEvidence({
        probeStatus: probe.status,
        url: probe.url,
        projectedLineCount: probe.projectedLineCount,
        observedChars: probe.observedChars,
        truncated: probe.truncated,
      });

      if (probe.status === 'auth_required') {
        const observedSchedule = saveSchedule(controllerHome, {
          ...latest,
          lastTriggeredAt: timestamp,
          lastOccurrenceId: occurrenceId,
          lastObservationAt: timestamp,
          lastObservationStatus: 'auth_required',
          consecutiveFailures: 0,
          nextEligibleAt: undefined,
          pausedReason: undefined,
        });
        if (args.wake_on_auth_required !== false) {
          const authPrompt = typeof args.auth_required_prompt === 'string'
            ? args.auth_required_prompt
            : typeof args.continuation_prompt === 'string'
              ? args.continuation_prompt
              : `Scheduled browser watcher ${schedule.scheduleId} detected that authentication is required (${probe.authReason ?? 'login marker'}). Inspect the external dependency and request user login only if it cannot be restored safely.`;
          if (workId) {
            const wakeArgs = { ...args, continuation_prompt: authPrompt };
            return executeExternalControllerWake(controllerHome, observedSchedule, occurrence, timestamp, wakeArgs, { ...observationEvidence, authReason: probe.authReason });
          }
          const controllerType = typeof args.controller_type === 'string' ? args.controller_type.trim() : 'chatgpt';
          if (controllerType !== 'chatgpt') {
            return decideOccurrence(controllerHome, observedSchedule, occurrence, 'operation_blocked', 'skipped', 'STANDALONE_BROWSER_KEEPALIVE_CHATGPT_REQUIRED', observationEvidence);
          }
          const dispatched = await runStandaloneChatgptPrompt({
            controllerHome,
            repoId: schedule.repoId,
            scopeId: `schedule:${schedule.scheduleId}`,
            prompt: authPrompt,
            browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
            conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
          });
          if (dispatched.status === 'failed') throw new Error(dispatched.error?.message ?? 'CHATGPT_STANDALONE_PROMPT_FAILED');
          return decideOccurrence(
            controllerHome,
            observedSchedule,
            occurrence,
            'execute',
            'succeeded',
            'Standalone browser keepalive auth-required prompt dispatched to ChatGPT.',
            {
              ...observationEvidence,
              authReason: probe.authReason,
              browserSessionId: dispatched.browserSessionId,
              conversationUrl: dispatched.conversationUrl,
            },
          );
        }
        return decideOccurrence(controllerHome, observedSchedule, occurrence, 'operation_blocked', 'skipped', `Browser ${workId ? 'watcher' : 'keepalive'} requires authentication: ${probe.authReason ?? 'login marker matched'}`, observationEvidence);
      }

      if (probe.status === 'keepalive') {
        const observedSchedule = saveSchedule(controllerHome, {
          ...latest,
          lastTriggeredAt: timestamp,
          lastOccurrenceId: occurrenceId,
          lastObservationAt: timestamp,
          lastObservationStatus: 'keepalive',
          consecutiveFailures: 0,
          consecutiveNoops: 0,
          nextEligibleAt: undefined,
          pausedReason: undefined,
        });
        return decideOccurrence(controllerHome, observedSchedule, occurrence, 'execute', 'succeeded', 'Browser session keepalive refreshed successfully.', observationEvidence);
      }

      const observation = classifyScheduledBrowserObservation(
        latest.lastObservationFingerprint,
        probe.fingerprint,
        args.wake_on_first_observation === true,
      );
      const changed = observation.status === 'changed';
      const shouldWake = args.wake_on_change !== false && observation.shouldWake;
      const observationStatus: RepositorySchedule['lastObservationStatus'] = observation.status;
      const observedSchedule = saveSchedule(controllerHome, {
        ...latest,
        lastTriggeredAt: timestamp,
        lastOccurrenceId: occurrenceId,
        lastObservationAt: timestamp,
        lastObservationFingerprint: probe.fingerprint,
        lastObservationChangedAt: changed ? timestamp : latest.lastObservationChangedAt,
        lastObservationStatus: observationStatus,
        consecutiveFailures: 0,
        consecutiveNoops: shouldWake ? 0 : (latest.consecutiveNoops ?? 0) + 1,
        nextEligibleAt: undefined,
        pausedReason: undefined,
      });

      if (!shouldWake) {
        const reason = observation.status === 'baseline'
          ? 'Browser watcher baseline recorded; no Controller wake was emitted.'
          : 'Browser watcher observation is unchanged; no Controller wake was emitted.';
        return decideOccurrence(controllerHome, observedSchedule, occurrence, 'nothing_to_do', 'skipped', reason, { ...observationEvidence, observationStatus });
      }

      const wakeArgs = {
        ...args,
        continuation_prompt: typeof args.continuation_prompt === 'string'
          ? args.continuation_prompt
          : `Scheduled browser watcher ${schedule.scheduleId} detected a changed external observation. Read the current external state, correlate it with Work ${workId}, and continue only the bounded Work objective.`,
      };
      return executeExternalControllerWake(controllerHome, observedSchedule, occurrence, timestamp, wakeArgs, { ...observationEvidence, observationStatus });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
        outcome: 'failed',
        decision: 'execute',
        reason,
        handoff: {
          title: `Browser watcher occurrence ${occurrence.occurrenceId} failed`,
          summary: 'A bounded browser probe failed before Forge could compare the external observation.',
          reason,
          creationReason: 'repeated_infrastructure_failure',
          blockingDecision: 'Repair browser/session readiness or update the watcher target before unattended probing resumes.',
          recommendedDecision: 'Inspect the browser plugin/session and retrigger the watcher after the target is readable.',
          recommendedPrompt: `Inspect browser watcher schedule ${schedule.scheduleId} for Work ${workId}, repair the failed browser probe, then retrigger one bounded occurrence.`,
          statusSummary: 'Scheduled browser watcher failed.',
          blockedBy: ['browser_probe_failed'],
          attemptedActions: [`schedule:${schedule.scheduleId}`, `work:${workId}`, 'operation:browser_probe'],
        },
      });
      const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
      saveSchedule(controllerHome, { ...latest, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId });
      return failed.occurrence ?? saveOccurrence(controllerHome, { ...occurrence, status: 'failed', decision: 'execute', reason });
    }
  }

  const actionIdRaw = typeof args.action_id === 'string'
    ? args.action_id
    : typeof args.actionId === 'string'
      ? args.actionId
      : undefined;
  const decision = decideOccurrence(
    controllerHome,
    schedule,
    occurrence,
    'execute',
    'running',
    'Deterministic schedule occurrence executing inline without an ExecutionJob.',
    occurrenceDecisionEvidence({
      ...due.evidence,
      operation: schedule.action.operation,
      actionId: actionIdRaw,
    }),
  );

  try {
    if (!actionIdRaw) {
      throw new Error('SCHEDULE_ACTION_ID_REQUIRED: deterministic maintenance schedules require action_id.');
    }
    const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
    const result = applyRuntimeMaintenance(repository, controllerHome, {
      confirmMaintenance: true,
      actionId: actionIdRaw as RuntimeMaintenanceActionId,
      minAgeMinutes: typeof args.min_age_minutes === 'number'
        ? args.min_age_minutes
        : typeof args.minAgeMinutes === 'number'
          ? args.minAgeMinutes
          : undefined,
      maxCandidates: typeof args.max_candidates === 'number'
        ? args.max_candidates
        : typeof args.maxCandidates === 'number'
          ? args.maxCandidates
          : undefined,
      cancelPendingApprovals: false,
    });
    const appliedCount = result.applied.filter((candidate) => candidate.applied).length;
    const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
    saveSchedule(controllerHome, {
      ...latest,
      lastTriggeredAt: timestamp,
      lastOccurrenceId: occurrenceId,
      consecutiveFailures: 0,
      nextEligibleAt: undefined,
      pausedReason: undefined,
    });
    return saveOccurrence(controllerHome, {
      ...decision,
      status: 'succeeded',
      reason: `Deterministic maintenance applied ${appliedCount} candidate(s) for ${actionIdRaw}.`,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
      outcome: 'failed',
      decision: 'execute',
      reason,
      handoff: {
        title: `Scheduled maintenance occurrence ${occurrence.occurrenceId} failed`,
        summary: 'A bounded live maintenance occurrence failed during deterministic apply and requires review before the schedule continues unattended.',
        reason,
        creationReason: 'repeated_infrastructure_failure',
        blockingDecision: 'Review the failed maintenance occurrence and decide whether the schedule should continue automatically.',
        recommendedDecision: 'Inspect the failed occurrence, fix the runtime blocker, then re-enable or retrigger the schedule intentionally.',
        recommendedPrompt: `Review schedule occurrence ${occurrence.occurrenceId} for ${schedule.scheduleId}, inspect the failed runtime maintenance action, and decide whether to resume automatic maintenance.`,
        statusSummary: 'Scheduled maintenance execution failed.',
        blockedBy: ['scheduled_execution_failed'],
        attemptedActions: [
          `schedule:${schedule.scheduleId}`,
          `operation:${schedule.action.operation}`,
          actionIdRaw ? `action:${actionIdRaw}` : 'action:unknown',
        ],
      },
    });
    const latest = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
    saveSchedule(controllerHome, {
      ...latest,
      lastTriggeredAt: timestamp,
      lastOccurrenceId: occurrenceId,
    });
    return failed.occurrence ?? saveOccurrence(controllerHome, {
      ...decision,
      status: 'failed',
      reason,
    });
  }
}

export async function tickSchedules(controllerHome: string, repoIds: string[]): Promise<ScheduleOccurrence[]> {
  const occurrences: ScheduleOccurrence[] = [];
  for (const repoId of repoIds) {
    for (const schedule of listSchedules(controllerHome, repoId)) {
      const occurrence = await evaluateSchedule(controllerHome, schedule, false, { source: 'timer' });
      if (occurrence) occurrences.push(occurrence);
    }
  }
  return occurrences;
}

export function hasScheduledWriter(controllerHome: string, repoId: string): boolean {
  return listActiveExecutionJobs(controllerHome, repoId).some((job) => job.origin.surface === 'schedule' && job.resourceClaims.some((claim) => claim.mode !== 'read'));
}
