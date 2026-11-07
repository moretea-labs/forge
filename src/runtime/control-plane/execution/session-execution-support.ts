import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import {
  currentControllerInstanceId,
  requireExecutionSession,
  type ExecutionSessionContext,
  type SessionIdentity,
} from './session-store';

export function principalFor(ctx: McpExecutionContext): string {
  return ctx.principalId?.trim() || `controller-issued:${ctx.controllerInstanceId ?? currentControllerInstanceId()}`;
}

export function sessionIdentityFor(ctx: McpExecutionContext, args: Record<string, unknown>): SessionIdentity {
  return {
    sessionId: typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : ctx.sessionId,
    principalId: principalFor(ctx),
    controllerInstanceId: ctx.controllerInstanceId ?? currentControllerInstanceId(),
  };
}

export function requireSession(ctx: McpExecutionContext, args: Record<string, unknown>): ExecutionSessionContext {
  return requireExecutionSession(ctx.controllerHome, sessionIdentityFor(ctx, args));
}
