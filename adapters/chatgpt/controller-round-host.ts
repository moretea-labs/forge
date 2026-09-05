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
  const originWork = snapshot.works.find((work) => work.workId === snapshot.originWorkId);
  const terminalOriginGuidance = originWork?.status === 'completed'
    ? `origin Work ${snapshot.originWorkId} 已 completed。禁止再次 controller_claim/reclaim 这个 terminal Work。若它是 validating 的 Plan predecessor：先用当前 round authority 做 plan_accept_step；再显式 start 唯一 successor（related_work_id=${snapshot.originWorkId}, work_relation=continue，并显式提供 work_kind/所需 engineering_preconditions 以及同一 controller_authority_id + relay_scope_id）；start 成功后 successor 只做 mechanical bind、不得抢占 ownership；随后显式提交 continue_immediately 得到 pending_release，最后 controller_release predecessor 触发新的 successor ControllerRound。`
    : undefined;
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
    ...(terminalOriginGuidance ? [terminalOriginGuidance] : []),
    `机械 relay 预算：round=${snapshot.round.count}/${snapshot.round.maxRounds}；repeated_state=${snapshot.round.repeatedStateCount}/${snapshot.round.maxRepeatedState}；consecutive_failures=${snapshot.round.consecutiveFailures}/${snapshot.round.maxFailures}。`,
    '仓库中的工程、验收、安全和权限约束始终有效。但如果某条 Skill/tool 指令明确限定为其他 Controller host/runtime（例如“仅 Codex 使用/发现的 Skill”），它不是 ChatGPT 当前 round 的硬 capability gate，也不得仅为了满足该 host wording 而 delegate；应使用当前 ChatGPT/Forge 已有能力完成同一工程目标，或基于真实缺失能力提交精确 blocker。',
    record.authorityId
      ? `本轮 durable controller authority 为 controller_authority_id=${record.authorityId}。在 controller_claim、plan_accept_step、continue、verify、review、finalize、stop、controller_release 以及 terminal-successor start 中，必须保持同一个 controller_authority_id 与 relay_scope_id=${record.relayScopeId}。Frozen client 第一次 claim 使用 controller.round:controller_claim:${record.authorityId}:${record.relayScopeId}；plan_accept_step 与后续 lifecycle 使用同一 controller.round:<operation>:${record.authorityId}:${record.relayScopeId} authority；若 terminal-successor start 的旧 schema 缺 work_kind/engineering_preconditions/round 字段，使用 bounded semantic start compatibility carrier。绝不能用 transport session id 或其他 Work/conversation authority 替代。`
      : '这是没有 controller authority capability 的 legacy relay record；只能沿用已经 claim 的 controller lineage，直到显式恢复本轮。',
    ...(snapshot.recoveryReason
      ? ['上一轮 ChatGPT 在 liveness grace 到期前没有提交显式 disposition。必须重新读取 durable state，并显式关闭本轮。']
      : []),
    terminalOriginGuidance
      ? `terminal predecessor 必须在显式 successor start 完成 mechanical bind 后，再显式提交一次 continue_immediately；得到 pending_release 后仅释放 predecessor。若没有可执行 successor，则按最新 Plan/Requirement 事实使用 wait、带 active Handoff 的 wait_for_user 或 goal_complete。`
      : `如果 Requirement/Goal 需要下一个 controller round，在释放 Work 前提交 continue_immediately，并带 relay_scope_id=${record.relayScopeId}。否则使用 wait、带 active Handoff 的 wait_for_user，或 goal_complete。Frozen MCP client 可使用 controller.disposition:<disposition>:${record.relayScopeId}。`,
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
