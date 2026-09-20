(() => {
  const core = globalThis.ForgeWorkflowSupervisorChromeCore;
  if (!core) throw new Error('FORGE_WORKFLOW_SUPERVISOR_CHROME_CORE_MISSING');
  const ASSISTANT = '[data-message-author-role="assistant"]';
  const USER = '[data-message-author-role="user"]';
  const COMPOSER = 'div#prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"]';
  const SEND = '[data-testid="send-button"], button[aria-label*="Send"], button[data-testid*="send"]';
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
  const latestText = (selector) => {
    const nodes = document.querySelectorAll(selector);
    const node = nodes.item(nodes.length - 1);
    return node ? String(node.innerText ?? node.textContent ?? '').trim() : '';
  };
  const latestAssistant = () => { const text = latestText(ASSISTANT); return core.isCommittedAssistantResponse(text) ? text : undefined; };
  const exactLatestUser = (prompt) => core.normalizeText(latestText(USER)) === core.normalizeText(prompt);
  const reconciliationSnapshot = (effectId) => ({ latest_user_text: latestText(USER), latest_assistant_response: latestText(ASSISTANT), target_marker_present: core.promptHasEffect(latestText(USER), effectId) });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function fillAndSend(prompt) {
    const composer = document.querySelector(COMPOSER);
    if (!composer) return { outcome: 'unknown', evidence: { reason: 'composer_missing' } };
    composer.focus();
    const selection = globalThis.getSelection?.();
    if (selection) { const range = document.createRange(); range.selectNodeContents(composer); selection.removeAllRanges(); selection.addRange(range); selection.deleteFromDocument(); }
    const inserted = document.execCommand?.('insertText', false, prompt) === true;
    if (!inserted || core.normalizeText(composer.innerText ?? composer.textContent) !== core.normalizeText(prompt)) {
      composer.textContent = prompt;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    }
    let button;
    for (let attempt = 0; attempt < 20 && !button; attempt += 1) { button = document.querySelector(SEND); if (!button) await sleep(100); }
    if (!button) return { outcome: 'unknown', evidence: { reason: 'send_button_missing' } };
    button.click();
    for (let attempt = 0; attempt < 50; attempt += 1) { if (exactLatestUser(prompt)) return { outcome: 'applied', evidence: { exact_user_message: true } }; await sleep(100); }
    return { outcome: 'unknown', evidence: { reason: 'outbound_not_confirmed' } };
  }

  async function execute(message) {
    const current = identity();
    const target = core.parseConversation(message.conversationUrl);
    if (!current || !target || !core.sameIdentity(current, target) || current.conversationId !== message.conversationId) return { outcome: 'unknown', evidence: { reason: 'conversation_mismatch' } };
    if (!core.promptHasEffect(message.prompt, message.effectId)) return { outcome: 'unknown', evidence: { reason: 'effect_marker_missing' } };
    if (message.mode === 'reconcile') return exactLatestUser(message.prompt)
      ? { outcome: 'applied', evidence: { exact_user_message: true, reconciliation: true } }
      : { outcome: 'not_applied', evidence: { reconciliation: true, ...reconciliationSnapshot(message.effectId) } };
    if (message.mode !== 'send') return { outcome: 'unknown', evidence: { reason: 'mode_invalid' } };
    return await fillAndSend(message.prompt);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === 'forge-workflow-supervisor-scan') { notify(); return false; }
    if (message.type === 'forge-workflow-supervisor-discovery-scan') {
      sendResponse({ projects: discoverProjectLinks(message.projectTitles), conversations: discoverConversationLinks(), pageUrl: location.href });
      return false;
    }
    if (message.type === 'forge-workflow-supervisor-snapshot') { sendResponse(reconciliationSnapshot(String(message.effectId ?? ''))); return false; }
    if (message.type !== 'forge-workflow-supervisor-effect') return false;
    execute(message).then(sendResponse, (error) => sendResponse({ outcome: 'unknown', evidence: { reason: String(error?.message ?? error) } }));
    return true;
  });

  let timer;
  function notify() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const current = identity();
      if (!current) return;
      const assistantResponse = latestAssistant();
      chrome.runtime.sendMessage({ type: 'forge-workflow-supervisor-page', ...current, ...(assistantResponse ? { assistantResponse } : {}) }, () => void chrome.runtime.lastError);
    }, 200);
  }
  new MutationObserver(notify).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  notify();
})();
