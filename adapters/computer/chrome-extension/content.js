(() => {
  const core = globalThis.ForgeComputerChatgptCore;
  if (!core) throw new Error('FORGE_COMPUTER_CHATGPT_CORE_MISSING');
  // Declarative document_idle loading and exact-tab receiver recovery can race.
  // Install one listener set per document or one Send could be handled twice.
  if (globalThis.__forgeComputerChatgptContentInstalledV1 === true) return;
  globalThis.__forgeComputerChatgptContentInstalledV1 = true;
  const ASSISTANT = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
  const USER = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]';
  const COMPOSER = '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-text-input"], textarea[name="prompt"], textarea[placeholder*="Message"], textarea[placeholder*="消息"], form [contenteditable="true"], div[role="textbox"][contenteditable="true"]';
  const SEND = 'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"], button[data-testid*="send"]';
  const STOP = '[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"]';
  const TURN = '[data-testid^="conversation-turn-"]';
  const PROVIDER_ACTIVITY_CHARS = 64 * 1024;
  const PROVIDER_FAILURE_CHARS = 250_000;
  const absoluteChatgptUrl = (href) => {
    try { const url = new URL(String(href ?? ''), location.href); return url.protocol === 'https:' && url.hostname === 'chatgpt.com' ? url.toString() : undefined; }
    catch { return undefined; }
  };
  const visible = (node) => Boolean(node?.getClientRects?.().length);
  /**
   * The hydrated conversation surface is the visible `main`. ChatGPT also
   * renders hidden SSR shells, and reading those into role/progress extraction
   * reports turns that the signed-in page is not actually showing.
   */
  const conversationRoot = () => {
    const mains = Array.from(document.querySelectorAll('main')).filter(visible);
    return mains.length ? mains[mains.length - 1] : document;
  };
  const discoverProjectLinks = (titles) => {
    const wanted = new Map((Array.isArray(titles) ? titles : []).map((title) => [core.normalizeText(title).toLocaleLowerCase(), core.normalizeText(title)]).filter(([key]) => key));
    const seen = new Set();
    const projects = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const title = core.normalizeText(anchor.innerText ?? anchor.textContent);
      const matched = wanted.get(title.toLocaleLowerCase());
      const url = absoluteChatgptUrl(anchor.getAttribute('href'));
      if (!matched || !url || seen.has(`${matched}\n${url}`)) continue;
      seen.add(`${matched}\n${url}`);
      projects.push({ title: matched, url });
    }
    return projects;
  };
  const discoverConversationLinks = () => {
    const seen = new Set();
    const conversations = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const parsed = core.parseConversation(absoluteChatgptUrl(anchor.getAttribute('href')) ?? '');
      if (!parsed || seen.has(parsed.conversationId)) continue;
      seen.add(parsed.conversationId);
      const title = core.normalizeText(anchor.innerText ?? anchor.textContent);
      conversations.push({ conversationId: parsed.conversationId, canonicalUrl: parsed.canonicalUrl, ...(title ? { title: title.slice(0, 512) } : {}) });
    }
    return conversations;
  };
  const messageText = (node) => {
    if (!node) return '';
    const semanticContent = node.querySelector?.('[data-chatgpt-selection-message-id]');
    // Message line boundaries carry the final Supervisor receipt. Normalizing
    // them like UI labels destroys the protocol before the owner can parse it.
    return String(semanticContent?.innerText ?? semanticContent?.textContent ?? node.innerText ?? node.textContent ?? '').trim();
  };
  const roleNodes = (selector) => {
    const seen = new Set();
    const result = [];
    for (const node of conversationRoot().querySelectorAll(selector)) {
      const semanticKey = String(node.getAttribute?.('data-chatgpt-search-unit-key') || node.getAttribute?.('data-content-search-unit-key') || '');
      const messageIds = String(node.getAttribute?.('data-chatgpt-search-message-ids') || node.getAttribute?.('data-chatgpt-selection-message-id') || '');
      if (semanticKey || messageIds) {
        const key = `${semanticKey}|${messageIds}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      result.push(node);
    }
    return result;
  };
  const latestTurnRole = () => {
    const nodes = conversationRoot().querySelectorAll(`${USER}, ${ASSISTANT}`);
    const node = nodes.item(nodes.length - 1);
    const explicit = node?.getAttribute?.('data-message-author-role');
    if (explicit === 'user' || explicit === 'assistant') return explicit;
    const semanticKey = String(node?.getAttribute?.('data-chatgpt-search-unit-key') || node?.getAttribute?.('data-content-search-unit-key') || '');
    if (semanticKey.endsWith(':user')) return 'user';
    if (semanticKey.endsWith(':assistant')) return 'assistant';
    return undefined;
  };
  /**
   * Provider generation evidence. A visible stop/stream control is searched
   * page-wide because missing it would allow a concurrent submission, but it
   * must be *visible*: the previous query accepted hidden SSR controls, and a
   * page-global `aria-busy` also fires for unrelated profile/route loading, so
   * `aria-busy` is trusted only inside the current conversation turn.
   */
  const isGenerating = () => {
    if (Array.from(document.querySelectorAll(`${STOP}, [data-is-streaming="true"]`)).some(visible)) return true;
    const turns = conversationRoot().querySelectorAll(TURN);
    const current = turns.length ? turns[turns.length - 1] : undefined;
    if (current && Array.from(current.querySelectorAll('[aria-busy="true"]')).some(visible)) return true;
    return latestTurnRole() === 'user';
  };
  /**
   * Live progress of the running provider turn. The last *committed* assistant
   * answer cannot change while a new turn runs, so liveness has to read the live
   * turn surface. Without it every turn that outlasts the quiet window was
   * misread as stalled and earned a duplicate provider prompt.
   */
  const providerActivityText = () => {
    const turns = conversationRoot().querySelectorAll(TURN);
    const current = turns.length ? turns[turns.length - 1] : undefined;
    return core.normalizeText(current?.innerText ?? current?.textContent).slice(-PROVIDER_ACTIVITY_CHARS);
  };
  const providerFailureText = () => {
    // The conversation-capacity banner is not always an ARIA alert.
    // Read visible, short, non-message status nodes only; ordinary conversation
    // history must never be interpreted as a current provider failure.
    const status = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]'))
      .filter(visible);
    const capacity = Array.from(conversationRoot().querySelectorAll('p, span, div'))
      // Exclude message subtrees before layout-dependent visibility reads.
      .filter((node) => !node.closest(TURN) && !node.closest('[data-message-author-role]') && visible(node))
      .filter((node) => {
        const text = core.normalizeText(node.innerText ?? node.textContent);
        return text.length <= 250 && /(?:你已达到此对话的长度上限|此对话已达到长度上限|you(?:'ve| have) reached the (?:maximum length for this conversation|conversation length limit)|this conversation has reached its maximum length)/i.test(text);
      });
    return [...status, ...capacity]
      .map((node) => core.normalizeText(node.innerText ?? node.textContent))
      .filter(Boolean).slice(-8).join('\n').slice(-PROVIDER_FAILURE_CHARS);
  };
  // Project pages can retain hidden SSR editors beside the live hydrated one.
  // Resolve one visible editor, preferring the active main, or fail closed:
  // a hidden editor's draft is not proof that the task-owned composer is busy.
  const composer = () => {
    const visibleEditors = Array.from(document.querySelectorAll(COMPOSER))
      .filter((node) => visible(node) && !node.closest?.('[aria-hidden="true"], [hidden], [inert]'));
    const root = conversationRoot();
    const inMain = root === document ? [] : visibleEditors.filter((node) => root.contains?.(node));
    const candidates = inMain.length ? inMain : visibleEditors;
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  // Editor text is a provider payload, not a UI label: preserve its whitespace.
  const exactComposerText = (value) => String(value ?? '').replace(/\r\n?/g, '\n');
  const composerText = (editor = composer()) => {
    const blocks = editor?.isContentEditable ? Array.from(editor.children ?? []) : [];
    // ChatGPT's ProseMirror writes one P block per entered newline but
    // HTMLElement.innerText synthesizes TWO newlines between those blocks.
    // Reconstruct the actual editor payload from its direct paragraphs rather
    // than comparing synthetic layout whitespace to an immutable effect.
    const observed = blocks.length > 0 && blocks.every((block) => block.tagName === 'P')
      ? blocks.map((block) => {
        // innerText may insert a *visual* newline around auto-linked URLs or
        // inline styled descendants even inside one ProseMirror paragraph.
        // One direct <p> is one actual editor line: read its text nodes.
        const value = exactComposerText(block.textContent ?? block.innerText);
        return !value.trim() ? '' : value;
      }).join('\n')
      : editor?.value ?? editor?.innerText ?? editor?.textContent;
    const text = exactComposerText(observed);
    // Only whitespace-only *empty* editors collapse; all nonblank text,
    // including leading/trailing spaces and intentional blank lines, remains
    // byte-for-byte subject only to CRLF normalization.
    return text.trim() ? text : '';
  };
  const pageSnapshot = (options = {}) => {
    const userNodes = roleNodes(USER);
    const assistantNodes = roleNodes(ASSISTANT);
    // Reading innerText on the entire page can force layout on every poll.
    // Only collect it when a caller explicitly requests the full page.
    const editor = composer();
    return {
      url: location.href,
      title: document.title,
      latestUserText: messageText(userNodes[userNodes.length - 1]),
      latestAssistantResponse: messageText(assistantNodes[assistantNodes.length - 1]),
      ...(options.includeUserHistory === true ? {
        userMessages: userNodes.map(messageText).filter(Boolean),
        assistantMessages: assistantNodes.map(messageText).filter(Boolean),
      } : {}),
      ...(editor ? { composerText: composerText(editor) } : {}),
      composerSelectorVersion: 'visible-single-v2',
      composerReplacementContract: 'exact-backed-up-project-draft-v1',
      // Read-only hydration attestation for a NEW Project bootstrap tab.
      // URL/DOM shell visibility alone cannot prove that the React model
      // picker has mounted or that the provider editor is send-ready.
      providerActivityText: providerActivityText(),
      providerFailureText: providerFailureText(),
      ...(options.includePageText === true ? { pageText: String(document.body?.innerText ?? '').slice(-500000) } : {}),
      latestTurnRole: latestTurnRole(),
      isGenerating: isGenerating(),
    };
  };
  const writeComposer = (node, prompt) => {
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(node, prompt); else node.value = prompt;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      return;
    }
    if (node.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!document.execCommand('insertText', false, prompt)) {
        node.textContent = prompt;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      }
      selection?.removeAllRanges();
    }
  };
  const dispatchPrompt = async (prompt, mode = 'send', expectedConversationId, prepareOnly = false, expectedProjectId) => {
    const exactConversationIsCurrent = () => expectedConversationId
      ? core.parseConversation(location.href)?.conversationId === expectedConversationId
      : expectedProjectId ? core.projectId(location.href) === expectedProjectId && !core.parseConversation(location.href)
        : true;
    if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
    if (typeof prompt !== 'string' || !prompt.trim()) return { dispatched: false, reason: 'prompt_required' };
    // This bounded prepare-only envelope is produced by the canonical
    // Supervisor only after an exact 0600 on-device backup and operator marker.
    // It is never part of a sent effect and never authorizes another provider.
    const replacement = /^<<<FORGE_DRAFT_REPLACE_V1:([a-f0-9]{24}):([a-f0-9]{32})>>>\n/.exec(prompt);
    if (replacement && (!prepareOnly || !expectedProjectId || mode !== 'send')) {
      return { dispatched: false, reason: 'composer_replacement_mode_invalid' };
    }
    // Prepare-only exact retirement; never submits or retries the stopped task.
    const retired = /^<<<FORGE_RETIRED_DRAFT_V1:((?:fx|crpe)_[a-zA-Z0-9_-]{8,120}):([a-f0-9]{24})>>>\n/.exec(prompt);
    if (retired && (!prepareOnly || !expectedProjectId || mode !== 'send' || replacement)) {
      return { dispatched: false, reason: 'composer_replacement_mode_invalid' };
    }
    const actualPrompt = replacement ? prompt.slice(replacement[0].length)
      : retired ? prompt.slice(retired[0].length) : prompt;
    if (mode === 'recover') {
      const stop = document.querySelector(STOP);
      if (prepareOnly && stop instanceof HTMLElement) return { prepared: false, reason: 'provider_recovery_stop_pending' };
      if (stop instanceof HTMLElement) {
        if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
        stop.click();
        for (let attempt = 0; attempt < 20 && document.querySelector(STOP); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
        }
        if (document.querySelector(STOP)) return { dispatched: false, reason: 'provider_recovery_stop_unconfirmed' };
      }
    } else if (isGenerating()) return { dispatched: false, reason: 'provider_busy' };
    const node = composer();
    if (!node) return { dispatched: false, reason: 'composer_missing' };
    // Project instructions select tools. No @forge UI mention is needed.
    const supervisor = /^(?:@forge\s+)?<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>/.test(actualPrompt);
    if (supervisor && !expectedConversationId && !expectedProjectId) return { dispatched: false, reason: 'target_identity_unavailable' };
    // Strip only the exact legacy prefix on already-durable effects.
    const payload = supervisor ? actualPrompt.replace(/^@forge\s+(?=<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>)/, '') : actualPrompt;
    const expected = exactComposerText(payload);
    const existing = composerText();
    // A restored draft belongs to this effect only when it matches precisely.
    // Never overwrite another task's draft or a human-authored message.
    const ownedDrafts = supervisor
      ? [expected, expected + '\n', exactComposerText(payload + '\n@'), exactComposerText(payload + '\nforge'), exactComposerText('forge ' + payload)]
      : [expected];
    if (node.querySelector('[plugin-mention-name], [app-mention-name]')) return { dispatched: false, reason: 'composer_has_app_mention' };
    const unowned = Boolean(existing && !ownedDrafts.includes(existing));
    if (unowned && ((!replacement && !retired) || !supervisor)) return { dispatched: false, reason: 'composer_not_empty' };
    if (retired && (!unowned || !existing.startsWith(`<<<FORGE_WORKFLOW_EFFECT_V1:${retired[1]}>>>`))) {
      return { dispatched: false, reason: 'composer_not_empty' };
    }
    if (unowned) {
      // Hash the *currently visible* single editor, not the page or another
      // tab. If it changed since the backup, do not touch it.
      if (!globalThis.crypto?.subtle || !globalThis.TextEncoder) return { dispatched: false, reason: 'composer_replacement_digest_unavailable' };
      const bytes = new TextEncoder().encode('preflight-composer-v1:\0' + existing);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const prefix = Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
      if (prefix !== (replacement ? replacement[1] : retired?.[2])) return { dispatched: false, reason: 'composer_not_empty' };
    }
    if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
    // Hashing and model-picker hydration yield to page/user edits. Revalidate
    // the same single editor before overwriting any bytes observed above.
    if (composer() !== node || composerText(node) !== existing) return { dispatched: false, reason: 'composer_not_empty' };
    if (existing !== expected && existing !== expected + '\n') writeComposer(node, payload);
    // React may acknowledge the exact draft before it enables Send. Observe
    // this same target for at most two seconds, below the broker deadline;
    // this is read-only readiness, never another write or Send attempt.
    const ready = await new Promise((resolve) => {
      let timer;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        document.removeEventListener('input', check, true);
        clearTimeout(timer);
        resolve(value);
      };
      const check = (expired = false) => {
        if (!exactConversationIsCurrent()) { finish({ reason: 'target_identity_changed' }); return; }
        // ProseMirror may expose one editor-generated final newline. Do not
        // widen matching beyond that break or tolerate another visible draft.
        const text = composerText();
        if (text !== expected && text !== expected + '\n') { finish({ reason: 'composer_write_unconfirmed' }); return; }
        if (isGenerating()) { finish({ reason: 'provider_busy' }); return; }
        const buttons = Array.from(document.querySelectorAll(SEND)).filter(visible);
        const send = buttons.length === 1 ? buttons[0] : undefined;
        if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') { finish({ send }); return; }
        if (expired === true) finish({ reason: send ? 'send_button_disabled' : 'send_button_missing' });
      };
      const observer = new MutationObserver(() => check());
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      document.addEventListener('input', check, true);
      timer = setTimeout(() => check(true), 2_000);
      check();
    });
    if (!ready.send) return { dispatched: false, reason: ready.reason };
    // Await resumes in a new microtask: retain the exact pre-click fences even
    // if an input/route update was queued alongside the readiness observation.
    if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
    const text = composerText();
    if (text !== expected && text !== expected + '\n') return { dispatched: false, reason: 'composer_write_unconfirmed' };
    if (isGenerating()) return { dispatched: false, reason: 'provider_busy' };
    const send = ready.send;
    if (!send.isConnected || !visible(send)) return { dispatched: false, reason: 'send_button_missing' };
    if (send.disabled || send.getAttribute('aria-disabled') === 'true') return { dispatched: false, reason: 'send_button_disabled' };
    if (prepareOnly) return { prepared: true };
    // Confirm the committed turn inside the content script, rather than
    // requesting delayed snapshots from the extension background worker.
    const beforeSend = roleNodes(USER).at(-1);
    // Once click starts, an exception cannot prove that the provider did not
    // receive the message. Keep post-click observation failures outcome-unknown.
    try {
      send.click();
      const confirmed = await new Promise((resolve) => {
        // Unobserved submission is unknown, never proof that Send did not run.
        let timer;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(value);
        };
        const check = () => {
          if (expectedConversationId && !exactConversationIsCurrent()) return;
          const latest = roleNodes(USER).at(-1);
          if (latest && latest !== beforeSend
            && exactComposerText(messageText(latest)) === expected) finish(true);
        };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        timer = setTimeout(() => finish(false), 2_000);
        check();
      });
      return { dispatched: true, confirmed };
    } catch {
      return { dispatched: true, confirmed: false };
    }
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === 'forge-computer-chatgpt-scan') { notify(); sendResponse?.({ ok: true }); return false; }
    if (message.type === 'forge-computer-chatgpt-discovery-scan') {
      sendResponse({ projects: discoverProjectLinks(message.projectTitles), conversations: discoverConversationLinks(), pageUrl: location.href });
      return false;
    }
    if (message.type === 'forge-computer-chatgpt-snapshot') { sendResponse(pageSnapshot(message.options ?? {})); return false; }
    // Read-only exact-tab attestation for bootstrap/draft target guards.
    if (message.type === 'forge-computer-chatgpt-capabilities') {
      sendResponse({ bootstrapTargetGuard: 'project-checked-before-send-v1',
        composerReplacementContract: 'exact-backed-up-project-draft-v1' });
      return false;
    }
    if (message.type === 'forge-computer-chatgpt-prepare') {
      dispatchPrompt(String(message.prompt ?? ''), String(message.mode ?? 'send'), message.expectedConversationId, true, message.expectedProjectId)
        .then((result) => sendResponse(result?.prepared === true
          ? { prepared: true }
          : { prepared: false, reason: String(result?.reason ?? 'COMPUTER_CHATGPT_PREPARE_REJECTED') }),
          (error) => sendResponse({ prepared: false, reason: String(error?.message ?? error) }));
      return true;
    }
    if (message.type === 'forge-computer-chatgpt-dispatch') {
      dispatchPrompt(String(message.prompt ?? ''), String(message.mode ?? 'send'), message.expectedConversationId, false, message.expectedProjectId)
        .then(sendResponse, (error) => sendResponse({ dispatched: false, reason: String(error?.message ?? error) }));
      return true;
    }
    return false;
  });
  let timer;
  function notify() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const current = core.parseConversation(location.href);
      chrome.runtime.sendMessage({
        type: 'forge-computer-chatgpt-page',
        ...(current ?? {}),
        pageUrl: location.href,
        isGenerating: isGenerating(),
      }, () => void chrome.runtime.lastError);
    }, 200);
  }
  new MutationObserver(notify).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  notify();
})();
