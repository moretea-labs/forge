import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { isWorkspaceScopeKey, repositoryControllerRoot, scopedOperationRoot } from '../../../effects/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import type { AccessMode } from './access-policy';

export type AuthorizationRiskClass =
  | 'readonly'
  | 'local_repo_write'
  | 'workspace_write'
  | 'local_command'
  | 'dependency_change'
  | 'local_git'
  | 'remote_write'
  | 'destructive'
  | 'secret_access'
  | 'outside_repository';

export type AuthorizationDecision =
  | {
      decision: 'allow';
      source: 'policy' | 'full_access' | 'goal_delegation' | 'gpt_risk_delegate' | 'user_confirmation';
      reason: string;
    }
  | {
      decision: 'user_confirmation_required';
      approvalRequestId: string;
      humanSummary: string;
      consequences: string[];
      continuation: string;
    }
  | { decision: 'deny'; reason: string };

export interface GoalDelegation {
  schemaVersion: 1;
  sessionId: string;
  repositoryId: string;
  goalId?: string;
  allowedRiskClasses: AuthorizationRiskClass[];
  deniedRiskClasses: AuthorizationRiskClass[];
  permissionSnapshotVersion: number;
  source: 'goal_delegation' | 'gpt_risk_delegate';
  createdAt: string;
  expiresAt?: string;
  version: number;
}

export interface AuthorizationRequestRecord {
  schemaVersion: 1;
  approvalRequestId: string;
  repositoryId: string;
  sessionId?: string;
  principalId?: string;
  goalId?: string;
  command?: string | string[];
  approvalToken?: string;
  risk: AuthorizationRiskClass;
  permissionSnapshotVersion: number;
  humanSummary: string;
  consequences: string[];
  continuation: string;
  status: 'pending' | 'resolved' | 'invalidated';
  createdAt: string;
  resolvedAt?: string;
  invalidatedReason?: string;
}

export interface AuthorizationContext {
  controllerHome?: string;
  accessMode: AccessMode;
  risk: AuthorizationRiskClass;
  repositoryId: string;
  currentRepositoryId?: string;
  goalId?: string;
  boundGoalId?: string;
  sessionId?: string;
  principalId?: string;
  permissionSnapshotVersion: number;
  delegation?: GoalDelegation;
  worktreePath?: string;
  cwd?: string;
  command?: string | string[];
  approvalRequestId?: string;
  approvalToken?: string;
  approvedByUser?: boolean;
}

function requestRoot(controllerHome: string, repoId: string): string {
  const root = join(scopedOperationRoot(controllerHome, repoId), 'controller', 'approval-requests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function requestPath(controllerHome: string, repoId: string, requestId: string): string {
  return join(requestRoot(controllerHome, repoId), `${sanitizeFileComponent(requestId)}.json`);
}

/**
 * Bounded migration read: an approval issued for a workspace scope before the
 * workspace partition existed is still resolvable instead of failing closed as
 * a missing request.
 */
function readableRequestPath(controllerHome: string, repoId: string, requestId: string): string {
  const current = requestPath(controllerHome, repoId, requestId);
  if (existsSync(current) || !isWorkspaceScopeKey(repoId)) return current;
  const legacy = join(
    repositoryControllerRoot(controllerHome, repoId),
    'controller',
    'approval-requests',
    `${sanitizeFileComponent(requestId)}.json`,
  );
  return existsSync(legacy) ? legacy : current;
}

function scopeMatches(context: AuthorizationContext): boolean {
  if (context.currentRepositoryId && context.repositoryId !== context.currentRepositoryId) return false;
  if (context.goalId && context.boundGoalId && context.goalId !== context.boundGoalId) return false;
  if (context.worktreePath && context.cwd) {
    const cwd = resolve(context.worktreePath, context.cwd);
    const rel = relative(resolve(context.worktreePath), cwd);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return false;
  }
  return true;
}

function delegationMatches(context: AuthorizationContext): boolean {
  const delegation = context.delegation;
  if (!delegation || delegation.sessionId !== context.sessionId || delegation.repositoryId !== context.repositoryId)
    return false;
  if (delegation.goalId && delegation.goalId !== context.goalId && delegation.goalId !== context.boundGoalId)
    return false;
  if (delegation.permissionSnapshotVersion !== context.permissionSnapshotVersion) return false;
  if (delegation.expiresAt && Date.parse(delegation.expiresAt) <= Date.now()) return false;
  if (delegation.deniedRiskClasses.includes(context.risk) || !delegation.allowedRiskClasses.includes(context.risk))
    return false;
  return scopeMatches(context);
}

function requestDecision(context: AuthorizationContext, reason: string): AuthorizationDecision {
  if (!context.controllerHome) {
    return { decision: 'deny', reason: `${reason} Controller Home is unavailable for a resumable approval request.` };
  }
  const approvalRequestId = `apr_${randomUUID().replace(/-/g, '')}`;
  const record: AuthorizationRequestRecord = {
    schemaVersion: 1,
    approvalRequestId,
    repositoryId: context.repositoryId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.principalId ? { principalId: context.principalId } : {}),
    ...(context.goalId ? { goalId: context.goalId } : {}),
    ...(context.command ? { command: context.command } : {}),
    ...(context.approvalToken ? { approvalToken: context.approvalToken } : {}),
    risk: context.risk,
    permissionSnapshotVersion: context.permissionSnapshotVersion,
    humanSummary: reason,
    consequences: [`Operation risk class: ${context.risk}`, `Repository: ${context.repositoryId}`],
    continuation: context.command
      ? `After confirming approvalRequestId=${approvalRequestId}, retry the same command with the returned approval request; changed commands require a new approval.`
      : `After confirming approvalRequestId=${approvalRequestId}, retry the original operation in this session.`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(requestPath(context.controllerHome, context.repositoryId, approvalRequestId), record);
  return {
    decision: 'user_confirmation_required',
    approvalRequestId,
    humanSummary: record.humanSummary,
    consequences: record.consequences,
    continuation: record.continuation,
  };
}

export function requestExplicitAuthorization(input: {
  controllerHome: string;
  repositoryId: string;
  requestKey: string;
  sessionId?: string;
  principalId?: string;
  permissionSnapshotVersion: number;
  risk?: AuthorizationRiskClass;
  humanSummary: string;
  consequences?: string[];
  continuation?: string;
  command?: string | string[];
}): AuthorizationRequestRecord {
  const requestKey = input.requestKey.trim();
  const humanSummary = input.humanSummary.trim();
  if (!requestKey || requestKey.length > 2048) throw new Error('APPROVAL_REQUEST_KEY_INVALID');
  if (!humanSummary || humanSummary.length > 4000) throw new Error('APPROVAL_REQUEST_SUMMARY_INVALID');
  if (!Number.isSafeInteger(input.permissionSnapshotVersion) || input.permissionSnapshotVersion < 0)
    throw new Error('APPROVAL_REQUEST_PERMISSION_SNAPSHOT_INVALID');
  const approvalRequestId = `apr_exp_${createHash('sha256').update(requestKey).digest('hex').slice(0, 32)}`;
  const existingPath = readableRequestPath(input.controllerHome, input.repositoryId, approvalRequestId);
  const risk = input.risk ?? 'workspace_write';
  const consequences = input.consequences?.length
    ? input.consequences.map((entry) => entry.trim()).filter(Boolean)
    : [`Operation risk class: ${risk}`, `Repository: ${input.repositoryId}`];
  const continuation =
    input.continuation?.trim() ||
    `After confirming approvalRequestId=${approvalRequestId}, resume the exact pending Workflow operation.`;
  if (existsSync(existingPath)) {
    const existing = readAuthorizationRequest(input.controllerHome, input.repositoryId, approvalRequestId);
    if (
      existing.sessionId !== input.sessionId ||
      existing.principalId !== input.principalId ||
      existing.permissionSnapshotVersion !== input.permissionSnapshotVersion ||
      existing.risk !== risk ||
      existing.humanSummary !== humanSummary ||
      JSON.stringify(existing.command) !== JSON.stringify(input.command)
    ) {
      throw new Error('APPROVAL_REQUEST_IDEMPOTENCY_CONFLICT');
    }
    if (existing.status === 'invalidated')
      throw new Error(`APPROVAL_REQUEST_INVALIDATED: ${existing.invalidatedReason ?? 'approval request is stale'}`);
    return existing;
  }
  const record: AuthorizationRequestRecord = {
    schemaVersion: 1,
    approvalRequestId,
    repositoryId: input.repositoryId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.principalId ? { principalId: input.principalId } : {}),
    ...(input.command ? { command: structuredClone(input.command) } : {}),
    risk,
    permissionSnapshotVersion: input.permissionSnapshotVersion,
    humanSummary,
    consequences,
    continuation,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(requestPath(input.controllerHome, input.repositoryId, approvalRequestId), record);
  return record;
}

export function decideAuthorization(context: AuthorizationContext): AuthorizationDecision {
  if (context.risk === 'secret_access')
    return { decision: 'deny', reason: 'Credential, keychain, token, and raw secret access is always denied.' };
  if (!scopeMatches(context))
    return requestDecision(
      context,
      'The operation is outside the active repository, checkout/worktree, or Goal scope.',
    );
  if (['outside_repository', 'destructive'].includes(context.risk)) {
    return context.approvedByUser
      ? {
          decision: 'allow',
          source: 'user_confirmation',
          reason: 'The user explicitly confirmed the scoped catastrophic operation.',
        }
      : requestDecision(context, `Explicit user confirmation is required for ${context.risk}.`);
  }
  if (delegationMatches(context)) {
    return {
      decision: 'allow',
      source: context.delegation?.source ?? 'gpt_risk_delegate',
      reason: 'The operation is within the current Goal and repository scope.',
    };
  }
  return {
    decision: 'allow',
    source: 'policy',
    reason: 'Normal scoped operations follow the host AI permission model; Forge only gates catastrophic effects.',
  };
}

export function createGoalDelegation(
  input: Omit<GoalDelegation, 'schemaVersion' | 'createdAt' | 'version'> & { expiresAt?: string },
): GoalDelegation {
  return { schemaVersion: 1, ...input, createdAt: new Date().toISOString(), version: 1 };
}

export function readAuthorizationRequest(
  controllerHome: string,
  repositoryId: string,
  approvalRequestId: string,
): AuthorizationRequestRecord {
  const path = readableRequestPath(controllerHome, repositoryId, approvalRequestId);
  if (!existsSync(path)) throw new Error(`APPROVAL_REQUEST_NOT_FOUND: ${approvalRequestId}`);
  const request = readJsonFile<AuthorizationRequestRecord>(path);
  if (request.repositoryId !== repositoryId || request.approvalRequestId !== approvalRequestId)
    throw new Error('APPROVAL_REQUEST_IDENTITY_MISMATCH');
  return request;
}

export function invalidateAuthorizationRequest(input: {
  controllerHome: string;
  repositoryId: string;
  approvalRequestId: string;
  reason: string;
}): AuthorizationRequestRecord {
  const reason = input.reason.trim();
  if (!reason || reason.length > 2000) throw new Error('APPROVAL_INVALIDATION_REASON_INVALID');
  const request = readAuthorizationRequest(input.controllerHome, input.repositoryId, input.approvalRequestId);
  if (request.status === 'resolved') throw new Error('APPROVAL_ALREADY_RESOLVED');
  if (request.status === 'invalidated') return request;
  const invalidated: AuthorizationRequestRecord = {
    ...request,
    status: 'invalidated',
    invalidatedReason: reason,
  };
  writeJsonAtomic(requestPath(input.controllerHome, input.repositoryId, input.approvalRequestId), invalidated);
  return invalidated;
}

export function resolveAuthorizationRequest(input: {
  controllerHome: string;
  repositoryId: string;
  approvalRequestId: string;
  sessionId?: string;
  principalId?: string;
  permissionSnapshotVersion: number;
  confirm: boolean;
}): AuthorizationRequestRecord {
  const request = readAuthorizationRequest(input.controllerHome, input.repositoryId, input.approvalRequestId);
  if (!input.confirm)
    throw new Error(
      'USER_CONFIRMATION_REQUIRED: confirm_authorization=true is required to resolve the approval request',
    );
  if (request.status === 'invalidated')
    throw new Error(`APPROVAL_REQUEST_INVALIDATED: ${request.invalidatedReason ?? 'approval request is stale'}`);
  if (request.sessionId && request.sessionId !== input.sessionId) throw new Error('APPROVAL_REQUEST_SESSION_MISMATCH');
  if (request.principalId && request.principalId !== input.principalId)
    throw new Error('APPROVAL_REQUEST_PRINCIPAL_MISMATCH');
  if (request.permissionSnapshotVersion !== input.permissionSnapshotVersion)
    throw new Error('APPROVAL_REQUEST_STALE_PERMISSION');
  const resolved = { ...request, status: 'resolved' as const, resolvedAt: new Date().toISOString() };
  writeJsonAtomic(requestPath(input.controllerHome, input.repositoryId, input.approvalRequestId), resolved);
  return resolved;
}

export function assertResolvedAuthorization(input: {
  controllerHome: string;
  repositoryId: string;
  approvalRequestId: string;
  sessionId?: string;
  principalId?: string;
  permissionSnapshotVersion: number;
  command?: string | string[];
}): AuthorizationRequestRecord {
  const request = readAuthorizationRequest(input.controllerHome, input.repositoryId, input.approvalRequestId);
  if (request.status !== 'resolved')
    throw new Error('APPROVAL_REQUEST_NOT_RESOLVED: confirm the approval request in the current conversation first');
  if (request.sessionId && request.sessionId !== input.sessionId) throw new Error('APPROVAL_REQUEST_SESSION_MISMATCH');
  if (request.principalId && request.principalId !== input.principalId)
    throw new Error('APPROVAL_REQUEST_PRINCIPAL_MISMATCH');
  if (request.permissionSnapshotVersion !== input.permissionSnapshotVersion)
    throw new Error('APPROVAL_REQUEST_STALE_PERMISSION');
  if (request.command && input.command && JSON.stringify(request.command) !== JSON.stringify(input.command))
    throw new Error('APPROVAL_REQUEST_COMMAND_CHANGED: request a new approval for changed parameters');
  return request;
}
