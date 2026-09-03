import { createHash } from 'crypto';
import {
  OPERATIONAL_SIGNAL_DEFINITIONS,
  OPERATIONAL_TARGET_DEFINITIONS,
  reduceOperationalObservations,
  resolveOperationalShadowPrior,
  type OperationalObservation,
  type OperationalShadowPrior,
} from '../../../../packages/kernel/memory/api/index';
import { extractProcessCheckShadowObservation } from '../../evidence/operational-shadow';
import { processCheckCompletionReceipt } from '../../execution/process-runtime/check-receipt';
import { getProcessRecord } from '../../execution/process-runtime/store';
import {
  deleteControlPlaneRecord,
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from './sqlite-store';

export const OPERATIONAL_MEMORY_NAMESPACE = 'operational_memory_prior';
export const CHECK_COMPLETION_GRACE_TARGET = 'check_completion_grace' as const;
export const CHECK_COMPLETION_GRACE_ACTION = 'observed_check' as const;
export const CHECK_COMPLETION_GRACE_MAX_MS = 250;
const SCHEMA_VERSION = 1;
const SIGNAL_ID = 'process_check.terminal_mechanical' as const;
const CHECK_COMPLETION_GRACE_MAX_SAMPLES = OPERATIONAL_TARGET_DEFINITIONS[CHECK_COMPLETION_GRACE_TARGET].activationThreshold.maxSamples;

type ProcessRecordLoader = typeof getProcessRecord;
export interface OperationalPriorStoreDependencies {
  loadProcessRecord?: ProcessRecordLoader;
  now?: () => Date;
}

interface CheckCompletionGraceSupport {
  processId: string;
  receiptId: string;
  finishedAt: string;
}

export interface CheckCompletionGracePriorRecord {
  schemaVersion: 1;
  repoId: string;
  checkId: string;
  environmentFingerprint: string;
  targetId: typeof CHECK_COMPLETION_GRACE_TARGET;
  actionId: typeof CHECK_COMPLETION_GRACE_ACTION;
  prior: OperationalShadowPrior;
  support: CheckCompletionGraceSupport[];
  updatedAt: string;
}

function nowIso(deps: OperationalPriorStoreDependencies): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function recordKey(checkId: string, environmentFingerprint: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ targetId: CHECK_COMPLETION_GRACE_TARGET, checkId, environmentFingerprint }))
    .digest('hex')
    .slice(0, 32);
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validRecord(value: unknown): value is CheckCompletionGracePriorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<CheckCompletionGracePriorRecord>;
  if (record.schemaVersion !== 1
    || record.targetId !== CHECK_COMPLETION_GRACE_TARGET
    || record.actionId !== CHECK_COMPLETION_GRACE_ACTION
    || !boundedText(record.repoId)
    || !boundedText(record.checkId)
    || !boundedText(record.environmentFingerprint)
    || !validInstant(record.updatedAt)
    || !Array.isArray(record.support)
    || record.support.length > CHECK_COMPLETION_GRACE_MAX_SAMPLES
    || record.support.some((entry) => !entry
      || !boundedText(entry.processId)
      || !boundedText(entry.receiptId)
      || !validInstant(entry.finishedAt))) return false;

  const prior = record.prior;
  if (!prior || typeof prior !== 'object'
    || prior.schemaVersion !== 1
    || prior.mode !== 'shadow'
    || prior.targetId !== CHECK_COMPLETION_GRACE_TARGET
    || prior.actionId !== CHECK_COMPLETION_GRACE_ACTION
    || prior.metricId !== 'latency_ms'
    || prior.scope?.schemaVersion !== 1
    || prior.scope.kind !== 'project'
    || prior.scope.id !== record.repoId
    || prior.compatibility?.operation !== `check:${record.checkId}`
    || prior.compatibility.environment !== record.environmentFingerprint
    || !Number.isFinite(prior.estimate)
    || !Number.isInteger(prior.sampleCount)
    || prior.sampleCount < 1
    || prior.sampleCount > CHECK_COMPLETION_GRACE_MAX_SAMPLES
    || !Number.isInteger(prior.distinctEvidenceCount)
    || prior.distinctEvidenceCount < 1
    || prior.distinctEvidenceCount > prior.sampleCount
    || !validInstant(prior.latestObservedAt)
    || !validInstant(prior.replayHorizonEndsAt)
    || !Array.isArray(prior.supportEvidenceRefs)
    || prior.supportEvidenceRefs.length !== prior.sampleCount
    || prior.supportEvidenceRefs.some((entry) => !boundedText(entry))
    || !Array.isArray(prior.sourceObservationIds)
    || prior.sourceObservationIds.length !== prior.sampleCount
    || prior.sourceObservationIds.some((entry) => !boundedText(entry))
    || (prior.readiness !== 'insufficient_samples' && prior.readiness !== 'shadow_candidate')
    || record.support.length !== prior.sampleCount) return false;
  return true;
}

function retainedUntil(finishedAt: string): string | undefined {
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(finished)) return undefined;
  return new Date(finished + OPERATIONAL_SIGNAL_DEFINITIONS[SIGNAL_ID].retentionHorizonMs).toISOString();
}

function replayFromProcesses(input: {
  controllerHome: string;
  repoId: string;
  processIds: readonly string[];
  checkId: string;
  environmentFingerprint: string;
  asOf: string;
}, deps: OperationalPriorStoreDependencies): {
  replayGap: boolean;
  prior?: OperationalShadowPrior;
  support: CheckCompletionGraceSupport[];
} {
  const load = deps.loadProcessRecord ?? getProcessRecord;
  const observations: OperationalObservation[] = [];
  const support: CheckCompletionGraceSupport[] = [];
  const seen = new Set<string>();
  for (const processId of input.processIds) {
    if (!processId || seen.has(processId)) continue;
    seen.add(processId);
    const process = load(input.controllerHome, input.repoId, processId);
    if (!process) return { replayGap: true, support: [] };
    let receipt;
    try {
      receipt = processCheckCompletionReceipt(process);
    } catch {
      return { replayGap: true, support: [] };
    }
    if (receipt.status !== 'passed' || !receipt.requestId || !receipt.checkEnvironmentFingerprint) {
      return { replayGap: true, support: [] };
    }
    if (receipt.checkId !== input.checkId || receipt.checkEnvironmentFingerprint !== input.environmentFingerprint) {
      return { replayGap: true, support: [] };
    }
    const until = retainedUntil(receipt.finishedAt);
    if (!until) return { replayGap: true, support: [] };
    observations.push(extractProcessCheckShadowObservation(receipt, {
      targetId: CHECK_COMPLETION_GRACE_TARGET,
      actionId: CHECK_COMPLETION_GRACE_ACTION,
      metricId: 'latency_ms',
      scope: { schemaVersion: 1, kind: 'project', id: input.repoId },
      consumerRequestId: receipt.requestId,
      retainedUntil: until,
      environmentFingerprint: receipt.checkEnvironmentFingerprint,
    }));
    support.push({ processId, receiptId: receipt.receiptId, finishedAt: receipt.finishedAt });
  }
  const maxSamples = CHECK_COMPLETION_GRACE_MAX_SAMPLES;
  const ordered = support
    .map((entry, index) => ({ entry, observation: observations[index]! }))
    .sort((a, b) => a.entry.finishedAt.localeCompare(b.entry.finishedAt) || a.entry.processId.localeCompare(b.entry.processId))
    .slice(-maxSamples);
  const reduction = reduceOperationalObservations({ observations: ordered.map((item) => item.observation), asOf: input.asOf });
  const prior = reduction.priors.find((candidate) => candidate.targetId === CHECK_COMPLETION_GRACE_TARGET
    && candidate.actionId === CHECK_COMPLETION_GRACE_ACTION
    && candidate.metricId === 'latency_ms'
    && candidate.compatibility.operation === `check:${input.checkId}`
    && candidate.compatibility.environment === input.environmentFingerprint);
  return { replayGap: false, prior, support: ordered.map((item) => item.entry) };
}

function deleteRecord(controllerHome: string, repoId: string, checkId: string, environmentFingerprint: string, action: string): void {
  deleteControlPlaneRecord(controllerHome, {
    namespace: OPERATIONAL_MEMORY_NAMESPACE,
    scope: repoId,
    key: recordKey(checkId, environmentFingerprint),
    action,
  });
}

export function ingestCheckCompletionGraceProcess(input: {
  controllerHome: string;
  repoId: string;
  processId: string;
}, deps: OperationalPriorStoreDependencies = {}): { stored: boolean; readiness?: OperationalShadowPrior['readiness']; sampleCount?: number } {
  const load = deps.loadProcessRecord ?? getProcessRecord;
  const process = load(input.controllerHome, input.repoId, input.processId);
  if (!process) return { stored: false };
  let receipt;
  try {
    receipt = processCheckCompletionReceipt(process);
  } catch {
    return { stored: false };
  }
  // The active consumer learns only exact successful latency. Failed receipts are
  // intentionally excluded because a raw Process receipt does not itself prove
  // acceptance-vs-infrastructure failure semantics.
  if (receipt.status !== 'passed' || !receipt.requestId || !receipt.checkEnvironmentFingerprint) return { stored: false };
  const checkId = receipt.checkId;
  const environmentFingerprint = receipt.checkEnvironmentFingerprint;
  const key = recordKey(checkId, environmentFingerprint);
  const existing = readControlPlaneRecord<CheckCompletionGracePriorRecord>(input.controllerHome, OPERATIONAL_MEMORY_NAMESPACE, input.repoId, key);
  const previousIds = existing && validRecord(existing.value) ? existing.value.support.map((entry) => entry.processId) : [];
  const asOf = nowIso(deps);
  let replay = replayFromProcesses({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    processIds: [...previousIds, input.processId],
    checkId,
    environmentFingerprint,
    asOf,
  }, deps);
  if (replay.replayGap) {
    deleteRecord(input.controllerHome, input.repoId, checkId, environmentFingerprint, 'operational_memory_replay_gap');
    replay = replayFromProcesses({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      processIds: [input.processId],
      checkId,
      environmentFingerprint,
      asOf,
    }, deps);
  }
  if (replay.replayGap || !replay.prior) return { stored: false };
  const value: CheckCompletionGracePriorRecord = {
    schemaVersion: SCHEMA_VERSION,
    repoId: input.repoId,
    checkId,
    environmentFingerprint,
    targetId: CHECK_COMPLETION_GRACE_TARGET,
    actionId: CHECK_COMPLETION_GRACE_ACTION,
    prior: replay.prior,
    support: replay.support,
    updatedAt: asOf,
  };
  const unchanged = existing && validRecord(existing.value)
    && JSON.stringify(existing.value.prior) === JSON.stringify(value.prior)
    && JSON.stringify(existing.value.support) === JSON.stringify(value.support);
  if (!unchanged) {
    writeControlPlaneRecord(input.controllerHome, {
      namespace: OPERATIONAL_MEMORY_NAMESPACE,
      scope: input.repoId,
      key,
      schemaVersion: SCHEMA_VERSION,
      value,
      action: 'operational_memory_replay_materialize',
    });
  }
  return { stored: true, readiness: replay.prior.readiness, sampleCount: replay.prior.sampleCount };
}

function resolveCheckCompletionGraceWaitMsUnsafe(input: {
  controllerHome: string;
  repoId: string;
  checkId: string;
  environmentFingerprint: string;
}, deps: OperationalPriorStoreDependencies): number | undefined {
  const key = recordKey(input.checkId, input.environmentFingerprint);
  const stored = readControlPlaneRecord<CheckCompletionGracePriorRecord>(input.controllerHome, OPERATIONAL_MEMORY_NAMESPACE, input.repoId, key);
  if (!stored) return undefined;
  if (!validRecord(stored.value)
    || stored.value.repoId !== input.repoId
    || stored.value.checkId !== input.checkId
    || stored.value.environmentFingerprint !== input.environmentFingerprint
    || stored.value.support.some((entry) => !entry || typeof entry.processId !== 'string' || typeof entry.receiptId !== 'string' || typeof entry.finishedAt !== 'string')) {
    deleteRecord(input.controllerHome, input.repoId, input.checkId, input.environmentFingerprint, 'operational_memory_invalid_record');
    return undefined;
  }
  const asOf = nowIso(deps);
  const replay = replayFromProcesses({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    processIds: stored.value.support.map((entry) => entry.processId),
    checkId: input.checkId,
    environmentFingerprint: input.environmentFingerprint,
    asOf,
  }, deps);
  if (replay.replayGap || !replay.prior) {
    deleteRecord(input.controllerHome, input.repoId, input.checkId, input.environmentFingerprint, 'operational_memory_replay_gap');
    return undefined;
  }
  const retainedEvidenceRefs = new Set(replay.prior.supportEvidenceRefs);
  const resolved = resolveOperationalShadowPrior({
    prior: replay.prior,
    compatibility: { operation: `check:${input.checkId}`, environment: input.environmentFingerprint },
    retainedEvidenceRefs,
    asOf,
  });
  if (resolved.status !== 'shadow_candidate') return undefined;
  if (resolved.prior.estimate > CHECK_COMPLETION_GRACE_MAX_MS) return undefined;
  return CHECK_COMPLETION_GRACE_MAX_MS;
}

export function resolveCheckCompletionGraceWaitMs(input: {
  controllerHome: string;
  repoId: string;
  checkId: string;
  environmentFingerprint: string;
}, deps: OperationalPriorStoreDependencies = {}): number | undefined {
  try {
    return resolveCheckCompletionGraceWaitMsUnsafe(input, deps);
  } catch {
    // This namespace is a disposable optimization. Corruption, SQLite contention,
    // replay gaps, or stale derived records must degrade to the canonical wait.
    return undefined;
  }
}

export function dropOperationalMemoryNamespace(controllerHome: string, repoId: string): number {
  const records = listControlPlaneRecords(controllerHome, { namespace: OPERATIONAL_MEMORY_NAMESPACE, scope: repoId, limit: 5_000 });
  let deleted = 0;
  for (const record of records) {
    if (deleteControlPlaneRecord(controllerHome, {
      namespace: OPERATIONAL_MEMORY_NAMESPACE,
      scope: repoId,
      key: record.key,
      action: 'operational_memory_drop',
    })) deleted += 1;
  }
  return deleted;
}
