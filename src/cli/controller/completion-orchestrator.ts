import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  finalizeEditSession,
  getEditSession,
  revalidateEditSessionOwnership,
  rollbackEditSession,
  verifyEditSession,
} from '../../runtime/editing/edit-session';
import { withControllerLock } from '../../effects/controller-locks';
import { withRepositoryMutationExclusion } from '../../runtime/resources/leases/store';
import {
  acceptVerifiedTask,
  getIssue,
  projectIssueEffectiveView,
  recordTaskVerification,
  updateTask,
} from './issue-store';
import { completionEvidenceComplete } from './execution-policy';
import { currentCompletionTarget, resolveCompletionTargetBranch } from './completion-target';
import { runControllerCheck } from '../../runtime/execution/process-runtime/check-runner';
import type { ControllerIssue, ControllerTask, IntegrationEvidence, TaskVerification } from './types';
import type { CompletionMaintenanceWarning, CompletionResourceBlocker, RepositoryCompletionReceipt } from './types';
import {
  legacyIssueAuthorityRetired,
  legacyIssueCutoverState,
  migratedTaskCompletionState,
  recordMigratedTaskCompletion,
  type LegacyIssueCutoverState,
} from './legacy-issue-cutover';

export type TaskReviewDecision = 'auto' | 'approve_and_finish' | 'request_changes' | 'discard';

export interface FinishEditSessionOptions {
  sessionId: string;
  decision?: TaskReviewDecision;
  reviewer?: string;
  note?: string;
  commit?: boolean;
  checkIds?: string[];
}

export interface FinishEditSessionResult {
  action: 'finished' | 'needs_decision' | 'changes_requested' | 'discarded' | 'already_done' | 'no_change' | 'blocked';
  sessionId: string;
  issueId: string;
  taskId: string;
  decision: TaskReviewDecision;
  taskStatus: string;
  issue: ReturnType<typeof projectIssueEffectiveView>;
  changedPaths?: string[];
  reason?: string;
  commitSha?: string;
  commitError?: string;
  completionReceipt?: RepositoryCompletionReceipt;
  maintenanceWarnings?: CompletionMaintenanceWarning[];
}

function gitText(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
  return {
    ok: result.status === 0 && !result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : (result.error?.message ?? ''),
  };
}

function safeCommitChangedPaths(
  repoRoot: string,
  input: { issueId: string; taskId: string; sourceLabel: string; sourceId: string; changedPaths?: string[] },
): { commitSha?: string; reusedHead?: boolean; error?: string } {
  const paths = Array.from(new Set((input.changedPaths ?? []).filter(Boolean)));
  if (paths.length === 0) return {};
  const staged = gitText(repoRoot, ['diff', '--cached', '--name-only']);
  if (!staged.ok) return { error: staged.stderr || 'failed to inspect staged changes' };
  if (staged.stdout.trim())
    return { error: 'index already has staged changes; refusing to mix completion commit with unrelated staged work' };
  const pending = gitText(repoRoot, ['status', '--porcelain', '--', ...paths]);
  if (!pending.ok) return { error: pending.stderr || 'failed to inspect selected-path changes' };
  if (!pending.stdout.trim()) {
    const existing = gitText(repoRoot, ['rev-parse', 'HEAD']);
    return existing.ok
      ? { commitSha: existing.stdout.trim(), reusedHead: true }
      : { error: existing.stderr || 'selected paths are clean but target HEAD could not be resolved' };
  }
  const add = gitText(repoRoot, ['add', '--', ...paths]);
  if (!add.ok) return { error: add.stderr || 'failed to stage changed paths' };
  const commit = gitText(repoRoot, [
    'commit',
    '--only',
    '-m',
    `Complete ${input.issueId}/${input.taskId}`,
    '-m',
    `${input.sourceLabel}: ${input.sourceId}`,
    '--',
    ...paths,
  ]);
  if (!commit.ok) {
    gitText(repoRoot, ['reset', '--', ...paths]);
    const output = `${commit.stderr}\n${commit.stdout}`.trim();
    if (/\bnothing to commit\b/i.test(output)) return {};
    return { error: commit.stderr || commit.stdout || 'failed to create completion commit' };
  }
  const rev = gitText(repoRoot, ['rev-parse', 'HEAD']);
  return rev.ok
    ? { commitSha: rev.stdout.trim() }
    : { error: rev.stderr || 'commit created but HEAD could not be resolved' };
}

function latestDirectEditOperations(session: ReturnType<typeof getEditSession>) {
  const latest = new Map<string, (typeof session.operations)[number]>();
  for (const operation of session.operations) latest.set(operation.path, operation);
  return latest;
}

function directEditRevisionMismatches(
  repoRoot: string,
  revision: string,
  session: ReturnType<typeof getEditSession>,
): string[] {
  const mismatches: string[] = [];
  for (const operation of latestDirectEditOperations(session).values()) {
    const object = `${revision}:${operation.path}`;
    if (operation.type === 'delete') {
      if (gitText(repoRoot, ['cat-file', '-e', object]).ok) mismatches.push(operation.path);
      continue;
    }
    const content = gitText(repoRoot, ['show', object]);
    if (
      !content.ok ||
      !operation.afterSha256 ||
      createHash('sha256').update(content.stdout).digest('hex') !== operation.afterSha256
    ) {
      mismatches.push(operation.path);
    }
  }
  return mismatches;
}

function nowIso(): string {
  return new Date().toISOString();
}

function taskForRun(issue: ControllerIssue, taskId: string): ControllerTask {
  const task = issue.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`task not found: ${issue.id}/${taskId}`);
  return task;
}

function canAutoFinish(task: ControllerTask): boolean {
  return task.acceptanceCriteria.length === 0;
}

function editResult(repoRoot: string, input: Omit<FinishEditSessionResult, 'issue'>): FinishEditSessionResult {
  const issue = projectIssueEffectiveView(repoRoot, getIssue(repoRoot, input.issueId));
  return { ...input, issue };
}

function directEditCheckIds(
  task: ControllerTask,
  session: ReturnType<typeof getEditSession>,
  override: readonly string[] | undefined,
): string[] {
  return Array.from(
    new Set(
      [...task.checks, ...session.requestedChecks, ...(override ?? [])].map((entry) => entry.trim()).filter(Boolean),
    ),
  );
}

function directEditChangedPaths(session: ReturnType<typeof getEditSession>): string[] {
  return Array.from(new Set(session.operations.map((operation) => operation.path).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right),
  );
}

function directEditAcceptanceResults(
  task: ControllerTask,
  decision: TaskReviewDecision,
  reviewer: string,
): TaskVerification['acceptanceResults'] {
  if (task.acceptanceCriteria.length === 0) return [];
  const accepted = decision === 'approve_and_finish';
  return task.acceptanceCriteria.map((criterion) => ({
    criterion,
    ok: accepted,
    outcome: accepted ? ('passed' as const) : ('not_evaluated' as const),
    source: accepted ? ('human_review' as const) : ('reported' as const),
    evidence: accepted
      ? `Explicitly accepted by ${reviewer} for direct edit completion.`
      : 'Direct edit checks passed; acceptance was not independently evaluated.',
  }));
}

function finishEditSessionUnlocked(repoRoot: string, options: FinishEditSessionOptions): FinishEditSessionResult {
  const decision = options.decision ?? 'auto';
  const reviewer =
    options.reviewer?.trim() || (decision === 'auto' ? 'forge-direct-edit-completion' : 'controller-review');
  const shouldCommit = options.commit !== false;
  const initialSession = getEditSession(repoRoot, options.sessionId);
  if (!initialSession.issueId || !initialSession.taskId) {
    throw new Error('Direct Edit completion requires a session bound to an Issue and Task.');
  }

  const issue = getIssue(repoRoot, initialSession.issueId);
  const task = taskForRun(issue, initialSession.taskId);
  const migratedCompletion = migratedTaskCompletionState(repoRoot, issue.id, task.id);
  if (migratedCompletion.migrated && migratedCompletion.completed) {
    return editResult(repoRoot, {
      action: 'already_done',
      sessionId: initialSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: 'done',
    });
  }
  if (task.status === 'done') {
    if (
      !completionEvidenceComplete(task.verification, {
        targetBranch: resolveCompletionTargetBranch(repoRoot),
      })
    ) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: initialSession.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        reason: 'Task is declared done without a complete delivery receipt; run reconciliation before accepting it.',
      });
    }
    return editResult(repoRoot, {
      action: 'already_done',
      sessionId: initialSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
    });
  }

  if (decision === 'request_changes') {
    const updated = updateTask(repoRoot, issue.id, task.id, {
      status: 'changes_requested',
      note: options.note ?? `Changes requested for direct edit ${initialSession.sessionId}.`,
    });
    return editResult(repoRoot, {
      action: 'changes_requested',
      sessionId: initialSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: taskForRun(updated, task.id).status,
    });
  }

  if (decision === 'discard') {
    let discardSession = revalidateEditSessionOwnership(repoRoot, initialSession.sessionId, {
      reviewer,
      note: options.note ?? `Validated direct edit before discard for ${issue.id}/${task.id}.`,
    });
    const discardPaths = directEditChangedPaths(discardSession);
    if (discardSession.status === 'superseded') {
      const updated = updateTask(repoRoot, issue.id, task.id, {
        status: 'integration_blocked',
        note: `Cannot discard superseded direct edit ${discardSession.sessionId}; newer changes are preserved.`,
      });
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: discardSession.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: taskForRun(updated, task.id).status,
        changedPaths: discardPaths,
        reason: 'Direct Edit was superseded and cannot be safely rolled back.',
      });
    }
    if (discardPaths.length > 0) {
      const stagedOwned = gitText(repoRoot, ['diff', '--cached', '--name-only', '--', ...discardPaths]);
      if (!stagedOwned.ok || stagedOwned.stdout.trim()) {
        return editResult(repoRoot, {
          action: 'blocked',
          sessionId: discardSession.sessionId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: task.status,
          changedPaths: discardPaths,
          reason: stagedOwned.ok
            ? `Direct Edit discard requires owned paths to be unstaged first: ${stagedOwned.stdout.trim().split('\n').join(', ')}`
            : stagedOwned.stderr || 'Unable to inspect staged Direct Edit paths before discard.',
        });
      }
    }
    if (discardSession.status === 'finalized') {
      const dirtyPaths = new Set(workspaceChangesForPaths(repoRoot, discardPaths));
      const cleanOwnedPaths = discardPaths.filter((path) => !dirtyPaths.has(path));
      if (cleanOwnedPaths.length > 0) {
        return editResult(repoRoot, {
          action: 'blocked',
          sessionId: discardSession.sessionId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: task.status,
          changedPaths: discardPaths,
          reason: `Finalized Direct Edit has clean or integrated owned paths and requires an explicit revert: ${cleanOwnedPaths.join(', ')}`,
        });
      }
      discardSession = rollbackEditSession(repoRoot, discardSession.sessionId, { allowFinalized: true });
    } else if (discardSession.status !== 'rolled_back') {
      discardSession = rollbackEditSession(repoRoot, discardSession.sessionId);
    }
    const retained = ownedWorkspaceChanges(repoRoot, discardPaths, discardSession.allowedPaths);
    if (discardSession.status !== 'rolled_back' || retained.length > 0) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: discardSession.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        changedPaths: discardPaths,
        reason:
          retained.length > 0
            ? `Direct Edit discard retained owned changes: ${retained.join(', ')}`
            : `Direct Edit discard did not close the session (current: ${discardSession.status}).`,
      });
    }
    const updated = updateTask(repoRoot, issue.id, task.id, {
      status: 'cancelled',
      note: options.note ?? `Discarded and rolled back direct edit ${initialSession.sessionId}.`,
    });
    return editResult(repoRoot, {
      action: 'discarded',
      sessionId: discardSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: taskForRun(updated, task.id).status,
      changedPaths: discardPaths,
      reason: 'Direct edit was rolled back and discarded.',
    });
  }

  const completionTarget = currentCompletionTarget(repoRoot);
  if (!completionTarget.onTargetBranch) {
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: initialSession.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: `Direct Edit completion must run on integration target ${completionTarget.expectedBranch}; current branch is ${completionTarget.branch}.`,
    });
  }

  const checkIds = directEditCheckIds(task, initialSession, options.checkIds);
  let session = revalidateEditSessionOwnership(repoRoot, initialSession.sessionId, {
    reviewer,
    note: options.note ?? `Revalidated direct edit ownership before Task completion for ${issue.id}/${task.id}.`,
  });
  let standaloneCheckResults: TaskVerification['checkResults'] = [];
  if (!['finalized', 'superseded', 'rolled_back'].includes(session.status)) {
    const emptyOpenSession = session.status === 'open' && session.operations.length === 0;
    if (emptyOpenSession) {
      standaloneCheckResults = checkIds.map((checkId) => {
        try {
          const result = runControllerCheck(repoRoot, checkId);
          return {
            checkId,
            ok: result.ok,
            summary: result.ok
              ? `Passed with persisted evidence: ${result.artifactPath}`
              : `Failed with persisted evidence: ${result.artifactPath}; ${(result.stderr || result.stdout).slice(0, 500)}`,
          };
        } catch (error) {
          return { checkId, ok: false, summary: error instanceof Error ? error.message : String(error) };
        }
      });
      if (standaloneCheckResults.some((result) => !result.ok)) {
        const failedVerification: TaskVerification = {
          reviewer,
          checkResults: standaloneCheckResults,
          commandEvidence: [
            {
              command: ['forge', 'controller', 'finish-edit', session.sessionId],
              cwd: repoRoot,
              ok: false,
              reportedBy: reviewer,
              executedAt: nowIso(),
              source: 'controller',
            },
          ],
          acceptanceResults: directEditAcceptanceResults(task, decision, reviewer),
          reviewedDiffHash: session.diffSha256,
          verifiedAt: nowIso(),
        };
        const updated = recordTaskVerification(repoRoot, issue.id, task.id, failedVerification);
        return editResult(repoRoot, {
          action: 'changes_requested',
          sessionId: session.sessionId,
          issueId: issue.id,
          taskId: task.id,
          decision,
          taskStatus: taskForRun(updated, task.id).status,
          changedPaths: [],
          reason: 'Direct Edit checks failed.',
        });
      }
    } else {
      const missingPassedCheck = checkIds.some(
        (checkId) => !session.checkResults.some((result) => result.checkId === checkId && result.ok),
      );
      if (session.status !== 'checked' || missingPassedCheck) {
        try {
          session = verifyEditSession(repoRoot, session.sessionId, {
            checkIds,
            reviewer,
            note: options.note,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('edited file changed outside the session')) throw error;
          session = finalizeEditSession(repoRoot, session.sessionId, {
            reviewer,
            note: options.note ?? `Closed superseded direct edit before Task completion for ${issue.id}/${task.id}.`,
          });
        }
        if (session.checkResults.some((result) => !result.ok)) {
          const failedVerification: TaskVerification = {
            reviewer,
            checkResults: session.checkResults.map((result) => ({
              checkId: result.checkId,
              ok: result.ok,
              summary: result.summary,
            })),
            commandEvidence: [
              {
                command: ['forge', 'controller', 'finish-edit', session.sessionId],
                cwd: repoRoot,
                ok: false,
                reportedBy: reviewer,
                executedAt: nowIso(),
                source: 'controller',
              },
            ],
            acceptanceResults: directEditAcceptanceResults(task, decision, reviewer),
            reviewedDiffHash: session.diffSha256,
            verifiedAt: nowIso(),
          };
          const updated = recordTaskVerification(repoRoot, issue.id, task.id, failedVerification);
          return editResult(repoRoot, {
            action: 'changes_requested',
            sessionId: session.sessionId,
            issueId: issue.id,
            taskId: task.id,
            decision,
            taskStatus: taskForRun(updated, task.id).status,
            changedPaths: directEditChangedPaths(session),
            reason: 'Direct Edit checks failed.',
          });
        }
      }
    }
    if (session.status !== 'superseded') {
      session = finalizeEditSession(repoRoot, session.sessionId, {
        reviewer,
        note: options.note ?? `Finalized direct edit before Task completion for ${issue.id}/${task.id}.`,
      });
    }
  }

  if (session.status === 'rolled_back') {
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: 'Direct Edit session was rolled back and has no deliverable change.',
    });
  }
  if (session.status === 'superseded') {
    updateTask(repoRoot, issue.id, task.id, {
      status: 'integration_blocked',
      note: `Direct Edit session ${session.sessionId} was superseded by newer workspace changes in ${(session.supersededPaths ?? []).join(', ') || 'owned paths'}.`,
    });
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: 'integration_blocked',
      changedPaths: directEditChangedPaths(session),
      reason: 'Direct Edit session was superseded before completion.',
    });
  }
  if (session.status !== 'finalized') {
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      reason: `Direct Edit session is not finalized (current: ${session.status}).`,
    });
  }

  const changedPaths = directEditChangedPaths(session);
  let commitSha: string | undefined;
  let commitError: string | undefined;
  let reusedHead = false;
  if (changedPaths.length > 0) {
    if (!shouldCommit) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: session.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        changedPaths,
        reason: 'Direct Edit changed paths require a target-branch commit before Task completion.',
      });
    }
    const committed = safeCommitChangedPaths(repoRoot, {
      issueId: issue.id,
      taskId: task.id,
      sourceLabel: 'Direct Edit',
      sourceId: session.sessionId,
      changedPaths,
    });
    commitSha = committed.commitSha;
    reusedHead = committed.reusedHead === true;
    commitError = committed.error;
    if (commitError || !commitSha) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: session.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        changedPaths,
        commitError: commitError ?? 'direct edit changes did not produce a target-branch commit',
        reason: commitError ?? 'direct edit changes did not produce a target-branch commit',
      });
    }
  }

  const after = currentCompletionTarget(repoRoot);
  if (!after.onTargetBranch) {
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: task.status,
      changedPaths,
      commitSha,
      reason: `Integration target changed during completion; expected ${after.expectedBranch}, current ${after.branch}.`,
    });
  }
  const targetRevision = commitSha ?? after.revision;
  const revisionMismatches = directEditRevisionMismatches(repoRoot, targetRevision, session);
  if (revisionMismatches.length > 0) {
    const reason = `Target revision ${targetRevision} does not contain finalized Direct Edit content for: ${revisionMismatches.join(', ')}`;
    updateTask(repoRoot, issue.id, task.id, { status: 'integration_blocked', note: reason });
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: 'integration_blocked',
      changedPaths,
      commitSha,
      reason,
    });
  }
  const integrationEvidence = {
    kind: commitSha ? ('commit' as const) : ('no_change' as const),
    targetBranch: after.branch,
    targetRevision,
    sourceRevision: targetRevision,
    baseRevision: session.baseRevision,
    strategy:
      commitSha && !reusedHead
        ? ('edit_session_commit' as const)
        : changedPaths.length === 0
          ? ('no_change' as const)
          : ('already_integrated' as const),
    editSessionId: session.sessionId,
    reachable: revisionReachable(repoRoot, targetRevision, after.branch),
    recordedAt: nowIso(),
  };
  const dirtyOwnedPaths = ownedWorkspaceChanges(repoRoot, changedPaths, session.allowedPaths);
  const cleanupBlockers =
    dirtyOwnedPaths.length > 0
      ? [
          blocker(
            'dirty_owned_paths',
            `Direct Edit owned paths still have uncommitted changes: ${dirtyOwnedPaths.join(', ')}`,
            'workspace',
          ),
        ]
      : [];
  const completionReceipt = buildDirectEditCompletionReceipt({
    editSessionId: session.sessionId,
    integrationEvidence,
    changedPaths,
    cleanupBlockers,
  });
  if (completionReceipt.cleanup.status === 'blocked') {
    updateTask(repoRoot, issue.id, task.id, {
      status: 'cleanup_blocked',
      note: completionReceipt.cleanup.blockers.map((entry) => entry.message).join(' '),
    });
    return editResult(repoRoot, {
      action: 'blocked',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: 'cleanup_blocked',
      changedPaths,
      completionReceipt,
      reason: completionReceipt.cleanup.blockers.map((entry) => entry.message).join(' '),
      commitSha,
    });
  }

  if (legacyIssueAuthorityRetired(repoRoot)) {
    const migrated = recordMigratedTaskCompletion(repoRoot, {
      issueId: issue.id,
      taskId: task.id,
      receipt: completionReceipt,
      reviewer,
      note: options.note,
      checks: (session.checkResults.length > 0 ? session.checkResults : standaloneCheckResults).map((result) => ({
        checkId: result.checkId,
        ok: result.ok,
        summary: result.summary,
      })),
    });
    if (!migrated.migrated || !migrated.completed) {
      return editResult(repoRoot, {
        action: 'blocked',
        sessionId: session.sessionId,
        issueId: issue.id,
        taskId: task.id,
        decision,
        taskStatus: task.status,
        changedPaths,
        completionReceipt,
        commitSha,
        reason: `Migrated PlanStep completion was not recorded for ${issue.id}/${task.id}.`,
      });
    }
    return editResult(repoRoot, {
      action: changedPaths.length === 0 ? 'no_change' : 'finished',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: 'done',
      changedPaths,
      commitSha,
      completionReceipt,
    });
  }

  const verification: TaskVerification = {
    reviewer,
    checkResults: (session.checkResults.length > 0 ? session.checkResults : standaloneCheckResults).map((result) => ({
      checkId: result.checkId,
      ok: result.ok,
      summary: result.summary,
    })),
    commandEvidence: [
      {
        command: ['forge', 'controller', 'finish-edit', session.sessionId],
        cwd: repoRoot,
        ok: true,
        reportedBy: reviewer,
        executedAt: nowIso(),
        source: 'controller',
      },
    ],
    acceptanceResults: directEditAcceptanceResults(task, decision, reviewer),
    reviewedDiffHash: session.diffSha256,
    integratedRevision: targetRevision,
    completionReceipt,
    verifiedAt: nowIso(),
  };
  const verified = recordTaskVerification(repoRoot, issue.id, task.id, verification);
  const verifiedTask = taskForRun(verified, task.id);
  if (verifiedTask.status === 'changes_requested') {
    return editResult(repoRoot, {
      action: 'changes_requested',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: verifiedTask.status,
      changedPaths,
      completionReceipt,
      commitSha,
    });
  }
  if (verifiedTask.status !== 'verified') {
    return editResult(repoRoot, {
      action: 'needs_decision',
      sessionId: session.sessionId,
      issueId: issue.id,
      taskId: task.id,
      decision,
      taskStatus: verifiedTask.status,
      changedPaths,
      completionReceipt,
      commitSha,
      reason: 'Direct Edit verification is incomplete.',
    });
  }
  const accepted =
    decision === 'approve_and_finish' || canAutoFinish(verifiedTask)
      ? acceptVerifiedTask(
          repoRoot,
          issue.id,
          task.id,
          options.note ?? `Accepted direct edit receipt ${completionReceipt.receiptId}.`,
        )
      : verified;
  const finalStatus = taskForRun(accepted, task.id).status;
  return editResult(repoRoot, {
    action: finalStatus === 'done' ? (changedPaths.length === 0 ? 'no_change' : 'finished') : 'needs_decision',
    sessionId: session.sessionId,
    issueId: issue.id,
    taskId: task.id,
    decision,
    taskStatus: finalStatus,
    changedPaths,
    commitSha,
    completionReceipt,
  });
}

function revisionReachable(repoRoot: string, revision: string, branch: string): boolean {
  return gitText(repoRoot, ['merge-base', '--is-ancestor', revision, branch]).ok;
}

function scopedWorkspaceChanges(repoRoot: string, allowedPaths: string[]): string[] {
  const status = gitText(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) return [];
  const prefixes = allowedPaths.map((path) =>
    path
      .replace(/\\/g, '/')
      .split(/[?*{\[]/, 1)[0]
      .replace(/\/+$/, ''),
  );
  return Array.from(
    new Set(
      status.stdout.split('\n').flatMap((line) => {
        const path = line.length >= 4 ? line.slice(3).trim().replace(/^"|"$/g, '') : '';
        if (!path || !prefixes.some((prefix) => prefix && (path === prefix || path.startsWith(`${prefix}/`))))
          return [];
        return [path];
      }),
    ),
  );
}

function workspaceChangesForPaths(repoRoot: string, paths: readonly string[]): string[] {
  const selected = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
  if (selected.length === 0) return [];
  const status = gitText(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...selected]);
  if (!status.ok) return [];
  return Array.from(
    new Set(
      status.stdout.split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        const raw = line.length >= 4 ? line.slice(3).trim().replace(/^"|"$/g, '') : '';
        if (!raw) return [];
        const renamed = raw.includes(' -> ') ? raw.split(' -> ').at(-1)?.trim() : raw;
        return renamed ? [renamed] : [];
      }),
    ),
  );
}

function ownedWorkspaceChanges(
  repoRoot: string,
  ownedPaths: readonly string[],
  fallbackAllowedPaths: readonly string[] = [],
): string[] {
  if (ownedPaths.length > 0) return workspaceChangesForPaths(repoRoot, ownedPaths);
  return scopedWorkspaceChanges(repoRoot, [...fallbackAllowedPaths]);
}

function directEditReceiptId(ownerId: string, targetRevision: string): string {
  const digest = createHash('sha256')
    .update(['direct_edit', ownerId, targetRevision].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return 'REC-direct_edit-' + digest;
}

function cleanupStatus(
  warnings: readonly CompletionMaintenanceWarning[],
  blockers: readonly CompletionResourceBlocker[],
): RepositoryCompletionReceipt['cleanup']['status'] {
  if (blockers.length > 0) return 'blocked';
  return warnings.length > 0 ? 'maintenance_warning' : 'complete';
}

function blocker(
  code: CompletionResourceBlocker['code'],
  message: string,
  resourceKind?: CompletionResourceBlocker['resourceKind'],
  resourceId?: string,
  at = nowIso(),
): CompletionResourceBlocker {
  return { code, message, resourceKind, resourceId, recordedAt: at };
}

function buildDirectEditCompletionReceipt(input: {
  editSessionId: string;
  integrationEvidence: Omit<IntegrationEvidence, 'runId'>;
  changedPaths: readonly string[];
  cleanupWarnings?: CompletionMaintenanceWarning[];
  cleanupBlockers?: CompletionResourceBlocker[];
  verifiedAt?: string;
}): RepositoryCompletionReceipt {
  const warnings = [...(input.cleanupWarnings ?? [])];
  const blockers = [
    ...(input.cleanupBlockers ?? []),
    ...(input.integrationEvidence.reachable
      ? []
      : [
          blocker(
            'target_revision_unreachable',
            'Target revision ' +
              input.integrationEvidence.targetRevision +
              ' is not reachable from ' +
              input.integrationEvidence.targetBranch +
              '.',
            'workspace',
          ),
        ]),
  ];
  const recordedAt = nowIso();
  return {
    schemaVersion: 1,
    receiptId: directEditReceiptId(input.editSessionId, input.integrationEvidence.targetRevision),
    editSessionId: input.editSessionId,
    targetBranch: input.integrationEvidence.targetBranch,
    targetRevision: input.integrationEvidence.targetRevision,
    sourceRevision: input.integrationEvidence.sourceRevision,
    baseRevision: input.integrationEvidence.baseRevision,
    changedPaths: Array.from(new Set(input.changedPaths)).sort((left, right) => left.localeCompare(right)),
    delivery: {
      status: blockers.some((entry) => entry.code === 'target_revision_unreachable') ? 'blocked' : 'integrated',
      reachable: input.integrationEvidence.reachable,
    },
    cleanup: {
      status: cleanupStatus(warnings, blockers),
      warnings,
      blockers,
    },
    verifiedAt: input.verifiedAt ?? recordedAt,
    recordedAt,
  };
}

// repository lock serializes its physical writes with MCP and Local Bridge
// Safe Patch. Lock ordering is always integration -> repository, once for the
// entire transaction (never in the nested edit primitives).
function withLegacyCompletionWrite<T>(
  repoRoot: string,
  cutover: LegacyIssueCutoverState,
  identity: string,
  operation: () => T,
): T {
  if (!cutover.repoId)
    throw new Error('COMPLETION_REPOSITORY_IDENTITY_REQUIRED: cannot prove the shared repository lock key');
  const targetBranch = resolveCompletionTargetBranch(repoRoot);
  const resource = `integration-${createHash('sha256').update(`${repoRoot}\0${targetBranch}`).digest('hex').slice(0, 24)}`;
  return withControllerLock(
    cutover.controllerHome,
    { scope: 'global', resource },
    `completion:${identity}`,
    () =>
      withRepositoryMutationExclusion(
        cutover.controllerHome,
        cutover.repoId!,
        `completion:${identity}`,
        operation,
        undefined,
        cutover.checkoutId
          ? [
              { resourceKey: `git-index:${cutover.checkoutId}`, mode: 'write' as const },
              { resourceKey: `git-refs:${cutover.repoId}`, mode: 'write' as const },
            ]
          : undefined,
      ),
    30 * 60_000,
  );
}

export function finishEditSession(repoRoot: string, options: FinishEditSessionOptions): FinishEditSessionResult {
  const cutover = legacyIssueCutoverState(repoRoot);
  if (cutover.retired) {
    throw new Error(
      'LEGACY_EDIT_SESSION_COMPLETION_RETIRED: Direct Edit Issue/Task completion aliases cannot mutate PlanStep state after SQLite cutover; use authoritative Work completion.',
    );
  }
  return withLegacyCompletionWrite(repoRoot, cutover, options.sessionId, () =>
    finishEditSessionUnlocked(repoRoot, options),
  );
}
