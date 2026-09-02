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
    ? `Requirement ${snapshot.requirement.requirementId}：state=${snapshot.requirement.state}；outcome=${snapshot.requirement.outcomeStatement}`
    : `当前未绑定 durable Requirement；语义 relay scope 为 ${snapshot.relayScopeId}。`;
  const workLines = snapshot.works.length > 0
    ? snapshot.works.map((work) => `- ${work.workId}：status=${work.status}；phase=${work.phase}；updated=${work.updatedAt}；objective=${work.objective}`).join('\n')
    : '- 未找到关联 Work 快照';
  const handoffLines = snapshot.handoffs.length > 0
    ? snapshot.handoffs.map((handoff) => `- ${handoff.id}：status=${handoff.status}；work=${handoff.workId ?? 'repo'}；${handoff.title}；reason=${handoff.reason}`).join('\n')
    : '- 当前没有 active linked Handoff';
  return [
    `继续 Forge Requirement/Goal relay ${snapshot.relayScopeId}，repo=${snapshot.repoId}。`,
    '这是新的 ChatGPT controller round。第一步必须重新读取最新 Forge Requirement/Work/Handoff 状态；下面的快照只用于启动提示，不能代替 durable state。',
    requirementLine,
    `关联 Work 快照：\n${workLines}`,
    `Active Handoff 快照：\n${handoffLines}`,
    promptOptions.exactOriginWork
      ? `这是 Work-bound scheduled round。只允许 claim 并推进 origin Work ${snapshot.originWorkId}。不得选择、启动、delegate、resume sibling Work，不得新建 schedule，也不得扩大 scope。如果经过一次有界诊断或修复后仍无法安全推进，记录精确证据，提交 wait 或带 active Handoff 的 wait_for_user，释放 ownership，然后结束本轮。`
      : `上一轮 relay 的 origin Work 是 ${snapshot.originWorkId}。不要假设下一步必须继续该 Work；必须依据最新 semantic state 选择、启动或 claim 正确的 Work。`,
    `机械 relay 预算：round=${snapshot.round.count}/${snapshot.round.maxRounds}；repeated_state=${snapshot.round.repeatedStateCount}/${snapshot.round.maxRepeatedState}；consecutive_failures=${snapshot.round.consecutiveFailures}/${snapshot.round.maxFailures}。`,
    record.authorityId
      ? `本轮 durable controller authority 为 controller_authority_id=${record.authorityId}。在 controller_claim、continue、verify、review、finalize、stop、controller_release 中，必须同时传入这个完全相同的 controller_authority_id 与 relay_scope_id=${record.relayScopeId}。如果当前 frozen client schema 缺少其中任一字段，第一次 claim 必须使用 MCP compatibility capability controller.round:controller_claim:${record.authorityId}:${record.relayScopeId}；后续 lifecycle 调用使用 controller.round:<operation>:${record.authorityId}:${record.relayScopeId}。绝不能用 transport session id 或其他 Work/conversation authority 替代。`
      : '这是没有 controller authority capability 的 legacy relay record；只能沿用已经 claim 的 controller lineage，直到显式恢复本轮。',
    ...(snapshot.recoveryReason
      ? ['上一轮 ChatGPT 在 liveness grace 到期前没有提交显式 disposition。必须重新读取 durable state，并显式关闭本轮。']
      : []),
    `如果 Requirement/Goal 需要下一个 controller round，在释放 Work 前提交 continue_immediately，并带 relay_scope_id=${record.relayScopeId}。否则使用 wait、带 active Handoff 的 wait_for_user，或 goal_complete。Frozen MCP client 可使用 controller.disposition:<disposition>:${record.relayScopeId}。`,
    'Forge 不得自行推断 semantic next step。现有 Work ownership、Handoff authority 与 external-effect authorization 始终是权威。',
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
