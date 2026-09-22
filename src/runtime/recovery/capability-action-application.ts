import type { RepositoryRecord } from '../../cli/repositories/types';
import { ensureRepositoryRuntimeStorage } from '../../cli/repositories/runtime-storage';
import { prepareTransferArtifacts } from '../../cli/repositories/selected-path-actions';
import { applyRuntimeCleanup, previewRuntimeCleanup } from '../maintenance/cleanup';
import { rebuildRepositoryProjection } from '../projections/materialized-view';
import { recoveryActionById } from './actions';
import { assertRecoveryAuthorized, buildRecoveryAuditRecord } from './audit';
import { applyRuntimeMaintenance } from './maintenance-executor';
import { writeRecoveryAuditRecord } from './store';

export interface CapabilityRecoveryApplicationInput {
  controllerHome: string;
  repository: RepositoryRecord;
  actionId: string;
  reason: string;
  confirmAuthorization: boolean;
  authorization?: string;
  minAgeMinutes?: number;
  maxCandidates?: number;
  callStandaloneRecoveryTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  recoverySnapshot: () => Promise<Record<string, unknown>>;
}

export interface CapabilityRecoveryApplicationResult {
  repoId: string;
  action: NonNullable<ReturnType<typeof recoveryActionById>>;
  audit: ReturnType<typeof writeRecoveryAuditRecord>;
  result: Record<string, unknown>;
}

export class RecoveryApplicationError extends Error {
  readonly code: 'RECOVERY_ACTION_UNKNOWN';
  readonly actionId: string;

  constructor(code: 'RECOVERY_ACTION_UNKNOWN', actionId: string) {
    super(`${code}: ${actionId}`);
    this.name = 'RecoveryApplicationError';
    this.code = code;
    this.actionId = actionId;
  }
}


export function executeRuntimeMaintenanceAction(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  actionId: Parameters<typeof applyRuntimeMaintenance>[2]['actionId'];
  confirmMaintenance: boolean;
  authorization?: string;
  minAgeMinutes?: number;
  maxCandidates?: number;
  cancelPendingApprovals?: boolean;
}) {
  if (!input.actionId) throw new Error('RUNTIME_MAINTENANCE_ACTION_REQUIRED');
  if (!input.confirmMaintenance || input.authorization !== input.actionId) {
    throw new Error('RUNTIME_MAINTENANCE_AUTHORIZATION_REQUIRED: confirm_maintenance=true and authorization must match action_id.');
  }
  return applyRuntimeMaintenance(input.repository, input.controllerHome, {
    actionId: input.actionId,
    confirmMaintenance: true,
    minAgeMinutes: input.minAgeMinutes,
    maxCandidates: input.maxCandidates,
    cancelPendingApprovals: input.cancelPendingApprovals,
  });
}

/**
 * Canonical Recovery application boundary.
 *
 * Transport adapters may translate fields and render this result, but action
 * selection, authorization, mutation choice, and audit attribution live here.
 */
export async function executeCapabilityRecoveryAction(
  input: CapabilityRecoveryApplicationInput,
): Promise<CapabilityRecoveryApplicationResult> {
  const action = recoveryActionById(input.actionId);
  if (!action) throw new RecoveryApplicationError('RECOVERY_ACTION_UNKNOWN', input.actionId);
  assertRecoveryAuthorized(
    action,
    action.confirmation === 'none'
      ? action.id
      : input.confirmAuthorization
        ? input.authorization
        : undefined,
  );

  let payload: Record<string, unknown>;
  let affectedPaths: string[] = [];
  switch (action.id) {
    case 'recovery.stage_and_activate_runtime_release': {
      payload = await input.callStandaloneRecoveryTool('prepare_runtime_release_session', {
        request_id: `runtime-release-session-${Date.now()}`,
      });
      affectedPaths = ['controllerHome/recovery/state/release-sessions', 'candidate-runtime-lanes'];
      break;
    }
    case 'recovery.restart_primary_connector': {
      payload = await input.callStandaloneRecoveryTool('restart_primary_connector', {
        request_id: `connector-restart-${Date.now()}`,
      });
      affectedPaths = ['controllerHome/recovery/audit'];
      break;
    }
    case 'recovery.probe_again':
      payload = { recovery: await input.recoverySnapshot() };
      break;
    case 'recovery.rebuild_projection': {
      const projection = rebuildRepositoryProjection(input.controllerHome, input.repository.repoId);
      payload = { projection };
      affectedPaths = ['.ai/harness/controller/projections'];
      break;
    }
    case 'recovery.refresh_repository': {
      const runtimeStorage = ensureRepositoryRuntimeStorage(input.repository, input.controllerHome);
      const projection = rebuildRepositoryProjection(input.controllerHome, input.repository.repoId);
      payload = { runtimeStorage, projection };
      affectedPaths = ['.ai/harness/controller', '.ai/harness/local-bridge'];
      break;
    }
    case 'recovery.cleanup_preview': {
      payload = previewRuntimeCleanup(input.repository.canonicalRoot, {
        minAgeMinutes: input.minAgeMinutes,
        includeTempDirs: true,
        includeTerminalLocalJobs: true,
        includeLegacyRuns: true,
        includeHistoricalAttention: true,
        maxCandidates: input.maxCandidates,
      }) as unknown as Record<string, unknown>;
      break;
    }
    case 'recovery.cleanup_apply': {
      payload = applyRuntimeCleanup(input.repository.canonicalRoot, {
        minAgeMinutes: input.minAgeMinutes,
        includeTempDirs: true,
        includeTerminalLocalJobs: true,
        includeLegacyRuns: true,
        includeHistoricalAttention: true,
        maxCandidates: input.maxCandidates,
        confirmCleanup: true,
      }) as unknown as Record<string, unknown>;
      affectedPaths = ['.ai/harness/local-jobs-archive', '.ai/harness/jobs-archive', '.ai/harness/controller/acknowledged-attention.jsonl'];
      break;
    }
    case 'recovery.reconcile_jobs':
    case 'recovery.local_jobs_reconcile': {
      const maintenance = applyRuntimeMaintenance(input.repository, input.controllerHome, {
        actionId: 'local_jobs_reconcile',
        confirmMaintenance: true,
        minAgeMinutes: input.minAgeMinutes ?? 10,
        maxCandidates: input.maxCandidates,
      });
      payload = { maintenance };
      affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/local-jobs-quarantine', '.ai/harness/controller'];
      break;
    }
    case 'recovery.local_jobs_quarantine_unreadable': {
      const maintenance = applyRuntimeMaintenance(input.repository, input.controllerHome, {
        actionId: 'quarantine_unreadable_local_jobs',
        confirmMaintenance: true,
        minAgeMinutes: input.minAgeMinutes ?? 0,
        maxCandidates: input.maxCandidates,
      });
      payload = { maintenance };
      affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/local-jobs-quarantine'];
      break;
    }
    case 'recovery.runtime_storage_finalize_relocation': {
      const maintenance = applyRuntimeMaintenance(input.repository, input.controllerHome, {
        actionId: 'runtime_storage_finalize_relocation',
        confirmMaintenance: true,
        minAgeMinutes: input.minAgeMinutes ?? 0,
        maxCandidates: input.maxCandidates,
      });
      payload = { maintenance };
      affectedPaths = ['.ai/harness/local-jobs', '.ai/harness/controller'];
      break;
    }
    case 'recovery.create_patch_handoff':
      payload = prepareTransferArtifacts(input.repository, { reason: input.reason }) as unknown as Record<string, unknown>;
      affectedPaths = ['.ai/harness/transfers', '.ai/harness/session'];
      break;
    case 'recovery.workspace_auth_login_prepare':
      payload = {
        skipped: true,
        nextTool: 'workspace_auth_login_prepare',
        reason: 'Auth login is a non-secret handoff and should be prepared through the dedicated typed tool.',
      };
      break;
    case 'recovery.external_filesystem_grant_preview':
      payload = {
        skipped: true,
        nextTool: 'external_filesystem_grant_preview',
        reason: 'External filesystem access must be converted into a named read-only target first.',
      };
      break;
    default:
      payload = { skipped: true, reason: `No executor is registered for ${action.id}.` };
  }

  const audit = writeRecoveryAuditRecord(
    input.controllerHome,
    input.repository.repoId,
    buildRecoveryAuditRecord({
      actor: 'capability_recovery_apply',
      action,
      result: payload.skipped === true ? 'skipped' : 'succeeded',
      reason: input.reason,
      affectedPaths,
    }),
  );
  return { repoId: input.repository.repoId, action, audit, result: payload };
}
