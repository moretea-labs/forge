import {
  bindControllerSessionToCurrentRuntime,
  controllerSessionPrincipalId,
  getControllerRoundRelay,
  getControllerSession,
  mintControllerSessionAuthority,
  recoverControllerRoundRelayAuthority,
  type ControllerRoundRelayRecord,
  type ControllerSession,
  type ControllerType,
} from '../../../../packages/kernel/controller/api/index';
import { getWorkContract } from '../../../../packages/kernel/work/api/index';
import { currentPermissionSnapshotVersion } from './validation';
import { startExecutionSession, updateExecutionSession } from './session-store';

export interface DirectControllerAuthorityRecoveryIdentity {
  controllerId: string;
  controllerType: ControllerType;
  sessionId: string;
  principalId: string;
  controllerInstanceId: string;
}

export interface DirectControllerAuthorityRecoveryResult {
  session: ControllerSession;
  controllerAuthorityId: string;
  controllerAuthorityCarrier: 'controller_authority_id_or_session_id_compat';
  authorityRecovered: true;
}

/**
 * Rekey one direct (non-relay) Work Controller capability after transport loss.
 * This is an explicit user-directed recovery transaction, not ordinary claim
 * fallback. Durable Work/Controller ownership is preserved while only the
 * opaque capability digest and current transport binding rotate.
 */
export function recoverDirectControllerAuthority(input: {
  controllerHome: string;
  repoId: string;
  repositoryActiveCheckoutId?: string;
  workId: string;
  requestedBy?: string;
  identity: DirectControllerAuthorityRecoveryIdentity;
  runtime: { running?: boolean; runtimeInstanceId?: string };
  leaseMs?: number;
}): DirectControllerAuthorityRecoveryResult {
  const workId = input.workId.trim();
  if (!workId) throw new Error('WORK_CONTROLLER_AUTHORITY_RECOVERY_WORK_REQUIRED');
  if (input.requestedBy !== 'user') {
    throw new Error('WORK_CONTROLLER_AUTHORITY_RECOVERY_USER_REQUIRED: direct authority rekey is an explicit user-directed recovery only.');
  }
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const work = getWorkContract(store, workId);
  if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
  if (['completed', 'failed', 'cancelled'].includes(work.status)) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_TERMINAL: ${workId}:${work.status}`);
  }
  if (getControllerRoundRelay(store, workId)) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_CONFLICT: ${workId}; relay-bound Work must recover through its exact per-round authority.`);
  }
  const owner = getControllerSession(store, workId);
  if (!owner) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}`);
  if (owner.controllerId !== input.identity.controllerId) throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId} is owned by ${owner.controllerId}`);
  if (owner.controllerType !== input.identity.controllerType) throw new Error(`WORK_CONTROLLER_TYPE_MISMATCH: ${workId} is owned by ${owner.controllerType}`);
  if (controllerSessionPrincipalId(owner) !== input.identity.principalId) throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
  if (!input.runtime.running || !input.runtime.runtimeInstanceId || input.runtime.runtimeInstanceId !== input.identity.controllerInstanceId) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RUNTIME_REQUIRED: ${workId}; caller must be served by the live canonical Runtime.`);
  }

  // Validate and materialize the replacement transport binding before rotating
  // the durable Work-bound controller capability. An invalidated or otherwise
  // unusable ExecutionSession must fail with zero ControllerSession mutation;
  // recovery is not allowed to strand a Work behind a freshly rotated secret.
  const permissionSnapshotVersion = currentPermissionSnapshotVersion(input.controllerHome, input.repoId);
  const executionSession = startExecutionSession(input.controllerHome, {
    sessionId: input.identity.sessionId,
    principalId: input.identity.principalId,
    controllerInstanceId: input.identity.controllerInstanceId,
    permissionSnapshotVersion,
  });
  updateExecutionSession(input.controllerHome, {
    sessionId: executionSession.sessionId,
    principalId: executionSession.principalId,
    controllerInstanceId: executionSession.controllerInstanceId,
  }, {
    activeRepositoryId: input.repoId,
    activeCheckoutId: work.checkoutId || input.repositoryActiveCheckoutId,
    activeWorkId: work.workId,
    permissionSnapshotVersion,
    lastValidatedAt: new Date().toISOString(),
  });

  const authority = mintControllerSessionAuthority();
  const session = bindControllerSessionToCurrentRuntime(store, {
    workId,
    controllerId: input.identity.controllerId,
    controllerType: input.identity.controllerType,
    sessionId: executionSession.sessionId,
    authorityDigest: authority.authorityDigest,
    principalId: input.identity.principalId,
    controllerInstanceId: input.identity.controllerInstanceId,
    currentRuntimeInstanceId: input.runtime.runtimeInstanceId,
    leaseMs: input.leaseMs ?? 3_600_000,
  });
  return {
    session,
    controllerAuthorityId: authority.authorityId,
    controllerAuthorityCarrier: 'controller_authority_id_or_session_id_compat',
    authorityRecovered: true,
  };
}

export interface RelayControllerAuthorityRecoveryResult {
  relay: ControllerRoundRelayRecord;
  controllerAuthorityId: string;
  relayScopeId: string;
  controllerAuthorityCarrier: 'controller_authority_id_or_session_id_compat';
  authorityRecovered: true;
}

export type ControllerAuthorityRecoveryResult = DirectControllerAuthorityRecoveryResult | RelayControllerAuthorityRecoveryResult;

/** Select the canonical direct or relay recovery transaction for one exact Work. */
export function recoverControllerAuthority(input: {
  controllerHome: string;
  repoId: string;
  repositoryActiveCheckoutId?: string;
  workId: string;
  requestedBy?: string;
  identity: DirectControllerAuthorityRecoveryIdentity;
  runtime: { running?: boolean; runtimeInstanceId?: string };
  leaseMs?: number;
}): ControllerAuthorityRecoveryResult {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  if (!getControllerRoundRelay(store, input.workId.trim())) return recoverDirectControllerAuthority(input);
  if (!input.runtime.running || !input.runtime.runtimeInstanceId || input.runtime.runtimeInstanceId !== input.identity.controllerInstanceId) {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RUNTIME_REQUIRED: ${input.workId}; caller must be served by the live canonical Runtime.`);
  }
  const relay = recoverControllerRoundRelayAuthority(store, {
    workId: input.workId,
    requestedBy: input.requestedBy,
    identity: {
      controllerId: input.identity.controllerId,
      controllerType: input.identity.controllerType,
      principalId: input.identity.principalId,
      controllerInstanceId: input.identity.controllerInstanceId,
      sessionId: input.identity.sessionId,
    },
  });
  const controllerAuthorityId = relay.authorityId?.trim() || '';
  if (!controllerAuthorityId) throw new Error(`WORK_CONTROLLER_ROUND_AUTHORITY_REQUIRED: ${input.workId}`);
  return {
    relay,
    controllerAuthorityId,
    relayScopeId: relay.relayScopeId,
    controllerAuthorityCarrier: 'controller_authority_id_or_session_id_compat',
    authorityRecovered: true,
  };
}
