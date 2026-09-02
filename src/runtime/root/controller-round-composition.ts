import type { ControllerRoundRelayRecord } from '../../../packages/kernel/controller/api/index';
import { getChatgptWorkConversationBinding } from '../../../adapters/chatgpt/work-conversation-binding-store';
import {
  buildChatgptControllerRoundPrompt,
  chatgptControllerRoundBindingAuthorizesRecovery,
} from '../../../adapters/chatgpt/controller-round-host';
import {
  recordChatgptControllerRoundSettlement,
  type ChatgptControllerRoundSettlementStatus,
} from '../../../adapters/chatgpt/controller-round-settlement-store';

// Kernel V2 composition root: provider-specific adapter wiring lives here, not in transport adapters.
export interface ControllerRoundCompositionStore {
  controllerHome: string;
  repoId: string;
}

export interface ChatgptControllerRoundBindingSnapshot {
  bindingId?: string;
  browserSessionId?: string;
  conversationUrl?: string;
}

export function chatgptControllerRoundBinding(
  store: ControllerRoundCompositionStore,
  workId: string,
): ChatgptControllerRoundBindingSnapshot | undefined {
  const binding = getChatgptWorkConversationBinding(store, workId);
  if (!binding) return undefined;
  return {
    bindingId: binding.bindingId,
    browserSessionId: binding.latestBrowserSessionId,
    conversationUrl: binding.conversationUrl,
  };
}

export function chatgptControllerRoundRecoveryAuthorized(
  store: ControllerRoundCompositionStore,
  workId: string,
  relay: ControllerRoundRelayRecord | undefined,
): boolean {
  return chatgptControllerRoundBindingAuthorizesRecovery(
    relay,
    getChatgptWorkConversationBinding(store, workId),
  );
}

export function renderChatgptControllerRoundPrompt(
  store: ControllerRoundCompositionStore,
  relay: ControllerRoundRelayRecord,
  options: { exactOriginWork?: boolean } = {},
): string {
  return buildChatgptControllerRoundPrompt(store, relay, options);
}

export function recordChatgptControllerRoundTabSettlement(
  store: ControllerRoundCompositionStore,
  input: {
    workId: string;
    relayScopeId: string;
    status: ChatgptControllerRoundSettlementStatus;
    error?: string;
  },
): void {
  recordChatgptControllerRoundSettlement(store, input);
}
