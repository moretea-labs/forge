import type { RecoveryActionDescriptor } from './types';

export const RECOVERY_ACTIONS = {
  probeAgain: {
    id: 'recovery.probe_again',
    title: 'Run capability probe again',
    description: 'Run the read-only recovery probe again and compare evidence.',
    class: 'unknown',
    risk: 'readonly',
    confirmation: 'none',
    localOnly: true,
    boundedTo: [],
  },
  refreshRepository: {
    id: 'recovery.refresh_repository',
    title: 'Refresh repository metadata',
    description: 'Refresh registered repository and checkout metadata.',
    class: 'local_recoverable',
    risk: 'low',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['registered_repository'],
  },
  rebuildProjection: {
    id: 'recovery.rebuild_projection',
    title: 'Rebuild runtime projection',
    description: 'Rebuild materialized forge runtime projection from durable state.',
    class: 'stale_runtime_state',
    risk: 'low',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['forge_runtime_storage'],
  },
  localJobsReconcile: {
    id: 'recovery.local_jobs_reconcile',
    title: 'Reconcile Local Jobs',
    description: 'Terminalize stale active Local Jobs and rebuild the Local Bridge active index without invoking execute_command.',
    class: 'local_jobs_reconciliation_required',
    risk: 'low',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['forge_runtime_storage', 'local_jobs_metadata'],
  },
  quarantineUnreadableLocalJobs: {
    id: 'recovery.local_jobs_quarantine_unreadable',
    title: 'Quarantine unreadable Local Jobs',
    description: 'Move malformed or missing Local Job metadata into forge quarantine so runtime storage can continue safely.',
    class: 'local_jobs_unreadable',
    risk: 'low',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['forge_runtime_storage', 'local_jobs_quarantine'],
  },
  finalizeRuntimeStorageRelocation: {
    id: 'recovery.runtime_storage_finalize_relocation',
    title: 'Finalize runtime storage relocation',
    description: 'Retry forge runtime storage binding after bounded maintenance removes local metadata blockers.',
    class: 'runtime_storage_not_ready',
    risk: 'low',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['forge_runtime_storage'],
  },
  cleanupPreview: {
    id: 'recovery.cleanup_preview',
    title: 'Preview runtime cleanup',
    description: 'Preview stale forge temp dirs, terminal local jobs, and historical attention cleanup candidates.',
    class: 'local_recoverable',
    risk: 'readonly',
    confirmation: 'none',
    localOnly: true,
    boundedTo: ['forge_runtime_storage'],
  },
  cleanupApply: {
    id: 'recovery.cleanup_apply',
    title: 'Apply runtime cleanup',
    description: 'Apply safe forge runtime cleanup candidates after explicit authorization. Does not kill processes or touch source files.',
    class: 'local_recoverable',
    risk: 'medium',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['forge_runtime_storage', 'forge_temp_dirs'],
  },
  prepareRuntimeReleaseSession: {
    id: 'recovery.prepare_runtime_release_session',
    title: 'Prepare Runtime ReleaseSession',
    description: 'Ask standalone Recovery to freeze its configured source and Stable A authority and build one immutable release into the durable ReleaseSession.',
    class: 'stale_runtime_state',
    risk: 'medium',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['registered_repository', 'runtime_release_storage'],
  },
  restartPrimaryConnector: {
    id: 'recovery.restart_primary_connector',
    title: 'Restart primary Connector',
    description: 'Restart only the explicitly configured primary OAuth/Connector launchd service through standalone Recovery after local Canonical Runtime verification.',
    class: 'stale_runtime_state',
    risk: 'medium',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['primary_connector_service', 'external_runtime_lifecycle'],
  },
  createPatchHandoff: {
    id: 'recovery.create_patch_handoff',
    title: 'Create patch handoff',
    description: 'Create a safe patch handoff artifact when client-side tool calls are blocked.',
    class: 'platform_blocked',
    risk: 'medium',
    confirmation: 'authorization',
    localOnly: true,
    boundedTo: ['forge_artifact_storage'],
  },
  workspaceAuthLoginPrepare: {
    id: 'recovery.workspace_auth_login_prepare',
    title: 'Prepare Workspace auth login',
    description: 'Prepare a non-secret Gmail/Google Workspace login handoff when plugin auth is missing.',
    class: 'auth_required',
    risk: 'readonly',
    confirmation: 'none',
    localOnly: true,
    boundedTo: ['google_workspace_auth_handoff'],
  },
  externalFilesystemGrantPreview: {
    id: 'recovery.external_filesystem_grant_preview',
    title: 'Preview external filesystem grant',
    description: 'Preview a narrow external filesystem target grant instead of retrying absolute paths.',
    class: 'external_filesystem_grant_required',
    risk: 'readonly',
    confirmation: 'none',
    localOnly: true,
    boundedTo: ['external_filesystem_grants'],
  },
} satisfies Record<string, RecoveryActionDescriptor>;

/**
 * Deprecated wire alias. It resolves to the one canonical descriptor so an
 * older caller cannot acquire a second risk label, scope or mutation. The same
 * mapping applies to the confirmation token, so an in-flight caller is not
 * broken mid-authorization. New callers must use
 * `recovery.local_jobs_reconcile`.
 */
const RECOVERY_ACTION_ID_ALIASES: Readonly<Record<string, string>> = {
  'recovery.reconcile_jobs': 'recovery.local_jobs_reconcile',
};

export function canonicalRecoveryActionId(actionId: string): string {
  return RECOVERY_ACTION_ID_ALIASES[actionId] ?? actionId;
}

export function recoveryAuthorizationMatches(action: RecoveryActionDescriptor, authorization: string | undefined): boolean {
  if (!authorization) return false;
  return canonicalRecoveryActionId(authorization) === action.id;
}

export function recoveryActionById(actionId: string): RecoveryActionDescriptor | undefined {
  const canonicalId = canonicalRecoveryActionId(actionId);
  return Object.values(RECOVERY_ACTIONS).find((action) => action.id === canonicalId);
}
