/** Immutable access-policy value captured by a Work contract. */
export type WorkAccessMode = 'request' | 'full_access';

export type WorkRouteExecutionMode = 'direct_control' | 'goal_workloop' | 'handoff_only';
export type WorkRouteMode = 'direct_edit' | 'bounded_work' | 'quick_agent' | 'issue_task';
export type WorkRouteExecutionPath = 'fast' | 'durable';
export type WorkRouteExecutorKind = 'direct_edit' | 'local_cli' | 'remote_api' | 'cloud_agent' | 'external_controller' | 'handoff_only';
export type WorkRouteApprovalState = 'approval_not_required' | 'normal_authorization_required' | 'strong_confirmation_required' | 'blocked_by_policy';

export interface WorkRouteReason {
  code: string;
  message: string;
}

/** Persistence-safe snapshot of a routing decision. The routing engine remains outside Kernel. */
export interface WorkRouteDecisionSnapshot {
  executionMode: WorkRouteExecutionMode;
  executorKind: WorkRouteExecutorKind;
  selectedProviderId: string | null;
  workMode: WorkRouteMode;
  executionPath: WorkRouteExecutionPath;
  requiresWork: boolean;
  requiresApproval: boolean;
  requiresIsolation: boolean;
  requiresRecovery: boolean;
  createHandoff: boolean;
  waitForUser: boolean;
  approvalState: WorkRouteApprovalState;
  alternatives: string[];
  reasons: WorkRouteReason[];
  inputFingerprint: string;
  policyVersion: string;
}
