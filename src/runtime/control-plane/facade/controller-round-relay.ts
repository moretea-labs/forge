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
  | 'claimed'
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
  claimedAt?: string;
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

export interface BeginInitialControllerRoundDispatchInput {
  workId: string;
  identity: ControllerRoundRelayIdentity;
  relayScopeId?: string;
  requirementId?: string;
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
const DEFAULT_UNCLOSED_ROUND_GRACE_MS = 10 * 60_000;
const MAX_UNCLOSED_ROUND_GRACE_MS = 60 * 60_000;

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

function latestRelayRecordsByScope(options: ControllerRoundRelayStoreOptions): ControllerRoundRelayRecord[] {
  const latest = new Map<string, ControllerRoundRelayRecord>();
  for (const entry of listControlPlaneRecords<ControllerRoundRelayRecord>(options.controllerHome, {
    namespace: NAMESPACE,
    scope: options.repoId,
    limit: 5_000,
  }).map((record) => record.value)) {
    const current = latest.get(entry.relayScopeId);
    if (!current || entry.updatedAt > current.updatedAt) latest.set(entry.relayScopeId, entry);
  }
  return [...latest.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
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

export function beginInitialControllerRoundDispatch(
  options: ControllerRoundRelayStoreOptions,
  input: BeginInitialControllerRoundDispatchInput,
): ControllerRoundRelayRecord {
  const work = getWorkContract(options, input.workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (isTerminalWorkContractStatus(work.status)) throw new Error(`CONTROLLER_RELAY_WORK_TERMINAL: ${work.status}`);
  const requirementId = resolveRequirementId(options, work, input.requirementId);
  const requirement = requirementForRelay(options, requirementId);
  if (requirement && !['planned', 'active'].includes(requirement.state)) {
    throw new Error(`CONTROLLER_RELAY_REQUIREMENT_TERMINAL: ${requirement.state}`);
  }
  const relayScopeId = resolveRelayScope(work, requirementId, input.relayScopeId);

  return relayLock(options, relayScopeId, `controller-relay-launch:${input.identity.controllerId}`, () => {
    const existing = readRelayRecord(options, work.workId);
    if (existing && existing.value.relayScopeId !== relayScopeId) {
      throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: Work ${work.workId} is already bound to ${existing.value.relayScopeId}`);
    }
    const previous = relayHistory(options, relayScopeId)[0];
    if (previous && ['pending_release', 'dispatching', 'dispatched', 'claimed'].includes(previous.status)) {
      throw new Error(`CONTROLLER_RELAY_ROUND_ALREADY_OPEN: ${relayScopeId}`);
    }
    const requestedMaxRounds = boundedInteger(input.maxRounds, DEFAULT_MAX_ROUNDS, 1, 32);
    const requestedMaxRepeatedState = boundedInteger(input.maxRepeatedState, DEFAULT_MAX_REPEATED_STATE, 1, 8);
    const requestedMaxFailures = boundedInteger(input.maxFailures, DEFAULT_MAX_FAILURES, 1, 8);
    const maxRounds = previous ? Math.min(previous.maxRounds, requestedMaxRounds) : requestedMaxRounds;
    const maxRepeatedState = previous ? Math.min(previous.maxRepeatedState, requestedMaxRepeatedState) : requestedMaxRepeatedState;
    const maxFailures = previous ? Math.min(previous.maxFailures, requestedMaxFailures) : requestedMaxFailures;
    const stateFingerprint = mechanicalStateFingerprint(options, work, requirementId);
    const roundCount = (previous?.roundCount ?? 0) + 1;
    const repeatedStateCount = previous?.stateFingerprint === stateFingerprint
      ? previous.repeatedStateCount + 1
      : 0;
    const consecutiveFailures = previous?.consecutiveFailures ?? 0;
    let blockedReason: string | undefined;
    if (roundCount > maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${maxRounds}`;
    else if (repeatedStateCount >= maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${maxRepeatedState}`;
    else if (consecutiveFailures >= maxFailures) blockedReason = `consecutive_failures:${consecutiveFailures}>=${maxFailures}`;

    const at = nowIso(options);
    const record: ControllerRoundRelayRecord = {
      schemaVersion: 1,
      repoId: options.repoId,
      relayScopeId,
      originWorkId: work.workId,
      ...(requirementId ? { requirementId } : {}),
      // launcher_start is itself an explicit request to continue the Work. The
      // launched controller must still submit its own end-of-round disposition.
      disposition: 'continue_immediately',
      status: blockedReason ? 'blocked' : 'dispatching',
      controllerId: input.identity.controllerId.trim().slice(0, 240) || 'chatgpt-launcher',
      principalId: input.identity.principalId.trim().slice(0, 240) || input.identity.controllerId.trim().slice(0, 240),
      controllerInstanceId: input.identity.controllerInstanceId.trim().slice(0, 240),
      sessionId: input.identity.sessionId.trim().slice(0, 240),
      claimGeneration: 0,
      stateFingerprint,
      roundCount,
      repeatedStateCount,
      consecutiveFailures,
      maxRounds,
      maxRepeatedState,
      maxFailures,
      reason: 'launcher_start_requested_continuation',
      ...(bounded(input.browserSessionId, 500) ? { browserSessionId: bounded(input.browserSessionId, 500) } : previous?.browserSessionId ? { browserSessionId: previous.browserSessionId } : {}),
      ...(bounded(input.conversationUrl, 2_000) ? { conversationUrl: bounded(input.conversationUrl, 2_000) } : previous?.conversationUrl ? { conversationUrl: previous.conversationUrl } : {}),
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
      action: blockedReason ? 'controller_round_initial_launch_blocked' : 'controller_round_initial_launch_begin',
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
          lastError: undefined,
          blockedReason: undefined,
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

export function acknowledgeControllerRoundClaim(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; session: ControllerSession },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial) return undefined;
  if (initial.value.status === 'claimed') {
    if (
      initial.value.controllerId === input.session.controllerId
      && initial.value.sessionId === input.session.sessionId
      && initial.value.claimGeneration === input.session.claimGeneration
    ) return initial.value;
    throw new Error(`CONTROLLER_RELAY_CLAIM_CONFLICT: ${input.workId}`);
  }
  if (initial.value.status !== 'dispatched') return initial.value;
  if (input.session.controllerType !== 'chatgpt') throw new Error(`CONTROLLER_RELAY_CHATGPT_CLAIM_REQUIRED: ${input.workId}`);

  return relayLock(options, initial.value.relayScopeId, `controller-relay-claim:${input.session.controllerId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current) return undefined;
    if (current.value.status === 'claimed') {
      if (
        current.value.controllerId === input.session.controllerId
        && current.value.sessionId === input.session.sessionId
        && current.value.claimGeneration === input.session.claimGeneration
      ) return current.value;
      throw new Error(`CONTROLLER_RELAY_CLAIM_CONFLICT: ${input.workId}`);
    }
    if (current.value.status !== 'dispatched') return current.value;
    const owner = getControllerSession(options, input.workId);
    if (!owner) throw new Error(`CONTROLLER_RELAY_ACTIVE_CLAIM_REQUIRED: ${input.workId}`);
    if (
      owner.controllerType !== 'chatgpt'
      || owner.controllerId !== input.session.controllerId
      || owner.sessionId !== input.session.sessionId
      || owner.claimGeneration !== input.session.claimGeneration
      || (owner.principalId?.trim() || owner.controllerId) !== (input.session.principalId?.trim() || input.session.controllerId)
    ) throw new Error(`CONTROLLER_RELAY_CLAIM_IDENTITY_MISMATCH: ${input.workId}`);
    if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
      throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_REQUIRED: ${input.workId}`);
    }
    const claimGeneration = owner.claimGeneration;
    const at = nowIso(options);
    const next: ControllerRoundRelayRecord = {
      ...current.value,
      status: 'claimed',
      controllerId: owner.controllerId,
      principalId: owner.principalId?.trim() || owner.controllerId,
      controllerInstanceId: owner.controllerInstanceId?.trim() || current.value.controllerInstanceId,
      sessionId: owner.sessionId,
      claimGeneration,
      claimedAt: at,
      updatedAt: at,
      lastError: undefined,
    };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE,
      scope: options.repoId,
      key: input.workId,
      schemaVersion: SCHEMA_VERSION,
      value: next,
      action: 'controller_round_relay_claim_acknowledged',
      expectedRevision: current.revision,
    });
    return next;
  });
}

export function claimStalledControllerRoundRelays(
  options: ControllerRoundRelayStoreOptions,
  input: { nowMs?: number; graceMs?: number; limit?: number } = {},
): ControllerRoundRelayRecord[] {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = Math.max(60_000, Math.min(input.graceMs ?? DEFAULT_UNCLOSED_ROUND_GRACE_MS, MAX_UNCLOSED_ROUND_GRACE_MS));
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 2), 16));
  const claimed: ControllerRoundRelayRecord[] = [];

  for (const candidate of latestRelayRecordsByScope(options)) {
    if (claimed.length >= limit) break;
    if (!['dispatched', 'claimed'].includes(candidate.status)) continue;
    const roundOpenedAtMs = Date.parse(candidate.claimedAt ?? candidate.dispatchedAt ?? candidate.updatedAt);
    if (!Number.isFinite(roundOpenedAtMs) || nowMs - roundOpenedAtMs < graceMs) continue;
    const requirement = requirementForRelay(options, candidate.requirementId);
    if (requirement && !['planned', 'active'].includes(requirement.state)) continue;
    const candidateWorks = relevantWork(options, candidate);
    const activeCandidateWorks = candidateWorks.filter((work) => !isTerminalWorkContractStatus(work.status));
    if (activeCandidateWorks.length === 0) continue;
    if (activeCandidateWorks.some((work) => getControllerSession(options, work.workId))) continue;

    const next = relayLock(options, candidate.relayScopeId, `controller-relay-recover:${candidate.originWorkId}`, () => {
      const latest = relayHistory(options, candidate.relayScopeId)[0];
      if (!latest || latest.originWorkId !== candidate.originWorkId || latest.updatedAt !== candidate.updatedAt || latest.status !== candidate.status) return undefined;
      const latestRoundOpenedAtMs = Date.parse(latest.claimedAt ?? latest.dispatchedAt ?? latest.updatedAt);
      if (!Number.isFinite(latestRoundOpenedAtMs) || nowMs - latestRoundOpenedAtMs < graceMs) return undefined;
      const latestRequirement = requirementForRelay(options, latest.requirementId);
      if (latestRequirement && !['planned', 'active'].includes(latestRequirement.state)) return undefined;
      const works = relevantWork(options, latest);
      const activeWorks = works.filter((work) => !isTerminalWorkContractStatus(work.status));
      if (activeWorks.length === 0) return undefined;
      if (activeWorks.some((work) => getControllerSession(options, work.workId))) return undefined;

      const currentRecord = readRelayRecord(options, latest.originWorkId);
      if (!currentRecord || currentRecord.value.updatedAt !== latest.updatedAt || currentRecord.value.status !== latest.status) return undefined;
      const fingerprintWork = activeWorks[0] ?? getWorkContract(options, latest.originWorkId);
      const stateFingerprint = fingerprintWork
        ? mechanicalStateFingerprint(options, fingerprintWork, latest.requirementId)
        : latest.stateFingerprint;
      const roundCount = latest.roundCount + 1;
      const repeatedStateCount = latest.stateFingerprint === stateFingerprint ? latest.repeatedStateCount + 1 : 0;
      let blockedReason: string | undefined;
      if (roundCount > latest.maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${latest.maxRounds}`;
      else if (repeatedStateCount >= latest.maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${latest.maxRepeatedState}`;

      const at = new Date(nowMs).toISOString();
      const recovered: ControllerRoundRelayRecord = {
        ...latest,
        status: blockedReason ? 'blocked' : 'dispatching',
        stateFingerprint,
        roundCount,
        repeatedStateCount,
        lastError: latest.status === 'claimed' ? 'CONTROLLER_RELAY_CLAIMED_ROUND_UNCLOSED' : 'CONTROLLER_RELAY_ROUND_UNCLOSED',
        claimedAt: undefined,
        ...(blockedReason ? { blockedReason } : { blockedReason: undefined }),
        updatedAt: at,
      };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: latest.originWorkId,
        schemaVersion: SCHEMA_VERSION,
        value: recovered,
        action: blockedReason ? 'controller_round_relay_stalled_blocked' : 'controller_round_relay_stalled_recovery_begin',
        expectedRevision: currentRecord.revision,
      });
      return blockedReason ? undefined : recovered;
    });
    if (next) claimed.push(next);
  }
  return claimed;
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
    ...(['CONTROLLER_RELAY_ROUND_UNCLOSED', 'CONTROLLER_RELAY_CLAIMED_ROUND_UNCLOSED'].includes(record.lastError ?? '')
      ? ['The previous ChatGPT round did not submit an explicit disposition before its liveness grace elapsed. Forge is only recovering liveness: reread durable state, make the semantic decision in ChatGPT, and close this round explicitly.']
      : []),
    `If the overall Requirement/Goal still needs another controller round, explicitly submit rh_work controller_disposition=continue_immediately with relay_scope_id=${record.relayScopeId} before releasing the Work you own. Otherwise use wait, wait_for_user with an active Handoff, or goal_complete.`,
    'Forge must not infer the semantic next step. Existing Work ownership, Handoff authority, and external-effect authorization remain authoritative; claim the exact Work before any mutation.',
  ].join('\n');
}
