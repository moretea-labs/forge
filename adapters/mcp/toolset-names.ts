import { FACADE_TOOLS } from '../../src/runtime/control-plane/facade/types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

/**
 * Default ChatGPT-facing MCP surface. The Runtime retains atomic handlers
 * internally, while ChatGPT sees this bounded execution surface. Historical
 * `toolset=full` configurations select this same published ABI.
 */
export const DEFAULT_CONTROLLER_TOOL_NAMES = [
  ...PREFERRED_FACADE_TOOL_NAMES,

  // Repository selection / bootstrap.
  'repository_list',
  'repository_get',
  'repository_register',

  // Unified terminal entry; scope determines its authorized execution target.
  'execute_command',

  // Source inspection and bounded Direct Edit. Code location is routed through
  // rh_context.search; the low-level search_repository handler remains in full.
  'read_repository_file',
  'repository_safe_patch_apply',

  // Focused checks through Process Runtime.
  'run_check',

  // Protected Computer preparation/input use typed direct-non-persistent actions
  // behind the stable plugin dispatcher. Their full-profile atomic tools remain
  // registered only for compatibility clients and are not part of this frozen ABI.

  // One typed plugin dispatcher. Plugin discovery/action schemas stay routed
  // through rh_context(capability_id=plugin.<plugin>.<action>) to avoid widening
  // the default surface with list/get plugin atomics.
  'plugin_action_execute',

  // Managed Process Runtime lifecycle (attach / poll / cancel — never re-exec).
  // Host execution requires execute_command(scope=host) with explicit process:exec Grant.
  'process_get',
  'process_wait',
  'process_logs',
  'process_cancel',

  // Evidence. Approval resolution is available through rh_access/rh_work and
  // internal-only atomic handlers; it does not need a top-level
  // default tool.
  'result_read',
  'result_search',
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
 * Stable ChatGPT connector schema. This is identical to the bounded default
 * Runtime surface; no Controller profile exposes the internal atomic catalog.
 * Historical `full` selections normalize to `advanced` without losing
 * repository, process, evidence, or typed plugin capabilities.
 */
export const STABLE_CONTROLLER_TOOL_NAMES = DEFAULT_CONTROLLER_TOOL_NAMES;

/** Core is a compatibility label for the bounded default Controller surface. */
export const CORE_CONTROLLER_TOOL_NAMES = DEFAULT_CONTROLLER_TOOL_NAMES;
