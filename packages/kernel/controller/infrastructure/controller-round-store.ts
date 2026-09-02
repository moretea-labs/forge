import { createHash, randomUUID } from 'crypto';
import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readRequirement } from '../../../../src/runtime/control-plane/persistence/requirement-store';
import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import { workHasActiveExecution } from '../../../../src/runtime/execution/work-activity';
import { controllerSessionBlocksRecovery, getControllerSession } from './controller-session-store';
import { getHandoffItem, listHandoffItems } from '../../../../src/runtime/control-plane/facade/handoff-inbox-store';
import { getWorkContract, readWorkContractStore, isTerminalWorkContractStatus, type WorkContract } from '../../work/api/index';
import { isTerminalHandoffStatus } from '../../../protocols/handoff/index';
import type { ControllerSession, ControllerType } from '../domain/types';
import {
  CONTROLLER_ROUND_DISPOSITIONS,
  CONTROLLER_RELAY_ABANDONED_RELEASE_ERROR,
  type ControllerRoundDisposition,
  type ControllerRoundRelayIdentity,
  type ControllerRoundRelayRecord,
  type ControllerRoundRelayStatus,
} from '../domain/controller-round';

export interface ControllerRoundRelayStoreOptions {
  controllerHome: string;
  repoId: string;
  now?: () => string;
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
  /** Opaque provider binding owned by a ControllerHost adapter. */
  bindingId?: string;
  maxRounds?: number;
  maxRepeatedState?: number;
  maxFailures?: number;
}

export interface BeginInitialControllerRoundDispatchInput {
  workId: string;
  identity: ControllerRoundRelayIdentity;
  relayScopeId?: string;
  requirementId?: string;
  /** Opaque provider binding owned by a ControllerHost adapter. */
  bindingId?: string;
  maxRounds?: number;
  maxRepeatedState?: number;
  maxFailures?: number;
}

/** Legacy ControllerRound rows predate explicit controllerType and were ChatGPT-only. */
function relayControllerType(record: Pick<ControllerRoundRelayRecord, 'controllerType'>): ControllerType {
  return record.controllerType ?? 'chatgpt';
}

const NAMESPACE = 'controller_round_relay';
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_MAX_REPEATED_STATE = 2;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_UNCLOSED_ROUND_GRACE_MS = 10 * 60_000;
const MAX_UNCLOSED_ROUND_GRACE_MS = 60 * 60_000;
const DEFAULT_STALLED_RECOVERY_BACKOFF_MS = 60_000;
const MAX_STALLED_RECOVERY_BACKOFF_MS = 15 * 60_000;

function nowIso(options: ControllerRoundRelayStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function newControllerRoundAuthorityId(): string {
  return `cra_${randomUUID().replace(/-/g, '')}`;
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

export function getControllerRoundRelay(
  options: ControllerRoundRelayStoreOptions,
  workId: string,
): ControllerRoundRelayRecord | undefined {
  return readRelayRecord(options, workId)?.value;
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
  if (record.requirementId) {
    for (const work of all) {
      if (work.requirementId === record.requirementId) linkedWorkIds.add(work.workId);
    }
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const work of all) {
      if (linkedWorkIds.has(work.workId)) {
        if (work.parentWorkId && !linkedWorkIds.has(work.parentWorkId)) {
          linkedWorkIds.add(work.parentWorkId);
          expanded = true;
        }
        continue;
      }
      if (work.parentWorkId && linkedWorkIds.has(work.parentWorkId)) {
        linkedWorkIds.add(work.workId);
        expanded = true;
      }
    }
  }
  return all
    .filter((work) => linkedWorkIds.has(work.workId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function mechanicalStateFingerprint(
  options: ControllerRoundRelayStoreOptions,
  work: WorkContract,
  requirementId: string | undefined,
  relayScopeId: string,
): string {
  const requirement = requirementForRelay(options, requirementId);
  const works = relevantWork(options, { relayScopeId, originWorkId: work.workId, requirementId })
    .map((entry) => ({
      workId: entry.workId,
      parentWorkId: entry.parentWorkId,
      status: entry.status,
      phase: entry.phase,
      dispatchState: entry.dispatchState,
      evidenceState: entry.evidenceState,
      completionOutcome: entry.completionOutcome,
      updatedAt: entry.updatedAt,
    }))
    .sort((left, right) => left.workId.localeCompare(right.workId));
  const linkedWorkIds = new Set(works.map((entry) => entry.workId));
  const handoffs = listHandoffItems({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 })
    .filter((handoff) => !handoff.workId || linkedWorkIds.has(handoff.workId))
    .map((handoff) => ({ id: handoff.id, status: handoff.status, updatedAt: handoff.updatedAt }));
  return createHash('sha256').update(JSON.stringify({
    requirement: requirement ? {
      requirementId: requirement.requirementId,
      state: requirement.state,
      revision: requirement.revision,
      updatedAt: requirement.updatedAt,
    } : undefined,
    works,
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

function assertControllerOwner(
  options: ControllerRoundRelayStoreOptions,
  workId: string,
  identity: ControllerRoundRelayIdentity,
): ControllerSession & { claimGeneration: number } {
  const owner = getControllerSession(options, workId);
  if (!owner) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}`);
  if (owner.controllerType !== identity.controllerType) throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${workId}`);
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
  const requirementId = resolveRequirementId(options, work, input.requirementId);
  const relayScopeId = resolveRelayScope(work, requirementId, input.relayScopeId);
  const terminal = isTerminalWorkContractStatus(work.status);

  return relayLock(options, relayScopeId, `controller-relay-submit:${input.identity.controllerId}`, () => {
    const existing = readRelayRecord(options, work.workId);
    if (!existing) throw new Error(`CONTROLLER_RELAY_ROUND_NOT_OPEN: ${work.workId}`);
    if (existing.value.relayScopeId !== relayScopeId) {
      throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: Work ${work.workId} is already bound to ${existing.value.relayScopeId}`);
    }
    if (existing.value.status !== 'claimed') {
      throw new Error(`CONTROLLER_RELAY_ROUND_NOT_CLAIMED: ${existing.value.status}`);
    }
    if (terminal && (work.status !== 'completed' || input.disposition !== 'goal_complete')) {
      throw new Error(`CONTROLLER_RELAY_WORK_TERMINAL: ${work.status}`);
    }

    const liveOwner = getControllerSession(options, work.workId);
    const authority = terminal
      ? (() => {
          // The physical Work may be completed while its old live lease still exists.
          // goal_complete is semantic round closure, not a terminal Work reclaim: use
          // the authenticated controller/principal plus the already-claimed relay as
          // authority and allow MCP session / Runtime instance rotation. If a live
          // owner remains, it must still agree on controller type and principal.
          const principalId = input.identity.principalId.trim();
          const controllerInstanceId = input.identity.controllerInstanceId.trim();
          const sessionId = input.identity.sessionId.trim();
          if (!principalId || !controllerInstanceId || !sessionId) throw new Error(`CONTROLLER_RELAY_TERMINAL_AUTHORITY_REQUIRED: ${work.workId}`);
          const expectedControllerType = relayControllerType(existing.value);
          if (input.identity.controllerType !== expectedControllerType) throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${work.workId}`);
          if (liveOwner) {
            if (liveOwner.controllerType !== expectedControllerType) throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${work.workId}`);
            if (liveOwner.controllerId !== input.identity.controllerId) throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${work.workId}`);
            if ((liveOwner.principalId?.trim() || liveOwner.controllerId) !== principalId) {
              throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${work.workId}`);
            }
          }
          if (existing.value.controllerId !== input.identity.controllerId) throw new Error(`CONTROLLER_RELAY_CLAIM_CONTROLLER_MISMATCH: ${work.workId}`);
          if (existing.value.principalId !== principalId) throw new Error(`CONTROLLER_RELAY_CLAIM_PRINCIPAL_MISMATCH: ${work.workId}`);
          if (existing.value.claimGeneration < 1) throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_REQUIRED: ${work.workId}`);
          return {
            controllerId: existing.value.controllerId,
            controllerType: expectedControllerType,
            principalId: existing.value.principalId,
            controllerInstanceId,
            sessionId,
            claimGeneration: existing.value.claimGeneration,
          };
        })()
      : (() => {
          const owner = assertControllerOwner(options, work.workId, input.identity);
          return {
            controllerId: owner.controllerId,
            controllerType: owner.controllerType,
            principalId: owner.principalId?.trim() || owner.controllerId,
            controllerInstanceId: owner.controllerInstanceId?.trim() || '',
            sessionId: owner.sessionId,
            claimGeneration: owner.claimGeneration,
          };
        })();
    if (existing.value.controllerId !== authority.controllerId) {
      throw new Error(`CONTROLLER_RELAY_CLAIM_CONTROLLER_MISMATCH: ${work.workId}`);
    }
    if (existing.value.principalId !== authority.principalId) {
      throw new Error(`CONTROLLER_RELAY_CLAIM_PRINCIPAL_MISMATCH: ${work.workId}`);
    }
    // A completed Work may have already released its live controller session before
    // the prompt-required terminal disposition arrives. At that point the exact
    // authenticated controller/principal + Work + relay scope remain the lineage
    // fence; MCP session and canonical Runtime instance are allowed to rotate.
    const terminalLineageMigration = terminal;
    if (!terminalLineageMigration && existing.value.controllerInstanceId !== authority.controllerInstanceId) {
      throw new Error(`CONTROLLER_RELAY_CLAIM_INSTANCE_MISMATCH: ${work.workId}`);
    }
    if (!terminalLineageMigration && existing.value.claimGeneration !== authority.claimGeneration) {
      throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_MISMATCH: ${work.workId}`);
    }
    const previous = relayHistory(options, relayScopeId)[0];
    const requestedMaxRounds = boundedInteger(input.maxRounds, DEFAULT_MAX_ROUNDS, 1, 32);
    const requestedMaxRepeatedState = boundedInteger(input.maxRepeatedState, DEFAULT_MAX_REPEATED_STATE, 1, 8);
    const requestedMaxFailures = boundedInteger(input.maxFailures, DEFAULT_MAX_FAILURES, 1, 8);
    const maxRounds = previous ? Math.min(previous.maxRounds, requestedMaxRounds) : requestedMaxRounds;
    const maxRepeatedState = previous ? Math.min(previous.maxRepeatedState, requestedMaxRepeatedState) : requestedMaxRepeatedState;
    const maxFailures = previous ? Math.min(previous.maxFailures, requestedMaxFailures) : requestedMaxFailures;
    const stateFingerprint = bounded(input.stateFingerprint, 256) ?? mechanicalStateFingerprint(options, work, requirementId, relayScopeId);
    const continuing = input.disposition === 'continue_immediately';
    const roundCount = (previous?.roundCount ?? 0) + (continuing ? 1 : 0);
    const repeatedStateCount = continuing
      ? (previous?.stateFingerprint === stateFingerprint ? (previous.repeatedStateCount + 1) : 0)
      : (previous?.repeatedStateCount ?? 0);
    const consecutiveFailures = previous?.consecutiveFailures ?? 0;
    const bindingId = bounded(input.bindingId, 500) ?? previous?.bindingId;

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
      lifecycleStage: 'semantic_round_closed',
      controllerId: authority.controllerId,
      controllerType: authority.controllerType,
      principalId: authority.principalId,
      controllerInstanceId: authority.controllerInstanceId,
      sessionId: authority.sessionId,
      claimGeneration: authority.claimGeneration,
      authorityId: existing.value.authorityId,
      stateFingerprint,
      roundCount,
      repeatedStateCount,
      consecutiveFailures,
      maxRounds,
      maxRepeatedState,
      maxFailures,
      ...(handoffId ? { handoffId } : {}),
      ...(bounded(input.reason, 1_000) ? { reason: bounded(input.reason, 1_000) } : {}),
      ...(bindingId ? { bindingId } : {}),
      ...(existing.value.providerDispatchReceiptId ? { providerDispatchReceiptId: existing.value.providerDispatchReceiptId } : {}),
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
    if (previous?.status === 'blocked' && previous.blockedReason === 'provider_dispatch_outcome_unknown') {
      throw new Error(`CONTROLLER_RELAY_PROVIDER_DISPATCH_OUTCOME_UNKNOWN: ${relayScopeId}`);
    }
    const abandonedReleasedRound = previous?.status === 'failed'
      && previous.lastError === CONTROLLER_RELAY_ABANDONED_RELEASE_ERROR;
    const requestedMaxRounds = boundedInteger(input.maxRounds, DEFAULT_MAX_ROUNDS, 1, 32);
    const requestedMaxRepeatedState = boundedInteger(input.maxRepeatedState, DEFAULT_MAX_REPEATED_STATE, 1, 8);
    const requestedMaxFailures = boundedInteger(input.maxFailures, DEFAULT_MAX_FAILURES, 1, 8);
    const maxRounds = previous ? Math.min(previous.maxRounds, requestedMaxRounds) : requestedMaxRounds;
    const maxRepeatedState = previous ? Math.min(previous.maxRepeatedState, requestedMaxRepeatedState) : requestedMaxRepeatedState;
    const maxFailures = previous ? Math.min(previous.maxFailures, requestedMaxFailures) : requestedMaxFailures;
    const stateFingerprint = mechanicalStateFingerprint(options, work, requirementId, relayScopeId);
    // Ordinary later schedule/manual occurrences intentionally receive a fresh
    // mechanical budget. A claimed round explicitly released without any semantic
    // disposition is different: launcher_start is recovering the same abandoned
    // relay chain, so it must consume round/repeated-state budget rather than reset
    // it and thereby weaken repeated-state fencing.
    const roundCount = abandonedReleasedRound ? previous!.roundCount + 1 : 1;
    const repeatedStateCount = abandonedReleasedRound
      ? (previous!.stateFingerprint === stateFingerprint ? previous!.repeatedStateCount + 1 : 0)
      : 0;
    const consecutiveFailures = abandonedReleasedRound ? previous!.consecutiveFailures : 0;
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
      lifecycleStage: 'dispatching',
      controllerId: input.identity.controllerId.trim().slice(0, 240) || 'controller-host',
      controllerType: input.identity.controllerType,
      principalId: input.identity.principalId.trim().slice(0, 240) || input.identity.controllerId.trim().slice(0, 240),
      controllerInstanceId: input.identity.controllerInstanceId.trim().slice(0, 240),
      sessionId: input.identity.sessionId.trim().slice(0, 240),
      claimGeneration: 0,
      authorityId: newControllerRoundAuthorityId(),
      stateFingerprint,
      roundCount,
      repeatedStateCount,
      consecutiveFailures,
      maxRounds,
      maxRepeatedState,
      maxFailures,
      reason: abandonedReleasedRound ? 'launcher_start_recovered_abandoned_claim' : 'launcher_start_requested_continuation',
      ...(bounded(input.bindingId, 500) ? { bindingId: bounded(input.bindingId, 500) } : previous?.bindingId ? { bindingId: previous.bindingId } : {}),
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
    // A released round is semantically closed. The successor dispatch receives a
    // fresh capability so a stale provider host cannot mutate the next round.
    const dispatching: ControllerRoundRelayRecord = {
      ...record,
      authorityId: newControllerRoundAuthorityId(),
      status: 'dispatching',
      lifecycleStage: 'dispatching',
      updatedAt: at,
    };
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

/**
 * Mechanically close a claimed controller round only after its exact controller
 * epoch has been released and durable state proves no controller lease remains.
 * This never invents a semantic disposition; launcher_start must open a new round.
 */
export function reconcileControllerRoundAfterAbandonedRelease(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; releasedSession: ControllerSession },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial || initial.value.status !== 'claimed') return undefined;
  return relayLock(options, initial.value.relayScopeId, `controller-relay-abandoned-release:${input.releasedSession.controllerId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current || current.value.status !== 'claimed') return undefined;
    const record = current.value;
    const releasedPrincipal = input.releasedSession.principalId?.trim() || input.releasedSession.controllerId;
    const releasedInstanceId = input.releasedSession.controllerInstanceId?.trim() || '';
    if (
      record.claimGeneration !== input.releasedSession.claimGeneration
      || record.controllerId !== input.releasedSession.controllerId
      || record.principalId !== releasedPrincipal
      || record.controllerInstanceId !== releasedInstanceId
      || record.sessionId !== input.releasedSession.sessionId
    ) {
      throw new Error(`CONTROLLER_RELAY_RELEASE_FENCE_MISMATCH: ${input.workId}`);
    }
    if (getControllerSession(options, input.workId)) {
      throw new Error(`CONTROLLER_RELAY_ABANDONED_RELEASE_ACTIVE_CLAIM: ${input.workId}`);
    }
    const work = getWorkContract(options, input.workId);
    if (!work || isTerminalWorkContractStatus(work.status)) return undefined;

    const at = nowIso(options);
    const abandoned: ControllerRoundRelayRecord = {
      ...record,
      status: 'failed',
      lastError: CONTROLLER_RELAY_ABANDONED_RELEASE_ERROR,
      claimedAt: undefined,
      updatedAt: at,
    };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE,
      scope: options.repoId,
      key: input.workId,
      schemaVersion: SCHEMA_VERSION,
      value: abandoned,
      action: 'controller_round_relay_claim_abandoned_after_release',
      expectedRevision: current.revision,
    });
    return abandoned;
  });
}

export function finishControllerRoundRelayDispatch(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; ok: boolean; bindingId?: string; providerDispatchReceiptId?: string; error?: string; recovery?: boolean; outcomeUnknown?: boolean; waitForUser?: boolean; handoffId?: string; nowMs?: number },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial || initial.value.status !== 'dispatching') return initial?.value;
  return relayLock(options, initial.value.relayScopeId, `controller-relay-finish:${input.workId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current || current.value.status !== 'dispatching') return current?.value;
    const at = typeof input.nowMs === 'number' ? new Date(input.nowMs).toISOString() : nowIso(options);
    const nextFailureCount = current.value.consecutiveFailures + 1;
    const recoveryBlocked = input.recovery === true && nextFailureCount >= current.value.maxFailures;
    const handoffId = bounded(input.handoffId, 200);
    if (input.waitForUser) {
      if (!handoffId) throw new Error('CONTROLLER_RELAY_WAIT_FOR_USER_HANDOFF_REQUIRED');
      const handoff = getHandoffItem(options, handoffId);
      if (!handoff) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
      if (isTerminalHandoffStatus(handoff.status)) throw new Error(`CONTROLLER_RELAY_HANDOFF_TERMINAL: ${handoff.status}`);
      if (handoff.workId && handoff.workId !== input.workId) throw new Error(`CONTROLLER_RELAY_HANDOFF_WORK_MISMATCH: ${handoffId}`);
    }
    const recoveryDelayMs = Math.min(
      MAX_STALLED_RECOVERY_BACKOFF_MS,
      DEFAULT_STALLED_RECOVERY_BACKOFF_MS * 2 ** Math.max(0, nextFailureCount - 1),
    );
    const next: ControllerRoundRelayRecord = input.ok
      ? {
          ...current.value,
          status: 'dispatched',
          lifecycleStage: 'dispatch_confirmed',
          consecutiveFailures: 0,
          lastError: undefined,
          nextRecoveryAt: undefined,
          blockedReason: undefined,
          ...(bounded(input.bindingId, 500) ? { bindingId: bounded(input.bindingId, 500) } : {}),
          ...(bounded(input.providerDispatchReceiptId, 500) ? { providerDispatchReceiptId: bounded(input.providerDispatchReceiptId, 500) } : {}),
          dispatchedAt: at,
          updatedAt: at,
        }
      : input.outcomeUnknown
        ? {
            ...current.value,
            status: 'blocked',
            consecutiveFailures: nextFailureCount,
            nextRecoveryAt: undefined,
            lastError: bounded(input.error, 2_000) ?? 'CONTROLLER_RELAY_PROVIDER_DISPATCH_OUTCOME_UNKNOWN',
            blockedReason: 'provider_dispatch_outcome_unknown',
            updatedAt: at,
          }
        : input.waitForUser
          ? {
              ...current.value,
              status: 'waiting_for_user',
              nextRecoveryAt: undefined,
              lastError: bounded(input.error, 2_000) ?? 'CONTROLLER_RELAY_WAIT_FOR_USER',
              blockedReason: 'provider_user_action_required',
              handoffId,
              updatedAt: at,
            }
        : input.recovery
        ? {
            ...current.value,
            status: recoveryBlocked ? 'blocked' : 'dispatching',
            consecutiveFailures: nextFailureCount,
            lastError: bounded(input.error, 2_000) ?? 'CONTROLLER_RELAY_RECOVERY_FAILED',
            blockedReason: recoveryBlocked
              ? `consecutive_failures:${nextFailureCount}>=${current.value.maxFailures}`
              : undefined,
            nextRecoveryAt: recoveryBlocked
              ? undefined
              : new Date(Date.parse(at) + recoveryDelayMs).toISOString(),
            updatedAt: at,
          }
        : {
            ...current.value,
            status: 'failed',
            consecutiveFailures: nextFailureCount,
            nextRecoveryAt: undefined,
            lastError: bounded(input.error, 2_000) ?? 'CONTROLLER_RELAY_DISPATCH_FAILED',
            updatedAt: at,
          };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE,
      scope: options.repoId,
      key: input.workId,
      schemaVersion: SCHEMA_VERSION,
      value: next,
      action: input.ok
        ? 'controller_round_relay_dispatched'
        : input.outcomeUnknown
          ? 'controller_round_relay_dispatch_outcome_unknown'
          : input.waitForUser
            ? 'controller_round_relay_waiting_for_user'
          : input.recovery
            ? recoveryBlocked ? 'controller_round_relay_recovery_blocked' : 'controller_round_relay_recovery_retry_scheduled'
            : 'controller_round_relay_failed',
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
  } else if (initial.value.status === 'blocked') {
    if (!initial.value.blockedReason?.startsWith('repeated_state:')) return initial.value;
  } else if (!['dispatching', 'dispatched'].includes(initial.value.status)) return initial.value;
  const expectedControllerType = relayControllerType(initial.value);
  if (input.session.controllerType !== expectedControllerType) throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${input.workId}`);

  return relayLock(options, initial.value.relayScopeId, `controller-relay-claim:${input.session.controllerId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current) return undefined;
    if (current.value.status === 'claimed') {
      if (
        current.value.controllerId === input.session.controllerId
        && current.value.sessionId === input.session.sessionId
        && current.value.claimGeneration === input.session.claimGeneration
      ) return current.value;

      const owner = getControllerSession(options, input.workId);
      const ownerPrincipal = owner?.principalId?.trim() || owner?.controllerId;
      const sessionPrincipal = input.session.principalId?.trim() || input.session.controllerId;
      if (
        !owner
        || owner.controllerType !== (relayControllerType(current.value))
        || owner.controllerId !== input.session.controllerId
        || owner.sessionId !== input.session.sessionId
        || owner.claimGeneration !== input.session.claimGeneration
        || ownerPrincipal !== sessionPrincipal
        || (owner.controllerInstanceId?.trim() || '') !== (input.session.controllerInstanceId?.trim() || '')
      ) throw new Error(`CONTROLLER_RELAY_CLAIM_IDENTITY_MISMATCH: ${input.workId}`);
      if (current.value.controllerId !== owner.controllerId || current.value.principalId !== ownerPrincipal) {
        throw new Error(`CONTROLLER_RELAY_CLAIM_CONFLICT: ${input.workId}`);
      }
      if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
        throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_REQUIRED: ${input.workId}`);
      }
      const controllerInstanceId = owner.controllerInstanceId?.trim();
      if (!controllerInstanceId) throw new Error(`CONTROLLER_RELAY_CLAIM_INSTANCE_REQUIRED: ${input.workId}`);
      const at = nowIso(options);
      const migrated: ControllerRoundRelayRecord = {
        ...current.value,
        controllerType: owner.controllerType,
        controllerInstanceId,
        sessionId: owner.sessionId,
        claimGeneration: owner.claimGeneration,
        lifecycleStage: 'controller_claimed',
        claimedAt: at,
        updatedAt: at,
        lastError: undefined,
      };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: input.workId,
        schemaVersion: SCHEMA_VERSION,
        value: migrated,
        action: 'controller_round_relay_claim_migrated',
        expectedRevision: current.revision,
      });
      return migrated;
    }
    if (current.value.status === 'blocked') {
      if (!current.value.blockedReason?.startsWith('repeated_state:')) return current.value;
      if (current.value.roundCount > current.value.maxRounds || current.value.consecutiveFailures >= current.value.maxFailures) {
        return current.value;
      }
      const work = getWorkContract(options, input.workId);
      if (!work || isTerminalWorkContractStatus(work.status)) return current.value;
      const owner = getControllerSession(options, input.workId);
      const ownerPrincipal = owner?.principalId?.trim() || owner?.controllerId;
      const sessionPrincipal = input.session.principalId?.trim() || input.session.controllerId;
      if (
        !owner
        || owner.controllerType !== (relayControllerType(current.value))
        || owner.controllerId !== input.session.controllerId
        || owner.sessionId !== input.session.sessionId
        || owner.claimGeneration !== input.session.claimGeneration
        || ownerPrincipal !== sessionPrincipal
        || (owner.controllerInstanceId?.trim() || '') !== (input.session.controllerInstanceId?.trim() || '')
      ) throw new Error(`CONTROLLER_RELAY_CLAIM_IDENTITY_MISMATCH: ${input.workId}`);
      if (current.value.controllerId !== owner.controllerId || current.value.principalId !== ownerPrincipal) {
        throw new Error(`CONTROLLER_RELAY_CLAIM_CONFLICT: ${input.workId}`);
      }
      if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
        throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_REQUIRED: ${input.workId}`);
      }
      const controllerInstanceId = owner.controllerInstanceId?.trim();
      if (!controllerInstanceId) throw new Error(`CONTROLLER_RELAY_CLAIM_INSTANCE_REQUIRED: ${input.workId}`);
      const stateFingerprint = mechanicalStateFingerprint(options, work, current.value.requirementId, current.value.relayScopeId);
      if (stateFingerprint === current.value.stateFingerprint) return current.value;
      const at = nowIso(options);
      const rearmed: ControllerRoundRelayRecord = {
        ...current.value,
        status: 'claimed',
        lifecycleStage: 'controller_claimed',
        controllerId: owner.controllerId,
        controllerType: owner.controllerType,
        principalId: ownerPrincipal,
        controllerInstanceId,
        sessionId: owner.sessionId,
        claimGeneration: owner.claimGeneration,
        stateFingerprint,
        repeatedStateCount: 0,
        blockedReason: undefined,
        lastError: undefined,
        claimedAt: at,
        updatedAt: at,
      };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: input.workId,
        schemaVersion: SCHEMA_VERSION,
        value: rearmed,
        action: 'controller_round_relay_claim_rearmed_after_state_change',
        expectedRevision: current.revision,
      });
      return rearmed;
    }
    if (!['dispatching', 'dispatched'].includes(current.value.status)) return current.value;
    const owner = getControllerSession(options, input.workId);
    if (!owner) throw new Error(`CONTROLLER_RELAY_ACTIVE_CLAIM_REQUIRED: ${input.workId}`);
    if (
      owner.controllerType !== (relayControllerType(current.value))
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
      lifecycleStage: 'controller_claimed',
      controllerId: owner.controllerId,
      controllerType: owner.controllerType,
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
  input: { nowMs?: number; graceMs?: number; limit?: number; controllerTypes?: readonly ControllerType[] } = {},
): ControllerRoundRelayRecord[] {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = Math.max(60_000, Math.min(input.graceMs ?? DEFAULT_UNCLOSED_ROUND_GRACE_MS, MAX_UNCLOSED_ROUND_GRACE_MS));
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 2), 16));
  const claimed: ControllerRoundRelayRecord[] = [];

  for (const candidate of latestRelayRecordsByScope(options)) {
    if (claimed.length >= limit) break;
    if (!['pending_release', 'dispatching', 'dispatched', 'claimed'].includes(candidate.status)) continue;
    if (input.controllerTypes && !input.controllerTypes.includes(relayControllerType(candidate))) continue;
    const scheduledRecoveryAtMs = candidate.nextRecoveryAt ? Date.parse(candidate.nextRecoveryAt) : Number.NaN;
    if (Number.isFinite(scheduledRecoveryAtMs)) {
      if (nowMs < scheduledRecoveryAtMs) continue;
    } else {
      const roundOpenedAtMs = Date.parse(candidate.claimedAt ?? candidate.dispatchedAt ?? candidate.updatedAt);
      if (!Number.isFinite(roundOpenedAtMs) || nowMs - roundOpenedAtMs < graceMs) continue;
    }
    const requirement = requirementForRelay(options, candidate.requirementId);
    if (requirement && !['planned', 'active'].includes(requirement.state)) continue;
    const candidateWorks = relevantWork(options, candidate);
    const activeCandidateWorks = candidateWorks.filter((work) => !isTerminalWorkContractStatus(work.status));
    if (activeCandidateWorks.length === 0) continue;
    if (activeCandidateWorks.some((work) => workHasActiveExecution(options.controllerHome, options.repoId, work.workId) || controllerSessionBlocksRecovery(options, work.workId, { nowMs, graceMs }))) continue;

    const next = relayLock(options, candidate.relayScopeId, `controller-relay-recover:${candidate.originWorkId}`, () => {
      const latest = relayHistory(options, candidate.relayScopeId)[0];
      if (!latest || latest.originWorkId !== candidate.originWorkId || latest.updatedAt !== candidate.updatedAt || latest.status !== candidate.status) return undefined;
      if (input.controllerTypes && !input.controllerTypes.includes(relayControllerType(latest))) return undefined;
      const latestRecoveryAtMs = latest.nextRecoveryAt ? Date.parse(latest.nextRecoveryAt) : Number.NaN;
      if (Number.isFinite(latestRecoveryAtMs)) {
        if (nowMs < latestRecoveryAtMs) return undefined;
      } else {
        const latestRoundOpenedAtMs = Date.parse(latest.claimedAt ?? latest.dispatchedAt ?? latest.updatedAt);
        if (!Number.isFinite(latestRoundOpenedAtMs) || nowMs - latestRoundOpenedAtMs < graceMs) return undefined;
      }
      const latestRequirement = requirementForRelay(options, latest.requirementId);
      if (latestRequirement && !['planned', 'active'].includes(latestRequirement.state)) return undefined;
      const works = relevantWork(options, latest);
      const activeWorks = works.filter((work) => !isTerminalWorkContractStatus(work.status));
      if (activeWorks.length === 0) return undefined;
      if (activeWorks.some((work) => workHasActiveExecution(options.controllerHome, options.repoId, work.workId) || controllerSessionBlocksRecovery(options, work.workId, { nowMs, graceMs }))) return undefined;

      const currentRecord = readRelayRecord(options, latest.originWorkId);
      if (!currentRecord || currentRecord.value.updatedAt !== latest.updatedAt || currentRecord.value.status !== latest.status) return undefined;
      const fingerprintWork = activeWorks[0] ?? getWorkContract(options, latest.originWorkId);
      const stateFingerprint = fingerprintWork
        ? mechanicalStateFingerprint(options, fingerprintWork, latest.requirementId, latest.relayScopeId)
        : latest.stateFingerprint;
      const resumesUndispatchedRound = latest.status === 'pending_release' || latest.status === 'dispatching';
      const roundCount = latest.roundCount + (resumesUndispatchedRound ? 0 : 1);
      const repeatedStateCount = resumesUndispatchedRound
        ? latest.repeatedStateCount
        : latest.stateFingerprint === stateFingerprint ? latest.repeatedStateCount + 1 : 0;
      let blockedReason: string | undefined;
      if (roundCount > latest.maxRounds) blockedReason = `round_budget_exhausted:${roundCount}>${latest.maxRounds}`;
      else if (repeatedStateCount >= latest.maxRepeatedState) blockedReason = `repeated_state:${repeatedStateCount}>=${latest.maxRepeatedState}`;

      const at = new Date(nowMs).toISOString();
      const recovered: ControllerRoundRelayRecord = {
        ...latest,
        // Re-dispatching an already dispatched/claimed round creates a new
        // controller epoch. Retrying an in-flight dispatch keeps its capability.
        authorityId: blockedReason
          ? latest.authorityId
          : latest.status === 'dispatching' && latest.authorityId
            ? latest.authorityId
            : newControllerRoundAuthorityId(),
        status: blockedReason ? 'blocked' : 'dispatching',
        ...(blockedReason ? {} : { lifecycleStage: 'dispatching' as const }),
        stateFingerprint,
        roundCount,
        repeatedStateCount,
        lastError: latest.nextRecoveryAt
          ? latest.lastError
          : latest.status === 'pending_release'
            ? 'CONTROLLER_RELAY_RELEASE_TRANSITION_INCOMPLETE'
            : latest.status === 'dispatching'
              ? 'CONTROLLER_RELAY_DISPATCH_TRANSITION_INCOMPLETE'
              : latest.status === 'claimed' ? 'CONTROLLER_RELAY_CLAIMED_ROUND_UNCLOSED' : 'CONTROLLER_RELAY_ROUND_UNCLOSED',
        nextRecoveryAt: undefined,
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

export interface ControllerRoundContextSnapshot {
  repoId: string;
  relayScopeId: string;
  originWorkId: string;
  requirement?: {
    requirementId: string;
    state: string;
    outcomeStatement: string;
  };
  works: Array<{
    workId: string;
    status: string;
    phase: string;
    updatedAt: string;
    objective: string;
  }>;
  handoffs: Array<{
    id: string;
    status: string;
    workId?: string;
    title: string;
    reason: string;
  }>;
  round: {
    count: number;
    maxRounds: number;
    repeatedStateCount: number;
    maxRepeatedState: number;
    consecutiveFailures: number;
    maxFailures: number;
  };
  recoveryReason?: string;
}

/** Provider-neutral launch context. ControllerHost adapters decide how to render it. */
export function readControllerRoundContextSnapshot(
  options: ControllerRoundRelayStoreOptions,
  record: ControllerRoundRelayRecord,
): ControllerRoundContextSnapshot {
  const requirement = requirementForRelay(options, record.requirementId);
  const relevantWorks = relevantWork(options, record);
  const works = relevantWorks.slice(0, 8);
  const workIds = new Set(relevantWorks.map((work) => work.workId));
  const handoffs = listHandoffItems({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 })
    .filter((handoff) => !handoff.workId || workIds.has(handoff.workId))
    .slice(0, 8);
  return {
    repoId: record.repoId,
    relayScopeId: record.relayScopeId,
    originWorkId: record.originWorkId,
    ...(requirement ? {
      requirement: {
        requirementId: requirement.requirementId,
        state: requirement.state,
        outcomeStatement: requirement.outcomeStatement.slice(0, 800),
      },
    } : {}),
    works: works.map((work) => ({
      workId: work.workId,
      status: work.status,
      phase: work.phase,
      updatedAt: work.updatedAt,
      objective: work.objective.slice(0, 500),
    })),
    handoffs: handoffs.map((handoff) => ({
      id: handoff.id,
      status: handoff.status,
      ...(handoff.workId ? { workId: handoff.workId } : {}),
      title: handoff.title,
      reason: handoff.reason.slice(0, 300),
    })),
    round: {
      count: record.roundCount,
      maxRounds: record.maxRounds,
      repeatedStateCount: record.repeatedStateCount,
      maxRepeatedState: record.maxRepeatedState,
      consecutiveFailures: record.consecutiveFailures,
      maxFailures: record.maxFailures,
    },
    ...(['CONTROLLER_RELAY_ROUND_UNCLOSED', 'CONTROLLER_RELAY_CLAIMED_ROUND_UNCLOSED'].includes(record.lastError ?? '')
      ? { recoveryReason: record.lastError }
      : {}),
  };
}
