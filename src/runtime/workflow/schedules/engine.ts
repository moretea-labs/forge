import { createHash } from 'crypto';
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
import { appendWorkEvidence, getWorkContract, isTerminalWorkContractStatus } from '../../../../packages/kernel/work/api/index';
import {
  controllerSessionBlocksRecovery,
  getControllerSession,
  getControllerSessionBinding,
  getRetainedControllerSession,
} from '../../../../packages/kernel/controller/api/index';
import {
  applyScheduleFailure,
  applyScheduleRetryableFailure,
  cronDue,
  evaluateScheduleOccurrenceAdmission,
  evaluateScheduleTriggerEligibility,
  getOccurrence,
  getSchedule,
  listActiveOccurrences,
  listOccurrences,
  recordScheduleOccurrenceHandoff,
  resumeScheduledControllerContinuation,
  listSchedules,
  saveOccurrence,
  saveScheduleDecision,
  updateSchedule,
} from '../../../../packages/kernel/scheduler/api/index';
export { cronDue };
import { ensureScheduledControllerBinding, controllerHostForScheduledBinding } from '../../root/scheduled-controller-composition';
import { listHandoffItems } from '../../control-plane/facade/handoff-inbox-store';
import { runStandaloneChatgptPrompt } from '../../control-plane/launcher/chatgpt-work-continuation';

import { classifyScheduledBrowserObservation, executeScheduledBrowserProbe } from './browser-probe';
import { executeScheduledGithubIssueWatch } from './github-issue-watch';
import type {
  RepositorySchedule,
  ScheduleDecisionType,
  ScheduleOccurrence,
  ScheduleTriggerContext,
} from '../../../../packages/kernel/scheduler/api/index';

const execFileAsync = promisify(execFile);
const LIVE_MAINTENANCE_OPERATION = 'runtime_maintenance_apply';
const EXTERNAL_CONTROLLER_WAKE_OPERATION = 'external_controller_wake';
const BROWSER_PROBE_OPERATION = 'browser_probe';
const GITHUB_ISSUE_WATCH_OPERATION = 'github_issue_watch';
const DEFAULT_EXTERNAL_CONTROLLER_WAKE_TIMEOUT_MS = 60_000;
const MAX_EXTERNAL_CONTROLLER_WAKE_TIMEOUT_MS = 120_000;

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

function workBoundScheduleWorkId(schedule: RepositorySchedule): string | undefined {
  if (schedule.action.operation !== EXTERNAL_CONTROLLER_WAKE_OPERATION
    && schedule.action.operation !== BROWSER_PROBE_OPERATION) return undefined;
  const value = schedule.action.arguments?.work_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const HUMAN_ONLY_HANDOFF_REASONS = new Set([
  'policy_approval_required',
  'missing_authorization',
  'invalid_objective',
  'destructive_action_requires_confirmation',
]);

function handoffRequiresHumanReview(item: ReturnType<typeof listHandoffItems>[number]): boolean {
  if (item.approvalAction) return true;
  if (!item.creationReason) return true;
  return HUMAN_ONLY_HANDOFF_REASONS.has(item.creationReason);
}

async function stopReason(controllerHome: string, schedule: RepositorySchedule): Promise<string | undefined> {
  const projection = readRepositoryProjection(controllerHome, schedule.repoId);
  const workId = workBoundScheduleWorkId(schedule);
  const work = workId ? getWorkContract({ controllerHome, repoId: schedule.repoId }, workId) : undefined;
  if (schedule.stopConditions.includes('human_review_required')) {
    if (workId) {
      const activeHandoff = listHandoffItems({ controllerHome, repoId: schedule.repoId, status: 'active', limit: 100 })
        .find((item) => item.workId === workId && handoffRequiresHumanReview(item));
      if (activeHandoff) return `Work ${workId} has active Handoff ${activeHandoff.id} requiring human review.`;
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

export function externalControllerWakeTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EXTERNAL_CONTROLLER_WAKE_TIMEOUT_MS;
  return Math.max(5_000, Math.min(Math.trunc(value), MAX_EXTERNAL_CONTROLLER_WAKE_TIMEOUT_MS));
}

export async function awaitExternalControllerWake<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CONTROLLER_WAKE_TOTAL_TIMEOUT: external Controller dispatch exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function classifyChatgptWakeFailure(reason: string): ChatgptWakeFailureClass {
  const normalized = reason.toUpperCase();
  if (
    normalized.includes('CHATGPT_AUTOMATION_LOGIN_REQUIRED')
    || normalized.includes('PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED')
    || normalized.includes('PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED')
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
    'PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN',
    'PLUGIN_MACOS_CAPABILITY_BROKER_UNAVAILABLE',
    'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNAVAILABLE',
    'CHATGPT_CONTROLLER_BROWSER_ROOT_UNAVAILABLE',
    'CHATGPT_CONTROLLER_BROWSER_FAILED',
    'CHATGPT_AUTOMATION_COMPOSER_UNAVAILABLE',
    'CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE',
    'CHATGPT_AUTOMATION_REPLACEMENT_SESSION_NOT_CONFIRMED',
    'CONTROLLER_WAKE_TOTAL_TIMEOUT',
    'HTTP 502',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
  ];
  if (retryableMarkers.some((marker) => normalized.includes(marker))) return 'retryable_readiness';
  return 'ordinary_failure';
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
  if (!workId) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', 'EXTERNAL_CONTROLLER_WAKE_WORK_ID_REQUIRED');
  }
  const workStore = { controllerHome, repoId: schedule.repoId };
  const work = getWorkContract(workStore, workId);
  if (!work) {
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ enabled: false, pausedReason: `Work ${workId} no longer exists.`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId }));
    return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', `EXTERNAL_CONTROLLER_WAKE_WORK_NOT_FOUND:${workId}`);
  }
  if (isTerminalWorkContractStatus(work.status)) {
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ enabled: false, pausedReason: `Work ${workId} is terminal (${work.status}).`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId }));
    return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} is terminal (${work.status}); automatic continuation stopped.`);
  }

  const retainedSession = getRetainedControllerSession(workStore, workId);
  if (!retainedSession) {
    return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', `SCHEDULE_CONTINUATION_CONTROLLER_SESSION_REQUIRED:${workId}`);
  }
  const requestedControllerType = typeof args.controller_type === 'string' ? args.controller_type.trim() : '';
  if (requestedControllerType && requestedControllerType !== retainedSession.controllerType) {
    return decideOccurrence(
      controllerHome,
      schedule,
      occurrence,
      'operation_blocked',
      'skipped',
      `SCHEDULE_CONTINUATION_CONTROLLER_TYPE_MISMATCH:${workId}:expected=${retainedSession.controllerType}:requested=${requestedControllerType}`,
    );
  }
  const expectedSessionId = typeof args.controller_session_id === 'string' ? args.controller_session_id.trim() : '';
  if (expectedSessionId && expectedSessionId !== retainedSession.sessionId) {
    return decideOccurrence(
      controllerHome,
      schedule,
      occurrence,
      'operation_blocked',
      'skipped',
      `SCHEDULE_CONTINUATION_SESSION_DRIFT:${workId}:expected=${expectedSessionId}:actual=${retainedSession.sessionId}`,
    );
  }

  const occurrenceNowMs = Date.parse(timestamp);
  const nowMs = Number.isFinite(occurrenceNowMs) ? occurrenceNowMs : Date.now();
  if (workHasActiveExecution(controllerHome, schedule.repoId, workId)) {
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId }));
    return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} has active execution; duplicate Controller wake suppressed.`);
  }
  const existingOwner = getControllerSession(workStore, workId);
  if (existingOwner && controllerSessionBlocksRecovery(workStore, workId, { nowMs })) {
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId }));
    return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} has a recently active Controller ${existingOwner.controllerId}.`);
  }

  const repository = getRepository(schedule.repoId, controllerHome, { includeRemoved: true });
  let bindingId = typeof args.controller_binding_id === 'string' ? args.controller_binding_id.trim() : '';
  let bindingRecord = bindingId ? getControllerSessionBinding(workStore, workId, retainedSession.sessionId) : undefined;
  if (bindingRecord && bindingRecord.binding.bindingId !== bindingId) {
    return decideOccurrence(
      controllerHome,
      schedule,
      occurrence,
      'operation_blocked',
      'skipped',
      `SCHEDULE_CONTINUATION_BINDING_DRIFT:${workId}:expected=${bindingId}:actual=${bindingRecord.binding.bindingId}`,
    );
  }

  // Explicit compatibility migration for schedules written before Kernel V2 B4.
  // Provider metadata is copied once into the adapter-owned binding and the
  // Schedule is rewritten to exact Work/ControllerSession/ControllerBinding ids.
  if (!bindingRecord) {
    const binding = ensureScheduledControllerBinding(
      { controllerHome, repoId: schedule.repoId },
      { workId, session: retainedSession, scheduleName: schedule.name, args },
    );
    bindingId = binding.bindingId;
    bindingRecord = getControllerSessionBinding(workStore, workId, retainedSession.sessionId);
    if (!bindingRecord || bindingRecord.binding.bindingId !== bindingId) {
      throw new Error(`SCHEDULE_CONTINUATION_BINDING_MIGRATION_FAILED:${workId}`);
    }
    const continuationHint = typeof args.continuation_hint === 'string'
      ? args.continuation_hint
      : typeof args.continuation_prompt === 'string'
        ? args.continuation_prompt
        : undefined;
    const relayScopeId = typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined;
    schedule = updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => ({
      action: {
        ...current.action,
        arguments: {
          work_id: workId,
          controller_type: retainedSession.controllerType,
          controller_session_id: retainedSession.sessionId,
          controller_binding_id: bindingId,
          ...(relayScopeId ? { relay_scope_id: relayScopeId } : {}),
          ...(continuationHint?.trim() ? { continuation_hint: continuationHint.trim() } : {}),
        },
      },
    }));
  }

  const controllerType = retainedSession.controllerType;
  const continuationHint = typeof schedule.action.arguments?.continuation_hint === 'string'
    ? schedule.action.arguments.continuation_hint
    : undefined;
  const relayScopeId = typeof schedule.action.arguments?.relay_scope_id === 'string'
    ? schedule.action.arguments.relay_scope_id
    : undefined;
  const wakeDecision = decideOccurrence(
    controllerHome,
    schedule,
    occurrence,
    'execute',
    'running',
    'Deterministic Controller continuation is starting through Kernel Scheduler and ControllerHost.',
    occurrenceDecisionEvidence({
      operation: schedule.action.operation,
      workId,
      controllerType,
      controllerSessionId: retainedSession.sessionId,
      controllerBindingId: bindingRecord.binding.bindingId,
      ...extraEvidence,
    }),
  );

  try {
    const host = controllerHostForScheduledBinding(
      { controllerHome, repoId: schedule.repoId, repoRoot: repository.canonicalRoot },
      bindingRecord.binding,
    );
    const resumed = await resumeScheduledControllerContinuation(
      workStore,
      {
        scheduleId: schedule.scheduleId,
        occurrenceId: occurrence.occurrenceId,
        workId,
        controllerSessionId: retainedSession.sessionId,
        controllerBindingId: bindingRecord.binding.bindingId,
        relayScopeId,
        continuationHint,
      },
      host,
    );
    if (resumed.dispatch.status === 'rejected') {
      throw new Error(resumed.dispatch.reason ?? 'CONTROLLER_HOST_RESUME_REJECTED');

    }
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => ({
      lastTriggeredAt: timestamp,
      lastOccurrenceId: occurrence.occurrenceId,
      consecutiveFailures: 0,
      nextEligibleAt: undefined,
      ...(current.enabled ? { pausedReason: undefined } : {}),
    }));
    const dispatchedOccurrence = saveOccurrence(controllerHome, {
      ...wakeDecision,
      status: 'dispatched',
      reason: resumed.reused
        ? `Controller continuation occurrence ${occurrence.occurrenceId} was already durably dispatched; external replay suppressed and semantic round closure is still pending.`
        : `ControllerHost accepted exact session ${retainedSession.sessionId} for Work ${workId}; dispatch ${resumed.dispatch.hostDispatchId ?? resumed.dispatch.relayScopeId}; semantic round closure is still pending.`,
    });
    appendWorkEvidence(workStore, workId, {
      evidenceId: dispatchedOccurrence.occurrenceId,
      title: 'scheduled Controller continuation dispatched',
      summary: `Schedule ${schedule.scheduleId} occurrence ${dispatchedOccurrence.occurrenceId} resumed the exact Work-bound ControllerSession through ControllerHost.`,
      detailLevel: 'summary',
    });
    return dispatchedOccurrence;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason.startsWith('SCHEDULE_CONTINUATION_ROUND_ALREADY_OPEN:')) {
      updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId }));
      return decideOccurrence(controllerHome, schedule, wakeDecision, 'nothing_to_do', 'skipped', `Work ${workId} already has an open Controller round awaiting claim or disposition.`);
    }
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
      updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({
        lastTriggeredAt: timestamp,
        lastOccurrenceId: occurrence.occurrenceId,
      }));
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
        summary: 'Forge recorded the schedule trigger but could not resume the exact configured ControllerSession through ControllerHost.',
        reason,
        creationReason: 'repeated_infrastructure_failure',
        blockingDecision: reason.startsWith('SCHEDULE_CONTINUATION_OUTCOME_UNKNOWN:')
          ? 'Inspect the durable ControllerHost dispatch outcome before any retry; automatic replay is fenced.'
          : 'Repair the ControllerHost adapter/binding or update the retained ControllerSession.',
        recommendedDecision: 'Inspect the exact Scheduler continuation dispatch, ControllerSession, and adapter binding, then retrigger only when the outcome is known.',
        recommendedPrompt: `Resume Work ${workId} manually, inspect failed wake occurrence ${occurrence.occurrenceId}, and repair the exact ControllerHost continuation path before unattended continuation resumes.`,
        statusSummary: 'Scheduled ControllerHost continuation failed.',
        blockedBy: ['external_controller_wake_failed'],
        attemptedActions: [`schedule:${schedule.scheduleId}`, `work:${workId}`, `controller:${controllerType}`, `session:${retainedSession.sessionId}`, `binding:${bindingRecord.binding.bindingId}`],
      },
    });
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrence.occurrenceId }));
    return failed.occurrence ?? saveOccurrence(controllerHome, { ...wakeDecision, status: 'failed', reason });
  }
}

export async function evaluateSchedule(
  controllerHome: string,
  schedule: RepositorySchedule,
  force = false,
  triggerContext?: ScheduleTriggerContext,
): Promise<ScheduleOccurrence | undefined> {
  // The persisted Schedule record is the authority. Callers may legitimately
  // retain the object returned by create/list/get across multiple trigger
  // attempts, so never let an older in-memory revision become execution state.
  schedule = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
  // Preserve retired schedule records as evidence, but do not create a new
  // occurrence or resume a controller/external action from their old payload.
  if (retiredScheduleReason(schedule)) return undefined;
  const eligibilityNowMs = Date.now();
  const triggerJobIds = new Set<string>(schedule.trigger.dependencyJobIds ?? []);
  if (schedule.trigger.condition?.jobId) triggerJobIds.add(schedule.trigger.condition.jobId);
  const jobStatuses = Object.fromEntries([...triggerJobIds].map((jobId) => [jobId, findExecutionJob(controllerHome, jobId)?.status]));
  const repositoryClean = schedule.trigger.condition?.kind === 'repository_clean'
    ? !(await workspaceDirty(controllerHome, schedule.repoId))
    : undefined;
  const due = evaluateScheduleTriggerEligibility(schedule, {
    nowMs: eligibilityNowMs,
    force,
    context: triggerContext,
    repositoryClean,
    jobStatuses,
  });
  if (!due.due || !due.windowKey) return undefined;

  const key = due.windowKey;
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
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
    return externalControllerHandoff;
  }

  const recent = listOccurrences(controllerHome, schedule.repoId, schedule.scheduleId, 1000);
  const active = listActiveOccurrences(controllerHome, schedule.repoId, schedule.scheduleId)
    .filter((entry) => entry.occurrenceId !== occurrence.occurrenceId);
  const admission = evaluateScheduleOccurrenceAdmission(schedule, {
    nowMs: Date.now(),
    force,
    stopReason: await stopReason(controllerHome, schedule),
    activeOccurrenceCount: active.length,
    dailyRuntimeMinutes: dailyRuntimeMinutes(controllerHome, recent),
  });
  if (admission.kind === 'stop_condition') {
    const stop = admission.reason ?? 'Schedule stop condition is active.';
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
  if (admission.kind === 'active_occurrence') {
    return decideOccurrence(controllerHome, schedule, occurrence, 'active_occurrence', 'skipped', admission.reason);
  }
  if (admission.kind === 'failure_limit') {
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => ({
      enabled: false,
      pausedReason: current.enabled ? 'Maximum consecutive failures reached.' : current.pausedReason,
    }));
    return decideOccurrence(controllerHome, schedule, occurrence, 'stopped', 'skipped', admission.reason);
  }
  if (admission.kind === 'cooldown') {
    return decideOccurrence(controllerHome, schedule, occurrence, 'cooldown', 'skipped', admission.reason);
  }
  if (admission.kind === 'budget_exhausted') {
    return decideOccurrence(controllerHome, schedule, occurrence, 'budget_exhausted', 'skipped', admission.reason);
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
      updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
      return decideOccurrence(controllerHome, schedule, occurrence, 'would_execute', 'shadowed', 'Shadow mode records the live maintenance decision without applying it.', occurrenceDecisionEvidence({
        actionId: preview.actionId,
        safeCandidates: preview.selectedCandidateIds.length,
        typedSafeCandidates: preview.selectedTypedCandidateIds.length,
      }));
    }
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
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
      const evidence = occurrenceDecisionEvidence({
        githubRepository: typeof args.github_repository === 'string' ? args.github_repository : undefined,
        observationStatus: observation.status,
        observedIssueCount: observation.issues.length,
        changedIssueNumbers: observation.changedOpenIssues.map((issue) => issue.number),
      });
      const persistObservation = () => updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => {
        if (current.action.operation !== GITHUB_ISSUE_WATCH_OPERATION) throw new Error('SCHEDULE_ACTION_CHANGED_DURING_GITHUB_OBSERVATION');
        return {
          action: {
            ...current.action,
            arguments: { ...(current.action.arguments ?? {}), issue_watch_state: observation.nextState, issue_watch_since: undefined },
          },
          lastTriggeredAt: timestamp,
          lastOccurrenceId: occurrenceId,
          lastObservationAt: timestamp,
          lastObservationStatus: observation.status,
          lastObservationChangedAt: observation.shouldWake ? timestamp : current.lastObservationChangedAt,
          consecutiveFailures: 0,
          consecutiveNoops: observation.shouldWake ? 0 : (current.consecutiveNoops ?? 0) + 1,
          nextEligibleAt: undefined,
          ...(current.enabled ? { pausedReason: undefined } : {}),
        };
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
        updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ enabled: false, pausedReason: `Work ${workId} no longer exists.`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
        return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', `SCHEDULE_BROWSER_PROBE_WORK_NOT_FOUND:${workId}`);
      }
      if (isTerminalWorkContractStatus(work.status)) {
        updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ enabled: false, pausedReason: `Work ${workId} is terminal (${work.status}).`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
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
        const observedSchedule = updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => ({
          lastTriggeredAt: timestamp,
          lastOccurrenceId: occurrenceId,
          lastObservationAt: timestamp,
          lastObservationStatus: 'auth_required',
          consecutiveFailures: 0,
          nextEligibleAt: undefined,
          ...(current.enabled ? { pausedReason: undefined } : {}),
        }));
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
        const observedSchedule = updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => ({
          lastTriggeredAt: timestamp,
          lastOccurrenceId: occurrenceId,
          lastObservationAt: timestamp,
          lastObservationStatus: 'keepalive',
          consecutiveFailures: 0,
          consecutiveNoops: 0,
          nextEligibleAt: undefined,
          ...(current.enabled ? { pausedReason: undefined } : {}),
        }));
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
      const observedSchedule = updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => ({
        lastTriggeredAt: timestamp,
        lastOccurrenceId: occurrenceId,
        lastObservationAt: timestamp,
        lastObservationFingerprint: probe.fingerprint,
        lastObservationChangedAt: changed ? timestamp : current.lastObservationChangedAt,
        lastObservationStatus: observationStatus,
        consecutiveFailures: 0,
        consecutiveNoops: shouldWake ? 0 : (current.consecutiveNoops ?? 0) + 1,
        nextEligibleAt: undefined,
        ...(current.enabled ? { pausedReason: undefined } : {}),
      }));

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
      updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
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
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, (current) => ({
      lastTriggeredAt: timestamp,
      lastOccurrenceId: occurrenceId,
      consecutiveFailures: 0,
      nextEligibleAt: undefined,
      ...(current.enabled ? { pausedReason: undefined } : {}),
    }));
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
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({
      lastTriggeredAt: timestamp,
      lastOccurrenceId: occurrenceId,
    }));
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
