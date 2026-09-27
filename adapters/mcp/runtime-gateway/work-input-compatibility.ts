export type RhWorkInputCompatibilityResult =
  | { ok: true; args: Record<string, unknown>; operation: string; scheduleIdOverride?: string; requirementOperationArgs?: Record<string, unknown> }
  | { ok: false; summary: string; data: Record<string, unknown> };

function failure(summary: string, data: Record<string, unknown> = {}): RhWorkInputCompatibilityResult {
  return { ok: false, summary, data };
}

/** Thin Forge has no frozen lifecycle transport. Keep this boundary so callers
 * receive one explicit rejection rather than accidentally reviving old ABI. */
export function normalizeRhWorkInputCompatibility(input: Record<string, unknown>): RhWorkInputCompatibilityResult {
  const args = { ...input };
  const requestedOperation = String(args.operation ?? 'start');
  if (typeof args.capability_id === 'string' && args.capability_id.includes(':')) {
    return failure('FROZEN_MCP_LIFECYCLE_REMOVED: reconnect with the Thin Forge MCP schema.');
  }
  return { ok: true, args, operation: requestedOperation };
}
