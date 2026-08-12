import { withControllerLock } from '../../../cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';

const NAMESPACE = 'chatgpt_work_conversation_binding';

export interface ChatgptWorkConversationBinding {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  conversationUrl: string;
  conversationId: string;
  localAlias: string;
  latestBrowserSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastContinuedAt?: string;
}

export interface ChatgptWorkBindingStoreOptions {
  controllerHome: string;
  repoId: string;
  now?: () => string;
}

function nowIso(options: ChatgptWorkBindingStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function parseChatgptConversationIdentity(value: string): { conversationUrl: string; conversationId: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CHATGPT_WORK_CONVERSATION_URL_INVALID');
  }
  if (url.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(url.hostname)) {
    throw new Error('CHATGPT_WORK_CONVERSATION_URL_INVALID');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const c = parts.lastIndexOf('c');
  const conversationId = c >= 0 ? parts[c + 1]?.trim() : undefined;
  if (!conversationId) throw new Error('CHATGPT_WORK_CONVERSATION_ID_MISSING');
  url.protocol = 'https:';
  url.hostname = 'chatgpt.com';
  url.search = '';
  url.hash = '';
  return { conversationUrl: url.toString(), conversationId };
}

function record(options: ChatgptWorkBindingStoreOptions, workId: string) {
  return readControlPlaneRecord<ChatgptWorkConversationBinding>(
    options.controllerHome,
    NAMESPACE,
    options.repoId,
    workId,
  );
}

export function getChatgptWorkConversationBinding(
  options: ChatgptWorkBindingStoreOptions,
  workId: string,
): ChatgptWorkConversationBinding | undefined {
  return record(options, workId)?.value;
}

export function bindChatgptWorkConversation(
  options: ChatgptWorkBindingStoreOptions,
  input: {
    workId: string;
    conversationUrl: string;
    latestBrowserSessionId?: string;
    localAlias?: string;
  },
): ChatgptWorkConversationBinding {
  if (!input.workId.trim()) throw new Error('CHATGPT_WORK_BINDING_WORK_REQUIRED');
  const identity = parseChatgptConversationIdentity(input.conversationUrl);
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `chatgpt-work-binding-${input.workId}` },
    `chatgpt-work-binding:${input.workId}`,
    () => {
      const existing = record(options, input.workId);
      if (existing && existing.value.conversationId !== identity.conversationId) {
        throw new Error(`CHATGPT_WORK_CONVERSATION_REBIND_REQUIRED: ${input.workId}:${existing.value.conversationId}`);
      }
      const now = nowIso(options);
      const localAlias = input.localAlias?.trim()
        || existing?.value.localAlias
        || `Forge · ${options.repoId} · ${input.workId} · ${identity.conversationId.slice(0, 8)}`;
      const binding: ChatgptWorkConversationBinding = {
        schemaVersion: 1,
        repoId: options.repoId,
        workId: input.workId,
        conversationUrl: identity.conversationUrl,
        conversationId: identity.conversationId,
        localAlias: localAlias.slice(0, 180),
        latestBrowserSessionId: input.latestBrowserSessionId ?? existing?.value.latestBrowserSessionId,
        createdAt: existing?.value.createdAt ?? now,
        updatedAt: now,
        lastContinuedAt: now,
      };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: input.workId,
        schemaVersion: 1,
        value: binding,
        action: existing ? 'chatgpt_work_conversation_continue' : 'chatgpt_work_conversation_bind',
        expectedRevision: existing?.revision ?? null,
      });
      return binding;
    },
  );
}
