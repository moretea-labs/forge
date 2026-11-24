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
  source: 'direct_edit' | 'isolated_agent_run' | 'workspace_run' | 'remote_no_change_execution';
  issueId: string;
  taskId: string;
  runId?: string;
  editSessionId?: string;
  targetBranch: string;
  targetRevision: string;
  sourceRevision?: string;
  baseRevision?: string;
  changedPaths: string[];
  delivery: {
    kind: 'commit' | 'no_change' | 'remote' | 'superseded';
    status: 'integrated' | 'blocked';
    strategy: 'edit_session_commit' | 'already_integrated' | 'no_change' | 'remote';
    reachable: boolean;
    recordedAt: string;
  };
  cleanup: {
    status: 'complete' | 'maintenance_warning' | 'blocked';
    warnings: CompletionMaintenanceWarning[];
    blockers: CompletionResourceBlocker[];
    recordedAt: string;
  };
  verifiedAt: string;
  recordedAt: string;
}
