import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { workflowSupervisorSocketPath } from './paths';
import type { WorkflowSupervisorConsumerStatus, WorkflowSupervisorContinuationProof, WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTaskStall, WorkflowSupervisorTerminalState, WorkflowSupervisorReviewNotice } from './types';

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

export async function reviseWorkflowSupervisorTaskObjective(forgeHome: string, input: {
  taskId: string; objective: string; expectedObjectiveSha256: string; requestId: string; authorizedBy?: string;
  workId?: string; requirementId?: string; expectedCompletionContractSha256?: string;
}): Promise<{ task: WorkflowSupervisorTask; changed: boolean; deduplicated: boolean; objectiveSha256: string; completionContractSha256: string; semanticBindingChanged: boolean; refreshedEffect?: WorkflowSupervisorEffect }> {
  return await rpc(forgeHome, 'task_revise_objective', {
    task_id: input.taskId,
    objective: input.objective,
    expected_objective_sha256: input.expectedObjectiveSha256,
    request_id: input.requestId,
    ...(input.workId?.trim() ? { work_id: input.workId.trim() } : {}),
    ...(input.requirementId?.trim() ? { requirement_id: input.requirementId.trim() } : {}),
    ...(input.expectedCompletionContractSha256?.trim() ? { expected_completion_contract_sha256: input.expectedCompletionContractSha256.trim() } : {}),
    ...(input.authorizedBy?.trim() ? { authorized_by: input.authorizedBy.trim() } : {}),
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
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
/** Explicit read-only terminal history. Native ChatGPT archive is not inferred. */
export async function listWorkflowSupervisorTerminalTasks(forgeHome: string): Promise<Array<{ task: WorkflowSupervisorTask; terminal: WorkflowSupervisorTerminalState }>> {
  const result = await rpc<{ terminalTasks: Array<{ task: WorkflowSupervisorTask; terminal: WorkflowSupervisorTerminalState }> }>(
    forgeHome, 'task_list', { terminal_only: true },
  );
  return result.terminalTasks;
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
/** Original-task explicit opt-in; only the current Supervisor owns watch facts. */
export async function bindWorkflowSupervisorReviewWatch(forgeHome: string, input: {
  taskId: string; repoId: string; githubRepository: string; prNumber: number;
}): Promise<{ deduplicated: boolean }> {
  return await rpc(forgeHome, 'task_review_watch_bind', {
    task_id: input.taskId, repo_id: input.repoId,
    github_repository: input.githubRepository, pr_number: input.prNumber,
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

/** Trusted local review/CI ingress. Never authorize merge or provider Send. */
export async function observeWorkflowSupervisorReviewNotice(forgeHome: string, input: WorkflowSupervisorReviewNotice): Promise<{
  eventKey: string; deduplicated: boolean; deferred: boolean;
}> {
  return await rpc(forgeHome, 'task_review_notice', {
    task_id: input.taskId, repo_id: input.repoId, pr_number: input.prNumber,
    reviewed_head_sha: input.reviewedHeadSha, current_head_sha: input.currentHeadSha,
    review_id: input.reviewId, source: input.source, outcome: input.outcome,
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

export async function getWorkflowSupervisorTaskStall(forgeHome: string, taskId: string): Promise<WorkflowSupervisorTaskStall> {
  return await rpc<WorkflowSupervisorTaskStall>(forgeHome, 'task_stall', { task_id: taskId });
}

/** One-way binding of a Work-owned Supervisor task to its canonical Scheduler lane. */
export async function bindWorkflowSupervisorScheduledWake(forgeHome: string, input: {
  taskId: string; repoId: string; workId: string; scheduleId: string;
}): Promise<{ task: WorkflowSupervisorTask; changed: boolean; deduplicated: boolean }> {
  return await rpc(forgeHome, 'task_bind_scheduled_wake', {
    task_id: input.taskId, repo_id: input.repoId, work_id: input.workId, schedule_id: input.scheduleId,
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

/** Scheduler occurrence is the idempotency identity; an unknown send outcome is never replayed. */
export async function wakeWorkflowSupervisorScheduledTask(forgeHome: string, input: {
  taskId: string; scheduleId: string; occurrenceId: string;
}): Promise<{ effect: WorkflowSupervisorEffect; deduplicated: boolean }> {
  return await rpc(forgeHome, 'task_wake_scheduled', {
    task_id: input.taskId, schedule_id: input.scheduleId, occurrence_id: input.occurrenceId,
  }, SUPERVISOR_RPC_MUTATION_TIMEOUT_MS);
}

/**
 * Operator-only conversation migration for a standalone Supervisor task whose
 * exact conversation became permanently unusable. It is explicit and bounded by
 * design: it is never triggered automatically by provider backpressure.
 */
export async function migrateWorkflowSupervisorConversation(forgeHome: string, input: {
  taskId: string; expectedConversationId: string; requestId: string; reason: string; authorizedBy?: string;
} & ({ conversationId: string; conversationUrl: string; fresh?: false } | { fresh: true; conversationId?: never; conversationUrl?: never })
): Promise<{ taskId: string; conversationId: string; conversationUrl: string; migrated: boolean; freshConversation?: boolean }> {
  return await rpc(forgeHome, 'task_migrate_conversation', {
    task_id: input.taskId,
    expected_conversation_id: input.expectedConversationId,
    ...(input.fresh === true ? { fresh: true } : { conversation_id: input.conversationId, conversation_url: input.conversationUrl }),
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

export async function reserveWorkflowSupervisorEnrollment(forgeHome: string, taskId: string, canonicalEffectId?: string): Promise<WorkflowSupervisorEffect> {
  return await rpc<WorkflowSupervisorEffect>(forgeHome, 'reserve_enrollment', {
    task_id: taskId,
    ...(canonicalEffectId?.trim() ? { effect_id: canonicalEffectId.trim() } : {}),
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
