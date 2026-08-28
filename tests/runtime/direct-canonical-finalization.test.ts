import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { repositoryGitStatus } from '../../src/cli/repositories/structured-git';
import type { VerificationRecord } from '../../src/runtime/control-plane/facade/types';
import { verificationInputFingerprint, workspaceValidationFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';
import { inspectDirectCanonicalTargetAdvanceReconciliation } from '../../src/runtime/gateway/mcp/execution-tools';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(String(result.stderr || `git ${args.join(' ')} failed`));
  return String(result.stdout ?? '').trim();
}

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `forge-direct-canonical-${label}-`));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Direct Canonical Test']);
  git(repoRoot, ['config', 'user.email', 'direct-canonical@example.test']);
  writeFileSync(join(repoRoot, 'owned.txt'), 'owned-base\n');
  writeFileSync(join(repoRoot, 'target.txt'), 'target-base\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base']);
  const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: `direct-canonical-${label}` });
  return { controllerHome, repoRoot, repository, expectedHead };
}

function freshVerification(input: {
  repoId: string;
  checkoutId: string;
  sourceRevision: string;
  workspaceFingerprint: string;
  checkIds: string[];
  checkId: string;
}): VerificationRecord {
  const recordedAt = '2026-08-28T00:00:00.000Z';
  return {
    checkId: input.checkId,
    outcome: 'valid_pass',
    summary: 'fresh exact verification',
    recordedAt,
    sourceRevision: input.sourceRevision,
    workspaceFingerprint: input.workspaceFingerprint,
    verificationInputFingerprint: verificationInputFingerprint({
      sourceRevision: input.sourceRevision,
      workspaceFingerprint: input.workspaceFingerprint,
      checkId: input.checkId,
      requestedChecks: input.checkIds,
    }),
    receipt: {
      schemaVersion: 1,
      receiptId: `receipt-${input.checkId}`,
      resultDigest: `digest-${input.checkId}`,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      checkId: input.checkId,
      processId: `process-${input.checkId}`,
      status: 'passed',
      runtimeStatus: 'succeeded',
      ok: true,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      artifactPath: `.ai/harness/checks/${input.checkId}.json`,
      summary: 'passed',
      startedAt: recordedAt,
      finishedAt: recordedAt,
    },
  };
}

function inspectFresh(
  fx: ReturnType<typeof fixture>,
  options: { checkRefs?: VerificationRecord[]; declaredCheckIds?: string[] } = {},
) {
  const status = repositoryGitStatus(fx.repository);
  const targetHead = status.head!;
  const checkId = 'package:check:main';
  const declaredCheckIds = options.declaredCheckIds ?? [checkId];
  const evidenceRequestedChecks = declaredCheckIds.length > 0 ? declaredCheckIds : [checkId];
  const workspaceFingerprint = workspaceValidationFingerprint(fx.repoRoot, status);
  return inspectDirectCanonicalTargetAdvanceReconciliation({
    root: fx.repoRoot,
    worktreePath: fx.repoRoot,
    managedWorktree: false,
    workBranch: 'main',
    targetBranch: 'main',
    expectedRevision: fx.expectedHead,
    status,
    scope: { allowedPaths: ['owned.txt'], forbiddenPaths: [] },
    checkIds: declaredCheckIds,
    checkRefs: options.checkRefs ?? [freshVerification({
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      sourceRevision: targetHead,
      workspaceFingerprint,
      checkIds: evidenceRequestedChecks,
      checkId,
    })],
  });
}

describe('direct canonical Work target advancement reconciliation', () => {
  test('reconciles only a linear target advance disjoint from preserved Work-owned dirty paths with fresh exact verification', () => {
    const fx = fixture('safe');
    writeFileSync(join(fx.repoRoot, 'owned.txt'), 'owned-work-delta\n');
    writeFileSync(join(fx.repoRoot, 'advance.txt'), 'independent target advance\n');
    git(fx.repoRoot, ['add', 'advance.txt']);
    git(fx.repoRoot, ['commit', '-m', 'advance target']);
    const advanced = git(fx.repoRoot, ['rev-parse', 'HEAD']);

    expect(inspectFresh(fx)).toMatchObject({
      reconcilable: true,
      reason: 'reconcilable',
      previousHead: fx.expectedHead,
      targetHead: advanced,
      dirtyPaths: ['owned.txt'],
      targetChangedPaths: ['advance.txt'],
      freshCheckIds: ['package:check:main'],
    });
  });

  test('fails closed instead of adopting another Work dirty path in the shared canonical checkout', () => {
    const fx = fixture('foreign-dirty');
    writeFileSync(join(fx.repoRoot, 'owned.txt'), 'owned-work-delta\n');
    writeFileSync(join(fx.repoRoot, 'advance.txt'), 'independent target advance\n');
    git(fx.repoRoot, ['add', 'advance.txt']);
    git(fx.repoRoot, ['commit', '-m', 'advance target']);
    writeFileSync(join(fx.repoRoot, 'foreign.txt'), 'another Work delta\n');

    expect(inspectFresh(fx)).toMatchObject({
      reconcilable: false,
      reason: 'unrelated_dirty_paths',
      dirtyPaths: ['foreign.txt', 'owned.txt'],
    });
  });

  test('fails closed when target advancement touched the same path as the preserved Work delta', () => {
    const fx = fixture('overlap');
    writeFileSync(join(fx.repoRoot, 'owned.txt'), 'target-owned-change\n');
    git(fx.repoRoot, ['add', 'owned.txt']);
    git(fx.repoRoot, ['commit', '-m', 'target touches owned path']);
    writeFileSync(join(fx.repoRoot, 'owned.txt'), 'work-delta-after-target\n');

    expect(inspectFresh(fx)).toMatchObject({
      reconcilable: false,
      reason: 'target_touches_work_path',
      dirtyPaths: ['owned.txt'],
      targetChangedPaths: ['owned.txt'],
    });
  });

  test('accepts an exact-current focused verification receipt even when the WorkContract declared no checks', () => {
    const fx = fixture('focused-evidence');
    writeFileSync(join(fx.repoRoot, 'owned.txt'), 'owned-work-delta\n');
    writeFileSync(join(fx.repoRoot, 'advance.txt'), 'independent target advance\n');
    git(fx.repoRoot, ['add', 'advance.txt']);
    git(fx.repoRoot, ['commit', '-m', 'advance target']);

    expect(inspectFresh(fx, { declaredCheckIds: [] })).toMatchObject({
      reconcilable: true,
      reason: 'reconcilable',
      freshCheckIds: ['package:check:main'],
    });
  });

  test('requires fresh verification for the exact advanced source and current dirty workspace', () => {
    const fx = fixture('stale-evidence');
    writeFileSync(join(fx.repoRoot, 'owned.txt'), 'owned-work-delta\n');
    writeFileSync(join(fx.repoRoot, 'advance.txt'), 'independent target advance\n');
    git(fx.repoRoot, ['add', 'advance.txt']);
    git(fx.repoRoot, ['commit', '-m', 'advance target']);

    expect(inspectFresh(fx, { checkRefs: [] })).toMatchObject({
      reconcilable: false,
      reason: 'fresh_verification_missing',
      freshCheckIds: [],
    });
  });
});
