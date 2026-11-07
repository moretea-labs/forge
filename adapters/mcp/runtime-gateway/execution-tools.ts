import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { currentControllerInstanceId, startExecutionSession, type ExecutionSessionContext } from '../../../src/runtime/control-plane/execution/session-store';
import { bindSessionRepository, currentPermissionSnapshotVersion } from '../../../src/runtime/control-plane/execution/session-repository-binding';
import { resolveAuthorizationRequest } from '../../../src/runtime/control-plane/governance/authorization';
import { readControllerResult, searchControllerResult } from '../../../src/runtime/evidence/result-store';
import { resumeExecutionJobAfterApproval } from '../../../src/runtime/execution/jobs/store';
import { principalFor, requireSession } from '../../../src/runtime/control-plane/execution/session-execution-support';

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], readOnlyHint = false, destructiveHint = false): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }, annotations: { readOnlyHint, openWorldHint: false, destructiveHint } };
}

const sessionId = { type: 'string', description: 'Controller-issued session id returned by session_start. Omit only when the MCP transport binds one.' };
const repoId = { type: 'string', description: 'Stable repository id. Repository switching must be explicit through session_bind_repository.' };

export const executionToolDefinitions: McpToolDefinition[] = [
  definition('session_start', 'Start or resume a controller-owned MCP execution session. Identity comes from the authenticated/controller-issued transport context.', {}, [], false),
  definition('session_bind_repository', 'Explicitly bind the current session to one registered repository and checkout.', { session_id: sessionId, repo_id: repoId, checkout_id: { type: 'string' } }, ['repo_id'], false),
  definition('approval_resolve', 'Resolve a controller approval request from the current conversation; GUI approval is optional and not required for continuation.', { session_id: sessionId, repo_id: repoId, approval_request_id: { type: 'string' }, confirm_authorization: { type: 'boolean' } }, ['approval_request_id', 'confirm_authorization'], false),
  definition('result_read', 'Read a session-scoped result reference with bounded pagination.', { session_id: sessionId, result_ref: { type: 'string' }, cursor: { type: 'number' }, limit: { type: 'number' } }, ['result_ref'], true),
  definition('result_search', 'Search a session-scoped result reference without returning the full payload.', { session_id: sessionId, result_ref: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, ['result_ref', 'query'], true),
];

const executionToolNames = new Set(executionToolDefinitions.map((tool) => tool.name));

/** No new execution operation is owned by WorkHandle. */
const DURABLE_WORK_OPERATION_NAMES = new Set<string>();

export function isDurableWorkOperation(name: string): boolean {
  return DURABLE_WORK_OPERATION_NAMES.has(name);
}

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'EXECUTION_TOOL_FAILED';
  return result({ error: { code, message } }, true);
}

export function startOrResumeSession(ctx: MultiRepositoryMcpToolContext): ExecutionSessionContext {
  return startExecutionSession(ctx.controllerHome, {
    sessionId: ctx.sessionId,
    principalId: principalFor(ctx),
    controllerInstanceId: ctx.controllerInstanceId ?? currentControllerInstanceId(),
    ...(ctx.explicitRepository ? { permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, ctx.explicitRepository.repoId) } : {}),
    capabilitySnapshotVersion: 1,
  });
}

export async function callExecutionTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  if (!executionToolNames.has(name)) return undefined;
  try {
    switch (name) {
      case 'session_start': {
        const session = startOrResumeSession(ctx);
        return result({ session: { sessionId: session.sessionId, principalId: session.principalId, activeRepositoryId: session.activeRepositoryId, activeCheckoutId: session.activeCheckoutId, permissionSnapshotVersion: session.permissionSnapshotVersion, capabilitySnapshotVersion: session.capabilitySnapshotVersion, controllerInstanceId: session.controllerInstanceId, createdAt: session.createdAt, updatedAt: session.updatedAt } });
      }
      case 'session_bind_repository': return result(bindSessionRepository(ctx, args));
      case 'approval_resolve': {
        const session = requireSession(ctx, args);
        const repositoryId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : session.activeRepositoryId;
        if (!repositoryId) throw new Error('SESSION_REPOSITORY_REQUIRED: bind a repository before resolving approval');
        const resolved = resolveAuthorizationRequest({
          controllerHome: ctx.controllerHome,
          repositoryId,
          approvalRequestId: String(args.approval_request_id ?? ''),
          sessionId: session.sessionId,
          principalId: session.principalId,
          permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repositoryId),
          confirm: args.confirm_authorization === true,
        });
        const resumed = resumeExecutionJobAfterApproval(ctx.controllerHome, repositoryId, resolved.approvalRequestId);
        return result({
          authorization: { decision: 'allow', source: 'user_confirmation', reason: 'User confirmation was recorded for the exact pending operation.' },
          approval: resolved,
          resumedJob: resumed ? { jobId: resumed.jobId, status: resumed.status, requestId: resumed.requestId } : undefined,
          continuation: resumed
            ? `The original durable Job ${resumed.jobId} was resumed with the resolved approval request.`
            : `Retry the original operation with approval_request_id=${resolved.approvalRequestId}.`,
        });
      }
      case 'result_read': {
        const session = requireSession(ctx, args);
        return result(readControllerResult({ controllerHome: ctx.controllerHome, resultRef: String(args.result_ref ?? ''), sessionId: session.sessionId, principalId: session.principalId, cursor: typeof args.cursor === 'number' ? args.cursor : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }));
      }
      case 'result_search': {
        const session = requireSession(ctx, args);
        return result(searchControllerResult({ controllerHome: ctx.controllerHome, resultRef: String(args.result_ref ?? ''), sessionId: session.sessionId, principalId: session.principalId, query: String(args.query ?? ''), limit: typeof args.limit === 'number' ? args.limit : undefined }));
      }
      default: return undefined;
    }
  } catch (error) {
    return failure(error);
  }
}
