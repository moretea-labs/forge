import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { mcpServerInstructions } from './instructions';
import { buildMcpToolDefinitions, callMcpTool, type CallToolResult, type McpToolContext } from './tools';
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
import { controllerExposureSnapshot, isControllerToolExposed } from './toolset';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { observeRuntimeStatus } from '../../runtime/root/status';
import { getRuntimeWriteClaim } from '../../runtime/root/write-fence';
import { recordMcpIncident, recordMcpTiming } from '../../runtime/diagnostics/mcp-timing';
import { FORGE_VERSION, forgeToolSurfaceFingerprint } from '../controller/runtime-config';

export type { McpServerOptions } from './multi-repository';
export { buildMultiRepositoryToolDefinitions, callMultiRepositoryTool } from './multi-repository';

type ServerToolContext = McpToolContext | MultiRepositoryMcpToolContext;

/** A per-session schema read directly from the Canonical Runtime's tools/list. */
export interface CanonicalRuntimeToolSchema {
  definitions: Tool[];
  toolNames: string[];
  fingerprint: string;
}

function isMultiRepositoryContext(ctx: ServerToolContext): ctx is MultiRepositoryMcpToolContext {
  return 'controllerHome' in ctx;
}

function recordRequestId(args: Record<string, unknown>, rpcId: string | number | undefined): string {
  const explicit = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  return explicit || `mcp-rpc:${rpcId === undefined ? randomUUID() : String(rpcId)}`;
}

function tracedResult(
  value: CallToolResult | undefined,
  traceId: string,
  requestId: string,
): CallToolResult | undefined {
  if (!value || !value.structuredContent || typeof value.structuredContent !== 'object' || Array.isArray(value.structuredContent)) return value;
  const originalStructuredContent = value.structuredContent as Record<string, unknown>;
  const structuredContent = {
    ...originalStructuredContent,
    responseMeta: {
      ...(originalStructuredContent.responseMeta && typeof originalStructuredContent.responseMeta === 'object'
        ? originalStructuredContent.responseMeta as Record<string, unknown>
        : {}),
      traceId,
      requestId,
    },
  };
  return {
    ...value,
    structuredContent,
    content: value.content.map((block, index) => index === 0 && block.type === 'text'
      ? { ...block, text: JSON.stringify(structuredContent) }
      : block),
  };
}

async function traceControllerMcpRequest(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
  rpcId: string | number | undefined,
  handler: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  const traceId = randomUUID();
  const requestId = recordRequestId(args, rpcId);
  let outcome: 'ok' | 'error' | 'exception' = 'ok';
  let errorCode: string | undefined;
  try {
    const value = await handler();
    if (value?.isError) {
      outcome = 'error';
      const error = value.structuredContent && typeof value.structuredContent === 'object'
        ? (value.structuredContent as Record<string, unknown>).error
        : undefined;
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        errorCode = typeof (error as Record<string, unknown>).code === 'string'
          ? (error as Record<string, unknown>).code as string
          : 'MCP_TOOL_ERROR';
        recordMcpIncident(ctx.controllerHome, {
          traceId,
          requestId,
          ...(rpcId === undefined ? {} : { rpcId }),
          tool: name,
          kind: 'tool_error',
          code: errorCode,
          message: typeof (error as Record<string, unknown>).message === 'string'
            ? (error as Record<string, unknown>).message as string
            : 'MCP tool returned an error.',
          ...(typeof (value.structuredContent as Record<string, unknown>).repoId === 'string'
            ? { repoId: (value.structuredContent as Record<string, unknown>).repoId as string }
            : {}),
        });
      }
    }
    return tracedResult(value, traceId, requestId) as CallToolResult;
  } catch (error) {
    outcome = 'exception';
    errorCode = 'MCP_REQUEST_EXCEPTION';
    recordMcpIncident(ctx.controllerHome, {
      traceId,
      requestId,
      ...(rpcId === undefined ? {} : { rpcId }),
      tool: name,
      kind: 'exception',
      code: errorCode,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    recordMcpTiming(ctx.controllerHome, {
      tool: name,
      traceId,
      requestId,
      ...(rpcId === undefined ? {} : { rpcId }),
      outcome,
      ...(errorCode ? { errorCode } : {}),
      totalToolDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  }
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

function canonicalRuntimeEndpoint(ctx: MultiRepositoryMcpToolContext): URL {
  const endpoint = observeRuntimeStatus(ctx.controllerHome).snapshot?.endpoint;
  if (!endpoint) throw new Error('CANONICAL_RUNTIME_ENDPOINT_UNAVAILABLE');
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`CANONICAL_RUNTIME_ENDPOINT_NOT_LOOPBACK: ${url.origin}`);
  }
  return url;
}

function canonicalRuntimeToken(ctx: MultiRepositoryMcpToolContext): string {
  const path = join(ctx.controllerHome, 'mcp', 'runtime-token');
  const token = readFileSync(path, 'utf8').trim();
  if (!token) throw new Error('CANONICAL_RUNTIME_TOKEN_UNAVAILABLE');
  return token;
}

const CANONICAL_RUNTIME_MCP_TIMEOUT_MS = 5_000;

async function withCanonicalRuntimeClient<T>(
  ctx: MultiRepositoryMcpToolContext,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('CANONICAL_RUNTIME_TIMEOUT')), CANONICAL_RUNTIME_MCP_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${canonicalRuntimeToken(ctx)}`,
  };
  if (ctx.principalId?.trim()) headers['x-forge-forwarded-principal-id'] = ctx.principalId.trim();
  if (ctx.sessionId?.trim()) headers['x-forge-forwarded-session-id'] = ctx.sessionId.trim();
  const transport = new StreamableHTTPClientTransport(canonicalRuntimeEndpoint(ctx), {
    requestInit: { headers, signal: abort.signal },
  });
  const client = new Client({ name: 'forge-public-gateway-proxy', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await action(client);
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => undefined);
  }
}

/**
 * The public Gateway has no schema cache authority. It obtains each Connector
 * session's schema from the Runtime that will execute its calls.
 */
export async function readCanonicalRuntimeToolSchema(
  ctx: MultiRepositoryMcpToolContext,
): Promise<CanonicalRuntimeToolSchema> {
  const response = await withCanonicalRuntimeClient(ctx, async (client) => await client.listTools());
  const definitions = response.tools as Tool[];
  const toolNames = definitions
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort();
  return {
    definitions,
    toolNames,
    fingerprint: forgeToolSurfaceFingerprint(definitions),
  };
}

async function proxyRuntimeToolCall(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return withCanonicalRuntimeClient(ctx, async (client) => {
    // The outer Connector session is already bound to the Canonical Runtime
    // schema and fenced by the Runtime-published fingerprint before dispatch.
    // Re-listing tools here creates a second discovery round trip for every
    // tool call without strengthening that fence.
    const response = await client.callTool({ name, arguments: args });
    return response as unknown as CallToolResult;
  });
}

function canonicalRuntimeSchemaMatchesGateway(ctx: MultiRepositoryMcpToolContext): boolean {
  const runtimeFingerprint = observeRuntimeStatus(ctx.controllerHome).snapshot?.toolSurfaceFingerprint;
  // Older Runtime status records do not have a schema fence. Preserve a
  // diagnosable compatibility path until the Runtime has been upgraded.
  return !runtimeFingerprint || runtimeFingerprint === controllerExposureSnapshot(ctx).fingerprint;
}

function toolSurfaceMismatchResult(): CallToolResult {
  const value = {
    error: {
      code: 'MCP_TOOL_SURFACE_MISMATCH',
      message: 'Gateway and Canonical Runtime tool surfaces differ. The session must reinitialize against a matching Runtime release.',
      recoverable: true,
      action: 'reinitialize',
    },
  };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

export function createForgeMcpServerFromContext(
  baseContext: ServerToolContext,
  runtimeSchema?: CanonicalRuntimeToolSchema,
): Server {
  const server = new Server(
    { name: 'forge-mcp', version: FORGE_VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: mcpServerInstructions(baseContext.policy.profile) },
  );
  // The connector process can outlive the canonical Runtime release it proxies.
  // Refresh tools after every MCP session initialization so clients do not keep
  // a stale schema when the bounded Runtime surface changes behind the gateway.
  server.oninitialized = () => {
    void server.sendToolListChanged().catch(() => undefined);
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (isMultiRepositoryContext(baseContext) && !runtimeSchema && !getRuntimeWriteClaim() && !canonicalRuntimeSchemaMatchesGateway(baseContext)) {
      throw new Error('MCP_TOOL_SURFACE_MISMATCH: Gateway source does not match the Canonical Runtime schema.');
    }
    return {
      tools: runtimeSchema?.definitions ?? (isMultiRepositoryContext(baseContext)
        ? controllerExposureSnapshot(baseContext).definitions
        : buildMcpToolDefinitions(baseContext.policy, { enableChatgptBrowser: baseContext.enableChatgptBrowser === true })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const ctx: ServerToolContext = { ...baseContext, signal: extra.signal };
    if (isMultiRepositoryContext(ctx)) {
      const rpcId = (request as unknown as { id?: unknown }).id;
      return traceControllerMcpRequest(ctx, name, args, typeof rpcId === 'string' || typeof rpcId === 'number' ? rpcId : undefined, async () => {
        // The public Gateway only exposes its stable facade schema. It may
        // proxy execution, but it never discovers one Runtime schema and
        // validates calls against another source checkout.
        if (!getRuntimeWriteClaim() && !runtimeSchema && !canonicalRuntimeSchemaMatchesGateway(ctx)) {
          return toolSurfaceMismatchResult();
        }
        if (runtimeSchema && !runtimeSchema.toolNames.includes(name)) {
          return toolSurfaceMismatchResult();
        }
        if (!runtimeSchema && !isControllerToolExposed(ctx, name)) {
          const value = {
            error: {
              code: 'TOOL_NOT_FOUND',
              message: `${name} is not registered by this forge build. Tool availability is independent of Request vs Full Access.`,
            },
          };
          return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: true };
        }
        // The public OAuth Gateway is intentionally thin. If this process does
        // not own the Canonical Runtime write claim, forward the complete tool
        // call to the loopback Runtime MCP endpoint. This prevents source-checkout
        // Gateway processes from acquiring Process Runtime leases or evaluating
        // Runtime source coherence against their own checkout.
        if (!getRuntimeWriteClaim()) {
          if (runtimeSchema) return proxyRuntimeToolCall(ctx, name, args);
          if (observeRuntimeStatus(ctx.controllerHome).ready) return proxyRuntimeToolCall(ctx, name, args);
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
      });
    }
    return callMcpTool(ctx, name, args);
  });
  return server;
}

export function createForgeMcpServer(opts: McpServerOptions): Server {
  return createForgeMcpServerFromContext(createMcpToolContext(opts));
}
