import { existsSync, readFileSync } from 'fs';
import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { repositoryGitStatus, repositoryGitDiff } from '../../../src/cli/repositories/structured-git';
import { listControllerChecks } from '../../../src/cli/controller/check-runner';
import { buildWorkContinuationSnapshot } from '../../../src/runtime/control-plane/facade/work-continuation';
import { currentControllerInstanceId, startExecutionSession, type ExecutionSessionContext } from '../../../src/runtime/control-plane/execution/session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle } from '../../../src/runtime/control-plane/execution/validation';
import { resolveAuthorizationRequest } from '../../../src/runtime/control-plane/governance/authorization';
import { readControllerResult, searchControllerResult } from '../../../src/runtime/evidence/result-store';
import { resumeExecutionJobAfterApproval } from '../../../src/runtime/execution/jobs/store';
import { recordMcpTiming, type McpTimingTrace } from '../../../src/runtime/diagnostics/mcp-timing';
import { compactHandle, contractFor, identityFor, makeBoundedWorkResult, principalFor, requireSession, workForSession } from '../../../src/runtime/control-plane/execution/work-execution-support';
import { finalizeWork } from '../../../src/runtime/control-plane/execution/work-finalization-service';
import { bindSessionRepository, prepareWork } from '../../../src/runtime/control-plane/execution/work-preparation-service';
import { executeWork, validateWork } from '../../../src/runtime/control-plane/execution/work-operation-service';


// Compatibility exports: implementation authority lives in control-plane execution.
export {
  inspectWorkTargetAdvance,
  targetAdvanceLinearMergeCommits,
  planTargetAdvanceValidationAuthority,
  targetAdvanceWorkScopeViolation,
  inspectDirectTargetDelivery,
  inspectTargetDirtyWorkOwnership,
  inspectDirectCanonicalTargetAdvanceReconciliation,
  completionReceiptChangedPaths,
  inspectCleanupOnlyMergedHead,
  resetFinalizationStagesForRequest,
} from '../../../src/runtime/control-plane/execution/work-finalization-service';
export { releasePreparedWorkOwnership } from '../../../src/runtime/control-plane/execution/work-execution-support';
export { selectDefaultWorkValidationChecks } from '../../../src/runtime/control-plane/execution/work-operation-service';
export type {
  DirectCanonicalTargetAdvanceInspection,
  DirectTargetDeliveryInspection,
  TargetAdvanceValidationTransferPlan,
  TargetDirtyWorkOwnershipInspection,
  WorkTargetAdvanceInspection,
} from '../../../src/runtime/control-plane/execution/work-finalization-service';

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
    objective: { type: 'string' }, goal_id: { type: 'string' }, acceptance_criteria: { type: 'array', items: { type: 'string' } }, allowed_paths: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'string' } },
    isolation: { type: 'string', enum: ['reuse', 'new_worktree', 'auto'] }, base_ref: { type: 'string' }, needs_dependencies: { type: 'boolean' },
    expected_previous_head: { type: 'string', description: 'Explicit prior WorkHandle HEAD required for audited successor adoption of an existing work_id.' },
    adopt_candidate_head: { type: 'string', description: 'Explicit current successor commit to adopt after exact identity, ownership, cleanliness, ancestry, and path-scope validation.' },
  }, [], false),
  definition('work_inspect', 'Collect bounded Git, WorkContract, path, check, and readiness evidence through one work handle.', { session_id: sessionId, repo_id: repoId, work_id: workId, detail: { type: 'string', enum: ['summary', 'detail'] } }, ['work_id'], true),
  definition('work_execute', 'Execute approved, repository-scoped commands against a validated work handle while preserving the existing command policy and audit path.', {
    session_id: sessionId, controller_id: { type: 'string', description: 'Controller identity that holds the Work lease. Defaults to the authenticated principal.' }, repo_id: repoId, work_id: workId,
    command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] }, approval_token: { type: 'string' }, cwd: { type: 'string' }, timeout_ms: { type: 'number' }, max_output_bytes: { type: 'number' },
    commands: { type: 'array', items: { type: 'object' } }, approval_request_id: { type: 'string' },
  }, ['work_id'], false),
  definition('work_validate', 'Run targeted checks or read-only validation commands against a work handle with full current-state validation.', {
    session_id: sessionId, controller_id: { type: 'string', description: 'Controller identity that holds the Work lease. Defaults to the authenticated principal.' }, repo_id: repoId, work_id: workId, check_ids: { type: 'array', items: { type: 'string' } }, commands: { type: 'array', items: { type: 'object' } },
  }, ['work_id'], false),
  definition('work_finalize', 'Idempotently validate, commit, merge, clean a managed worktree, and complete the existing WorkContract in independently recorded stages.', {
    session_id: sessionId, controller_id: { type: 'string', description: 'Controller identity that holds the Work lease. Defaults to the authenticated principal.' }, repo_id: repoId, work_id: workId, commit: { type: 'boolean' }, message: { type: 'string' }, merge: { type: 'boolean' }, target_branch: { type: 'string' }, remote_write: { type: 'boolean', description: 'When true, push the exact locally integrated target revision to origin before cleanup and Work terminalization.' }, delete_branch: { type: 'boolean' }, cleanup: { type: 'boolean' }, no_ff: { type: 'boolean' }, approval_request_id: { type: 'string' },
    completion_outcome: { type: 'string', enum: ['completed_changed', 'completed_no_change'] }, no_change_evidence: { type: 'string', description: 'Objective-specific proof that the requested state already holds; required for completed_no_change.' },
  }, ['work_id'], false, true),
  definition('approval_resolve', 'Resolve a controller approval request from the current conversation; GUI approval is optional and not required for continuation.', { session_id: sessionId, repo_id: repoId, work_id: workId, approval_request_id: { type: 'string' }, confirm_authorization: { type: 'boolean' } }, ['approval_request_id', 'confirm_authorization'], false),
  definition('result_read', 'Read a session-scoped result reference with bounded pagination.', { session_id: sessionId, result_ref: { type: 'string' }, work_id: workId, cursor: { type: 'number' }, limit: { type: 'number' } }, ['result_ref'], true),
  definition('result_search', 'Search a session-scoped result reference without returning the full payload.', { session_id: sessionId, result_ref: { type: 'string' }, work_id: workId, query: { type: 'string' }, limit: { type: 'number' } }, ['result_ref', 'query'], true),
];

const executionToolNames = new Set(executionToolDefinitions.map((tool) => tool.name));

/**
 * Work mutation tool names remain grouped for compatibility with older Worker
 * entrypoints. On the public MCP surface they execute directly through
 * WorkContract + Process Runtime ownership rather than durable ExecutionJobs.
 */
const DURABLE_WORK_OPERATION_NAMES = new Set([
  'work_execute',
  'work_validate',
  'work_finalize',
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

function startOrResumeSession(ctx: MultiRepositoryMcpToolContext): ExecutionSessionContext {
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
  // work_inspect is authorized read-only evidence; it must not require the write lease.
  const handle = workForSession(ctx, session, args);
  const started = performance.now();
  const validationStarted = performance.now();
  const validated = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'cheap', 'inspect');
  const validationMs = performance.now() - validationStarted;
  const status = repositoryGitStatus(validated.worktreeRepository);
  const diff = repositoryGitDiff(validated.worktreeRepository, { maxBytes: 64 * 1024 });
  const contract = contractFor(ctx, handle);
  const checks = contract?.checks ?? [];
  const packageManifest = existsSync(`${validated.worktreeRepository.canonicalRoot}/package.json`)
    ? JSON.parse(readFileSync(`${validated.worktreeRepository.canonicalRoot}/package.json`, 'utf-8')) as Record<string, unknown>
    : undefined;
  const value = {
    session: { sessionId: session.sessionId, repoId: session.activeRepositoryId, checkoutId: session.activeCheckoutId },
    work: compactHandle(handle),
    readiness: { valid: true, warnings: validated.warnings, permissionSnapshotVersion: handle.permissionSnapshotVersion },
    git: { status, diff: { nameOnly: diff.nameOnly, stat: diff.stat, patch: diff.patch, truncated: diff.truncated } },
    workContract: contract ? {
      workId: contract.workId,
      status: contract.status,
      objective: contract.objective,
      checks: contract.checks,
      acceptanceCriteria: contract.acceptanceCriteria,
      allowedPaths: contract.allowedPaths,
      semantics: buildWorkContinuationSnapshot(contract).semantics,
    } : undefined,
    continuation: contract ? buildWorkContinuationSnapshot(contract) : undefined,
    paths: { allowed: handle.workContractId ? contract?.allowedPaths ?? [] : [], relevant: diff.nameOnly },
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
      case 'work_execute': return result(await executeWork(ctx, args));
      case 'work_validate': return result(await validateWork(ctx, args));
      case 'work_finalize': return result(await finalizeWork(ctx, args));
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
