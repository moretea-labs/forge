import { existsSync, readFileSync } from 'fs';
import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { repositoryGitWorkspaceChanges } from '../../../src/cli/repositories/structured-git';
import { listControllerChecks } from '../../../src/cli/controller/check-runner';
import { buildWorkContinuationSnapshot } from '../../../src/runtime/control-plane/facade/work-continuation';
import { currentControllerInstanceId, startExecutionSession, type ExecutionSessionContext } from '../../../src/runtime/control-plane/execution/session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle } from '../../../src/runtime/control-plane/execution/validation';
import { resolveAuthorizationRequest } from '../../../src/runtime/control-plane/governance/authorization';
import { readControllerResult, searchControllerResult } from '../../../src/runtime/evidence/result-store';
import { resumeExecutionJobAfterApproval } from '../../../src/runtime/execution/jobs/store';
import { recordMcpTiming, type McpTimingTrace } from '../../../src/runtime/diagnostics/mcp-timing';
import { compactHandle, contractFor, findWorkHandle, identityFor, makeBoundedWorkResult, principalFor, requireSession } from '../../../src/runtime/control-plane/execution/work-execution-support';
import { bindSessionRepository, prepareWork } from '../../../src/runtime/control-plane/execution/work-preparation-service';
import { validateWork } from '../../../src/runtime/control-plane/execution/work-operation-service';

export { selectDefaultWorkValidationChecks } from '../../../src/runtime/control-plane/execution/work-operation-service';

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], readOnlyHint = false, destructiveHint = false): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }, annotations: { readOnlyHint, openWorldHint: false, destructiveHint } };
}

const sessionId = { type: 'string', description: 'Controller-issued session id returned by session_start. Omit only when the MCP transport binds one.' };
const workId = { type: 'string', description: 'Controller-owned work handle id returned by work_prepare.' };
const repoId = { type: 'string', description: 'Stable repository id. Repository switching must be explicit through session_bind_repository.' };

export const executionToolDefinitions: McpToolDefinition[] = [
  definition('session_start', 'Start or resume a controller-owned MCP execution session. Identity comes from the authenticated/controller-issued transport context.', {}, [], false),
  definition('session_bind_repository', 'Explicitly bind the current session to one registered repository and checkout.', { session_id: sessionId, repo_id: repoId, checkout_id: { type: 'string' } }, ['repo_id'], false),
  definition('work_prepare', 'Prepare or reuse one controller-owned work handle and bind it to a WorkContract, checkout, branch, and permission snapshot.', {
    session_id: sessionId, repo_id: repoId, checkout_id: { type: 'string' }, work_id: workId,
    objective: { type: 'string' }, goal_id: { type: 'string' }, acceptance_criteria: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'string' } },
    isolation: { type: 'string', enum: ['reuse', 'new_worktree', 'auto'] }, base_ref: { type: 'string' }, needs_dependencies: { type: 'boolean' },
    expected_previous_head: { type: 'string', description: 'Exact prior WorkHandle HEAD for direct successor adoption. Cleaned-open Work recovery derives it from the stored handle; if supplied there, it must match.' },
    adopt_candidate_head: { type: 'string', description: 'Explicit current successor commit to adopt after exact identity, ownership, cleanliness, and ancestry validation.' },
    dirty_overlap_proofs: { type: 'array', maxItems: 20, description: 'Explicit attested content fingerprints for every overlapping unstaged tracked file; metadata-only successor adoption preserves files and index unchanged.', items: { type: 'object', properties: { path: { type: 'string' }, worktree_sha256: { type: 'string' }, index_blob_oid: { type: 'string' } }, required: ['path', 'worktree_sha256', 'index_blob_oid'], additionalProperties: false } },
    relocate_to_new_worktree: { type: 'boolean', description: 'Move this existing Work identity to its own managed worktree, with exact previous/candidate HEADs and base_ref. WorkHandle and WorkContract placement commit atomically; the source checkout is not mutated.' },
  }, [], false),
  definition('work_inspect', 'Collect bounded Git, WorkContract, changed-path, check, and readiness evidence through one work handle.', { session_id: sessionId, repo_id: repoId, work_id: workId, detail: { type: 'string', enum: ['summary', 'detail'] } }, ['work_id'], true),
  definition('work_validate', 'Run targeted checks or read-only validation commands against a work handle with full current-state validation.', {
    session_id: sessionId, controller_id: { type: 'string', description: 'Controller identity that holds the Work lease. Defaults to the authenticated principal.' }, repo_id: repoId, work_id: workId, check_ids: { type: 'array', items: { type: 'string' } }, commands: { type: 'array', items: { type: 'object' } }, interactive_wait_ms: { type: 'number', description: 'Optional bounded attach window for checks launched by this validation call. Defaults to asynchronous behavior.' },
  }, ['work_id'], false),
  definition('approval_resolve', 'Resolve a controller approval request from the current conversation; GUI approval is optional and not required for continuation.', { session_id: sessionId, repo_id: repoId, work_id: workId, approval_request_id: { type: 'string' }, confirm_authorization: { type: 'boolean' } }, ['approval_request_id', 'confirm_authorization'], false),
  definition('result_read', 'Read a session-scoped result reference with bounded pagination.', { session_id: sessionId, result_ref: { type: 'string' }, work_id: workId, cursor: { type: 'number' }, limit: { type: 'number' } }, ['result_ref'], true),
  definition('result_search', 'Search a session-scoped result reference without returning the full payload.', { session_id: sessionId, result_ref: { type: 'string' }, work_id: workId, query: { type: 'string' }, limit: { type: 'number' } }, ['result_ref', 'query'], true),
];

const executionToolNames = new Set(executionToolDefinitions.map((tool) => tool.name));

/** Repository execution and validation remain Process/WorkHandle operations; semantic Work completion is separate. */
const DURABLE_WORK_OPERATION_NAMES = new Set([
  'work_validate',
]);

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
  const permissionVersion = ctx.explicitRepository ? currentPermissionSnapshotVersion(ctx.controllerHome, ctx.explicitRepository.repoId) : 0;
  return startExecutionSession(ctx.controllerHome, {
    sessionId: ctx.sessionId,
    principalId: principalFor(ctx),
    controllerInstanceId: ctx.controllerInstanceId ?? currentControllerInstanceId(),
    permissionSnapshotVersion: permissionVersion,
    capabilitySnapshotVersion: 1,
  });
}

function inspectWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  // Inspect the exact WorkHandle without rebinding its controller identity,
  // reconciling validation, or changing the session's active execution focus.
  // validateWorkHandle below enforces the authenticated principal and fences.
  const handle = findWorkHandle(ctx, session, args);
  const started = performance.now();
  const validationStarted = performance.now();
  const validated = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'cheap', 'inspect');
  const validationMs = performance.now() - validationStarted;
  const contract = contractFor(ctx, handle);
  if (validated.placementLoss) {
    // The checkout is gone, but the canonical Work is not. Report semantic
    // state and the exact mechanical recovery action; never invent Git state.
    const value = {
      session: { sessionId: session.sessionId, repoId: session.activeRepositoryId, checkoutId: session.activeCheckoutId },
      work: compactHandle(handle),
      readiness: {
        valid: false,
        placement: {
          state: 'lost' as const,
          reason: validated.placementLoss,
          checkoutId: handle.checkoutId,
          worktreePath: handle.worktreePath,
          recovery: { operation: 'work_prepare', workId: handle.workId, requires: 'exact recorded head plus a landed candidate revision' },
        },
        warnings: validated.warnings,
        permissionSnapshotVersion: handle.permissionSnapshotVersion,
      },
      workContract: contract ? {
        workId: contract.workId,
        state: contract.semanticState,
        objective: contract.objective,
        checks: contract.checks,
        acceptanceCriteria: contract.acceptanceCriteria,
        semantics: buildWorkContinuationSnapshot(contract).semantics,
      } : undefined,
      continuation: contract ? buildWorkContinuationSnapshot(contract) : undefined,
    };
    const response = makeBoundedWorkResult(ctx, session, handle.repositoryId, handle.workId, 'inspection', value);
    const trace: McpTimingTrace = { tool: 'work_inspect', sessionResolutionMs: 0, repositoryResolutionMs: 0, workHandleValidationMs: Math.round(validationMs * 100) / 100, resultSerializationMs: 0, totalToolDurationMs: Math.round((performance.now() - started) * 100) / 100, sessionId: session.sessionId, repoId: handle.repositoryId, workId: handle.workId };
    recordMcpTiming(ctx.controllerHome, trace);
    return response;
  }
  const candidate = repositoryGitWorkspaceChanges(validated.worktreeRepository);
  const { status, diff } = candidate;
  const checks = contract?.checks ?? [];
  const packageManifest = existsSync(`${validated.worktreeRepository.canonicalRoot}/package.json`)
    ? JSON.parse(readFileSync(`${validated.worktreeRepository.canonicalRoot}/package.json`, 'utf-8')) as Record<string, unknown>
    : undefined;
  const value = {
    session: { sessionId: session.sessionId, repoId: session.activeRepositoryId, checkoutId: session.activeCheckoutId },
    work: compactHandle(handle),
    readiness: { valid: true, warnings: validated.warnings, permissionSnapshotVersion: handle.permissionSnapshotVersion },
    git: { status, diff: { ...diff, staged: { nameOnly: candidate.staged.nameOnly, stat: candidate.staged.stat, truncated: candidate.staged.truncated }, unstaged: { nameOnly: candidate.unstaged.nameOnly, stat: candidate.unstaged.stat, truncated: candidate.unstaged.truncated }, untracked: status.untracked } },
    workContract: contract ? {
      workId: contract.workId,
      state: contract.semanticState,
      objective: contract.objective,
      checks: contract.checks,
      acceptanceCriteria: contract.acceptanceCriteria,
      semantics: buildWorkContinuationSnapshot(contract).semantics,
    } : undefined,
    continuation: contract ? buildWorkContinuationSnapshot(contract) : undefined,
    paths: { changed: candidate.changedPaths },
    checks: checks.map((checkId) => ({ checkId, registered: listControllerChecks(validated.worktreeRepository.canonicalRoot).some((check) => check.id === checkId) })),
    package: packageManifest ? { name: packageManifest.name, scripts: packageManifest.scripts } : undefined,
  };
  const response = makeBoundedWorkResult(ctx, session, handle.repositoryId, handle.workId, 'inspection', value);
  const trace: McpTimingTrace = { tool: 'work_inspect', sessionResolutionMs: 0, repositoryResolutionMs: 0, workHandleValidationMs: Math.round(validationMs * 100) / 100, resultSerializationMs: 0, totalToolDurationMs: Math.round((performance.now() - started) * 100) / 100, sessionId: session.sessionId, repoId: handle.repositoryId, workId: handle.workId };
  recordMcpTiming(ctx.controllerHome, trace);
  return response;
}

export async function callExecutionTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  if (!executionToolNames.has(name)) return undefined;
  try {
    switch (name) {
      case 'session_start': {
        const session = startOrResumeSession(ctx);
        return result({ session: { sessionId: session.sessionId, principalId: session.principalId, activeRepositoryId: session.activeRepositoryId, activeCheckoutId: session.activeCheckoutId, activeWorkId: session.activeWorkId, permissionSnapshotVersion: session.permissionSnapshotVersion, capabilitySnapshotVersion: session.capabilitySnapshotVersion, controllerInstanceId: session.controllerInstanceId, createdAt: session.createdAt, updatedAt: session.updatedAt } });
      }
      case 'session_bind_repository': return result(bindSessionRepository(ctx, args));
      case 'work_prepare': return result(prepareWork(ctx, args));
      case 'work_inspect': return result(inspectWork(ctx, args));
      case 'work_validate': return result(await validateWork(ctx, args));
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
          workId: typeof args.work_id === 'string' ? args.work_id : session.activeWorkId,
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
        return result(readControllerResult({ controllerHome: ctx.controllerHome, resultRef: String(args.result_ref ?? ''), sessionId: session.sessionId, principalId: session.principalId, workId: typeof args.work_id === 'string' ? args.work_id : undefined, cursor: typeof args.cursor === 'number' ? args.cursor : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }));
      }
      case 'result_search': {
        const session = requireSession(ctx, args);
        return result(searchControllerResult({ controllerHome: ctx.controllerHome, resultRef: String(args.result_ref ?? ''), sessionId: session.sessionId, principalId: session.principalId, workId: typeof args.work_id === 'string' ? args.work_id : undefined, query: String(args.query ?? ''), limit: typeof args.limit === 'number' ? args.limit : undefined }));
      }
      default: return undefined;
    }
  } catch (error) {
    return failure(error);
  }
}
