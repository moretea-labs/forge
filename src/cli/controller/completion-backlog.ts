import { getAgentJob } from '../agent-jobs/job-manager';
import type { AgentJobMeta } from '../agent-jobs/types';
import { listIssues, projectIssueEffectiveView } from './issue-store';
import { completionEvidenceComplete, taskExecutionPolicy } from './execution-policy';
import type { ControllerIssue, ControllerTask, TaskStatus } from './types';
import { resolveCompletionTargetBranch } from './completion-target';
import { legacyIssueAuthorityRetired } from './legacy-issue-cutover';

export type CompletionBacklogAction =
  | 'auto_finish'
  | 'needs_human_review'
  | 'retry_required'
  | 'system_blocked'
  | 'already_terminal'
  | 'no_run_evidence';

export interface CompletionBacklogItem {
  issueId: string;
  taskId: string;
  title: string;
  taskStatus: TaskStatus;
  effectiveStatus?: string;
  verificationStatus?: string;
  runId?: string;
  runStatus?: AgentJobMeta['status'];
  executionClass: ReturnType<typeof taskExecutionPolicy>['executionClass'];
  action: CompletionBacklogAction;
  reason: string;
  canAutoFinish: boolean;
  suggestedDecision: 'auto' | 'approve_and_finish' | 'request_changes' | 'retry' | 'inspect';
}

export interface CompletionBacklogReport {
  scannedAt: string;
  counts: Record<CompletionBacklogAction, number>;
  finishableRunIds: string[];
  needsHumanReviewRunIds: string[];
  retryTaskRefs: Array<{ issueId: string; taskId: string; runId?: string }>;
  items: CompletionBacklogItem[];
  recommendations: string[];
}

const ACTIVE_REVIEW_STATUSES = new Set<TaskStatus>([
  'running',
  'blocked',
  'review',
  'verifying',
  'ready_to_integrate',
  'integrating',
  'integration_blocked',
  'integrated',
  'cleanup_pending',
  'cleanup_blocked',
  'verified',
  'changes_requested',
]);
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['done', 'cancelled', 'superseded']);
const FINISHABLE_RUN_STATUSES = new Set<AgentJobMeta['status']>(['succeeded', 'waiting_for_user']);
const RETRY_RUN_STATUSES = new Set<AgentJobMeta['status']>(['failed', 'cancelled', 'unknown']);

function latestKnownRun(repoRoot: string, task: ControllerTask): AgentJobMeta | undefined {
  for (const runId of [...task.runIds].reverse()) {
    try {
      return getAgentJob(repoRoot, runId);
    } catch (_error) {
      // Run metadata can be pruned independently from task history; keep scanning older ids.
    }
  }
  return undefined;
}

function itemCounts(items: CompletionBacklogItem[]): Record<CompletionBacklogAction, number> {
  const counts: Record<CompletionBacklogAction, number> = {
    auto_finish: 0,
    needs_human_review: 0,
    retry_required: 0,
    system_blocked: 0,
    already_terminal: 0,
    no_run_evidence: 0,
  };
  for (const item of items) counts[item.action] += 1;
  return counts;
}

function effectiveTask(issue: ReturnType<typeof projectIssueEffectiveView>, taskId: string): (ControllerTask & Record<string, unknown>) | undefined {
  return issue.tasks.find((task) => task.id === taskId) as (ControllerTask & Record<string, unknown>) | undefined;
}

function classifyTask(repoRoot: string, issue: ControllerIssue, task: ControllerTask): CompletionBacklogItem | undefined {
  const policy = taskExecutionPolicy(task);
  const view = projectIssueEffectiveView(repoRoot, issue);
  const effective = effectiveTask(view, task.id);
  const run = latestKnownRun(repoRoot, task);
  const base = {
    issueId: issue.id,
    taskId: task.id,
    title: task.title,
    taskStatus: task.status,
    effectiveStatus: typeof effective?.effectiveStatus === 'string' ? effective.effectiveStatus : undefined,
    verificationStatus: typeof effective?.verificationStatus === 'string' ? effective.verificationStatus : undefined,
    runId: run?.runId,
    runStatus: run?.status,
    executionClass: policy.executionClass,
  };

  if (task.status === 'done') {
    if (!completionEvidenceComplete(task.verification, {
      issueId: issue.id,
      taskId: task.id,
      targetBranch: resolveCompletionTargetBranch(repoRoot),
    })) {
      return {
        ...base,
        action: 'system_blocked',
        reason: 'Task is declared done without a complete delivery receipt; run the stuck-state migration before any new execution.',
        canAutoFinish: false,
        suggestedDecision: 'inspect',
      };
    }
  }

  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return { ...base, action: 'already_terminal', reason: `Task is ${task.status}.`, canAutoFinish: false, suggestedDecision: 'inspect' };
  }

  if (run && FINISHABLE_RUN_STATUSES.has(run.status)) {
    if (task.acceptanceCriteria.length > 0) {
      return {
        ...base,
        action: 'needs_human_review',
        reason: `Task declares acceptance criteria that require an explicit acceptance decision before finishing ${run.runId}.`,
        canAutoFinish: false,
        suggestedDecision: 'approve_and_finish',
      };
    }
    return {
      ...base,
      action: 'auto_finish',
      reason: `Run ${run.runId} is ${run.status} and the Task declares no semantic acceptance criteria, so automatic finish may proceed.`,
      canAutoFinish: true,
      suggestedDecision: 'auto',
    };
  }

  if (run && RETRY_RUN_STATUSES.has(run.status)) {
    return {
      ...base,
      action: 'retry_required',
      reason: `Latest Run ${run.runId} ended as ${run.status}; a retry or explicit changes request is required.`,
      canAutoFinish: false,
      suggestedDecision: 'retry',
    };
  }

  if (ACTIVE_REVIEW_STATUSES.has(task.status) && !run) {
    return {
      ...base,
      action: 'no_run_evidence',
      reason: `Task is ${task.status} but has no readable Run evidence.`,
      canAutoFinish: false,
      suggestedDecision: 'inspect',
    };
  }

  if (task.status === 'blocked') {
    return {
      ...base,
      action: 'system_blocked',
      reason: 'Task is blocked without a finishable latest Run.',
      canAutoFinish: false,
      suggestedDecision: 'inspect',
    };
  }

  return undefined;
}

export function inspectCompletionBacklog(repoRoot: string, options: { includeTerminal?: boolean; limit?: number } = {}): CompletionBacklogReport {
  if (legacyIssueAuthorityRetired(repoRoot)) {
    return {
      scannedAt: new Date().toISOString(),
      counts: itemCounts([]),
      finishableRunIds: [],
      needsHumanReviewRunIds: [],
      retryTaskRefs: [],
      items: [],
      recommendations: ['Legacy Issue/Task completion backlog is retired. Use Work and Execution Diagnostics from controller-home SQLite.'],
    };
  }
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  const issues = listIssues(repoRoot, { includeEphemeral: false });
  const items: CompletionBacklogItem[] = [];
  for (const issue of issues) {
    for (const task of issue.tasks) {
      const item = classifyTask(repoRoot, issue, task);
      if (!item) continue;
      if (!options.includeTerminal && item.action === 'already_terminal') continue;
      items.push(item);
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }
  const counts = itemCounts(items);
  const finishableRunIds = items.filter((item) => item.action === 'auto_finish' && item.runId).map((item) => item.runId!);
  const needsHumanReviewRunIds = items.filter((item) => item.action === 'needs_human_review' && item.runId).map((item) => item.runId!);
  const retryTaskRefs = items
    .filter((item) => item.action === 'retry_required')
    .map((item) => ({ issueId: item.issueId, taskId: item.taskId, runId: item.runId }));
  const recommendations: string[] = [];
  if (finishableRunIds.length) recommendations.push(`Run controller finish-ready-runs --apply to close ${finishableRunIds.length} low/medium completed Run(s).`);
  if (needsHumanReviewRunIds.length) recommendations.push(`${needsHumanReviewRunIds.length} high/destructive Run(s) still need an explicit approve_and_finish/request_changes/discard decision.`);
  if (retryTaskRefs.length) recommendations.push(`${retryTaskRefs.length} task(s) need retry or changes_requested before they can progress.`);
  if (counts.no_run_evidence) recommendations.push(`${counts.no_run_evidence} task(s) have review-like status but no readable Run evidence; inspect or mark them explicitly.`);

  return {
    scannedAt: new Date().toISOString(),
    counts,
    finishableRunIds,
    needsHumanReviewRunIds,
    retryTaskRefs,
    items,
    recommendations,
  };
}
