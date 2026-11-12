/**
 * MCP tool schema definitions for the Repository tool surface.
 *
 * Definitions only: execution authority lives in the protocol-neutral
 * repository-tool-dispatch module, which every transport shares.
 */
import type { McpToolDefinition } from '../../../packages/protocols/mcp/tool-contract';
import { EDIT_OPERATION_INPUT_SCHEMA } from '../../../src/runtime/editing/edit-operation-contract';

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
  }, ['repo_id']),
  definition('repository_workbench', 'Return Workbench state or invoke one bounded Thin Harness operation without adding top-level MCP tools. Prefer batch_execute for multi-step status→search→read→diff or read→patch→check flows so ChatGPT pays one routing/receipt ownership cycle.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repository-scoped operations.' },
    include_removed: { type: 'boolean' },
    operation: {
      type: 'string',
      enum: ['summary', 'batch_execute', 'lanes_execute', 'lanes_integrate', 'fast_receipt_get', 'fast_receipt_list', 'execution_route'],
      description: 'Defaults to summary. Use batch_execute for multi-step repository capability execution and lanes_execute for limited parallel reads. Workflow/mode selection belongs to the model/user, not Workbench.',
    },
    payload: {
      type: 'object',
      description: 'Operation-specific bounded arguments. Batch write operations should include request_id. For batch_execute: { steps:[{id?, kind, input}], stop_on_error?, allowed_paths?, timeout_ms?, request_id?, purpose? }.' ,
      additionalProperties: true,
    },
  }),
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
  definition('repository_git_delete_branch', 'Delete one safe Git branch. Defaults to local deletion; remote=true requires an exact expected_remote_sha CAS against origin and reconciles the remote ref after the push.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    branch: { type: 'string' },
    force: { type: 'boolean', description: 'Local deletion only. Remote deletion never accepts force.' },
    remote: { type: 'boolean', description: 'When true, delete exactly origin/<branch> with expected_remote_sha CAS and remote readback.' },
    expected_remote_sha: { type: 'string', description: 'Required with remote=true: exact 40-hex current origin branch SHA.' },
    approval_request_id: { type: 'string', description: 'Resolved approvalRequestId returned by approval_resolve for this exact remote deletion.' },
  }, ['branch']),

  definition('repository_git_remove_worktree', 'Preview then safely remove one exactly registered clean, merged, unowned Git linked checkout; never deletes arbitrary paths, the canonical/active checkout, or branches.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Required exact registered target checkout identity; never a filesystem path.' },
    expected_head: { type: 'string', description: 'Exact HEAD from the current preview, required for confirmation.' },
    expected_identity: { type: 'string', description: 'Physical device/inode witness from preview, required for confirmation.' },
    preview_token: { type: 'string', description: 'Exact approval token returned from a clean preview; bound to the Git snapshot.' },
    confirm_cleanup: { type: 'boolean', description: 'False/omitted previews. True requires expected_head and preview_token.' },
  }, ['repo_id', 'checkout_id']),

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
    operations: { type: 'array', items: EDIT_OPERATION_INPUT_SCHEMA, description: 'Typed edit operations. Use type=create for a new path; write/replace/insert/prepend/append/delete require an existing target and preserve strict preconditions.' },
    chunk_size: { type: 'number', description: 'Maximum operations per deterministic chunk. Capped at 100.' },
  }, ['operations'], true),
  definition('repository_safe_patch_apply', 'Apply one coherent deterministic edit batch and return bounded review evidence. Checks are opt-in: pass check_ids only when the batch is stable. Long checks return managed Process handles instead of blocking the MCP call; use validation_only with the returned session/request ids to join later without replaying the patch.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    session_id: { type: 'string', description: 'Existing edit session id. Required for validation_only; otherwise omit to create one.' },
    purpose: { type: 'string', description: 'Purpose for a newly created edit session.' },
    operations: { type: 'array', items: EDIT_OPERATION_INPUT_SCHEMA, description: 'Typed edit operations. Use type=create for a new path; write/replace/insert/prepend/append/delete require an existing target and preserve strict preconditions. Required unless validation_only=true.' },
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
  definition('execute_command', 'Single terminal entry. Registered repository commands use Process Runtime handles; workspace_root targets are bounded direct execution (maximum 30 seconds, no durable handle). No Work or Plan required; host scope requires the existing process:exec Grant.', {
    repo_id: repoId,
    checkout_id: { type: 'string', description: 'Optional checkout identity for repositories with multiple local clones.' },
    scope: { type: 'string', enum: ['repository', 'host'], description: 'Defaults to repository; host requires an explicit process:exec ForgeInstance Grant.' },
    command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Repository: typed argv or shell string; host: typed argv only.' },
    shell_command: { type: 'string', description: 'Host shell only; mutually exclusive with command and requires scope=host.' },
    request_id: { type: 'string', description: 'Stable invocation id for reconnect without duplicate effects.' },
    cwd: { type: 'string', description: 'Optional root-relative working directory.' },
    mutation_paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Optional model-declared repository-relative paths/directories this command may mutate. Forge converts these to mechanical source-write claims; this narrows concurrency scope but never grants command permission.' },
    workspace_root: { type: 'string', description: 'Absolute existing directory used as an ephemeral execution root. Mutually exclusive with repo_id/checkout_id; direct commands are capped at 30 seconds with no durable Process handle. Use a registered repository checkout for longer operations.' },
    dry_run: { type: 'boolean', description: 'Preview without executing: returns command classification, approval token and Git snapshots for repository/workspace target.' },
    approval_token: { type: 'string', description: 'Exact approval token returned by execute_command(dry_run=true).' },
    approval_request_id: { type: 'string', description: 'Resolved approvalRequestId returned by approval_resolve.' },
    timeout_ms: { type: 'number', description: 'Optional execution timeout in milliseconds; workspace_root direct execution is capped at 30000ms even if a larger budget is requested.' },
    max_output_bytes: { type: 'number', minimum: 1024, maximum: 1048576, description: 'Captured output limit 1024–1048576 bytes.' },
    interactive_wait_ms: { type: 'number', description: 'Optional short attachment window for registered repositories; long commands there return a handle. workspace_root direct execution never returns a Process handle.' },
  }),

  // Thin Harness V1 is exposed through repository_workbench operations to keep the stable tool surface bounded.
];

export const repositoryToolNames = repositoryToolDefinitions.map((tool) => tool.name);

