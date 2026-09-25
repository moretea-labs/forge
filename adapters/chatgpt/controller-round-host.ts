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
    ? snapshot.works.map((work) => {
      const summary = `- ${work.workId}：status=${work.status}；phase=${work.phase}；updated=${work.updatedAt}；objective=${work.objective}`;
      if (work.workId !== snapshot.originWorkId || work.acceptanceCriteria.length === 0) return summary;
      return [
        summary,
        '  origin Work acceptanceCriteria（durable semantic contract）：',
        ...work.acceptanceCriteria.map((criterion, index) => `  ${index + 1}. ${criterion}`),
      ].join('\n');
    }).join('\n')
    : '- 未找到关联 Work 快照';
  const originWork = snapshot.works.find((work) => work.workId === snapshot.originWorkId);
  const terminalOriginGuidance = originWork?.status === 'completed'
    ? `origin Work ${snapshot.originWorkId} 已 completed。不要重新打开或重新 claim terminal Work。重新读取当前 Requirement/Plan/Work 语义事实，由模型决定是否还有新的执行 Work；Plan 进度只能通过显式 Plan revise 更新，不得从 Work 终态或 ControllerRound 生命周期推断。若当前旧 Runtime 仍要求 continuation disposition/release bookkeeping，只把它当作机械续跑兼容层。`
    : undefined;
  const handoffLines = snapshot.handoffs.length > 0
    ? snapshot.handoffs.map((handoff) => `- ${handoff.id}：status=${handoff.status}；work=${handoff.workId ?? 'repo'}；${handoff.title}；reason=${handoff.reason}`).join('\n')
    : '- 当前没有 active linked Handoff';
  return [
    `继续 Forge Requirement/Goal relay ${snapshot.relayScopeId}，repo=${snapshot.repoId}。`,
    '这是新的 ChatGPT controller round。第一步重新读取最新 Forge Requirement/Plan/Work/UserRequest 相关事实；下面的快照只用于机械续跑启动，不能代替 durable semantic state。',
    requirementLine,
    `关联 Work 快照：\n${workLines}`,
    'origin Work 的 objective 与 acceptanceCriteria 是本轮必须显式检查的 durable semantic contract；若最新事实满足其中更具体的终态义务，不得仅凭通用 disposition 指导改写成另一种终态。',
    `Active Handoff 快照：\n${handoffLines}`,
    ...(snapshot.assistantContext ? [snapshot.assistantContext] : []),
    ...(snapshot.executionQualitySignals?.length ? [
      `Execution quality evidence (advisory): ${JSON.stringify(snapshot.executionQualitySignals)}`,
      'Review this evidence before repeating the same operation. Diagnose semantically; record whether an adjustment is justified. Do not infer a bug from edit counts, discard mandatory checks, widen authority or create another supervisor.',
    ] : []),
    promptOptions.exactOriginWork
      ? `这是 Work-bound scheduled round。只推进 origin Work ${snapshot.originWorkId} 的既定范围，不得扩大 scope、创建 sibling Work 或新增 schedule。若存在真实用户授权/判断 blocker，记录一个去重的 UserRequest；否则继续可执行工作。当前 Runtime 若仍要求 disposition/release，只作为机械续跑兼容步骤。`
      : `上一轮 relay 的 origin Work 是 ${snapshot.originWorkId}。不要假设下一步必须继续该 Work；必须依据最新 semantic state 选择、启动或 claim 正确的 Work。`,
    ...(terminalOriginGuidance ? [terminalOriginGuidance] : []),
    `机械 relay 预算：round=${snapshot.round.count}/${snapshot.round.maxRounds}；repeated_state=${snapshot.round.repeatedStateCount}/${snapshot.round.maxRepeatedState}；consecutive_failures=${snapshot.round.consecutiveFailures}/${snapshot.round.maxFailures}。`,
    '仓库中的工程、验收、安全和权限约束始终有效。但如果某条 Skill/tool 指令明确限定为其他 Controller host/runtime（例如“仅 Codex 使用/发现的 Skill”），它不是 ChatGPT 当前 round 的硬 capability gate，也不得仅为了满足该 host wording 而 delegate；应使用当前 ChatGPT/Forge 已有能力完成同一工程目标，或基于真实缺失能力提交精确 blocker。',
    record.authorityId
      ? `本轮 controller_authority_id=${record.authorityId}、relay_scope_id=${record.relayScopeId} 仅用于当前旧 Runtime 的机械 continuation/relay 身份一致性，不是 Requirement、Plan 或 Work 的语义写权限。只有在 frozen transport 明确要求这些字段的 continuation disposition、release 或兼容 start 中保持同一 identity；不要据此发明 plan_accept_step、verify、review、finalize 等必经生命周期。语义修改仍由各自 stable id + revision/CAS 或对应 domain capability 决定。`
      : '这是没有 controller authority capability 的 legacy relay record；只能沿用已经 claim 的 controller lineage，直到显式恢复本轮。',
    ...(snapshot.recoveryReason
      ? ['上一轮 ChatGPT 在 liveness grace 到期前没有提交显式 disposition。必须重新读取 durable state，并显式关闭本轮。']
      : []),
    terminalOriginGuidance
      ? `若最新 Requirement/Plan 事实仍有可执行工作，由模型选择现有或新的明确 Work 并继续；若当前旧 Runtime 需要下一 ControllerRound，再提交 continue_immediately 并完成对应机械 release。真实用户 blocker 绑定去重 UserRequest；没有可执行工作时再选择 wait 或 goal_complete。`
      : `如果 Requirement/Goal 需要下一个 controller round，当前旧 Runtime 可使用 continue_immediately 并带 relay_scope_id=${record.relayScopeId}；这只是机械续跑。真实用户 blocker 使用 UserRequest，语义完成由模型依据 Requirement/Plan/Work 事实判断。`,
    '若当前 frozen Runtime 仍要求 controller disposition/release，在结束本轮前完成这一机械 bookkeeping；它不得成为 Requirement/Plan/Work 的第二套语义生命周期。',
    '如果最新 durable state 表明 Requirement/Goal 尚有可执行工作，且不存在真实 external blocker、active Handoff 或必须由用户决定的边界，则必须选择 continue_immediately。wait 只用于真实等待条件；wait_for_user 必须绑定 active Handoff；goal_complete 只用于 Requirement/Goal 已语义完成。',
    '提交 continue_immediately 后必须立即 controller_release 当前 Work。controller_release 是立即续跑的 canonical trigger：Forge 将通过现有 ChatGPT launcher 复用 durable conversation binding 并投递下一 ControllerRound prompt。正常连续推进不得依赖用户再次发送“继续”，也不得用 interval schedule 代替该即时 relay；schedule 只能作为故障恢复/watchdog。',
    'Forge 不得自行推断 semantic next step。语义 CAS、真实 UserRequest、具体资源/效果 fence 与外部授权事实分别保持各自权威；Work/controller ownership 不得充当通用语义锁。',
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
