import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { listControllerChecks } from '../../../src/cli/controller/check-runner';
import { ensureRepositoryRuntimeStorage } from '../../../src/cli/repositories/runtime-storage';
import { cachedGitIdentity } from '../../../src/cli/repository/inspector';
import { inferLocalControllerProcess } from '../../../src/runtime/diagnostics/performance';
import { listExecutionJobs } from '../../../src/runtime/execution/jobs/store';
import { listLocalBridgeJobSnapshots } from '../../../src/cli/local-bridge/job-store';
import { listAssistantPluginManifests } from '../../../src/runtime/plugins/store';
import { readRepositoryProjectionSnapshot } from '../../../src/runtime/projections/materialized-view';
import {
  controllerContextProjectionNeedsRefresh,
  readControllerContextProjection,
} from '../../../src/runtime/projections/controller-context';
import {
  buildCapabilityRecoverySnapshot,
  buildRuntimeMaintenanceStatus,
  executeCapabilityRecoveryAction,
  executeRuntimeMaintenanceAction,
  RecoveryApplicationError,
  listRecoveryAuditRecords,
  previewRuntimeStorageRepair,
  applyRuntimeStorageRepair,
  type RuntimeMaintenanceActionId,
} from '../../../src/runtime/recovery';
import { loadMcpRuntimeState } from '../auth';
import { formatRuntimeSourceDriftMessage } from '../../../src/runtime/control-plane/runtime-generation';
import { callStandaloneRecoveryTool } from './recovery-client-adapter';
import {
  controllerReadinessEvidence,
  runtimeSourceSnapshotStatus,
} from './status-inbox-adapter';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

async function capabilityRecoveryInput(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
) {
  const readiness = await controllerReadinessEvidence(ctx, repository);
  const runtimeSnapshot = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
  const localBridge = loadMcpRuntimeState(repository.canonicalRoot)?.localController;
  const inferredLocalBridge = inferLocalControllerProcess(repository.canonicalRoot);
  const contextProjectionSourceRevision = String(
    runtimeSnapshot.projection.metadata?.contentRevision ?? runtimeSnapshot.projection.revision,
  );
  const contextGitIdentity = cachedGitIdentity(repository.canonicalRoot);
  const contextSourceIdentity = {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    canonicalRoot: repository.canonicalRoot,
    head: contextGitIdentity.head,
    branch: contextGitIdentity.branch,
    workingTreeFingerprint: contextGitIdentity.workingTreeFingerprint,
    runtimeGeneration: runtimeSnapshot.projection.metadata?.producerGeneration,
    sourceRevision: contextProjectionSourceRevision,
    variant: 'summary' as const,
    toolset: ctx.toolset,
    profile: ctx.policy.profile,
  };
  const contextProjection = readControllerContextProjection(ctx.controllerHome, repository.repoId, {
    sourceIdentity: contextSourceIdentity,
  });
  const contextProjectionStale = controllerContextProjectionNeedsRefresh(
    contextProjection,
    contextProjectionSourceRevision,
    contextSourceIdentity,
  );
  const recentErrors = Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : [];
  const runtimeSource = runtimeSourceSnapshotStatus(readiness.daemon.source, ctx.runtimeSourceRoot);
  let runtimeStorageReady: boolean | undefined;
  let runtimeStorageWarnings: string[] = [];
  try {
    const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
    runtimeStorageReady = runtimeStorage.readyForExecution;
    runtimeStorageWarnings = runtimeStorage.warnings;
  } catch (error) {
    runtimeStorageReady = false;
    runtimeStorageWarnings = [error instanceof Error ? error.message : String(error)];
  }
  const plugins = listAssistantPluginManifests(ctx.controllerHome, repository, { preferStored: true });
  const localJobs = listLocalBridgeJobSnapshots(repository.canonicalRoot, 30);
  const executionJobs = listExecutionJobs(ctx.controllerHome, repository.repoId, 30);
  return {
    generatedAt: new Date().toISOString(),
    daemonStatus: readiness.daemon.status,
    daemonError: readiness.daemon.error,
    schedulerStatus: readiness.durableScheduler.status,
    schedulerHeartbeatAgeMs: readiness.durableScheduler.heartbeatAgeMs,
    schedulerDispatchHeartbeatAgeMs: readiness.durableScheduler.dispatchHeartbeatAgeMs,
    queueDepth: readiness.workerLoop.queueDepth,
    runningWorkers: readiness.workerLoop.runningWorkers,
    activeLeases: readiness.workerLoop.activeLeases,
    localBridgeRunning: localBridge?.running ?? inferredLocalBridge?.running,
    localBridgeError: localBridge?.error,
    runtimeHealth: readiness.health,
    runtimeOperationalView: readiness.operationalView,
    connectorHealthy: undefined,
    runtimeProjectionStale: runtimeSnapshot.stale,
    runtimeProjectionPersisted: runtimeSnapshot.persisted,
    runtimeSourceCoherence: {
      ready: !runtimeSource.restartRequired,
      code: runtimeSource.code,
      reasons: runtimeSource.reasons,
      summary: runtimeSource.restartRequired
        ? formatRuntimeSourceDriftMessage(runtimeSource)
        : 'Runtime source snapshot matches the current Controller Runtime source.',
    },
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
    executionJobs: executionJobs.map((job) => ({
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
      operation: job.payload.operation,
    })),
  };
}

async function capabilityRecoverySnapshot(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return buildCapabilityRecoverySnapshot(await capabilityRecoveryInput(ctx, repository, args)) as unknown as Record<string, unknown>;
}

export async function callRecoveryAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  switch (name) {
    case 'capability_recovery_probe': {
      const repository = selected(ctx, args);
      const snapshot = await buildCapabilityRecoverySnapshot(await capabilityRecoveryInput(ctx, repository, args));
      const blockingCapabilityCount = snapshot.capabilities
        .filter((capability) => ['blocked', 'unavailable', 'degraded'].includes(capability.state))
        .length;
      const ready = blockingCapabilityCount === 0 && snapshot.platformBlocked !== true;
      return result({
        ready,
        reasonCodes: ready ? [] : [snapshot.externalLifecycleHandoff?.reasonCode ?? 'RUNTIME_DIAGNOSTICS_ATTENTION_REQUIRED'],
        diagnostics: {
          capabilityCount: snapshot.capabilities.length,
          blockingCapabilityCount,
          platformBlocked: snapshot.platformBlocked === true,
          recentAuditCount: listRecoveryAuditRecords(ctx.controllerHome, repository.repoId, 10).length,
        },
        externalLifecycleHandoff: snapshot.externalLifecycleHandoff,
        observedAt: snapshot.generatedAt,
        mutatesState: false,
        ownsRuntimeLifecycle: false,
      });
    }
    case 'capability_recovery_plan': {
      const repository = selected(ctx, args);
      const snapshot = await buildCapabilityRecoverySnapshot(await capabilityRecoveryInput(ctx, repository, args));
      const blockingCapabilityCount = snapshot.capabilities
        .filter((capability) => ['blocked', 'unavailable', 'degraded'].includes(capability.state))
        .length;
      const ready = blockingCapabilityCount === 0 && snapshot.platformBlocked !== true;
      return result({
        ready,
        reasonCodes: ready ? [] : [snapshot.externalLifecycleHandoff?.reasonCode ?? 'RUNTIME_DIAGNOSTICS_ATTENTION_REQUIRED'],
        diagnostics: {
          capabilityCount: snapshot.capabilities.length,
          blockingCapabilityCount,
          platformBlocked: snapshot.platformBlocked === true,
        },
        observedAt: snapshot.generatedAt,
        handoffRequired: !ready,
        externalLifecycleHandoff: snapshot.externalLifecycleHandoff,
        notes: snapshot.notes,
        next: ready
          ? 'Continue through the current Runtime and Work interfaces.'
          : snapshot.externalLifecycleHandoff
            ? 'Create or consume an rh_inbox handoff for the external Runtime lifecycle owner. Operate on the existing single forge-runtime only, then verify controller_ready and rh_status source coherence.'
            : 'Inspect runtime_maintenance_status and create an rh_inbox handoff when operator or external Controller action is required.',
      });
    }
    case 'runtime_maintenance_status': {
      const repository = selected(ctx, args);
      return result(buildRuntimeMaintenanceStatus(repository, ctx.controllerHome, {
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        cancelPendingApprovals: args.cancel_pending_approvals === true,
      }) as unknown as Record<string, unknown>);
    }
    case 'runtime_maintenance_apply': {
      const repository = selected(ctx, args);
      const actionId = String(args.action_id ?? '').trim() as RuntimeMaintenanceActionId;
      return result(executeRuntimeMaintenanceAction({
        controllerHome: ctx.controllerHome,
        repository,
        actionId,
        confirmMaintenance: args.confirm_maintenance === true,
        authorization: typeof args.authorization === 'string' ? args.authorization : undefined,
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        cancelPendingApprovals: args.cancel_pending_approvals === true,
      }) as unknown as Record<string, unknown>);
    }
    case 'capability_recovery_apply': {
      const repository = selected(ctx, args);
      const actionId = String(args.action_id ?? '').trim();
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'manual recovery action';
      try {
        return result(await executeCapabilityRecoveryAction({
          controllerHome: ctx.controllerHome,
          repository,
          actionId,
          reason,
          confirmAuthorization: args.confirm_authorization === true,
          authorization: typeof args.authorization === 'string' ? args.authorization : undefined,
          minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          callStandaloneRecoveryTool: (toolName, toolArgs) => callStandaloneRecoveryTool(ctx.controllerHome, toolName, toolArgs),
          recoverySnapshot: () => capabilityRecoverySnapshot(ctx, repository, args),
        }) as unknown as Record<string, unknown>);
      } catch (error) {
        if (error instanceof RecoveryApplicationError && error.code === 'RECOVERY_ACTION_UNKNOWN') {
          return result({ error: { code: error.code, message: error.actionId } }, true);
        }
        throw error;
      }
    }
    case 'runtime_storage_repair_preview': {
      const repository = selected(ctx, args);
      return result(previewRuntimeStorageRepair(repository, ctx.controllerHome, {
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
      }) as unknown as Record<string, unknown>);
    }
    case 'runtime_storage_repair_apply': {
      const repository = selected(ctx, args);
      const candidateIds = Array.isArray(args.candidate_ids) ? args.candidate_ids.map(String) : undefined;
      const applied = applyRuntimeStorageRepair(repository, ctx.controllerHome, {
        candidateIds,
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        confirmRepair: args.confirm_repair === true,
      });
      const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
      const projection = readRepositoryProjectionSnapshot(ctx.controllerHome, repository.repoId);
      return result({ ...applied, runtimeStorage, projection });
    }
    default:
      return undefined;
  }
}
