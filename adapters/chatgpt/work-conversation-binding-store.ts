import { FORGE_INSTANCE_SCOPE_KEY } from '../../src/cli/repositories/controller-home';
import { withControllerLock } from '../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { parseCanonicalChatgptConversationIdentity } from './conversation-identity';

const NAMESPACE = 'chatgpt_work_conversation_binding';

export interface ChatgptWorkConversationBinding {
  schemaVersion: 1;
  /** Optional repository provenance only. */
  repoId?: string;
  workId: string;
  bindingId: string;
  conversationUrl: string;
  conversationId: string;
  localAlias: string;
  latestBrowserSessionId?: string;
  authorizationGrantRefs?: string[];
  createdAt: string;
  updatedAt: string;
  lastContinuedAt?: string;
}

export interface ChatgptWorkBindingStoreOptions {
  controllerHome: string;
  repoId?: string;
  now?: () => string;
}

export function chatgptControllerBindingId(_repoId: string | undefined, workId: string): string {
  return `chatgpt:${workId}`;
}

function legacyBindingId(repoId: string, workId: string): string {
  return `chatgpt:${repoId}:${workId}`;
}

function nowIso(options: ChatgptWorkBindingStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function parseChatgptConversationIdentity(value: string): { conversationUrl: string; conversationId: string } {
  try { return parseCanonicalChatgptConversationIdentity(value); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'CHATGPT_CONVERSATION_URL_INVALID') throw new Error('CHATGPT_WORK_CONVERSATION_URL_INVALID');
    if (message === 'CHATGPT_CONVERSATION_ID_MISSING') throw new Error('CHATGPT_WORK_CONVERSATION_ID_MISSING');
    throw new Error('CHATGPT_WORK_CONVERSATION_ID_INVALID');
  }
}

export function hasChatgptConversationIdentity(value: string): boolean {
  try {
    parseChatgptConversationIdentity(value);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'CHATGPT_WORK_CONVERSATION_ID_MISSING') return false;
    throw error;
  }
}

function canonicalRecord(options: ChatgptWorkBindingStoreOptions, workId: string) {
  return readControlPlaneRecord<ChatgptWorkConversationBinding>(
    options.controllerHome,
    NAMESPACE,
    FORGE_INSTANCE_SCOPE_KEY,
    workId,
  );
}

function legacyRecord(options: ChatgptWorkBindingStoreOptions, workId: string) {
  const repoId = options.repoId?.trim();
  if (!repoId) return undefined;
  return readControlPlaneRecord<ChatgptWorkConversationBinding>(
    options.controllerHome,
    NAMESPACE,
    repoId,
    workId,
  );
}

function record(options: ChatgptWorkBindingStoreOptions, workId: string) {
  const canonical = canonicalRecord(options, workId);
  const legacy = legacyRecord(options, workId);
  if (canonical && legacy) {
    if (canonical.value.conversationId !== legacy.value.conversationId
      || canonical.value.workId !== legacy.value.workId) {
      throw new Error(`CHATGPT_WORK_BINDING_COLLISION: ${workId}`);
    }
  }
  return canonical ?? legacy;
}

function canonicalizeBinding(
  options: ChatgptWorkBindingStoreOptions,
  value: ChatgptWorkConversationBinding,
): ChatgptWorkConversationBinding {
  return {
    ...value,
    bindingId: chatgptControllerBindingId(undefined, value.workId),
    ...(options.repoId?.trim() ? { repoId: options.repoId.trim() } : {}),
  };
}

export function getChatgptWorkConversationBinding(
  options: ChatgptWorkBindingStoreOptions,
  workId: string,
): ChatgptWorkConversationBinding | undefined {
  const value = record(options, workId)?.value;
  return value ? canonicalizeBinding(options, value) : undefined;
}

function writeBinding(
  options: ChatgptWorkBindingStoreOptions,
  binding: ChatgptWorkConversationBinding,
  action: string,
  expectedRevision: number | null,
): void {
  writeControlPlaneRecord(options.controllerHome, {
    namespace: NAMESPACE,
    scope: FORGE_INSTANCE_SCOPE_KEY,
    key: binding.workId,
    schemaVersion: 1,
    value: binding,
    action,
    expectedRevision,
  });
}

export function rebindChatgptWorkConversation(
  options: ChatgptWorkBindingStoreOptions,
  input: {
    workId: string;
    previousConversationId: string;
    conversationUrl: string;
    latestBrowserSessionId?: string;
    authorizationGrantRefs?: readonly string[];
    localAlias?: string;
  },
): ChatgptWorkConversationBinding {
  if (!input.workId.trim()) throw new Error('CHATGPT_WORK_BINDING_WORK_REQUIRED');
  if (!input.previousConversationId.trim()) throw new Error('CHATGPT_WORK_REBIND_PREVIOUS_CONVERSATION_REQUIRED');
  const identity = parseChatgptConversationIdentity(input.conversationUrl);
  return withControllerLock(
    options.controllerHome,
    { scope: 'global', resource: `chatgpt-work-binding:${input.workId}` },
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
        ...(options.repoId?.trim() ? { repoId: options.repoId.trim() } : {}),
        workId: input.workId,
        bindingId: chatgptControllerBindingId(undefined, input.workId),
        conversationUrl: identity.conversationUrl,
        conversationId: identity.conversationId,
        localAlias: (input.localAlias?.trim() || existing.value.localAlias).slice(0, 180),
        latestBrowserSessionId: input.latestBrowserSessionId ?? existing.value.latestBrowserSessionId,
        authorizationGrantRefs: [...new Set((input.authorizationGrantRefs ?? existing.value.authorizationGrantRefs ?? []).map((ref) => ref.trim()).filter(Boolean))],
        createdAt: existing.value.createdAt,
        updatedAt: now,
        lastContinuedAt: now,
      };
      writeBinding(options, binding, 'chatgpt_work_conversation_rebind', canonicalRecord(options, input.workId)?.revision ?? null);
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
    authorizationGrantRefs?: readonly string[];
    localAlias?: string;
  },
): ChatgptWorkConversationBinding {
  if (!input.workId.trim()) throw new Error('CHATGPT_WORK_BINDING_WORK_REQUIRED');
  const identity = parseChatgptConversationIdentity(input.conversationUrl);
  return withControllerLock(
    options.controllerHome,
    { scope: 'global', resource: `chatgpt-work-binding:${input.workId}` },
    `chatgpt-work-binding:${input.workId}`,
    () => {
      const existing = record(options, input.workId);
      if (existing && existing.value.conversationId !== identity.conversationId) {
        throw new Error(`CHATGPT_WORK_CONVERSATION_REBIND_REQUIRED: ${input.workId}:${existing.value.conversationId}`);
      }
      const now = nowIso(options);
      const localAlias = input.localAlias?.trim()
        || existing?.value.localAlias
        || `Forge · ${input.workId} · ${identity.conversationId.slice(0, 8)}`;
      const binding: ChatgptWorkConversationBinding = {
        schemaVersion: 1,
        ...(options.repoId?.trim() ? { repoId: options.repoId.trim() } : {}),
        workId: input.workId,
        bindingId: chatgptControllerBindingId(undefined, input.workId),
        conversationUrl: identity.conversationUrl,
        conversationId: identity.conversationId,
        localAlias: localAlias.slice(0, 180),
        latestBrowserSessionId: input.latestBrowserSessionId ?? existing?.value.latestBrowserSessionId,
        authorizationGrantRefs: [...new Set((input.authorizationGrantRefs ?? existing?.value.authorizationGrantRefs ?? []).map((ref) => ref.trim()).filter(Boolean))],
        createdAt: existing?.value.createdAt ?? now,
        updatedAt: now,
        lastContinuedAt: now,
      };
      writeBinding(options, binding, existing ? 'chatgpt_work_conversation_continue' : 'chatgpt_work_conversation_bind', canonicalRecord(options, input.workId)?.revision ?? null);
      return binding;
    },
  );
}
