import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createForgeMcpServer, type McpServerOptions } from '../server';

export async function startMcpStdio(opts: McpServerOptions): Promise<void> {
  const server = createForgeMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
