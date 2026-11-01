(() => {
  if (globalThis.__forgeProviderReadbackInstalledV1 === true) return;
  globalThis.__forgeProviderReadbackInstalledV1 = true;
  // ISOLATED content world: page window.postMessage is only a wake-up hint.
  // All terminal facts below come from a fresh authenticated HTTPS readback.
  const SOURCE = 'forge-computer-provider-turn-v1';
  const PROOF = 'chatgpt-conversation-readback-v1';
  const MAX_BODY = 8 * 1024 * 1024;
  const inFlight = new Set();

  function conversationId() {
    const match = location.pathname.match(/(?:^|\/)c\/([0-9a-f-]{36})(?:\/|$)/i);
    return match?.[1]?.toLowerCase();
  }
  function matchesPrompt(message, hint) {
    if (message?.id !== hint.turn_id || message?.author?.role !== 'user') return false;
    const parts = message?.content?.parts;
    if (!Array.isArray(parts)) return false;
    const lines = parts.filter((part) => typeof part === 'string').join('\n').split(/\r?\n/);
    return lines[0] === '<<<FORGE_WORKFLOW_EFFECT_V1:' + hint.effect_id + '>>>'
      && lines[1] === 'task_id:' + JSON.stringify(hint.task_id)
      && lines[2] === 'receipt:' + hint.receipt_challenge
      && lines.includes('provider_turn:sse-final-v1');
  }
  function verifiedAssistant(data, hint) {
    if (!data || data.conversation_id?.toLowerCase() !== hint.conversation_id.toLowerCase()
      || !Array.isArray(data.messages)) return;
    const index = data.messages.findIndex((message) => matchesPrompt(message, hint));
    if (index < 0) return; // A page hint cannot create its own matching server-side user message.
    let assistant;
    for (const message of data.messages.slice(index + 1)) {
      if (message?.author?.role === 'user') return; // Not the current exchange.
      if (message?.author?.role !== 'assistant' || (message.recipient && message.recipient !== 'all')) continue;
      if (message.status === 'finished_successfully' && message.end_turn === true && typeof message.id === 'string') {
        assistant = message;
      }
    }
    return assistant;
  }
  async function readback(hint) {
    // Never copy a page-origin claimed status, completion marker or HTTP code.
    if (!['completed', 'unknown'].includes(hint?.outcome)
      || conversationId() !== String(hint.conversation_id ?? '').toLowerCase()
      || !/^fx_[a-z0-9_-]{16,128}$/i.test(hint.effect_id ?? '')
      || typeof hint.task_id !== 'string' || !/^([0-9a-f]{7})$/.test(hint.receipt_challenge ?? '')
      || typeof hint.turn_id !== 'string' || typeof hint.request_id !== 'string'
      || !Number.isSafeInteger(hint.started_at_ms)) return;
    const key = hint.effect_id + ':' + hint.turn_id;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const auth = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
      if (!auth.ok) return;
      const session = await auth.json();
      const token = typeof session?.accessToken === 'string' ? session.accessToken : '';
      if (!token) return;
      const response = await fetch('/backend-api/conversations/' + encodeURIComponent(hint.conversation_id)
        + '?include_has_versions=true&num_turns=100', {
        credentials: 'include', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) return;
      if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY) return;
      const body = await response.text();
      if (body.length > MAX_BODY) return;
      const assistant = verifiedAssistant(JSON.parse(body), hint);
      if (!assistant) return;
      await chrome.runtime.sendMessage({
        type: 'forge-computer-provider-turn-event',
        event: {
          task_id: hint.task_id, effect_id: hint.effect_id, receipt_challenge: hint.receipt_challenge,
          turn_id: hint.turn_id, request_id: hint.request_id,
          conversation_id: hint.conversation_id, started_at_ms: hint.started_at_ms,
          outcome: 'completed', status_code: 200, content_type: 'application/json',
          proof_source: PROOF, assistant_message_id: assistant.id,
          assistant_status: 'finished_successfully', assistant_end_turn: true,
        },
      });
    } catch { /* No provider proof; keep the Effect unknown, never retry its Send. */ }
    finally { inFlight.delete(key); }
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== SOURCE || event.data?.type !== 'turn-event') return;
    void readback(event.data.event);
  });
})();
