import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyEditOperations, beginEditSession, finalizeEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { acceptReviewedDirectEditWorkReconciliation, reconcileFinalizedDirectEditWorksAfterCommit } from '../../src/runtime/control-plane/execution/direct-edit-work-completion';
import { verificationInputFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';
import { createWorkContract, getWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(requirementId?: string, checks: string[] = []) {
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
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    mode: 'direct_control',
    objective: 'Complete a standalone Direct Edit through WorkContract authority.',
    acceptanceCriteria: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    checks,
    constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    ...(requirementId ? { requirementId } : {}),
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

  test('closes historically delivered Work even when Requirement completion projection is unavailable', () => {
    const fx = fixture('REQ-direct-edit-missing-record');
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    const result = acceptReviewedDirectEditWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      workId: fx.workId,
      targetBranch: 'main',
      targetRevision,
      comparedPaths: ['src/example.ts'],
      reviewer: 'reviewer-test',
      rationale: 'The exact owned path tree is already integrated at the accepted target revision.',
      cleanupOwnershipProof: 'This current-checkout Work owns no managed branch or worktree cleanup.',
    });

    expect(result.reconciliation).toMatchObject({ method: 'owned_path_tree', outcome: 'accepted_equivalence', comparedPaths: ['src/example.ts'] });
    expect(result.receipt).toMatchObject({ source: 'direct_edit_work', reconciliationId: result.reconciliation.reconciliationId, targetRevision });
    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId);
    expect(completed).toMatchObject({ status: 'completed', completionOutcome: 'completed_changed' });
    expect(completed?.evidenceRefs.some((evidence) => evidence.title === 'requirement completion projection pending' && (evidence.summary ?? '').includes('REQUIREMENT_NOT_FOUND'))).toBe(true);
  });

  test('uses exact target-revision check evidence even when a later same-check pass exists', () => {
    const checkId = 'package:check:type';
    const checks = [checkId];
    const fx = fixture(undefined, checks);
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const targetWorkspaceFingerprint = 'workspace-at-target';

    writeFileSync(join(fx.repoRoot, 'README.md'), '# Later head\n');
    execFileSync('git', ['add', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'later unrelated head'], { cwd: fx.repoRoot });
    const newerRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const newerWorkspaceFingerprint = 'workspace-at-newer-head';

    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checkRefs: [
        {
          checkId,
          outcome: 'valid_pass',
          summary: 'later pass',
          recordedAt: '2026-08-25T00:02:00.000Z',
          sourceRevision: newerRevision,
          workspaceFingerprint: newerWorkspaceFingerprint,
          verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: newerRevision, workspaceFingerprint: newerWorkspaceFingerprint, checkId, requestedChecks: checks }),
        },
        {
          checkId,
          outcome: 'valid_pass',
          summary: 'accepted target pass',
          recordedAt: '2026-08-25T00:01:00.000Z',
          sourceRevision: targetRevision,
          workspaceFingerprint: targetWorkspaceFingerprint,
          verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: targetRevision, workspaceFingerprint: targetWorkspaceFingerprint, checkId, requestedChecks: checks }),
        },
      ],
    });

    const result = acceptReviewedDirectEditWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      workId: fx.workId,
      targetBranch: 'main',
      targetRevision,
      comparedPaths: ['src/example.ts'],
      reviewer: 'reviewer-test',
      rationale: 'Use the immutable required-check receipt bound to the accepted target revision.',
      cleanupOwnershipProof: 'No managed cleanup remains.',
    });

    expect(result.receipt).toMatchObject({ targetRevision, verifiedAt: '2026-08-25T00:01:00.000Z' });
  });

  test('rejects reviewed reconciliation when required check evidence exists only on a newer revision', () => {
    const checkId = 'package:check:type';
    const checks = [checkId];
    const fx = fixture(undefined, checks);
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    writeFileSync(join(fx.repoRoot, 'README.md'), '# Later head\n');
    execFileSync('git', ['add', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'later unrelated head'], { cwd: fx.repoRoot });
    const newerRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const newerWorkspaceFingerprint = 'workspace-at-newer-head';
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checkRefs: [{
        checkId,
        outcome: 'valid_pass',
        summary: 'later pass only',
        recordedAt: '2026-08-25T00:02:00.000Z',
        sourceRevision: newerRevision,
        workspaceFingerprint: newerWorkspaceFingerprint,
        verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: newerRevision, workspaceFingerprint: newerWorkspaceFingerprint, checkId, requestedChecks: checks }),
      }],
    });

    expect(() => acceptReviewedDirectEditWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      workId: fx.workId,
      targetBranch: 'main',
      targetRevision,
      comparedPaths: ['src/example.ts'],
      reviewer: 'reviewer-test',
      rationale: 'The accepted revision must have its own required-check receipt.',
      cleanupOwnershipProof: 'No managed cleanup remains.',
    })).toThrow(`DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_STALE: ${checkId}`);
  });

  test('rejects reviewed reconciliation unless the supplied path set is exact', () => {
    const fx = fixture();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    expect(() => acceptReviewedDirectEditWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      workId: fx.workId,
      targetBranch: 'main',
      targetRevision,
      comparedPaths: ['src/other.ts'],
      reviewer: 'reviewer-test',
      rationale: 'Invalid incomplete review set.',
      cleanupOwnershipProof: 'No managed cleanup remains.',
    })).toThrow('DIRECT_EDIT_WORK_RECONCILIATION_PATH_COMPARISON_MISMATCH');
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
