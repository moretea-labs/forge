import {
  readControllerRoundContextSnapshot,
  type ControllerRoundRelayRecord,
  type ControllerRoundRelayStoreOptions,
} from '../../packages/kernel/controller/api/index';
import { hasChatgptConversationIdentity, type ChatgptWorkConversationBinding } from './work-conversation-binding-store';

/** ChatGPT-specific rendering of one provider-neutral Kernel ControllerRound. */
export function buildChatgptControllerRoundPrompt(
  options: ControllerRoundRelayStoreOptions,
  record: ControllerRoundRelayRecord,
  promptOptions: { exactOriginWork?: boolean } = {},
): string {
  const snapshot = readControllerRoundContextSnapshot(options, record);
  const requirementLine = snapshot.requirement
    ? `Requirement ${snapshot.requirement.requirementId}: state=${snapshot.requirement.state}; outcome=${snapshot.requirement.outcomeStatement}`
    : `No durable Requirement is bound; semantic relay scope is ${snapshot.relayScopeId}.`;
  const workLines = snapshot.works.length > 0
    ? snapshot.works.map((work) => `- ${work.workId}: status=${work.status}; phase=${work.phase}; updated=${work.updatedAt}; objective=${work.objective}`).join('\n')
    : '- no linked Work snapshot found';
  const handoffLines = snapshot.handoffs.length > 0
    ? snapshot.handoffs.map((handoff) => `- ${handoff.id}: status=${handoff.status}; work=${handoff.workId ?? 'repo'}; ${handoff.title}; reason=${handoff.reason}`).join('\n')
    : '- no active linked Handoff';
  return [
    `Continue Forge Requirement/Goal relay ${snapshot.relayScopeId} in repo ${snapshot.repoId}.`,
    'This is a new ChatGPT controller round. First reread the latest Forge Requirement/Work/Handoff state; the snapshot below is only a launch hint.',
    requirementLine,
    `Linked Work snapshot:\n${workLines}`,
    `Active Handoff snapshot:\n${handoffLines}`,
    promptOptions.exactOriginWork
      ? `This is a Work-bound scheduled round. Claim and advance only origin Work ${snapshot.originWorkId}. Do not select, start, delegate, or resume a sibling Work, create another schedule, or widen scope. If this Work cannot safely advance after one bounded diagnostic or repair attempt, record the exact evidence, submit wait or wait_for_user, release ownership, and end the round.`
      : `Previous relay origin Work: ${snapshot.originWorkId}. Do not assume the next action must continue that Work; select, start, or claim the appropriate Work from the latest semantic state.`,
    `Mechanical relay budget: round=${snapshot.round.count}/${snapshot.round.maxRounds}; repeated_state=${snapshot.round.repeatedStateCount}/${snapshot.round.maxRepeatedState}; consecutive_failures=${snapshot.round.consecutiveFailures}/${snapshot.round.maxFailures}.`,
    record.authorityId
      ? `This round's durable controller authority is controller_authority_id=${record.authorityId}. Pass this exact controller_authority_id together with relay_scope_id=${record.relayScopeId} on controller_claim, continue, verify, review, finalize, stop, and controller_release. If this client schema omits either field, use the MCP compatibility capability controller.round:<operation>:${record.authorityId}:${record.relayScopeId}. Never substitute a transport session id or another Work/conversation authority.`
      : 'This is a legacy relay record without a controller authority capability; use only the already-claimed controller lineage until the round is explicitly recovered.',
    ...(snapshot.recoveryReason
      ? ['The previous ChatGPT round did not submit an explicit disposition before its liveness grace elapsed. Reread durable state and close this round explicitly.']
      : []),
    `If the Requirement/Goal needs another controller round, submit continue_immediately with relay_scope_id=${record.relayScopeId} before releasing Work. Otherwise use wait, wait_for_user with an active Handoff, or goal_complete. Frozen MCP clients may use controller.disposition:<disposition>:${record.relayScopeId}.`,
    'Forge must not infer the semantic next step. Existing Work ownership, Handoff authority, and external-effect authorization remain authoritative.',
  ].join('\n');
}

/** ChatGPT adapter continuity proof; Kernel only sees the opaque binding id. */
export function chatgptControllerRoundBindingAuthorizesRecovery(
  record: ControllerRoundRelayRecord | undefined,
  binding: ChatgptWorkConversationBinding | undefined,
): boolean {
  if (record?.controllerType !== 'chatgpt' || record.status !== 'dispatched' || !record.bindingId || !binding) return false;
  if (binding.bindingId !== record.bindingId || !binding.latestBrowserSessionId) return false;
  try { return hasChatgptConversationIdentity(binding.conversationUrl); } catch { return false; }
}
