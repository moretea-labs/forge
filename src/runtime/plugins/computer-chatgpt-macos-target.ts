import type {
  ComputerChatgptBootstrapIdentity,
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationObservation,
  ComputerChatgptConversationObservationOptions,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptTargetIdentity,
  ComputerChatgptTargetResult,
  ComputerInteractionTargetAuthorityPort,
  ComputerSurfaceProviderBinding,
  ComputerSurfaceStableIdentity,
  ComputerSurfaceTarget,
} from '../../../packages/plugin-runtime/computer';
import { parseCanonicalChatgptConversationIdentity } from '../../../packages/plugin-runtime/computer';
import { AssistantPluginError } from './errors';
import {
  closeMacOsBrowserOwnedTab,
  createMacOsBrowserOwnedPageForProduct,
  discoverMacOsBrowserAttachment,
  listMacOsBrowserTabs,
  reattachMacOsBrowserOwnedPage,
  type MacOsAppleEventsPage,
  type MacOsBrowserProduct,
  type MacOsBrowserTabInventoryEntry,
  type MacOsBrowserTabRef,
} from './browser-macos-bridge';

const PROVIDER_ID = 'browser.macos-apple-events';
const PROVIDER_PRODUCTS: readonly MacOsBrowserProduct[] = ['chrome', 'vivaldi'];
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LOCAL_OBSERVATION_ATTEMPTS = 3;
const MAX_PROVIDER_FAILURE_SCAN_CHARS = 250_000;
const MAX_PROVIDER_ACTIVITY_CHARS = 64 * 1024;
const OWNER_PREFIX = 'forge-computer-chatgpt:';
const LEGACY_SUPERVISOR_OWNER_PREFIX = 'forge-workflow-supervisor:';
const LEGACY_BROWSER_OWNER_PREFIX = 'forge-browser-owned:';

type TaggedTab = MacOsBrowserTabInventoryEntry & { browserProduct: MacOsBrowserProduct };
type TaggedRef = MacOsBrowserTabRef & { browserProduct: MacOsBrowserProduct };

interface ComputerChatgptNativePage {
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  tabRef(): TaggedRef | undefined;
}

function taggedPage(page: MacOsAppleEventsPage, product: MacOsBrowserProduct): ComputerChatgptNativePage {
  return {
    evaluate: page.evaluate.bind(page),
    tabRef: () => {
      const ref = page.tabRef();
      return ref ? { ...ref, browserProduct: product } : undefined;
    },
  };
}

function normalize(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function delayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(8, Math.trunc(attempt) - 1)));
}
async function sleep(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

function identityResource(identity: ComputerChatgptTargetIdentity): ComputerSurfaceStableIdentity {
  return {
    surfaceType: 'browser-tab',
    ownership: 'provider_owned',
    resource: identity.namespace === 'chatgpt.conversation'
      ? { namespace: identity.namespace, key: identity.conversationId }
      : { namespace: identity.namespace, key: identity.bootstrapKey },
  };
}

function targetAlias(identity: ComputerChatgptTargetIdentity): string {
  return identity.namespace === 'chatgpt.conversation'
    ? `chatgpt:conversation:${identity.conversationId}`
    : `chatgpt:bootstrap:${identity.bootstrapKey}`;
}

function ownerToken(targetId: string): string { return `${OWNER_PREFIX}${targetId}`; }
function providerBinding(page: ComputerChatgptNativePage, targetId: string, ownership: 'provider_owned' | 'user_owned'): ComputerSurfaceProviderBinding {
  const ref = page.tabRef();
  if (!ref) throw new Error('COMPUTER_CHATGPT_TARGET_PROVIDER_BINDING_UNPROVEN');
  return {
    providerId: PROVIDER_ID,
    observedAt: new Date().toISOString(),
    browserProduct: ref.browserProduct,
    windowId: ref.windowId,
    tabId: ref.tabId,
    ...(ownership === 'provider_owned' ? { ownerToken: ownerToken(targetId) } : {}),
  };
}

function productForBinding(binding: ComputerSurfaceProviderBinding): MacOsBrowserProduct | undefined {
  return binding.browserProduct === 'chrome' || binding.browserProduct === 'vivaldi' ? binding.browserProduct : undefined;
}

function parseConversation(value: string): ComputerChatgptConversationIdentity | undefined {
  try {
    const parsed = parseCanonicalChatgptConversationIdentity(value);
    return { namespace: 'chatgpt.conversation', conversationId: parsed.conversationId, canonicalUrl: parsed.conversationUrl };
  } catch { return undefined; }
}

function sameConversation(value: string, identity: ComputerChatgptConversationIdentity): boolean {
  return parseConversation(value)?.conversationId === identity.conversationId;
}

function macOsChatgptSessionUsable(observation: ComputerChatgptConversationObservation): boolean {
  // A signed-in conversation renders a composer; a login wall renders neither a
  // composer, nor generating state, nor any conversation text.
  return observation.composerText !== undefined
    || observation.isGenerating
    || Boolean(observation.latestUserText.trim() || observation.latestAssistantResponse.trim() || observation.providerActivityText.trim());
}
function isChatgptUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'chatgpt.com';
  } catch { return false; }
}
function projectMetadata(value: string): { projectTitle?: string; projectUrl?: string } {
  try {
    const parsed = new URL(value);
    const match = /^\/g\/(g-p-[a-z0-9]+)(?:-([^/]+))?\/c\/[a-z0-9-]+\/?$/i.exec(parsed.pathname);
    const slug = match?.[2]?.trim();
    if (!match?.[1]) return {};
    return {
      ...(slug ? { projectTitle: slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() } : {}),
      projectUrl: `https://chatgpt.com/g/${match[1]}/project`,
    };
  } catch { return {}; }
}

function failure(error: unknown, fallback: string): ComputerChatgptTargetResult {
  const code = error instanceof AssistantPluginError ? error.code : (() => {
    const message = error instanceof Error ? error.message : String(error);
    const candidate = message.split(':', 1)[0]?.trim() ?? '';
    return /^[A-Z][A-Z0-9_]+$/.test(candidate) ? candidate : fallback;
  })();
  return {
    state: 'unavailable',
    failure: {
      code,
      retryable: !(error instanceof AssistantPluginError) || error.retryable !== false,
      phase: 'pre_mutation',
      ...(code === 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' ? { humanAction: 'grant_permission' as const } : {}),
    },
  };
}

export async function observeMacOsChatgptPage(
  page: ComputerChatgptNativePage,
  options: ComputerChatgptConversationObservationOptions = {},
): Promise<ComputerChatgptConversationObservation> {
  const includeUserHistory = options.includeUserHistory ?? true;
  const includePageText = options.includePageText ?? true;
  return await page.evaluate<ComputerChatgptConversationObservation>(`(() => {
    const text = (node) => String(node?.innerText ?? node?.textContent ?? '').trim();
    const root = Array.from(document.querySelectorAll('main')).filter(node => node.getClientRects().length).pop() || document;
    const nodes = (selector) => root.querySelectorAll(selector);
    const semanticRole = (node) => {
      const explicit = node?.getAttribute?.('data-message-author-role');
      if (explicit === 'user' || explicit === 'assistant') return explicit;
      const key = String(node?.getAttribute?.('data-chatgpt-search-unit-key') || node?.getAttribute?.('data-content-search-unit-key') || '');
      if (key.endsWith(':user')) return 'user';
      if (key.endsWith(':assistant')) return 'assistant';
      return undefined;
    };
    const messageText = (node) => {
      if (!node) return '';
      const semanticContent = node.querySelector?.('[data-chatgpt-selection-message-id]');
      return text(semanticContent) || text(node);
    };
    const roleEntries = (role) => {
      const selector = role === 'user'
        ? '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]'
        : '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
      const seen = new Map(); const entries = [];
      for (const node of Array.from(nodes(selector))) {
        const semanticKey = String(node?.getAttribute?.('data-chatgpt-search-unit-key') || node?.getAttribute?.('data-content-search-unit-key') || '');
        const messageIds = String(node?.getAttribute?.('data-chatgpt-search-message-ids') || node?.getAttribute?.('data-chatgpt-selection-message-id') || '');
        if (semanticKey || messageIds) {
          const key = semanticKey || messageIds;
          if (seen.has(key)) { entries[seen.get(key)] = node; continue; }
          seen.set(key, entries.length);
        }
        entries.push(node);
      }
      return entries;
    };
    const userEntries = roleEntries('user'); const assistantEntries = roleEntries('assistant');
    const userTexts = ${JSON.stringify(includeUserHistory)} ? userEntries.map(messageText).filter(Boolean) : undefined;
    const assistantTexts = ${JSON.stringify(includeUserHistory)} ? assistantEntries.map(messageText).filter(Boolean) : undefined;
    const latest = (entries) => messageText(entries.length ? entries[entries.length - 1] : undefined);
    const composer = ['[data-testid="composer-text-input"]','div#prompt-textarea[contenteditable="true"]','#prompt-textarea[contenteditable="true"]','textarea[name="prompt"]','div[role="textbox"][contenteditable="true"]']
      .flatMap((selector) => Array.from(nodes(selector))).find((element) => Boolean(element && element.getClientRects && element.getClientRects().length));
    const roleNodes = Array.from(nodes('[data-message-author-role="user"], [data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"]'));
    const latestRoleNode = roleNodes.length ? roleNodes[roleNodes.length - 1] : undefined;
    const turns = nodes('[data-testid^="conversation-turn-"]');
    const providerActivityText = turns.length ? text(turns[turns.length - 1]).slice(-${MAX_PROVIDER_ACTIVITY_CHARS}) : messageText(latestRoleNode).slice(-${MAX_PROVIDER_ACTIVITY_CHARS});
    const liveProviderStatus = Array.from(nodes('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]')).map(text).filter(Boolean).slice(-8).join('\\n');
    const result = {
      url: String(location.href || ''), title: String(document.title || ''),
      latestUserText: userTexts ? userTexts.join('\\n') : latest(userEntries),
      latestAssistantResponse: latest(assistantEntries),
      ...(userTexts ? { userMessages: userTexts } : {}), ...(assistantTexts ? { assistantMessages: assistantTexts } : {}),
      ...(composer ? { composerText: String(('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '') || '') } : {}),
      providerActivityText, providerFailureText: liveProviderStatus.slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS}),
      latestTurnRole: semanticRole(latestRoleNode),
      isGenerating: Array.from(nodes('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"], [data-is-streaming="true"]')).some(node => Boolean(node.getClientRects().length)),
    };
    if (${JSON.stringify(includePageText)}) result.pageText = String(document.body?.innerText ?? document.body?.textContent ?? '').trim().slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS});
    return result;
  })()`);
}

export async function dispatchMacOsChatgptPrompt(
  page: ComputerChatgptNativePage,
  prompt: string,
  options: { mode?: 'send' | 'resume' | 'recover' } = {},
): Promise<{ mutation: 'not_attempted'; reasonCode: string } | { mutation: 'attempted'; confirmed?: boolean }> {
  const resume = options.mode === 'resume';
  if (options.mode === 'recover') {
    try {
      const interrupted = await page.evaluate<boolean>(`(() => {
        const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
        const stop = Array.from(document.querySelectorAll('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"]')).find(visible);
        if (!(stop instanceof HTMLElement)) return false;
        stop.click(); return true;
      })()`);
      if (interrupted) {
        for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
          await sleep(delayMs(attempt, 250, 1_000));
          const generating = await page.evaluate<boolean>(`(() => Array.from(document.querySelectorAll('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"]')).some(element => Boolean(element && element.getClientRects && element.getClientRects().length)))()`);
          if (!generating) break;
          if (attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) return { mutation: 'not_attempted', reasonCode: 'provider_recovery_stop_unconfirmed' };
        }
      }
    } catch (error) {
      const code = error instanceof AssistantPluginError ? error.code : String(error);
      if (code === 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' || String(code).includes('PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED')) {
        return { mutation: 'not_attempted', reasonCode: 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' };
      }
      return { mutation: 'not_attempted', reasonCode: 'provider_recovery_stop_unavailable' };
    }
  }
  let prepared: { prepared: boolean; reason?: string } | undefined;
  for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    try {
      prepared = await page.evaluate<{ prepared: boolean; reason?: string }>(`(() => {
        const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
        const root = Array.from(document.querySelectorAll('main')).filter(visible).pop() || document;
        const value = (element) => String((element?.innerText ?? element?.textContent ?? '') || '');
        const norm = (input) => String(input || '').replace(/\\s+/g, ' ').trim();
        const expected = ${JSON.stringify(prompt)}; const expectedNorm = norm(expected); const resume = ${JSON.stringify(resume)};
        const composer = ['div#prompt-textarea[contenteditable="true"]','#prompt-textarea[contenteditable="true"]','[data-testid="composer-text-input"][contenteditable="true"]','div[role="textbox"][contenteditable="true"]']
          .flatMap((selector) => Array.from(root.querySelectorAll(selector))).find(visible);
        if (!(composer instanceof HTMLElement) || !composer.isContentEditable) return { prepared: false, reason: 'composer_missing' };
        const current = norm(value(composer));
        // A *previous attempt of this exact effect* may have inserted this same
        // prompt and then failed before clicking Send. That draft is this turn's
        // own text, not a foreign user draft: reusing it is the same logical
        // send. Treating it as occupied burned a generation without ever
        // reaching the provider.
        if (current && current === expectedNorm) return { prepared: true };
        if (resume) { if (!current) return { prepared: false, reason: 'composer_resume_empty' }; if (current !== expectedNorm) return { prepared: false, reason: 'composer_resume_mismatch' }; }
        else {
          if (current) return { prepared: false, reason: 'composer_not_empty' };
          composer.focus({ preventScroll: true });
          const selection = window.getSelection(); if (!selection) return { prepared: false, reason: 'composer_selection_unavailable' };
          const range = document.createRange(); range.selectNodeContents(composer); range.deleteContents(); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
          if (!document.execCommand('insertText', false, expected)) return { prepared: false, reason: 'composer_text_insertion_rejected' };
        }
        return norm(value(composer)) === expectedNorm ? { prepared: true } : { prepared: false, reason: 'composer_text_unconfirmed' };
      })()`);
    } catch (error) {
      const code = error instanceof AssistantPluginError ? error.code : String(error);
      if (code === 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' || String(code).includes('PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED')) {
        return { mutation: 'not_attempted', reasonCode: 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' };
      }
      if (attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) throw error;
      await sleep(delayMs(attempt, 2_000, 4_000)); continue;
    }
    if (prepared.prepared) break;
    if (prepared.reason !== 'composer_missing' || attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) return { mutation: 'not_attempted', reasonCode: prepared.reason ?? 'composer_prepare_failed' };
    await sleep(delayMs(attempt, 2_000, 4_000));
  }
  if (!prepared?.prepared) return { mutation: 'not_attempted', reasonCode: prepared?.reason ?? 'composer_prepare_failed' };
  for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    let result: { dispatched: boolean; reason?: string };
    try {
      result = await page.evaluate<{ dispatched: boolean; reason?: string }>(`(() => {
      const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
      const root = Array.from(document.querySelectorAll('main')).filter(visible).pop() || document;
      const value = (element) => String((element?.innerText ?? element?.textContent ?? '') || '');
      const norm = (input) => String(input || '').replace(/\\s+/g, ' ').trim(); const expected = ${JSON.stringify(prompt)};
      const composer = Array.from(root.querySelectorAll('div#prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"], [data-testid="composer-text-input"][contenteditable="true"], div[role="textbox"][contenteditable="true"]')).find(visible);
      if (!(composer instanceof HTMLElement) || norm(value(composer)) !== norm(expected)) return { dispatched: false, reason: 'composer_submit_mismatch' };
      const sendButton = Array.from(root.querySelectorAll('[data-testid="send-button"], button[aria-label="Send"], button[aria-label="发送"], button[data-testid*="send"], button[type="submit"]')).find(visible);
      if (!(sendButton instanceof HTMLElement) || sendButton.hasAttribute('disabled') || sendButton.getAttribute('aria-disabled') === 'true') return { dispatched: false, reason: 'send_button_missing' };
      sendButton.click(); return { dispatched: true };
    })()`);
    } catch {
      // The submit-stage Apple Events operation may have executed the click
      // before its response transport failed. Conservatively treat it as a
      // possible provider mutation so callers reconcile instead of resending.
      return { mutation: 'attempted' };
    }
    if (result.dispatched) return { mutation: 'attempted' };
    if (result.reason !== 'send_button_missing' || attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) return { mutation: 'not_attempted', reasonCode: result.reason ?? 'send_failed' };
    await sleep(delayMs(attempt, 250, 1_000));
  }
  return { mutation: 'not_attempted', reasonCode: 'send_button_missing' };
}

export class MacOsChatgptConversationTargetPort implements ComputerChatgptConversationTargetPort {
  private readonly pages = new Map<string, ComputerChatgptNativePage>();
  constructor(
    private readonly controllerHome: string,
    private readonly authority: ComputerInteractionTargetAuthorityPort,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private async listTabs(): Promise<{ entries: TaggedTab[]; unavailableProviders: string[] }> {
    const inspected = await Promise.all(PROVIDER_PRODUCTS.map(async (product) => {
      try {
        const inventory = await listMacOsBrowserTabs(product, this.timeoutMs);
        return { entries: inventory.tabs.map((tab): TaggedTab => ({ ...tab, browserProduct: product })) };
      } catch (error) {
        if (error instanceof AssistantPluginError && error.code === 'PLUGIN_BROWSER_NATIVE_APP_NOT_RUNNING') return { entries: [] as TaggedTab[] };
        return { entries: [] as TaggedTab[], unavailableProvider: `${PROVIDER_ID}:${product}` };
      }
    }));
    return {
      entries: inspected.flatMap((item) => item.entries),
      unavailableProviders: inspected.flatMap((item) => item.unavailableProvider ? [item.unavailableProvider] : []),
    };
  }

  private async reattach(ref: TaggedRef): Promise<ComputerChatgptNativePage> {
    return taggedPage((await reattachMacOsBrowserOwnedPage(ref.browserProduct, ref, this.timeoutMs)).page, ref.browserProduct);
  }

  /**
   * Opening a *new* ChatGPT tab must land in the browser that already hosts the
   * user's signed-in ChatGPT session. Selecting by "frontmost" does not express
   * identity: it can open the conversation in a browser profile that is not
   * signed in, which both fails and leaves a foreign logged-out window behind.
   * When no browser hosts any ChatGPT conversation we fail closed with a
   * specific code instead of guessing; the caller surfaces one durable blocker.
   */
  private async create(url: string, preferredProduct?: MacOsBrowserProduct): Promise<ComputerChatgptNativePage> {
    const inventory = await this.listTabs();
    const conversationTabCounts = new Map<MacOsBrowserProduct, number>();
    for (const entry of inventory.entries) {
      if (!isChatgptUrl(entry.url)) continue;
      conversationTabCounts.set(entry.browserProduct, (conversationTabCounts.get(entry.browserProduct) ?? 0) + 1);
    }
    const signedIn = [...conversationTabCounts.keys()];
    // With no ChatGPT tab anywhere, stay on the browser this target was already
    // bound to (it was the user's ChatGPT browser before); the post-create
    // session check still closes it and blocks if that profile is signed out.
    const candidates = signedIn.length > 0
      ? (preferredProduct && signedIn.includes(preferredProduct) ? [preferredProduct] : signedIn)
      : (preferredProduct ? [preferredProduct] : []);
    if (candidates.length === 0) throw new Error('COMPUTER_CHATGPT_BROWSER_IDENTITY_UNAVAILABLE');
    const ordered = preferredProduct && candidates.includes(preferredProduct)
      ? [preferredProduct, ...candidates.filter((product) => product !== preferredProduct)]
      : candidates;
    const { attachment } = await discoverMacOsBrowserAttachment(ordered, this.timeoutMs);
    if (!attachment) throw new Error('COMPUTER_CHATGPT_BROWSER_UNAVAILABLE');
    // The chosen browser must either host a ChatGPT session or be the product
    // this target was already bound to.
    if (signedIn.length > 0 && !signedIn.includes(attachment.metadata.product)) throw new Error('COMPUTER_CHATGPT_BROWSER_IDENTITY_UNAVAILABLE');
    if (signedIn.length === 0 && preferredProduct && attachment.metadata.product !== preferredProduct) throw new Error('COMPUTER_CHATGPT_BROWSER_IDENTITY_UNAVAILABLE');
    return taggedPage((await createMacOsBrowserOwnedPageForProduct(attachment.metadata.product, url, attachment.attempts, this.timeoutMs)).page, attachment.metadata.product);
  }

  private upsert(identity: ComputerChatgptTargetIdentity, ownership: 'provider_owned' | 'user_owned', binding?: ComputerSurfaceProviderBinding): ComputerSurfaceTarget {
    return this.authority.upsertSurface(this.controllerHome, {
      stableIdentity: { ...identityResource(identity), ownership },
      compatibilityAliases: [targetAlias(identity)],
      visibility: 'controller',
      providerBinding: binding,
      compatibilityRecords: [{
        namespace: 'chatgpt.target', schemaVersion: 1,
        value: identity.namespace === 'chatgpt.conversation'
          ? { namespace: identity.namespace, conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl }
          : { namespace: identity.namespace, bootstrapKey: identity.bootstrapKey, projectUrl: identity.projectUrl },
        updatedAt: new Date().toISOString(),
      }],
      reactivate: true,
    }).target;
  }

  private target(identity: ComputerChatgptTargetIdentity, record: ComputerSurfaceTarget, page: ComputerChatgptNativePage): ComputerChatgptConversationTarget {
    return {
      targetId: record.targetId,
      identity,
      observe: async (options) => await observeMacOsChatgptPage(page, options),
      dispatch: async (prompt, options) => await dispatchMacOsChatgptPrompt(page, prompt, options),
    };
  }

  private async bind(identity: ComputerChatgptTargetIdentity, record: ComputerSurfaceTarget, page: ComputerChatgptNativePage, ownership: 'provider_owned' | 'user_owned'): Promise<ComputerSurfaceTarget> {
    if (ownership === 'provider_owned') {
      await page.evaluate(`(() => { window.name = ${JSON.stringify(ownerToken(record.targetId))}; return window.name; })()`);
    }
    const updated = this.upsert(identity, ownership, providerBinding(page, record.targetId, ownership));
    this.pages.set(updated.targetId, page);
    return updated;
  }

  private async clearBinding(record: ComputerSurfaceTarget): Promise<void> {
    this.pages.delete(record.targetId);
    await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => { lease.clearBinding(); });
  }

  async inventory(): Promise<ComputerChatgptConversationInventory> {
    const inventory = await this.listTabs();
    const conversations = [];
    for (const entry of inventory.entries) {
      const identity = parseConversation(entry.url); if (!identity) continue;
      const metadata = projectMetadata(entry.url);
      conversations.push({
        conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl,
        ...(entry.title.trim() ? { title: entry.title.trim().slice(0, 512) } : {}), ...metadata,
        ...(entry.active && entry.frontmost === true ? { isCurrent: true } : {}),
      });
    }
    return { conversations, complete: inventory.unavailableProviders.length === 0, unavailableProviders: inventory.unavailableProviders };
  }

  async ensureExact(identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    let record = this.upsert(identity, 'provider_owned');
    const cached = this.pages.get(record.targetId);
    if (cached) {
      try {
        const observation = await observeMacOsChatgptPage(cached, { includeUserHistory: false, includePageText: false });
        if (sameConversation(observation.url, identity)) return { state: 'ready', target: this.target(identity, record, cached), observation };
      } catch { /* rebuild from provider binding/inventory */ }
      this.pages.delete(record.targetId);
    }
    const binding = record.providerBinding;
    const product = binding ? productForBinding(binding) : undefined;
    if (binding?.providerId === PROVIDER_ID && product && binding.windowId && binding.tabId) {
      try {
        const page = await this.reattach({ browserProduct: product, windowId: binding.windowId, tabId: binding.tabId });
        const observation = await observeMacOsChatgptPage(page, { includeUserHistory: false, includePageText: false });
        if (sameConversation(observation.url, identity)) {
          this.pages.set(record.targetId, page);
          return { state: 'ready', target: this.target(identity, record, page), observation };
        }
      } catch { /* provider binding is disposable */ }
      await this.clearBinding(record).catch(() => undefined);
      record = this.upsert(identity, record.stableIdentity.ownership === 'user_owned' ? 'user_owned' : 'provider_owned');
    }
    const inventory = await this.listTabs();
    const exact = inventory.entries.filter((entry) => sameConversation(entry.url, identity));
    const inspected: Array<{ page: ComputerChatgptNativePage; entry: TaggedTab; owner: string }> = [];
    for (const entry of exact) {
      try {
        const page = await this.reattach({ browserProduct: entry.browserProduct, windowId: entry.windowId, tabId: entry.tabId });
        const observation = await observeMacOsChatgptPage(page, { includeUserHistory: false, includePageText: false });
        if (!sameConversation(observation.url, identity)) continue;
        const owner = await page.evaluate<string>('String(window.name || "")').catch(() => '');
        inspected.push({ page, entry, owner });
      } catch { /* unreadable exact target keeps absence unproven */ }
    }
    const owned = inspected.filter((candidate) => candidate.owner === ownerToken(record.targetId)
      || candidate.owner.startsWith(LEGACY_SUPERVISOR_OWNER_PREFIX)
      || candidate.owner.startsWith(LEGACY_BROWSER_OWNER_PREFIX));
    const candidates = owned.length === 1 ? owned : inspected.length === 1 ? inspected : [];
    if (candidates.length === 1) {
      const selected = candidates[0]!;
      const ownership = selected.owner ? 'provider_owned' : 'user_owned';
      const updated = await this.bind(identity, record, selected.page, ownership);
      const observation = await observeMacOsChatgptPage(selected.page, { includeUserHistory: false, includePageText: false });
      return { state: 'ready', target: this.target(identity, updated, selected.page), observation };
    }
    if (exact.length > 0) return failure(new Error('COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN'), 'COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN');
    if (inventory.unavailableProviders.length > 0) return failure(new Error('COMPUTER_CHATGPT_TARGET_INVENTORY_INCOMPLETE'), 'COMPUTER_CHATGPT_TARGET_INVENTORY_INCOMPLETE');
    let created: ComputerChatgptNativePage | undefined;
    try {
      created = await this.create(identity.canonicalUrl, record.providerBinding?.browserProduct as MacOsBrowserProduct | undefined);
      const updated = await this.bind(identity, record, created, 'provider_owned');
      const observation = await observeMacOsChatgptPage(created, { includeUserHistory: false, includePageText: false });
      if (!sameConversation(observation.url, identity)) throw new Error('COMPUTER_CHATGPT_RESTORED_TARGET_UNPROVEN');
      // A created tab that renders a signed-out shell is not a usable surface.
      // Close it instead of leaving a foreign logged-out window open, and let the
      // caller report one durable identity blocker.
      if (!macOsChatgptSessionUsable(observation)) throw new Error('COMPUTER_CHATGPT_BROWSER_IDENTITY_UNAVAILABLE');
      return { state: 'ready', target: this.target(identity, updated, created), observation };
    } catch (error) {
      if (created?.tabRef()) {
        const ref = created.tabRef()!;
        await closeMacOsBrowserOwnedTab(ref.browserProduct, ref, this.timeoutMs).catch(() => undefined);
      }
      await this.clearBinding(record).catch(() => undefined);
      return failure(error, 'COMPUTER_CHATGPT_TARGET_RESTORE_FAILED');
    }
  }

  async openBootstrap(projectUrl: string, bootstrapKey: string): Promise<ComputerChatgptTargetResult> {
    const identity: ComputerChatgptBootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl };
    let record = this.upsert(identity, 'provider_owned');
    const cached = this.pages.get(record.targetId);
    if (cached) return { state: 'ready', target: this.target(identity, record, cached) };
    try {
      const page = await this.create(projectUrl);
      record = await this.bind(identity, record, page, 'provider_owned');
      return { state: 'ready', target: this.target(identity, record, page) };
    } catch (error) { return failure(error, 'COMPUTER_CHATGPT_BOOTSTRAP_TARGET_UNAVAILABLE'); }
  }

  async findBySubmittedMarker(
    marker: string,
    bootstrapKey?: string,
    betweenObservations?: () => Promise<void>,
  ): Promise<ComputerChatgptTargetResult[]> {
    const inventory = await this.listTabs();
    const matches: ComputerChatgptTargetResult[] = [];
    for (const entry of inventory.entries) {
      try {
        const parsed = new URL(entry.url); if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') continue;
        const page = await this.reattach({ browserProduct: entry.browserProduct, windowId: entry.windowId, tabId: entry.tabId });
        await betweenObservations?.();
        const observation = await observeMacOsChatgptPage(page, { includeUserHistory: true, includePageText: false });
        await betweenObservations?.();
        if (!observation.latestUserText.includes(marker) && observation.userMessages?.some((message) => message.includes(marker)) !== true) continue;
        const conversation = parseConversation(observation.url);
        const identity: ComputerChatgptTargetIdentity = conversation ?? (bootstrapKey ? { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl: observation.url } : undefined as never);
        if (!identity) continue;
        let record = this.upsert(identity, 'user_owned');
        record = await this.bind(identity, record, page, 'user_owned');
        matches.push({ state: 'ready', target: this.target(identity, record, page), observation });
      } catch { /* one unreadable tab is not causal proof */ }
    }
    return matches;
  }

  async promoteBootstrap(targetId: string, identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const page = this.pages.get(targetId);
    if (!page) return failure(new Error('COMPUTER_CHATGPT_BOOTSTRAP_PROVIDER_BINDING_MISSING'), 'COMPUTER_CHATGPT_BOOTSTRAP_PROVIDER_BINDING_MISSING');
    const previous = this.authority.getSurface(this.controllerHome, targetId);
    if (!previous) return failure(new Error('COMPUTER_CHATGPT_BOOTSTRAP_TARGET_MISSING'), 'COMPUTER_CHATGPT_BOOTSTRAP_TARGET_MISSING');
    if (previous.providerBinding && previous.providerBinding.providerId !== PROVIDER_ID) {
      return {
        state: 'unavailable',
        failure: { code: 'COMPUTER_CHATGPT_BOOTSTRAP_PROVIDER_MISMATCH', retryable: false, phase: 'pre_mutation', failoverSafe: true },
      };
    }
    try {
      await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => { lease.clearBinding(); });
      let record = this.upsert(identity, 'provider_owned');
      record = await this.bind(identity, record, page, 'provider_owned');
      this.pages.delete(targetId);
      this.authority.tombstoneSurface(this.controllerHome, targetId);
      const observation = await observeMacOsChatgptPage(page, { includeUserHistory: false, includePageText: false });
      return { state: 'ready', target: this.target(identity, record, page), observation };
    } catch (error) { return failure(error, 'COMPUTER_CHATGPT_BOOTSTRAP_PROMOTION_FAILED'); }
  }

  async cleanup(activeResourceKeys: readonly string[]): Promise<void> {
    const active = new Set(activeResourceKeys);
    for (const record of this.authority.listAllSurfaces(this.controllerHome)) {
      const resource = record.stableIdentity.resource;
      if (!resource || (resource.namespace !== 'chatgpt.conversation' && resource.namespace !== 'chatgpt.bootstrap')) continue;
      const resourceKey = `${resource.namespace}:${resource.key}`;
      if (active.has(resourceKey) || !record.providerBinding || record.providerBinding.providerId !== PROVIDER_ID) continue;
      const product = productForBinding(record.providerBinding);
      const page = this.pages.get(record.targetId);
      let resolved = page;
      if (!resolved && product && record.providerBinding.windowId && record.providerBinding.tabId) {
        try { resolved = await this.reattach({ browserProduct: product, windowId: record.providerBinding.windowId, tabId: record.providerBinding.tabId }); } catch { /* stale binding */ }
      }
      if (resolved && record.stableIdentity.ownership === 'provider_owned') {
        const ref = resolved.tabRef(); if (ref) await closeMacOsBrowserOwnedTab(ref.browserProduct, ref, this.timeoutMs).catch(() => undefined);
      }
      this.pages.delete(record.targetId);
      await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => { lease.clearBinding(); }).catch(() => undefined);
      if (resource.namespace === 'chatgpt.bootstrap') this.authority.tombstoneSurface(this.controllerHome, record.targetId);
    }
  }

  async release(targetId: string): Promise<void> {
    const record = this.authority.getSurface(this.controllerHome, targetId);
    if (!record) { this.pages.delete(targetId); return; }
    if (record.providerBinding && record.providerBinding.providerId !== PROVIDER_ID) return;
    const page = this.pages.get(targetId);
    this.pages.delete(targetId);
    if (page && record.stableIdentity.ownership === 'provider_owned') {
      const ref = page.tabRef(); if (ref) await closeMacOsBrowserOwnedTab(ref.browserProduct, ref, this.timeoutMs).catch(() => undefined);
    }
    await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => { lease.clearBinding(); }).catch(() => undefined);
  }

  async close(): Promise<void> {
    // Runtime/adapter shutdown is not semantic target retirement. Keep the
    // provider tab and durable provider binding intact so the next Runtime can
    // reattach to the same exact conversation without manufacturing a tab.
    this.pages.clear();
  }
}
