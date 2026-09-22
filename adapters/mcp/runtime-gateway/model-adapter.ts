import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  buildModelClientSummary,
  buildModelControlPlaneSummary,
  deepSeekControllerManifest,
  deepSeekFunctionToolManifest,
  prepareDeepSeekControllerHandoff,
  prepareDeepSeekControllerRequest,
  prepareDeepSeekToolCall,
} from '../../../src/runtime/model-clients';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

/** Transport-only compatibility adapter for model-client preview/manifest surfaces. */
export function callModelAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  switch (name) {
    case 'model_clients_summary':
      return result({ clients: buildModelClientSummary(), policyOwner: 'forge', transportEncryption: 'not-configured-by-this-tool' });
    case 'model_control_plane_summary':
      return result({ controlPlane: buildModelControlPlaneSummary(), transportEncryption: 'not-configured-by-this-tool' });
    case 'deepseek_tool_manifest':
      return result({ provider: 'deepseek', tools: deepSeekFunctionToolManifest(), policyOwner: 'forge' });
    case 'deepseek_tool_call_prepare': {
      const functionArguments = args.function_arguments && typeof args.function_arguments === 'object' && !Array.isArray(args.function_arguments)
        ? args.function_arguments as Record<string, unknown>
        : {};
      return result({ prepared: prepareDeepSeekToolCall(String(args.function_name ?? '').trim(), functionArguments) });
    }
    case 'deepseek_controller_manifest':
      return result({ manifest: deepSeekControllerManifest() });
    case 'deepseek_controller_handoff_prepare': {
      const repository = selected(ctx, args);
      return result({ handoff: prepareDeepSeekControllerHandoff({
        reason: args.reason as never,
        objective: typeof args.objective === 'string' ? args.objective : undefined,
        repoId: repository.repoId,
        currentController: typeof args.current_controller === 'string' ? args.current_controller : undefined,
        blockedToolName: typeof args.blocked_tool_name === 'string' ? args.blocked_tool_name : undefined,
        recentSafeError: typeof args.recent_safe_error === 'string' ? args.recent_safe_error : undefined,
      }) });
    }
    case 'deepseek_controller_request_prepare': {
      const repository = selected(ctx, args);
      return result({ preview: prepareDeepSeekControllerRequest({
        reason: args.reason as never,
        objective: typeof args.objective === 'string' ? args.objective : undefined,
        userMessage: typeof args.user_message === 'string' ? args.user_message : undefined,
        repoId: repository.repoId,
        currentController: typeof args.current_controller === 'string' ? args.current_controller : undefined,
        blockedToolName: typeof args.blocked_tool_name === 'string' ? args.blocked_tool_name : undefined,
        recentSafeError: typeof args.recent_safe_error === 'string' ? args.recent_safe_error : undefined,
        model: typeof args.model === 'string' ? args.model : undefined,
      }) });
    }
    default:
      return undefined;
  }
}
