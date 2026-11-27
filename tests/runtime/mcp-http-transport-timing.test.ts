import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { createStatelessMcpHttpHandler, mcpToolCallTraceRequests } from '../../adapters/mcp/transports/http';
import type { CanonicalRuntimeProxy, CanonicalRuntimeToolSchema } from '../../adapters/mcp/server';
import { flushMcpDiagnostics } from '../../src/runtime/diagnostics/mcp-timing';

describe('MCP HTTP transport trace identity', () => {
  test('records complete HTTP spans for concurrent stateless calls without mixing request identities', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-stateless-timing-'));
    const schema: CanonicalRuntimeToolSchema = {
      definitions: [{ name: 'rh_status', description: 'status fixture', inputSchema: { type: 'object' } }],
      toolNames: ['rh_status'],
      fingerprint: 'fixture',
    };
    const proxy: CanonicalRuntimeProxy = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
    };
    const handler = createStatelessMcpHttpHandler({ controllerHome: home }, async () => schema, proxy);
    const app = express();
    app.use(express.json());
    app.post('/mcp', (req, res) => {
      void handler.nodeHandler(req, res, req.body);
    });
    const listener = app.listen(0, '127.0.0.1');
    try {
      if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve));
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const ingressByRpc = new Map<
        number,
        {
          clientStartedAt?: string;
          upstreamRequestId: string;
          clientTraceId: string;
          cloudflareRay: string;
          ingressRequestId?: string;
        }
      >();
      await Promise.all(
        Array.from({ length: 32 }, (_, index) => index + 11).map(async (id) => {
          const version = id < 13 ? '2026-07-28' : '2025-11-25';
          const clientStartedAt = id === 42 ? undefined : id === 41 ? '2099-01-01T00:00:00.000Z' : new Date().toISOString();
          const upstreamRequestId = 'fixture-request-' + id;
          const clientTraceId = id.toString(16).padStart(32, '0');
          const cloudflareRay = 'fixture-' + id + '-NRT';
          ingressByRpc.set(id, {
            ...(clientStartedAt ? { clientStartedAt } : {}),
            upstreamRequestId,
            clientTraceId,
            cloudflareRay,
          });
          const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': version,
              'mcp-method': 'tools/call',
              'mcp-name': 'rh_status',
              ...(clientStartedAt ? { 'x-forge-client-started-at': clientStartedAt } : {}),
              'x-forge-client-trace-id': clientTraceId,
              'x-request-id': upstreamRequestId,
              'cf-ray': cloudflareRay,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: 'tools/call',
              params: {
                name: 'rh_status',
                arguments: {},
                ...(id < 13
                  ? {
                      _meta: {
                        [PROTOCOL_VERSION_META_KEY]: version,
                        [CLIENT_INFO_META_KEY]: { name: 'http-timing-fixture', version: '1' },
                        [CLIENT_CAPABILITIES_META_KEY]: {},
                      },
                    }
                  : {}),
              },
            }),
          });
          const ingressRequestId = response.headers.get('x-forge-ingress-request-id') ?? undefined;
          expect(ingressRequestId).toMatch(/^[0-9a-f-]{36}$/i);
          const ingress = ingressByRpc.get(id);
          if (ingress) ingress.ingressRequestId = ingressRequestId;
          const text = await response.text();
          if (response.status !== 200) throw new Error(`HTTP ${response.status} (${version}): ${text}`);
          const result = response.headers.get('content-type')?.startsWith('text/event-stream')
            ? JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? 'null')
            : JSON.parse(text);
          expect(result).toMatchObject({ id, result: { content: [{ text: 'ok' }] } });
        }),
      );
      await flushMcpDiagnostics(home);
      const records = readFileSync(join(home, 'audit', 'mcp-timings.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const spans = records.filter((row) => row.spanKind === 'http_transport');
      expect(spans).toHaveLength(32);
      for (const span of spans) {
        const tool = records.find((row) => row.tool === 'rh_status' && row.traceId === span.traceId);
        expect(tool).toBeDefined();
        const ingress = ingressByRpc.get(Number(span.rpcId));
        expect(ingress).toBeDefined();
        expect(span).toMatchObject({
          rpcId: tool?.rpcId,
          sessionId: tool?.sessionId,
          mcpTool: 'rh_status',
          httpStatusCode: 200,
          httpOutcome: 'finished',
          ingressRequestId: ingress?.ingressRequestId,
          upstreamRequestId: ingress?.upstreamRequestId,
          clientTraceId: ingress?.clientTraceId,
          cloudflareRay: ingress?.cloudflareRay,
          clientStartObserved: Boolean(ingress?.clientStartedAt),
        });
        expect(Date.parse(String(span.httpStartedAt))).toBeLessThanOrEqual(Date.parse(String(tool?.startedAt)));
        expect(Date.parse(String(span.httpFinishedAt))).toBeGreaterThanOrEqual(Date.parse(String(tool?.at)));
      }
      expect(new Set(spans.map((span) => span.sessionId)).size).toBe(32);
      expect(new Set(spans.map((span) => span.ingressRequestId)).size).toBe(32);
      for (const span of spans) {
        const ingress = ingressByRpc.get(Number(span.rpcId));
        if (ingress?.clientStartedAt) {
          expect(span).toMatchObject({ clientStartedAt: ingress.clientStartedAt });
          if (Date.parse(ingress.clientStartedAt) <= Date.now()) {
            expect(span).toHaveProperty('clientToGatewayMs');
            expect(Number(span.clientToGatewayMs)).toBeGreaterThanOrEqual(0);
          } else {
            expect(span).not.toHaveProperty('clientToGatewayMs');
          }
        } else {
          expect(span).not.toHaveProperty('clientStartedAt');
          expect(span).not.toHaveProperty('clientToGatewayMs');
        }
      }
    } finally {
      await handler.handler.close();
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
      await flushMcpDiagnostics(home);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('extracts the JSON-RPC id, tool name, and forwarded runtime session', () => {
    expect(
      mcpToolCallTraceRequests({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'rh_status',
          arguments: { detail_level: 'summary' },
          _meta: {
            forgeRuntimeForwarding: {
              sessionId: 'outer-session-21',
            },
          },
        },
      }),
    ).toEqual([
      {
        rpcId: 21,
        tool: 'rh_status',
        forwardedSessionId: 'outer-session-21',
      },
    ]);
  });

  test('supports JSON-RPC batches and ignores non-tool calls and notifications', () => {
    expect(
      mcpToolCallTraceRequests([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rh_status' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', method: 'tools/call', params: { name: 'rh_context' } },
        { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: { name: '  ' } },
      ]),
    ).toEqual([{ rpcId: 1, tool: 'rh_status' }]);
  });
});
