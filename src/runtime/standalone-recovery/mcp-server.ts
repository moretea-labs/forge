import type { IncomingMessage, ServerResponse } from 'http';
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { FORGE_VERSION } from '../../version';

export interface RecoveryMcpRequestContext {
  remoteAddress: string;
}

export interface RecoveryMcpServerOptions {
  tools: readonly Tool[];
  dispatchTool(name: string, args: Record<string, unknown>, context: RecoveryMcpRequestContext): Promise<unknown>;
}

/**
 * Standalone Recovery owns durable recovery/release authority, never MCP
 * transport-session authority. Both MCP 2026-07-28 and the bounded 2025-era
 * compatibility protocol are served statelessly so a Gateway process
 * replacement cannot invalidate the Recovery control path.
 */
export class RecoveryMcpServer {
  constructor(private readonly options: RecoveryMcpServerOptions) {}

  async close(): Promise<void> {
    // Stateless handlers retain no cross-request transport resources.
  }

  async handle(request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void> {
    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.setHeader('allow', 'POST');
      response.end();
      return;
    }

    const context: RecoveryMcpRequestContext = {
      remoteAddress: request.socket.remoteAddress ?? 'unknown',
    };
    const handler = createMcpHandler(async () => this.createServer(context), {
      legacy: 'stateless',
      responseMode: 'auto',
    });
    try {
      await toNodeHandler(handler)(request, response, body);
    } finally {
      await handler.close();
    }
  }

  private createServer(context: RecoveryMcpRequestContext): Server {
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
}
