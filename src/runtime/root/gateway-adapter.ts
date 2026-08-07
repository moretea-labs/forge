import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createForgeMcpServerFromContext, createMcpToolContext } from '../../cli/mcp/server';
import type { RuntimeControllerServices } from './controller-services';

export interface RuntimeGatewayServerOptions {
  controllerHome: string;
  runtimeInstanceId: string;
  sessionId?: string;
}

/**
 * Build the authoritative Controller MCP surface inside the Canonical Runtime.
 *
 * The public OAuth Gateway is intentionally a thin proxy. It must never execute
 * Runtime-owned write operations in its own source-checkout process. The Runtime
 * owns the write claim, Process Runtime leases, Scheduler, and source identity,
 * so all Controller tools ultimately execute here.
 */
export function createRuntimeGatewayServer(
  _controller: RuntimeControllerServices,
  principalId: string,
  options: RuntimeGatewayServerOptions,
): Server {
  const context = createMcpToolContext({
    controllerHome: options.controllerHome,
    profile: 'controller',
    principalId,
    sessionId: options.sessionId,
    controllerInstanceId: options.runtimeInstanceId,
  });
  return createForgeMcpServerFromContext(context);
}
