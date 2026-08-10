/**
 * Shared, side-effect-free runtime health semantics.
 *
 * Callers are responsible for collecting observations from the Canonical Forge Runtime,
 * scheduler, projections, endpoints, and storage. This module only classifies
 * those observations so lifecycle, MCP, recovery, and UI surfaces cannot drift
 * into separate threshold implementations.
 */

export type RuntimeHealthState = 'healthy' | 'warning' | 'degraded' | 'unavailable';
export type RuntimeComponentState = RuntimeHealthState | 'disabled';

export interface HealthReason {
  code: string;
  message: string;
  component: keyof RuntimeHealthObservations;
  details?: Record<string, unknown>;
}

export interface ComponentHealth {
  state: RuntimeComponentState;
  ready: boolean;
  activeBlockers: HealthReason[];
  warnings: HealthReason[];
}

export interface DaemonObservation {
  status?: string;
  error?: string;
  heartbeatAgeMs?: number;
}

export interface SchedulerObservation {
  status?: string;
  heartbeatAgeMs?: number;
  dispatchHeartbeatAgeMs?: number;
}

export interface WorkerObservation {
  queueDepth?: number;
  runningWorkers?: number;
  activeLeases?: number;
  activeAttentionCount?: number;
}

export interface ProjectionObservation {
  readable: boolean;
  persisted: boolean;
  dirty?: boolean;
  sourceRevisionChanged?: boolean;
  refreshPending?: boolean;
  refreshGraceElapsed?: boolean;
  activeInvariantAtRisk?: boolean;
  producerHealthy?: boolean;
  producerHeartbeatAgeMs?: number;
  lastBuildError?: string;
  contentRevision?: number;
  generatedFromRevision?: string;
  sourceReconciliation?: ProjectionSourceReconciliation;
}

export interface ProjectionSourceReconciliation {
  status: 'consistent' | 'mismatch' | 'unknown';
  projectionRunningWorkers?: number;
  ledgerRunningTasks?: number;
  ledgerRunningTaskIds?: string[];
  detail?: string;
}

export type LocalBridgeMode = 'standalone' | 'embedded' | 'remote' | 'disabled' | 'unknown';

export interface LocalBridgeObservation {
  enabled: boolean;
  requiredForReadiness: boolean;
  mode: LocalBridgeMode;
  endpoint?: string;
  endpointReachable: boolean;
  expectedSurface: boolean;
  processAlive?: boolean;
  runtimeStateFresh?: boolean;
  error?: string;
}

export interface RuntimeStorageObservation {
  readable: boolean;
  ready?: boolean;
  warnings?: string[];
}

/**
 * End-to-end reachability signals for the ChatGPT -> ingress -> MCP -> Controller
 * path. These are observability-only: `unknown` never blocks readiness, it only
 * downgrades the displayed state. Local development (no public endpoint
 * configured) reports `unknown` and must remain ready.
 */
export type GradedObservationStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface GradedObservation {
  status: GradedObservationStatus;
  detail?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeHealthObservations {
  daemon: DaemonObservation;
  scheduler: SchedulerObservation;
  workers: WorkerObservation;
  projection: ProjectionObservation;
  localBridge: LocalBridgeObservation;
  runtimeStorage: RuntimeStorageObservation;
  /** Optional: public Stable Connector reachability. Absent => not evaluated. */
  externalReachability?: GradedObservation;
  /** Preferred name for public Stable Connector reachability. */
  externalEndpoint?: GradedObservation;
  /** Optional: most recent MCP initialize/tools-list handshake outcome. */
  mcpHandshake?: GradedObservation;
  /** Optional: ingress session migration continuity. */
  sessionContinuity?: GradedObservation;
}

export interface RuntimeHealthEvaluation {
  state: RuntimeHealthState;
  ready: boolean;
  activeBlockers: HealthReason[];
  warnings: HealthReason[];
  components: {
    daemon: ComponentHealth;
    scheduler: ComponentHealth;
    workers: ComponentHealth;
    projection: ComponentHealth;
    localBridge: ComponentHealth;
    runtimeStorage: ComponentHealth;
    externalReachability: ComponentHealth;
    mcpHandshake: ComponentHealth;
    sessionContinuity: ComponentHealth;
  };
}

/**
 * Three independent readiness axes. Ordinary interactive execution only
 * depends on `executionReady`; maintenance debt and durable-queue health are
 * separate signals and must not silently promote ordinary work into watchdog /
 * deep-diagnose / maintenance / recovery flows.
 */
export interface RuntimeReadinessSemantics {
  /** Ordinary read / search / command / patch / focused check reliability. */
  executionReady: boolean;
  /** Legacy debt / stale metadata / cleanup debt cleanliness (null = not evaluated). */
  maintenanceHealthy: boolean | null;
  /** Strict release / integration gate readiness. */
  releaseReady: boolean;
  reasons: {
    executionReady: HealthReason[];
    releaseReady: HealthReason[];
  };
}

export function classifyRuntimeReadinessSemantics(
  health: RuntimeHealthEvaluation,
  options: { maintenanceHealthy?: boolean | null } = {},
): RuntimeReadinessSemantics {
  const executionBlockers = [
    ...health.components.daemon.activeBlockers,
    ...health.components.projection.activeBlockers.filter((item) => (
      item.code === 'PROJECTION_UNREADABLE' || item.code === 'PROJECTION_BUILD_FAILED'
    )),
    ...health.components.localBridge.activeBlockers,
    ...health.components.runtimeStorage.activeBlockers.filter((item) => (
      item.code === 'RUNTIME_STORAGE_UNAVAILABLE'
    )),
  ];
  const releaseBlockers = [
    ...health.activeBlockers,
    ...health.components.projection.activeBlockers,
  ];
  return {
    executionReady: executionBlockers.length === 0,
    maintenanceHealthy: options.maintenanceHealthy ?? null,
    releaseReady: releaseBlockers.length === 0,
    reasons: {
      executionReady: executionBlockers,
      releaseReady: releaseBlockers,
    },
  };
}

export const RUNTIME_HEALTH_THRESHOLDS = {
  schedulerHeartbeatStaleMs: 10_000,
  queueProgressStaleMs: 10_000,
  projectionRefreshGraceMs: 30_000,
} as const;

function reason(
  component: keyof RuntimeHealthObservations,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HealthReason {
  return { component, code, message, ...(details ? { details } : {}) };
}

function component(
  state: RuntimeComponentState,
  activeBlockers: HealthReason[] = [],
  warnings: HealthReason[] = [],
): ComponentHealth {
  return {
    state,
    ready: activeBlockers.length === 0,
    activeBlockers,
    warnings,
  };
}

function classifyComponent(
  blockers: HealthReason[],
  warnings: HealthReason[],
): ComponentHealth {
  if (blockers.some((item) => item.code.endsWith('_UNAVAILABLE') || item.code === 'PROJECTION_UNREADABLE')) {
    return component('unavailable', blockers, warnings);
  }
  if (blockers.length > 0) return component('degraded', blockers, warnings);
  if (warnings.length > 0) return component('warning', blockers, warnings);
  return component('healthy');
}

function evaluateDaemon(observation: DaemonObservation): ComponentHealth {
  const blockers: HealthReason[] = [];
  const warnings: HealthReason[] = [];
  const status = observation.status?.trim().toLowerCase();
  if (status && status !== 'ready') {
    blockers.push(reason('daemon', 'RUNTIME_NOT_READY', `Forge Runtime is ${observation.status}.`, {
      status: observation.status,
      error: observation.error,
    }));
  } else if (observation.heartbeatAgeMs === undefined) {
    warnings.push(reason('daemon', 'RUNTIME_HEARTBEAT_UNKNOWN', 'Forge Runtime heartbeat is not available.'));
  }
  return classifyComponent(blockers, warnings);
}

function evaluateScheduler(
  observation: SchedulerObservation,
  workers: WorkerObservation,
): ComponentHealth {
  const blockers: HealthReason[] = [];
  const warnings: HealthReason[] = [];
  const status = observation.status?.trim().toLowerCase();
  const heartbeatStale = observation.heartbeatAgeMs !== undefined
    && observation.heartbeatAgeMs > RUNTIME_HEALTH_THRESHOLDS.schedulerHeartbeatStaleMs;
  const queueWaiting = (workers.queueDepth ?? 0) > 0;
  const explicitlyNotReady = status === 'not_ready';
  const degradedWithWaitingWork = status === 'degraded' && queueWaiting;
  const staleWithWaitingWork = heartbeatStale && queueWaiting;
  if (explicitlyNotReady || degradedWithWaitingWork || staleWithWaitingWork) {
    blockers.push(reason('scheduler', 'SCHEDULER_NOT_PROGRESSING', 'Scheduler is not progressing while durable work is waiting.', {
      status: observation.status,
      heartbeatAgeMs: observation.heartbeatAgeMs,
      queueDepth: workers.queueDepth ?? 0,
    }));
  } else if (status === 'degraded') {
    warnings.push(reason('scheduler', 'SCHEDULER_DEGRADED_IDLE', 'Scheduler reported a degraded recovery state, but its heartbeat is current and no work is waiting.', {
      status: observation.status,
      heartbeatAgeMs: observation.heartbeatAgeMs,
      queueDepth: workers.queueDepth ?? 0,
    }));
  } else if (heartbeatStale || observation.heartbeatAgeMs === undefined) {
    warnings.push(reason('scheduler', 'SCHEDULER_HEARTBEAT_UNCERTAIN', 'Scheduler heartbeat is stale or unavailable; idle runtime remains usable.', {
      heartbeatAgeMs: observation.heartbeatAgeMs,
    }));
  }
  return classifyComponent(blockers, warnings);
}

function evaluateWorkers(observation: WorkerObservation): ComponentHealth {
  const queueDepth = Math.max(0, observation.queueDepth ?? 0);
  const runningWorkers = Math.max(0, observation.runningWorkers ?? 0);
  const activeLeases = Math.max(0, observation.activeLeases ?? 0);
  const activeAttentionCount = Math.max(0, observation.activeAttentionCount ?? 0);
  const blockers: HealthReason[] = [];
  const warnings: HealthReason[] = [];
  if (activeAttentionCount > 0) {
    blockers.push(reason('workers', 'ACTIVE_JOB_ATTENTION_REQUIRED', 'Active execution records require attention before runtime work can be considered healthy.', {
      activeAttentionCount,
    }));
  }
  if (queueDepth > 0 && runningWorkers === 0 && activeLeases === 0) {
    blockers.push(reason('workers', 'WORKER_NOT_RUNNING', 'Queued work exists but no worker is consuming it.', {
      queueDepth,
      runningWorkers,
      activeLeases,
    }));
  } else if (activeLeases > 0 && runningWorkers === 0) {
    blockers.push(reason('workers', 'LEASE_WITHOUT_WORKER', 'Active leases exist without a running worker.', {
      queueDepth,
      runningWorkers,
      activeLeases,
    }));
  }
  return classifyComponent(blockers, warnings);
}

function evaluateProjection(observation: ProjectionObservation): ComponentHealth {
  const blockers: HealthReason[] = [];
  const warnings: HealthReason[] = [];
  if (!observation.readable) {
    blockers.push(reason('projection', 'PROJECTION_UNREADABLE', 'Runtime projection is missing or unreadable.', {
      persisted: observation.persisted,
    }));
    return classifyComponent(blockers, warnings);
  }
  if (observation.lastBuildError) {
    blockers.push(reason('projection', 'PROJECTION_BUILD_FAILED', 'The latest required projection build failed.', {
      error: observation.lastBuildError,
    }));
  }
  const refreshPending = observation.refreshPending === true
    || observation.sourceRevisionChanged === true
    || (
      observation.dirty === true
      && observation.sourceRevisionChanged !== false
      && observation.activeInvariantAtRisk === true
    );
  if (refreshPending) {
    const details = {
      dirty: observation.dirty,
      sourceRevisionChanged: observation.sourceRevisionChanged,
      activeInvariantAtRisk: observation.activeInvariantAtRisk,
    };
    if (observation.refreshGraceElapsed === true) {
      blockers.push(reason('projection', 'PROJECTION_REFRESH_MISSED', 'A required projection refresh has not completed within the bounded grace period.', details));
    } else {
      warnings.push(reason('projection', 'PROJECTION_REFRESH_PENDING', 'Projection content is awaiting a bounded refresh; readable idle state remains usable.', details));
    }
  }
  if (observation.producerHealthy === false) {
    if (refreshPending || observation.activeInvariantAtRisk === true) {
      blockers.push(reason('projection', 'PROJECTION_PRODUCER_UNHEALTHY', 'Projection producer is unhealthy while a required refresh is pending.', {
        producerHeartbeatAgeMs: observation.producerHeartbeatAgeMs,
      }));
    } else {
      warnings.push(reason('projection', 'PROJECTION_PRODUCER_UNCERTAIN', 'Projection producer heartbeat is unavailable; readable unchanged content remains usable.', {
        producerHeartbeatAgeMs: observation.producerHeartbeatAgeMs,
      }));
    }
  }
  if (observation.sourceReconciliation?.status === 'mismatch') {
    const mismatch = reason('projection', 'PROJECTION_SOURCE_MISMATCH', 'Task workflow progress and runtime worker ownership differ.', {
      ...observation.sourceReconciliation,
    });
    warnings.push(mismatch);
  }
  return classifyComponent(blockers, warnings);
}

function evaluateLocalBridge(observation: LocalBridgeObservation): ComponentHealth {
  if (!observation.enabled || observation.mode === 'disabled') return component('disabled');
  const blockers: HealthReason[] = [];
  const warnings: HealthReason[] = [];
  const issue = (value: HealthReason): void => {
    if (observation.requiredForReadiness) blockers.push(value);
    else warnings.push(value);
  };
  if (!observation.endpointReachable) {
    issue(reason('localBridge', 'LOCAL_BRIDGE_ENDPOINT_UNAVAILABLE', 'Expected Local Controller endpoint is not reachable.', {
      endpoint: observation.endpoint,
      mode: observation.mode,
      error: observation.error,
    }));
  } else if (!observation.expectedSurface) {
    issue(reason('localBridge', 'LOCAL_BRIDGE_SURFACE_MISMATCH', 'Expected endpoint responded, but it is not the Local Controller health surface.', {
      endpoint: observation.endpoint,
    }));
  }
  // Endpoint capability is authoritative. A stale persisted `running=false` or
  // missing PID is diagnostic evidence, not a failure when the expected surface
  // is reachable and identity checks pass.
  if (observation.endpointReachable && observation.expectedSurface && observation.processAlive === false) {
    warnings.push(reason('localBridge', 'LOCAL_BRIDGE_PROCESS_EVIDENCE_STALE', 'Local Controller endpoint is healthy although process ownership evidence is stale.', {
      endpoint: observation.endpoint,
      mode: observation.mode,
    }));
  }
  if (observation.endpointReachable && observation.runtimeStateFresh === false) {
    warnings.push(reason('localBridge', 'LOCAL_BRIDGE_RUNTIME_STATE_STALE', 'Persisted Local Controller state is stale; live endpoint capability is being used.', {
      endpoint: observation.endpoint,
    }));
  }
  return classifyComponent(blockers, warnings);
}

function evaluateRuntimeStorage(observation: RuntimeStorageObservation): ComponentHealth {
  const blockers: HealthReason[] = [];
  const warnings: HealthReason[] = [];
  if (!observation.readable || observation.ready === false) {
    blockers.push(reason('runtimeStorage', 'RUNTIME_STORAGE_UNAVAILABLE', 'Runtime storage is not ready for durable execution.', {
      readable: observation.readable,
      warnings: observation.warnings ?? [],
    }));
  } else if ((observation.warnings ?? []).length > 0) {
    warnings.push(reason('runtimeStorage', 'RUNTIME_STORAGE_WARNING', 'Runtime storage is usable but reported warnings.', {
      warnings: observation.warnings,
    }));
  }
  return classifyComponent(blockers, warnings);
}

function evaluateGradedObservation(
  componentName: 'externalReachability' | 'mcpHandshake' | 'sessionContinuity',
  observation: GradedObservation | undefined,
  label: string,
): ComponentHealth {
  if (!observation) return component('healthy');
  const details = {
    status: observation.status,
    ...(observation.detail ? { detail: observation.detail } : {}),
    ...(observation.details ?? {}),
  };
  const prefix = componentName === 'externalReachability'
    ? 'EXTERNAL_ENDPOINT'
    : componentName.replace(/[A-Z]/g, (value) => `_${value}`).toUpperCase();
  if (observation.status === 'healthy') return component('healthy');
  if (observation.status === 'unknown') {
    return component('warning', [], [reason(
      componentName,
      `${prefix}_UNKNOWN`,
      `${label} status is unknown; readiness is not blocked.`,
      details,
    )]);
  }
  return component('degraded', [reason(
    componentName,
    `${prefix}_UNHEALTHY`,
    `${label} is unhealthy.`,
    details,
  )]);
}

export function evaluateRuntimeHealth(observations: RuntimeHealthObservations): RuntimeHealthEvaluation {
  const components = {
    daemon: evaluateDaemon(observations.daemon),
    scheduler: evaluateScheduler(observations.scheduler, observations.workers),
    workers: evaluateWorkers(observations.workers),
    projection: evaluateProjection(observations.projection),
    localBridge: evaluateLocalBridge(observations.localBridge),
    runtimeStorage: evaluateRuntimeStorage(observations.runtimeStorage),
    externalReachability: evaluateGradedObservation(
      'externalReachability',
      observations.externalEndpoint ?? observations.externalReachability,
      'External endpoint',
    ),
    mcpHandshake: evaluateGradedObservation('mcpHandshake', observations.mcpHandshake, 'MCP handshake'),
    sessionContinuity: evaluateGradedObservation('sessionContinuity', observations.sessionContinuity, 'MCP session continuity'),
  };
  const allComponents = Object.values(components);
  const activeBlockers = allComponents.flatMap((item) => item.activeBlockers);
  const warnings = allComponents.flatMap((item) => item.warnings);
  const state: RuntimeHealthState = components.runtimeStorage.state === 'unavailable'
    || components.projection.state === 'unavailable'
    || components.localBridge.state === 'unavailable'
    ? 'unavailable'
    : activeBlockers.length > 0
      ? 'degraded'
      : warnings.length > 0
        ? 'warning'
        : 'healthy';
  return {
    state,
    ready: activeBlockers.length === 0,
    activeBlockers,
    warnings,
    components,
  };
}
