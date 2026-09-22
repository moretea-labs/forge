import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { callPluginAdapter } from './plugin-adapter';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

/**
 * Compatibility translation only: legacy iOS MCP tool names are normalized to
 * the canonical typed iOS plugin action surface. This module owns no runtime,
 * repository, Work, approval, or plugin execution state.
 */
export interface LegacyIosPluginInvocation {
  actionId: string;
  requestId: string;
  arguments: Record<string, unknown>;
  confirmAuthorization: boolean;
}

function definedArguments(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] as string : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === 'number' ? args[key] as number : undefined;
}

export function legacyIosPluginInvocation(
  legacyTool: string,
  args: Record<string, unknown>,
): LegacyIosPluginInvocation | undefined {
  const invocation = (() => {
    switch (legacyTool) {
      case 'ios_xcode_status':
        return { actionId: 'xcode_status', arguments: {} };
      case 'ios_simulators_list':
        return { actionId: 'list_simulators', arguments: { runtime: optionalString(args, 'runtime'), name: optionalString(args, 'name') } };
      case 'ios_project_discover':
        return { actionId: 'discover_project', arguments: {} };
      case 'ios_schemes_list':
        return { actionId: 'list_schemes', arguments: { workspace: optionalString(args, 'workspace'), project: optionalString(args, 'project') } };
      case 'ios_simulator_boot':
        return { actionId: 'launch_simulator', arguments: { udid: String(args.udid ?? '').trim(), open_simulator: args.open_simulator !== false, timeout_ms: optionalNumber(args, 'timeout_ms') } };
      case 'ios_app_build':
        return { actionId: 'build', arguments: { scheme: String(args.scheme ?? '').trim(), udid: optionalString(args, 'udid'), simulator_name: optionalString(args, 'simulator_name'), workspace: optionalString(args, 'workspace'), project: optionalString(args, 'project'), configuration: optionalString(args, 'configuration'), timeout_ms: optionalNumber(args, 'timeout_ms') } };
      case 'ios_simulator_screenshot':
        return { actionId: 'capture_screenshot', arguments: { udid: String(args.udid ?? '').trim(), label: optionalString(args, 'label') } };
      case 'ios_ui_smoke_test':
        return { actionId: 'smoke_review', arguments: { scheme: optionalString(args, 'scheme'), bundle_id: optionalString(args, 'bundle_id'), udid: optionalString(args, 'udid'), simulator_name: optionalString(args, 'simulator_name'), workspace: optionalString(args, 'workspace'), project: optionalString(args, 'project'), configuration: optionalString(args, 'configuration'), app_path: optionalString(args, 'app_path'), screenshot_label: optionalString(args, 'screenshot_label') } };
      default:
        return undefined;
    }
  })();
  if (!invocation) return undefined;
  const requestId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : `legacy-${legacyTool}-${Date.now()}`;
  return {
    actionId: invocation.actionId,
    requestId,
    arguments: definedArguments(invocation.arguments),
    confirmAuthorization: args.confirm_authorization === true,
  };
}


const LEGACY_IOS_PLUGIN_TOOLS = new Set([
  'ios_xcode_status', 'ios_simulators_list', 'ios_project_discover', 'ios_schemes_list',
  'ios_simulator_boot', 'ios_app_build', 'ios_simulator_screenshot', 'ios_ui_smoke_test',
]);
const RETIRED_IOS_ATOMIC_TOOLS = new Set(['ios_app_install', 'ios_app_launch', 'ios_simulator_log_tail']);

/** Thin compatibility dispatch. Execution remains owned by the typed iOS plugin application path. */
export async function callLegacyIosAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (RETIRED_IOS_ATOMIC_TOOLS.has(name)) {
    return result({
      accepted: false,
      mode: 'compatibility_migration',
      path: 'plugin_action_execute',
      rejectCode: 'LEGACY_IOS_ATOMIC_RETIRED',
      message: `${name} no longer owns an independent iOS execution path. Use plugin_action_execute with plugin_id=ios and action_id=smoke_review for staged simulator validation.`,
      migration: { tool: 'plugin_action_execute', plugin_id: 'ios', action_id: 'smoke_review' },
    }, true);
  }
  if (!LEGACY_IOS_PLUGIN_TOOLS.has(name)) return undefined;
  const repository = selected(ctx, args);
  const invocation = legacyIosPluginInvocation(name, args);
  if (!invocation) return undefined;
  return callPluginAdapter(ctx, 'plugin_action_execute', {
    repo_id: repository.repoId,
    checkout_id: repository.activeCheckoutId,
    plugin_id: 'ios',
    action_id: invocation.actionId,
    request_id: invocation.requestId,
    arguments: invocation.arguments,
    ...(invocation.confirmAuthorization ? { confirm_authorization: true } : {}),
  });
}
