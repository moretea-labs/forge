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

/** Kernel-owned repository delivery receipt derived from native execution, Git, and resource facts. */
export interface RepositoryCompletionReceipt {
  schemaVersion: 1;
  receiptId: string;
  editSessionId: string;
  targetBranch: string;
  targetRevision: string;
  changedPaths: string[];
  reachable: boolean;
  cleanup: {
    warnings: CompletionMaintenanceWarning[];
    blockers: CompletionResourceBlocker[];
  };
  recordedAt: string;
}
