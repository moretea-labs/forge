import { existsSync } from 'node:fs';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  type ChatgptWorkConversationBinding,
} from '../../../adapters/chatgpt/work-conversation-binding-store';
import { readRequirement } from '../control-plane/persistence/requirement-store';
import { registerWorkflowSupervisorTask, reserveWorkflowSupervisorEnrollment } from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';

export type WorkflowSupervisorBoundary =
  | { status: 'not_eligible' | 'conversation_pending' }
  | { status: 'outer_turn'; taskId: string; requirementId: string; conversationId: string; conversationUrl: string };

function taskIdForRequirement(repoId: string, requirementId: string): string {
  return `forge:${repoId}:requirement:${requirementId}`;
}

/**
 * The boundary is derived from canonical lower-layer facts, never copied into
 * Scheduler or ControllerRound state. Once one Requirement-backed Work has an
 * exact ChatGPT conversation, lower layers may prepare/claim ControllerRounds
 * but may no longer submit the next outer assistant turn.
 */
export function workflowSupervisorBoundaryForWork(
  options: { controllerHome: string; repoId: string },
  workId: string,
): WorkflowSupervisorBoundary {
  const work = getWorkContract(options, workId);
  if (!work?.requirementId) return { status: 'not_eligible' };
  const binding = getChatgptWorkConversationBinding(options, workId);
  if (!binding) return { status: 'conversation_pending' };
  return {
    status: 'outer_turn',
    taskId: taskIdForRequirement(options.repoId, work.requirementId),
    requirementId: work.requirementId,
    conversationId: binding.conversationId,
    conversationUrl: binding.conversationUrl,
  };
}

export function inheritWorkflowSupervisorConversationBinding(
  options: { controllerHome: string; repoId: string },
  fromWorkId: string,
  toWorkId: string,
): ChatgptWorkConversationBinding | undefined {
  if (fromWorkId === toWorkId) return getChatgptWorkConversationBinding(options, toWorkId);
  const sourceWork = getWorkContract(options, fromWorkId);
  const targetWork = getWorkContract(options, toWorkId);
  if (!sourceWork?.requirementId || sourceWork.requirementId !== targetWork?.requirementId) return undefined;
  const source = getChatgptWorkConversationBinding(options, fromWorkId);
  if (!source) return undefined;
  const existing = getChatgptWorkConversationBinding(options, toWorkId);
  if (existing) {
    if (existing.conversationId !== source.conversationId) {
      throw new Error(`WORKFLOW_SUPERVISOR_CONVERSATION_CONFLICT:${sourceWork.requirementId}`);
    }
    return existing;
  }
  return bindChatgptWorkConversation(options, {
    workId: toWorkId,
    conversationUrl: source.conversationUrl,
    latestBrowserSessionId: source.latestBrowserSessionId,
    authorizationGrantRefs: source.authorizationGrantRefs,
    localAlias: source.localAlias,
  });
}

export async function ensureWorkflowSupervisorEnrollmentForWork(
  options: { controllerHome: string; repoId: string },
  workId: string,
): Promise<{ status: 'not_eligible' | 'conversation_pending' | 'daemon_unavailable' | 'enrolled'; taskId?: string; effectId?: string }> {
  const boundary = workflowSupervisorBoundaryForWork(options, workId);
  if (boundary.status !== 'outer_turn') return { status: boundary.status };
  const requirement = readRequirement({ controllerHome: options.controllerHome }, boundary.requirementId)?.value;
  if (!requirement) return { status: 'not_eligible' };
  const forgeHome = resolveWorkflowSupervisorForgeHome(options.controllerHome);
  if (!existsSync(workflowSupervisorSocketPath(forgeHome))) return { status: 'daemon_unavailable', taskId: boundary.taskId };
  await registerWorkflowSupervisorTask(forgeHome, {
    taskId: boundary.taskId,
    conversationId: boundary.conversationId,
    conversationUrl: boundary.conversationUrl,
    objective: requirement.outcomeStatement,
    completionContract: {
      kind: 'forge_requirement_done',
      controller_home: options.controllerHome,
      repo_id: options.repoId,
      requirement_id: requirement.requirementId,
    },
    continuationPolicy: {
      kind: 'forge_goal_outer_turn',
      exact_conversation_id: boundary.conversationId,
      exact_conversation_url: boundary.conversationUrl,
      lower_layer_continuation_owner: 'controller_round',
      outer_turn_owner: 'workflow_supervisor',
    },
    userBlockerPolicy: {
      kind: 'forge_requirement_waiting_for_user',
      controller_home: options.controllerHome,
      repo_id: options.repoId,
      requirement_id: requirement.requirementId,
    },
  });
  const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, boundary.taskId);
  return { status: 'enrolled', taskId: boundary.taskId, effectId: effect.effectId };
}
