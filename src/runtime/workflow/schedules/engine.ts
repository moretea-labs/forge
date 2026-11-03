import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRepository } from '../../../cli/repositories/registry';
import { findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../execution/jobs/store';
import { executionJobBelongsToWork } from '../../execution/work-activity';
import { readRepositoryProjection } from '../../projections/materialized-view';
import {
  applyRuntimeMaintenance,
  previewAutomaticRuntimeMaintenance,
  type RuntimeMaintenanceActionId,
} from '../../recovery/maintenance-executor';
import { getWorkContract, semanticWorkState } from '../../../../packages/kernel/work/api/index';
import {
  applyScheduleFailure,
  cronDue,
  evaluateScheduleOccurrenceAdmission,
  evaluateScheduleTriggerEligibility,
  getOccurrence,
  getSchedule,
  listActiveOccurrences,
  listOccurrences,
  reclaimStaleCreatedOccurrences,
  listSchedules,
  saveOccurrence,
  saveScheduleDecision,
  updateSchedule,
} from '../../../../packages/kernel/scheduler/api/index';
export { cronDue };
import { listUserRequests } from '../../../../packages/kernel/identity/api/index';

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
const CONTROLLER_PROGRESSION_OPERATION = 'controller_progression';
const BROWSER_PROBE_OPERATION = 'browser_probe';
const GITHUB_ISSUE_WATCH_OPERATION = 'github_issue_watch';

function isDeterministicSchedule(schedule: RepositorySchedule): boolean {
  // Kernel executes only typed, bounded dispatch operations.
  return schedule.action.operation === LIVE_MAINTENANCE_OPERATION
    || schedule.action.operation === EXTERNAL_CONTROLLER_WAKE_OPERATION
    || schedule.action.operation === CONTROLLER_PROGRESSION_OPERATION
    || schedule.action.operation === BROWSER_PROBE_OPERATION
    || schedule.action.operation === GITHUB_ISSUE_WATCH_OPERATION;
}

function retiredScheduleReason(schedule: RepositorySchedule): string | undefined {
  if (schedule.action.operation === EXTERNAL_CONTROLLER_WAKE_OPERATION
    || schedule.action.operation === CONTROLLER_PROGRESSION_OPERATION) {
    return 'RETIRED_AUTONOMOUS_CONTINUATION_SCHEDULE';
  }
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
    && schedule.action.operation !== CONTROLLER_PROGRESSION_OPERATION
    && schedule.action.operation !== BROWSER_PROBE_OPERATION) return undefined;
  const value = schedule.action.arguments?.work_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function stopReason(controllerHome: string, schedule: RepositorySchedule): Promise<string | undefined> {
  const projection = readRepositoryProjection(controllerHome, schedule.repoId);
  const workId = workBoundScheduleWorkId(schedule);
  const work = workId ? getWorkContract({ controllerHome, repoId: schedule.repoId }, workId) : undefined;
  if (schedule.stopConditions.includes('human_review_required')) {
    const pendingUserRequests = listUserRequests(controllerHome, 'pending');
    if (workId) {
      const request = pendingUserRequests.find((item) => item.targetScope?.workId === workId);
      if (request) return `Work ${workId} has pending UserRequest ${request.requestId} requiring human action.`;
    } else {
      const request = pendingUserRequests.find((item) => item.targetScope?.repoId === schedule.repoId);
      if (request) return `Repository ${schedule.repoId} has pending UserRequest ${request.requestId}.`;
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
  // Preserve retired schedule records, but never create an occurrence or
  // replay an autonomous model Turn. Disable once in the existing Schedule
  // store so operator resume cannot silently revive the retired action.
  const retirementReason = retiredScheduleReason(schedule);
  if (retirementReason) {
    if (schedule.enabled || schedule.pausedReason !== retirementReason) {
      updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({
        enabled: false,
        pausedReason: retirementReason,
      }));
    }
    return undefined;
  }
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

  // Semantic/model-owned schedule actions record the trigger only. A trigger is
  // continuation input for the external Controller/Supervisor, not a human
  // blocker and therefore must not manufacture Handoff/UserRequest state.
  if (!isDeterministicSchedule(schedule)) {
    const recorded = decideOccurrence(
      controllerHome,
      schedule,
      occurrence,
      'operation_blocked',
      'skipped',
      'Schedule trigger recorded for external Controller continuation; no Kernel ExecutionJob or human Handoff was created.',
      occurrenceDecisionEvidence({ operation: schedule.action.operation, trigger: occurrence.triggerContext?.source }),
    );
    updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
    return recorded;
  }

  const recent = listOccurrences(controllerHome, schedule.repoId, schedule.scheduleId, 1000);
  reclaimStaleCreatedOccurrences(controllerHome, schedule.repoId, schedule.scheduleId);
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
          ...(preview.blockedPermanently ? {
            handoff: {
              title: `Scheduled maintenance occurrence ${occurrence.occurrenceId} needs a user decision`,
              summary: 'Automatic maintenance is permanently blocked and requires an explicit user decision before the schedule can resume.',
              reason: preview.blockedReason ?? 'Automatic maintenance preview blocked the occurrence.',
              creationReason: 'ambiguous_outcome' as const,
              blockingDecision: 'Correct the configuration/authorization or intentionally keep this schedule paused.',
              recommendedDecision: 'Review the permanent blocker and explicitly decide whether to repair configuration and resume.',
              recommendedPrompt: `Review permanently blocked maintenance occurrence ${occurrence.occurrenceId} for schedule ${schedule.scheduleId} and decide whether to repair and resume it.`,
              statusSummary: 'Scheduled maintenance is permanently blocked pending a user decision.',
              blockedBy: [decision],
              attemptedActions: [`schedule:${schedule.scheduleId}`, `operation:${schedule.action.operation}`],
            },
          } : {}),
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
        ...(preview.blockedPermanently ? {
          handoff: {
            title: `Scheduled maintenance occurrence ${occurrence.occurrenceId} needs a user decision`,
            summary: 'Automatic maintenance is permanently blocked and requires an explicit user decision before the schedule can resume.',
            reason: preview.blockedReason ?? 'Automatic maintenance preview blocked the occurrence.',
            creationReason: 'ambiguous_outcome' as const,
            blockingDecision: 'Correct the configuration/authorization or intentionally keep this schedule paused.',
            recommendedDecision: 'Review the permanent blocker and explicitly decide whether to repair configuration and resume.',
            recommendedPrompt: `Review permanently blocked maintenance occurrence ${occurrence.occurrenceId} for schedule ${schedule.scheduleId} and decide whether to repair and resume it.`,
            statusSummary: 'Scheduled maintenance is permanently blocked pending a user decision.',
            blockedBy: [decision],
            attemptedActions: [`schedule:${schedule.scheduleId}`, `operation:${schedule.action.operation}`],
          },
        } : {}),
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
      const observedSchedule = persistObservation();
      return decideOccurrence(controllerHome, observedSchedule, occurrence, 'execute', 'succeeded',
        'GitHub issue change recorded; Schedule never dispatches a model continuation.', evidence);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
        outcome: 'failed',
        decision: 'execute',
        reason,

      });
      return failed.occurrence ?? occurrence;
    }
  }

  if (schedule.action.operation === BROWSER_PROBE_OPERATION) {
    const workId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
    if (workId) {
      const workStore = { controllerHome, repoId: schedule.repoId };
      const work = getWorkContract(workStore, workId);
      if (!work) {
        updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ enabled: false, pausedReason: `Work ${workId} no longer exists.`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
        return decideOccurrence(controllerHome, schedule, occurrence, 'operation_blocked', 'skipped', `SCHEDULE_BROWSER_PROBE_WORK_NOT_FOUND:${workId}`);
      }
      if (semanticWorkState(work) !== 'open') {
        updateSchedule(controllerHome, schedule.repoId, schedule.scheduleId, () => ({ enabled: false, pausedReason: `Work ${workId} is terminal (${work.semanticState}).`, lastTriggeredAt: timestamp, lastOccurrenceId: occurrenceId }));
        return decideOccurrence(controllerHome, schedule, occurrence, 'nothing_to_do', 'skipped', `Work ${workId} is terminal (${work.semanticState}); browser watcher stopped before probing.`);
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
        return decideOccurrence(controllerHome, observedSchedule, occurrence, 'operation_blocked', 'skipped',
          'Browser ' + (workId ? 'watcher' : 'keepalive') + ' requires authentication: ' + (probe.authReason ?? 'login marker matched'),
          { ...observationEvidence, authReason: probe.authReason });
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

      return decideOccurrence(controllerHome, observedSchedule, occurrence, 'execute', 'succeeded',
        'Browser observation changed; Schedule recorded the result without sending a model message.',
        { ...observationEvidence, observationStatus });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = applyScheduleFailure(controllerHome, schedule.scheduleId, schedule.repoId, occurrence.occurrenceId, {
        outcome: 'failed',
        decision: 'execute',
        reason,

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
