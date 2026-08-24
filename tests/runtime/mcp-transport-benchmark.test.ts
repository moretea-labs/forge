import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { timingLedgerServerDuration } from '../../scripts/benchmark-mcp-transport';
import {
  aggregateMcpTransportLatencySamples,
  extractForgeServerDuration,
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
      writeFileSync(ledger, [
        JSON.stringify({ tool: 'rh_status', traceId: 'trace-a', requestId: 'request-a', totalToolDurationMs: 91.25 }),
        JSON.stringify({ tool: 'rh_status', traceId: 'trace-b', requestId: 'request-b', totalToolDurationMs: 47.5 }),
        '{malformed-latest-line',
      ].join('\n'));
      expect(timingLedgerServerDuration(ledger, 'rh_status', { traceId: 'trace-b', requestId: 'request-b' })).toBe(47.5);
      expect(timingLedgerServerDuration(ledger, 'rh_status', { traceId: 'trace-a', requestId: 'request-a' })).toBe(91.25);
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
    expect(secure.clientTotalMs.p50).toBe(200);
    expect(secure.clientTotalMs.p95).toBe(300);
    expect(secure.externalResidualMs.p50).toBe(120);
    expect(secure.externalResidualMs.p95).toBe(200);
    expect(secure.serverExceedsClientCount).toBe(0);
  });

  test('keeps connection-inclusive samples separate from steady-state tool calls', () => {
    const report = aggregateMcpTransportLatencySamples([
      { label: 'loopback', tool: 'rh_status', timingScope: 'tool_call', clientTotalMs: 20, serverDurationMs: 15 },
      { label: 'loopback', tool: 'rh_status', timingScope: 'connect_and_tool_call', clientTotalMs: 80, serverDurationMs: 15 },
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

  test('rejects malformed samples', () => {
    expect(() => normalizeMcpTransportLatencySample({ label: '', tool: 'rh_status', clientTotalMs: 1, serverDurationMs: 1 })).toThrow();
    expect(() => normalizeMcpTransportLatencySample({ label: 'x', tool: 'rh_status', clientTotalMs: -1, serverDurationMs: 1 })).toThrow();
    expect(() => normalizeMcpTransportLatencySample({ label: 'x', tool: 'rh_status', timingScope: 'bad', clientTotalMs: 1, serverDurationMs: 1 })).toThrow();
  });
});
