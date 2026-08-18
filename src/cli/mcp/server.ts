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
import { readRuntimeReleaseAuthority } from '../../runtime/root/release-store';
import { getRuntimeWriteClaim } from '../../runtime/root/write-fence';
import { recordMcpIncident, recordMcpTiming, type McpTimingTrace } from '../../runtime/diagnostics/mcp-timing';
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

function firstTimingString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function timingIdentity(value: CallToolResult | undefined): {
  repoId?: string;
  workId?: string;
  processId?: string;
  route?: string;
} {
  if (!value?.structuredContent || typeof value.structuredContent !== 'object' || Array.isArray(value.structuredContent)) return {};
  const structured = value.structuredContent as Record<string, unknown>;
  const work = structured.work && typeof structured.work === 'object' && !Array.isArray(structured.work)
    ? structured.work as Record<string, unknown>
    : undefined;
  const process = structured.process && typeof structured.process === 'object' && !Array.isArray(structured.process)
    ? structured.process as Record<string, unknown>
    : undefined;
  const resultRef = structured.resultRef && typeof structured.resultRef === 'object' && !Array.isArray(structured.resultRef)
    ? structured.resultRef as Record<string, unknown>
    : undefined;
  return {
    repoId: firstTimingString(structured.repoId, structured.repo_id, work?.repositoryId, work?.repoId),
    workId: firstTimingString(structured.workId, structured.work_id, work?.workId),
    processId: firstTimingString(structured.processId, structured.process_id, process?.processId, resultRef?.processId),
    route: firstTimingString(structured.route, structured.path, structured.mode, process?.route),
  };
}

function tracedResult(
  value: CallToolResult | undefined,
  traceId: string,
  requestId: string,
  serverTiming?: { startedAt: string; durationMs: number },
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
      ...(serverTiming ? { serverStartedAt: serverTiming.startedAt, serverDurationMs: serverTiming.durationMs } : {}),
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
  handler: (requestId: string, traceId: string, phaseTimings: Partial<McpTimingTrace>) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const startedAtWall = new Date().toISOString();
  const startedAt = performance.now();
  const traceId = randomUUID();
  const requestId = recordRequestId(args, rpcId);
  let outcome: 'ok' | 'error' | 'exception' = 'ok';
  let errorCode: string | undefined;
  let executionIdentity: ReturnType<typeof timingIdentity> = {};
  const phaseTimings: Partial<McpTimingTrace> = {};
  try {
    const value = await handler(requestId, traceId, phaseTimings);
    executionIdentity = timingIdentity(value);
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
    const serverDurationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    return tracedResult(value, traceId, requestId, { startedAt: startedAtWall, durationMs: serverDurationMs }) as CallToolResult;
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
      layer: ctx.runtimeSourceRoot ? 'canonical_runtime' : 'public_gateway',
      startedAt: startedAtWall,
      outcome,
      ...(errorCode ? { errorCode } : {}),
      ...executionIdentity,
      ...phaseTimings,
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

export const CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS = 5_000;
/**
 * The loopback connection should fail fast, but a valid Canonical Runtime tool
 * call may legitimately outlive five seconds (for example Work finalization).
 * Do not let the thin Public Gateway report a false timeout while authoritative
 * work continues successfully behind it.
 */
export const CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS = 120_000;
export const CANONICAL_RUNTIME_HANDOFF_WAIT_MS = 20_000;
export const CANONICAL_RUNTIME_HANDOFF_RETRY_INTERVAL_MS = 150;
const CANONICAL_RUNTIME_HANDOFF_SIGNAL_TTL_MS = 90_000;

export interface CanonicalRuntimeReleaseHandoffObservation {
  authorityReleaseId?: string;
  authorityCommittedAt?: string;
  runtimeReleaseId?: string;
  runtimeRunning: boolean;
  runtimeReady: boolean;
  runtimeStartedAt?: string;
  runtimeUpdatedAt?: string;
  recoveryActivationInProgress?: boolean;
  nowMs: number;
}

function timestampIsRecent(value: string | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (!value) return false;
  const observedAt = Date.parse(value);
  if (!Number.isFinite(observedAt)) return false;
  const ageMs = nowMs - observedAt;
  return ageMs >= -5_000 && ageMs <= maxAgeMs;
}

/**
 * Recognize only a bounded whole-Runtime release handoff. An old dead Runtime
 * must not keep the public Gateway waiting forever, so every transition signal
 * is time-bounded. This is observability, never release authority.
 */
export function canonicalRuntimeReleaseHandoffInProgress(
  input: CanonicalRuntimeReleaseHandoffObservation,
): boolean {
  if (!input.authorityReleaseId) return false;
  const sameRelease = input.runtimeReleaseId === input.authorityReleaseId;
  const authorityRecent = timestampIsRecent(
    input.authorityCommittedAt,
    input.nowMs,
    CANONICAL_RUNTIME_HANDOFF_SIGNAL_TTL_MS,
  );

  // The release authority switches only after the old Runtime has completely
  // stopped. Until the new Runtime publishes matching status, this mismatch is
  // the strongest handoff signal. Missing status is equivalent to mismatch only
  // while the authority commit is recent.
  if (!sameRelease && authorityRecent) return true;

  // The new Runtime owns the target release but has not completed scheduler +
  // MCP end-to-end readiness yet.
  if (sameRelease && input.runtimeRunning && !input.runtimeReady) {
    return timestampIsRecent(
      input.runtimeStartedAt ?? input.runtimeUpdatedAt,
      input.nowMs,
      CANONICAL_RUNTIME_HANDOFF_SIGNAL_TTL_MS,
    );
  }

  // Bridge the intentional bootout -> authority-publish gap only while the
  // standalone Recovery transaction explicitly owns the activation lock. A
  // freshly crashed Runtime without that lock is an outage and stays fail-fast.
  if (sameRelease && !input.runtimeRunning) {
    return input.recoveryActivationInProgress === true;
  }

  return false;
}

export interface CanonicalRuntimeHandoffWaitResult {
  waited: boolean;
  settled: boolean;
  observations: number;
}

export async function waitForCanonicalRuntimeReleaseHandoff(
  handoffInProgress: () => boolean,
  options: {
    maxWaitMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<CanonicalRuntimeHandoffWaitResult> {
  const maxWaitMs = Math.max(0, options.maxWaitMs ?? CANONICAL_RUNTIME_HANDOFF_WAIT_MS);
  const intervalMs = Math.max(1, options.intervalMs ?? CANONICAL_RUNTIME_HANDOFF_RETRY_INTERVAL_MS);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let observations = 1;
  if (!handoffInProgress()) return { waited: false, settled: true, observations };
  const deadline = now() + maxWaitMs;
  let waited = false;
  while (now() < deadline) {
    waited = true;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
    observations += 1;
    if (!handoffInProgress()) return { waited, settled: true, observations };
  }
  observations += 1;
  return { waited, settled: !handoffInProgress(), observations };
}

export async function retryCanonicalRuntimeConnectDuringHandoff<T>(
  connect: () => Promise<T>,
  handoffInProgress: () => boolean,
  options: Parameters<typeof waitForCanonicalRuntimeReleaseHandoff>[1] = {},
): Promise<T> {
  const initialWait = await waitForCanonicalRuntimeReleaseHandoff(handoffInProgress, options);
  if (initialWait.waited && !initialWait.settled) {
    // Preserve the ordinary connect failure shape after the bounded handoff
    // window rather than manufacturing a new proxy-only error.
    return await connect();
  }
  try {
    return await connect();
  } catch (error) {
    // Retrying is safe only because connect() has not dispatched a tool call.
    // Once client.callTool() begins, callers must never use this helper.
    if (!handoffInProgress()) throw error;
    const waited = await waitForCanonicalRuntimeReleaseHandoff(handoffInProgress, options);
    if (!waited.settled) throw error;
    return await connect();
  }
}

function recoveryRuntimeReleaseActivationInProgress(controllerHome: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(join(controllerHome, 'recovery', 'locks', 'operation.lock'), 'utf8')) as {
      action?: string;
      acquiredAt?: string;
    };
    if (lock.action !== 'activate_runtime_release' && lock.action !== 'stage_and_activate_runtime_release') return false;
    return timestampIsRecent(lock.acquiredAt, Date.now(), CANONICAL_RUNTIME_HANDOFF_SIGNAL_TTL_MS);
  } catch {
    return false;
  }
}

function canonicalRuntimeReleaseHandoffActive(controllerHome: string): boolean {
  const runtime = observeRuntimeStatus(controllerHome);
  if (runtime.running && runtime.ready) return false;
  const authority = readRuntimeReleaseAuthority(controllerHome);
  return canonicalRuntimeReleaseHandoffInProgress({
    authorityReleaseId: authority?.active.releaseId,
    authorityCommittedAt: authority?.committedAt,
    runtimeReleaseId: runtime.snapshot?.releaseId,
    runtimeRunning: runtime.running,
    runtimeReady: runtime.ready,
    runtimeStartedAt: runtime.snapshot?.startedAt,
    runtimeUpdatedAt: runtime.snapshot?.updatedAt,
    recoveryActivationInProgress: recoveryRuntimeReleaseActivationInProgress(controllerHome),
    nowMs: Date.now(),
  });
}


async function withCanonicalRuntimeClient<T>(
  ctx: MultiRepositoryMcpToolContext,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const connect = async (): Promise<Client> => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error('CANONICAL_RUNTIME_TIMEOUT')), CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS);
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
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  const client = await retryCanonicalRuntimeConnectDuringHandoff(
    connect,
    () => canonicalRuntimeReleaseHandoffActive(ctx.controllerHome),
  );
  try {
    // action() is intentionally outside the retry helper. Tool/schema work is
    // dispatched at most once even if the Runtime changes mid-response.
    return await action(client);
  } finally {
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

interface CanonicalRuntimeProxyIdentity {
  endpoint: URL;
  token: string;
  principalId: string;
  sessionId: string;
}

function canonicalRuntimeProxyIdentity(ctx: MultiRepositoryMcpToolContext): CanonicalRuntimeProxyIdentity {
  return {
    endpoint: canonicalRuntimeEndpoint(ctx),
    token: canonicalRuntimeToken(ctx),
    principalId: ctx.principalId?.trim() ?? '',
    sessionId: ctx.sessionId?.trim() ?? '',
  };
}

function sameCanonicalRuntimeProxyIdentity(
  left: CanonicalRuntimeProxyIdentity,
  right: CanonicalRuntimeProxyIdentity,
): boolean {
  return left.endpoint.href === right.endpoint.href
    && left.token === right.token
    && left.principalId === right.principalId
    && left.sessionId === right.sessionId;
}

type GatewayProxyTiming = Pick<McpTimingTrace,
  | 'gatewayProxyResolveMs'
  | 'gatewayProxyConnectMs'
  | 'gatewayProxyCallMs'
  | 'gatewayProxyCanonicalDispatchLagMs'
  | 'gatewayProxyCanonicalDurationMs'
  | 'gatewayProxyReturnMs'
  | 'gatewayProxyConnectionState'
>;

type MutableGatewayProxyTiming = Partial<GatewayProxyTiming>;

function roundedMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export function deriveCanonicalForwardingTiming(input: {
  gatewayCallStartedAtMs: number;
  gatewayCallDurationMs: number;
  response: CallToolResult;
}): Pick<GatewayProxyTiming, 'gatewayProxyCanonicalDispatchLagMs' | 'gatewayProxyCanonicalDurationMs' | 'gatewayProxyReturnMs'> {
  const structured = input.response.structuredContent;
  const responseMeta = structured && typeof structured === 'object' && !Array.isArray(structured)
    && (structured as Record<string, unknown>).responseMeta
    && typeof (structured as Record<string, unknown>).responseMeta === 'object'
    ? (structured as Record<string, unknown>).responseMeta as Record<string, unknown>
    : undefined;
  const canonicalStartedAt = typeof responseMeta?.serverStartedAt === 'string'
    ? Date.parse(responseMeta.serverStartedAt)
    : Number.NaN;
  const canonicalDurationMs = typeof responseMeta?.serverDurationMs === 'number'
    ? responseMeta.serverDurationMs
    : Number.NaN;
  if (!Number.isFinite(canonicalStartedAt) || !Number.isFinite(canonicalDurationMs)) return {};
  const dispatchLagMs = roundedMs(canonicalStartedAt - input.gatewayCallStartedAtMs);
  const boundedCanonicalDurationMs = roundedMs(canonicalDurationMs);
  return {
    gatewayProxyCanonicalDispatchLagMs: dispatchLagMs,
    gatewayProxyCanonicalDurationMs: boundedCanonicalDurationMs,
    gatewayProxyReturnMs: roundedMs(input.gatewayCallDurationMs - dispatchLagMs - boundedCanonicalDurationMs),
  };
}

function createCanonicalRuntimeProxy(ctx: MultiRepositoryMcpToolContext): {
  callTool: (name: string, args: Record<string, unknown>, timing?: MutableGatewayProxyTiming) => Promise<CallToolResult>;
  close: () => Promise<void>;
} {
  let current: { identity: CanonicalRuntimeProxyIdentity; client: Client } | undefined;
  let connecting: Promise<{ identity: CanonicalRuntimeProxyIdentity; client: Client }> | undefined;

  const closeCurrent = async (expectedClient?: Client): Promise<void> => {
    if (!current || (expectedClient && current.client !== expectedClient)) return;
    const closing = current.client;
    current = undefined;
    await closing.close().catch(() => undefined);
  };

  const connect = async (identity: CanonicalRuntimeProxyIdentity): Promise<{ identity: CanonicalRuntimeProxyIdentity; client: Client }> => {
    const connectOnce = async (): Promise<{ identity: CanonicalRuntimeProxyIdentity; client: Client }> => {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new Error('CANONICAL_RUNTIME_TIMEOUT')), CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${identity.token}`,
      };
      if (identity.principalId) headers['x-forge-forwarded-principal-id'] = identity.principalId;
      if (identity.sessionId) headers['x-forge-forwarded-session-id'] = identity.sessionId;
      const transport = new StreamableHTTPClientTransport(identity.endpoint, {
        requestInit: { headers, signal: abort.signal },
      });
      const client = new Client({ name: 'forge-public-gateway-proxy', version: '1.0.0' });
      try {
        await client.connect(transport);
        return { identity, client };
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };
    return await retryCanonicalRuntimeConnectDuringHandoff(
      connectOnce,
      () => canonicalRuntimeReleaseHandoffActive(ctx.controllerHome),
    );
  };

  const clientForCurrentRuntime = async (timing: MutableGatewayProxyTiming): Promise<Client> => {
    const resolveStarted = performance.now();
    const identity = canonicalRuntimeProxyIdentity(ctx);
    timing.gatewayProxyResolveMs = roundedMs(performance.now() - resolveStarted);
    if (current && sameCanonicalRuntimeProxyIdentity(current.identity, identity)) {
      timing.gatewayProxyConnectionState = 'reused';
      timing.gatewayProxyConnectMs = 0;
      return current.client;
    }

    if (connecting) {
      const connectStarted = performance.now();
      const pending = await connecting;
      timing.gatewayProxyConnectMs = roundedMs(performance.now() - connectStarted);
      if (sameCanonicalRuntimeProxyIdentity(pending.identity, identity)) {
        timing.gatewayProxyConnectionState = 'coalesced_connect';
        return pending.client;
      }
    }

    const reconnect = Boolean(current);
    await closeCurrent();
    const connectStarted = performance.now();
    connecting = connect(identity);
    try {
      current = await connecting;
      timing.gatewayProxyConnectMs = roundedMs(performance.now() - connectStarted);
      timing.gatewayProxyConnectionState = reconnect ? 'identity_reconnect' : 'cold_connect';
      return current.client;
    } finally {
      connecting = undefined;
    }
  };

  return {
    async callTool(name, args, timing = {}) {
      // The endpoint/token identity is intentionally stable across releases, so
      // an old persistent inner MCP client would otherwise be reused into the
      // bootout window. Wait only for a proven release handoff, then discard the
      // stale connection before selecting the current Runtime client.
      const handoff = await waitForCanonicalRuntimeReleaseHandoff(
        () => canonicalRuntimeReleaseHandoffActive(ctx.controllerHome),
      );
      if (handoff.waited) await closeCurrent();
      const client = await clientForCurrentRuntime(timing);
      const gatewayCallStartedAtMs = Date.now();
      const callStarted = performance.now();
      try {
        // The outer Connector session is already bound to the Canonical Runtime
        // schema and fenced by the Runtime-published fingerprint before dispatch.
        // Re-listing tools here creates a second discovery round trip for every
        // tool call without strengthening that fence.
        const response = await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS },
        );
        const result = response as unknown as CallToolResult;
        timing.gatewayProxyCallMs = roundedMs(performance.now() - callStarted);
        Object.assign(timing, deriveCanonicalForwardingTiming({
          gatewayCallStartedAtMs,
          gatewayCallDurationMs: timing.gatewayProxyCallMs,
          response: result,
        }));
        return result;
      } catch (error) {
        timing.gatewayProxyCallMs = roundedMs(performance.now() - callStarted);
        // A Runtime restart, token rotation, or broken HTTP session must never
        // poison later calls. The next request reconnects against fresh identity.
        await closeCurrent(client);
        throw error;
      }
    },
    async close() {
      if (connecting) {
        await connecting.catch(() => undefined);
        connecting = undefined;
      }
      await closeCurrent();
    },
  };
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
  const runtimeProxy = isMultiRepositoryContext(baseContext) && !getRuntimeWriteClaim()
    ? createCanonicalRuntimeProxy(baseContext)
    : undefined;
  server.onclose = () => {
    void runtimeProxy?.close();
  };
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
      return traceControllerMcpRequest(ctx, name, args, typeof rpcId === 'string' || typeof rpcId === 'number' ? rpcId : undefined, async (requestId, _traceId, phaseTimings) => {
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
          const forwardedArgs = typeof args.request_id === 'string' && args.request_id.trim()
            ? args
            : { ...args, request_id: requestId };
          if (runtimeProxy && runtimeSchema) return runtimeProxy.callTool(name, forwardedArgs, phaseTimings);
          if (runtimeProxy && observeRuntimeStatus(ctx.controllerHome).ready) return runtimeProxy.callTool(name, forwardedArgs, phaseTimings);
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
        const repositoryResult = await callRepositoryTool(ctx.controllerHome, name, args, ctx);
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
