import { describe, expect, test } from 'bun:test';
import { forgeToolSurfaceFingerprint } from '../../src/cli/controller/runtime-config';
import {
  CANONICAL_RUNTIME_CONNECT_TIMEOUT_MS,
  CANONICAL_RUNTIME_HANDOFF_WAIT_MS,
  CANONICAL_RUNTIME_TOOL_CALL_TIMEOUT_MS,
  canonicalRuntimeReleaseHandoffInProgress,
  deriveCanonicalForwardingTiming,
  retryCanonicalRuntimeConnectDuringHandoff,
  waitForCanonicalRuntimeReleaseHandoff,
} from '../../src/cli/mcp/server';
import {
  mcpSessionToolSurfaceFingerprintIsCurrent,
  resolveMcpSessionCurrentFingerprint,
} from '../../src/cli/mcp/transports/http';
import { closeRuntimeMcpTransportResources } from '../../src/runtime/root/mcp-transport';

describe('MCP canonical Runtime proxy routing', () => {
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
