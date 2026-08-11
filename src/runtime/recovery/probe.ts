import { RECOVERY_ACTIONS } from './actions';
import { classifyFailure, dominantRecoveryClass } from './classifier';
import type {
  CapabilityRecoveryInput,
  CapabilityRecoverySnapshot,
  CapabilityState,
  CapabilityStatus,
  RecoveryActionDescriptor,
  RecoveryClass,
  RecoveryEvidence,
} from './types';
import type { ComponentHealth, RuntimeHealthEvaluation } from '../health';

const SCHEDULER_STALE_MS = 10_000;

function evidence(source: string, message: string, at: string, details?: Record<string, unknown>): RecoveryEvidence[] {
  return [{ source, message, at, details }];
}

function capability(
  at: string,
  id: string,
  label: string,
  state: CapabilityState,
  recoveryClass: RecoveryClass,
  reason: string,
  suggestedActions: RecoveryActionDescriptor[] = [],
  details?: Record<string, unknown>,
): CapabilityStatus {
  return { id, label, state, class: recoveryClass, reason, suggestedActions, evidence: evidence(id, reason, at, details) };
}

function dedupeActions(actions: RecoveryActionDescriptor[]): RecoveryActionDescriptor[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
}

function countStates(capabilities: CapabilityStatus[]): Record<CapabilityState, number> {
  return capabilities.reduce<Record<CapabilityState, number>>((counts, item) => {
    counts[item.state] += 1;
    return counts;
  }, { ready: 0, degraded: 0, blocked: 0, unavailable: 0, unknown: 0 });
}

function classifyRecentErrors(input: CapabilityRecoveryInput): RecoveryClass {
  return dominantRecoveryClass((input.recentErrors ?? []).map(classifyFailure));
}

function failingJobClass(input: CapabilityRecoveryInput): RecoveryClass {
  const messages = [
    ...(input.localJobs ?? []).flatMap((job) => job.error ? [job.error] : []),
    ...(input.executionJobs ?? []).flatMap((job) => job.error ? [typeof job.error === 'string' ? job.error : JSON.stringify(job.error)] : []),
  ];
  return dominantRecoveryClass(messages.map(classifyFailure));
}

function suggestedActionsForClass(recoveryClass: RecoveryClass): RecoveryActionDescriptor[] {
  if (recoveryClass === 'platform_blocked' || recoveryClass === 'dirty_worktree_conflict') return [RECOVERY_ACTIONS.createPatchHandoff];
  if (recoveryClass === 'auth_required') return [RECOVERY_ACTIONS.workspaceAuthLoginPrepare];
  if (recoveryClass === 'browser_domain_grant_required') return [RECOVERY_ACTIONS.browserDomainAccessPreview];
  if (recoveryClass === 'external_filesystem_grant_required') return [RECOVERY_ACTIONS.externalFilesystemGrantPreview];
  if (recoveryClass === 'agent_runtime_failure') return [RECOVERY_ACTIONS.reconcileJobs];
  if (recoveryClass === 'source_defect_suspected' || recoveryClass === 'external_lifecycle_required') return [];
  if (['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable', 'local_jobs_reconciliation_required', 'maintenance_executor_required'].includes(recoveryClass)) {
    return [RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
  }
  return [RECOVERY_ACTIONS.probeAgain];
}

function runtimeStorageClass(input: CapabilityRecoveryInput): RecoveryClass {
  return dominantRecoveryClass((input.runtimeStorageWarnings ?? []).map(classifyFailure));
}

function runtimeStorageActions(recoveryClass: RecoveryClass): RecoveryActionDescriptor[] {
  if (recoveryClass === 'local_jobs_unreadable') return [RECOVERY_ACTIONS.quarantineUnreadableLocalJobs, RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
  if (recoveryClass === 'local_jobs_legacy_active') return [RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
  if (recoveryClass === 'runtime_storage_not_ready') return [RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
  return [RECOVERY_ACTIONS.localJobsReconcile, RECOVERY_ACTIONS.finalizeRuntimeStorageRelocation];
}

function commandExecuteActions(recoveryClass: RecoveryClass): RecoveryActionDescriptor[] {
  if (['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable', 'local_jobs_reconciliation_required'].includes(recoveryClass)) {
    return runtimeStorageActions(recoveryClass);
  }
  return suggestedActionsForClass(recoveryClass);
}

function capabilityFromSharedHealth(
  at: string,
  id: string,
  label: string,
  componentHealth: ComponentHealth,
  recoveryClass: RecoveryClass,
  suggestedActions: RecoveryActionDescriptor[] = [],
): CapabilityStatus {
  const evidenceItem = componentHealth.activeBlockers[0] ?? componentHealth.warnings[0];
  if (!evidenceItem || componentHealth.state === 'disabled') {
    return capability(at, id, label, 'ready', 'unknown', componentHealth.state === 'disabled' ? `${label} is disabled by configuration.` : `${label} is healthy.`, [], {
      sharedHealthState: componentHealth.state,
    });
  }
  return capability(
    at,
    id,
    label,
    componentHealth.state === 'unavailable' ? 'unavailable' : componentHealth.ready ? 'ready' : 'degraded',
    recoveryClass,
    evidenceItem.message,
    componentHealth.ready ? [] : suggestedActions,
    { sharedHealthCode: evidenceItem.code, sharedHealthState: componentHealth.state, ...evidenceItem.details },
  );
}

export function buildCapabilityRecoverySnapshot(input: CapabilityRecoveryInput): CapabilityRecoverySnapshot {
  const at = input.generatedAt ?? new Date().toISOString();
  const capabilities: CapabilityStatus[] = [];
  const queueDepth = input.queueDepth ?? 0;
  const runningWorkers = input.runningWorkers ?? 0;
  const activeLeases = input.activeLeases ?? 0;
  const sharedHealth = input.runtimeHealth;
  if (sharedHealth) {
    capabilities.push(
      capabilityFromSharedHealth(at, 'forge.runtime', 'Forge Runtime', sharedHealth.components.daemon, 'external_lifecycle_required'),
      capabilityFromSharedHealth(at, 'durable.scheduler', 'Durable scheduler', sharedHealth.components.scheduler, 'stale_runtime_state', [RECOVERY_ACTIONS.reconcileJobs]),
      capabilityFromSharedHealth(at, 'worker.loop', 'Worker loop', sharedHealth.components.workers, 'stale_runtime_state', [RECOVERY_ACTIONS.reconcileJobs]),
      capabilityFromSharedHealth(at, 'local.bridge', 'Local bridge', sharedHealth.components.localBridge, 'local_recoverable', [RECOVERY_ACTIONS.probeAgain]),
      capabilityFromSharedHealth(at, 'runtime.projection', 'Runtime projection', sharedHealth.components.projection, 'stale_runtime_state', [RECOVERY_ACTIONS.rebuildProjection]),
      capabilityFromSharedHealth(at, 'runtime.storage', 'Runtime storage', sharedHealth.components.runtimeStorage, 'runtime_storage_not_ready', runtimeStorageActions('runtime_storage_not_ready')),
    );
  } else {
    const daemonReady = input.daemonStatus === undefined || input.daemonStatus === 'ready';
    capabilities.push(daemonReady
      ? capability(at, 'forge.runtime', 'Forge Runtime', 'ready', 'unknown', 'Forge Runtime is ready.', [], { status: input.daemonStatus ?? 'unknown' })
      : capability(at, 'forge.runtime', 'Forge Runtime', 'unavailable', 'external_lifecycle_required', `Forge Runtime is ${input.daemonStatus ?? 'unknown'}; lifecycle recovery belongs to the external owner of the existing single Runtime service.`, [], { status: input.daemonStatus, error: input.daemonError }));

    const schedulerAge = input.schedulerHeartbeatAgeMs;
    const schedulerStale = typeof schedulerAge === 'number' && schedulerAge > SCHEDULER_STALE_MS;
    capabilities.push(schedulerStale || input.schedulerStatus === 'degraded' || input.schedulerStatus === 'not_ready'
      ? capability(at, 'durable.scheduler', 'Durable scheduler', 'degraded', 'stale_runtime_state', 'Scheduler heartbeat is stale or degraded.', [RECOVERY_ACTIONS.reconcileJobs], { schedulerStatus: input.schedulerStatus, schedulerHeartbeatAgeMs: schedulerAge })
      : capability(at, 'durable.scheduler', 'Durable scheduler', 'ready', 'unknown', 'Scheduler heartbeat is healthy.', [], { schedulerStatus: input.schedulerStatus, schedulerHeartbeatAgeMs: schedulerAge }));

    const queueStalled = queueDepth > 0 && runningWorkers === 0;
    capabilities.push(queueStalled || activeLeases > 0 && runningWorkers === 0
      ? capability(at, 'worker.loop', 'Worker loop', 'degraded', 'stale_runtime_state', 'Queued work or leases may be stuck without active workers.', [RECOVERY_ACTIONS.reconcileJobs], { queueDepth, runningWorkers, activeLeases })
      : capability(at, 'worker.loop', 'Worker loop', 'ready', 'unknown', 'Worker loop has no stuck queue evidence.', [], { queueDepth, runningWorkers, activeLeases }));

    capabilities.push(input.localBridgeRunning === false
      ? capability(at, 'local.bridge', 'Local bridge', 'unavailable', 'local_recoverable', 'Local bridge is not running. Component restart recovery is not a supported Runtime action.', [RECOVERY_ACTIONS.probeAgain], { error: input.localBridgeError })
      : capability(at, 'local.bridge', 'Local bridge', 'ready', 'unknown', 'Local bridge is available.', [], { running: input.localBridgeRunning }));
  }

  capabilities.push(input.connectorHealthy === false
    ? capability(at, 'chatgpt.connector', 'ChatGPT connector', 'degraded', 'local_recoverable', 'Connector runtime state does not match the expected tool surface.', [RECOVERY_ACTIONS.probeAgain], { mismatch: input.connectorMismatch })
    : input.connectorHealthy === true
      ? capability(at, 'chatgpt.connector', 'ChatGPT connector', 'ready', 'unknown', 'Connector runtime state matches expected configuration.', [], { healthy: true })
      : capability(at, 'chatgpt.connector', 'ChatGPT connector', 'unknown', 'unknown', 'Connector schema has not been verified by live MCP discovery.', [RECOVERY_ACTIONS.probeAgain]));

  if (input.runtimeSourceCoherence) {
    const source = input.runtimeSourceCoherence;
    capabilities.push(source.ready
      ? capability(at, 'runtime.source_coherence', 'Runtime source coherence', 'ready', 'unknown', source.summary ?? 'Runtime source snapshot matches the current Runtime source.', [], { code: source.code, reasons: source.reasons ?? [] })
      : capability(at, 'runtime.source_coherence', 'Runtime source coherence', 'blocked', 'external_lifecycle_required', source.summary ?? 'Runtime source snapshot is missing or stale. The running Runtime cannot repair or restart its own lifecycle.', [], { code: source.code, reasons: source.reasons ?? [], lifecycleOwner: 'external_runtime_lifecycle' }));
  }

  if (!sharedHealth) {
    capabilities.push(input.runtimeProjectionStale === true || input.runtimeProjectionPersisted === false
      ? capability(at, 'runtime.projection', 'Runtime projection', 'degraded', 'stale_runtime_state', 'Runtime projection is stale or missing from persisted state.', [RECOVERY_ACTIONS.rebuildProjection], { stale: input.runtimeProjectionStale, persisted: input.runtimeProjectionPersisted })
      : capability(at, 'runtime.projection', 'Runtime projection', 'ready', 'unknown', 'Runtime projection is available.', [], { stale: input.runtimeProjectionStale, persisted: input.runtimeProjectionPersisted }));
  }

  capabilities.push(input.contextProjectionStale === true
    ? capability(at, 'context.projection', 'Context projection', 'degraded', 'stale_runtime_state', 'Controller context projection source identity is behind the current runtime projection.', [RECOVERY_ACTIONS.rebuildProjection], { stale: true, ageIsNotFailure: true })
    : capability(at, 'context.projection', 'Context projection', 'ready', 'unknown', 'Controller context projection is usable; cache age is not a health failure.', [], { stale: input.contextProjectionStale, ageIsNotFailure: true }));

  const storageClass = runtimeStorageClass(input);
  if (input.runtimeStorageReady === false || (input.runtimeStorageWarnings ?? []).length > 0) {
    const classifiedStorage = storageClass === 'unknown' ? 'runtime_storage_not_ready' : storageClass;
    capabilities.push(capability(
      at,
      'runtime.storage',
      'Runtime storage',
      'blocked',
      classifiedStorage,
      'Runtime storage is not ready; ordinary execution may be unable to create or dispatch Local Jobs.',
      runtimeStorageActions(classifiedStorage),
      { ready: input.runtimeStorageReady, warnings: input.runtimeStorageWarnings ?? [] },
    ));
  }

  capabilities.push(input.commandPreviewAvailable === false
    ? capability(at, 'tool.command_preview', 'Command preview', 'blocked', 'policy_denied', 'Command preview is blocked or unavailable.', [RECOVERY_ACTIONS.probeAgain])
    : capability(at, 'tool.command_preview', 'Command preview', 'ready', 'unknown', 'Command preview is available.'));

  const recentClass = classifyRecentErrors(input);
  capabilities.push(input.commandExecuteAvailable === false
    ? capability(
      at,
      'tool.command_execute',
      'Command execute',
      'blocked',
      recentClass === 'platform_blocked' ? 'platform_blocked' : recentClass === 'unknown' ? 'policy_denied' : recentClass,
      recentClass === 'platform_blocked'
        ? 'Command execute appears blocked before reaching forge. Do not restart-loop local services.'
        : ['runtime_storage_not_ready', 'local_jobs_legacy_active', 'local_jobs_unreadable', 'local_jobs_reconciliation_required'].includes(recentClass)
          ? 'Command execute is blocked by forge runtime storage; use the maintenance executor instead of repository_command_execute.'
          : 'Command execute is blocked, denied, or unavailable.',
      commandExecuteActions(recentClass),
    )
    : capability(at, 'tool.command_execute', 'Command execute', 'ready', 'unknown', 'Command execute is available.'));

  capabilities.push(input.issueToolsAvailable === false
    ? capability(at, 'tool.issue', 'Issue tools', 'blocked', recentClass, 'Issue tooling is blocked or unavailable.', suggestedActionsForClass(recentClass))
    : capability(at, 'tool.issue', 'Issue tools', 'ready', 'unknown', 'Issue tooling is available.'));

  capabilities.push(input.jobToolsAvailable === false
    ? capability(at, 'tool.jobs', 'Job tools', 'blocked', recentClass, 'Job tooling is blocked or unavailable.', suggestedActionsForClass(recentClass))
    : capability(at, 'tool.jobs', 'Job tools', 'ready', 'unknown', 'Job tooling is available.'));

  const jobClass = failingJobClass(input);
  if (jobClass !== 'unknown') {
    capabilities.push(capability(at, 'recent.failures', 'Recent failures', 'degraded', jobClass, `Recent job failures classify as ${jobClass}.`, suggestedActionsForClass(jobClass), { localJobs: input.localJobs?.length ?? 0, executionJobs: input.executionJobs?.length ?? 0 }));
  }

  for (const plugin of input.pluginStates ?? []) {
    const state = plugin.healthState ?? (plugin.ready ? 'ready' : plugin.enabled ? 'degraded' : 'disabled');
    if (plugin.enabled === false) {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'degraded', 'user_action_required', 'Plugin is disabled.', [], { state }));
    } else if (plugin.ready === true || state === 'ready') {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'ready', 'unknown', 'Plugin is ready.', [], { state }));
    } else if ((plugin.errors ?? []).some((error) => classifyFailure(error) === 'auth_required')) {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'degraded', 'auth_required', 'Plugin requires authorization or token refresh.', [RECOVERY_ACTIONS.workspaceAuthLoginPrepare], { state, errors: plugin.errors }));
    } else {
      capabilities.push(capability(at, `plugin.${plugin.pluginId}`, `${plugin.pluginId} plugin`, 'degraded', 'plugin_configuration_error', 'Plugin is enabled but not healthy.', [], { state, errors: plugin.errors, warnings: plugin.warnings }));
    }
  }

  if ((input.dirtyPaths ?? []).length > 0) {
    capabilities.push(capability(at, 'worktree.dirty_paths', 'Dirty path conflict guard', 'degraded', 'dirty_worktree_conflict', 'Main worktree has dirty paths. Integration must not overwrite them.', [], { dirtyPaths: input.dirtyPaths }));
  }

  capabilities.push(capability(at, 'assistant.monitor', 'Assistant monitor', 'ready', 'unknown', 'Assistant monitor data is available for the local GUI.', [], input.assistant));

  const states = countStates(capabilities);
  const recommendedActions = dedupeActions(capabilities.flatMap((item) => item.suggestedActions));
  const classes = capabilities.map((item) => item.class);
  const platformBlocked = classes.includes('platform_blocked');
  const topRisks = [...new Set(classes.filter((item) => item !== 'unknown'))].slice(0, 5);
  const overallState: CapabilityState = states.blocked > 0
    ? 'blocked'
    : states.unavailable > 0
      ? 'unavailable'
      : states.degraded > 0
        ? 'degraded'
        : 'ready';
  const externalLifecycleCapability = capabilities.find((item) => item.class === 'external_lifecycle_required' && item.state !== 'ready');
  const externalLifecycleHandoff = externalLifecycleCapability ? {
    owner: 'external_runtime_lifecycle' as const,
    target: 'forge-runtime' as const,
    reasonCode: input.runtimeSourceCoherence?.ready === false
      ? input.runtimeSourceCoherence.code ?? 'RUNTIME_SOURCE_COHERENCE_FAILED'
      : 'RUNTIME_LIFECYCLE_EXTERNAL_ACTION_REQUIRED',
    summary: externalLifecycleCapability.reason,
    requiredAction: 'restart_existing_single_runtime' as const,
    constraints: [
      'Operate on the existing single forge-runtime service only.',
      'Do not start a second Runtime, component Runtime, restart coordinator, or rollout slot.',
      'Do not mutate the source checkout as part of lifecycle recovery.',
      'The currently running Runtime must not attempt to own its own restart.',
    ],
    verification: [
      'The restarted Runtime publishes ready=true.',
      'A startup Runtime source snapshot exists under Controller Home.',
      'Runtime source coherence reports no drift against the current configured Runtime source.',
      'Runtime/release ownership evidence identifies one active Runtime.',
    ],
  } : undefined;

  return {
    schemaVersion: 1,
    generatedAt: at,
    overallState,
    fallbackRequired: platformBlocked || externalLifecycleHandoff !== undefined,
    platformBlocked,
    capabilities,
    recommendedActions,
    summary: {
      ready: states.ready,
      degraded: states.degraded,
      blocked: states.blocked,
      unavailable: states.unavailable,
      unknown: states.unknown,
      topRisks,
      nextBestAction: recommendedActions[0],
    },
    externalLifecycleHandoff,
    notes: externalLifecycleHandoff
      ? ['Runtime lifecycle action is required outside the running Runtime. Use the existing single forge-runtime service only; no rollout, second Runtime, component restart, or source mutation.']
      : platformBlocked
        ? ['One or more calls appear blocked before reaching forge. Use patch handoff or narrower typed tools; do not infer a local Runtime lifecycle failure.']
        : (input.runtimeStorageReady === false ? ['Runtime storage is not ready. Use runtime_maintenance_status/runtime_maintenance_apply; do not try to repair repository_command_execute with repository_command_execute.'] : []),
    runtimeHealth: sharedHealth,
    runtimeOperationalView: input.runtimeOperationalView,
  };
}
