/**
 * Canonical Mode-Free Capability Broker Types and Contracts.
 * 
 * Public capabilities (read, search, edit, command, process, git, workspace,
 * browser, computer, plugin, API, agent, schedule, release, recovery)
 * compose without mandatory Requirement/Plan/Work, task-size thresholds,
 * or Direct/GoalWorkloop/Scale mode tokens.
 * 
 * Shared invocation conventions:
 * - target / principal
 * - typed arguments
 * - optional expected revision
 * - timeout / cancellation
 * - optional idempotency / request identity
 * - result or typed handle
 */

export interface CapabilityTarget {
  scope: 'global' | 'repository' | 'workspace' | 'device' | 'account' | 'provider';
  scopeId?: string;
  repoId?: string;
}

export interface CapabilityInvocationInput<TArgs = Record<string, unknown>> {
  capabilityId: string;
  target: CapabilityTarget;
  principalId: string;
  arguments: TArgs;
  expectedRevision?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
  associatedWorkId?: string;
}

export type CapabilityExecutionKind = 'synchronous' | 'managed_handle' | 'delegated_agent';

export interface CapabilityTypedHandle {
  handleId: string;
  capabilityId: string;
  executionKind: CapabilityExecutionKind;
  target: CapabilityTarget;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface CapabilityInvocationResult<TResult = unknown> {
  success: boolean;
  result?: TResult;
  handle?: CapabilityTypedHandle;
  error?: {
    code: string;
    message: string;
  };
}
