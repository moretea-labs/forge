import {
  assertControllerOwnershipAuthority,
  bindControllerSessionToCurrentRuntime,
  controllerSessionAuthorityMatches,
  controllerSessionPrincipalId,
  getControllerRoundRelay,
  getControllerSession,
  mintControllerSessionAuthority,
  recoverControllerRoundRelayAuthority,
  type ControllerRoundRelayRecord,
  type ControllerSession,
  type ControllerTerminalizationAuthority,
  type ControllerType,
} from '../../../../packages/kernel/controller/api/index';
import { getWorkContract, semanticWorkState } from '../../../../packages/kernel/work/api/index';
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
  if (semanticWorkState(work) !== 'open') {
    throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_TERMINAL: ${workId}:${semanticWorkState(work)}`);
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
  recoveryReason?: string;
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
    recoveryReason: input.recoveryReason,
    allowCanonicalRuntimeMigration: true,
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

export interface ControllerInvocationIdentity extends DirectControllerAuthorityRecoveryIdentity {
  /** Present only when the transport itself supplied a protocol session. */
  transportSessionId?: string;
  /** Exact durable Work/ControllerRound capability after MCP-edge normalization. */
  controllerAuthorityId?: string;
  /** True only for the frozen-client session_id compatibility carrier. */
  authorityViaSessionCompatibility?: boolean;
}

export interface ControllerInvocationAuthorityContext {
  controllerHome: string;
  repoId: string;
  workId: string;
  identity: ControllerInvocationIdentity;
  /** Explicit relay grouping metadata from the current MCP request. */
  relayScopeId?: string;
}

/**
 * Durable Controller ownership matching. Transport presence is deliberately not
 * authority: modern sessionless MCP must present the exact Work-bound capability.
 */
export function controllerInvocationAuthorityMatches(
  owner: ControllerSession | undefined,
  identity: Pick<ControllerInvocationIdentity, 'transportSessionId' | 'controllerAuthorityId'>,
): boolean {
  if (!owner || identity.transportSessionId) return true;
  return controllerSessionAuthorityMatches(owner, identity.controllerAuthorityId);
}

export function assertControllerInvocationAuthority(
  owner: ControllerSession | undefined,
  identity: Pick<ControllerInvocationIdentity, 'transportSessionId' | 'controllerAuthorityId'>,
  workId: string,
): void {
  if (controllerInvocationAuthorityMatches(owner, identity)) return;
  throw new Error(`WORK_CONTROLLER_SCOPE_MISMATCH: ${workId}; sessionless MCP requests must present the exact Work-bound controller authority.`);
}

/** Canonical authority check for one exact ControllerRound invocation. */
export function assertControllerRoundInvocationAuthority(
  input: ControllerInvocationAuthorityContext,
): ControllerRoundRelayRecord | undefined {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const workId = input.workId.trim();
  const relay = getControllerRoundRelay(store, workId);
  if (!relay) return undefined;

  const expectedAuthorityId = relay.authorityId?.trim() || '';
  if (expectedAuthorityId) {
    const requestedAuthorityId = input.identity.controllerAuthorityId?.trim() || '';
    // relay_scope_id is grouping metadata, not the secret authority. Only the
    // frozen session_id compatibility carrier may inherit the scope from the
    // exact Work-selected relay. Explicit modern capability calls remain scoped.
    const requestedScopeId = input.relayScopeId?.trim()
      || (input.identity.authorityViaSessionCompatibility ? relay.relayScopeId : '');
    if (!requestedScopeId || requestedScopeId !== relay.relayScopeId) {
      throw new Error(`WORK_CONTROLLER_RELAY_SCOPE_MISMATCH: ${workId}:expected=${relay.relayScopeId}`);
    }
    if (!requestedAuthorityId) throw new Error(`WORK_CONTROLLER_ROUND_AUTHORITY_REQUIRED: ${workId}`);
    if (requestedAuthorityId !== expectedAuthorityId) {
      throw new Error(`WORK_CONTROLLER_ROUND_AUTHORITY_MISMATCH: ${workId}`);
    }
    return relay;
  }

  // Pre-capability relay records preserve only their already-claimed durable
  // epoch. They may not be rebound by shared principal identity.
  const owner = getControllerSession(store, workId);
  if (
    owner
    && owner.sessionId === input.identity.sessionId
    && controllerSessionPrincipalId(owner) === input.identity.principalId
    && (owner.controllerInstanceId?.trim() || '') === input.identity.controllerInstanceId
  ) return relay;
  throw new Error(`WORK_CONTROLLER_ROUND_AUTHORITY_UPGRADE_REQUIRED: ${workId}`);
}

/**
 * Validate the one durable authority that owns this invocation before changing
 * only its observed transport/runtime binding. ControllerRound relay authority
 * supersedes the replaceable Work-session transport binding for relay-bound
 * lifecycle calls; ordinary Work keeps its Work-bound controller capability.
 */
function assertControllerLifecycleInvocationAuthority(
  input: ControllerInvocationAuthorityContext,
  owner: ControllerSession | undefined,
): ControllerRoundRelayRecord | undefined {
  const relay = getControllerRoundRelay(
    { controllerHome: input.controllerHome, repoId: input.repoId },
    input.workId.trim(),
  );
  if (relay) return assertControllerRoundInvocationAuthority(input);
  assertControllerInvocationAuthority(owner, input.identity, input.workId.trim());
  return undefined;
}

/**
 * Modern sessionless MCP replaces its request binding on every call. For a
 * direct Work, omission of an opaque capability is not a semantic ownership
 * change when the exact Work, authenticated controller/principal/type and live
 * canonical Runtime still agree. Relay-bound rounds remain capability-scoped,
 * and an explicitly supplied wrong capability never uses this path.
 */
export function controllerInvocationCanMechanicallyRebindDirectOwnership(
  input: ControllerInvocationAuthorityContext & { runtime: { running?: boolean; runtimeInstanceId?: string } },
  owner: ControllerSession | undefined = getControllerSession(
    { controllerHome: input.controllerHome, repoId: input.repoId },
    input.workId.trim(),
  ),
): boolean {
  const workId = input.workId.trim();
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  if (!owner || getControllerRoundRelay(store, workId)) return false;
  if (input.identity.transportSessionId || input.identity.controllerAuthorityId) return false;
  if (owner.controllerId !== input.identity.controllerId || owner.controllerType !== input.identity.controllerType) return false;
  if (controllerSessionPrincipalId(owner) !== input.identity.principalId) return false;
  const requestedInstanceId = input.identity.controllerInstanceId.trim();
  const canonicalRuntimeInstanceId = input.runtime.running ? input.runtime.runtimeInstanceId?.trim() || '' : '';
  return Boolean(requestedInstanceId && canonicalRuntimeInstanceId === requestedInstanceId);
}

/** Bind one exact Work owner to the current transport/runtime without changing semantic ownership. */
export function bindControllerOwnershipForInvocation(input: ControllerInvocationAuthorityContext & {
  runtime: { running?: boolean; runtimeInstanceId?: string };
  allowClaimIfMissing?: boolean;
  leaseMs?: number;
}): ControllerSession {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const workId = input.workId.trim();
  const existingOwner = getControllerSession(store, workId);
  if (!controllerInvocationCanMechanicallyRebindDirectOwnership(input, existingOwner)) {
    assertControllerLifecycleInvocationAuthority(input, existingOwner);
  }
  return bindControllerSessionToCurrentRuntime(store, {
    workId,
    controllerId: input.identity.controllerId,
    controllerType: input.identity.controllerType,
    sessionId: input.identity.sessionId,
    principalId: input.identity.principalId,
    controllerInstanceId: input.identity.controllerInstanceId,
    currentRuntimeInstanceId: input.runtime.running ? input.runtime.runtimeInstanceId : undefined,
    allowClaimIfMissing: input.allowClaimIfMissing,
    leaseMs: input.leaseMs ?? 3_600_000,
  });
}

/** Resolve the sole canonical authority allowed to semantically terminalize a Work. */
export function controllerTerminalizationAuthorityForInvocation(input: ControllerInvocationAuthorityContext & {
  runtime: { running?: boolean; runtimeInstanceId?: string };
}): ControllerTerminalizationAuthority {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const workId = input.workId.trim();
  let owner = getControllerSession(store, workId);
  if (!owner) {
    throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}; terminalization requires an explicit controller_claim for this exact Work.`);
  }
  if (owner.controllerId !== input.identity.controllerId) {
    throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId} is owned by ${owner.controllerId}`);
  }
  if (owner.controllerType !== input.identity.controllerType) {
    throw new Error(`WORK_CONTROLLER_TYPE_MISMATCH: ${workId} is owned by ${owner.controllerType}`);
  }
  if (controllerSessionPrincipalId(owner) !== input.identity.principalId) {
    throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
  }
  const ownerInstanceId = owner.controllerInstanceId?.trim() || '';
  if (!ownerInstanceId) throw new Error(`WORK_CONTROLLER_INSTANCE_MISMATCH: ${workId}`);

  if (ownerInstanceId !== input.identity.controllerInstanceId || owner.sessionId !== input.identity.sessionId) {
    if (getControllerRoundRelay(store, workId)) {
      assertControllerRoundInvocationAuthority(input);
    } else if (
      input.identity.controllerAuthorityId
      && !controllerSessionAuthorityMatches(owner, input.identity.controllerAuthorityId)
    ) {
      throw new Error(`WORK_CONTROLLER_SCOPE_MISMATCH: ${workId}; explicit Work-bound controller authority does not match.`);
    }
    owner = bindControllerOwnershipForInvocation({ ...input, runtime: input.runtime });
  }
  if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
    throw new Error(`WORK_CONTROLLER_CLAIM_GENERATION_REQUIRED: ${workId}`);
  }
  return {
    controllerId: owner.controllerId,
    controllerType: owner.controllerType,
    principalId: controllerSessionPrincipalId(owner),
    controllerInstanceId: owner.controllerInstanceId?.trim() || '',
    claimGeneration: owner.claimGeneration,
  };
}

/** Resolve authority for physical cleanup of an already-terminal Work. */
export function terminalCleanupAuthorityForInvocation(
  input: ControllerInvocationAuthorityContext,
): ControllerTerminalizationAuthority {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const workId = input.workId.trim();
  const owner = getControllerSession(store, workId);
  if (!owner) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}`);
  const relay = assertControllerLifecycleInvocationAuthority(input, owner);
  const authority = assertControllerOwnershipAuthority(owner, {
    workId,
    controllerId: input.identity.controllerId,
    controllerType: input.identity.controllerType,
    principalId: input.identity.principalId,
    controllerInstanceId: input.identity.controllerInstanceId,
  });
  if (!relay && input.identity.controllerAuthorityId
    && !controllerSessionAuthorityMatches(owner, input.identity.controllerAuthorityId)) {
    throw new Error(`WORK_CONTROLLER_SCOPE_MISMATCH: ${workId}; explicit Work-bound controller authority does not match.`);
  }
  return authority;
}
