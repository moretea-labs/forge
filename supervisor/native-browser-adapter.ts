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
import { chatgptProviderPageFailure } from '../adapters/chatgpt/provider-delivery';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { WorkflowSupervisorControlPlane } from './control-plane';
import { hasCommittedSupervisorEnvelope, renderEffectMarker, sha256 } from './protocol';
import type { WorkflowSupervisorEphemeralDiscovery } from './server';
import type { WorkflowSupervisorBrowserCommand, WorkflowSupervisorBrowserTask } from './types';

const OWNER_PREFIX = 'forge-workflow-supervisor:';
const DEFAULT_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TRANSPORT_BACKOFF_MS = 60_000;
const MAX_TRANSPORT_BACKOFF_STEPS = 6;
const MAX_PROVIDER_FAILURE_SCAN_CHARS = 250_000;
const MAX_PROVIDER_ACTIVITY_CHARS = 64 * 1024;
const NATIVE_BROWSER_PRODUCTS: readonly MacOsBrowserProduct[] = ['vivaldi', 'chrome'];
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
  dispatchPrompt(page: WorkflowSupervisorNativePage, prompt: string, task: WorkflowSupervisorBrowserTask, options?: { mode?: 'send' | 'resume' }): Promise<{ dispatched: boolean; confirmed?: boolean; reason?: string }>;
  nowMs(): number;
  providerIdleGraceMs: number;
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
function ownerMarker(conversationId: string): string { return `${OWNER_PREFIX}${conversationId}`; }
function exactConversation(url: string, task: WorkflowSupervisorBrowserTask): boolean {
  try {
    const parsed = parseChatgptConversationIdentity(url);
    return parsed.conversationId === task.conversationId && parsed.canonicalUrl === task.conversationUrl;
  } catch { return false; }
}
function committedAssistant(text: string): boolean {
  return hasCommittedSupervisorEnvelope(text.trim());
}
function targetMarkerPresent(text: string, effectId: string): boolean { return text.includes(renderEffectMarker(effectId)); }
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
    const latestText = (selector) => {
      const matches = nodes(selector);
      return text(matches.length ? matches[matches.length - 1] : undefined);
    };
    const allTexts = (selector) => {
      const matches = nodes(selector);
      return Array.from(matches).map(text).filter(Boolean);
    };
    const includeUserHistory = ${JSON.stringify(includeUserHistory)};
    const includePageText = ${JSON.stringify(includePageText)};
    const userTexts = includeUserHistory ? allTexts('[data-message-author-role="user"]') : undefined;
    const composer = [
      '[data-testid="composer-text-input"]',
      'div#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea[contenteditable="true"]',
      'textarea[name="prompt"]',
      'div[role="textbox"][contenteditable="true"]',
    ].map((selector) => document.querySelector(selector)).find((element) => Boolean(element && element.getClientRects && element.getClientRects().length));
    const roleNodes = Array.from(nodes('[data-message-author-role="user"], [data-message-author-role="assistant"]'));
    const latestRoleNode = roleNodes.length ? roleNodes[roleNodes.length - 1] : undefined;
    const latestTurn = (() => {
      const turns = nodes('[data-testid^="conversation-turn-"]');
      return turns.length ? text(turns[turns.length - 1]).slice(-${MAX_PROVIDER_ACTIVITY_CHARS}) : '';
    })();
    const liveProviderStatus = allTexts('[role="alert"], [aria-live="assertive"], [aria-live="polite"]').slice(-8).join('\\n');
    const snapshot = {
      url: String(location.href || ''),
      title: String(document.title || ''),
      latestUserText: userTexts ? userTexts.join('\\n') : latestText('[data-message-author-role="user"]'),
      latestAssistantResponse: latestText('[data-message-author-role="assistant"]'),
      ...(composer ? { composerText: String(('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '') || '') } : {}),
      providerActivityText: latestTurn,
      providerFailureText: (latestTurn + '\\n' + liveProviderStatus).slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS}),
      latestTurnRole: latestRoleNode?.getAttribute?.('data-message-author-role') || undefined,
      isGenerating: Boolean(document.querySelector('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="streaming"]')),
    };
    if (includePageText) snapshot.pageText = String(document.body?.innerText ?? document.body?.textContent ?? '').trim().slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS});
    return snapshot;
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
  const prepared = await page.evaluate<{ prepared: boolean; reason?: string }>(`(() => {
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
  if (!prepared.prepared) return { dispatched: false, reason: prepared.reason ?? 'composer_prepare_failed' };

  await page.waitForSelector('[data-testid="send-button"]', { state: 'visible', timeout: 2_000 });

  // Re-verify the exact payload after the bounded wait. If the user deliberately
  // edits this Forge-owned tab in the tiny interval, refuse to submit rather than
  // sending mixed content. browserBeginEffect will reconcile the same generation.
  return await page.evaluate<{ dispatched: boolean; reason?: string }>(`(() => {
    const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
    const value = (element) => String((element?.innerText ?? element?.textContent ?? '') || '');
    const normalizeValue = (input) => String(input || '').replace(/\\s+/g, ' ').trim();
    const expected = ${JSON.stringify(prompt)};
    const composer = document.querySelector('div#prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"], [data-testid="composer-text-input"][contenteditable="true"], div[role="textbox"][contenteditable="true"]');
    if (!(composer instanceof HTMLElement) || normalizeValue(value(composer)) !== normalizeValue(expected)) {
      return { dispatched: false, reason: 'composer_submit_mismatch' };
    }
    const sendButton = document.querySelector('[data-testid="send-button"]');
    if (!(sendButton instanceof HTMLElement)
        || !visible(sendButton)
        || sendButton.hasAttribute('disabled')
        || sendButton.getAttribute('aria-disabled') === 'true') {
      return { dispatched: false, reason: 'send_button_missing' };
    }
    sendButton.click();
    return { dispatched: true };
  })()`);
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
  dispatchPrompt: async (page, prompt, _task, options) => await defaultDispatchPrompt(page, prompt, options),
  nowMs: () => Date.now(),
  providerIdleGraceMs: 60_000,
  sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)); },
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (timer) => clearInterval(timer),
  onError: (error) => { process.stderr.write(`[workflow-supervisor-native-browser] ${error instanceof Error ? error.message : String(error)}\\n`); },
};

export class WorkflowSupervisorNativeBrowserAdapter {
  private readonly deps: WorkflowSupervisorNativeBrowserDependencies;
  private readonly pages = new Map<string, WorkflowSupervisorNativePage>();
  private readonly observedAssistant = new Map<string, string>();
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
        let poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        // Only an explicit send obligation may create a browser resource.
        // Reconciliation/observation must attach to an existing exact owned tab;
        // a user closing the tab is transport loss, not authority to reopen it.
        const allowCreate = poll.command?.mode === 'send';
        let ensured = await this.ensurePage(task, allowCreate);
        if (ensured.state !== 'ready') {
          // A reconcile command represents an unconfirmed external mutation. Missing
          // transport is not proof that the effect was or was not applied, so never
          // recreate or replay that source effect from transport absence alone.
          if (poll.command || ensured.state !== 'missing') continue;
          const transport = this.control.browserObserveProviderTurn({
            conversationId: task.conversationId,
            conversationUrl: task.conversationUrl,
            generating: false,
            latestAssistantResponse: '',
            providerActivityText: 'exact Forge-owned conversation transport absent from successful browser inventory',
            providerFailureCode: 'WORKFLOW_SUPERVISOR_PROVIDER_TRANSPORT_UNAVAILABLE',
            observedAtMs: this.deps.nowMs(),
            graceMs: this.deps.providerIdleGraceMs,
          });
          if (transport.state !== 'recovery_reserved') continue;
          poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
          if (poll.command?.mode !== 'send') continue;
          ensured = await this.ensurePage(task, true);
          if (ensured.state !== 'ready') continue;
        }
        let page = ensured.page;
        let snapshot = ensured.snapshot
          ?? await this.deps.snapshot(page, { includeUserHistory: false, includePageText: false });
        if (!exactConversation(snapshot.url, task)) {
          await this.retireOwnedPage(task, page);
          if (!allowCreate) continue;
          const replacement = await this.createOwnedPage(task);
          page = replacement.page;
          this.pages.set(task.conversationId, page);
          snapshot = replacement.snapshot;
        }
        conversations.push({ conversation_id: task.conversationId, canonical_url: task.conversationUrl, ...(snapshot.title.trim() ? { title: snapshot.title.trim().slice(0, 512) } : {}) });
        await this.observeAssistant(task, snapshot);
        const providerBusy = snapshot.isGenerating;
        const latestRoleStillUser = snapshot.latestTurnRole === 'user';
        const providerFailureCode = chatgptProviderPageFailure(snapshot.providerFailureText);
        let recoveryAuthorized = false;
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
            providerFailureCode,
            observedAtMs: this.deps.nowMs(),
            graceMs: this.deps.providerIdleGraceMs,
          });
          recoveryAuthorized = providerObservation.state === 'recovery_reserved';
          if (providerBusy && !providerFailureCode) continue;
          if (latestRoleStillUser && !providerFailureCode && !recoveryAuthorized) continue;
          poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        }
        // An already-present send command must not steal the composer from a live
        // provider turn. Only the causal recovery observation above authorizes a
        // send while the latest committed role is still the user.
        if (providerBusy && !providerFailureCode) continue;
        if (latestRoleStillUser && !providerFailureCode && !recoveryAuthorized) continue;
        if (poll.command) await this.executeCommand(this.pages.get(task.conversationId) ?? page, poll.command, task);
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

  private async cleanupInactive(tasks: WorkflowSupervisorBrowserTask[]): Promise<void> {
    const active = new Set(tasks.map((task) => task.conversationId));
    for (const [conversationId, page] of [...this.pages]) {
      if (active.has(conversationId)) continue;
      const ref = page.tabRef();
      try {
        if (ref && await this.deps.readOwner(page) === ownerMarker(conversationId)) await this.deps.close(ref);
      } catch { /* Transport cleanup is best-effort; never reinterpret lifecycle state. */ }
      this.invalidateInventory();
      this.pages.delete(conversationId);
      this.observedAssistant.delete(conversationId);
    }
  }

  private async ensurePage(task: WorkflowSupervisorBrowserTask, allowCreate: boolean): Promise<
    | { state: 'ready'; page: WorkflowSupervisorNativePage; snapshot?: WorkflowSupervisorNativeSnapshot }
    | { state: 'missing' | 'unproven' }
  > {
    const marker = ownerMarker(task.conversationId);
    const cached = this.pages.get(task.conversationId);
    if (cached) {
      try {
        const snapshot = await this.deps.snapshot(cached, { includeUserHistory: false, includePageText: false });
        if (await this.deps.readOwner(cached) === marker && exactConversation(snapshot.url, task)) {
          return { state: 'ready', page: cached, snapshot };
        }
      } catch { /* Reconstruct from browser evidence below. */ }
      this.pages.delete(task.conversationId);
    }
    const inventory = await this.listInventory();
    const matches: Array<{ page: WorkflowSupervisorNativePage; ref: TaggedBrowserTabRef }> = [];
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
        if (owner === marker) {
          matches.push({ page, ref });
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
    if (matches.length === 0 && adoptable.length > 0) {
      for (const candidate of adoptable) {
        try {
          await this.deps.writeOwner(candidate.page, marker);
          if (await this.deps.readOwner(candidate.page) === marker) matches.push(candidate);
        } catch { exactCandidateInspectionFailed = true; }
      }
    }
    if (matches.length > 0) {
      const [selected, ...duplicates] = matches;
      for (const duplicate of duplicates) await this.deps.close(duplicate.ref).catch(() => undefined);
      if (duplicates.length > 0) this.invalidateInventory();
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
    if (!allowCreate) return { state: exactCandidateInspectionFailed ? 'unproven' : 'missing' };
    const created = await this.createOwnedPage(task);
    this.pages.set(task.conversationId, created.page);
    return { state: 'ready', ...created };
  }

  private async createOwnedPage(task: WorkflowSupervisorBrowserTask): Promise<{
    page: WorkflowSupervisorNativePage;
    snapshot: WorkflowSupervisorNativeSnapshot;
  }> {
    const page = await this.deps.create(task.conversationUrl);
    const ref = page.tabRef();
    try {
      let snapshot: WorkflowSupervisorNativeSnapshot | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          snapshot = await this.deps.snapshot(page, { includeUserHistory: false, includePageText: false });
          if (exactConversation(snapshot.url, task)) break;
        } catch { /* Page may still be loading. */ }
        await this.deps.sleep(100);
      }
      if (!snapshot || !exactConversation(snapshot.url, task)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_CONVERSATION_NOT_READY');
      await this.deps.writeOwner(page, ownerMarker(task.conversationId));
      if (await this.deps.readOwner(page) !== ownerMarker(task.conversationId)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_OWNER_MARKER_FAILED');
      return { page, snapshot };
    } catch (error) {
      if (ref) await this.deps.close(ref).catch(() => undefined);
      throw error;
    }
  }

  private async retireOwnedPage(task: WorkflowSupervisorBrowserTask, page: WorkflowSupervisorNativePage): Promise<void> {
    const ref = page.tabRef();
    try {
      if (ref && await this.deps.readOwner(page) === ownerMarker(task.conversationId)) await this.deps.close(ref);
    } finally {
      this.invalidateInventory();
      this.pages.delete(task.conversationId);
      this.observedAssistant.delete(task.conversationId);
    }
  }

  private async observeAssistant(task: WorkflowSupervisorBrowserTask, snapshot: WorkflowSupervisorNativeSnapshot): Promise<void> {
    const response = snapshot.latestAssistantResponse.trim();
    if (!committedAssistant(response)) return;
    const digest = sha256(response);
    if (this.observedAssistant.get(task.conversationId) === digest) return;
    try {
      await this.control.browserObserveAssistant({ conversationId: task.conversationId, conversationUrl: task.conversationUrl, responseText: response });
      this.observedAssistant.set(task.conversationId, digest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('WORKFLOW_SUPERVISOR_CAUSAL_EFFECT_NOT_APPLIED') || message.includes('WORKFLOW_SUPERVISOR_TASK_TERMINAL')) return;
      // A provider can render a syntactically complete but semantically invalid
      // Supervisor block. It is not a completion receipt and must not be
      // retried on every one-second browser tick. Remember that exact response
      // while still allowing the provider-idle observer below to drive bounded
      // recovery. A later provider response has a different digest and is
      // observed normally.
      if (message.startsWith('WORKFLOW_SUPERVISOR_')) {
        this.observedAssistant.set(task.conversationId, digest);
        return;
      }
      throw error;
    }
  }

  private async executeCommand(page: WorkflowSupervisorNativePage, command: WorkflowSupervisorBrowserCommand, task: WorkflowSupervisorBrowserTask): Promise<void> {
    let snapshot = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: true });
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
        // Input mutation already happened in this generation, but Send did not
        // become observable. Resume only that exact payload in the same
        // generation; never retype it and never manufacture a retry generation.
        // The exact Browser tab itself is the transport target. Resume the
        // already-written payload in that background tab without activating it.
        dispatch = await this.deps.dispatchPrompt(page, command.prompt, task, { mode: 'resume' });
        if (!dispatch.dispatched) {
          this.control.browserObserveEffect({
            conversationId: command.conversationId,
            conversationUrl: command.conversationUrl,
            effectId: command.effectId,
            observationId: `native-observe-${randomUUID()}`,
            outcome: 'unknown',
            evidence: { surface: 'macos-native', reconciliation: true, reason: dispatch.reason ?? 'resume_dispatch_failed' },
          });
          return;
        }
      } else {
        const composerProvablyEmpty = composerPresent && !composerValue;
        this.control.browserObserveEffect({
          conversationId: command.conversationId,
          conversationUrl: command.conversationUrl,
          effectId: command.effectId,
          observationId: `native-observe-${randomUUID()}`,
          outcome: composerProvablyEmpty ? 'not_applied' : 'unknown',
          evidence: {
            surface: 'macos-native',
            exact_user_message: false,
            reconciliation: true,
            target_marker_present: false,
            reason: composerProvablyEmpty ? 'composer_proven_empty' : composerPresent ? 'composer_payload_mismatch' : 'composer_state_unavailable',
            latest_user_text: snapshot.latestUserText,
            latest_assistant_response: snapshot.latestAssistantResponse,
          },
        });
        return;
      }
    }
    if (!dispatch) {
      // Unattended continuation targets the exact Forge-owned tab by identity;
      // it must not steal the user's foreground browser/tab to obtain input focus.
      dispatch = await this.deps.dispatchPrompt(page, command.prompt, task);
    }
    if (!dispatch.dispatched) {
      this.control.browserObserveEffect({
        conversationId: command.conversationId,
        conversationUrl: command.conversationUrl,
        effectId: command.effectId,
        observationId: `native-observe-${randomUUID()}`,
        outcome: 'unknown',
        evidence: { surface: 'macos-native', reason: dispatch.reason ?? 'dispatch_failed' },
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
    for (let attempt = 0; attempt < 50; attempt += 1) {
      snapshot = await this.deps.snapshot(page, { includeUserHistory: true, includePageText: true });
      exact = normalize(snapshot.latestUserText) === normalize(command.prompt);
      // A marker in page text may still be sitting in the composer after the
      // send control failed. Only the committed user-role history can prove
      // that this external mutation reached the conversation.
      markerPresent = targetMarkerPresent(snapshot.latestUserText, command.effectId);
      if (exact || markerPresent) break;
      await this.deps.sleep(100);
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
        ...(!exact && !markerPresent ? { reason: 'outbound_not_confirmed' } : {}),
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
