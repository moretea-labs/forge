import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeControllerServices } from './controller-services';

const CONTROLLER_READY_TOOL = {
  name: 'controller_ready',
  description: 'Read whole-Runtime readiness and the SQLite-backed Controller control-plane inspection.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

export function createRuntimeGatewayServer(
  controller: RuntimeControllerServices,
  principalId: string,
): Server {
  const server = new Server(
    { name: 'forge-runtime', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [CONTROLLER_READY_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== CONTROLLER_READY_TOOL.name) {
      throw new Error(`TOOL_NOT_FOUND: ${request.params.name}`);
    }
    const args = request.params.arguments ?? {};
    if (Object.keys(args).length > 0) throw new Error('INVALID_ARGUMENT: controller_ready accepts no arguments');
    const snapshot = controller.readRuntimeSnapshot();
    const response = { principalId, ...snapshot };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      structuredContent: response,
      isError: false,
    };
  });
  return server;
}
