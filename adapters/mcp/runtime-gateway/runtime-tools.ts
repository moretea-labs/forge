
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { callLegacyIosAdapter } from './legacy-ios-tool-adapter';
import { result } from './result-adapter';
import { callContextAdapter } from './context-adapter';import { callPluginAdapter } from './plugin-adapter';import { callRecoveryAdapter } from './recovery-adapter';import { callArtifactAdapter } from './artifact-adapter';import { callFilesystemAdapter } from './filesystem-adapter';import { callModelAdapter } from './model-adapter';
import { callProtectedComputerAdapter } from './protected-computer-adapter';
import { callWorkCompatibilityAdapter } from './work-compat-adapter';
import { callRepositoryCompatibilityAdapter } from './repository-compat-adapter';
import { callSchedulerAdapter } from './scheduler-adapter';
import { callRuntimeObservationAdapter } from './runtime-observation-adapter';
import { callExecutionControlAdapter } from './execution-control-adapter';
import { callMaintenanceAdapter } from './maintenance-adapter';
import { callStatusInboxAdapter } from './status-inbox-adapter';
export { boundedPluginArtifactImageContent } from './result-adapter';
export { classifyTerminalCheckEvidence } from '../../../src/runtime/execution/process-runtime/check-result';

export {
  connectorExposedTools,
  currentCallableTools,
  runtimeToolDefinitions,
} from './runtime-tool-definitions';
import { callWorkAdapter, runFacadeRepair } from './work-adapter';

export async function callRuntimeTool(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    const statusInbox = await callStatusInboxAdapter(ctx, name, args, { repair: runFacadeRepair });
    if (statusInbox) return statusInbox;
    const context = await callContextAdapter(ctx, name, args);
    if (context) return context;
    const protectedComputer = await callProtectedComputerAdapter(ctx, name, args);
    if (protectedComputer) return protectedComputer;
    const plugin = await callPluginAdapter(ctx, name, args);
    if (plugin) return plugin;
    const recovery = await callRecoveryAdapter(ctx, name, args);
    if (recovery) return recovery;
    const artifact = callArtifactAdapter(ctx, name, args);
    if (artifact) return artifact;
    const filesystem = callFilesystemAdapter(ctx, name, args);
    if (filesystem) return filesystem;
    const model = callModelAdapter(ctx, name, args);
    if (model) return model;
    const workCompatibility = await callWorkCompatibilityAdapter(ctx, name, args);
    if (workCompatibility) return workCompatibility;
    const repositoryCompatibility = await callRepositoryCompatibilityAdapter(ctx, name, args);
    if (repositoryCompatibility) return repositoryCompatibility;
    const scheduler = await callSchedulerAdapter(ctx, name, args);
    if (scheduler) return scheduler;
    const runtimeObservation = await callRuntimeObservationAdapter(ctx, name, args);
    if (runtimeObservation) return runtimeObservation;
    const executionControl = await callExecutionControlAdapter(ctx, name, args);
    if (executionControl) return executionControl;
    const maintenance = await callMaintenanceAdapter(ctx, name, args);
    if (maintenance) return maintenance;
    const legacyIos = await callLegacyIosAdapter(ctx, name, args);
    if (legacyIos) return legacyIos;
    if (name === 'rh_work') return callWorkAdapter(ctx, args);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}

export { RH_WORK_VERIFY_LEASE_WAIT_MS, runtimeIdentitySnapshot, dispatchedChatgptRelayAuthorizesStaleControllerRecovery, sessionlessFacadeControllerAuthorityMatches } from './work-adapter';
export type { RuntimeIdentitySnapshot } from './work-adapter';
