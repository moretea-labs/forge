import { existsSync } from 'node:fs';
import { getRepository } from '../../cli/repositories/registry';
import { getWorkContract, semanticWorkState, workSemanticView } from '../../../packages/kernel/work/api/index';
import {
  beginControllerRoundRelayAfterRelease,
  claimControllerRoundSession,
  controllerRoundBlockerClass,
  controllerRoundProviderEffectId,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getControllerSession,
  getRequirementControllerRoundRelay,
  getRetainedControllerSession,
  releaseObservedControllerSession,
  reconcileControllerRoundAfterTerminalWork,
  rearmControllerRoundAfterContinuationEvidence,
  settleControllerRoundAfterTurn,
} from '../../../packages/kernel/controller/api/index';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  type ChatgptWorkConversationBinding,
} from '../../../adapters/chatgpt/work-conversation-binding-store';
import { readRequirement } from '../control-plane/persistence/requirement-store';
import { getWorkflowSupervisorCurrentConversation, registerWorkflowSupervisorTask, reserveWorkflowSupervisorEnrollment } from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';
import type { WorkflowSupervisorCompletion, WorkflowSupervisorLifecycleHooks, WorkflowSupervisorTask, WorkflowSupervisorTurnSettlement } from '../../../supervisor/types';
import { getRuntimeWriteClaim } from './write-fence';

export type WorkflowSupervisorBoundary =
  | { status: 'not_eligible' }
  | { status: 'conversation_pending'; reason: 'EXACT_WORK_CONVERSATION_BINDING_REQUIRED' }
  | { status: 'outer_turn'; workId?: string; requirementId?: string; conversationId: string; conversationUrl: string };

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
  const outcomeUnknownEffectAwaitingObservation = relay.status === 'blocked'
    && controllerRoundBlockerClass(relay) === 'provider_dispatch_outcome_unknown'
    && (relay.providerDispatchAttempt ?? 0) > 0
    && Boolean(relay.providerDispatchEffectId?.trim());
  if (!['dispatching', 'dispatched', 'claimed'].includes(relay.status) && !outcomeUnknownEffectAwaitingObservation) {
    return { ready: false, reason: `CONTROLLER_ROUND_NOT_DISPATCHABLE:${relay.status}:${relay.blockedReason ?? relay.originWorkId}` };
  }
  return {
    ready: true,
    workId: relay.originWorkId,
    providerEffectId: relay.providerDispatchEffectId ?? controllerRoundProviderEffectId(relay),
  };
}

function taskIdForWork(repoId: string, workId: string): string {
  return `forge:${repoId}:work:${workId}`;
}
export function getWorkflowSupervisorConversationBindingForWork(
  options: { controllerHome: string; repoId: string },
  workId: string,
): ChatgptWorkConversationBinding | undefined {
  return getChatgptWorkConversationBinding(options, workId);
}

export function bindWorkflowSupervisorConversationForWork(
  options: { controllerHome: string; repoId: string },
  input: { workId: string; conversationUrl: string; localAlias?: string },
): ChatgptWorkConversationBinding {
  return bindChatgptWorkConversation(options, input);
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

function workflowSupervisorProjectAliases(task: WorkflowSupervisorTask): string[] {
  const requirementId = workflowSupervisorContractText(task, 'requirement_id');
  if (!requirementId) return [];
  // Requirement ids intentionally carry the product key before the structural
  // suffix. ChatGPT Project slugs may insert word separators (for example
  // shenbaobao -> shen-bao-bao), so the browser adapter compares compact ids.
  const productKey = /^REQ-([a-z0-9]{4,})-/i.exec(requirementId.trim())?.[1];
  return productKey ? [productKey] : [];
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
  let liveOwner = getControllerSession(store, settledWorkId);
  if (relay.status === 'dispatched') {
    const retained = liveOwner ?? getRetainedControllerSession(store, settledWorkId);
    if (!retained) {
      return { continuationAllowed: false, reason: 'CONTROLLER_SESSION_COMPLETION_CLAIM_WITNESS_MISSING' };
    }
    const claimed = claimControllerRoundSession(store, {
      workId: settledWorkId,
      relayWorkId: settledWorkId,
      sessionClaim: {
        workId: settledWorkId,
        controllerId: retained.controllerId,
        controllerType: retained.controllerType,
        sessionId: retained.sessionId,
        principalId: retained.principalId?.trim() || retained.controllerId,
        controllerInstanceId: retained.controllerInstanceId?.trim() || relay.controllerInstanceId,
        leaseMs: 60_000,
      },
    });
    relay = claimed.relay ?? relay;
    liveOwner = claimed.session;
  }
  if (relay.status === 'claimed') {
    relay = settleControllerRoundAfterTurn(store, {
      workId: settledWorkId,
      completionEvidenceId: completion.completionFingerprint,
    }) ?? relay;
  }

  liveOwner = getControllerSession(store, settledWorkId);
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

  let continuationNeedsFreshSupervisorEffect = false;
  const continuationBlocker = controllerRoundBlockerClass(relay);
  if (completion.action === 'CONTINUE'
    && task.continuationPolicy.kind === 'forge_goal_outer_turn'
    && (continuationBlocker === 'repeated_state' || continuationBlocker === 'round_budget_exhausted')) {
    const boundary = workflowSupervisorBoundaryForWork(store, settledWorkId);
    const exactEnrolledBoundary = boundary.status === 'outer_turn'
      && boundary.conversationId === task.conversationId
      && boundary.conversationUrl === task.conversationUrl;
    if (exactEnrolledBoundary) {
      relay = rearmControllerRoundAfterContinuationEvidence(store, {
        workId: settledWorkId,
        relayScopeId: relay.relayScopeId,
        expectedUpdatedAt: relay.updatedAt,
        completionEvidenceId: completion.completionFingerprint,
      });
      // The blocked round's canonical provider effect identity may already have
      // been used by the source/recovery chain. A durable CONTINUE that reopens
      // this same semantic round therefore needs a fresh Supervisor effect. The
      // control plane derives that identity from the completion fingerprint and
      // effectApplied records it back onto the lower relay exactly once.
      continuationNeedsFreshSupervisorEffect = true;
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
    'Controller authority and relay scope are internal transport fencing facts; the model must not claim, release, or progress Work through them.',
    'Treat ControllerRound identity as resume/transport bookkeeping only. Re-read current Requirement/Plan/Work/UserRequest facts and use canonical stable-id + expected_revision semantic operations; do not invent mandatory verify/review/finalize/PlanStep lifecycle from this authority.',
    'Never mint a replacement continuation authority and never substitute a transport session id.',
  ].join('\n');
  return {
    continuationAllowed: true,
    continuationContext,
    ...(continuationNeedsFreshSupervisorEffect
      ? {}
      : { continuationEffectId: relay.providerDispatchEffectId ?? controllerRoundProviderEffectId(relay) }),
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
function createForgeWorkflowSupervisorBrowserTaskActive(controllerHome: string): (task: WorkflowSupervisorTask) => boolean {
  const workStateById = new Map<string, { revision: number; active: boolean }>();
  const lowerLayerNotReadyUntilByTask = new Map<string, number>();
  const LOWER_LAYER_NOT_READY_CACHE_MS = 5_000;
  return (task) => {
    if (task.continuationPolicy.kind === 'standalone_supervisor') return true;
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
    const lowerLayerReady = workflowSupervisorLowerLayerReadyForWork(store, relay.originWorkId).ready;
    const outcomeUnknownEffectAwaitingObservation = relay.status === 'blocked'
      && controllerRoundBlockerClass(relay) === 'provider_dispatch_outcome_unknown'
      && (relay.providerDispatchAttempt ?? 0) > 0
      && Boolean(relay.providerDispatchEffectId?.trim());
    if (!lowerLayerReady && !outcomeUnknownEffectAwaitingObservation) {
      // A blocked/paused lower layer must not make the native adapter rescan
      // the full Controller record set every second. The sole blocked exception
      // is an already-started outcome-unknown provider effect: Supervisor must
      // keep observing that exact effect so it can reconcile, never resend it.
      lowerLayerNotReadyUntilByTask.set(task.taskId, nowMs + LOWER_LAYER_NOT_READY_CACHE_MS);
      return false;
    }
    const work = getWorkContract(store, relay.originWorkId);
    if (!work) {
      lowerLayerNotReadyUntilByTask.set(task.taskId, nowMs + LOWER_LAYER_NOT_READY_CACHE_MS);
      return false;
    }
    const revision = workSemanticView(work).revision;
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
    effectDispatchEvidence: () => {
      const claim = getRuntimeWriteClaim();
      return claim && !claim.unmanaged
        ? {
            runtime_instance_id: claim.runtimeInstanceId,
            runtime_fencing_generation: claim.fencingGeneration,
            active_release_id: claim.releaseId,
            active_release_authority_revision: claim.releaseAuthorityRevision,
          }
        : {};
    },
    inheritedEffectDispatch: (task, effect) => {
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const requirementId = workflowSupervisorContractText(task, 'requirement_id');
      const workId = workflowSupervisorContractText(task, 'work_id');
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId || (!requirementId && !workId) || taskControllerHome !== controllerHome) return undefined;
      const store = { controllerHome, repoId };
      const relay = requirementId
        ? getRequirementControllerRoundRelay(store, requirementId)
        : getControllerRoundRelay(store, workId!);
      const legacyStartedDispatch = Boolean(
        relay
        && (relay.providerDispatchAttempt ?? 0) >= 1
        && relay.providerDispatchEffectId === effect.effectId
        && (
          (relay.status === 'blocked' && controllerRoundBlockerClass(relay) === 'provider_dispatch_outcome_unknown')
          || (relay.status === 'dispatched' && Boolean(relay.providerDispatchReceiptId))
        )
      );
      if (!relay || !legacyStartedDispatch) return undefined;
      const boundary = workflowSupervisorBoundaryForWork(store, relay.originWorkId);
      if (boundary.status !== 'outer_turn'
        || boundary.conversationId !== task.conversationId
        || boundary.conversationUrl !== task.conversationUrl) return undefined;
      return {
        generation: 1,
        dispatchId: `controller-round:${relay.relayScopeId}:${relay.providerDispatchAttempt}`,
        evidence: {
          surface: 'controller_round_reconciliation',
          inherited_provider_dispatch: true,
          relay_scope_id: relay.relayScopeId,
          provider_dispatch_attempt: relay.providerDispatchAttempt,
          ...(relay.providerDispatchStartedAt ? { provider_dispatch_started_at: relay.providerDispatchStartedAt } : {}),
        },
      };
    },
    projectScopeForTask: (task) => {
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId) return undefined;
      if (taskControllerHome && taskControllerHome !== controllerHome) return undefined;
      if (!taskControllerHome && task.continuationPolicy.kind !== 'standalone_supervisor') return undefined;
      try {
        const repository = getRepository(repoId, controllerHome);
        const aliases = workflowSupervisorProjectAliases(task);
        return {
          title: repository.displayName,
          ...(aliases.length > 0 ? { aliases } : {}),
          repoId,
          controllerHome,
        };
      } catch { return undefined; }
    },
    browserTaskActive,
    bootstrapConversationBound: (task) => {
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const workId = workflowSupervisorContractText(task, 'work_id');
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId || !workId || taskControllerHome !== controllerHome) return;
      const existing = getChatgptWorkConversationBinding({ controllerHome, repoId }, workId);
      if (existing && (existing.conversationId !== task.conversationId || existing.conversationUrl !== task.conversationUrl)) {
        throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_WORK_CONVERSATION_CONFLICT');
      }
      if (!existing) {
        bindChatgptWorkConversation({ controllerHome, repoId }, {
          workId,
          conversationUrl: task.conversationUrl,
          localAlias: 'Forge autonomous execution',
        });
      }
    },
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
      if (!relay) return;
      const boundary = workflowSupervisorBoundaryForWork(store, relay.originWorkId);
      if (boundary.status !== 'outer_turn' || boundary.conversationId !== task.conversationId) return;
      finishControllerRoundRelayDispatch(store, {
        workId: relay.originWorkId,
        ok: true,
        providerDispatchEffectId: effect.effectId,
        providerDispatchReceiptId: `workflow-supervisor:${effect.effectId}:${observation.observationId}`,
      });
    },
    assistantTurnCommitted: (task, completion) => task.continuationPolicy.kind === 'standalone_supervisor'
      ? Promise.resolve({ continuationAllowed: true })
      : settleForgeWorkflowSupervisorTurn(controllerHome, task, completion),
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
    // The same ChatGPT conversation may be rendered with or without its Project
    // route. Its durable conversation id, not that route, proves continuity.
    return Boolean(current
      && current.conversationId === boundary.conversationId);
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
): Promise<{ status: WorkflowSupervisorEnrollmentStatus; taskId?: string; effectId?: string; reason?: string }> {
  const boundary = workflowSupervisorBoundaryForWork(options, workId);
  if (boundary.status === 'not_eligible') return { status: boundary.status };
  const forgeHome = resolveWorkflowSupervisorForgeHome(options.controllerHome);
  // Work-derived task ids are only bootstrap reservation identities. Once an
  // exact conversation exists, the task-registration RPC returns the canonical
  // Supervisor task already owning that conversation, including across successor Work.
  const taskId = taskIdForWork(options.repoId, workId);
  if (!existsSync(workflowSupervisorSocketPath(forgeHome))) return { status: 'daemon_unavailable', taskId };
  const lowerLayer = workflowSupervisorLowerLayerReadyForWork(options, workId);
  if (!lowerLayer.ready) return { status: 'lower_layer_not_ready', reason: lowerLayer.reason };
  const work = getWorkContract(options, workId);
  const requirement = work?.requirementId
    ? readRequirement({ controllerHome: options.controllerHome }, work.requirementId)?.value
    : undefined;
  const registeredTask = await registerWorkflowSupervisorTask(forgeHome, {
    taskId,
    // This is a durable pre-send reservation, not a conversation identity.
    // The Computer adapter replaces it atomically after the first confirmed
    // submission exposes ChatGPT's canonical conversation URL.
    conversationId: boundary.status === 'outer_turn' ? boundary.conversationId : `bootstrap:${workId}`,
    conversationUrl: boundary.status === 'outer_turn' ? boundary.conversationUrl : 'https://chatgpt.com/',
    objective: requirement?.outcomeStatement ?? work?.objective ?? workId,
    completionContract: {
      kind: requirement ? 'forge_requirement_done' : 'forge_work_done',
      controller_home: options.controllerHome,
      repo_id: options.repoId,
      ...(requirement ? { requirement_id: requirement.requirementId } : { work_id: workId }),
    },
    continuationPolicy: {
      kind: 'forge_goal_outer_turn',
      ...(boundary.status === 'outer_turn'
        ? { exact_conversation_id: boundary.conversationId, exact_conversation_url: boundary.conversationUrl }
        : { bootstrap: true }),
      lower_layer_continuation_owner: 'controller_round',
      outer_turn_owner: 'workflow_supervisor',
    },
    userBlockerPolicy: {
      kind: requirement ? 'forge_requirement_waiting_for_user' : 'forge_work_waiting_for_user',
      controller_home: options.controllerHome,
      repo_id: options.repoId,
      ...(requirement ? { requirement_id: requirement.requirementId } : { work_id: workId }),
    },
  });
  const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, registeredTask.taskId, lowerLayer.providerEffectId);
  // Runtime owns only enrollment. Provider send/reconcile/re-dispatch budgeting
  // stays entirely inside the Supervisor effect ledger and Browser adapter.
  return { status: 'enrolled', taskId: registeredTask.taskId, effectId: effect.effectId };
}
