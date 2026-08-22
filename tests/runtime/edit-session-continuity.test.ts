import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  applyEditOperations,
  beginEditSession,
  finalizeEditSession,
  getEditSession,
  type EditSessionBinding,
} from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
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
