(() => {
  if (globalThis.__forgeProviderReadbackInstalledV1 === true) return;
  globalThis.__forgeProviderReadbackInstalledV1 = true;
  // ISOLATED content world: page window.postMessage is only a wake-up hint.
  // All terminal facts below come from a fresh authenticated HTTPS readback.
  const SOURCE = 'forge-computer-provider-turn-v1';
  const PROOF = 'chatgpt-conversation-readback-v1';
  const MAX_BODY = 8 * 1024 * 1024;
  // One bounded read-only verification per observed user Turn. A real
  // conversation POST produces only one wake-up hint; retry inside that
  // observation, never rely on another page event or resend the POST.
  const attempted = new Map();
  const MAX_TURNS_PER_DOCUMENT = 128;
  const MAX_READBACK_ATTEMPTS = 3;
  const RETRY_INTERVAL_MS = 3_000;
  // Reuse the existing Supervisor's slow read-only observation to re-arm a
  // settled-but-unverified Effect. No independent polling loop or durable state.
  const RECONCILE_INTERVAL_MS = 60_000;

  function conversationId() {
    const match = location.pathname.match(/(?:^|\/)c\/([0-9a-f-]{36})(?:\/|$)/i);
    return match?.[1]?.toLowerCase();
  }
  function matchesPrompt(message, hint) {
    if (message?.author?.role !== 'user' || (hint.turn_id && message?.id !== hint.turn_id)) return false;
    const parts = message?.content?.parts;
    if (!Array.isArray(parts)) return false;
    const lines = parts.filter((part) => typeof part === 'string').join('\n').split(/\r?\n/);
    return lines[0] === '<<<FORGE_WORKFLOW_EFFECT_V1:' + hint.effect_id + '>>>'
      && lines[1] === 'task_id:' + JSON.stringify(hint.task_id)
      && lines[2] === 'receipt:' + hint.receipt_challenge
      && lines.includes('provider_turn:conversation-readback-v1');
  }
  function verifiedAssistant(data, hint) {
    if (!data || data.conversation_id?.toLowerCase() !== hint.conversation_id.toLowerCase()
      || !Array.isArray(data.messages) || data.page_info?.has_next_page !== false) return;
    // The current paginated conversation API returns messages on the active
    // branch in order. A page with more *later* messages is never final proof.
    // Only the latest persisted user message can own the next final assistant.
    const index = data.messages.findLastIndex((message) => message?.author?.role === 'user');
    if (index < 0 || !matchesPrompt(data.messages[index], hint)) return;
    let assistant;
    for (const message of data.messages.slice(index + 1)) {
      if (message?.author?.role === 'user') return;
      if (message?.author?.role !== 'assistant' || (message.recipient && message.recipient !== 'all')) continue;
      // An earlier assistant final is not proof if a newer assistant is still
      // generating in this same exchange.
      const completed = message.status === 'finished_successfully' && message.end_turn === true;
      const failed = message.status === 'failed' || message.status === 'cancelled';
      assistant = (completed || failed) && typeof message.id === 'string'
        ? { ...message, outcome: failed ? 'failed' : 'completed' } : undefined;
    }
    return assistant && { ...assistant, verifiedUserTurnId: data.messages[index]?.id };
  }
  function retryAfterMs(response) {
    const value = response?.headers?.get?.('retry-after');
    if (!value) return RECONCILE_INTERVAL_MS;
    const seconds = Number(value);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return Math.max(RECONCILE_INTERVAL_MS, Math.min(86_400_000,
      Number.isFinite(duration) ? Math.max(0, duration) : RECONCILE_INTERVAL_MS));
  }
  async function readback(hint, trustedSnapshot = false) {
    // Never copy a page-origin claimed status, completion marker or HTTP code.
    if (!['completed', 'unknown'].includes(hint?.outcome)
      || conversationId() !== String(hint.conversation_id ?? '').toLowerCase()
      || !/^fx_[a-z0-9_-]{16,128}$/i.test(hint.effect_id ?? '')
      || typeof hint.task_id !== 'string' || !/^([0-9a-f]{7})$/.test(hint.receipt_challenge ?? '')
      || (!trustedSnapshot && typeof hint.turn_id !== 'string')
      || typeof hint.request_id !== 'string'
      || !Number.isSafeInteger(hint.started_at_ms)) return;
    const key = hint.effect_id;
    const prior = attempted.get(key);
    if ((attempted.size >= MAX_TURNS_PER_DOCUMENT && !prior)
      || prior?.completed || prior?.inFlight
      || (prior && (!trustedSnapshot || Date.now() < prior.nextProbeAt))) return;
    const state = prior ?? { completed: false, inFlight: false, nextProbeAt: 0 };
    state.inFlight = true;
    state.nextProbeAt = Date.now() + RECONCILE_INTERVAL_MS;
    attempted.set(key, state);
    try {
      for (let retry = 0; retry < MAX_READBACK_ATTEMPTS; retry += 1) {
        if (retry) await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
        try {
          const auth = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
          // 429 is provider backpressure, not a transient persistence lag.
          // Never challenge Retry-After with the bounded readback polling loop.
          if (auth.status === 429) { state.nextProbeAt = Date.now() + retryAfterMs(auth); return; }
          if (!auth.ok) continue;
          const session = await auth.json();
          const token = typeof session?.accessToken === 'string' ? session.accessToken : undefined;
          if (!token) continue;
          // The SSE stream can finish before the final assistant is persisted.
          // Recheck a maximum of twice per bounded attempt.
          for (let read = 0; read < 2; read += 1) {
            if (read) await new Promise((resolve) => setTimeout(resolve, 700));
            const response = await fetch('/backend-api/conversations/' + encodeURIComponent(hint.conversation_id)
              + '?include_has_versions=true&num_turns=100', {
              credentials: 'include', cache: 'no-store',
              headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
            });
            if (response.status === 429) { state.nextProbeAt = Date.now() + retryAfterMs(response); return; }
            if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) break;
            if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY) break;
            const body = await response.text();
            if (body.length > MAX_BODY) break;
            const assistant = verifiedAssistant(JSON.parse(body), hint);
            if (!assistant) continue;
            const failed = assistant.outcome === 'failed';
            const accepted = await chrome.runtime.sendMessage({
              type: 'forge-computer-provider-turn-event',
              event: {
                task_id: hint.task_id, effect_id: hint.effect_id, receipt_challenge: hint.receipt_challenge,
                turn_id: assistant.verifiedUserTurnId, request_id: hint.request_id,
                conversation_id: hint.conversation_id, started_at_ms: hint.started_at_ms,
                outcome: failed ? 'failed' : 'completed', status_code: 200, content_type: 'application/json',
                proof_source: PROOF, assistant_message_id: assistant.id,
                assistant_status: assistant.status, assistant_end_turn: assistant.end_turn === true,
                ...(failed ? {
                  stream_done: true,
                  failure_code: assistant.status === 'cancelled'
                    ? 'CHATGPT_PROVIDER_TURN_CANCELLED' : 'CHATGPT_PROVIDER_TURN_FAILED',
                } : {}),
              },
            });
            // The existing Computer outbox owns durability. A transient refusal
            // may be reconciled via read-only GET; never repeat the original Send.
            if (accepted?.accepted === true) { state.completed = true; return; }
            if (accepted?.retryable === false) return;
            break;
          }
        } catch { /* No trusted proof; keep the original Effect unknown. */ }
      }
    } finally { state.inFlight = false; }
  }
  // Only the extension's existing exact-tab snapshot receiver may re-arm an
  // unresolved Effect. DOM is a wake-up hint, never a completion credential.
  // The authenticated GET supplies the real user message ID and final reply.
  globalThis.__forgeProviderReadbackFromSnapshot = (userText) => {
    if (typeof userText !== 'string' || !conversationId()) return;
    const lines = userText.split(/\r?\n/);
    const effect = /^<<<FORGE_WORKFLOW_EFFECT_V1:(fx_[a-z0-9_-]{16,128})>>>$/i.exec(lines[0] ?? '');
    const receipt = /^receipt:([0-9a-f]{7})$/.exec(lines[2] ?? '');
    if (!effect || !receipt || !lines.includes('provider_turn:conversation-readback-v1')) return;
    let taskId;
    try { taskId = JSON.parse((lines[1] ?? '').replace(/^task_id:/, '')); } catch { return; }
    if (!lines[1]?.startsWith('task_id:') || typeof taskId !== 'string' || !taskId) return;
    void readback({
      task_id: taskId, effect_id: effect[1], receipt_challenge: receipt[1],
      conversation_id: conversationId(), request_id: crypto.randomUUID(),
      started_at_ms: Date.now(), outcome: 'unknown',
    }, true);
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== SOURCE || event.data?.type !== 'turn-event') return;
    void readback(event.data.event);
  });
})();
