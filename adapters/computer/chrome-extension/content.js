(() => {
  const core = globalThis.ForgeComputerChatgptCore;
  if (!core) throw new Error('FORGE_COMPUTER_CHATGPT_CORE_MISSING');
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
    return core.normalizeText(semanticContent?.innerText ?? semanticContent?.textContent ?? node.innerText ?? node.textContent);
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
  const providerFailureText = () => Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]'))
    .filter(visible)
    .map((node) => core.normalizeText(node.innerText ?? node.textContent))
    .filter(Boolean)
    .slice(-8)
    .join('\n')
    .slice(-PROVIDER_FAILURE_CHARS);
  const composer = () => document.querySelector(COMPOSER);
  const composerText = () => core.normalizeText(composer()?.value ?? composer()?.innerText ?? composer()?.textContent);
  const pageSnapshot = (options = {}) => {
    const userNodes = roleNodes(USER);
    const assistantNodes = roleNodes(ASSISTANT);
    const bodyText = String(document.body?.innerText ?? '');
    return {
      url: location.href,
      title: document.title,
      latestUserText: messageText(userNodes[userNodes.length - 1]),
      latestAssistantResponse: messageText(assistantNodes[assistantNodes.length - 1]),
      ...(options.includeUserHistory === true ? {
        userMessages: userNodes.map(messageText).filter(Boolean),
        assistantMessages: assistantNodes.map(messageText).filter(Boolean),
      } : {}),
      ...(composer() ? { composerText: composerText() } : {}),
      providerActivityText: providerActivityText(),
      providerFailureText: providerFailureText(),
      ...(options.includePageText === true ? { pageText: bodyText.slice(-500000) } : {}),
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
  const dispatchPrompt = async (prompt, mode = 'send') => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { dispatched: false, reason: 'prompt_required' };
    if (mode === 'recover') {
      const stop = document.querySelector(STOP);
      if (stop instanceof HTMLElement) {
        stop.click();
        for (let attempt = 0; attempt < 20 && document.querySelector(STOP); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (document.querySelector(STOP)) return { dispatched: false, reason: 'provider_recovery_stop_unconfirmed' };
      }
    } else if (isGenerating()) return { dispatched: false, reason: 'provider_busy' };
    const node = composer();
    if (!node) return { dispatched: false, reason: 'composer_missing' };
    const expected = core.normalizeText(prompt);
    const existing = composerText();
    if (existing && existing !== expected) return { dispatched: false, reason: 'composer_not_empty' };
    if (existing !== expected) writeComposer(node, prompt);
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (composerText() !== expected) return { dispatched: false, reason: 'composer_write_unconfirmed' };
    const send = document.querySelector(SEND);
    if (!send) return { dispatched: false, reason: 'send_button_missing' };
    if (send.disabled || send.getAttribute('aria-disabled') === 'true') return { dispatched: false, reason: 'send_button_disabled' };
    send.click();
    return { dispatched: true };
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === 'forge-computer-chatgpt-scan') { notify(); sendResponse?.({ ok: true }); return false; }
    if (message.type === 'forge-computer-chatgpt-discovery-scan') {
      sendResponse({ projects: discoverProjectLinks(message.projectTitles), conversations: discoverConversationLinks(), pageUrl: location.href });
      return false;
    }
    if (message.type === 'forge-computer-chatgpt-snapshot') { sendResponse(pageSnapshot(message.options ?? {})); return false; }
    if (message.type === 'forge-computer-chatgpt-dispatch') {
      dispatchPrompt(String(message.prompt ?? ''), String(message.mode ?? 'send')).then(sendResponse, (error) => sendResponse({ dispatched: false, reason: String(error?.message ?? error) }));
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
