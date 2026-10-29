import {
  readControllerRoundContextSnapshot,
  type ControllerRoundRelayRecord,
  type ControllerRoundRelayStoreOptions,
} from '../../packages/kernel/controller/api/index';
import { hasChatgptConversationIdentity, type ChatgptWorkConversationBinding } from './work-conversation-binding-store';

/** ChatGPT continuation is a wake-up pointer, not another progress snapshot. */
export function buildChatgptControllerRoundPrompt(
  _options: ControllerRoundRelayStoreOptions,
  record: ControllerRoundRelayRecord,
  promptOptions: { exactOriginWork?: boolean } = {},
): string {
  return [
    `继续 Forge ${record.requirementId ? `Requirement ${record.requirementId}` : `Work ${record.originWorkId}`}，repo=${record.repoId}。`,
    '目标：按关联 Requirement 的现有验收标准推进实际交付。',
    '提交 disposition 前，用 rh_work get_contract 读取完整 WorkContract（验收、约束、检查、工作区/审批/恢复策略）。',
    '验收/安全约束未满足或未核验时必须 wait；外部评估边界也必须 wait，禁止 goal_complete。',
    '按需读取最新 Requirement/Plan、Git/PR/CI 及执行证据；不要沿用历史进度摘要作为当前事实。',
    promptOptions.exactOriginWork
      ? `只推进 origin Work ${record.originWorkId} 的既定范围；遇到真实用户判断阻塞再记录 UserRequest。`
      : `origin Work=${record.originWorkId}，由模型按当前事实决定下一步。`,
    '执行与验证直接调用现有能力；仅有实际进度才更新 Requirement，保留权限、Git CAS 和外部 effect 去重。',
    '本轮完成实际行动并给出回执；只有真实阻塞才停止，不要只汇报计划。',
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
