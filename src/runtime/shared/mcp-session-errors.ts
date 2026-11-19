export interface McpSessionLookupErrorResponse {
  status: 400 | 404;
  body: {
    error: 'missing_session' | 'session_not_found';
    code: 'MCP_SESSION_REQUIRED' | 'MCP_SESSION_EXPIRED';
    message: string;
    recoverable: true;
    action: 'reinitialize';
  };
}

export function mcpSessionLookupError(sessionId: string | undefined): McpSessionLookupErrorResponse {
  if (!sessionId?.trim()) {
    return {
      status: 400,
      body: {
        error: 'missing_session',
        code: 'MCP_SESSION_REQUIRED',
        message: 'Mcp-Session-Id header is required for this request.',
        recoverable: true,
        action: 'reinitialize',
      },
    };
  }
  return {
    status: 404,
    body: {
      error: 'session_not_found',
      code: 'MCP_SESSION_EXPIRED',
      message: 'MCP session not found or expired; initialize a new session.',
      recoverable: true,
      action: 'reinitialize',
    },
  };
}
