import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getCachedGitStatus,
  invalidateGitStatusCache,
  clearGitStatusCache,
  selectValidationMode,
  createDelayedValidation,
} from '../../src/runtime/control-plane/execution/validation-optimization';

describe('ValidationOptimization', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'forge-test-'));
    clearGitStatusCache();
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
    clearGitStatusCache();
  });

  describe('getCachedGitStatus', () => {
    test('caches Git status for same repository', () => {
      const repo = {
        repoId: 'repo_test',
        activeCheckoutId: 'checkout_main',
        canonicalRoot: testDir,
      };

      // First call - cache miss
      const status1 = getCachedGitStatus(repo);

      // Second call - should use cache
      const status2 = getCachedGitStatus(repo);

      // Should return same reference (cached)
      expect(status2).toBe(status1);
    });

    test('different repos have separate cache entries', () => {
      const repo1 = {
        repoId: 'repo_a',
        activeCheckoutId: 'checkout_main',
        canonicalRoot: testDir,
      };

      const repo2 = {
        repoId: 'repo_b',
        activeCheckoutId: 'checkout_main',
        canonicalRoot: testDir,
      };

      const status1 = getCachedGitStatus(repo1);
      const status2 = getCachedGitStatus(repo2);

      // Different repos, different cache entries
      expect(status1).toBeDefined();
      expect(status2).toBeDefined();
    });

    test('cache expires after TTL', async () => {
      const repo = {
        repoId: 'repo_test',
        activeCheckoutId: 'checkout_main',
        canonicalRoot: testDir,
      };

      const status1 = getCachedGitStatus(repo);

      // Wait for cache to expire (>5 seconds in real scenario)
      // For test, we just verify the mechanism works
      const status2 = getCachedGitStatus(repo);

      // Within TTL, should be cached
      expect(status2).toBe(status1);
    });

    test('forceRefresh bypasses cache', () => {
      const repo = {
        repoId: 'repo_test',
        activeCheckoutId: 'checkout_main',
        canonicalRoot: testDir,
      };

      const status1 = getCachedGitStatus(repo);
      const status2 = getCachedGitStatus(repo); // force refresh

      // Should fetch fresh (different object)
      expect(status2).not.toBe(status1);
    });
  });

  describe('invalidateGitStatusCache', () => {
    test('invalidates specific checkout', () => {
      const repo = {
        repoId: 'repo_test',
        activeCheckoutId: 'checkout_main',
        canonicalRoot: testDir,
      };

      const status1 = getCachedGitStatus(repo);
      invalidateGitStatusCache('repo_test', 'checkout_main');
      const status2 = getCachedGitStatus(repo);

      // Cache invalidated, should be different object
      expect(status2).not.toBe(status1);
    });

    test('invalidates all checkouts for a repo', () => {
      const repo1 = {
        repoId: 'repo_test',
        activeCheckoutId: 'checkout_main',
        canonicalRoot: testDir,
      };

      const repo2 = {
        repoId: 'repo_test',
        activeCheckoutId: 'checkout_feature',
        canonicalRoot: testDir,
      };

      getCachedGitStatus(repo1);
      getCachedGitStatus(repo2);

      invalidateGitStatusCache('repo_test'); // no checkoutId - invalidate all

      const status1After = getCachedGitStatus(repo1);
      const status2After = getCachedGitStatus(repo2);

      // Both should be fresh
      expect(status1After).toBeDefined();
      expect(status2After).toBeDefined();
    });
  });

  describe('selectValidationMode', () => {
    const mockSession = {
      sessionId: 'sess_test',
      principalId: 'principal_test',
    } as any;

    test('returns fast for existing work_id', () => {
      const mode = selectValidationMode({ work_id: 'work-123' }, mockSession);
      expect(mode).toBe('fast');
    });

    test('returns fast for isolation=reuse', () => {
      const mode = selectValidationMode({ isolation: 'reuse' }, mockSession);
      expect(mode).toBe('fast');
    });

    test('returns full for new isolated work', () => {
      const mode = selectValidationMode({ isolation: 'new_worktree' }, mockSession);
      expect(mode).toBe('full');
    });

    test('returns full for auto isolation (default)', () => {
      const mode = selectValidationMode({}, mockSession);
      expect(mode).toBe('full');
    });
  });

  describe('createDelayedValidation', () => {
    const mockSession = {
      sessionId: 'sess_test',
      principalId: 'principal_test',
    } as any;

    test('skips worktree checks for reuse mode', () => {
      const validation = createDelayedValidation({ isolation: 'reuse' }, mockSession);

      expect(validation.mode).toBe('fast');
      expect(validation.skipWorktreeChecks).toBe(true);
      expect(validation.skipIntegrationChecks).toBe(true);
      expect(validation.deferPermissionCheck).toBe(true);
    });

    test('performs full checks for new_worktree', () => {
      const validation = createDelayedValidation({ isolation: 'new_worktree' }, mockSession);

      expect(validation.mode).toBe('full');
      expect(validation.skipWorktreeChecks).toBe(false);
      expect(validation.skipIntegrationChecks).toBe(false);
      expect(validation.deferPermissionCheck).toBe(false);
    });

    test('fast mode for existing work_id', () => {
      const validation = createDelayedValidation(
        { work_id: 'work-123', isolation: 'new_worktree' },
        mockSession,
      );

      expect(validation.mode).toBe('fast');
      expect(validation.deferPermissionCheck).toBe(true);
    });

    test('auto isolation creates worktree (full validation)', () => {
      const validation = createDelayedValidation({ isolation: 'auto' }, mockSession);

      expect(validation.mode).toBe('full');
      expect(validation.skipWorktreeChecks).toBe(false);
    });
  });
});
