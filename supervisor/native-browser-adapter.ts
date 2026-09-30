import { randomUUID } from 'node:crypto';
import {
  closeMacOsBrowserOwnedTab,
  createMacOsBrowserOwnedPageForProduct,
  discoverMacOsBrowserAttachment,
  listMacOsBrowserTabs,
  reattachMacOsBrowserOwnedPage,
  type MacOsAppleEventsPage,
  type MacOsBrowserTabInventoryEntry,
  type MacOsBrowserProduct,
  type MacOsBrowserTabRef,
} from '../src/runtime/plugins/browser-macos-bridge';
import { CHATGPT_AUTOMATION_RATE_LIMITED, chatgptProviderBackpressureRemainingMs, chatgptProviderPageFailure, noteChatgptProviderBackpressure, withChatgptProviderDispatchLane } from '../adapters/chatgpt/provider-delivery';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { WorkflowSupervisorControlPlane } from './control-plane';
import { renderEffectMarker, sha256 } from './protocol';
import type { WorkflowSupervisorEphemeralDiscovery } from './server';
import type { WorkflowSupervisorBrowserCommand, WorkflowSupervisorBrowserTask } from './types';

const OWNER_PREFIX = 'forge-workflow-supervisor:';
const LEGACY_BROWSER_PLUGIN_OWNER_PREFIX = 'forge-browser-owned:';
const DEFAULT_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TRANSPORT_BACKOFF_MS = 60_000;
const MAX_TRANSPORT_BACKOFF_STEPS = 6;
const MAX_LOCAL_OBSERVATION_ATTEMPTS = 3;
const MAX_PROVIDER_FAILURE_SCAN_CHARS = 250_000;
const MAX_PROVIDER_ACTIVITY_CHARS = 64 * 1024;
const NATIVE_BROWSER_PRODUCTS: readonly MacOsBrowserProduct[] = ['chrome', 'vivaldi'];
type TaggedBrowserTabRef = MacOsBrowserTabRef & { browserProduct?: MacOsBrowserProduct };
type TaggedBrowserTabInventoryEntry = MacOsBrowserTabInventoryEntry & { browserProduct?: MacOsBrowserProduct };

export interface WorkflowSupervisorNativePage {
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  tabRef(): MacOsBrowserTabRef | undefined;
}
export interface WorkflowSupervisorNativeSnapshot {
  url: string;
  title: string;
  latestUserText: string;
  pageText?: string;
  latestAssistantResponse: string;
  /** Complete currently-observed role history, present only for causal reconciliation snapshots. */
  userMessages?: string[];
  assistantMessages?: string[];
  /** Exact current composer payload, when the ChatGPT composer is present. */
  composerText?: string;
  providerActivityText: string;
  providerFailureText: string;
  latestTurnRole?: 'user' | 'assistant';
  isGenerating: boolean;
}
export interface WorkflowSupervisorNativeSnapshotOptions {
  includeUserHistory?: boolean;
  includePageText?: boolean;
}
export interface WorkflowSupervisorNativeBrowserDependencies {
  platform: NodeJS.Platform;
  listTabs(): Promise<WorkflowSupervisorNativeBrowserInventory>;
  reattach(ref: MacOsBrowserTabRef): Promise<WorkflowSupervisorNativePage>;
  create(url: string): Promise<WorkflowSupervisorNativePage>;
  close(ref: MacOsBrowserTabRef): Promise<void>;
  readOwner(page: WorkflowSupervisorNativePage): Promise<string>;
  writeOwner(page: WorkflowSupervisorNativePage, marker: string): Promise<void>;
  snapshot(page: WorkflowSupervisorNativePage, options?: WorkflowSupervisorNativeSnapshotOptions): Promise<WorkflowSupervisorNativeSnapshot>;
  clearComposer(page: WorkflowSupervisorNativePage, expectedStalePrompt: string): Promise<boolean>;
  dispatchPrompt(page: WorkflowSupervisorNativePage, prompt: string, task: WorkflowSupervisorBrowserTask, options?: { mode?: 'send' | 'resume' }): Promise<{ dispatched: boolean; confirmed?: boolean; reason?: string }>;
  nowMs(): number;
  providerIdleGraceMs: number;
  /** Shared transient provider-pressure scope. Canonical Runtime passes Controller Home. */
  providerScopeKey: string;
  sleep(ms: number): Promise<void>;
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  onError(error: unknown): void;
}
/**
 * One bounded inventory result. `unavailableProducts` carries the products
 * whose native inventory could not be read at all, which is the difference
 * between "this conversation has no tab" (safe to create) and "Forge cannot
 * see whether this conversation has a tab" (never an authority to create).
 */
export interface WorkflowSupervisorNativeBrowserInventory {
  entries: TaggedBrowserTabInventoryEntry[];
  unavailableProducts: MacOsBrowserProduct[];
}
export interface WorkflowSupervisorNativeBrowserHandle {
  readonly adapter: WorkflowSupervisorNativeBrowserAdapter;
  close(): Promise<void>;
}

function normalize(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function localObservationDelayMs(completedAttempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, Math.min(8, Math.trunc(completedAttempts) - 1));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
type WorkflowSupervisorTabOwnership = 'created' | 'adopted' | 'legacy';
function ownerMarker(conversationId: string, ownership: 'created' | 'adopted' = 'created'): string {
  return `${OWNER_PREFIX}${ownership}:${conversationId}`;
}
function bootstrapOwnerMarker(taskId: string): string {
  return `${OWNER_PREFIX}bootstrap:${taskId}`;
}
function ownerMarkerOwnership(marker: string, conversationId: string): WorkflowSupervisorTabOwnership | undefined {
  if (marker === ownerMarker(conversationId, 'created')) return 'created';
  if (marker === ownerMarker(conversationId, 'adopted')) return 'adopted';
  // Pre-provenance markers could belong to either a Forge-created or user tab.
  // Keep them recoverable, but never auto-close an ambiguous legacy resource.
  if (marker === `${OWNER_PREFIX}${conversationId}`) return 'legacy';
  return undefined;
}
function exactConversation(url: string, task: WorkflowSupervisorBrowserTask): boolean {
  try {
    const parsed = parseChatgptConversationIdentity(url);
    // ChatGPT may add or remove its Project route while retaining the same
    // durable conversation. This adapter is already attached to the exact tab;
    // route presentation is therefore not a second conversation identity.
    return parsed.conversationId === task.conversationId;
  } catch { return false; }
}
function targetMarkerPresent(text: string, effectId: string): boolean { return text.includes(renderEffectMarker(effectId)); }
function unknownObservationFingerprint(effectId: string, reason: string, snapshot: WorkflowSupervisorNativeSnapshot): string {
  return sha256(JSON.stringify({
    effectId,
    reason,
    url: snapshot.url,
    latestUserText: normalize(snapshot.latestUserText),
    latestAssistantResponse: normalize(snapshot.latestAssistantResponse),
    composerText: snapshot.composerText === undefined ? null : normalize(snapshot.composerText),
    latestTurnRole: snapshot.latestTurnRole ?? null,
    isGenerating: snapshot.isGenerating,
  }));
}
function snapshotTargetMarkerPresent(snapshot: WorkflowSupervisorNativeSnapshot, effectId: string): boolean {
  return targetMarkerPresent(snapshot.latestUserText, effectId)
    || snapshot.userMessages?.some((message) => targetMarkerPresent(message, effectId)) === true;
}
function refKey(ref: TaggedBrowserTabRef): string { return `${ref.browserProduct ?? 'unknown'}:${ref.windowId}:${ref.tabId}`; }
function productForRef(ref: TaggedBrowserTabRef): MacOsBrowserProduct {
  if (ref.browserProduct === 'chrome' || ref.browserProduct === 'vivaldi') return ref.browserProduct;
  throw new Error('WORKFLOW_SUPERVISOR_BROWSER_PRODUCT_UNPROVEN');
}
function taggedPage(page: MacOsAppleEventsPage, product: MacOsBrowserProduct): WorkflowSupervisorNativePage {
  return {
    evaluate: page.evaluate.bind(page),
    waitForSelector: page.waitForSelector.bind(page),
    tabRef: () => {
      const ref = page.tabRef();
      return ref ? { ...ref, browserProduct: product } : undefined;
    },
  };
}

export async function defaultSnapshot(page: WorkflowSupervisorNativePage, options: WorkflowSupervisorNativeSnapshotOptions = {}): Promise<WorkflowSupervisorNativeSnapshot> {
  const includeUserHistory = options.includeUserHistory ?? true;
  const includePageText = options.includePageText ?? true;
  return await page.evaluate<WorkflowSupervisorNativeSnapshot>(`(() => {
    const text = (node) => String(node?.innerText ?? node?.textContent ?? '').trim();
    const nodes = (selector) => document.querySelectorAll(selector);
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
      const semanticText = text(semanticContent);
      return semanticText || text(node);
    };
    const roleEntries = (role) => {
      const selector = role === 'user'
        ? '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]'
        : '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
      const seen = new Set();
      const entries = [];
      for (const node of Array.from(nodes(selector))) {
        const semanticKey = String(node?.getAttribute?.('data-chatgpt-search-unit-key') || node?.getAttribute?.('data-content-search-unit-key') || '');
        const messageIds = String(node?.getAttribute?.('data-chatgpt-search-message-ids') || node?.getAttribute?.('data-chatgpt-selection-message-id') || '');
        if (semanticKey || messageIds) {
          const key = semanticKey + '|' + messageIds;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        entries.push(node);
      }
      return entries;
    };
    const latestRoleText = (role) => {
      const matches = roleEntries(role);
      return messageText(matches.length ? matches[matches.length - 1] : undefined);
    };
    const includeUserHistory = ${JSON.stringify(includeUserHistory)};
    const includePageText = ${JSON.stringify(includePageText)};
    const userEntries = roleEntries('user');
    const assistantEntries = roleEntries('assistant');
    const userTexts = includeUserHistory ? userEntries.map(messageText).filter(Boolean) : undefined;
    const assistantTexts = includeUserHistory ? assistantEntries.map(messageText).filter(Boolean) : undefined;
    const composer = [
      '[data-testid="composer-text-input"]',
      'div#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea[contenteditable="true"]',
      'textarea[name="prompt"]',
      'div[role="textbox"][contenteditable="true"]',
    ].map((selector) => document.querySelector(selector)).find((element) => Boolean(element && element.getClientRects && element.getClientRects().length));
    const roleNodes = Array.from(nodes('[data-message-author-role="user"], [data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"]'));
    const latestRoleNode = roleNodes.length ? roleNodes[roleNodes.length - 1] : undefined;
    const latestTurn = (() => {
      const turns = nodes('[data-testid^="conversation-turn-"]');
      if (turns.length) return text(turns[turns.length - 1]).slice(-${MAX_PROVIDER_ACTIVITY_CHARS});
      return messageText(latestRoleNode).slice(-${MAX_PROVIDER_ACTIVITY_CHARS});
    })();
    const liveProviderStatus = Array.from(nodes('[role="alert"], [aria-live="assertive"], [aria-live="polite"]')).map(text).filter(Boolean).slice(-8).join('\\n');
    const snapshot = {
      url: String(location.href || ''),
      title: String(document.title || ''),
      latestUserText: userTexts ? userTexts.join('\\n') : latestRoleText('user'),
      latestAssistantResponse: latestRoleText('assistant'),
      ...(userTexts ? { userMessages: userTexts } : {}),
      ...(assistantTexts ? { assistantMessages: assistantTexts } : {}),
      ...(composer ? { composerText: String(('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '') || '') } : {}),
      providerActivityText: latestTurn,
      // Failure classification must never inspect chat content. A user discussing
      // "429" or "Too many requests" is not evidence that the provider failed.
      providerFailureText: liveProviderStatus.slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS}),
      latestTurnRole: semanticRole(latestRoleNode),
      isGenerating: Boolean(document.querySelector('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="streaming"]')),
    };
    if (includePageText) snapshot.pageText = String(document.body?.innerText ?? document.body?.textContent ?? '').trim().slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS});
    return snapshot;
  })()`);
}
export async function defaultClearComposer(page: WorkflowSupervisorNativePage, expectedStalePrompt: string): Promise<boolean> {
  return await page.evaluate<boolean>(`(() => {
    const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
    const value = (element) => String((element?.innerText ?? element?.textContent ?? '') || '');
    const normalizeValue = (input) => String(input || '').replace(/\\s+/g, ' ').trim();
    const expected = ${JSON.stringify(expectedStalePrompt)};
    const composer = [
      'div#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea[contenteditable="true"]',
      '[data-testid="composer-text-input"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
    ].map((selector) => document.querySelector(selector)).find(visible);
    if (!(composer instanceof HTMLElement) || !composer.isContentEditable) return false;
    // Re-check the entire durable predecessor prompt at mutation time. If the
    // user edited even one character after the snapshot, fail closed.
    if (normalizeValue(value(composer)) !== normalizeValue(expected)) return false;
    composer.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    const deleted = document.execCommand('delete');
    if (!deleted && normalizeValue(value(composer))) {
      range.deleteContents();
      try { composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null })); }
      catch { composer.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    selection.removeAllRanges();
    return !normalizeValue(value(composer));
  })()`);
}

export async function defaultDispatchPrompt(
  page: WorkflowSupervisorNativePage,
  prompt: string,
  options: { mode?: 'send' | 'resume' } = {},
): Promise<{ dispatched: boolean; reason?: string }> {
  const resume = options.mode === 'resume';
  // The native Browser page is already bound to one exact windowId/tabId. Keep
  // compose and submit inside that tab's JavaScript context so normal user activity
  // in other tabs/windows cannot redirect the effect. React renders the send
  // control asynchronously after contenteditable input, so use the Browser's
  // exact-tab bounded selector wait instead of a foreground sleep or Computer input.
  // A freshly opened ChatGPT Project shell can finish its route transition
  // before React hydrates the composer. Give that exact-tab transition a
  // bounded window rather than classifying an otherwise untouched tab as an
  // outcome-unknown provider send.
  let prepared: { prepared: boolean; reason?: string } | undefined;
  for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    try {
      prepared = await page.evaluate<{ prepared: boolean; reason?: string }>(`(() => {
        const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
        const value = (element) => String((element?.innerText ?? element?.textContent ?? '') || '');
        const normalizeValue = (input) => String(input || '').replace(/\\s+/g, ' ').trim();
        const expected = ${JSON.stringify(prompt)};
        const normalizedExpected = normalizeValue(expected);
        const resume = ${JSON.stringify(resume)};
        const composer = [
          'div#prompt-textarea[contenteditable="true"]',
          '#prompt-textarea[contenteditable="true"]',
          '[data-testid="composer-text-input"][contenteditable="true"]',
          'div[role="textbox"][contenteditable="true"]',
        ].map((selector) => document.querySelector(selector)).find(visible);
        if (!(composer instanceof HTMLElement) || !composer.isContentEditable) return { prepared: false, reason: 'composer_missing' };
        const current = normalizeValue(value(composer));
        if (resume) {
          if (!current) return { prepared: false, reason: 'composer_resume_empty' };
          if (current !== normalizedExpected) return { prepared: false, reason: 'composer_resume_mismatch' };
        } else {
          if (current) return { prepared: false, reason: 'composer_not_empty' };
          composer.focus({ preventScroll: true });
          const selection = window.getSelection();
          if (!selection) return { prepared: false, reason: 'composer_selection_unavailable' };
          const range = document.createRange();
          range.selectNodeContents(composer);
          range.deleteContents();
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          if (!document.execCommand('insertText', false, expected)) {
            return { prepared: false, reason: 'composer_text_insertion_rejected' };
          }
        }
        if (normalizeValue(value(composer)) !== normalizedExpected) {
          return { prepared: false, reason: 'composer_text_unconfirmed' };
        }
        return { prepared: true };
      })()`);
    } catch (error) {
      if (attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) throw error;
      await sleepMs(localObservationDelayMs(attempt, 2_000, 4_000));
      continue;
    }
    if (prepared.prepared) break;
    if (prepared.reason !== 'composer_missing' || attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) {
      return { dispatched: false, reason: prepared.reason ?? 'composer_prepare_failed' };
    }
    await sleepMs(localObservationDelayMs(attempt, 2_000, 4_000));
  }
  if (!prepared?.prepared) return { dispatched: false, reason: prepared?.reason ?? 'composer_prepare_failed' };

  // Keep send-control readiness on the same exact-tab DOM transport as
  // composer mutation. The generic selector-wait bridge can lag ChatGPT DOM
  // changes even while execute_javascript sees the live submit button.
  for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    // Re-verify the exact payload on every observation. If the user deliberately
    // edits this Forge-owned tab in the tiny interval, refuse to submit rather
    // than sending mixed content. browserBeginEffect will reconcile the same
    // generation.
    const result = await page.evaluate<{ dispatched: boolean; reason?: string }>(`(() => {
      const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
      const value = (element) => String((element?.innerText ?? element?.textContent ?? '') || '');
      const normalizeValue = (input) => String(input || '').replace(/\\s+/g, ' ').trim();
      const expected = ${JSON.stringify(prompt)};
      const composer = document.querySelector('div#prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"], [data-testid="composer-text-input"][contenteditable="true"], div[role="textbox"][contenteditable="true"]');
      if (!(composer instanceof HTMLElement) || normalizeValue(value(composer)) !== normalizeValue(expected)) {
        return { dispatched: false, reason: 'composer_submit_mismatch' };
      }
      const sendButton = document.querySelector('[data-testid="send-button"], button[aria-label="Send"], button[aria-label="发送"], button[data-testid*="send"], button[type="submit"]');
      if (!(sendButton instanceof HTMLElement)
          || !visible(sendButton)
          || sendButton.hasAttribute('disabled')
          || sendButton.getAttribute('aria-disabled') === 'true') {
        return { dispatched: false, reason: 'send_button_missing' };
      }
      sendButton.click();
      return { dispatched: true };
    })()`);
    if (result.dispatched || result.reason !== 'send_button_missing' || attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) return result;
    await sleepMs(localObservationDelayMs(attempt, 250, 1_000));
  }
  return { dispatched: false, reason: 'send_button_missing' };
}

const DEFAULT_DEPENDENCIES: WorkflowSupervisorNativeBrowserDependencies = {
  platform: process.platform,
  listTabs: async () => {
    const inspected = await Promise.all(NATIVE_BROWSER_PRODUCTS.map(async (product) => {
      try {
        return {
          entries: (await listMacOsBrowserTabs(product, DEFAULT_TIMEOUT_MS)).tabs.map((tab): TaggedBrowserTabInventoryEntry => ({ ...tab, browserProduct: product })),
        };
      } catch {
        // A failed native inventory is unknown transport state, not evidence
        // that the exact conversation tab is absent.
        return { entries: [] as TaggedBrowserTabInventoryEntry[], unavailableProduct: product };
      }
    }));
    return {
      entries: inspected.flatMap((entry) => entry.entries),
      unavailableProducts: inspected.flatMap((entry) => (entry.unavailableProduct ? [entry.unavailableProduct] : [])),
    };
  },
  reattach: async (ref) => {
    const product = productForRef(ref as TaggedBrowserTabRef);
    return taggedPage((await reattachMacOsBrowserOwnedPage(product, ref, DEFAULT_TIMEOUT_MS)).page, product);
  },
  create: async (url) => {
    const { attachment } = await discoverMacOsBrowserAttachment([...NATIVE_BROWSER_PRODUCTS], DEFAULT_TIMEOUT_MS);
    if (!attachment) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_UNAVAILABLE');
    const product = attachment.metadata.product;
    return taggedPage((await createMacOsBrowserOwnedPageForProduct(product, url, attachment.attempts, DEFAULT_TIMEOUT_MS)).page, product);
  },
  close: async (ref) => { await closeMacOsBrowserOwnedTab(productForRef(ref as TaggedBrowserTabRef), ref, DEFAULT_TIMEOUT_MS); },
  readOwner: async (page) => await page.evaluate<string>('String(window.name || "")'),
  writeOwner: async (page, marker) => { await page.evaluate(`(() => { window.name = ${JSON.stringify(marker)}; return window.name; })()`); },
  snapshot: defaultSnapshot,
  clearComposer: defaultClearComposer,
  dispatchPrompt: async (page, prompt, _task, options) => await defaultDispatchPrompt(page, prompt, options),
  nowMs: () => Date.now(),
  providerIdleGraceMs: 60_000,
  providerScopeKey: 'workflow-supervisor-native',
  sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)); },
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (timer) => clearInterval(timer),
  onError: (error) => { process.stderr.write(`[workflow-supervisor-native-browser] ${error instanceof Error ? error.message : String(error)}\\n`); },
};

export class WorkflowSupervisorNativeBrowserAdapter {
  private readonly deps: WorkflowSupervisorNativeBrowserDependencies;
  private readonly pages = new Map<string, WorkflowSupervisorNativePage>();
  private readonly observedAssistant = new Map<string, string>();
  private readonly providerFailureSeen = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private inflight?: Promise<void>;
  private closed = false;
  private nextRunAtMs = 0;
  private lastRunHadTasks = false;
  private inventory?: Promise<WorkflowSupervisorNativeBrowserInventory>;
  private lastRunTransportUnavailable = false;
  private transportFailureStreak = 0;
  constructor(
    private readonly control: WorkflowSupervisorControlPlane,
    private readonly discovery: WorkflowSupervisorEphemeralDiscovery,
    dependencies: Partial<WorkflowSupervisorNativeBrowserDependencies> = {},
  ) { this.deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }; }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer || this.closed || this.deps.platform !== 'darwin') return;
    const activeIntervalMs = Math.max(1, Math.trunc(intervalMs));
    const idleIntervalMs = Math.max(activeIntervalMs, IDLE_INTERVAL_MS);
    const tick = () => {
      if (this.inflight || this.closed || this.deps.nowMs() < this.nextRunAtMs) return;
      this.inflight = this.runOnce().catch(this.deps.onError).finally(() => {
        const baseIntervalMs = this.lastRunHadTasks ? activeIntervalMs : idleIntervalMs;
        // A transport that cannot answer does not get polled at tick rate: each
        // failed attempt used to re-enter the same unprovable attach and create
        // another browser tab.
        const backoffMs = this.lastRunTransportUnavailable
          ? Math.min(baseIntervalMs * 2 ** Math.min(this.transportFailureStreak, MAX_TRANSPORT_BACKOFF_STEPS), MAX_TRANSPORT_BACKOFF_MS)
          : baseIntervalMs;
        this.nextRunAtMs = this.deps.nowMs() + backoffMs;
        this.inflight = undefined;
      });
    };
    tick();
    this.timer = this.deps.setInterval(tick, activeIntervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) this.deps.clearInterval(this.timer);
    this.timer = undefined;
    await this.inflight?.catch(() => undefined);
    this.pages.clear();
    this.observedAssistant.clear();
    this.providerFailureSeen.clear();
  }

  async runOnce(): Promise<void> {
    if (this.deps.platform !== 'darwin' || this.closed) return;
    this.inventory = undefined;
    this.lastRunTransportUnavailable = false;
    const tasks = this.control.browserTasks();
    this.lastRunHadTasks = tasks.length > 0;
    await this.cleanupInactive(tasks);
    const conversations: Array<{ conversation_id: string; canonical_url: string; title?: string }> = [];
    for (const task of tasks) {
      try {
        if (task.conversationId.startsWith('bootstrap:')) {
          await this.bootstrapTask(task);
          continue;
        }
        let poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        let recoveryAuthorized = false;
        // An enrolled conversation is an existing user resource. Supervisor may
        // attach to its exact open tab, but a queued send/recovery is not authority
        // to manufacture a browser tab. Historical pending tasks survive Runtime
        // restarts; letting each one create transport turned that durable registry
        // into an implicit tab-opening queue whenever native cleanup failed.
        const ensured = await this.ensurePage(task);
        if (ensured.state !== 'ready') continue;
        const page = ensured.page;
        const snapshot = ensured.snapshot
          ?? await this.deps.snapshot(page, { includeUserHistory: false, includePageText: false });
        if (!exactConversation(snapshot.url, task)) {
          await this.retireOwnedPage(task, page);
          continue;
        }
        conversations.push({ conversation_id: task.conversationId, canonical_url: task.conversationUrl, ...(snapshot.title.trim() ? { title: snapshot.title.trim().slice(0, 512) } : {}) });
        const providerBusy = snapshot.isGenerating;
        const latestRoleStillUser = snapshot.latestTurnRole === 'user';
        const providerFailureCode = chatgptProviderPageFailure(snapshot.providerFailureText);
        const priorProviderFailure = this.providerFailureSeen.get(task.conversationId);
        if (!providerFailureCode) {
          this.providerFailureSeen.delete(task.conversationId);
        } else if (priorProviderFailure !== providerFailureCode) {
          noteChatgptProviderBackpressure(this.deps.providerScopeKey, providerFailureCode, this.deps.nowMs());
          this.providerFailureSeen.set(task.conversationId, providerFailureCode);
        }
        let providerBackpressureMs = chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs());
        // 429 is transport backpressure, not authority to mint a semantic recovery
        // effect. While the shared cooldown is live, observe locally and send nothing.
        if (poll.command?.mode !== 'reconcile' && providerFailureCode === CHATGPT_AUTOMATION_RATE_LIMITED && providerBackpressureMs > 0) continue;
        if (!poll.command && !providerBusy && snapshot.latestTurnRole === 'assistant' && snapshot.latestAssistantResponse.trim()) {
          const responseFingerprint = sha256(snapshot.latestAssistantResponse);
          if (this.observedAssistant.get(task.conversationId) !== responseFingerprint) {
            try {
              await this.control.browserObserveAssistant({
                conversationId: task.conversationId,
                conversationUrl: task.conversationUrl,
                responseText: snapshot.latestAssistantResponse,
              });
              this.observedAssistant.set(task.conversationId, responseFingerprint);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // Mirror the extension adapter's bounded duplicate suppression: a
              // distinct malformed Supervisor response is useful evidence once,
              // not an excuse to reparse the same assistant text every tick.
              if (message.includes('WORKFLOW_SUPERVISOR_')
                && !message.includes('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH')) {
                this.observedAssistant.set(task.conversationId, responseFingerprint);
              }
              if (!message.includes('WORKFLOW_SUPERVISOR_TASK_TERMINAL')) this.deps.onError(error);
            }
          }
          poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
          if (poll.terminal) continue;
        }
        if (!poll.command) {
          // Provider failure evidence is scoped to the latest turn plus current
          // live status regions. Historical page text must never poison a later turn.
          // The latest committed role being user is not itself a busy signal: if
          // provider activity keeps changing, the digest below resets idle grace;
          // if activity stops changing, the existing bounded recovery path closes
          // a provider turn that died without ever committing an assistant message.
          const providerObservation = this.control.browserObserveProviderTurn({
            conversationId: task.conversationId,
            conversationUrl: task.conversationUrl,
            generating: providerFailureCode ? false : providerBusy,
            latestAssistantResponse: snapshot.latestAssistantResponse,
            providerActivityText: snapshot.providerActivityText,
            providerFailureCode: providerFailureCode === CHATGPT_AUTOMATION_RATE_LIMITED ? undefined : providerFailureCode,
            observedAtMs: this.deps.nowMs(),
            graceMs: this.deps.providerIdleGraceMs,
          });
          recoveryAuthorized = providerObservation.state === 'recovery_reserved';
          if (providerBusy && !providerFailureCode && !recoveryAuthorized) continue;
          if (latestRoleStillUser && !providerFailureCode && !recoveryAuthorized) continue;
          poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        }
        // Recovery stays on the already-attached exact tab. Transport loss is
        // not authority to create a replacement browser resource.
        providerBackpressureMs = chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs());
        const commandMutationBlocked = providerBackpressureMs > 0
          || (providerBusy && !providerFailureCode && !recoveryAuthorized)
          || (latestRoleStillUser && !providerFailureCode && !recoveryAuthorized);
        // Keep one mutation gate for both a fresh send and reconcile's bounded
        // resume/cleanup path. A blocked reconcile may still observe committed
        // user history, but it cannot touch the composer or submit anything.
        if (poll.command?.mode === 'send' && commandMutationBlocked) continue;
        if (poll.command) {
          // The page is an ephemeral Computer resource. The durable effect
          // ledger, not an open page or rendered assistant text, decides the
          // next turn. Unknown sends reopen only the exact conversation for
          // reconciliation on a later tick.
          await this.executeCommand(
            this.pages.get(task.conversationId) ?? page,
            poll.command,
            task,
            { mutationAllowed: !commandMutationBlocked },
          );
          await this.retireOwnedPage(task, this.pages.get(task.conversationId) ?? page);
        }
      } catch (error) {
        this.deps.onError(error);
      }
    }
    this.discovery.update(conversations, 'native-browser');
    this.control.recordBrowserDiscovery('native-browser', this.discovery.sourceConversations('native-browser'));
    this.transportFailureStreak = this.lastRunTransportUnavailable
      ? Math.min(this.transportFailureStreak + 1, MAX_TRANSPORT_BACKOFF_STEPS)
      : 0;
  }

  /**
   * Every task in one tick shares a single bounded inventory snapshot. Reading
   * the native inventory per task multiplied the Apple Events cost by the task
   * count and kept the native transport saturated.
   */
  private listInventory(): Promise<WorkflowSupervisorNativeBrowserInventory> {
    this.inventory ??= this.deps.listTabs();
    return this.inventory;
  }

  /**
   * A close mutates the native inventory, so a snapshot taken before it must
   * not be reused. Creation only adds the newly owned tab, which is never the
   * absence proof for a different conversation.
   */
  private invalidateInventory(): void {
    this.inventory = undefined;
  }

  private async releasePage(conversationId: string, page: WorkflowSupervisorNativePage): Promise<void> {
    const ownership = ownerMarkerOwnership(await this.deps.readOwner(page), conversationId);
    if (!ownership) return;
    const ref = page.tabRef();
    if (ownership === 'created' && ref) {
      await this.deps.close(ref);
      this.invalidateInventory();
      return;
    }
    // Adopted tabs belong to the user. Legacy markers predate ownership
    // provenance, so they are ambiguous and receive the same conservative
    // treatment: release the marker but leave the browser resource intact.
    await this.deps.writeOwner(page, '');
  }

  private async bootstrapTask(task: WorkflowSupervisorBrowserTask): Promise<void> {
    const poll = this.control.bootstrapPoll(task.taskId);
    const command = poll.command;
    if (!command) return;
    if (command.mode === 'reconcile') {
      await this.reconcileBootstrapTask(task, command);
      return;
    }
    if (command.mode !== 'send') return;

    // Reserve the durable generation before creating a native Browser resource.
    // If create() opens a tab but its reply is lost, the next tick is therefore
    // reconciliation-only and can never create a second replacement tab.
    if (!this.control.bootstrapBeginEffect({
      taskId: task.taskId,
      effectId: command.effectId,
      dispatchId: `bootstrap-${randomUUID()}`,
      dispatchGeneration: command.dispatchGeneration,
    })) return;

    let page: WorkflowSupervisorNativePage | undefined;
    let ref: MacOsBrowserTabRef | undefined;
    let preserveForReconcile = true;
    try {
      page = await this.deps.create(this.control.bootstrapProjectUrl(task.taskId));
      ref = page.tabRef();
      const marker = bootstrapOwnerMarker(task.taskId);
      // window.name is a best-effort ownership hint. The effect marker rendered
      // in committed user history remains the causal cross-restart proof.
      try { await this.deps.writeOwner(page, marker); } catch { /* causal marker reconciliation remains authoritative */ }

      const dispatched = await withChatgptProviderDispatchLane(
        this.deps.providerScopeKey,
        () => this.deps.dispatchPrompt(page!, command.prompt, task),
        (result) => result.dispatched ? { providerAccepted: result.confirmed === true } : { code: result.reason, message: result.reason },
      );
      if (!dispatched.dispatched) {
        // No Send click occurred, so this is the only safe negative proof that
        // authorizes another provider generation after the durable backoff.
        this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-${randomUUID()}`, outcome: 'not_applied' });
        preserveForReconcile = false;
        return;
      }

      let reason = 'bootstrap_outbound_not_confirmed';
      for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
        const snapshot = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: false });
        try {
          const identity = parseChatgptConversationIdentity(snapshot.url);
          if (!targetMarkerPresent(snapshot.latestUserText, command.effectId)) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_EFFECT_MARKER_NOT_OBSERVED');
          this.control.bindBootstrapConversation({ taskId: task.taskId, conversationId: identity.conversationId, conversationUrl: identity.canonicalUrl });
          this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-${randomUUID()}`, outcome: 'applied' });
          preserveForReconcile = false;
          return;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          if (attempt < MAX_LOCAL_OBSERVATION_ATTEMPTS) {
            await this.deps.sleep(localObservationDelayMs(attempt, 1_000, 4_000));
          }
        }
      }
      this.control.bootstrapObserveEffect({
        taskId: task.taskId,
        effectId: command.effectId,
        observationId: `bootstrap-${randomUUID()}`,
        outcome: 'unknown',
        evidence: { reconciliation: true, reason },
      });
    } catch (error) {
      this.lastRunTransportUnavailable = true;
      const reason = error instanceof Error ? error.message : String(error);
      try {
        this.control.bootstrapObserveEffect({
          taskId: task.taskId,
          effectId: command.effectId,
          observationId: `bootstrap-${randomUUID()}`,
          outcome: 'unknown',
          evidence: { reconciliation: true, reason },
        });
      } catch { /* Preserve the original transport failure. */ }
      throw error;
    } finally {
      if (ref && !preserveForReconcile) await this.deps.close(ref).catch(() => undefined);
    }
  }

  private async reconcileBootstrapTask(task: WorkflowSupervisorBrowserTask, command: WorkflowSupervisorBrowserCommand): Promise<void> {
    const inventory = await this.listInventory();
    const expectedOwner = bootstrapOwnerMarker(task.taskId);
    const matches: Array<{ page: WorkflowSupervisorNativePage; ref: TaggedBrowserTabRef; ownerMatched: boolean; snapshot?: WorkflowSupervisorNativeSnapshot }> = [];
    for (const candidate of inventory.entries) {
      let parsed: URL;
      try { parsed = new URL(candidate.url); } catch { continue; }
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') continue;
      const ref: TaggedBrowserTabRef = {
        windowId: candidate.windowId,
        tabId: candidate.tabId,
        ...(candidate.browserProduct ? { browserProduct: candidate.browserProduct } : {}),
      };
      let page: WorkflowSupervisorNativePage;
      try { page = await this.deps.reattach(ref); }
      catch { continue; /* An unreadable tab is not evidence that the effect was not applied. */ }
      try {
        if (await this.deps.readOwner(page) === expectedOwner) {
          matches.push({ page, ref, ownerMatched: true });
          continue;
        }
      } catch { /* window.name is only a best-effort hint. */ }
      try {
        const snapshot = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: false });
        if (snapshotTargetMarkerPresent(snapshot, command.effectId)) matches.push({ page, ref, ownerMatched: false, snapshot });
      } catch { /* No readable marker means no causal bootstrap match. */ }
    }
    const observeUnknown = (reason: string): void => {
      this.control.bootstrapObserveEffect({
        taskId: task.taskId,
        effectId: command.effectId,
        observationId: `bootstrap-reconcile-${randomUUID()}`,
        outcome: 'unknown',
        evidence: { reconciliation: true, reason },
      });
    };
    if (matches.length === 0) {
      observeUnknown(inventory.unavailableProducts.length > 0 ? 'bootstrap_inventory_unavailable' : 'bootstrap_tab_not_observed');
      return;
    }
    if (matches.length !== 1) {
      observeUnknown('bootstrap_reconcile_ambiguous');
      return;
    }
    const [{ page, ref, ownerMatched, snapshot: observed }] = matches;
    let applied = false;
    try {
      let snapshot: WorkflowSupervisorNativeSnapshot;
      try { snapshot = observed ?? await this.deps.snapshot(page, { includeUserHistory: true, includePageText: false }); }
      catch (error) {
        observeUnknown(error instanceof Error ? error.message : String(error));
        return;
      }
      let identity;
      try { identity = parseChatgptConversationIdentity(snapshot.url); }
      catch {
        observeUnknown('bootstrap_conversation_identity_unavailable');
        return;
      }
      if (!snapshotTargetMarkerPresent(snapshot, command.effectId)) {
        observeUnknown('bootstrap_effect_marker_not_observed');
        return;
      }
      this.control.bindBootstrapConversation({ taskId: task.taskId, conversationId: identity.conversationId, conversationUrl: identity.canonicalUrl });
      this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-reconcile-${randomUUID()}`, outcome: 'applied' });
      applied = true;
    } finally {
      // A surviving owner marker proves Forge-created resource ownership. Marker-
      // only recovery proves causal conversation identity, not tab ownership, so
      // bind it but leave that browser resource intact.
      if (applied && ownerMatched) {
        await this.deps.close(ref).catch(() => undefined);
        this.invalidateInventory();
      }
    }
  }

  private async cleanupInactive(tasks: WorkflowSupervisorBrowserTask[]): Promise<void> {
    const active = new Set(tasks.map((task) => task.conversationId));
    for (const [conversationId, page] of [...this.pages]) {
      if (active.has(conversationId)) continue;
      try { await this.releasePage(conversationId, page); }
      catch { /* Transport cleanup is best-effort; never reinterpret lifecycle state. */ }
      this.pages.delete(conversationId);
      this.observedAssistant.delete(conversationId);
      this.providerFailureSeen.delete(conversationId);
    }
  }

  private async ensurePage(task: WorkflowSupervisorBrowserTask): Promise<
    | { state: 'ready'; page: WorkflowSupervisorNativePage; snapshot?: WorkflowSupervisorNativeSnapshot }
    | { state: 'missing' | 'unproven' }
  > {
    const cached = this.pages.get(task.conversationId);
    if (cached) {
      try {
        const snapshot = await this.deps.snapshot(cached, { includeUserHistory: false, includePageText: false });
        const ownership = ownerMarkerOwnership(await this.deps.readOwner(cached), task.conversationId);
        if (ownership && exactConversation(snapshot.url, task)) {
          return { state: 'ready', page: cached, snapshot };
        }
      } catch { /* Reconstruct from browser evidence below. */ }
      this.pages.delete(task.conversationId);
    }
    const inventory = await this.listInventory();
    const matches: Array<{ page: WorkflowSupervisorNativePage; ref: TaggedBrowserTabRef; ownership: WorkflowSupervisorTabOwnership }> = [];
    const transferablePluginOwned: Array<{ page: WorkflowSupervisorNativePage; ref: TaggedBrowserTabRef }> = [];
    const adoptable: Array<{ page: WorkflowSupervisorNativePage; ref: TaggedBrowserTabRef }> = [];
    let exactCandidateInspectionFailed = false;
    for (const candidate of inventory.entries.filter((entry) => exactConversation(entry.url, task))) {
      const ref: TaggedBrowserTabRef = {
        windowId: candidate.windowId,
        tabId: candidate.tabId,
        ...(candidate.browserProduct ? { browserProduct: candidate.browserProduct } : {}),
      };
      try {
        const page = await this.deps.reattach(ref);
        const owner = await this.deps.readOwner(page);
        const ownership = ownerMarkerOwnership(owner, task.conversationId);
        if (ownership) {
          matches.push({ page, ref, ownership });
        } else if (owner?.trim().startsWith(LEGACY_BROWSER_PLUGIN_OWNER_PREFIX)) {
          // The initial Controller Browser transport owns its native tab with a
          // forge-browser-owned:* window.name token. Once the exact conversation
          // is enrolled under Workflow Supervisor, that Forge-owned transport
          // resource must be transferred instead of opening a second exact tab.
          // Exact conversation identity is the handoff fence; user-owned tabs do
          // not carry this Forge plugin owner token.
          transferablePluginOwned.push({ page, ref });
        } else if (!owner?.trim()) {
          // A user can close and reopen the exact durable conversation. Its
          // browser attachment is ephemeral, so an unowned exact tab may be
          // adopted for this task, but only when this Supervisor has no owned
          // attachment of its own left to recover. Adoption is decided after the
          // whole inventory is inspected so a live owned tab is never displaced
          // (and closed) in favour of a tab the user is working in.
          adoptable.push({ page, ref });
        }
      } catch { exactCandidateInspectionFailed = true; }
    }
    if (matches.length === 0 && transferablePluginOwned.length > 0) {
      const transferredMarker = ownerMarker(task.conversationId, 'created');
      const [selected, ...duplicates] = transferablePluginOwned;
      try {
        await this.deps.writeOwner(selected!.page, transferredMarker);
        if (await this.deps.readOwner(selected!.page) === transferredMarker) {
          matches.push({ ...selected!, ownership: 'created' });
          for (const duplicate of duplicates) {
            await this.deps.close(duplicate.ref).catch(() => undefined);
            this.invalidateInventory();
          }
        }
      } catch { exactCandidateInspectionFailed = true; }
    }
    if (matches.length === 0 && adoptable.length > 0) {
      const adoptedMarker = ownerMarker(task.conversationId, 'adopted');
      for (const candidate of adoptable) {
        try {
          await this.deps.writeOwner(candidate.page, adoptedMarker);
          if (await this.deps.readOwner(candidate.page) === adoptedMarker) {
            matches.push({ ...candidate, ownership: 'adopted' });
            break;
          }
        } catch { exactCandidateInspectionFailed = true; }
      }
    }
    if (matches.length > 0) {
      const priority: Record<WorkflowSupervisorTabOwnership, number> = { created: 0, adopted: 1, legacy: 2 };
      matches.sort((left, right) => priority[left.ownership] - priority[right.ownership]);
      const [selected, ...duplicates] = matches;
      for (const duplicate of duplicates) await this.releasePage(task.conversationId, duplicate.page).catch(() => undefined);
      this.pages.set(task.conversationId, selected!.page);
      return { state: 'ready', page: selected!.page };
    }
    // An unreadable product inventory can still hold the exact owned tab. Only a
    // complete inventory may assert that the conversation has no tab, and only
    // that assertion authorizes creating one.
    if (inventory.unavailableProducts.length > 0) {
      this.lastRunTransportUnavailable = true;
      return { state: 'unproven' };
    }
    return { state: exactCandidateInspectionFailed ? 'unproven' : 'missing' };
  }

  private async retireOwnedPage(
    task: WorkflowSupervisorBrowserTask,
    page: WorkflowSupervisorNativePage,
  ): Promise<void> {
    try { await this.releasePage(task.conversationId, page); }
    finally {
      this.pages.delete(task.conversationId);
      this.observedAssistant.delete(task.conversationId);
      this.providerFailureSeen.delete(task.conversationId);
    }
  }

  private async executeCommand(
    page: WorkflowSupervisorNativePage,
    command: WorkflowSupervisorBrowserCommand,
    task: WorkflowSupervisorBrowserTask,
    options: { mutationAllowed?: boolean } = {},
  ): Promise<void> {
    // Every Supervisor submission shares the Runtime's single transient ChatGPT
    // provider dispatch lane. Sharing only the cooldown would still allow this
    // transport to submit concurrently with the Controller-relay lane, which is
    // provider-level concurrency no individual Work asked for.
    const dispatchPrompt = (mode?: 'send' | 'resume') => withChatgptProviderDispatchLane(
      this.deps.providerScopeKey,
      () => this.deps.dispatchPrompt(page, command.prompt, task, mode ? { mode } : undefined),
      (result) => (result.dispatched
        ? { providerAccepted: result.confirmed === true }
        : { code: result.reason, message: result.reason }),
    );
    let snapshot = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: true });
    // A recovery effect may be authorized because an enrolled provider turn stayed
    // visually `generating` without observable progress for the bounded stale
    // window. Do not type into a live composer. Stop only that exact Forge-owned
    // conversation turn, verify the provider left generating state, then continue
    // through the normal effect dispatch/reconciliation fence.
    if (command.kind === 'recovery' && snapshot.isGenerating) {
      const stopped = await page.evaluate<boolean>(`(() => {
        const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
        const stop = [
          '[data-testid="stop-button"]',
          '[data-testid*="stop-button"]',
          'button[aria-label*="Stop"]',
          'button[aria-label*="停止"]',
        ].map((selector) => document.querySelector(selector)).find(visible);
        if (!(stop instanceof HTMLElement)) return false;
        stop.click();
        return true;
      })()`);
      if (!stopped) return;
      for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
        await this.deps.sleep(localObservationDelayMs(attempt, 250, 1_000));
        snapshot = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: true });
        if (!snapshot.isGenerating) break;
      }
      if (snapshot.isGenerating) return;
    }
    let mode = command.mode;
    if (mode === 'send') {
      const begin = this.control.browserBeginEffect({
        conversationId: command.conversationId,
        conversationUrl: command.conversationUrl,
        effectId: command.effectId,
        dispatchId: `native-${randomUUID()}`,
        dispatchGeneration: command.dispatchGeneration,
        evidence: {
          surface: 'macos-native',
          latest_user_text: snapshot.latestUserText,
          latest_assistant_response: snapshot.latestAssistantResponse,
        },
      });
      if (!begin.started) mode = 'reconcile';
    }
    let dispatch: { dispatched: boolean; confirmed?: boolean; reason?: string } | undefined;
    if (mode === 'reconcile') {
      const exact = normalize(snapshot.latestUserText) === normalize(command.prompt);
      // Page text also includes the composer and transient UI labels. Treating
      // a marker there as proof of submission can acknowledge a prompt that
      // never became a committed user message after a send-control failure.
      // Only submitted user-role history is causal evidence for this effect.
      const markerPresent = targetMarkerPresent(snapshot.latestUserText, command.effectId);
      if (exact || markerPresent) {
        this.control.browserObserveEffect({
          conversationId: command.conversationId,
          conversationUrl: command.conversationUrl,
          effectId: command.effectId,
          observationId: `native-observe-${randomUUID()}`,
          outcome: 'applied',
          evidence: { surface: 'macos-native', exact_user_message: exact, reconciliation: true, target_marker_present: markerPresent },
        });
        return;
      }
      const composerPresent = snapshot.composerText !== undefined;
      const composerValue = normalize(snapshot.composerText ?? '');
      if (composerPresent && composerValue === normalize(command.prompt)) {
        if (options.mutationAllowed === false) {
          this.control.browserObserveEffect({
            conversationId: command.conversationId,
            conversationUrl: command.conversationUrl,
            effectId: command.effectId,
            observationId: `native-observe-${randomUUID()}`,
            outcome: 'unknown',
            evidence: {
              surface: 'macos-native',
              reconciliation: true,
              reason: 'resume_blocked_live_provider',
              observation_fingerprint: unknownObservationFingerprint(command.effectId, 'resume_blocked_live_provider', snapshot),
            },
          });
          return;
        }
        // Input mutation already happened in this generation, but Send did not
        // become observable. Resume only that exact payload in the same
        // generation; never retype it and never manufacture a retry generation.
        // The exact Browser tab itself is the transport target. Resume the
        // already-written payload in that background tab without activating it.
        dispatch = await dispatchPrompt('resume');
        if (!dispatch.dispatched) {
          this.control.browserObserveEffect({
            conversationId: command.conversationId,
            conversationUrl: command.conversationUrl,
            effectId: command.effectId,
            observationId: `native-observe-${randomUUID()}`,
            outcome: 'unknown',
            evidence: {
              surface: 'macos-native',
              reconciliation: true,
              reason: dispatch.reason ?? 'resume_dispatch_failed',
              observation_fingerprint: unknownObservationFingerprint(command.effectId, dispatch.reason ?? 'resume_dispatch_failed', snapshot),
            },
          });
          return;
        }
      } else {
        let composerProvablyEmpty = composerPresent && !composerValue;
        let reconciliationReason = composerProvablyEmpty ? 'composer_proven_empty' : composerPresent ? 'composer_payload_mismatch' : 'composer_state_unavailable';
        if (options.mutationAllowed !== false && composerPresent && composerValue) {
          const stale = this.control.browserStaleComposerPayload({
            conversationId: command.conversationId,
            conversationUrl: command.conversationUrl,
            currentEffectId: command.effectId,
            composerText: snapshot.composerText ?? '',
          });
          if (stale.stale && await this.deps.clearComposer(page, stale.prompt)) {
            const afterClear = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: true });
            const afterClearValue = normalize(afterClear.composerText ?? '');
            if (afterClear.composerText !== undefined && !afterClearValue) {
              snapshot = afterClear;
              composerProvablyEmpty = true;
              reconciliationReason = 'stale_completed_supervisor_composer_cleared';
            }
          }
        }
        this.control.browserObserveEffect({
          conversationId: command.conversationId,
          conversationUrl: command.conversationUrl,
          effectId: command.effectId,
          observationId: `native-observe-${randomUUID()}`,
          outcome: composerProvablyEmpty ? 'not_applied' : 'unknown',
          evidence: {
            surface: 'macos-native',
            // "The send never applied" is only observable on a rendered
            // conversation surface. A missing composer means the page (or the
            // exact tab) had not rendered a live conversation yet, which is not
            // proof of non-application and must not authorise another send.
            provider_surface_rendered: composerPresent,
            exact_user_message: false,
            reconciliation: true,
            target_marker_present: false,
            reason: reconciliationReason,
            latest_user_text: snapshot.latestUserText,
            latest_assistant_response: snapshot.latestAssistantResponse,
            user_messages: snapshot.userMessages,
            assistant_messages: snapshot.assistantMessages,
            ...(!composerProvablyEmpty ? {
              observation_fingerprint: unknownObservationFingerprint(command.effectId, reconciliationReason, snapshot),
            } : {}),
          },
        });
        return;
      }
    }
    if (!dispatch) {
      // Unattended continuation targets the exact Forge-owned tab by identity;
      // it must not steal the user's foreground browser/tab to obtain input focus.
      dispatch = await dispatchPrompt();
    }
    if (!dispatch.dispatched) {
      this.control.browserObserveEffect({
        conversationId: command.conversationId,
        conversationUrl: command.conversationUrl,
        effectId: command.effectId,
        observationId: `native-observe-${randomUUID()}`,
        outcome: 'unknown',
        evidence: {
          surface: 'macos-native',
          reason: dispatch.reason ?? 'dispatch_failed',
          observation_fingerprint: unknownObservationFingerprint(command.effectId, dispatch.reason ?? 'dispatch_failed', snapshot),
        },
      });
      return;
    }
    if (dispatch.confirmed) {
      this.control.browserObserveEffect({
        conversationId: command.conversationId,
        conversationUrl: command.conversationUrl,
        effectId: command.effectId,
        observationId: `native-observe-${randomUUID()}`,
        outcome: 'applied',
        evidence: { surface: 'canonical-chatgpt-provider', provider_confirmed: true },
      });
      return;
    }
    let exact = false;
    let markerPresent = false;
    for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
      snapshot = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: true });
      exact = normalize(snapshot.latestUserText) === normalize(command.prompt);
      // A marker in page text may still be sitting in the composer after the
      // send control failed. Only the committed user-role history can prove
      // that this external mutation reached the conversation.
      markerPresent = targetMarkerPresent(snapshot.latestUserText, command.effectId);
      if (exact || markerPresent || attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) break;
      await this.deps.sleep(localObservationDelayMs(attempt, 1_000, 4_000));
    }
    this.control.browserObserveEffect({
      conversationId: command.conversationId,
      conversationUrl: command.conversationUrl,
      effectId: command.effectId,
      observationId: `native-observe-${randomUUID()}`,
      outcome: exact || markerPresent ? 'applied' : 'unknown',
      evidence: {
        surface: 'macos-native',
        exact_user_message: exact,
        target_marker_present: markerPresent,
        ...(!exact && !markerPresent ? {
          reason: 'outbound_not_confirmed',
          observation_fingerprint: unknownObservationFingerprint(command.effectId, 'outbound_not_confirmed', snapshot),
        } : {}),
      },
    });
  }
}

export function startWorkflowSupervisorNativeBrowserAdapter(
  control: WorkflowSupervisorControlPlane,
  discovery: WorkflowSupervisorEphemeralDiscovery,
  dependencies: Partial<WorkflowSupervisorNativeBrowserDependencies> = {},
): WorkflowSupervisorNativeBrowserHandle | undefined {
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, discovery, dependencies);
  if ((dependencies.platform ?? process.platform) !== 'darwin') return undefined;
  adapter.start();
  return { adapter, close: async () => { await adapter.close(); } };
}
