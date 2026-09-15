import { randomUUID } from 'crypto';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  assertControllerInvocationAuthority,
  assertControllerRoundInvocationAuthority,
  bindControllerOwnershipForInvocation,
  controllerInvocationAuthorityMatches,
  controllerTerminalizationAuthorityForInvocation,
  terminalCleanupAuthorityForInvocation,
} from '../../../src/runtime/control-plane/execution/controller-authority-recovery';
import { currentControllerInstanceId } from '../../../src/runtime/control-plane/execution/session-store';
import { observeRuntimeStatus } from '../../../src/runtime/root/status';
import { chatgptControllerRoundRecoveryAuthorized } from '../../../src/runtime/root/controller-round-composition';
import {
  getControllerSession,
  type ControllerRoundRelayRecord,
  type ControllerTerminalizationAuthority,
} from '../../../packages/kernel/controller/api/index';

export interface RuntimeIdentitySnapshot {
  releaseId?: string;
  artifactIdentity?: string;
  runtimeCommit?: string;
  buildCommit?: string;
  startedAt?: string;
  runtimeInstanceId?: string;
  controllerInstanceId?: string;
  endpoint?: string;
  running?: boolean;
  ready?: boolean;
  reasonCodes?: string[];
  toolset?: string;
  profile?: string;
}

export function runtimeIdentitySnapshot(ctx: MultiRepositoryMcpToolContext): RuntimeIdentitySnapshot {
  const observation = observeRuntimeStatus(ctx.controllerHome);
  const snapshot = observation.snapshot;
  return {
    releaseId: snapshot?.releaseId,
    artifactIdentity: snapshot?.artifactIdentity,
    startedAt: snapshot?.startedAt,
    runtimeInstanceId: snapshot?.runtimeInstanceId,
    controllerInstanceId: snapshot?.runtimeInstanceId,
    endpoint: snapshot?.endpoint,
    running: observation.running,
    ready: observation.ready,
    reasonCodes: observation.reasonCodes,
    toolset: ctx.toolset,
    profile: ctx.policy.profile,
  };
}

export function authenticatedFacadeControllerIdentity(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
  _options: { allowTransportSessionRollover?: boolean } = {},
): { controllerId: string; principalId: string; sessionId: string; transportSessionId?: string; controllerAuthorityId?: string; authorityViaSessionCompatibility?: boolean; controllerInstanceId: string; controllerType: 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human' } {
  const principalId = ctx.principalId?.trim();
  const transportSessionId = ctx.sessionId?.trim();
  const requestedControllerId = typeof args.controller_id === 'string' ? args.controller_id.trim() : '';
  const requestedSessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  const requestedAuthorityId = typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '';
  if (!principalId) {
    // Preserve the bounded legacy stdio contract when no authenticated
    // transport identity exists at all. Modern MCP requests carry a principal
    // without a protocol session and reach the principal guard below; an
    // unauthenticated legacy request must not silently mint one.
    if (!transportSessionId && !requestedSessionId) {
      throw new Error('CONTROLLER_AUTHENTICATED_SESSION_REQUIRED: reconnect or provide session_id through the authenticated MCP transport');
    }
    throw new Error('CONTROLLER_AUTHENTICATED_PRINCIPAL_REQUIRED: use an authenticated MCP transport');
  }
  // Legacy MCP sessions remain replaceable transport bindings. Modern MCP has no
  // protocol session, so a fresh request-scoped execution binding is minted when
  // the caller does not provide an explicit compatibility carrier. Durable Work
  // authority is never derived from this request binding.
  const sessionId = transportSessionId || requestedSessionId || `mcp_request_${randomUUID().replace(/-/g, '')}`;
  const compatibilityAuthorityId = (!transportSessionId && requestedSessionId ? requestedSessionId : '')
    || (transportSessionId && requestedSessionId !== transportSessionId ? requestedSessionId : '');
  const controllerAuthorityId = requestedAuthorityId || compatibilityAuthorityId;
  const authorityViaSessionCompatibility = !requestedAuthorityId && Boolean(compatibilityAuthorityId);
  if (requestedControllerId && requestedControllerId !== principalId) {
    throw new Error('CONTROLLER_ID_CONTEXT_MISMATCH: controller_id must match the authenticated principal');
  }
  const requestedControllerType = typeof args.controller_type === 'string' && ['chatgpt', 'codex', 'claude', 'grok', 'human'].includes(args.controller_type)
    ? args.controller_type as 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human'
    : undefined;
  const transportControllerType = ctx.controllerType;
  if (transportControllerType && requestedControllerType && requestedControllerType !== transportControllerType) {
    throw new Error('CONTROLLER_TYPE_CONTEXT_MISMATCH: controller_type must match the authenticated transport provider');
  }
  return {
    controllerId: principalId,
    principalId,
    sessionId,
    ...(transportSessionId ? { transportSessionId } : {}),
    ...(controllerAuthorityId ? { controllerAuthorityId } : {}),
    ...(authorityViaSessionCompatibility ? { authorityViaSessionCompatibility: true } : {}),
    controllerType: transportControllerType ?? requestedControllerType ?? 'chatgpt',
    controllerInstanceId: ctx.controllerInstanceId?.trim() || currentControllerInstanceId(),
  };
}

export function dispatchedChatgptRelayAuthorizesStaleControllerRecovery(
  store: { controllerHome: string; repoId: string },
  workId: string,
  relay: ControllerRoundRelayRecord | undefined,
  controllerType: 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human',
): boolean {
  return controllerType === 'chatgpt' && chatgptControllerRoundRecoveryAuthorized(store, workId, relay);
}

export function assertFacadeControllerRoundAuthority(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  args: Record<string, unknown>,
): ControllerRoundRelayRecord | undefined {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return assertControllerRoundInvocationAuthority({
    ...store,
    workId,
    identity,
    relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
  });
}

export function sessionlessFacadeControllerAuthorityMatches(
  owner: NonNullable<ReturnType<typeof getControllerSession>> | undefined,
  identity: { transportSessionId?: string; controllerAuthorityId?: string },
): boolean {
  return controllerInvocationAuthorityMatches(owner, identity);
}

export function assertSessionlessFacadeControllerAuthority(
  owner: NonNullable<ReturnType<typeof getControllerSession>> | undefined,
  identity: { transportSessionId?: string; controllerAuthorityId?: string },
  workId: string,
): void {
  assertControllerInvocationAuthority(owner, identity, workId);
}

export function bindFacadeControllerOwnership(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  identity: ReturnType<typeof authenticatedFacadeControllerIdentity>,
  options: { allowClaimIfMissing?: boolean; leaseMs?: number; relayScopeId?: string } = {},
) {
  return bindControllerOwnershipForInvocation({
    ...store,
    workId,
    identity,
    relayScopeId: options.relayScopeId,
    runtime: runtimeIdentitySnapshot(ctx),
    allowClaimIfMissing: options.allowClaimIfMissing,
    leaseMs: options.leaseMs,
  });
}

export function currentFacadeTerminalizationAuthority(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  args: Record<string, unknown>,
): ControllerTerminalizationAuthority {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return controllerTerminalizationAuthorityForInvocation({
    ...store,
    workId,
    identity,
    relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
    runtime: runtimeIdentitySnapshot(ctx),
  });
}

export function currentTerminalCleanupAuthority(
  ctx: MultiRepositoryMcpToolContext,
  store: { controllerHome: string; repoId: string },
  workId: string,
  args: Record<string, unknown>,
): ControllerTerminalizationAuthority {
  const identity = authenticatedFacadeControllerIdentity(ctx, args);
  return terminalCleanupAuthorityForInvocation({
    ...store,
    workId,
    identity,
    relayScopeId: typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : undefined,
  });
}
