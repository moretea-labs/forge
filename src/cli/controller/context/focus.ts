import type { TaskLedgerTaskProjection } from '../task-ledger';
import type { projectBoard } from '../issue-store';
import type { buildControllerTaskLedgerProjection } from '../task-ledger';

export interface ContextPackIssueFocus { id?: string; title?: string; summary?: string; tasks: ContextPackTaskFocus[] }
export interface ContextPackTaskFocus { id?: string; title?: string; objective?: string; status?: string }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function task(value: unknown): ContextPackTaskFocus {
  const item = record(value);
  return { id: string(item.id), title: string(item.title), objective: string(item.objective), status: string(item.status) };
}
function issue(value: unknown): ContextPackIssueFocus {
  const item = record(value);
  return {
    id: string(item.id), title: string(item.title), summary: string(item.summary),
    tasks: Array.isArray(item.tasks) ? item.tasks.map(task).filter((entry) => Object.keys(entry).length > 0) : [],
  };
}

export function issueTaskFocus(
  board: ReturnType<typeof projectBoard>,
  issueId?: string,
  taskId?: string,
): { issue?: ContextPackIssueFocus; task?: ContextPackTaskFocus } {
  const issues = board.issues.map(issue);
  const resolvedIssue = issueId
    ? issues.find((entry) => entry.id === issueId)
    : board.currentIssueId ? issues.find((entry) => entry.id === board.currentIssueId) : undefined;
  return { issue: resolvedIssue, task: resolvedIssue?.tasks.find((entry) => entry.id === taskId) ?? resolvedIssue?.tasks[0] };
}

export function ledgerTask(
  ledger: ReturnType<typeof buildControllerTaskLedgerProjection>,
  issueId?: string,
  taskId?: string,
): TaskLedgerTaskProjection | undefined {
  const tasks = ledger.issues.flatMap((entry) => entry.tasks);
  const find = (candidateIssueId?: string, candidateTaskId?: string) => tasks
    .find((entry) => (!candidateIssueId || entry.issueId === candidateIssueId) && (!candidateTaskId || entry.taskId === candidateTaskId));
  if (!issueId && !taskId) {
    const ready = ledger.readyTasks[0];
    return ledger.attention[0] ?? find(ready?.issueId, ready?.taskId) ?? tasks.find((entry) => entry.dispatchable || entry.queueable);
  }
  return find(issueId, taskId);
}
