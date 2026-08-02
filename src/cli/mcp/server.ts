import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpServerInstructions } from './instructions';
import { buildMcpToolDefinitions, callMcpTool, type McpToolContext } from './tools';
import { createLegacyMcpToolContext } from './legacy-context';
import {
  buildMultiRepositoryToolDefinitions,
  callMultiRepositoryTool,
  createMcpToolContext as createMultiRepositoryToolContext,
  type McpServerOptions,
  type MultiRepositoryMcpToolContext,
} from './multi-repository';
import { callAccessTool } from './access-tools';
import { callRepositoryTool } from './repository-tools';
import { callRuntimeTool } from '../../runtime/gateway/mcp/runtime-tools';
import { callExecutionTool } from '../../runtime/gateway/mcp/execution-tools';
import { callProcessTool } from '../../runtime/gateway/mcp/process-tools';
import { injectDurableCommandFields, isGatewayIsolatedTool, routeDurableMcpCall } from '../../runtime/gateway/mcp/router';
import {
  controllerToolInventory,
  controllerExposureSnapshot,
  isControllerToolExposed,
} from './toolset';

export type { McpServerOptions } from './multi-repository';
export { buildMultiRepositoryToolDefinitions, callMultiRepositoryTool } from './multi-repository';

type ServerToolContext = McpToolContext | MultiRepositoryMcpToolContext;

function isMultiRepositoryContext(ctx: ServerToolContext): ctx is MultiRepositoryMcpToolContext {
  return 'controllerHome' in ctx;
}

export function createMcpToolContext(
  opts: McpServerOptions & { profile?: "controller" },
): MultiRepositoryMcpToolContext;
export function createMcpToolContext(opts: McpServerOptions): ServerToolContext;
export function createMcpToolContext(opts: McpServerOptions): ServerToolContext {
  const profile = opts.profile ?? 'controller';
  if (profile !== 'controller') return createLegacyMcpToolContext(opts);
  const repo = opts.repo?.trim() === '.' ? undefined : opts.repo;
  return createMultiRepositoryToolContext({ ...opts, repo });
}

export function createRepoHarnessMcpServerFromContext(baseContext: ServerToolContext): Server {
  const server = new Server(
    { name: 'repo-harness-mcp', version: '1.4.0' },
    { capabilities: { tools: {} }, instructions: mcpServerInstructions(baseContext.policy.profile) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: isMultiRepositoryContext(baseContext)
      ? controllerExposureSnapshot(baseContext).definitions.map(injectDurableCommandFields)
      : buildMcpToolDefinitions(baseContext.policy, { enableChatgptBrowser: baseContext.enableChatgptBrowser === true }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const ctx: ServerToolContext = { ...baseContext, signal: extra.signal };
    if (isMultiRepositoryContext(ctx)) {
      if (!isControllerToolExposed(ctx, name)) {
        if (ctx.toolset === 'core') {
          const advanced = controllerExposureSnapshot({ ...ctx, toolset: 'advanced' });
          const route = controllerToolInventory(advanced.actualToolNames, 'advanced').find((entry) => entry.name === name);
          if (route) {
            const facadeCompletes = Boolean(route.capability === 'facade' || name.startsWith('rh_'));
            const value = {
              error: {
                code: 'unsupported_in_core',
                message: `${name} requires the ${route.capability} capability, which is outside the Core toolset. Use the Advanced or Full profile, or route ordinary work through the bounded rh_ facade.`,
                missingCapability: route.capability,
                currentToolset: 'core',
                suggestedProfile: 'advanced',
                facadeCanComplete: facadeCompletes,
                route: {
                  profile: 'advanced',
                  tool: route.name,
                  capability: route.capability,
                  exposedVia: route.exposedVia,
                },
                requiredCapability: route.capability,
              },
            };
            return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
          }
        }
        const value = {
          error: {
            code: 'TOOL_NOT_FOUND',
            message: `${name} is not registered by this repo-harness build. Tool availability is independent of Request vs Full Access.`,
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: true };
      }
      const accessResult = callAccessTool(ctx, name, args);
      if (accessResult) return accessResult;
      const executionResult = await callExecutionTool(ctx, name, args);
      if (executionResult) return executionResult;
      const processResult = await callProcessTool(ctx, name, args);
      if (processResult) return processResult;
      if (isGatewayIsolatedTool(name)) {
        const isolatedResult = await routeDurableMcpCall(ctx, name, args, { allowReadOnly: true, forceDurable: true });
        if (isolatedResult) return isolatedResult;
      }
      const runtimeResult = await callRuntimeTool(ctx, name, args);
      if (runtimeResult) return runtimeResult;
      const durableResult = await routeDurableMcpCall(ctx, name, args);
      if (durableResult) return durableResult;
      const repositoryResult = await callRepositoryTool(ctx.controllerHome, name, args);
      if (repositoryResult) return repositoryResult;
      return callMultiRepositoryTool(ctx, name, args);
    }
    return callMcpTool(ctx, name, args);
  });
  return server;
}

export function createRepoHarnessMcpServer(opts: McpServerOptions): Server {
  return createRepoHarnessMcpServerFromContext(createMcpToolContext(opts));
}
