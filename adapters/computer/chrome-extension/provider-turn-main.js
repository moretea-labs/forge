(() => {
  if (globalThis.__forgeProviderTurnObserverV1 === true) return;
  globalThis.__forgeProviderTurnObserverV1 = true;

  const SOURCE = 'forge-computer-provider-turn-v1';
  const MARKER = 'provider_turn:sse-final-v1';
  const MAX_STREAM_BYTES = 8 * 1024 * 1024;
  const MAX_FRAME_CHARS = 2 * 1024 * 1024;
  const CONVERSATION_PATH = '/backend-api/conversation';

  function safeText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    return normalized.length <= maxLength ? normalized : '';
  }
  function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function conversationIdFromUrl(value) {
    try {
      const url = new URL(String(value ?? ''), location.href);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return '';
      const match = url.pathname.match(/(?:^|\/)c\/([0-9a-f-]{36})(?:\/|$)/i);
      return match ? match[1] : '';
    } catch { return ''; }
  }
  function promptFromMessage(message) {
    const parts = message?.content?.parts;
    if (Array.isArray(parts)) return parts.filter((part) => typeof part === 'string').join('\n');
    return typeof message?.content?.text === 'string' ? message.content.text : '';
  }
  async function requestInfo(input, init) {
    let url;
    let method;
    let body = init?.body;
    try {
      if (typeof input === 'string' || input instanceof URL) url = new URL(String(input), location.href);
      else if (input && typeof input.url === 'string') url = new URL(input.url, location.href);
      else return undefined;
      method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com'
        || url.pathname !== CONVERSATION_PATH || method !== 'POST') return undefined;
      if (body === undefined && input instanceof Request) body = await input.clone().text();
      else if (body instanceof URLSearchParams) body = body.toString();
      else if (body instanceof Blob) body = await body.text();
      if (typeof body !== 'string' || !body.trim()) return undefined;
      const payload = JSON.parse(body);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      let userMessage;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.author?.role === 'user') { userMessage = messages[index]; break; }
      }
      const prompt = promptFromMessage(userMessage);
      if (!prompt) return undefined;
      const lines = prompt.split(/\r?\n/);
      const effectMatch = String(lines[0] ?? '').match(/^<<<FORGE_WORKFLOW_EFFECT_V1:([A-Za-z0-9_-]+)>>>$/);
      const taskLine = String(lines[1] ?? '');
      const receiptMatch = String(lines[2] ?? '').match(/^receipt:([0-9a-f]{7})$/);
      if (!effectMatch || !taskLine.startsWith('task_id:') || !receiptMatch || !lines.includes(MARKER)) return undefined;
      let taskId;
      try { taskId = JSON.parse(taskLine.slice(8)); } catch { return undefined; }
      const turnId = safeText(userMessage?.id, 256);
      if (typeof taskId !== 'string' || !taskId.trim() || !turnId) return undefined;
      return {
        taskId: taskId.trim(),
        effectId: effectMatch[1],
        receiptChallenge: receiptMatch[1],
        turnId,
        requestId: uuid(),
        startedAtMs: Date.now(),
        conversationId: safeText(payload.conversation_id, 256) || conversationIdFromUrl(location.href),
      };
    } catch { return undefined; }
  }
  function retryAfterMilliseconds(value, nowMs) {
    const raw = safeText(value, 256);
    if (!raw) return undefined;
    const seconds = Number(raw);
    const parsed = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : Date.parse(raw) - nowMs;
    return Number.isFinite(parsed) ? Math.max(0, Math.min(86_400_000, parsed)) : undefined;
  }
  function emit(info, fields) {
    const conversationId = safeText(fields.conversationId || info.conversationId, 256);
    if (!conversationId) return;
    const event = {
      task_id: info.taskId,
      effect_id: info.effectId,
      receipt_challenge: info.receiptChallenge,
      turn_id: info.turnId,
      request_id: info.requestId,
      conversation_id: conversationId,
      started_at_ms: info.startedAtMs,
      outcome: fields.outcome,
      status_code: fields.statusCode,
      ...(fields.contentType ? { content_type: fields.contentType.slice(0, 256) } : {}),
      ...(fields.assistantMessageId ? { assistant_message_id: fields.assistantMessageId } : {}),
      ...(fields.assistantStatus ? { assistant_status: fields.assistantStatus } : {}),
      ...(typeof fields.assistantEndTurn === 'boolean' ? { assistant_end_turn: fields.assistantEndTurn } : {}),
      ...(typeof fields.streamDone === 'boolean' ? { stream_done: fields.streamDone } : {}),
      ...(fields.failureCode ? { failure_code: fields.failureCode } : {}),
      ...(Number.isSafeInteger(fields.retryAfterMs) ? { retry_after_ms: fields.retryAfterMs } : {}),
    };
    window.postMessage({ source: SOURCE, type: 'turn-event', event }, location.origin);
  }
  function updateMessage(state, message) {
    if (!message || typeof message !== 'object') return;
    const role = message.author?.role;
    if (role && role !== 'assistant') return;
    if (role === 'assistant' || message.id || message.status) {
      state.assistantMessageId = safeText(message.id, 256) || state.assistantMessageId;
      state.assistantStatus = safeText(message.status, 64) || state.assistantStatus;
      state.assistantEndTurn = typeof message.end_turn === 'boolean' ? message.end_turn : state.assistantEndTurn;
      if (state.assistantStatus === 'failed' || state.assistantStatus === 'cancelled') state.explicitFailure = true;
    }
  }
  function updatePatch(state, patch) {
    if (!patch || typeof patch !== 'object') return;
    if (patch.p === '' && patch.v && typeof patch.v === 'object' && patch.v.message) updateMessage(state, patch.v.message);
    const path = String(patch.p ?? '');
    if (path === '/message' && patch.v && typeof patch.v === 'object') updateMessage(state, patch.v);
    if (path === '/message/id') state.assistantMessageId = safeText(patch.v, 256) || state.assistantMessageId;
    if (path === '/message/author/role' && patch.v !== 'assistant') state.assistantStatus = '';
    if (path === '/message/status') {
      state.assistantStatus = safeText(patch.v, 64);
      if (state.assistantStatus === 'failed' || state.assistantStatus === 'cancelled') state.explicitFailure = true;
    }
    if (path === '/message/end_turn' && typeof patch.v === 'boolean') state.assistantEndTurn = patch.v;
    if (patch.o === 'patch' && Array.isArray(patch.v)) for (const item of patch.v) updatePatch(state, item);
  }
  function processPayload(state, payload) {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.conversation_id === 'string') state.conversationId = payload.conversation_id;
    if (payload.error !== undefined && payload.error !== null && payload.error !== false) state.explicitFailure = true;
    if (payload.type === 'message_stream_complete') state.messageStreamComplete = true;
    if (payload.type === 'error' || payload.type === 'message_error' || payload.type === 'turn_failed') state.explicitFailure = true;
    if (payload.message) updateMessage(state, payload.message);
    if (payload.v && typeof payload.v === 'object' && payload.v.message) {
      if (typeof payload.v.conversation_id === 'string') state.conversationId = payload.v.conversation_id;
      updateMessage(state, payload.v.message);
    }
    if (typeof payload.p === 'string') updatePatch(state, payload);
  }
  function processFrame(state, frame) {
    const dataLines = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^\s/, ''));
    if (!dataLines.length) return;
    const data = dataLines.join('\n').trim();
    if (data === '[DONE]') { state.streamDone = true; return; }
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    processPayload(state, payload);
  }
  async function observeResponse(response, info) {
    const statusCode = Number(response?.status) || 0;
    const contentType = safeText(response?.headers?.get?.('content-type') ?? '', 256);
    if (statusCode === 429) {
      emit(info, { outcome: 'failed', statusCode, contentType, failureCode: 'CHATGPT_AUTOMATION_RATE_LIMITED',
        retryAfterMs: retryAfterMilliseconds(response.headers?.get?.('retry-after'), Date.now()), conversationId: info.conversationId });
      return;
    }
    if (statusCode >= 400 && statusCode < 500) {
      emit(info, { outcome: 'failed', statusCode, contentType, failureCode: 'CHATGPT_PROVIDER_HTTP_' + statusCode, conversationId: info.conversationId });
      return;
    }
    if (statusCode !== 200 || !contentType.toLowerCase().includes('text/event-stream')) {
      emit(info, { outcome: 'unknown', statusCode, contentType, failureCode: 'CHATGPT_PROVIDER_RESPONSE_STREAM_UNAVAILABLE', conversationId: info.conversationId });
      return;
    }
    let clone;
    try { clone = response.clone(); } catch {
      emit(info, { outcome: 'unknown', statusCode, contentType, failureCode: 'CHATGPT_PROVIDER_RESPONSE_STREAM_UNAVAILABLE', conversationId: info.conversationId });
      return;
    }
    if (!clone.body) {
      emit(info, { outcome: 'unknown', statusCode, contentType, failureCode: 'CHATGPT_PROVIDER_RESPONSE_STREAM_UNAVAILABLE', conversationId: info.conversationId });
      return;
    }
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    const state = { conversationId: info.conversationId, assistantMessageId: '', assistantStatus: '', assistantEndTurn: undefined,
      streamDone: false, explicitFailure: false, bytesRead: 0 };
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        state.bytesRead += result.value?.byteLength ?? 0;
        if (state.bytesRead > MAX_STREAM_BYTES) throw new Error('CHATGPT_PROVIDER_STREAM_OBSERVATION_LIMIT');
        buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > MAX_FRAME_CHARS) throw new Error('CHATGPT_PROVIDER_STREAM_FRAME_LIMIT');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          processFrame(state, buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processFrame(state, buffer);
    } catch {
      emit(info, { outcome: 'unknown', statusCode, contentType, failureCode: 'CHATGPT_PROVIDER_RESPONSE_STREAM_UNAVAILABLE',
        conversationId: state.conversationId });
      return;
    }
    if (state.explicitFailure && state.streamDone) {
      emit(info, { outcome: 'failed', statusCode, contentType, failureCode: 'CHATGPT_PROVIDER_TURN_FAILED',
        assistantMessageId: state.assistantMessageId, assistantStatus: state.assistantStatus || 'failed',
        assistantEndTurn: state.assistantEndTurn, streamDone: true, conversationId: state.conversationId });
      return;
    }
    if (state.streamDone && state.assistantMessageId && state.assistantStatus === 'finished_successfully' && state.assistantEndTurn === true) {
      emit(info, { outcome: 'completed', statusCode, contentType, assistantMessageId: state.assistantMessageId,
        assistantStatus: state.assistantStatus, assistantEndTurn: true, streamDone: true, conversationId: state.conversationId });
      return;
    }
    emit(info, { outcome: 'unknown', statusCode, contentType, failureCode: 'CHATGPT_PROVIDER_TURN_COMPLETION_MISSING',
      assistantMessageId: state.assistantMessageId, assistantStatus: state.assistantStatus,
      assistantEndTurn: state.assistantEndTurn, streamDone: state.streamDone, conversationId: state.conversationId });
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;
  window.fetch = function(input, init) {
    let infoPromise;
    try { infoPromise = requestInfo(input, init).catch(() => undefined); } catch {}
    let responsePromise;
    try { responsePromise = originalFetch.apply(this, arguments); }
    catch (error) {
      if (infoPromise) void infoPromise.then((info) => {
        if (info) emit(info, { outcome: 'unknown', statusCode: 0, failureCode: 'CHATGPT_PROVIDER_RESPONSE_STREAM_UNAVAILABLE' });
      });
      throw error;
    }
    return Promise.resolve(responsePromise).then((response) => {
      if (infoPromise) void infoPromise.then((info) => {
        if (info) void observeResponse(response, info).catch(() => emit(info, {
          outcome: 'unknown', statusCode: Number(response?.status) || 0,
          failureCode: 'CHATGPT_PROVIDER_RESPONSE_STREAM_UNAVAILABLE',
        }));
      });
      return response;
    }, (error) => {
      if (infoPromise) void infoPromise.then((info) => {
        if (info) emit(info, { outcome: 'unknown', statusCode: 0, failureCode: 'CHATGPT_PROVIDER_RESPONSE_STREAM_UNAVAILABLE' });
      });
      throw error;
    });
  };
})();
