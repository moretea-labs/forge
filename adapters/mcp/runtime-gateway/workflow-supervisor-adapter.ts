import { createHash } from 'node:crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  getWorkflowSupervisorContinuationProof,
  getWorkflowSupervisorTask,
  registerWorkflowSupervisorTask,
  reserveWorkflowSupervisorEnrollment,
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
      completionContract: { kind: 'model_semantic_completion', ...(repoId ? { repo_id: repoId } : {}) },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, ...(repoId ? { repo_id: repoId } : {}) },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, task.taskId);
    return result({ task, effect, summary: `Standalone Supervisor task ${task.taskId} started.` });
  }

  if (operation === 'get') {
    const id = textArg(args, 'task_id');
    if (!id) throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_REQUIRED');
    const task = await getWorkflowSupervisorTask(forgeHome, id);
    return result(task
      ? { task, summary: `Supervisor task ${id} retrieved.` }
      : { taskId: id, status: 'not_found', summary: `Supervisor task ${id} not found.` }, !task);
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
