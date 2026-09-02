export type CompletionReceiptSource =
  | 'direct_edit'
  | 'controller_work'
  | 'isolated_agent_run'
  | 'workspace_run'
  | 'remote_no_change_execution';

export type CompletionReceiptDeliveryKind = 'commit' | 'no_change' | 'remote' | 'superseded';
export type CompletionReceiptDeliveryStatus = 'integrated' | 'blocked';
export type CompletionReceiptCleanupStatus = 'complete' | 'maintenance_warning' | 'blocked';

export interface CompletionMaintenanceWarning {
  code:
    | 'worktree_cleanup_failed'
    | 'branch_cleanup_failed'
    | 'edit_session_backup_retained'
    | 'cleanup_retained_by_request';
  message: string;
  resourceKind?: 'worktree' | 'branch' | 'edit_session' | 'lease' | 'process' | 'workspace';
  resourceId?: string;
  recordedAt: string;
}

export interface CompletionResourceBlocker {
  code:
    | 'unintegrated_changes'
    | 'active_write_process'
    | 'unknown_resource_ownership'
    | 'dirty_owned_paths'
    | 'edit_session_open'
    | 'lease_active'
    | 'run_not_terminal'
    | 'target_revision_unreachable';
  message: string;
  resourceKind?: 'worktree' | 'branch' | 'edit_session' | 'lease' | 'process' | 'workspace';
  resourceId?: string;
  recordedAt: string;
}

/** Kernel-owned repository delivery receipt; legacy Task/Issue fields remain compatibility projection identity. */
export interface RepositoryCompletionReceipt {
  schemaVersion: 1;
  receiptId: string;
  source: CompletionReceiptSource;
  issueId: string;
  taskId: string;
  runId?: string;
  workId?: string;
  editSessionId?: string;
  targetBranch: string;
  targetRevision: string;
  sourceRevision?: string;
  baseRevision?: string;
  changedPaths: string[];
  delivery: {
    kind: CompletionReceiptDeliveryKind;
    status: CompletionReceiptDeliveryStatus;
    strategy: 'edit_session_commit' | 'already_integrated' | 'no_change' | 'remote';
    reachable: boolean;
    recordedAt: string;
  };
  cleanup: {
    status: CompletionReceiptCleanupStatus;
    warnings: CompletionMaintenanceWarning[];
    blockers: CompletionResourceBlocker[];
    recordedAt: string;
  };
  verifiedAt: string;
  recordedAt: string;
}

/** Legacy public name retained as an inward projection. */
export type CompletionReceipt = RepositoryCompletionReceipt;
