import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { createMcpHandler, isLegacyRequest, Server, type Tool } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { McpSessionRegistry, type McpSessionRoute, type McpSessionSnapshot } from '../../../adapters/mcp/transports/session-registry';
import { FORGE_VERSION } from '../../version';

export const RECOVERY_MCP_SESSION_ROUTE: McpSessionRoute = '/recovery/mcp';
const RECOVERY_MCP_PRINCIPAL_ID = 'standalone-recovery-oauth-client';
const RECOVERY_MCP_CONNECTION_ID = 'forge-standalone-recovery';

export interface RecoveryMcpRequestContext {
  remoteAddress: string;
}

export interface RecoveryMcpSessionServerOptions {
  tools: readonly Tool[];
  dispatchTool(name: string, args: Record<string, unknown>, context: RecoveryMcpRequestContext): Promise<unknown>;
}

type RecoveryMcpSessionContext = RecoveryMcpRequestContext;
type RecoveryMcpRegistry = McpSessionRegistry<NodeStreamableHTTPServerTransport, RecoveryMcpSessionContext>;

function sessionId(request: IncomingMessage): string | undefined {
  const value = request.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

function isInitialize(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { method?: unknown }).method === 'initialize');
}

function initializeClientIdentity(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown-client';
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'unknown-client';
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  if (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo)) return 'unknown-client';
  const name = typeof (clientInfo as { name?: unknown }).name === 'string' ? (clientInfo as { name: string }).name.trim() : 'unknown';
  const version = typeof (clientInfo as { version?: unknown }).version === 'string' ? (clientInfo as { version: string }).version.trim() : 'unknown';
  return `${name || 'unknown'}/${version || 'unknown'}`.slice(0, 200);
}

function sendSessionLookupError(response: ServerResponse, id: string | undefined): void {
  const missing = !id?.trim();
  response.statusCode = missing ? 400 : 404;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('Mcp-Session-Reset', 'reinitialize');
  response.setHeader('x-forge-session-reset', 'reinitialize');
  response.end(JSON.stringify(missing ? {
    error: 'missing_session',
    code: 'MCP_SESSION_REQUIRED',
    message: 'Mcp-Session-Id header is required for this request.',
    recoverable: true,
    action: 'reinitialize',
  } : {
    error: 'session_not_found',
    code: 'MCP_SESSION_EXPIRED',
    message: 'MCP session not found or expired; initialize a new session.',
    recoverable: true,
    action: 'reinitialize',
  }));
}

export class RecoveryMcpSessionServer {
  private readonly registry: RecoveryMcpRegistry;

  constructor(private readonly options: RecoveryMcpSessionServerOptions) {
    this.registry = new McpSessionRegistry<NodeStreamableHTTPServerTransport, RecoveryMcpSessionContext>({
      maximumSessions: 16,
      maximumSessionsPerPrincipal: 16,
    });
  }

  snapshot(): McpSessionSnapshot {
    return this.registry.snapshot();
  }

  async close(): Promise<void> {
    await this.registry.closeAll('shutdown');
  }

  async handle(request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void> {
    await this.registry.prune();
    if (request.method === 'POST') {
      if (await this.handleModernPost(request, response, body)) return;
      await this.handlePost(request, response, body);
      return;
    }
    if (request.method === 'GET') {
      await this.handleGet(request, response);
      return;
    }
    if (request.method === 'DELETE') {
      await this.handleDelete(request, response);
      return;
    }
    response.statusCode = 405;
    response.end();
  }

  /**
   * MCP 2026-07-28 is the canonical Recovery serving path. Modern requests are
   * sessionless and therefore survive Recovery gateway replacement without
   * depending on an in-memory Mcp-Session-Id registry. The legacy stateful
   * transport below remains explicit compatibility for 2025-era clients.
   */
  private async handleModernPost(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<boolean> {
    const webRequest = await toWebRequest(request, body);
    if (await isLegacyRequest(webRequest, body)) return false;

    const context: RecoveryMcpSessionContext = {
      remoteAddress: request.socket.remoteAddress ?? 'unknown',
    };
    const handler = createMcpHandler(async () => this.createServer(context), {
      legacy: 'reject',
      responseMode: 'auto',
    });
    try {
      await toNodeHandler(handler)(request, response, body);
    } finally {
      await handler.close();
    }
    return true;
  }

  private createServer(context: RecoveryMcpSessionContext): Server {
    const server = new Server(
      { name: 'forge-standalone-recovery', version: FORGE_VERSION },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({ tools: [...this.options.tools] }));
    server.setRequestHandler('tools/call', async (request) => {
      const name = request.params.name;
      const args = request.params.arguments && typeof request.params.arguments === 'object' && !Array.isArray(request.params.arguments)
        ? request.params.arguments as Record<string, unknown>
        : {};
      try {
        const payload = await this.options.dispatchTool(name, args, context);
        const structuredContent = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : { value: payload };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Recovery request rejected' }],
        };
      }
    });
    return server;
  }

  private async handlePost(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const currentSessionId = sessionId(request);
    if (isInitialize(body)) {
      if (currentSessionId) {
        response.setHeader('Mcp-Session-Reset', 'reinitialized');
        response.setHeader('x-forge-session-reset', 'reinitialized');
      }
      const reservationId = await this.registry.reserveForInitialize({
        principalId: RECOVERY_MCP_PRINCIPAL_ID,
        connectionId: RECOVERY_MCP_CONNECTION_ID,
        route: RECOVERY_MCP_SESSION_ROUTE,
        ...(currentSessionId ? { supersedeSessionId: currentSessionId } : {}),
      });
      if (!reservationId) {
        response.statusCode = 503;
        response.setHeader('retry-after', '1');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({
          error: 'session_capacity',
          code: 'MCP_SESSION_CAPACITY',
          recoverable: true,
          retryable: true,
          action: 'retry',
        }));
        return;
      }
      const context: RecoveryMcpSessionContext = { remoteAddress: request.socket.remoteAddress ?? 'unknown' };
      let transport: NodeStreamableHTTPServerTransport | undefined;
      let initializedSessionId: string | undefined;
      try {
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string): void => {
            this.registry.commitInitialize(reservationId, {
              sessionId: newSessionId,
              transport: transport!,
              toolContext: context,
              route: RECOVERY_MCP_SESSION_ROUTE,
              principalId: RECOVERY_MCP_PRINCIPAL_ID,
              connectionId: RECOVERY_MCP_CONNECTION_ID,
              clientIdentity: initializeClientIdentity(body),
            });
            initializedSessionId = newSessionId;
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) this.registry.detach(transport.sessionId);
        };
        const server = this.createServer(context);
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } finally {
        if (initializedSessionId) this.registry.endPost(initializedSessionId);
        this.registry.releaseInitialize(reservationId);
        if (!transport?.sessionId) await transport?.close().catch(() => undefined);
      }
      return;
    }

    if (!currentSessionId) {
      sendSessionLookupError(response, currentSessionId);
      return;
    }
    const managed = this.registry.get(currentSessionId);
    if (!managed || managed.route !== RECOVERY_MCP_SESSION_ROUTE || managed.principalId !== RECOVERY_MCP_PRINCIPAL_ID) {
      sendSessionLookupError(response, currentSessionId);
      return;
    }
    this.registry.beginPost(currentSessionId);
    try {
      await managed.transport.handleRequest(request, response, body);
    } finally {
      this.registry.endPost(currentSessionId);
    }
  }

  private async handleGet(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const currentSessionId = sessionId(request);
    const managed = currentSessionId ? this.registry.get(currentSessionId) : undefined;
    if (!managed || managed.route !== RECOVERY_MCP_SESSION_ROUTE || managed.principalId !== RECOVERY_MCP_PRINCIPAL_ID) {
      sendSessionLookupError(response, currentSessionId);
      return;
    }
    this.registry.beginStream(currentSessionId!);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.registry.endStream(currentSessionId!);
    };
    request.once('aborted', release);
    response.once('close', release);
    try {
      await managed.transport.handleRequest(request, response);
    } catch (error) {
      release();
      throw error;
    }
  }

  private async handleDelete(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const currentSessionId = sessionId(request);
    const managed = currentSessionId ? this.registry.get(currentSessionId) : undefined;
    if (!managed || managed.route !== RECOVERY_MCP_SESSION_ROUTE || managed.principalId !== RECOVERY_MCP_PRINCIPAL_ID) {
      sendSessionLookupError(response, currentSessionId);
      return;
    }
    this.registry.setPendingCloseReason(currentSessionId!, 'client_delete');
    await managed.transport.handleRequest(request, response);
    if (this.registry.get(currentSessionId!)) await this.registry.close(currentSessionId!, 'client_delete');
  }
}
