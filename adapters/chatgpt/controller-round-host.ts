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
    : '当前未绑定 durable Requirement。';
  const workLines = snapshot.works.length > 0
    ? snapshot.works.map((work) => {
      const summary = `- ${work.workId}：updated=${work.updatedAt}；objective=${work.objective}`;
      if (work.workId !== snapshot.originWorkId || work.acceptanceCriteria.length === 0) return summary;
      return [
        summary,
        '  origin Work acceptanceCriteria：',
        ...work.acceptanceCriteria.map((criterion, index) => `  ${index + 1}. ${criterion}`),
      ].join('\n');
    }).join('\n')
    : '- 未找到关联 Work 快照';
  const originWork = snapshot.works.find((work) => work.workId === snapshot.originWorkId);
  const terminalOriginGuidance = originWork?.status === 'completed'
    ? `origin Work ${snapshot.originWorkId} 的持久状态已完成。不要重新打开它；重新读取 Requirement/Plan/Work 语义事实，由模型决定是否仍有新的明确工作。`
    : undefined;
  const handoffLines = snapshot.handoffs.length > 0
    ? snapshot.handoffs.map((handoff) => `- ${handoff.id}：status=${handoff.status}；work=${handoff.workId ?? 'repo'}；${handoff.title}；reason=${handoff.reason}`).join('\n')
    : '- 当前没有 active linked Handoff';
  return [
    `继续 Forge ${snapshot.requirement ? `Requirement ${snapshot.requirement.requirementId}` : `Work ${snapshot.originWorkId}`}，repo=${snapshot.repoId}。`,
    '先重新读取最新 Forge Requirement/Plan/Work/UserRequest 语义事实；下面快照只用于恢复上下文，不能代替 durable semantic state。',
    requirementLine,
    `关联 Work 快照：\n${workLines}`,
    'origin Work 的 objective 与 acceptanceCriteria 是需要显式检查的 durable semantic contract；语义结论只来自最新事实与模型判断。',
    `Active Handoff 快照：\n${handoffLines}`,
    ...(snapshot.assistantContext ? [snapshot.assistantContext] : []),
    ...(snapshot.executionQualitySignals?.length ? [
      `Execution quality evidence (advisory): ${JSON.stringify(snapshot.executionQualitySignals)}`,
      'Review this evidence before repeating the same operation. Diagnose semantically; record whether an adjustment is justified. Do not infer a bug from edit counts, discard mandatory checks, widen authority or create another supervisor.',
    ] : []),
    promptOptions.exactOriginWork
      ? `只推进 origin Work ${snapshot.originWorkId} 的既定范围。若存在真实用户授权/判断 blocker，记录一个去重的 UserRequest；否则继续可执行工作。`
      : `origin Work 是 ${snapshot.originWorkId}。不要假设下一步必须继续它；依据最新 semantic state 选择现有或新的明确 Work。`,
    ...(terminalOriginGuidance ? [terminalOriginGuidance] : []),
    'Provider/session binding、transport recovery、dedupe、retry 和 continuation bookkeeping 由 Forge 内部维护，不属于模型工作流，也不是 Requirement/Plan/Work 的第二套语义权威。',
    '执行与验证直接使用当前 domain capability；只有 durable 语义实际变化时才更新 Requirement/Plan/Work。Forge 不替模型推断语义 next step。',
    '仓库工程、安全、权限和资源 fence 始终有效。若真实外部条件或用户判断阻塞，记录精确 UserRequest/Handoff；不要为了机械续跑创建 sibling Work、PlanStep 或额外 lifecycle。',
    'Presentation-only progress：持续较久或包含多轮工具调用时，在关键阶段用 1–2 句 user-visible 进度说明已确认结果、下一件事或真实 blocker。不要逐工具播报，不要输出 private reasoning / chain-of-thought。',
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
