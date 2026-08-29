import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Transport-neutral MCP tool schema used by legacy, repository and Runtime surfaces. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Bounded text-first result contract shared by Forge MCP adapters. */
export type CallToolResult = Omit<SdkCallToolResult, 'content'> & {
  content: Array<{ type: 'text'; text: string }>;
};
