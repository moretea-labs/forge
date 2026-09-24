import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { workflowSupervisorSocketPath } from './paths';
import type { WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorTask, WorkflowSupervisorTaskInput } from './types';

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

export async function getWorkflowSupervisorCurrentConversation(forgeHome: string): Promise<WorkflowSupervisorDiscoveredConversation | undefined> {
  const result = await rpc<{ conversation?: WorkflowSupervisorDiscoveredConversation }>(forgeHome, 'browser_current_conversation', {});
  return result.conversation;
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

export async function reserveWorkflowSupervisorEnrollment(forgeHome: string, taskId: string): Promise<WorkflowSupervisorEffect> {
  return await rpc<WorkflowSupervisorEffect>(forgeHome, 'reserve_enrollment', { task_id: taskId }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export async function reserveWorkflowSupervisorSchedulerRecovery(forgeHome: string, taskId: string, recoveryKey?: string): Promise<WorkflowSupervisorEffect | undefined> {
  return await rpc<WorkflowSupervisorEffect | undefined>(forgeHome, 'reserve_scheduler_recovery', {
    task_id: taskId,
    ...(recoveryKey?.trim() ? { recovery_key: recoveryKey.trim() } : {}),
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}
