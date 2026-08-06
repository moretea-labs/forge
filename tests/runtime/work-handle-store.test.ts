import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readWorkHandle,
  transitionWorkHandle,
  writeWorkHandle,
  type WorkHandleState,
} from '../../src/runtime/control-plane/execution/work-handle-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { controllerHome: string; handle: WorkHandleState } {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-handle-'));
  roots.push(controllerHome);
  const now = new Date().toISOString();
  return {
    controllerHome,
    handle: {
      schemaVersion: 1,
      workId: 'work-cas',
      sessionId: 'session-a',
      principalId: 'principal-a',
      repositoryId: 'repo-a',
      checkoutId: 'checkout-a',
      worktreePath: '/tmp/worktree-a',
      branch: 'work/a',
      managedWorktree: false,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      finalization: {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
      },
    },
  };
}

describe('WorkHandle CAS lifecycle', () => {
  test('rejects a stale lifecycle writer instead of overwriting newer state', () => {
    const fx = fixture();
    writeWorkHandle(fx.controllerHome, fx.handle);
    const first = readWorkHandle(fx.controllerHome, fx.handle.repositoryId, fx.handle.workId)!;
    const stale = { ...first };
    const editing = transitionWorkHandle(fx.controllerHome, first, 'editing');

    expect(editing.recordRevision).toBeGreaterThan(first.recordRevision ?? 0);
    expect(() => transitionWorkHandle(fx.controllerHome, stale, 'validating')).toThrow(/CONTROL_PLANE_REVISION_CONFLICT/);
    expect(readWorkHandle(fx.controllerHome, fx.handle.repositoryId, fx.handle.workId)?.state).toBe('editing');
  });
});
