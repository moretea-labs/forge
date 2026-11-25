export interface CompletionMaintenanceWarning {
  code:
    | 'worktree_cleanup_failed'
    | 'branch_cleanup_failed'
    | 'cleanup_retained_by_request';
  message: string;
}

export interface CompletionResourceBlocker {
  code:
    | 'unintegrated_changes'
    | 'active_write_process'
    | 'unknown_resource_ownership'
    | 'dirty_owned_paths'
    | 'lease_active'
    | 'run_not_terminal'
    | 'target_revision_unreachable';
  message: string;
  resourceKind?: 'worktree' | 'branch' | 'lease' | 'process' | 'workspace';
}

/** Kernel-owned repository delivery receipt derived from native execution, Git, and resource facts. */
export interface RepositoryCompletionReceipt {
  receiptId: string;
  targetBranch: string;
  targetRevision: string;
  changedPaths: string[];
  reachable: boolean;
  maintenanceWarnings: CompletionMaintenanceWarning[];
  resourceBlockers: CompletionResourceBlocker[];
  recordedAt: string;
}
