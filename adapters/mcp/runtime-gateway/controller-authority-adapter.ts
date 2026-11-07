import { randomUUID } from 'crypto';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { currentControllerInstanceId } from '../../../src/runtime/control-plane/execution/session-store';
import { observeRuntimeStatus } from '../../../src/runtime/root/status';

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

/**
 * Transport-scoped identity only. This never claims task, Work, lifecycle,
 * repository, provider-turn, or terminalization authority.
 */
export function authenticatedFacadeControllerIdentity(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
  options: { allowTransportSessionRollover?: boolean } = {},
): {
  controllerId: string;
  principalId: string;
  sessionId: string;
  transportSessionId?: string;
  controllerAuthorityId?: string;
  authorityViaSessionCompatibility?: boolean;
  controllerInstanceId: string;
  controllerType: 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human';
} {
  const principalId = ctx.principalId?.trim();
  const transportSessionId = ctx.sessionId?.trim();
  const requestedControllerId = typeof args.controller_id === 'string' ? args.controller_id.trim() : '';
  const requestedSessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  const requestedAuthorityId = typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '';
  if (!principalId) {
    if (!transportSessionId && !requestedSessionId) {
      throw new Error('CONTROLLER_AUTHENTICATED_SESSION_REQUIRED: reconnect or provide session_id through the authenticated MCP transport');
    }
    throw new Error('CONTROLLER_AUTHENTICATED_PRINCIPAL_REQUIRED: use an authenticated MCP transport');
  }

  const sessionId = transportSessionId || requestedSessionId || `mcp_request_${randomUUID().replace(/-/g, '')}`;
  const transportRolloverRequested = Boolean(
    transportSessionId
      && requestedSessionId
      && requestedSessionId !== transportSessionId,
  );
  if (transportRolloverRequested && options.allowTransportSessionRollover !== true) {
    throw new Error('CONTROLLER_TRANSPORT_SESSION_ROLLOVER_NOT_ALLOWED: this operation must use the current authenticated transport session');
  }

  const compatibilityAuthorityId = (!transportSessionId && requestedSessionId ? requestedSessionId : '')
    || (transportRolloverRequested ? requestedSessionId : '');
  const controllerAuthorityId = requestedAuthorityId || compatibilityAuthorityId;
  const authorityViaSessionCompatibility = !requestedAuthorityId && Boolean(compatibilityAuthorityId);
  if (requestedControllerId && requestedControllerId !== principalId) {
    throw new Error('CONTROLLER_ID_CONTEXT_MISMATCH: controller_id must match the authenticated principal');
  }
  const requestedControllerType = typeof args.controller_type === 'string'
    && ['chatgpt', 'codex', 'claude', 'grok', 'human'].includes(args.controller_type)
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
