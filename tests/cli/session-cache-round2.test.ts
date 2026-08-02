import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearAllSessionCachesForTest,
  clearSessionCachesForSession,
  getOrCreateSessionCache,
  pruneSessionCaches,
  sessionCacheGlobalDiagnostics,
} from '../../src/cli/repository/session-cache';
import { McpSessionRegistry } from '../../src/cli/mcp/transports/session-registry';

afterEach(() => clearAllSessionCachesForTest());

const identity = (repoId: string, checkoutId = 'checkout'): {
  repoId: string;
  checkoutId: string;
  branch: string;
  head: string;
  workingTreeFingerprint: string;
} => ({
  repoId,
  checkoutId,
  branch: 'main',
  head: 'head',
  workingTreeFingerprint: 'tree',
});

describe('session cache round two lifecycle', () => {
  test('bounds process-wide entries with LRU diagnostics and TTL pruning', () => {
    const root = '/tmp/repo-harness-session-cache-round2';
    const limit = sessionCacheGlobalDiagnostics().maxEntries;
    for (let index = 0; index < limit + 4; index += 1) {
      getOrCreateSessionCache(`session-${index}`, root, identity(`repo-${index}`));
    }
    const bounded = sessionCacheGlobalDiagnostics();
    expect(bounded.activeEntries).toBeLessThanOrEqual(limit);
    expect(bounded.evictions).toBeGreaterThan(0);
    expect(pruneSessionCaches(Date.now() + bounded.ttlMs + 1)).toBe(bounded.activeEntries);
    expect(sessionCacheGlobalDiagnostics().activeEntries).toBe(0);
  });

  test('session close removes all repository/checkout cache entries', async () => {
    const root = '/tmp/repo-harness-session-cache-round2-close';
    getOrCreateSessionCache('session-close', root, identity('repo-close', 'checkout-a'));
    getOrCreateSessionCache('session-close', root, identity('repo-close', 'checkout-b'));
    expect(sessionCacheGlobalDiagnostics().sessionIds).toContain('session-close');

    const registry = new McpSessionRegistry<{ close(): void }>();
    registry.register({
      sessionId: 'session-close',
      transport: { close: () => undefined },
      toolContext: {},
      route: '/mcp',
      principalId: 'test',
      clientIdentity: 'test',
    });
    await registry.close('session-close', 'client_delete');
    expect(sessionCacheGlobalDiagnostics().sessionIds).not.toContain('session-close');
    expect(clearSessionCachesForSession('session-close')).toBe(0);
  });
});
