import { existsSync } from 'fs';
import { collectRuntimePerformanceDiagnostics, inferLocalControllerProcess } from '../../../src/runtime/diagnostics/performance';
import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { allControllerToolDefinitions, controllerExposureSnapshot, controllerToolSurfaceStatus } from '../toolset';
import { boundedPluginArtifactImageContent, jsonPreview, result, resultWithPluginArtifactImages } from './result-adapter';
import { expectedRevision, repositoryRootForRepoId, selected, stringList } from './shared-adapter';
import { callStatusInboxAdapter, GIT_IDENTITY_SAMPLE_TTL_MS, summarizeInvalidActiveWorkCandidate, summarizeWorkListItem } from './status-inbox-adapter';
import { ageMs, controllerReadinessEvidence, localControllerDiagnosticMatchesRuntime, probeLocalControllerHealth, runtimeSourceSnapshotStatus, type ControllerReadinessSignals } from './runtime-readiness-observation';
import { listRepositories, repositorySummary, resolveRepositorySelection } from '../../../src/cli/repositories/registry';
import { repositoryControllerRoot } from '../../../src/cli/repositories/controller-home';
import { cancelExecutionJob, findExecutionJob, getExecutionJob, getExecutionJobByRequestId, listExecutionJobs } from '../../../src/runtime/execution/jobs/store';
import { waitForExecutionJob } from '../../../src/runtime/execution/jobs/wait';
import { getProcessHandle, listRecoverableProcessRecords, processRuntimeResourceDiagnostics } from '../../../src/runtime/execution/process-runtime';
import { readExecutionArtifact } from '../../../src/runtime/evidence/artifact-store';
import { readExecutionEvidence } from '../../../src/runtime/evidence/evidence-store';
import { readForgeRuntimeStatus } from '../../../src/runtime/control-plane/runtime-status-client';
import { readSchedulerHealthSnapshot } from '../../../src/runtime/control-plane/global-scheduler/scheduler';
import { rebuildRepositoryProjection, projectionObservation, readRepositoryProjectionSnapshot, reconcileProjectionWithTaskLedger } from '../../../src/runtime/projections/materialized-view';
import {
  buildRuntimeOperationalView,
  classifyRuntimeReadinessSemantics,
  evaluateRuntimeHealth,
  RUNTIME_HEALTH_THRESHOLDS,
  type RuntimeHealthEvaluation,
  type RuntimeOperationalView,
  type GradedObservation,
} from '../../../src/runtime/health';
import { ensureRepositoryRuntimeStorage } from '../../../src/cli/repositories/runtime-storage';
import { projectBoard } from '../../../src/cli/controller/issue-store';
import { buildControllerTaskLedgerProjection } from '../../../src/cli/controller/task-ledger';
import { CONTROLLER_CONTEXT_IMPACT_DOMAINS, type ControllerContextImpactDomain } from '../../../src/cli/controller/context/types';
import { legacyIssueAuthorityRetired } from '../../../src/cli/controller/legacy-issue-cutover';
import { buildControllerOperationalPlan } from '../../../src/cli/controller/operational-plan';
import { listControllerChecks, readLatestControllerCheckEvidence } from '../../../src/cli/controller/check-runner';
import { listActiveAgentJobSnapshots } from '../../../src/cli/agent-jobs/job-manager';
import {
  controllerContextPerformanceSnapshot,
  controllerContextProjectionAgeMs,
  controllerContextProjectionGeneration,
  controllerContextProjectionPayloadMatchesSourceIdentity,
  controllerContextProjectionNeedsRefresh,
  queueControllerContextProjectionRefresh,
  readControllerContextProjection,
  readControllerContextProjectionInvalidation,
  recordControllerContextRead,
  writeControllerContextProjection,
} from '../../../src/runtime/projections/controller-context';
import { loadMcpRuntimeState } from '../auth';
import { resolveLocalBridgeSurface, summarizeRecentJobs } from '../../../src/runtime/shared/local-bridge-surface';
import { listAssistantPluginManifests } from '../../../src/runtime/plugins/store';
import { sessionCacheGlobalDiagnostics } from '../../../src/cli/repository/session-cache';
import { cachedGitIdentity, gitIdentityPerformanceSnapshot, gitSnapshot, gitSnapshotPerformanceSnapshot } from '../../../src/cli/repository/inspector';
import { buildWorkflowWatchdogReport } from '../../../src/runtime/watchdog/workflow-watchdog';
import {
  getLocalBridgeJobEventsSnapshot,
  getLocalBridgeJobSnapshot,
  listLocalBridgeJobSnapshots,
  readLocalBridgeJobOutputSnapshot,
} from '../../../src/cli/local-bridge/job-store';
import { callWorkAdapter, contextRecord, contextText, runFacadeRepair, runtimeIdentitySnapshot } from './work-adapter';
import { summarizeJobEvents, summarizeExecutionJob } from './runtime-tool-shared';

export function summarizeControllerReadyPayload(fullPayload: Record<string, unknown>): Record<string, unknown> {
  const health = (fullPayload.health ?? {}) as Record<string, unknown>;
  const workerLoop = (fullPayload.workerLoop ?? {}) as Record<string, unknown>;
  const durableScheduler = (fullPayload.durableScheduler ?? {}) as Record<string, unknown>;
  const localBridge = (fullPayload.localBridge ?? {}) as Record<string, unknown>;
  const localBridgeHealth = (localBridge.health ?? {}) as Record<string, unknown>;
  const toolSurface = (fullPayload.toolSurface ?? {}) as Record<string, unknown>;
  const routeBehavior = (fullPayload.routeBehavior ?? {}) as Record<string, unknown>;
  const expectedTools = Array.isArray(toolSurface.expectedTools) ? toolSurface.expectedTools : [];
  const actualTools = Array.isArray(toolSurface.actualTools) ? toolSurface.actualTools : [];
  const repoIdValue = typeof fullPayload.repoId === 'string' ? fullPayload.repoId : undefined;
  return {
    detailLevel: 'summary',
    repoId: repoIdValue,
    ready: fullPayload.ready,
    state: fullPayload.state,
    reasons: fullPayload.reasons,
    taskLedgerStatus: fullPayload.taskLedgerStatus,
    taskLedgerCounts: fullPayload.taskLedgerCounts,
    gateway: fullPayload.gateway,
    projectionReconciliation: fullPayload.projectionReconciliation,
    health: {
      state: health.state,
      ready: health.ready,
      activeBlockers: health.activeBlockers,
      warnings: health.warnings,
      components: health.components,
    },
    activity: {
      queueDepth: workerLoop.queueDepth,
      runningWorkers: workerLoop.runningWorkers,
      activeLeases: workerLoop.activeLeases,
      schedulerStatus: durableScheduler.status,
      schedulerHeartbeatAgeMs: durableScheduler.heartbeatAgeMs,
      localBridgeReady: localBridgeHealth.ready ?? localBridge.running,
    },
    externalEndpoint: fullPayload.externalEndpoint,
    runtimeIdentity: (() => {
      const identity = fullPayload.runtimeIdentity && typeof fullPayload.runtimeIdentity === 'object'
        ? fullPayload.runtimeIdentity as Record<string, unknown>
        : undefined;
      if (!identity) return undefined;
      return {
        releaseId: identity.releaseId,
        runtimeCommit: identity.runtimeCommit,
        buildCommit: identity.buildCommit,
        startedAt: identity.startedAt,
        controllerInstanceId: identity.controllerInstanceId,
        endpoint: identity.endpoint,
        ready: identity.ready,
        reasonCodes: identity.reasonCodes,
        toolset: identity.toolset,
        profile: identity.profile,
      };
    })(),
    routeBehavior: {
      schemaVersion: routeBehavior.schemaVersion,
      fingerprint: routeBehavior.fingerprint,
      probeCount: routeBehavior.probeCount,
    },
    toolSurface: {
      ready: toolSurface.ready,
      // Never report 0/0 as a real tool surface: an uncomputed exposure is
      // explicitly unknown until the snapshot has been built.
      expectedToolCount: expectedTools.length > 0 || toolSurface.ready ? expectedTools.length : null,
      actualToolCount: actualTools.length > 0 || toolSurface.ready ? actualTools.length : null,
      toolSurfaceState: expectedTools.length === 0 && actualTools.length === 0 && !toolSurface.ready ? 'unknown' : 'computed',
      missingTools: toolSurface.missingTools,
      unexpectedTools: toolSurface.unexpectedTools,
      duplicateTools: toolSurface.duplicateTools,
      fingerprint: toolSurface.fingerprint,
      schemaStableAcrossAccessModes: toolSurface.schemaStableAcrossAccessModes,
    },
    access: fullPayload.access,
    registeredRepositories: fullPayload.registeredRepositories,
    detailPointer: {
      tool: 'controller_ready',
      arguments: { ...(repoIdValue ? { repo_id: repoIdValue } : {}), detail_level: 'detail' },
    },
  };
}

function withRuntimeResponseMeta(
  payload: Record<string, unknown>,
  startedAt: number,
  options: {
    phaseTimingsMs?: Record<string, number>;
    transport?: string;
    sessionId?: string;
    routing?: { repoId?: string; checkoutId?: string };
    cacheHit?: boolean;
    stale?: boolean;
    refreshJobId?: string;
    sourceObservation?: { observedAt: string; ageMs: number; maxAgeMs: number; policy: 'bounded_sample_with_mutation_invalidation' };
  } = {},
): Record<string, unknown> {
  const response = {
    ...payload,
    responseMeta: {
      serverDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      phaseTimingsMs: options.phaseTimingsMs ?? {},
      transport: options.transport ?? 'runtime-local',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.routing ? { routing: options.routing } : {}),
      ...(options.cacheHit !== undefined ? { cacheHit: options.cacheHit } : {}),
      ...(options.stale !== undefined ? { stale: options.stale } : {}),
      ...(options.refreshJobId ? { refreshJobId: options.refreshJobId } : {}),
      ...(options.sourceObservation ? { sourceObservation: options.sourceObservation } : {}),
      structuredPayloadBytes: 0,
    },
  };
  response.responseMeta.structuredPayloadBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
  return response;
}

function summarizeRuntimeProjectionForReadiness<T extends { currentAttention?: unknown; attention?: unknown }>(projection: T): T & { historicalAttention?: unknown } {
  return {
    ...projection,
    attention: projection.currentAttention ?? projection.attention,
    historicalAttention: projection.attention,
  };
}

/**
 * Read-only Runtime identity projection. A stored identity is accepted only
 * while the live Runtime owner has the same Runtime instance and PID.
 */


function compactContextTask(value: unknown): Record<string, unknown> {
  const task = contextRecord(value);
  return {
    issueId: task.issueId ?? task.id,
    taskId: task.taskId ?? task.id,
    title: task.title,
    effectiveStatus: task.effectiveStatus,
    verificationStatus: task.verificationStatus,
    latestRunStatus: task.latestRunStatus,
    retryable: task.retryable,
    dispatchable: task.dispatchable,
    queueable: task.queueable,
  };
}

function compactControllerContextSummaryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Idempotent: already-compacted summaries pass through untouched.
  if (payload.detailLevel === 'summary') return payload;
  const git = contextRecord(payload.git);
  const repository = contextRecord(payload.repository);
  const ledger = contextRecord(payload.taskLedger);
  const operationalPlan = contextRecord(payload.operationalPlan);
  const ready = contextRecord(payload.controllerReady);
  const runtimeProjection = contextRecord(payload.runtimeProjection);
  const runtimeProjectionState = contextRecord(payload.runtimeProjectionState);
  const currentIssue = contextRecord(payload.currentIssue);
  const currentIssueTasks = Array.isArray(currentIssue.tasks) ? currentIssue.tasks : [];
  const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const activeRuns = Array.isArray(payload.activeRuns) ? payload.activeRuns : [];
  const attention = Array.isArray(ledger.attention) ? ledger.attention : [];
  const readyTasks = Array.isArray(ledger.readyTasks) ? ledger.readyTasks : [];
  const runtimeIdentity = contextRecord(payload.runtimeIdentity);
  const runtime = contextRecord(payload.runtime);
  const repoId = String(payload.repoId ?? repository.repoId ?? '');
  const enabledCount = plugins.filter((plugin) => contextRecord(plugin).enabled === true).length;
  const unhealthyCount = plugins.filter((plugin) => {
    const health = contextRecord(contextRecord(plugin).health);
    return health.state === 'unhealthy' || health.ready === false;
  }).length;
  const attentionPluginIds = plugins
    .filter((plugin) => {
      const health = contextRecord(contextRecord(plugin).health);
      return ['degraded', 'unhealthy', 'error'].includes(String(health.state));
    })
    .map((plugin) => contextRecord(plugin).pluginId)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, 5);
  const recommendedCheckIds = checks
    .filter((check) => contextRecord(check).recommended === true || contextRecord(check).required === true)
    .map((check) => contextRecord(check).id)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, 8);
  const lastFailureCount = checks.filter((check) => {
    const value = contextRecord(check);
    return value.lastFailureAt || value.failed === true;
  }).length;
  const changedFileCount = typeof git.changedFileCount === 'number'
    ? git.changedFileCount
    : typeof git.diffStat === 'string'
      ? git.diffStat.split(/\r?\n/).filter((line) => line.includes('|')).length
      : git.dirty === true ? -1 : 0;
  const compact: Record<string, unknown> = {
    detailLevel: 'summary',
    // Deprecated compatibility: legacy clients read this before focus.currentIssue.
    ...(payload.currentIssueId !== undefined ? { currentIssueId: payload.currentIssueId } : {}),
    repoId,
    repository: {
      repoId,
      checkoutId: repository.activeCheckoutId ?? repository.checkoutId,
      root: repository.canonicalRoot ?? repository.root ?? repository.localRoot,
      branch: git.branch,
      head: git.head,
      dirty: git.dirty === true,
      changedFileCount,
    },
    focus: {
      ...(currentIssue.id ? {
        currentIssue: {
          id: currentIssue.id,
          title: currentIssue.title,
          status: currentIssue.status,
          lifecycleStatus: currentIssue.lifecycleStatus,
          updatedAt: currentIssue.updatedAt,
          taskCount: currentIssueTasks.length,
          tasks: currentIssueTasks.slice(0, 5).map(compactContextTask),
        },
      } : {}),
      ...(payload.currentTask && typeof payload.currentTask === 'object' ? { currentTask: payload.currentTask } : {}),
      activeRunCount: activeRuns.length,
      ...(typeof payload.activeJobCount === 'number' ? { activeJobCount: payload.activeJobCount } : {}),
    },
    health: {
      ready: ready.ready === true,
      reasonCodes: Array.isArray(ready.reasonCodes) ? ready.reasonCodes.slice(0, 10) : [],
      diagnostics: contextRecord(ready.diagnostics),
      observedAt: ready.observedAt,
    },
    attention: attention.slice(0, 5).map(compactContextTask),
    readyTasks: readyTasks.slice(0, 5).map(compactContextTask),
    execution: {
      requiredChecks: recommendedCheckIds,
    },
    runtime: {
      releaseId: runtime.releaseId ?? runtimeIdentity.releaseId,
      runtimeCommit: runtime.runtimeCommit ?? runtimeIdentity.runtimeCommit,
      controllerInstanceId: runtime.controllerInstanceId ?? runtimeIdentity.controllerInstanceId,
      toolset: runtime.toolset ?? runtimeIdentity.toolset,
    },
    detailPointers: {
      git: { tool: 'repository_git_status', arguments: { repo_id: repoId } },
      taskLedger: { tool: 'controller_context', arguments: { repo_id: repoId, detail_level: 'detail' } },
      plugin: { tool: 'list_plugins', arguments: { repo_id: repoId } },
      check: { tool: 'controller_context', arguments: { repo_id: repoId, detail_level: 'detail' } },
      history: { tool: 'controller_context', arguments: { repo_id: repoId, detail_level: 'detail' } },
    },
    git: {
      branch: git.branch,
      head: git.head,
      dirty: git.dirty === true,
      changedFileCount,
    },
    plugins: { enabledCount, disabledCount: Math.max(0, plugins.length - enabledCount), unhealthyCount, attentionPluginIds },
    checks: { availableCount: checks.length, recommendedCheckIds, lastFailureCount },
    taskLedger: {
      schemaVersion: ledger.schemaVersion,
      source: ledger.source,
      generatedAt: ledger.generatedAt,
      currentIssueId: ledger.currentIssueId,
      counts: ledger.counts,
      issueCount: ledger.issueCount,
      archivedIssueCount: ledger.archivedIssueCount,
      status: ledger.status,
      contextContract: {
        strategy: contextRecord(ledger.contextContract).strategy,
        rawCodeRequiredForImplementation: true,
      },
    },
    operationalPlan: {
      schemaVersion: operationalPlan.schemaVersion,
      source: operationalPlan.source,
      generatedAt: operationalPlan.generatedAt,
      status: operationalPlan.status,
      completedCapabilities: (Array.isArray(operationalPlan.completedCapabilities) ? operationalPlan.completedCapabilities : []).slice(0, 5),
      remainingDecisionPoints: (Array.isArray(operationalPlan.remainingDecisionPoints) ? operationalPlan.remainingDecisionPoints : []).slice(0, 5),
      validationStrategy: operationalPlan.validationStrategy,
    },
    // Required keys for cache-completeness and legacy readers (deprecated).
    runtimeStorage: payload.runtimeStorage,
    runtimeProjectionState,
    runtimeProjection: runtimeProjection.repoId || runtimeProjection.revision !== undefined
      ? {
        schemaVersion: runtimeProjection.schemaVersion,
        repoId: runtimeProjection.repoId,
        generatedAt: runtimeProjection.generatedAt,
        revision: runtimeProjection.revision,
        queueDepth: runtimeProjection.queueDepth,
        runningWorkers: runtimeProjection.runningWorkers,
        activeLeases: runtimeProjection.activeLeases,
        currentAttention: (Array.isArray(runtimeProjection.currentAttention) ? runtimeProjection.currentAttention : []).slice(0, 5),
      }
      : runtimeProjection,
    activeRuns: activeRuns.slice(0, 5).map((run) => {
      const value = contextRecord(run);
      return { runId: value.runId, issueId: value.issueId, taskId: value.taskId, status: value.status, agent: value.agent, provider: value.provider, progress: value.progress, lastHeartbeatAt: value.lastHeartbeatAt, error: contextText(value.error, 300) };
    }),
    localBridge: (() => {
      const localBridge = contextRecord(payload.localBridge);
      return { reconciliation: localBridge.reconciliation };
    })(),
    ...(payload.repository ? { repositorySummary: repository } : {}),
  };
  if (ready.health || ready.ready !== undefined) {
    compact.controllerReady = summarizeControllerReadyPayload(ready);
  }
  return compact;
}

/**
 * Projection freshness is event-driven (source identity, invalidation marker,
 * materialized-view revision). The wall-clock TTL is only a bounded fallback
 * for lost events, so it is intentionally coarse.
 */
const CONTROLLER_CONTEXT_PROJECTION_REFRESH_MS = Math.max(
  5_000,
  Number(process.env.FORGE_CONTEXT_PROJECTION_REFRESH_MS ?? 300_000),
);

export async function controllerReadiness(
  ctx: MultiRepositoryMcpToolContext,
  repository = ctx.explicitRepository,
  signals: ControllerReadinessSignals = {},
) {
  const evidence = await controllerReadinessEvidence(ctx, repository, signals);
  const reasonCodes = new Set(evidence.reasons.map((item) => item.code));
  const controllerServicesReady = evidence.daemon.status === 'ready' && evidence.daemon.degraded !== true;
  const schedulerReady = evidence.durableScheduler.status === 'ready';
  const workersReady = evidence.workerLoop.consuming;
  const databaseReady = evidence.health.components.projection.ready;
  const releaseCoherenceReady = evidence.daemon.status === 'ready' && evidence.daemon.degraded !== true;
  const runtimeSource = runtimeSourceSnapshotStatus(evidence.daemon.source, ctx.runtimeSourceRoot);
  const sourceCoherenceReady = !runtimeSource.restartRequired;
  if (!sourceCoherenceReady) reasonCodes.add(runtimeSource.code);
  const ready = evidence.ready
    && controllerServicesReady
    && schedulerReady
    && workersReady
    && databaseReady
    && releaseCoherenceReady
    && sourceCoherenceReady;

  return {
    ready,
    reasonCodes: [...reasonCodes],
    diagnostics: {
      database: {
        ready: databaseReady,
        evidence: {
          persisted: evidence.projectionSnapshot?.persisted,
          stale: evidence.projectionSnapshot?.stale,
          projectionRevision: evidence.projection?.revision,
        },
      },
      controllerServices: {
        ready: controllerServicesReady,
        evidence: {
          status: evidence.daemon.status,
          degraded: evidence.daemon.degraded,
          error: evidence.daemon.error,
        },
      },
      scheduler: {
        ready: schedulerReady,
        evidence: {
          loopStartedAt: evidence.durableScheduler.loopStartedAt,
          lastTickAt: evidence.durableScheduler.lastTickAt,
          lastDispatchAt: evidence.durableScheduler.lastDispatchAt,
          heartbeatAgeMs: evidence.durableScheduler.heartbeatAgeMs,
          dispatchHeartbeatAgeMs: evidence.durableScheduler.dispatchHeartbeatAgeMs,
        },
      },
      workers: {
        ready: workersReady,
        evidence: {
          queueDepth: evidence.workerLoop.queueDepth,
          runningWorkers: evidence.workerLoop.runningWorkers,
          activeLeases: evidence.workerLoop.activeLeases,
          consuming: evidence.workerLoop.consuming,
        },
      },
      releaseCoherence: {
        ready: releaseCoherenceReady && sourceCoherenceReady,
        evidence: {
          status: evidence.daemon.status,
          degraded: evidence.daemon.degraded,
          error: evidence.daemon.error,
          sourceCoherence: {
            ready: sourceCoherenceReady,
            code: runtimeSource.code,
            reasons: runtimeSource.reasons,
          },
        },
      },
      mcpEndToEnd: {
        ready: evidence.ready,
        evidence: {
          activeBlockers: evidence.reasons,
          warnings: evidence.warnings,
        },
      },
    },
    observedAt: new Date().toISOString(),
  };
}

export async function callRuntimeObservationAdapter(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'local_bridge_status': {
              const repository = selected(ctx, args);
              const detailLevel = args.detail_level === 'detail' || args.detail === true ? 'detail' : 'summary';
              const surface = resolveLocalBridgeSurface({
                controllerHome: ctx.controllerHome,
                repoRoot: repository.canonicalRoot,
                // Process scan is expensive; only for detail or missing runtime state.
                allowProcessScan: detailLevel === 'detail',
              });
              const endpoint = surface.endpoint;
              const shouldProbe = surface.enabled
                && surface.endpointConfigured
                && Boolean(endpoint)
                && surface.mode !== 'disabled';
              const liveHealth = shouldProbe ? await probeLocalControllerHealth(endpoint) : null;
              const endpointReachable = liveHealth !== null;
              const expectedSurface = shouldProbe
                ? localControllerDiagnosticMatchesRuntime(liveHealth, {
                  generation: surface.generation,
                })
                : false;
              const processAlive = surface.processRunning;
              const projectionSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
              const daemon = readForgeRuntimeStatus(ctx.controllerHome);
              const scheduler = readSchedulerHealthSnapshot(ctx.controllerHome);
              const schedulerHeartbeatAgeMs = ageMs(scheduler.lastTickAt);
              const schedulerDispatchHeartbeatAgeMs = ageMs(scheduler.lastDispatchAt);
              const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
              const health = evaluateRuntimeHealth({
                daemon: {
                  status: daemon.status,
                  error: daemon.error,
                  heartbeatAgeMs: schedulerHeartbeatAgeMs,
                },
                scheduler: {
                  status: daemon.degraded ? 'degraded' : daemon.status,
                  heartbeatAgeMs: schedulerHeartbeatAgeMs,
                  dispatchHeartbeatAgeMs: schedulerDispatchHeartbeatAgeMs,
                },
                workers: {
                  queueDepth: projectionSnapshot.projection.queueDepth,
                  runningWorkers: projectionSnapshot.projection.runningWorkers,
                  activeLeases: projectionSnapshot.projection.activeLeases,
                  activeAttentionCount: projectionSnapshot.projection.currentAttention.length,
                },
                projection: projectionObservation(projectionSnapshot),
                localBridge: {
                  enabled: surface.enabled,
                  requiredForReadiness: surface.requiredForReadiness,
                  mode: surface.mode,
                  endpoint,
                  // When endpoint is not configured (disabled/unknown), treat as non-issue.
                  endpointReachable: shouldProbe ? endpointReachable : true,
                  expectedSurface: shouldProbe ? expectedSurface : true,
                  processAlive,
                  runtimeStateFresh: surface.source === 'service-runtime' || surface.source === 'repo-runtime',
                  error: surface.error,
                },
                runtimeStorage: {
                  readable: true,
                  ready: runtimeStorage.readyForExecution,
                  warnings: runtimeStorage.warnings,
                },
              });
              const jobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, detailLevel === 'detail' ? 12 : 20);
              const { activeJobCount, recentJobSummary } = summarizeRecentJobs(jobs);
              const running = surface.enabled
                && health.components.localBridge.ready
                && (!shouldProbe || (endpointReachable && expectedSurface));
              // Historical job counts are operational stats, not current readiness blockers.
              const bridgeWarnings = health.components.localBridge.warnings
                .filter((warning) => warning.code !== 'LOCAL_BRIDGE_ENDPOINT_UNAVAILABLE'
                  || surface.requiredForReadiness
                  || shouldProbe)
                .map((warning) => ({ code: warning.code, message: warning.message }));
      
              if (detailLevel === 'summary') {
                return result({
                  localBridgeSummary: true,
                  omitEnvelope: true,
                  detailLevel: 'summary',
                  repoId: repository.repoId,
                  running,
                  ready: health.components.localBridge.ready,
                  mode: surface.mode,
                  endpoint: endpoint ?? null,
                  endpointConfigured: surface.endpointConfigured,
                  endpointReachable: shouldProbe ? endpointReachable : null,
                  processRunning: processAlive ?? null,
                  expectedSurface: surface.expectedSurface,
                  requiredForReadiness: surface.requiredForReadiness,
                  warnings: bridgeWarnings,
                  activeJobCount,
                  recentJobSummary,
                  statusSource: surface.source,
                  nonBlocking: !surface.requiredForReadiness,
                });
              }
      
              return result({
                detailLevel: 'detail',
                endpoint: endpoint ?? null,
                endpointConfigured: surface.endpointConfigured,
                running,
                capability: {
                  enabled: surface.enabled,
                  requiredForReadiness: surface.requiredForReadiness,
                  mode: surface.mode,
                  ready: health.components.localBridge.ready,
                  endpointReachable: shouldProbe ? endpointReachable : null,
                  expectedSurface: shouldProbe ? expectedSurface : null,
                  observedAt: new Date().toISOString(),
                  owner: {
                    kind: surface.ownerKind,
                    ...(surface.pid ? { pid: surface.pid } : {}),
                  },
                  evidence: {
                    endpointReachable: shouldProbe ? endpointReachable : null,
                    expectedSurface: shouldProbe ? expectedSurface : null,
                    ...(processAlive !== undefined ? { processAlive } : {}),
                    runtimeStateFresh: surface.source === 'service-runtime' || surface.source === 'repo-runtime',
                    observedAt: new Date().toISOString(),
                  },
                },
                health: {
                  ready: health.ready,
                  // Do not elevate historical job failures into active blockers.
                  activeBlockers: health.activeBlockers,
                  warnings: health.warnings,
                },
                error: surface.error,
                statusSource: surface.source,
                counts: recentJobSummary,
                activeJobCount,
                recentJobSummary,
                approvalQueue: false,
                reconciliation: { scanned: jobs.length, active: activeJobCount, terminalized: 0, deferredToController: true },
                recentJobs: jobs.map((job) => ({
                  jobId: job.jobId,
                  action: job.action,
                  status: job.status,
                  checkId: job.action === 'run-check' ? (job.payload as { checkId?: string }).checkId : undefined,
                  runId: job.runId,
                  issueId: job.issueId,
                  taskId: job.taskId,
                  createdAt: job.createdAt,
                  updatedAt: job.updatedAt,
                  finishedAt: job.finishedAt,
                  revision: job.revision,
                  deadlineAt: job.deadlineAt,
                  error: job.error?.slice(0, 300),
                })),
                fallback: 'Open the localhost Local Controller to launch work or inspect execution when a ChatGPT write action is unavailable.',
                repoId: repository.repoId,
                repository: repositorySummary(repository),
                runtimeStorage,
                nonBlocking: !surface.requiredForReadiness,
              });
            }
      case 'get_local_job': {
              const repository = selected(ctx, args);
              const jobId = String(args.job_id ?? '').trim();
              const job = getLocalBridgeJobSnapshot(repository.canonicalRoot, jobId);
              return result({
                job: job.job,
                lookup: job.status === 'ok' ? undefined : job,
                ...(args.include_events === true && job.status === 'ok'
                  ? { events: getLocalBridgeJobEventsSnapshot(repository.canonicalRoot, jobId) }
                  : {}),
                ...(args.include_output === true ? { output: readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
                  stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
                  maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
                }) } : {}),
                repoId: repository.repoId,
                repository: repositorySummary(repository),
                runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
                nonBlocking: true,
              });
            }
      case 'get_local_job_output': {
              const repository = selected(ctx, args);
              const jobId = String(args.job_id ?? '').trim();
              return result({
                ...readLocalBridgeJobOutputSnapshot(repository.canonicalRoot, jobId, {
                  stream: args.stream === 'stderr' ? 'stderr' : 'stdout',
                  maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
                }),
                repoId: repository.repoId,
                repository: repositorySummary(repository),
                runtimeStorage: ensureRepositoryRuntimeStorage(repository, ctx.controllerHome),
                nonBlocking: true,
              });
            }
      case 'controller_context': {
              const responseStartedAt = performance.now();
              const phaseTimingsMs: Record<string, number> = {};
              const markPhase = (name: string, startedAt: number): void => {
                phaseTimingsMs[name] = Math.round((performance.now() - startedAt) * 100) / 100;
              };
              const repositoryStartedAt = performance.now();
              const repository = selected(ctx, args);
              markPhase('repositoryRouting', repositoryStartedAt);
              const variant = args.detail_level === 'detail' ? 'detail' as const : 'summary' as const;
              const runtimeRoot = repositoryControllerRoot(ctx.controllerHome, repository.repoId);
              const runtimeStorage = {
                repoId: repository.repoId,
                controllerRoot: runtimeRoot,
                readyForExecution: existsSync(runtimeRoot),
                readOnly: true,
              };
              const runtimeSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
              const runtimeProjection = runtimeSnapshot.projection;
              const contextSourceRevision = String(runtimeProjection.metadata?.contentRevision ?? runtimeProjection.revision);
              // Git identity is sampled at most once per TTL per repository; hot reads
              // reuse the sampled HEAD/fingerprint instead of spawning subprocesses.
              const gitIdentityStartedAt = performance.now();
              const gitIdentity = cachedGitIdentity(repository.canonicalRoot);
              const gitIdentityObservation = {
                observedAt: new Date(gitIdentity.sampledAt).toISOString(),
                ageMs: Math.max(0, Date.now() - gitIdentity.sampledAt),
                maxAgeMs: GIT_IDENTITY_SAMPLE_TTL_MS,
                policy: 'bounded_sample_with_mutation_invalidation' as const,
              };
              markPhase('gitIdentity', gitIdentityStartedAt);
              const invalidationStartedAt = performance.now();
              const contextInvalidation = readControllerContextProjectionInvalidation(repository.canonicalRoot);
              markPhase('invalidation', invalidationStartedAt);
              const sourceIdentity = {
                repoId: repository.repoId,
                checkoutId: repository.activeCheckoutId,
                canonicalRoot: repository.canonicalRoot,
                head: gitIdentity.head,
                branch: gitIdentity.branch,
                workingTreeFingerprint: gitIdentity.workingTreeFingerprint,
                runtimeGeneration: runtimeProjection.metadata?.producerGeneration,
                sourceRevision: contextSourceRevision,
                variant,
                toolset: ctx.toolset,
                profile: ctx.policy.profile,
              };
              markPhase('identity', repositoryStartedAt);
              const cacheStartedAt = performance.now();
              const cached = readControllerContextProjection(ctx.controllerHome, repository.repoId, {
                sourceIdentity,
              });
              const projectionAgeMs = controllerContextProjectionAgeMs(cached);
              markPhase('cacheRead', cacheStartedAt);
              const cachedPayload = cached?.payload;
              const cachedProjectionIncomplete = !cachedPayload
                || typeof cachedPayload !== 'object'
                || !('repoId' in cachedPayload)
                || !('runtimeProjectionState' in cachedPayload)
                || !('controllerReady' in cachedPayload);
              const invalidatedAfterBuild = Boolean(
                cached
                && contextInvalidation
                && cached.invalidationNonce !== contextInvalidation.nonce,
              );
              // The materialized-view stale flag is reported, not acted on: a view
              // that is stale-but-unchanged (daemon down) would otherwise force an
              // endless rebuild of an already-current context projection. Context
              // freshness tracks its own source identity, the view revision, and the
              // invalidation marker.
              const cacheStale = controllerContextProjectionNeedsRefresh(cached, contextSourceRevision, sourceIdentity)
                || invalidatedAfterBuild
                || !Number.isFinite(projectionAgeMs)
                || projectionAgeMs >= CONTROLLER_CONTEXT_PROJECTION_REFRESH_MS;
              const projectionPayload = (
                projectionRecord: typeof cached,
                stale: boolean,
                refreshJobId?: string,
              ): Record<string, unknown> => {
                const ageMs = controllerContextProjectionAgeMs(projectionRecord);
                return {
                  contextProjection: {
                    variant,
                    generatedAt: projectionRecord?.generatedAt,
                    ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
                    stale,
                    healthImpact: false,
                    sourceIdentity: projectionRecord?.sourceIdentity ?? sourceIdentity,
                    projectionGeneration: projectionRecord?.projectionGeneration ?? controllerContextProjectionGeneration(sourceIdentity),
                    refreshState: projectionRecord?.refreshState ?? 'idle',
                    lastRefreshError: projectionRecord?.lastRefreshError,
                    nextAttemptAt: projectionRecord?.nextAttemptAt,
                    sourceRevision: projectionRecord?.sourceRevision ?? contextSourceRevision,
                    strategy: 'event-driven-swr',
                    refreshJobId,
                    readOnly: true,
                    nonBlocking: true,
                  },
                };
              };
      
              const responseOptions = {
                phaseTimingsMs,
                transport: 'runtime-local',
                sessionId: ctx.sessionId,
                routing: { repoId: repository.repoId, checkoutId: repository.activeCheckoutId },
                sourceObservation: gitIdentityObservation,
              };
              const respondWith = (
                payload: Record<string, unknown>,
                projectionRecord: typeof cached,
                input: { cacheHit: boolean; stale: boolean; refreshJobId?: string },
              ): CallToolResult => {
                const {
                  modeContextPack: _legacyModeContextPack,
                  recommendedExecution: _legacyRecommendedExecution,
                  ...taskScopedPayload
                } = payload;
                if (!controllerContextProjectionPayloadMatchesSourceIdentity(taskScopedPayload, sourceIdentity)) {
                  const response = withRuntimeResponseMeta({
                    error: {
                      code: 'CONTEXT_PROJECTION_SOURCE_MISMATCH',
                      message: 'Refusing controller context whose payload identity differs from the selected repository checkout.',
                      errorClass: 'infrastructure_failure',
                      summary: 'Controller context identity validation failed closed.',
                    },
                    ...projectionPayload(projectionRecord, true, input.refreshJobId),
                  }, responseStartedAt, { ...responseOptions, cacheHit: input.cacheHit, stale: true, refreshJobId: input.refreshJobId });
                  const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
                  recordControllerContextRead({
                    durationMs: performance.now() - responseStartedAt,
                    cacheHit: input.cacheHit,
                    stale: true,
                    responseBytes,
                    phaseDurationsMs: phaseTimingsMs,
                  });
                  return result(response, true);
                }
                const response = withRuntimeResponseMeta({
                  ...taskScopedPayload,
                  ...projectionPayload(projectionRecord, input.stale, input.refreshJobId),
                }, responseStartedAt, { ...responseOptions, cacheHit: input.cacheHit, stale: input.stale, refreshJobId: input.refreshJobId });
                const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
                recordControllerContextRead({
                  durationMs: performance.now() - responseStartedAt,
                  cacheHit: input.cacheHit,
                  stale: input.stale,
                  responseBytes,
                  phaseDurationsMs: phaseTimingsMs,
                });
                return result(response);
              };
              if (variant === 'summary' && cached && !cachedProjectionIncomplete && !cacheStale) {
                return respondWith(compactControllerContextSummaryPayload(cached.payload), cached, { cacheHit: true, stale: false });
              }
      
              const buildStartedAt = performance.now();
              const buildPayload = async (): Promise<Record<string, unknown>> => {
                const readinessStartedAt = performance.now();
                const readiness = await controllerReadiness(ctx, repository);
                markPhase('build.readiness', readinessStartedAt);
                const activeCheckout = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
                const gitStartedAt = performance.now();
                const liveGit = gitSnapshot(repository.canonicalRoot);
                markPhase('build.git', gitStartedAt);
                const taskStateStartedAt = performance.now();
                const board = legacyIssueAuthorityRetired(repository.canonicalRoot)
                  ? undefined
                  : projectBoard(repository.canonicalRoot);
                const taskLedger = buildControllerTaskLedgerProjection(repository.canonicalRoot, board);
                const operationalPlan = buildControllerOperationalPlan(repository.canonicalRoot, taskLedger);
                markPhase('build.task_state', taskStateStartedAt);
                const currentIssueRecord = board?.currentIssueId
                  ? board.issues.find((issue) => issue.id === board.currentIssueId)
                  : undefined;
                const currentIssue = currentIssueRecord ? {
                  id: currentIssueRecord.id,
                  title: currentIssueRecord.title,
                  status: currentIssueRecord.status,
                  lifecycleStatus: currentIssueRecord.lifecycleStatus,
                  updatedAt: currentIssueRecord.updatedAt,
                  tasks: Array.isArray(currentIssueRecord.tasks)
                    ? currentIssueRecord.tasks.slice(0, 20).map((task) => {
                      const item = task as Record<string, unknown>;
                      return {
                        id: item.id,
                        title: item.title,
                        effectiveStatus: item.effectiveStatus,
                        latestRunStatus: item.latestRunStatus,
                      };
                    })
                    : [],
                } : undefined;
                const jobsStartedAt = performance.now();
                const activeRuns = listActiveAgentJobSnapshots(repository.canonicalRoot, 20).map((run) => ({
                  runId: run.runId,
                  issueId: run.issueId,
                  taskId: run.taskId,
                  status: run.status,
                  agent: run.agent,
                  provider: run.provider,
                  executionMode: run.executionMode,
                  progress: run.progress,
                  lastHeartbeatAt: run.lastHeartbeatAt,
                  error: run.error,
                }));
                const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 12);
                const activeLocalJobs = localJobs.filter((job) => ['approved', 'running', 'dispatched'].includes(job.status)).length;
                const recentLocalJobs = localJobs.map((job) => ({
                  jobId: job.jobId,
                  action: job.action,
                  status: job.status,
                  runId: job.runId,
                  issueId: job.issueId,
                  taskId: job.taskId,
                  createdAt: job.createdAt,
                  updatedAt: job.updatedAt,
                  finishedAt: job.finishedAt,
                  error: job.error?.slice(0, 300),
                }));
                markPhase('build.jobs', jobsStartedAt);
                const checksStartedAt = performance.now();
                const checks = listControllerChecks(repository.canonicalRoot).map((check) => {
                  const evidence = readLatestControllerCheckEvidence(repository.canonicalRoot, check.id);
                  return {
                    id: check.id,
                    description: check.description,
                    timeoutMs: check.timeoutMs,
                    source: check.source,
                    ...(evidence ? { lastFailureAt: evidence.ok ? undefined : evidence.executedAt, failed: !evidence.ok } : {}),
                  };
                });
                markPhase('build.checks', checksStartedAt);
                const pluginsStartedAt = performance.now();
                const plugins = listAssistantPluginManifests(ctx.controllerHome, repository, {
                  preferStored: true,
                  // Controller context is a materialized read in every detail mode.
                  // Missing projections remain unknown until explicit plugin discovery
                  // or execution refreshes them; a context read never probes hosts.
                  fallbackToLive: false,
                }).map((plugin) => ({
                  pluginId: plugin.pluginId,
                  provider: plugin.provider,
                  enabled: plugin.enabled,
                  revision: plugin.revision,
                  lifecycle: plugin.lifecycle,
                  health: plugin.health,
                  actionCount: plugin.actions.length,
                  actions: plugin.actions.map((action) => ({
                    actionId: action.actionId,
                    readOnly: action.readOnly,
                    risk: action.risk,
                    confirmation: action.confirmation,
                  })),
                }));
                markPhase('build.plugins', pluginsStartedAt);
                return {
                  git: liveGit.branch || liveGit.head || liveGit.status || liveGit.diffStat ? liveGit : {
                    branch: activeCheckout?.branch ?? sourceIdentity.branch ?? null,
                    head: sourceIdentity.head ?? null,
                    status: 'No live repository scan is available; showing bounded runtime state only.',
                    diffStat: '',
                    dirty: false,
                  },
                  currentIssueId: board?.currentIssueId ?? taskLedger.currentIssueId,
                  currentIssue,
                  taskLedger,
                  taskLedgerStatus: taskLedger.status,
                  operationalPlan,
                  readyTasks: (board?.readyTasks ?? taskLedger.readyTasks).slice(0, 20),
                  activeRuns,
                  activeJobCount: activeLocalJobs,
                  localBridge: {
                    reconciliation: { scanned: localJobs.length, active: activeLocalJobs, terminalized: 0 },
                    recentJobs: recentLocalJobs,
                  },
                  plugins,
                  checks,
                  repoId: repository.repoId,
                  repository: repositorySummary(repository),
                  runtimeStorage,
                  runtimeProjection,
                  runtimeProjectionState: {
                    stale: runtimeSnapshot.stale,
                    persisted: runtimeSnapshot.persisted,
                  },
                  controllerReady: readiness,
                  runtimeIdentity: runtimeIdentitySnapshot(ctx),
                };
              };
      
              if (variant === 'summary' && cached && !cachedProjectionIncomplete) {
                const refresh = queueControllerContextProjectionRefresh(ctx.controllerHome, repository.repoId, {
                  variant,
                  sourceIdentity,
                  projectionGeneration: controllerContextProjectionGeneration(sourceIdentity),
                  invalidationNonce: contextInvalidation?.nonce,
                  build: buildPayload,
                });
                markPhase('refreshQueue', buildStartedAt);
                const refreshing = readControllerContextProjection(ctx.controllerHome, repository.repoId, {
                  sourceIdentity,
                });
                return respondWith(compactControllerContextSummaryPayload(cached.payload), refreshing ?? cached, {
                  cacheHit: true,
                  stale: true,
                  refreshJobId: refresh.refreshJobId,
                });
              }
      
              const payload = await buildPayload();
              const persistedPayload = variant === 'summary'
                ? compactControllerContextSummaryPayload(payload)
                : payload;
              markPhase('build', buildStartedAt);
              let projectionRecord: typeof cached;
              try {
                projectionRecord = writeControllerContextProjection(ctx.controllerHome, repository.repoId, persistedPayload, {
                  sourceRevision: contextSourceRevision,
                  contentFingerprint: runtimeProjection.metadata?.contentFingerprint,
                  invalidationNonce: contextInvalidation?.nonce,
                  sourceIdentity,
                  variant,
                  projectionGeneration: controllerContextProjectionGeneration(sourceIdentity),
                  refreshState: 'idle',
                });
              } catch {
                projectionRecord = cached;
              }
              markPhase('serialize', performance.now());
              return respondWith(persistedPayload, projectionRecord, {
                cacheHit: false,
                stale: controllerContextProjectionNeedsRefresh(projectionRecord, contextSourceRevision, sourceIdentity),
              });
            }
      case 'get_job': {
              const jobId = String(args.job_id ?? '').trim();
              let job = typeof args.repo_id === 'string' ? getExecutionJob(ctx.controllerHome, args.repo_id, jobId) : findExecutionJob(ctx.controllerHome, jobId);
              if (!job) return result({ error: { code: 'JOB_NOT_FOUND', message: jobId || 'missing job_id', errorClass: 'not_found', summary: '未找到对应 Job。' } }, true);
              let timedOut = false;
              let waitedMs = 0;
              if (args.wait === true || typeof args.wait_ms === 'number') {
                const waited = await waitForExecutionJob({
                  controllerHome: ctx.controllerHome,
                  repoId: job.repoId,
                  jobId: job.jobId,
                  timeoutMs: typeof args.wait_ms === 'number' ? args.wait_ms : 15_000,
                });
                job = waited.job;
                timedOut = waited.timedOut;
                waitedMs = waited.waitedMs;
              }
              const full = args.detail_level === 'full';
              const repoRoot = repositoryRootForRepoId(ctx.controllerHome, job.repoId);
              // summarizeExecutionJob already embeds a compact digest + single suggestedNextActions list.
              const jobSummary = summarizeExecutionJob(job, repoRoot);
              return result({
                detailLevel: 'summary',
                requestedDetailLevel: full ? 'full' : 'summary',
                job: jobSummary,
                summary: jobSummary.summary,
                phase: jobSummary.phase,
                statusLabel: jobSummary.statusLabel,
                errorClass: jobSummary.errorClass,
                errorMessage: jobSummary.errorMessage,
                changedFiles: jobSummary.changedFiles,
                suggestedNextActions: jobSummary.suggestedNextActions,
                artifactRefs: jobSummary.artifactRefs,
                evidenceIds: jobSummary.evidenceIds,
                evidenceRefs: jobSummary.evidenceRefs,
                waited: args.wait === true || typeof args.wait_ms === 'number',
                timedOut,
                waitedMs,
                ...(args.include_events === true
                  ? { events: summarizeJobEvents(ctx.controllerHome, job.repoId, job.jobId) }
                  : {}),
                next: full
                  ? 'Raw job state is intentionally not returned through MCP. Use the bounded job summary, events, and get_artifact with artifactId (ART-...), not evidenceId (EVD-...).'
                  : jobSummary.terminal
                    ? String(jobSummary.summary ?? '')
                    : 'Historical Job is still active. Continue independent work; read it only if an observation can change the next decision, and use work_wait only when this exact result becomes a dependency. Do not periodically poll.',
              }, jobSummary.phase === 'failed' || jobSummary.phase === 'timed_out');
            }
      case 'get_artifact': {
              const artifactId = String(args.artifact_id ?? '').trim();
              const legacyArtifactRepoId = String(args.repo_id ?? '').trim() || undefined;
              const artifactPrincipalId = ctx.principalId?.trim() || '__anonymous__';
              if (artifactId.startsWith('EVD-')) {
                const evidence = readExecutionEvidence(ctx.controllerHome, artifactId, { legacyRepoId: legacyArtifactRepoId, principalId: artifactPrincipalId });
                return result({
                  referenceType: 'evidence',
                  evidenceId: evidence.evidenceId,
                  repoId: evidence.repoId,
                  jobId: evidence.jobId,
                  outcome: evidence.outcome,
                  operation: evidence.operation,
                  revision: evidence.revision,
                  executedAt: evidence.executedAt,
                  note: 'This is an evidenceId (EVD-...), not an artifactId (ART-...). Evidence holds audit metadata; command output lives under artifactRefs/artifactId.',
                  next: `For output content, call get_job with job_id=${evidence.jobId} and use artifactRefs.artifactId, then get_artifact with that ART-... id.`,
                });
              }
              if (!artifactId.startsWith('ART-') && artifactId) {
                return result({
                  error: {
                    code: 'ARTIFACT_ID_EXPECTED',
                    message: `Expected artifactId starting with ART- (got ${artifactId.slice(0, 40)}). evidenceId (EVD-...) is audit metadata; use get_job artifactRefs for content.`,
                  },
                  referenceType: 'unknown',
                  next: 'Call get_job, read artifactRefs[].artifactId (ART-...), then get_artifact with that id. repo_id is only a legacy adoption hint.',
                }, true);
              }
              const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : 64 * 1024;
              const loaded = readExecutionArtifact(ctx.controllerHome, artifactId, maxBytes, { legacyRepoId: legacyArtifactRepoId, principalId: artifactPrincipalId });
              // Do not re-attach controller/repository/runtime envelopes here; multi-repo layer already compact.
              return result({
                referenceType: 'artifact',
                artifactId: loaded.artifact.artifactId,
                artifactKind: loaded.artifact.kind,
                repoId: loaded.artifact.repoId,
                jobId: loaded.artifact.jobId,
                byteLength: loaded.artifact.byteLength,
                mediaType: loaded.artifact.mediaType,
                truncated: loaded.truncated,
                content: loaded.content,
                next: loaded.truncated
                  ? `Artifact truncated at ${maxBytes} bytes. Re-call get_artifact with a larger max_bytes (up to 512KB) or page via result refs.`
                  : 'Artifact content loaded.',
              });
            }
      case 'list_jobs': {
              const repository = selected(ctx, args);
              const requestedLimit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 100;
              const limit = Math.max(1, Math.min(requestedLimit, 100));
              const jobs = listExecutionJobs(ctx.controllerHome, repository.repoId, limit);
              const full = args.detail_level === 'full';
              return result({
                detailLevel: 'summary',
                requestedDetailLevel: full ? 'full' : 'summary',
                limit,
                jobs: jobs.map((job) => summarizeExecutionJob(job, repository.canonicalRoot)),
                next: 'Call get_job with one job_id for bounded details; raw job state is intentionally not returned through MCP.',
              });
            }
      case 'controller_ready': {
              const explicitRepoId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
              const registered = listRepositories(ctx.controllerHome).filter((repository) => repository.enabled && !repository.removedAt);
              const repository = explicitRepoId
                ? selected(ctx, args)
                : (ctx.explicitRepository ?? (registered.length === 1 ? registered[0] : undefined));
              const readiness = await controllerReadiness(ctx, repository);
              const exposure = controllerExposureSnapshot(ctx);
              const toolSurfaceReady = exposure.ready && exposure.missingToolNames.length === 0;
              const reasonCodes = new Set(readiness.reasonCodes);
              if (!toolSurfaceReady) reasonCodes.add('MCP_TOOL_SURFACE_INCOMPLETE');
              const mcpReady = readiness.diagnostics.mcpEndToEnd.ready && toolSurfaceReady;
              const ready = readiness.ready && mcpReady;
              const payload = {
                ready,
                reasonCodes: [...reasonCodes],
                diagnostics: {
                  ...readiness.diagnostics,
                  mcpEndToEnd: {
                    ready: mcpReady,
                    evidence: {
                      ...readiness.diagnostics.mcpEndToEnd.evidence,
                      expectedToolCount: exposure.expectedToolNames.length,
                      actualToolCount: exposure.actualToolNames.length,
                      missingTools: exposure.missingToolNames,
                      unexpectedTools: exposure.unexpectedToolNames,
                      duplicateTools: exposure.duplicateToolNames,
                      fingerprint: exposure.fingerprint,
                    },
                  },
                },
                observedAt: readiness.observedAt,
              };
              return result(payload);
            }
      case 'repository_runtime_snapshot': {
              const repository = selected(ctx, args);
              const snapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
              return result({
                snapshot: summarizeRuntimeProjectionForReadiness(snapshot.projection),
                stale: snapshot.stale,
                persisted: snapshot.persisted,
                dirtySinceAt: snapshot.dirtySinceAt,
                dirtyReason: snapshot.dirtyReason,
              });
            }
      case 'runtime_performance_diagnostics': {
              const repository = selected(ctx, args);
              const projection = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId).projection;
              const runtime = loadMcpRuntimeState(repository.canonicalRoot);
              const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
              const activeJobIds = listExecutionJobs(ctx.controllerHome, repository.repoId, 100)
                .filter((job) => ['queued', 'dispatched', 'running', 'waiting_for_dependency', 'waiting_for_workspace', 'waiting_for_heavy_check', 'waiting_for_integration'].includes(job.status))
                .map((job) => job.jobId);
              const diagnostics = collectRuntimePerformanceDiagnostics({
                repoId: repository.repoId,
                repoRoot: repository.canonicalRoot,
                queueDepth: projection?.queueDepth ?? 0,
                runningWorkers: projection?.runningWorkers ?? 0,
                activeLeases: projection?.activeLeases ?? 0,
                activeJobIds,
                includeProcesses: args.include_processes !== false,
                includeTempDirs: args.include_temp_dirs !== false,
                cleanupPreview: args.cleanup_preview === true,
                localControllerRunning: runtime?.localController?.running === true || inferredLocalBridge?.running === true,
                localControllerPid: runtime?.localController?.pid ?? inferredLocalBridge?.pid,
                localControllerEndpoint: runtime?.localController?.endpoint ?? inferredLocalBridge?.endpoint,
              });
              return result({
                ...diagnostics,
                contextPerformance: controllerContextPerformanceSnapshot(),
                gitPerformance: gitSnapshotPerformanceSnapshot(),
                gitIdentity: gitIdentityPerformanceSnapshot(),
                runtimeIdentity: runtimeIdentitySnapshot(ctx),
                resourceCost: {
                  processRuntime: processRuntimeResourceDiagnostics(),
                  scheduler: readSchedulerHealthSnapshot(ctx.controllerHome),
                  sessionCache: sessionCacheGlobalDiagnostics(),
                },
              });
            }
      case 'workflow_watchdog_report': {
              const repository = selected(ctx, args);
              return result(buildWorkflowWatchdogReport(ctx.controllerHome, repository, { staleMinutes: args.stale_minutes, includeProcesses: args.include_processes }) as unknown as Record<string, unknown>);
            }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
