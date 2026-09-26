import { existsSync } from 'node:fs';
import { getRepository } from '../../cli/repositories/registry';
import { getWorkContract, semanticWorkState } from '../../../packages/kernel/work/api/index';
import {
  beginControllerRoundRelayAfterRelease,
  controllerRoundProviderEffectId,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
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
import { withControlPlaneReadDatabase } from '../control-plane/persistence/sqlite-store';
import { getWorkflowSupervisorCurrentConversation, registerWorkflowSupervisorTask, reserveWorkflowSupervisorEnrollment } from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';
import type { WorkflowSupervisorCompletion, WorkflowSupervisorLifecycleHooks, WorkflowSupervisorTask, WorkflowSupervisorTurnSettlement } from '../../../supervisor/types';

export type WorkflowSupervisorBoundary =
  | { status: 'not_eligible' }
  | { status: 'conversation_pending'; reason: 'EXACT_WORK_CONVERSATION_BINDING_REQUIRED' }
  | { status: 'outer_turn'; taskId: string; workId?: string; requirementId?: string; conversationId: string; conversationUrl: string };

export type WorkflowSupervisorEnrollmentStatus =
  | 'not_eligible'
  | 'conversation_pending'
  | 'current_conversation_unbound'
  | 'daemon_unavailable'
  | 'enrolled'
  | 'lower_layer_not_ready';

export function workflowSupervisorLowerLayerReadyForWork(
  options: { controllerHome: string; repoId: string },
  workId: string,
): { ready: true; workId: string; providerEffectId: string } | { ready: false; reason: string } {
  const directRelay = getControllerRoundRelay(options, workId);
  const work = getWorkContract(options, workId);
  const relay = directRelay ?? (work?.requirementId ? getRequirementControllerRoundRelay(options, work.requirementId) : undefined);
  if (!relay) return { ready: false, reason: 'CONTROLLER_ROUND_NOT_PREPARED' };
  if (!relay.authorityId?.trim()) return { ready: false, reason: `CONTROLLER_ROUND_AUTHORITY_REQUIRED:${relay.originWorkId}` };
  if (!['dispatching', 'dispatched', 'claimed'].includes(relay.status)) {
    return { ready: false, reason: `CONTROLLER_ROUND_NOT_DISPATCHABLE:${relay.status}:${relay.blockedReason ?? relay.originWorkId}` };
  }
  return {
    ready: true,
    workId: relay.originWorkId,
    providerEffectId: relay.providerDispatchEffectId ?? controllerRoundProviderEffectId(relay),
  };
}

function taskIdForConversation(repoId: string, conversationId: string): string {
  return `forge:${repoId}:conversation:${conversationId}`;
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
  if (!work || semanticWorkState(work) !== 'open') return { status: 'not_eligible' };
  const binding = getChatgptWorkConversationBinding(options, workId);
  if (!binding) return { status: 'conversation_pending', reason: 'EXACT_WORK_CONVERSATION_BINDING_REQUIRED' };
  return {
    status: 'outer_turn',
    taskId: taskIdForConversation(options.repoId, binding.conversationId),
    workId: work.workId,
    ...(work.requirementId ? { requirementId: work.requirementId } : {}),
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
  // Requirement membership is goal identity, not conversation lineage. Only an
  // explicit Work predecessor edge proves that the successor belongs to the
  // same logical controller conversation. Sibling Works must bind their own
  // current conversation instead of silently reusing historical delivery.
  if (targetWork?.predecessorWorkId?.trim() !== fromWorkId) return undefined;
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
  const workId = workflowSupervisorContractText(task, 'work_id');
  const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
  const workRequirementId = repoId && workId && taskControllerHome === controllerHome
    ? getWorkContract({ controllerHome, repoId }, workId)?.requirementId
    : undefined;
  // Legacy completions may still carry activeScope, but current execution derives
  // Requirement identity from the task/Work authority whenever possible.
  const legacyRequirementId = completion.proposal.activeScope?.startsWith('requirement:') ? completion.proposal.activeScope.slice('requirement:'.length).trim() : undefined;
  const requirementId = workflowSupervisorContractText(task, 'requirement_id') ?? workRequirementId ?? legacyRequirementId;
  if (!repoId || (!requirementId && !workId) || !taskControllerHome) return { continuationAllowed: false, reason: 'WORKFLOW_SUPERVISOR_ACTIVE_WORK_SCOPE_REQUIRED' };
  if (taskControllerHome !== controllerHome) throw new Error('WORKFLOW_SUPERVISOR_CONTROLLER_HOME_MISMATCH');

  const store = { controllerHome, repoId };
  let relay = requirementId
    ? getRequirementControllerRoundRelay(store, requirementId)
    : getControllerRoundRelay(store, workId!);
  if (!relay) return { continuationAllowed: false, reason: 'CONTROLLER_ROUND_WORK_RELAY_MISSING' };

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
    `Exact lower-layer continuation is prepared for Work ${relay.originWorkId} in repo ${repoId}.`,
    `controller_authority_id=${relay.authorityId}`,
    `relay_scope_id=${relay.relayScopeId}`,
    `Current frozen Runtime may require this exact authority pair for the mechanical controller_claim/continuation/release envelope for Work ${relay.originWorkId}.`,
    'Treat ControllerRound identity as resume/transport bookkeeping only. Re-read current Requirement/Plan/Work/UserRequest facts and use canonical stable-id + expected_revision semantic operations; do not invent mandatory verify/review/finalize/PlanStep lifecycle from this authority.',
    'Never mint a replacement continuation authority and never substitute a transport session id.',
  ].join('\n');
  return {
    continuationAllowed: true,
    continuationContext,
    continuationEffectId: relay.providerDispatchEffectId ?? controllerRoundProviderEffectId(relay),
  };
}

export function resolveWorkflowSupervisorChatgptDelivery(
  controllerHome: string,
  task: WorkflowSupervisorTask,
): { repoId: string; workId: string; browserSessionId: string; conversationUrl: string; authorizationGrantRefs: string[] } {
  const repoId = workflowSupervisorContractText(task, 'repo_id');
  const requirementId = workflowSupervisorContractText(task, 'requirement_id');
  const workId = workflowSupervisorContractText(task, 'work_id');
  const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
  if (!repoId || (!requirementId && !workId) || !taskControllerHome) throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_DELIVERY_CONTRACT_INCOMPLETE');
  if (taskControllerHome !== controllerHome) throw new Error('WORKFLOW_SUPERVISOR_CONTROLLER_HOME_MISMATCH');
  const store = { controllerHome, repoId };
  const relay = requirementId
    ? getRequirementControllerRoundRelay(store, requirementId)
    : getControllerRoundRelay(store, workId!);
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
function workflowSupervisorWorkRecordRevision(controllerHome: string, repoId: string, workId: string): number | undefined {
  return withControlPlaneReadDatabase(controllerHome, (database) => {
    const statement = database.prepare(`
      SELECT revision FROM control_plane_records
      WHERE namespace = 'work_contract' AND scope = ? AND record_key = ?
    `);
    try {
      const row = statement.get(repoId, workId) as { revision?: number } | undefined;
      const revision = Number(row?.revision);
      return Number.isInteger(revision) && revision > 0 ? revision : undefined;
    } finally {
      statement.finalize?.();
    }
  });
}

function createForgeWorkflowSupervisorBrowserTaskActive(controllerHome: string): (task: WorkflowSupervisorTask) => boolean {
  const workStateById = new Map<string, { revision: number; active: boolean }>();
  const lowerLayerNotReadyUntilByTask = new Map<string, number>();
  const LOWER_LAYER_NOT_READY_CACHE_MS = 5_000;
  return (task) => {
    const repoId = workflowSupervisorContractText(task, 'repo_id');
    const requirementId = workflowSupervisorContractText(task, 'requirement_id');
    const workId = workflowSupervisorContractText(task, 'work_id');
    const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
    if (!repoId || (!requirementId && !workId) || !taskControllerHome) return false;
    if (taskControllerHome !== controllerHome) return false;
    const nowMs = Date.now();
    const lowerLayerNotReadyUntil = lowerLayerNotReadyUntilByTask.get(task.taskId) ?? 0;
    if (lowerLayerNotReadyUntil > nowMs) return false;
    lowerLayerNotReadyUntilByTask.delete(task.taskId);
    const requirement = requirementId ? readRequirement({ controllerHome }, requirementId)?.value : undefined;
    if (requirementId && (!requirement || requirement.state === 'done' || requirement.state === 'cancelled')) {
      lowerLayerNotReadyUntilByTask.set(task.taskId, nowMs + LOWER_LAYER_NOT_READY_CACHE_MS);
      return false;
    }
    const store = { controllerHome, repoId };
    let relay = requirementId
      ? getRequirementControllerRoundRelay(store, requirementId)
      : getControllerRoundRelay(store, workId!);
    if (!relay || relay.status === 'failed') {
      lowerLayerNotReadyUntilByTask.set(task.taskId, nowMs + LOWER_LAYER_NOT_READY_CACHE_MS);
      return false;
    }
    if (!workflowSupervisorLowerLayerReadyForWork(store, relay.originWorkId).ready) {
      // A blocked/paused lower layer must not make the native adapter rescan
      // the full Controller record set every second. The next Scheduler or
      // Controller transition is still observed within this bounded TTL.
      lowerLayerNotReadyUntilByTask.set(task.taskId, nowMs + LOWER_LAYER_NOT_READY_CACHE_MS);
      return false;
    }
    const revision = workflowSupervisorWorkRecordRevision(controllerHome, repoId, relay.originWorkId);
    if (!revision) {
      lowerLayerNotReadyUntilByTask.set(task.taskId, nowMs + LOWER_LAYER_NOT_READY_CACHE_MS);
      return false;
    }
    const work = getWorkContract(store, relay.originWorkId);
    if (!work) {
      lowerLayerNotReadyUntilByTask.set(task.taskId, nowMs + LOWER_LAYER_NOT_READY_CACHE_MS);
      return false;
    }
    const semanticState = semanticWorkState(work);
    if (semanticState !== 'open') {
      if (semanticState === 'cancelled') {
        try {
          relay = reconcileControllerRoundAfterTerminalWork(store, { workId: work.workId, actor: `workflow-supervisor-task-reconcile:${task.taskId}` }) ?? relay;
        } catch {
          return false;
        }
      }
      workStateById.set(work.workId, { revision, active: false });
      return false;
    }
    // A Work may deliberately CAS-rebind from an interactive/control
    // conversation onto a fresh autonomous execution conversation. Requirement
    // scope alone is not enough to keep the predecessor task alive: only the
    // Work's current exact conversation boundary may own browser delivery.
    // Check this before consulting the Work-revision cache because a conversation
    // rebind does not have to mutate the WorkContract revision.
    const boundary = workflowSupervisorBoundaryForWork(store, relay.originWorkId);
    if (boundary.status !== 'outer_turn'
      || boundary.conversationId !== task.conversationId
      || boundary.conversationUrl !== task.conversationUrl) return false;
    const cached = workStateById.get(relay.originWorkId);
    if (cached?.revision === revision) return cached.active;
    workStateById.set(work.workId, { revision, active: true });
    return true;
  };
}

export function forgeWorkflowSupervisorLifecycleHooks(controllerHome: string): WorkflowSupervisorLifecycleHooks {
  const browserTaskActive = createForgeWorkflowSupervisorBrowserTaskActive(controllerHome);
  return {
    projectScopeForTask: (task) => {
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId || !taskControllerHome || taskControllerHome !== controllerHome) return undefined;
      try {
        const repository = getRepository(repoId, controllerHome);
        return { title: repository.displayName, repoId, controllerHome };
      } catch { return undefined; }
    },
    browserTaskActive,
    effectApplied: (task, effect, observation) => {
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const requirementId = workflowSupervisorContractText(task, 'requirement_id');
      const workId = workflowSupervisorContractText(task, 'work_id');
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId || (!requirementId && !workId) || taskControllerHome !== controllerHome) return;
      const store = { controllerHome, repoId };
      const relay = requirementId
        ? getRequirementControllerRoundRelay(store, requirementId)
        : getControllerRoundRelay(store, workId!);
      if (!relay || relay.status !== 'dispatching') return;
      const boundary = workflowSupervisorBoundaryForWork(store, relay.originWorkId);
      if (boundary.status !== 'outer_turn' || boundary.taskId !== task.taskId || boundary.conversationId !== task.conversationId) return;
      finishControllerRoundRelayDispatch(store, {
        workId: relay.originWorkId,
        ok: true,
        providerDispatchEffectId: effect.effectId,
        providerDispatchReceiptId: `workflow-supervisor:${effect.effectId}:${observation.observationId}`,
      });
    },
    assistantTurnCommitted: (task, completion) => settleForgeWorkflowSupervisorTurn(controllerHome, task, completion),
  };
}
export async function workflowSupervisorCurrentConversationMatchesWork(
  options: { controllerHome: string; repoId: string },
  workId: string,
): Promise<boolean> {
  const boundary = workflowSupervisorBoundaryForWork(options, workId);
  if (boundary.status !== 'outer_turn') return false;
  const forgeHome = resolveWorkflowSupervisorForgeHome(options.controllerHome);
  if (!existsSync(workflowSupervisorSocketPath(forgeHome))) return false;
  try {
    const current = await getWorkflowSupervisorCurrentConversation(forgeHome);
    return Boolean(current
      && current.conversationId === boundary.conversationId
      && current.canonicalUrl === boundary.conversationUrl);
  } catch {
    return false;
  }
}

export async function bindCurrentWorkflowSupervisorConversationForWork(
  options: { controllerHome: string; repoId: string },
  workId: string,
): Promise<
  | { status: 'bound'; binding: ChatgptWorkConversationBinding }
  | { status: 'not_eligible' | 'current_conversation_unbound' | 'daemon_unavailable'; reason?: string }
> {
  const work = getWorkContract(options, workId);
  if (!work || semanticWorkState(work) !== 'open') return { status: 'not_eligible' };
  const forgeHome = resolveWorkflowSupervisorForgeHome(options.controllerHome);
  if (!existsSync(workflowSupervisorSocketPath(forgeHome))) return { status: 'daemon_unavailable', reason: 'WORKFLOW_SUPERVISOR_DAEMON_UNAVAILABLE' };
  const current = await getWorkflowSupervisorCurrentConversation(forgeHome);
  if (!current) return { status: 'current_conversation_unbound', reason: 'WORKFLOW_SUPERVISOR_CURRENT_CONVERSATION_UNBOUND' };
  const existing = getChatgptWorkConversationBinding(options, workId);
  if (existing && existing.conversationId !== current.conversationId) {
    throw new Error(`WORKFLOW_SUPERVISOR_CURRENT_CONVERSATION_CONFLICT:${workId}:${existing.conversationId}:${current.conversationId}`);
  }
  const binding = existing ?? bindChatgptWorkConversation(options, {
    workId,
    conversationUrl: current.canonicalUrl,
    localAlias: current.title,
  });
  return { status: 'bound', binding };
}

export async function ensureWorkflowSupervisorEnrollmentForWork(
  options: { controllerHome: string; repoId: string },
  workId: string,
  input: { schedulerRecoveryKey?: string } = {},
): Promise<{ status: WorkflowSupervisorEnrollmentStatus; taskId?: string; effectId?: string; reason?: string }> {
  const boundary = workflowSupervisorBoundaryForWork(options, workId);
  if (boundary.status !== 'outer_turn') {
    return { status: boundary.status, ...('reason' in boundary ? { reason: boundary.reason } : {}) };
  }
  const forgeHome = resolveWorkflowSupervisorForgeHome(options.controllerHome);
  if (!existsSync(workflowSupervisorSocketPath(forgeHome))) return { status: 'daemon_unavailable', taskId: boundary.taskId };
  const lowerLayer = workflowSupervisorLowerLayerReadyForWork(options, workId);
  if (!lowerLayer.ready) return { status: 'lower_layer_not_ready', reason: lowerLayer.reason };
  const requirement = boundary.requirementId
    ? readRequirement({ controllerHome: options.controllerHome }, boundary.requirementId)?.value
    : undefined;
  const registeredTask = await registerWorkflowSupervisorTask(forgeHome, {
    taskId: boundary.taskId,
    conversationId: boundary.conversationId,
    conversationUrl: boundary.conversationUrl,
    objective: requirement?.outcomeStatement ?? getWorkContract(options, boundary.workId ?? workId)?.objective ?? (boundary.workId ?? workId),
    completionContract: {
      kind: requirement ? 'forge_requirement_done' : 'forge_work_done',
      controller_home: options.controllerHome,
      repo_id: options.repoId,
      ...(requirement ? { requirement_id: requirement.requirementId } : { work_id: boundary.workId ?? workId }),
    },
    continuationPolicy: {
      kind: 'forge_goal_outer_turn',
      exact_conversation_id: boundary.conversationId,
      exact_conversation_url: boundary.conversationUrl,
      lower_layer_continuation_owner: 'controller_round',
      outer_turn_owner: 'workflow_supervisor',
    },
    userBlockerPolicy: {
      kind: requirement ? 'forge_requirement_waiting_for_user' : 'forge_work_waiting_for_user',
      controller_home: options.controllerHome,
      repo_id: options.repoId,
      ...(requirement ? { requirement_id: requirement.requirementId } : { work_id: boundary.workId ?? workId }),
    },
  });
  const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, registeredTask.taskId, lowerLayer.providerEffectId);
  return { status: 'enrolled', taskId: registeredTask.taskId, effectId: effect.effectId };
}
