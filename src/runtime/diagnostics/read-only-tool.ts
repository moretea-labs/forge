import type { RepositoryRecord } from '../../cli/repositories/types';
import { loadMcpRuntimeState } from '../../cli/mcp/auth';
import { listControllerChecks } from '../../cli/controller/check-runner';
import { listLocalBridgeJobSnapshots } from '../../cli/local-bridge/job-store';
import { ensureRepositoryRuntimeStorage } from '../../cli/repositories/runtime-storage';
import { sessionCacheGlobalDiagnostics } from '../../cli/repository/session-cache';
import {
  cachedGitIdentity,
  gitIdentityPerformanceSnapshot,
  gitSnapshotPerformanceSnapshot,
} from '../../cli/repository/inspector';
import { previewRuntimeCleanup } from '../maintenance/cleanup';
import {
  buildCapabilityRecoverySnapshot,
  buildRuntimeMaintenanceStatus,
  listRecoveryAuditRecords,
} from '../recovery';
import { buildWorkflowWatchdogReport } from '../watchdog/workflow-watchdog';
import {
  collectRuntimePerformanceDiagnostics,
  inferLocalControllerProcess,
} from './performance';
import { readRepositoryProjectionSnapshot } from '../projections/materialized-view';
import {
  controllerContextPerformanceSnapshot,
  controllerContextProjectionNeedsRefresh,
  readControllerContextProjection,
} from '../projections/controller-context';
import { listExecutionJobs } from '../execution/jobs/store';
import { processRuntimeResourceDiagnostics } from '../execution/process-runtime';
import { readSchedulerHealthSnapshot } from '../control-plane/global-scheduler/scheduler';
import { readForgeRuntimeStatus } from '../control-plane/runtime-status-client';
import { listAssistantPluginManifests } from '../plugins/store';

export const READ_ONLY_DIAGNOSTIC_TOOLS = [
  'runtime_maintenance_status',
  'workflow_watchdog_report',
  'runtime_cleanup_preview',
  'runtime_performance_diagnostics',
  'capability_recovery_probe',
] as const;

export type ReadOnlyDiagnosticTool = (typeof READ_ONLY_DIAGNOSTIC_TOOLS)[number];

const READ_ONLY_DIAGNOSTIC_TOOL_SET = new Set<string>(READ_ONLY_DIAGNOSTIC_TOOLS);

export function isReadOnlyDiagnosticTool(value: string): value is ReadOnlyDiagnosticTool {
  return READ_ONLY_DIAGNOSTIC_TOOL_SET.has(value);
}

function activeExecutionJobs(controllerHome: string, repoId: string) {
  return listExecutionJobs(controllerHome, repoId, 100)
    .filter((job) => !['succeeded', 'failed', 'cancelled', 'timed_out', 'orphaned', 'stale'].includes(job.status));
}

function performanceDiagnostic(
  controllerHome: string,
  repository: RepositoryRecord,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const projection = readRepositoryProjectionSnapshot(controllerHome, repository.repoId).projection;
  const runtime = loadMcpRuntimeState(repository.canonicalRoot);
  const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
  const activeJobs = activeExecutionJobs(controllerHome, repository.repoId);
  const daemon = readForgeRuntimeStatus(controllerHome);
  return {
    ...collectRuntimePerformanceDiagnostics({
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
      queueDepth: projection.queueDepth ?? 0,
      runningWorkers: projection.runningWorkers ?? 0,
      activeLeases: projection.activeLeases ?? 0,
      activeJobIds: activeJobs.map((job) => job.jobId),
      includeProcesses: args.include_processes !== false,
      includeTempDirs: args.include_temp_dirs !== false,
      cleanupPreview: args.cleanup_preview === true,
      localControllerRunning: runtime?.localController?.running === true || inferredLocalBridge?.running === true,
      localControllerPid: runtime?.localController?.pid ?? inferredLocalBridge?.pid,
      localControllerEndpoint: runtime?.localController?.endpoint ?? inferredLocalBridge?.endpoint,
    }),
    contextPerformance: controllerContextPerformanceSnapshot(),
    gitPerformance: gitSnapshotPerformanceSnapshot(),
    gitIdentity: gitIdentityPerformanceSnapshot(),
    runtimeIdentity: {
      runtimeCommit: daemon.source?.commit,
      buildCommit: daemon.source?.releaseRevision,
      controllerInstanceId: daemon.instanceId,
      generation: daemon.generation,
      toolset: typeof args.__diagnostic_toolset === 'string' ? args.__diagnostic_toolset : 'advanced',
      profile: typeof args.__diagnostic_profile === 'string' ? args.__diagnostic_profile : 'controller',
    },
    resourceCost: {
      processRuntime: processRuntimeResourceDiagnostics(),
      scheduler: readSchedulerHealthSnapshot(controllerHome),
      sessionCache: sessionCacheGlobalDiagnostics(),
    },
  };
}

function diagnosticContextProjectionStale(
  controllerHome: string,
  repository: RepositoryRecord,
  args: Record<string, unknown>,
): boolean {
  const runtimeSnapshot = readRepositoryProjectionSnapshot(controllerHome, repository.repoId);
  const sourceRevision = String(runtimeSnapshot.projection.metadata?.contentRevision ?? runtimeSnapshot.projection.revision);
  const gitIdentity = cachedGitIdentity(repository.canonicalRoot);
  const sourceIdentity = {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    canonicalRoot: repository.canonicalRoot,
    head: gitIdentity.head,
    branch: gitIdentity.branch,
    workingTreeFingerprint: gitIdentity.workingTreeFingerprint,
    runtimeGeneration: runtimeSnapshot.projection.metadata?.producerGeneration,
    sourceRevision,
    variant: 'summary' as const,
    toolset: typeof args.__diagnostic_toolset === 'string' ? args.__diagnostic_toolset : 'advanced',
    profile: typeof args.__diagnostic_profile === 'string' ? args.__diagnostic_profile : 'controller',
  };
  const projection = readControllerContextProjection(controllerHome, repository.repoId, { sourceIdentity });
  return controllerContextProjectionNeedsRefresh(projection, sourceRevision, sourceIdentity);
}

function recoveryProbe(
  controllerHome: string,
  repository: RepositoryRecord,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const daemon = readForgeRuntimeStatus(controllerHome);
  const scheduler = readSchedulerHealthSnapshot(controllerHome);
  const projectionSnapshot = readRepositoryProjectionSnapshot(controllerHome, repository.repoId);
  const projection = projectionSnapshot.projection;
  const localBridge = loadMcpRuntimeState(repository.canonicalRoot)?.localController;
  const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
  const activeJobs = activeExecutionJobs(controllerHome, repository.repoId);
  const heartbeat = scheduler.lastHeartbeatAt ?? scheduler.lastTickAt;
  const heartbeatAgeMs = heartbeat ? Math.max(0, Date.now() - Date.parse(heartbeat)) : undefined;
  const heartbeatTimeoutMs = scheduler.heartbeatTimeoutMs ?? 60_000;
  let runtimeStorageReady = false;
  let runtimeStorageWarnings: string[] = [];
  try {
    const storage = ensureRepositoryRuntimeStorage(repository, controllerHome);
    runtimeStorageReady = storage.readyForExecution;
    runtimeStorageWarnings = storage.warnings;
  } catch (error) {
    runtimeStorageWarnings = [error instanceof Error ? error.message : String(error)];
  }
  const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 30);
  const recentErrors = Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : [];
  const contextProjectionStale = diagnosticContextProjectionStale(controllerHome, repository, args);
  const plugins = listAssistantPluginManifests(controllerHome, repository, { preferStored: true });
  const recovery = buildCapabilityRecoverySnapshot({
    generatedAt: new Date().toISOString(),
    daemonStatus: daemon.status === 'ready' ? 'ready' : daemon.status,
    daemonError: daemon.error,
    schedulerStatus: heartbeatAgeMs !== undefined && heartbeatAgeMs <= heartbeatTimeoutMs ? 'ready' : 'degraded',
    schedulerHeartbeatAgeMs: heartbeatAgeMs,
    queueDepth: projection.queueDepth ?? 0,
    runningWorkers: projection.runningWorkers ?? 0,
    activeLeases: projection.activeLeases ?? 0,
    localBridgeRunning: localBridge?.running ?? inferredLocalBridge?.running,
    localBridgeError: localBridge?.error,
    runtimeProjectionStale: projectionSnapshot.stale,
    runtimeProjectionPersisted: projectionSnapshot.persisted,
    contextProjectionStale,
    commandPreviewAvailable: args.command_preview_available === undefined ? true : args.command_preview_available === true,
    commandExecuteAvailable: args.command_execute_available === undefined ? true : args.command_execute_available === true,
    issueToolsAvailable: args.issue_tools_available === undefined ? true : args.issue_tools_available === true,
    jobToolsAvailable: args.job_tools_available === undefined ? true : args.job_tools_available === true,
    checksAvailable: listControllerChecks(repository.canonicalRoot).length > 0,
    runtimeStorageReady,
    runtimeStorageWarnings,
    pluginStates: plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      healthState: plugin.health.state,
      ready: plugin.health.ready,
      errors: plugin.health.errors,
      warnings: plugin.health.warnings,
    })),
    recentErrors,
    localJobs: localJobs.map((job) => ({ status: job.status, error: job.error, updatedAt: job.updatedAt })),
    executionJobs: activeJobs.map((job) => ({
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
      operation: job.payload.operation,
    })),
  });
  return { recovery, audit: listRecoveryAuditRecords(controllerHome, repository.repoId, 10) };
}

export async function executeReadOnlyDiagnostic(
  tool: ReadOnlyDiagnosticTool,
  controllerHome: string,
  repository: RepositoryRecord,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'runtime_maintenance_status':
      return buildRuntimeMaintenanceStatus(repository, controllerHome, {
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        cancelPendingApprovals: args.cancel_pending_approvals === true,
        recentErrors: Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : undefined,
      }) as unknown as Record<string, unknown>;
    case 'workflow_watchdog_report':
      return buildWorkflowWatchdogReport(controllerHome, repository, {
        staleMinutes: args.stale_minutes,
        includeProcesses: args.include_processes,
      }) as unknown as Record<string, unknown>;
    case 'runtime_cleanup_preview':
      return previewRuntimeCleanup(repository.canonicalRoot, {
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        includeTempDirs: args.include_temp_dirs !== false,
        includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
        includeLegacyRuns: args.include_legacy_runs === true,
        includeHistoricalAttention: args.include_historical_attention === true,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
      }) as unknown as Record<string, unknown>;
    case 'runtime_performance_diagnostics':
      return performanceDiagnostic(controllerHome, repository, args);
    case 'capability_recovery_probe':
      return recoveryProbe(controllerHome, repository, args);
  }
}
