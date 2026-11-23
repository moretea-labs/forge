import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMcpConcurrentBatches, timingLedgerServerDuration } from '../../scripts/benchmark-mcp-transport';
import {
  aggregateMcpTransportLatencySamples,
  extractForgeServerDuration,
  mcpServerStartSpreadMs,
  normalizeMcpTransportLatencySample,
} from '../../src/runtime/diagnostics/mcp-transport-benchmark';

describe('MCP transport latency benchmark', () => {
  test('extracts Forge server duration from MCP structured content', () => {
    expect(extractForgeServerDuration({ structuredContent: { responseMeta: { serverDurationMs: 42.5 } } })).toBe(42.5);
    expect(extractForgeServerDuration({ structuredContent: {} })).toBeUndefined();
  });

  test('recovers server duration from the matching MCP timing ledger entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-mcp-timing-ledger-'));
    const ledger = join(root, 'mcp-timings.jsonl');
    try {
      writeFileSync(
        ledger,
        [
          JSON.stringify({ tool: 'rh_status', traceId: 'trace-a', requestId: 'request-a', totalToolDurationMs: 91.25 }),
          JSON.stringify({ tool: 'rh_status', traceId: 'trace-b', requestId: 'request-b', totalToolDurationMs: 47.5 }),
          '{malformed-latest-line',
        ].join('\n'),
      );
      expect(timingLedgerServerDuration(ledger, 'rh_status', { traceId: 'trace-b', requestId: 'request-b' })).toBe(
        47.5,
      );
      expect(timingLedgerServerDuration(ledger, 'rh_status', { traceId: 'trace-a', requestId: 'request-a' })).toBe(
        91.25,
      );
      expect(timingLedgerServerDuration(ledger, 'rh_status', { traceId: 'missing' })).toBeUndefined();
      expect(timingLedgerServerDuration(ledger, 'rh_work', { traceId: 'trace-b' })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('aggregates client, server, and external residual percentiles by transport and tool', () => {
    const report = aggregateMcpTransportLatencySamples([
      { label: 'secure', tool: 'rh_status', clientTotalMs: 200, serverDurationMs: 80 },
      { label: 'secure', tool: 'rh_status', clientTotalMs: 300, serverDurationMs: 100 },
      { label: 'https', tool: 'rh_status', clientTotalMs: 120, serverDurationMs: 75 },
    ]);
    expect(report.sampleCount).toBe(3);
    expect(report.groups).toHaveLength(2);
    const secure = report.groups.find((group) => group.label === 'secure')!;
    expect(secure.timingScope).toBe('tool_call');
    expect(secure.concurrency).toBe(1);
    expect(secure.clientTotalMs.p50).toBe(200);
    expect(secure.clientTotalMs.p95).toBe(300);
    expect(secure.externalResidualMs.p50).toBe(120);
    expect(secure.externalResidualMs.p95).toBe(200);
    expect(secure.serverExceedsClientCount).toBe(0);
  });

  test('keeps connection-inclusive samples separate from steady-state tool calls', () => {
    const report = aggregateMcpTransportLatencySamples([
      { label: 'loopback', tool: 'rh_status', timingScope: 'tool_call', clientTotalMs: 20, serverDurationMs: 15 },
      {
        label: 'loopback',
        tool: 'rh_status',
        timingScope: 'connect_and_tool_call',
        clientTotalMs: 80,
        serverDurationMs: 15,
      },
    ]);
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((group) => group.timingScope).sort()).toEqual(['connect_and_tool_call', 'tool_call']);
  });

  test('clamps negative residuals but reports server/client timing anomalies', () => {
    const report = aggregateMcpTransportLatencySamples([
      { label: 'loopback', tool: 'rh_status', clientTotalMs: 10, serverDurationMs: 11 },
    ]);
    expect(report.groups[0]!.externalResidualMs.p50).toBe(0);
    expect(report.groups[0]!.serverExceedsClientCount).toBe(1);
  });

  test('separates concurrency levels rather than mixing their latency percentiles', () => {
    const report = aggregateMcpTransportLatencySamples([
      { label: 'cloudflare', tool: 'rh_status', concurrency: 8, clientTotalMs: 140, serverDurationMs: 20 },
      { label: 'cloudflare', tool: 'rh_status', concurrency: 16, clientTotalMs: 400, serverDurationMs: 20 },
    ]);
    expect(report.groups.map((group) => [group.concurrency, group.clientTotalMs.p50])).toEqual([
      [8, 140],
      [16, 400],
    ]);
  });

  test('submits true concurrent batches and retains failures independently', async () => {
    let active = 0;
    let maxActive = 0;
    const submitted: number[] = [];
    const batches = await runMcpConcurrentBatches(8, 3, async (requestIndex) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      submitted.push(requestIndex);
      await Promise.resolve();
      active -= 1;
      if (requestIndex === 4) throw new Error('probe failure');
      return requestIndex;
    });
    expect(maxActive).toBe(3);
    expect(submitted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(batches.map((batch) => batch.outcomes.length)).toEqual([3, 3, 2]);
    expect(batches[1]!.outcomes[1]!.status).toBe('rejected');
    expect(batches[2]!.outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(batches.every((batch) => batch.clientBatchTotalMs >= 0)).toBe(true);
  });

  test('rejects invalid concurrent batch inputs', async () => {
    await expect(runMcpConcurrentBatches(2, 0, async () => 1)).rejects.toThrow('MCP_TRANSPORT_BATCH_INVALID');
  });

  test('server ingress spread is independent of client clock skew and response order', () => {
    const samples = [
      { serverStartedAt: '2026-11-24T00:00:00.650Z' },
      { serverStartedAt: '2026-11-24T00:00:00.100Z' },
      { serverStartedAt: '2026-11-24T00:00:01.200Z' },
    ];
    expect(mcpServerStartSpreadMs(samples)).toBe(1100);
    expect(mcpServerStartSpreadMs([...samples].reverse())).toBe(1100);
    expect(mcpServerStartSpreadMs([{ serverStartedAt: '2026-11-24T00:00:01.200Z' }])).toBeUndefined();
    expect(mcpServerStartSpreadMs([{ serverStartedAt: 'invalid' }, {}])).toBeUndefined();
  });

  test('rejects malformed samples', () => {
    expect(() =>
      normalizeMcpTransportLatencySample({ label: '', tool: 'rh_status', clientTotalMs: 1, serverDurationMs: 1 }),
    ).toThrow();
    expect(() =>
      normalizeMcpTransportLatencySample({ label: 'x', tool: 'rh_status', clientTotalMs: -1, serverDurationMs: 1 }),
    ).toThrow();
    expect(() =>
      normalizeMcpTransportLatencySample({
        label: 'x',
        tool: 'rh_status',
        timingScope: 'bad',
        clientTotalMs: 1,
        serverDurationMs: 1,
      }),
    ).toThrow();
    expect(() =>
      normalizeMcpTransportLatencySample({
        label: 'x',
        tool: 'rh_status',
        concurrency: 0,
        clientTotalMs: 1,
        serverDurationMs: 1,
      }),
    ).toThrow();
  });
});
