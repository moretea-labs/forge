import type { Response } from 'express';

/**
 * Converge the response-owned POST registry from Node's authoritative response
 * state. Event listeners remain the hot path, but an SDK may remove or replace
 * listeners while the terminal ServerResponse flags still remain authoritative.
 * Request age is deliberately irrelevant: a connected unfinished response is
 * retained for as long as it remains live.
 */
export function reconcileFinishedMcpPosts(activePostStartedAt: Map<Response, number>): void {
  for (const response of activePostStartedAt.keys()) {
    if (
      response.writableEnded
      || response.writableFinished
      || response.destroyed
      || response.closed
    ) activePostStartedAt.delete(response);
  }
}
