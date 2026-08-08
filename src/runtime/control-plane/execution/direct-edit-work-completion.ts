import { createHash } from 'crypto';
import { getEditSession, listEditSessions, type EditSession } from '../../../cli/editing/edit-session';
import { runProcess } from '../../../effects/process-runner';
import { getWorkContract, recordWorkCompletionReceipt } from '../facade/work-contract-store';
import { isTerminalWorkContractStatus, type DirectEditWorkCompletionReceipt } from '../facade/types';

export interface DirectEditWorkCompletionReconciliation {
  completedWorkIds: string[];
  examinedSessionIds: string[];
  skipped: Array<{ sessionId: string; workId?: string; reason: string }>;
  targetBranch?: string;
  targetRevision?: string;
}

function git(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcess('git', args, { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 4 * 1024 * 1024 });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.error || '' };
}

function changedPaths(session: EditSession): string[] {
  return Array.from(new Set(session.operations.map((operation) => operation.path).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function latestOperations(session: EditSession): Map<string, EditSession['operations'][number]> {
  const latest = new Map<string, EditSession['operations'][number]>();
  for (const operation of session.operations) latest.set(operation.path, operation);
  return latest;
}

function revisionMismatches(repoRoot: string, revision: string, session: EditSession): string[] {
  const mismatches: string[] = [];
  for (const operation of latestOperations(session).values()) {
    const object = `${revision}:${operation.path}`;
    if (operation.type === 'delete') {
      if (git(repoRoot, ['cat-file', '-e', object]).ok) mismatches.push(operation.path);
      continue;
    }
    const content = git(repoRoot, ['show', object]);
    if (!content.ok || !operation.afterSha256 || createHash('sha256').update(content.stdout).digest('hex') !== operation.afterSha256) {
      mismatches.push(operation.path);
    }
  }
  return mismatches;
}

function requestedChecksPassed(session: EditSession): boolean {
  return session.requestedChecks.every((checkId) => session.checkResults.some((result) => result.checkId === checkId && result.ok));
}

export function reconcileFinalizedDirectEditWorksAfterCommit(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  committedPaths: string[];
  fallbackBranch?: string;
  limit?: number;
}): DirectEditWorkCompletionReconciliation {
  const committedPathSet = new Set(input.committedPaths);
  const targetRevisionResult = git(input.repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!targetRevisionResult.ok) {
    return { completedWorkIds: [], examinedSessionIds: [], skipped: [], targetRevision: undefined, targetBranch: undefined };
  }
  const targetRevision = targetRevisionResult.stdout.trim();
  const branchResult = git(input.repoRoot, ['branch', '--show-current']);
  const targetBranch = branchResult.ok && branchResult.stdout.trim()
    ? branchResult.stdout.trim()
    : input.fallbackBranch?.trim();
  if (!targetBranch) {
    return { completedWorkIds: [], examinedSessionIds: [], skipped: [], targetRevision, targetBranch: undefined };
  }
  const reachable = git(input.repoRoot, ['merge-base', '--is-ancestor', targetRevision, targetBranch]).ok;
  if (!reachable) {
    return { completedWorkIds: [], examinedSessionIds: [], skipped: [], targetRevision, targetBranch };
  }

  const completedWorkIds: string[] = [];
  const examinedSessionIds: string[] = [];
  const skipped: DirectEditWorkCompletionReconciliation['skipped'] = [];
  const summaries = listEditSessions(input.repoRoot, input.limit ?? 200);
  for (const summary of summaries) {
    const session = getEditSession(input.repoRoot, summary.sessionId);
    if (session.status !== 'finalized' || !session.workId) continue;
    if (session.repoId && session.repoId !== input.repoId) continue;
    if (session.checkoutId && session.checkoutId !== input.checkoutId) continue;
    const paths = changedPaths(session);
    if (paths.length === 0 || !paths.every((path) => committedPathSet.has(path))) continue;
    examinedSessionIds.push(session.sessionId);

    const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, session.workId);
    if (!work) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: 'work_not_found' });
      continue;
    }
    if (isTerminalWorkContractStatus(work.status)) continue;
    if (!requestedChecksPassed(session)) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: 'configured_checks_not_passed' });
      continue;
    }
    const status = git(input.repoRoot, ['status', '--porcelain=v1', '--', ...paths]);
    if (!status.ok || status.stdout.trim()) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: 'owned_paths_not_clean' });
      continue;
    }
    const mismatches = revisionMismatches(input.repoRoot, targetRevision, session);
    if (mismatches.length > 0) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: `revision_mismatch:${mismatches.join(',')}` });
      continue;
    }

    const recordedAt = new Date().toISOString();
    const receipt: DirectEditWorkCompletionReceipt = {
      schemaVersion: 1,
      receiptId: `REC-direct-edit-work-${createHash('sha256').update(`${input.repoId}\0${session.workId}\0${session.sessionId}\0${targetRevision}`).digest('hex').slice(0, 20)}`,
      source: 'direct_edit_work',
      workId: session.workId,
      editSessionId: session.sessionId,
      targetBranch,
      targetRevision,
      sourceRevision: targetRevision,
      baseRevision: session.baseRevision,
      changedPaths: paths,
      delivery: {
        kind: 'commit',
        status: 'integrated',
        strategy: 'edit_session_commit',
        reachable: true,
        recordedAt,
      },
      cleanup: {
        status: 'complete',
        warnings: [],
        blockers: [],
        recordedAt,
      },
      verifiedAt: session.verifiedAt ?? session.finalizedAt ?? recordedAt,
      recordedAt,
    };
    recordWorkCompletionReceipt(
      { controllerHome: input.controllerHome, repoId: input.repoId },
      session.workId,
      receipt,
      'completed_changed',
      'repository_change',
    );
    completedWorkIds.push(session.workId);
  }

  return { completedWorkIds, examinedSessionIds, skipped, targetBranch, targetRevision };
}
