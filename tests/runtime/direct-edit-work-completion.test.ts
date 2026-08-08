import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyEditOperations, beginEditSession, finalizeEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { reconcileFinalizedDirectEditWorksAfterCommit } from '../../src/runtime/control-plane/execution/direct-edit-work-completion';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-direct-edit-work-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-direct-edit-work-home-'));
  roots.push(repoRoot, controllerHome);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# Test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });

  const repoId = 'repo-direct-edit-work';
  const checkoutId = 'checkout-direct-edit-work';
  const workId = 'work-direct-edit-work';
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    checkoutId,
    mode: 'direct_control',
    objective: 'Complete a standalone Direct Edit through WorkContract authority.',
    acceptanceCriteria: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    checks: [],
    constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });
  const session = beginEditSession(repoRoot, {
    purpose: 'Standalone Direct Edit',
    allowedPaths: ['src/**'],
    binding: { workId, repoId, checkoutId, principalId: 'principal-test' },
  });
  applyEditOperations(repoRoot, getMcpPolicy('controller'), session.sessionId, [
    { type: 'create', path: 'src/example.ts', content: 'export const value = 1;\n' },
  ], {
    binding: { workId, repoId, checkoutId, principalId: 'principal-test' },
  });
  finalizeEditSession(repoRoot, session.sessionId, {
    reviewer: 'test',
    binding: { workId, repoId, checkoutId, principalId: 'principal-test' },
  });
  return { repoRoot, controllerHome, repoId, checkoutId, workId, sessionId: session.sessionId };
}

function commitExample(repoRoot: string, content?: string) {
  if (content !== undefined) writeFileSync(join(repoRoot, 'src/example.ts'), content);
  execFileSync('git', ['add', '--', 'src/example.ts'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'direct edit'], { cwd: repoRoot });
}

describe('standalone Direct Edit Work completion', () => {
  test('records an exact Work completion receipt after the finalized edit is committed', () => {
    const fx = fixture();
    commitExample(fx.repoRoot);

    const reconciliation = reconcileFinalizedDirectEditWorksAfterCommit({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      committedPaths: ['src/example.ts'],
      fallbackBranch: 'main',
    });

    expect(reconciliation.completedWorkIds).toEqual([fx.workId]);
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId);
    expect(work).toMatchObject({
      status: 'completed',
      workKind: 'repository_change',
      completionOutcome: 'completed_changed',
      completionReceipt: {
        source: 'direct_edit_work',
        workId: fx.workId,
        editSessionId: fx.sessionId,
        targetBranch: 'main',
        changedPaths: ['src/example.ts'],
        delivery: { status: 'integrated', reachable: true },
        cleanup: { status: 'complete', blockers: [] },
      },
    });
  });

  test('does not complete Work when the committed content no longer matches the finalized edit', () => {
    const fx = fixture();
    commitExample(fx.repoRoot, 'export const value = 2;\n');

    const reconciliation = reconcileFinalizedDirectEditWorksAfterCommit({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      committedPaths: ['src/example.ts'],
      fallbackBranch: 'main',
    });

    expect(reconciliation.completedWorkIds).toEqual([]);
    expect(reconciliation.skipped[0]?.reason).toContain('revision_mismatch');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.status).toBe('running');
  });
});
