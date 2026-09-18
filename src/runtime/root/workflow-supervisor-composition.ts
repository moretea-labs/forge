import { existsSync } from 'node:fs';
import { getWorkContract, isTerminalWorkContractStatus } from '../../../packages/kernel/work/api/index';
import {
  beginControllerRoundRelayAfterRelease,
  getControllerSession,
  getRequirementControllerRoundRelay,
  getRetainedControllerSession,
  releaseObservedControllerSession,
  reconcileControllerRoundAfterTerminalWork,
  settleControllerRoundAfterTurn,
} from '../../../packages/kernel/controller/api/index';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  type ChatgptWorkConversationBinding,
} from '../../../adapters/chatgpt/work-conversation-binding-store';
import { readRequirement } from '../control-plane/persistence/requirement-store';
import { registerWorkflowSupervisorTask, reserveWorkflowSupervisorEnrollment } from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';
import type { WorkflowSupervisorCompletion, WorkflowSupervisorLifecycleHooks, WorkflowSupervisorTask, WorkflowSupervisorTurnSettlement } from '../../../supervisor/types';

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

function workflowSupervisorContractText(task: WorkflowSupervisorTask, key: string): string | undefined {
  const value = task.completionContract[key] ?? task.userBlockerPolicy[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function settleForgeWorkflowSupervisorTurn(
  controllerHome: string,
  task: WorkflowSupervisorTask,
  completion: WorkflowSupervisorCompletion,
): Promise<WorkflowSupervisorTurnSettlement> {
  const repoId = workflowSupervisorContractText(task, 'repo_id');
  const requirementId = workflowSupervisorContractText(task, 'requirement_id');
  const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
  if (!repoId || !requirementId || !taskControllerHome) return { continuationAllowed: true };
  if (taskControllerHome !== controllerHome) throw new Error('WORKFLOW_SUPERVISOR_CONTROLLER_HOME_MISMATCH');

  const store = { controllerHome, repoId };
  let relay = getRequirementControllerRoundRelay(store, requirementId);
  if (!relay) return { continuationAllowed: false, reason: 'CONTROLLER_ROUND_REQUIREMENT_RELAY_MISSING' };

  const settledWorkId = relay.originWorkId;
  if (relay.status === 'claimed') {
    relay = settleControllerRoundAfterTurn(store, {
      workId: settledWorkId,
      completionEvidenceId: completion.completionFingerprint,
    }) ?? relay;
  }

  const liveOwner = getControllerSession(store, settledWorkId);
  const releaseWitness = liveOwner ?? getRetainedControllerSession(store, settledWorkId);
  if (liveOwner && ['pending_release', 'waiting', 'waiting_for_user', 'goal_complete', 'blocked', 'failed'].includes(relay.status)) {
    const released = releaseObservedControllerSession(store, {
      workId: settledWorkId,
      actor: `workflow-supervisor-turn-settled:${completion.completionFingerprint}`,
      owner: liveOwner,
    });
    if (!released.allowed) {
      return { continuationAllowed: false, reason: `CONTROLLER_SESSION_RELEASE_FENCED:${released.reason}` };
    }
  }

  if (relay.status === 'pending_release') {
    if (!releaseWitness) return { continuationAllowed: false, reason: 'CONTROLLER_SESSION_RELEASE_WITNESS_MISSING' };
    relay = beginControllerRoundRelayAfterRelease(store, {
      workId: settledWorkId,
      releasedSession: releaseWitness,
    }) ?? relay;
  }

  if (relay.status !== 'dispatching' || !relay.authorityId) {
    return {
      continuationAllowed: false,
      reason: `CONTROLLER_ROUND_NOT_READY_FOR_OUTER_CONTINUATION:${relay.status}${relay.blockedReason ? `:${relay.blockedReason}` : ''}`,
    };
  }

  if (relay.originWorkId !== settledWorkId) {
    inheritWorkflowSupervisorConversationBinding(store, settledWorkId, relay.originWorkId);
  }
  const continuationContext = [
    `Exact lower-layer ControllerRound prepared for Work ${relay.originWorkId} in repo ${repoId}.`,
    `controller_authority_id=${relay.authorityId}`,
    `relay_scope_id=${relay.relayScopeId}`,
    `Before any repository mutation, call rh_work operation=controller_claim for exact Work ${relay.originWorkId} with this exact authority pair.`,
    'Reuse the same controller_authority_id and relay_scope_id for continue/verify/review/finalize/stop/controller_release in this round.',
    'Never mint a replacement authority and never substitute a transport session id.',
  ].join('\n');
  return { continuationAllowed: true, continuationContext };
}

export function resolveWorkflowSupervisorChatgptDelivery(
  controllerHome: string,
  task: WorkflowSupervisorTask,
): { repoId: string; workId: string; browserSessionId: string; conversationUrl: string; authorizationGrantRefs: string[] } {
  const repoId = workflowSupervisorContractText(task, 'repo_id');
  const requirementId = workflowSupervisorContractText(task, 'requirement_id');
  const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
  if (!repoId || !requirementId || !taskControllerHome) throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_DELIVERY_CONTRACT_INCOMPLETE');
  if (taskControllerHome !== controllerHome) throw new Error('WORKFLOW_SUPERVISOR_CONTROLLER_HOME_MISMATCH');
  const store = { controllerHome, repoId };
  const relay = getRequirementControllerRoundRelay(store, requirementId);
  if (!relay) throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_DELIVERY_RELAY_MISSING');
  const binding = getChatgptWorkConversationBinding(store, relay.originWorkId);
  if (!binding || binding.conversationId !== task.conversationId || binding.conversationUrl !== task.conversationUrl) {
    throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_DELIVERY_BINDING_MISMATCH');
  }
  if (!binding.latestBrowserSessionId?.trim()) throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_BROWSER_SESSION_MISSING');
  return {
    repoId,
    workId: relay.originWorkId,
    browserSessionId: binding.latestBrowserSessionId,
    conversationUrl: binding.conversationUrl,
    authorizationGrantRefs: [...(binding.authorizationGrantRefs ?? [])],
  };
}
function forgeWorkflowSupervisorBrowserTaskActive(controllerHome: string, task: WorkflowSupervisorTask): boolean {
  const repoId = workflowSupervisorContractText(task, 'repo_id');
  const requirementId = workflowSupervisorContractText(task, 'requirement_id');
  const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
  if (!repoId || !requirementId || !taskControllerHome) return true;
  if (taskControllerHome !== controllerHome) return false;
  const requirement = readRequirement({ controllerHome }, requirementId)?.value;
  if (!requirement || requirement.state === 'done' || requirement.state === 'cancelled') return false;
  const store = { controllerHome, repoId };
  let relay = getRequirementControllerRoundRelay(store, requirementId);
  if (!relay) return false;
  const work = getWorkContract(store, relay.originWorkId);
  if (!work) return false;
  if (isTerminalWorkContractStatus(work.status)) {
    if (work.status === 'failed' || work.status === 'cancelled') {
      try {
        relay = reconcileControllerRoundAfterTerminalWork(store, { workId: work.workId, actor: `workflow-supervisor-task-reconcile:${task.taskId}` }) ?? relay;
      } catch {
        return false;
      }
    }
    return false;
  }
  return relay.status !== 'failed';
}

export function forgeWorkflowSupervisorLifecycleHooks(controllerHome: string): WorkflowSupervisorLifecycleHooks {
  return {
    browserTaskActive: (task) => forgeWorkflowSupervisorBrowserTaskActive(controllerHome, task),
    assistantTurnCommitted: (task, completion) => settleForgeWorkflowSupervisorTurn(controllerHome, task, completion),
  };
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
