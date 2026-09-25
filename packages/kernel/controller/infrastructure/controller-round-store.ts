import { createHash, randomUUID } from 'crypto';
import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readRequirement } from '../../../../src/runtime/control-plane/persistence/requirement-store';
import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecord,
  writeControlPlaneRecordWithinTransaction,
  withControlPlaneReadDatabase,
  type ControlPlaneRecord,
} from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import { workHasActiveExecution } from '../../../../src/runtime/execution/work-activity';
import {
  assertControllerSessionWorkClaimable,
  controllerSessionBlocksRecovery,
  controllerSessionPrincipalId,
  getControllerSession,
  releaseObservedControllerSession,
  resumeControllerSessionWithinTransaction,
  withControllerSessionMutationLock,
  type ClaimedControllerSession,
  type ControllerSessionClaimInput,
} from './controller-session-store';
import { getHandoffItem, listHandoffItems } from '../../../../src/runtime/control-plane/facade/handoff-inbox-store';
import { currentTaskLineageWorkIds, getWorkContract, readActiveWorkCandidates, readWorkContractStore, isTerminalWorkContractStatus, type WorkContract } from '../../work/api/index';
import { isTerminalHandoffStatus } from '../../../protocols/handoff/index';
import type { ControllerSession, ControllerType } from '../domain/types';
import { deriveClosedRoundQualitySignals, type AssistantContextSnapshot, type AssistantContextUsage, type ClosedRoundObservation, type ExecutionQualityAdjustmentResult, type ExecutionQualityDecision, type ExecutionQualitySignal } from '../domain/execution-quality';
import {
  CONTROLLER_ROUND_DISPOSITIONS,
  CONTROLLER_RELAY_ABANDONED_RELEASE_ERROR,
  type ControllerRoundDisposition,
  type ControllerRoundRelayIdentity,
  type ControllerRoundRelayRecord,
  type ControllerRoundRelayStatus,
} from '../domain/controller-round';
import {
  controllerRoundBlockerClass,
  controllerRoundProviderEffectId,
  controllerRoundRelayClaimable,
  decideControllerRoundTransition,
  type ControllerRoundBlockerClass,
  type ControllerRoundTransitionDecision,
  type ControllerRoundTransitionEvent,
} from '../domain/controller-round-transition-policy';

export interface ControllerRoundRelayStoreOptions {
  controllerHome: string;
  repoId: string;
  now?: () => string;
  /** Trusted composition supplies advisory data; Kernel does not read project files. */
  prepareAssistantContext?: (workId: string) => string | undefined;
}

export interface SubmitControllerRoundDispositionInput {
  workId: string;
  identity: ControllerRoundRelayIdentity;
  disposition: ControllerRoundDisposition;
  executionQualityDecisions?: ExecutionQualityDecision[];
  executionQualityAdjustmentResults?: Array<Omit<ExecutionQualityAdjustmentResult, 'verifiedAt'>>;
  assistantContextDigest?: string;
  assistantContextUsage?: AssistantContextUsage[];
  relayScopeId?: string;
  requirementId?: string;
  handoffId?: string;
  stateFingerprint?: string;
  reason?: string;
  /** Exact facade-authenticated authority for completed-Work provider-wait goal closure only. */
  terminalAuthorityId?: string;
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
  /** Required for any later schedule/manual/replan occurrence after a prior semantic state exists. */
  occurrenceId?: string;
  /**
   * Scheduler-owned recovery may re-arm an unchanged semantic wait when the
   * outer Workflow Supervisor task is no longer runnable. This is bounded by
   * the existing repeated-state/round budgets and never applies to a user
   * blocker or an unknown provider outcome.
   */
  allowSemanticWaitRecovery?: boolean;
}

export interface RecoverControllerRoundRelayAuthorityInput {
  workId: string;
  requestedBy?: string;
  recoveryReason?: string;
  identity: ControllerRoundRelayIdentity;
  /** Set only after the caller proves this identity is served by the live canonical Runtime. */
  allowCanonicalRuntimeMigration?: boolean;
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
const MAX_LATEST_RELAY_CACHE_ENTRIES = 128;

interface LatestRelayRecordsCacheEntry {
  signature: string;
  records: ControllerRoundRelayRecord[];
}

const latestRelayRecordsCache = new Map<string, LatestRelayRecordsCacheEntry>();


function transitionDecisionOrThrow(decision: ControllerRoundTransitionDecision): { record: ControllerRoundRelayRecord; action?: string; changed: boolean } {
  if (decision.kind === 'accept') return { record: decision.next, action: decision.action, changed: true };
  if (decision.kind === 'accept_atomic') throw new Error('CONTROLLER_RELAY_ATOMIC_TRANSITION_REQUIRES_TRANSACTION');
  if (decision.kind === 'no_op') return { record: decision.current, changed: false };
  if (decision.kind === 'needs_evidence') throw new Error(decision.code);
  throw new Error(decision.code);
}

function atomicTransitionDecisionOrThrow(decision: ControllerRoundTransitionDecision): Extract<ControllerRoundTransitionDecision, { kind: 'accept_atomic' }> {
  if (decision.kind === 'accept_atomic') return decision;
  if (decision.kind === 'needs_evidence' || decision.kind === 'reject') throw new Error(decision.code);
  throw new Error('CONTROLLER_RELAY_ATOMIC_TRANSITION_REQUIRED');
}

function applyControllerRoundTransition(
  options: ControllerRoundRelayStoreOptions,
  current: ControlPlaneRecord<ControllerRoundRelayRecord> | undefined,
  event: ControllerRoundTransitionEvent,
): ControllerRoundRelayRecord {
  const decided = transitionDecisionOrThrow(decideControllerRoundTransition(current?.value, event));
  if (!decided.changed) return decided.record;
  const key = current?.value.originWorkId ?? (event.type === 'occurrence_requested' ? event.originWorkId : undefined);
  if (!key) throw new Error('CONTROLLER_RELAY_TRANSITION_KEY_REQUIRED');
  writeControlPlaneRecord(options.controllerHome, {
    namespace: NAMESPACE, scope: options.repoId, key, schemaVersion: SCHEMA_VERSION, value: decided.record,
    action: decided.action ?? `controller_round_transition_${event.type}`, expectedRevision: current?.revision ?? null,
  });
  return decided.record;
}
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

export function getRequirementControllerRoundRelay(
  options: ControllerRoundRelayStoreOptions,
  requirementId: string,
): ControllerRoundRelayRecord | undefined {
  const normalizedRequirementId = requirementId.trim();
  if (!normalizedRequirementId) return undefined;
  const relayScopeId = `requirement:${normalizedRequirementId}`;
  return latestRelayRecordsByScope(options).find((entry) =>
    entry.relayScopeId === relayScopeId
    && entry.requirementId === normalizedRequirementId);
}

/**
 * Resolve an existing Requirement-scoped ControllerRound authority for another
 * Work that is mechanically part of the same durable Requirement/Work graph.
 * This never mints, copies, or rebinds relay state; callers may only project the
 * already-proven opaque authority into the target Work's ControllerSession.
 */
export function resolveRequirementControllerRoundRelayForWork(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; authorityId: string; relayScopeId: string },
): ControllerRoundRelayRecord | undefined {
  const workId = input.workId.trim();
  const authorityId = input.authorityId.trim();
  const relayScopeId = input.relayScopeId.trim();
  if (!workId || !authorityId || !relayScopeId.startsWith('requirement:')) return undefined;
  const candidate = latestRelayRecordsByScope(options).find((entry) =>
    entry.relayScopeId === relayScopeId
    && entry.authorityId?.trim() === authorityId
    && Boolean(entry.requirementId)
    && `requirement:${entry.requirementId}` === relayScopeId);
  if (!candidate) return undefined;
  const target = getWorkContract(options, workId);
  if (!target) return undefined;
  if (candidate.requirementId && target.requirementId !== candidate.requirementId) return undefined;
  const all = readWorkContractStore({ controllerHome: options.controllerHome, repoId: options.repoId }).contracts;
  return currentTaskLineageWorkIds([candidate.originWorkId], all).has(workId) ? candidate : undefined;
}

function relayHistory(options: ControllerRoundRelayStoreOptions, relayScopeId: string): ControllerRoundRelayRecord[] {
  return listControlPlaneRecords<ControllerRoundRelayRecord>(options.controllerHome, {
    namespace: NAMESPACE,
    scope: options.repoId,
    limit: 5_000,
  })
    .map((entry) => entry.value)
    .filter((entry) => entry.relayScopeId === relayScopeId && entry.status !== 'handed_off')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function latestRelayRecordsByScope(options: ControllerRoundRelayStoreOptions): ControllerRoundRelayRecord[] {
  const cacheKey = `${options.controllerHome}\u0000${options.repoId}`;
  const signature = withControlPlaneReadDatabase(options.controllerHome, (database) => {
    const statement = database.prepare(`
      SELECT COUNT(*) AS recordCount,
             COALESCE(SUM(revision), 0) AS revisionSum,
             MAX(updated_at) AS latestUpdatedAt
      FROM control_plane_records
      WHERE namespace = ? AND scope = ?
    `);
    try {
      const row = statement.get(NAMESPACE, options.repoId) as { recordCount?: unknown; revisionSum?: unknown; latestUpdatedAt?: unknown } | undefined;
      return `${String(row?.recordCount ?? 0)}:${String(row?.revisionSum ?? 0)}:${typeof row?.latestUpdatedAt === 'string' ? row.latestUpdatedAt : ''}`;
    } finally {
      statement.finalize?.();
    }
  });
  const cached = latestRelayRecordsCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached.records;

  const latest = new Map<string, ControllerRoundRelayRecord>();
  for (const entry of listControlPlaneRecords<ControllerRoundRelayRecord>(options.controllerHome, {
    namespace: NAMESPACE,
    scope: options.repoId,
    limit: 5_000,
  }).map((record) => record.value)) {
    if (entry.status === 'handed_off') continue;
    const current = latest.get(entry.relayScopeId);
    if (!current || entry.updatedAt > current.updatedAt) latest.set(entry.relayScopeId, entry);
  }
  const records = [...latest.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  latestRelayRecordsCache.set(cacheKey, { signature, records });
  while (latestRelayRecordsCache.size > MAX_LATEST_RELAY_CACHE_ENTRIES) {
    const oldest = latestRelayRecordsCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    latestRelayRecordsCache.delete(oldest);
  }
  return records;
}

/** Read-only current relay projection for bounded lifecycle/resource reconciliation. */
export function listControllerRoundRelaysByBlocker(
  options: ControllerRoundRelayStoreOptions,
  blocker: ControllerRoundBlockerClass,
  limit = 16,
): ControllerRoundRelayRecord[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  return latestRelayRecordsByScope(options)
    .filter((record) => controllerRoundBlockerClass(record) === blocker)
    .slice(0, boundedLimit);
}

/** Read-only latest relay projection used by bounded lifecycle/resource reconciliation. */
export function listCurrentControllerRoundRelays(
  options: ControllerRoundRelayStoreOptions,
  limit = 100,
): ControllerRoundRelayRecord[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  return latestRelayRecordsByScope(options).slice(0, boundedLimit);
}


function requirementForRelay(options: ControllerRoundRelayStoreOptions, requirementId: string | undefined) {
  return requirementId ? readRequirement({ controllerHome: options.controllerHome }, requirementId)?.value : undefined;
}

function relevantWork(
  options: ControllerRoundRelayStoreOptions,
  record: Pick<ControllerRoundRelayRecord, 'relayScopeId' | 'originWorkId' | 'requirementId'>,
  allWorkContracts: readonly WorkContract[] = readWorkContractStore({ controllerHome: options.controllerHome, repoId: options.repoId }).contracts,
): WorkContract[] {
  const all = allWorkContracts;
  const linkedWorkIds = currentTaskLineageWorkIds([record.originWorkId], all);
  return all
    .filter((work) => linkedWorkIds.has(work.workId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function recoveryFenceWork(
  options: ControllerRoundRelayStoreOptions,
  record: Pick<ControllerRoundRelayRecord, 'relayScopeId' | 'originWorkId' | 'requirementId'>,
  allWorkContracts: readonly WorkContract[] = readWorkContractStore({ controllerHome: options.controllerHome, repoId: options.repoId }).contracts,
): WorkContract[] {
  const explicit = relevantWork(options, record, allWorkContracts);
  const requirementId = record.requirementId?.trim();
  if (!requirementId || record.relayScopeId !== `requirement:${requirementId}`) return explicit;
  const byId = new Map(explicit.map((work) => [work.workId, work] as const));
  for (const work of allWorkContracts) {
    if (work.requirementId?.trim() === requirementId) byId.set(work.workId, work);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function relayMayHaveActiveWork(
  options: ControllerRoundRelayStoreOptions,
  record: Pick<ControllerRoundRelayRecord, 'relayScopeId' | 'originWorkId' | 'requirementId'>,
  activeWorkSnapshot: ReturnType<typeof readActiveWorkCandidates>,
): boolean {
  const all = readWorkContractStore({ controllerHome: options.controllerHome, repoId: options.repoId }).contracts;
  const recoveryFenceIds = new Set(recoveryFenceWork(options, record, all).map((work) => work.workId));
  // Recovery is a destructive liveness decision. For Requirement-scoped relay
  // authority it must conservatively fence every active Work in that Requirement,
  // while normal semantic context continues to use exact current-task lineage.
  if (activeWorkSnapshot.invalid.some((work) => recoveryFenceIds.has(work.workId))) return true;
  return activeWorkSnapshot.contracts.some((work) => recoveryFenceIds.has(work.workId));
}

function relevantHandoffs(
  options: ControllerRoundRelayStoreOptions,
  works: readonly Pick<WorkContract, 'workId'>[],
  explicitHandoffId?: string,
) {
  const linkedWorkIds = new Set(works.map((work) => work.workId));
  return listHandoffItems({ controllerHome: options.controllerHome, repoId: options.repoId, status: 'active', limit: 100 })
    .filter((handoff) => handoff.workId ? linkedWorkIds.has(handoff.workId) : handoff.id === explicitHandoffId);
}

function semanticVerificationFacts(work: WorkContract): Array<{
  checkId: string; verificationInputFingerprint: string; checkDefinitionDigest: string;
  checkEnvironmentFingerprint: string; checkCacheKey: string; outcome: string; status: string;
}> {
  const unique = new Map<string, {
    checkId: string; verificationInputFingerprint: string; checkDefinitionDigest: string;
    checkEnvironmentFingerprint: string; checkCacheKey: string; outcome: string; status: string;
  }>();
  for (const record of work.checkRefs.slice(-32)) {
    const receipt = record.receipt;
    if (!receipt || !record.verificationInputFingerprint || !receipt.checkDefinitionDigest
      || !receipt.checkEnvironmentFingerprint || !receipt.checkCacheKey
      || !['valid_pass', 'valid_fail'].includes(record.outcome)
      || !['passed', 'failed'].includes(receipt.status)) continue;
    const fact = {
      checkId: record.checkId,
      verificationInputFingerprint: record.verificationInputFingerprint,
      checkDefinitionDigest: receipt.checkDefinitionDigest,
      checkEnvironmentFingerprint: receipt.checkEnvironmentFingerprint,
      checkCacheKey: receipt.checkCacheKey,
      outcome: record.outcome,
      status: receipt.status,
    };
    unique.set(JSON.stringify(fact), fact);
  }
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function mechanicalStateFingerprint(
  options: ControllerRoundRelayStoreOptions,
  work: WorkContract,
  requirementId: string | undefined,
  relayScopeId: string,
  explicitHandoffId?: string,
  allWorkContracts?: readonly WorkContract[],
): string {
  const requirement = requirementForRelay(options, requirementId);
  const works = relevantWork(options, { relayScopeId, originWorkId: work.workId, requirementId }, allWorkContracts)
    .map((entry) => ({
      workId: entry.workId,
      parentWorkId: entry.parentWorkId,
      status: entry.status,
      phase: entry.phase,
      dispatchState: entry.dispatchState,
      evidenceState: entry.evidenceState,
      completionOutcome: entry.completionOutcome,
      verificationFacts: semanticVerificationFacts(entry),
      executionConcurrency: entry.executionConcurrency ? {
        status: entry.executionConcurrency.status,
        source: entry.executionConcurrency.source,
        blockerCode: entry.executionConcurrency.blockerCode,
        blockingWorkId: entry.executionConcurrency.blockingWorkId,
        semanticScopeKeys: entry.executionConcurrency.semanticScopeKeys,
        resourceKeys: entry.executionConcurrency.resourceKeys,
        leaseRepoId: entry.executionConcurrency.leaseRepoId,
        resourceIntents: entry.executionConcurrency.resourceIntents,
        wakeTrigger: entry.executionConcurrency.wakeTrigger,
      } : undefined,
    }))
    .sort((left, right) => left.workId.localeCompare(right.workId));
  const handoffs = relevantHandoffs(options, works, explicitHandoffId)
    .map((handoff) => ({
      id: handoff.id,
      workId: handoff.workId,
      status: handoff.status,
      severity: handoff.severity,
      title: handoff.title,
      reason: handoff.reason,
      creationReason: handoff.creationReason,
      blockingDecision: handoff.blockingDecision,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify({
    requirement: requirement ? {
      requirementId: requirement.requirementId,
      state: requirement.state,
      revision: requirement.revision,
    } : undefined,
    works,
    handoffs,
  })).digest('hex');
}

/** Current semantic state identity for one existing ControllerRound lineage. Volatile persistence timestamps are intentionally excluded. */
export function readControllerRoundSemanticStateFingerprint(
  options: ControllerRoundRelayStoreOptions,
  workId: string,
): string | undefined {
  const work = getWorkContract(options, workId);
  const current = readRelayRecord(options, workId)?.value;
  if (!work || !current) return undefined;
  return mechanicalStateFingerprint(options, work, current.requirementId, current.relayScopeId, current.handoffId);
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

function assertControllerRoundSuccessorLineage(
  options: ControllerRoundRelayStoreOptions,
  predecessor: WorkContract,
  successorWorkId: string,
): WorkContract {
  const successor = getWorkContract(options, successorWorkId);
  if (!successor) throw new Error(`CONTROLLER_RELAY_SUCCESSOR_WORK_NOT_FOUND: ${successorWorkId}`);
  if (isTerminalWorkContractStatus(successor.status)) {
    throw new Error(`CONTROLLER_RELAY_SUCCESSOR_WORK_TERMINAL: ${successor.workId}:${successor.status}`);
  }
  if (successor.predecessorWorkId !== predecessor.workId) {
    throw new Error(`CONTROLLER_RELAY_SUCCESSOR_LINEAGE_MISMATCH: ${successor.workId}:predecessor=${successor.predecessorWorkId ?? 'none'}:expected=${predecessor.workId}`);
  }
  if (predecessor.requirementId && successor.requirementId !== predecessor.requirementId) {
    throw new Error(`CONTROLLER_RELAY_SUCCESSOR_REQUIREMENT_MISMATCH: ${successor.workId}`);
  }
  if (predecessor.planId && successor.planId !== predecessor.planId) {
    throw new Error(`CONTROLLER_RELAY_SUCCESSOR_PLAN_MISMATCH: ${successor.workId}`);
  }
  if (successor.workId === predecessor.workId) throw new Error('CONTROLLER_RELAY_SUCCESSOR_IDENTITY_REUSE_FORBIDDEN');
  return successor;
}

/**
 * Bind an already-admitted GoalWorkloop successor to the currently claimed
 * ControllerRound. This stores only a mechanical handoff target: Goal/Plan
 * semantics were decided before this call and are revalidated through Work
 * lineage here. No successor Work is created by ControllerRound.
 */
export function bindControllerRoundSuccessorWork(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; successorWorkId: string; identity: ControllerRoundRelayIdentity; controllerAuthorityId?: string },
): ControllerRoundRelayRecord {
  const predecessor = getWorkContract(options, input.workId);
  if (!predecessor) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (predecessor.status !== 'completed') {
    throw new Error(`CONTROLLER_RELAY_SUCCESSOR_PREDECESSOR_NOT_COMPLETED: ${predecessor.workId}:${predecessor.status}`);
  }
  const initial = readRelayRecord(options, predecessor.workId);
  if (!initial) throw new Error(`CONTROLLER_RELAY_ROUND_NOT_OPEN: ${predecessor.workId}`);
  return relayLock(options, initial.value.relayScopeId, `controller-relay-bind-successor:${input.identity.controllerId}`, () => {
    const current = readRelayRecord(options, predecessor.workId);
    if (!current || !['claimed', 'failed'].includes(current.value.status)) {
      throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_REQUIRES_ACTIVE_OR_FAILED_PRECLAIM_ROUND: ${predecessor.workId}:${current?.value.status ?? 'missing'}`);
    }
    const failedPreclaim = current.value.status === 'failed';
    const expectedAuthorityId = current.value.authorityId?.trim() || '';
    const requestedAuthorityId = input.controllerAuthorityId?.trim() || '';
    if (expectedAuthorityId) {
      if (!requestedAuthorityId) throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_REQUIRED: ${predecessor.workId}`);
      if (requestedAuthorityId !== expectedAuthorityId) throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_MISMATCH: ${predecessor.workId}`);
      const principalId = input.identity.principalId.trim();
      if (!principalId || current.value.controllerId !== input.identity.controllerId || current.value.principalId !== principalId) {
        throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_MISMATCH: ${predecessor.workId}`);
      }
      if (relayControllerType(current.value) !== input.identity.controllerType) {
        throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_MISMATCH: ${predecessor.workId}`);
      }
      const liveOwner = getControllerSession(options, predecessor.workId);
      if (failedPreclaim) {
        if (current.value.lifecycleStage !== 'dispatching' || current.value.claimGeneration !== 0 || liveOwner) {
          throw new Error(`CONTROLLER_RELAY_FAILED_SUCCESSOR_HANDOFF_PRECLAIM_REQUIRED: ${predecessor.workId}`);
        }
      } else {
        if (current.value.claimGeneration < 1) {
          throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_MISMATCH: ${predecessor.workId}`);
        }
        if (liveOwner) {
          const livePrincipal = liveOwner.principalId?.trim() || liveOwner.controllerId;
          if (liveOwner.controllerId !== input.identity.controllerId
            || liveOwner.controllerType !== input.identity.controllerType
            || livePrincipal !== principalId) {
            throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_MISMATCH: ${predecessor.workId}`);
          }
        }
      }
    } else {
        if (failedPreclaim) throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_REQUIRED: ${predecessor.workId}`);
      // Legacy claimed rounds have no opaque per-round capability. Preserve only
      // their exact live owner epoch; rollover is available after the round has
      // been upgraded by the canonical launcher/recovery path.
      const owner = assertControllerOwner(options, predecessor.workId, input.identity);
      if (current.value.controllerId !== owner.controllerId
        || current.value.principalId !== (owner.principalId?.trim() || owner.controllerId)
        || current.value.claimGeneration !== owner.claimGeneration) {
        throw new Error(`CONTROLLER_RELAY_SUCCESSOR_BIND_AUTHORITY_MISMATCH: ${predecessor.workId}`);
      }
    }
    const successor = assertControllerRoundSuccessorLineage(options, predecessor, input.successorWorkId.trim());
    if (failedPreclaim) {
      const at = nowIso(options);
      const successorStateFingerprint = mechanicalStateFingerprint(options, successor, current.value.requirementId, current.value.relayScopeId, current.value.handoffId);
      return withControlPlaneTransaction(options.controllerHome, (database) => {
        const predecessorRelay = readControlPlaneRecordWithinTransaction<ControllerRoundRelayRecord>(
          database, NAMESPACE, options.repoId, predecessor.workId,
        );
        if (!predecessorRelay || predecessorRelay.value.status !== 'failed' || predecessorRelay.value.claimGeneration !== 0) {
          throw new Error(`CONTROLLER_RELAY_FAILED_SUCCESSOR_HANDOFF_STALE: ${predecessor.workId}`);
        }
        const existingSuccessorRelay = readControlPlaneRecordWithinTransaction<ControllerRoundRelayRecord>(
          database, NAMESPACE, options.repoId, successor.workId,
        );
        if (existingSuccessorRelay) {
          if (existingSuccessorRelay.value.relayScopeId === current.value.relayScopeId
            && ['dispatching', 'dispatched', 'claimed'].includes(existingSuccessorRelay.value.status)) {
            return existingSuccessorRelay.value;
          }
          throw new Error(`CONTROLLER_RELAY_SUCCESSOR_ALREADY_HAS_ROUND: ${successor.workId}`);
        }
        const decision = atomicTransitionDecisionOrThrow(decideControllerRoundTransition(predecessorRelay.value, {
          type: 'failed_dispatch_successor_handoff',
          at,
          successorWorkId: successor.workId,
          successorStateFingerprint,
          proposedAuthorityId: newControllerRoundAuthorityId(),
        }));
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: NAMESPACE, scope: options.repoId, key: predecessor.workId, schemaVersion: SCHEMA_VERSION,
          value: decision.next, action: decision.action, expectedRevision: predecessorRelay.revision,
        });
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: NAMESPACE, scope: options.repoId, key: decision.relatedWorkId, schemaVersion: SCHEMA_VERSION,
          value: decision.relatedNext, action: decision.relatedAction, expectedRevision: null,
        });
        return decision.relatedNext;
      });
    }
    return applyControllerRoundTransition(options, current, {
      type: 'successor_bound', at: nowIso(options), successorWorkId: successor.workId,
    });
  });
}

function sameAssistantContextSnapshot(
  left: AssistantContextSnapshot | undefined,
  right: AssistantContextSnapshot | null | undefined,
): boolean {
  if (right === undefined) return true;
  if (right === null) return left === undefined;
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatedAssistantContextUsage(
  record: ControllerRoundRelayRecord,
  input: SubmitControllerRoundDispositionInput,
): AssistantContextUsage[] {
  const usage = input.assistantContextUsage ?? [];
  if (!Array.isArray(usage) || usage.length > 32) throw new Error('CONTROLLER_ASSISTANT_CONTEXT_USAGE_LIMIT');
  const snapshot = record.assistantContextSnapshot;
  const digest = input.assistantContextDigest?.trim();
  if (usage.length > 0 && (!snapshot || !digest)) throw new Error('CONTROLLER_ASSISTANT_CONTEXT_SNAPSHOT_REQUIRED');
  if (digest && (!snapshot || digest !== snapshot.digest)) throw new Error('CONTROLLER_ASSISTANT_CONTEXT_DIGEST_MISMATCH');
  if (!usage.length) return [];
  const expected = new Map(snapshot!.items.map((item) => [`${item.kind}:${item.itemId}`, item]));
  const seen = new Set<string>();
  for (const item of usage) {
    const key = `${item.kind}:${item.itemId}`;
    if (!expected.has(key) || seen.has(key) || !['used', 'rejected'].includes(item.decision)
      || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1_000
      || (item.rejectionKind !== undefined && !['irrelevant', 'stale', 'contradicted'].includes(item.rejectionKind))
      || (item.decision === 'used' && item.rejectionKind !== undefined)) {
      throw new Error('CONTROLLER_ASSISTANT_CONTEXT_USAGE_INVALID');
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) throw new Error('CONTROLLER_ASSISTANT_CONTEXT_USAGE_INCOMPLETE');
  return usage.map((item) => ({
    ...item,
    reason: item.reason.trim(),
    // Missing rejectionKind is accepted only for frozen clients and means ordinary
    // irrelevance. Forge never derives stale/contradicted semantics from prose.
    ...(item.decision === 'rejected' ? { rejectionKind: item.rejectionKind ?? 'irrelevant' as const } : {}),
  }));
}

function persistClaimedAssistantContextSnapshot(
  options: ControllerRoundRelayStoreOptions,
  record: ControllerRoundRelayRecord,
  requested: AssistantContextSnapshot | null | undefined,
  at: string,
): ControllerRoundRelayRecord {
  if (requested === undefined || sameAssistantContextSnapshot(record.assistantContextSnapshot, requested)) return record;
  if (record.assistantContextSnapshot) {
    throw new Error(`CONTROLLER_ASSISTANT_CONTEXT_CLAIM_MISMATCH: ${record.originWorkId}`);
  }
  if (requested === null) return record;
  const current = readRelayRecord(options, record.originWorkId);
  if (!current || current.value.relayScopeId !== record.relayScopeId || current.value.status !== 'claimed'
    || current.value.claimGeneration !== record.claimGeneration) {
    throw new Error(`CONTROLLER_ASSISTANT_CONTEXT_CLAIM_STALE: ${record.originWorkId}`);
  }
  if (current.value.assistantContextSnapshot) {
    if (sameAssistantContextSnapshot(current.value.assistantContextSnapshot, requested)) return current.value;
    throw new Error(`CONTROLLER_ASSISTANT_CONTEXT_CLAIM_MISMATCH: ${record.originWorkId}`);
  }
  const next: ControllerRoundRelayRecord = { ...current.value, assistantContextSnapshot: requested, updatedAt: at };
  writeControlPlaneRecord(options.controllerHome, {
    namespace: NAMESPACE, scope: options.repoId, key: record.originWorkId, schemaVersion: SCHEMA_VERSION, value: next,
    action: 'controller_round_assistant_context_bound', expectedRevision: current.revision,
  });
  return next;
}

function pendingQualitySignals(record: ControllerRoundRelayRecord): ExecutionQualitySignal[] {
  const handled = new Set(record.qualityDecisions?.map(decision => decision.fingerprint) ?? []);
  return deriveClosedRoundQualitySignals(record.observationWindow ?? [], { repeatedStateCount: record.repeatedStateCount,
    maxRepeatedState: record.maxRepeatedState, waiting: record.status === 'waiting' || record.status === 'waiting_for_user',
    roundRef: `${record.relayScopeId}:${record.roundCount}` }).map(signal => ({ ...signal,
      fingerprint: createHash('sha256').update(JSON.stringify([signal.code, [...signal.evidenceRefs].sort()])).digest('hex'),
    })).filter(signal => !handled.has(signal.fingerprint));
}

function closedRoundObservation(work: WorkContract, roundRef: string, stateFingerprint: string, waiting: boolean, assistantContext: AssistantContextSnapshot | undefined, assistantContextUsage: AssistantContextUsage[]): ClosedRoundObservation {
  const coverageGaps: string[] = [];
  const verifications: ClosedRoundObservation['verifications'] = [];
  for (const check of work.checkRefs.slice(-32)) {
    const receipt = check.receipt;
    // HEAD alone does not identify dirty source. Require the exact input fingerprint.
    if (!receipt || !check.verificationInputFingerprint || !receipt.checkDefinitionDigest || !receipt.checkEnvironmentFingerprint) {
      coverageGaps.push('check_identity_incomplete'); continue;
    }
    if (receipt.status !== 'passed' && receipt.status !== 'failed') continue;
    verifications.push({ checkId: `${receipt.checkId}:${receipt.checkDefinitionDigest}`, sourceDigest: check.verificationInputFingerprint,
      environment: receipt.checkEnvironmentFingerprint, outcome: receipt.status, evidenceRef: receipt.receiptId });
  }
  // Generic evidence references without content identity cannot prove absence of new knowledge.
  if (work.evidenceRefs.length) coverageGaps.push('generic_evidence_content_identity_unavailable');
  if (work.checkRefs.length > 32) coverageGaps.push('check_window_truncated');
  if (!assistantContext) coverageGaps.push('assistant_context_snapshot_unavailable');
  else if (assistantContext.items.length > 0 && assistantContextUsage.length === 0) coverageGaps.push('assistant_context_usage_unreported');
  const accepted = work.semanticAcceptanceEvidence ?? [];
  if (accepted.length > 32) coverageGaps.push('accepted_result_window_truncated');
  return { roundRef, workId: work.workId, requirementId: work.requirementId, planId: work.planId,
    designVersion: work.engineeringContext?.sourceIdentity.kind === 'revision' ? work.engineeringContext.sourceIdentity.revision : undefined,
    rootCauses: (work.engineeringContext?.blockerDispositions ?? []).slice(-32).filter(disposition => disposition.classification === 'same_root_cause')
      .map(disposition => ({ dispositionRef: disposition.receiptId, rootCauseId: disposition.blockerId,
        designScope: JSON.stringify([...disposition.semanticScopeKeys].sort()), controllerConfirmed: true })),
    stateFingerprint, waiting, coverageGaps: [...new Set(coverageGaps)], verifications, assistantContext, assistantContextUsage,
    evidenceIdentities: work.checkRefs.slice(-32).flatMap(check => check.receipt ? [check.receipt.resultDigest] : []),
    acceptedResultIdentities: accepted.slice(-32).map(result => createHash('sha256').update(JSON.stringify([result.criterion, [...result.evidenceIds].sort()])).digest('hex')) };
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
    const terminalAuthorityId = bounded(input.terminalAuthorityId, 256);
    const providerWaitTerminalGoalComplete = terminal
      && work.status === 'completed'
      && input.disposition === 'goal_complete'
      && existing.value.status === 'waiting_for_user'
      && controllerRoundBlockerClass(existing.value) === 'provider_user_action_required';
    if (providerWaitTerminalGoalComplete) {
      if (!terminalAuthorityId || terminalAuthorityId !== existing.value.authorityId) {
        throw new Error(`CONTROLLER_RELAY_TERMINAL_AUTHORITY_MISMATCH: ${work.workId}`);
      }
    } else if (existing.value.status !== 'claimed') {
      throw new Error(`CONTROLLER_RELAY_ROUND_NOT_CLAIMED: ${existing.value.status}`);
    }
    const terminalSuccessor = terminal
      && work.status === 'completed'
      && input.disposition === 'continue_immediately'
      && existing.value.successorWorkId
      ? assertControllerRoundSuccessorLineage(options, work, existing.value.successorWorkId)
      : undefined;
    const terminalRoundClosureAllowed = terminal
      && work.status === 'completed'
      && (input.disposition === 'goal_complete' || Boolean(terminalSuccessor));
    if (terminal && !terminalRoundClosureAllowed) {
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
          if (existing.value.claimGeneration < 1 && !providerWaitTerminalGoalComplete) throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_REQUIRED: ${work.workId}`);
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
    const assistantContextUsage = validatedAssistantContextUsage(existing.value, input);
    const at = nowIso(options);
    const qualityDecisions = input.executionQualityDecisions ?? [];
    if (!Array.isArray(qualityDecisions) || qualityDecisions.length > 8) throw new Error('CONTROLLER_QUALITY_DECISION_LIMIT');
    const pending = new Set(pendingQualitySignals(existing.value).map(signal => signal.fingerprint));
    const normalizedQualityDecisions: ExecutionQualityDecision[] = [];
    for (const decision of qualityDecisions) {
      if (!pending.has(decision.fingerprint) || !['no_adjustment', 'adjustment'].includes(decision.action)
        || typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > 1000
        || decision.action === 'adjustment' && (typeof decision.verificationCondition !== 'string' || !decision.verificationCondition.trim() || decision.verificationCondition.length > 1000)) {
        throw new Error('CONTROLLER_QUALITY_DECISION_INVALID');
      }
      normalizedQualityDecisions.push({ ...decision, decidedAt: at });
      pending.delete(decision.fingerprint);
    }
    const knownDecisions = [...(existing.value.qualityDecisions ?? []), ...normalizedQualityDecisions];
    const submittedAdjustmentResults = input.executionQualityAdjustmentResults ?? [];
    if (!Array.isArray(submittedAdjustmentResults) || submittedAdjustmentResults.length > 8) throw new Error('CONTROLLER_QUALITY_ADJUSTMENT_RESULT_LIMIT');
    const knownResultFingerprints = new Set((existing.value.qualityAdjustmentResults ?? []).map(result => result.fingerprint));
    const normalizedAdjustmentResults: ExecutionQualityAdjustmentResult[] = [];
    for (const submitted of submittedAdjustmentResults) {
      const decision = knownDecisions.find(candidate => candidate.fingerprint === submitted.fingerprint);
      const refs = Array.isArray(submitted.evidenceRefs) ? submitted.evidenceRefs.map(ref => String(ref).trim()).filter(Boolean) : [];
      if (!decision || decision.action !== 'adjustment' || !decision.decidedAt
        || !['improved', 'not_improved', 'inconclusive'].includes(submitted.outcome)
        || typeof submitted.reason !== 'string' || !submitted.reason.trim() || submitted.reason.length > 1000
        || refs.length < 1 || refs.length > 16 || new Set(refs).size !== refs.length
        || knownResultFingerprints.has(submitted.fingerprint)) {
        throw new Error('CONTROLLER_QUALITY_ADJUSTMENT_RESULT_INVALID');
      }
      const decidedAt = Date.parse(decision.decidedAt);
      if (!Number.isFinite(decidedAt) || refs.some(ref => {
        const check = work.checkRefs.find(candidate => candidate.receipt?.receiptId === ref);
        return !check || !check.receipt || !Number.isFinite(Date.parse(check.recordedAt)) || Date.parse(check.recordedAt) <= decidedAt;
      })) throw new Error('CONTROLLER_QUALITY_ADJUSTMENT_VERIFICATION_EVIDENCE_INVALID');
      normalizedAdjustmentResults.push({ fingerprint: submitted.fingerprint, outcome: submitted.outcome, evidenceRefs: refs, reason: submitted.reason.trim(), verifiedAt: at });
      knownResultFingerprints.add(submitted.fingerprint);
    }
    const requestedMaxRounds = boundedInteger(input.maxRounds, DEFAULT_MAX_ROUNDS, 1, 32);
    const requestedMaxRepeatedState = boundedInteger(input.maxRepeatedState, DEFAULT_MAX_REPEATED_STATE, 1, 8);
    const requestedMaxFailures = boundedInteger(input.maxFailures, DEFAULT_MAX_FAILURES, 1, 8);
    const handoffId = bounded(input.handoffId, 200);
    const stateFingerprint = bounded(input.stateFingerprint, 256)
      ?? mechanicalStateFingerprint(options, terminalSuccessor ?? work, requirementId, relayScopeId, handoffId ?? existing.value.handoffId);
    const bindingId = bounded(input.bindingId, 500) ?? existing.value.bindingId;
    if (input.disposition === 'wait_for_user') {
      if (!handoffId) throw new Error('CONTROLLER_RELAY_WAIT_FOR_USER_HANDOFF_REQUIRED');
      const handoff = getHandoffItem(options, handoffId);
      if (!handoff) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
      if (isTerminalHandoffStatus(handoff.status)) throw new Error(`CONTROLLER_RELAY_HANDOFF_TERMINAL: ${handoff.status}`);
      if (handoff.workId && handoff.workId !== work.workId) throw new Error(`CONTROLLER_RELAY_HANDOFF_WORK_MISMATCH: ${handoffId}`);
    }
    const observationWindow = [
      ...(existing.value.observationWindow ?? []),
      closedRoundObservation(work, `${relayScopeId}:${existing.value.roundCount}`, stateFingerprint, input.disposition === 'wait' || input.disposition === 'wait_for_user', existing.value.assistantContextSnapshot, assistantContextUsage),
    ].slice(-8);
    const accumulatedQualityDecisions = [...(existing.value.qualityDecisions ?? []), ...normalizedQualityDecisions].slice(-64);
    const accumulatedQualityAdjustmentResults = [...(existing.value.qualityAdjustmentResults ?? []), ...normalizedAdjustmentResults].slice(-64);
    return applyControllerRoundTransition(options, existing, {
      type: 'semantic_disposition_submitted', at, disposition: input.disposition, stateFingerprint,
      maxRounds: requestedMaxRounds, maxRepeatedState: requestedMaxRepeatedState, maxFailures: requestedMaxFailures,
      controllerSession: authority,
      ...(providerWaitTerminalGoalComplete ? { terminalGoalComplete: true } : {}),
      qualityDecisions: accumulatedQualityDecisions, qualityAdjustmentResults: accumulatedQualityAdjustmentResults, observationWindow,
      ...(handoffId ? { handoffId } : {}),
      ...(bounded(input.reason, 1_000) ? { reason: bounded(input.reason, 1_000) } : {}),
      ...(bindingId ? { bindingId } : {}),
    });
  });
}

/**
 * Observe that the exact provider Controller turn has settled. If the Work is
 * still nonterminal and the Controller did not explicitly close the round,
 * canonical Kernel policy creates the continuation obligation. Provider
 * adapters supply only completion evidence; they do not choose the disposition.
 */
export function settleControllerRoundAfterTurn(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; completionEvidenceId: string },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial) return undefined;
  return relayLock(options, initial.value.relayScopeId, `controller-turn-settled:${input.workId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current) return undefined;
    const completionEvidenceId = bounded(input.completionEvidenceId, 500);
    if (!completionEvidenceId) throw new Error('CONTROLLER_RELAY_TURN_COMPLETION_EVIDENCE_REQUIRED');
    const work = getWorkContract(options, input.workId);
    if (!work) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
    const at = nowIso(options);
    const successor = work.status === 'completed' && current.value.successorWorkId
      ? getWorkContract(options, current.value.successorWorkId)
      : undefined;
    const terminalSuccessorContinuation = Boolean(successor && !isTerminalWorkContractStatus(successor.status));
    if (isTerminalWorkContractStatus(work.status) && !terminalSuccessorContinuation) {
      return applyControllerRoundTransition(options, current, {
        type: 'terminal_work_observed', at, error: `Controller turn settled after terminal Work ${work.status}`,
      });
    }
    const semanticWork = successor ?? work;
    const blockingHandoff = relevantHandoffs(options, relevantWork(options, current.value), current.value.handoffId)
      .find((handoff) => Boolean(handoff.blockingDecision?.trim())
        && (handoff.workId === semanticWork.workId || handoff.id === current.value.handoffId));
    const stateFingerprint = mechanicalStateFingerprint(options, semanticWork, current.value.requirementId, current.value.relayScopeId, current.value.handoffId);
    return applyControllerRoundTransition(options, current, {
      type: 'controller_turn_settled', at, stateFingerprint, completionEvidenceId,
      ...(blockingHandoff ? { blockingHandoffId: blockingHandoff.id } : {}),
    });
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
  const occurrenceId = bounded(input.occurrenceId, 500);

  return relayLock(options, relayScopeId, `controller-relay-launch:${input.identity.controllerId}`, () => {
    const existing = readRelayRecord(options, work.workId);
    if (existing && existing.value.relayScopeId !== relayScopeId) {
      throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: Work ${work.workId} is already bound to ${existing.value.relayScopeId}`);
    }
    if (existing) {
      const requestedControllerId = input.identity.controllerId.trim().slice(0, 240) || 'controller-host';
      const requestedPrincipalId = input.identity.principalId.trim().slice(0, 240) || requestedControllerId;
      const reusableUnsubmittedRelay = existing.value.originWorkId === work.workId
        && ['pending_release', 'dispatching'].includes(existing.value.status)
        && existing.value.controllerId === requestedControllerId
        && relayControllerType(existing.value) === input.identity.controllerType
        && existing.value.principalId === requestedPrincipalId
        && Boolean(existing.value.authorityId?.trim())
        && !existing.value.providerDispatchEffectId
        && !existing.value.providerDispatchStartedAt
        && !existing.value.providerDispatchReceiptId
        && (existing.value.providerDispatchAttempt ?? 0) === 0
        && (existing.value.occurrenceId ?? '') === (occurrenceId ?? '');
      if (reusableUnsubmittedRelay) return existing.value;
    }
    const previous = relayHistory(options, relayScopeId)[0];
    const abandonedReleasedRound = previous?.status === 'failed' && previous.failureClass === 'abandoned_release';
    const stateFingerprint = mechanicalStateFingerprint(options, work, requirementId, relayScopeId);
    return applyControllerRoundTransition(options, existing, {
      type: 'occurrence_requested', at: nowIso(options), repoId: options.repoId, relayScopeId, originWorkId: work.workId,
      ...(requirementId ? { requirementId } : {}), identity: input.identity, stateFingerprint, proposedAuthorityId: newControllerRoundAuthorityId(),
      maxRounds: boundedInteger(input.maxRounds, DEFAULT_MAX_ROUNDS, 1, 32), maxRepeatedState: boundedInteger(input.maxRepeatedState, DEFAULT_MAX_REPEATED_STATE, 1, 8),
      maxFailures: boundedInteger(input.maxFailures, DEFAULT_MAX_FAILURES, 1, 8),
      ...(bounded(input.bindingId, 500) ? { bindingId: bounded(input.bindingId, 500) } : {}), ...(occurrenceId ? { occurrenceId } : {}),
      ...(input.allowSemanticWaitRecovery ? { allowSemanticWaitRecovery: true } : {}),
      abandonedReleaseRecovery: Boolean(abandonedReleasedRound),
    });
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
    if (record.successorWorkId) {
      const predecessor = getWorkContract(options, input.workId);
      if (!predecessor || predecessor.status !== 'completed') {
        throw new Error(`CONTROLLER_RELAY_SUCCESSOR_PREDECESSOR_NOT_COMPLETED: ${input.workId}:${predecessor?.status ?? 'missing'}`);
      }
      const successor = assertControllerRoundSuccessorLineage(options, predecessor, record.successorWorkId);
      const successorStateFingerprint = mechanicalStateFingerprint(options, successor, record.requirementId, record.relayScopeId, record.handoffId);
      return withControlPlaneTransaction(options.controllerHome, (database) => {
        const predecessorRelay = readControlPlaneRecordWithinTransaction<ControllerRoundRelayRecord>(
          database, NAMESPACE, options.repoId, input.workId,
        );
        if (!predecessorRelay || predecessorRelay.value.status !== 'pending_release' || predecessorRelay.value.successorWorkId !== successor.workId) {
          throw new Error(`CONTROLLER_RELAY_SUCCESSOR_HANDOFF_STALE: ${input.workId}`);
        }
        const existingSuccessorRelay = readControlPlaneRecordWithinTransaction<ControllerRoundRelayRecord>(
          database, NAMESPACE, options.repoId, successor.workId,
        );
        if (existingSuccessorRelay) {
          if (existingSuccessorRelay.value.relayScopeId === record.relayScopeId
            && ['dispatching', 'dispatched', 'claimed'].includes(existingSuccessorRelay.value.status)) {
            return existingSuccessorRelay.value;
          }
          throw new Error(`CONTROLLER_RELAY_SUCCESSOR_ALREADY_HAS_ROUND: ${successor.workId}`);
        }
        const decision = atomicTransitionDecisionOrThrow(decideControllerRoundTransition(predecessorRelay.value, {
          type: 'successor_release_handoff', at, successorWorkId: successor.workId, successorStateFingerprint, proposedAuthorityId: newControllerRoundAuthorityId(),
        }));
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: NAMESPACE, scope: options.repoId, key: predecessor.workId, schemaVersion: SCHEMA_VERSION,
          value: decision.next, action: decision.action, expectedRevision: predecessorRelay.revision,
        });
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: NAMESPACE, scope: options.repoId, key: decision.relatedWorkId, schemaVersion: SCHEMA_VERSION,
          value: decision.relatedNext, action: decision.relatedAction, expectedRevision: null,
        });
        return decision.relatedNext;
      });
    }
    return applyControllerRoundTransition(options, current, {
      type: 'controller_release_observed', at, proposedAuthorityId: newControllerRoundAuthorityId(),
    });
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
    ) {
      throw new Error(`CONTROLLER_RELAY_RELEASE_FENCE_MISMATCH: ${input.workId}`);
    }
    if (getControllerSession(options, input.workId)) {
      throw new Error(`CONTROLLER_RELAY_ABANDONED_RELEASE_ACTIVE_CLAIM: ${input.workId}`);
    }
    const work = getWorkContract(options, input.workId);
    // Completed Work still requires semantic goal_complete or a valid terminal
    // successor. Failed/cancelled Work has no legal semantic continuation, so
    // its exact released controller epoch may mechanically abandon the claimed
    // round and free the relay scope for later recovery/replanning.
    if (!work || work.status === 'completed') return undefined;

    return applyControllerRoundTransition(options, current, {
      type: 'abandoned_release_observed', at: nowIso(options), error: CONTROLLER_RELAY_ABANDONED_RELEASE_ERROR,
    });
  });
}

/**
 * Mechanically retire any surviving ControllerRound once Work lifecycle authority
 * is durably failed/cancelled and no Controller lease remains. This is cleanup,
 * not a semantic disposition: completed Work is intentionally excluded.
 */
export function reconcileControllerRoundAfterTerminalWork(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; actor?: string },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial) return undefined;
  const work = getWorkContract(options, input.workId);
  if (!work || !['failed', 'cancelled'].includes(work.status)) return undefined;
  if (getControllerSession(options, input.workId)) {
    throw new Error(`CONTROLLER_RELAY_TERMINAL_WORK_ACTIVE_CLAIM: ${input.workId}`);
  }
  if (initial.value.status === 'failed') return initial.value;
  return relayLock(options, initial.value.relayScopeId, input.actor ?? `controller-relay-terminal-work:${input.workId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current) return undefined;
    const currentWork = getWorkContract(options, input.workId);
    if (!currentWork || !['failed', 'cancelled'].includes(currentWork.status)) return undefined;
    if (getControllerSession(options, input.workId)) {
      throw new Error(`CONTROLLER_RELAY_TERMINAL_WORK_ACTIVE_CLAIM: ${input.workId}`);
    }
    if (current.value.status === 'failed') return current.value;
    return applyControllerRoundTransition(options, current, {
      type: 'terminal_work_observed', at: nowIso(options), error: `CONTROLLER_RELAY_TERMINAL_WORK_RETIRED:${input.workId}`,
    });
  });
}

export function beginControllerRoundProviderDispatch(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; authorityId: string; expectedUpdatedAt: string; bindingId?: string },
): ControllerRoundRelayRecord {
  const initial = readRelayRecord(options, input.workId);
  if (!initial) throw new Error(`CONTROLLER_RELAY_PROVIDER_DISPATCH_RELAY_REQUIRED: ${input.workId}`);
  return relayLock(options, initial.value.relayScopeId, `controller-provider-dispatch-start:${input.workId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current) throw new Error(`CONTROLLER_RELAY_PROVIDER_DISPATCH_RELAY_REQUIRED: ${input.workId}`);
    if (current.value.status !== 'dispatching') throw new Error(`CONTROLLER_RELAY_DISPATCH_STATE_INVALID:${current.value.status}`);
    if (current.value.authorityId !== input.authorityId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_DISPATCH_AUTHORITY_MISMATCH: ${input.workId}`);
    if (current.value.updatedAt !== input.expectedUpdatedAt.trim()) {
      if (current.value.providerDispatchStartedAt) throw new Error(`CONTROLLER_CONTINUATION_ALREADY_DISPATCHING:${input.workId}`);
      throw new Error(`CONTROLLER_RELAY_PROVIDER_DISPATCH_STALE: ${input.workId}`);
    }
    if (current.value.providerDispatchStartedAt) throw new Error(`CONTROLLER_CONTINUATION_ALREADY_DISPATCHING:${input.workId}`);
    const providerDispatchEffectId = controllerRoundProviderEffectId(current.value.relayScopeId, input.authorityId);
    return applyControllerRoundTransition(options, current, {
      type: 'provider_dispatch_started', at: nowIso(options), providerDispatchEffectId,
      ...(bounded(input.bindingId, 500) ? { bindingId: bounded(input.bindingId, 500) } : {}),
    });
  });
}

export function finishControllerRoundRelayDispatch(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; ok: boolean; bindingId?: string; providerDispatchEffectId?: string; providerDispatchReceiptId?: string; error?: string; recovery?: boolean; outcomeUnknown?: boolean; waitForUser?: boolean; handoffId?: string; nowMs?: number },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial || initial.value.status !== 'dispatching') return initial?.value;
  return relayLock(options, initial.value.relayScopeId, `controller-relay-finish:${input.workId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current || current.value.status !== 'dispatching') return current?.value;
    const at = typeof input.nowMs === 'number' ? new Date(input.nowMs).toISOString() : nowIso(options);
    const handoffId = bounded(input.handoffId, 200);
    if (input.waitForUser) {
      if (!handoffId) throw new Error('CONTROLLER_RELAY_WAIT_FOR_USER_HANDOFF_REQUIRED');
      const handoff = getHandoffItem(options, handoffId);
      if (!handoff) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
      if (isTerminalHandoffStatus(handoff.status)) throw new Error(`CONTROLLER_RELAY_HANDOFF_TERMINAL: ${handoff.status}`);
      if (handoff.workId && handoff.workId !== input.workId) throw new Error(`CONTROLLER_RELAY_HANDOFF_WORK_MISMATCH: ${handoffId}`);
    }
    const error = bounded(input.error, 2_000) ?? (input.outcomeUnknown
      ? 'CONTROLLER_RELAY_PROVIDER_DISPATCH_OUTCOME_UNKNOWN'
      : input.waitForUser
        ? 'CONTROLLER_RELAY_WAIT_FOR_USER'
        : input.recovery
          ? 'CONTROLLER_RELAY_RECOVERY_FAILED'
          : 'CONTROLLER_RELAY_DISPATCH_FAILED');
    const providerDispatchEffectId = bounded(input.providerDispatchEffectId, 500)
      ?? (current.value.authorityId ? controllerRoundProviderEffectId(current.value.relayScopeId, current.value.authorityId) : undefined);
    let event: ControllerRoundTransitionEvent;
    if (input.ok) {
      if (!providerDispatchEffectId) throw new Error('CONTROLLER_RELAY_PROVIDER_EFFECT_ID_REQUIRED');
      event = { type: 'provider_dispatch_succeeded', at, providerDispatchEffectId, ...(bounded(input.bindingId, 500) ? { bindingId: bounded(input.bindingId, 500) } : {}), ...(bounded(input.providerDispatchReceiptId, 500) ? { providerDispatchReceiptId: bounded(input.providerDispatchReceiptId, 500) } : {}) };
    } else if (input.outcomeUnknown) {
      const effectIdentity = providerDispatchEffectId;
      if (!effectIdentity) throw new Error('CONTROLLER_RELAY_PROVIDER_EFFECT_ID_REQUIRED');
      event = { type: 'provider_dispatch_outcome_unknown', at, error, providerDispatchEffectId: effectIdentity };
    } else if (input.waitForUser) {
      event = { type: 'provider_user_action_required', at, error, handoffId: handoffId! };
    } else {
      const nextFailureCount = current.value.consecutiveFailures + 1;
      const recoveryDelayMs = Math.min(MAX_STALLED_RECOVERY_BACKOFF_MS, DEFAULT_STALLED_RECOVERY_BACKOFF_MS * 2 ** Math.max(0, nextFailureCount - 1));
      event = { type: 'provider_dispatch_failed', at, error, recovery: input.recovery === true, ...(input.recovery ? { nextRecoveryAt: new Date(Date.parse(at) + recoveryDelayMs).toISOString() } : {}) };
    }
    return applyControllerRoundTransition(options, current, event);
  });
}

export interface ClaimControllerRoundSessionInput {
  workId: string;
  relayWorkId: string;
  sessionClaim: ControllerSessionClaimInput & { principalId: string; controllerInstanceId: string };
  assistantContextSnapshot?: AssistantContextSnapshot | null;
  allowUserResume?: boolean;
}

/**
 * Atomically claim one relay-bound Work. Relay claimability is rechecked inside
 * the same BEGIN IMMEDIATE transaction that persists ControllerSession ownership.
 * A Requirement-scope inherited relay is fenced but not rewritten for a sibling Work.
 */
export function claimControllerRoundSession(
  options: ControllerRoundRelayStoreOptions,
  input: ClaimControllerRoundSessionInput,
): { session: ClaimedControllerSession; relay?: ControllerRoundRelayRecord } {
  const relayWorkId = input.relayWorkId.trim();
  const initial = readRelayRecord(options, relayWorkId);
  if (!initial) throw new Error(`CONTROLLER_RELAY_ROUND_NOT_OPEN: ${relayWorkId}`);
  return relayLock(options, initial.value.relayScopeId, `controller-relay-session-claim:${input.sessionClaim.controllerId}`, () => {
    const lockedRelay = readRelayRecord(options, relayWorkId);
    if (!lockedRelay || !controllerRoundRelayClaimable(lockedRelay.value, { allowUserResume: input.allowUserResume })) {
      throw new Error(`CONTROLLER_RELAY_CLAIM_STATE_INVALID:${lockedRelay?.value.status ?? 'missing'}`);
    }
    const repeatedStateFingerprint = controllerRoundBlockerClass(lockedRelay.value) === 'repeated_state'
      ? (() => {
          const work = getWorkContract(options, input.workId);
          if (!work || isTerminalWorkContractStatus(work.status)) throw new Error(`WORK_CONTROLLER_CLAIM_TERMINAL: ${input.workId}:${work?.status ?? 'missing'}`);
          return mechanicalStateFingerprint(options, work, lockedRelay.value.requirementId, lockedRelay.value.relayScopeId, lockedRelay.value.handoffId);
        })()
      : undefined;
    return withControllerSessionMutationLock(options, input.workId, `controller-relay-session-claim:${input.sessionClaim.controllerId}`, () => {
      assertControllerSessionWorkClaimable(options, input.workId);
      return withControlPlaneTransaction(options.controllerHome, (database) => {
        const current = readControlPlaneRecordWithinTransaction<ControllerRoundRelayRecord>(
          database, NAMESPACE, options.repoId, relayWorkId,
        );
        if (!current || !controllerRoundRelayClaimable(current.value, { allowUserResume: input.allowUserResume })) {
          throw new Error(`CONTROLLER_RELAY_CLAIM_STATE_INVALID:${current?.value.status ?? 'missing'}`);
        }
        if (input.sessionClaim.controllerType !== relayControllerType(current.value)) {
          throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${input.workId}`);
        }
        const session = resumeControllerSessionWithinTransaction(database, options, input.sessionClaim);
        if (relayWorkId !== input.workId) return { session };

        const at = nowIso(options);
        const blocker = controllerRoundBlockerClass(current.value);
        const event: ControllerRoundTransitionEvent = blocker === 'repeated_state'
          ? {
              type: 'semantic_state_changed', at,
              stateFingerprint: repeatedStateFingerprint!, session,
              principalId: input.sessionClaim.principalId,
              controllerInstanceId: input.sessionClaim.controllerInstanceId,
            }
          : {
              type: 'controller_claim_observed', at, session,
              principalId: input.sessionClaim.principalId,
              controllerInstanceId: input.sessionClaim.controllerInstanceId,
              ...(input.allowUserResume ? { userResume: true } : {}),
            };
        const decided = transitionDecisionOrThrow(decideControllerRoundTransition(current.value, event));
        let next = decided.record;
        const requested = input.assistantContextSnapshot;
        if (requested !== undefined && !sameAssistantContextSnapshot(next.assistantContextSnapshot, requested)) {
          if (next.assistantContextSnapshot) throw new Error(`CONTROLLER_ASSISTANT_CONTEXT_CLAIM_MISMATCH: ${input.workId}`);
          if (requested !== null) next = { ...next, assistantContextSnapshot: requested, updatedAt: at };
        }
        if (decided.changed || next !== decided.record) {
          writeControlPlaneRecordWithinTransaction(database, {
            namespace: NAMESPACE,
            scope: options.repoId,
            key: relayWorkId,
            schemaVersion: SCHEMA_VERSION,
            value: next,
            action: decided.action ?? 'controller_round_relay_claim_acknowledged',
            expectedRevision: current.revision,
          });
        }
        return { session, relay: next };
      });
    });
  });
}

export function acknowledgeControllerRoundClaim(
  options: ControllerRoundRelayStoreOptions,
  input: { workId: string; session: ControllerSession; assistantContextSnapshot?: AssistantContextSnapshot | null },
): ControllerRoundRelayRecord | undefined {
  const initial = readRelayRecord(options, input.workId);
  if (!initial) return undefined;
  const expectedControllerType = relayControllerType(initial.value);
  if (input.session.controllerType !== expectedControllerType) throw new Error(`CONTROLLER_RELAY_CONTROLLER_TYPE_MISMATCH: ${input.workId}`);

  return relayLock(options, initial.value.relayScopeId, `controller-relay-claim:${input.session.controllerId}`, () => {
    const current = readRelayRecord(options, input.workId);
    if (!current) return undefined;
    if (current.value.status === 'claimed'
      && current.value.controllerId === input.session.controllerId
      && current.value.sessionId === input.session.sessionId
      && current.value.claimGeneration === input.session.claimGeneration
      && sameAssistantContextSnapshot(current.value.assistantContextSnapshot, input.assistantContextSnapshot)) return current.value;

    const blocker = controllerRoundBlockerClass(current.value);
    if (!controllerRoundRelayClaimable(current.value)) return current.value;

    const owner = getControllerSession(options, input.workId);
    const ownerPrincipal = owner?.principalId?.trim() || owner?.controllerId;
    const sessionPrincipal = input.session.principalId?.trim() || input.session.controllerId;
    if (
      !owner
      || owner.controllerType !== relayControllerType(current.value)
      || owner.controllerId !== input.session.controllerId
      || owner.sessionId !== input.session.sessionId
      || owner.claimGeneration !== input.session.claimGeneration
      || ownerPrincipal !== sessionPrincipal
      || (owner.controllerInstanceId?.trim() || '') !== (input.session.controllerInstanceId?.trim() || '')
    ) throw new Error(`CONTROLLER_RELAY_CLAIM_IDENTITY_MISMATCH: ${input.workId}`);
    // The dispatching relay records the provider/launcher identity until the
    // authenticated controller actually claims the round. The domain transition
    // policy owns that one-way identity handoff; duplicating an equality guard
    // here would turn provider dispatch metadata into a second claim authority.
    if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
      throw new Error(`CONTROLLER_RELAY_CLAIM_GENERATION_REQUIRED: ${input.workId}`);
    }
    const controllerInstanceId = owner.controllerInstanceId?.trim();
    if (!controllerInstanceId) throw new Error(`CONTROLLER_RELAY_CLAIM_INSTANCE_REQUIRED: ${input.workId}`);
    const at = nowIso(options);
    const session = owner as ControllerSession & { claimGeneration: number };

    if (blocker === 'repeated_state') {
      const work = getWorkContract(options, input.workId);
      if (!work || isTerminalWorkContractStatus(work.status)) return current.value;
      const stateFingerprint = mechanicalStateFingerprint(options, work, current.value.requirementId, current.value.relayScopeId, current.value.handoffId);
      const transitioned = applyControllerRoundTransition(options, current, {
        type: 'semantic_state_changed', at, stateFingerprint, session, principalId: ownerPrincipal!, controllerInstanceId,
      });
      return persistClaimedAssistantContextSnapshot(options, transitioned, input.assistantContextSnapshot, at);
    }

    const transitioned = applyControllerRoundTransition(options, current, {
      type: 'controller_claim_observed', at, session, principalId: ownerPrincipal!, controllerInstanceId,
    });
    return persistClaimedAssistantContextSnapshot(options, transitioned, input.assistantContextSnapshot, at);
  });
}

/**
 * Explicitly rekey one exact relay-bound Work after the caller lost the opaque
 * per-round capability with its MCP/ChatGPT transport. This is not a semantic
 * continuation and never dispatches a provider: it preserves the current
 * relay lineage and budgets, rotates only the capability epoch, and leaves the
 * standard controller_claim path responsible for mechanically acknowledging
 * the recovered round.
 */
export function recoverControllerRoundRelayAuthority(
  options: ControllerRoundRelayStoreOptions,
  input: RecoverControllerRoundRelayAuthorityInput,
): ControllerRoundRelayRecord {
  const workId = input.workId.trim();
  if (!workId) throw new Error('WORK_CONTROLLER_AUTHORITY_RECOVERY_WORK_REQUIRED');
  if (input.requestedBy !== 'user') {
    throw new Error('WORK_CONTROLLER_AUTHORITY_RECOVERY_USER_REQUIRED: relay authority rekey is an explicit user-directed recovery only.');
  }
  const work = getWorkContract(options, workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
  if (isTerminalWorkContractStatus(work.status)) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_TERMINAL: ${workId}:${work.status}`);
  }
  const initial = readRelayRecord(options, workId);
  if (!initial) throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_REQUIRED: ${workId}`);
  const expectedType = relayControllerType(initial.value);
  if (expectedType !== input.identity.controllerType) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_CONTROLLER_TYPE_MISMATCH: ${workId}`);
  }
  if (initial.value.controllerId !== input.identity.controllerId || initial.value.principalId !== input.identity.principalId) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_PRINCIPAL_MISMATCH: ${workId}`);
  }
  const recoverableStatuses: readonly ControllerRoundRelayStatus[] = ['pending_release', 'dispatching', 'dispatched', 'claimed', 'waiting_for_user', 'failed'];
  const initialRepeatedStateBlock = initial.value.status === 'blocked' && initial.value.blockedReason?.startsWith('repeated_state:');
  const initialConsecutiveFailureBlock = controllerRoundBlockerClass(initial.value) === 'consecutive_failures';
  const initialRecoveryReason = input.recoveryReason?.trim() ?? '';
  if (initialRepeatedStateBlock && !initialRecoveryReason) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_REASON_REQUIRED: ${workId}; repeated-state recovery must state why the bounded recovery is being opened.`);
  }
  if (!recoverableStatuses.includes(initial.value.status) && !initialRepeatedStateBlock && !initialConsecutiveFailureBlock) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_STATE_INVALID: ${workId}:${initial.value.status}`);
  }

  return relayLock(options, initial.value.relayScopeId, `controller-relay-explicit-recover:${workId}`, () => {
    const current = readRelayRecord(options, workId);
    if (!current) throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_REQUIRED: ${workId}`);
    const latest = relayHistory(options, current.value.relayScopeId)[0];
    if (!latest || latest.originWorkId !== workId || latest.updatedAt !== current.value.updatedAt) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_NOT_CURRENT: ${workId}`);
    }
    const currentRepeatedStateBlock = current.value.status === 'blocked' && current.value.blockedReason?.startsWith('repeated_state:');
    const currentConsecutiveFailureBlock = controllerRoundBlockerClass(current.value) === 'consecutive_failures';
    if (currentRepeatedStateBlock && !initialRecoveryReason) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_REASON_REQUIRED: ${workId}; repeated-state recovery must state why the bounded recovery is being opened.`);
    }
    if (!recoverableStatuses.includes(current.value.status) && !currentRepeatedStateBlock && !currentConsecutiveFailureBlock) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_STATE_INVALID: ${workId}:${current.value.status}`);
    }
    if (relayControllerType(current.value) !== input.identity.controllerType
      || current.value.controllerId !== input.identity.controllerId
      || current.value.principalId !== input.identity.principalId) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_PRINCIPAL_MISMATCH: ${workId}`);
    }
    const currentWork = getWorkContract(options, workId);
    if (!currentWork) throw new Error(`WORK_NOT_FOUND: ${workId}`);
    if (isTerminalWorkContractStatus(currentWork.status)) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_TERMINAL: ${workId}:${currentWork.status}`);
    }
    const activeWorks = recoveryFenceWork(options, current.value).filter((entry) => !isTerminalWorkContractStatus(entry.status));
    if (activeWorks.some((entry) => workHasActiveExecution(options.controllerHome, options.repoId, entry.workId))) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_ACTIVE_EXECUTION: ${workId}`);
    }
    const claimedWorks = activeWorks
      .map((entry) => ({ work: entry, owner: getControllerSession(options, entry.workId) }))
      .filter((entry): entry is typeof entry & { owner: NonNullable<typeof entry.owner> } => Boolean(entry.owner));
    if (claimedWorks.some((entry) => entry.work.workId !== workId)) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_ACTIVE_CLAIM: ${workId}`);
    }
    const currentOwner = claimedWorks.find((entry) => entry.work.workId === workId)?.owner;
    if (currentConsecutiveFailureBlock && currentOwner) {
      throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_ACTIVE_CLAIM: ${workId}`);
    }
    if (currentOwner) {
      const ownerPrincipal = controllerSessionPrincipalId(currentOwner);
      const ownerInstanceId = currentOwner.controllerInstanceId?.trim() || '';
      const samePrincipalOwner = currentOwner.controllerId === input.identity.controllerId
        && currentOwner.controllerType === input.identity.controllerType
        && ownerPrincipal === input.identity.principalId;
      const sameRuntimeOwner = ownerInstanceId === input.identity.controllerInstanceId;
      const canonicalRuntimeMigration = input.allowCanonicalRuntimeMigration === true
        && ownerInstanceId !== input.identity.controllerInstanceId;
      if (!samePrincipalOwner || (!sameRuntimeOwner && !canonicalRuntimeMigration)) {
        throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_ACTIVE_CLAIM: ${workId}`);
      }
      const released = releaseObservedControllerSession(options, {
        workId,
        actor: `controller-relay-explicit-authority-recovery:${workId}`,
        owner: currentOwner,
      });
      if (!released.allowed) {
        throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_ACTIVE_CLAIM: ${workId}:${released.reason}`);
      }
    }

    return applyControllerRoundTransition(options, current, {
      type: 'authority_recovery_requested', at: nowIso(options), proposedAuthorityId: newControllerRoundAuthorityId(),
      keepsConfirmedDispatch: current.value.status === 'dispatched',
      preserveBlockedState: currentConsecutiveFailureBlock,
      preserveWaitingForUserState: current.value.status === 'waiting_for_user',
      ...(initialRecoveryReason ? { reason: initialRecoveryReason } : {}),
    });
  });
}

export interface RetryFailedControllerRoundProviderDispatchInput {
  workId: string;
  relayScopeId: string;
  authorityId: string;
  expectedUpdatedAt: string;
  occurrenceId?: string;
}

/** Retry one known, non-ambiguous provider failure without creating a new semantic round or authority. */
export function retryFailedControllerRoundProviderDispatch(
  options: ControllerRoundRelayStoreOptions,
  input: RetryFailedControllerRoundProviderDispatchInput,
): ControllerRoundRelayRecord {
  const workId = input.workId.trim();
  const initial = readRelayRecord(options, workId);
  if (!initial) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_RELAY_REQUIRED:${workId}`);
  if (initial.value.relayScopeId !== input.relayScopeId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_SCOPE_MISMATCH:${workId}`);
  return relayLock(options, initial.value.relayScopeId, `controller-relay-provider-retry:${workId}`, () => {
    const current = readRelayRecord(options, workId);
    if (!current) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_RELAY_REQUIRED:${workId}`);
    if (current.value.updatedAt !== input.expectedUpdatedAt.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_STALE:${workId}`);
    if (current.value.relayScopeId !== input.relayScopeId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_SCOPE_MISMATCH:${workId}`);
    if ((current.value.authorityId?.trim() || '') !== input.authorityId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_AUTHORITY_MISMATCH:${workId}`);
    const work = getWorkContract(options, workId);
    if (!work || isTerminalWorkContractStatus(work.status)) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_WORK_TERMINAL:${workId}:${work?.status ?? 'missing'}`);
    const requirement = requirementForRelay(options, current.value.requirementId);
    if (requirement && !['planned', 'active'].includes(requirement.state)) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_REQUIREMENT_TERMINAL:${requirement.state}`);
    if (workHasActiveExecution(options.controllerHome, options.repoId, workId)) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_ACTIVE_EXECUTION:${workId}`);
    if (getControllerSession(options, workId)) throw new Error(`CONTROLLER_RELAY_PROVIDER_RETRY_ACTIVE_CLAIM:${workId}`);
    return applyControllerRoundTransition(options, current, {
      type: 'provider_retry_requested', at: nowIso(options), occurrenceId: input.occurrenceId?.trim() || undefined,
    });
  });
}

export interface RearmControllerRoundAfterProviderRecoveryInput {
  workId: string;
  relayScopeId: string;
  authorityId: string;
  expectedUpdatedAt: string;
  evidenceId: string;
}

export interface BindLegacyControllerRoundOccurrenceInput {
  workId: string;
  relayScopeId: string;
  occurrenceId: string;
  authorityId: string;
  expectedUpdatedAt: string;
  identity: Pick<ControllerRoundRelayIdentity, 'controllerId' | 'controllerType' | 'principalId'>;
}

export interface RearmControllerRoundAfterProviderUserActionInput {
  workId: string;
  handoffId: string;
  /** Compatibility fence for explicit callers; automatic Handoff resolution reads durable authority internally. */
  authorityId?: string;
  /** Compatibility CAS for explicit callers; automatic Handoff resolution validates current state under the relay lock. */
  expectedUpdatedAt?: string;
  /** Compatibility override only. Omit to preserve the existing semantic occurrence identity. */
  occurrenceId?: string;
}

/** Rearm the same provider dispatch responsibility only after its exact user-action Handoff is resolved. */
export function rearmControllerRoundAfterProviderUserAction(
  options: ControllerRoundRelayStoreOptions,
  input: RearmControllerRoundAfterProviderUserActionInput,
): ControllerRoundRelayRecord {
  const workId = input.workId.trim();
  const initial = readRelayRecord(options, workId);
  if (!initial) throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_RELAY_REQUIRED: ${workId}`);
  return relayLock(options, initial.value.relayScopeId, `controller-relay-provider-user-action-resolved:${workId}`, () => {
    const current = readRelayRecord(options, workId);
    if (!current) throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_RELAY_REQUIRED: ${workId}`);
    if (input.expectedUpdatedAt?.trim() && current.value.updatedAt !== input.expectedUpdatedAt.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_STALE: ${workId}`);
    if (input.authorityId?.trim() && (current.value.authorityId?.trim() || '') !== input.authorityId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_AUTHORITY_MISMATCH: ${workId}`);
    if (controllerRoundBlockerClass(current.value) !== 'provider_user_action_required') throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_BLOCKER_MISMATCH: ${workId}`);
    const handoffId = bounded(input.handoffId, 200);
    if (!handoffId || current.value.handoffId !== handoffId) throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_HANDOFF_MISMATCH: ${workId}`);
    const handoff = getHandoffItem(options, handoffId);
    if (!handoff) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
    if (handoff.workId && handoff.workId !== workId) throw new Error(`CONTROLLER_RELAY_HANDOFF_WORK_MISMATCH: ${handoffId}`);
    if (handoff.status !== 'resolved') throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_HANDOFF_NOT_RESOLVED: ${handoff.status}`);
    const requestedOccurrenceId = bounded(input.occurrenceId, 240);
    if (requestedOccurrenceId && current.value.occurrenceId && requestedOccurrenceId !== current.value.occurrenceId) {
      throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_OCCURRENCE_MISMATCH: ${workId}`);
    }
    const occurrenceId = requestedOccurrenceId ?? current.value.occurrenceId;
    if (!occurrenceId) throw new Error('CONTROLLER_RELAY_OCCURRENCE_ID_REQUIRED');
    const work = getWorkContract(options, workId);
    if (!work || isTerminalWorkContractStatus(work.status)) throw new Error(`CONTROLLER_RELAY_PROVIDER_USER_ACTION_WORK_TERMINAL: ${workId}:${work?.status ?? 'missing'}`);
    return applyControllerRoundTransition(options, current, {
      type: 'provider_user_action_resolved', at: nowIso(options), handoffId, occurrenceId,
    });
  });
}

/** Exact evidence-gated provider/environment recovery for one exhausted same-round dispatch responsibility. */
export function rearmControllerRoundAfterProviderRecovery(
  options: ControllerRoundRelayStoreOptions,
  input: RearmControllerRoundAfterProviderRecoveryInput,
): ControllerRoundRelayRecord {
  const workId = input.workId.trim();
  const initial = readRelayRecord(options, workId);
  if (!initial) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_RELAY_REQUIRED: ${workId}`);
  if (initial.value.relayScopeId !== input.relayScopeId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_SCOPE_MISMATCH: ${workId}`);
  return relayLock(options, initial.value.relayScopeId, `controller-relay-provider-recovered:${workId}`, () => {
    const current = readRelayRecord(options, workId);
    if (!current) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_RELAY_REQUIRED: ${workId}`);
    if (current.value.updatedAt !== input.expectedUpdatedAt.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_STALE: ${workId}`);
    if (current.value.relayScopeId !== input.relayScopeId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_SCOPE_MISMATCH: ${workId}`);
    if ((current.value.authorityId?.trim() || '') !== input.authorityId.trim()) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_AUTHORITY_MISMATCH: ${workId}`);
    if (controllerRoundBlockerClass(current.value) !== 'consecutive_failures') throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_BLOCKER_MISMATCH: ${workId}`);
    const work = getWorkContract(options, workId);
    if (!work || isTerminalWorkContractStatus(work.status)) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_WORK_TERMINAL: ${workId}:${work?.status ?? 'missing'}`);
    const requirement = requirementForRelay(options, current.value.requirementId);
    if (requirement && !['planned', 'active'].includes(requirement.state)) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_REQUIREMENT_TERMINAL: ${requirement.state}`);
    const activeWorks = recoveryFenceWork(options, current.value).filter((entry) => !isTerminalWorkContractStatus(entry.status));
    if (activeWorks.some((entry) => workHasActiveExecution(options.controllerHome, options.repoId, entry.workId))) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_ACTIVE_EXECUTION: ${workId}`);
    if (activeWorks.some((entry) => Boolean(getControllerSession(options, entry.workId)))) throw new Error(`CONTROLLER_RELAY_PROVIDER_RECOVERY_ACTIVE_CLAIM: ${workId}`);
    const evidenceId = bounded(input.evidenceId, 500);
    if (!evidenceId) throw new Error('CONTROLLER_RELAY_PROVIDER_RECOVERY_EVIDENCE_REQUIRED');
    return applyControllerRoundTransition(options, current, { type: 'provider_environment_recovered', at: nowIso(options), evidenceId });
  });
}

/**
 * One-time migration of a pre-occurrence-era dispatch responsibility onto the
 * first explicit post-recovery Scheduler occurrence. This does not create a
 * round or provider effect: exact round authority, CAS and controller lineage
 * fence the single occurrenceId write before normal strict occurrence matching
 * resumes.
 */
export function bindLegacyControllerRoundOccurrence(
  options: ControllerRoundRelayStoreOptions,
  input: BindLegacyControllerRoundOccurrenceInput,
): ControllerRoundRelayRecord {
  const workId = input.workId.trim();
  const relayScopeId = input.relayScopeId.trim();
  const occurrenceId = bounded(input.occurrenceId, 500);
  if (!occurrenceId) throw new Error('CONTROLLER_RELAY_OCCURRENCE_ID_REQUIRED');
  const initial = readRelayRecord(options, workId);
  if (!initial) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_RELAY_REQUIRED: ${workId}`);
  if (initial.value.relayScopeId !== relayScopeId) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_SCOPE_MISMATCH: ${workId}`);
  return relayLock(options, initial.value.relayScopeId, `controller-relay-bind-legacy-occurrence:${workId}`, () => {
    const current = readRelayRecord(options, workId);
    if (!current) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_RELAY_REQUIRED: ${workId}`);
    if (current.value.updatedAt !== input.expectedUpdatedAt.trim()) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_STALE: ${workId}`);
    if (current.value.relayScopeId !== relayScopeId) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_SCOPE_MISMATCH: ${workId}`);
    if (current.value.originWorkId !== workId) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_WORK_MISMATCH: ${workId}`);
    if ((current.value.authorityId?.trim() || '') !== input.authorityId.trim()) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_AUTHORITY_MISMATCH: ${workId}`);
    const expectedPrincipalId = input.identity.principalId.trim() || input.identity.controllerId.trim();
    const currentPrincipalId = current.value.principalId?.trim() || current.value.controllerId;
    if (current.value.controllerId !== input.identity.controllerId.trim()
      || relayControllerType(current.value) !== input.identity.controllerType
      || currentPrincipalId !== expectedPrincipalId) {
      throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_CONTROLLER_MISMATCH: ${workId}`);
    }
    const work = getWorkContract(options, workId);
    if (!work || isTerminalWorkContractStatus(work.status)) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_WORK_TERMINAL: ${workId}:${work?.status ?? 'missing'}`);
    const requirement = requirementForRelay(options, current.value.requirementId);
    if (requirement && !['planned', 'active'].includes(requirement.state)) throw new Error(`CONTROLLER_RELAY_LEGACY_OCCURRENCE_REQUIREMENT_TERMINAL: ${requirement.state}`);
    return applyControllerRoundTransition(options, current, { type: 'legacy_occurrence_bound', at: nowIso(options), occurrenceId });
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
  // A recovery pass evaluates many relay candidates for the same repository.
  // Work contracts are immutable for this read phase, so share one snapshot
  // across candidates. The locked transition below still refreshes the Work
  // snapshot before deriving the durable recovery decision.
  let scanWorkContracts: readonly WorkContract[] | undefined;
  let scanActiveWorkSnapshot: ReturnType<typeof readActiveWorkCandidates> | undefined;
  const activeWorkSnapshotForScan = (): ReturnType<typeof readActiveWorkCandidates> => {
    scanActiveWorkSnapshot ??= readActiveWorkCandidates({ controllerHome: options.controllerHome, repoId: options.repoId, limit: 1_000 });
    return scanActiveWorkSnapshot;
  };
  const workSnapshotForScan = (): readonly WorkContract[] => {
    scanWorkContracts ??= readWorkContractStore({ controllerHome: options.controllerHome, repoId: options.repoId }).contracts;
    return scanWorkContracts;
  };

  for (const candidate of latestRelayRecordsByScope(options)) {
    if (claimed.length >= limit) break;
    const repeatedStateBlocked = candidate.status === 'blocked' && candidate.blockedReason?.startsWith('repeated_state:') === true;
    if (!['pending_release', 'dispatching', 'dispatched', 'claimed'].includes(candidate.status) && !repeatedStateBlocked) continue;
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
    if (!relayMayHaveActiveWork(options, candidate, activeWorkSnapshotForScan())) continue;
    const candidateWorks = recoveryFenceWork(options, candidate, workSnapshotForScan());
    const activeCandidateWorks = candidateWorks.filter((work) => !isTerminalWorkContractStatus(work.status));
    if (activeCandidateWorks.length === 0) continue;
    if (activeCandidateWorks.some((work) => workHasActiveExecution(options.controllerHome, options.repoId, work.workId) || controllerSessionBlocksRecovery(options, work.workId, { nowMs, graceMs }))) continue;
    if (repeatedStateBlocked) {
      const fingerprintWork = activeCandidateWorks[0] ?? getWorkContract(options, candidate.originWorkId);
      const currentFingerprint = fingerprintWork
        ? mechanicalStateFingerprint(options, fingerprintWork, candidate.requirementId, candidate.relayScopeId, candidate.handoffId)
        : candidate.stateFingerprint;
      if (currentFingerprint === candidate.stateFingerprint) continue;
    }

    const next = relayLock(options, candidate.relayScopeId, `controller-relay-recover:${candidate.originWorkId}`, () => {
      const latest = relayHistory(options, candidate.relayScopeId)[0];
      if (!latest || latest.originWorkId !== candidate.originWorkId || latest.updatedAt !== candidate.updatedAt || latest.status !== candidate.status) return undefined;
      const latestRepeatedStateBlocked = latest.status === 'blocked' && latest.blockedReason?.startsWith('repeated_state:') === true;
      if (latest.status === 'blocked' && !latestRepeatedStateBlocked) return undefined;
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
      const lockedWorkContracts = readWorkContractStore({ controllerHome: options.controllerHome, repoId: options.repoId }).contracts;
      const works = recoveryFenceWork(options, latest, lockedWorkContracts);
      const activeWorks = works.filter((work) => !isTerminalWorkContractStatus(work.status));
      if (activeWorks.length === 0) return undefined;
      if (activeWorks.some((work) => workHasActiveExecution(options.controllerHome, options.repoId, work.workId) || controllerSessionBlocksRecovery(options, work.workId, { nowMs, graceMs }))) return undefined;

      // A claimed ControllerRound may become recoverable after its execution
      // activity grace expires while the durable owner lease itself is still
      // unexpired. Never rotate the opaque per-round capability while leaving
      // that old owner authoritative: doing so makes release/recovery mutually
      // inaccessible. Fence the exact observed stale owner first. A crash after
      // this release but before relay transition is safe and retryable because
      // the old relay authority remains unchanged and no stale writer survives.
      for (const work of activeWorks) {
        const staleOwner = getControllerSession(options, work.workId);
        if (!staleOwner) continue;
        const released = releaseObservedControllerSession(options, {
          workId: work.workId,
          actor: `controller-relay-stalled-recovery:${latest.originWorkId}`,
          owner: staleOwner,
        });
        if (!released.allowed) return undefined;
      }

      const currentRecord = readRelayRecord(options, latest.originWorkId);
      if (!currentRecord || currentRecord.value.updatedAt !== latest.updatedAt || currentRecord.value.status !== latest.status) return undefined;
      const fingerprintWork = activeWorks[0] ?? getWorkContract(options, latest.originWorkId);
      const stateFingerprint = fingerprintWork
        ? mechanicalStateFingerprint(options, fingerprintWork, latest.requirementId, latest.relayScopeId, latest.handoffId, lockedWorkContracts)
        : latest.stateFingerprint;
      const at = new Date(nowMs).toISOString();
      const lastError = latestRepeatedStateBlocked
        ? undefined
        : latest.nextRecoveryAt
          ? latest.lastError
          : latest.status === 'pending_release'
            ? 'CONTROLLER_RELAY_RELEASE_TRANSITION_INCOMPLETE'
            : latest.status === 'dispatching'
              ? 'CONTROLLER_RELAY_DISPATCH_TRANSITION_INCOMPLETE'
              : latest.status === 'claimed' ? 'CONTROLLER_RELAY_CLAIMED_ROUND_UNCLOSED' : 'CONTROLLER_RELAY_ROUND_UNCLOSED';
      if (latest.status === 'dispatching' && latest.providerDispatchStartedAt && latest.providerDispatchEffectId) {
        applyControllerRoundTransition(options, currentRecord, {
          type: 'provider_dispatch_outcome_unknown',
          at,
          error: 'CONTROLLER_RELAY_PROVIDER_DISPATCH_STALLED_AFTER_EFFECT_START',
          providerDispatchEffectId: latest.providerDispatchEffectId,
        });
        return undefined;
      }
      const recovered = applyControllerRoundTransition(options, currentRecord, {
        type: 'stalled_round_observed', at, stateFingerprint, proposedAuthorityId: newControllerRoundAuthorityId(),
        ...(lastError ? { lastError } : {}),
      });
      return recovered.status === 'dispatching' ? recovered : undefined;
    });
    if (next) claimed.push(next);
  }
  return claimed;
}

const CONTROLLER_ROUND_ORIGIN_OBJECTIVE_MAX_CHARS = 4_000;
const CONTROLLER_ROUND_RELATED_OBJECTIVE_MAX_CHARS = 500;
const CONTROLLER_ROUND_ORIGIN_ACCEPTANCE_MAX_ITEMS = 16;
const CONTROLLER_ROUND_ACCEPTANCE_CRITERION_MAX_CHARS = 1_000;

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
    acceptanceCriteria: string[];
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
  assistantContext?: string;
  executionQualitySignals?: ExecutionQualitySignal[];
}

/** Provider-neutral launch context. ControllerHost adapters decide how to render it. */
export function readControllerRoundContextSnapshot(
  options: ControllerRoundRelayStoreOptions,
  record: ControllerRoundRelayRecord,
): ControllerRoundContextSnapshot {
  const requirement = requirementForRelay(options, record.requirementId);
  const relevantWorks = relevantWork(options, record);
  const works = relevantWorks.slice(0, 8);
  const handoffs = relevantHandoffs(options, relevantWorks, record.handoffId).slice(0, 8);
  return {
    repoId: record.repoId,
    relayScopeId: record.relayScopeId,
    originWorkId: record.originWorkId,
    assistantContext: options.prepareAssistantContext?.(record.originWorkId),
    executionQualitySignals: pendingQualitySignals(record),
    ...(requirement ? {
      requirement: {
        requirementId: requirement.requirementId,
        state: requirement.state,
        outcomeStatement: requirement.outcomeStatement.slice(0, 800),
      },
    } : {}),
    works: works.map((work) => {
      const origin = work.workId === record.originWorkId;
      return {
        workId: work.workId,
        status: work.status,
        phase: work.phase,
        updatedAt: work.updatedAt,
        objective: work.objective.slice(0, origin
          ? CONTROLLER_ROUND_ORIGIN_OBJECTIVE_MAX_CHARS
          : CONTROLLER_ROUND_RELATED_OBJECTIVE_MAX_CHARS),
        acceptanceCriteria: origin
          ? work.acceptanceCriteria
            .slice(0, CONTROLLER_ROUND_ORIGIN_ACCEPTANCE_MAX_ITEMS)
            .map((criterion) => criterion.slice(0, CONTROLLER_ROUND_ACCEPTANCE_CRITERION_MAX_CHARS))
          : [],
      };
    }),
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
