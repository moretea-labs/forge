/** Shared read-only Task Ledger projection contract. The CLI remains the legacy projection builder. */

export const TASK_LEDGER_SCHEMA_VERSION = 2;

export interface TaskLedgerTaskProjection {
  issueId: string;
  taskId: string;
  title: string;
  objective?: string;
  declaredStatus?: string;
  effectiveStatus?: string;
  statusReason?: string;
  verificationStatus?: string;
  latestRunStatus?: string;
  latestRunClosureState?: string;
  activeRunId?: string;
  activeRunStatus?: string;
  retryable: boolean;
  requiresExplicitRetry: boolean;
  dispatchable: boolean;
  queueable: boolean;
  multipleActiveRuns: boolean;
  allowedPaths: string[];
  checks: string[];
  runIds: string[];
}


export type TaskLedgerStatusKind =
  | "empty"
  | "needs_issue_selection"
  | "active_run"
  | "needs_review"
  | "needs_retry_decision"
  | "blocked"
  | "ready_to_dispatch"
  | "queueable_pending"
  | "continue_current"
  | "complete_or_idle";

export interface TaskLedgerStatusProjection {
  kind: TaskLedgerStatusKind;
  severity: "info" | "action" | "warning" | "blocked";
  label: string;
  reason: string;
  issueId?: string;
  taskId?: string;
  nextAction: string;
}

export interface TaskLedgerIssueProjection {
  id: string;
  title: string;
  status?: string;
  lifecycleStatus?: string;
  isCurrent: boolean;
  updatedAt?: string;
  taskCounts: Record<string, number>;
  tasks: TaskLedgerTaskProjection[];
}

export interface TaskLedgerProjection {
  schemaVersion: typeof TASK_LEDGER_SCHEMA_VERSION;
  generatedAt: string;
  source: "controller-task-ledger";
  currentIssueId?: string;
  counts: Record<string, number>;
  declaredCounts: Record<string, number>;
  archivedCounts: Record<string, number>;
  issueCount: number;
  archivedIssueCount: number;
  status: TaskLedgerStatusProjection;
  issues: TaskLedgerIssueProjection[];
  attention: TaskLedgerTaskProjection[];
  readyTasks: Array<Record<string, string>>;
  queueableTasks: Array<Record<string, string>>;
  recentEvents: Array<{
    at: string;
    category: string;
    action: string;
    summary: string;
    issueId?: string;
    taskId?: string;
    runId?: string;
    jobId?: string;
  }>;
  suggestedNextActions: string[];
  contextContract: {
    strategy: string;
    rawCodeRequiredForImplementation: true;
    notes: string[];
  };
  deprecated?: true;
  frozen?: true;
  readOnly?: true;
  authority?: "controller-home-sqlite";
  notice?: string;
}
