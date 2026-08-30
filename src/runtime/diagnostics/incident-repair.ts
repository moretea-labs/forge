import { createHash } from 'crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { listRepositories, selectRepositoryCheckout } from '../../cli/repositories/registry';
import { withControllerLock } from '../../cli/repositories/locks';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { loadRuntimeReleaseManifest } from '../root/release-manifest';
import { appendWorkEvidence, getWorkContract, listWorkContracts } from '../control-plane/facade/work-contract-store';
import { routeWorkStart } from '../control-plane/facade/goal-workloop';
import { createWorkContinuationSchedule } from '../workflow/schedules/work-continuation';
import { touchSchedulerWakeSignal } from '../control-plane/global-scheduler/wake-signal';
import type { McpIncident } from './mcp-timing';

const RECURRENCE_WINDOW_MS = 30 * 60_000;
const RECURRENCE_THRESHOLD = 3;
const INCIDENT_TAIL_BYTES = 256 * 1024;
const INCIDENT_WORK_PREFIX = 'forge-incident-repair';
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

function readBoundedIncidentTail(controllerHome: string): PersistedMcpIncident[] {
  const path = incidentAuditPath(controllerHome);
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, INCIDENT_TAIL_BYTES);
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
        const parsed = JSON.parse(line) as PersistedMcpIncident;
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

function recentRootIncidents(
  controllerHome: string,
  classification: ForgeIncidentRepairClassification,
  nowMs: number,
): PersistedMcpIncident[] {
  if (!classification.eligible || !classification.rootCode) return [];
  const unique = new Map<string, PersistedMcpIncident>();
  for (const candidate of readBoundedIncidentTail(controllerHome)) {
    const at = Date.parse(candidate.at ?? '');
    if (!Number.isFinite(at) || at < nowMs - RECURRENCE_WINDOW_MS || at > nowMs + 60_000) continue;
    if (classifyForgeIncidentForRepair(candidate).rootCode !== classification.rootCode) continue;
    if (!candidate.traceId?.trim()) continue;
    unique.set(candidate.traceId.trim(), candidate);
  }
  return [...unique.values()];
}

function gitContainsCommit(root: string, commit: string): boolean {
  const exists = spawnSync('git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`], {
    encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000,
  });
  if (exists.status !== 0) return false;
  const ancestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD'], {
    encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000,
  });
  return ancestor.status === 0;
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
 * Source-mode Runtime uses exact checkout path identity; immutable/package mode
 * must prove its release sourceCommit exists in exactly one enabled repo.
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
  let sourceCommit: string | undefined;
  try {
    sourceCommit = loadRuntimeReleaseManifest(manifestPath, controllerHome).sourceCommit;
  } catch {
    return undefined;
  }
  if (!sourceCommit || !/^[a-f0-9]{40}$/i.test(sourceCommit)) return undefined;
  const containing = repositories.filter((repository) => {
    const selected = selectRepositoryCheckout(repository, repository.activeCheckoutId);
    return gitContainsCommit(selected.canonicalRoot, sourceCommit!);
  });
  if (containing.length !== 1) return undefined;
  return selectRepositoryCheckout(containing[0]!, containing[0]!.activeCheckoutId);
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

/**
 * Promote only recurrent, source-authority-proven Forge infrastructure incidents
 * into canonical primary Work. The JSONL incident log remains evidence only;
 * WorkContract + existing continuation Schedule are the sole durable authorities.
 */
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
  const nowMs = input.now?.() ?? Date.now();
  const occurrences = recentRootIncidents(input.controllerHome, classification, nowMs);
  if (occurrences.length < RECURRENCE_THRESHOLD) {
    return {
      eligible: true,
      recurrent: false,
      occurrenceCount: occurrences.length,
      fingerprint: classification.fingerprint,
      rootCode: classification.rootCode,
      reason: `waiting for ${RECURRENCE_THRESHOLD} occurrences within ${RECURRENCE_WINDOW_MS / 60_000} minutes`,
    };
  }

  const repairRepository = resolveRuntimeSourceRepairRepository(input.controllerHome, input.runtimeSourceRoot);
  if (!repairRepository) {
    return {
      eligible: true,
      recurrent: true,
      occurrenceCount: occurrences.length,
      fingerprint: classification.fingerprint,
      rootCode: classification.rootCode,
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
    const recentEvidence = occurrences.slice(-RECURRENCE_THRESHOLD);
    if (active) {
      for (const [index, occurrence] of recentEvidence.entries()) {
        if (active.evidenceRefs.some((entry) => entry.evidenceId === `MCPINC-${occurrence.traceId}`)) continue;
        appendWorkEvidence(store, active.workId, incidentEvidence(occurrence, classification.rootCode!, occurrences.length - recentEvidence.length + index + 1));
      }
      const scheduleId = ensureAutomaticContinuation(input.controllerHome, repairRepository.repoId, active.workId, classification.rootCode!);
      return {
        eligible: true,
        recurrent: true,
        occurrenceCount: occurrences.length,
        fingerprint: classification.fingerprint,
        rootCode: classification.rootCode,
        repairRepoId: repairRepository.repoId,
        workId: active.workId,
        reusedExistingWork: true,
        scheduleId,
        reason: 'reused active canonical incident-repair Work',
      };
    }

    const predecessor = matching.at(-1);
    const generation = (predecessor ? (requestGeneration(predecessor.requestId, base) ?? 0) : 0) + 1;
    const requestId = `${base}:g${generation}`;
    const head = gitHead(repairRepository.canonicalRoot);
    if (!head) {
      return {
        eligible: true,
        recurrent: true,
        occurrenceCount: occurrences.length,
        fingerprint: classification.fingerprint,
        rootCode: classification.rootCode,
        repairRepoId: repairRepository.repoId,
        reason: 'repair repository HEAD could not be proven',
      };
    }
    const routed = routeWorkStart({
      workStore: store,
      handoffStore: store,
      repoId: repairRepository.repoId,
      sourceRevision: head,
      checkoutId: repairRepository.activeCheckoutId,
    }, {
      objective: `Repair recurrent Forge infrastructure incident ${classification.rootCode} automatically registered after ${occurrences.length} occurrences within ${RECURRENCE_WINDOW_MS / 60_000} minutes.`,
      acceptanceCriteria: [
        `Reproduce and eliminate root incident ${classification.rootCode} without bypassing canonical Runtime/Recovery/Controller authority.`,
        'Preserve fail-closed behavior for expected policy, ownership, user-code, and approval failures.',
        'Run focused affected checks and live verification before terminalizing the Work.',
      ],
      allowedPaths: ['src/**', 'tests/**', 'scripts/**', 'package.json'],
      initialLikelyPaths: [],
      forbiddenPaths: ['node_modules/**', '_ops/**'],
      constraints: { workspaceMode: 'auto', requireHandoffOnAmbiguity: true },
      modeInput: {
        scopeClear: false,
        mutation: true,
        requiresInvestigation: true,
        requiresRecovery: true,
        risk: 'workspace_write',
      },
      requestedBy: 'system',
      requestId,
      relatedWorkId: predecessor?.workId,
      workRelation: 'new_goal',
      workKind: 'repository_change',
    });
    if (routed.status !== 'ok') {
      return {
        eligible: true,
        recurrent: true,
        occurrenceCount: occurrences.length,
        fingerprint: classification.fingerprint,
        rootCode: classification.rootCode,
        repairRepoId: repairRepository.repoId,
        reason: `canonical Work admission did not create repair Work: ${routed.summary}`,
      };
    }
    const created = listWorkContracts({ ...store, status: 'all', limit: 500 }).find((work) => work.requestId === requestId);
    if (!created) {
      return {
        eligible: true,
        recurrent: true,
        occurrenceCount: occurrences.length,
        fingerprint: classification.fingerprint,
        rootCode: classification.rootCode,
        repairRepoId: repairRepository.repoId,
        reason: 'canonical Work admission succeeded without a request-bound readable Work',
      };
    }
    if (predecessor) {
      appendWorkEvidence(store, created.workId, {
        title: 'incident repair predecessor',
        summary: `Recurrent root ${classification.rootCode} created successor generation ${generation} after terminal Work ${predecessor.workId} (${predecessor.status}).`,
        detailLevel: 'summary',
      });
    }
    for (const [index, occurrence] of recentEvidence.entries()) {
      appendWorkEvidence(store, created.workId, incidentEvidence(occurrence, classification.rootCode!, occurrences.length - recentEvidence.length + index + 1));
    }
    const scheduleId = ensureAutomaticContinuation(input.controllerHome, repairRepository.repoId, created.workId, classification.rootCode!);
    return {
      eligible: true,
      recurrent: true,
      occurrenceCount: occurrences.length,
      fingerprint: classification.fingerprint,
      rootCode: classification.rootCode,
      repairRepoId: repairRepository.repoId,
      workId: created.workId,
      reusedExistingWork: false,
      scheduleId,
      reason: 'created canonical recurrent-incident repair Work',
    };
  }, 10_000);
}
