import { describe, expect, test } from 'bun:test';
import { reconcileReadinessProjectionSource } from '../../src/cli/mcp/readiness-projection';

describe('MCP readiness projection reconciliation', () => {
  test('keeps readiness independent from a retired legacy task ledger', () => {
    const reconciliation = reconcileReadinessProjectionSource({
      projection: { runningWorkers: 0 },
    } as Parameters<typeof reconcileReadinessProjectionSource>[0]);

    expect(reconciliation).toEqual({
      status: 'unknown',
      projectionRunningWorkers: 0,
      detail: 'legacy task ledger retired; readiness uses persisted projection state',
    });
  });
});
