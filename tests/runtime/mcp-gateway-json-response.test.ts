import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'bun:test';
import { isLocalGatewayJsonResponseSession, startRuntimeMcpTransport } from '../../src/runtime/root/mcp-transport';

const bearer = 'runtime-json-test-bearer';
const readiness = {
  ready: true,
  reasonCodes: [],
  observedAt: new Date().toISOString(),
  diagnostics: {
    database: { outcome: 'pass' as const },
    scheduler: { outcome: 'pass' as const },
    releaseCoherence: { outcome: 'pass' as const },
    mcpEndToEnd: { outcome: 'pass' as const },
  },
};

async function observeClientContentTypes(endpoint: string, name: string): Promise<string[]> {
  const types: string[] = [];
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? '').toUpperCase() === 'POST' && response.status === 200) {
        types.push(response.headers.get('content-type') ?? '');
      }
      return response;
    },
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('rh_status');
    const result = await client.callTool({ name: 'rh_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ status: 'ok' });
    return types;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function createFixture(jsonOptIn: boolean) {
  return await startRuntimeMcpTransport({
    host: '127.0.0.1',
    port: 0,
    authToken: bearer,
    enableGatewayJsonResponses: jsonOptIn,
    readiness: () => readiness,
    createServer: () => {
      const server = new Server({ name: 'canonical-json-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', async () => ({
        tools: [{ name: 'rh_status', inputSchema: { type: 'object' as const } }],
      }));
      server.setRequestHandler('tools/call', async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { status: 'ok' },
      }));
      return server;
    },
  });
}

async function isolatedResponseBurst(
  jsonOptIn: boolean,
  sizes: readonly number[],
): Promise<
  Array<{
    mode: 'json' | 'sse';
    concurrency: number;
    batchMs: number;
    p50Ms: number;
    p95Ms: number;
  }>
> {
  const runtime = await createFixture(jsonOptIn);
  const client = new Client({ name: 'forge-public-gateway-proxy', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  try {
    await client.connect(transport);
    await client.callTool({ name: 'rh_status', arguments: {} });
    const batches = [];
    for (const concurrency of sizes) {
      const started = performance.now();
      const latencies = await Promise.all(
        Array.from({ length: concurrency }, async () => {
          const began = performance.now();
          const result = await client.callTool({ name: 'rh_status', arguments: {} });
          expect(result.structuredContent).toMatchObject({ status: 'ok' });
          return performance.now() - began;
        }),
      );
      const batchMs = performance.now() - started;
      latencies.sort((a, b) => a - b);
      batches.push({
        mode: jsonOptIn ? ('json' as const) : ('sse' as const),
        concurrency,
        batchMs: Math.round(batchMs * 100) / 100,
        p50Ms: Math.round(latencies[Math.floor((latencies.length - 1) * 0.5)]! * 100) / 100,
        p95Ms: Math.round(latencies[Math.floor((latencies.length - 1) * 0.95)]! * 100) / 100,
      });
    }
    return batches;
  } finally {
    await client.close().catch(() => undefined);
    await runtime.close();
  }
}

describe('Canonical Runtime opt-in Gateway JSON response', () => {
  test('requires a loopback single initialize from the Gateway client name', () => {
    const initialize = { method: 'initialize', params: { clientInfo: { name: 'forge-public-gateway-proxy' } } };
    expect(isLocalGatewayJsonResponseSession(initialize, '127.0.0.1')).toBe(true);
    expect(isLocalGatewayJsonResponseSession(initialize, '::ffff:127.0.0.1')).toBe(true);
    expect(isLocalGatewayJsonResponseSession(initialize, '::1')).toBe(true);
    expect(isLocalGatewayJsonResponseSession(initialize, '192.0.2.10')).toBe(false);
    expect(isLocalGatewayJsonResponseSession([{ ...initialize }], '127.0.0.1')).toBe(false);
    expect(isLocalGatewayJsonResponseSession({ ...initialize, method: 'tools/call' }, '127.0.0.1')).toBe(false);
    expect(
      isLocalGatewayJsonResponseSession(
        {
          ...initialize,
          params: { clientInfo: { name: 'ordinary-client' } },
        },
        '127.0.0.1',
      ),
    ).toBe(false);
  });

  test('Gateway JSON mode preserves regular SSE clients on the same Runtime', async () => {
    const runtime = await createFixture(true);
    try {
      const inner = await observeClientContentTypes(runtime.endpoint, 'forge-public-gateway-proxy');
      expect(inner.length).toBeGreaterThanOrEqual(2);
      expect(inner.every((value) => value.startsWith('application/json'))).toBe(true);

      const external = await observeClientContentTypes(runtime.endpoint, 'ordinary-client');
      expect(external.length).toBeGreaterThanOrEqual(2);
      expect(external.every((value) => value.startsWith('text/event-stream'))).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 20_000);

  test('keeps every request valid at 8 and 16 concurrency in isolated JSON/SSE A/B', async () => {
    // ABBA balances host warmup, connection churn, and test-order effects.
    // Neither mode shares a live Runtime session with the other.
    const rounds = [false, true, true, false] as const;
    const observations = [];
    for (const [index, jsonOptIn] of rounds.entries()) {
      const batches = await isolatedResponseBurst(jsonOptIn, [8, 16]);
      expect(batches).toHaveLength(2);
      for (const batch of batches) {
        expect(batch.batchMs).toBeGreaterThan(0);
        expect(batch.p95Ms).toBeGreaterThan(0);
        observations.push({ round: index + 1, ...batch });
      }
    }
    expect(observations).toHaveLength(8);
    expect(observations.filter((batch) => batch.mode === 'sse')).toHaveLength(4);
    expect(observations.filter((batch) => batch.mode === 'json')).toHaveLength(4);
    // These are measurements, not fixed latency assertions: load can vary.
    console.log('MCP_JSON_SSE_ISOLATED_ABBA', JSON.stringify(observations));
  }, 45_000);

  test('disabled opt-in preserves SSE even for a Gateway client', async () => {
    const runtime = await createFixture(false);
    try {
      const types = await observeClientContentTypes(runtime.endpoint, 'forge-public-gateway-proxy');
      expect(types.length).toBeGreaterThanOrEqual(2);
      expect(types.every((value) => value.startsWith('text/event-stream'))).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 20_000);
});
