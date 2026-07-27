import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStableIngressRouter, type StableIngressUpstream } from '../../src/runtime/supervisor/ingress-router';
import { stableIngressSessionStorePath } from '../../src/runtime/supervisor/ingress-session-store';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

interface GatewayFixture {
  port: number;
  events: string[];
  expireSessions(): void;
  close(): Promise<void>;
}

async function gateway(name: string): Promise<GatewayFixture> {
  let sequence = 0;
  const sessions = new Set<string>();
  const events: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const payload = request.method === 'POST' ? await body(request) : {};
    const method = typeof payload.method === 'string' ? payload.method : request.method ?? 'unknown';
    const sessionId = String(request.headers['mcp-session-id'] ?? '');
    if (request.method === 'POST' && method === 'initialize') {
      const created = `${name}-session-${++sequence}`;
      sessions.add(created);
      events.push(`initialize:${created}`);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.setHeader('mcp-session-id', created);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } }));
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) {
      events.push(`expired:${method}:${sessionId || 'missing'}`);
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'MCP_SESSION_EXPIRED' } }));
      return;
    }
    if (request.method === 'DELETE') {
      sessions.delete(sessionId);
      events.push(`delete:${sessionId}`);
      response.statusCode = 204;
      response.end();
      return;
    }
    events.push(`${method}:${sessionId}`);
    response.statusCode = method === 'notifications/initialized' ? 202 : 200;
    response.setHeader('content-type', 'application/json');
    response.end(method === 'notifications/initialized'
      ? ''
      : JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { source: name, sessionId } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('gateway fixture failed');
  return {
    port: address.port,
    events,
    expireSessions: () => sessions.clear(),
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function headers(sessionId?: string): Record<string, string> {
  return {
    authorization: 'Bearer secret-do-not-persist',
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

describe('stable ingress MCP session migration', () => {
  test('keeps the external session id while migrating blue to green and reloads durable affinity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-ingress-session-'));
    roots.push(home);
    const blue = await gateway('blue');
    const green = await gateway('green');
    let active: StableIngressUpstream = { host: '127.0.0.1', port: blue.port, key: 'blue' };
    const storePath = stableIngressSessionStorePath(home);
    let router = await createStableIngressRouter({
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: blue.port,
      sessionStorePath: storePath,
      upstream: () => active,
    });
    try {
      const initialize = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      });
      expect(initialize.status).toBe(200);
      const externalSessionId = initialize.headers.get('mcp-session-id');
      expect(externalSessionId).toBe('blue-session-1');

      active = { host: '127.0.0.1', port: green.port, key: 'green' };
      const migrated = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'POST',
        headers: headers(externalSessionId!),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(migrated.status).toBe(200);
      expect(migrated.headers.get('mcp-session-id')).toBe(externalSessionId);
      expect((await migrated.json() as { result?: { source?: string; sessionId?: string } }).result).toEqual({
        source: 'green',
        sessionId: 'green-session-1',
      });
      expect(green.events).toEqual([
        'initialize:green-session-1',
        'notifications/initialized:green-session-1',
        'tools/list:green-session-1',
      ]);

      const persisted = readFileSync(storePath, 'utf8');
      expect(persisted).not.toContain('secret-do-not-persist');
      expect(persisted).toContain('blue-session-1');
      expect(persisted).toContain('green-session-1');

      await router.close();
      router = await createStableIngressRouter({
        host: '127.0.0.1',
        port: 0,
        rescueHost: '127.0.0.1',
        rescuePort: blue.port,
        sessionStorePath: storePath,
        upstream: () => active,
      });
      const afterRestart = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'POST',
        headers: headers(externalSessionId!),
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      expect(afterRestart.status).toBe(200);
      expect((await afterRestart.json() as { result?: { source?: string } }).result?.source).toBe('green');
      expect(green.events.filter((event) => event.startsWith('initialize:'))).toHaveLength(1);

      const deleted = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'DELETE',
        headers: headers(externalSessionId!),
      });
      expect(deleted.status).toBe(204);
      expect(readFileSync(storePath, 'utf8')).not.toContain(externalSessionId!);
    } finally {
      await router.close();
      await blue.close();
      await green.close();
    }
  });

  test('reinitializes the backend session after a same-slot Gateway restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-ingress-session-same-slot-'));
    roots.push(home);
    const green = await gateway('green');
    const active: StableIngressUpstream = { host: '127.0.0.1', port: green.port, key: 'green' };
    const router = await createStableIngressRouter({
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: green.port,
      sessionStorePath: stableIngressSessionStorePath(home),
      upstream: () => active,
    });
    try {
      const initialize = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      const externalSessionId = initialize.headers.get('mcp-session-id')!;
      expect(externalSessionId).toBe('green-session-1');
      green.expireSessions();

      const recovered = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'POST',
        headers: headers(externalSessionId),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(recovered.status).toBe(200);
      expect(recovered.headers.get('mcp-session-id')).toBe(externalSessionId);
      expect((await recovered.json() as { result?: { sessionId?: string } }).result?.sessionId).toBe('green-session-2');
      expect(green.events).toEqual([
        'initialize:green-session-1',
        'expired:tools/list:green-session-1',
        'initialize:green-session-2',
        'notifications/initialized:green-session-2',
        'tools/list:green-session-2',
      ]);
    } finally {
      await router.close();
      await green.close();
    }
  });

  test('returns a retryable migration response without discarding the external session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-ingress-session-failure-'));
    roots.push(home);
    const blue = await gateway('blue');
    let active: StableIngressUpstream = { host: '127.0.0.1', port: blue.port, key: 'blue' };
    const storePath = stableIngressSessionStorePath(home);
    const router = await createStableIngressRouter({
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: blue.port,
      sessionStorePath: storePath,
      upstream: () => active,
    });
    try {
      const initialize = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      const sessionId = initialize.headers.get('mcp-session-id')!;
      active = { host: '127.0.0.1', port: 1, key: 'green' };
      const failed = await fetch(`http://127.0.0.1:${router.port}/mcp`, {
        method: 'POST',
        headers: headers(sessionId),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(failed.status).toBe(503);
      expect(failed.headers.get('retry-after')).toBe('1');
      expect((await failed.json() as { error?: { code?: string } }).error?.code).toBe('MCP_SESSION_MIGRATION_PENDING');
      expect(readFileSync(storePath, 'utf8')).toContain(sessionId);
    } finally {
      await router.close();
      await blue.close();
    }
  });
});
