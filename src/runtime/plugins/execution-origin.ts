export interface McpPluginExecutionOrigin {
  surface: 'mcp';
  actor: string;
  correlationId?: string;
}

/**
 * Preserve the authenticated/controller-issued principal as the plugin actor.
 * A generic tool actor is retained only when no trusted principal is available;
 * local target grants normalize that compatibility actor to controller:shared.
 */
export function mcpPluginExecutionOrigin(
  principalId: string | undefined,
  fallbackActor: string,
  correlationId?: string,
): McpPluginExecutionOrigin {
  const principal = principalId?.trim();
  const fallback = fallbackActor.trim();
  const actor = principal || fallback || 'anonymous';
  const correlation = correlationId?.trim();
  return {
    surface: 'mcp',
    actor,
    ...(correlation ? { correlationId: correlation } : {}),
  };
}
