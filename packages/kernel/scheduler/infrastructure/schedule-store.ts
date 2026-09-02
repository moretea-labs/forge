import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../../src/cli/repositories/controller-home';
import { withControllerLock } from '../../../../src/cli/repositories/locks';
import {
  createHandoffItem,
  getHandoffItem,
  listHandoffItems,
  resolveHandoffItem,
} from '../../../../src/runtime/control-plane/facade/handoff-inbox-store';
import { readJsonFile, writeJsonAtomic } from '../../../../src/runtime/shared/json-files';
import { appendRuntimeEvent } from '../../../../src/runtime/evidence/event-ledger';
import type { RepositorySchedule, ScheduleDecision, ScheduleOccurrence } from '../domain/schedule';

interface OccurrenceIndex {
  schemaVersion: 1;
  updatedAt: string;
  active: Array<{ occurrenceId: string; scheduleId: string; status: ScheduleOccurrence['status']; updatedAt: string }>;
  recent: Array<{ occurrenceId: string; scheduleId: string; status: ScheduleOccurrence['status']; createdAt: string; updatedAt: string }>;
}
interface ScheduleRequestRecord {
  schemaVersion: 1;
  requestId: string;
  semanticKey: string;
  scheduleId: string;
  repoId: string;
  createdAt: string;
}
type CreateScheduleInput = Omit<RepositorySchedule, 'schemaVersion' | 'revision' | 'scheduleId' | 'createdAt' | 'updatedAt' | 'consecutiveFailures'>;
type ScheduleMutableUpdate = Partial<Omit<RepositorySchedule, 'schemaVersion' | 'revision' | 'scheduleId' | 'repoId' | 'requestId' | 'createdAt' | 'updatedAt'>>;

export interface ScheduleOccurrenceHandoffInput {
  title: string;
  summary: string;
  reason: string;
  creationReason: 'ambiguous_outcome' | 'missing_authorization' | 'repeated_infrastructure_failure';
  blockingDecision: string;
  recommendedDecision: string;
  recommendedPrompt: string;
  statusSummary: string;
  blockedBy?: string[];
  attemptedActions?: string[];
  evidenceRefs?: Array<{ title: string; summary?: string; detailLevel?: 'summary' | 'detail' | 'raw' }>;
}

function schedulesRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'schedules');
}
function schedulePath(controllerHome: string, repoId: string, scheduleId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'records', `${scheduleId}.json`);
}
function occurrencePath(controllerHome: string, repoId: string, occurrenceId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'occurrences', `${occurrenceId}.json`);
}

function decisionPath(controllerHome: string, repoId: string, decisionId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'decisions', `${decisionId}.json`);
}
function occurrenceIndexPath(controllerHome: string, repoId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'indexes', 'occurrences.json');
}
function requestPath(controllerHome: string, repoId: string, requestId: string): string {
  return join(schedulesRoot(controllerHome, repoId), 'indexes', 'requests', `${createHash('sha256').update(requestId).digest('hex')}.json`);
}

const EXTERNAL_CONTROLLER_WAKE_MAX_FAILURES = 3;
const EXTERNAL_CONTROLLER_WAKE_DAILY_BUDGET_MINUTES = 60;
const EXTERNAL_CONTROLLER_WAKE_MIN_COOLDOWN_MINUTES = 10;

function boundedSchedulePolicy(schedule: RepositorySchedule): RepositorySchedule['policy'] {
  const policy = {
    ...schedule.policy,
    backoffBaseMinutes: Math.max(1, schedule.policy.backoffBaseMinutes ?? schedule.policy.cooldownMinutes ?? 1),
    backoffMaxMinutes: Math.max(1, schedule.policy.backoffMaxMinutes ?? 24 * 60),
  };
  if (schedule.action.operation !== 'external_controller_wake') return policy;
  // A Work-bound controller wake is expensive and can affect the user's
  // provider. No schedule payload may convert a transient tool outage into an
  // all-day retry loop. Larger work needs an explicit future user action after
  // the bounded lane records useful failure evidence.
  return {
    ...policy,
    maxFailures: Math.max(1, Math.min(policy.maxFailures, EXTERNAL_CONTROLLER_WAKE_MAX_FAILURES)),
    dailyBudgetMinutes: Math.max(1, Math.min(policy.dailyBudgetMinutes, EXTERNAL_CONTROLLER_WAKE_DAILY_BUDGET_MINUTES)),
    cooldownMinutes: Math.max(policy.cooldownMinutes, EXTERNAL_CONTROLLER_WAKE_MIN_COOLDOWN_MINUTES),
    backoffBaseMinutes: Math.max(policy.backoffBaseMinutes, EXTERNAL_CONTROLLER_WAKE_MIN_COOLDOWN_MINUTES),
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function scheduleSemanticKey(input: CreateScheduleInput): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    repoId: input.repoId,
    name: input.name,
    trigger: input.trigger,
    policy: input.policy,
    action: input.action,
    stopConditions: input.stopConditions,
  }))).digest('hex');
}
function emptyIndex(): OccurrenceIndex {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), active: [], recent: [] };
}
function readOccurrenceIndex(controllerHome: string, repoId: string): OccurrenceIndex {
  return readJsonFile<OccurrenceIndex>(occurrenceIndexPath(controllerHome, repoId), emptyIndex());
}
function upsertOccurrenceIndexUnlocked(controllerHome: string, occurrence: ScheduleOccurrence): void {
  const index = readOccurrenceIndex(controllerHome, occurrence.repoId);
  index.active = index.active.filter((entry) => entry.occurrenceId !== occurrence.occurrenceId);
  index.recent = index.recent.filter((entry) => entry.occurrenceId !== occurrence.occurrenceId);
  if (['created', 'queued', 'running'].includes(occurrence.status)) {
    index.active.push({ occurrenceId: occurrence.occurrenceId, scheduleId: occurrence.scheduleId, status: occurrence.status, updatedAt: occurrence.updatedAt });
  }
  index.recent.push({ occurrenceId: occurrence.occurrenceId, scheduleId: occurrence.scheduleId, status: occurrence.status, createdAt: occurrence.createdAt, updatedAt: occurrence.updatedAt });
  index.updatedAt = new Date().toISOString();
  index.active.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  index.recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  index.active = index.active.slice(-5000);
  index.recent = index.recent.slice(0, 5000);
  writeJsonAtomic(occurrenceIndexPath(controllerHome, occurrence.repoId), index);
}

export function createSchedule(controllerHome: string, input: CreateScheduleInput): RepositorySchedule {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error('SCHEDULE_REQUEST_ID_REQUIRED');
  const semanticKey = scheduleSemanticKey(input);
  return withControllerLock(controllerHome, { scope: 'task', repoId: input.repoId, taskId: `schedule-request-${createHash('sha256').update(requestId).digest('hex').slice(0, 16)}` }, `create-schedule:${requestId}`, () => {
    const requestRecordPath = requestPath(controllerHome, input.repoId, requestId);
    if (existsSync(requestRecordPath)) {
      const record = readJsonFile<ScheduleRequestRecord>(requestRecordPath);
      if (record.semanticKey !== semanticKey) throw new Error(`SCHEDULE_REQUEST_ID_CONFLICT: ${requestId}`);
      return getSchedule(controllerHome, input.repoId, record.scheduleId);
    }
    const timestamp = new Date().toISOString();
    const schedule: RepositorySchedule = {
      ...input,
      requestId,
      schemaVersion: 1,
      revision: 1,
      scheduleId: `SCH-${Date.now()}-${randomUUID().slice(0, 8)}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      consecutiveFailures: 0,
    };
    writeJsonAtomic(schedulePath(controllerHome, schedule.repoId, schedule.scheduleId), schedule);
    writeJsonAtomic(requestRecordPath, { schemaVersion: 1, requestId, semanticKey, scheduleId: schedule.scheduleId, repoId: schedule.repoId, createdAt: timestamp } satisfies ScheduleRequestRecord);
    appendRuntimeEvent(controllerHome, { repoId: schedule.repoId, entityType: 'schedule', entityId: schedule.scheduleId, eventType: 'schedule_created', requestId, revision: schedule.revision, data: { name: schedule.name, shadowMode: schedule.policy.shadowMode } });
    return schedule;
  }, 10_000);
}

export function getSchedule(controllerHome: string, repoId: string, scheduleId: string): RepositorySchedule {
  const schedule = readJsonFile<RepositorySchedule>(schedulePath(controllerHome, repoId, scheduleId));
  // Hydrate schedules written before requestId/revision became mandatory.
  return {
    ...schedule,
    revision: Number.isFinite(schedule.revision) ? schedule.revision : 1,
    requestId: schedule.requestId || `legacy-schedule:${schedule.scheduleId}`,
    policy: boundedSchedulePolicy(schedule),
    consecutiveNoops: Math.max(0, schedule.consecutiveNoops ?? 0),
  };
}

function persistScheduleRevision(
  controllerHome: string,
  current: RepositorySchedule,
  candidate: RepositorySchedule,
): RepositorySchedule {
  const next: RepositorySchedule = {
    ...candidate,
    schemaVersion: current.schemaVersion,
    revision: current.revision + 1,
    scheduleId: current.scheduleId,
    repoId: current.repoId,
    requestId: current.requestId,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(schedulePath(controllerHome, next.repoId, next.scheduleId), next);
  appendRuntimeEvent(controllerHome, { repoId: next.repoId, entityType: 'schedule', entityId: next.scheduleId, eventType: 'schedule_updated', requestId: next.requestId, revision: next.revision, data: { enabled: next.enabled, pausedReason: next.pausedReason } });
  return next;
}

/**
 * Persist a caller-owned Schedule snapshot only when its revision is still the
 * current authority. User/configuration mutations use this path so stale
 * writers fail closed instead of overwriting a newer decision.
 */
export function saveSchedule(controllerHome: string, schedule: RepositorySchedule): RepositorySchedule {
  return withControllerLock(controllerHome, { scope: 'task', repoId: schedule.repoId, taskId: `schedule-${schedule.scheduleId}` }, `save-schedule:${schedule.scheduleId}`, () => {
    const current = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
    if (schedule.revision !== current.revision) {
      throw new Error(`SCHEDULE_REVISION_CONFLICT: ${schedule.scheduleId}:expected=${schedule.revision}:actual=${current.revision}`);
    }
    return persistScheduleRevision(controllerHome, current, schedule);
  }, 10_000);
}

/**
 * Apply runtime-owned settlement/observation fields to the latest Schedule
 * authority while holding the Schedule lock. Identity and revision fields are
 * never writable through this path. Long-running occurrences use this instead
 * of replaying a stale whole-record snapshot after user state may have changed.
 */
export function updateSchedule(
  controllerHome: string,
  repoId: string,
  scheduleId: string,
  update: (current: RepositorySchedule) => ScheduleMutableUpdate,
): RepositorySchedule {
  return withControllerLock(controllerHome, { scope: 'task', repoId, taskId: `schedule-${scheduleId}` }, `update-schedule:${scheduleId}`, () => {
    const current = getSchedule(controllerHome, repoId, scheduleId);
    const changes = update(current);
    return persistScheduleRevision(controllerHome, current, { ...current, ...changes });
  }, 10_000);
}

export function listSchedules(controllerHome: string, repoId: string): RepositorySchedule[] {
  const root = join(schedulesRoot(controllerHome, repoId), 'records');
  try {
    return readdirSync(root).filter((name) => name.endsWith('.json'))
      .map((name) => getSchedule(controllerHome, repoId, name.slice(0, -'.json'.length)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch { return []; }
}

export function deleteSchedule(controllerHome: string, repoId: string, scheduleId: string): RepositorySchedule {
  return withControllerLock(controllerHome, { scope: 'task', repoId, taskId: `schedule-${scheduleId}` }, `delete-schedule:${scheduleId}`, () => {
    const current = getSchedule(controllerHome, repoId, scheduleId);
    if (current.enabled) throw new Error(`SCHEDULE_DELETE_REQUIRES_PAUSED: ${scheduleId}`);
    if (listActiveOccurrences(controllerHome, repoId, scheduleId).length > 0) {
      throw new Error(`SCHEDULE_DELETE_ACTIVE_OCCURRENCE: ${scheduleId}`);
    }
    rmSync(schedulePath(controllerHome, repoId, scheduleId), { force: true });
    const requestRecordPath = requestPath(controllerHome, repoId, current.requestId);
    if (existsSync(requestRecordPath)) {
      const record = readJsonFile<ScheduleRequestRecord>(requestRecordPath);
      if (record.scheduleId === scheduleId) rmSync(requestRecordPath, { force: true });
    }
    appendRuntimeEvent(controllerHome, {
      repoId,
      entityType: 'schedule',
      entityId: scheduleId,
      eventType: 'schedule_deleted',
      requestId: current.requestId,
      revision: current.revision + 1,
      data: { name: current.name },
    });
    return current;
  }, 10_000);
}

function scheduleFailureClass(reason: string): string {
  const trimmed = reason.trim();
  const explicitCode = trimmed.match(/^([A-Z][A-Z0-9_]{2,})(?::|\b)/)?.[1];
  if (explicitCode) return explicitCode;
  const prefix = (trimmed.split(':', 1)[0] ?? trimmed)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 120);
  return prefix || 'unknown_failure';
}

function activeScheduleFailureHandoff(
  controllerHome: string,
  repoId: string,
  scheduleId: string,
  creationReason: ScheduleOccurrenceHandoffInput['creationReason'],
  reason: string,
) {
  const failureClass = scheduleFailureClass(reason);
  return listHandoffItems({ controllerHome, repoId, status: 'active', limit: 100 }).find((item) => (
    item.currentState?.taskId === scheduleId
    && item.creationReason === creationReason
    && scheduleFailureClass(item.reason) === failureClass
  ));
}

function stableScheduleFailureHandoffId(
  controllerHome: string,
  repoId: string,
  scheduleId: string,
  creationReason: ScheduleOccurrenceHandoffInput['creationReason'],
  reason: string,
  occurrenceId: string,
): string {
  const digest = createHash('sha256')
    .update(`${scheduleId}:${creationReason}:${scheduleFailureClass(reason)}`)
    .digest('hex')
    .slice(0, 20);
  const baseId = `schedule-failure-${digest}`;
  if (!getHandoffItem({ controllerHome, repoId }, baseId)) return baseId;
  // A previous failure streak may already have resolved the stable item. Handoff
  // records are immutable apart from lifecycle status, so use one new epoch id;
  // subsequent failures in this streak will discover and reuse the active item.
  const epoch = createHash('sha256').update(occurrenceId).digest('hex').slice(0, 8);
  return `${baseId}-${epoch}`;
}

function resolveRecoveredScheduleFailureHandoffs(controllerHome: string, occurrence: ScheduleOccurrence): void {
  try {
    const active = listHandoffItems({ controllerHome, repoId: occurrence.repoId, status: 'active', limit: 100 })
      .filter((item) => (
        item.currentState?.taskId === occurrence.scheduleId
        && item.creationReason === 'repeated_infrastructure_failure'
      ));
    for (const item of active) {
      try {
        resolveHandoffItem(
          { controllerHome, repoId: occurrence.repoId },
          item.id,
          {
            decision: `Schedule ${occurrence.scheduleId} recovered on occurrence ${occurrence.occurrenceId}.`,
            resolver: 'schedule-runtime',
          },
        );
      } catch {
        // The succeeded occurrence remains authoritative. Inbox cleanup is
        // best-effort and must never turn schedule recovery into a failure.
      }
    }
  } catch {
    // Preserve successful Schedule settlement even if Inbox storage is unavailable.
  }
}

export function saveOccurrence(controllerHome: string, occurrence: ScheduleOccurrence): ScheduleOccurrence {
  const next = withControllerLock(controllerHome, { scope: 'task', repoId: occurrence.repoId, taskId: `schedule-${occurrence.scheduleId}` }, `save-occurrence:${occurrence.occurrenceId}`, () => {
    const existingPath = occurrencePath(controllerHome, occurrence.repoId, occurrence.occurrenceId);
    const previous = existsSync(existingPath) ? readJsonFile<ScheduleOccurrence>(existingPath) : undefined;
    const expectedRevision = previous?.revision ?? 0;
    if (occurrence.revision !== expectedRevision) {
      throw new Error(`SCHEDULE_OCCURRENCE_REVISION_CONFLICT: ${occurrence.occurrenceId}:expected=${occurrence.revision}:actual=${expectedRevision}`);
    }
    const saved = { ...occurrence, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
    writeJsonAtomic(existingPath, saved);
    upsertOccurrenceIndexUnlocked(controllerHome, saved);
    const schedule = getSchedule(controllerHome, saved.repoId, saved.scheduleId);
    appendRuntimeEvent(controllerHome, { repoId: saved.repoId, entityType: 'occurrence', entityId: saved.occurrenceId, eventType: `occurrence_${saved.status}`, requestId: `${schedule.requestId}:${saved.windowKey}`, revision: saved.revision, correlationId: saved.scheduleId, data: { decision: saved.decision, jobId: saved.jobId, reason: saved.reason } });
    return saved;
  }, 10_000);
  if (next.status === 'succeeded' || next.status === 'dispatched') resolveRecoveredScheduleFailureHandoffs(controllerHome, next);
  return next;
}

export function getOccurrence(controllerHome: string, repoId: string, occurrenceId: string): ScheduleOccurrence | undefined {
  const path = occurrencePath(controllerHome, repoId, occurrenceId);
  return existsSync(path) ? readJsonFile<ScheduleOccurrence>(path) : undefined;
}

export function recordScheduleOccurrenceHandoff(
  controllerHome: string,
  schedule: RepositorySchedule,
  occurrence: ScheduleOccurrence,
  input: ScheduleOccurrenceHandoffInput,
): ScheduleOccurrence {
  if (occurrence.handoffId) return occurrence;
  const reusable = input.creationReason === 'repeated_infrastructure_failure'
    ? activeScheduleFailureHandoff(controllerHome, occurrence.repoId, schedule.scheduleId, input.creationReason, input.reason)
    : undefined;
  if (reusable) return saveOccurrence(controllerHome, { ...occurrence, handoffId: reusable.id });
  const handoffId = input.creationReason === 'repeated_infrastructure_failure'
    ? stableScheduleFailureHandoffId(
      controllerHome,
      occurrence.repoId,
      schedule.scheduleId,
      input.creationReason,
      input.reason,
      occurrence.occurrenceId,
    )
    : `schedule-${occurrence.occurrenceId}`;
  const evidenceRefs: NonNullable<ScheduleOccurrenceHandoffInput['evidenceRefs']> = [
    { title: `Occurrence ${occurrence.occurrenceId}`, summary: occurrence.reason ?? input.reason, detailLevel: 'summary' as const },
  ];
  for (const ref of input.evidenceRefs ?? []) {
    evidenceRefs.push(ref);
    if (evidenceRefs.length >= 20) break;
  }
  const existing = getHandoffItem({ controllerHome, repoId: occurrence.repoId }, handoffId);
  const item = existing ?? createHandoffItem(
    { controllerHome, repoId: occurrence.repoId },
    {
      id: handoffId,
      repoId: occurrence.repoId,
      title: input.title,
      severity: 'blocked',
      reason: input.reason,
      creationReason: input.creationReason,
      summary: input.summary,
      currentState: {
        repoId: occurrence.repoId,
        taskId: schedule.scheduleId,
        statusSummary: input.statusSummary,
        blockedBy: input.blockedBy,
      },
      attemptedActions: [
        `schedule:${schedule.scheduleId}`,
        `occurrence:${occurrence.occurrenceId}`,
        ...(input.attemptedActions ?? []),
      ].slice(0, 20),
      evidenceRefs,
      blockingDecision: input.blockingDecision,
      recommendedDecision: input.recommendedDecision,
      recommendedPrompt: input.recommendedPrompt,
      suggestedNextActions: [{
        label: 'Review handoff',
        tool: 'rh_inbox',
        operation: 'get',
        payload: { handoff_id: handoffId },
        risk: 'readonly',
        confidence: 'high',
        reason: 'Review the bounded occurrence handoff before resuming automatic maintenance.',
      }],
    },
  );
  return saveOccurrence(controllerHome, { ...occurrence, handoffId: item.id });
}

export function listActiveOccurrences(controllerHome: string, repoId: string, scheduleId?: string): ScheduleOccurrence[] {
  const index = readOccurrenceIndex(controllerHome, repoId);
  return index.active
    .filter((entry) => !scheduleId || entry.scheduleId === scheduleId)
    .flatMap((entry) => {
      const occurrence = getOccurrence(controllerHome, repoId, entry.occurrenceId);
      return occurrence ? [occurrence] : [];
    });
}

export function listOccurrences(controllerHome: string, repoId: string, scheduleId?: string, limit = 100): ScheduleOccurrence[] {
  const bounded = Math.max(1, Math.min(limit, 1000));
  const index = readOccurrenceIndex(controllerHome, repoId);
  const indexed = index.recent
    .filter((entry) => !scheduleId || entry.scheduleId === scheduleId)
    .slice(0, bounded)
    .flatMap((entry) => {
      const occurrence = getOccurrence(controllerHome, repoId, entry.occurrenceId);
      return occurrence ? [occurrence] : [];
    });
  if (indexed.length > 0) return indexed;

  const root = join(schedulesRoot(controllerHome, repoId), 'occurrences');
  try {
    const legacy = readdirSync(root).filter((name) => name.endsWith('.json'))
      .map((name) => readJsonFile<ScheduleOccurrence>(join(root, name)))
      .filter((entry) => !scheduleId || entry.scheduleId === scheduleId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded);
    if (legacy.length > 0) {
      withControllerLock(controllerHome, { scope: 'repository', repoId }, `schedule-index-backfill:${repoId}`, () => {
        for (const occurrence of legacy) upsertOccurrenceIndexUnlocked(controllerHome, occurrence);
      }, 10_000);
    }
    return legacy;
  } catch { return []; }
}


export function saveScheduleDecision(controllerHome: string, decision: ScheduleDecision): ScheduleDecision {
  return withControllerLock(controllerHome, { scope: 'task', repoId: decision.repoId, taskId: `schedule-${decision.scheduleId}` }, `save-schedule-decision:${decision.decisionId}`, () => {
    const path = decisionPath(controllerHome, decision.repoId, decision.decisionId);
    if (existsSync(path)) return readJsonFile<ScheduleDecision>(path);
    writeJsonAtomic(path, decision);
    appendRuntimeEvent(controllerHome, {
      repoId: decision.repoId,
      entityType: 'schedule-decision',
      entityId: decision.decisionId,
      eventType: `schedule_decision_${decision.decision}`,
      requestId: decision.requestId,
      revision: decision.revision,
      correlationId: decision.occurrenceId,
      data: { scheduleId: decision.scheduleId, reason: decision.reason, evidence: decision.evidence },
    });
    return decision;
  }, 10_000);
}

export function getScheduleDecision(controllerHome: string, repoId: string, decisionId: string): ScheduleDecision | undefined {
  const path = decisionPath(controllerHome, repoId, decisionId);
  return existsSync(path) ? readJsonFile<ScheduleDecision>(path) : undefined;
}


export interface ScheduleDuplicateMember {
  scheduleId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  keep: boolean;
  reason: string;
}

export interface ScheduleDuplicateGroup {
  semanticKey: string;
  scheduleIds: string[];
  names: string[];
  enabledCount: number;
  keepScheduleId: string;
  members: ScheduleDuplicateMember[];
  recommendation: string;
}

export interface ScheduleDedupeReport {
  repoId: string;
  generatedAt: string;
  totalSchedules: number;
  duplicateGroups: ScheduleDuplicateGroup[];
  proposedDisableCount: number;
}

export interface ScheduleDedupeApplyResult {
  repoId: string;
  appliedAt: string;
  dryRun: boolean;
  report: ScheduleDedupeReport;
  disabled: Array<{ scheduleId: string; previousEnabled: boolean; pausedReason?: string }>;
}

function scheduleDedupeKey(schedule: RepositorySchedule): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    repoId: schedule.repoId,
    name: schedule.name.trim().toLowerCase(),
    trigger: schedule.trigger,
    policy: schedule.policy,
    action: schedule.action,
    stopConditions: schedule.stopConditions,
  }))).digest('hex');
}

function chooseScheduleToKeep(entries: RepositorySchedule[]): RepositorySchedule {
  const enabled = entries.filter((entry) => entry.enabled);
  const pool = enabled.length > 0 ? enabled : entries;
  return [...pool].sort((left, right) => {
    const triggered = String(right.lastTriggeredAt ?? '').localeCompare(String(left.lastTriggeredAt ?? ''));
    if (triggered !== 0) return triggered;
    return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt);
  })[0]!;
}

function duplicateGroup(semanticKey: string, entries: RepositorySchedule[]): ScheduleDuplicateGroup {
  const keep = chooseScheduleToKeep(entries);
  const members = [...entries]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((entry) => ({
      scheduleId: entry.scheduleId,
      name: entry.name,
      enabled: entry.enabled,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      keep: entry.scheduleId === keep.scheduleId,
      reason: entry.scheduleId === keep.scheduleId
        ? 'newest enabled duplicate selected as canonical schedule'
        : entry.enabled ? 'enabled duplicate should be paused to prevent repeated execution' : 'already disabled duplicate',
    }));
  return {
    semanticKey,
    scheduleIds: entries.map((entry) => entry.scheduleId),
    names: [...new Set(entries.map((entry) => entry.name))],
    enabledCount: entries.filter((entry) => entry.enabled).length,
    keepScheduleId: keep.scheduleId,
    members,
    recommendation: 'Keep one canonical schedule enabled and pause older enabled duplicates with a dedupe reason.',
  };
}

export function buildScheduleDedupeReport(controllerHome: string, repoId: string): ScheduleDedupeReport {
  const schedules = listSchedules(controllerHome, repoId);
  const groups = new Map<string, RepositorySchedule[]>();
  for (const schedule of schedules) {
    const key = scheduleDedupeKey(schedule);
    groups.set(key, [...(groups.get(key) ?? []), schedule]);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([semanticKey, entries]) => duplicateGroup(semanticKey, entries))
    .sort((left, right) => right.scheduleIds.length - left.scheduleIds.length);
  const proposedDisableCount = duplicateGroups.reduce((sum, group) => sum + group.members.filter((member) => member.enabled && !member.keep).length, 0);
  return { repoId, generatedAt: new Date().toISOString(), totalSchedules: schedules.length, duplicateGroups, proposedDisableCount };
}

export function applyScheduleDedupe(controllerHome: string, repoId: string, input: { dryRun?: unknown; confirmAuthorization?: unknown } = {}): ScheduleDedupeApplyResult {
  const dryRun = input.dryRun === true;
  if (!dryRun && input.confirmAuthorization !== true) throw new Error('SCHEDULE_DEDUPE_AUTHORIZATION_REQUIRED: confirm_authorization must be true to pause duplicate schedules');
  return withControllerLock(controllerHome, { scope: 'task', repoId, taskId: 'schedule-dedupe' }, `schedule-dedupe:${repoId}`, () => {
    const report = buildScheduleDedupeReport(controllerHome, repoId);
    const disabled: ScheduleDedupeApplyResult['disabled'] = [];
    if (!dryRun) {
      for (const group of report.duplicateGroups) {
        for (const member of group.members) {
          if (member.keep || !member.enabled) continue;
          const current = getSchedule(controllerHome, repoId, member.scheduleId);
          const previousEnabled = current.enabled;
          const pausedReason = `duplicate schedule paused by schedule_dedupe_apply; kept ${group.keepScheduleId}`;
          saveSchedule(controllerHome, { ...current, enabled: false, pausedReason });
          disabled.push({ scheduleId: current.scheduleId, previousEnabled, pausedReason });
        }
      }
    }
    return { repoId, appliedAt: new Date().toISOString(), dryRun, report, disabled };
  }, 10_000);
}
