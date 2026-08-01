import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createIssue, getIssue, updateTask } from '../../src/cli/controller/issue-store';
import { createWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { acceptVerifiedTaskFromControllerWork } from '../../src/runtime/control-plane/execution/work-task-receipt';
import { verificationInputFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-work-receipt-'));
  roots.push(repoRoot);
  git(repoRoot, ['init', '-b', 'main']);
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"work-receipt-fixture"}\n');
  git(repoRoot, ['add', 'package.json']);
  git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'base']);
  const baseCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFileSync(join(repoRoot, 'feature.txt'), 'implemented\n');
  git(repoRoot, ['add', 'feature.txt']);
  git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'implementation']);
  const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']);
  const controllerHome = join(repoRoot, '.controller-home');
  const repoId = 'repo-work-receipt';
  const workId = 'work_completed_fixture';
  const issue = createIssue(repoRoot, {
    title: 'Controller Work receipt',
    tasks: [{ title: 'Implement change', objective: 'Change one tracked file.', allowedPaths: ['feature.txt'], risk: 'medium' }],
    allowDuplicate: true,
  });
  const verifiedAt = new Date().toISOString();
  updateTask(repoRoot, issue.id, 'T1', {
    status: 'verified',
    verification: {
      integratedRevision: expectedHead,
      checkResults: [],
      commandEvidence: [{ command: ['test', '-f', 'feature.txt'], ok: true, exitCode: 0, executedAt: verifiedAt, source: 'reported' }],
      acceptanceResults: [],
      reviewer: 'test',
      verifiedAt,
    },
  });
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    mode: 'goal_workloop',
    objective: 'Implement the verified Task.',
    acceptanceCriteria: [],
    constraints: { requireHandoffOnAmbiguity: true },
    allowedPaths: ['feature.txt'],
    forbiddenPaths: [],
    checks: [],
    requestedBy: 'chatgpt',
    status: 'completed',
  });
  const handle: WorkHandleState = {
    schemaVersion: 1,
    workId,
    sessionId: 'session-test',
    principalId: 'principal-test',
    repositoryId: repoId,
    checkoutId: 'checkout-work',
    worktreePath: join(repoRoot, 'removed-worktree'),
    branch: 'feature/work-receipt',
    sourceCheckoutId: 'checkout-main',
    managedWorktree: true,
    workContractId: workId,
    baseCommit,
    expectedHead,
    permissionSnapshotVersion: 1,
    state: 'cleaned',
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
    finalization: {
      validation: 'done',
      commit: 'done',
      merge: 'done',
      branchCleanup: 'done',
      worktreeCleanup: 'done',
    },
  };
  writeWorkHandle(controllerHome, handle);
  return { repoRoot, controllerHome, repoId, workId, issueId: issue.id, baseCommit, expectedHead, handle };
}

describe('controller Work Task completion receipt', () => {
  test('binds a completed cleaned Work to the exact verified Task and accepts it', () => {
    const fx = fixture();
    const result = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    });
    const task = result.issue.tasks.find((entry) => entry.id === 'T1')!;
    expect(task.status).toBe('done');
    expect(result.receipt).toMatchObject({
      source: 'controller_work',
      workId: fx.workId,
      issueId: fx.issueId,
      taskId: 'T1',
      targetBranch: 'main',
      targetRevision: fx.expectedHead,
      baseRevision: fx.baseCommit,
      changedPaths: ['feature.txt'],
      delivery: { status: 'integrated', reachable: true },
      cleanup: { status: 'complete' },
    });
    const retried = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    });
    expect(retried.receipt.receiptId).toBe(result.receipt.receiptId);
  });

  test('fails closed on revision mismatch without changing Task status', () => {
    const fx = fixture();
    updateTask(fx.repoRoot, fx.issueId, 'T1', {
      verification: {
        ...getIssue(fx.repoRoot, fx.issueId).tasks[0]!.verification!,
        integratedRevision: fx.baseCommit,
      },
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    })).toThrow(/REVISION_MISMATCH/);
    expect(getIssue(fx.repoRoot, fx.issueId).tasks[0]!.status).toBe('verified');
  });

  test('fails closed when cleanup evidence is incomplete', () => {
    const fx = fixture();
    writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      state: 'merged',
      finalization: { ...fx.handle.finalization, worktreeCleanup: 'pending' },
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    })).toThrow(/FINALIZATION_INCOMPLETE/);
    expect(getIssue(fx.repoRoot, fx.issueId).tasks[0]!.status).toBe('verified');
  });

  test('rejects a required check whose exact revision is stale', () => {
    const fx = fixture();
    const checkId = 'package:test';
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks: [checkId],
      checkRefs: [{
        checkId,
        outcome: 'valid_pass',
        summary: 'passed on the base revision',
        recordedAt: new Date().toISOString(),
        sourceRevision: fx.baseCommit,
        verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: fx.baseCommit, checkId, requestedChecks: [checkId] }),
      }],
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    })).toThrow(/CHECK_EVIDENCE_STALE/);
    expect(getIssue(fx.repoRoot, fx.issueId).tasks[0]!.status).toBe('verified');
  });
});
