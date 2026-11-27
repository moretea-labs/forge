import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import {
  flushMcpDiagnostics,
  readRecentMcpTimingSummary,
  recordMcpTiming,
} from '../../src/runtime/diagnostics/mcp-timing';
import { startRuntimeMcpTransport } from '../../src/runtime/root/mcp-transport';
import type { RuntimeReadiness } from '../../src/runtime/root/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await flushMcpDiagnostics(root);
      rmSync(root, { recursive: true, force: true });
    }),
  );
});

describe('Canonical Runtime HTTP timing', () => {
  test('correlates HTTP ingress and response completion with the tool handler span', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-http-timing-'));
    roots.push(controllerHome);
    const sessionId = 'runtime-http-timing-session';
    const authToken = 'runtime-http-timing-token';
    let activeToolCalls = 0;
    let maxActiveToolCalls = 0;
    let enteredToolCalls = 0;
    let releasePeerBarrier: (() => void) | undefined;
    const peerBarrier = new Promise<void>((resolve) => {
      releasePeerBarrier = resolve;
    });
    const readiness = {
      ready: true,
      reasonCodes: [],
      observedAt: new Date().toISOString(),
      diagnostics: {
        database: { outcome: 'pass' },
        scheduler: { outcome: 'pass' },
        releaseCoherence: { outcome: 'pass' },
        mcpEndToEnd: { outcome: 'pass' },
      },
    } as RuntimeReadiness;
    const runtime = await startRuntimeMcpTransport({
      host: '127.0.0.1',
      port: 0,
      controllerHome,
      authToken,
      readiness: () => readiness,
      createServer: () => {
        const server = new Server(
          { name: 'runtime-http-timing-test', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler('tools/list', async () => ({
          tools: [{ name: 'timing_probe', inputSchema: { type: 'object' as const } }],
        }));
        server.setRequestHandler('tools/call', async (request, extra) => {
          activeToolCalls += 1;
          maxActiveToolCalls = Math.max(maxActiveToolCalls, activeToolCalls);
          enteredToolCalls += 1;
          if (enteredToolCalls >= 2) releasePeerBarrier?.();
          // If the transport serializes same-session calls, the first request
          // times out this bounded peer wait and the assertion below exposes it.
          await Promise.race([peerBarrier, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
          const params = request.params as Record<string, unknown>;
          const rpcId = extra.mcpReq.id as string | number;
          recordMcpTiming(controllerHome, {
            tool: String(params.name),
            traceId: `runtime-http-timing-${String(rpcId)}`,
            rpcId,
            sessionId,
            layer: 'canonical_runtime',
            startedAt: new Date().toISOString(),
            outcome: 'ok',
            totalToolDurationMs: 0,
          });
          activeToolCalls -= 1;
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        });
        return server;
      },
    });
    const client = new Client({ name: 'runtime-http-timing-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(runtime.endpoint), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-Forge-Forwarded-Session-Id': sessionId,
        },
      },
    });

    try {
      await client.connect(transport);
      const results = await Promise.all([
        client.callTool({
          name: 'timing_probe',
          arguments: {},
          _meta: { forgeRuntimeForwarding: { sessionId } },
        }),
        client.callTool({
          name: 'timing_probe',
          arguments: {},
          _meta: { forgeRuntimeForwarding: { sessionId } },
        }),
      ]);
      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(maxActiveToolCalls).toBe(2);
      await flushMcpDiagnostics(controllerHome);

      const records = readFileSync(join(controllerHome, 'audit', 'mcp-timings.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.find((record) => record.spanKind === 'http_transport')).toMatchObject({
        spanKind: 'http_transport',
        mcpTool: 'timing_probe',
        layer: 'canonical_runtime',
        sessionId,
      });
      const summary = readRecentMcpTimingSummary(controllerHome);
      const tool = summary.tools.find((entry) => entry.tool === 'timing_probe' && entry.layer === 'canonical_runtime');
      expect(tool?.preHandlerDispatchMs).toBeDefined();
      expect(tool?.responseTailMs).toBeDefined();
      expect(tool?.sampleCount).toBe(2);
      expect(tool?.maxConcurrentHttpPosts).toBe(2);
    } finally {
      await client.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      await flushMcpDiagnostics(controllerHome);
    }
  });
});
