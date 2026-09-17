import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import {
  acknowledgeControllerRoundClaim,
  beginControllerRoundProviderDispatch,
  beginInitialControllerRoundDispatch,
  beginControllerRoundRelayAfterRelease,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  getControllerSession,
  releaseControllerSessionWithAuthority,
  requireControllerOwnershipAuthority,
  submitControllerRoundDisposition,
  type ControllerRoundDisposition,
} from '../../../../packages/kernel/controller/api/index';
import { chatgptControllerRoundBinding, recordChatgptControllerRoundTabSettlement, renderChatgptControllerRoundPrompt } from '../../root/controller-round-composition';
import { ensureWorkflowSupervisorEnrollmentForWork, inheritWorkflowSupervisorConversationBinding, workflowSupervisorBoundaryForWork } from '../../root/workflow-supervisor-composition';
import { readExecutionSession, updateExecutionSession } from '../execution/session-store';
import { runWorkChatgptContinuation, type WorkChatgptContinuationResult } from './chatgpt-work-continuation';
import { getRepository } from '../../../cli/repositories/registry';

export const SOURCE_ROUND_CONTINUATION_INSTRUCTION =
  '当前为 Forge V2 源码自动续跑模式。不要用已安装旧 Runtime 直接结束本轮，因为旧 Runtime 可能只建立 Work owner 而未 reconciliation provider_dispatch_outcome_unknown。若 Goal 尚未完成且无真实 blocker，必须使用 prompt 提供的 exact current-source round-continue invocation；若本轮应 wait、wait_for_user 或 goal_complete，则必须使用 current-source round-close，它只做 canonical claim acknowledgement、semantic disposition 和 release，绝不派发 successor。不得重新探测 Controller Home、repo/work identity、controller authority 或 relay scope。';

function sourceCheckoutId(controllerHome: string, repoId: string, repoRoot: string): string {
  const repository = getRepository(repoId, controllerHome);
  const sourceRoot = realpathSync(repoRoot);
  const matches = repository.checkouts.filter((checkout) => {
    if (checkout.lifecycle === 'removed') return false;
    try { return realpathSync(checkout.canonicalRoot) === sourceRoot; } catch { return false; }
  });
  if (matches.length !== 1) {
    throw new Error(`SOURCE_ROUND_CHECKOUT_IDENTITY_AMBIGUOUS: ${repoId}:${repoRoot}:${matches.length}`);
  }
  return matches[0]!.checkoutId;
}

export function renderSourceRoundContinuationInstruction(input: {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  controllerAuthorityId: string;
  relayScopeId: string;
}): string {
  const checkoutId = sourceCheckoutId(input.controllerHome, input.repoId, input.repoRoot);
  const command = [
    'bun',
    'src/cli/index.ts',
    'chatgpt',
    'round-continue',
    '--controller-home', input.controllerHome,
    '--repo-id', input.repoId,
    '--work-id', input.workId,
    '--controller-authority-id', input.controllerAuthorityId,
    '--relay-scope-id', input.relayScopeId,
  ];
  const requestId = `source-round-continue:${input.controllerAuthorityId}`;
  const closeWaitCommand = [
    'bun',
    'src/cli/index.ts',
    'chatgpt',
    'round-close',
    '--controller-home', input.controllerHome,
    '--repo-id', input.repoId,
    '--work-id', input.workId,
    '--controller-authority-id', input.controllerAuthorityId,
    '--relay-scope-id', input.relayScopeId,
    '--disposition', 'wait',
  ];
  const closeWaitRequestId = `source-round-close:wait:${input.controllerAuthorityId}`;
  return [
    SOURCE_ROUND_CONTINUATION_INSTRUCTION,
    `Exact current-source continue invocation: repository_command_execute(repo_id=${JSON.stringify(input.repoId)}, checkout_id=${JSON.stringify(checkoutId)}, command=${JSON.stringify(command)}, request_id=${JSON.stringify(requestId)}).`,
    `Exact current-source wait/close invocation: repository_command_execute(repo_id=${JSON.stringify(input.repoId)}, checkout_id=${JSON.stringify(checkoutId)}, command=${JSON.stringify(closeWaitCommand)}, request_id=${JSON.stringify(closeWaitRequestId)}).`,
    `For wait_for_user or goal_complete use the same round-close command with only --disposition changed; wait_for_user must additionally provide --handoff-id for the active Handoff.`,
    `These exact lifecycle invocations are the sole repository_command_execute exception: do not pass wrapper work_id; CLI --work-id=${input.workId}, --controller-authority-id=${input.controllerAuthorityId}, and --relay-scope-id=${input.relayScopeId} remain the fenced Controller lifecycle authority.`,
  ].join(' ');
}


export interface SourceChatgptRoundOpenInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  controllerId: string;
  principalId: string;
  controllerInstanceId?: string;
  continuationPrompt?: string;
  timeoutMs?: number;
}

export interface SourceChatgptRoundOpenResult {
  relayStatus: string;
  controllerAuthorityId: string;
  relayScopeId: string;
  dispatch: WorkChatgptContinuationResult;
}

export async function openChatgptControllerRoundFromSource(
  input: SourceChatgptRoundOpenInput,
  dependencies: { dispatch?: typeof runWorkChatgptContinuation } = {},
): Promise<SourceChatgptRoundOpenResult> {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const binding = chatgptControllerRoundBinding(store, input.workId);
  const relay = beginInitialControllerRoundDispatch(store, {
    workId: input.workId,
    identity: {
      controllerId: input.controllerId.trim(),
      controllerType: 'chatgpt',
      principalId: input.principalId.trim(),
      controllerInstanceId: input.controllerInstanceId?.trim() || 'source-v2-launcher',
      sessionId: `source-v2-launch-${randomUUID()}`,
    },
    bindingId: binding?.bindingId,
  });
  if (relay.status === 'blocked' || !relay.authorityId) {
    throw new Error(`CONTROLLER_RELAY_LAUNCH_BLOCKED: ${relay.blockedReason ?? relay.relayScopeId}`);
  }
  const prompt = [
    renderChatgptControllerRoundPrompt(store, relay, { exactOriginWork: true }),
    renderSourceRoundContinuationInstruction({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      repoRoot: input.repoRoot,
      workId: input.workId,
      controllerAuthorityId: relay.authorityId,
      relayScopeId: relay.relayScopeId,
    }),
    input.continuationPrompt?.trim() ? `Continuation: ${input.continuationPrompt.trim()}` : '',
  ].filter(Boolean).join('\n\n');
  const dispatchingRelay = beginControllerRoundProviderDispatch(store, {
    workId: input.workId,
    authorityId: relay.authorityId,
    expectedUpdatedAt: relay.updatedAt,
    bindingId: binding?.bindingId,
  });
  const dispatch = dependencies.dispatch ?? runWorkChatgptContinuation;
  const dispatched = await dispatch({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    workId: input.workId,
    prompt,
    controllerAuthorityId: dispatchingRelay.authorityId!,
    relayScopeId: dispatchingRelay.relayScopeId,
    browserSessionId: binding?.browserSessionId,
    conversationUrl: binding?.conversationUrl,
    tabPolicy: 'reuse',
    timeoutMs: input.timeoutMs,
  });
  if (dispatched.status === 'failed') {
    const message = `${dispatched.error?.code ?? 'CONTROLLER_RELAY_DISPATCH_FAILED'}:${dispatched.error?.message ?? 'Controller relay dispatch failed'}`;
    const outcomeUnknown = dispatched.providerDeliveryStatus === 'outcome_unknown';
    const completed = finishControllerRoundRelayDispatch(store, {
      workId: input.workId,
      ok: false,
      error: message,
      outcomeUnknown,
    });
    if (!outcomeUnknown) throw new Error(message);
    return {
      relayStatus: completed?.status ?? 'blocked',
      controllerAuthorityId: relay.authorityId,
      relayScopeId: relay.relayScopeId,
      dispatch: dispatched,
    };
  }
  const updatedBinding = chatgptControllerRoundBinding(store, input.workId);
  const completed = finishControllerRoundRelayDispatch(store, {
    workId: input.workId,
    ok: true,
    bindingId: updatedBinding?.bindingId,
  });
  return {
    relayStatus: completed?.status ?? 'missing',
    controllerAuthorityId: relay.authorityId,
    relayScopeId: relay.relayScopeId,
    dispatch: dispatched,
  };
}

type SourceChatgptRoundTerminalDisposition = Exclude<ControllerRoundDisposition, 'continue_immediately'>;

interface ReconciledSourceRound {
  store: { controllerHome: string; repoId: string };
  owner: NonNullable<ReturnType<typeof getControllerSession>>;
  ownerAuthority: ReturnType<typeof requireControllerOwnershipAuthority>;
  relay: NonNullable<ReturnType<typeof acknowledgeControllerRoundClaim>>;
  identity: {
    controllerId: string;
    controllerType: 'chatgpt';
    principalId: string;
    controllerInstanceId: string;
    sessionId: string;
    claimGeneration: number;
  };
  bindingId?: string;
}

function reconcileClaimedSourceRound(input: {
  controllerHome: string; repoId: string; workId: string; controllerAuthorityId: string; relayScopeId: string;
}, options: { allowPendingReleaseContinuation?: boolean } = {}): ReconciledSourceRound {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const initialRelay = getControllerRoundRelay(store, input.workId);
  if (!initialRelay) throw new Error(`CONTROLLER_RELAY_ROUND_NOT_OPEN: ${input.workId}`);
  if (initialRelay.authorityId !== input.controllerAuthorityId.trim()) throw new Error(`CONTROLLER_RELAY_AUTHORITY_MISMATCH: ${input.workId}`);
  if (initialRelay.relayScopeId !== input.relayScopeId.trim()) throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: ${input.workId}`);

  const owner = getControllerSession(store, input.workId);
  if (!owner) throw new Error(`CONTROLLER_RELAY_ACTIVE_CLAIM_REQUIRED: ${input.workId}`);
  if (owner.controllerType !== 'chatgpt') throw new Error(`CONTROLLER_RELAY_CHATGPT_ONLY: ${input.workId}`);
  const ownerAuthority = requireControllerOwnershipAuthority(owner, input.workId);
  const resumablePendingRelease = options.allowPendingReleaseContinuation === true
    && initialRelay.status === 'pending_release'
    && initialRelay.disposition === 'continue_immediately'
    && initialRelay.lifecycleStage === 'semantic_round_closed';
  const relay = resumablePendingRelease
    ? initialRelay
    : acknowledgeControllerRoundClaim(store, { workId: input.workId, session: owner });
  if (!relay) throw new Error(`CONTROLLER_RELAY_ROUND_NOT_OPEN: ${input.workId}`);
  if (relay.authorityId !== input.controllerAuthorityId.trim()) throw new Error(`CONTROLLER_RELAY_AUTHORITY_MISMATCH: ${input.workId}`);
  if (relay.relayScopeId !== input.relayScopeId.trim()) throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: ${input.workId}`);
  if (resumablePendingRelease) {
    if (relay.controllerId !== owner.controllerId
      || relay.controllerType !== owner.controllerType
      || relay.principalId !== ownerAuthority.principalId
      || relay.controllerInstanceId !== ownerAuthority.controllerInstanceId) {
      throw new Error(`CONTROLLER_RELAY_PENDING_RELEASE_OWNER_MISMATCH: ${input.workId}`);
    }
  } else if (relay.status !== 'claimed') {
    throw new Error(`CONTROLLER_RELAY_ROUND_NOT_CLAIMED: ${relay.status}`);
  }
  const identity = {
    controllerId: owner.controllerId,
    controllerType: 'chatgpt' as const,
    principalId: ownerAuthority.principalId,
    controllerInstanceId: ownerAuthority.controllerInstanceId,
    sessionId: owner.sessionId,
    claimGeneration: ownerAuthority.claimGeneration,
  };
  return { store, owner, ownerAuthority, relay, identity, bindingId: chatgptControllerRoundBinding(store, input.workId)?.bindingId };
}

function releaseReconciledSourceRound(input: { controllerHome: string; workId: string }, reconciled: ReconciledSourceRound, actorPrefix: string): void {
  const released = releaseControllerSessionWithAuthority(reconciled.store, {
    workId: input.workId,
    actor: `${actorPrefix}:${reconciled.owner.controllerId}`,
    authority: reconciled.ownerAuthority,
  });
  if (!released.allowed) throw new Error(`WORK_CONTROLLER_RELEASE_FENCED: ${input.workId}:${released.reason}`);
  const sessionIdentity = {
    sessionId: reconciled.owner.sessionId,
    principalId: reconciled.ownerAuthority.principalId,
    controllerInstanceId: reconciled.ownerAuthority.controllerInstanceId,
  };
  const executionSession = readExecutionSession(input.controllerHome, sessionIdentity);
  if (executionSession?.activeWorkId === input.workId) {
    updateExecutionSession(input.controllerHome, sessionIdentity, { activeWorkId: undefined, lastValidatedAt: new Date().toISOString() });
  }
}

export interface SourceChatgptRoundCloseInput {
  controllerHome: string;
  repoId: string;
  workId: string;
  controllerAuthorityId: string;
  relayScopeId: string;
  disposition: SourceChatgptRoundTerminalDisposition;
  handoffId?: string;
  reason?: string;
}

export interface SourceChatgptRoundCloseResult {
  disposition: SourceChatgptRoundTerminalDisposition;
  dispositionStatus: string;
  relayScopeId: string;
}

export function closeChatgptControllerRoundFromSource(input: SourceChatgptRoundCloseInput): SourceChatgptRoundCloseResult {
  if (input.disposition === 'wait_for_user' && !input.handoffId?.trim()) {
    throw new Error('CONTROLLER_RELAY_WAIT_FOR_USER_HANDOFF_REQUIRED');
  }
  const reconciled = reconcileClaimedSourceRound(input);
  const disposition = submitControllerRoundDisposition(reconciled.store, {
    workId: input.workId,
    identity: reconciled.identity,
    disposition: input.disposition,
    relayScopeId: input.relayScopeId,
    requirementId: reconciled.relay.requirementId,
    bindingId: reconciled.bindingId,
    ...(input.handoffId?.trim() ? { handoffId: input.handoffId.trim() } : {}),
    reason: input.reason ?? `source_v2_${input.disposition}`,
  });
  const expectedStatus = input.disposition === 'wait' ? 'waiting' : input.disposition === 'wait_for_user' ? 'waiting_for_user' : 'goal_complete';
  if (disposition.status !== expectedStatus) {
    throw new Error(`CONTROLLER_RELAY_CLOSE_STATUS_INVALID: ${disposition.status}`);
  }
  releaseReconciledSourceRound(input, reconciled, 'source-chatgpt-round-close');
  return { disposition: input.disposition, dispositionStatus: disposition.status, relayScopeId: disposition.relayScopeId };
}

export interface SourceChatgptRoundContinueInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  controllerAuthorityId: string;
  relayScopeId: string;
  reason?: string;
  timeoutMs?: number;
}

export interface SourceChatgptRoundContinueResult {
  dispositionStatus: string;
  relayStatus: string;
  relayWorkId: string;
  outerTurnOwner: 'controller_round_provider' | 'workflow_supervisor';
  dispatch?: WorkChatgptContinuationResult;
  supervisorEnrollment?: { status: 'not_eligible' | 'conversation_pending' | 'daemon_unavailable' | 'enrolled'; taskId?: string; effectId?: string };
}

export async function continueChatgptControllerRoundFromSource(
  input: SourceChatgptRoundContinueInput,
  dependencies: { dispatch?: typeof runWorkChatgptContinuation } = {},
): Promise<SourceChatgptRoundContinueResult> {
  // The installed Runtime may be older than the source under canary. It is authoritative only
  // for establishing the exact live ControllerSession owner. Reconcile that durable owner
  // through the current source state machine before deciding whether this round is claimed.
  const reconciled = reconcileClaimedSourceRound(input, { allowPendingReleaseContinuation: true });
  const { store, owner, relay } = reconciled;
  // A transport/session failure can happen after the semantic disposition is durably
  // recorded but before owner release. Retry from that exact post-disposition boundary
  // instead of resubmitting continue_immediately (which would double-consume round budget).
  const disposition = relay.status === 'pending_release'
    ? relay
    : submitControllerRoundDisposition(store, {
        workId: input.workId,
        identity: reconciled.identity,
        disposition: 'continue_immediately',
        relayScopeId: input.relayScopeId,
        requirementId: relay.requirementId,
        bindingId: reconciled.bindingId,
        reason: input.reason ?? 'source_v2_immediate_continuation',
      });
  if (disposition.status !== 'pending_release') {
    throw new Error(`CONTROLLER_RELAY_CONTINUATION_NOT_PENDING_RELEASE: ${disposition.status}`);
  }

  releaseReconciledSourceRound(input, reconciled, 'source-chatgpt-round-continue');

  const nextRelay = beginControllerRoundRelayAfterRelease(store, { workId: input.workId, releasedSession: owner });
  if (!nextRelay || nextRelay.status !== 'dispatching' || !nextRelay.authorityId) {
    throw new Error(`CONTROLLER_RELAY_IMMEDIATE_DISPATCH_NOT_READY: ${nextRelay?.status ?? 'missing'}`);
  }
  const relayWorkId = nextRelay.originWorkId;
  inheritWorkflowSupervisorConversationBinding(store, input.workId, relayWorkId);
  const supervisorBoundary = workflowSupervisorBoundaryForWork(store, relayWorkId);
  if (supervisorBoundary.status === 'outer_turn') {
    const supervisorEnrollment = await ensureWorkflowSupervisorEnrollmentForWork(store, relayWorkId);
    return {
      dispositionStatus: disposition.status,
      relayStatus: nextRelay.status,
      relayWorkId,
      outerTurnOwner: 'workflow_supervisor',
      supervisorEnrollment,
    };
  }
  const prompt = `${renderChatgptControllerRoundPrompt(store, nextRelay)}\n\n${renderSourceRoundContinuationInstruction({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    workId: relayWorkId,
    controllerAuthorityId: nextRelay.authorityId,
    relayScopeId: nextRelay.relayScopeId,
  })}`;
  const dispatchingNextRelay = beginControllerRoundProviderDispatch(store, {
    workId: relayWorkId,
    authorityId: nextRelay.authorityId,
    expectedUpdatedAt: nextRelay.updatedAt,
    bindingId: chatgptControllerRoundBinding(store, relayWorkId)?.bindingId,
  });
  const dispatch = dependencies.dispatch ?? runWorkChatgptContinuation;
  const dispatched = await dispatch({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    workId: relayWorkId,
    prompt,
    controllerAuthorityId: dispatchingNextRelay.authorityId!,
    relayScopeId: dispatchingNextRelay.relayScopeId,
    tabPolicy: 'new',
    transportConversation: 'fresh',
    timeoutMs: input.timeoutMs,
  });
  if (dispatched.status === 'failed') {
    const message = `${dispatched.error?.code ?? 'CONTROLLER_RELAY_DISPATCH_FAILED'}:${dispatched.error?.message ?? 'Controller relay dispatch failed'}`;
    finishControllerRoundRelayDispatch(store, {
      workId: relayWorkId,
      ok: false,
      error: message,
      outcomeUnknown: dispatched.providerDeliveryStatus === 'outcome_unknown',
    });
    throw new Error(message);
  }

  recordChatgptControllerRoundTabSettlement(store, {
    workId: relayWorkId,
    relayScopeId: dispatchingNextRelay.relayScopeId,
    status: 'retained_for_immediate_continuation',
  });
  const updatedBinding = chatgptControllerRoundBinding(store, relayWorkId);
  const completed = finishControllerRoundRelayDispatch(store, {
    workId: relayWorkId,
    ok: true,
    bindingId: updatedBinding?.bindingId,
  });
  return {
    dispositionStatus: disposition.status,
    relayStatus: completed?.status ?? 'missing',
    relayWorkId,
    outerTurnOwner: 'controller_round_provider',
    dispatch: dispatched,
  };
}
