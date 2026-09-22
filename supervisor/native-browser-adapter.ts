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
import type { ComputerTrustedInput } from '../packages/protocols/computer/index';
import { chatgptProviderPageFailure } from '../adapters/chatgpt/provider-delivery';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { WorkflowSupervisorControlPlane } from './control-plane';
import { renderEffectMarker, sha256, SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from './protocol';
import type { WorkflowSupervisorEphemeralDiscovery } from './server';
import type { WorkflowSupervisorBrowserCommand, WorkflowSupervisorBrowserTask } from './types';

const OWNER_PREFIX = 'forge-workflow-supervisor:';
const DEFAULT_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_FAILURE_SCAN_CHARS = 250_000;
const MAX_PROVIDER_ACTIVITY_CHARS = 64 * 1024;
const MAX_TRUSTED_TEXT_INPUT_CHARS = 10_000;
const NATIVE_BROWSER_PRODUCTS: readonly MacOsBrowserProduct[] = ['vivaldi', 'chrome'];
type TaggedBrowserTabRef = MacOsBrowserTabRef & { browserProduct?: MacOsBrowserProduct };
type TaggedBrowserTabInventoryEntry = MacOsBrowserTabInventoryEntry & { browserProduct?: MacOsBrowserProduct };

export interface WorkflowSupervisorNativePage {
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  tabRef(): MacOsBrowserTabRef | undefined;
  foregroundState?(): Promise<{ frontmost: boolean; active: boolean }>;
  /** Real OS input, required for a provider-visible message submission. */
  trustedInput?(input: ComputerTrustedInput): Promise<void>;
}
export interface WorkflowSupervisorNativeSnapshot {
  url: string;
  title: string;
  latestUserText: string;
  pageText?: string;
  latestAssistantResponse: string;
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
  listTabs(): Promise<TaggedBrowserTabInventoryEntry[]>;
  reattach(ref: MacOsBrowserTabRef): Promise<WorkflowSupervisorNativePage>;
  create(url: string): Promise<WorkflowSupervisorNativePage>;
  close(ref: MacOsBrowserTabRef): Promise<void>;
  readOwner(page: WorkflowSupervisorNativePage): Promise<string>;
  writeOwner(page: WorkflowSupervisorNativePage, marker: string): Promise<void>;
  snapshot(page: WorkflowSupervisorNativePage, options?: WorkflowSupervisorNativeSnapshotOptions): Promise<WorkflowSupervisorNativeSnapshot>;
  dispatchPrompt(page: WorkflowSupervisorNativePage, prompt: string, task: WorkflowSupervisorBrowserTask): Promise<{ dispatched: boolean; confirmed?: boolean; reason?: string }>;
  nowMs(): number;
  providerIdleGraceMs: number;
  sleep(ms: number): Promise<void>;
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  onError(error: unknown): void;
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
  const value = text.trim();
  return value.length <= 512 * 1024 && value.endsWith(SUPERVISOR_BLOCK_END) && value.lastIndexOf(SUPERVISOR_BLOCK_START) >= 0;
}
function targetMarkerPresent(text: string, effectId: string): boolean { return text.includes(renderEffectMarker(effectId)); }
type PromptControl = { value: string; center: { x: number; y: number } };
type PromptControls = { composer?: PromptControl; sendButton?: PromptControl };

function refKey(ref: TaggedBrowserTabRef): string { return `${ref.browserProduct ?? 'unknown'}:${ref.windowId}:${ref.tabId}`; }
function productForRef(ref: TaggedBrowserTabRef): MacOsBrowserProduct {
  if (ref.browserProduct === 'chrome' || ref.browserProduct === 'vivaldi') return ref.browserProduct;
  throw new Error('WORKFLOW_SUPERVISOR_BROWSER_PRODUCT_UNPROVEN');
}
function taggedPage(page: MacOsAppleEventsPage, product: MacOsBrowserProduct): WorkflowSupervisorNativePage {
  return {
    evaluate: page.evaluate.bind(page),
    tabRef: () => {
      const ref = page.tabRef();
      return ref ? { ...ref, browserProduct: product } : undefined;
    },
    foregroundState: page.foregroundState.bind(page),
    trustedInput: page.trustedInput.bind(page),
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
      providerActivityText: latestTurn,
      providerFailureText: (latestTurn + '\\n' + liveProviderStatus).slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS}),
      latestTurnRole: latestRoleNode?.getAttribute?.('data-message-author-role') || undefined,
      isGenerating: Boolean(document.querySelector('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="streaming"]')),
    };
    if (includePageText) snapshot.pageText = String(document.body?.innerText ?? document.body?.textContent ?? '').trim().slice(-${MAX_PROVIDER_FAILURE_SCAN_CHARS});
    return snapshot;
  })()`);
}
async function promptControls(page: WorkflowSupervisorNativePage): Promise<PromptControls> {
  return await page.evaluate<PromptControls>(`(() => {
    const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
    const control = (element) => {
      if (!element || !visible(element)) return undefined;
      const rect = element.getBoundingClientRect();
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) return undefined;
      return {
        value: String(('value' in element ? element.value : element.innerText ?? element.textContent ?? '') || ''),
        center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      };
    };
    const composer = [
      '[data-testid="composer-text-input"]',
      'div#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea[contenteditable="true"]',
      'textarea[name="prompt"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="问问"]',
      'div[role="textbox"][contenteditable="true"]',
    ].map((selector) => document.querySelector(selector)).find(visible);
    const button = [
      '[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[data-testid*="send"]',
    ].map((selector) => document.querySelector(selector)).find((candidate) => visible(candidate) && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true');
    return { composer: control(composer), sendButton: control(button) };
  })()`);
}

export async function defaultDispatchPrompt(page: WorkflowSupervisorNativePage, prompt: string): Promise<{ dispatched: boolean; reason?: string }> {
  if (!page.trustedInput) return { dispatched: false, reason: 'trusted_input_unavailable' };
  const foreground = await page.foregroundState?.();
  if (!foreground || !foreground.frontmost || !foreground.active) {
    return { dispatched: false, reason: 'browser_foreground_required' };
  }
  const before = await promptControls(page);
  if (!before.composer) return { dispatched: false, reason: 'composer_missing' };
  // A non-empty composer is an unconfirmed previous external mutation. Do not
  // overwrite it or manufacture a second submission from an ambiguous state.
  if (normalize(before.composer.value)) return { dispatched: false, reason: 'composer_not_empty' };
  await page.trustedInput({ kind: 'click', x: before.composer.center.x, y: before.composer.center.y, button: 'left', clickCount: 1 });
  for (let offset = 0; offset < prompt.length; offset += MAX_TRUSTED_TEXT_INPUT_CHARS) {
    await page.trustedInput({ kind: 'text', text: prompt.slice(offset, offset + MAX_TRUSTED_TEXT_INPUT_CHARS) });
  }
  const typed = await promptControls(page);
  if (!typed.composer || normalize(typed.composer.value) !== normalize(prompt)) {
    return { dispatched: false, reason: 'composer_text_unconfirmed' };
  }
  if (!typed.sendButton) return { dispatched: false, reason: 'send_button_missing' };
  await page.trustedInput({ kind: 'click', x: typed.sendButton.center.x, y: typed.sendButton.center.y, button: 'left', clickCount: 1 });
  return { dispatched: true };
}

const DEFAULT_DEPENDENCIES: WorkflowSupervisorNativeBrowserDependencies = {
  platform: process.platform,
  listTabs: async () => (await Promise.all(NATIVE_BROWSER_PRODUCTS.map(async (product) => {
    try {
      return (await listMacOsBrowserTabs(product, DEFAULT_TIMEOUT_MS)).tabs.map((tab): TaggedBrowserTabInventoryEntry => ({ ...tab, browserProduct: product }));
    } catch { return []; }
  }))).flat(),
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
  dispatchPrompt: defaultDispatchPrompt,
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
        this.nextRunAtMs = this.deps.nowMs() + (this.lastRunHadTasks ? activeIntervalMs : idleIntervalMs);
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
  }

  private async cleanupInactive(tasks: WorkflowSupervisorBrowserTask[]): Promise<void> {
    const active = new Set(tasks.map((task) => task.conversationId));
    for (const [conversationId, page] of [...this.pages]) {
      if (active.has(conversationId)) continue;
      const ref = page.tabRef();
      try {
        if (ref && await this.deps.readOwner(page) === ownerMarker(conversationId)) await this.deps.close(ref);
      } catch { /* Transport cleanup is best-effort; never reinterpret lifecycle state. */ }
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
    const inventory = await this.deps.listTabs();
    const matches: Array<{ page: WorkflowSupervisorNativePage; ref: TaggedBrowserTabRef }> = [];
    let exactCandidateInspectionFailed = false;
    for (const candidate of inventory.filter((entry) => exactConversation(entry.url, task))) {
      const ref: TaggedBrowserTabRef = {
        windowId: candidate.windowId,
        tabId: candidate.tabId,
        ...(candidate.browserProduct ? { browserProduct: candidate.browserProduct } : {}),
      };
      try {
        const page = await this.deps.reattach(ref);
        if (await this.deps.readOwner(page) === marker) matches.push({ page, ref });
      } catch { exactCandidateInspectionFailed = true; }
    }
    if (matches.length > 0) {
      const [selected, ...duplicates] = matches;
      for (const duplicate of duplicates) await this.deps.close(duplicate.ref).catch(() => undefined);
      this.pages.set(task.conversationId, selected!.page);
      return { state: 'ready', page: selected!.page };
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
    if (mode === 'reconcile') {
      const exact = normalize(snapshot.latestUserText) === normalize(command.prompt);
      // Page text also includes the composer and transient UI labels. Treating
      // a marker there as proof of submission can acknowledge a prompt that
      // never became a committed user message after a send-control failure.
      // Only submitted user-role history is causal evidence for this effect.
      const markerPresent = targetMarkerPresent(snapshot.latestUserText, command.effectId);
      this.control.browserObserveEffect({
        conversationId: command.conversationId,
        conversationUrl: command.conversationUrl,
        effectId: command.effectId,
        observationId: `native-observe-${randomUUID()}`,
        outcome: exact || markerPresent ? 'applied' : 'not_applied',
        evidence: {
          surface: 'macos-native',
          exact_user_message: exact,
          reconciliation: true,
          target_marker_present: markerPresent,
          latest_user_text: snapshot.latestUserText,
          page_text: snapshot.pageText,
          latest_assistant_response: snapshot.latestAssistantResponse,
        },
      });
      return;
    }
    const dispatch = await this.deps.dispatchPrompt(page, command.prompt, task);
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
