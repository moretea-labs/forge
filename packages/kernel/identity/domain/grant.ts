import type { ScopeRef } from './scope';

export type GrantRiskCeiling = 'readonly' | 'workspace_write' | 'remote_write';

export interface GrantTarget {
  kind: string;
  id: string;
  repoId?: string;
  scopeRef?: ScopeRef;
  identityFingerprint?: string;
}

export interface Grant {
  schemaVersion: 1;
  grantId: string;
  principalId: string;
  ownerScope?: string;
  capabilities: string[];
  target?: GrantTarget;
  scopes?: string[];
  riskCeiling?: GrantRiskCeiling;
  constraints?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedReason?: string;
}

export interface RecordGrantInput {
  grantId?: string;
  principalId: string;
  ownerScope?: string;
  capabilities: string[];
  target?: GrantTarget;
  scopes?: string[];
  riskCeiling?: GrantRiskCeiling;
  constraints?: Record<string, unknown>;
  expiresInMinutes?: number;
  now?: Date;
}

export interface RevokeGrantInput {
  grantId: string;
  ownerScope?: string;
  reason: string;
  now?: Date;
}

export interface ReconcileGrantsInput {
  retiredOwnerScopes?: readonly string[];
  now?: Date;
}

export interface ReconcileGrantsResult {
  removedRetiredOwner: number;
  removedRevoked: number;
  removedExpired: number;
  removedTotal: number;
  remaining: number;
  changed: boolean;
}

export interface QueryGrantInput {
  principalId?: string;
  ownerScope?: string;
  capability: string;
  target?: GrantTarget;
  scopes?: readonly string[];
  risk?: 'readonly' | 'workspace_write' | 'remote_write' | 'destructive';
  at?: Date;
}
