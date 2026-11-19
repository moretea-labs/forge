import { createHash } from 'crypto';
import {
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../persistence/sqlite-store';

const NAMESPACE = 'chatgpt_task_session_binding';
const SCHEMA_VERSION = 1;
const MAX_HISTORY = 32;
const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,255}$/;

export type ChatgptSendOutcome = 'reserved' | 'applied' | 'not_applied' | 'outcome_unknown';

export interface ChatgptTaskSessionRef {
  sessionId: string;
  conversationUrl: string;
  boundAt: string;
  sendRequestId?: string;
  sendReceiptId?: string;
}

export interface ChatgptTaskSessionHistory extends ChatgptTaskSessionRef {
  archivedAt: string;
  tabCleanup: 'pending' | 'closed';
  replacedBySessionId: string;
}

export interface ChatgptTaskSessionBinding {
  schemaVersion: 1;
  repoId: string;
  taskId: string;
  active: ChatgptTaskSessionRef;
  pendingSend?: {
    requestId: string;
    sessionId: string;
    outcome: ChatgptSendOutcome;
    receiptId?: string;
    updatedAt: string;
  };
  replacement?: {
    sourceSessionId: string;
    candidateSessionId: string;
    reasonCode: string;
    startedAt: string;
  };
  history: ChatgptTaskSessionHistory[];
  updatedAt: string;
}

function normalizedTaskId(taskId: string): string {
  const value = taskId.trim();
  if (!TASK_ID.test(value)) throw new Error('CHATGPT_TASK_ID_INVALID');
  return value;
}

function normalizedSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value || value.length > 256) throw new Error('CHATGPT_TASK_SESSION_ID_INVALID');
  return value;
}

function canonicalConversationUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('CHATGPT_TASK_CONVERSATION_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.username || url.password || url.port) {
    throw new Error('CHATGPT_TASK_CONVERSATION_ORIGIN_INVALID');
  }
  return url.href;
}

function key(taskId: string): string {
  return createHash('sha256').update(normalizedTaskId(taskId)).digest('hex');
}

function assertRecord(value: ChatgptTaskSessionBinding, repoId: string, taskId: string): ChatgptTaskSessionBinding {
  if (value.schemaVersion !== SCHEMA_VERSION || value.repoId !== repoId || value.taskId !== taskId
    || !Array.isArray(value.history) || !value.active) {
    throw new Error('CHATGPT_TASK_SESSION_BINDING_CORRUPT');
  }
  normalizedSessionId(value.active.sessionId);
  canonicalConversationUrl(value.active.conversationUrl);
  return value;
}

export function readChatgptTaskSessionBinding(
  controllerHome: string,
  repoId: string,
  taskId: string,
): ChatgptTaskSessionBinding | undefined {
  const normalized = normalizedTaskId(taskId);
  const record = readControlPlaneRecord<ChatgptTaskSessionBinding>(controllerHome, NAMESPACE, repoId, key(normalized));
  return record ? assertRecord(record.value, repoId, normalized) : undefined;
}

export function bindInitialChatgptTaskSession(input: {
  controllerHome: string;
  repoId: string;
  taskId: string;
  sessionId: string;
  conversationUrl: string;
  now?: string;
}): ChatgptTaskSessionBinding {
  const taskId = normalizedTaskId(input.taskId);
  const sessionId = normalizedSessionId(input.sessionId);
  const conversationUrl = canonicalConversationUrl(input.conversationUrl);
  const timestamp = input.now ?? new Date().toISOString();
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const existing = readControlPlaneRecordWithinTransaction<ChatgptTaskSessionBinding>(database, NAMESPACE, input.repoId, key(taskId));
    if (existing) {
      const value = assertRecord(existing.value, input.repoId, taskId);
      if (value.active.sessionId !== sessionId || value.active.conversationUrl !== conversationUrl) {
        throw new Error('CHATGPT_TASK_SESSION_ALREADY_BOUND');
      }
      return value;
    }
    const value: ChatgptTaskSessionBinding = {
      schemaVersion: SCHEMA_VERSION,
      repoId: input.repoId,
      taskId,
      active: { sessionId, conversationUrl, boundAt: timestamp },
      history: [],
      updatedAt: timestamp,
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: input.repoId, key: key(taskId), schemaVersion: SCHEMA_VERSION,
      value, action: 'chatgpt_task_session_bound', expectedRevision: null,
    });
    return value;
  });
}

export function reserveChatgptTaskSend(input: {
  controllerHome: string;
  repoId: string;
  taskId: string;
  sessionId: string;
  requestId: string;
  now?: string;
}): ChatgptTaskSessionBinding {
  const taskId = normalizedTaskId(input.taskId);
  const sessionId = normalizedSessionId(input.sessionId);
  const requestId = input.requestId.trim();
  if (!requestId || requestId.length > 256) throw new Error('CHATGPT_TASK_SEND_REQUEST_ID_INVALID');
  const timestamp = input.now ?? new Date().toISOString();
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const record = readControlPlaneRecordWithinTransaction<ChatgptTaskSessionBinding>(database, NAMESPACE, input.repoId, key(taskId));
    if (!record) throw new Error('CHATGPT_TASK_SESSION_NOT_BOUND');
    const current = assertRecord(record.value, input.repoId, taskId);
    const isActive = current.active.sessionId === sessionId;
    const isReplacementCandidate = current.replacement?.candidateSessionId === sessionId;
    if (!isActive && !isReplacementCandidate) throw new Error('CHATGPT_TASK_SESSION_STALE');
    if (current.pendingSend?.requestId === requestId) return current;
    if (current.pendingSend?.outcome === 'reserved' || current.pendingSend?.outcome === 'outcome_unknown') {
      throw new Error('CHATGPT_TASK_SEND_RECONCILIATION_REQUIRED');
    }
    const value: ChatgptTaskSessionBinding = {
      ...current,
      pendingSend: { requestId, sessionId, outcome: 'reserved', updatedAt: timestamp },
      updatedAt: timestamp,
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: input.repoId, key: key(taskId), schemaVersion: SCHEMA_VERSION,
      value, action: 'chatgpt_task_send_reserved', expectedRevision: record.revision,
    });
    return value;
  });
}

export function updateActiveChatgptTaskConversationUrl(input: {
  controllerHome: string;
  repoId: string;
  taskId: string;
  sessionId: string;
  conversationUrl: string;
  now?: string;
}): ChatgptTaskSessionBinding {
  const taskId = normalizedTaskId(input.taskId);
  const sessionId = normalizedSessionId(input.sessionId);
  const conversationUrl = canonicalConversationUrl(input.conversationUrl);
  const timestamp = input.now ?? new Date().toISOString();
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const record = readControlPlaneRecordWithinTransaction<ChatgptTaskSessionBinding>(database, NAMESPACE, input.repoId, key(taskId));
    if (!record) throw new Error('CHATGPT_TASK_SESSION_NOT_BOUND');
    const current = assertRecord(record.value, input.repoId, taskId);
    if (current.active.sessionId !== sessionId) throw new Error('CHATGPT_TASK_SESSION_STALE');
    if (current.active.conversationUrl === conversationUrl) return current;
    const value = { ...current, active: { ...current.active, conversationUrl }, updatedAt: timestamp };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: input.repoId, key: key(taskId), schemaVersion: SCHEMA_VERSION,
      value, action: 'chatgpt_task_conversation_url_observed', expectedRevision: record.revision,
    });
    return value;
  });
}

export function settleChatgptTaskSend(input: {
  controllerHome: string;
  repoId: string;
  taskId: string;
  requestId: string;
  outcome: Exclude<ChatgptSendOutcome, 'reserved'>;
  receiptId?: string;
  now?: string;
}): ChatgptTaskSessionBinding {
  const taskId = normalizedTaskId(input.taskId);
  const timestamp = input.now ?? new Date().toISOString();
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const record = readControlPlaneRecordWithinTransaction<ChatgptTaskSessionBinding>(database, NAMESPACE, input.repoId, key(taskId));
    if (!record) throw new Error('CHATGPT_TASK_SESSION_NOT_BOUND');
    const current = assertRecord(record.value, input.repoId, taskId);
    if (!current.pendingSend || current.pendingSend.requestId !== input.requestId) {
      throw new Error('CHATGPT_TASK_SEND_RECEIPT_STALE');
    }
    if (current.pendingSend.outcome !== 'reserved' && current.pendingSend.outcome !== input.outcome) {
      throw new Error('CHATGPT_TASK_SEND_OUTCOME_CONFLICT');
    }
    const pendingSend = {
      ...current.pendingSend,
      outcome: input.outcome,
      ...(input.receiptId?.trim() ? { receiptId: input.receiptId.trim() } : {}),
      updatedAt: timestamp,
    };
    const value: ChatgptTaskSessionBinding = {
      ...current,
      pendingSend,
      active: input.outcome === 'applied' && current.pendingSend.sessionId === current.active.sessionId
        ? { ...current.active, sendRequestId: input.requestId, ...(pendingSend.receiptId ? { sendReceiptId: pendingSend.receiptId } : {}) }
        : current.active,
      updatedAt: timestamp,
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: input.repoId, key: key(taskId), schemaVersion: SCHEMA_VERSION,
      value, action: `chatgpt_task_send_${input.outcome}`, expectedRevision: record.revision,
    });
    return value;
  });
}

export function beginChatgptTaskSessionReplacement(input: {
  controllerHome: string;
  repoId: string;
  taskId: string;
  expectedSessionId: string;
  candidateSessionId: string;
  reasonCode: string;
  now?: string;
}): ChatgptTaskSessionBinding {
  const taskId = normalizedTaskId(input.taskId);
  const expectedSessionId = normalizedSessionId(input.expectedSessionId);
  const candidateSessionId = normalizedSessionId(input.candidateSessionId);
  if (expectedSessionId === candidateSessionId) throw new Error('CHATGPT_TASK_REPLACEMENT_SESSION_CONFLICT');
  const timestamp = input.now ?? new Date().toISOString();
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const record = readControlPlaneRecordWithinTransaction<ChatgptTaskSessionBinding>(database, NAMESPACE, input.repoId, key(taskId));
    if (!record) throw new Error('CHATGPT_TASK_SESSION_NOT_BOUND');
    const current = assertRecord(record.value, input.repoId, taskId);
    if (current.active.sessionId !== expectedSessionId) throw new Error('CHATGPT_TASK_REPLACEMENT_STALE');
    if (current.pendingSend?.outcome === 'reserved' || current.pendingSend?.outcome === 'outcome_unknown') {
      throw new Error('CHATGPT_TASK_REPLACEMENT_PENDING_SEND');
    }
    if (current.replacement) {
      if (current.replacement.candidateSessionId === candidateSessionId) return current;
      throw new Error('CHATGPT_TASK_REPLACEMENT_ALREADY_PENDING');
    }
    const value: ChatgptTaskSessionBinding = {
      ...current,
      replacement: { sourceSessionId: expectedSessionId, candidateSessionId, reasonCode: input.reasonCode.trim(), startedAt: timestamp },
      pendingSend: undefined,
      updatedAt: timestamp,
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: input.repoId, key: key(taskId), schemaVersion: SCHEMA_VERSION,
      value, action: 'chatgpt_task_session_replacement_started', expectedRevision: record.revision,
    });
    return value;
  });
}

export function commitChatgptTaskSessionTakeover(input: {
  controllerHome: string;
  repoId: string;
  taskId: string;
  candidateSessionId: string;
  conversationUrl: string;
  sendRequestId: string;
  sendReceiptId: string;
  now?: string;
}): ChatgptTaskSessionBinding {
  const taskId = normalizedTaskId(input.taskId);
  const candidateSessionId = normalizedSessionId(input.candidateSessionId);
  const conversationUrl = canonicalConversationUrl(input.conversationUrl);
  const timestamp = input.now ?? new Date().toISOString();
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const record = readControlPlaneRecordWithinTransaction<ChatgptTaskSessionBinding>(database, NAMESPACE, input.repoId, key(taskId));
    if (!record) throw new Error('CHATGPT_TASK_SESSION_NOT_BOUND');
    const current = assertRecord(record.value, input.repoId, taskId);
    if (!current.replacement || current.replacement.candidateSessionId !== candidateSessionId) {
      if (current.active.sessionId === candidateSessionId && current.active.sendRequestId === input.sendRequestId) return current;
      throw new Error('CHATGPT_TASK_TAKEOVER_NOT_PENDING');
    }
    if (!current.pendingSend || current.pendingSend.sessionId !== candidateSessionId
      || current.pendingSend.requestId !== input.sendRequestId || current.pendingSend.outcome !== 'applied'
      || current.pendingSend.receiptId !== input.sendReceiptId) {
      throw new Error('CHATGPT_TASK_TAKEOVER_RECEIPT_REQUIRED');
    }
    const history = [...current.history, {
      ...current.active,
      archivedAt: timestamp,
      tabCleanup: 'pending' as const,
      replacedBySessionId: candidateSessionId,
    }].slice(-MAX_HISTORY);
    const value: ChatgptTaskSessionBinding = {
      ...current,
      active: {
        sessionId: candidateSessionId,
        conversationUrl,
        boundAt: timestamp,
        sendRequestId: input.sendRequestId,
        sendReceiptId: input.sendReceiptId,
      },
      pendingSend: undefined,
      replacement: undefined,
      history,
      updatedAt: timestamp,
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: input.repoId, key: key(taskId), schemaVersion: SCHEMA_VERSION,
      value, action: 'chatgpt_task_session_takeover_committed', expectedRevision: record.revision,
    });
    return value;
  });
}

export function confirmArchivedChatgptTabClosed(input: {
  controllerHome: string;
  repoId: string;
  taskId: string;
  sessionId: string;
  now?: string;
}): ChatgptTaskSessionBinding {
  const taskId = normalizedTaskId(input.taskId);
  const sessionId = normalizedSessionId(input.sessionId);
  const timestamp = input.now ?? new Date().toISOString();
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const record = readControlPlaneRecordWithinTransaction<ChatgptTaskSessionBinding>(database, NAMESPACE, input.repoId, key(taskId));
    if (!record) throw new Error('CHATGPT_TASK_SESSION_NOT_BOUND');
    const current = assertRecord(record.value, input.repoId, taskId);
    const history = current.history.map((entry) => entry.sessionId === sessionId ? { ...entry, tabCleanup: 'closed' as const } : entry);
    if (!history.some((entry) => entry.sessionId === sessionId)) throw new Error('CHATGPT_TASK_ARCHIVED_SESSION_NOT_FOUND');
    const value = { ...current, history, updatedAt: timestamp };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: input.repoId, key: key(taskId), schemaVersion: SCHEMA_VERSION,
      value, action: 'chatgpt_task_archived_tab_closed', expectedRevision: record.revision,
    });
    return value;
  });
}
