import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getRepository } from '../../cli/repositories/registry';
import { getWorkContract, semanticWorkState } from '../../../packages/kernel/work/api/index';
import {
  controllerRoundBlockerClass,
  controllerRoundProviderEffectId,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getRequirementControllerRoundRelay,
} from '../../../packages/kernel/controller/api/index';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  type ChatgptWorkConversationBinding,
} from '../../../adapters/chatgpt/work-conversation-binding-store';
import { readRequirement } from '../control-plane/persistence/requirement-store';
import { getWorkflowSupervisorCurrentConversation, getWorkflowSupervisorTaskByConversationId, registerWorkflowSupervisorTask, reserveWorkflowSupervisorEnrollment } from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';
import type { WorkflowSupervisorLifecycleHooks, WorkflowSupervisorTask } from '../../../supervisor/types';
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

function workflowSupervisorOriginWorkId(task: WorkflowSupervisorTask, repoId: string): string | undefined {
  const legacyWorkPrefix = `forge:${repoId}:work:`;
  return workflowSupervisorContractText(task, 'work_id')
    ?? (task.taskId.startsWith(legacyWorkPrefix) ? task.taskId.slice(legacyWorkPrefix.length) || undefined : undefined);
}

/**
 * Mechanical Work projection used to decide whether a provider turn advanced
 * anything. `updatedAt` is deliberately excluded: mechanical Supervisor and
 * Controller bookkeeping touches the record every turn, while only a real Work
 * mutation (authored revision/state, phase evidence, execution evidence,
 * observable changed paths, or a delivery receipt) means the turn did work.
 */
function workflowSupervisorWorkProgressFingerprint(controllerHome: string, task: WorkflowSupervisorTask): string | undefined {
  const repoId = workflowSupervisorContractText(task, 'repo_id');
  const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
  if (!repoId || (taskControllerHome && taskControllerHome !== controllerHome)) return undefined;
  const workId = workflowSupervisorOriginWorkId(task, repoId);
  if (!workId) return undefined;
  const work = getWorkContract({ controllerHome, repoId }, workId);
  if (!work) return undefined;
  return createHash('sha256').update(JSON.stringify({
    semanticRevision: work.semanticRevision ?? null,
    semanticState: work.semanticState,
    phase: work.phase,
    phaseEvidence: work.phaseEvidence,
    dispatchState: work.dispatchState,
    evidenceState: work.evidenceState,
    completionOutcome: work.completionOutcome ?? null,
    completionReceipt: work.completionReceipt ?? null,
    evidenceRefs: work.evidenceRefs,
    changedPaths: work.scopeEvidence?.actualChangedPaths ?? [],
  })).digest('hex');
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

/**
 * Enrollment gives Supervisor authority over this exact conversation. Work and
 * ControllerRound are execution context, not another cross-turn lifecycle.
 * Goal cancellation and explicit conversation rebind revoke new-send authority.
 * Provider observation remains governed separately by the effect ledger.
 */
function createForgeWorkflowSupervisorBrowserTaskActive(controllerHome: string): (task: WorkflowSupervisorTask) => boolean {
  return (task) => {
    if (task.continuationPolicy.kind === 'standalone_supervisor') return true;
    if (task.continuationPolicy.kind !== 'forge_goal_outer_turn') return false;
    const repoId = workflowSupervisorContractText(task, 'repo_id');
    const requirementId = workflowSupervisorContractText(task, 'requirement_id');
    const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
    if (!repoId || taskControllerHome !== controllerHome) return false;
    if (requirementId && readRequirement({ controllerHome }, requirementId)?.value.state === 'cancelled') return false;
    const workId = workflowSupervisorOriginWorkId(task, repoId);
    if (!requirementId && !workId) return false;
    // An existing task may outlive the Work that originally enrolled it. Its
    // durable task/effect chain still owns the original Goal; absence cannot
    // mean DONE, NEEDS_USER, nor permit a replacement provider send.
    const binding = workId ? getChatgptWorkConversationBinding({ controllerHome, repoId }, workId) : undefined;
    return !binding || binding.conversationId === task.conversationId;
  };
}

export function forgeWorkflowSupervisorLifecycleHooks(controllerHome: string): WorkflowSupervisorLifecycleHooks {
  const browserTaskActive = createForgeWorkflowSupervisorBrowserTaskActive(controllerHome);
  return {
    canonicalObjectiveForTask: (task) => {
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const workId = repoId ? workflowSupervisorOriginWorkId(task, repoId) : undefined;
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId || !workId || (taskControllerHome && taskControllerHome !== controllerHome)) return undefined;
      const work = getWorkContract({ controllerHome, repoId }, workId);
      // A persisted Supervisor task/effect chain can outlive a retired Work.
      // Keep its recorded objective for observation/reconciliation; absence must
      // never manufacture a replacement Work or turn into a dispatch exception.
      return work?.objective;
    },
    effectDispatchEvidence: ({ task }) => {
      const claim = getRuntimeWriteClaim();
      const progress = workflowSupervisorWorkProgressFingerprint(controllerHome, task);
      return {
        ...(claim && !claim.unmanaged
          ? {
              runtime_instance_id: claim.runtimeInstanceId,
              runtime_fencing_generation: claim.fencingGeneration,
              active_release_id: claim.releaseId,
              active_release_authority_revision: claim.releaseAuthorityRevision,
            }
          : {}),
        ...(progress ? { work_progress_fingerprint: progress } : {}),
      };
    },
    workProgressFingerprint: (task) => workflowSupervisorWorkProgressFingerprint(controllerHome, task),
    inheritedEffectDispatch: (task, effect) => {
      if (effect.kind !== 'enrollment') return undefined;
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const requirementId = workflowSupervisorContractText(task, 'requirement_id');
      const workId = repoId ? workflowSupervisorOriginWorkId(task, repoId) : undefined;
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId || (!requirementId && !workId) || taskControllerHome !== controllerHome) return undefined;
      const store = { controllerHome, repoId };
      const relay = workId
        ? getControllerRoundRelay(store, workId)
        : getRequirementControllerRoundRelay(store, requirementId!);
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
      if (effect.kind !== 'enrollment') return;
      const repoId = workflowSupervisorContractText(task, 'repo_id');
      const requirementId = workflowSupervisorContractText(task, 'requirement_id');
      const workId = repoId ? workflowSupervisorOriginWorkId(task, repoId) : undefined;
      const taskControllerHome = workflowSupervisorContractText(task, 'controller_home');
      if (!repoId || (!requirementId && !workId) || taskControllerHome !== controllerHome) return;
      const store = { controllerHome, repoId };
      const relay = workId
        ? getControllerRoundRelay(store, workId)
        : getRequirementControllerRoundRelay(store, requirementId!);
      if (!relay || !['dispatching', 'blocked'].includes(relay.status)) return;
      // Receipt projection can settle only the enrolled lower effect. A newer
      // occurrence or sibling Work must never inherit an old conversation send.
      if ((relay.providerDispatchEffectId ?? controllerRoundProviderEffectId(relay)) !== effect.effectId) return;
      const boundary = workflowSupervisorBoundaryForWork(store, relay.originWorkId);
      if (boundary.status !== 'outer_turn' || boundary.conversationId !== task.conversationId) return;
      finishControllerRoundRelayDispatch(store, {
        workId: relay.originWorkId,
        ok: true,
        providerDispatchEffectId: effect.effectId,
        providerDispatchReceiptId: `workflow-supervisor:${effect.effectId}:${observation.observationId}`,
      });
    },
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
  const existing = getChatgptWorkConversationBinding(options, workId);
  const current = await getWorkflowSupervisorCurrentConversation(forgeHome);
  // Browser focus is ephemeral observation, not a second authority over an
  // already-bound Work. When a durable exact binding exists, a missing current
  // marker cannot revoke it; a fresh conflicting marker still fails closed.
  if (existing) {
    if (current && existing.conversationId !== current.conversationId) {
      throw new Error(`WORKFLOW_SUPERVISOR_CURRENT_CONVERSATION_CONFLICT:${workId}:${existing.conversationId}:${current.conversationId}`);
    }
    return { status: 'bound', binding: existing };
  }
  if (!current) return { status: 'current_conversation_unbound', reason: 'WORKFLOW_SUPERVISOR_CURRENT_CONVERSATION_UNBOUND' };
  const binding = bindChatgptWorkConversation(options, {
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

  // Once an exact conversation is already owned by a Supervisor task, that
  // task is the outer-turn authority. ControllerRound is only first-admission
  // execution context and must not regain veto power over later continuation.
  // Read before any lower-layer admission check so a blocked/exhausted old
  // Round cannot strand an already-enrolled exact conversation.
  if (boundary.status === 'outer_turn') {
    const existingAuthority = await getWorkflowSupervisorTaskByConversationId(forgeHome, boundary.conversationId);
    if (existingAuthority) {
      const existingRepoId = typeof existingAuthority.task.completionContract.repo_id === 'string'
        ? existingAuthority.task.completionContract.repo_id
        : existingAuthority.task.continuationPolicy.repo_id;
      if (typeof existingRepoId === 'string' && existingRepoId !== options.repoId) {
        throw new Error(`WORKFLOW_SUPERVISOR_TASK_REPOSITORY_CONFLICT:${boundary.conversationId}`);
      }
      if (existingAuthority.terminal) {
        // Terminal Supervisor authority must never be resurrected by a lower
        // ControllerRound. Report the outer-turn boundary as already owned so
        // Scheduler/Controller composition cannot create another provider turn.
        return {
          status: 'enrolled',
          taskId: existingAuthority.task.taskId,
          reason: `WORKFLOW_SUPERVISOR_TASK_TERMINAL:${existingAuthority.terminal}`,
        };
      }
      const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, existingAuthority.task.taskId);
      return { status: 'enrolled', taskId: existingAuthority.task.taskId, effectId: effect.effectId };
    }
  }

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
      work_id: workId,
      ...(requirement ? { requirement_id: requirement.requirementId } : {}),
    },
    continuationPolicy: {
      kind: 'forge_goal_outer_turn',
      ...(boundary.status === 'outer_turn'
        ? { exact_conversation_id: boundary.conversationId, exact_conversation_url: boundary.conversationUrl }
        : { bootstrap: true }),
      outer_turn_owner: 'workflow_supervisor',
    },
    userBlockerPolicy: {
      kind: requirement ? 'forge_requirement_waiting_for_user' : 'forge_work_waiting_for_user',
      controller_home: options.controllerHome,
      repo_id: options.repoId,
      work_id: workId,
      ...(requirement ? { requirement_id: requirement.requirementId } : {}),
    },
  });
  const effect = await reserveWorkflowSupervisorEnrollment(forgeHome, registeredTask.taskId, lowerLayer.providerEffectId);
  // Runtime owns only enrollment. Provider send/reconcile/re-dispatch budgeting
  // stays entirely inside the Supervisor effect ledger and Browser adapter.
  return { status: 'enrolled', taskId: registeredTask.taskId, effectId: effect.effectId };
}
