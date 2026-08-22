import { describe, expect, test } from 'bun:test';
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

  test('aggregates client, server, and external residual percentiles by transport and tool', () => {
    const report = aggregateMcpTransportLatencySamples([
      { label: 'secure', tool: 'rh_status', clientTotalMs: 200, serverDurationMs: 80 },
      { label: 'secure', tool: 'rh_status', clientTotalMs: 300, serverDurationMs: 100 },
      { label: 'https', tool: 'rh_status', clientTotalMs: 120, serverDurationMs: 75 },
    ]);
    expect(report.sampleCount).toBe(3);
    expect(report.groups).toHaveLength(2);
    const secure = report.groups.find((group) => group.label === 'secure')!;
    expect(secure.clientTotalMs.p50).toBe(200);
    expect(secure.clientTotalMs.p95).toBe(300);
    expect(secure.externalResidualMs.p50).toBe(120);
    expect(secure.externalResidualMs.p95).toBe(200);
    expect(secure.serverExceedsClientCount).toBe(0);
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
  });
});
