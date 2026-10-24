import { createHash } from 'node:crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  getWorkflowSupervisorContinuationProof,
  getWorkflowSupervisorTask,
  bindWorkflowSupervisorReviewWatch,
  observeWorkflowSupervisorReviewNotice,
  getWorkflowSupervisorTaskStall,
  listWorkflowSupervisorTasks,
  listWorkflowSupervisorTerminalTasks,
  migrateWorkflowSupervisorConversation,
  recoverWorkflowSupervisorTask,
  registerWorkflowSupervisorTask,
  reviseWorkflowSupervisorTaskObjective,
  reserveWorkflowSupervisorEnrollment,
  stopWorkflowSupervisorTask,
} from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome } from '../../../supervisor/paths';
import { workflowSupervisorCompletionContractSha256 } from '../../../supervisor/store';
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
    const workId = textArg(args, 'work_id');
    const requirementId = textArg(args, 'requirement_id');
    if (workId && requirementId) throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_AMBIGUOUS');
    if ((workId || requirementId) && !repoId) throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_REPO_REQUIRED');
    const id = standaloneTaskId(repoId, requestId);
    const task = await registerWorkflowSupervisorTask(forgeHome, {
      taskId: id,
      conversationId: `bootstrap:${id}`,
      conversationUrl: 'https://chatgpt.com/',
      objective,
      completionContract: {
        kind: 'model_semantic_completion',
        ...(repoId ? { repo_id: repoId, controller_home: ctx.controllerHome } : {}),
        ...(workId ? { work_id: workId } : {}),
        ...(requirementId ? { requirement_id: requirementId } : {}),
      },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, ...(repoId ? { repo_id: repoId } : {}) },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, task.taskId);
    return result({ task, effect, summary: `Standalone Supervisor task ${task.taskId} started.` });
  }

  if (operation === 'review_watch_bind') {
    const taskId = textArg(args, 'task_id');
    const githubRepository = textArg(args, 'github_repository');
    if (!taskId || !repoId) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_WATCH_IDENTITY_REQUIRED');
    const bound = await bindWorkflowSupervisorReviewWatch(forgeHome, {
      taskId, repoId, githubRepository, prNumber: Number(args.pr_number),
    });
    return result({ ...bound, status: 'original_task_watch_bound', taskId,
      summary: 'Only the original Supervisor will observe this exact PR using the existing maintenance loop; no Send or merge was authorized.',
    });
  }

  if (operation === 'review_notice') {
    const taskId = textArg(args, 'task_id');
    if (!taskId) throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_REQUIRED');
    // Reviewers notify an existing task only. This never creates a Work,
    // Supervisor or GitHub merge permission; only a later original CONTINUE
    // can consume this signal under its canonical effect CAS.
    if (!repoId) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_REPOSITORY_REQUIRED');
    const receipt = await observeWorkflowSupervisorReviewNotice(forgeHome, {
      taskId, repoId,
      prNumber: Number(args.pr_number),
      reviewedHeadSha: textArg(args, 'reviewed_head_sha'),
      currentHeadSha: textArg(args, 'current_head_sha'),
      reviewId: textArg(args, 'review_id'),
      source: textArg(args, 'review_source') as 'github_review' | 'github_ci' | 'independent_reviewer',
      outcome: textArg(args, 'review_outcome') as 'ACCEPT' | 'REVISE' | 'BLOCK' | 'CI_FAILED' | 'CI_PASSED',
    });
    return result({ ...receipt, taskId, status: 'recorded_for_original_writer',
      summary: `Review/CI notification is journaled for original Supervisor ${taskId}; no approval/merge authority or extra Send was granted.` });
  }

  if (operation === 'list') {
    if (args.terminal_only === true) {
      const terminalTasks = await listWorkflowSupervisorTerminalTasks(forgeHome);
      return result({ terminalTasks, count: terminalTasks.length, terminalOnly: true, summary: `${terminalTasks.length} canonically terminal Supervisor task(s) in retained history; conversations are not archived or deleted.` });
    }
    const activeOnly = args.active_only !== false;
    const tasks = await listWorkflowSupervisorTasks(forgeHome, activeOnly);
    return result({ tasks, count: tasks.length, activeOnly, summary: `${tasks.length} Supervisor task(s) listed.` });
  }

  if (operation === 'revise') {
    const id = textArg(args, 'task_id');
    const objective = textArg(args, 'objective');
    const expectedObjectiveSha256 = textArg(args, 'expected_objective_sha256');
    const expectedCompletionContractSha256 = textArg(args, 'expected_completion_contract_sha256');
    const workId = textArg(args, 'work_id');
    const requirementId = textArg(args, 'requirement_id');
    const requestId = textArg(args, 'request_id');
    if (!id) throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_REQUIRED');
    if (!objective) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REQUIRED');
    if (!expectedObjectiveSha256) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_EXPECTED_SHA_REQUIRED');
    if (!requestId) throw new Error('WORKFLOW_SUPERVISOR_REQUEST_ID_REQUIRED');
    if (workId && requirementId) throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_TARGET_INVALID');
    if ((workId || requirementId) && !expectedCompletionContractSha256) throw new Error('WORKFLOW_SUPERVISOR_COMPLETION_CONTRACT_REVISION_EXPECTED_SHA_REQUIRED');
    if (!(workId || requirementId) && expectedCompletionContractSha256) throw new Error('WORKFLOW_SUPERVISOR_COMPLETION_CONTRACT_REVISION_TARGET_REQUIRED');
    const revised = await reviseWorkflowSupervisorTaskObjective(forgeHome, {
      taskId: id,
      objective,
      expectedObjectiveSha256,
      requestId,
      ...(workId ? { workId } : {}),
      ...(requirementId ? { requirementId } : {}),
      ...(expectedCompletionContractSha256 ? { expectedCompletionContractSha256 } : {}),
      authorizedBy: textArg(args, 'authorized_by') || 'operator',
    });
    const bindingSummary = workId || requirementId
      ? `; semantic completion binding ${revised.semanticBindingChanged ? 'revised' : 'confirmed'}`
      : '';
    return result({ ...revised, summary: `Supervisor task ${id} objective ${revised.changed ? 'revised' : 'confirmed'} in place${bindingSummary}.` });
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
    // Report elapsed silence instead of implying that activity equals progress.
    // The text is informational only; it never authorizes another provider Send.
    const silentTurn = stall && 'silentTurn' in stall ? stall.silentTurn : undefined;
    const silenceSummary = silentTurn
      ? ` No visible provider output for ${Math.max(1, Math.round(silentTurn.elapsedMs / 60_000))}m while the provider still reports ${silentTurn.providerState}; review is due at ${silentTurn.recoveryReviewAt}, and silence alone never authorizes a resend.`
      : '';
    return result({ task, completionContractSha256: workflowSupervisorCompletionContractSha256(task.completionContract), ...(stall ? { stall } : {}), summary: `Supervisor task ${id} retrieved${stall ? ` (${stall.state})` : ''}; canonical completion-contract CAS fingerprint included.${silenceSummary}` });
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
