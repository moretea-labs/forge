import { withControllerLock } from '../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';

const NAMESPACE = 'chatgpt_work_conversation_binding';

export interface ChatgptWorkConversationBinding {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  /** Stable opaque ControllerBinding adapterRef exposed to Kernel. */
  bindingId: string;
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

export function chatgptControllerBindingId(repoId: string, workId: string): string {
  return `chatgpt:${repoId}:${workId}`;
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

export function hasChatgptConversationIdentity(value: string): boolean {
  try {
    parseChatgptConversationIdentity(value);
    return true;
  } catch (error) {
    // ChatGPT root and Project URLs are valid launch seeds, but they are not
    // durable conversation identities. Persist only the /c/<id> URL observed
    // after the browser confirms submission.
    if (error instanceof Error && error.message === 'CHATGPT_WORK_CONVERSATION_ID_MISSING') return false;
    throw error;
  }
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
  const value = record(options, workId)?.value;
  return value ? { ...value, bindingId: value.bindingId || chatgptControllerBindingId(options.repoId, workId) } : undefined;
}

export function rebindChatgptWorkConversation(
  options: ChatgptWorkBindingStoreOptions,
  input: {
    workId: string;
    previousConversationId: string;
    conversationUrl: string;
    latestBrowserSessionId?: string;
    localAlias?: string;
  },
): ChatgptWorkConversationBinding {
  if (!input.workId.trim()) throw new Error('CHATGPT_WORK_BINDING_WORK_REQUIRED');
  if (!input.previousConversationId.trim()) throw new Error('CHATGPT_WORK_REBIND_PREVIOUS_CONVERSATION_REQUIRED');
  const identity = parseChatgptConversationIdentity(input.conversationUrl);
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `chatgpt-work-binding-${input.workId}` },
    `chatgpt-work-rebind:${input.workId}`,
    () => {
      const existing = record(options, input.workId);
      if (!existing) throw new Error(`CHATGPT_WORK_CONVERSATION_BINDING_NOT_FOUND: ${input.workId}`);
      if (existing.value.conversationId !== input.previousConversationId.trim()) {
        throw new Error(`CHATGPT_WORK_CONVERSATION_REBIND_STALE: ${input.workId}:${existing.value.conversationId}`);
      }
      const now = nowIso(options);
      const binding: ChatgptWorkConversationBinding = {
        schemaVersion: 1,
        repoId: options.repoId,
        workId: input.workId,
        bindingId: chatgptControllerBindingId(options.repoId, input.workId),
        conversationUrl: identity.conversationUrl,
        conversationId: identity.conversationId,
        localAlias: (input.localAlias?.trim() || existing.value.localAlias).slice(0, 180),
        latestBrowserSessionId: input.latestBrowserSessionId ?? existing.value.latestBrowserSessionId,
        createdAt: existing.value.createdAt,
        updatedAt: now,
        lastContinuedAt: now,
      };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: options.repoId,
        key: input.workId,
        schemaVersion: 1,
        value: binding,
        action: 'chatgpt_work_conversation_rebind',
        expectedRevision: existing.revision,
      });
      return binding;
    },
  );
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
        bindingId: chatgptControllerBindingId(options.repoId, input.workId),
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
