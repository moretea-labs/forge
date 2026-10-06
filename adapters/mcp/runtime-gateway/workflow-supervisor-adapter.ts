import { createHash } from 'node:crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  getWorkflowSupervisorContinuationProof,
  getWorkflowSupervisorTask,
  getWorkflowSupervisorTaskStall,
  listWorkflowSupervisorTasks,
  migrateWorkflowSupervisorConversation,
  recoverWorkflowSupervisorTask,
  registerWorkflowSupervisorTask,
  reserveWorkflowSupervisorEnrollment,
  stopWorkflowSupervisorTask,
} from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome } from '../../../supervisor/paths';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { result } from './result-adapter';

function textArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? String(args[key]).trim() : '';
}

function standaloneTaskId(repoId: string | undefined, requestId: string): string {
  const digest = createHash('sha256').update(`${repoId ?? 'global'}\0${requestId}`).digest('hex').slice(0, 24);
  return `supervisor:${digest}`;
}

export async function callWorkflowSupervisorAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'supervisor_task') return undefined;
  const operation = textArg(args, 'operation');
  const forgeHome = resolveWorkflowSupervisorForgeHome(ctx.controllerHome);
  const repoId = textArg(args, 'repo_id') || ctx.explicitRepository?.repoId || ctx.repoId || undefined;

  if (operation === 'start') {
    const objective = textArg(args, 'objective');
    const requestId = textArg(args, 'request_id');
    if (!objective) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REQUIRED');
    if (!requestId) throw new Error('WORKFLOW_SUPERVISOR_REQUEST_ID_REQUIRED');
    const id = standaloneTaskId(repoId, requestId);
    const task = await registerWorkflowSupervisorTask(forgeHome, {
      taskId: id,
      conversationId: `bootstrap:${id}`,
      conversationUrl: 'https://chatgpt.com/',
      objective,
      completionContract: {
        kind: 'model_semantic_completion',
        ...(repoId ? { repo_id: repoId, controller_home: ctx.controllerHome } : {}),
      },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, ...(repoId ? { repo_id: repoId } : {}) },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, task.taskId);
    return result({ task, effect, summary: `Standalone Supervisor task ${task.taskId} started.` });
  }

  if (operation === 'list') {
    const activeOnly = args.active_only !== false;
    const tasks = await listWorkflowSupervisorTasks(forgeHome, activeOnly);
    return result({ tasks, count: tasks.length, activeOnly, summary: `${tasks.length} Supervisor task(s) listed.` });
  }

  if (operation === 'stop') {
    const id = textArg(args, 'task_id');
    if (!id) throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_REQUIRED');
    const stopped = await stopWorkflowSupervisorTask(forgeHome, id, textArg(args, 'reason') || 'Stopped by operator request.');
    return result({ ...stopped, summary: `Supervisor task ${id} stopped.` });
  }

  if (operation === 'switch_to_fresh_conversation') {
    const id = textArg(args, 'task_id');
    const expectedConversationId = textArg(args, 'expected_conversation_id');
    const requestId = textArg(args, 'request_id');
    const reason = textArg(args, 'reason');
    if (!id) throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_REQUIRED');
    if (!expectedConversationId) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_EXPECTED_CONVERSATION_REQUIRED');
    if (!requestId) throw new Error('WORKFLOW_SUPERVISOR_REQUEST_ID_REQUIRED');
    if (!reason) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_REASON_REQUIRED');
    const migrated = await migrateWorkflowSupervisorConversation(forgeHome, {
      taskId: id, expectedConversationId, requestId, reason, fresh: true,
      authorizedBy: textArg(args, 'authorized_by') || 'operator',
    });
    return result({
      ...migrated,
      status: migrated.migrated ? 'switching_to_fresh_conversation' : 'unchanged',
      summary: migrated.migrated
        ? `Supervisor task ${id} reserved a fresh conversation and will bind it after the enrollment send is observed.`
        : `Supervisor task ${id} conversation was unchanged.`,
    });
  }

  if (operation === 'recover') {
    const id = textArg(args, 'task_id');
    const requestId = textArg(args, 'request_id');
    const reason = textArg(args, 'reason');
    if (!id) throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_REQUIRED');
    if (!requestId) throw new Error('WORKFLOW_SUPERVISOR_REQUEST_ID_REQUIRED');
    if (!reason) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_REASON_REQUIRED');
    const recovered = await recoverWorkflowSupervisorTask(forgeHome, {
      taskId: id,
      sourceEffectId: textArg(args, 'source_effect_id') || undefined,
      requestId,
      reason,
      authorizedBy: textArg(args, 'authorized_by') || 'operator',
      ...(args.supersede_unknown === true ? { supersedeUnknown: true } : {}),
    });
    return result({ ...recovered, summary: `Supervisor task ${id} recovery ${recovered.action}.` });
  }

  if (operation === 'get') {
    const id = textArg(args, 'task_id');
    if (!id) throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_REQUIRED');
    const task = await getWorkflowSupervisorTask(forgeHome, id);
    if (!task) return result({ taskId: id, status: 'not_found', summary: `Supervisor task ${id} not found.` }, true);
    // Derived read-only projection: an effect that exhausted its mechanical
    // retry/resume budget used to make the task silently leave the delivery
    // queue. The stall state names the exact operator action that can move it.
    const stall = await getWorkflowSupervisorTaskStall(forgeHome, id).catch(() => undefined);
    return result({ task, ...(stall ? { stall } : {}), summary: `Supervisor task ${id} retrieved${stall ? ` (${stall.state})` : ''}.` });
  }

  if (operation === 'proof') {
    const activeReleaseId = textArg(args, 'active_release_id');
    const notBefore = textArg(args, 'not_before');
    if (!activeReleaseId) throw new Error('WORKFLOW_SUPERVISOR_PROOF_RELEASE_REQUIRED');
    if (!notBefore) throw new Error('WORKFLOW_SUPERVISOR_PROOF_BOUNDARY_REQUIRED');
    const proof = await getWorkflowSupervisorContinuationProof(forgeHome, { repoId, activeReleaseId, notBefore });
    return result(proof
      ? { proof, summary: `Standalone Supervisor continuation proof found for ${proof.taskId}.` }
      : { status: 'not_found', summary: 'No matching CONTINUE -> CONTINUE -> DONE proof found.' }, !proof);
  }

  throw new Error(`WORKFLOW_SUPERVISOR_OPERATION_INVALID:${operation || '(missing)'}`);
}
