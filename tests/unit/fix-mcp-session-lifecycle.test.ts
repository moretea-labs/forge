import { describe, expect, test } from 'bun:test';
import {
  McpSessionRegistry,
  type ClosableMcpTransport,
  type McpSessionRoute,
} from '../../src/cli/mcp/transports/session-registry';
import { mcpSessionToolSurfaceFingerprintIsCurrent } from '../../src/cli/mcp/transports/http';

class FakeTransport implements ClosableMcpTransport {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function addSession(
  registry: McpSessionRegistry, sessionId: string,
  options: {
    route?: McpSessionRoute; principalId?: string; clientIdentity?: string;
    toolSurfaceFingerprint?: string; notifyToolListChanged?: () => Promise<void> | void;
    refreshToolSurface?: () => Promise<{ toolSurfaceFingerprint: string; toolNames?: string[] } | undefined>;
  } = {},
): FakeTransport {
  const transport = new FakeTransport();
  registry.register({
    sessionId,
    transport,
    toolContext: {},
    route: options.route ?? '/mcp',
    principalId: options.principalId ?? 'principal-a',
    clientIdentity: options.clientIdentity ?? `client-${sessionId}`,
    toolSurfaceFingerprint: options.toolSurfaceFingerprint, notifyToolListChanged: options.notifyToolListChanged,
    refreshToolSurface: options.refreshToolSurface,
  });
  return transport;
}

describe('MCP session lifecycle registry', () => {
  test('notifies only stale tool-surface sessions once per new fingerprint without marking them refreshed', async () => { const registry = new McpSessionRegistry(); let oldNotifications = 0; let currentNotifications = 0; addSession(registry, 'old-schema', { toolSurfaceFingerprint: 'schema-v1', notifyToolListChanged: () => { oldNotifications += 1; } }); addSession(registry, 'current-schema', { toolSurfaceFingerprint: 'schema-v2', notifyToolListChanged: () => { currentNotifications += 1; } }); expect(await registry.notifyToolListChanged('schema-v2')).toBe(1); expect(await registry.notifyToolListChanged('schema-v2')).toBe(0); expect(oldNotifications).toBe(1); expect(currentNotifications).toBe(0); expect(registry.get('old-schema')?.toolSurfaceFingerprint).toBe('schema-v1'); expect(mcpSessionToolSurfaceFingerprintIsCurrent(registry.get('old-schema')?.toolSurfaceFingerprint, 'schema-v2')).toBe(false); });

  test('refreshes a stale session fingerprint and tool names in place after tools/list', async () => {
    const registry = new McpSessionRegistry();
    addSession(registry, 'refreshable', {
      toolSurfaceFingerprint: 'schema-v1',
      refreshToolSurface: async () => ({
        toolSurfaceFingerprint: 'schema-v2',
        toolNames: ['rh_status', 'rh_work'],
      }),
    });

    const refreshed = await registry.refreshToolSurface('refreshable');
    expect(refreshed).toEqual({
      toolSurfaceFingerprint: 'schema-v2',
      toolNames: ['rh_status', 'rh_work'],
    });
    expect(registry.get('refreshable')).toMatchObject({
      toolSurfaceFingerprint: 'schema-v2',
      toolNames: ['rh_status', 'rh_work'],
      lastNotifiedToolSurfaceFingerprint: 'schema-v2',
    });
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(
      registry.get('refreshable')?.toolSurfaceFingerprint,
      'schema-v2',
    )).toBe(true);
  });

  test('reports the exact managed session and close reason once for explicit close and transport detach', async () => {
    const observed: Array<{ sessionId: string; reason: string; marker?: string }> = [];
    const registry = new McpSessionRegistry<FakeTransport, { marker?: string }>({
      onSessionClosed: (session, reason) => observed.push({
        sessionId: session.sessionId,
        reason,
        marker: session.toolContext.marker,
      }),
    });
    const first = new FakeTransport();
    registry.register({
      sessionId: 'explicit-close', transport: first, toolContext: { marker: 'first' }, route: '/mcp', principalId: 'principal-a', clientIdentity: 'client-a',
    });
    const second = new FakeTransport();
    registry.register({
      sessionId: 'transport-close', transport: second, toolContext: { marker: 'second' }, route: '/mcp', principalId: 'principal-a', clientIdentity: 'client-b',
    });

    expect(await registry.close('explicit-close', 'client_delete')).toBe(true);
    expect(registry.detach('explicit-close')).toBe(false);
    expect(registry.detach('transport-close', 'transport_close')).toBe(true);
    expect(observed).toEqual([
      { sessionId: 'explicit-close', reason: 'client_delete', marker: 'first' },
      { sessionId: 'transport-close', reason: 'transport_close', marker: 'second' },
    ]);
  });

  test('survives 500 initialize and client-close cycles without consuming capacity', async () => {
    const registry = new McpSessionRegistry({ maximumSessions: 4 });

    for (let cycle = 0; cycle < 500; cycle += 1) {
      const sessionId = `session-${cycle}`;
      addSession(registry, sessionId);
      expect(await registry.close(sessionId, 'client_delete')).toBe(true);
    }

    expect(registry.snapshot()).toMatchObject({
      active: 0,
      maximum: 4,
      capacityAvailable: 4,
      acceptingNewSessions: true,
      closed: { clientDelete: 500 },
    });
  });

  test('backpressures instead of evicting active streams, then reclaims an idle session', async () => {
    let now = 1_000;
    const registry = new McpSessionRegistry({ maximumSessions: 2, now: () => now });
    const oldest = addSession(registry, 'oldest', { route: '/mcp' });
    registry.beginStream('oldest');
    now += 100;
    const newer = addSession(registry, 'newer', { route: '/mcp-grok', principalId: 'principal-b' });
    registry.beginStream('newer');

    expect(await registry.reserveForInitialize({
      principalId: 'principal-c',
      route: '/mcp',
    })).toBeUndefined();
    expect(registry.get('oldest')).toBeDefined();
    expect(registry.get('newer')).toBeDefined();
    expect(oldest.closeCalls).toBe(0);
    expect(newer.closeCalls).toBe(0);
    expect(registry.snapshot()).toMatchObject({
      active: 2,
      maximum: 2,
      evictable: 0,
      protected: 2,
      acceptingNewSessions: false,
      closed: { capacityEviction: 0 },
    });

    registry.endStream('oldest');
    const reservation = await registry.reserveForInitialize({
      principalId: 'principal-c',
      route: '/mcp',
    });
    expect(reservation).toBeDefined();
    expect(registry.get('oldest')).toBeUndefined();
    expect(registry.get('newer')).toBeDefined();
    expect(oldest.closeCalls).toBe(1);
    expect(newer.closeCalls).toBe(0);
    expect(registry.snapshot().closed.capacityEviction).toBe(1);
  });

  test('never evicts a session with an active POST', async () => {
    const registry = new McpSessionRegistry({ maximumSessions: 1 });
    const protectedTransport = addSession(registry, 'protected');
    registry.beginPost('protected');

    expect(await registry.reserveForInitialize({
      principalId: 'principal-b',
      route: '/mcp',
    })).toBeUndefined();
    expect(registry.get('protected')).toBeDefined();
    expect(protectedTransport.closeCalls).toBe(0);
    expect(registry.snapshot()).toMatchObject({
      active: 1,
      protected: 1,
      acceptingNewSessions: false,
      capacityAvailable: 0,
    });
  });

  test('serializes global reservations without charging them all to one principal', async () => {
    const registry = new McpSessionRegistry({ maximumSessions: 4, maximumSessionsPerPrincipal: 2 });
    const existing = addSession(registry, 'existing');
    addSession(registry, 'other-principal', { principalId: 'principal-b' });

    const reservations = await Promise.all([
      registry.reserveForInitialize({ principalId: 'principal-a', route: '/mcp' }),
      registry.reserveForInitialize({ principalId: 'principal-b', route: '/mcp-grok' }),
    ]);
    expect(reservations.every(Boolean)).toBe(true);
    expect(registry.get('existing')).toBeDefined();
    expect(existing.closeCalls).toBe(0);
    expect(registry.snapshot().closed.principalCapacity).toBe(0);
  });

  test('supersedes only the explicitly named prior session', async () => {
    const registry = new McpSessionRegistry({ maximumSessions: 8 });
    const previous = addSession(registry, 'previous', {
      principalId: 'oauth-client:chatgpt',
      clientIdentity: 'oauth-client:chatgpt|/mcp|chatgpt/1',
    });
    registry.beginStream('previous');

    expect(await registry.reserveForInitialize({
      principalId: 'oauth-client:chatgpt',
      route: '/mcp',
      supersedeSessionId: 'previous',
    })).toBeDefined();

    expect(registry.get('previous')).toBeUndefined();
    expect(previous.closeCalls).toBe(1);
    expect(registry.snapshot().closed.superseded).toBe(1);
  });

  test('does not treat shared client metadata as a unique agent instance', async () => {
    const registry = new McpSessionRegistry({ maximumSessions: 8 });
    const existing = addSession(registry, 'parallel-agent', {
      principalId: 'oauth-client:chatgpt',
      clientIdentity: 'oauth-client:chatgpt|/mcp|chatgpt/1',
    });

    expect(await registry.reserveForInitialize({
      principalId: 'oauth-client:chatgpt',
      route: '/mcp',
    })).toBeDefined();
    expect(registry.get('parallel-agent')).toBeDefined();
    expect(existing.closeCalls).toBe(0);
  });

  test('atomically enforces principal reservations and protects the initialize POST', async () => {
    const registry = new McpSessionRegistry({ maximumSessions: 4, maximumSessionsPerPrincipal: 2 });
    addSession(registry, 'existing');
    registry.beginPost('existing');

    const [first, second] = await Promise.all([
      registry.reserveForInitialize({ principalId: 'principal-a', route: '/mcp' }),
      registry.reserveForInitialize({ principalId: 'principal-a', route: '/mcp' }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const reservation = first ?? second!;
    const transport = new FakeTransport();
    registry.commitInitialize(reservation, {
      sessionId: 'initializing',
      transport,
      toolContext: {},
      route: '/mcp',
      principalId: 'principal-a',
      clientIdentity: 'client-initializing',
    });
    expect(registry.snapshot()).toMatchObject({ active: 2, protected: 2, activePosts: 2 });
    registry.endPost('initializing');
    registry.endPost('existing');
    expect(registry.snapshot()).toMatchObject({ activePosts: 0 });
  });

  test('expires an over-lease SSE stream but preserves active work until the POST completes', async () => {
    let now = 10_000;
    const registry = new McpSessionRegistry({
      maximumSessions: 4,
      streamLeaseMs: 1_000,
      absoluteLifetimeMs: 2_000,
      now: () => now,
    });
    const leased = addSession(registry, 'leased');
    registry.beginStream('leased');
    const working = addSession(registry, 'working');
    registry.beginStream('working');
    registry.beginPost('working');
    now += 2_500;

    await registry.prune();
    expect(registry.get('leased')).toBeUndefined();
    expect(leased.closeCalls).toBe(1);
    expect(registry.get('working')).toBeDefined();
    expect(working.closeCalls).toBe(0);

    registry.endPost('working');
    await registry.prune();
    expect(registry.get('working')).toBeUndefined();
    expect(working.closeCalls).toBe(1);
  });

  test('detects stale tool-surface fingerprints while tolerating missing compatibility metadata', () => {
    expect([mcpSessionToolSurfaceFingerprintIsCurrent('schema-a', 'schema-a'), mcpSessionToolSurfaceFingerprintIsCurrent('schema-a', 'schema-b'), mcpSessionToolSurfaceFingerprintIsCurrent(undefined, 'schema-b'), mcpSessionToolSurfaceFingerprintIsCurrent('schema-a', undefined)]).toEqual([true, false, true, true]);
  });

  test('preserves a stale tool-surface session until replacement initialize supersedes it', async () => {
    const registry = new McpSessionRegistry({ maximumSessions: 3 });
    const transport = addSession(registry, 'stale-surface', { principalId: 'oauth-client:chatgpt', route: '/mcp', toolSurfaceFingerprint: 'schema-old' });
    expect(mcpSessionToolSurfaceFingerprintIsCurrent('schema-old', 'schema-new')).toBe(false); expect(registry.get('stale-surface')).toBeDefined(); expect(transport.closeCalls).toBe(0);
    expect(await registry.reserveForInitialize({ principalId: 'oauth-client:chatgpt', route: '/mcp', supersedeSessionId: 'stale-surface' })).toBeDefined();
    expect(registry.get('stale-surface')).toBeUndefined(); expect(transport.closeCalls).toBe(1); expect(registry.snapshot().closed.superseded).toBe(1); expect(registry.snapshot().closed.toolSurfaceChanged).toBe(0);
  });

  test('enforces one global capacity pool across all MCP routes', () => {
    const registry = new McpSessionRegistry({ maximumSessions: 3 });
    addSession(registry, 'chatgpt', { route: '/mcp' });
    addSession(registry, 'grok', { route: '/mcp-grok', principalId: 'principal-b' });
    addSession(registry, 'bearer', { route: '/mcp-bearer', principalId: 'principal-c' });

    const snapshot = registry.snapshot();
    expect(snapshot.active).toBe(3);
    expect(snapshot.maximum).toBe(3);
    expect(snapshot.capacityAvailable).toBe(0);
    expect(snapshot.utilization).toBe(1);
  });
});
