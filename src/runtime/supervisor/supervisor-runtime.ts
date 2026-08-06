import { realpathSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { loadMcpServiceLocalConfig, loadMcpServiceRuntimeState, readMcpServiceBearerToken, syncMcpControllerHomeBearerToken, writeMcpServiceLocalConfig, type McpRuntimeState } from '../../cli/mcp/auth';
import {
  ensureSlotHome,
  isRollbackWindowOpen,
  markCutoverAuthority,
  markRollbackAuthority,
  oppositeSlot,
  readActiveSlotAuthority,
  readSlotIdentity,
  writeActiveSlotAuthority,
  writeSlotIdentity,
  type ActiveSlotAuthority,
  type RuntimeSlotId,
} from '../../cli/controller/runtime-slots';
import { readControllerDaemonStatus, type ControllerDaemonStatus } from '../control-plane/daemon-client';
import { readRuntimeGeneration } from '../control-plane/runtime-generation';
import { createSupervisorControlServer, type SupervisorControlServerHandle, type SupervisorControlHandlers } from './control-server';
import { createStableIngressRouter, type StableIngressRouterHandle } from './ingress-router';
import { createSupervisorOperation, listSupervisorOperations, readSupervisorOperation, updateSupervisorOperation } from './operation-store';
import { DEFAULT_RESTART_POLICY, decideRestart, lockout, newRestartBudgetRecord, recordFailure, recordRestart, recordStable } from './restart-policy';
import { SupervisorProcessManager, type SpawnedSupervisorProcess, type SupervisorProcessManagerOptions } from './process-manager';
import { createSupervisorState, readSupervisorState, writeSupervisorState } from './state-store';
import { readCurrentSupervisorRelease, readPreviousSupervisorRelease, readSupervisorRelease, supervisorControlSocketPath, supervisorReleasesRoot, supervisorReleaseClosureMissing, type SupervisorReleaseDescriptor } from './paths';
import { stableIngressSessionStorePath } from './ingress-session-store';
import { publishSupervisorRelease, verifySupervisorReleaseExecutionCanary, verifySupervisorSourceIdentity } from './installer';
import {
  publishAndScheduleSupervisorRelease,
  readServiceActivationState,
  scheduleServiceActivation,
  type SupervisorReleaseActivationResult,
} from './service-activation';
import type { RestartBudgetRecord, SupervisorComponentName, SupervisorManagedProcess, SupervisorOperation, SupervisorOperationKind, SupervisorSourceIdentity, SupervisorState } from './types';

export interface StableSupervisorRuntimeOptions extends SupervisorProcessManagerOptions {
  controlHost?: string;
  controlPort?: number;
  rescueAuthToken?: string;
  releaseRevision?: string;
  serviceActivationScheduler?: typeof scheduleServiceActivation;
  activatePublishedRelease?: boolean;
  onHandoff?: () => void;
  onStopped?: () => void;
}

interface StartedRuntimeSlot {
  slot: RuntimeSlotId;
  generation?: string;
  manager: SupervisorProcessManager;
  controllerDaemon: SupervisorManagedProcess;
  gatewayHost: SupervisorManagedProcess;
  localControllerPort: number;
  durableJobId: string;
  mcpReadiness?: Awaited<ReturnType<typeof probeAuthenticatedMcpReadiness>>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export const SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD = Math.max(
  1,
  Math.ceil(DEFAULT_RESTART_POLICY.unhealthyWindowMs / DEFAULT_RESTART_POLICY.probeIntervalMs),
);

export interface SupervisorGatewayHealthProbeResult {
  healthy: boolean;
  detail: string;
  statusCode?: number;
  ready?: boolean;
  recoveryRecommended?: boolean;
  failureClass?: 'probe_timeout' | 'probe_cancelled' | 'connection_refused' | 'network_error' | 'invalid_body' | 'http_status' | 'unhealthy';
  timedOut?: boolean;
}

export function supervisorGatewayHealthDecision(
  previousFailures: number,
  healthy: boolean,
  cancelled = false,
): { consecutiveFailures: number; shouldRecover: boolean } {
  // A preempted probe (caller abort) is not evidence about gateway health and
  // must not consume the recovery budget: consecutiveFailures stays unchanged.
  if (cancelled) return { consecutiveFailures: Math.max(0, previousFailures), shouldRecover: false };
  const consecutiveFailures = healthy ? 0 : Math.max(0, previousFailures) + 1;
  return {
    consecutiveFailures,
    shouldRecover: !healthy && consecutiveFailures >= SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD,
  };
}

export const SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD = SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD;

export function supervisorIngressHealthDecision(
  previousFailures: number,
  healthy: boolean,
  recoverySuppressed = false,
): { consecutiveFailures: number; shouldReplace: boolean } {
  const consecutiveFailures = healthy ? 0 : Math.max(0, previousFailures) + 1;
  return {
    consecutiveFailures,
    shouldReplace: !recoverySuppressed
      && !healthy
      && consecutiveFailures >= SUPERVISOR_INGRESS_HEALTH_FAILURE_THRESHOLD,
  };
}

const SUPERVISOR_CUTOVER_OBSERVATION_MS = Math.max(
  1_000,
  Number(process.env.REPO_HARNESS_SUPERVISOR_CUTOVER_OBSERVATION_MS ?? 5_000) || 5_000,
);

export const SUPERVISOR_MONITOR_FAILURE_THRESHOLD = 3;

export function supervisorGatewayOperational(
  processAlive: boolean,
  state: SupervisorManagedProcess['state'] | undefined,
  consecutiveFailures: number,
): boolean {
  return processAlive
    && state === 'running'
    && Math.max(0, consecutiveFailures) < SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD;
}

export function supervisorGatewayRuntimeReady(runtime: McpRuntimeState | null | undefined): boolean {
  return runtime?.server.healthy === true
    && (runtime.status === 'running' || runtime.status === 'degraded');
}

function readinessBoundaryMs(managed: SupervisorManagedProcess, notBeforeMs?: number): number | undefined {
  if (Number.isFinite(notBeforeMs)) return Math.max(0, Math.trunc(notBeforeMs!));
  const parsed = Date.parse(managed.processStartTime);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestampMatchesManagedLaunch(value: string | undefined, boundaryMs: number | undefined): boolean {
  if (boundaryMs === undefined) return true;
  if (!value) return false;
  const parsed = Date.parse(value);
  // OS process start timestamps may have one-second precision. Keep a bounded
  // tolerance while still rejecting state left by a prior slot occupant.
  return Number.isFinite(parsed) && parsed >= boundaryMs - 1_000;
}

export function supervisorManagedDaemonReady(
  status: ControllerDaemonStatus,
  managed: SupervisorManagedProcess,
  notBeforeMs?: number,
): boolean {
  if (status.status !== 'ready' || status.degraded === true) return false;
  if (status.pid !== managed.pid) return false;
  if (status.instanceId !== managed.instanceId) return false;
  if (status.ownerEpoch !== managed.ownerEpoch) return false;
  if (managed.slot && status.slot !== managed.slot) return false;
  if (managed.generation && status.generation !== managed.generation) return false;
  const observedReleaseRevision = status.source?.releaseRevision ?? status.source?.commit;
  if (managed.releaseRevision && observedReleaseRevision !== managed.releaseRevision) return false;
  return timestampMatchesManagedLaunch(status.startedAt, readinessBoundaryMs(managed, notBeforeMs));
}

export function supervisorManagedGatewayReady(
  runtime: McpRuntimeState | null | undefined,
  managed: SupervisorManagedProcess,
  notBeforeMs?: number,
): boolean {
  if (!supervisorGatewayRuntimeReady(runtime)) return false;
  if (managed.generation
    && (runtime?.generation !== managed.generation || runtime.server.generation !== managed.generation)) return false;
  const observedReleaseRevision = runtime?.source?.releaseRevision ?? runtime?.source?.commit;
  if (managed.releaseRevision && observedReleaseRevision !== managed.releaseRevision) return false;
  const boundaryMs = readinessBoundaryMs(managed, notBeforeMs);
  return timestampMatchesManagedLaunch(runtime?.startedAt, boundaryMs)
    && timestampMatchesManagedLaunch(runtime?.updatedAt, boundaryMs);
}

export function supervisorMonitorFailureDecision(
  previousFailures: number,
  healthy: boolean,
): { consecutiveFailures: number; shouldRestart: boolean } {
  const consecutiveFailures = healthy ? 0 : Math.max(0, previousFailures) + 1;
  return {
    consecutiveFailures,
    shouldRestart: !healthy && consecutiveFailures >= SUPERVISOR_MONITOR_FAILURE_THRESHOLD,
  };
}

export async function probeSupervisorGatewayHealth(
  endpoint: string,
  timeoutMs = 2_000,
): Promise<SupervisorGatewayHealthProbeResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    let healthStatus: unknown;
    let readiness: unknown;
    let recoveryRecommended = false;
    try {
      const payload = await response.json() as {
        status?: unknown;
        ready?: unknown;
        sessionCapacity?: { recoveryRecommended?: unknown; acceptingNewSessions?: unknown };
      };
      healthStatus = payload?.status;
      readiness = payload?.ready;
      recoveryRecommended = payload?.sessionCapacity?.recoveryRecommended === true;
    } catch {
      return {
        healthy: false,
        statusCode: response.status,
        detail: 'invalid_health_body',
        failureClass: 'invalid_body',
      };
    }
    if (readiness === false) {
      return {
        healthy: true,
        ready: false,
        recoveryRecommended,
        statusCode: response.status,
        detail: recoveryRecommended
          ? 'gateway readiness requires bounded recovery'
          : 'gateway is live but temporarily not ready',
      };
    }
    if (!response.ok) {
      return {
        healthy: false,
        statusCode: response.status,
        detail: `status=${response.status}${healthStatus === undefined ? '' : ` health=${String(healthStatus)}`}`,
        failureClass: 'http_status',
      };
    }
    if (readiness === true) {
      return { healthy: true, ready: true, recoveryRecommended: false, statusCode: response.status, detail: 'ready' };
    }
    if (healthStatus !== 'ok') {
      return { healthy: false, statusCode: response.status, detail: `health=${String(healthStatus)}`, failureClass: 'unhealthy' };
    }
    return { healthy: true, statusCode: response.status, detail: 'ok' };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
    const errorCode = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    // Only the internal deadline timer sets `timedOut`. Any other AbortError is
    // a caller preemption and is not evidence about the gateway's health, so it
    // is classified separately and must not consume the recovery budget.
    const preempted = !timedOut && ((error instanceof Error && error.name === 'AbortError') || /operation was aborted/i.test(detail));
    const failureClass = timedOut
      ? 'probe_timeout'
      : preempted
        ? 'probe_cancelled'
        : errorCode === 'ECONNREFUSED' || /ECONNREFUSED/i.test(detail)
          ? 'connection_refused'
          : 'network_error';
    return {
      healthy: false,
      detail: `${failureClass}: ${detail || 'health probe failed'}`,
      failureClass,
      ...(timedOut ? { timedOut: true } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface McpProbeCallResult {
  ok: boolean;
  detail: string;
  status?: number;
  payload?: Record<string, unknown>;
  sessionId?: string;
}

function parseMcpProbePayload(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      } catch {
        // Continue to the next SSE data frame.
      }
    }
    return undefined;
  }
}

async function callMcpProbe(input: {
  endpoint: string;
  token?: string;
  sessionId?: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs: number;
}): Promise<McpProbeCallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...(input.sessionId ? { 'mcp-session-id': input.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: input.id,
        method: input.method,
        ...(input.params ? { params: input.params } : {}),
      }),
    });
    const text = await response.text();
    const payload = parseMcpProbePayload(text);
    const rpcError = payload?.error;
    return {
      ok: response.ok && !rpcError,
      detail: `HTTP ${response.status}${rpcError ? ' JSON-RPC error' : ''}`,
      status: response.status,
      ...(payload ? { payload } : {}),
      ...(response.headers.get('mcp-session-id') ? { sessionId: response.headers.get('mcp-session-id')! } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      detail: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface CutoverReadinessSample {
  daemonAlive: boolean;
  gatewayAlive: boolean;
  daemon: { status: string; degraded?: boolean; error?: string };
  gateway: SupervisorGatewayHealthProbeResult;
  daemonGeneration?: string;
  gatewayGeneration?: string;
}

export async function sampleCutoverReadiness(input: {
  daemonAlive: boolean;
  gatewayAlive: boolean;
  readDaemon(): CutoverReadinessSample['daemon'];
  probeGateway(): Promise<SupervisorGatewayHealthProbeResult>;
  readDaemonGeneration?(): string | undefined;
  readGatewayGeneration?(): string | undefined;
}): Promise<CutoverReadinessSample> {
  const deferredGateway: SupervisorGatewayHealthProbeResult = {
    healthy: false,
    detail: 'gateway probe deferred until the Daemon is ready',
  };
  if (!input.daemonAlive || !input.gatewayAlive) {
    return {
      daemonAlive: input.daemonAlive,
      gatewayAlive: input.gatewayAlive,
      daemon: { status: 'unavailable' },
      gateway: deferredGateway,
    };
  }

  const daemon = input.readDaemon();
  if (daemon.status !== 'ready' || daemon.degraded) {
    return {
      daemonAlive: true,
      gatewayAlive: true,
      daemon,
      gateway: deferredGateway,
    };
  }

  const gateway = await input.probeGateway();
  if (!gateway.healthy || gateway.ready === false) {
    return {
      daemonAlive: true,
      gatewayAlive: true,
      daemon,
      gateway,
    };
  }
  return {
    daemonAlive: true,
    gatewayAlive: true,
    daemon,
    gateway,
    daemonGeneration: input.readDaemonGeneration?.(),
    gatewayGeneration: input.readGatewayGeneration?.(),
  };
}

export async function observeCutoverReadinessWindow(input: {
  expectedGeneration?: string;
  timeoutMs: number;
  intervalMs?: number;
  stabilityMs?: number;
  sample(): Promise<CutoverReadinessSample> | CutoverReadinessSample;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? sleep;
  const timeoutMs = Math.max(1_000, input.timeoutMs);
  const intervalMs = Math.max(25, input.intervalMs ?? 250);
  const stabilityMs = Math.min(timeoutMs, Math.max(250, input.stabilityMs ?? 1_000));
  const deadline = now() + timeoutMs;
  let stableSince: number | undefined;
  let lastReadinessFailure = 'SUPERVISOR_CUTOVER_READINESS_TIMEOUT: no healthy sample observed';

  while (true) {
    const sample = await input.sample();
    if (!sample.daemonAlive) throw new Error('SUPERVISOR_CUTOVER_DAEMON_LIVENESS_FAILED');
    if (!sample.gatewayAlive) throw new Error('SUPERVISOR_CUTOVER_GATEWAY_LIVENESS_FAILED');

    if (sample.daemon.status !== 'ready' || sample.daemon.degraded) {
      stableSince = undefined;
      lastReadinessFailure = `SUPERVISOR_CUTOVER_DAEMON_READINESS_FAILED: status=${sample.daemon.status}${sample.daemon.error ? ` error=${sample.daemon.error}` : ''}`;
    } else if (!sample.gateway.healthy || sample.gateway.ready === false) {
      stableSince = undefined;
      lastReadinessFailure = `SUPERVISOR_CUTOVER_GATEWAY_READINESS_FAILED: ${sample.gateway.detail}`;
    } else {
      if (input.expectedGeneration
        && (sample.daemonGeneration !== input.expectedGeneration || sample.gatewayGeneration !== input.expectedGeneration)) {
        throw new Error(
          `SUPERVISOR_CUTOVER_GENERATION_MISMATCH: expected=${input.expectedGeneration} daemon=${sample.daemonGeneration ?? 'missing'} gateway=${sample.gatewayGeneration ?? 'missing'}`,
        );
      }
      const observedAt = now();
      stableSince ??= observedAt;
      if (observedAt - stableSince >= stabilityMs) return;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error(lastReadinessFailure);
    await wait(Math.min(intervalMs, remainingMs));
  }
}

export async function probeAuthenticatedMcpReadiness(input: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<{ healthy: boolean; detail: string; toolCount?: number; readOnlyTool?: string }> {
  const baseUrl = input.baseUrl.replace(/\/$/, '');
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 8_000);
  const oauthChallenge = await callMcpProbe({
    endpoint: `${baseUrl}/mcp`,
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stable-supervisor-probe', version: '1' } },
    timeoutMs,
  });
  if (oauthChallenge.status !== 401) {
    return { healthy: false, detail: `OAuth MCP challenge expected HTTP 401, received ${oauthChallenge.detail}` };
  }

  const endpoint = `${baseUrl}/mcp-bearer`;
  const initialized = await callMcpProbe({
    endpoint,
    token: input.token,
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stable-supervisor-probe', version: '1' } },
    timeoutMs,
  });
  if (!initialized.ok) return { healthy: false, detail: `MCP initialize failed: ${initialized.detail}` };

  const listed = await callMcpProbe({
    endpoint,
    token: input.token,
    sessionId: initialized.sessionId,
    id: 3,
    method: 'tools/list',
    timeoutMs,
  });
  const tools = Array.isArray((listed.payload?.result as { tools?: unknown } | undefined)?.tools)
    ? ((listed.payload!.result as { tools: Array<{ name?: unknown }> }).tools)
    : [];
  const names = tools.map((tool) => typeof tool.name === 'string' ? tool.name : '').filter(Boolean);
  if (!listed.ok || names.length === 0) {
    return { healthy: false, detail: `MCP tools/list failed: ${listed.detail}; count=${names.length}` };
  }

  const readOnlyTool = names.includes('controller_ready')
    ? { name: 'controller_ready', arguments: {} }
    : names.includes('rh_status')
      ? { name: 'rh_status', arguments: { operation: 'get', detail_level: 'summary' } }
      : undefined;
  if (!readOnlyTool) {
    return { healthy: false, detail: `MCP tool surface lacks a cutover-safe readiness tool; count=${names.length}`, toolCount: names.length };
  }
  const called = await callMcpProbe({
    endpoint,
    token: input.token,
    sessionId: initialized.sessionId,
    id: 4,
    method: 'tools/call',
    params: { name: readOnlyTool.name, arguments: readOnlyTool.arguments },
    timeoutMs,
  });
  if (!called.ok) {
    return { healthy: false, detail: `MCP ${readOnlyTool.name} failed: ${called.detail}`, toolCount: names.length, readOnlyTool: readOnlyTool.name };
  }
  return {
    healthy: true,
    detail: `OAuth challenge and authenticated MCP initialize/tools/list/${readOnlyTool.name} passed`,
    toolCount: names.length,
    readOnlyTool: readOnlyTool.name,
  };
}

function processState(spawned: SpawnedSupervisorProcess, previous?: SupervisorManagedProcess): SupervisorManagedProcess {
  const now = new Date().toISOString();
  const generation = readRuntimeGeneration(spawned.identity.controllerHome)?.generation;
  return {
    ...spawned.identity,
    ...(generation ? { generation } : {}),
    state: 'running',
    lastLivenessAt: now,
    restartCount: previous?.restartCount ?? 0,
    consecutiveFailures: 0,
  };
}

function operationActive(operation: SupervisorOperation): boolean {
  return !['succeeded', 'failed', 'locked_out'].includes(operation.phase);
}

interface SupervisorActivationReference {
  activationId: string;
  expectedReleaseRevision?: string;
}

type RolloutRecoveryCheckpointStage = 'authority_committed' | 'runtime_activated';

interface RolloutRecoveryCheckpoint {
  stage: RolloutRecoveryCheckpointStage;
  candidateSlot: RuntimeSlotId;
  previousSlot: RuntimeSlotId;
  candidateReleasePath: string;
  candidateGeneration?: string;
  previousGeneration?: string;
  expectedReleaseRevision?: string;
  recordedAt: string;
}

interface InterruptedRolloutRecovery {
  operationId: string;
  releasePath: string;
  candidateSlot: RuntimeSlotId;
  candidateGeneration?: string;
}

function operationRolloutCheckpoint(operation: SupervisorOperation): RolloutRecoveryCheckpoint | undefined {
  const value = operation.result?.rolloutCheckpoint;
  if (!value || typeof value !== 'object') return undefined;
  const checkpoint = value as Record<string, unknown>;
  const stage = checkpoint.stage;
  const candidateSlot = checkpoint.candidateSlot;
  const previousSlot = checkpoint.previousSlot;
  const candidateReleasePath = checkpoint.candidateReleasePath;
  const recordedAt = checkpoint.recordedAt;
  if (stage !== 'authority_committed' && stage !== 'runtime_activated') return undefined;
  if ((candidateSlot !== 'blue' && candidateSlot !== 'green') || (previousSlot !== 'blue' && previousSlot !== 'green')) return undefined;
  if (typeof candidateReleasePath !== 'string' || !candidateReleasePath.trim() || typeof recordedAt !== 'string') return undefined;
  return {
    stage,
    candidateSlot,
    previousSlot,
    candidateReleasePath,
    ...(typeof checkpoint.candidateGeneration === 'string' ? { candidateGeneration: checkpoint.candidateGeneration } : {}),
    ...(typeof checkpoint.previousGeneration === 'string' ? { previousGeneration: checkpoint.previousGeneration } : {}),
    ...(typeof checkpoint.expectedReleaseRevision === 'string' ? { expectedReleaseRevision: checkpoint.expectedReleaseRevision } : {}),
    recordedAt,
  };
}

function resultWithRolloutCheckpoint(operation: SupervisorOperation, checkpoint: RolloutRecoveryCheckpoint): Record<string, unknown> {
  return { ...(operation.result ?? {}), rolloutCheckpoint: checkpoint };
}

export function resumableInterruptedRollout(
  state: SupervisorState,
  authority: ActiveSlotAuthority,
  operations: SupervisorOperation[],
): InterruptedRolloutRecovery | undefined {
  for (const operation of operations) {
    if (operation.kind !== 'rollout' || !operationActive(operation)) continue;
    if (state.currentOperationId !== operation.operationId) continue;
    const checkpoint = operationRolloutCheckpoint(operation);
    if (!checkpoint || authority.activeSlot !== checkpoint.candidateSlot) continue;
    if (checkpoint.candidateGeneration && authority.generation && checkpoint.candidateGeneration !== authority.generation) continue;
    return {
      operationId: operation.operationId,
      releasePath: checkpoint.candidateReleasePath,
      candidateSlot: checkpoint.candidateSlot,
      ...(checkpoint.candidateGeneration ? { candidateGeneration: checkpoint.candidateGeneration } : {}),
    };
  }
  return undefined;
}

export function supervisorOperationRecoverySuppressed(currentOperationId: string | null | undefined): boolean {
  return Boolean(currentOperationId?.trim());
}

function supervisorErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 600);
}

export function recoverableCutoverObservationFailure(error: unknown): boolean {
  return /^SUPERVISOR_CUTOVER_(?:DAEMON|GATEWAY)_(?:LIVENESS|READINESS)_FAILED/.test(supervisorErrorMessage(error));
}

export function recoverableWriterClaimRefreshFailure(error: unknown): boolean {
  const message = supervisorErrorMessage(error);
  return /^SUPERVISOR_(?:CONTROLLERDAEMON|GATEWAYHOST)_(?:PROCESS_DIED|READINESS_TIMEOUT)/.test(message)
    || message.startsWith('SUPERVISOR_ACTIVATED_MCP_READINESS_FAILED:');
}

export async function refreshWriterClaimWithSingleRetry<T>(
  candidate: T,
  refresh: (value: T) => Promise<T>,
  onRetry?: (firstFailure: string) => Promise<void> | void,
): Promise<{ candidate: T; retried: boolean; firstFailure?: string }> {
  try {
    return { candidate: await refresh(candidate), retried: false };
  } catch (error) {
    if (!recoverableWriterClaimRefreshFailure(error)) throw error;
    const firstFailure = supervisorErrorMessage(error);
    await onRetry?.(firstFailure);
    try {
      return { candidate: await refresh(candidate), retried: true, firstFailure };
    } catch (secondError) {
      throw new Error(
        `SUPERVISOR_WRITER_REFRESH_RETRY_EXHAUSTED: initial=${firstFailure}; second=${supervisorErrorMessage(secondError)}`,
      );
    }
  }
}

export function combinedRolloutRollbackFailure(primary: unknown, rollback: unknown): Error {
  return new Error(
    `SUPERVISOR_ROLLOUT_AND_ROLLBACK_FAILED: primary=${supervisorErrorMessage(primary)}; rollback=${supervisorErrorMessage(rollback)}`,
  );
}

export async function observeCutoverCandidateWithSingleRecovery<T>(
  candidate: T,
  observe: (value: T) => Promise<void>,
  recover: (value: T, firstFailure: string) => Promise<T>,
): Promise<{ candidate: T; recovered: boolean; firstFailure?: string }> {
  try {
    await observe(candidate);
    return { candidate, recovered: false };
  } catch (error) {
    if (!recoverableCutoverObservationFailure(error)) throw error;
    const firstFailure = supervisorErrorMessage(error);
    let recovered: T;
    try {
      recovered = await recover(candidate, firstFailure);
    } catch (recoveryError) {
      throw new Error(
        `SUPERVISOR_CUTOVER_RECOVERY_FAILED: initial=${firstFailure}; recovery=${supervisorErrorMessage(recoveryError)}`,
      );
    }
    try {
      await observe(recovered);
      return { candidate: recovered, recovered: true, firstFailure };
    } catch (secondError) {
      throw new Error(
        `SUPERVISOR_CUTOVER_RECOVERY_EXHAUSTED: initial=${firstFailure}; second=${supervisorErrorMessage(secondError)}`,
      );
    }
  }
}

function operationActivationReference(operation: SupervisorOperation): SupervisorActivationReference | undefined {
  const value = operation.result?.supervisorActivation;
  if (!value || typeof value !== 'object') return undefined;
  const activation = value as Record<string, unknown>;
  if (typeof activation.activationId !== 'string') return undefined;
  return {
    activationId: activation.activationId,
    ...(typeof activation.expectedReleaseRevision === 'string'
      ? { expectedReleaseRevision: activation.expectedReleaseRevision }
      : {}),
  };
}

export function reconcilePendingSupervisorActivations(controllerHome: string): number {
  const activationState = readServiceActivationState(controllerHome);
  if (!activationState) return 0;
  let reconciled = 0;
  for (const operation of listSupervisorOperations(controllerHome, 100)) {
    if (operation.phase !== 'cutover') continue;
    const reference = operationActivationReference(operation);
    if (!reference || reference.activationId !== activationState.activationId) continue;
    if (activationState.phase === 'succeeded') {
      const actualRevision = activationState.expectedReleaseRevision
        ?? (typeof activationState.releaseRevision === 'string' ? activationState.releaseRevision : undefined);
      if (reference.expectedReleaseRevision && actualRevision !== reference.expectedReleaseRevision) {
        updateSupervisorOperation(controllerHome, operation.operationId, {
          phase: 'failed',
          completedAt: new Date().toISOString(),
          failureClass: 'identity',
          error: `SUPERVISOR_ACTIVATION_RELEASE_MISMATCH: expected=${reference.expectedReleaseRevision} actual=${actualRevision ?? 'missing'}`,
        });
      } else {
        updateSupervisorOperation(controllerHome, operation.operationId, {
          phase: 'succeeded',
          completedAt: new Date().toISOString(),
          evidence: [
            ...(operation.evidence ?? []),
            { kind: 'supervisor_activation', summary: `Supervisor activation ${reference.activationId} completed and matched the expected release.`, at: new Date().toISOString() },
          ],
        });
      }
      reconciled += 1;
    } else if (activationState.phase === 'failed') {
      updateSupervisorOperation(controllerHome, operation.operationId, {
        phase: 'failed',
        completedAt: new Date().toISOString(),
        failureClass: 'startup',
        error: activationState.error ?? 'SUPERVISOR_ACTIVATION_FAILED',
      });
      reconciled += 1;
    }
  }
  return reconciled;
}

function operationKindForComponent(component: SupervisorComponentName): SupervisorOperationKind {
  return component === 'controllerDaemon' ? 'restart_controller' : 'restart_gateway';
}

function managedKey(component: SupervisorComponentName, generation?: string): string {
  return `${component}:${generation ?? 'unknown'}`;
}

export function terminalizeInterruptedSupervisorOperations(
  controllerHome: string,
  preserveOperationIds: ReadonlySet<string> = new Set<string>(),
): number {
  let terminalized = 0;
  for (const operation of listSupervisorOperations(controllerHome, 100)) {
    if (!operationActive(operation) || operation.phase === 'accepted' || operation.phase === 'scheduled') continue;
    if (preserveOperationIds.has(operation.operationId)) continue;
    // A rollout/rollback that has switched traffic and scheduled Supervisor
    // activation is intentionally resumed by the new Supervisor. It must not be
    // misclassified as an interrupted mutation during the handoff.
    if (operation.phase === 'cutover' && operationActivationReference(operation)) continue;
    updateSupervisorOperation(controllerHome, operation.operationId, {
      phase: 'failed',
      completedAt: new Date().toISOString(),
      failureClass: 'startup',
      error: 'SUPERVISOR_RESTART_INTERRUPTED_OPERATION',
      evidence: [...(operation.evidence ?? []), { kind: 'supervisor_restart', summary: 'Operation was terminalized instead of blindly replayed after Supervisor restart.', at: new Date().toISOString() }],
    });
    terminalized += 1;
  }
  return terminalized;
}

function currentManagedPairSlot(state: SupervisorState): RuntimeSlotId | undefined {
  if (!state.controllerDaemon || !state.gatewayHost) return undefined;
  const daemonSlot = state.controllerDaemon.slot ?? state.activeSlot;
  const gatewaySlot = state.gatewayHost.slot ?? state.activeSlot;
  return daemonSlot === gatewaySlot ? daemonSlot : undefined;
}

export function reconcileActiveManagedGenerations(
  state: SupervisorState,
  observed: { controllerDaemon?: string; gatewayHost?: string },
): { state: SupervisorState; coherent: boolean; generation?: string } {
  const daemon = state.controllerDaemon;
  const gateway = state.gatewayHost;
  const daemonSlot = daemon?.slot ?? state.activeSlot;
  const gatewaySlot = gateway?.slot ?? state.activeSlot;
  const activePair = Boolean(
    daemon
    && gateway
    && daemonSlot === state.activeSlot
    && gatewaySlot === state.activeSlot,
  );
  const coherentGeneration = activePair
    && observed.controllerDaemon
    && observed.gatewayHost
    && observed.controllerDaemon === observed.gatewayHost
    ? observed.controllerDaemon
    : undefined;
  const daemonChanged = Boolean(daemon && observed.controllerDaemon && daemon.generation !== observed.controllerDaemon);
  const gatewayChanged = Boolean(gateway && observed.gatewayHost && gateway.generation !== observed.gatewayHost);
  const activeChanged = Boolean(coherentGeneration && state.activeGeneration !== coherentGeneration);
  if (!daemonChanged && !gatewayChanged && !activeChanged) {
    return { state, coherent: Boolean(coherentGeneration), ...(coherentGeneration ? { generation: coherentGeneration } : {}) };
  }
  return {
    state: {
      ...state,
      ...(daemon && observed.controllerDaemon
        ? { controllerDaemon: { ...daemon, generation: observed.controllerDaemon } }
        : {}),
      ...(gateway && observed.gatewayHost
        ? { gatewayHost: { ...gateway, generation: observed.gatewayHost } }
        : {}),
      ...(coherentGeneration ? { activeGeneration: coherentGeneration } : {}),
      updatedAt: new Date().toISOString(),
    },
    coherent: Boolean(coherentGeneration),
    ...(coherentGeneration ? { generation: coherentGeneration } : {}),
  };
}

export function managedProcessNeedsReleaseRefresh(
  managed: SupervisorManagedProcess,
  expected: SupervisorReleaseDescriptor,
  ownerEpoch: number,
  processCommandMatches: boolean,
  options: { allowOwnerEpochAdoption?: boolean } = {},
): boolean {
  const ownerEpochMismatch = managed.ownerEpoch !== ownerEpoch
    && options.allowOwnerEpochAdoption !== true;
  return ownerEpochMismatch
    || resolve(managed.releasePath ?? '') !== expected.releasePath
    || managed.releaseRevision !== expected.releaseRevision
    || !processCommandMatches;
}

export function reconcileSupervisorStateWithAuthority(
  state: SupervisorState,
  authority: ActiveSlotAuthority,
): SupervisorState {
  const now = new Date().toISOString();
  const currentSlot = currentManagedPairSlot(state);
  if (!state.controllerDaemon && !state.gatewayHost && !state.standby) {
    return {
      ...state,
      activeSlot: authority.activeSlot,
      previousSlot: authority.previousSlot,
      activeGeneration: authority.generation ?? state.activeGeneration,
      ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
      updatedAt: now,
    };
  }
  if (currentSlot === authority.activeSlot) {
    return {
      ...state,
      activeSlot: authority.activeSlot,
      previousSlot: authority.previousSlot,
      activeGeneration: authority.generation ?? state.controllerDaemon?.generation ?? state.activeGeneration,
      ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
      updatedAt: now,
    };
  }
  if (state.standby?.slot === authority.activeSlot) {
    const displaced = currentSlot && state.controllerDaemon && state.gatewayHost
      ? {
          slot: currentSlot,
          ...(state.controllerDaemon.generation ?? state.activeGeneration ? { generation: state.controllerDaemon.generation ?? state.activeGeneration } : {}),
          controllerDaemon: state.controllerDaemon,
          gatewayHost: state.gatewayHost,
          ...(authority.previousSlot === currentSlot && authority.rollbackUntil ? { retainedUntil: authority.rollbackUntil } : {}),
        }
      : undefined;
    return {
      ...state,
      activeSlot: authority.activeSlot,
      previousSlot: authority.previousSlot,
      activeGeneration: authority.generation ?? state.standby.generation ?? state.standby.controllerDaemon.generation,
      controllerDaemon: state.standby.controllerDaemon,
      gatewayHost: state.standby.gatewayHost,
      standby: displaced,
      observedState: 'degraded',
      ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
      lastIncident: { at: now, reason: 'Supervisor state was reconciled to the active-slot authority after restart.' },
      updatedAt: now,
    };
  }
  const displaced = currentSlot && currentSlot !== authority.activeSlot && state.controllerDaemon && state.gatewayHost
    ? {
        slot: currentSlot,
        ...(state.controllerDaemon.generation ?? state.activeGeneration ? { generation: state.controllerDaemon.generation ?? state.activeGeneration } : {}),
        controllerDaemon: state.controllerDaemon,
        gatewayHost: state.gatewayHost,
      }
    : state.standby?.slot !== authority.activeSlot ? state.standby : undefined;
  return {
    ...state,
    activeSlot: authority.activeSlot,
    previousSlot: authority.previousSlot,
    activeGeneration: authority.generation,
    controllerDaemon: undefined,
    gatewayHost: undefined,
    standby: displaced,
    observedState: 'degraded',
    ingress: { ...state.ingress, activeUpstreamSlot: authority.activeSlot },
    lastIncident: {
      at: now,
      reason: 'No managed process pair matched the active-slot authority after restart; rebuilding the managed pair on the active slot.',
    },
    updatedAt: now,
  };
}

export function automaticRecoveryRequestId(
  component: SupervisorComponentName,
  generation: string | undefined,
  budget: RestartBudgetRecord,
): string {
  const parsedWindow = Date.parse(budget.windowStartedAt);
  const windowKey = Number.isFinite(parsedWindow) ? String(parsedWindow) : 'unknown';
  return `auto-recover:${component}:${generation ?? 'unknown'}:${windowKey}:${budget.attempts + 1}`;
}

export class StableSupervisorRuntime implements SupervisorControlHandlers {
  readonly options: StableSupervisorRuntimeOptions;
  readonly manager: SupervisorProcessManager;
  private state: SupervisorState;
  private control?: SupervisorControlServerHandle;
  private ingressRouter?: StableIngressRouterHandle;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private monitorPromise?: Promise<void>;
  private executionPromise?: Promise<void>;
  private interruptedRollout?: InterruptedRolloutRecovery & { release: SupervisorReleaseDescriptor };
  private stopping = false;
  private monitorFailureCount = 0;
  private selfRestartRequested = false;

  constructor(options: StableSupervisorRuntimeOptions) {
    const serviceConfig = loadMcpServiceLocalConfig(options.controllerHome, options.repoRoot);
    const installedRelease = readSupervisorRelease(options.releasePath)
      ?? readCurrentSupervisorRelease(options.controllerHome);
    this.options = {
      ...options,
      ...(installedRelease ? {
        runtimeExecutable: options.runtimeExecutable ?? installedRelease.runtimeExecutable,
        daemonExecutable: options.daemonExecutable ?? installedRelease.daemonExecutable,
        runtimeSourceRoot: options.runtimeSourceRoot ?? installedRelease.sourceRoot ?? options.runtimeSourceRoot,
        releasePath: options.releasePath ?? installedRelease.releasePath,
        releaseRevision: options.releaseRevision ?? installedRelease.releaseRevision,
      } : {}),
      stableIngressHost: options.stableIngressHost ?? serviceConfig?.server?.host ?? '127.0.0.1',
      stableIngressPort: options.stableIngressPort ?? serviceConfig?.server?.port ?? 8765,
    };
    this.manager = new SupervisorProcessManager(this.options);
    const existing = readSupervisorState(options.controllerHome);
    this.state = existing ?? createSupervisorState(options.controllerHome, {
      pid: process.pid,
      instanceId: `sup-${process.pid}`,
      processStartTime: new Date().toISOString(),
      executableFingerprint: 'pending',
      controllerHome: options.controllerHome,
      ownerEpoch: options.ownerEpoch,
    }, { releaseRevision: options.releaseRevision });
  }

  getState(): SupervisorState | null {
    return this.state;
  }

  adoptSupervisorIdentity(identity: SupervisorState['supervisor'], releaseRevision?: string): void {
    const release = this.expectedManagedRelease();
    this.state = {
      ...this.state,
      supervisor: {
        ...identity,
        ...(release?.releasePath ? { releasePath: release.releasePath } : {}),
        ...(releaseRevision ?? release?.releaseRevision ? { releaseRevision: releaseRevision ?? release?.releaseRevision } : {}),
      },
      desiredState: 'running',
      observedState: 'starting',
      updatedAt: new Date().toISOString(),
    };
  }

  getOperation(operationId: string): SupervisorOperation | null {
    return readSupervisorOperation(this.options.controllerHome, operationId);
  }

  submitOperation(input: {
    requestId: string;
    kind: SupervisorOperationKind;
    actor: string;
    reason?: string;
    candidateReleasePath?: string;
    targetReleasePath?: string;
    repoRoot?: string;
    sourceIdentity?: SupervisorSourceIdentity;
  }): { operation: SupervisorOperation; deduplicated: boolean } {
    return this.submitCommand(input);
  }

  submitCommand(input: {
    requestId: string;
    kind: SupervisorOperationKind;
    actor: string;
    reason?: string;
    candidateReleasePath?: string;
    targetReleasePath?: string;
    repoRoot?: string;
    sourceIdentity?: SupervisorSourceIdentity;
  }): { operation: SupervisorOperation; deduplicated: boolean } {
    const accepted = createSupervisorOperation({
      controllerHome: this.options.controllerHome,
      repoRoot: input.repoRoot ?? this.options.repoRoot,
      requestId: input.requestId,
      kind: input.kind,
      requestedBy: input.actor,
      actor: input.actor,
      reason: input.reason,
      candidateReleasePath: input.candidateReleasePath,
      targetReleasePath: input.targetReleasePath,
      sourceIdentity: input.sourceIdentity,
    });
    void this.runPendingOperations();
    return accepted;
  }

  private resetMonitorFailures(): void {
    this.monitorFailureCount = 0;
  }

  private requestSupervisorSelfRestart(reason: string): void {
    if (this.selfRestartRequested || this.stopping) return;
    this.selfRestartRequested = true;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    this.persist({
      observedState: 'degraded',
      lastIncident: {
        at: new Date().toISOString(),
        reason: `Stable Supervisor requested OS-service restart: ${reason}`,
      },
    });
    this.options.onStopped?.();
  }

  private recordMonitorFailure(reason: string): void {
    const decision = supervisorMonitorFailureDecision(this.monitorFailureCount, false);
    this.monitorFailureCount = decision.consecutiveFailures;
    this.persist({
      observedState: 'degraded',
      lastIncident: {
        at: new Date().toISOString(),
        reason: `${reason} (${decision.consecutiveFailures}/${SUPERVISOR_MONITOR_FAILURE_THRESHOLD})`,
      },
    });
    if (decision.shouldRestart) this.requestSupervisorSelfRestart(reason);
  }

  /**
   * Transitional compatibility only. The router is started once with the
   * Supervisor and is not recreated, replaced, or promoted into an independent
   * health/recovery owner by the monitor loop.
   */
  private async startCompatibilityIngressRouter(): Promise<StableIngressRouterHandle> {
    if (this.ingressRouter) return this.ingressRouter;
    if (!this.control) throw new Error('SUPERVISOR_INGRESS_CONTEXT_MISSING');
    this.ingressRouter = await createStableIngressRouter({
      host: this.options.stableIngressHost ?? '127.0.0.1',
      port: this.options.stableIngressPort ?? 8765,
      rescueHost: this.control.host,
      rescuePort: this.control.port,
      sessionStorePath: stableIngressSessionStorePath(this.options.controllerHome),
      upstream: () => {
        const authority = readActiveSlotAuthority(this.options.controllerHome);
        const binding = this.manager.gatewayBinding(authority.activeSlot);
        return { host: binding.host, port: binding.port, key: authority.activeSlot };
      },
      authorityObservation: () => {
        const authority = readActiveSlotAuthority(this.options.controllerHome);
        return { term: authority.generation, revision: authority.updatedAt };
      },
    });
    return this.ingressRouter;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.selfRestartRequested = false;
    this.resetMonitorFailures();
    this.reconcileInterruptedOperations();
    this.state = reconcileSupervisorStateWithAuthority(this.state, readActiveSlotAuthority(this.options.controllerHome));
    writeSupervisorState(this.options.controllerHome, this.state);
    this.control = await createSupervisorControlServer({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      controlHost: this.options.controlHost,
      controlPort: this.options.controlPort,
      authToken: this.options.rescueAuthToken,
      handlers: this,
      onHandoff: this.options.onHandoff,
      onStopped: this.options.onStopped,
    });
    this.ingressRouter = await this.startCompatibilityIngressRouter();
    this.state = this.persist({
      ingress: {
        ...this.state.ingress,
        state: 'running',
        activeUpstreamSlot: this.state.activeSlot,
        activeUpstreamPort: this.manager.gatewayBinding(this.state.activeSlot).port,
        pid: process.pid,
        lastHealthyAt: new Date().toISOString(),
      },
      control: {
        host: this.control.host,
        port: this.control.port,
        socketPath: supervisorControlSocketPath(this.options.controllerHome),
        rescueEndpoint: `http://${this.ingressRouter.host}:${this.ingressRouter.port}/rescue/mcp`,
      },
    });
    // Cold start must keep the Rescue / control plane alive even when the managed
    // Daemon/Gateway pair cannot become ready yet. Throwing here used to exit the
    // Supervisor process and trigger a launchd KeepAlive thrash that never reached
    // startGateway. Degrade in place and let the monitor / durable operations retry.
    try {
      await this.ensureRuntime();
      await this.resumeInterruptedRolloutActivation();
      reconcilePendingSupervisorActivations(this.options.controllerHome);
      this.state = this.persist({ observedState: 'healthy' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = this.persist({
        observedState: 'degraded',
        lastIncident: {
          at: new Date().toISOString(),
          reason: `cold start managed runtime recovery deferred: ${message}`.slice(0, 500),
        },
      });
    }
    this.monitorTimer = setInterval(() => this.scheduleMonitorTick(), 5_000);
    this.monitorTimer.unref?.();
    await this.runPendingOperations();
  }

  private reconcileInterruptedOperations(): void {
    reconcilePendingSupervisorActivations(this.options.controllerHome);
    const operations = listSupervisorOperations(this.options.controllerHome, 100);
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const recovery = resumableInterruptedRollout(this.state, authority, operations);
    if (recovery) {
      const release = readSupervisorRelease(recovery.releasePath);
      if (release) this.interruptedRollout = { ...recovery, release };
    }
    terminalizeInterruptedSupervisorOperations(
      this.options.controllerHome,
      this.interruptedRollout ? new Set([this.interruptedRollout.operationId]) : new Set<string>(),
    );
    this.state = { ...this.state, currentOperationId: this.interruptedRollout?.operationId ?? null };
  }

  private async resumeInterruptedRolloutActivation(): Promise<void> {
    const recovery = this.interruptedRollout;
    if (!recovery) return;
    const operation = readSupervisorOperation(this.options.controllerHome, recovery.operationId);
    if (!operation || !operationActive(operation)) {
      this.interruptedRollout = undefined;
      this.persist({ currentOperationId: null });
      return;
    }
    try {
      const daemon = this.state.controllerDaemon;
      const gateway = this.state.gatewayHost;
      if (!daemon || !gateway) throw new Error('SUPERVISOR_INTERRUPTED_ROLLOUT_RUNTIME_MISSING');
      if (resolve(daemon.releasePath ?? '') !== recovery.release.releasePath || resolve(gateway.releasePath ?? '') !== recovery.release.releasePath) {
        throw new Error('SUPERVISOR_INTERRUPTED_ROLLOUT_RELEASE_MISMATCH');
      }
      const generation = this.synchronizeActiveRuntimeGeneration(true) ?? recovery.candidateGeneration;
      const activeSlot = gateway.slot ?? this.state.activeSlot;
      await this.verifyAuthoritySelectedGateway({
        manager: this.managerForManaged(gateway, activeSlot),
        slot: activeSlot,
        expectedGeneration: generation,
        controllerHome: daemon.controllerHome,
      });
      const activeIdentity = readSlotIdentity(this.options.controllerHome, this.state.activeSlot);
      if (activeIdentity) {
        writeSlotIdentity(this.options.controllerHome, {
          ...activeIdentity,
          role: 'active',
          releasePath: recovery.release.releasePath,
          ...(recovery.release.releaseRevision ? { releaseRevision: recovery.release.releaseRevision } : {}),
        });
      }
      if (this.state.previousSlot) {
        const previousIdentity = readSlotIdentity(this.options.controllerHome, this.state.previousSlot);
        if (previousIdentity) writeSlotIdentity(this.options.controllerHome, { ...previousIdentity, role: 'standby' });
      }
      const activation = this.options.activatePublishedRelease === false
        ? undefined
        : publishAndScheduleSupervisorRelease({
            controllerHome: this.options.controllerHome,
            repoRoot: this.options.repoRoot,
            releasePath: recovery.release.releasePath,
            handoffDelayMs: 2_000,
          }, this.options.serviceActivationScheduler
            ? { schedule: this.options.serviceActivationScheduler }
            : undefined);
      if (!activation) {
        publishSupervisorRelease({
          controllerHome: this.options.controllerHome,
          repoRoot: this.options.repoRoot,
          releasePath: recovery.release.releasePath,
        });
      }
      const latest = readSupervisorOperation(this.options.controllerHome, recovery.operationId) ?? operation;
      const result = {
        ...(latest.result ?? {}),
        operationId: recovery.operationId,
        runtimeGeneration: generation,
        reconnectContract: 'stable_domain_retry',
        recoveredAfterSupervisorRestart: true,
        ...(activation ? {
          supervisorReleaseRevision: activation.publication.releaseRevision,
          supervisorActivation: activation.activation,
        } : {}),
      };
      updateSupervisorOperation(this.options.controllerHome, recovery.operationId, activation ? {
        phase: 'cutover',
        result,
        evidence: [
          ...(latest.evidence ?? []),
          { kind: 'supervisor_restart_recovery', summary: `Interrupted rollout resumed from committed authority and scheduled activation ${activation.activation.activationId}.`, at: new Date().toISOString() },
        ],
      } : {
        phase: 'succeeded',
        completedAt: new Date().toISOString(),
        result,
        evidence: [
          ...(latest.evidence ?? []),
          { kind: 'supervisor_restart_recovery', summary: 'Interrupted rollout resumed from committed authority and published the candidate release.', at: new Date().toISOString() },
        ],
      });
      this.persist({ currentOperationId: null, observedState: 'healthy' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateSupervisorOperation(this.options.controllerHome, recovery.operationId, {
        phase: 'failed',
        completedAt: new Date().toISOString(),
        failureClass: message.includes('MISMATCH') ? 'identity' : 'startup',
        error: `SUPERVISOR_INTERRUPTED_ROLLOUT_RESUME_FAILED: ${message}`,
      });
      this.persist({
        currentOperationId: null,
        observedState: 'degraded',
        lastIncident: { at: new Date().toISOString(), reason: message, operationId: recovery.operationId },
      });
    } finally {
      this.interruptedRollout = undefined;
    }
  }

  private persist(patch: Partial<SupervisorState>): SupervisorState {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    writeSupervisorState(this.options.controllerHome, this.state);
    return this.state;
  }

  private observedGatewayGeneration(gateway = this.state.gatewayHost): string | undefined {
    if (!gateway) return undefined;
    const runtime = loadMcpServiceRuntimeState(gateway.controllerHome, this.options.repoRoot);
    const topLevelGeneration = runtime?.generation;
    const serverGeneration = runtime?.server.generation;
    if (topLevelGeneration && serverGeneration && topLevelGeneration !== serverGeneration) return undefined;
    return serverGeneration ?? topLevelGeneration;
  }

  private synchronizeActiveRuntimeGeneration(requireAgreement = false): string | undefined {
    const daemon = this.state.controllerDaemon;
    const gateway = this.state.gatewayHost;
    const daemonRuntime = daemon ? readRuntimeGeneration(daemon.controllerHome) : undefined;
    const gatewayGeneration = this.observedGatewayGeneration(gateway);
    const reconciled = reconcileActiveManagedGenerations(this.state, {
      ...(daemonRuntime?.generation ? { controllerDaemon: daemonRuntime.generation } : {}),
      ...(gatewayGeneration ? { gatewayHost: gatewayGeneration } : {}),
    });
    if (reconciled.state !== this.state) {
      this.state = reconciled.state;
      writeSupervisorState(this.options.controllerHome, this.state);
    }
    if (reconciled.generation) {
      const authority = readActiveSlotAuthority(this.options.controllerHome);
      if (authority.activeSlot === this.state.activeSlot && authority.generation !== reconciled.generation) {
        writeActiveSlotAuthority(this.options.controllerHome, {
          activeSlot: authority.activeSlot,
          ...(authority.previousSlot ? { previousSlot: authority.previousSlot } : {}),
          generation: reconciled.generation,
          reason: 'runtime-generation-sync',
          ...(authority.rollbackUntil ? { rollbackUntil: authority.rollbackUntil } : {}),
        });
      }
      const identity = readSlotIdentity(this.options.controllerHome, this.state.activeSlot);
      const daemonReleasePath = daemon?.releasePath;
      const daemonReleaseRevision = daemon?.releaseRevision;
      if (identity && (
        identity.generation !== reconciled.generation
        || identity.sourceCommit !== daemonRuntime?.source.commit
        || identity.releasePath !== daemonReleasePath
        || identity.releaseRevision !== daemonReleaseRevision
      )) {
        writeSlotIdentity(this.options.controllerHome, {
          ...identity,
          generation: reconciled.generation,
          ...(daemonRuntime?.source.commit ? { sourceCommit: daemonRuntime.source.commit } : {}),
          releasePath: daemonReleasePath,
          releaseRevision: daemonReleaseRevision,
        });
      }
    }
    if (requireAgreement && !reconciled.coherent) {
      throw new Error(
        `SUPERVISOR_ACTIVE_GENERATION_MISMATCH: daemon=${daemonRuntime?.generation ?? 'missing'} gateway=${gatewayGeneration ?? 'missing'}`,
      );
    }
    return reconciled.generation;
  }

  private componentState(component: SupervisorComponentName): SupervisorManagedProcess | undefined {
    return component === 'controllerDaemon' ? this.state.controllerDaemon : this.state.gatewayHost;
  }

  private gatewayForSlot(slot: RuntimeSlotId): SupervisorManagedProcess | undefined {
    if (this.state.gatewayHost && (this.state.gatewayHost.slot === slot || (!this.state.gatewayHost.slot && this.state.activeSlot === slot))) {
      return this.state.gatewayHost;
    }
    if (this.state.standby?.slot === slot) return this.state.standby.gatewayHost;
    return undefined;
  }

  private managerForSlot(slot: RuntimeSlotId, release?: SupervisorReleaseDescriptor): SupervisorProcessManager {
    return new SupervisorProcessManager({
      ...this.options,
      slot,
      ...(release ? {
        runtimeSourceRoot: release.releasePath,
        runtimeExecutable: release.runtimeExecutable,
        daemonExecutable: release.daemonExecutable,
        releasePath: release.releasePath,
        releaseRevision: release.releaseRevision,
      } : {}),
    });
  }

  private managerForManaged(managed: SupervisorManagedProcess | undefined, fallbackSlot = this.state.activeSlot): SupervisorProcessManager {
    const release = readSupervisorRelease(managed?.releasePath);
    return this.managerForSlot(managed?.slot ?? fallbackSlot, release);
  }

  private expectedManagedRelease(): SupervisorReleaseDescriptor | undefined {
    return this.interruptedRollout?.release
      ?? readCurrentSupervisorRelease(this.options.controllerHome)
      ?? readSupervisorRelease(this.options.releasePath);
  }

  private async reconcileManagedRelease(): Promise<void> {
    const expected = this.expectedManagedRelease();
    if (!expected) return;
    const daemon = this.state.controllerDaemon;
    const gateway = this.state.gatewayHost;
    const daemonNeedsRefresh = daemon
      ? managedProcessNeedsReleaseRefresh(
          daemon,
          expected,
          this.options.ownerEpoch,
          this.managerForManaged(daemon).processCommandMatches(daemon, [expected.daemonExecutable]),
          { allowOwnerEpochAdoption: true },
        )
      : false;
    const gatewayNeedsRefresh = gateway
      ? managedProcessNeedsReleaseRefresh(
          gateway,
          expected,
          this.options.ownerEpoch,
          this.managerForManaged(gateway).processCommandMatches(gateway, [expected.runtimeExecutable]),
          { allowOwnerEpochAdoption: true },
        )
      : false;
    if (!daemonNeedsRefresh && !gatewayNeedsRefresh) return;

    // Stop the dependent Gateway first. Each stop is identity-checked by the
    // persisted PID/start-time/fingerprint tuple; an unproven PID is never
    // terminated during release handoff.
    if (gateway) {
      const result = await this.stopManagedProcess(
        this.managerForManaged(gateway),
        gateway,
        'gatewayHost',
        'managed_release_handoff',
      );
      if (!result.stopped) throw new Error('SUPERVISOR_GATEWAYHOST_RELEASE_HANDOFF_STOP_INCOMPLETE');
    }
    if (daemon) {
      const result = await this.stopManagedProcess(
        this.managerForManaged(daemon),
        daemon,
        'controllerDaemon',
        'managed_release_handoff',
      );
      if (!result.stopped) throw new Error('SUPERVISOR_CONTROLLERDAEMON_RELEASE_HANDOFF_STOP_INCOMPLETE');
    }
    this.persist({
      controllerDaemon: undefined,
      gatewayHost: undefined,
      activeGeneration: undefined,
      observedState: 'degraded',
      lastIncident: {
        at: new Date().toISOString(),
        reason: `Managed runtime release handoff to ${expected.releaseRevision ?? expected.releasePath}.`,
      },
    });
  }

  private prepareSlotConfig(
    slot: RuntimeSlotId,
    release?: SupervisorReleaseDescriptor,
    manager = this.managerForSlot(slot, release),
  ): { home: string; localControllerPort: number; manager: SupervisorProcessManager } {
    const home = ensureSlotHome(this.options.controllerHome, slot);
    const activeHome = this.state.controllerDaemon?.controllerHome ?? this.options.controllerHome;
    const rootTemplate = loadMcpServiceLocalConfig(this.options.controllerHome, this.options.repoRoot);
    const template = rootTemplate
      ?? loadMcpServiceLocalConfig(activeHome, this.options.repoRoot);
    if (!template) throw new Error('SUPERVISOR_SLOT_CONFIG_UNAVAILABLE');
    const localControllerPort = manager.localControllerBinding(slot).port;
    const binding = manager.gatewayBinding(slot);
    syncMcpControllerHomeBearerToken(home, this.options.controllerHome, this.options.repoRoot);
    writeMcpServiceLocalConfig(home, {
      ...template,
      server: { ...template.server, host: binding.host, port: binding.port },
      localController: {
        enabled: true,
        host: template.localController?.host ?? '127.0.0.1',
        port: localControllerPort,
        autoOpen: false,
      },
    });
    return { home, localControllerPort, manager };
  }

  private async waitForManagedReady(
    manager: SupervisorProcessManager,
    component: SupervisorComponentName,
    managed: SupervisorManagedProcess,
    options: { timeoutMs?: number; notBeforeMs?: number } = {},
  ): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if (manager.observe(managed) === 'alive') {
        if (component === 'controllerDaemon') {
          const status = readControllerDaemonStatus(managed.controllerHome);
          if (supervisorManagedDaemonReady(status, managed, options.notBeforeMs)) return;
        } else {
          const runtime = loadMcpServiceRuntimeState(managed.controllerHome, this.options.repoRoot);
          if (supervisorManagedGatewayReady(runtime, managed, options.notBeforeMs)) return;
        }
      }
      await sleep(250);
    }
    throw new Error(`SUPERVISOR_${component.toUpperCase()}_READINESS_TIMEOUT`);
  }

  private async startSlot(slot: RuntimeSlotId, release?: SupervisorReleaseDescriptor): Promise<StartedRuntimeSlot> {
    const manager = this.managerForSlot(slot, release);
    const staleCleanup = await manager.cleanupStaleSlotDaemons(slot, {
      reason: 'candidate_slot_preflight_cleanup',
      ...(this.state.currentOperationId ? { operationId: this.state.currentOperationId } : {}),
    });
    if (staleCleanup.failed > 0) {
      throw new Error(`SUPERVISOR_STALE_SLOT_DAEMON_CLEANUP_FAILED: ${staleCleanup.errors.join('; ')}`);
    }
    const prepared = this.prepareSlotConfig(slot, release, manager);
    let daemon: SupervisorManagedProcess | undefined;
    let gateway: SupervisorManagedProcess | undefined;
    try {
      const daemonNotBeforeMs = Date.now();
      const daemonSpawned = await prepared.manager.startDaemon();
      daemon = processState(daemonSpawned);
      await this.waitForManagedReady(prepared.manager, 'controllerDaemon', daemon, { notBeforeMs: daemonNotBeforeMs });
      const gatewayNotBeforeMs = Date.now();
      const gatewaySpawned = await prepared.manager.startGateway();
      gateway = processState(gatewaySpawned);
      await this.waitForManagedReady(prepared.manager, 'gatewayHost', gateway, { notBeforeMs: gatewayNotBeforeMs });
      const generation = readRuntimeGeneration(daemon.controllerHome)?.generation ?? daemon.generation;
      const sourceCommit = readRuntimeGeneration(daemon.controllerHome)?.source.commit;
      const gatewayRuntime = loadMcpServiceRuntimeState(gateway.controllerHome, this.options.repoRoot);
      if (!generation || gatewayRuntime?.generation !== generation || gatewayRuntime.server.generation !== generation) {
        throw new Error('SUPERVISOR_CANDIDATE_GENERATION_MISMATCH');
      }
      if (gatewayRuntime.server.profile !== 'controller') throw new Error('SUPERVISOR_CANDIDATE_PROFILE_MISMATCH');
      const toolFingerprint = gatewayRuntime.server.toolSurfaceFingerprint ?? gatewayRuntime.server.runtimeToolSurfaceFingerprint;
      if (!toolFingerprint) throw new Error('SUPERVISOR_CANDIDATE_TOOL_FINGERPRINT_MISSING');
      const candidateToken = readMcpServiceBearerToken(daemon.controllerHome, this.options.repoRoot);
      if (!candidateToken) throw new Error('SUPERVISOR_CANDIDATE_MCP_TOKEN_MISSING');
      const candidateBinding = prepared.manager.gatewayBinding(slot);
      const mcpReadiness = await probeAuthenticatedMcpReadiness({
        baseUrl: `http://${candidateBinding.host}:${candidateBinding.port}`,
        token: candidateToken,
      });
      if (!mcpReadiness.healthy) {
        throw new Error(`SUPERVISOR_CANDIDATE_MCP_READINESS_FAILED: ${mcpReadiness.detail}`);
      }
      // Passive candidates must not create or consume durable Jobs before the
      // authority transaction commits. MCP initialize/auth/tools-list/tool-call
      // plus process/generation checks prove readiness without acquiring writes.
      const durableJobId = 'process-runtime-readiness';
      writeSlotIdentity(this.options.controllerHome, {
        schemaVersion: 1,
        slot,
        role: 'candidate',
        controllerHome: this.options.controllerHome,
        slotHome: daemon.controllerHome,
        mcpPort: prepared.manager.gatewayBinding(slot).port,
        localControllerPort: prepared.localControllerPort,
        ...(generation ? { generation } : {}),
        ...(sourceCommit ? { sourceCommit } : {}),
        ...(daemon.releasePath ? { releasePath: daemon.releasePath } : {}),
        ...(daemon.releaseRevision ? { releaseRevision: daemon.releaseRevision } : {}),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        logDir: dirname(this.options.logPath),
      });
      return {
        slot,
        generation,
        manager: prepared.manager,
        controllerDaemon: daemon,
        gatewayHost: gateway,
        localControllerPort: prepared.localControllerPort,
        durableJobId,
        mcpReadiness,
      };
    } catch (error) {
      if (gateway) {
        await this.stopManagedProcess(prepared.manager, gateway, 'gatewayHost', 'candidate_start_failure_cleanup')
          .catch(() => undefined);
      }
      if (daemon) {
        await this.stopManagedProcess(prepared.manager, daemon, 'controllerDaemon', 'candidate_start_failure_cleanup')
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async verifyAuthoritySelectedGateway(input: {
    manager: SupervisorProcessManager;
    slot: RuntimeSlotId;
    expectedGeneration?: string;
    controllerHome?: string;
  }): Promise<void> {
    const binding = input.manager.gatewayBinding(input.slot);
    try {
      const health = await probeSupervisorGatewayHealth(`http://${binding.host}:${binding.port}/ready`, 5_000);
      if (!health.healthy || health.ready === false) throw new Error(health.detail);
      const runtime = loadMcpServiceRuntimeState(input.controllerHome ?? this.options.controllerHome, this.options.repoRoot);
      if (input.expectedGeneration
        && (runtime?.generation !== input.expectedGeneration || runtime?.server.generation !== input.expectedGeneration)) {
        throw new Error(
          `generation=${runtime?.generation ?? 'missing'} serverGeneration=${runtime?.server.generation ?? 'missing'} expected=${input.expectedGeneration}`,
        );
      }
      const token = readMcpServiceBearerToken(input.controllerHome ?? this.options.controllerHome, this.options.repoRoot);
      if (!token) throw new Error('authenticated MCP probe token is unavailable');
      let mcp = await probeAuthenticatedMcpReadiness({
        baseUrl: `http://${binding.host}:${binding.port}`,
        token,
      });
      for (let attempt = 0; attempt < 10 && !mcp.healthy; attempt += 1) {
        await sleep(250);
        mcp = await probeAuthenticatedMcpReadiness({
          baseUrl: `http://${binding.host}:${binding.port}`,
          token,
        });
      }
      if (!mcp.healthy) throw new Error(mcp.detail);
    } catch (error) {
      throw new Error(`SUPERVISOR_ACTIVE_GATEWAY_VERIFY_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async observeActivatedSlot(
    input: StartedRuntimeSlot,
    timeoutMs = SUPERVISOR_CUTOVER_OBSERVATION_MS,
  ): Promise<void> {
    const binding = input.manager.gatewayBinding(input.slot);
    await observeCutoverReadinessWindow({
      expectedGeneration: input.generation,
      timeoutMs,
      sample: async () => await sampleCutoverReadiness({
        daemonAlive: input.manager.observe(input.controllerDaemon) === 'alive',
        gatewayAlive: input.manager.observe(input.gatewayHost) === 'alive',
        readDaemon: () => readControllerDaemonStatus(input.controllerDaemon.controllerHome),
        probeGateway: async () => await probeSupervisorGatewayHealth(`http://${binding.host}:${binding.port}/ready`),
        readDaemonGeneration: () => readRuntimeGeneration(input.controllerDaemon.controllerHome)?.generation,
        readGatewayGeneration: () => loadMcpServiceRuntimeState(input.gatewayHost.controllerHome, this.options.repoRoot)?.server.generation,
      }),
    });
  }
  private async stopManagedProcess(
    manager: SupervisorProcessManager,
    identity: SupervisorManagedProcess,
    component: SupervisorComponentName,
    reason: string,
    operationId = this.state.currentOperationId ?? undefined,
  ): Promise<{ stopped: boolean; observation: 'alive' | 'dead' | 'unknown' }> {
    return manager.stop(identity, {
      reason,
      component,
      ...(operationId ? { operationId } : {}),
    });
  }

  private async stopSlotProcesses(
    input: { slot: RuntimeSlotId; controllerDaemon?: SupervisorManagedProcess; gatewayHost?: SupervisorManagedProcess },
    reason = 'slot_cleanup',
    operationId = this.state.currentOperationId ?? undefined,
  ): Promise<void> {
    if (input.gatewayHost) {
      await this.stopManagedProcess(
        this.managerForManaged(input.gatewayHost, input.slot),
        input.gatewayHost,
        'gatewayHost',
        reason,
        operationId,
      ).catch(() => undefined);
    }
    if (input.controllerDaemon) {
      await this.stopManagedProcess(
        this.managerForManaged(input.controllerDaemon, input.slot),
        input.controllerDaemon,
        'controllerDaemon',
        reason,
        operationId,
      ).catch(() => undefined);
    }
  }

  /**
   * A passive candidate starts before authority cutover and therefore holds a
   * deliberately stale writer claim. Once the activation transaction commits,
   * restart the candidate pair so both processes inherit the committed
   * slot/epoch/token before stable ingress is switched.
   */
  private async refreshSlotWriterClaim(
    input: StartedRuntimeSlot,
    context: { operationId?: string; reason?: string } = {},
  ): Promise<StartedRuntimeSlot> {
    syncMcpControllerHomeBearerToken(
      input.controllerDaemon.controllerHome,
      this.options.controllerHome,
      this.options.repoRoot,
    );
    const reason = context.reason ?? 'writer_claim_refresh';
    const operationId = context.operationId ?? this.state.currentOperationId ?? undefined;
    const stoppedGateway = await this.stopManagedProcess(
      input.manager,
      input.gatewayHost,
      'gatewayHost',
      `${reason}:stop_previous_gateway`,
      operationId,
    );
    if (!stoppedGateway.stopped) throw new Error('SUPERVISOR_GATEWAY_WRITER_REFRESH_STOP_INCOMPLETE');
    const stoppedDaemon = await this.stopManagedProcess(
      input.manager,
      input.controllerDaemon,
      'controllerDaemon',
      `${reason}:stop_previous_daemon`,
      operationId,
    );
    if (!stoppedDaemon.stopped) throw new Error('SUPERVISOR_DAEMON_WRITER_REFRESH_STOP_INCOMPLETE');

    let daemon: SupervisorManagedProcess | undefined;
    let gateway: SupervisorManagedProcess | undefined;
    try {
      const daemonNotBeforeMs = Date.now();
      daemon = processState(await input.manager.startDaemon(), input.controllerDaemon);
      await this.waitForManagedReady(input.manager, 'controllerDaemon', daemon, { notBeforeMs: daemonNotBeforeMs });
      const gatewayNotBeforeMs = Date.now();
      gateway = processState(await input.manager.startGateway(), input.gatewayHost);
      await this.waitForManagedReady(input.manager, 'gatewayHost', gateway, { notBeforeMs: gatewayNotBeforeMs });
      const generation = readRuntimeGeneration(daemon.controllerHome)?.generation ?? daemon.generation;
      const gatewayRuntime = loadMcpServiceRuntimeState(gateway.controllerHome, this.options.repoRoot);
      if (!generation || generation !== input.generation) {
        throw new Error(`SUPERVISOR_ACTIVATED_GENERATION_MISMATCH: observed=${generation ?? 'missing'} expected=${input.generation ?? 'missing'}`);
      }
      if (gatewayRuntime?.generation !== generation || gatewayRuntime.server.generation !== generation) {
        throw new Error('SUPERVISOR_ACTIVATED_GATEWAY_GENERATION_MISMATCH');
      }
      syncMcpControllerHomeBearerToken(
        daemon.controllerHome,
        this.options.controllerHome,
        this.options.repoRoot,
      );
      const token = readMcpServiceBearerToken(daemon.controllerHome, this.options.repoRoot)
        ?? readMcpServiceBearerToken(this.options.controllerHome, this.options.repoRoot);
      if (!token) throw new Error('SUPERVISOR_ACTIVATED_MCP_TOKEN_MISSING');
      const binding = input.manager.gatewayBinding(input.slot);
      const mcpReadiness = await probeAuthenticatedMcpReadiness({
        baseUrl: `http://${binding.host}:${binding.port}`,
        token,
      });
      if (!mcpReadiness.healthy) {
        throw new Error(`SUPERVISOR_ACTIVATED_MCP_READINESS_FAILED: ${mcpReadiness.detail}`);
      }
      return { ...input, generation, controllerDaemon: daemon, gatewayHost: gateway, mcpReadiness };
    } catch (error) {
      if (gateway) {
        await this.stopManagedProcess(
          input.manager,
          gateway,
          'gatewayHost',
          `${reason}:failed_refresh_cleanup`,
          operationId,
        ).catch(() => undefined);
      }
      if (daemon) {
        await this.stopManagedProcess(
          input.manager,
          daemon,
          'controllerDaemon',
          `${reason}:failed_refresh_cleanup`,
          operationId,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  private async rollout(operation: SupervisorOperation): Promise<SupervisorReleaseActivationResult | undefined> {
    const operationId = operation.operationId;
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const previousSlot = authority.activeSlot;
    const candidateSlot = oppositeSlot(previousSlot);
    const previousDaemon = this.state.controllerDaemon;
    const previousGateway = this.state.gatewayHost;
    if (!previousDaemon || !previousGateway) throw new Error('SUPERVISOR_ACTIVE_RUNTIME_MISSING');
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
    let candidateRelease = readCurrentSupervisorRelease(this.options.controllerHome);
    if (operation.candidateReleasePath) {
      const candidatePath = resolve(operation.candidateReleasePath);
      try {
        const releasesRootReal = realpathSync(resolve(supervisorReleasesRoot(this.options.controllerHome)));
        const candidateReal = realpathSync(candidatePath);
        if (!candidateReal.startsWith(`${releasesRootReal}${sep}`)) {
          throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME') throw error;
        throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
      }
      candidateRelease = readSupervisorRelease(candidatePath);
      if (!candidateRelease) throw new Error('SUPERVISOR_STAGED_RELEASE_INVALID');
    }
    if (operation.sourceIdentity && candidateRelease) {
      verifySupervisorSourceIdentity(operation.sourceIdentity, candidateRelease);
    }
    if (operation.sourceIdentity && !candidateRelease) {
      throw new Error('SUPERVISOR_SOURCE_IDENTITY_REQUIRES_CANDIDATE_RELEASE');
    }
    if (candidateRelease) {
      const missing = supervisorReleaseClosureMissing(candidateRelease.releasePath);
      if (missing.length > 0) {
        throw new Error(`SUPERVISOR_CANDIDATE_RELEASE_CLOSURE_INCOMPLETE: candidate is missing required executables: ${missing.join(', ')}`);
      }
      verifySupervisorReleaseExecutionCanary({
        releasePath: candidateRelease.releasePath,
        cwd: operation.repoRoot ?? this.options.repoRoot,
        executionMode: candidateRelease.executionMode,
      });
    }
    const candidate = await this.startSlot(candidateSlot, candidateRelease);
    updateSupervisorOperation(this.options.controllerHome, operationId, {
      phase: 'verifying',
      evidence: [{
        kind: 'candidate_verification',
        summary: `Candidate ${candidateSlot} passed generation, tool-surface, daemon/Gateway readiness, and authenticated MCP readiness (${candidate.mcpReadiness?.toolCount ?? 'unknown'} tools); passive candidates do not create durable Jobs before writer activation (${candidate.durableJobId}).`,
        at: new Date().toISOString(),
      }],
    });
    const previousGeneration = previousDaemon.generation ?? this.state.activeGeneration;
    this.persist({
      activeSlot: candidateSlot,
      activeGeneration: candidate.generation,
      controllerDaemon: candidate.controllerDaemon,
      gatewayHost: candidate.gatewayHost,
      standby: {
        slot: previousSlot,
        ...(previousGeneration ? { generation: previousGeneration } : {}),
        controllerDaemon: previousDaemon,
        gatewayHost: previousGateway,
      },
    });
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'switching_ingress' });

    let activatedCandidate = candidate;
    let authorityCommitted = false;
    try {
      const nextAuthority = markCutoverAuthority(this.options.controllerHome, candidateSlot, candidate.generation);
      authorityCommitted = true;
      if (candidateRelease?.releasePath) {
        const latest = readSupervisorOperation(this.options.controllerHome, operationId) ?? operation;
        updateSupervisorOperation(this.options.controllerHome, operationId, {
          phase: 'switching_ingress',
          result: resultWithRolloutCheckpoint(latest, {
            stage: 'authority_committed',
            candidateSlot,
            previousSlot,
            candidateReleasePath: candidateRelease.releasePath,
            ...(candidate.generation ? { candidateGeneration: candidate.generation } : {}),
            ...(previousGeneration ? { previousGeneration } : {}),
            ...(candidateRelease.releaseRevision ? { expectedReleaseRevision: candidateRelease.releaseRevision } : {}),
            recordedAt: new Date().toISOString(),
          }),
        });
      }
      // The candidate was intentionally passive before commit. Restart it with
      // the committed claim while ingress still routes to the previous slot.
      // A transient process/readiness loss gets one bounded retry; identity and
      // authority mismatches still fail closed immediately.
      const writerRefresh = await refreshWriterClaimWithSingleRetry(
        candidate,
        (current) => this.refreshSlotWriterClaim(current, {
          operationId,
          reason: 'rollout_writer_claim_refresh',
        }),
        async (firstFailure) => {
          const latest = readSupervisorOperation(this.options.controllerHome, operationId) ?? operation;
          updateSupervisorOperation(this.options.controllerHome, operationId, {
            phase: latest.phase,
            evidence: [
              ...(latest.evidence ?? []),
              {
                kind: 'candidate_writer_refresh_retry',
                summary: `Candidate ${candidateSlot} writer activation failed once (${firstFailure}); retrying the same authority-owned release exactly once.`,
                at: new Date().toISOString(),
              },
            ],
          });
        },
      );
      activatedCandidate = writerRefresh.candidate;
      if (operation.sourceIdentity && candidateRelease) {
        verifySupervisorSourceIdentity(operation.sourceIdentity, candidateRelease);
      }
      this.persist({
        activeSlot: candidateSlot,
        activeGeneration: activatedCandidate.generation,
        controllerDaemon: activatedCandidate.controllerDaemon,
        gatewayHost: activatedCandidate.gatewayHost,
        previousSlot,
        standby: this.state.standby ? { ...this.state.standby, retainedUntil: nextAuthority.rollbackUntil } : undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: candidateSlot,
          activeUpstreamPort: activatedCandidate.manager.gatewayBinding(candidateSlot).port,
        },
      });
      await this.verifyAuthoritySelectedGateway({
        manager: activatedCandidate.manager,
        slot: activatedCandidate.slot,
        expectedGeneration: activatedCandidate.generation,
        controllerHome: activatedCandidate.controllerDaemon.controllerHome,
      });
      if (operation.sourceIdentity && candidateRelease) {
        verifySupervisorSourceIdentity(operation.sourceIdentity, candidateRelease);
      }
      const observed = await observeCutoverCandidateWithSingleRecovery(
        activatedCandidate,
        (current) => this.observeActivatedSlot(current),
        async (failedCandidate, firstFailure) => {
          const daemonStatus = readControllerDaemonStatus(failedCandidate.controllerDaemon.controllerHome);
          const latest = readSupervisorOperation(this.options.controllerHome, operationId) ?? operation;
          updateSupervisorOperation(this.options.controllerHome, operationId, {
            phase: latest.phase,
            evidence: [
              ...(latest.evidence ?? []),
              {
                kind: 'candidate_cutover_recovery',
                summary: `Candidate ${candidateSlot} observation failed once (${firstFailure}); daemonStatus=${daemonStatus.status} shutdownReason=${daemonStatus.shutdownReason ?? 'unknown'}. Refreshing the authority-owned pair once before rollback.`,
                at: new Date().toISOString(),
              },
            ],
          });
          const refreshed = await this.refreshSlotWriterClaim(failedCandidate, {
            operationId,
            reason: 'rollout_cutover_observation_recovery',
          });
          this.persist({
            activeSlot: candidateSlot,
            activeGeneration: refreshed.generation,
            controllerDaemon: refreshed.controllerDaemon,
            gatewayHost: refreshed.gatewayHost,
            ingress: {
              ...this.state.ingress,
              activeUpstreamSlot: candidateSlot,
              activeUpstreamPort: refreshed.manager.gatewayBinding(candidateSlot).port,
            },
          });
          await this.verifyAuthoritySelectedGateway({
            manager: refreshed.manager,
            slot: refreshed.slot,
            expectedGeneration: refreshed.generation,
            controllerHome: refreshed.controllerDaemon.controllerHome,
          });
          return refreshed;
        },
      );
      activatedCandidate = observed.candidate;
      writeSlotIdentity(this.options.controllerHome, {
        ...(readSlotIdentity(this.options.controllerHome, candidateSlot) ?? {
          schemaVersion: 1,
          slot: candidateSlot,
          controllerHome: this.options.controllerHome,
          slotHome: activatedCandidate.controllerDaemon.controllerHome,
          mcpPort: activatedCandidate.manager.gatewayBinding(candidateSlot).port,
          localControllerPort: activatedCandidate.localControllerPort,
          updatedAt: new Date().toISOString(),
          logDir: dirname(this.options.logPath),
        }),
        role: 'active',
      });
      const previousIdentity = readSlotIdentity(this.options.controllerHome, previousSlot);
      if (previousIdentity) writeSlotIdentity(this.options.controllerHome, { ...previousIdentity, role: 'standby' });
      const latest = readSupervisorOperation(this.options.controllerHome, operationId) ?? operation;
      if (candidateRelease?.releasePath) {
        updateSupervisorOperation(this.options.controllerHome, operationId, {
          phase: 'cutover',
          result: resultWithRolloutCheckpoint(latest, {
            stage: 'runtime_activated',
            candidateSlot,
            previousSlot,
            candidateReleasePath: candidateRelease.releasePath,
            ...(activatedCandidate.generation ? { candidateGeneration: activatedCandidate.generation } : {}),
            ...(previousGeneration ? { previousGeneration } : {}),
            ...(candidateRelease.releaseRevision ? { expectedReleaseRevision: candidateRelease.releaseRevision } : {}),
            recordedAt: new Date().toISOString(),
          }),
        });
      } else {
        updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'cutover' });
      }
      if (!candidateRelease) return undefined;
      if (this.options.activatePublishedRelease === false) {
        publishSupervisorRelease({
          controllerHome: this.options.controllerHome,
          repoRoot: operation.repoRoot ?? this.options.repoRoot,
          releasePath: candidateRelease.releasePath,
        });
        return undefined;
      }
      return publishAndScheduleSupervisorRelease({
        controllerHome: this.options.controllerHome,
        repoRoot: operation.repoRoot ?? this.options.repoRoot,
        releasePath: candidateRelease.releasePath,
        handoffDelayMs: 2_000,
      }, this.options.serviceActivationScheduler
        ? { schedule: this.options.serviceActivationScheduler }
        : undefined);
    } catch (error) {
      const primaryFailure = error;
      let rollbackFailure: unknown;
      let restoredDaemon: SupervisorManagedProcess | undefined = previousDaemon;
      let restoredGateway: SupervisorManagedProcess | undefined = previousGateway;
      if (authorityCommitted) {
        markRollbackAuthority(this.options.controllerHome, previousGeneration);
        const previousTarget: StartedRuntimeSlot = {
          slot: previousSlot,
          generation: previousGeneration,
          manager: this.managerForManaged(previousDaemon, previousSlot),
          controllerDaemon: previousDaemon,
          gatewayHost: previousGateway,
          localControllerPort: loadMcpServiceLocalConfig(previousDaemon.controllerHome, this.options.repoRoot)?.localController?.port ?? 8766,
          durableJobId: 'cutover-rollback-restore',
        };
        try {
          const restored = await this.refreshSlotWriterClaim(previousTarget, {
            operationId,
            reason: 'rollout_rollback_restore_previous',
          });
          restoredDaemon = restored.controllerDaemon;
          restoredGateway = restored.gatewayHost;
        } catch (caught) {
          rollbackFailure = caught;
          restoredDaemon = undefined;
          restoredGateway = undefined;
          this.persist({
            activeSlot: previousSlot,
            previousSlot: candidateSlot,
            activeGeneration: previousGeneration,
            controllerDaemon: undefined,
            gatewayHost: undefined,
            standby: undefined,
            ingress: {
              ...this.state.ingress,
              activeUpstreamSlot: previousSlot,
              activeUpstreamPort: this.managerForManaged(previousGateway, previousSlot).gatewayBinding(previousSlot).port,
            },
          });
          try {
            await this.ensureRuntime();
            restoredDaemon = this.state.controllerDaemon;
            restoredGateway = this.state.gatewayHost;
          } catch (authorityRecoveryError) {
            rollbackFailure = new Error(
              `${supervisorErrorMessage(caught)}; authorityRecovery=${supervisorErrorMessage(authorityRecoveryError)}`,
            );
          }
        }
      }
      this.persist({
        activeSlot: previousSlot,
        previousSlot: candidateSlot,
        activeGeneration: previousGeneration,
        controllerDaemon: restoredDaemon,
        gatewayHost: restoredGateway,
        standby: undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: previousSlot,
          activeUpstreamPort: this.managerForManaged(restoredGateway ?? previousGateway, previousSlot).gatewayBinding(previousSlot).port,
        },
      });
      await this.stopSlotProcesses(activatedCandidate, 'rollout_failed_candidate_cleanup', operationId);
      const identity = readSlotIdentity(this.options.controllerHome, candidateSlot);
      if (identity) writeSlotIdentity(this.options.controllerHome, { ...identity, role: 'failed' });
      if (rollbackFailure) throw combinedRolloutRollbackFailure(primaryFailure, rollbackFailure);
      throw primaryFailure;
    }
  }

  private async rollback(operationId: string, targetReleasePath?: string): Promise<SupervisorReleaseActivationResult | undefined> {
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const currentSlot = authority.activeSlot;
    const targetSlot = authority.previousSlot ?? this.state.standby?.slot ?? (targetReleasePath ? oppositeSlot(currentSlot) : undefined);
    if (!targetSlot) throw new Error('SUPERVISOR_ROLLBACK_TARGET_MISSING');
    const failedDaemon = this.state.controllerDaemon;
    const failedGateway = this.state.gatewayHost;
    if (!failedDaemon) throw new Error('SUPERVISOR_ACTIVE_RUNTIME_MISSING');
    let target: StartedRuntimeSlot;
    if (
      !targetReleasePath
      && this.state.standby?.slot === targetSlot
      && this.manager.observe(this.state.standby.controllerDaemon) === 'alive'
      && this.manager.observe(this.state.standby.gatewayHost) === 'alive'
    ) {
      const manager = this.managerForManaged(this.state.standby.controllerDaemon, targetSlot);
      target = {
        slot: targetSlot,
        generation: this.state.standby.generation,
        manager,
        controllerDaemon: this.state.standby.controllerDaemon,
        gatewayHost: this.state.standby.gatewayHost,
        localControllerPort: loadMcpServiceLocalConfig(this.state.standby.controllerDaemon.controllerHome, this.options.repoRoot)?.localController?.port ?? 8766,
        durableJobId: 'existing-standby',
      };
    } else {
      updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
      const targetIdentity = readSlotIdentity(this.options.controllerHome, targetSlot);
      const targetRelease = readSupervisorRelease(targetReleasePath)
        ?? readSupervisorRelease(targetIdentity?.releasePath)
        ?? readPreviousSupervisorRelease(this.options.controllerHome);
      target = await this.startSlot(targetSlot, targetRelease);
    }
    // A live standby is not automatically a safe rollback target: it may have
    // been started from an older incomplete release. Validate the exact release
    // behind either the retained standby or the newly started target before
    // committing rollback authority or switching ingress.
    const rollbackRelease = readSupervisorRelease(target.controllerDaemon.releasePath);
    if (!rollbackRelease) {
      throw new Error('SUPERVISOR_ROLLBACK_RELEASE_UNAVAILABLE');
    }
    const rollbackMissing = supervisorReleaseClosureMissing(rollbackRelease.releasePath);
    if (rollbackMissing.length > 0) {
      throw new Error(`SUPERVISOR_ROLLBACK_RELEASE_CLOSURE_INCOMPLETE: previous release is missing required executables: ${rollbackMissing.join(', ')}`);
    }
    verifySupervisorReleaseExecutionCanary({
      releasePath: rollbackRelease.releasePath,
      cwd: this.options.repoRoot,
      executionMode: rollbackRelease.executionMode,
    });
    this.persist({
      activeSlot: targetSlot,
      activeGeneration: target.generation,
      controllerDaemon: target.controllerDaemon,
      gatewayHost: target.gatewayHost,
      ...(failedGateway ? {
        standby: {
          slot: currentSlot,
          ...(failedDaemon.generation ? { generation: failedDaemon.generation } : {}),
          controllerDaemon: failedDaemon,
          gatewayHost: failedGateway,
        },
      } : { standby: undefined }),
    });
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'rolling_back' });

    let activatedTarget = target;
    let rollbackAuthorityCommitted = false;
    try {
      markRollbackAuthority(this.options.controllerHome, target.generation, {
        releaseRevision: rollbackRelease.releaseRevision,
        releasePath: rollbackRelease.releasePath,
      });
      rollbackAuthorityCommitted = true;
      activatedTarget = await this.refreshSlotWriterClaim(target);
      this.persist({
        activeSlot: targetSlot,
        activeGeneration: activatedTarget.generation,
        controllerDaemon: activatedTarget.controllerDaemon,
        gatewayHost: activatedTarget.gatewayHost,
        previousSlot: currentSlot,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: targetSlot,
          activeUpstreamPort: activatedTarget.manager.gatewayBinding(targetSlot).port,
        },
      });
      await this.verifyAuthoritySelectedGateway({
        manager: activatedTarget.manager,
        slot: activatedTarget.slot,
        expectedGeneration: activatedTarget.generation,
        controllerHome: activatedTarget.controllerDaemon.controllerHome,
      });
      await this.observeActivatedSlot(activatedTarget);
    } catch (error) {
      let restoredDaemon = failedDaemon;
      let restoredGateway = failedGateway;
      if (rollbackAuthorityCommitted && failedGateway) {
        markRollbackAuthority(this.options.controllerHome, failedDaemon.generation ?? this.state.activeGeneration, {
          releaseRevision: failedDaemon.releaseRevision,
          releasePath: failedDaemon.releasePath,
        });
        const failedTarget: StartedRuntimeSlot = {
          slot: currentSlot,
          generation: failedDaemon.generation ?? this.state.activeGeneration,
          manager: this.managerForManaged(failedDaemon, currentSlot),
          controllerDaemon: failedDaemon,
          gatewayHost: failedGateway,
          localControllerPort: loadMcpServiceLocalConfig(failedDaemon.controllerHome, this.options.repoRoot)?.localController?.port ?? 8766,
          durableJobId: 'rollback-failure-restore',
        };
        const restored = await this.refreshSlotWriterClaim(failedTarget);
        restoredDaemon = restored.controllerDaemon;
        restoredGateway = restored.gatewayHost;
      } else if (rollbackAuthorityCommitted) {
        markRollbackAuthority(this.options.controllerHome, failedDaemon.generation ?? this.state.activeGeneration, {
          releaseRevision: failedDaemon.releaseRevision,
          releasePath: failedDaemon.releasePath,
        });
      }
      const restoredPort = restoredGateway
        ? this.managerForManaged(restoredGateway, currentSlot).gatewayBinding(currentSlot).port
        : this.state.ingress.activeUpstreamPort;
      this.persist({
        activeSlot: currentSlot,
        activeGeneration: failedDaemon.generation,
        controllerDaemon: restoredDaemon,
        gatewayHost: restoredGateway,
        standby: undefined,
        ingress: {
          ...this.state.ingress,
          activeUpstreamSlot: currentSlot,
          ...(restoredPort ? { activeUpstreamPort: restoredPort } : {}),
        },
      });
      await this.stopSlotProcesses(activatedTarget);
      throw error;
    }
    await this.stopSlotProcesses({ slot: currentSlot, controllerDaemon: failedDaemon, gatewayHost: failedGateway });
    this.persist({ standby: undefined });
    const targetIdentity = readSlotIdentity(this.options.controllerHome, targetSlot);
    if (targetIdentity) writeSlotIdentity(this.options.controllerHome, { ...targetIdentity, role: 'active' });
    const failedIdentity = readSlotIdentity(this.options.controllerHome, currentSlot);
    if (failedIdentity) writeSlotIdentity(this.options.controllerHome, { ...failedIdentity, role: 'failed' });
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'cutover' });
    const rollbackReleasePath = activatedTarget.controllerDaemon.releasePath;
    if (!rollbackReleasePath) return undefined;
    if (this.options.activatePublishedRelease === false) {
      publishSupervisorRelease({
        controllerHome: this.options.controllerHome,
        repoRoot: this.options.repoRoot,
        releasePath: rollbackReleasePath,
      });
      return undefined;
    }
    return publishAndScheduleSupervisorRelease({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      releasePath: rollbackReleasePath,
      handoffDelayMs: 2_000,
      allowOutdatedReleaseActivation: true,
    }, this.options.serviceActivationScheduler
      ? { schedule: this.options.serviceActivationScheduler }
      : undefined);
  }

  private async cleanupExpiredStandby(): Promise<void> {
    const standby = this.state.standby;
    if (!standby || this.state.currentOperationId) return;
    const retainedUntil = standby.retainedUntil ? Date.parse(standby.retainedUntil) : Number.NaN;
    if (Number.isFinite(retainedUntil) && retainedUntil > Date.now()) return;
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    if (!standby.retainedUntil && isRollbackWindowOpen(authority)) return;
    await this.stopSlotProcesses(standby);
    const identity = readSlotIdentity(this.options.controllerHome, standby.slot);
    if (identity) writeSlotIdentity(this.options.controllerHome, { ...identity, role: 'inactive' });
    this.persist({ standby: undefined });
  }

  private setComponent(component: SupervisorComponentName, value: SupervisorManagedProcess | undefined): void {
    if (component === 'controllerDaemon') this.persist({ controllerDaemon: value });
    else this.persist({ gatewayHost: value });
  }

  private async ensureRuntime(): Promise<void> {
    if (this.stopping || this.state.desiredState !== 'running') return;
    await this.reconcileManagedRelease();
    const expectedRelease = this.expectedManagedRelease();
    const activeSlot = this.state.controllerDaemon?.slot
      ?? this.state.gatewayHost?.slot
      ?? this.state.activeSlot;
    const currentReleaseManager = expectedRelease
      ? this.managerForSlot(activeSlot, expectedRelease)
      : undefined;
    const staleCleanup = await (currentReleaseManager ?? this.managerForSlot(activeSlot))
      .cleanupStaleSlotDaemons(activeSlot, {
        reason: 'active_slot_preflight_cleanup',
        ...(this.state.currentOperationId ? { operationId: this.state.currentOperationId } : {}),
      }, {
        includeCurrentOwnerEpoch: true,
        preservePids: new Set(this.state.controllerDaemon?.pid ? [this.state.controllerDaemon.pid] : []),
      });
    if (staleCleanup.failed > 0) {
      throw new Error(`SUPERVISOR_ACTIVE_SLOT_DAEMON_CLEANUP_FAILED: ${staleCleanup.errors.join('; ')}`);
    }
    if (!this.state.controllerDaemon || this.manager.observe(this.state.controllerDaemon) !== 'alive') {
      const previous = this.state.controllerDaemon;
      const started = await (currentReleaseManager ?? this.managerForManaged(previous, activeSlot)).startDaemon();
      this.setComponent('controllerDaemon', processState(started, previous));
    }
    await this.waitForReady('controllerDaemon');
    const daemonGeneration = this.state.controllerDaemon
      ? readRuntimeGeneration(this.state.controllerDaemon.controllerHome)?.generation
      : undefined;
    const currentGateway = this.state.gatewayHost;
    if (
      currentGateway
      && this.manager.observe(currentGateway) === 'alive'
      && daemonGeneration
      && this.observedGatewayGeneration(currentGateway) !== daemonGeneration
    ) {
      const stopped = await this.stopManagedProcess(
        this.managerForManaged(currentGateway),
        currentGateway,
        'gatewayHost',
        'gateway_generation_refresh',
      );
      if (!stopped.stopped) throw new Error('SUPERVISOR_GATEWAYHOST_GENERATION_REFRESH_STOP_INCOMPLETE');
      this.setComponent('gatewayHost', { ...currentGateway, state: 'stopped', lastLivenessAt: new Date().toISOString() });
    }
    if (!this.state.gatewayHost || this.manager.observe(this.state.gatewayHost) !== 'alive') {
      const previous = this.state.gatewayHost;
      const started = await (currentReleaseManager ?? this.managerForManaged(previous, activeSlot)).startGateway();
      this.setComponent('gatewayHost', processState(started, previous));
    }
    await this.waitForReady('gatewayHost');
    const activeGeneration = this.synchronizeActiveRuntimeGeneration(true);
    this.persist({
      activeSlot: this.state.controllerDaemon?.slot ?? this.state.activeSlot,
      ...(activeGeneration ? { activeGeneration } : {}),
      ingress: {
        ...this.state.ingress,
        activeUpstreamSlot: this.state.gatewayHost?.slot ?? this.state.activeSlot,
        activeUpstreamPort: this.manager.gatewayBinding(this.state.gatewayHost?.slot ?? this.state.activeSlot).port,
      },
    });
  }

  private async waitForReady(component: SupervisorComponentName): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const managed = this.componentState(component);
      if (managed && this.managerForManaged(managed).observe(managed) === 'alive') {
        if (component === 'controllerDaemon') {
          const daemon = readControllerDaemonStatus(managed.controllerHome);
          if (supervisorManagedDaemonReady(daemon, managed)) return;
        } else {
          const runtime = loadMcpServiceRuntimeState(managed.controllerHome, this.options.repoRoot);
          if (supervisorManagedGatewayReady(runtime, managed)) return;
        }
      }
      await sleep(250);
    }
    throw new Error(`SUPERVISOR_${component.toUpperCase()}_READINESS_TIMEOUT`);
  }

  private async stopComponent(component: SupervisorComponentName): Promise<void> {
    const current = this.componentState(component);
    if (!current) return;
    const result = await this.stopManagedProcess(
      this.managerForManaged(current),
      current,
      component,
      `component_stop:${component}`,
    );
    if (!result.stopped) throw new Error(`SUPERVISOR_${component.toUpperCase()}_STOP_INCOMPLETE`);
    this.setComponent(component, { ...current, state: 'stopped', lastLivenessAt: new Date().toISOString() });
  }

  private async restartComponent(component: SupervisorComponentName, operationId: string): Promise<void> {
    const current = this.componentState(component);
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'stopping', startedAt: new Date().toISOString() });
    if (current) await this.stopComponent(component);
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'starting' });
    const manager = this.managerForManaged(current);
    const started = component === 'controllerDaemon' ? await manager.startDaemon() : await manager.startGateway();
    this.setComponent(component, processState(started, current));
    updateSupervisorOperation(this.options.controllerHome, operationId, { phase: 'verifying' });
    await this.waitForReady(component);
  }

  private async executeOperation(operation: SupervisorOperation): Promise<void> {
    let releaseActivation: SupervisorReleaseActivationResult | undefined;
    let current = updateSupervisorOperation(this.options.controllerHome, operation.operationId, { phase: 'scheduled', scheduledAt: new Date().toISOString() });
    this.persist({ currentOperationId: operation.operationId, observedState: 'degraded' });
    try {
      if (current.kind === 'restart_controller') {
        await this.restartComponent('controllerDaemon', current.operationId);
        // A normal Supervisor-owned daemon restart preserves the writer generation.
        // Keep the Gateway connection stable unless the observed generation really
        // changed; ensureRuntime performs that conditional refresh and verification.
        await this.ensureRuntime();
      } else if (current.kind === 'restart_gateway') {
        await this.restartComponent('gatewayHost', current.operationId);
      } else if (current.kind === 'restart_full') {
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'stopping', startedAt: new Date().toISOString() });
        await this.stopComponent('gatewayHost');
        await this.stopComponent('controllerDaemon');
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'starting' });
        await this.ensureRuntime();
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'verifying' });
        await this.waitForReady('controllerDaemon');
        await this.waitForReady('gatewayHost');
      } else if (current.kind === 'unlock_and_recover') {
        const restartBudget = Object.fromEntries(Object.entries(this.state.restartBudget).map(([key, value]) => [key, { ...value, lockedOut: false, reason: undefined }]));
        this.persist({ restartBudget, observedState: 'degraded' });
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'starting' });
        await this.ensureRuntime();
        updateSupervisorOperation(this.options.controllerHome, current.operationId, { phase: 'verifying' });
        await this.waitForReady('controllerDaemon');
        await this.waitForReady('gatewayHost');
      } else if (current.kind === 'rollout') {
        releaseActivation = await this.rollout(current);
      } else {
        releaseActivation = await this.rollback(current.operationId, current.targetReleasePath);
      }
      this.synchronizeActiveRuntimeGeneration(true);
      const persistedOperation = readSupervisorOperation(this.options.controllerHome, current.operationId) ?? current;
      const result = {
        ...(persistedOperation.result ?? {}),
        operationId: current.operationId,
        runtimeGeneration: this.state.activeGeneration,
        reconnectContract: 'stable_domain_retry',
        ...(releaseActivation ? {
          supervisorReleaseRevision: releaseActivation.publication.releaseRevision,
          supervisorActivation: releaseActivation.activation,
        } : {}),
      };
      if (releaseActivation) {
        // Scheduling a self-replacing Supervisor is not success. Persist a
        // resumable nonterminal handoff; the newly activated Supervisor marks
        // it succeeded only after activation.json records verified readiness.
        current = updateSupervisorOperation(this.options.controllerHome, current.operationId, {
          phase: 'cutover',
          result,
          evidence: [
            ...(current.evidence ?? []),
            { kind: 'supervisor_activation', summary: `Supervisor activation ${releaseActivation.activation.activationId} scheduled; awaiting verified terminal state.`, at: new Date().toISOString() },
          ],
        });
        this.persist({ currentOperationId: null, observedState: 'healthy' });
        return;
      }
      current = updateSupervisorOperation(this.options.controllerHome, current.operationId, {
        phase: 'succeeded',
        completedAt: new Date().toISOString(),
        result,
      });
      this.persist({ currentOperationId: null, observedState: 'healthy' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current = updateSupervisorOperation(this.options.controllerHome, current.operationId, {
        phase: 'failed',
        completedAt: new Date().toISOString(),
        failureClass: message.includes('READINESS') ? 'readiness' : message.includes('IDENTITY') ? 'identity' : 'unknown',
        error: message,
      });
      this.persist({ currentOperationId: null, observedState: 'degraded', lastIncident: { at: new Date().toISOString(), reason: message, operationId: current.operationId } });
    }
  }

  private async runPendingOperations(): Promise<void> {
    if (this.executionPromise || this.stopping) return;
    this.executionPromise = (async () => {
      const pending = listSupervisorOperations(this.options.controllerHome, 100)
        .filter((operation) => operation.phase === 'accepted' || operation.phase === 'scheduled')
        .sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
      const next = pending[0];
      if (next) await this.executeOperation(next);
    })().finally(() => {
      this.executionPromise = undefined;
    });
    await this.executionPromise;
  }

  private async recoverComponent(component: SupervisorComponentName, failureReason = `${component} liveness failed`): Promise<void> {
    if (supervisorOperationRecoverySuppressed(this.state.currentOperationId)) {
      this.persist({
        observedState: 'degraded',
        lastIncident: {
          at: new Date().toISOString(),
          component,
          reason: `${failureReason}; automatic recovery deferred while Supervisor operation ${this.state.currentOperationId} owns the writer slot`,
          operationId: this.state.currentOperationId ?? undefined,
        },
      });
      return;
    }
    const managed = this.componentState(component);
    if (!managed) return;
    const authority = readActiveSlotAuthority(this.options.controllerHome);
    const standby = this.state.standby;
    if (
      !this.state.currentOperationId
      && standby
      && standby.slot === authority.previousSlot
      && isRollbackWindowOpen(authority)
      && this.manager.observe(standby.controllerDaemon) === 'alive'
      && this.manager.observe(standby.gatewayHost) === 'alive'
    ) {
      const accepted = createSupervisorOperation({
        controllerHome: this.options.controllerHome,
        repoRoot: this.options.repoRoot,
        requestId: `auto-rollback:${authority.activeSlot}:${authority.generation ?? 'unknown'}`,
        kind: 'rollback',
        requestedBy: 'supervisor',
        actor: 'supervisor',
        reason: `${failureReason} within the rollback window`,
      });
      this.persist({
        lastIncident: { at: new Date().toISOString(), component, reason: `${failureReason}; automatic rollback accepted`, operationId: accepted.operation.operationId },
      });
      await this.runPendingOperations();
      return;
    }
    const generation = managed.generation ?? this.state.activeGeneration;
    const key = managedKey(component, generation);
    const budget = this.state.restartBudget[key] ?? newRestartBudgetRecord(component, generation);
    const decision = decideRestart(budget);
    if (!decision.allowed) {
      if (decision.reason === 'backoff') {
        this.persist({
          observedState: 'degraded',
          lastIncident: { at: new Date().toISOString(), component, reason: `restart backoff active for ${decision.delayMs}ms` },
        });
        return;
      }
      this.persist({
        observedState: 'locked_out',
        restartBudget: { ...this.state.restartBudget, [key]: lockout(budget, decision.reason ?? 'restart budget exhausted') },
        lastIncident: { at: new Date().toISOString(), component, reason: decision.reason ?? 'restart budget exhausted' },
      });
      return;
    }
    const requestId = automaticRecoveryRequestId(component, generation, budget);
    const accepted = createSupervisorOperation({
      controllerHome: this.options.controllerHome,
      repoRoot: this.options.repoRoot,
      requestId,
      kind: operationKindForComponent(component),
      requestedBy: 'supervisor',
      actor: 'supervisor',
      reason: failureReason,
    });
    this.persist({
      restartBudget: { ...this.state.restartBudget, [key]: recordRestart(recordFailure(budget, failureReason)) },
      lastIncident: { at: new Date().toISOString(), component, reason: failureReason, operationId: accepted.operation.operationId },
    });
    await this.runPendingOperations();
  }

  private async monitorTick(): Promise<void> {
    if (this.stopping || this.selfRestartRequested || this.state.desiredState !== 'running') return;
    reconcilePendingSupervisorActivations(this.options.controllerHome);
    let degraded = !this.synchronizeActiveRuntimeGeneration(false);
    for (const component of ['controllerDaemon', 'gatewayHost'] as const) {
      const managed = this.componentState(component);
      const observation = this.manager.observe(managed);
      if (observation === 'alive' && managed) {
        if (component === 'gatewayHost') {
          const slot = managed.slot ?? this.state.activeSlot;
          const binding = this.managerForManaged(managed, slot).gatewayBinding(slot);
          const health = await probeSupervisorGatewayHealth(`http://${binding.host}:${binding.port}/ready`);
          if (!health.healthy || health.ready === false) {
            if (health.healthy && health.recoveryRecommended !== true) {
              this.setComponent('gatewayHost', {
                ...managed,
                state: 'running',
                lastLivenessAt: new Date().toISOString(),
                consecutiveFailures: 0,
              });
              this.persist({ lastIncident: { at: new Date().toISOString(), component, reason: health.detail } });
              continue;
            }
            // A preempted probe carries no health evidence; keep the budget unchanged.
            const decision = supervisorGatewayHealthDecision(managed.consecutiveFailures, false, health.failureClass === 'probe_cancelled');
            const consecutiveFailures = decision.consecutiveFailures;
            degraded = degraded || decision.shouldRecover;
            const failureReason = `gatewayHost readiness probe requires recovery ${consecutiveFailures}/${SUPERVISOR_GATEWAY_HEALTH_FAILURE_THRESHOLD}: ${health.detail}`;
            this.setComponent('gatewayHost', {
              ...managed,
              state: 'running',
              lastLivenessAt: new Date().toISOString(),
              consecutiveFailures,
            });
            if (decision.shouldRecover) {
              await this.recoverComponent('gatewayHost', failureReason);
            } else {
              this.persist({ lastIncident: { at: new Date().toISOString(), component, reason: failureReason } });
            }
            continue;
          }
        }
        const key = managedKey(component, managed.generation ?? this.state.activeGeneration);
        const budget = this.state.restartBudget[key];
        const healthyManaged = {
          ...managed,
          state: 'running' as const,
          lastLivenessAt: new Date().toISOString(),
          consecutiveFailures: 0,
        };
        this.persist({
          ...(budget ? { restartBudget: { ...this.state.restartBudget, [key]: recordStable(budget) } } : {}),
          ...(component === 'controllerDaemon' ? { controllerDaemon: healthyManaged } : { gatewayHost: healthyManaged }),
        });
      } else if (observation === 'dead') {
        degraded = true;
        await this.recoverComponent(component);
      } else {
        degraded = true;
        this.persist({ lastIncident: { at: new Date().toISOString(), component, reason: 'process identity could not be proven; process retained' } });
      }
    }
    if (this.state.observedState !== 'locked_out') {
      const gatewayAlive = this.manager.observe(this.state.gatewayHost) === 'alive';
      const gatewayHealthy = supervisorGatewayOperational(
        gatewayAlive,
        this.state.gatewayHost?.state,
        this.state.gatewayHost?.consecutiveFailures ?? 0,
      );
      const operationActive = Boolean(this.state.currentOperationId);
      const runtimeHealthy = gatewayHealthy && !degraded && !operationActive;
      if (runtimeHealthy) this.resetMonitorFailures();
      this.persist({
        observedState: runtimeHealthy ? 'healthy' : 'degraded',
        ingress: {
          ...this.state.ingress,
          // Compatibility projection only. Ingress presence is no longer part of
          // Supervisor lifecycle health and the monitor never recreates it.
          state: this.ingressRouter ? 'running' : 'stopped',
          pid: this.ingressRouter ? process.pid : undefined,
        },
      });

      // Public endpoint observations are diagnostics only. They cannot degrade,
      // restart, or otherwise control the Supervisor lifecycle.
      const externalEndpoint = process.env.REPO_HARNESS_SUPERVISOR_PUBLIC_HEALTH_ENDPOINT?.trim();
      if (externalEndpoint) {
        try {
          const externalHealth = await probeSupervisorGatewayHealth(externalEndpoint);
          this.persist({
            externalEndpointHealthy: externalHealth.healthy,
            externalEndpointLastCheckedAt: new Date().toISOString(),
            externalEndpointLastDetail: externalHealth.detail,
          });
        } catch {
          this.persist({
            externalEndpointHealthy: false,
            externalEndpointLastCheckedAt: new Date().toISOString(),
            externalEndpointLastDetail: 'external endpoint probe failed',
          });
        }
      }
    }
    await this.runPendingOperations();
    await this.cleanupExpiredStandby();
  }

  private scheduleMonitorTick(): void {
    if (this.monitorPromise || this.selfRestartRequested) return;
    const run = this.monitorTick().catch((error) => {
      const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
      if (detail.startsWith('SUPERVISOR_OPERATION_OWNER_BUSY')) {
        this.persist({
          observedState: 'degraded',
          lastIncident: { at: new Date().toISOString(), reason: `Supervisor monitor recovery deferred: ${detail}` },
        });
        return;
      }
      this.recordMonitorFailure(`Supervisor monitor tick failed: ${detail || 'unknown error'}`);
    });
    this.monitorPromise = run;
    void run.finally(() => {
      if (this.monitorPromise === run) this.monitorPromise = undefined;
    });
  }

  async handoff(): Promise<void> {
    this.stopping = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
    await this.monitorPromise?.catch(() => undefined);
    // Service activation replaces only the Supervisor process. Keep the active
    // and standby Daemon/Gateway pairs alive so in-memory MCP sessions survive
    // and the next Supervisor can adopt the identity-proven processes.
    this.persist({
      desiredState: 'running',
      observedState: 'degraded',
      lastIncident: {
        at: new Date().toISOString(),
        reason: 'Supervisor service handoff preserved managed runtime processes.',
      },
    });
    if (this.ingressRouter) await this.ingressRouter.close();
    this.ingressRouter = undefined;
    if (this.control) await this.control.close();
    this.control = undefined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    await this.monitorPromise?.catch(() => undefined);
    this.persist({ desiredState: 'stopped', observedState: 'stopped' });
    await this.stopComponent('gatewayHost');
    await this.stopComponent('controllerDaemon');
    if (this.state.standby) await this.stopSlotProcesses(this.state.standby);
    this.persist({ standby: undefined });
    if (this.ingressRouter) await this.ingressRouter.close();
    this.ingressRouter = undefined;
    if (this.control) await this.control.close();
    this.control = undefined;
    this.persist({ currentOperationId: null, ingress: { ...this.state.ingress, state: 'stopped' } });
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
