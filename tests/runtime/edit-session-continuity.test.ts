import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  adoptEditSessionSuccessorHead,
  applyEditOperations,
  beginEditSession,
  cleanupEditSession,
  inspectIntegratedEditSession,
  finalizeEditSession,
  getEditSession,
  listEditSessions,
  type EditSessionBinding,
} from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../adapters/mcp/policy';
import { registerRepository } from '../../src/cli/repositories/registry';
import { ensureRepositoryRuntimeStorageBinding } from '../../src/cli/repositories/runtime-storage';
import { applySafePatch } from '../../src/cli/repositories/safe-patch';
import { acquireExecutionLeases, listActiveLeases, releaseExecutionLeases } from '../../src/runtime/resources/leases/store';
import { buildRuntimeMaintenanceStatus } from '../../src/runtime/recovery/maintenance-executor';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test('adopts a non-overlapping successor HEAD in the same durable edit session and advances validation revision', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Concurrent successor adoption',
      allowedPaths: ['source.ts'],
      binding: durableBinding(),
    });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding() });

    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'parallel\n');
    spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'parallel unrelated change'], { cwd: fx.repoRoot });
    const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

    const adopted = adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
      binding: durableBinding(),
      controllerHome: fx.controllerHome,
      expectedRevision: getEditSession(fx.repoRoot, session.sessionId).currentRevision,
    });
    expect(adopted.sessionId).toBe(session.sessionId);
    expect(adopted.baseRevision).toBe(successor);
    expect(adopted.currentRevision).toBe(2);
    expect(adopted.revisions.at(-1)).toMatchObject({ revision: 2, operations: [], changedFiles: 0, changedLines: 0 });
    expect(adopted.checkResults).toEqual([]);
    expect(adopted.controllerInstanceId).toBeUndefined();
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 2;\n');

    const continued = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256('export const value = 2;\n'),
      replacements: [{ oldText: 'value = 2', newText: 'value = 3' }],
    }], { expectedRevision: 2, binding: durableBinding() });
    expect(continued.currentRevision).toBe(3);
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 3;\n');
  });

  test('adopts a non-overlapping successor HEAD for an ordinary Safe Patch session', () => {
    const fx = fixture();
    const binding: EditSessionBinding = {
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      principalId: 'principal-runtime-continuity',
    };
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Ordinary edit successor adoption without Work admission',
      allowedPaths: ['source.ts'],
      binding,
    });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding });

    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'parallel\n');
    spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'parallel unrelated change'], { cwd: fx.repoRoot });
    const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

    const adopted = adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
      binding,
      controllerHome: fx.controllerHome,
      expectedRevision: getEditSession(fx.repoRoot, session.sessionId).currentRevision,
    });
    expect(adopted.baseRevision).toBe(successor);
    expect(adopted.currentRevision).toBe(2);
    expect('workId' in adopted).toBe(false);
    expect(adopted.repoId).toBe(fx.repository.repoId);
    expect(adopted.checkoutId).toBe(fx.repository.activeCheckoutId);
    expect(adopted.controllerInstanceId).toBeUndefined();
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 2;\n');
  });

  test('safe patch transparently recovers an ordinary edit session after a non-overlapping HEAD advance', () => {
    const fx = fixture();
    const binding: EditSessionBinding = {
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      principalId: 'principal-runtime-continuity',
    };
    const session = beginEditSession(fx.repoRoot, { purpose: 'Ordinary safe patch successor recovery', allowedPaths: ['source.ts'], binding });
    const first = applySafePatch(fx.repository, {
      controllerHome: fx.controllerHome,
      sessionId: session.sessionId,
      operations: [{ type: 'replace', path: 'source.ts', old_text: 'value = 1', new_text: 'value = 2' }],
      binding,
    });
    expect(first.status).toBe('applied');

    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'parallel\n');
    spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'parallel unrelated change'], { cwd: fx.repoRoot });
    const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

    const second = applySafePatch(fx.repository, {
      controllerHome: fx.controllerHome,
      sessionId: session.sessionId,
      expectedRevision: first.session.currentRevision,
      operations: [{ type: 'replace', path: 'source.ts', old_text: 'value = 2', new_text: 'value = 3' }],
      binding,
    });
    expect(second.status).toBe('applied');
    expect(second.recoveredSession).toMatchObject({ previousSessionId: session.sessionId, newSessionId: session.sessionId });
    expect('workId' in second.session).toBe(false);
    expect(second.session.baseRevision).toBe(successor);
    expect(second.session.currentRevision).toBe(3);
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 3;\n');
  });

  test('ordinary successor adoption still rejects a foreign durable identity', () => {
    const fx = fixture();
    const binding: EditSessionBinding = {
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      principalId: 'principal-runtime-continuity',
    };
    const session = beginEditSession(fx.repoRoot, { purpose: 'Ordinary identity fence', allowedPaths: ['source.ts'], binding });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding });

    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'parallel\n');
    spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'parallel unrelated change'], { cwd: fx.repoRoot });
    const baseBefore = getEditSession(fx.repoRoot, session.sessionId).baseRevision;

    expect(() => adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
      binding: { ...binding, principalId: 'foreign-principal' },
      expectedRevision: getEditSession(fx.repoRoot, session.sessionId).currentRevision,
    })).toThrow('EDIT_SESSION_IDENTITY_MISMATCH: principalId');
    expect(getEditSession(fx.repoRoot, session.sessionId).baseRevision).toBe(baseBefore);
  });

  test('finalizes an integrated edit session after its tracked paths are committed', () => {
    const fx = fixture();
    const binding = durableBinding();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Finalize integrated session after HEAD advance',
      allowedPaths: ['source.ts'],
      binding,
    });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding });

    spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'integrate edit session'], { cwd: fx.repoRoot });

    const finalized = finalizeEditSession(fx.repoRoot, session.sessionId, {
      binding: durableBinding(),
    });
    expect(finalized).toMatchObject({ status: 'finalized', currentRevision: 1 });
    expect(finalized.controllerInstanceId).toBeUndefined();
  });

  test('does not finalize a stale session while its tracked after-image remains uncommitted', () => {
    const fx = fixture();
    const binding = durableBinding();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Keep uncommitted edit behind stale-baseline guard',
      allowedPaths: ['source.ts'],
      binding,
    });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding });

    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'parallel\n');
    spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'parallel unrelated change'], { cwd: fx.repoRoot });

    expect(() => finalizeEditSession(fx.repoRoot, session.sessionId, { binding }))
      .toThrow('EDIT_SESSION_BASE_REVISION_CHANGED');
    expect(getEditSession(fx.repoRoot, session.sessionId).status).toBe('dirty');
  });

  test('continues the same EditSession after exact integrated after-images and rejects unsafe overlap', () => {
    const fx = fixture();
    const binding = durableBinding();
    const session = beginEditSession(fx.repoRoot, { purpose: 'Exact integrated after-image adoption', allowedPaths: ['source.ts'], binding });
    const first = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { expectedRevision: session.currentRevision, binding });
    spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'integrate exact session after-image'], { cwd: fx.repoRoot });
    const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

    const held = acquireExecutionLeases(fx.controllerHome, fx.repository.repoId, 'successor-owner', [{
      resourceKey: 'workspace:checkout-runtime-continuity',
      mode: 'write',
      repoId: fx.repository.repoId,
      checkoutId: session.checkoutId,
    }], { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false });
    expect(held.acquired).toBe(true);
    expect(listActiveLeases(fx.controllerHome, fx.repository.repoId)).toContainEqual(expect.objectContaining({
      ownerJobId: 'successor-owner', checkoutId: session.checkoutId,
    }));
    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256('export const value = 2;\n'),
      replacements: [{ oldText: 'value = 2', newText: 'value = 3' }],
    }], {
      controllerHome: fx.controllerHome,
      expectedRevision: first.currentRevision,
      allowSuccessorHeadAdoption: true,
      binding,
    })).toThrow('EDIT_SESSION_SUCCESSOR_HEAD_ACTIVE_LEASE');
    expect(getEditSession(fx.repoRoot, session.sessionId).currentRevision).toBe(first.currentRevision);

    const continued = applySafePatch(fx.repository, {
      controllerHome: fx.controllerHome,
      leaseOwnerJobId: 'successor-owner',
      sessionId: session.sessionId,
      expectedRevision: first.currentRevision,
      operations: [{ type: 'replace', path: 'source.ts', old_text: 'value = 2', new_text: 'value = 3' }],
      binding,
    });
    expect(continued.status).toBe('applied');
    expect(continued.recoveredSession).toMatchObject({
      previousSessionId: session.sessionId,
      newSessionId: session.sessionId,
    });
    expect(continued.session.currentRevision).toBe(first.currentRevision + 2);
    expect(releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'successor-owner')).toBe(1);
    expect(continued.session).toMatchObject({
      status: 'dirty',
      baseRevision: successor,
      currentRevision: first.currentRevision + 2,
    });
    expect(continued.session.revisions[first.currentRevision].operations).toEqual([]);
    expect(continued.session.revisions[0].patchSha256).toBe(first.revisions[0].patchSha256);
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 3;\n');

    const drift = fixture();
    const driftBinding = durableBinding();
    const driftSession = beginEditSession(drift.repoRoot, {
      purpose: 'Reject overlapping content drift', allowedPaths: ['source.ts'], binding: driftBinding,
    });
    const driftFirst = applyEditOperations(drift.repoRoot, drift.policy, driftSession.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(drift.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { expectedRevision: driftSession.currentRevision, binding: driftBinding });
    writeFileSync(join(drift.repoRoot, 'source.ts'), 'export const value = 99;\n');
    spawnSync('git', ['add', 'source.ts'], { cwd: drift.repoRoot });
    spawnSync('git', ['commit', '-qm', 'overlapping foreign content'], { cwd: drift.repoRoot });

    expect(() => applyEditOperations(drift.repoRoot, drift.policy, driftSession.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256('export const value = 2;\n'),
      replacements: [{ oldText: 'value = 2', newText: 'value = 3' }],
    }], {
      controllerHome: drift.controllerHome,
      expectedRevision: driftFirst.currentRevision,
      allowSuccessorHeadAdoption: true,
      binding: driftBinding,
    }))
      .toThrow('EDIT_SESSION_SUCCESSOR_HEAD_CONTENT_DRIFT: source.ts');
    expect(getEditSession(drift.repoRoot, driftSession.sessionId).currentRevision).toBe(driftFirst.currentRevision);
    expect(readFileSync(join(drift.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 99;\n');
  });

  test('does not adopt an integrated after-image when its file mode has drifted', () => {
    const fx = fixture();
    const binding = durableBinding();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Exact after-image includes executable mode',
      allowedPaths: ['source.ts'],
      binding,
    });
    const first = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { expectedRevision: session.currentRevision, binding });
    spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'integrate before mode drift'], { cwd: fx.repoRoot });
    chmodSync(join(fx.repoRoot, 'source.ts'), 0o755);

    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256('export const value = 2;\n'),
      replacements: [{ oldText: 'value = 2', newText: 'value = 3' }],
    }], {
      controllerHome: fx.controllerHome,
      expectedRevision: first.currentRevision,
      allowSuccessorHeadAdoption: true,
      binding,
    })).toThrow('EDIT_SESSION_SUCCESSOR_HEAD_CONTENT_DRIFT: source.ts');
    expect(getEditSession(fx.repoRoot, session.sessionId).currentRevision).toBe(first.currentRevision);
  });

  test('continues a session when only some exact after-images were committed', () => {
    const fx = fixture();
    const binding = durableBinding();
    const otherInitial = 'export const other = 1;\n';
    writeFileSync(join(fx.repoRoot, 'other.ts'), otherInitial);
    spawnSync('git', ['add', 'other.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'add second tracked source'], { cwd: fx.repoRoot });

    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Partial exact after-image integration',
      allowedPaths: ['source.ts', 'other.ts'],
      binding,
    });
    const first = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [
      {
        type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
        replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
      },
      {
        type: 'replace', path: 'other.ts', expectedSha256: sha256(otherInitial),
        replacements: [{ oldText: 'other = 1', newText: 'other = 2' }],
      },
    ], { expectedRevision: session.currentRevision, binding });
    spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'integrate one exact after-image'], { cwd: fx.repoRoot });
    const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

    const continued = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'other.ts', expectedSha256: sha256('export const other = 2;\n'),
      replacements: [{ oldText: 'other = 2', newText: 'other = 3' }],
    }], {
      controllerHome: fx.controllerHome,
      expectedRevision: first.currentRevision,
      allowSuccessorHeadAdoption: true,
      binding,
    });
    expect(continued.baseRevision).toBe(successor);
    expect(continued.currentRevision).toBe(first.currentRevision + 2);
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 2;\n');
    expect(readFileSync(join(fx.repoRoot, 'other.ts'), 'utf8')).toBe('export const other = 3;\n');
  });

  test('continues a session after an exact committed deletion', () => {
    const fx = fixture();
    const binding = durableBinding();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Exact deleted after-image integration',
      allowedPaths: ['source.ts'],
      binding,
    });
    const first = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'delete', path: 'source.ts', expectedSha256: sha256(fx.initial),
    }], { expectedRevision: session.currentRevision, binding });
    spawnSync('git', ['add', '-u', 'source.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'integrate exact deletion'], { cwd: fx.repoRoot });
    const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

    const continued = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'create', path: 'source.ts', content: 'export const value = 3;\n',
    }], {
      controllerHome: fx.controllerHome,
      expectedRevision: first.currentRevision,
      allowSuccessorHeadAdoption: true,
      binding,
    });
    expect(continued.baseRevision).toBe(successor);
    expect(continued.currentRevision).toBe(first.currentRevision + 2);
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 3;\n');
  });

  test('fails closed when an active repository lease has no checkout identity', () => {
  const fx = fixture();
  const binding = durableBinding();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Unknown checkout lease is repository-wide',
    allowedPaths: ['source.ts'],
    binding,
  });
  applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
  }], { expectedRevision: session.currentRevision, binding });
  spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
  spawnSync('git', ['commit', '-qm', 'integrate before unscoped lease'], { cwd: fx.repoRoot });

  const held = acquireExecutionLeases(fx.controllerHome, fx.repository.repoId, 'unscoped-owner', [{
    resourceKey: 'workspace:legacy-unscoped',
    mode: 'write',
    repoId: fx.repository.repoId,
  }], { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false });
  expect(held.acquired).toBe(true);
  expect(listActiveLeases(fx.controllerHome, fx.repository.repoId)).toContainEqual(expect.objectContaining({
    ownerJobId: 'unscoped-owner',
    ownerIdentity: expect.objectContaining({ checkoutId: 'unscoped' }),
  }));
  expect(() => adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
    binding,
    controllerHome: fx.controllerHome,
    expectedRevision: getEditSession(fx.repoRoot, session.sessionId).currentRevision,
  })).toThrow('EDIT_SESSION_SUCCESSOR_HEAD_ACTIVE_LEASE');
  expect(releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'unscoped-owner')).toBe(1);
});

test('does not block successor adoption for a different checkout lease', () => {
  const fx = fixture();
  const binding = durableBinding();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Independent checkout remains concurrent',
    allowedPaths: ['source.ts'],
    binding,
  });
  applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
  }], { expectedRevision: session.currentRevision, binding });
  spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
  spawnSync('git', ['commit', '-qm', 'integrate before independent lease'], { cwd: fx.repoRoot });
  const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

  const held = acquireExecutionLeases(fx.controllerHome, fx.repository.repoId, 'other-checkout-owner', [{
    resourceKey: 'workspace:other-checkout',
    mode: 'write',
    repoId: fx.repository.repoId,
    checkoutId: 'checkout-other',
  }], { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false });
  expect(held.acquired).toBe(true);
  const adopted = adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
    binding,
    controllerHome: fx.controllerHome,
    expectedRevision: getEditSession(fx.repoRoot, session.sessionId).currentRevision,
  });
  expect(adopted.baseRevision).toBe(successor);
  expect(releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'other-checkout-owner')).toBe(1);
});

test('rejects successor HEAD adoption after a non-descendant branch rewrite', () => {
    const fx = fixture();
    const session = beginEditSession(fx.repoRoot, { purpose: 'Descendant guard', allowedPaths: ['source.ts'], binding: durableBinding() });
    applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding: durableBinding() });
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();
    const unrelatedRoot = spawnSync('git', ['commit-tree', tree, '-m', 'unrelated root'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['update-ref', 'refs/heads/main', unrelatedRoot], { cwd: fx.repoRoot });

    expect(() => adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
      binding: durableBinding(),
      expectedRevision: getEditSession(fx.repoRoot, session.sessionId).currentRevision,
    }))
      .toThrow('EDIT_SESSION_SUCCESSOR_HEAD_NOT_DESCENDANT');
  });

  test('safe patch transparently continues the same durable edit session after a non-overlapping HEAD advance', () => {
    const fx = fixture();
    const binding = durableBinding({ repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId });
    const session = beginEditSession(fx.repoRoot, { purpose: 'Safe patch successor recovery', allowedPaths: ['source.ts'], binding });
    const first = applySafePatch(fx.repository, {
      sessionId: session.sessionId,
      operations: [{ type: 'replace', path: 'source.ts', old_text: 'value = 1', new_text: 'value = 2' }],
      binding,
    });
    expect(first.status).toBe('applied');

    spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
    spawnSync('git', ['commit', '-qm', 'integrate exact safe-patch after-image'], { cwd: fx.repoRoot });
    const rebound = binding;
    const second = applySafePatch(fx.repository, {
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

test('Swift-only medium edit does not inject unavailable Forge package checks', () => {
  const fx = fixture();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Swift-like repository with no package check registry',
    allowedPaths: ['source.ts'], binding: durableBinding(),
  });
  const larger = 'value = 2;' + Array.from({ length: 550 }, (_, i) => '\n// line ' + i).join('');
  const edited = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'value = 1', newText: larger }],
  }], { binding: durableBinding() });
  expect(edited.assurance?.semanticRisk).toBe('medium');
  expect(edited.assurance?.requiredChecks).toEqual([]);
  expect(edited.requestedChecks).toEqual([]);
});

test('available package type check is required for medium edits', () => {
  const fx = fixture();
  writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({ scripts: { 'check:type': 'tsc --noEmit' } }));
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Registered package check is real',
    allowedPaths: ['source.ts'], binding: durableBinding(),
  });
  const larger = 'value = 2;' + Array.from({ length: 550 }, (_, i) => '\n// line ' + i).join('');
  const edited = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'value = 1', newText: larger }],
  }], { binding: durableBinding() });
  expect(edited.assurance?.requiredChecks).toContain('package:check:type');
});

test('integrated legacy missing check records explicitly UNVERIFIED without claiming PASS', () => {
  const fx = fixture();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Already-integrated Swift source with unavailable package check',
    allowedPaths: ['source.ts'], checks: ['package:check:type'], binding: durableBinding(),
  });
  applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
  }], { binding: durableBinding() });
  spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
  spawnSync('git', ['commit', '-qm', 'source already integrated'], { cwd: fx.repoRoot });
  const inspect = () => inspectIntegratedEditSession(fx.repoRoot, session.sessionId, {
    repoId: fx.repository.repoId, controllerHome: fx.controllerHome,
  });
  expect(inspect()).toMatchObject({ safe: true, unverifiedChecks: ['package:check:type'] });
  const cleanup = cleanupEditSession(fx.repoRoot, session.sessionId, {
    repoId: fx.repository.repoId, controllerHome: fx.controllerHome,
  });
  expect(cleanup.status).toBe('reconciled_unverified');
  expect(cleanup.checkResults).toEqual([]);
  expect(cleanup.verifiedAt).toBeUndefined();
  expect(cleanup.unverifiedChecks).toEqual(['package:check:type']);
  expect(cleanup.reviewNote).toContain('UNVERIFIED');
  expect(getEditSession(fx.repoRoot, session.sessionId).status).toBe('reconciled_unverified');
  expect(listEditSessions(fx.repoRoot).find((entry) => entry.sessionId === session.sessionId)?.reconciledAt).toBeDefined();
  expect(cleanupEditSession(fx.repoRoot, session.sessionId).status).toBe('reconciled_unverified');

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();
  const continued = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256('export const value = 2;\n'),
    replacements: [{ oldText: 'value = 2', newText: 'value = 3' }],
  }], {
    controllerHome: fx.controllerHome,
    expectedRevision: cleanup.currentRevision,
    allowSuccessorHeadAdoption: true,
    binding: durableBinding(),
  });
  expect(continued.status).toBe('dirty');
  expect(continued.baseRevision).toBe(head);
  expect(continued.checkResults).toEqual([]);
  expect(continued.verifiedAt).toBeUndefined();
  expect(continued.unverifiedChecks).toBeUndefined();
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 3;\n');
});

test('metadata-only reconciliation rejects live lease and leaves dirty session unchanged', () => {
  const fx = fixture();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Lease owner still active',
    allowedPaths: ['source.ts'], checks: ['package:check:type'], binding: durableBinding(),
  });
  applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
  }], { binding: durableBinding() });
  spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot });
  spawnSync('git', ['commit', '-qm', 'integrated under lease'], { cwd: fx.repoRoot });
  const held = acquireExecutionLeases(fx.controllerHome, fx.repository.repoId, 'test-owner', [
    { resourceKey: 'workspace:checkout-runtime-continuity', mode: 'write' },
  ], { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false });
  expect(held.acquired).toBe(true);
  const inspect = inspectIntegratedEditSession(fx.repoRoot, session.sessionId, {
    repoId: fx.repository.repoId, controllerHome: fx.controllerHome,
  });
  expect(inspect).toMatchObject({ safe: false, reason: 'EDIT_SESSION_RECONCILIATION_ACTIVE_LEASE' });
  expect(() => cleanupEditSession(fx.repoRoot, session.sessionId, {
    repoId: fx.repository.repoId, controllerHome: fx.controllerHome,
  })).toThrow('EDIT_SESSION_RECONCILIATION_ACTIVE_LEASE');
  expect(getEditSession(fx.repoRoot, session.sessionId).status).toBe('dirty');
});

test('maintenance never considers an empty reserved successor session safe garbage', () => {
  const fx = fixture();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Reserved P0B session', allowedPaths: ['source.ts'], binding: durableBinding(),
  });
  const state = buildRuntimeMaintenanceStatus({
    repoId: fx.repository.repoId, canonicalRoot: fx.repoRoot,
  }, fx.controllerHome, { minAgeMinutes: 0, maxCandidates: 25 });
  const candidate = state.candidates.find((entry) => entry.id === session.sessionId);
  expect(candidate).toMatchObject({
    kind: 'stale_edit_session', safe: false,
    reason: 'EDIT_SESSION_RECONCILIATION_NOT_ELIGIBLE',
  });
  expect(getEditSession(fx.repoRoot, session.sessionId).status).toBe('open');
});

test('protected generated paths retain explicit approval across metadata cleanup', () => {
  const fx = fixture();
  const protectedPath = 'Generated.xcodeproj/project.pbxproj';
  mkdirSync(join(fx.repoRoot, 'Generated.xcodeproj'), { recursive: true });
  writeFileSync(join(fx.repoRoot, protectedPath), 'value = 1;\n');
  writeFileSync(join(fx.repoRoot, '.gitignore'), protectedPath + '\n');
  spawnSync('git', ['add', '.gitignore'], { cwd: fx.repoRoot });
  spawnSync('git', ['commit', '-qm', 'ignore generated project file'], { cwd: fx.repoRoot });

  const binding: EditSessionBinding = {
    repoId: fx.repository.repoId,
    checkoutId: fx.repository.activeCheckoutId,
    principalId: 'principal-runtime-continuity',
  };
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Protected generated project approval boundary',
    allowedPaths: [protectedPath],
    binding,
  });
  applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace',
    path: protectedPath,
    expectedSha256: sha256('value = 1;\n'),
    replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
  }], { binding });

  writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'advance HEAD\n');
  spawnSync('git', ['add', 'unrelated.txt'], { cwd: fx.repoRoot });
  spawnSync('git', ['commit', '-qm', 'advance unrelated HEAD'], { cwd: fx.repoRoot });

  expect(getEditSession(fx.repoRoot, session.sessionId).assurance?.approvalRequired).toBe(true);
  expect(() => adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
    binding,
    expectedRevision: getEditSession(fx.repoRoot, session.sessionId).currentRevision,
  })).toThrow('EDIT_SESSION_SUCCESSOR_HEAD_APPROVAL_REQUIRED');
  expect(inspectIntegratedEditSession(fx.repoRoot, session.sessionId, {
    repoId: fx.repository.repoId, controllerHome: fx.controllerHome,
  })).toMatchObject({
    safe: false,
    reason: 'EDIT_SESSION_RECONCILIATION_APPROVAL_REQUIRED',
  });
  expect(() => cleanupEditSession(fx.repoRoot, session.sessionId, {
    repoId: fx.repository.repoId,
    controllerHome: fx.controllerHome,
  })).toThrow('EDIT_SESSION_RECONCILIATION_APPROVAL_REQUIRED');
  expect(getEditSession(fx.repoRoot, session.sessionId).status).toBe('dirty');
  expect(() => finalizeEditSession(fx.repoRoot, session.sessionId, { binding }))
    .toThrow('EDIT_SESSION_APPROVAL_REQUIRED');

  const finalized = finalizeEditSession(fx.repoRoot, session.sessionId, {
    binding,
    approvalConfirmed: true,
  });
  expect(finalized.status).toBe('finalized');
  expect(finalized.assurance?.approvalRequired).toBe(true);
  expect(readFileSync(join(fx.repoRoot, protectedPath), 'utf8')).toBe('value = 2;\n');
});

test('successor adoption hashes exact committed source bytes with credential-shaped assignments', () => {
  const fx = fixture();
  const binding = durableBinding();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Exact Git blob hash with credential-shaped source',
    allowedPaths: ['source.ts'],
    binding,
  });
  const after = "export const authorization = 'fixture-value';\n";
  applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'export const value = 1;', newText: "export const authorization = 'fixture-value';" }],
  }], { binding });
  expect(spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot }).status).toBe(0);
  expect(spawnSync('git', ['commit', '-qm', 'integrate credential-shaped source'], { cwd: fx.repoRoot }).status).toBe(0);
  const successor = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).stdout.trim();

  const adopted = adoptEditSessionSuccessorHead(fx.repoRoot, session.sessionId, {
    binding, controllerHome: fx.controllerHome, expectedRevision: 1,
  });
  expect(adopted.baseRevision).toBe(successor);
  expect(adopted.currentRevision).toBe(2);
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(after);
});

test('integrated EditSession inspection hashes exact committed source bytes before redaction', () => {
  const fx = fixture();
  const binding = durableBinding();
  const session = beginEditSession(fx.repoRoot, {
    purpose: 'Inspect exact Git blob with credential-shaped source',
    allowedPaths: ['source.ts'],
    binding,
  });
  const after = "export const authorization = 'fixture-value';\n";
  applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
    type: 'replace', path: 'source.ts', expectedSha256: sha256(fx.initial),
    replacements: [{ oldText: 'export const value = 1;', newText: "export const authorization = 'fixture-value';" }],
  }], { binding });
  expect(spawnSync('git', ['add', 'source.ts'], { cwd: fx.repoRoot }).status).toBe(0);
  expect(spawnSync('git', ['commit', '-qm', 'integrate credential-shaped source'], { cwd: fx.repoRoot }).status).toBe(0);
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(after);

  expect(inspectIntegratedEditSession(fx.repoRoot, session.sessionId, {
    repoId: fx.repository.repoId, controllerHome: fx.controllerHome,
  })).toMatchObject({ safe: true, unverifiedChecks: [] });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-edit-session-continuity-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-edit-session-controller-'));
  roots.push(repoRoot, controllerHome);
  // Safe Patch re-resolves runtime storage from the controller environment;
  // bind each fixture's isolated Controller Home so tests cannot write the
  // developer's real Controller Home.
  process.env.FORGE_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
  const initial = 'export const value = 1;\n';
  writeFileSync(join(repoRoot, 'source.ts'), initial);
  spawnSync('git', ['add', 'source.ts'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  const repository = registerRepository({ path: repoRoot, controllerHome, repoIdOverride: 'repo-runtime-continuity' });
  ensureRepositoryRuntimeStorageBinding(repository, 'edit-sessions', controllerHome);
  return { repoRoot, controllerHome, repository, initial, policy: getMcpPolicy('controller', { repoRoot }) };
}

function durableBinding(overrides: Partial<EditSessionBinding> = {}): EditSessionBinding {
  return {
    repoId: 'repo-runtime-continuity',
    checkoutId: 'checkout-runtime-continuity',
    principalId: 'principal-runtime-continuity',
    ...overrides,
  };
}

describe('edit session durable identity continuity', () => {
  test('continues and finalizes using the same repository/checkout/principal identity', () => {
    const fx = fixture();
    const binding = durableBinding();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Durable identity continuity',
      allowedPaths: ['source.ts'],
      binding,
    });

    const applied = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace',
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding });

    expect(applied).toMatchObject({ status: 'dirty', currentRevision: 1 });
    expect(applied.controllerInstanceId).toBeUndefined();
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const value = 2;\n');

    const finalized = finalizeEditSession(fx.repoRoot, session.sessionId, { binding });
    expect(finalized).toMatchObject({ status: 'finalized', currentRevision: 1 });
    expect(finalized.controllerInstanceId).toBeUndefined();
  });

  test('rejects a foreign principal or checkout without consulting Work', () => {
    const fx = fixture();
    const binding = durableBinding();
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Durable identity fence',
      allowedPaths: ['source.ts'],
      binding,
    });
    const operation = [{
      type: 'replace' as const,
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }];

    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, operation, {
      binding: durableBinding({ principalId: 'foreign-principal' }),
    })).toThrow('EDIT_SESSION_IDENTITY_MISMATCH: principalId');
    expect(() => applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, operation, {
      binding: durableBinding({ checkoutId: 'foreign-checkout' }),
    })).toThrow('EDIT_SESSION_IDENTITY_MISMATCH: checkoutId');
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  });

  test('principal-only transient edit identity can continue without Runtime-instance rebinding', () => {
    const fx = fixture();
    const binding: EditSessionBinding = { principalId: 'principal-runtime-continuity' };
    const session = beginEditSession(fx.repoRoot, {
      purpose: 'Transient principal continuity',
      allowedPaths: ['source.ts'],
      binding,
    });

    const applied = applyEditOperations(fx.repoRoot, fx.policy, session.sessionId, [{
      type: 'replace',
      path: 'source.ts',
      expectedSha256: sha256(fx.initial),
      replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
    }], { binding });
    expect(applied.status).toBe('dirty');
    expect(applied.controllerInstanceId).toBeUndefined();
  });
});
