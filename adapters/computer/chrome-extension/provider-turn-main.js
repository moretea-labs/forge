(() => {
  if (globalThis.__forgeProviderTurnObserverV1 === true) return;
  globalThis.__forgeProviderTurnObserverV1 = true;

  const SOURCE = 'forge-computer-provider-turn-v1';
  const MARKER = 'provider_turn:conversation-readback-v1';
  const MAX_STREAM_BYTES = 8 * 1024 * 1024;
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
  // MAIN-world is page-controlled. Emit only an exact request *wake-up* hint;
  // the ISOLATED conversation readback owns all final assistant evidence.
  function emitHint(info, statusCode) {
    if (!info.conversationId) return;
    window.postMessage({ source: SOURCE, type: 'turn-event', event: {
      task_id: info.taskId,
      effect_id: info.effectId,
      receipt_challenge: info.receiptChallenge,
      turn_id: info.turnId,
      request_id: info.requestId,
      conversation_id: info.conversationId,
      started_at_ms: info.startedAtMs,
      outcome: 'unknown',
      status_code: statusCode,
    } }, location.origin);
  }
  async function observeResponse(response, info) {
    const statusCode = Number(response?.status) || 0;
    if (statusCode === 200 && response?.headers?.get?.('content-type')?.toLowerCase().includes('text/event-stream')) {
      // Wait for the response stream to settle before the isolated GET. Its
      // contents are untrusted and never parsed as terminal authorization.
      try {
        const reader = response.clone().body?.getReader();
        if (reader) {
          let bytes = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value?.byteLength ?? 0;
            if (bytes > MAX_STREAM_BYTES) break;
          }
          await reader.cancel().catch(() => undefined);
        }
      } catch { /* The trusted readback will reject an unfinished Turn. */ }
    }
    emitHint(info, statusCode);
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
        if (info) emitHint(info, 0);
      });
      throw error;
    }
    return Promise.resolve(responsePromise).then((response) => {
      if (infoPromise) void infoPromise.then((info) => {
        if (info) void observeResponse(response, info).catch(() => emitHint(info, Number(response?.status) || 0));
      });
      return response;
    }, (error) => {
      if (infoPromise) void infoPromise.then((info) => {
        if (info) emitHint(info, 0);
      });
      throw error;
    });
  };
})();
