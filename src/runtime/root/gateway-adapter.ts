import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createForgeMcpServerFromContext, createMcpToolContext } from '../../../adapters/mcp/server';
import { controllerExposureSnapshot } from '../../../adapters/mcp/toolset';
import type { RuntimeControllerServices } from './controller-services';

export interface RuntimeGatewayServerOptions {
  controllerHome: string;
  runtimeInstanceId: string;
  runtimeSourceRoot: string;
  sessionId?: string;
  controllerType?: 'chatgpt' | 'codex' | 'claude' | 'grok';
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
    controllerType: options.controllerType,
    controllerInstanceId: options.runtimeInstanceId,
    runtimeSourceRoot: options.runtimeSourceRoot,
  });
  return createForgeMcpServerFromContext(context);
}

/** The Canonical Runtime is the sole publisher of the MCP schema fence. */
export function runtimeGatewayToolSurfaceFingerprint(options: Omit<RuntimeGatewayServerOptions, 'sessionId'>): string {
  const context = createMcpToolContext({
    controllerHome: options.controllerHome,
    profile: 'controller',
    controllerInstanceId: options.runtimeInstanceId,
    runtimeSourceRoot: options.runtimeSourceRoot,
  });
  return controllerExposureSnapshot(context).fingerprint;
}
