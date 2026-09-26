import { createHash } from 'crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { listRepositories, selectRepositoryCheckout } from '../../cli/repositories/registry';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { withControllerLock } from '../../cli/repositories/locks';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { loadRuntimeReleaseManifest } from '../root/release-manifest';
import { readRuntimeReleaseAuthority } from '../root/release-store';
import { appendRuntimeEvent, type RuntimeEntityEvent } from '../evidence/event-ledger';
import { listReleaseSessions } from '../release/release-session';
import { appendWorkEvidence, getWorkContract, listWorkContracts } from '../../../packages/kernel/work/api/index';
import { routeWorkStart } from '../control-plane/facade/goal-workloop';
import { createWorkContinuationSchedule } from '../workflow/schedules/work-continuation';
import { touchSchedulerWakeSignal } from '../control-plane/global-scheduler/wake-signal';
import { recentMcpIncidents, type McpIncident } from './mcp-timing';

const RECURRENCE_WINDOW_MS = 30 * 60_000;
const RECURRENCE_THRESHOLD = 3;
const INCIDENT_TAIL_BYTES = 256 * 1024;
const INCIDENT_WORK_PREFIX = 'forge-incident-repair';
const ACTIONABLE_FAILURE_EVENT = 'forge_actionable_failure_observed';
const TERMINAL_WORK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface ForgeIncidentRepairClassification {
  eligible: boolean;
  rootCode?: string;
  fingerprint?: string;
  reason: string;
}

export interface ForgeIncidentRepairRegistration {
  eligible: boolean;
  recurrent: boolean;
  occurrenceCount: number;
  fingerprint?: string;
  rootCode?: string;
  repairRepoId?: string;
  workId?: string;
  reusedExistingWork?: boolean;
  scheduleId?: string;
  reason: string;
}

export interface ForgeActionableFailureObservation {
  observationId: string;
  source: 'progression' | 'release' | 'maintenance';
  code: string;
  message: string;
  at?: string;
  repoId?: string;
  workId?: string;
}

interface PersistedMcpIncident extends McpIncident {
  schemaVersion?: number;
  at?: string;
}

function transportFailureMessage(message: string): boolean {
  const transportFailure = /(?:ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|connection failed|fetch failed|network error|timed? out|timeout)/i.test(message);
  const forgeTransport = /(?:canonical runtime|runtime mcp|mcp transport|forge gateway|forge tunnel)/i.test(message);
  return transportFailure && forgeTransport;
}

/**
 * Conservative product-defect classifier. Expected policy, scope, admission,
 * user-code acceptance, and ordinary contention failures are intentionally not
 * auto-promoted into Forge source Work.
 */
export function classifyForgeIncidentForRepair(incident: McpIncident): ForgeIncidentRepairClassification {
  const code = incident.code.trim().toUpperCase();
  if (!code) return { eligible: false, reason: 'incident code is empty' };

  const rootCode = (() => {
    if (code === 'MCP_REQUEST_EXCEPTION' && transportFailureMessage(incident.message)) return 'MCP_TRANSPORT_UNAVAILABLE';
    if (code === 'CONTROLLER_AUTHENTICATED_SESSION_REQUIRED') return code;
    if (code === 'WORK_CONTROLLER_SCOPE_MISMATCH') return code;
    if (code.startsWith('CANONICAL_RUNTIME_')) return code;
    if (code.startsWith('RECOVERY_')) return code;
    if (code.startsWith('CONTROLLER_RELAY_')) return code;
    if (code.startsWith('PROCESS_RUNTIME_')) return code;
    if (/^PLUGIN_[A-Z0-9_]+_(?:UNAVAILABLE|MISSING|MISMATCH)$/.test(code)) return code;
    if (/^RUNTIME_(?:SERVICE|RELEASE|OWNER|WRITE|PROCESS|GATEWAY)_[A-Z0-9_]+$/.test(code)) return code;
    return undefined;
  })();
  if (!rootCode) return { eligible: false, reason: `expected/non-product incident class ${code}` };

  const fingerprint = createHash('sha256').update(`forge-infrastructure:${rootCode}`).digest('hex').slice(0, 24);
  return { eligible: true, rootCode, fingerprint, reason: `eligible Forge infrastructure root ${rootCode}` };
}

function incidentAuditPath(controllerHome: string): string {
  return join(resolve(controllerHome), 'audit', 'mcp-incidents.jsonl');
}

function readBoundedJsonLines<T>(path: string, maxBytes = INCIDENT_TAIL_BYTES): T[] {
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    const read = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as T;
        return parsed && typeof parsed === 'object' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readBoundedIncidentTail(controllerHome: string): PersistedMcpIncident[] {
  return readBoundedJsonLines<PersistedMcpIncident>(incidentAuditPath(controllerHome));
}

function recentRootIncidents(
  controllerHome: string,
  classification: ForgeIncidentRepairClassification,
  nowMs: number,
): PersistedMcpIncident[] {
  if (!classification.eligible || !classification.rootCode) return [];
  const unique = new Map<string, PersistedMcpIncident>();
  for (const candidate of [...readBoundedIncidentTail(controllerHome), ...recentMcpIncidents(controllerHome)]) {
    const at = Date.parse(candidate.at ?? '');
    if (!Number.isFinite(at) || at < nowMs - RECURRENCE_WINDOW_MS || at > nowMs + 60_000) continue;
    if (classifyForgeIncidentForRepair(candidate).rootCode !== classification.rootCode) continue;
    if (!candidate.traceId?.trim()) continue;
    unique.set(candidate.traceId.trim(), candidate);
  }
  return [...unique.values()];
}

function actionableFailureLedgerPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
}

function readActionableFailureEvents(controllerHome: string, repoId: string): RuntimeEntityEvent[] {
  return readBoundedJsonLines<RuntimeEntityEvent>(actionableFailureLedgerPath(controllerHome, repoId))
    .filter((event) => event.eventType === ACTIONABLE_FAILURE_EVENT && event.entityType === 'portfolio');
}

function normalizedFailureMessage(message: string): string {
  return message.toUpperCase()
    .replace(/[A-F0-9]{16,64}/g, '<ID>')
    .replace(/\b\d{2,}\b/g, '<N>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function deriveForgeActionableFailureCode(prefix: string, message: string): string {
  const normalizedPrefix = prefix.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'FORGE_FAILURE';
  const normalizedMessage = normalizedFailureMessage(message);
  const explicit = normalizedMessage.match(/\b(?:[A-Z][A-Z0-9]*_){1,}[A-Z0-9_]+\b/)?.[0];
  if (explicit) return explicit.slice(0, 120);
  const digest = createHash('sha256').update(normalizedMessage || normalizedPrefix).digest('hex').slice(0, 12).toUpperCase();
  return `${normalizedPrefix}_${digest}`.slice(0, 120);
}

export function classifyForgeActionableFailureForRepair(observation: ForgeActionableFailureObservation): ForgeIncidentRepairClassification {
  const code = observation.code.trim().toUpperCase();
  if (!code) return { eligible: false, reason: 'actionable failure code is empty' };
  const blockerText = `${code} ${observation.message}`.toUpperCase();
  if (
    blockerText.includes('EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED')
    || blockerText.includes('PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED')
    || blockerText.includes('LOGIN_REQUIRED')
    || blockerText.includes('PERMISSION_REQUIRED')
    || blockerText.includes('CONSENT_REQUIRED')
    || blockerText.includes('WAITING_FOR_USER')
    || blockerText.includes('USER_ACTION_REQUIRED')
    || blockerText.includes('OUTCOME_UNKNOWN')
  ) return { eligible: false, reason: `explicit user/ambiguity blocker ${code}` };

  const rootCode = (
    code.startsWith('CONTROLLER_')
    || code.startsWith('SCHEDULER_')
    || code.startsWith('WORKFLOW_SUPERVISOR_')
    || code.startsWith('RUNTIME_')
    || code.startsWith('RECOVERY_')
    || code.startsWith('PROCESS_')
    || code.startsWith('RELEASE_SESSION_')
    || code.startsWith('MAINTENANCE_')
    || /^PLUGIN_[A-Z0-9_]+_(?:UNAVAILABLE|MISSING|MISMATCH|FAILED)$/.test(code)
  ) ? code : undefined;
  if (!rootCode) return { eligible: false, reason: `non-infrastructure actionable failure class ${code}` };
  const fingerprint = createHash('sha256').update(`forge-infrastructure:${rootCode}`).digest('hex').slice(0, 24);
  return { eligible: true, rootCode, fingerprint, reason: `eligible Forge infrastructure root ${rootCode}` };
}

function activeRuntimeSourceRoot(controllerHome: string): string | undefined {
  const authority = readRuntimeReleaseAuthority(controllerHome);
  return authority?.active.manifestPath ? dirname(authority.active.manifestPath) : undefined;
}

function recentActionableRootEvents(
  controllerHome: string,
  repoId: string,
  classification: ForgeIncidentRepairClassification,
  nowMs: number,
): RuntimeEntityEvent[] {
  if (!classification.eligible || !classification.rootCode) return [];
  const unique = new Map<string, RuntimeEntityEvent>();
  for (const event of readActionableFailureEvents(controllerHome, repoId)) {
    const data = event.data ?? {};
    const rootCode = typeof data.rootCode === 'string' ? data.rootCode : '';
    const observationId = typeof data.observationId === 'string' ? data.observationId : '';
    const observedAt = typeof data.observedAt === 'string' ? data.observedAt : event.occurredAt;
    const at = Date.parse(observedAt);
    if (rootCode !== classification.rootCode || !observationId) continue;
    if (!Number.isFinite(at) || at < nowMs - RECURRENCE_WINDOW_MS || at > nowMs + 60_000) continue;
    unique.set(observationId, event);
  }
  return [...unique.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

function actionableEvidence(event: RuntimeEntityEvent, rootCode: string, ordinal: number) {
  const data = event.data ?? {};
  const observationId = typeof data.observationId === 'string' ? data.observationId : event.eventId;
  const source = typeof data.source === 'string' ? data.source : 'unknown';
  const affectedRepo = typeof data.affectedRepoId === 'string' ? data.affectedRepoId : undefined;
  const workId = typeof data.workId === 'string' ? data.workId : undefined;
  return {
    evidenceId: `FAILOBS-${createHash('sha256').update(observationId).digest('hex').slice(0, 24)}`,
    title: `recurrent Forge failure ${rootCode}`,
    summary: [
      `Occurrence ${ordinal} for ${rootCode}.`,
      `source=${source}`,
      ...(affectedRepo ? [`affectedRepo=${affectedRepo}`] : []),
      ...(workId ? [`work=${workId}`] : []),
      `observation=${observationId}`,
    ].join(' ').slice(0, 1_000),
    detailLevel: 'summary' as const,
  };
}

function gitHead(root: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
  });
  const head = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/i.test(head) ? head : undefined;
}

function samePath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return resolve(left) === resolve(right); }
}

/**
 * Resolve the registered Forge source authority. A user/business repository
 * affected by a Runtime defect is never treated as the repair repository.
 * Source-mode Runtime uses exact checkout path identity. Immutable/package mode
 * uses the release manifest's sourceRepositoryId, which is minted by the staged
 * release contract. Scheduler/incident reconciliation must not rediscover that
 * identity by synchronously walking Git history across registered repositories.
 */
export function resolveRuntimeSourceRepairRepository(
  controllerHome: string,
  runtimeSourceRoot: string | undefined,
): RepositoryRecord | undefined {
  const root = runtimeSourceRoot?.trim();
  if (!root) return undefined;
  const repositories = listRepositories(controllerHome).filter((repository) => repository.enabled && !repository.removedAt);
  const exact = repositories.filter((repository) => repository.checkouts.some((checkout) => (
    checkout.lifecycle !== 'removed' && samePath(checkout.canonicalRoot, root)
  )));
  if (exact.length === 1) return selectRepositoryCheckout(exact[0]!, exact[0]!.activeCheckoutId);
  if (exact.length > 1) return undefined;

  const manifestPath = join(resolve(root), 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  let sourceRepositoryId: string | undefined;
  try {
    sourceRepositoryId = loadRuntimeReleaseManifest(manifestPath, controllerHome).sourceRepositoryId?.trim();
  } catch {
    return undefined;
  }
  if (!sourceRepositoryId) return undefined;
  const sourceRepository = repositories.find((repository) => repository.repoId === sourceRepositoryId);
  if (!sourceRepository) return undefined;
  return selectRepositoryCheckout(sourceRepository, sourceRepository.activeCheckoutId);
}

function requestBase(fingerprint: string): string {
  return `${INCIDENT_WORK_PREFIX}:${fingerprint}`;
}

function requestGeneration(requestId: string | undefined, base: string): number | undefined {
  if (!requestId?.startsWith(`${base}:g`)) return undefined;
  const value = Number.parseInt(requestId.slice(`${base}:g`.length), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function incidentEvidence(incident: PersistedMcpIncident, rootCode: string, ordinal: number) {
  return {
    evidenceId: `MCPINC-${incident.traceId}`.slice(0, 160),
    title: `recurrent Forge incident ${rootCode}`,
    summary: [
      `Occurrence ${ordinal} for ${rootCode}.`,
      `tool=${incident.tool}`,
      `trace=${incident.traceId}`,
      ...(incident.repoId ? [`affectedRepo=${incident.repoId}`] : []),
    ].join(' ').slice(0, 1_000),
    detailLevel: 'summary' as const,
  };
}

function ensureAutomaticContinuation(
  controllerHome: string,
  repoId: string,
  workId: string,
  rootCode: string,
): string | undefined {
  try {
    const { schedule } = createWorkContinuationSchedule(controllerHome, repoId, {
      workId,
      scheduleMode: 'continuation',
      controllerType: 'chatgpt',
      scheduleName: `Repair recurrent Forge incident ${rootCode}`,
      requestId: `incident-repair-continuation:${workId}`,
      triggerType: 'interval',
      everyMinutes: 5,
      shadowMode: false,
      maxFailures: 5,
      cooldownMinutes: 15,
      dailyBudgetMinutes: 180,
      backoffBaseMinutes: 5,
      backoffMaxMinutes: 60,
      continuationPrompt: `Continue automatically registered Forge repair Work ${workId}. Reproduce root incident ${rootCode}, deduplicate against current source/lifecycle evidence, repair the canonical root cause in Forge source, verify, and finalize. Do not bypass Runtime/Recovery/Controller authority.`,
      stopConditions: ['work_terminal', 'human_review_required', 'external_blocker'],
    });
    touchSchedulerWakeSignal(controllerHome, `automatic incident repair schedule ${schedule.scheduleId} for ${workId}`);
    return schedule.scheduleId;
  } catch {
    return undefined;
  }
}

interface RepairEvidenceRef {
  evidenceId?: string;
  title: string;
  summary: string;
  detailLevel: 'summary';
}

function registerRecurringForgeRepair(input: {
  controllerHome: string;
  runtimeSourceRoot?: string;
  classification: ForgeIncidentRepairClassification;
  occurrenceCount: number;
  evidence: RepairEvidenceRef[];
  repairRepository?: RepositoryRecord;
}): ForgeIncidentRepairRegistration {
  const { classification } = input;
  if (!classification.eligible || !classification.fingerprint || !classification.rootCode) {
    return { eligible: false, recurrent: false, occurrenceCount: 0, reason: classification.reason };
  }
  if (input.occurrenceCount < RECURRENCE_THRESHOLD) {
    return {
      eligible: true, recurrent: false, occurrenceCount: input.occurrenceCount,
      fingerprint: classification.fingerprint, rootCode: classification.rootCode,
      reason: `waiting for ${RECURRENCE_THRESHOLD} occurrences within ${RECURRENCE_WINDOW_MS / 60_000} minutes`,
    };
  }

  const repairRepository = input.repairRepository
    ?? resolveRuntimeSourceRepairRepository(input.controllerHome, input.runtimeSourceRoot);
  if (!repairRepository) {
    return {
      eligible: true, recurrent: true, occurrenceCount: input.occurrenceCount,
      fingerprint: classification.fingerprint, rootCode: classification.rootCode,
      reason: 'runtime source authority could not be mapped unambiguously to one registered repository',
    };
  }

  const base = requestBase(classification.fingerprint);
  const lockResource = `incident-repair-${classification.fingerprint}`;
  return withControllerLock(input.controllerHome, { scope: 'global', resource: lockResource }, lockResource, () => {
    const store = { controllerHome: input.controllerHome, repoId: repairRepository.repoId };
    const matching = listWorkContracts({ ...store, status: 'all', limit: 500 })
      .filter((work) => requestGeneration(work.requestId, base) !== undefined)
      .sort((left, right) => (requestGeneration(left.requestId, base) ?? 0) - (requestGeneration(right.requestId, base) ?? 0));
    const active = [...matching].reverse().find((work) => !TERMINAL_WORK_STATUSES.has(work.status));
    const recentEvidence = input.evidence.slice(-RECURRENCE_THRESHOLD);

    if (active) {
      for (const evidence of recentEvidence) {
        if (evidence.evidenceId && active.evidenceRefs.some((entry) => entry.evidenceId === evidence.evidenceId)) continue;
        appendWorkEvidence(store, active.workId, evidence);
      }
      const scheduleId = ensureAutomaticContinuation(input.controllerHome, repairRepository.repoId, active.workId, classification.rootCode!);
      return {
        eligible: true, recurrent: true, occurrenceCount: input.occurrenceCount,
        fingerprint: classification.fingerprint, rootCode: classification.rootCode,
        repairRepoId: repairRepository.repoId, workId: active.workId, reusedExistingWork: true,
        scheduleId, reason: 'reused active canonical incident-repair Work',
      };
    }

    const predecessor = matching.at(-1);
    const generation = (predecessor ? (requestGeneration(predecessor.requestId, base) ?? 0) : 0) + 1;
    const requestId = `${base}:g${generation}`;
    const head = gitHead(repairRepository.canonicalRoot);
    if (!head) return {
      eligible: true, recurrent: true, occurrenceCount: input.occurrenceCount,
      fingerprint: classification.fingerprint, rootCode: classification.rootCode,
      repairRepoId: repairRepository.repoId, reason: 'repair repository HEAD could not be proven',
    };

    const routed = routeWorkStart({
      workStore: store, handoffStore: store, repoId: repairRepository.repoId,
      sourceRevision: head, checkoutId: repairRepository.activeCheckoutId,
    }, {
      objective: `Repair recurrent Forge infrastructure incident ${classification.rootCode} automatically registered after ${input.occurrenceCount} occurrences within ${RECURRENCE_WINDOW_MS / 60_000} minutes.`,
      acceptanceCriteria: [
        `Reproduce and eliminate root incident ${classification.rootCode} without bypassing canonical Runtime/Recovery/Controller authority.`,
        'Preserve fail-closed behavior for expected policy, ownership, user-code, and approval failures.',
        'Run focused affected checks and live verification before terminalizing the Work.',
      ],
      allowedPaths: ['src/**', 'tests/**', 'scripts/**', 'package.json'],
      initialLikelyPaths: [],
      forbiddenPaths: ['node_modules/**', '_ops/**'],
      constraints: { workspaceMode: 'auto', requireHandoffOnAmbiguity: true },
      request: { scopeClear: false, mutation: true, requiresRecovery: true, risk: 'workspace_write' },
      requestedBy: 'system',
      requestId,
      relatedWorkId: predecessor?.workId,
      workRelation: 'new_goal',
      workKind: 'repository_change',
    });
    if (routed.status !== 'ok') return {
      eligible: true, recurrent: true, occurrenceCount: input.occurrenceCount,
      fingerprint: classification.fingerprint, rootCode: classification.rootCode,
      repairRepoId: repairRepository.repoId,
      reason: `canonical Work admission did not create repair Work: ${routed.summary}`,
    };

    const created = listWorkContracts({ ...store, status: 'all', limit: 500 }).find((work) => work.requestId === requestId);
    if (!created) return {
      eligible: true, recurrent: true, occurrenceCount: input.occurrenceCount,
      fingerprint: classification.fingerprint, rootCode: classification.rootCode,
      repairRepoId: repairRepository.repoId,
      reason: 'canonical Work admission succeeded without a request-bound readable Work',
    };

    if (predecessor) appendWorkEvidence(store, created.workId, {
      title: 'incident repair predecessor',
      summary: `Recurrent root ${classification.rootCode} created successor generation ${generation} after terminal Work ${predecessor.workId} (${predecessor.status}).`,
      detailLevel: 'summary',
    });
    for (const evidence of recentEvidence) appendWorkEvidence(store, created.workId, evidence);
    const scheduleId = ensureAutomaticContinuation(input.controllerHome, repairRepository.repoId, created.workId, classification.rootCode!);
    return {
      eligible: true, recurrent: true, occurrenceCount: input.occurrenceCount,
      fingerprint: classification.fingerprint, rootCode: classification.rootCode,
      repairRepoId: repairRepository.repoId, workId: created.workId, reusedExistingWork: false,
      scheduleId, reason: 'created canonical recurrent-incident repair Work',
    };
  }, 10_000);
}

export function maybeRegisterMcpIncidentRepair(input: {
  controllerHome: string;
  runtimeSourceRoot?: string;
  incident: McpIncident;
  now?: () => number;
}): ForgeIncidentRepairRegistration {
  const classification = classifyForgeIncidentForRepair(input.incident);
  if (!classification.eligible || !classification.fingerprint || !classification.rootCode) {
    return { eligible: false, recurrent: false, occurrenceCount: 0, reason: classification.reason };
  }
  const occurrences = recentRootIncidents(input.controllerHome, classification, input.now?.() ?? Date.now());
  return registerRecurringForgeRepair({
    controllerHome: input.controllerHome,
    runtimeSourceRoot: input.runtimeSourceRoot,
    classification,
    occurrenceCount: occurrences.length,
    evidence: occurrences.map((incident, index) => incidentEvidence(incident, classification.rootCode!, index + 1)),
  });
}

export function maybeRegisterForgeActionableFailureRepair(input: {
  controllerHome: string;
  runtimeSourceRoot?: string;
  observation: ForgeActionableFailureObservation;
  now?: () => number;
}): ForgeIncidentRepairRegistration {
  const classification = classifyForgeActionableFailureForRepair(input.observation);
  if (!classification.eligible || !classification.fingerprint || !classification.rootCode) {
    return { eligible: false, recurrent: false, occurrenceCount: 0, reason: classification.reason };
  }

  const runtimeSourceRoot = input.runtimeSourceRoot ?? activeRuntimeSourceRoot(input.controllerHome);
  const repairRepository = resolveRuntimeSourceRepairRepository(input.controllerHome, runtimeSourceRoot);
  if (!repairRepository) return {
    eligible: true, recurrent: false, occurrenceCount: 0,
    fingerprint: classification.fingerprint, rootCode: classification.rootCode,
    reason: 'runtime source authority could not be mapped unambiguously to one registered repository',
  };

  const nowMs = input.now?.() ?? Date.now();
  const observedAt = input.observation.at?.trim() || new Date(nowMs).toISOString();
  const existing = readActionableFailureEvents(input.controllerHome, repairRepository.repoId);
  if (!existing.some((event) => event.data?.observationId === input.observation.observationId)) {
    appendRuntimeEvent(input.controllerHome, {
      repoId: repairRepository.repoId,
      entityType: 'portfolio',
      entityId: `forge-failure:${classification.fingerprint}`,
      eventType: ACTIONABLE_FAILURE_EVENT,
      requestId: `forge-actionable-failure:${input.observation.observationId}`,
      revision: 1,
      data: {
        observationId: input.observation.observationId,
        source: input.observation.source,
        rootCode: classification.rootCode,
        message: input.observation.message.slice(0, 2_000),
        observedAt,
        ...(input.observation.repoId ? { affectedRepoId: input.observation.repoId } : {}),
        ...(input.observation.workId ? { workId: input.observation.workId } : {}),
      },
    });
  }

  const occurrences = recentActionableRootEvents(input.controllerHome, repairRepository.repoId, classification, nowMs);
  return registerRecurringForgeRepair({
    controllerHome: input.controllerHome,
    runtimeSourceRoot,
    repairRepository,
    classification,
    occurrenceCount: occurrences.length,
    evidence: occurrences.map((event, index) => actionableEvidence(event, classification.rootCode!, index + 1)),
  });
}

export function maybeRegisterFailedReleaseSessionRepairs(input: {
  controllerHome: string;
  runtimeSourceRoot?: string;
  now?: () => number;
}): ForgeIncidentRepairRegistration[] {
  return listReleaseSessions(input.controllerHome, { maxEntries: 128 }).sessions
    .filter((session) => session.phase === 'failed')
    .slice(-32)
    .map((session) => {
      const lastReceipt = session.receipts.at(-1);
      const message = lastReceipt?.summary?.trim()
        || `ReleaseSession ${session.sessionId} entered failed phase without a diagnostic receipt.`;
      return maybeRegisterForgeActionableFailureRepair({
        controllerHome: input.controllerHome,
        runtimeSourceRoot: input.runtimeSourceRoot,
        now: input.now,
        observation: {
          observationId: `release:${session.sessionId}:r${session.revision}`,
          source: 'release',
          code: deriveForgeActionableFailureCode(
            `RELEASE_SESSION_${(lastReceipt?.kind ?? 'UNKNOWN').toUpperCase()}_FAILED`,
            message,
          ),
          message,
          at: session.updatedAt,
          repoId: session.candidateRelease?.sourceRepositoryId,
        },
      });
    });
}
