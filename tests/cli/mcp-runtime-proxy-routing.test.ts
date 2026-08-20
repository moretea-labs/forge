import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { forgeToolSurfaceFingerprint } from '../../src/cli/controller/runtime-config';
import {
  CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS,
  CANONICAL_RUNTIME_HANDOFF_WAIT_MS,
  CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_CANONICAL_RUNTIME_PROXY_LANES,
  MAX_CANONICAL_RUNTIME_PROXY_LANES,
  canonicalRuntimeForwardingIdentity,
  canonicalRuntimeProxyLaneLimit,
  canonicalRuntimeReleaseHandoffInProgress,
  createCanonicalRuntimeLaneScheduler,
  createForgeMcpServerFromContext,
  createMcpToolContext,
  deriveCanonicalForwardingTiming,
  retryCanonicalRuntimeConnectDuringHandoff,
  sameCanonicalRuntimeProxyIdentity,
  waitForCanonicalRuntimeReleaseHandoff,
  type CanonicalRuntimeProxy,
  type CanonicalRuntimeToolSchema,
} from '../../src/cli/mcp/server';
import {
  mcpSessionToolSurfaceFingerprintIsCurrent,
  resolveMcpSessionCurrentFingerprint,
} from '../../src/cli/mcp/transports/http';
import { closeRuntimeMcpTransportResources } from '../../src/runtime/root/mcp-transport';

describe('MCP canonical Runtime proxy routing', () => {
  test('bounds inner Runtime proxy lanes and leases them exclusively under concurrency', async () => {
    expect(canonicalRuntimeProxyLaneLimit(undefined)).toBe(DEFAULT_CANONICAL_RUNTIME_PROXY_LANES);
    expect(canonicalRuntimeProxyLaneLimit('0')).toBe(DEFAULT_CANONICAL_RUNTIME_PROXY_LANES);
    expect(canonicalRuntimeProxyLaneLimit('999')).toBe(MAX_CANONICAL_RUNTIME_PROXY_LANES);
    expect(canonicalRuntimeProxyLaneLimit('3')).toBe(3);

    const scheduler = createCanonicalRuntimeLaneScheduler(2);
    const first = await scheduler.acquire();
    const second = await scheduler.acquire();
    expect(first).not.toBe(second);
    expect(scheduler.size()).toBe(2);

    let thirdResolved = false;
    const thirdPromise = scheduler.acquire().then((laneId) => {
      thirdResolved = true;
      return laneId;
    });
    await Bun.sleep(1);
    expect(thirdResolved).toBe(false);

    scheduler.release(first);
    expect(await thirdPromise).toBe(first);
    scheduler.release(second);
    scheduler.release(first);
    scheduler.close();
    await expect(scheduler.acquire()).rejects.toThrow('CANONICAL_RUNTIME_PROXY_CLOSED');
  });

  test('reserves proxy capacity for interactive calls when process_wait saturates its lane budget', async () => {
    const scheduler = createCanonicalRuntimeLaneScheduler(3);
    const waitLane = await scheduler.acquire('wait');
    let secondWaitResolved = false;
    const secondWait = scheduler.acquire('wait').then((laneId) => {
      secondWaitResolved = true;
      return laneId;
    });
    await Bun.sleep(1);
    expect(secondWaitResolved).toBe(false);

    const interactiveLane = await scheduler.acquire('interactive');
    expect(interactiveLane).not.toBe(waitLane);
    scheduler.release(waitLane);
    expect(await secondWait).toBe(waitLane);
    scheduler.release(interactiveLane);
    scheduler.release(waitLane);
    scheduler.close();
  });

  test('invalidates a hot inner lane when the Canonical Runtime instance changes at the same endpoint and token', () => {
    const baseline = {
      endpoint: new URL('http://127.0.0.1:8766/mcp-bearer'),
      token: 'fixture-token',
      runtimeInstanceId: 'runtime-a',
    };
    expect(sameCanonicalRuntimeProxyIdentity(baseline, { ...baseline })).toBe(true);
    expect(sameCanonicalRuntimeProxyIdentity(baseline, { ...baseline, runtimeInstanceId: 'runtime-b' })).toBe(false);
  });

  test('reuses one shared Runtime proxy across outer MCP sessions without collapsing caller session identity', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-proxy-reuse-'));
    const runtimeSchema: CanonicalRuntimeToolSchema = {
      definitions: [{ name: 'rh_status', description: 'fixture', inputSchema: { type: 'object' } }],
      toolNames: ['rh_status'],
      fingerprint: 'fixture-runtime-schema',
    };
    const observedSessions: string[] = [];
    let closeCalls = 0;
    const sharedProxy: CanonicalRuntimeProxy = {
      listTools: async () => ({ tools: runtimeSchema.definitions }),
      callTool: async (ctx) => {
        observedSessions.push(ctx.sessionId ?? 'missing');
        return {
          content: [{ type: 'text', text: '{"ok":true}' }],
          structuredContent: { ok: true },
        };
      },
      close: async () => { closeCalls += 1; },
    };
    const invoke = async (sessionId: string): Promise<void> => {
      const context = {
        ...createMcpToolContext({ controllerHome, profile: 'controller' }),
        principalId: 'oauth-client:fixture',
        sessionId,
        controllerType: 'chatgpt' as const,
      };
      const server = createForgeMcpServerFromContext(context, runtimeSchema, sharedProxy);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: `proxy-client-${sessionId}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        await client.callTool({ name: 'rh_status', arguments: { request_id: `req-${sessionId}` } });
      } finally {
        await client.close();
        await server.close();
      }
    };
    try {
      await invoke('outer-session-a');
      await invoke('outer-session-b');
      expect(observedSessions).toEqual(['outer-session-a', 'outer-session-b']);
      expect(closeCalls).toBe(0);
    } finally {
      await sharedProxy.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
    expect(closeCalls).toBe(1);
  });

  test('accepts only bounded internal Runtime forwarding identity metadata', () => {
    expect(canonicalRuntimeForwardingIdentity({
      forgeRuntimeForwarding: {
        principalId: ' oauth-client:fixture ',
        sessionId: ' session-a ',
        controllerType: 'chatgpt',
      },
    })).toEqual({
      principalId: 'oauth-client:fixture',
      sessionId: 'session-a',
      controllerType: 'chatgpt',
    });
    expect(canonicalRuntimeForwardingIdentity({
      forgeRuntimeForwarding: { principalId: 'fixture', sessionId: 'session-b', controllerType: 'root' },
    })).toEqual({ principalId: 'fixture', sessionId: 'session-b' });
    expect(canonicalRuntimeForwardingIdentity({ forgeRuntimeForwarding: 'invalid' })).toEqual({});
  });

  test('gracefully drains an in-flight Runtime request before closing sessions and forcing residual connections', async () => {
    const events: string[] = [];
    let releaseRequest!: () => void;
    let releaseListener!: () => void;
    const requestDrain = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const listenerClosed = new Promise<void>((resolve) => { releaseListener = resolve; });
    const closing = closeRuntimeMcpTransportResources({
      closeListener: async () => {
        events.push('listener');
        await listenerClosed;
      },
      waitForRequestDrain: async () => {
        events.push('request-drain');
        await requestDrain;
      },
      closeSessions: [async () => { events.push('session'); }],
      forceCloseConnections: () => {
        events.push('force');
        releaseListener();
      },
      requestDrainTimeoutMs: 1_000,
      sessionCloseTimeoutMs: 1_000,
    });
    await Bun.sleep(10);
    expect(events).toEqual(['listener', 'request-drain']);
    releaseRequest();
    await closing;
    expect(events).toEqual(['listener', 'request-drain', 'session', 'force']);
  });

  test('keeps loopback connect fail-fast without capping valid tool work at five seconds', () => {
    expect(CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS);
    expect(CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS).toBe(120_000);
  });

  test('recognizes only recent Canonical Runtime release handoff states', () => {
    const nowMs = Date.parse('2026-08-18T04:00:30.000Z');
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-new', authorityCommittedAt: '2026-08-18T04:00:25.000Z',
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:24.000Z', nowMs,
    })).toBe(true);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-new', authorityCommittedAt: '2026-08-18T04:00:25.000Z',
      runtimeReleaseId: 'release-new', runtimeRunning: true, runtimeReady: false,
      runtimeStartedAt: '2026-08-18T04:00:26.000Z', nowMs,
    })).toBe(true);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-old', authorityCommittedAt: '2026-08-17T04:00:00.000Z',
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:24.000Z', recoveryActivationInProgress: true, nowMs,
    })).toBe(true);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      authorityReleaseId: 'release-old', authorityCommittedAt: '2026-08-17T04:00:00.000Z',
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:29.000Z', recoveryActivationInProgress: false, nowMs,
    })).toBe(false);
    expect(canonicalRuntimeReleaseHandoffInProgress({
      runtimeReleaseId: 'release-old', runtimeRunning: false, runtimeReady: false,
      runtimeUpdatedAt: '2026-08-18T04:00:29.000Z', nowMs,
    })).toBe(false);
  });

  test('waits boundedly for a release handoff to settle', async () => {
    let nowMs = 0;
    let observations = 0;
    const result = await waitForCanonicalRuntimeReleaseHandoff(
      () => ++observations < 4,
      {
        maxWaitMs: 1_000,
        intervalMs: 100,
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms; },
      },
    );
    expect(result.waited).toBe(true);
    expect(result.settled).toBe(true);
    expect(nowMs).toBe(300);
    expect(observations).toBe(4);
    expect(CANONICAL_RUNTIME_HANDOFF_WAIT_MS).toBeGreaterThan(CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS);
  });

  test('retries only connection establishment during a proven release handoff', async () => {
    let attempts = 0;
    let nowMs = 0;
    let handoff = false;
    const value = await retryCanonicalRuntimeConnectDuringHandoff(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          handoff = true;
          throw new Error('ECONNREFUSED');
        }
        return 'connected';
      },
      () => handoff,
      {
        maxWaitMs: 1_000,
        intervalMs: 100,
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms; handoff = false; },
      },
    );
    expect(value).toBe('connected');
    expect(attempts).toBe(2);
  });

  test('keeps ordinary Canonical Runtime outages fail-fast when no handoff is active', async () => {
    let attempts = 0;
    await expect(retryCanonicalRuntimeConnectDuringHandoff(
      async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
      () => false,
      { maxWaitMs: 1_000 },
    )).rejects.toThrow('ECONNREFUSED');
    expect(attempts).toBe(1);
  });

  test('derives pre-canonical dispatch and return transport phases from canonical response timing', () => {
    const response = {
      content: [{ type: 'text' as const, text: '{}' }],
      structuredContent: {
        responseMeta: {
          serverStartedAt: '2026-08-17T03:31:46.332Z',
          serverDurationMs: 66.22,
        },
      },
    };
    expect(deriveCanonicalForwardingTiming({
      gatewayCallStartedAtMs: Date.parse('2026-08-17T03:31:41.699Z'),
      gatewayCallDurationMs: 4701.36,
      response,
    })).toEqual({
      gatewayProxyCanonicalDispatchLagMs: 4633,
      gatewayProxyCanonicalDurationMs: 66.22,
      gatewayProxyReturnMs: 2.14,
    });
  });
});

describe('MCP canonical Runtime schema fencing', () => {
  test('changes only when the exposed schema changes, not when a release identity changes', () => {
    const surface = [{
      name: 'rh_work',
      description: 'Stable facade.',
      inputSchema: { type: 'object', properties: { operation: { type: 'string' } } },
      annotations: { readOnlyHint: false },
    }];
    const baseline = forgeToolSurfaceFingerprint(surface);
    expect(forgeToolSurfaceFingerprint(structuredClone(surface))).toBe(baseline);
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(baseline, baseline)).toBe(true);
  });

  test('invalidates a session when discovery schema changes', () => {
    const before = forgeToolSurfaceFingerprint([{ name: 'rh_status', inputSchema: { type: 'object' } }]);
    const after = forgeToolSurfaceFingerprint([{ name: 'rh_context', inputSchema: { type: 'object' } }]);
    expect(before).not.toBe(after);
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(before, after)).toBe(false);
  });

  test('uses the published Runtime fingerprint without rediscovering tools on the hot path', async () => {
    let discoveryCalls = 0;
    const fingerprint = await resolveMcpSessionCurrentFingerprint('runtime-schema-v1', async () => {
      discoveryCalls += 1;
      return 'runtime-schema-v1';
    });

    expect(fingerprint).toBe('runtime-schema-v1');
    expect(discoveryCalls).toBe(0);
  });

  test('falls back to live Runtime discovery when the published fingerprint is unavailable', async () => {
    let discoveryCalls = 0;
    const fingerprint = await resolveMcpSessionCurrentFingerprint(undefined, async () => {
      discoveryCalls += 1;
      return 'runtime-schema-v1';
    });

    expect(fingerprint).toBe('runtime-schema-v1');
    expect(discoveryCalls).toBe(1);
  });
});
