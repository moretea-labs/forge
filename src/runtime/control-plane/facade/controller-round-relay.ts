import { createHash } from 'crypto';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readRequirement } from '../persistence/requirement-store';
import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../persistence/sqlite-store';
import { getControllerSession } from './controller-session-store';
import { getHandoffItem, listHandoffItems } from './handoff-inbox-store';
import { getWorkContract, readWorkContractStore } from './work-contract-store';
import {
  isTerminalHandoffStatus,
  isTerminalWorkContractStatus,
  type ControllerSession,
  type WorkContract,
} from './types';

export const CONTROLLER_ROUND_DISPOSITIONS = [
  'continue_immediately',
  'wait',
  'wait_for_user',
  'goal_complete',
] as const;
export type ControllerRoundDisposition = (typeof CONTROLLER_ROUND_DISPOSITIONS)[number];

export type ControllerRoundRelayStatus =
  | 'pending_release'
  | 'dispatching'
  | 'dispatched'
  | 'waiting'
  | 'waiting_for_user'
  | 'goal_complete'
  | 'blocked'
  | 'failed';

export interface ControllerRoundRelayRecord {
  schemaVersion: 1;
  repoId: string;
  relayScopeId: string;
  originWorkId: string;
  requirementId?: string;
  disposition: ControllerRoundDisposition;
  status: ControllerRoundRelayStatus;
  controllerId: string;
  principalId: string;
  controllerInstanceId: string;
  sessionId: string;
  claimGeneration: number;
  stateFingerprint: string;
  roundCount: number;
  repeatedStateCount: number;
  consecutiveFailures: number;
  maxRounds: number;
  maxRepeatedState: number;
  maxFailures: number;
  handoffId?: string;
  reason?: string;
  browserSessionId?: string;
  conversationUrl?: string;
  blockedReason?: string;
  lastError?: string;
  submittedAt: string;
  updatedAt: string;
  dispatchedAt?: string;
}

export interface ControllerRoundRelayStoreOptions {
  controllerHome: string;
  repoId: string;
  now?: () => string;
}

export interface ControllerRoundRelayIdentity {
  controllerId: string;
  principalId: string;
  controllerInstanceId: string;
  sessionId: string;
}

export interface SubmitControllerRoundDispositionInput {
  workId: string;
  identity: ControllerRoundRelayIdentity;
  disposition: ControllerRoundDisposition;
  relayScopeId?: string;
  requirementId?: string;
  handoffId?: string;
  stateFingerprint?: string;
  reason?: string;
  browserSessionId?: string;
  conversationUrl?: string;
  maxRounds?: number;
  maxRepeatedState?: number;
  maxFailures?: number;
}

const NAMESPACE = 'controller_round_relay';
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_MAX_REPEATED_STATE = 2;
const DEFAULT_MAX_FAILURES = 3;

function nowIso(options: ControllerRoundRelayStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function bounded(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function normalizeScopeId(value: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error('CONTROLLER_RELAY_SCOPE_INVALID');
  return normalized.slice(0, 240);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function relayLock<T>(
  options: ControllerRoundRelayStoreOptions,
  relayScopeId: string,
  actor: string,
  operation: () => T,
): T {
  const lockId = createHash('sha256').update(relayScopeId).digest('hex').slice(0, 20);
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-round-relay-${lockId}` },
    actor,
    operation,
  );
}

function readRelayRecord(
  options: ControllerRoundRelayStoreOptions,
  workId: string,
): ControlPlaneRecord<ControllerRoundRelayRecord> | undefined {
  return readControlPlaneRecord<ControllerRoundRelayRecord>(options.controllerHome, NAMESPACE, options.repoId, workId);
}

function relayHistory(options: ControllerRoundRelayStoreOptions, relayScopeId: string): ControllerRoundRelayRecord[] {
  return listControlPlaneRecords<ControllerRoundRelayRecord>(options.controllerHome, {
    namespace: NAMESPACE,
    scope: options.repoId,
    limit: 5_000,
  })
    .map((entry) => entry.value)
    .filter((entry) => entry.relayScopeId === relayScopeId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function requirementForRelay(options: ControllerRoundRelayStoreOptions, requirementId: string | undefined) {
  return requirementId ? readRequirement({ controllerHome: options.controllerHome }, requirementId)?.value : undefined;
}

function relevantWork(options: ControllerRoundRelayStoreOptions, record: Pick<ControllerRoundRelayRecord, 'relayScopeId' | 'originWorkId' | 'requirementId'>): WorkContract[] {
  const all = readWorkContractStore({ controllerHome: options.controllerHome, repoId: options.repoId }).contracts;
  const linkedWorkIds = new Set([
    record.originWorkId,
    ...relayHistory(options, record.relayScopeId).map((entry) => entry.originWorkId),
  ]);
  return all
    .filter((work) => record.requirementId ? work.requirementId === record.requirementId : linkedWorkIds.has(work.workId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);
}

function mechanicalStateFingerprint(
  options: ControllerRoundRelayStoreOptions,
  work: WorkContract,
  requirementId: string | undefined,
): string {
  const requirement = requirementForRelay(options, requirementId);
  const handoffs = listHandoffItems({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 })
    .filter((handoff) => !handoff.workId || handoff.workId === work.workId)
    .map((handoff) => ({ id: handoff.id, status: handoff.status, updatedAt: handoff.updatedAt }));
  return createHash('sha256').update(JSON.stringify({
    requirement: requirement ? {
      requirementId: requirement.requirementId,
      state: requirement.state,
      revision: requirement.revision,
      updatedAt: requirement.updatedAt,
    } : undefined,
    work: {
      workId: work.workId,
      status: work.status,
      phase: work.phase,
      dispatchState: work.dispatchState,
      evidenceState: work.evidenceState,
      updatedAt: work.updatedAt,
    },
    handoffs,
  })).digest('hex');
}

function resolveRequirementId(
  options: ControllerRoundRelayStoreOptions,
  work: WorkContract,
  requestedRequirementId: string | undefined,
): string | undefined {
  const requested = bounded(requestedRequirementId, 160);
  if (work.requirementId && requested && work.requirementId !== requested) {
    throw new Error(`CONTROLLER_RELAY_REQUIREMENT_MISMATCH: Work ${work.workId} belongs to ${work.requirementId}`);
  }
  const requirementId = work.requirementId ?? requested;
  if (requirementId && !requirementForRelay(options, requirementId)) {
    throw new Error(`REQUIREMENT_NOT_FOUND: ${requirementId}`);
  }
  return requirementId;
}

function resolveRelayScope(
  work: WorkContract,
  requirementId: string | undefined,
  requestedScopeId: string | undefined,
): string {
  const canonicalRequirementScope = requirementId ? `requirement:${requirementId}` : undefined;
  if (canonicalRequirementScope) {
    if (requestedScopeId && normalizeScopeId(requestedScopeId) !== canonicalRequirementScope) {
      throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: expected ${canonicalRequirementScope}`);
    }
    return canonicalRequirementScope;
  }
  return requestedScopeId ? normalizeScopeId(requestedScopeId) : `goal:${work.workId}`;
}

function assertChatgptOwner(
  options: ControllerRoundRelayStoreOptions,
  workId: string,
  identity: ControllerRoundRelayIdentity,
): ControllerSession & { claimGeneration: number } {
  const owner = getControllerSession(options, workId);
  if (!owner) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}`);
  if (owner.controllerType !== 'chatgpt') throw new Error(`CONTROLLER_RELAY_CHATGPT_ONLY: ${workId}`);
  if (owner.controllerId !== identity.controllerId) throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId}`);
  const ownerPrincipal = owner.principalId?.trim() || owner.controllerId;
  if (ownerPrincipal !== identity.principalId.trim()) throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
  if (owner.sessionId !== identity.sessionId.trim()) throw new Error(`WORK_CONTROLLER_SESSION_MISMATCH: ${workId}`);
  const ownerInstanceId = owner.controllerInstanceId?.trim();
  if (ownerInstanceId && ownerInstanceId !== identity.controllerInstanceId.trim()) {
    throw new Error(`WORK_CONTROLLER_INSTANCE_MISMATCH: ${workId}`);
  }
  if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_REQUIRED: ${workId}`);
  return owner as ControllerSession & { claimGeneration: number };
}

export function submitControllerRoundDisposition(
  options: ControllerRoundRelayStoreOptions,
  input: SubmitControllerRoundDispositionInput,
): ControllerRoundRelayRecord {
  if (!CONTROLLER_ROUND_DISPOSITIONS.includes(input.disposition)) throw new Error('CONTROLLER_RELAY_DISPOSITION_INVALID');
  const work = getWorkContract(options, input.workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (isTerminalWorkContractStatus(work.status)) throw new Error(`CONTROLLER_RELAY_WORK_TERMINAL: ${work.status}`);
  const owner = assertChatgptOwner(options, work.workId, input.identity);
  const requirementId = resolveRequirementId(options, work, input.requirementId);
  const relayScopeId = resolveRelayScope(work, requirementId, input.relayScopeId);

  return relayLock(options, relayScopeId, `controller-relay-submit:${input.identity.controllerId}`, () => {
    const existing = readRelayRecord(options, work.workId);
    if (existing && existing.value.relayScopeId !== relayScopeId) {
      throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: Work ${work.workId} is already bound to ${existing.value.relayScopeId}`);
    }
    const previous = relayHistory(options, relayScopeId)[0];
    const requestedMaxRounds = boundedInteger(input.maxRounds, DEFAULT_MAX_ROUNDS, 1, 32);
    const requestedMaxRepeatedState = boundedInteger(input.maxRepeatedState, DEFAULT_MAX_REPEATED_STATE, 1, 8);
    const requestedMaxFailures = boundedInteger(input.maxFailures, DEFAULT_MAX_FAILURES, 1, 8);
    const maxRounds = previous ? Math.min(previous.maxRounds, requestedMaxRounds) : requestedMaxRounds;
    const maxRepeatedState = previous ? Math.min(previous.maxRepeatedState, requestedMaxRepeatedState) : requestedMaxRepeatedState;
    const maxFailures = previous ? Math.min(previous.maxFailures, requestedMaxFailures) : requestedMaxFailures;
    const stateFingerprint = bounded(input.stateFingerprint, 256) ?? mechanicalStateFingerprint(options, work, requirementId);
    const continuing = input.disposition === 'continue_immediately';
    const roundCount = (previous?.roundCount ?? 0) + (continuing ? 1 : 0);
    const repeatedStateCount = continuing
      ? (previous?.stateFingerprint === stateFingerprint ? (previous.repeatedStateCount + 1) : 0)
      : (previous?.repeatedStateCount ?? 0);
    const consecutiveFailures = previous?.consecutiveFailures ?? 0;
    const browserSessionId = bounded(input.browserSessionId, 500) ?? previous?.browserSessionId;
    const conversationUrl = bounded(input.conversationUrl, 2_000) ?? previous?.conversationUrl;

    let status: ControllerRoundRelayStatus = input.disposition === 'continue_immediately'
      ? 'pending_release'
      : input.disposition === 'wait'
        ? 'waiting'
        : input.disposition === 'wait_for_user'
          ? 'waiting_for_user'
          : 'goal_complete';
    let blockedReason: string | undefined;

    const handoffId = bounded(input.handoffId, 200);
    if (input.disposition === 'wait_for_user') {
      if (!handoffId) throw new Error('CONTROLLER_RELAY_WAIT_FOR_USER_HANDOFF_REQUIRED');
      const handoff = getHandoffItem(options, handoffId);
      if (!handoff) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
      if (isTerminalHandoffStatus(handoff.status)) throw new Error(`CONTROLLER_RELAY_HANDOFF_TERMINAL: ${handoff.status}`);
      if (handoff.workId && handoff.workId !== work.workId) throw new Error(`CONTROLLER_RELAY_HANDOFF_WORK_MISMATCH: ${handoffId}`);
    }

    if (continuing) {
      if (roundCount > maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${maxRounds}`;
      else if (repeatedStateCount >= maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${maxRepeatedState}`;
      else if (consecutiveFailures >= maxFailures) blockedReason = `consecutive_failures:${consecutiveFailures}>=${maxFailures}`;
      if (blockedReason) status = 'blocked';
    }

    const at = nowIso(options);
    const record: ControllerRoundRelayRecord = {
      schemaVersion: 1,
      repoId: options.repoId,
      relayScopeId,
      originWorkId: work.workId,
      ...(requirementId ? { requirementId } : {}),
      disposition: input.disposition,
      status,
      controllerId: owner.controllerId,
      principalId: owner.principalId?.trim() || input.identity.principalId.trim(),
      controllerInstanceId: owner.controllerInstanceId?.trim() || input.identity.controllerInstanceId.trim(),
      sessionId: owner.sessionId,
      claimGeneration: owner.claimGeneration,
      stateFingerprint,
      roundCount,
      repeatedStateCount,
      consecutiveFailures,
      maxRounds,
      maxRepeatedState,
      maxFailures,
      ...(handoffId ? { handoffId } : {}),
      ...(bounded(input.reason, 1_000) ? { reason: bounded(input.reason, 1_000) } : {}),
      ...(browserSessionId ? { browserSessionId } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      submittedAt: at,
      updatedAt: at,
    };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE,
      scope: options.repoId,
      key: work.workId,
      schemaVersion: SCHEMA_VERSION,
      value: record,
      action: 'controller_round_disposition_submitted',
      expectedRevision: existing?.revision ?? null,
    });
    return record;
  });
}

export function beginControllerRoundRelayAfterRelease(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; releasedSession: ControllerSession },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial || initial.value.status !== 'pending_release') return undefined;
  return relayLock(options, initial.value.relayScopeId, `controller-relay-begin:${input.releasedSession.controllerId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current || current.value.status !== 'pending_release') return undefined;
    const record = current.value;
    const releasedPrincipal = input.releasedSession.principalId?.trim() || input.releasedSession.controllerId;
    if (
      record.claimGeneration !== input.releasedSession.claimGeneration
      || record.controllerId !== input.releasedSession.controllerId
      || record.principalId !== releasedPrincipal
    ) {
      throw new Error(`CONTROLLER_RELAY_RELEASE_FENCE_MISMATCH: ${input.workId}`);
    }
    const at = nowIso(options);
    const dispatching: ControllerRoundRelayRecord = { ...record, status: 'dispatching', updatedAt: at };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE,
      scope: options.repoId,
      key: input.workId,
      schemaVersion: SCHEMA_VERSION,
      value: dispatching,
      action: 'controller_round_relay_dispatch_begin',
      expectedRevision: current.revision,
    });
    return dispatching;
  });
}

export function finishControllerRoundRelayDispatch(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; ok: boolean; browserSessionId?: string; conversationUrl?: string; error?: string },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial || initial.value.status !== 'dispatching') return initial?.value;
  return relayLock(options, initial.value.relayScopeId, `controller-relay-finish:${input.workId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current || current.value.status !== 'dispatching') return current?.value;
    const at = nowIso(options);
    const next: ControllerRoundRelayRecord = input.ok
      ? {
          ...current.value,
          status: 'dispatched',
          consecutiveFailures: 0,
          ...(bounded(input.browserSessionId, 500) ? { browserSessionId: bounded(input.browserSessionId, 500) } : {}),
          ...(bounded(input.conversationUrl, 2_000) ? { conversationUrl: bounded(input.conversationUrl, 2_000) } : {}),
          dispatchedAt: at,
          updatedAt: at,
        }
      : {
          ...current.value,
          status: 'failed',
          consecutiveFailures: current.value.consecutiveFailures + 1,
          lastError: bounded(input.error, 2_000) ?? 'CONTROLLER_RELAY_DISPATCH_FAILED',
          updatedAt: at,
        };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE,
      scope: options.repoId,
      key: input.workId,
      schemaVersion: SCHEMA_VERSION,
      value: next,
      action: input.ok ? 'controller_round_relay_dispatched' : 'controller_round_relay_failed',
      expectedRevision: current.revision,
    });
    return next;
  });
}

export function buildControllerRoundRelayPrompt(
  options: ControllerRoundRelayStoreOptions,
  record: ControllerRoundRelayRecord,
): string {
  const requirement = requirementForRelay(options, record.requirementId);
  const works = relevantWork(options, record);
  const workIds = new Set(works.map((work) => work.workId));
  const handoffs = listHandoffItems({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 })
    .filter((handoff) => !handoff.workId || workIds.has(handoff.workId))
    .slice(0, 8);
  const requirementLine = requirement
    ? `Requirement ${requirement.requirementId}: state=${requirement.state}; outcome=${requirement.outcomeStatement.slice(0, 800)}`
    : `No durable Requirement is bound; semantic relay scope is ${record.relayScopeId}.`;
  const workLines = works.length > 0
    ? works.map((work) => `- ${work.workId}: status=${work.status}; phase=${work.phase}; updated=${work.updatedAt}; objective=${work.objective.slice(0, 500)}`).join('\n')
    : '- no linked Work snapshot found';
  const handoffLines = handoffs.length > 0
    ? handoffs.map((handoff) => `- ${handoff.id}: status=${handoff.status}; work=${handoff.workId ?? 'repo'}; ${handoff.title}; reason=${handoff.reason.slice(0, 300)}`).join('\n')
    : '- no active linked Handoff';
  return [
    `Continue Forge Requirement/Goal relay ${record.relayScopeId} in repo ${record.repoId}.`,
    'This is a new ChatGPT controller round. First reread the latest Forge Requirement/Work/Handoff state; the snapshot below is only a launch hint.',
    requirementLine,
    `Linked Work snapshot:\n${workLines}`,
    `Active Handoff snapshot:\n${handoffLines}`,
    `Previous relay origin Work: ${record.originWorkId}. Do not assume the next action must continue that Work; select, start, or claim the appropriate Work from the latest semantic state.`,
    `Mechanical relay budget: round=${record.roundCount}/${record.maxRounds}; repeated_state=${record.repeatedStateCount}/${record.maxRepeatedState}; consecutive_failures=${record.consecutiveFailures}/${record.maxFailures}.`,
    `If the overall Requirement/Goal still needs another controller round, explicitly submit rh_work controller_disposition=continue_immediately with relay_scope_id=${record.relayScopeId} before releasing the Work you own. Otherwise use wait, wait_for_user with an active Handoff, or goal_complete.`,
    'Forge must not infer the semantic next step. Existing Work ownership, Handoff authority, and external-effect authorization remain authoritative; claim the exact Work before any mutation.',
  ].join('\n');
}
