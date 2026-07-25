import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyEditOperations,
  beginEditSession,
  cleanupEditSession,
  finalizeEditSession,
  getEditSession,
  listEditSessions,
  reconcileEditSession,
  reconcileOpenEditSessions,
  rollbackEditSession,
} from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { runProcess } from '../../src/effects/process-runner';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-edit-lifecycle-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'example.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'edit-lifecycle' }, null, 2));
  writeFileSync(join(root, '.gitignore'), '.ai/\n');
  expect(runProcess('git', ['init', '-b', 'main'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
  expect(runProcess('git', ['config', 'user.email', 'edit@test.local'], { cwd: root, timeoutMs: 5_000 }).ok).toBe(true);
  expect(runProcess('git', ['config', 'user.name', 'Edit Lifecycle'], { cwd: root, timeoutMs: 5_000 }).ok).toBe(true);
  expect(runProcess('git', ['add', '.'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
  expect(runProcess('git', ['commit', '-m', 'init'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
  return root;
}

describe('edit session lifecycle reconciliation', () => {
  test('create → edit → commit → reconcile finalizes a committed dirty session', () => {
    const root = fixtureRepo();
    const policy = getMcpPolicy('controller', { repoRoot: root });
    const initial = readFileSync(join(root, 'src/example.ts'), 'utf-8');
    const session = beginEditSession(root, {
      purpose: 'Committed session should not block forever',
      allowedPaths: ['src/**'],
    });

    applyEditOperations(root, policy, session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }]);
    expect(getEditSession(root, session.sessionId).status).toBe('dirty');

    expect(runProcess('git', ['add', 'src/example.ts'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
    expect(runProcess('git', ['commit', '-m', 'apply edit session'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);

    const reconciled = reconcileEditSession(root, session.sessionId, { reviewer: 'lifecycle-test' });
    expect(reconciled.status).toBe('finalized');
    expect(reconciled.reviewNote).toMatch(/Reconciled after commit/i);
    expect(readFileSync(join(root, 'src/example.ts'), 'utf-8')).toContain('value = 2');

    // Idempotent: second reconcile leaves terminal state alone.
    expect(reconcileEditSession(root, session.sessionId).status).toBe('finalized');
    expect(listEditSessions(root).find((entry) => entry.sessionId === session.sessionId)?.status).toBe('finalized');
  });

  test('committed sessions with configured checks remain open until every check passes', () => {
    const root = fixtureRepo();
    const policy = getMcpPolicy('controller', { repoRoot: root });
    const initial = readFileSync(join(root, 'src/example.ts'), 'utf-8');
    const session = beginEditSession(root, {
      purpose: 'Checks cannot be bypassed by commit reconciliation',
      allowedPaths: ['src/**'],
      checks: ['package:check:type'],
    });

    applyEditOperations(root, policy, session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }]);
    expect(runProcess('git', ['add', 'src/example.ts'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
    expect(runProcess('git', ['commit', '-m', 'commit without checks'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);

    const reconciled = reconcileEditSession(root, session.sessionId);
    expect(reconciled.status).toBe('dirty');
    expect(reconciled.finalizedAt).toBeUndefined();
    expect(() => finalizeEditSession(root, session.sessionId)).toThrow(/configured checks must pass/i);
  });

  test('empty session rollback produces no Git changes', () => {
    const root = fixtureRepo();
    const beforeStatus = runProcess('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 5_000 });
    expect(beforeStatus.ok).toBe(true);
    expect(beforeStatus.stdout.trim()).toBe('');

    const session = beginEditSession(root, { purpose: 'Empty rollback' });
    const rolled = rollbackEditSession(root, session.sessionId);
    expect(rolled.status).toBe('rolled_back');
    expect(rolled.currentRevision).toBe(0);

    const afterStatus = runProcess('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 5_000 });
    expect(afterStatus.ok).toBe(true);
    expect(afterStatus.stdout.trim()).toBe('');
    expect(readFileSync(join(root, 'src/example.ts'), 'utf-8')).toBe('export const value = 1;\n');
  });

  test('cleanup refuses sessions that still own unique uncommitted content', () => {
    const root = fixtureRepo();
    const policy = getMcpPolicy('controller', { repoRoot: root });
    const initial = readFileSync(join(root, 'src/example.ts'), 'utf-8');
    const session = beginEditSession(root, {
      purpose: 'Unique uncommitted content',
      allowedPaths: ['src/**'],
    });
    applyEditOperations(root, policy, session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = unique-uncommitted' }],
    }]);

    const contentBefore = readFileSync(join(root, 'src/example.ts'), 'utf-8');
    expect(() => cleanupEditSession(root, session.sessionId)).toThrow(/unique uncommitted changes/i);
    expect(getEditSession(root, session.sessionId).status).toBe('dirty');
    expect(readFileSync(join(root, 'src/example.ts'), 'utf-8')).toBe(contentBefore);
  });

  test('external overwrite marks session superseded without rewriting files', () => {
    const root = fixtureRepo();
    const policy = getMcpPolicy('controller', { repoRoot: root });
    const initial = readFileSync(join(root, 'src/example.ts'), 'utf-8');
    const session = beginEditSession(root, { purpose: 'Supersede by newer content', allowedPaths: ['src/**'] });
    applyEditOperations(root, policy, session.sessionId, [{
      type: 'replace',
      path: 'src/example.ts',
      expectedSha256: sha(initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }]);

    const newer = 'export const value = 99;\nexport const stable = true;\n';
    writeFileSync(join(root, 'src/example.ts'), newer);

    const closed = reconcileEditSession(root, session.sessionId, { reviewer: 'lifecycle-test' });
    expect(closed.status).toBe('superseded');
    expect(closed.supersededPaths).toEqual(['src/example.ts']);
    expect(readFileSync(join(root, 'src/example.ts'), 'utf-8')).toBe(newer);
  });

  test('reconcileOpenEditSessions is idempotent and batch-safe', () => {
    const root = fixtureRepo();
    const empty = beginEditSession(root, { purpose: 'still open empty' });
    const finalizedEmpty = beginEditSession(root, { purpose: 'finalize empty' });
    finalizeEditSession(root, finalizedEmpty.sessionId);

    const summaries = reconcileOpenEditSessions(root, { reviewer: 'batch' });
    expect(summaries.some((entry) => entry.sessionId === empty.sessionId && entry.status === 'open')).toBe(true);
    expect(summaries.every((entry) => entry.sessionId !== finalizedEmpty.sessionId)).toBe(true);
    expect(getEditSession(root, empty.sessionId).status).toBe('open');
    expect(getEditSession(root, finalizedEmpty.sessionId).status).toBe('finalized');

    // Empty open sessions can be cleaned by cleanup without Git churn.
    const cleaned = cleanupEditSession(root, empty.sessionId);
    expect(cleaned.status).toBe('rolled_back');
    expect(existsSync(join(root, '.ai/harness/edit-sessions', empty.sessionId, 'session.json'))).toBe(true);
  });
});
