import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  adoptEditSessionSuccessorHead,
  applyEditOperations,
  beginEditSession,
  finalizeEditSession,
  getEditSession,
  type EditSessionBinding,
} from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { registerRepository } from '../../src/cli/repositories/registry';
import { applySafePatch } from '../../src/cli/repositories/safe-patch';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test('adopts a non-overlapping successor HEAD in the same Work-bound session and advances validation revision', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Concurrent successor adoption',
      allowedPaths: ['source.ts'],
      binding: durableBinding('runtime-a'),
    });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding('runtime-a') });

    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'parallel\n');
    spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'parallel unrelated change'], { cwd: fx.repoRoot });
    const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

    const adopted = adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, { binding: durableBinding('runtime-b') });
    expect(adopted.sessionId).toBe(session.sessionId);
    expect(adopted.baseRevision).toBe(successor);
    expect(adopted.currentRevision).toBe(2);
    expect(adopted.revisions.at(-1)).toMatchObject({ revision: 2, operations: [], changedFiles: 0, changedLines: 0 });
    expect(adopted.checkResults).toEqual([]);
    expect(adopted.controllerInstanceId).toBe('runtime-b');
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 2;\n');

    const continued = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256('export const value = 2;\n'),
      replacements: [{ oldText: 'value = 2', newText: 'value = 3' }],
    }], { expectedRevision: 2, binding: durableBinding('runtime-b') });
    expect(continued.currentRevision).toBe(3);
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 3;\n');
  });

  test('rejects successor HEAD adoption when the intervening commit overlaps a session path', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, { purpose: 'Overlap guard', allowedPaths: ['source.ts'], binding: durableBinding('runtime-a') });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding('runtime-a') });
    spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'overlapping source change'], { cwd: fx.repoRoot });

    expect(() => adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, { binding: durableBinding('runtime-b') }))
      .toThrow('EDIT_SESSION_SUCCESSOR_HEAD_PATH_OVERLAP: source.ts');
    expect(getEditSession(fx.repoRoot, session.sessionId).baseRevision).toBe(session.baseRevision);
  });

  test('rejects successor HEAD adoption after a non-descendant branch rewrite', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, { purpose: 'Descendant guard', allowedPaths: ['source.ts'], binding: durableBinding('runtime-a') });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding('runtime-a') });
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();
    const unrelatedRoot = spawnSync('git', ['commit-tree', tree, '-m', 'unrelated root'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['update-ref', 'refs/heads/main', unrelatedRoot], { cwd: fx.repoRoot });

    expect(() => adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, { binding: durableBinding('runtime-b') }))
      .toThrow('EDIT_SESSION_SUCCESSOR_HEAD_NOT_DESCENDANT');
  });

  test('safe patch transparently continues the same Work-bound session after a non-overlapping HEAD advance', () => {
    const fx = fixture();
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-edit-session-controller-'));
    roots.push(controllerHome);
    const repository = registerRepository({ path: fx.repoRoot, controllerHome, repoIdOverride: 'repo-runtime-continuity' });
    const binding = durableBinding('runtime-a', { repoId: repository.repoId, checkoutId: repository.activeCheckoutId });
    const session = beginEditSession(fx.repoRoot, { purpose: 'Safe patch successor recovery', allowedPaths: ['source.ts'], binding });
    const first = applySafePatch(repository, {
      sessionId: session.sessionId,
      operations: [{ type: 'replace', path: 'source.ts', old_text: 'value = 1', new_text: 'value = 2' }],
      binding,
    });
    expect(first.status).toBe('applied');

    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'parallel\n');
    spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'parallel unrelated change'], { cwd: fx.repoRoot });
    const rebound = { ...binding, controllerInstanceId: 'runtime-b' };
    const second = applySafePatch(repository, {
      sessionId: session.sessionId,
      expectedRevision: first.session.currentRevision,
      operations: [{ type: 'replace', path: 'source.ts', old_text: 'value = 2', new_text: 'value = 3' }],
      binding: rebound,
    });

    expect(second.status).toBe('applied');
    expect(second.recoveredSession).toMatchObject({ previousSessionId: session.sessionId, newSessionId: session.sessionId });
    expect(second.session.currentRevision).toBe(3);
    expect(second.session.baseRevision).toBe(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim());
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 3;\n');
  });

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-edit-session-continuity-'));
  roots.push(repoRoot);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
  const initial = 'export const value = 1;\n';
  writeFileSync(join(repoRoot, 'source.ts'), initial);
  spawnSync('git', ['add', 'source.ts'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  return { repoRoot, initial, policy: getMcpPolicy('controller', { repoRoot }) };
}

function durableBinding(controllerInstanceId: string, overrides: Partial<EditSessionBinding> = {}): EditSessionBinding {
  return {
    workId: 'work-runtime-continuity',
    repoId: 'repo-runtime-continuity',
    checkoutId: 'checkout-runtime-continuity',
    principalId: 'principal-runtime-continuity',
    controllerInstanceId,
    routeDecisionFingerprint: 'route-runtime-continuity',
    ...overrides,
  };
}

describe('edit session Runtime continuity', () => {
  test('rebinds a Work-owned session across Runtime instances and can finalize after another switch', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Runtime continuity',
      allowedPaths: ['source.ts'],
      binding: durableBinding('runtime-a'),
    });

    const applied = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace',
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding('runtime-b') });

    expect(applied).toMatchObject({ status: 'dirty', controllerInstanceId: 'runtime-b', currentRevision: 1 });
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 2;\n');

    const finalized = finalizeEditSession(fx.repoRoot, session.sessionId, {
      binding: durableBinding('runtime-c'),
    });
    expect(finalized).toMatchObject({ status: 'finalized', controllerInstanceId: 'runtime-c', currentRevision: 1 });
    expect(getEditSession(fx.repoRoot, session.sessionId).controllerInstanceId).toBe('runtime-c');
  });

  test('rejects Runtime rebinding when the durable principal changes', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Foreign principal guard',
      allowedPaths: ['source.ts'],
      binding: durableBinding('runtime-a'),
    });

    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace',
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding('runtime-b', { principalId: 'foreign-principal' }) })).toThrow('EDIT_SESSION_IDENTITY_MISMATCH: principalId');
    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace',
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding('runtime-b', { workId: 'foreign-work' }) })).toThrow('EDIT_SESSION_IDENTITY_MISMATCH: workId');
    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace',
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding('runtime-b', { checkoutId: 'foreign-checkout' }) })).toThrow('EDIT_SESSION_IDENTITY_MISMATCH: checkoutId');
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
    expect(getEditSession(fx.repoRoot, session.sessionId).controllerInstanceId).toBe('runtime-a');
  });

  test('does not migrate a transient direct-edit session using controller instance identity alone', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Direct session guard',
      allowedPaths: ['source.ts'],
      binding: { principalId: 'principal-runtime-continuity', controllerInstanceId: 'runtime-a' },
    });

    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace',
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: { principalId: 'principal-runtime-continuity', controllerInstanceId: 'runtime-b' } })).toThrow('EDIT_SESSION_IDENTITY_MISMATCH: controllerInstanceId');
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  });
});
