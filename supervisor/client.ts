import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { workflowSupervisorSocketPath } from './paths';
import type { WorkflowSupervisorAutomationStatus, WorkflowSupervisorConsumerStatus, WorkflowSupervisorContinuationProof, WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTaskStall, WorkflowSupervisorTerminalState } from './types';

interface RpcResponse<T> { id: string; ok: boolean; result?: T; error?: { code?: string; message?: string } }

// The Supervisor daemon is single-threaded and shares its event loop with the
// canonical Runtime's own scheduler/maintenance passes. A short read budget is
// enough for cheap lookups, but a mutating call must not be reported as failed
// merely because the Runtime was busy for a moment: `task_register` and the
// reservation calls are idempotent upserts, and treating ordinary contention as
// failure stranded ControllerRounds in `dispatching`
// (live evidence: `WORKFLOW_SUPERVISOR_RPC_TIMEOUT:task_register` in the Runtime
// stderr while the daemon was healthy). Keep both budgets bounded.
const SUPERVISOR_RPC_READ_TIMEOUT_MS = 2_000;
const SUPERVISOR_RPC_MUTATION_TIMEOUT_MS = 15_000;

async function rpc<T>(forgeHome: string, method: string, params: Record<string, unknown>, timeoutMs = SUPERVISOR_RPC_READ_TIMEOUT_MS): Promise<T> {
  const socketPath = workflowSupervisorSocketPath(forgeHome);
  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const id = `forge-${randomUUID()}`;
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`WORKFLOW_SUPERVISOR_RPC_TIMEOUT:${method}`)), timeoutMs);
    socket.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response: RpcResponse<T>;
      try { response = JSON.parse(buffer.slice(0, newline)) as RpcResponse<T>; }
      catch { finish(new Error('WORKFLOW_SUPERVISOR_RPC_RESPONSE_INVALID')); return; }
      if (response.id !== id) { finish(new Error('WORKFLOW_SUPERVISOR_RPC_RESPONSE_ID_MISMATCH')); return; }
      if (!response.ok) { finish(new Error(response.error?.message ?? response.error?.code ?? 'WORKFLOW_SUPERVISOR_RPC_FAILED')); return; }
      finish(undefined, response.result as T);
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
  });
}

export async function getWorkflowSupervisorConsumerStatus(forgeHome: string): Promise<WorkflowSupervisorConsumerStatus> {
  return await rpc<WorkflowSupervisorConsumerStatus>(forgeHome, 'consumer_status', {});
}

export async function getWorkflowSupervisorCurrentConversation(forgeHome: string): Promise<WorkflowSupervisorDiscoveredConversation | undefined> {
  const result = await rpc<{ conversation?: WorkflowSupervisorDiscoveredConversation }>(forgeHome, 'browser_current_conversation', {});
  return result.conversation;
}

export async function getWorkflowSupervisorTask(forgeHome: string, taskId: string): Promise<WorkflowSupervisorTask | undefined> {
  const task = await rpc<WorkflowSupervisorTask | null>(forgeHome, 'task_get', { task_id: taskId });
  return task ?? undefined;
}

export async function getWorkflowSupervisorTaskByConversationId(
  forgeHome: string,
  conversationId: string,
): Promise<{ task: WorkflowSupervisorTask; terminal?: WorkflowSupervisorTerminalState } | undefined> {
  const result = await rpc<{ task: WorkflowSupervisorTask; terminal?: WorkflowSupervisorTerminalState } | null>(
    forgeHome,
    'task_get_by_conversation',
    { conversation_id: conversationId },
  );
  return result ?? undefined;
}

export async function listWorkflowSupervisorTasks(forgeHome: string, activeOnly = false): Promise<WorkflowSupervisorTask[]> {
  const result = await rpc<{ tasks: WorkflowSupervisorTask[] }>(forgeHome, 'task_list', { active_only: activeOnly });
  return result.tasks;
}
/** Operator-only recovery; never exposed to the browser Native Messaging host. */
export async function recoverWorkflowSupervisorTask(forgeHome: string, input: { taskId: string; sourceEffectId?: string; requestId: string; reason: string; supersedeUnknown?: boolean; authorizedBy?: string }): Promise<{ recoveryEffect: WorkflowSupervisorEffect; action: 'retry_authorized' | 'recovery_reserved' | 'unknown_superseded' }> {
  return await rpc(forgeHome, 'task_recover', {
    task_id: input.taskId,
    ...(input.sourceEffectId?.trim() ? { source_effect_id: input.sourceEffectId.trim() } : {}),
    request_id: input.requestId,
    reason: input.reason,
    ...(input.supersedeUnknown === true ? { supersede_unknown: true } : {}),
    ...(input.authorizedBy?.trim() ? { authorized_by: input.authorizedBy.trim() } : {}),
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

/** Read-only stall classification; derived from the effect ledger, not new state. */
export async function getWorkflowSupervisorTaskStall(forgeHome: string, taskId: string): Promise<WorkflowSupervisorTaskStall> {
  return await rpc<WorkflowSupervisorTaskStall>(forgeHome, 'task_stall', { task_id: taskId });
}

/**
 * Operator-only conversation migration for a standalone Supervisor task whose
 * exact conversation became permanently unusable. It is explicit and bounded by
 * design: it is never triggered automatically by provider backpressure.
 */
export async function migrateWorkflowSupervisorConversation(forgeHome: string, input: {
  taskId: string; expectedConversationId: string; conversationId: string; conversationUrl: string;
  requestId: string; reason: string; authorizedBy?: string;
}): Promise<{ taskId: string; conversationId: string; conversationUrl: string; migrated: boolean }> {
  return await rpc(forgeHome, 'task_migrate_conversation', {
    task_id: input.taskId,
    expected_conversation_id: input.expectedConversationId,
    conversation_id: input.conversationId,
    conversation_url: input.conversationUrl,
    request_id: input.requestId,
    reason: input.reason,
    ...(input.authorizedBy?.trim() ? { authorized_by: input.authorizedBy.trim() } : {}),
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export async function stopWorkflowSupervisorTask(
  forgeHome: string,
  taskId: string,
  reason = 'Stopped by operator request.',
): Promise<{ taskId: string; terminal: 'STOPPED'; deduplicated: boolean }> {
  return await rpc(forgeHome, 'task_stop', { task_id: taskId, reason }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export async function registerWorkflowSupervisorTask(forgeHome: string, input: WorkflowSupervisorTaskInput): Promise<WorkflowSupervisorTask> {
  return await rpc<WorkflowSupervisorTask>(forgeHome, 'task_register', {
    task_id: input.taskId,
    conversation_id: input.conversationId,
    conversation_url: input.conversationUrl,
    objective: input.objective,
    completion_contract: input.completionContract,
    continuation_policy: input.continuationPolicy,
    user_blocker_policy: input.userBlockerPolicy,
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export async function bindWorkflowSupervisorBootstrapConversation(
  forgeHome: string,
  input: { taskId: string; conversationId: string; conversationUrl: string },
): Promise<WorkflowSupervisorTask> {
  return await rpc<WorkflowSupervisorTask>(forgeHome, 'bootstrap_bind_conversation', {
    task_id: input.taskId,
    conversation_id: input.conversationId,
    conversation_url: input.conversationUrl,
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export async function reserveWorkflowSupervisorEnrollment(forgeHome: string, taskId: string, canonicalEffectId?: string): Promise<WorkflowSupervisorEffect> {
  return await rpc<WorkflowSupervisorEffect>(forgeHome, 'reserve_enrollment', {
    task_id: taskId,
    ...(canonicalEffectId?.trim() ? { effect_id: canonicalEffectId.trim() } : {}),
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export async function recordWorkflowSupervisorAutomationReceipt(
  forgeHome: string,
  input: { taskId: string; conversationId: string; status: WorkflowSupervisorAutomationStatus; receiptId: string },
): Promise<unknown> {
  return await rpc(forgeHome, 'automation_receipt', {
    task_id: input.taskId,
    conversation_id: input.conversationId,
    automation_status: input.status,
    receipt_id: input.receiptId,
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export interface WorkflowSupervisorEffectDispatchBudget {
  effectId: string;
  generations: number;
  maxGenerations: number;
  lastDispatchedAtMs?: number;
  retryDelayMs?: number;
  exhausted: boolean;
}

export async function getWorkflowSupervisorEffectDispatchBudget(
  forgeHome: string,
  effectId: string,
): Promise<WorkflowSupervisorEffectDispatchBudget> {
  return await rpc<WorkflowSupervisorEffectDispatchBudget>(forgeHome, 'effect_dispatch_budget', { effect_id: effectId });
}

export async function getWorkflowSupervisorContinuationProof(forgeHome: string, input: { repoId?: string; activeReleaseId: string; notBefore: string }): Promise<WorkflowSupervisorContinuationProof | undefined> {
  const proof = await rpc<WorkflowSupervisorContinuationProof | null>(forgeHome, 'continuation_proof', {
    ...(input.repoId?.trim() ? { repo_id: input.repoId.trim() } : {}),
    active_release_id: input.activeReleaseId,
    not_before: input.notBefore,
  });
  return proof ?? undefined;
}
