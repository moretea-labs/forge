/**
 * Minimal transport-bound execution identity passed from the MCP adapter into
 * Runtime execution services. Runtime code must not depend on the full MCP
 * server/tool context or on adapter implementation modules.
 */
export interface McpExecutionContext {
  controllerHome: string;
  sessionId?: string;
  principalId?: string;
  controllerInstanceId?: string;
}
