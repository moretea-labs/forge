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
  const providerFailureText = () => {
    // The conversation-capacity banner is not always an ARIA alert.
    // Read visible, short, non-message status nodes only; ordinary conversation
    // history must never be interpreted as a current provider failure.
    const status = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]'))
      .filter(visible);
    const capacity = Array.from(conversationRoot().querySelectorAll('p, span, div'))
      .filter((node) => visible(node) && !node.closest(TURN) && !node.closest('[data-message-author-role]'))
      .filter((node) => {
        const text = core.normalizeText(node.innerText ?? node.textContent);
        return text.length <= 250 && /(?:你已达到此对话的长度上限|此对话已达到长度上限|you(?:'ve| have) reached the (?:maximum length for this conversation|conversation length limit)|this conversation has reached its maximum length)/i.test(text);
      });
    return [...status, ...capacity]
      .map((node) => core.normalizeText(node.innerText ?? node.textContent))
      .filter(Boolean).slice(-8).join('\n').slice(-PROVIDER_FAILURE_CHARS);
  };
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
  // Reasoning is a provider UI preference, not a Supervisor effect or workflow
  // decision. Observe the concrete composer control and fail before inserting
  // any prompt if the page does not acknowledge the requested level.
  const reasoningLevel = (value) => {
    const label = core.normalizeText(value).toLowerCase().replace(/[\s_-]+/g, '');
    if (/extrahigh|xhigh|超高|极高/.test(label)) return 'xhigh';
    if (/medium|中等/.test(label) || label === '中') return 'medium';
    if (/high|高/.test(label)) return 'high';
    return undefined;
  };
  const reasoningControl = () => {
    const selectors = 'button[aria-haspopup="menu"], button[aria-haspopup="listbox"], [role="button"][aria-haspopup="menu"], button[data-testid*="model"], button[data-testid*="reasoning"]';
    const candidates = Array.from(conversationRoot().querySelectorAll(selectors)).filter(visible);
    return candidates.find((node) => {
      const label = core.normalizeText((node.getAttribute?.('aria-label') ?? '') + ' ' + (node.innerText ?? node.textContent ?? ''));
      const normalized = label.toLowerCase().replace(/[\s_-]+/g, '');
      return /^gpt\d/.test(normalized) || normalized.includes('reasoning') || normalized.includes('thinking')
        || normalized.includes('推理') || normalized.includes('思考') || reasoningLevel(label) !== undefined;
    });
  };
  const reasoningControlLabel = (node) => core.normalizeText((node?.getAttribute?.('aria-label') ?? '') + ' ' + (node?.innerText ?? node?.textContent ?? ''));
  const selectedReasoningOption = (level) => Array.from(document.querySelectorAll('[role="menuitemradio"], [role="option"], [role="radio"]'))
    .filter(visible)
    .find((node) => reasoningLevel(reasoningControlLabel(node)) === level
      && (node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true'));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ensureReasoning = async (level) => {
    if (level !== 'medium' && level !== 'high' && level !== 'xhigh') {
      return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_INVALID' };
    }
    const control = reasoningControl();
    if (!control) return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_CONTROL_UNAVAILABLE' };
    if (reasoningLevel(reasoningControlLabel(control)) === level) return { verified: true, level };
    control.click();
    await sleep(80);
    const menuOptions = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="option"], [role="radio"]'))
      .filter(visible)
      .map((node) => ({ node, level: reasoningLevel(reasoningControlLabel(node)), disabled: node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true' }));
    // xhigh means highest *available*, not a claim that every plan exposes
    // Extra High. Prefer it, then High, then Medium; record the actual level.
    const menuLevel = level === 'xhigh'
      ? ['xhigh', 'high', 'medium'].find((candidate) => menuOptions.some((item) => item.level === candidate && !item.disabled))
      : level;
    const option = menuOptions.find((item) => item.level === menuLevel);
    if (option) {
      if (option.disabled) return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_OPTION_DISABLED' };
      option.node.click();
      await sleep(80);
      if (reasoningLevel(reasoningControlLabel(reasoningControl())) === menuLevel || selectedReasoningOption(menuLevel)) {
        return { verified: true, level: menuLevel };
      }
      return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_NOT_VERIFIED' };
    }
    // Older ChatGPT layouts expose a five-position slider in the model menu.
    // React must acknowledge each navigation by changing aria-valuenow; writing
    // our own attribute would be a false verification.
    const sliders = Array.from(document.querySelectorAll('[role="slider"][aria-valuenow]')).filter(visible);
    if (sliders.length !== 1) return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_OPTION_UNAVAILABLE' };
    const slider = sliders[0];
    const max = Number(slider.getAttribute('aria-valuemax'));
    const min = Number(slider.getAttribute('aria-valuemin') ?? '0');
    const target = level === 'xhigh' ? max : level === 'high' ? 3 : 2;
    const actualLevel = target === 4 ? 'xhigh' : target === 3 ? 'high' : target === 2 ? 'medium' : undefined;
    let current = Number(slider.getAttribute('aria-valuenow'));
    if (![min, max, current, target].every(Number.isInteger) || min < 0 || max > 4 || max < 2
      || current < min || current > max || target < min || target > max || !actualLevel) {
      return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_STATE_UNAVAILABLE' };
    }
    for (let step = 0; step < Math.abs(target - current); step += 1) {
      slider.focus?.();
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: target > current ? 'ArrowRight' : 'ArrowLeft', bubbles: true }));
      await sleep(40);
      const next = Number(slider.getAttribute('aria-valuenow'));
      if (next !== current + (target > current ? 1 : -1)) {
        return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_NOT_VERIFIED' };
      }
      current = next;
    }
    if (Number(slider.getAttribute('aria-valuenow')) !== target) {
      return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_NOT_VERIFIED' };
    }
    const valueText = slider.getAttribute('aria-valuetext');
    if (valueText && reasoningLevel(valueText) !== actualLevel) {
      return { verified: false, reason: 'COMPUTER_CHATGPT_REASONING_NOT_VERIFIED' };
    }
    return { verified: true, level: actualLevel };
  };
  const dispatchPrompt = async (prompt, mode = 'send', reasoning, expectedConversationId) => {
    const exactConversationIsCurrent = () => !expectedConversationId
      || core.parseConversation(location.href)?.conversationId === expectedConversationId;
    if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
    if (typeof prompt !== 'string' || !prompt.trim()) return { dispatched: false, reason: 'prompt_required' };
    if (mode === 'recover') {
      const stop = document.querySelector(STOP);
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
    const supervisor = /^@forge\s+<<<FORGE_WORKFLOW_EFFECT_V1:fx_[a-zA-Z0-9_-]+>>>/.test(prompt.trim());
    const payload = supervisor ? prompt.trim().replace(/^@forge\s+/, '') : prompt;
    const expected = core.normalizeText(payload);
    const triggerDraft = `${payload}\n@`;
    const triggerText = core.normalizeText(triggerDraft);
    const boundText = core.normalizeText(`${payload} forge`);
    const boundChip = () => {
      const chips = Array.from(node.querySelectorAll('[plugin-mention-name], [app-mention-name]'));
      return chips.length === 1
        && chips[0]?.getAttribute('app-mention-name') === 'forge'
        && chips[0]?.getAttribute('app-mention-path') === 'app://asdk_app_6ac09022b26081918f20ff868c773824'
        && composerText() === boundText;
    };
    const existing = composerText();
    if (existing && existing !== expected && !(supervisor && (existing === triggerText || boundChip()))) return { dispatched: false, reason: 'composer_not_empty' };
    let reasoningVerified;
    if (reasoning !== undefined) {
      const checked = await ensureReasoning(reasoning);
      if (!checked.verified) return { dispatched: false, reason: checked.reason };
      reasoningVerified = checked.level;
    }
    if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
    if (supervisor && !boundChip()) writeComposer(node, triggerDraft);
    else if (existing !== expected && !boundChip()) writeComposer(node, payload);
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
    if (supervisor) {
      if (!boundChip()) {
        if (composerText() !== triggerText) return { dispatched: false, reason: 'composer_write_unconfirmed' };
        // The final standalone @ paragraph was inserted together with the
        // payload; typing ` @` later drops the space in live ProseMirror.
        node.focus();
        const selection = window.getSelection();
        if (!selection) return { dispatched: false, reason: 'COMPUTER_CHATGPT_PLUGIN_SELECTION_UNAVAILABLE' };
        const range = document.createRange(); range.selectNodeContents(node); range.collapse(false);
        selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, 'forge')) return { dispatched: false, reason: 'COMPUTER_CHATGPT_PLUGIN_SELECTION_UNAVAILABLE' };
        await sleep(150);
        const entries = Array.from(document.querySelectorAll('[data-mention-section-items] > button'));
        const selected = entries.filter((entry) => {
          const label = core.normalizeText(entry.innerText ?? entry.textContent);
          return label === 'forge' || label.startsWith('forge Current Forge 1.8.1');
        });
        if (selected.length !== 1) {
          writeComposer(node, payload);
          return { dispatched: false, reason: 'COMPUTER_CHATGPT_FORGE_PLUGIN_UNAVAILABLE' };
        }
        if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
        selected[0].click();
        await sleep(150);
      }
      if (!boundChip()) return { dispatched: false, reason: 'COMPUTER_CHATGPT_FORGE_PLUGIN_CHIP_UNVERIFIED' };
    } else if (composerText() !== expected) return { dispatched: false, reason: 'composer_write_unconfirmed' };
    const send = document.querySelector(SEND);
    if (!send) return { dispatched: false, reason: 'send_button_missing' };
    if (send.disabled || send.getAttribute('aria-disabled') === 'true') return { dispatched: false, reason: 'send_button_disabled' };
    if (!exactConversationIsCurrent()) return { dispatched: false, reason: 'target_identity_changed' };
    send.click();
    return { dispatched: true, ...(reasoningVerified ? { reasoningVerified } : {}) };
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === 'forge-computer-chatgpt-scan') { notify(); sendResponse?.({ ok: true }); return false; }
    if (message.type === 'forge-computer-chatgpt-discovery-scan') {
      sendResponse({ projects: discoverProjectLinks(message.projectTitles), conversations: discoverConversationLinks(), pageUrl: location.href });
      return false;
    }
    if (message.type === 'forge-computer-chatgpt-snapshot') { sendResponse(pageSnapshot(message.options ?? {})); return false; }
    // Read-only exact-tab capability attestation. A stale content script must
    // never receive an xhigh-required send that it would silently ignore.
    if (message.type === 'forge-computer-chatgpt-capabilities') {
      sendResponse({ reasoningPreflight: 'verified_before_send_v1' });
      return false;
    }
    if (message.type === 'forge-computer-chatgpt-dispatch') {
      dispatchPrompt(String(message.prompt ?? ''), String(message.mode ?? 'send'), message.reasoning, message.expectedConversationId)
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
