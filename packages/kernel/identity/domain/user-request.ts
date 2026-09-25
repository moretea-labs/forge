export type UserRequestKind = 'user_action_request' | 'user_decision_request';

export type UserActionRequired =
  | 'login'
  | 'grant_permission'
  | 'confirm_destructive'
  | 'product_decision';

export interface UserRequestTargetScope {
  scopeKind: string;
  scopeId: string;
  repoId?: string;
  workId?: string;
  requirementId?: string;
}

export interface UserRequestOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserRequestPresentation {
  /** Compatibility lookup key for legacy Handoff callers; never a second authority. */
  legacyHandoffId?: string;
  severity?: 'info' | 'needs_review' | 'blocked' | 'failed' | 'ready_to_continue';
  creationReason?: string;
  reason?: string;
  currentState?: Record<string, unknown>;
  attemptedActions?: string[];
  evidenceRefs?: Array<{ title: string; summary?: string; detailLevel?: 'summary' | 'detail' | 'raw' }>;
  blockingDecision?: string;
  recommendedDecision?: string;
  recommendedPrompt?: string;
  recommendedContinuationPrompt?: string;
  approvalAction?: {
    operation: 'start' | 'repair';
    label: string;
    summary: string;
    risk: string;
    payload: Record<string, unknown>;
  };
  suggestedNextActions?: Array<{
    label: string;
    tool?: string;
    operation?: string;
    payload?: Record<string, unknown>;
    risk?: string;
    confidence?: string;
    reason?: string;
  }>;
}

export interface UserRequest {
  schemaVersion: 1;
  requestId: string;
  kind: UserRequestKind;
  rootCauseKey: string;
  title: string;
  summary: string;
  actionRequired: UserActionRequired;
  targetScope?: UserRequestTargetScope;
  options?: UserRequestOption[];
  presentation?: UserRequestPresentation;
  status: 'pending' | 'resolved' | 'cancelled';
  resolution?: {
    decision: string;
    resolvedBy: string;
    resolvedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserRequestInput {
  requestId?: string;
  kind: UserRequestKind;
  rootCauseKey: string;
  title: string;
  summary: string;
  actionRequired: UserActionRequired;
  targetScope?: UserRequestTargetScope;
  options?: UserRequestOption[];
  presentation?: UserRequestPresentation;
  now?: Date;
}

export interface ResolveUserRequestInput {
  requestId: string;
  decision: string;
  resolvedBy: string;
  now?: Date;
}
