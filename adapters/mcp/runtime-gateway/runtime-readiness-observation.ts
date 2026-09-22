import type { MultiRepositoryMcpToolContext } from "../multi-repository";
import { reconcileReadinessProjectionSource } from "../readiness-projection";
import { listExecutionJobs } from "../../../src/runtime/execution/jobs/store";
import { readForgeRuntimeStatus } from "../../../src/runtime/control-plane/runtime-status-client";
import { readSchedulerHealthSnapshot } from "../../../src/runtime/control-plane/global-scheduler/scheduler";
import { evaluateActiveRuntimeSourceDrift, type RuntimeSourceIdentity } from "../../../src/runtime/control-plane/runtime-generation";
import { projectionObservation, readRepositoryProjectionSnapshot } from "../../../src/runtime/projections/materialized-view";
import { buildRuntimeOperationalView, classifyRuntimeReadinessSemantics, evaluateRuntimeHealth, RUNTIME_HEALTH_THRESHOLDS, type RuntimeOperationalView, type GradedObservation } from "../../../src/runtime/health";
import { buildControllerTaskLedgerProjection } from "../../../src/cli/controller/task-ledger";
import { legacyIssueAuthorityRetired } from "../../../src/cli/controller/legacy-issue-cutover";
import { FORGE_MCP_SCHEMA_VERSION, FORGE_TOOL_SURFACE, FORGE_VERSION } from "../../../src/cli/controller/runtime-config";
import { resolveLocalBridgeSurface } from "../../../src/runtime/shared/local-bridge-surface";
import { listHandoffItems } from "../../../src/runtime/control-plane/facade";

export function ageMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : undefined;
}

export async function probeLocalControllerHealth(endpoint: string | undefined): Promise<Record<string, unknown> | null> {
  if (!endpoint) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const url = new URL(endpoint);
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function localControllerDiagnosticMatchesRuntime(
  payload: Record<string, unknown> | null,
  expected: { generation?: string } = {},
): boolean {
  return payload?.status === 'ok'
    && payload.toolSurface === FORGE_TOOL_SURFACE
    && payload.schemaVersion === FORGE_MCP_SCHEMA_VERSION
    && payload.version === FORGE_VERSION
    && (expected.generation === undefined || payload.generation === expected.generation);
}

export interface ControllerReadinessSignals {
  externalEndpoint?: GradedObservation;
  mcpHandshake?: GradedObservation;
  sessionContinuity?: GradedObservation;
}

export async function controllerReadinessEvidence(
  ctx: MultiRepositoryMcpToolContext,
  repository = ctx.explicitRepository,
  signals: ControllerReadinessSignals = {},
) {
  const daemon = readForgeRuntimeStatus(ctx.controllerHome);
  const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
  const projectionSnapshot = repository ? readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId) : undefined;
  const projection = projectionSnapshot?.projection;
  const taskLedger = repository && !legacyIssueAuthorityRetired(repository.canonicalRoot)
    ? buildControllerTaskLedgerProjection(repository.canonicalRoot)
    : undefined;
  const projectionReconciliation = projectionSnapshot
    ? reconcileReadinessProjectionSource(projectionSnapshot, taskLedger)
    : undefined;
  const localBridgeSurface = repository
    ? resolveLocalBridgeSurface({
      controllerHome: ctx.controllerHome,
      repoRoot: repository.canonicalRoot,
      allowProcessScan: false,
    })
    : undefined;
  const localBridgeEndpoint = localBridgeSurface?.endpoint;
  const shouldProbeLocalBridge = Boolean(
    localBridgeSurface?.enabled
    && localBridgeSurface.endpointConfigured
    && localBridgeEndpoint
    && localBridgeSurface.mode !== 'disabled',
  );
  const localBridgeLiveHealth = shouldProbeLocalBridge
    ? await probeLocalControllerHealth(localBridgeEndpoint)
    : null;
  const localBridgeEndpointReachable = localBridgeLiveHealth !== null;
  const localBridgeExpectedSurface = shouldProbeLocalBridge
    ? localControllerDiagnosticMatchesRuntime(localBridgeLiveHealth, {
      generation: localBridgeSurface?.generation,
    })
    : true;
  const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
  const dispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
  const localBridgeObservation = {
    enabled: localBridgeSurface?.enabled ?? false,
    requiredForReadiness: localBridgeSurface?.requiredForReadiness ?? false,
    mode: localBridgeSurface?.mode ?? ('disabled' as const),
    endpoint: localBridgeEndpoint,
    endpointReachable: shouldProbeLocalBridge ? localBridgeEndpointReachable : true,
    expectedSurface: localBridgeExpectedSurface,
    processAlive: localBridgeSurface?.processRunning,
    runtimeStateFresh: localBridgeSurface?.source === 'service-runtime'
      || localBridgeSurface?.source === 'repo-runtime',
    error: localBridgeSurface?.error,
  };
  const runtimeHealth = evaluateRuntimeHealth({
    daemon: {
      status: daemon.status,
      error: daemon.error,
      // Scheduler ticks are emitted by the Canonical Forge Runtime process and provide
      // its continuously refreshed heartbeat without introducing a second timer.
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
    },
    scheduler: {
      status: daemon.degraded ? 'degraded' : daemon.status,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs,
    },
    workers: {
      queueDepth: projection?.queueDepth,
      runningWorkers: projection?.runningWorkers,
      activeLeases: projection?.activeLeases,
      activeAttentionCount: projection?.currentAttention.length,
    },
    projection: projectionSnapshot ? projectionObservation(projectionSnapshot, projectionReconciliation) : {
      readable: true,
      persisted: true,
    },
    localBridge: localBridgeObservation,
    runtimeStorage: { readable: true, ready: true },
    ...signals,
  });
  const operationalView: RuntimeOperationalView = buildRuntimeOperationalView({
    health: runtimeHealth,
    handoffs: repository
      ? listHandoffItems({ controllerHome: ctx.controllerHome, repoId: repository.repoId, status: 'all', limit: 100 })
      : [],
    jobs: repository ? listExecutionJobs(ctx.controllerHome, repository.repoId, 100) : [],
  });
  const reasons: Array<{ code: string; message: string }> = runtimeHealth.activeBlockers.map((item) => ({
    code: item.code === 'SCHEDULER_NOT_PROGRESSING'
      ? 'DISPATCH_LOOP_STALLED'
      : item.code === 'LEASE_WITHOUT_WORKER' || item.code === 'WORKER_NOT_RUNNING'
        ? 'WORKER_NOT_RUNNING'
        : item.code,
    message: item.message,
  }));
  if (
    reasons.some((item) => item.code === 'WORKER_NOT_RUNNING')
    && (dispatchHeartbeatAgeMs === undefined || dispatchHeartbeatAgeMs > RUNTIME_HEALTH_THRESHOLDS.queueProgressStaleMs)
  ) {
    reasons.push({
      code: 'QUEUE_NOT_PROGRESSING',
      message: 'Queued Jobs have not received a recent dispatch heartbeat.',
    });
  }
  const ready = runtimeHealth.ready;
  return {
    ready,
    state: ready ? runtimeHealth.state === 'healthy' ? 'ready' as const : 'degraded' as const : daemon.status === 'ready' ? 'degraded' as const : 'not_ready' as const,
    reasons,
    warnings: runtimeHealth.warnings.map((item) => ({ code: item.code, message: item.message })),
    health: runtimeHealth,
    operationalView,
    daemon,
    durableScheduler: {
      status: runtimeHealth.components.scheduler.ready ? 'ready' : daemon.status === 'ready' ? 'degraded' : 'not_ready',
      loopStartedAt: scheduler.loopStartedAt,
      lastTickAt: scheduler.lastTickAt,
      lastDispatchAt: scheduler.lastDispatchAt,
      lastReconcileAt: scheduler.lastReconcileAt,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      dispatchHeartbeatAgeMs,
    },
    workerLoop: {
      status: projection?.runningWorkers ? 'running' : projection?.queueDepth ? 'idle' : 'ready',
      queueDepth: projection?.queueDepth ?? 0,
      runningWorkers: projection?.runningWorkers ?? 0,
      activeLeases: projection?.activeLeases ?? 0,
      activeAttentionCount: projection?.currentAttention.length ?? 0,
      consuming: (projection?.queueDepth ?? 0) === 0 || (projection?.runningWorkers ?? 0) > 0,
    },
    localBridge: repository ? {
      running: Boolean(localBridgeSurface?.enabled)
        && runtimeHealth.components.localBridge.ready
        && (!shouldProbeLocalBridge || (localBridgeEndpointReachable && localBridgeExpectedSurface)),
      endpoint: localBridgeEndpoint,
      error: localBridgeSurface?.error,
      inferredPid: localBridgeSurface?.pid,
      statusSource: localBridgeSurface?.source ?? 'none',
      health: runtimeHealth.components.localBridge,
    } : undefined,
    projection,
    projectionSnapshot,
    taskLedger,
    projectionReconciliation,
    semantics: classifyRuntimeReadinessSemantics(runtimeHealth),
  };
}

export function runtimeSourceSnapshotStatus(
  active: RuntimeSourceIdentity | undefined,
  currentRuntimeRoot?: string,
) {
  const drift = evaluateActiveRuntimeSourceDrift(active, {
    currentRuntimeRoot,
  });
  return {
    current: drift.current,
    restartRequired: drift.restartRequired,
    reasons: drift.reasons,
    code: drift.code,
  };
}

