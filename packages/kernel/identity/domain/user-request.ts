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
  now?: Date;
}

export interface ResolveUserRequestInput {
  requestId: string;
  decision: string;
  resolvedBy: string;
  now?: Date;
}
