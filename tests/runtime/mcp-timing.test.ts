import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  flushMcpDiagnostics,
  readRecentMcpTransportEvents,
  recordMcpHttpTransportSpan,
  recordMcpTiming,
  readRecentMcpTimingSummary,
  recordMcpTransportEvent,
} from '../../src/runtime/diagnostics/mcp-timing';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map(async (home) => {
      await flushMcpDiagnostics(home);
      rmSync(home, { recursive: true, force: true });
    }),
  );
});

describe('MCP timing diagnostics', () => {
  test('queues writes without synchronously touching the diagnostic file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-timing-'));
    homes.push(home);
    recordMcpTiming(home, { tool: 'repository_list', totalToolDurationMs: 1 });
    await flushMcpDiagnostics(home);
    expect(readFileSync(join(home, 'audit', 'mcp-timings.jsonl'), 'utf8')).toContain('repository_list');
  });

  test('correlates HTTP response completion with the originating MCP request trace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-http-timing-'));
    homes.push(home);
    recordMcpTiming(home, {
      tool: 'rh_status',
      traceId: 'trace-http-1',
      requestId: 'mcp-call:request-http-1',
      rpcId: 17,
      sessionId: 'session-http-1',
      layer: 'public_gateway',
      startedAt: '2026-11-24T12:00:00.000Z',
      outcome: 'ok',
      totalToolDurationMs: 9.5,
    });

    const span = {
      sessionId: 'session-http-1',
      layer: 'public_gateway' as const,
      rpcId: 17,
      tool: 'rh_status',
      route: '/mcp',
      startedAt: '2026-11-24T12:00:00.000Z',
      finishedAt: '2026-11-24T12:00:00.030Z',
      durationMs: 30,
      statusCode: 200,
      outcome: 'finished' as const,
    };
    expect(recordMcpHttpTransportSpan(home, { ...span, rpcId: 18 })).toBe(false);
    expect(recordMcpHttpTransportSpan(home, { ...span, layer: 'canonical_runtime' })).toBe(false);
    expect(recordMcpHttpTransportSpan(home, span)).toBe(true);
    expect(recordMcpHttpTransportSpan(home, span)).toBe(false);

    await flushMcpDiagnostics(home);
    const records = readFileSync(join(home, 'audit', 'mcp-timings.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const httpSpan = records.find((record) => record.spanKind === 'http_transport');
    expect(httpSpan).toMatchObject({
      tool: '__http_transport__',
      mcpTool: 'rh_status',
      traceId: 'trace-http-1',
      requestId: 'mcp-call:request-http-1',
      rpcId: 17,
      layer: 'public_gateway',
      sessionId: 'session-http-1',
      route: '/mcp',
      httpStartedAt: span.startedAt,
      httpFinishedAt: span.finishedAt,
      httpDurationMs: 30,
      httpStatusCode: 200,
      httpOutcome: 'finished',
    });
    expect(httpSpan).not.toHaveProperty('totalToolDurationMs');
  });

  test('summarizes tool duration, pre-handler dispatch wait, and response tail by runtime layer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-timing-summary-'));
    homes.push(home);
    recordMcpTiming(home, {
      tool: 'rh_status',
      traceId: 'trace-summary-gateway',
      rpcId: 31,
      sessionId: 'session-summary-gateway',
      layer: 'public_gateway',
      startedAt: '2026-11-24T12:00:00.010Z',
      outcome: 'ok',
      totalToolDurationMs: 9.5,
      gatewayProxyCallMs: 15.5,
      gatewayProxyLaneWaitMs: 0.2,
    });
    recordMcpHttpTransportSpan(home, {
      sessionId: 'session-summary-gateway',
      rpcId: 31,
      tool: 'rh_status',
      route: '/mcp',
      layer: 'public_gateway',
      startedAt: '2026-11-24T12:00:00.000Z',
      finishedAt: '2026-11-24T12:00:00.030Z',
      durationMs: 30,
      statusCode: 200,
      outcome: 'finished',
    });
    recordMcpTiming(home, {
      tool: 'rh_status',
      traceId: 'trace-summary-runtime',
      rpcId: 32,
      sessionId: 'session-summary-runtime',
      layer: 'canonical_runtime',
      startedAt: '2026-11-24T12:00:01.000Z',
      outcome: 'ok',
      totalToolDurationMs: 20,
    });
    await flushMcpDiagnostics(home);

    const summary = readRecentMcpTimingSummary(home);
    expect(summary).toMatchObject({ observation: 'observed', sampleCount: 2, httpSpanCount: 1 });
    expect(summary.tools).toEqual([
      {
        tool: 'rh_status',
        layer: 'canonical_runtime',
        sampleCount: 1,
        outcomes: { ok: 1, error: 0, exception: 0 },
        totalToolDurationMs: { p50Ms: 20, p95Ms: 20, maxMs: 20 },
      },
      {
        tool: 'rh_status',
        layer: 'public_gateway',
        sampleCount: 1,
        outcomes: { ok: 1, error: 0, exception: 0 },
        totalToolDurationMs: { p50Ms: 9.5, p95Ms: 9.5, maxMs: 9.5 },
        preHandlerDispatchMs: { p50Ms: 10, p95Ms: 10, maxMs: 10 },
        responseTailMs: { p50Ms: 10.5, p95Ms: 10.5, maxMs: 10.5 },
        gatewayProxyCallMs: { p50Ms: 15.5, p95Ms: 15.5, maxMs: 15.5 },
        gatewayProxyLaneWaitMs: { p50Ms: 0.2, p95Ms: 0.2, maxMs: 0.2 },
      },
    ]);
  });

  test('preserves the oldest live correlation when the pending bound is full', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-http-capacity-'));
    homes.push(home);
    const startedAt = '2026-11-24T12:00:00.000Z';
    const span = {
      sessionId: 'session-capacity',
      layer: 'public_gateway' as const,
      tool: 'rh_status',
      route: '/mcp',
      startedAt,
      finishedAt: '2026-11-24T12:00:00.030Z',
      durationMs: 30,
      statusCode: 200,
      outcome: 'finished' as const,
    };

    for (let rpcId = 0; rpcId < 4_096; rpcId += 1) {
      recordMcpTiming(home, {
        tool: 'rh_status',
        traceId: `trace-capacity-${rpcId}`,
        rpcId,
        sessionId: 'session-capacity',
        layer: 'public_gateway',
        startedAt,
        outcome: 'ok',
        totalToolDurationMs: 1,
      });
    }
    // Drain the first 4,096 tool-timing records so the independent bounded
    // diagnostic write queue does not mask the correlation-map capacity test.
    await flushMcpDiagnostics(home);

    expect(recordMcpHttpTransportSpan(home, { ...span, rpcId: 0 })).toBe(true);
    for (let rpcId = 1; rpcId < 4_096; rpcId += 1) {
      expect(recordMcpHttpTransportSpan(home, { ...span, rpcId })).toBe(true);
    }

    await flushMcpDiagnostics(home);
    const records = readFileSync(join(home, 'audit', 'mcp-timings.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const spans = records.filter((record) => record.spanKind === 'http_transport');
    expect(spans).toHaveLength(4_096);
    expect(spans[0]).toMatchObject({
      traceId: 'trace-capacity-0',
      rpcId: 0,
      sessionId: 'session-capacity',
    });
  });

  test('keeps bounded transport interruption and reconnect evidence across diagnostic flush', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-transport-evidence-'));
    homes.push(home);
    recordMcpTransportEvent(home, {
      at: '2026-09-22T10:00:00.000Z',
      kind: 'interruption',
      sessionId: 'session-a',
      connectionId: 'connection-a',
      route: '/mcp',
      principalId: 'controller-http-client',
      reason: 'transport_close',
    });
    recordMcpTransportEvent(home, {
      at: '2026-09-22T10:00:05.000Z',
      kind: 'session_initialized',
      sessionId: 'session-b',
      connectionId: 'connection-a',
      route: '/mcp',
      principalId: 'controller-http-client',
    });

    expect(readRecentMcpTransportEvents(home).map((event) => event.kind)).toEqual([
      'session_initialized',
      'interruption',
    ]);
    await flushMcpDiagnostics(home);
    const ledger = readFileSync(join(home, 'audit', 'mcp-transport-events.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"interruption"');
    expect(ledger).toContain('"kind":"session_initialized"');
    expect(readRecentMcpTransportEvents(home, 1)[0]?.sessionId).toBe('session-b');
  });

  test('rotates an oversized timing ledger before appending new diagnostics', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-timing-'));
    homes.push(home);
    const audit = join(home, 'audit');
    const current = join(audit, 'mcp-timings.jsonl');
    mkdirSync(audit, { recursive: true });
    // Use a sparse file: the rotation condition must use filesystem size rather
    // than loading historical diagnostics into the control-plane process.
    writeFileSync(current, 'x');
    const oversized = 32 * 1024 * 1024;
    truncateSync(current, oversized);
    recordMcpTiming(home, { tool: 'repository_list', totalToolDurationMs: 1 });
    await flushMcpDiagnostics(home);
    expect(existsSync(`${current}.previous`)).toBe(true);
    expect(readFileSync(current, 'utf8')).toContain('repository_list');
  });
});
