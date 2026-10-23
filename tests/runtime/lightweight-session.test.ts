import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createLightweightSession,
  readLightweightSession,
  touchLightweightSession,
  shouldUseLightweightMode,
  getLightweightSessionChanges,
  type LightweightWorkSession,
} from '../../src/runtime/control-plane/execution/lightweight-session';

describe('LightweightWorkSession', () => {
  let controllerHome: string;

  beforeEach(() => {
    controllerHome = mkdtempSync(join(tmpdir(), 'forge-test-'));
  });

  afterEach(() => {
    if (controllerHome) {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  describe('createLightweightSession', () => {
    test('creates a minimal session record', () => {
      const session = createLightweightSession(controllerHome, {
        sessionId: 'sess_test123',
        repoId: 'repo_abc',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123def456',
      });

      expect(session.schemaVersion).toBe(1);
      expect(session.sessionId).toBe('sess_test123');
      expect(session.repoId).toBe('repo_abc');
      expect(session.checkoutId).toBe('checkout_main');
      expect(session.branch).toBe('main');
      expect(session.baselineHead).toBe('abc123def456');
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
    });

    test('records baseline dirty paths', () => {
      const dirtyPaths = ['src/file1.ts', 'src/file2.ts', 'test/file3.ts'];
      const session = createLightweightSession(controllerHome, {
        sessionId: 'sess_test123',
        repoId: 'repo_abc',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
        baselineDirtyPaths: dirtyPaths,
      });

      expect(session.baselineDirtyPaths).toEqual(dirtyPaths);
      expect(session.baselineDirtyPathCount).toBe(3);
    });

    test('truncates excessive dirty paths', () => {
      const manyPaths = Array.from({ length: 3000 }, (_, i) => `file${i}.ts`);
      const session = createLightweightSession(controllerHome, {
        sessionId: 'sess_test123',
        repoId: 'repo_abc',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
        baselineDirtyPaths: manyPaths,
      });

      expect(session.baselineDirtyPaths?.length).toBe(2000);
      expect(session.baselineDirtyPathCount).toBe(3000);
    });
  });

  describe('readLightweightSession', () => {
    test('reads back created session', () => {
      const created = createLightweightSession(controllerHome, {
        sessionId: 'sess_test123',
        repoId: 'repo_abc',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
      });

      const read = readLightweightSession(controllerHome, 'sess_test123', 'repo_abc');
      expect(read).toEqual(created);
    });

    test('returns undefined for non-existent session', () => {
      const read = readLightweightSession(controllerHome, 'sess_missing', 'repo_abc');
      expect(read).toBeUndefined();
    });

    test('sessions are scoped by sessionId and repoId', () => {
      createLightweightSession(controllerHome, {
        sessionId: 'sess_1',
        repoId: 'repo_a',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
      });

      createLightweightSession(controllerHome, {
        sessionId: 'sess_1',
        repoId: 'repo_b',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'def456',
      });

      const sessionA = readLightweightSession(controllerHome, 'sess_1', 'repo_a');
      const sessionB = readLightweightSession(controllerHome, 'sess_1', 'repo_b');

      expect(sessionA?.baselineHead).toBe('abc123');
      expect(sessionB?.baselineHead).toBe('def456');
    });
  });

  describe('touchLightweightSession', () => {
    test('updates timestamp of existing session', async () => {
      const created = createLightweightSession(controllerHome, {
        sessionId: 'sess_test123',
        repoId: 'repo_abc',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
      });

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const touched = touchLightweightSession(controllerHome, 'sess_test123', 'repo_abc');
      expect(touched).toBeDefined();
      expect(touched!.updatedAt).not.toBe(created.updatedAt);
      expect(new Date(touched!.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime(),
      );
    });

    test('returns undefined for non-existent session', () => {
      const touched = touchLightweightSession(controllerHome, 'sess_missing', 'repo_abc');
      expect(touched).toBeUndefined();
    });
  });

  describe('shouldUseLightweightMode', () => {
    test('returns false by default (opt-in required)', () => {
      expect(shouldUseLightweightMode({ isolation: 'reuse' })).toBe(false);
    });

    test('returns true when lightweight=true with isolation=reuse', () => {
      expect(shouldUseLightweightMode({ isolation: 'reuse', lightweight: true })).toBe(true);
    });

    test('returns false for isolation=new_worktree even with lightweight=true', () => {
      expect(shouldUseLightweightMode({ isolation: 'new_worktree', lightweight: true })).toBe(false);
    });

    test('returns false when work_id is specified', () => {
      expect(shouldUseLightweightMode({ isolation: 'reuse', lightweight: true, work_id: 'work-123' })).toBe(false);
    });

    test('returns false for relocation', () => {
      expect(shouldUseLightweightMode({ isolation: 'reuse', lightweight: true, relocate_to_new_worktree: true })).toBe(
        false,
      );
    });

    test('returns false for recovery', () => {
      expect(
        shouldUseLightweightMode({ isolation: 'reuse', lightweight: true, expected_previous_head: 'abc123' }),
      ).toBe(false);
      expect(shouldUseLightweightMode({ isolation: 'reuse', lightweight: true, adopt_candidate_head: 'def456' })).toBe(
        false,
      );
    });
  });

  describe('getLightweightSessionChanges', () => {
    test('returns all dirty files when baseline was clean', () => {
      const session: LightweightWorkSession = {
        schemaVersion: 1,
        sessionId: 'sess_1',
        repoId: 'repo_a',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const currentDirty = new Set(['src/file1.ts', 'src/file2.ts']);
      const changes = getLightweightSessionChanges(session, currentDirty);

      expect(changes).toEqual(['src/file1.ts', 'src/file2.ts']);
    });

    test('returns only new dirty files when baseline had some', () => {
      const session: LightweightWorkSession = {
        schemaVersion: 1,
        sessionId: 'sess_1',
        repoId: 'repo_a',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
        baselineDirtyPaths: ['src/existing.ts'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const currentDirty = new Set(['src/existing.ts', 'src/new1.ts', 'src/new2.ts']);
      const changes = getLightweightSessionChanges(session, currentDirty);

      expect(changes).toEqual(['src/new1.ts', 'src/new2.ts']);
    });

    test('returns empty array when no new changes', () => {
      const session: LightweightWorkSession = {
        schemaVersion: 1,
        sessionId: 'sess_1',
        repoId: 'repo_a',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
        baselineDirtyPaths: ['src/existing.ts'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const currentDirty = new Set(['src/existing.ts']);
      const changes = getLightweightSessionChanges(session, currentDirty);

      expect(changes).toEqual([]);
    });

    test('returns sorted changes', () => {
      const session: LightweightWorkSession = {
        schemaVersion: 1,
        sessionId: 'sess_1',
        repoId: 'repo_a',
        checkoutId: 'checkout_main',
        branch: 'main',
        baselineHead: 'abc123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const currentDirty = new Set(['z.ts', 'a.ts', 'm.ts']);
      const changes = getLightweightSessionChanges(session, currentDirty);

      expect(changes).toEqual(['a.ts', 'm.ts', 'z.ts']);
    });
  });
});
