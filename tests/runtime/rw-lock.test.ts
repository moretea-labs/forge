import { describe, test, expect, beforeEach } from 'bun:test';
import {
  withRWLock,
  getLockStats,
  resetLockStats,
  getActiveLocks,
  clearAllLocks,
  type LockOptions,
} from '../../src/runtime/control-plane/execution/rw-lock';

describe('RWLock', () => {
  beforeEach(() => {
    clearAllLocks();
  });

  describe('read locks', () => {
    test('multiple readers can acquire simultaneously', async () => {
      const results: number[] = [];

      // Start 5 concurrent read operations
      await Promise.all([
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push(1);
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push(2);
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push(3);
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push(4);
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push(5);
        }),
      ]);

      expect(results.length).toBe(5);
      const stats = getLockStats();
      expect(stats.concurrentReads).toBeGreaterThanOrEqual(2);
    });

    test('different resources do not block each other', async () => {
      const results: string[] = [];

      await Promise.all([
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push('repo1');
        }),
        withRWLock({ scope: 'repo', resource: 'repo2', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push('repo2');
        }),
      ]);

      expect(results).toEqual(['repo1', 'repo2']);
    });
  });

  describe('write locks', () => {
    test('writer gets exclusive access', async () => {
      const results: string[] = [];

      await Promise.all([
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'write' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          results.push('write1');
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'write' }, async () => {
          results.push('write2');
        }),
      ]);

      // Writers execute serially
      expect(results).toEqual(['write1', 'write2']);
    });

    test('writer blocks readers', async () => {
      const results: string[] = [];

      await Promise.all([
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'write' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          results.push('write');
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          results.push('read');
        }),
      ]);

      // Read waits for write to complete
      expect(results).toEqual(['write', 'read']);
    });
  });

  describe('lock statistics', () => {
    test('tracks acquired and released locks', async () => {
      resetLockStats();

      await withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
        // no-op
      });

      await withRWLock({ scope: 'repo', resource: 'repo1', mode: 'write' }, async () => {
        // no-op
      });

      const stats = getLockStats();
      expect(stats.totalAcquired).toBe(2);
      expect(stats.totalReleased).toBe(2);
    });

    test('tracks concurrent reads', async () => {
      resetLockStats();

      await Promise.all([
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }),
        withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }),
      ]);

      const stats = getLockStats();
      expect(stats.concurrentReads).toBeGreaterThanOrEqual(2);
    });
  });

  describe('active locks', () => {
    test('reports active locks', async () => {
      const lockPromise = withRWLock(
        { scope: 'repo', resource: 'repo1', mode: 'read' },
        async () => {
          const active = getActiveLocks();
          expect(active.length).toBe(1);
          expect(active[0].key).toBe('repo:repo1');
          expect(active[0].mode).toBe('read');
        },
      );

      await lockPromise;
    });

    test('clears locks after release', async () => {
      await withRWLock({ scope: 'repo', resource: 'repo1', mode: 'read' }, async () => {
        // no-op
      });

      const active = getActiveLocks();
      expect(active.length).toBe(0);
    });
  });

  describe('error handling', () => {
    test('releases lock on error', async () => {
      try {
        await withRWLock({ scope: 'repo', resource: 'repo1', mode: 'write' }, async () => {
          throw new Error('test error');
        });
      } catch (error) {
        // Expected
      }

      // Lock should be released
      const active = getActiveLocks();
      expect(active.length).toBe(0);

      // Next operation should succeed
      await withRWLock({ scope: 'repo', resource: 'repo1', mode: 'write' }, async () => {
        // Should not block
      });
    });
  });

  describe('timeout', () => {
    test('times out if lock cannot be acquired', async () => {
      // Hold write lock
      const longLock = withRWLock(
        { scope: 'repo', resource: 'repo1', mode: 'write' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
      );

      // Try to acquire with short timeout
      await expect(
        withRWLock(
          { scope: 'repo', resource: 'repo1', mode: 'write', timeout: 10 },
          async () => {
            // Should not execute
          },
        ),
      ).rejects.toThrow('LOCK_TIMEOUT');

      await longLock;
    });
  });
});
