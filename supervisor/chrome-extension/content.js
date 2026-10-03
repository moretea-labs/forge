(() => {
  const core = globalThis.ForgeWorkflowSupervisorChromeCore;
  if (!core) throw new Error('FORGE_WORKFLOW_SUPERVISOR_CHROME_CORE_MISSING');
  const ASSISTANT = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
  const USER = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]';
  const COMPOSER = '#prompt-textarea, [data-testid="prompt-textarea"], textarea[placeholder*="Message"], textarea[placeholder*="消息"], form [contenteditable="true"]';
  const SEND = 'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"]';
  const identity = () => core.parseConversation(location.href);
  const absoluteChatgptUrl = (href) => {
    try { const url = new URL(String(href ?? ''), location.href); return url.protocol === 'https:' && url.hostname === 'chatgpt.com' ? url.toString() : undefined; }
    catch { return undefined; }
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
    for (const node of document.querySelectorAll(selector)) {
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
  const latestUser = () => { const nodes = roleNodes(USER); return messageText(nodes[nodes.length - 1]); };
  const latestAssistantText = () => { const nodes = roleNodes(ASSISTANT); return messageText(nodes[nodes.length - 1]); };
  const latestCommittedAssistant = () => { const text = latestAssistantText(); return core.isCommittedAssistantResponse(text) ? text : undefined; };
  const latestTurnRole = () => {
    const nodes = document.querySelectorAll(`${USER}, ${ASSISTANT}`);
    const node = nodes.item(nodes.length - 1);
    const explicit = node?.getAttribute?.('data-message-author-role');
    if (explicit) return explicit;
    const semanticKey = String(node?.getAttribute?.('data-chatgpt-search-unit-key') || node?.getAttribute?.('data-content-search-unit-key') || '');
    if (semanticKey.endsWith(':user')) return 'user';
    if (semanticKey.endsWith(':assistant')) return 'assistant';
    return undefined;
  };
  const providerTurnPending = () => Boolean(
    document.querySelector('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="streaming"]')
    || latestTurnRole() === 'user'
  );
  const composer = () => document.querySelector(COMPOSER);
  const composerText = () => core.normalizeText(composer()?.value ?? composer()?.innerText ?? composer()?.textContent);
  const pageSnapshot = () => ({
    pageUrl: location.href,
    title: document.title,
    latestUserText: latestUser(),
    latestAssistantResponse: latestAssistantText(),
    latestTurnRole: latestTurnRole(),
    providerTurnPending: providerTurnPending(),
    composerText: composerText(),
    providerFailureText: String(document.body?.innerText ?? '').slice(-250000),
  });
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
  const dispatchPrompt = async (prompt) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { dispatched: false, reason: 'prompt_required' };
    if (providerTurnPending()) return { dispatched: false, reason: 'provider_busy' };
    const node = composer();
    if (!node) return { dispatched: false, reason: 'composer_missing' };
    const existing = composerText();
    if (existing && existing !== core.normalizeText(prompt)) return { dispatched: false, reason: 'composer_not_empty' };
    if (existing !== core.normalizeText(prompt)) writeComposer(node, prompt);
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (composerText() !== core.normalizeText(prompt)) return { dispatched: false, reason: 'composer_write_unconfirmed' };
    const send = document.querySelector(SEND);
    if (!send) return { dispatched: false, reason: 'send_button_missing' };
    if (send.disabled || send.getAttribute('aria-disabled') === 'true') return { dispatched: false, reason: 'send_button_disabled' };
    send.click();
    return { dispatched: true };
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === 'forge-workflow-supervisor-scan') { notify(); sendResponse?.({ ok: true }); return false; }
    if (message.type === 'forge-workflow-supervisor-discovery-scan') {
      sendResponse({ projects: discoverProjectLinks(message.projectTitles), conversations: discoverConversationLinks(), pageUrl: location.href });
      return false;
    }
    if (message.type === 'forge-workflow-supervisor-snapshot') { sendResponse(pageSnapshot()); return false; }
    if (message.type === 'forge-workflow-supervisor-dispatch') {
      dispatchPrompt(String(message.prompt ?? '')).then(sendResponse, (error) => sendResponse({ dispatched: false, reason: String(error?.message ?? error) }));
      return true;
    }
    return false;
  });

  let timer;
  function notify() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const current = identity();
      if (!current) return;
      const assistantResponse = latestCommittedAssistant();
      chrome.runtime.sendMessage({
        type: 'forge-workflow-supervisor-page',
        ...current,
        providerTurnPending: providerTurnPending(),
        ...(assistantResponse ? { assistantResponse } : {}),
      }, () => void chrome.runtime.lastError);
    }, 200);
  }
  new MutationObserver(notify).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  notify();
})();
