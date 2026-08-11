import { FACADE_TOOLS } from '../../runtime/control-plane/facade/types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

/**
 * Default ChatGPT-facing MCP surface. The Runtime keeps every internal atomic
 * handler and the full compatibility profile; ChatGPT only needs this bounded
 * execution surface. Atomic Git / issue-task / campaign / edit-session / plugin
 * tools remain registered and reachable through `toolset=full`.
 */
export const DEFAULT_CONTROLLER_TOOL_NAMES = [
  ...PREFERRED_FACADE_TOOL_NAMES,

  // Repository selection / bootstrap.
  'repository_list',
  'repository_get',
  'repository_register',

  // Generic repository-scoped command (readonly fast path, mutation, destructive gate).
  'repository_command_execute',

  // Source inspection and bounded Direct Edit. Code location is routed through
  // rh_context.search; the low-level search_repository handler remains in full.
  'read_repository_file',
  'repository_safe_patch_apply',

  // Focused checks through Process Runtime.
  'run_check',

  // One typed plugin dispatcher. Plugin discovery/action schemas stay routed
  // through rh_context(capability_id=plugin.<plugin>.<action>) to avoid widening
  // the default surface with list/get plugin atomics.
  'plugin_action_execute',

  // Managed Process Runtime lifecycle (attach / poll / cancel — never re-exec).
  'process_get',
  'process_wait',
  'process_logs',
  'process_cancel',

  // Evidence and approval.
  'result_read',
  'result_search',
  'approval_resolve',
] as const;

/** Minimal bootstrap subset retained for diagnostics and constrained clients. */
export const BOOTSTRAP_CONTROLLER_TOOL_NAMES = [
  ...PREFERRED_FACADE_TOOL_NAMES,
  'repository_access_get',
  'repository_list',
  'repository_get',
  'repository_register',
  'repository_latest_source_diagnose',
  'repository_bootstrap_local_project',
] as const;

/**
 * Stable ChatGPT connector schema. Keep this identical to the bounded default
 * Runtime surface so discovery never advertises atomic tools that the default
 * Forge build will reject. The exhaustive `full` profile is assembled directly
 * from registered definitions and remains available for explicit compatibility
 * clients without widening the normal connector schema.
 */
export const STABLE_CONTROLLER_TOOL_NAMES = DEFAULT_CONTROLLER_TOOL_NAMES;

/** Core is a compatibility label for the bounded default Controller surface. */
export const CORE_CONTROLLER_TOOL_NAMES = DEFAULT_CONTROLLER_TOOL_NAMES;
