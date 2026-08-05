import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, isAbsolute, relative, resolve } from 'path';
import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { CompletionReceipt } from '../../../cli/controller/types';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  getRepository,
  listRepositories,
  resolveRepositorySelection,
  selectRepositoryCheckout,
  setRepositoryCheckoutLifecycle,
} from '../../../cli/repositories/registry';
import { withControllerLock } from '../../../cli/repositories/locks';
import { repositoryGitCommit, repositoryGitDeleteBranch, repositoryGitFinishWorkflow, repositoryGitStatus, repositoryGitDiff } from '../../../cli/repositories/structured-git';
import { previewRepositoryCommandExecution } from '../../../cli/repositories/command-executor';
import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { globMatches } from '../../../cli/mcp/paths';
import { ensureManagedWorkspace } from '../../workflow/campaigns/workspace';
import { listControllerChecks } from '../../../cli/controller/check-runner';
import { readRepositoryAccessPolicy } from '../../control-plane/governance/access-policy';
import { appendWorkEvidence, createWorkContract, getWorkContract, recordWorkCompletionReceipt, updateWorkContract, appendVerificationRecord } from '../../control-plane/facade/work-contract-store';
import { completeRequirementFromWork } from '../../control-plane/persistence/requirement-store';
import { isTerminalWorkContractStatus, type WorkReconciliationRecord } from '../../control-plane/facade/types';
import { buildWorkContinuationSnapshot } from '../../control-plane/facade/work-continuation';
import { claimControllerSession, getControllerSession, releaseControllerSession, resumeControllerSession } from '../../control-plane/facade/controller-session-store';
import { currentControllerInstanceId, requireExecutionSession, startExecutionSession, updateExecutionSession, type ExecutionSessionContext, type SessionIdentity } from '../../control-plane/execution/session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle } from '../../control-plane/execution/validation';
import { commandFingerprint, verificationInputFingerprint, workspaceValidationFingerprint, workValidationInputFingerprint } from '../../control-plane/execution/verification-evidence';
import { assertExecutionIdentity, executionIdentityForWork, executionIdentityFromCoordinates, resolveLegacyWorkContractIdentity } from '../../control-plane/execution/execution-identity';
import { withWorkPrepareRequest } from '../../control-plane/execution/work-prepare-request-store';
import { markWorkHandleFailed, newWorkId, readWorkHandle, transitionWorkHandle, writeWorkHandle, type WorkFinalizationStages, type WorkHandleState, type WorkTerminalOutcome } from '../../control-plane/execution/work-handle-store';
import { cleanupTerminalWork } from '../../control-plane/execution/work-terminal-cleanup';
import { assertResolvedAuthorization, createGoalDelegation, decideAuthorization, resolveAuthorizationRequest, type AuthorizationDecision, type AuthorizationRiskClass } from '../../control-plane/governance/authorization';
import { readControllerResult, searchControllerResult, writeControllerResult } from '../../evidence/result-store';
import { resumeExecutionJobAfterApproval } from '../../execution/jobs/store';
import { recordMcpTiming, type McpTimingTrace } from '../../diagnostics/mcp-timing';
import { commandValue, normalizeRepositoryCommand, type RepositoryCommandValue } from '../../../cli/repositories/command-normalization';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { executeRepositoryCommandViaProcessRuntime } from '../../execution/process-runtime/command-facade';
import { getCheckProcessHandle } from '../../execution/process-runtime/check-facade';
import { processCheckCompletionReceipt } from '../../execution/process-runtime/check-receipt';
import { claimProcessInvocation, getProcessRecord } from '../../execution/process-runtime/store';
import { runPersistedCheckViaProcessRuntime } from './persisted-check-process';
import { hasCurrentWorkValidationAuthority, markWorkValidationPending, projectWorkValidationOutcome, reconcileWorkValidation } from './work-validation-reconciler';

const MAX_INLINE_RESULT_BYTES = 64 * 1024;

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
    isolation: { type: 'string', enum: ['reuse', 'new_worktree', 'auto'] }, base_ref: { type: 'string' },
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
    session_id: sessionId, controller_id: { type: 'string', description: 'Controller identity that holds the Work lease. Defaults to the authenticated principal.' }, repo_id: repoId, work_id: workId, commit: { type: 'boolean' }, message: { type: 'string' }, merge: { type: 'boolean' }, target_branch: { type: 'string' }, delete_branch: { type: 'boolean' }, cleanup: { type: 'boolean' }, no_ff: { type: 'boolean' }, approval_request_id: { type: 'string' },
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

function principalFor(ctx: MultiRepositoryMcpToolContext): string {
  return ctx.principalId?.trim() || `controller-issued:${ctx.controllerInstanceId ?? currentControllerInstanceId()}`;
}

function identityFor(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): SessionIdentity {
  return {
    sessionId: typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : ctx.sessionId,
    principalId: principalFor(ctx),
    controllerInstanceId: ctx.controllerInstanceId ?? currentControllerInstanceId(),
  };
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

function requireSession(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): ExecutionSessionContext {
  return requireExecutionSession(ctx.controllerHome, identityFor(ctx, args));
}

function requireExplicitRepoId(args: Record<string, unknown>): string {
  const value = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (!value) throw new Error('REPOSITORY_ID_REQUIRED: repository selection must be explicit for session binding');
  return value;
}

function selectedRepository(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, args: Record<string, unknown>, allowSession = true) {
  const requested = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
  const selectedRepoId = requested ?? (allowSession ? session.activeRepositoryId : undefined);
  if (!selectedRepoId) throw new Error('SESSION_REPOSITORY_REQUIRED: bind a repository before using this work tool');
  if (session.activeRepositoryId && requested && session.activeRepositoryId !== requested) {
    throw new Error('SESSION_REPOSITORY_MISMATCH: call session_bind_repository before switching repositories');
  }
  return resolveRepositorySelection({ repoId: selectedRepoId, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : session.activeCheckoutId, controllerHome: ctx.controllerHome, allowSoleRepository: false });
}

function compactHandle(handle: WorkHandleState): Record<string, unknown> {
  return {
    workId: handle.workId, sessionId: handle.sessionId, repoId: handle.repositoryId, checkoutId: handle.checkoutId,
    worktreePath: handle.worktreePath, branch: handle.branch, sourceCheckoutId: handle.sourceCheckoutId, goalId: handle.goalId, delegationVersion: handle.delegationVersion,
    workContractId: handle.workContractId, baseCommit: handle.baseCommit, expectedHead: handle.expectedHead,
    permissionSnapshotVersion: handle.permissionSnapshotVersion, state: handle.state, managedWorktree: handle.managedWorktree,
    createdAt: handle.createdAt, updatedAt: handle.updatedAt, finalization: handle.finalization,
    ...(handle.failureReason ? { failureReason: handle.failureReason } : {}),
    ...(handle.cleanupResponsibility ? { cleanupResponsibility: handle.cleanupResponsibility } : {}),
    ...(handle.cleanupReceipt ? { cleanupReceipt: handle.cleanupReceipt } : {}),
  };
}

function initialStage(): WorkFinalizationStages {
  return { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' };
}

function gitHead(root: string): string | undefined {
  const output = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  return output.status === 0 && typeof output.stdout === 'string' ? output.stdout.trim() : undefined;
}

function gitCommit(root: string, revision: string, label: string): string {
  const output = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${revision}^{commit}`], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (output.status !== 0 || output.error || typeof output.stdout !== 'string' || !output.stdout.trim()) {
    throw new Error(`WORK_HEAD_ADOPTION_${label}_INVALID: ${revision}`);
  }
  return output.stdout.trim();
}

function gitChangedPaths(root: string, previousHead: string, candidateHead: string): string[] {
  const output = spawnSync('git', ['-C', root, 'diff', '--name-only', '-z', previousHead, candidateHead], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (output.status !== 0 || output.error || typeof output.stdout !== 'string') {
    throw new Error('WORK_HEAD_ADOPTION_CHANGED_PATHS_UNAVAILABLE');
  }
  return [...new Set(output.stdout.split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizedRequiredString(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' && args[key].trim() ? args[key].trim() : undefined;
}

function completionReceiptForFinalizedWork(
  ctx: MultiRepositoryMcpToolContext,
  handle: WorkHandleState,
  contract: ReturnType<typeof contractFor>,
  args: Record<string, unknown>,
): CompletionReceipt {
  const repository = getRepository(handle.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const target = selectRepositoryCheckout(repository, handle.sourceCheckoutId ?? repository.activeCheckoutId);
  const targetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : repository.defaultBranch || 'main';
  const targetRevision = gitHead(target.canonicalRoot);
  if (!targetRevision) throw new Error('WORK_COMPLETION_RECEIPT_TARGET_REQUIRED: target HEAD is unavailable');
  const reachable = spawnSync('git', ['-C', target.canonicalRoot, 'merge-base', '--is-ancestor', targetRevision, targetBranch], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }).status === 0;
  if (!reachable) throw new Error(`WORK_COMPLETION_RECEIPT_DELIVERY_NOT_PROVEN: ${targetRevision} is not reachable from ${targetBranch}`);
  const changedPaths = handle.baseCommit
    ? Array.from(new Set(String(spawnSync('git', ['-C', target.canonicalRoot, 'diff', '--name-only', `${handle.baseCommit}..${targetRevision}`], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      }).stdout ?? '').split('\n').map((entry) => entry.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right))
    : [];
  const recordedAt = new Date().toISOString();
  const noChange = args.completion_outcome === 'completed_no_change';
  const warnings = [
    ...(handle.finalization.branchCleanup === 'skipped' ? [{ code: 'cleanup_retained_by_request' as const, message: 'Branch cleanup was skipped by the finalization request.', resourceKind: 'branch' as const, resourceId: handle.branch, recordedAt }] : []),
    ...(handle.finalization.worktreeCleanup === 'skipped' && handle.managedWorktree ? [{ code: 'cleanup_retained_by_request' as const, message: 'Managed worktree cleanup was skipped by the finalization request.', resourceKind: 'worktree' as const, resourceId: handle.worktreePath, recordedAt }] : []),
  ];
  return {
    schemaVersion: 1,
    receiptId: `REC-controller_work-${createHash('sha256').update(`${handle.workId}\0${targetRevision}`).digest('hex').slice(0, 16)}`,
    source: 'controller_work',
    issueId: contract?.issueId ?? 'work',
    taskId: contract?.taskId ?? handle.workId,
    workId: handle.workId,
    targetBranch,
    targetRevision,
    sourceRevision: handle.baseCommit,
    baseRevision: handle.baseCommit,
    changedPaths,
    delivery: {
      kind: noChange ? 'no_change' : 'commit',
      status: 'integrated',
      strategy: noChange ? 'no_change' : handle.finalization.commit === 'done' ? 'edit_session_commit' : 'already_integrated',
      reachable: true,
      recordedAt,
    },
    cleanup: {
      status: warnings.length > 0 ? 'maintenance_warning' : 'complete',
      warnings,
      blockers: [],
      recordedAt,
    },
    verifiedAt: recordedAt,
    recordedAt,
  };
}

function boundedStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, limit) : [];
}

function workPrepareFingerprint(input: {
  repoId: string;
  requestedCheckoutId?: string;
  isolation: 'reuse' | 'new_worktree' | 'auto';
  objective: string;
  goalId?: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  checks: string[];
  baseRef?: string;
}): string {
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, operation: 'work_prepare', ...input })).digest('hex');
}

function makeBoundedResult(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, repoId: string, workIdValue: string | undefined, kind: 'inspection' | 'command' | 'validation' | 'finalization' | 'generic', value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_INLINE_RESULT_BYTES) return value;
  const started = performance.now();
  const stored = writeControllerResult({ controllerHome: ctx.controllerHome, repoId, sessionId: session.sessionId, principalId: session.principalId, workId: workIdValue, kind, value });
  return {
    summary: { itemCount: Array.isArray(value.items) ? value.items.length : undefined, truncated: true, warnings: ['Full result is available through the secure result reference.'] },
    items: Array.isArray(value.items) ? value.items.slice(0, 25) : { preview: serialized.slice(0, 16_384) },
    resultRef: stored.resultRef,
    resultId: stored.resultId,
    byteLength: stored.byteLength,
    _resultPersistenceMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

function contractFor(ctx: MultiRepositoryMcpToolContext, handle: WorkHandleState) {
  return handle.workContractId ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, handle.workContractId) : undefined;
}

function findWorkHandle(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  args: Record<string, unknown>,
): WorkHandleState {
  const requested = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const workIdValue = requested || session.activeWorkId || '';
  if (!workIdValue) throw new Error('WORK_ID_REQUIRED: provide work_id or call work_prepare first');
  const requestedRepoId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
  const requestedCheckoutId = typeof args.checkout_id === 'string' && args.checkout_id.trim()
    ? args.checkout_id.trim()
    : undefined;
  const repoCandidates = [
    requestedRepoId,
    session.activeRepositoryId,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  for (const repositoryId of repoCandidates) {
    const handle = readWorkHandle(ctx.controllerHome, repositoryId, workIdValue);
    if (!handle) continue;
    if (requestedCheckoutId && handle.checkoutId !== requestedCheckoutId) {
      throw new Error(
        `WORK_HANDLE_CHECKOUT_DRIFT: work ${workIdValue} is bound to checkout ${handle.checkoutId}, not ${requestedCheckoutId}`,
      );
    }
    return handle;
  }
  const matches = listRepositories(ctx.controllerHome, { includeRemoved: true })
    .map((repository) => readWorkHandle(ctx.controllerHome, repository.repoId, workIdValue))
    .filter((handle): handle is WorkHandleState => Boolean(handle));
  // Legacy incomplete identity: only a unique exact WorkHandle match may execute.
  return resolveLegacyWorkContractIdentity({
    workId: workIdValue,
    repoId: requestedRepoId,
    checkoutId: requestedCheckoutId,
    candidates: matches,
  });
}

function workForSession(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  args: Record<string, unknown>,
  options: { reconcileValidation?: boolean } = {},
): WorkHandleState {
  let handle = findWorkHandle(ctx, session, args);
  if (handle.principalId !== session.principalId) throw new Error('WORK_HANDLE_PRINCIPAL_MISMATCH: work handle belongs to another principal');
  if (options.reconcileValidation !== false) handle = reconcileWorkValidation(ctx.controllerHome, handle).handle;
  if (
    session.activeRepositoryId !== handle.repositoryId
    || session.activeCheckoutId !== handle.checkoutId
    || session.activeWorkId !== handle.workId
  ) {
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
      activeRepositoryId: handle.repositoryId,
      activeCheckoutId: handle.checkoutId,
      activeWorkId: handle.workId,
      permissionSnapshotVersion: handle.permissionSnapshotVersion,
      lastValidatedAt: new Date().toISOString(),
    });
  }
  return handle;
}

function assertWorkControllerOwnership(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  handle: WorkHandleState,
  args: Record<string, unknown>,
): void {
  const workIdValue = handle.workContractId ?? handle.workId;
  const owner = getControllerSession({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, workIdValue);
  const controllerId = typeof args.controller_id === 'string' && args.controller_id.trim()
    ? args.controller_id.trim()
    : session.principalId;
  if (controllerId !== session.principalId) {
    throw new Error('WORK_CONTROLLER_IDENTITY_MISMATCH: controller_id must match the authenticated principal');
  }
  const resumed = resumeControllerSession({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, {
    workId: workIdValue,
    controllerId,
    controllerType: owner?.controllerType ?? 'chatgpt',
    sessionId: session.sessionId,
    principalId: session.principalId,
    controllerInstanceId: session.controllerInstanceId,
    leaseMs: 3_600_000,
  });
  if (resumed.controllerId !== controllerId || resumed.sessionId !== session.sessionId) {
    throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workIdValue} is owned by ${resumed.controllerId}/${resumed.sessionId}`);
  }
}

function claimPreparedWorkOwnership(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  handle: WorkHandleState,
  args: Record<string, unknown>,
): void {
  const workIdValue = handle.workContractId ?? handle.workId;
  const controllerId = typeof args.controller_id === 'string' && args.controller_id.trim()
    ? args.controller_id.trim()
    : session.principalId;
  claimControllerSession({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, {
    workId: workIdValue,
    controllerId,
    controllerType: 'chatgpt',
    sessionId: session.sessionId,
    principalId: session.principalId,
    controllerInstanceId: session.controllerInstanceId,
    leaseMs: 3_600_000,
  });
}

function claimHeadAdoptionOwnership(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  handle: WorkHandleState,
  args: Record<string, unknown>,
): void {
  const workIdValue = handle.workContractId ?? handle.workId;
  const controllerId = normalizedRequiredString(args, 'controller_id') ?? session.principalId;
  if (controllerId !== session.principalId) {
    throw new Error('WORK_CONTROLLER_IDENTITY_MISMATCH: controller_id must match the authenticated principal');
  }
  const options = { controllerHome: ctx.controllerHome, repoId: handle.repositoryId };
  const current = getControllerSession(options, workIdValue);
  const input = {
    workId: workIdValue,
    controllerId,
    controllerType: current?.controllerType ?? 'chatgpt' as const,
    sessionId: session.sessionId,
    principalId: session.principalId,
    controllerInstanceId: session.controllerInstanceId,
    expectedClaimGeneration: current?.claimGeneration ?? 0,
    leaseMs: 3_600_000,
  };
  const claimed = current
    ? resumeControllerSession(options, input)
    : claimControllerSession(options, input);
  if (
    claimed.controllerId !== controllerId
    || claimed.sessionId !== session.sessionId
    || claimed.principalId !== session.principalId
    || claimed.controllerInstanceId !== session.controllerInstanceId
    || (claimed.claimGeneration ?? 0) < 1
  ) {
    throw new Error('WORK_HEAD_ADOPTION_OWNERSHIP_FENCE_MISMATCH');
  }
}

function adoptExistingWorkHead(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  repository: RepositoryRecord,
  handle: WorkHandleState,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const previousInput = normalizedRequiredString(args, 'expected_previous_head');
  const candidateInput = normalizedRequiredString(args, 'adopt_candidate_head');
  if (!previousInput && !candidateInput) return undefined;
  if (!previousInput || !candidateInput) {
    throw new Error('WORK_HEAD_ADOPTION_ARGUMENTS_REQUIRED: expected_previous_head and adopt_candidate_head must be provided together');
  }
  const requestedCheckoutId = normalizedRequiredString(args, 'checkout_id');
  if (!requestedCheckoutId) throw new Error('WORK_HEAD_ADOPTION_CHECKOUT_REQUIRED: checkout_id must be explicit');
  if (repository.repoId !== handle.repositoryId) throw new Error('WORK_HEAD_ADOPTION_REPOSITORY_MISMATCH');
  if (requestedCheckoutId !== handle.checkoutId || repository.activeCheckoutId !== handle.checkoutId) {
    throw new Error(`WORK_HEAD_ADOPTION_CHECKOUT_MISMATCH: expected ${handle.checkoutId}, found ${requestedCheckoutId}`);
  }
  if (!handle.managedWorktree) throw new Error('WORK_HEAD_ADOPTION_MANAGED_WORKTREE_REQUIRED');
  if (handle.principalId !== session.principalId) throw new Error('WORK_HANDLE_PRINCIPAL_MISMATCH: work handle belongs to another principal');
  if (handle.state !== 'prepared' && handle.state !== 'editing') {
    throw new Error(`WORK_HEAD_ADOPTION_STATE_INVALID: ${handle.state}`);
  }
  const finalizationStages = [
    handle.finalization.validation,
    handle.finalization.commit,
    handle.finalization.merge,
    handle.finalization.branchCleanup,
    handle.finalization.worktreeCleanup,
  ];
  if (finalizationStages.some((stage) => stage !== 'pending')) {
    throw new Error('WORK_HEAD_ADOPTION_FINALIZATION_ALREADY_STARTED');
  }

  const registered = getRepository(handle.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const registeredCheckout = registered.checkouts.find((entry) => entry.checkoutId === handle.checkoutId);
  if (!registeredCheckout || registeredCheckout.lifecycle !== 'active' || registeredCheckout.worktree !== true) {
    throw new Error('WORK_HEAD_ADOPTION_CHECKOUT_NOT_ACTIVE_MANAGED');
  }
  const worktreeRepository = selectRepositoryCheckout(registered, handle.checkoutId);
  const guarded = assertExecutionIdentity({
    controllerHome: ctx.controllerHome,
    identity: executionIdentityFromCoordinates({
      repositoryId: handle.repositoryId,
      checkoutId: handle.checkoutId,
      canonicalRoot: handle.worktreePath,
      workId: handle.workId,
      worktreePath: handle.worktreePath,
      branch: handle.branch,
    }),
    cwd: handle.worktreePath,
    requestedRepoId: repository.repoId,
    requestedCheckoutId,
  });
  const status = repositoryGitStatus(worktreeRepository);
  if (!status.clean) throw new Error('WORK_HEAD_ADOPTION_WORKTREE_DIRTY');

  const previousHead = gitCommit(handle.worktreePath, previousInput, 'PREVIOUS_HEAD');
  const candidateHead = gitCommit(handle.worktreePath, candidateInput, 'CANDIDATE_HEAD');
  const authoritativePrevious = handle.expectedHead ? gitCommit(handle.worktreePath, handle.expectedHead, 'AUTHORITATIVE_PREVIOUS_HEAD') : undefined;
  if (!authoritativePrevious || authoritativePrevious !== previousHead) {
    throw new Error(`WORK_HEAD_ADOPTION_PREVIOUS_HEAD_MISMATCH: expected ${authoritativePrevious ?? 'missing'}, found ${previousHead}`);
  }
  if (guarded.currentHead !== candidateHead || status.head !== candidateHead) {
    throw new Error(`WORK_HEAD_ADOPTION_CANDIDATE_NOT_CURRENT: expected current HEAD ${candidateHead}, found ${guarded.currentHead ?? status.head ?? 'missing'}`);
  }
  if (previousHead === candidateHead) throw new Error('WORK_HEAD_ADOPTION_SUCCESSOR_REQUIRED');
  const ancestry = spawnSync('git', ['-C', handle.worktreePath, 'merge-base', '--is-ancestor', previousHead, candidateHead], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (ancestry.status !== 0 || ancestry.error) throw new Error('WORK_HEAD_ADOPTION_NOT_DESCENDANT');

  const contract = contractFor(ctx, handle);
  if (!contract || contract.repoId !== handle.repositoryId) throw new Error('WORK_HEAD_ADOPTION_CONTRACT_MISSING');
  if (isTerminalWorkContractStatus(contract.status) || contract.completionReceipt) {
    throw new Error('WORK_HEAD_ADOPTION_CONTRACT_TERMINAL');
  }
  const changedPaths = gitChangedPaths(handle.worktreePath, previousHead, candidateHead);
  for (const path of changedPaths) {
    if (contract.forbiddenPaths.some((pattern) => globMatches(pattern, path))) {
      throw new Error(`WORK_HEAD_ADOPTION_FORBIDDEN_PATH: ${path}`);
    }
    if (contract.allowedPaths.length === 0 || !contract.allowedPaths.some((pattern) => globMatches(pattern, path))) {
      throw new Error(`WORK_HEAD_ADOPTION_PATH_OUT_OF_SCOPE: ${path}`);
    }
  }

  claimHeadAdoptionOwnership(ctx, session, handle, args);

  const reviewedAt = new Date().toISOString();
  const reconciliationId = `RECNC-${createHash('sha256').update([
    handle.repositoryId, handle.workId, previousHead, candidateHead, handle.checkoutId, handle.branch,
  ].join('\0')).digest('hex').slice(0, 16)}`;
  const reconciliation: WorkReconciliationRecord = {
    schemaVersion: 1,
    reconciliationId,
    originalExpectedRevision: previousHead,
    observedTargetRevision: candidateHead,
    baseRevision: gitCommit(handle.worktreePath, handle.baseCommit ?? previousHead, 'BASE_HEAD'),
    targetBranch: handle.branch,
    reachable: true,
    method: 'exact_commit',
    comparedPaths: changedPaths,
    reviewer: session.principalId.slice(0, 200),
    reviewedAt,
    unrecoverableStages: [],
    cleanupOwnershipProof: `No cleanup was performed; managed checkout ${handle.checkoutId} remains owned by Work finalizer.`,
    rationale: 'Adopted an exact clean successor commit after repository, checkout, worktree, branch, controller ownership, ancestry, and WorkContract path-scope verification. This reconciliation is not completion evidence.',
    outcome: 'accepted_equivalence',
  };

  const adopted = transitionWorkHandle(ctx.controllerHome, handle, 'editing', {
    expectedHead: candidateHead,
    failureReason: undefined,
    finalization: initialStage(),
    validationRun: undefined,
    validatedInputFingerprint: undefined,
  });
  try {
    updateWorkContract({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, contract.workId, {
      evidenceState: contract.checkRefs.length === 0
        ? contract.evidenceState
        : contract.evidenceState === 'valid' || contract.evidenceState === 'stale'
          ? 'stale'
          : 'partial',
      reconciliations: [reconciliation, ...contract.reconciliations.filter((entry) => entry.reconciliationId !== reconciliationId)],
    });
    appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, contract.workId, {
      title: 'audited WorkHandle successor HEAD adoption',
      summary: `${previousHead} -> ${candidateHead}; ${changedPaths.length} changed path(s) remained within the WorkContract allow-list. Historical validation and completion receipts were not rewritten.`,
      detailLevel: 'summary',
    });
  } catch (error) {
    try {
      writeWorkHandle(ctx.controllerHome, { ...handle, recordRevision: adopted.recordRevision });
    } catch (rollbackError) {
      throw new Error(`WORK_HEAD_ADOPTION_AUDIT_WRITE_FAILED_AND_ROLLBACK_FAILED: ${String(error)}; ${String(rollbackError)}`);
    }
    throw error;
  }
  const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: handle.repositoryId,
    activeCheckoutId: handle.checkoutId,
    activeWorkId: handle.workId,
    permissionSnapshotVersion: handle.permissionSnapshotVersion,
    lastValidatedAt: reviewedAt,
  });
  return {
    session: nextSession,
    work: compactHandle(adopted),
    reused: true,
    adopted: true,
    adoption: { previousHead, candidateHead, changedPaths, reconciliationId },
    controllerClaimed: true,
  };
}

function releasePreparedWorkOwnership(
  ctx: MultiRepositoryMcpToolContext,
  handle: WorkHandleState,
): 'released' | 'already_released' {
  const workIdValue = handle.workContractId ?? handle.workId;
  const current = getControllerSession(
    { controllerHome: ctx.controllerHome, repoId: handle.repositoryId },
    workIdValue,
  );
  if (!current) return 'already_released';
  releaseControllerSession(
    { controllerHome: ctx.controllerHome, repoId: handle.repositoryId },
    workIdValue,
    current.controllerId,
  );
  return 'released';
}

function terminalCleanupOutcome(
  ctx: MultiRepositoryMcpToolContext,
  handle: WorkHandleState,
): WorkTerminalOutcome | undefined {
  if (handle.cleanupReceipt) return handle.cleanupReceipt.terminalOutcome;
  const contract = contractFor(ctx, handle);
  if (contract?.status === 'cancelled') return 'cancelled';
  const reason = `${handle.failureReason ?? ''} ${handle.finalization.lastError ?? ''}`.toLowerCase();
  if (contract?.status === 'blocked' && reason.includes('terminal')) return 'blocked_terminal';
  if (contract?.status === 'failed' || handle.state === 'failed' || handle.state === 'failed_terminal_cleanup') {
    if (reason.includes('infrastructure') || reason.includes('timed out') || reason.includes('unavailable')) {
      return 'infrastructure_failed';
    }
    if (handle.finalization.validation === 'failed') return 'validation_failed';
    return 'failed';
  }
  return undefined;
}

async function reconcileTerminalCleanup(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  handle: WorkHandleState,
  args: Record<string, unknown>,
  outcome: WorkTerminalOutcome,
): Promise<Record<string, unknown>> {
  const wasComplete = handle.cleanupReceipt?.complete === true;
  const cleaned = await cleanupTerminalWork({
    controllerHome: ctx.controllerHome,
    handle,
    targetBranch: typeof args.target_branch === 'string' ? args.target_branch : undefined,
    deleteBranch: args.delete_branch !== false,
    terminalOutcome: outcome,
    failureReason: handle.failureReason ?? handle.finalization.lastError,
  });
  const ownership = releasePreparedWorkOwnership(ctx, cleaned.handle);
  cleaned.receipt.ownership.controllerLease = ownership;
  const persisted = writeWorkHandle(ctx.controllerHome, {
    ...cleaned.handle,
    cleanupReceipt: cleaned.receipt,
  });
  updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeWorkId: undefined,
    activeCheckoutId: persisted.sourceCheckoutId ?? session.activeCheckoutId,
  });
  if (cleaned.receipt.complete && !wasComplete) {
    appendWorkEvidence(
      { controllerHome: ctx.controllerHome, repoId: persisted.repositoryId },
      persisted.workContractId ?? persisted.workId,
      {
        title: 'terminal cleanup receipt',
        summary: `Cleanup ${cleaned.receipt.receiptId} completed for ${outcome}; Work outcome was preserved and no completion receipt was fabricated.`,
        detailLevel: 'summary',
      },
    );
  }
  return {
    work: compactHandle(persisted),
    stages: persisted.finalization,
    completed: false,
    cleanupCompleted: cleaned.receipt.complete,
    cleanupPartial: cleaned.receipt.partial,
    failurePreserved: true,
    cleanupReceipt: cleaned.receipt,
    idempotent: wasComplete,
  };
}

function invalidateActiveWork(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, reason: string): void {
  if (!session.activeRepositoryId || !session.activeWorkId) return;
  const handle = readWorkHandle(ctx.controllerHome, session.activeRepositoryId, session.activeWorkId);
  if (!handle || handle.state === 'cleaned') return;
  const contract = contractFor(ctx, handle);
  if (contract?.status === 'completed') return;
  markWorkHandleFailed(ctx.controllerHome, handle, reason);
}

function bindSessionRepository(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = resolveRepositorySelection({ repoId: requireExplicitRepoId(args), checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome: ctx.controllerHome, allowSoleRepository: false });
  const switching = session.activeRepositoryId !== undefined && (session.activeRepositoryId !== repository.repoId || session.activeCheckoutId !== repository.activeCheckoutId);
  if (switching) invalidateActiveWork(ctx, session, 'explicit repository or checkout switch invalidated the previous active work handle');
  const next = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: repository.activeCheckoutId,
    activeWorkId: undefined,
    goalDelegation: undefined,
    permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId),
    lastValidatedAt: new Date().toISOString(),
  });
  return { session: next, repository: { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, canonicalRoot: repository.canonicalRoot, branch: repository.checkouts.find((entry) => entry.checkoutId === repository.activeCheckoutId)?.branch ?? null }, switched: switching };
}

function prepareWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = selectedRepository(ctx, session, args, true);
  if (!session.activeRepositoryId) {
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: repository.activeCheckoutId, permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId) });
  }
  const existingId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (existingId) {
    const existing = readWorkHandle(ctx.controllerHome, repository.repoId, existingId)
      ?? findWorkHandle(ctx, session, { ...args, work_id: existingId, repo_id: repository.repoId });
    if (existing.principalId !== session.principalId) throw new Error('WORK_HANDLE_ACCESS_DENIED');
    const adopted = adoptExistingWorkHead(ctx, session, repository, existing, args);
    if (adopted) return adopted;
    validateWorkHandle(ctx.controllerHome, existing, identityFor(ctx, args), 'cheap', 'inspect');
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: existing.repositoryId, activeCheckoutId: existing.checkoutId, activeWorkId: existing.workId, permissionSnapshotVersion: existing.permissionSnapshotVersion });
    claimPreparedWorkOwnership(ctx, session, existing, args);
    return { session: requireSession(ctx, args), work: compactHandle(existing), reused: true, controllerClaimed: true };
  }

  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new Error('WORK_PREPARE_REQUEST_ID_REQUIRED: new work preparation requires request_id');
  const isolation = args.isolation === 'reuse' || args.isolation === 'new_worktree' || args.isolation === 'auto' ? args.isolation : 'auto';
  const objective = String(args.objective ?? 'Controller-managed repository work').trim().slice(0, 2_000);
  const goalId = typeof args.goal_id === 'string' && args.goal_id.trim() ? args.goal_id.trim() : undefined;
  const acceptanceCriteria = boundedStringArray(args.acceptance_criteria, 20);
  const allowedPaths = boundedStringArray(args.allowed_paths, 50);
  const checks = boundedStringArray(args.checks, 30);
  const baseRef = typeof args.base_ref === 'string' && args.base_ref.trim() ? args.base_ref.trim() : undefined;
  const requestedCheckoutId = typeof args.checkout_id === 'string' && args.checkout_id.trim() ? args.checkout_id.trim() : undefined;
  const baseCheckoutId = repository.activeCheckoutId;
  const baseStatus = repositoryGitStatus(repository);
  if (isolation === 'reuse' && !baseStatus.clean) throw new Error('WORKTREE_DIRTY: reuse was requested but the selected checkout is dirty; choose new_worktree or auto');
  const useWorktree = isolation === 'new_worktree' || (isolation === 'auto' && !baseStatus.clean);
  const policy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
  const fingerprint = workPrepareFingerprint({
    repoId: repository.repoId,
    requestedCheckoutId,
    isolation,
    objective,
    goalId,
    acceptanceCriteria,
    allowedPaths,
    checks,
    baseRef,
  });

  return withWorkPrepareRequest({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    sessionId: session.sessionId,
    principalId: session.principalId,
    requestId,
    fingerprint,
    proposedWorkId: newWorkId(),
  }, (request, requestReused) => {
    const createdWorkId = request.workId;
    const existingHandle = readWorkHandle(ctx.controllerHome, repository.repoId, createdWorkId);
    if (existingHandle) {
      if (existingHandle.principalId !== session.principalId || existingHandle.sessionId !== session.sessionId) {
        throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${requestId}`);
      }
      const existingContract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
      if (!existingContract) throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} has a Work handle without its WorkContract`);
      const terminal = isTerminalWorkContractStatus(existingContract.status)
        && !(existingContract.status === 'failed' && request.status === 'claimed');
      if (terminal) {
        return {
          session: requireSession(ctx, args),
          work: compactHandle(existingHandle),
          reused: true,
          terminal: true,
          workContractStatus: existingContract.status,
          controllerClaimed: false,
        };
      }
      if (existingContract.status === 'open' || existingContract.status === 'failed') {
        updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId, { status: 'running', worktreeRef: existingHandle.worktreePath });
      }
      const delegation = createGoalDelegation({
        sessionId: session.sessionId,
        repositoryId: repository.repoId,
        workId: createdWorkId,
        goalId,
        allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
        deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
        permissionSnapshotVersion: policy.revision,
        source: 'gpt_risk_delegate',
      });
      const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: existingHandle.checkoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
      claimPreparedWorkOwnership(ctx, nextSession, existingHandle, args);
      return { session: nextSession, work: compactHandle(existingHandle), reused: true, isolation: existingHandle.managedWorktree ? 'isolated' : 'current', controllerClaimed: true };
    }

    let contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
    if (contract?.requestId && contract.requestId !== requestId) throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${requestId}`);
    if (request.status === 'prepared') {
      throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} completed without a readable Work handle`);
    }
    if (contract && (contract.status === 'completed' || contract.status === 'cancelled')) {
      throw new Error(`WORK_PREPARE_REQUEST_TERMINAL: ${requestId} belongs to ${contract.status} Work ${createdWorkId}`);
    }
    if (!contract) {
      contract = createWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, {
        workId: createdWorkId,
        repoId: repository.repoId,
        mode: useWorktree ? 'goal_workloop' : 'direct_control',
        objective,
        acceptanceCriteria,
        allowedPaths,
        forbiddenPaths: [],
        checks,
        constraints: { accessMode: policy.mode, workspaceMode: useWorktree ? 'isolated' : 'current', requireWorktree: useWorktree, allowCommit: true, allowMerge: true, allowCleanup: true },
        worktreePolicy: { required: useWorktree, reason: useWorktree ? 'work_prepare selected isolated worktree execution' : 'explicitly reused a registered checkout' },
        requestedBy: 'chatgpt',
        requestId,
      });
    }
    const delegation = createGoalDelegation({
      sessionId: session.sessionId,
      repositoryId: repository.repoId,
      workId: createdWorkId,
      goalId,
      allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
      deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
      permissionSnapshotVersion: policy.revision,
      source: 'gpt_risk_delegate',
    });
    try {
      const workspace = useWorktree
        ? ensureManagedWorkspace(ctx.controllerHome, repository, { requestId: createdWorkId, title: objective, baseRef })
        : { mode: 'current' as const, checkoutId: baseCheckoutId, root: repository.canonicalRoot, branch: baseStatus.branch ?? 'detached', baseRevision: baseStatus.head ?? undefined, managed: false };
      const refreshed = getRepository(repository.repoId, ctx.controllerHome);
      const checkout = selectRepositoryCheckout(refreshed, workspace.checkoutId);
      const branch = workspace.branch || repositoryGitStatus(checkout).branch;
      if (!branch) throw new Error('WORKTREE_DETACHED: selected worktree has no branch');
      const head = gitHead(checkout.canonicalRoot);
      const handle: WorkHandleState = {
        schemaVersion: 1, workId: createdWorkId, sessionId: session.sessionId, principalId: session.principalId,
        repositoryId: repository.repoId, checkoutId: checkout.activeCheckoutId, worktreePath: checkout.canonicalRoot, branch,
        sourceCheckoutId: baseCheckoutId, managedWorktree: workspace.managed, workContractId: contract.workId, goalId, delegationVersion: delegation.version,
        baseCommit: workspace.baseRevision ?? head, expectedHead: head, permissionSnapshotVersion: policy.revision,
        state: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalization: initialStage(),
        cleanupResponsibility: { owner: 'work_finalizer', registeredAt: new Date().toISOString() },
      };
      writeWorkHandle(ctx.controllerHome, handle);
      updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId, { status: 'running', worktreeRef: checkout.canonicalRoot });
      const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: checkout.activeCheckoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
      claimPreparedWorkOwnership(ctx, nextSession, handle, args);
      return { session: nextSession, work: compactHandle(handle), reused: requestReused, isolation: workspace.mode, controllerClaimed: true };
    } catch (error) {
      updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId, { status: 'failed' });
      throw error;
    }
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
  const response = makeBoundedResult(ctx, session, handle.repositoryId, handle.workId, 'inspection', value);
  const trace: McpTimingTrace = { tool: 'work_inspect', sessionResolutionMs: 0, repositoryResolutionMs: 0, workHandleValidationMs: Math.round(validationMs * 100) / 100, resultSerializationMs: 0, totalToolDurationMs: Math.round((performance.now() - started) * 100) / 100, sessionId: session.sessionId, repoId: handle.repositoryId, workId: handle.workId };
  recordMcpTiming(ctx.controllerHome, trace);
  return response;
}

function commandInputs(args: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(args.commands)) return args.commands.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
  if (args.command !== undefined) return [{ command: args.command, cwd: args.cwd, approval_token: args.approval_token, timeout_ms: args.timeout_ms, max_output_bytes: args.max_output_bytes }];
  throw new Error('COMMAND_REQUIRED: provide command or commands');
}

function authorizationRisk(command: RepositoryCommandValue, classification: ReturnType<typeof classifyRepositoryCommand>): AuthorizationRiskClass {
  if (classification.risk === 'readonly') return 'readonly';
  if (classification.risk === 'remote_write') return 'remote_write';
  if (classification.risk === 'destructive') return 'destructive';
  const executable = typeof command === 'string' ? command : command[0] ?? '';
  if (typeof command === 'string' && /\b(?:npm|bun|pnpm|yarn)\s+(?:install|add|remove|update)\b/i.test(command)) return 'dependency_change';
  if (/^\s*(?:git|.*[\\/]git)(?:\s|$)/i.test(executable)) return 'local_git';
  return 'workspace_write';
}

async function executeWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args);
  assertWorkControllerOwnership(ctx, session, handle, args);
  const commands = commandInputs(args);
  if (commands.length > 16) throw new Error('COMMAND_BATCH_TOO_LARGE: at most 16 commands per work_execute');
  const cheap = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'cheap', 'execute');
  const inputs = commands.map((entry) => ({
    command: commandValue(normalizeRepositoryCommand(entry.command)),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    approvalToken: typeof entry.approval_token === 'string' ? entry.approval_token : undefined,
  }));
  const classifications = inputs.map((entry) => classifyRepositoryCommand(entry.command, cheap.repository.defaultBranch));
  const requiresFull = classifications.some((classification) => classification.risk !== 'readonly');
  if (requiresFull) validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'full', 'execute');
  const decisions: AuthorizationDecision[] = [];
  const approvalRequestId = typeof args.approval_request_id === 'string' ? args.approval_request_id.trim() : '';
  const resolvedRequest = approvalRequestId
    ? assertResolvedAuthorization({ controllerHome: ctx.controllerHome, repositoryId: handle.repositoryId, approvalRequestId, sessionId: session.sessionId, principalId: session.principalId, workId: handle.workId, permissionSnapshotVersion: handle.permissionSnapshotVersion, command: inputs[0]?.command })
    : undefined;
  for (const [index, entry] of inputs.entries()) {
    const classification = classifications[index]!;
    const outsideCwd = Boolean(entry.cwd && (isAbsolute(entry.cwd) || (() => {
      const rel = relative(resolve(handle.worktreePath), resolve(handle.worktreePath, entry.cwd));
      return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
    })()));
    const risk = outsideCwd ? 'outside_repository' : authorizationRisk(entry.command, classification);
    const decision = resolvedRequest
      ? { decision: 'allow', source: 'user_confirmation', reason: 'The user resolved the exact approval request for this command.' } as const
      : decideAuthorization({
        controllerHome: ctx.controllerHome,
        accessMode: readRepositoryAccessPolicy(ctx.controllerHome, handle.repositoryId).mode,
        risk,
        repositoryId: handle.repositoryId,
        currentRepositoryId: handle.repositoryId,
        workId: handle.workId,
        boundWorkId: handle.workId,
        goalId: handle.goalId,
        boundGoalId: handle.goalId,
        sessionId: session.sessionId,
        principalId: session.principalId,
        permissionSnapshotVersion: handle.permissionSnapshotVersion,
        delegation: session.goalDelegation,
        worktreePath: handle.worktreePath,
        cwd: entry.cwd,
        command: entry.command,
        approvedByUser: Boolean(resolvedRequest),
      });
    decisions.push(decision);
    if (decision.decision !== 'allow') return { authorization: decision, work: compactHandle(handle), command: entry.command };
  }
  const invocationId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : `invoke-${session.sessionId}-${handle.workId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const invocationFingerprint = createHash('sha256')
    .update(JSON.stringify({
      tool: 'work_execute',
      workId: handle.workId,
      commands: inputs.map((entry) => ({ command: entry.command, cwd: entry.cwd ?? null })),
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : null,
      maxOutputBytes: typeof args.max_output_bytes === 'number' ? args.max_output_bytes : null,
    }))
    .digest('hex');
  claimProcessInvocation({
    controllerHome: ctx.controllerHome,
    repoId: handle.repositoryId,
    checkoutId: handle.checkoutId,
    requestId: invocationId,
    invocationFingerprint,
  });
  const run = async (entry: typeof inputs[number], index: number) => {
    const commandId = `${invocationId}:command:${index + 1}`;
    const execution = await executeRepositoryCommandViaProcessRuntime({
      controllerHome: ctx.controllerHome,
      repository: cheap.worktreeRepository,
      executionIdentity: executionIdentityForWork(cheap.worktreeRepository, handle),
      command: entry.command,
      cwd: entry.cwd,
      workId: handle.workId,
      commandId,
      requestId: commandId,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      maxOutputBytes: typeof args.max_output_bytes === 'number' ? args.max_output_bytes : undefined,
    });
    const process = execution.process;
    const completed = process?.completed === true || execution.route === 'process_direct';
    const ok = process ? process.ok === true : execution.ok === true;
    const status = process
      ? (process.completed
        ? (process.cancelled ? 'cancelled' : process.timedOut ? 'timed_out' : ok ? 'executed' : 'failed')
        : 'running')
      : execution.route === 'durable'
        ? 'deferred_durable'
        : 'rejected';
    return {
      processId: process?.processId,
      commandId,
      requestId: commandId,
      status,
      ok,
      exitCode: process?.exitCode ?? execution.exitCode,
      timedOut: process?.timedOut === true,
      cancelled: process?.cancelled === true,
      startedAt: process?.startedAt,
      finishedAt: process?.completed ? process.startedAt : undefined,
      stdout: process?.stdout ?? execution.stdout,
      stderr: process?.stderr ?? execution.stderr,
      logArtifact: process?.processId ? { processId: process.processId, kind: 'process_logs' } : undefined,
      route: execution.route,
      reason: execution.reason,
      authorizationDecision: decisions[index],
      approvalRequestId: resolvedRequest?.approvalRequestId,
      authorization: decisions[index]?.decision === 'allow'
        ? (resolvedRequest ? 'confirmed_plan' : decisions[index]?.source)
        : 'explicit_user_request',
      durableSideEffects: execution.durableSideEffects,
      process,
    };
  };
  const started = performance.now();
  const executions = classifications.every((classification) => classification.risk === 'readonly')
    ? await Promise.all(inputs.map((entry, index) => run(entry, index)))
    : await (async () => {
      const ordered: Awaited<ReturnType<typeof run>>[] = [];
      for (const [index, entry] of inputs.entries()) {
        const execution = await run(entry, index);
        ordered.push(execution);
        // Do not launch another mutating command while this Work-owned Process
        // still owns workspace leases. The caller resumes through process_wait.
        if (execution.process && !execution.process.completed) break;
      }
      return ordered;
    })();
  const branch = repositoryGitStatus(cheap.worktreeRepository).branch;
  const head = gitHead(cheap.worktreeRepository.canonicalRoot);
  let nextHandle = handle;
  if (branch !== handle.branch) nextHandle = markWorkHandleFailed(ctx.controllerHome, handle, `command changed the bound branch to ${branch ?? 'detached'}`);
  else nextHandle = transitionWorkHandle(ctx.controllerHome, handle, 'editing', { expectedHead: head, failureReason: undefined });
  const value = {
    work: compactHandle(nextHandle),
    commands: executions,
    executedCount: executions.filter((entry) => entry.status === 'executed' && entry.ok === true).length,
    managedProcessCount: executions.filter((entry) => entry.process && !entry.process.completed).length,
    deferredCommandCount: Math.max(0, inputs.length - executions.length),
    authorization: decisions[0],
    requestId: invocationId,
  };
  const response = makeBoundedResult(ctx, session, handle.repositoryId, handle.workId, 'command', value);
  recordMcpTiming(ctx.controllerHome, { tool: 'work_execute', workHandleValidationMs: 0, commandExecutionMs: Math.round((performance.now() - started) * 100) / 100, totalToolDurationMs: Math.round((performance.now() - started) * 100) / 100, sessionId: session.sessionId, repoId: handle.repositoryId, workId: handle.workId });
  return response;
}

export function selectDefaultWorkValidationChecks(
  contract: ReturnType<typeof contractFor>,
  changedPaths: string[],
): string[] {
  if (!contract || changedPaths.length === 0) return [];
  if (contract.risk === 'medium' || contract.risk === 'high' || contract.risk === 'destructive') {
    return [...contract.checks];
  }
  const sourceTypeScriptChanged = changedPaths.some((path) =>
    /\.(?:ts|tsx|mts|cts)$/.test(path)
    && !/(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)/.test(path));
  return contract.checks.filter((checkId) => {
    const normalized = checkId.toLowerCase();
    if (normalized.includes('package:test') || normalized.includes('full') || normalized.includes('architecture') || normalized.includes('release') || normalized.includes('runtime')) {
      return false;
    }
    if (normalized.includes('type')) return sourceTypeScriptChanged;
    return normalized.includes('focused') || normalized.includes('unit') || normalized.includes('changed') || normalized.includes('target');
  });
}

async function validateWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = requireSession(ctx, args);
  const handle = workForSession(ctx, session, args, { reconcileValidation: false });
  const terminalOutcome = terminalCleanupOutcome(ctx, handle);
  if (terminalOutcome && args.cleanup !== false) {
    return await reconcileTerminalCleanup(ctx, session, handle, args, terminalOutcome);
  }
  const validated = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'full', 'validate');
  const contract = contractFor(ctx, handle);
  const changed = repositoryGitDiff(validated.worktreeRepository, { maxBytes: 64 * 1024 });
  const changedPaths = Array.isArray(changed.nameOnly) ? changed.nameOnly.map(String) : [];
  const requestedChecks = Array.isArray(args.check_ids)
    ? args.check_ids.map(String).filter(Boolean)
    : selectDefaultWorkValidationChecks(contract, changedPaths);
  const validationInvocationId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : `validate-${session.sessionId}-${handle.workId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const validationStatus = repositoryGitStatus(validated.worktreeRepository);
  const validationHead = validationStatus.head
    ?? handle.expectedHead
    ?? handle.baseCommit
    ?? 'unknown';
  const workspaceFingerprint = workspaceValidationFingerprint(
    validated.worktreeRepository.canonicalRoot,
    validationStatus,
  );
  const validationFingerprint = workValidationInputFingerprint(
    validationHead,
    workspaceFingerprint,
    requestedChecks,
  );
  const previousRun = handle.validationRun?.fingerprint === validationFingerprint
    ? handle.validationRun
    : undefined;
  let validationRun: NonNullable<WorkHandleState['validationRun']> = previousRun ?? {
    fingerprint: validationFingerprint,
    head: validationHead,
    workspaceFingerprint,
    requestedChecks,
    resumeState: handle.state === 'committed' || handle.state === 'merged' ? handle.state : 'editing',
    processes: {},
  };
  let current = transitionWorkHandle(ctx.controllerHome, handle, 'validating', {
    finalization: { ...handle.finalization, validation: 'pending', lastError: undefined },
    validationRun,
  });
  markWorkValidationPending(ctx.controllerHome, current);
  const available = new Set(listControllerChecks(validated.worktreeRepository.canonicalRoot).map((check) => check.id));
  const checks: Array<Record<string, unknown>> = [];
  for (const [index, checkId] of requestedChecks.entries()) {
    if (!available.has(checkId)) {
      checks.push({ checkId, ok: false, status: 'missing', summary: `Check not found: ${checkId}` });
      break;
    }
    const existingBinding = validationRun.processes[checkId];
    let process = existingBinding
      ? getCheckProcessHandle(ctx.controllerHome, handle.repositoryId, existingBinding.processId)
      : undefined;
    if (existingBinding && !process) {
      checks.push({
        checkId,
        ok: false,
        status: 'infrastructure_failure',
        summary: `Validation process record is unavailable: ${existingBinding.processId}`,
      });
      break;
    }
    if (!process) {
      const processRequestId = `${validationInvocationId}:check:${index + 1}`;
      const executed = await runPersistedCheckViaProcessRuntime({
        controllerHome: ctx.controllerHome,
        repoId: handle.repositoryId,
        checkoutId: handle.checkoutId,
        repoRoot: validated.worktreeRepository.canonicalRoot,
        executionIdentity: executionIdentityForWork(validated.worktreeRepository, handle),
        checkId,
        requestId: processRequestId,
        workId: handle.workId,
        commandId: processRequestId,
        verificationBinding: { executionSessionId: session.sessionId },
      });
      if (executed.mode === 'durable') {
        checks.push({ checkId, ok: undefined, status: 'deferred', summary: executed.durable?.reason, durable: executed.durable });
        break;
      }
      process = executed.process!;
      validationRun = {
        ...validationRun,
        processes: {
          ...validationRun.processes,
          [checkId]: { processId: process.processId, requestId: processRequestId },
        },
      };
      current = transitionWorkHandle(ctx.controllerHome, current, 'validating', { validationRun });
    }
    if (!process.completed) {
      checks.push({ checkId, ok: undefined, status: 'running', process });
      break;
    }
    const record = getProcessRecord(ctx.controllerHome, handle.repositoryId, process.processId);
    if (!record) {
      checks.push({ checkId, ok: false, status: 'infrastructure_failure', summary: `Validation process record is unavailable: ${process.processId}` });
      break;
    }
    const receipt = processCheckCompletionReceipt(record, {
      repoId: handle.repositoryId,
      checkoutId: handle.checkoutId,
      workId: handle.workId,
      executionSessionId: session.sessionId,
      checkId,
      processId: process.processId,
    });
    appendVerificationRecord({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, handle.workId, {
      checkId,
      outcome: receipt.ok ? 'valid_pass' : receipt.status === 'timed_out' || receipt.status === 'cancelled' ? 'infrastructure_failure' : 'valid_fail',
      summary: receipt.summary,
      recordedAt: receipt.finishedAt,
      sourceRevision: validationHead,
      workspaceFingerprint,
      verificationInputFingerprint: verificationInputFingerprint({
        sourceRevision: validationHead,
        workspaceFingerprint,
        checkId,
        requestedChecks,
        commandId: receipt.commandId,
      }),
      commandFingerprint: commandFingerprint(checkId, receipt.commandId),
      resultArtifactId: receipt.receiptId,
      startedAt: receipt.startedAt,
      completedAt: receipt.finishedAt,
      evidenceRef: { title: checkId, summary: `${receipt.receiptId}; artifact=${receipt.artifactPath}`, detailLevel: 'summary' },
      receipt,
    });
    checks.push({
      checkId,
      ok: receipt.ok,
      status: receipt.ok ? 'passed' : receipt.status === 'timed_out' || receipt.status === 'cancelled' ? 'infrastructure_failure' : 'failed',
      process,
      receipt,
    });
    if (!receipt.ok) break;
  }
  const infrastructureFailure = checks.find((check) => (
    check.status === 'missing'
    || check.status === 'infrastructure_failure'
    || check.status === 'deferred'
  ));
  const acceptedFailure = checks.find((check) => check.status === 'failed');
  const allObserved = checks.length === requestedChecks.length && checks.every((check) => check.ok !== undefined);
  const completed = Boolean(infrastructureFailure || acceptedFailure || allObserved);
  const passed = completed
    && !infrastructureFailure
    && !acceptedFailure
    && checks.every((check) => check.ok === true);
  const failureSummary = infrastructureFailure
    ? String(infrastructureFailure.summary ?? 'validation infrastructure failure')
    : acceptedFailure
      ? String(acceptedFailure.summary ?? 'targeted validation failed')
      : undefined;
  const nextState = !completed
    ? 'validating'
    : passed
      ? validationRun.resumeState
      : 'failed';
  const validation = !completed ? 'pending' : passed ? 'done' : 'failed';
  const next = transitionWorkHandle(ctx.controllerHome, current, nextState, {
    finalization: {
      ...current.finalization,
      validation,
      lastError: failureSummary,
    },
    validationRun: completed ? undefined : validationRun,
    ...(passed ? { validatedInputFingerprint: validationFingerprint } : {}),
    ...(failureSummary ? { failureReason: failureSummary } : { failureReason: undefined }),
  });
  if (completed) {
    projectWorkValidationOutcome(
      ctx.controllerHome,
      next,
      infrastructureFailure ? 'infrastructure_failure' : passed ? 'passed' : 'failed',
      failureSummary,
    );
  }
  if (completed && !passed) {
    const cleanup = await reconcileTerminalCleanup(
      ctx,
      session,
      next,
      args,
      infrastructureFailure ? 'infrastructure_failed' : 'validation_failed',
    );
    const value = {
      ...cleanup,
      validation: { passed, completed, checks, targeted: true, changedPaths, cleanupTriggered: true },
    };
    return makeBoundedResult(ctx, session, handle.repositoryId, handle.workId, 'validation', value);
  }
  const value = { work: compactHandle(next), validation: { passed, completed, checks, targeted: true, changedPaths } };
  return makeBoundedResult(ctx, session, handle.repositoryId, handle.workId, 'validation', value);
}

function runCleanup(targetRoot: string, worktreePath: string): { ok: boolean; message?: string } {
  if (targetRoot === worktreePath) return { ok: true };
  if (!existsSync(worktreePath)) return { ok: true, message: 'managed worktree already removed' };
  const status = repositoryGitStatus({ repoId: 'cleanup', activeCheckoutId: 'cleanup', canonicalRoot: worktreePath, localRoot: worktreePath, checkouts: [], schemaVersion: 1, displayName: basename(worktreePath), repositoryType: 'git', enabled: true, createdAt: '', updatedAt: '', lastSeenAt: '', configurationPath: '', stateStorageStrategy: 'controller-home' });
  if (!status.clean) return { ok: false, message: 'managed worktree is dirty; cleanup preserved it' };
  const process = spawnSync('git', ['-C', targetRoot, 'worktree', 'remove', worktreePath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return process.status === 0 ? { ok: true } : { ok: false, message: String(process.stderr ?? 'git worktree remove failed').trim() };
}

/**
 * Reconcile a stale Work Handle only for a cleanup-only request whose exact
 * branch HEAD is already reachable from the requested target branch.
 *
 * Two bounded recovery cases are supported:
 * 1. an older controller committed/merged successfully but failed before
 *    recording the finalization stages; and
 * 2. a terminal cancelled WorkContract owns an unchanged, clean duplicate
 *    worktree created by an idempotency defect.
 *
 * Missing worktrees are accepted only when this handle already recorded a
 * successful worktree cleanup. This lets a retry finish branch cleanup after a
 * crash without turning a missing checkout into proof of safety.
 */
function cleanupOnlyMergedHead(
  ctx: MultiRepositoryMcpToolContext,
  current: WorkHandleState,
  args: Record<string, unknown>,
): { currentHead: string; cancelledContract: boolean; worktreeMissing: boolean } | undefined {
  if (args.cleanup !== true || args.commit === true || args.merge === true || !current.managedWorktree) return undefined;
  const contract = contractFor(ctx, current);
  const cancelledContract = contract?.status === 'cancelled';

  const repository = getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const target = selectRepositoryCheckout(repository, current.sourceCheckoutId ?? repository.activeCheckoutId);
  const targetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : repository.defaultBranch || 'main';
  const branchHeadResult = spawnSync('git', ['-C', target.canonicalRoot, 'rev-parse', '--verify', `refs/heads/${current.branch}`], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  const currentHead = branchHeadResult.status === 0 ? String(branchHeadResult.stdout ?? '').trim() : '';
  if (!currentHead) return undefined;
  const merged = spawnSync('git', ['-C', target.canonicalRoot, 'merge-base', '--is-ancestor', currentHead, targetBranch], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (merged.status !== 0) return undefined;

  const worktreeMissing = !existsSync(current.worktreePath);
  if (worktreeMissing) {
    if (!cancelledContract || current.finalization.worktreeCleanup !== 'done') return undefined;
    return { currentHead, cancelledContract, worktreeMissing: true };
  }

  const worktree = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true });
  if (!repositoryGitStatus(worktree).clean) return undefined;
  const worktreeHead = gitHead(worktree.canonicalRoot);
  if (!worktreeHead || worktreeHead !== currentHead) return undefined;
  const currentBranch = spawnSync('git', ['-C', worktree.canonicalRoot, 'branch', '--show-current'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (currentBranch.status !== 0 || String(currentBranch.stdout ?? '').trim() !== current.branch) return undefined;
  if (current.expectedHead && currentHead === current.expectedHead && !cancelledContract) return undefined;
  if (current.expectedHead && currentHead !== current.expectedHead && cancelledContract) return undefined;
  return { currentHead, cancelledContract, worktreeMissing: false };
}

interface FailedCleanupProof {
  currentHead: string;
  worktreeMissing: boolean;
  targetBranch: string;
}

/**
 * Prove that a failed Work owns an unchanged, clean managed worktree whose
 * branch is already contained in the target branch. This authorizes resource
 * cleanup only; it never proves successful verification or delivery.
 */
function failedCleanupOnlyHead(
  ctx: MultiRepositoryMcpToolContext,
  current: WorkHandleState,
  args: Record<string, unknown>,
): FailedCleanupProof | undefined {
  if (
    current.state !== 'failed'
    || args.cleanup !== true
    || args.commit === true
    || args.merge === true
    || !current.managedWorktree
  ) return undefined;
  const contract = contractFor(ctx, current);
  if (contract?.status !== 'failed') return undefined;

  const expectedHead = current.expectedHead ?? current.baseCommit;
  if (!expectedHead) return undefined;
  const repository = getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const target = selectRepositoryCheckout(repository, current.sourceCheckoutId ?? repository.activeCheckoutId);
  const targetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : repository.defaultBranch || 'main';
  const merged = spawnSync('git', ['-C', target.canonicalRoot, 'merge-base', '--is-ancestor', expectedHead, targetBranch], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (merged.status !== 0) return undefined;

  const worktreeMissing = !existsSync(current.worktreePath);
  if (worktreeMissing) {
    return current.finalization.worktreeCleanup === 'done'
      ? { currentHead: expectedHead, worktreeMissing: true, targetBranch }
      : undefined;
  }

  const worktree = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true });
  if (resolve(worktree.canonicalRoot) !== resolve(current.worktreePath)) return undefined;
  if (!repositoryGitStatus(worktree).clean) return undefined;
  if (gitHead(worktree.canonicalRoot) !== expectedHead) return undefined;
  const currentBranch = spawnSync('git', ['-C', worktree.canonicalRoot, 'branch', '--show-current'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (currentBranch.status !== 0 || String(currentBranch.stdout ?? '').trim() !== current.branch) return undefined;
  return { currentHead: expectedHead, worktreeMissing: false, targetBranch };
}

function resetFailedFinalizationStages(stages: WorkFinalizationStages, wants: { commit: boolean; merge: boolean; cleanup: boolean }): WorkFinalizationStages {
  const next = { ...stages };
  let reset = false;
  if (next.validation === 'failed') {
    next.validation = 'pending';
    reset = true;
  }
  if (wants.commit && next.commit === 'failed') {
    next.commit = 'pending';
    reset = true;
  }
  if (wants.merge && next.merge === 'failed') {
    next.merge = 'pending';
    reset = true;
  }
  if (wants.cleanup && next.worktreeCleanup === 'failed') {
    next.worktreeCleanup = 'pending';
    reset = true;
  }
  if (wants.cleanup && next.branchCleanup === 'failed') {
    next.branchCleanup = 'pending';
    reset = true;
  }
  if (reset) delete next.lastError;
  return next;
}

function finalizationComplete(stages: WorkFinalizationStages): boolean {
  return stages.validation === 'done'
    && stages.commit !== 'pending'
    && stages.merge !== 'pending'
    && stages.branchCleanup !== 'pending'
    && stages.worktreeCleanup !== 'pending'
    && stages.commit !== 'failed'
    && stages.merge !== 'failed'
    && stages.branchCleanup !== 'failed'
    && stages.worktreeCleanup !== 'failed'
    && !stages.lastError;
}

function finalStateForStages(stages: WorkFinalizationStages, fallback: WorkHandleState['state']): WorkHandleState['state'] {
  if (stages.worktreeCleanup === 'done') return 'cleaned';
  if (stages.merge === 'done') return 'merged';
  if (stages.commit === 'done') return 'committed';
  return fallback === 'failed' ? 'editing' : fallback;
}

function currentWorkValidationInput(
  repository: RepositoryRecord,
  handle: WorkHandleState,
  requestedChecks: string[],
): { head: string; workspaceFingerprint: string; fingerprint: string; clean: boolean } {
  const status = repositoryGitStatus(repository);
  const head = status.head ?? handle.expectedHead ?? handle.baseCommit ?? 'unknown';
  const workspaceFingerprint = workspaceValidationFingerprint(repository.canonicalRoot, status);
  return {
    head,
    workspaceFingerprint,
    fingerprint: workValidationInputFingerprint(head, workspaceFingerprint, requestedChecks),
    clean: status.clean,
  };
}

async function finalizeWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = requireSession(ctx, args);
  let current = workForSession(ctx, session, args);
  const terminalOutcome = terminalCleanupOutcome(ctx, current);
  if (terminalOutcome && args.cleanup !== false) {
    return await reconcileTerminalCleanup(ctx, session, current, args, terminalOutcome);
  }
  assertWorkControllerOwnership(ctx, session, current, args);
  if (current.state === 'cleaned') {
    const terminalContract = contractFor(ctx, current);
    if (
      terminalContract?.status === 'failed'
      && current.finalization.validation === 'failed'
      && current.finalization.worktreeCleanup === 'done'
    ) {
      releasePreparedWorkOwnership(ctx, current);
      updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
        activeWorkId: undefined,
        activeCheckoutId: current.sourceCheckoutId ?? session.activeCheckoutId,
      });
      return {
        idempotent: true,
        work: compactHandle(current),
        stages: current.finalization,
        completed: false,
        cleanupCompleted: true,
        failurePreserved: true,
      };
    }
    validateWorkHandle(ctx.controllerHome, current, identityFor(ctx, args), 'none', 'finalize');
    return { idempotent: true, work: compactHandle(current) };
  }
  const identity = identityFor(ctx, args);
  const requestedOutcome = args.completion_outcome === 'completed_no_change' || args.completion_outcome === 'completed_changed'
    ? args.completion_outcome
    : undefined;
  const noChangeProof = typeof args.no_change_evidence === 'string' ? args.no_change_evidence.trim().slice(0, 1_000) : '';
  if (requestedOutcome === 'completed_no_change' && (!noChangeProof || args.commit === true || args.merge === true)) {
    throw new Error('WORK_NO_CHANGE_PROOF_REQUIRED: completed_no_change requires objective-specific evidence and forbids commit/merge');
  }
  const wants = { commit: args.commit === true, merge: args.merge === true, cleanup: args.cleanup === true };

  const transact = (label: string, update: (fresh: WorkHandleState) => WorkHandleState): WorkHandleState =>
    withControllerLock(ctx.controllerHome, { scope: 'worktree', repoId: current.repositoryId, worktreeId: current.checkoutId }, `work-finalize:${current.workId}:${label}`, () => {
      const fresh = readWorkHandle(ctx.controllerHome, current.repositoryId, current.workId) ?? current;
      return update(fresh);
    }, 10_000);

  const failStage = (stage: keyof WorkFinalizationStages, reason: string): Record<string, unknown> => {
    current = transact(`fail:${String(stage)}`, (fresh) => {
      const finalization = { ...fresh.finalization, [stage]: 'failed', lastError: reason } as WorkFinalizationStages;
      return markWorkHandleFailed(ctx.controllerHome, { ...fresh, finalization }, reason);
    });
    if (current.workContractId) updateWorkContract({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId, { status: 'failed' });
    markRepositoryProjectionDirty(ctx.controllerHome, current.repositoryId, `cleanup:${current.workId}:failed`);
    return { work: compactHandle(current), stages: current.finalization, completed: false };
  };

  const failedCleanupRequested = current.state === 'failed'
    && wants.cleanup
    && !wants.commit
    && !wants.merge;
  const failedCleanupProof = failedCleanupRequested
    ? failedCleanupOnlyHead(ctx, current, args)
    : undefined;
  if (failedCleanupRequested && !failedCleanupProof) {
    throw new Error('WORK_FAILED_CLEANUP_UNSAFE: failed Work cleanup requires exact checkout/branch ownership and an unchanged clean controller-owned managed worktree whose exact HEAD is already contained in the target branch');
  }

  if (!failedCleanupRequested) {
    current = transact('begin', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      state: fresh.state === 'failed' ? 'validating' : fresh.state,
      failureReason: undefined,
      finalization: resetFailedFinalizationStages(fresh.finalization, wants),
    }));
  }

  const approvalRequestId = typeof args.approval_request_id === 'string' ? args.approval_request_id.trim() : '';
  const resolvedAuthorization = approvalRequestId
    ? assertResolvedAuthorization({ controllerHome: ctx.controllerHome, repositoryId: current.repositoryId, approvalRequestId, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, permissionSnapshotVersion: current.permissionSnapshotVersion, command: 'work_finalize' })
    : undefined;
  const gitAuthorization = resolvedAuthorization
    ? { decision: 'allow', source: 'user_confirmation', reason: 'The user resolved the exact finalization approval request.' } as const
    : decideAuthorization({
      controllerHome: ctx.controllerHome,
      accessMode: readRepositoryAccessPolicy(ctx.controllerHome, current.repositoryId).mode,
      risk: 'local_git',
      repositoryId: current.repositoryId,
      currentRepositoryId: current.repositoryId,
      workId: current.workId,
      boundWorkId: current.workId,
      goalId: current.goalId,
      boundGoalId: current.goalId,
      sessionId: session.sessionId,
      principalId: session.principalId,
      permissionSnapshotVersion: current.permissionSnapshotVersion,
      delegation: session.goalDelegation,
      command: 'work_finalize',
    });
  if (gitAuthorization.decision !== 'allow') return { authorization: gitAuthorization, work: compactHandle(current), stages: current.finalization };

  if (failedCleanupProof) {
    const preservedFailure = current.failureReason ?? current.finalization.lastError ?? 'Work validation failed.';
    current = transact('failed-cleanup-begin', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      state: 'failed',
      failureReason: preservedFailure,
      finalization: {
        ...fresh.finalization,
        validation: 'failed',
        commit: fresh.finalization.commit === 'pending' ? 'skipped' : fresh.finalization.commit,
        merge: fresh.finalization.merge === 'pending' ? 'skipped' : fresh.finalization.merge,
        branchCleanup: args.delete_branch === false ? 'skipped' : fresh.finalization.branchCleanup,
        lastError: preservedFailure,
      },
    }));

    if (!failedCleanupProof.worktreeMissing && current.finalization.worktreeCleanup !== 'done') {
      const target = selectRepositoryCheckout(
        getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true }),
        current.sourceCheckoutId ?? current.checkoutId,
      );
      const cleanup = runCleanup(target.canonicalRoot, current.worktreePath);
      if (!cleanup.ok) {
        throw new Error(`WORK_FAILED_CLEANUP_UNSAFE: ${cleanup.message ?? 'managed worktree cleanup failed'}`);
      }
      current = transact('failed-worktree-cleanup-done', (fresh) => {
        setRepositoryCheckoutLifecycle({
          controllerHome: ctx.controllerHome,
          repoId: fresh.repositoryId,
          checkoutId: fresh.checkoutId,
          lifecycle: 'removed',
          reason: `Failed Work ${fresh.workId} cleanup completed without changing delivery state.`,
        });
        markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:failed-worktree`);
        return writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          state: 'failed',
          failureReason: preservedFailure,
          finalization: { ...fresh.finalization, worktreeCleanup: 'done', lastError: preservedFailure },
        });
      });
    }

    if (args.delete_branch !== false && current.finalization.branchCleanup !== 'done') {
      const target = selectRepositoryCheckout(
        getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true }),
        current.sourceCheckoutId ?? current.checkoutId,
      );
      const deleted = repositoryGitDeleteBranch(ctx.controllerHome, target, {
        branch: current.branch,
        force: false,
        authorizationDecision: gitAuthorization,
        sessionId: session.sessionId,
        principalId: session.principalId,
        workId: current.workId,
        goalId: current.goalId,
      });
      if (deleted.execution.authorizationDecision?.decision === 'user_confirmation_required') {
        return { authorization: deleted.execution.authorizationDecision, work: compactHandle(current), stages: current.finalization };
      }
      if (deleted.execution.status !== 'executed' || deleted.execution.ok !== true) {
        current = transact('failed-branch-cleanup-failed', (fresh) => writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          state: 'failed',
          failureReason: preservedFailure,
          finalization: {
            ...fresh.finalization,
            branchCleanup: 'failed',
            lastError: String(deleted.execution.stderr || 'feature branch cleanup failed').slice(0, 1_000),
          },
        }));
        return {
          work: compactHandle(current),
          stages: current.finalization,
          completed: false,
          cleanupCompleted: false,
          failurePreserved: true,
        };
      }
      current = transact('failed-branch-cleanup-done', (fresh) => {
        markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:failed-branch`);
        return writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          state: 'failed',
          failureReason: preservedFailure,
          finalization: { ...fresh.finalization, branchCleanup: 'done', lastError: preservedFailure },
        });
      });
    }

    current = transact('failed-cleanup-complete', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'cleaned', {
      failureReason: preservedFailure,
      finalization: {
        ...fresh.finalization,
        validation: 'failed',
        commit: fresh.finalization.commit === 'pending' ? 'skipped' : fresh.finalization.commit,
        merge: fresh.finalization.merge === 'pending' ? 'skipped' : fresh.finalization.merge,
        branchCleanup: args.delete_branch === false ? 'skipped' : fresh.finalization.branchCleanup,
        worktreeCleanup: 'done',
        lastError: preservedFailure,
      },
    }));
    appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
      title: 'failed work cleanup completed',
      summary: `Controller preserved the failed Work outcome while removing its unchanged clean managed worktree and ${args.delete_branch === false ? 'retaining' : 'removing'} the local branch after proving ${failedCleanupProof.currentHead} is contained in ${failedCleanupProof.targetBranch}.`,
      detailLevel: 'summary',
    });
    releasePreparedWorkOwnership(ctx, current);
    updateExecutionSession(ctx.controllerHome, identity, {
      activeWorkId: undefined,
      activeCheckoutId: current.sourceCheckoutId ?? session.activeCheckoutId,
    });
    return {
      work: compactHandle(current),
      stages: current.finalization,
      completed: false,
      cleanupCompleted: true,
      failurePreserved: true,
      idempotent: false,
    };
  }

  const contractAtStart = contractFor(ctx, current);
  const cancelledCleanupRequested = contractAtStart?.status === 'cancelled'
    && wants.cleanup
    && !wants.commit
    && !wants.merge;
  const cleanupReconciliation = cleanupOnlyMergedHead(ctx, current, args);
  if (cancelledCleanupRequested && !cleanupReconciliation) {
    throw new Error('WORK_CANCELLED_CLEANUP_UNSAFE: cancelled Work cleanup requires an unchanged clean managed worktree (or a previously recorded cleanup) and a branch HEAD already contained in the target branch');
  }
  if (cleanupReconciliation) {
    current = transact('cleanup-reconcile-merged-head', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      expectedHead: cleanupReconciliation.currentHead,
      state: 'merged',
      failureReason: undefined,
      finalization: {
        ...fresh.finalization,
        validation: cleanupReconciliation.worktreeMissing ? 'done' : fresh.finalization.validation,
        commit: fresh.finalization.commit === 'pending' ? 'skipped' : fresh.finalization.commit,
        merge: 'done',
        branchCleanup: args.delete_branch === false ? 'skipped' : 'pending',
        lastError: undefined,
      },
    }));
  }

  const terminalCleanupOnly = Boolean(cleanupReconciliation && wants.cleanup && !wants.commit && !wants.merge);
  if (terminalCleanupOnly) {
    current = transact('terminal-cleanup-validation-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      finalization: { ...fresh.finalization, validation: 'done', lastError: undefined },
    }));
  } else {
    let validatedRepository: RepositoryRecord;
    try {
      validatedRepository = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize').worktreeRepository;
    } catch (error) {
      return failStage('validation', error instanceof Error ? error.message : String(error));
    }
    const validationContract = contractFor(ctx, current);
    if (!validationContract) throw new Error(`WORK_VALIDATION_CONTRACT_MISSING: ${current.workContractId ?? current.workId}`);
    const validationInput = currentWorkValidationInput(validatedRepository, current, validationContract.checks);
    if (validationContract.checks.length === 0) {
      current = transact('validation-no-checks', (fresh) => writeWorkHandle(ctx.controllerHome, {
        ...fresh,
        validatedInputFingerprint: validationInput.fingerprint,
        finalization: { ...fresh.finalization, validation: 'done', lastError: undefined },
      }));
      projectWorkValidationOutcome(ctx.controllerHome, current, 'passed', 'No validation checks were required.');
    } else if (!hasCurrentWorkValidationAuthority({
      finalizationValidation: current.finalization.validation,
      validatedInputFingerprint: current.validatedInputFingerprint,
      evidenceState: validationContract.evidenceState,
      expectedFingerprint: validationInput.fingerprint,
    })) {
      current = transact('validation-required', (fresh) => writeWorkHandle(ctx.controllerHome, {
        ...fresh,
        validatedInputFingerprint: undefined,
        finalization: { ...fresh.finalization, validation: 'pending', lastError: undefined },
      }));
      markWorkValidationPending(ctx.controllerHome, current);
      throw new Error('WORK_VALIDATION_REQUIRED: run work_validate against the exact current workspace before finalization');
    }
    if (wants.merge && !wants.commit && current.finalization.commit !== 'done' && !validationInput.clean) {
      throw new Error('WORK_MERGE_UNCOMMITTED_CHANGES: commit the validated workspace before merging');
    }
  }

  if (requestedOutcome === 'completed_no_change') {
    const inspected = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize');
    if (!repositoryGitStatus(inspected.worktreeRepository).clean) {
      throw new Error('WORK_NO_CHANGE_DIRTY: completed_no_change cannot retain an owned dirty worktree');
    }
  }

  if (wants.commit && current.finalization.commit === 'pending') {
    const validated = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize');
    const contract = contractFor(ctx, current);
    if (contract?.constraints.allowCommit === false) throw new Error('WORK_COMMIT_NOT_ALLOWED: WorkContract disallows commit');
    const status = repositoryGitStatus(validated.worktreeRepository);
    const commitPaths = [...new Set([...status.staged, ...status.unstaged, ...status.untracked])];
    const committed = repositoryGitCommit(ctx.controllerHome, validated.worktreeRepository, { message: String(args.message ?? `Complete ${current.workId}`), paths: commitPaths, allowEmpty: false, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
    const pendingAuthorization = [committed.stage, committed.commit].find((execution) => execution?.authorizationDecision?.decision === 'user_confirmation_required')?.authorizationDecision;
    if (pendingAuthorization) return { authorization: pendingAuthorization, work: compactHandle(current), stages: current.finalization };
    if (!committed.committed) return { ...failStage('commit', committed.error?.message ?? 'commit failed'), commit: committed };
    current = transact('commit-done', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'committed', {
      expectedHead: gitHead(validated.worktreeRepository.canonicalRoot),
      finalization: {
        ...fresh.finalization,
        validation: contract?.checks.length ? 'pending' : 'done',
        commit: 'done',
        lastError: undefined,
      },
      validatedInputFingerprint: contract?.checks.length ? undefined : fresh.validatedInputFingerprint,
      failureReason: undefined,
    }));
    if (contract?.checks.length) {
      markWorkValidationPending(ctx.controllerHome, current);
      return {
        work: compactHandle(current),
        stages: current.finalization,
        completed: false,
        continuation: 'WORK_COMMITTED_REVALIDATION_REQUIRED: run work_validate on the exact committed HEAD before merge or completion',
      };
    }
    const postCommitInput = currentWorkValidationInput(validated.worktreeRepository, current, []);
    current = transact('commit-no-checks-validation', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      expectedHead: postCommitInput.head,
      validatedInputFingerprint: postCommitInput.fingerprint,
    }));
    projectWorkValidationOutcome(ctx.controllerHome, current, 'passed', 'No validation checks were required after commit.');
  } else if (!wants.commit && current.finalization.commit === 'pending') {
    current = transact('commit-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, commit: 'skipped' } }));
  }

  if (wants.merge && current.finalization.merge === 'pending') {
    validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize');
    const contract = contractFor(ctx, current);
    if (contract?.constraints.allowMerge === false) throw new Error('WORK_MERGE_NOT_ALLOWED: WorkContract disallows merge');
    const target = selectRepositoryCheckout(getRepository(current.repositoryId, ctx.controllerHome), current.sourceCheckoutId ?? current.checkoutId);
    const deleteAfterWorktreeCleanup = current.managedWorktree && args.delete_branch !== false;
    const merged = repositoryGitFinishWorkflow(ctx.controllerHome, target, { featureBranch: current.branch, targetBranch: typeof args.target_branch === 'string' ? args.target_branch : undefined, deleteBranch: !deleteAfterWorktreeCleanup && args.delete_branch !== false, noFf: args.no_ff === true, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
    const pendingAuthorization = merged.steps.find((step) => step.execution.authorizationDecision?.decision === 'user_confirmation_required')?.execution.authorizationDecision;
    if (pendingAuthorization) return { authorization: pendingAuthorization, work: compactHandle(current), stages: current.finalization };
    if (!merged.completed) return { ...failStage('merge', merged.error?.message ?? 'merge failed'), merge: merged };
    current = transact('merge-done', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'merged', {
      finalization: { ...fresh.finalization, merge: 'done', branchCleanup: args.delete_branch === false ? 'skipped' : deleteAfterWorktreeCleanup ? 'pending' : 'done', lastError: undefined },
      failureReason: undefined,
    }));
  } else if (!wants.merge && current.finalization.merge === 'pending') {
    current = transact('merge-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, merge: 'skipped', branchCleanup: 'skipped' } }));
  }

  if (wants.cleanup && current.finalization.worktreeCleanup === 'pending') {
    const contract = contractFor(ctx, current);
    if (contract?.constraints.allowCleanup === false) throw new Error('WORK_CLEANUP_NOT_ALLOWED: WorkContract disallows cleanup');
    if (!current.managedWorktree) {
      current = transact('worktree-cleanup-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, worktreeCleanup: 'skipped' } }));
    } else {
      const target = selectRepositoryCheckout(getRepository(current.repositoryId, ctx.controllerHome), current.sourceCheckoutId ?? current.checkoutId);
      const cleanup = runCleanup(target.canonicalRoot, current.worktreePath);
      if (!cleanup.ok) return failStage('worktreeCleanup', cleanup.message ?? 'worktree cleanup failed');
      current = transact('worktree-cleanup-done', (fresh) => {
        setRepositoryCheckoutLifecycle({ controllerHome: ctx.controllerHome, repoId: fresh.repositoryId, checkoutId: fresh.checkoutId, lifecycle: 'removed', reason: `Work ${fresh.workId} cleanup completed.` });
        markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:worktree`);
        return writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, worktreeCleanup: 'done', lastError: undefined } });
      });
    }
  } else if (!wants.cleanup && current.finalization.worktreeCleanup === 'pending') {
    current = transact('worktree-cleanup-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, worktreeCleanup: 'skipped' } }));
  }

  if (wants.cleanup && current.finalization.branchCleanup === 'pending' && current.finalization.merge === 'done') {
    const target = selectRepositoryCheckout(getRepository(current.repositoryId, ctx.controllerHome), current.sourceCheckoutId ?? current.checkoutId);
    const deleted = repositoryGitDeleteBranch(ctx.controllerHome, target, { branch: current.branch, force: false, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
    if (deleted.execution.authorizationDecision?.decision === 'user_confirmation_required') return { authorization: deleted.execution.authorizationDecision, work: compactHandle(current), stages: current.finalization };
    if (deleted.execution.status !== 'executed' || deleted.execution.ok !== true) return failStage('branchCleanup', deleted.execution.stderr || 'feature branch cleanup failed');
    current = transact('branch-cleanup-done', (fresh) => {
      markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:branch`);
      return writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, branchCleanup: 'done', lastError: undefined } });
    });
  }

  const complete = finalizationComplete(current.finalization);
  if (complete) {
    const finalState = finalStateForStages(current.finalization, current.state);
    current = transact('complete', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, finalState, { finalization: current.finalization, failureReason: undefined }));
    const completedContract = contractFor(ctx, current);
    if (completedContract?.status === 'cancelled') {
      appendWorkEvidence(
        { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
        completedContract.workId,
        {
          title: 'cancelled work cleanup completed',
          summary: 'Controller verified terminal ownership, a clean or previously removed managed worktree, and a branch HEAD already contained in the target branch before deleting retained workspace references.',
          detailLevel: 'summary',
        },
      );
    } else {
      const workId = current.workContractId ?? current.workId;
      const completionContract = contractFor(ctx, current);
      if (!completionContract) throw new Error(`WORK_COMPLETION_CONTRACT_MISSING: ${workId}`);
      if (requestedOutcome === 'completed_no_change') {
        appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, workId, {
          title: 'objective-specific no-change proof',
          summary: noChangeProof,
          detailLevel: 'summary',
        });
      }
      const receipt = completionReceiptForFinalizedWork(ctx, current, completionContract, args);
      const recorded = recordWorkCompletionReceipt(
        { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
        workId,
        receipt,
        requestedOutcome === 'completed_no_change' ? 'completed_no_change' : 'completed_changed',
        requestedOutcome === 'completed_no_change' ? 'completed_no_change' : 'repository_change',
      );
      if (recorded.requirementId) {
        completeRequirementFromWork(
          { controllerHome: ctx.controllerHome },
          { requirementId: recorded.requirementId, work: recorded },
        );
      }
    }
    // Successful WorkContract completion always ends controller ownership.
    // Physical branch/worktree retention is represented by finalization stages
    // and completion-receipt warnings; it must not keep a mutation owner live.
    releasePreparedWorkOwnership(ctx, current);
    updateExecutionSession(ctx.controllerHome, identity, {
      activeWorkId: undefined,
      activeCheckoutId: current.sourceCheckoutId ?? session.activeCheckoutId,
    });
  }
  return { work: compactHandle(current), stages: current.finalization, completed: complete, idempotent: !wants.commit && !wants.merge && !wants.cleanup && current.finalization.validation === 'done' };
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
