import { FACADE_TOOLS } from '../../src/runtime/control-plane/facade/types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

/**
 * Preferred public tool names for model routing and connector freshness.
 * Not an exposure profile: every registered MCP tool is always discoverable.
 * Removal of an obsolete public handler is a source migration, not a toolset switch.
 */
export const PREFERRED_CONTROLLER_TOOL_NAMES = [
  ...PREFERRED_FACADE_TOOL_NAMES,

  // Repository selection / bootstrap.
  'repository_list',
  'repository_get',
  'repository_register',

  // Unified terminal entry; scope determines its authorized execution target.
  'execute_command',

  // Source inspection and bounded Direct Edit. Code location is routed through
  // rh_context.search; the direct search_repository action remains available.
  'read_repository_file',
  'repository_safe_patch_apply',

  // Focused checks through Process Runtime.
  'run_check',

  // Protected Computer preparation/input use typed direct-non-persistent actions
  // behind the stable plugin dispatcher. Distinct OS actions remain public.

  // One typed plugin dispatcher. Plugin discovery/action schemas stay routed
  // through rh_context(capability_id=plugin.<plugin>.<action>) to avoid widening
  // the preferred list with every plugin atomic.
  'plugin_action_execute',

  // Managed Process Runtime lifecycle (attach / poll / cancel — never re-exec).
  // Host execution requires execute_command(scope=host) with explicit process:exec Grant.
  'process_get',
  'process_wait',
  'process_logs',
  'process_cancel',

  // Evidence. The complete registry also exposes exact typed approval actions.
  'result_read',
  'result_search',
] as const;
