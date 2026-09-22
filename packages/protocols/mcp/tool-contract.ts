import type { CallToolResult as SdkCallToolResult, Tool as SdkTool } from "@modelcontextprotocol/server";

/** Transport-neutral MCP tool schema used by legacy, repository and Runtime surfaces. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Convert an SDK tool into Forge's transport-neutral tool contract. */
export function mcpToolDefinitionFromSdk(tool: SdkTool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(tool.annotations ? { annotations: tool.annotations as unknown as Record<string, unknown> } : {}),
  };
}

/**
 * Convert the Forge tool contract at the SDK boundary. Forge intentionally
 * keeps JSON Schema transport-neutral internally; MCP tools are object-input
 * operations, so enforce that invariant once instead of leaking SDK schema
 * types through every tool-definition module.
 */
export function mcpToolDefinitionToSdk(tool: McpToolDefinition): SdkTool {
  if (tool.inputSchema.type !== 'object') {
    throw new Error(`MCP_TOOL_INPUT_SCHEMA_OBJECT_REQUIRED: ${tool.name}`);
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as SdkTool['inputSchema'],
    ...(tool.annotations ? { annotations: tool.annotations as SdkTool['annotations'] } : {}),
  };
}

/** Bounded text-first result contract shared by Forge MCP adapters. */
export type CallToolResult = Omit<SdkCallToolResult, 'content'> & {
  content: Array<{ type: 'text'; text: string }>;
};
