import {
  acknowledgeControllerRoundClaim,
  getControllerRoundRelay,
  getControllerSession,
  releaseControllerSessionWithAuthority,
  requireControllerOwnershipAuthority,
  submitControllerRoundDisposition,
  type ControllerRoundDisposition,
} from '../../../../packages/kernel/controller/api/index';
import { chatgptControllerRoundBinding } from '../../root/controller-round-composition';
import { readExecutionSession, updateExecutionSession } from '../execution/session-store';

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

/**
 * Compatibility close-only path for a ControllerRound that was already opened
 * by a pre-convergence current-source canary. New source-mode open/continue
 * dispatch is intentionally removed: candidate Runtime must be activated and
 * all new Work-bound ChatGPT turns flow through Workflow Supervisor.
 */
function reconcileClaimedSourceRound(input: {
  controllerHome: string;
  repoId: string;
  workId: string;
  controllerAuthorityId: string;
  relayScopeId: string;
}): ReconciledSourceRound {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const initialRelay = getControllerRoundRelay(store, input.workId);
  if (!initialRelay) throw new Error(`CONTROLLER_RELAY_ROUND_NOT_OPEN: ${input.workId}`);
  if (initialRelay.authorityId !== input.controllerAuthorityId.trim()) {
    throw new Error(`CONTROLLER_RELAY_AUTHORITY_MISMATCH: ${input.workId}`);
  }
  if (initialRelay.relayScopeId !== input.relayScopeId.trim()) {
    throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: ${input.workId}`);
  }

  const owner = getControllerSession(store, input.workId);
  if (!owner) throw new Error(`CONTROLLER_RELAY_ACTIVE_CLAIM_REQUIRED: ${input.workId}`);
  if (owner.controllerType !== 'chatgpt') throw new Error(`CONTROLLER_RELAY_CHATGPT_ONLY: ${input.workId}`);
  const ownerAuthority = requireControllerOwnershipAuthority(owner, input.workId);
  const relay = acknowledgeControllerRoundClaim(store, { workId: input.workId, session: owner });
  if (!relay) throw new Error(`CONTROLLER_RELAY_ROUND_NOT_OPEN: ${input.workId}`);
  if (relay.authorityId !== input.controllerAuthorityId.trim()) {
    throw new Error(`CONTROLLER_RELAY_AUTHORITY_MISMATCH: ${input.workId}`);
  }
  if (relay.relayScopeId !== input.relayScopeId.trim()) {
    throw new Error(`CONTROLLER_RELAY_SCOPE_MISMATCH: ${input.workId}`);
  }
  if (relay.status !== 'claimed') {
    throw new Error(`CONTROLLER_RELAY_ROUND_NOT_CLAIMED: ${relay.status}`);
  }

  return {
    store,
    owner,
    ownerAuthority,
    relay,
    identity: {
      controllerId: owner.controllerId,
      controllerType: 'chatgpt',
      principalId: ownerAuthority.principalId,
      controllerInstanceId: ownerAuthority.controllerInstanceId,
      sessionId: owner.sessionId,
      claimGeneration: ownerAuthority.claimGeneration,
    },
    bindingId: chatgptControllerRoundBinding(store, input.workId)?.bindingId,
  };
}

function releaseReconciledSourceRound(
  input: { controllerHome: string; workId: string },
  reconciled: ReconciledSourceRound,
): void {
  const released = releaseControllerSessionWithAuthority(reconciled.store, {
    workId: input.workId,
    actor: `source-chatgpt-round-close:${reconciled.owner.controllerId}`,
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
    updateExecutionSession(input.controllerHome, sessionIdentity, {
      activeWorkId: undefined,
      lastValidatedAt: new Date().toISOString(),
    });
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

export function closeChatgptControllerRoundFromSource(
  input: SourceChatgptRoundCloseInput,
): SourceChatgptRoundCloseResult {
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
  const expectedStatus = input.disposition === 'wait'
    ? 'waiting'
    : input.disposition === 'wait_for_user'
      ? 'waiting_for_user'
      : 'goal_complete';
  if (disposition.status !== expectedStatus) {
    throw new Error(`CONTROLLER_RELAY_CLOSE_STATUS_INVALID: ${disposition.status}`);
  }
  releaseReconciledSourceRound(input, reconciled);
  return {
    disposition: input.disposition,
    dispositionStatus: disposition.status,
    relayScopeId: disposition.relayScopeId,
  };
}
