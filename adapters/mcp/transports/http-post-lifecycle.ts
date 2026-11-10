import type { Response } from 'express';

export interface McpPostReconcileOptions {
  nowMs?: number;
  /** Bound for a POST that has not started responding (no headers written). */
  stalledPostMs?: number;
  /** Bound for a POST that is already streaming a response. */
  streamLeaseMs?: number;
  /** Called after a bounded stale response is removed from the registry. */
  onReclaim?: (response: Response, startedAt: number, ageMs: number) => void;
}

/**
 * Converge the response-owned POST registry from authoritative response state.
 * Event listeners remain the hot path, but an SDK or runtime may never deliver
 * them: Bun 1.3 does not emit `close`/`aborted` and does not update
 * `destroyed`/`closed` when a client disconnects before the response settles.
 * Without a time bound such a response would hold an admission slot forever and
 * permanently exhaust `MCP_SERVER_BUSY` capacity.
 *
 * A response that has not written headers is reclaimed after `stalledPostMs`;
 * a streaming response (including `subscriptions/listen`) gets the existing
 * stream lease. A connected response within both bounds is retained.
 */
export function reconcileFinishedMcpPosts(
  activePostStartedAt: Map<Response, number>,
  options: McpPostReconcileOptions = {},
): void {
  const now = options.nowMs ?? Date.now();
  for (const [response, startedAt] of activePostStartedAt) {
    if (
      response.writableEnded
      || response.writableFinished
      || response.destroyed
      || response.closed
    ) {
      activePostStartedAt.delete(response);
      continue;
    }
    const boundMs = response.headersSent ? options.streamLeaseMs : options.stalledPostMs;
    if (boundMs === undefined || boundMs <= 0) continue;
    const ageMs = Math.max(0, now - startedAt);
    if (ageMs < boundMs) continue;
    activePostStartedAt.delete(response);
    options.onReclaim?.(response, startedAt, ageMs);
  }
}

export interface McpActivePostRegistry {
  activePostStartedAt: Map<Response, number>;
  /** Bounded stale responses removed from admission because no terminal event arrived. */
  reclaimedStalePosts?: number;
}

/**
 * Apply admission liveness bounds to the registry and terminate reclaimed
 * responses. This is the shared authority for both request admission and
 * observation routes so a gateway cannot report capacity that it will never
 * release.
 */
export function reconcileActiveMcpPosts(
  registry: McpActivePostRegistry,
  bounds: { stalledPostMs: number; streamLeaseMs: number; nowMs?: number },
): void {
  reconcileFinishedMcpPosts(registry.activePostStartedAt, {
    nowMs: bounds.nowMs,
    stalledPostMs: bounds.stalledPostMs,
    streamLeaseMs: bounds.streamLeaseMs,
    onReclaim: (response, _startedAt, ageMs) => {
      const streaming = response.headersSent === true;
      registry.reclaimedStalePosts = (registry.reclaimedStalePosts ?? 0) + 1;
      console.error(
        `[forge mcp] reclaimed stale MCP POST response after ${Math.round(ageMs / 1_000)}s (streaming=${streaming})`,
      );
      terminateReclaimedMcpPost(response);
    },
  });
}

/**
 * Terminate a POST response that outlived its admission bound. Attempts a
 * terminal 504 only while no headers have been written; a streaming response is
 * closed as-is because its status line is already committed.
 */
export function terminateReclaimedMcpPost(response: Response): void {
  try {
    if (!response.headersSent) {
      response.status(504).json({
        error: 'request_timeout',
        code: 'MCP_ACTIVE_POST_STALLED',
        message: 'This MCP request exceeded its active-response bound; retry if the client is still connected.',
        recoverable: true,
        retryable: true,
        action: 'retry',
      });
    }
  } catch {
    // The response may already be detached (client gone); closing is best effort.
  }
  try {
    response.destroy();
  } catch {
    // A detached or already-closed response needs no further cleanup.
  }
}
