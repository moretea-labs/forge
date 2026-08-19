import { bindRepositoryEntities } from '../repositories/entity-migration';
import { bootstrapLocalProject, diagnoseLatestLocalProjectSource } from '../repositories/local-project-onboarding';
import { resolveEphemeralWorkspaceTarget } from '../repositories/ephemeral-workspace';
import type { ResolvedExecutionIdentity } from '../../runtime/control-plane/execution/execution-identity';
import { readExecutionSession } from '../../runtime/control-plane/execution/session-store';
import { getWorkContract } from '../../runtime/control-plane/facade/work-contract-store';
import { getControllerSession, listControllerSessions } from '../../runtime/control-plane/facade/controller-session-store';
import { isTerminalWorkContractStatus } from '../../runtime/control-plane/facade/types';
import { executeRepositoryCommand, previewRepositoryCommandExecution } from '../repositories/command-executor';
import { withControllerLock } from '../repositories/locks';
import {
  disableRepository,
  findIdenticalRepositoryRegistration,
  getRepository,
  listRepositories,
  reconcileRepositoryCheckouts,
  refreshRepository,
  registerRepository,
  removeRepository,
  repositorySummary,
  resolveRepositorySelection,
  updateRepository,
  validateRepository,
} from '../repositories/registry';
import { buildControllerWorkbench } from '../repositories/workbench';
import { applySafePatch, buildSafePatchPlan } from '../repositories/safe-patch';
import { getEditSessionDiff, type EditSessionBinding } from '../editing/edit-session';
import { buildSyncOperationDigest, classifyUserFacingError } from '../../runtime/control-plane/facade/operation-digest';
import { diagnoseRepositoryStuckState, listRepositoryGoalRuns, readRepositoryGoalRegistry, runRepositoryGoal, upsertRepositoryGoal } from '../repositories/goal-registry';
import {
  repositoryGitCommit,
  repositoryGitCreateBranch,
  repositoryGitDeleteBranch,
  repositoryGitDiff,
  repositoryGitFinishWorkflow,
  repositoryGitMergeBranch,
  repositoryGitStatus,
  repositoryGitSwitchBranch,
} from '../repositories/structured-git';
import {
  readRepositoryGitStatusSample,
  writeRepositoryGitStatusSample,
} from '../../runtime/projections/git-status-sampler';
import {
  executeLightweightLanes,
  executeRepositoryBatch,
  integratePatchProposals,
  listFastReceipts,
  readFastReceipt,
  routeExecution,
} from '../../runtime/execution/thin-harness';
import {
  classifyRepositoryCommandRoute,
  executeRepositoryCommandViaProcessRuntime,
} from '../../runtime/execution/process-runtime/command-facade';
import { assessWorkMode, parseExplicitTaskMode } from '../controller/work-mode';
import { normalizeRepositoryCommand } from '../repositories/command-normalization';
import { readRepositoryRange } from '../repository/inspector';
import { getMcpPolicy } from './policy';
import { redactMcpText } from './redaction';
import type { CallToolResult, McpToolDefinition } from './tools';
import {
  boundUtf8,
  compactCommandOutput,
  compactErrorMessage,
  compactRoutingSummary,
  RESPONSE_BUDGET,
} from '../../runtime/shared/response-budget';

export type RepositoryToolResult = CallToolResult;

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  readOnlyHint = false,
  destructiveHint = false,
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: { readOnlyHint, openWorldHint: false, destructiveHint },
  };
}

const repoId = { type: 'string', description: 'Stable Repository Registry repoId.' };

export const repositoryToolDefinitions: McpToolDefinition[] = [
  definition('repository_register', 'Register a Git repository with the Controller.', {
    path: { type: 'string' },
    display_name: { type: 'string' },
    remote_url: { type: 'string' },
    default_branch: { type: 'string' },
    detail_level: { type: 'string', enum: ['summary', 'detail'], description: 'Defaults to summary; detail returns full checkout and migration evidence.' },
  }, ['path']),
  definition('repository_latest_source_diagnose', 'Read-only diagnosis that compares sibling project directories and recommends the latest usable source tree.', {
    path: { type: 'string', description: 'Absolute local project path.' },
    repo_id: repoId,
  }, [], true),
  definition('repository_bootstrap_local_project', 'Safely initialize and optionally register a trusted non-Git local project directory.', {
    path: { type: 'string', description: 'Absolute local project path.' },
    display_name: { type: 'string' },
    default_branch: { type: 'string' },
    mode: { type: 'string', enum: ['init_git_only', 'init_git_and_register', 'replace_registration'] },
    replace_registered_repo_id: repoId,
    confirm_authorization: { type: 'boolean', description: 'Must be true to authorize Git initialization and registration.' },
  }, ['path', 'confirm_authorization'], false, true),
  definition('repository_list', 'List registered repositories.', {
    include_removed: { type: 'boolean' },
  }, [], true),
  definition('repository_get', 'Inspect one registered repository.', {
    repo_id: repoId,
    include_removed: { type: 'boolean' },
    detail_level: { type: 'string', enum: ['summary', 'detail'], description: 'Defaults to summary; detail returns the complete checkout history.' },
  }, ['repo_id'], true),
  definition('read_repository_file', 'Read a line range from one policy-readable repository file.', {
    repo_id: repoId,
    checkout_id: { type: 'string' },
    path: { type: 'string' },
    start_line: { type: 'number' },
    end_line: { type: 'number' },
  }, ['path'], true),
  definition('repository_validate', 'Validate repository identity and migrate legacy ownership.', {
    repo_id: repoId,
    detail_level: { type: 'string', enum: ['summary', 'detail'], description: 'Defaults to summary; detail returns full migration evidence.' },
  }, ['repo_id']),
  definition('repository_refresh', 'Refresh repository Git and checkout metadata.', {
    repo_id: repoId,
    detail_level: { type: 'string', enum: ['summary', 'detail'], description: 'Defaults to summary; detail returns full checkout and migration evidence.' },
  }, ['repo_id']),
  definition('repository_update', 'Update mutable repository metadata.', {
    repo_id: repoId,
    display_name: { type: 'string' },
    default_branch: { type: 'string' },
    enabled: { type: 'boolean' },
  }, ['repo_id']),
  definition('repository_disable', 'Disable new execution while retaining audit history.', {
    repo_id: repoId,
  }, ['repo_id']),
  definition('repository_remove', 'Soft-remove a repository while retaining audit history.', {
    repo_id: repoId,
  }, ['repo_id'], true),
  definition('repository_workbench', 'Return Workbench state or invoke one bounded Thin Harness operation without adding top-level MCP tools. Prefer batch_execute for multi-step status→search→read→diff or read→patch→check flows so ChatGPT pays one routing/receipt ownership cycle.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repository-scoped operations.' },
    include_removed: { type: 'boolean' },
    operation: {
      type: 'string',
      enum: ['summary', 'batch_execute', 'lanes_execute', 'lanes_integrate', 'fast_receipt_get', 'fast_receipt_list', 'execution_route', 'assess_work_mode'],
      description: 'Defaults to summary. Use batch_execute for multi-step Fast Path (one parent receipt). Use lanes_execute for limited parallel reads. Use assess_work_mode for Fast/Durable routing advice.',
    },
    payload: {
      type: 'object',
      description: 'Operation-specific bounded arguments. Batch write operations should include request_id. For batch_execute: { steps:[{id?, kind, input}], stop_on_error?, allowed_paths?, timeout_ms?, request_id?, purpose? }. For assess_work_mode: { description, known_paths?, expected_files?, requires_parallelism?, independent_task_count?, agent_requested? }. Agent routing is opt-in only.',
      additionalProperties: true,
    },
  }),



  definition('repository_goal_list', 'List durable repository goals stored inside the checkout.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
  }, [], true),
  definition('repository_goal_upsert', 'Create or update one durable repository goal for repeated assistant workflows.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['active', 'paused', 'done'] },
    checks: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  }, []),
  definition('repository_stuck_diagnose', 'Diagnose likely repository workflow blockers from Git state and registered goals.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
  }, [], true),
  definition('repository_goal_run', 'Run one durable repository goal iteration, optionally executing its configured checks and recording a goal-run artifact.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    goal_id: { type: 'string', description: 'Goal id. Defaults to the first active goal.' },
    run_checks: { type: 'boolean', description: 'When true, execute configured checks. Defaults to diagnosis-only.' },
  }, []),
  definition('repository_goal_runs', 'List recent repository goal-run artifacts.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    limit: { type: 'number' },
  }, [], true),

  definition('repository_git_status', 'Return a structured Git status snapshot for the selected repository checkout.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    refresh: { type: 'boolean', description: 'When true, explicitly refresh the Git status sample. The default public hot path only reads the latest daemon sample.' },
  }, [], true),

  definition('repository_git_diff', 'Return a bounded structured git diff for the selected repository, optionally staged and path-scoped.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    staged: { type: 'boolean' },
    paths: { type: 'array', items: { type: 'string' } },
    max_bytes: { type: 'number' },
  }, [], true),
  definition('repository_git_create_branch', 'Create a safe local Git branch, optionally switching to it.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
    start_point: { type: 'string' },
    switch_to: { type: 'boolean', description: 'Defaults to true. False creates the branch without switching.' },
  }, ['branch']),
  definition('repository_git_switch_branch', 'Switch to a safe local Git branch name.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
  }, ['branch']),
  definition('repository_git_merge_branch', 'Merge a branch into the current branch using --ff-only by default.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
    no_ff: { type: 'boolean', description: 'Use --no-ff instead of the default --ff-only.' },
  }, ['branch']),
  definition('repository_git_delete_branch', 'Delete a safe local Git branch after it has been merged or intentionally discarded.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
    force: { type: 'boolean' },
  }, ['branch']),

  definition('repository_git_commit', 'Stage optional explicit paths and commit through a structured Git action.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    message: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    allow_empty: { type: 'boolean' },
  }, ['message']),
  definition('repository_git_finish_workflow', 'Finish the current feature workflow: require clean tree, switch to target, merge feature branch, and delete it by default.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    feature_branch: { type: 'string', description: 'Defaults to the current branch.' },
    target_branch: { type: 'string', description: 'Defaults to repository defaultBranch or main.' },
    delete_branch: { type: 'boolean', description: 'Defaults to true.' },
    no_ff: { type: 'boolean', description: 'Use --no-ff instead of the default --ff-only.' },
  }, []),
  definition('repository_safe_patch_plan', 'Plan a deterministic chunked repository patch with fresh file fingerprints before applying.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    operations: { type: 'array', items: { type: 'object' }, description: 'Edit operations using the same shape as apply_patch.' },
    chunk_size: { type: 'number', description: 'Maximum operations per deterministic chunk. Capped at 100.' },
  }, ['operations'], true),
  definition('repository_safe_patch_apply', 'Apply one coherent deterministic edit batch and return bounded review evidence. Checks are opt-in: pass check_ids only when the batch is stable. Long checks return managed Process handles instead of blocking the MCP call; use validation_only with the returned session/request ids to join later without replaying the patch.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    work_id: { type: 'string', description: 'Optional durable Work identity. Workflow controllers should pass the exact claimed Work id so attribution survives transient MCP transport sessions.' },
    session_id: { type: 'string', description: 'Existing edit session id. Required for validation_only; otherwise omit to create one.' },
    purpose: { type: 'string', description: 'Purpose for a newly created edit session.' },
    operations: { type: 'array', items: { type: 'object' }, description: 'Edit operations using the same shape as apply_patch. Required unless validation_only=true.' },
    chunk_size: { type: 'number', description: 'Maximum operations per deterministic chunk. Capped at 100.' },
    expected_revision: { type: 'number', description: 'Expected starting edit-session revision.' },
    allowed_paths: { type: 'array', items: { type: 'string' }, description: 'Optional allowed path globs for a newly created session.' },
    continue_on_error: { type: 'boolean', description: 'Continue applying later independent chunks after a failed chunk. Defaults to false.' },
    refresh_fingerprints: { type: 'boolean', description: 'Refresh file fingerprints before every chunk. Defaults to true.' },
    recover_stale_session: { type: 'boolean', description: 'For new sessions, recover stale edit-session fingerprints into a fresh session. Defaults to true.' },
    check_ids: { type: 'array', items: { type: 'string' }, description: 'Optional focused validation for this stable coherent edit batch. Omit to edit without running tests.' },
    check_timeout_ms: { type: 'number', description: 'Per-check execution budget. Long checks still return managed handles immediately.' },
    lease_wait_ms: { type: 'number', description: 'Bounded resource-lease wait for conflicting validation lanes.' },
    validation_request_id: { type: 'string', description: 'Stable validation identity returned by a prior edit+validation call; reuse with validation_only to join without replaying edits.' },
    validation_only: { type: 'boolean', description: 'When true, do not edit. Reconcile/reuse the existing session validation Processes identified by session_id/check_ids/validation_request_id.' },
    apply_mode: { type: 'string', enum: ['sync', 'async'], description: 'Defaults to sync for interactive development. Set async only for a separately durable operation.' },
  }),
  definition('repository_command_preview', 'Preview one repository-scoped local command with classification, approval token, and Git snapshots.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Legacy shell string or typed argv array. Typed argv executes without a shell.' },
    cwd: { type: 'string', description: 'Optional root-relative working directory.' },
    workspace_root: { type: 'string', description: 'Absolute existing local directory used as an ephemeral execution root. Mutually exclusive with repo_id/checkout_id; does not register or initialize the directory.' },
  }, ['command'], true),
  definition('repository_command_execute', 'Execute one repository-scoped command through the thinnest eligible lane: ephemeral for ordinary local work, an in-memory lightweight handle when it outlives the interaction budget, or explicit Durable handling for Work/external/release effects. Lightweight handles have no SQLite, Lease, recovery, or replay membership. Use rh_context for routine code discovery/reading; shell exploration is fallback-only.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    work_id: { type: 'string', description: 'Optional durable Work identity. Workflow controllers should pass the exact claimed Work id so attribution survives transient MCP transport sessions.' },
    command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Legacy shell string or typed argv array. Typed argv executes without a shell.' },
    cwd: { type: 'string', description: 'Optional root-relative working directory.' },
    workspace_root: { type: 'string', description: 'Absolute existing local directory used as an ephemeral execution root. Mutually exclusive with repo_id/checkout_id; does not register or initialize the directory.' },
    approval_token: { type: 'string', description: 'Exact approval token returned by repository_command_preview.' },
    approval_request_id: { type: 'string', description: 'Resolved approvalRequestId returned by approval_resolve.' },
    timeout_ms: { type: 'number', description: 'Optional execution timeout in milliseconds.' },
    max_output_bytes: { type: 'number', description: 'Optional cap for captured stdout/stderr.' },
  }, ['command']),

  // Thin Harness V1 is exposed through repository_workbench operations to keep the stable tool surface bounded.
];

export const repositoryToolNames = repositoryToolDefinitions.map((tool) => tool.name);

function result(value: Record<string, unknown>): RepositoryToolResult {
  // Compact text channel by default; structuredContent remains the machine view.
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const DEFAULT_MIGRATION_SAMPLE_LIMIT = 3;

function withResponseMeta(payload: Record<string, unknown>, startedAt: number): Record<string, unknown> {
  const response = {
    ...payload,
    responseMeta: {
      serverDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      structuredPayloadBytes: 0,
    },
  };
  response.responseMeta.structuredPayloadBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
  return response;
}

export interface RepositoryToolCallerContext {
  sessionId?: string;
  principalId?: string;
  controllerInstanceId?: string;
}

function claimedSessionWorkId(
  controllerHome: string,
  repository: ReturnType<typeof resolveRepositorySelection>,
  caller?: RepositoryToolCallerContext,
  explicitWorkId?: unknown,
): string | undefined {
  if (!caller?.principalId?.trim()) return undefined;
  const requestedWorkId = typeof explicitWorkId === 'string' ? explicitWorkId.trim() : '';
  if (requestedWorkId) {
    const work = getWorkContract({ controllerHome, repoId: repository.repoId }, requestedWorkId);
    if (!work || isTerminalWorkContractStatus(work.status)) throw new Error(`WORK_ATTRIBUTION_INVALID: ${requestedWorkId}`);
    if (work.checkoutId && work.checkoutId !== repository.activeCheckoutId) throw new Error(`WORK_CHECKOUT_MISMATCH: ${requestedWorkId}:${repository.activeCheckoutId}`);
    const owner = getControllerSession({ controllerHome, repoId: repository.repoId }, requestedWorkId);
    if (!owner) throw new Error(`WORK_CONTROLLER_CLAIM_REQUIRED: ${requestedWorkId}`);
    if ((owner.principalId?.trim() || owner.controllerId) !== caller.principalId.trim()) throw new Error(`WORK_CONTROLLER_OWNERSHIP_MISMATCH: ${requestedWorkId}`);
    return requestedWorkId;
  }
  if (caller.sessionId?.trim()) {
    const executionSession = readExecutionSession(controllerHome, {
      sessionId: caller.sessionId,
      principalId: caller.principalId,
      controllerInstanceId: caller.controllerInstanceId,
    });
    const workId = executionSession?.activeWorkId?.trim();
    if (workId && executionSession?.activeRepositoryId === repository.repoId && (!executionSession.activeCheckoutId || executionSession.activeCheckoutId === repository.activeCheckoutId)) {
      const work = getWorkContract({ controllerHome, repoId: repository.repoId }, workId);
      const owner = getControllerSession({ controllerHome, repoId: repository.repoId }, workId);
      if (work && !isTerminalWorkContractStatus(work.status) && owner?.sessionId === caller.sessionId && (owner.principalId?.trim() || owner.controllerId) === caller.principalId.trim()) return workId;
    }
  }
  const principal = caller.principalId.trim();
  const candidates = listControllerSessions({ controllerHome, repoId: repository.repoId })
    .filter((owner) => (owner.principalId?.trim() || owner.controllerId) === principal)
    .map((owner) => ({ owner, work: getWorkContract({ controllerHome, repoId: repository.repoId }, owner.workId) }))
    .filter((entry): entry is { owner: ReturnType<typeof listControllerSessions>[number]; work: NonNullable<ReturnType<typeof getWorkContract>> } => Boolean(entry.work && !isTerminalWorkContractStatus(entry.work.status) && (!entry.work.checkoutId || entry.work.checkoutId === repository.activeCheckoutId)));
  if (candidates.length === 1) return candidates[0].work.workId;
  if (candidates.length > 1) throw new Error(`WORK_ATTRIBUTION_AMBIGUOUS: principal ${principal} owns ${candidates.length} active Works on checkout ${repository.activeCheckoutId}`);
  return undefined;
}

function claimedSessionEditBinding(
  controllerHome: string,
  repository: ReturnType<typeof resolveRepositorySelection>,
  caller?: RepositoryToolCallerContext,
  explicitWorkId?: unknown,
): EditSessionBinding | undefined {
  const workId = claimedSessionWorkId(controllerHome, repository, caller, explicitWorkId);
  if (!workId || !caller?.principalId?.trim()) return undefined;
  const work = getWorkContract({ controllerHome, repoId: repository.repoId }, workId);
  if (!work) return undefined;
  return {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    principalId: caller.principalId.trim(),
    controllerInstanceId: caller.controllerInstanceId,
    routeDecisionFingerprint: work.routeDecisionFingerprint,
  };
}

function rawDefaultBranchMergeCommand(repository: ReturnType<typeof resolveRepositorySelection>, command: unknown): boolean {
  if (!repository.defaultBranch) return false;
  const checkout = repository.checkouts.find((entry) => entry.checkoutId === repository.activeCheckoutId);
  if (checkout?.branch !== repository.defaultBranch) return false;
  const normalized = normalizeRepositoryCommand(command);
  if (normalized.kind === 'argv') {
    const executable = normalized.executable?.split('/').pop();
    return executable === 'git' && normalized.args?.[0] === 'merge';
  }
  return /(?:^|[;&|]\s*)git\s+merge\b/.test(normalized.shellCommand ?? '');
}

function resolveRepositoryCommandTarget(
  controllerHome: string,
  args: Record<string, unknown>,
  repoIdValue: string,
  caller?: RepositoryToolCallerContext,
): {
  repository: ReturnType<typeof resolveRepositorySelection>;
  executionIdentity: ResolvedExecutionIdentity;
  workspace?: { workspaceId: string; root: string; registered: false };
} {
  const workspaceRoot = typeof args.workspace_root === 'string' ? args.workspace_root.trim() : '';
  const checkoutId = typeof args.checkout_id === 'string' ? args.checkout_id.trim() : '';
  if (workspaceRoot) {
    if (repoIdValue || checkoutId) {
      throw new Error('EPHEMERAL_WORKSPACE_TARGET_CONFLICT: workspace_root cannot be combined with repo_id or checkout_id');
    }
    const target = resolveEphemeralWorkspaceTarget(workspaceRoot, controllerHome);
    return {
      repository: target.repository,
      executionIdentity: {
        schemaVersion: 1,
        authority: 'ephemeral_workspace',
        repositoryId: target.workspaceId,
        checkoutId: target.checkoutId,
        canonicalRoot: target.canonicalRoot,
      },
      workspace: { workspaceId: target.workspaceId, root: target.canonicalRoot, registered: false },
    };
  }
  const repository = resolveRepositorySelection({
    repoId: repoIdValue || undefined,
    checkoutId: checkoutId || undefined,
    controllerHome,
    allowSoleRepository: true,
  });
  const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const workId = explicitWorkId
    ? claimedSessionWorkId(controllerHome, repository, caller, explicitWorkId)
    : undefined;
  return {
    repository,
    executionIdentity: {
      schemaVersion: 1,
      authority: 'repository',
      repositoryId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      canonicalRoot: repository.canonicalRoot,
      ...(workId ? { workId } : {}),
    },
  };
}

export function summarizeEntityMigrationReport(
  report: ReturnType<typeof bindRepositoryEntities>,
  detail = false,
): ReturnType<typeof bindRepositoryEntities> | Record<string, unknown> {
  if (detail) return report;
  const files = report.files.slice(0, DEFAULT_MIGRATION_SAMPLE_LIMIT);
  const errors = report.errors.slice(0, DEFAULT_MIGRATION_SAMPLE_LIMIT);
  return {
    repoId: report.repoId,
    checkoutId: report.checkoutId,
    scanned: report.scanned,
    updated: report.updated,
    unresolved: report.unresolved,
    fileCount: report.files.length,
    errorCount: report.errors.length,
    files,
    errors,
    truncated: report.files.length > files.length || report.errors.length > errors.length,
    omittedFileCount: Math.max(0, report.files.length - files.length),
    omittedErrorCount: Math.max(0, report.errors.length - errors.length),
  };
}

export function summarizeRepositoryRegistration(
  repository: ReturnType<typeof registerRepository>,
  migration: ReturnType<typeof bindRepositoryEntities>,
  detail = false,
  fastPath = false,
): Record<string, unknown> {
  if (detail) {
    return { detailLevel: 'detail', repository, migration, fastPath };
  }
  const checkoutCounts = repository.checkouts.reduce<Record<string, number>>((counts, checkout) => {
    const lifecycle = checkout.lifecycle ?? 'active';
    counts[lifecycle] = (counts[lifecycle] ?? 0) + 1;
    return counts;
  }, {});
  return {
    detailLevel: 'summary',
    repository: {
      ...repositorySummary(repository),
      activeCheckoutId: repository.activeCheckoutId,
      checkoutCount: repository.checkouts.length,
      checkoutCounts,
    },
    migration: summarizeEntityMigrationReport(migration),
    fastPath,
    next: 'Re-call with detail_level=detail only when full checkout or migration evidence is required.',
  };
}

export function summarizeRepositoryInspection(
  repository: ReturnType<typeof getRepository>,
  detail = false,
): Record<string, unknown> {
  if (detail) return { detailLevel: 'detail', repository };
  const checkoutCounts = repository.checkouts.reduce<Record<string, number>>((counts, checkout) => {
    const lifecycle = checkout.lifecycle ?? 'active';
    counts[lifecycle] = (counts[lifecycle] ?? 0) + 1;
    return counts;
  }, {});
  const activeCheckout = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
  return {
    detailLevel: 'summary',
    repository: {
      ...repositorySummary(repository),
      activeCheckoutId: repository.activeCheckoutId,
      ...(activeCheckout ? { activeCheckout } : {}),
      checkoutCount: repository.checkouts.length,
      checkoutCounts,
    },
    omittedCheckoutCount: Math.max(0, repository.checkouts.length - (activeCheckout ? 1 : 0)),
    next: 'Re-call with detail_level=detail only when complete checkout history is required.',
  };
}

function failure(error: unknown): RepositoryToolResult {
  const message = compactErrorMessage(error);
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'REPOSITORY_TOOL_FAILED';
  const details = typeof error === 'object' && error !== null && 'details' in error ? (error as { details?: unknown }).details : undefined;
  const compactDetails = details !== undefined && Buffer.byteLength(JSON.stringify(details) ?? '', 'utf8') > RESPONSE_BUDGET.previewBytes
    ? { omitted: true, message: 'Error details exceeded budget; inspect job/artifact/result refs.' }
    : details;
  return { ...result({ error: { code, message, ...(compactDetails !== undefined ? { details: compactDetails } : {}) } }), isError: true };
}

interface RepositoryExplorationGuidance {
  code: 'FRAGMENTED_REPOSITORY_EXPLORATION';
  recommendedTool: 'rh_context';
  recommendedOperation: 'search';
  message: string;
}

function fragmentedRepositoryExplorationGuidance(command: unknown): RepositoryExplorationGuidance | undefined {
  if (typeof command !== 'string') return undefined;
  const segments = command.split(/(?:&&|\|\||[;|])/g);
  const readPrograms = new Set<string>();
  let readStepCount = 0;
  for (const segment of segments) {
    const match = segment.trim().match(/^(?:(?:command|env)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(rg|grep|sed|cat|head|tail)\b/i);
    if (!match) continue;
    readStepCount += 1;
    readPrograms.add(match[1]!.toLowerCase());
  }
  if (readStepCount < 2) return undefined;
  return {
    code: 'FRAGMENTED_REPOSITORY_EXPLORATION',
    recommendedTool: 'rh_context',
    recommendedOperation: 'search',
    message: `Detected ${readStepCount} chained repository read steps (${[...readPrograms].join(', ')}). Prefer a broad rh_context request first, then repeat rh_context with selected paths or relationships when more evidence can improve correctness; keep shell search as fallback when the Context Plane cannot supply the needed evidence.`,
  };
}

function compactProcessCommandPayload(input: {
  accepted?: boolean;
  mode: string;
  path: string;
  route?: string;
  reasons: string[];
  decision?: unknown;
  repoId: string;
  checkoutId?: string;
  workspace?: { workspaceId: string; root: string; registered: false };
  processId?: string;
  process?: unknown;
  completed?: boolean;
  ok?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durableSideEffects?: Record<string, number>;
  next: string;
  /** summary (default) omits nested process / routing dumps; detail restores diagnostics. */
  detailLevel?: 'summary' | 'detail';
  includeFullProcess?: boolean;
  guidance?: RepositoryExplorationGuidance;
}): Record<string, unknown> {
  const output = compactCommandOutput(input.stdout, input.stderr, { ok: input.ok === true });
  const detail = input.detailLevel === 'detail' || input.includeFullProcess === true;
  const effects = input.durableSideEffects ?? {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };
  const reason = input.reasons[0] ?? 'readonly_fast_path';

  // Default success/failure: one authoritative stdout/stderr pair, no nested process dump.
  if (!detail) {
    const completed = input.completed !== false;
    const ok = input.ok === true;
    const payload: Record<string, unknown> = {
      ...(completed ? { ok } : {}),
      accepted: input.accepted ?? true,
      mode: input.mode,
      path: input.path,
      route: input.route ?? input.path,
      reason,
      repoId: input.repoId,
      ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.processId ? { processId: input.processId } : {}),
      ...(completed ? { exitCode: input.exitCode ?? (ok ? 0 : 1) } : {}),
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      ...(output.stdoutTruncated ? { stdoutTruncated: true, stdoutBytes: output.stdoutBytes } : {}),
      ...(output.stderrTruncated ? { stderrTruncated: true, stderrBytes: output.stderrBytes } : {}),
      ...(input.guidance ? { guidance: input.guidance, suggestedOperation: 'rh_context' } : {}),
    };
    if (completed && !ok) {
      payload.error = {
        code: 'PROCESS_COMMAND_FAILED',
        message: (output.stderr || 'process_direct command failed').slice(0, 800),
        retryable: false,
        exitCode: input.exitCode ?? 1,
      };
    }
    // Zero side-effects are implicit for process_direct summary; only surface non-zero.
    const nonZeroEffects = Object.fromEntries(
      Object.entries(effects).filter(([, value]) => typeof value === 'number' && value > 0),
    );
    if (Object.keys(nonZeroEffects).length > 0) payload.durableSideEffects = nonZeroEffects;
    return payload;
  }

  return {
    accepted: input.accepted ?? true,
    mode: input.mode,
    path: input.path,
    route: input.route ?? input.path,
    routing: {
      ...compactRoutingSummary({ path: input.path, mode: input.mode, reasons: input.reasons }),
      ...(input.decision ? { decision: input.decision } : {}),
    },
    reason,
    repoId: input.repoId,
    ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.processId ? { processId: input.processId } : {}),
    ok: input.ok,
    exitCode: input.exitCode,
    ...output,
    // Nested process only in detail mode; never duplicate stdout/stderr there.
    ...(input.process && typeof input.process === 'object'
      ? {
        process: (() => {
          const record = { ...(input.process as Record<string, unknown>) };
          delete record.stdout;
          delete record.stderr;
          delete record.durableSideEffects;
          return record;
        })(),
      }
      : {}),
    durableSideEffects: effects,
    ...(input.guidance ? { guidance: input.guidance, suggestedOperation: 'rh_context' } : {}),
    next: input.next,
    detailLevel: 'detail',
  };
}

function emptyRepositoryMigration(repository: ReturnType<typeof registerRepository>) {
  return {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    scanned: 0,
    updated: 0,
    unresolved: 0,
    files: [] as string[],
    errors: [] as Array<{ path: string; error: string }>,
  };
}

function registrationOnlyMetadataRefresh(
  match: ReturnType<typeof findIdenticalRepositoryRegistration>,
): boolean {
  if (!match || match.identical || match.reasons.length === 0) return false;
  const metadataReasons = new Set([
    'remote_identity_changed',
    'default_branch_changed',
    'display_name_changed',
  ]);
  return match.reasons.every((reason) => metadataReasons.has(reason));
}

function registrationOnlyAttachedExistingWorktree(repository: ReturnType<typeof registerRepository>): boolean {
  const selected = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
  return selected?.worktree === true
    && repository.checkouts.some((checkout) => checkout.checkoutId !== selected.checkoutId);
}

export async function callRepositoryTool(
  controllerHome: string,
  name: string,
  args: Record<string, unknown>,
  caller?: RepositoryToolCallerContext,
): Promise<RepositoryToolResult | undefined> {
  if (!name.startsWith('repository_') && name !== 'read_repository_file') return undefined;
  try {
    const repoIdValue = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
    switch (name) {
      case 'read_repository_file': {
        const repository = resolveRepositorySelection({
          repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const path = String(args.path ?? '').trim();
        if (!path) throw new Error('REPOSITORY_PATH_REQUIRED: path is required');
        const session = caller?.sessionId
          ? { sessionId: caller.sessionId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId }
          : undefined;
        const range = readRepositoryRange(
          repository.canonicalRoot,
          getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
          path,
          typeof args.start_line === 'number' ? args.start_line : 1,
          typeof args.end_line === 'number' ? args.end_line : 200,
          session,
        );
        const redacted = redactMcpText(range.content);
        return result({ ...range, content: redacted.text, redactions: redacted.redactions });
      }
      case 'repository_register': {
        const startedAt = performance.now();
        const registerInput = {
          path: String(args.path ?? ''),
          controllerHome,
          displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
          remoteUrl: typeof args.remote_url === 'string' ? args.remote_url : undefined,
          defaultBranch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
        };
        const identical = findIdenticalRepositoryRegistration(registerInput);
        if (identical?.identical) {
          const repository = identical.repository;
          // Repeat registration with identical identity returns immediately.
          // No legacy migration / edit-session migration / historical issue
          // scan / old issue rebinding runs on this hot path.
          const migration = emptyRepositoryMigration(repository);
          return result(withResponseMeta(
            summarizeRepositoryRegistration(repository, migration, args.detail_level === 'detail', true),
            startedAt,
          ));
        }
        const metadataRefresh = registrationOnlyMetadataRefresh(identical);
        const repository = registerRepository(registerInput);
        // Adding a worktree checkout or changing only display/remote/default-branch
        // metadata preserves repository + checkout authority. Existing entities
        // are already bound to the stable repoId, so a historical migration scan
        // would only add latency and stale unresolved diagnostics.
        const migration = registrationOnlyAttachedExistingWorktree(repository) || metadataRefresh
          ? emptyRepositoryMigration(repository)
          : bindRepositoryEntities(repository);
        return result(withResponseMeta(
          summarizeRepositoryRegistration(repository, migration, args.detail_level === 'detail', metadataRefresh),
          startedAt,
        ));
      }
      case 'repository_latest_source_diagnose':
        return result({
          diagnosis: diagnoseLatestLocalProjectSource({
            path: typeof args.path === 'string' ? args.path : undefined,
            repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
            controllerHome,
          }),
        });
      case 'repository_bootstrap_local_project':
        return result({
          bootstrap: bootstrapLocalProject({
            path: String(args.path ?? ''),
            controllerHome,
            displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
            defaultBranch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
            mode: typeof args.mode === 'string' ? args.mode as 'init_git_only' | 'init_git_and_register' | 'replace_registration' : undefined,
            replaceRegisteredRepoId: typeof args.replace_registered_repo_id === 'string' ? args.replace_registered_repo_id : undefined,
            confirmAuthorization: args.confirm_authorization === true,
          }),
        });
      case 'repository_list':
        return result({ repositories: listRepositories(controllerHome, { includeRemoved: args.include_removed === true }).map(repositorySummary) });
      case 'repository_get': {
        // Repository inspection is also the bounded reconciliation point for
        // checkout lifecycle drift caused by worktrees being removed outside
        // Forge. Reuse the existing registry reconciler so stale worktrees are
        // not exposed as lifecycle=active to automation callers.
        reconcileRepositoryCheckouts(repoIdValue, controllerHome);
        const repository = getRepository(repoIdValue, controllerHome, { includeRemoved: args.include_removed === true });
        return result(summarizeRepositoryInspection(repository, args.detail_level === 'detail'));
      }
      case 'repository_validate': {
        const startedAt = performance.now();
        const repository = getRepository(repoIdValue, controllerHome, { includeRemoved: true });
        const payload = {
          detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
          validation: validateRepository(repoIdValue, controllerHome),
          migration: summarizeEntityMigrationReport(bindRepositoryEntities(repository), args.detail_level === 'detail'),
        };
        return result(withResponseMeta(payload, startedAt));
      }
      case 'repository_refresh': {
        const startedAt = performance.now();
        const repository = refreshRepository(repoIdValue, controllerHome);
        const migration = bindRepositoryEntities(repository);
        return result(withResponseMeta(
          summarizeRepositoryRegistration(repository, migration, args.detail_level === 'detail'),
          startedAt,
        ));
      }
      case 'repository_update':
        return result({ repository: updateRepository(repoIdValue, {
          displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
          defaultBranch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
          enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        }, controllerHome) });
      case 'repository_disable':
        return result({ repository: disableRepository(repoIdValue, controllerHome) });
      case 'repository_remove':
        return result({ repository: removeRepository(repoIdValue, controllerHome) });
      case 'repository_workbench': {
        const operation = typeof args.operation === 'string' ? args.operation : 'summary';
        if (operation === 'summary') {
          return result({ workbench: buildControllerWorkbench(controllerHome, {
            repoId: repoIdValue || undefined,
            includeRemoved: args.include_removed === true,
          }) });
        }
        const payload = typeof args.payload === 'object' && args.payload !== null
          ? args.payload as Record<string, unknown>
          : {};
        if (operation === 'assess_work_mode') {
          const description = typeof payload.description === 'string'
            ? payload.description
            : typeof args.description === 'string' ? args.description : '';
          const assessment = assessWorkMode({
            description,
            knownPaths: Array.isArray(payload.known_paths) ? payload.known_paths.map(String) : undefined,
            expectedFiles: typeof payload.expected_files === 'number' ? payload.expected_files : undefined,
            expectedChangedLines: typeof payload.expected_changed_lines === 'number' ? payload.expected_changed_lines : undefined,
            requiresInvestigation: payload.requires_investigation === true,
            requiresParallelism: payload.requires_parallelism === true,
            requiresLongRunningChecks: payload.requires_long_running_checks === true,
            needsDependencies: payload.needs_dependencies === true,
            requiresIndependentDeliverables: payload.requires_independent_deliverables === true,
            independentTaskCount: typeof payload.independent_task_count === 'number' ? payload.independent_task_count : undefined,
            requiresRemoteWrite: payload.requires_remote_write === true || payload.remote_write === true,
            requiresRecovery: payload.requires_recovery === true,
            agentRequested: payload.agent_requested === true || payload.requires_worker === true,
            requiresWorkerIsolation: payload.requires_worker_isolation === true,
            risk: typeof payload.risk === 'string' ? payload.risk as 'low' | 'medium' | 'high' | 'destructive' : undefined,
            explicitMode: parseExplicitTaskMode(payload.mode),
          });
          return result({
            assessment,
            routing: {
              path: assessment.executionPath,
              reasons: assessment.reasons,
              recommendedMode: assessment.recommendedMode,
              issueRequired: assessment.issueRequired,
            },
            nextTools: assessment.nextTools,
          });
        }
        const internalTool = {
          batch_execute: 'repository_batch_execute',
          lanes_execute: 'repository_lanes_execute',
          lanes_integrate: 'repository_lanes_integrate',
          fast_receipt_get: 'repository_fast_receipt_get',
          fast_receipt_list: 'repository_fast_receipt_list',
          execution_route: 'repository_execution_route',
        }[operation];
        if (!internalTool) {
          return failure(new Error(`REPOSITORY_WORKBENCH_OPERATION_INVALID: ${operation}`));
        }
        return callRepositoryTool(controllerHome, internalTool, {
          ...payload,
          repo_id: repoIdValue || payload.repo_id,
          checkout_id: typeof args.checkout_id === 'string' ? args.checkout_id : payload.checkout_id,
        });
      }



      case 'repository_goal_list': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, registry: readRepositoryGoalRegistry(repository) });
      }
      case 'repository_goal_upsert': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...upsertRepositoryGoal(repository, { id: args.id, title: args.title, status: args.status, checks: args.checks, notes: args.notes }) as unknown as Record<string, unknown> });
      }
      case 'repository_stuck_diagnose': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ diagnosis: diagnoseRepositoryStuckState(repository) });
      }

      case 'repository_goal_run': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        const ran = withControllerLock(
          controllerHome,
          { scope: 'repository', repoId: repository.repoId },
          'mcp:repository_goal_run',
          () => runRepositoryGoal(repository, { goalId: args.goal_id, runChecks: args.run_checks }),
          60_000,
        );
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...ran as unknown as Record<string, unknown> });
      }
      case 'repository_goal_runs': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        const limit = typeof args.limit === 'number' ? args.limit : typeof args.limit === 'string' ? Number(args.limit) : undefined;
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, runs: listRepositoryGoalRuns(repository, limit) });
      }
      case 'repository_git_status': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        const status = args.refresh === true
          ? writeRepositoryGitStatusSample(controllerHome, repository)
          : readRepositoryGitStatusSample(controllerHome, repository.repoId, repository.activeCheckoutId);
        return result({
          status: status ?? {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            sampleSource: 'daemon-sample',
            sampled: false,
            observedAt: null,
            staleAgeMs: null,
            message: 'Git status has not been sampled by the Forge Runtime yet. Retry after scheduler heartbeat or call with refresh=true for an explicit live refresh.',
          },
        });
      }

      case 'repository_git_diff': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ diff: repositoryGitDiff(repository, { staged: args.staged, paths: args.paths, maxBytes: args.max_bytes }) });
      }
      case 'repository_git_create_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitCreateBranch(controllerHome, repository, { branch: args.branch, startPoint: args.start_point, switchTo: args.switch_to }) as unknown as Record<string, unknown> });
      }
      case 'repository_git_switch_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitSwitchBranch(controllerHome, repository, { branch: args.branch }) as unknown as Record<string, unknown> });
      }
      case 'repository_git_merge_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitMergeBranch(controllerHome, repository, { branch: args.branch, noFf: args.no_ff }) as unknown as Record<string, unknown> });
      }
      case 'repository_git_delete_branch': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ repoId: repository.repoId, checkoutId: repository.activeCheckoutId, ...repositoryGitDeleteBranch(controllerHome, repository, { branch: args.branch, force: args.force }) as unknown as Record<string, unknown> });
      }

      case 'repository_git_commit': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ commit: repositoryGitCommit(controllerHome, repository, { message: args.message, paths: args.paths, allowEmpty: args.allow_empty }) });
      }
      case 'repository_git_finish_workflow': {
        const repository = resolveRepositorySelection({ repoId: repoIdValue || undefined, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome, allowSoleRepository: true });
        return result({ finish: repositoryGitFinishWorkflow(controllerHome, repository, { featureBranch: args.feature_branch, targetBranch: args.target_branch, deleteBranch: args.delete_branch, noFf: args.no_ff }) });
      }
      case 'repository_safe_patch_plan': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          plan: buildSafePatchPlan(repository, { operations: args.operations, chunkSize: args.chunk_size }),
        });
      }
      case 'repository_safe_patch_apply': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const binding = claimedSessionEditBinding(controllerHome, repository, caller, args.work_id);
        const applied = withControllerLock(
          controllerHome,
          { scope: 'repository', repoId: repository.repoId },
          'mcp:repository_safe_patch_apply',
          () => applySafePatch(repository, {
            sessionId: args.session_id,
            purpose: args.purpose,
            operations: args.operations,
            chunkSize: args.chunk_size,
            expectedRevision: args.expected_revision,
            allowedPaths: args.allowed_paths,
            continueOnError: args.continue_on_error,
            refreshFingerprints: args.refresh_fingerprints,
            recoverStaleSession: args.recover_stale_session,
            binding,
          }),
          60_000,
        );
        const changedFiles = [
          ...new Set(
            (applied.appliedChunks ?? []).flatMap((chunk) => chunk.paths ?? []),
          ),
        ];
        const ok = applied.status === 'applied';
        const firstFailure = applied.failures?.[0];
        const editDiff = applied.appliedChunks.length > 0
          ? getEditSessionDiff(repository.canonicalRoot, applied.session.sessionId)
          : undefined;
        const boundedEditDiff = editDiff
          ? boundUtf8(editDiff.patch, RESPONSE_BUDGET.inlineOutputBytes)
          : undefined;
        const reviewEvidence = editDiff && boundedEditDiff
          ? {
              source: 'edit_session' as const,
              sessionId: editDiff.sessionId,
              revision: editDiff.revision,
              sha256: editDiff.sha256,
              patchPreview: boundedEditDiff.text,
              truncated: boundedEditDiff.truncated,
              byteLength: boundedEditDiff.byteLength,
              semanticReviewAuthority: 'chatgpt' as const,
              next: boundedEditDiff.truncated
                ? 'The edit diff exceeds the inline budget. Expand only the affected ranges or diff needed for semantic review.'
                : 'Review this exact edit-session diff before deciding whether more edits or focused validation are needed.',
            }
          : undefined;
        const digest = buildSyncOperationDigest({
          ok,
          operation: 'repository_safe_patch_apply',
          summary: ok
            ? `补丁已同步应用，涉及 ${changedFiles.length} 个文件。`
            : applied.status === 'partial'
              ? `补丁部分应用：${changedFiles.length} 个文件成功，存在失败 chunk。`
              : `补丁应用失败：${firstFailure?.message || '请检查 failures 摘要'}`,
          changedFiles,
          errorClass: ok ? undefined : classifyUserFacingError({
            code: firstFailure?.code,
            message: firstFailure?.message,
            infrastructure: firstFailure?.code === 'APPLY_FAILED',
          }),
          errorMessage: firstFailure?.message,
        });
        const payload = {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...applied as unknown as Record<string, unknown>,
          phase: digest.phase,
          statusLabel: digest.statusLabel,
          summary: digest.summary,
          terminal: true,
          applyMode: 'sync',
          digest,
          ...(reviewEvidence ? { reviewEvidence } : {}),
          suggestedNextActions: digest.suggestedNextActions,
        };
        return ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_command_preview': {
        const target = resolveRepositoryCommandTarget(controllerHome, args, repoIdValue, caller);
        const { repository } = target;
        const execution = withControllerLock(
          controllerHome,
          { scope: 'repository', repoId: repository.repoId },
          'mcp:repository_command_preview',
          () => executeRepositoryCommand(controllerHome, repository, {
            command: args.command as string | string[],
            cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
            dryRun: true,
            allowNonGitWorkspace: target.workspace !== undefined,
          }),
          60_000,
        );
        return result({
          ...execution as unknown as Record<string, unknown>,
          ...(target.workspace ? { workspace: target.workspace } : {}),
        });
      }
      case 'repository_command_execute': {
        const explorationGuidance = fragmentedRepositoryExplorationGuidance(args.command);
        const target = resolveRepositoryCommandTarget(controllerHome, args, repoIdValue, caller);
        const { repository, executionIdentity } = target;
        const deliveryWorkId = rawDefaultBranchMergeCommand(repository, args.command)
          ? executionIdentity.workId ?? claimedSessionWorkId(controllerHome, repository, caller)
          : undefined;
        if (deliveryWorkId) {
          throw new Error(`WORK_DELIVERY_REQUIRES_FINALIZE: ${deliveryWorkId} must pass Work verification and use rh_work finalize before default-branch integration`);
        }
        const timeoutMs = typeof args.timeout_ms === 'number'
          ? args.timeout_ms
          : typeof args.timeout_ms === 'string'
            ? Number(args.timeout_ms)
            : undefined;
        const maxOutputBytes = typeof args.max_output_bytes === 'number'
          ? args.max_output_bytes
          : typeof args.max_output_bytes === 'string'
            ? Number(args.max_output_bytes)
            : undefined;
        // Worker-owned durable executions must not re-enter Fast Path or create a
        // nested ExecutionJob. Local Job remains the worker settlement surface.
        const fromDurableWorker = args.__from_durable_worker === true
          || typeof args.__execution_job_id === 'string';
        // Process Runtime owns local async execution. apply_mode=async means
        // return its Process handle immediately; it must not promote a local
        // command into the retired ExecutionJob path. Explicit mode=durable
        // remains a separate external-Controller boundary.
        const returnHandleImmediately = args.apply_mode === 'async'
          || args.mode === 'async'
          || args.async === true
          || args.background === true;
        const forceDurable = fromDurableWorker
          || args.mode === 'durable'
          || args.force_durable === true;
        const routingDecision = routeExecution({
          operation: 'repository_command_execute',
          mode: forceDurable ? 'durable' : args.mode === 'fast' ? 'fast' : 'auto',
          command: args.command as string | string[] | undefined,
          timeoutMs,
          background: forceDurable && (args.background === true || args.async === true),
          defaultBranch: repository.defaultBranch,
          approvalContinuation: typeof args.approval_request_id === 'string'
            || typeof args.approval_token === 'string',
        });
        // Unified Process Runtime for local commands (Direct/Managed) when not forced durable.
        // Ephemeral workspaces cannot persist a recoverable async Process handle,
        // so their async requests remain promotion-required below.
        if (!forceDurable && !fromDurableWorker && !(target.workspace && returnHandleImmediately)) {
          try {
            const routeClass = classifyRepositoryCommandRoute(args.command as string | string[], {
              forceDurable: false,
              defaultBranch: repository.defaultBranch,
              timeoutMs,
            });
            if (routeClass.route === 'process_direct' || routeClass.route === 'process_managed') {
              const processResult = await executeRepositoryCommandViaProcessRuntime({
                controllerHome,
                repository,
                command: args.command as string | string[],
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                timeoutMs,
                interactiveWaitMs: returnHandleImmediately
                  ? 0
                  : typeof args.interactive_wait_ms === 'number' ? args.interactive_wait_ms : undefined,
                maxOutputBytes,
                returnHandleImmediately,
                requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
                workId: executionIdentity.workId,
                executionIdentity,
                allowNonGitWorkspace: target.workspace !== undefined,
              });
              if (processResult.route === 'process_direct' || processResult.route === 'process_managed') {
                const handle = processResult.process;
                const detailLevel = args.detail_level === 'detail' || args.detail === true
                  ? 'detail'
                  : 'summary';
                const directWithoutHandle = processResult.route === 'process_direct' && !handle;
                const directNotExecuted = directWithoutHandle
                  && processResult.executionStatus !== undefined
                  && processResult.executionStatus !== 'executed';
                if (directNotExecuted) {
                  const authorization = processResult.authorizationDecision ?? {
                    decision: 'deny' as const,
                    reason: 'Command was not executed because the required authorization was not satisfied.',
                  };
                  return result({
                    accepted: false,
                    mode: processResult.route,
                    path: processResult.reason ?? routeClass.reason,
                    route: processResult.route,
                    repoId: repository.repoId,
                    checkoutId: repository.activeCheckoutId,
                    workspace: target.workspace,
                    status: processResult.executionStatus,
                    policyDecision: processResult.policyDecision ?? 'approval_required',
                    authorization,
                    ...(processResult.approvalRequestId ? { approvalRequestId: processResult.approvalRequestId } : {}),
                    message: authorization.decision === 'user_confirmation_required'
                      ? authorization.humanSummary
                      : authorization.reason,
                    suggestedOperation: 'repository_command_preview',
                  });
                }
                const completed = directWithoutHandle || handle?.completed === true;
                const status = directWithoutHandle
                  ? (processResult.ok === true ? 'succeeded' : 'failed')
                  : !handle
                    ? 'rejected'
                    : completed
                      ? (handle.cancelled ? 'cancelled' : handle.timedOut ? 'timed_out' : processResult.ok === true ? 'succeeded' : 'failed')
                      : 'running';
                const payload = compactProcessCommandPayload({
                  accepted: true,
                  mode: processResult.route,
                  path: processResult.route,
                  route: processResult.route,
                  reasons: [processResult.reason ?? routeClass.reason, ...routingDecision.reasons],
                  decision: detailLevel === 'detail' ? routingDecision : undefined,
                  repoId: repository.repoId,
                  checkoutId: repository.activeCheckoutId,
                  workspace: target.workspace,
                  processId: handle?.processId,
                  process: detailLevel === 'detail' ? handle : undefined,
                  completed,
                  ok: completed ? processResult.ok : undefined,
                  exitCode: completed ? processResult.exitCode : undefined,
                  stdout: processResult.stdout,
                  stderr: processResult.stderr,
                  durableSideEffects: processResult.durableSideEffects,
                  guidance: explorationGuidance,
                  next: directWithoutHandle
                    ? processResult.reason === 'readonly_fast_path'
                      ? 'Bounded readonly execution completed without Process record / Lease / Local Job / ExecutionJob / Worker.'
                      : 'Bounded ephemeral workspace execution completed without Process record / Lease / Local Job / ExecutionJob / Worker.'
                    : processResult.route === 'process_direct' || completed
                      ? 'Process Runtime completed without Local Job / ExecutionJob / Worker.'
                      : `Process Runtime is managing ${handle?.processId}; poll process_get/process_wait instead of creating a Local Job.`,
                  detailLevel,
                });
                payload.status = status;
                payload.processId = handle?.processId;
                payload.authorization = {
                  decision: 'allow',
                  source: directWithoutHandle ? 'bounded_read_direct' : 'process_runtime',
                  reason: directWithoutHandle
                    ? 'Readonly repository command executed through the bounded non-persistent direct path.'
                    : 'Repository command executed through Unified Process Runtime.',
                };
                if (directWithoutHandle && processResult.reason !== 'readonly_fast_path') {
                  payload.authorization = processResult.authorizationDecision?.decision === 'allow'
                    ? processResult.authorizationDecision
                    : {
                        decision: 'allow',
                        source: 'ephemeral_workspace_direct',
                        reason: 'Bounded ephemeral workspace command executed through the non-persistent direct path.',
                      };
                }
                if (handle?.processId) {
                  payload.resultRef = { kind: 'process_logs', processId: handle.processId };
                }
                // Keep accepted true once the command was admitted to Process Runtime.
                payload.accepted = true;
                return processResult.ok === true || !completed
                  ? result(payload)
                  : { ...result(payload), isError: true };
              }
            }
          } catch (error) {
            // Process Runtime is authoritative. Falling through could spawn the
            // same command again through the legacy Fast/Local Job path.
            if (process.env.FORGE_DEBUG_PROCESS_RUNTIME === '1') {
              console.error('[repository_command_execute] process runtime error', error);
            }
            return failure(error);
          }
        }
        if (target.workspace && (forceDurable || returnHandleImmediately)) {
          return result({
            accepted: false,
            mode: 'durable',
            path: 'ephemeral_workspace_promotion_required',
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            workspace: target.workspace,
            message: 'Ephemeral workspaces support bounded local Direct/Managed execution only. Register the directory before durable, remote, release, or resumable Work.',
            suggestedOperation: 'repository_register',
          });
        }
        // Durable Worker calls skip Process/Fast above, then use the Local Bridge
        // compatibility projection below for writes/long commands so the worker
        // can settle the legacy child without creating a nested ExecutionJob.
        // Short readonly commands keep the zero-Local-Job direct path.
        if (fromDurableWorker) {
          try {
            const routeClass = classifyRepositoryCommandRoute(args.command as string | string[], {
              forceDurable: false,
              defaultBranch: repository.defaultBranch,
              timeoutMs,
            });
            if (routeClass.route === 'process_direct') {
              const processResult = await executeRepositoryCommandViaProcessRuntime({
                controllerHome,
                repository,
                command: args.command as string | string[],
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                timeoutMs,
                maxOutputBytes,
                requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
                workId: executionIdentity.workId,
                executionIdentity,
              });
              if (processResult.route === 'process_direct') {
                const execRecord = processResult.process as unknown as Record<string, unknown> | undefined;
                const ok = processResult.ok === true;
                const inlinePayload = {
                  accepted: ok,
                  mode: 'durable',
                  path: 'durable_worker_inline',
                  routing: compactRoutingSummary({
                    path: 'durable',
                    mode: 'durable',
                    reasons: ['durable_worker_inline_process_direct', routeClass.reason, ...routingDecision.reasons],
                  }),
                  repoId: repository.repoId,
                  checkoutId: repository.activeCheckoutId,
                  ok,
                  processId: typeof execRecord?.processId === 'string' ? execRecord.processId : undefined,
                  status: typeof execRecord?.status === 'string' ? execRecord.status : undefined,
                  exitCode: typeof processResult.exitCode === 'number' ? processResult.exitCode : undefined,
                  ...compactCommandOutput(
                    typeof processResult.stdout === 'string' ? processResult.stdout : undefined,
                    typeof processResult.stderr === 'string' ? processResult.stderr : undefined,
                    { ok },
                  ),
                  durableSideEffects: processResult.durableSideEffects,
                  next: 'Durable Worker executed a short readonly repository command inline without a Local Job.',
                };
                return ok ? result(inlinePayload) : { ...result(inlinePayload), isError: true };
              }
            }
          } catch (error) {
            if (process.env.FORGE_DEBUG_PROCESS_RUNTIME === '1') {
              console.error('[repository_command_execute] durable worker inline process runtime error', error);
            }
          }
        }
        return result({
          accepted: false,
          mode: 'durable',
          path: 'external_controller_required',
          routing: compactRoutingSummary({ path: 'durable', mode: 'durable', reasons: [routingDecision.reasons.join(','), 'local_bridge_execution_retired'] }),
          message: 'This command requires explicit external Controller handling; Local Bridge Jobs are retired for repository commands.',
          suggestedOperation: 'Create or claim WorkContract, then use rh_work.launcher_start or a Process Runtime-compatible command.',
          externalEffect: {
            outcome: 'not_started',
            ambiguousFailureOutcome: 'outcome_unknown',
            replayPolicy: 'never_auto_retry',
            reconciliation: 'After an ambiguous dispatch failure, inspect the remote ref/registry/release state before deciding whether to retry.',
          },
        });
      }
      case 'repository_batch_execute': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const steps = Array.isArray(args.steps)
          ? args.steps
            .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
            .map((entry) => ({
              id: typeof entry.id === 'string' ? entry.id : undefined,
              kind: String(entry.kind ?? '') as
                | 'read_file'
                | 'search'
                | 'git_status'
                | 'git_diff'
                | 'apply_patch'
                | 'run_short_command'
                | 'run_focused_check'
                | 'stage_paths'
                | 'commit_paths',
              input: (typeof entry.input === 'object' && entry.input !== null
                ? entry.input
                : {}) as Record<string, unknown>,
            }))
          : [];
        const batch = await executeRepositoryBatch(
          { controllerHome, repository },
          {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            mode: args.mode === 'fast' || args.mode === 'durable' || args.mode === 'auto' ? args.mode : 'auto',
            steps,
            stopOnError: args.stop_on_error !== false,
            allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
            includeLatencyBreakdown: args.include_latency_breakdown === true,
            purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
            requestId: typeof args.request_id === 'string' ? args.request_id.trim() || undefined : undefined,
          },
        );
        const payload = batch as unknown as Record<string, unknown>;
        return batch.ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_lanes_execute': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const lanes = await executeLightweightLanes(
          { controllerHome, repository },
          {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            readLanes: Array.isArray(args.read_lanes)
              ? args.read_lanes
                .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
                .map((entry) => ({
                  id: typeof entry.id === 'string' ? entry.id : undefined,
                  kind: String(entry.kind ?? 'search') as 'search' | 'read_file' | 'git_status' | 'git_diff' | 'run_short_command',
                  input: (typeof entry.input === 'object' && entry.input !== null
                    ? entry.input
                    : {}) as Record<string, unknown>,
                }))
              : undefined,
            patchProposalLanes: Array.isArray(args.patch_proposal_lanes)
              ? args.patch_proposal_lanes
                .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
                .map((entry) => ({
                  id: typeof entry.id === 'string' ? entry.id : undefined,
                  readPaths: Array.isArray(entry.read_paths) ? entry.read_paths.map(String) : [],
                  writePaths: Array.isArray(entry.write_paths) ? entry.write_paths.map(String) : [],
                  proposedOperations: Array.isArray(entry.proposed_operations) ? entry.proposed_operations : [],
                  assumptions: Array.isArray(entry.assumptions) ? entry.assumptions.map(String) : undefined,
                  riskNotes: Array.isArray(entry.risk_notes) ? entry.risk_notes.map(String) : undefined,
                  suggestedFocusedCheck: entry.suggested_focused_check as string | string[] | undefined,
                }))
              : undefined,
            failFast: args.fail_fast === true,
            maxConcurrency: typeof args.max_concurrency === 'number' ? args.max_concurrency : undefined,
            includeLatencyBreakdown: args.include_latency_breakdown === true,
          },
        );
        const payload = lanes as unknown as Record<string, unknown>;
        return lanes.ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_lanes_integrate': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const proposals = Array.isArray(args.proposals)
          ? args.proposals
            .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
            .map((entry) => ({
              id: String(entry.id ?? 'proposal'),
              ok: entry.ok !== false,
              durationMs: 0,
              readPaths: Array.isArray(entry.read_paths) ? entry.read_paths.map(String) : [],
              writePaths: Array.isArray(entry.write_paths) ? entry.write_paths.map(String) : [],
              proposedOperations: Array.isArray(entry.proposed_operations) ? entry.proposed_operations : [],
              analysisOnly: entry.analysis_only === true,
              proposalId: typeof entry.proposal_id === 'string'
                ? entry.proposal_id
                : typeof entry.proposalId === 'string'
                  ? entry.proposalId
                  : undefined,
            }))
          : [];
        const integrated = await integratePatchProposals(
          { controllerHome, repository },
          proposals,
          {
            sessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
            allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
            purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
            requestId: typeof args.request_id === 'string' ? args.request_id.trim() || undefined : undefined,
            continueOnError: args.continue_on_error === true,
          },
        );
        const payload = integrated as unknown as Record<string, unknown>;
        return integrated.ok ? result(payload) : { ...result(payload), isError: true };
      }
      case 'repository_fast_receipt_get': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const receipt = readFastReceipt(controllerHome, repository.repoId, String(args.execution_id ?? ''));
        if (!receipt) return failure(new Error(`FAST_RECEIPT_NOT_FOUND: ${String(args.execution_id ?? '')}`));
        return result({ receipt });
      }
      case 'repository_fast_receipt_list': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        return result({ receipts: listFastReceipts(controllerHome, repository.repoId, limit) });
      }
      case 'repository_execution_route': {
        const repository = resolveRepositorySelection({
          repoId: repoIdValue || undefined,
          checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
          controllerHome,
          allowSoleRepository: true,
        });
        const decision = routeExecution({
          operation: String(args.operation ?? ''),
          mode: args.mode === 'fast' || args.mode === 'durable' || args.mode === 'auto' ? args.mode : 'auto',
          command: args.command as string | string[] | undefined,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          background: args.background === true,
          paths: Array.isArray(args.paths) ? args.paths.map(String) : undefined,
          allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
          defaultBranch: repository.defaultBranch,
        });
        return result({ decision, repoId: repository.repoId, checkoutId: repository.activeCheckoutId });
      }
      default:
        return failure(new Error(`UNKNOWN_REPOSITORY_TOOL: ${name}`));
    }
  } catch (error) {
    return failure(error);
  }
}
