import { createHash } from 'crypto';
import type { AssistantContextSnapshot, ControllerRoundRelayRecord } from '../../../packages/kernel/controller/api/index';
import { prepareAssistantWorkContext } from '../context/assistant-work-context';
import { renderAssistantContext, type AssistantContextResolution } from '../context/assistant-context';
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
  authorizationGrantRefs?: string[];
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
    authorizationGrantRefs: [...(binding.authorizationGrantRefs ?? [])],
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
  return buildChatgptControllerRoundPrompt({ ...store,
    prepareAssistantContext: workId => prepareControllerAssistantContext(store, workId),
  }, relay, options);
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

function controllerAssistantContextSnapshot(resolution: AssistantContextResolution): AssistantContextSnapshot {
  const items = resolution.items.map((item) => ({
    kind: item.kind,
    itemId: item.id,
    digest: item.provenance.digest,
    revision: item.provenance.revision,
    sourceRevision: item.provenance.sourceRevision,
  }));
  const identity = {
    ...(resolution.projectId ? { projectId: resolution.projectId } : {}),
    items,
    gaps: resolution.gaps,
    missingRequiredSources: resolution.missingRequiredSources,
    truncated: resolution.truncated,
  };
  return {
    digest: `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    ...identity,
  };
}

/** Resolve once at claim so rendered context and retained round evidence share one identity. */
export function prepareControllerAssistantContextBundle(
  store: ControllerRoundCompositionStore,
  workId: string,
): { rendered: string; snapshot: AssistantContextSnapshot; resolution: AssistantContextResolution } | undefined {
  const resolution = prepareAssistantWorkContext({ controllerHome: store.controllerHome, repoId: store.repoId, workId });
  if (!resolution) return undefined;
  return { rendered: renderAssistantContext(resolution), snapshot: controllerAssistantContextSnapshot(resolution), resolution };
}

/** Provider-neutral context refresh used immediately after a successful claim. */
export function prepareControllerAssistantContext(store: ControllerRoundCompositionStore, workId: string): string | undefined {
  return prepareControllerAssistantContextBundle(store, workId)?.rendered;
}
