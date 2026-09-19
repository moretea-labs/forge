import { randomUUID } from 'node:crypto';
import {
  closeMacOsBrowserOwnedTab,
  createMacOsBrowserOwnedPageForProduct,
  listMacOsBrowserTabs,
  reattachMacOsBrowserOwnedPage,
  type MacOsAppleEventsPage,
  type MacOsBrowserTabInventoryEntry,
  type MacOsBrowserTabRef,
} from '../src/runtime/plugins/browser-macos-bridge';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { WorkflowSupervisorControlPlane } from './control-plane';
import { renderEffectMarker, sha256, SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from './protocol';
import type { WorkflowSupervisorEphemeralDiscovery } from './server';
import type { WorkflowSupervisorBrowserCommand, WorkflowSupervisorBrowserTask } from './types';

const OWNER_PREFIX = 'forge-workflow-supervisor:';
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface WorkflowSupervisorNativePage {
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  tabRef(): MacOsBrowserTabRef | undefined;
}
export interface WorkflowSupervisorNativeSnapshot {
  url: string;
  title: string;
  latestUserText: string;
  latestAssistantResponse: string;
  isGenerating: boolean;
}
export interface WorkflowSupervisorNativeBrowserDependencies {
  platform: NodeJS.Platform;
  listTabs(): Promise<MacOsBrowserTabInventoryEntry[]>;
  reattach(ref: MacOsBrowserTabRef): Promise<WorkflowSupervisorNativePage>;
  create(url: string): Promise<WorkflowSupervisorNativePage>;
  close(ref: MacOsBrowserTabRef): Promise<void>;
  readOwner(page: WorkflowSupervisorNativePage): Promise<string>;
  writeOwner(page: WorkflowSupervisorNativePage, marker: string): Promise<void>;
  snapshot(page: WorkflowSupervisorNativePage): Promise<WorkflowSupervisorNativeSnapshot>;
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
function refKey(ref: MacOsBrowserTabRef): string { return `${ref.windowId}:${ref.tabId}`; }

async function defaultSnapshot(page: WorkflowSupervisorNativePage): Promise<WorkflowSupervisorNativeSnapshot> {
  return await page.evaluate<WorkflowSupervisorNativeSnapshot>(`(() => {
    const latest = (selector) => {
      const nodes = document.querySelectorAll(selector);
      const node = nodes.item(nodes.length - 1);
      return node ? String(node.innerText ?? node.textContent ?? '').trim() : '';
    };
    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      latestUserText: latest('[data-message-author-role="user"]'),
      latestAssistantResponse: latest('[data-message-author-role="assistant"]'),
      isGenerating: Boolean(document.querySelector('[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"]')),
    };
  })()`);
}
async function defaultDispatchPrompt(page: WorkflowSupervisorNativePage, prompt: string): Promise<{ dispatched: boolean; reason?: string }> {
  return await page.evaluate<{ dispatched: boolean; reason?: string }>(`(() => {
    const prompt = ${JSON.stringify(prompt)};
    const visible = (element) => Boolean(element && element.getClientRects && element.getClientRects().length);
    const composer = [
      '[data-testid="composer-text-input"]',
      'div#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea[contenteditable="true"]',
      'textarea[name="prompt"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="问问"]',
      'div[role="textbox"][contenteditable="true"]',
    ].map((selector) => document.querySelector(selector)).find(visible);
    if (!composer) return { dispatched: false, reason: 'composer_missing' };
    composer.focus();
    let inserted = false;
    if ('value' in composer) {
      composer.value = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      composer.value = prompt;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      inserted = true;
    } else {
      const selection = globalThis.getSelection?.();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        selection.deleteFromDocument();
      }
      inserted = document.execCommand?.('insertText', false, prompt) === true;
    }
    const current = String(('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '')).replace(/\\s+/g, ' ').trim();
    const expected = prompt.replace(/\\s+/g, ' ').trim();
    if (!inserted || current !== expected) {
      if ('value' in composer) composer.value = prompt;
      else composer.textContent = prompt;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    }
    const button = [
      '[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[data-testid*="send"]',
    ].map((selector) => document.querySelector(selector)).find((candidate) => visible(candidate) && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true');
    if (!button) return { dispatched: false, reason: 'send_button_missing' };
    button.click();
    return { dispatched: true };
  })()`);
}

const DEFAULT_DEPENDENCIES: WorkflowSupervisorNativeBrowserDependencies = {
  platform: process.platform,
  listTabs: async () => (await listMacOsBrowserTabs('chrome', DEFAULT_TIMEOUT_MS)).tabs,
  reattach: async (ref) => (await reattachMacOsBrowserOwnedPage('chrome', ref, DEFAULT_TIMEOUT_MS)).page,
  create: async (url) => (await createMacOsBrowserOwnedPageForProduct('chrome', url, [], DEFAULT_TIMEOUT_MS)).page,
  close: async (ref) => { await closeMacOsBrowserOwnedTab('chrome', ref, DEFAULT_TIMEOUT_MS); },
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
  constructor(
    private readonly control: WorkflowSupervisorControlPlane,
    private readonly discovery: WorkflowSupervisorEphemeralDiscovery,
    dependencies: Partial<WorkflowSupervisorNativeBrowserDependencies> = {},
  ) { this.deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }; }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer || this.closed || this.deps.platform !== 'darwin') return;
    const tick = () => {
      if (this.inflight || this.closed) return;
      this.inflight = this.runOnce().catch(this.deps.onError).finally(() => { this.inflight = undefined; });
    };
    tick();
    this.timer = this.deps.setInterval(tick, intervalMs);
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
    await this.cleanupInactive(tasks);
    const conversations: Array<{ conversation_id: string; canonical_url: string; title?: string }> = [];
    for (const task of tasks) {
      try {
        const page = await this.ensurePage(task);
        let snapshot = await this.deps.snapshot(page);
        if (!exactConversation(snapshot.url, task)) {
          await this.retireOwnedPage(task, page);
          const replacement = await this.createOwnedPage(task);
          this.pages.set(task.conversationId, replacement);
          snapshot = await this.deps.snapshot(replacement);
        }
        conversations.push({ conversation_id: task.conversationId, canonical_url: task.conversationUrl, ...(snapshot.title.trim() ? { title: snapshot.title.trim().slice(0, 512) } : {}) });
        await this.observeAssistant(task, snapshot);
        this.control.browserObserveProviderTurn({
          conversationId: task.conversationId,
          conversationUrl: task.conversationUrl,
          generating: snapshot.isGenerating,
          latestAssistantResponse: snapshot.latestAssistantResponse,
          observedAtMs: this.deps.nowMs(),
          graceMs: this.deps.providerIdleGraceMs,
        });
        // A provider turn owns the composer while it is generating. Do not
        // mutate the composer or classify the temporarily absent send control
        // as an unknown external effect; wait for the same exact page to become
        // idle and let the durable effect remain pending.
        if (snapshot.isGenerating) continue;
        const poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        if (poll.command) await this.executeCommand(this.pages.get(task.conversationId) ?? page, poll.command, task);
      } catch (error) {
        this.deps.onError(error);
      }
    }
    this.discovery.update(conversations);
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

  private async ensurePage(task: WorkflowSupervisorBrowserTask): Promise<WorkflowSupervisorNativePage> {
    const marker = ownerMarker(task.conversationId);
    const cached = this.pages.get(task.conversationId);
    if (cached) {
      try {
        const snapshot = await this.deps.snapshot(cached);
        if (await this.deps.readOwner(cached) === marker && exactConversation(snapshot.url, task)) return cached;
      } catch { /* Reconstruct from browser evidence below. */ }
      this.pages.delete(task.conversationId);
    }
    const inventory = await this.deps.listTabs();
    const matches: Array<{ page: WorkflowSupervisorNativePage; ref: MacOsBrowserTabRef }> = [];
    for (const candidate of inventory.filter((entry) => exactConversation(entry.url, task))) {
      const ref = { windowId: candidate.windowId, tabId: candidate.tabId };
      try {
        const page = await this.deps.reattach(ref);
        if (await this.deps.readOwner(page) === marker) matches.push({ page, ref });
      } catch { /* An uninspectable or unmarked user tab is never adopted. */ }
    }
    if (matches.length > 0) {
      const [selected, ...duplicates] = matches;
      for (const duplicate of duplicates) await this.deps.close(duplicate.ref).catch(() => undefined);
      this.pages.set(task.conversationId, selected!.page);
      return selected!.page;
    }
    const page = await this.createOwnedPage(task);
    this.pages.set(task.conversationId, page);
    return page;
  }

  private async createOwnedPage(task: WorkflowSupervisorBrowserTask): Promise<WorkflowSupervisorNativePage> {
    const page = await this.deps.create(task.conversationUrl);
    const ref = page.tabRef();
    try {
      let snapshot: WorkflowSupervisorNativeSnapshot | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          snapshot = await this.deps.snapshot(page);
          if (exactConversation(snapshot.url, task)) break;
        } catch { /* Page may still be loading. */ }
        await this.deps.sleep(100);
      }
      if (!snapshot || !exactConversation(snapshot.url, task)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_CONVERSATION_NOT_READY');
      await this.deps.writeOwner(page, ownerMarker(task.conversationId));
      if (await this.deps.readOwner(page) !== ownerMarker(task.conversationId)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_OWNER_MARKER_FAILED');
      return page;
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
      throw error;
    }
  }

  private async executeCommand(page: WorkflowSupervisorNativePage, command: WorkflowSupervisorBrowserCommand, task: WorkflowSupervisorBrowserTask): Promise<void> {
    let snapshot = await this.deps.snapshot(page);
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
      const markerPresent = targetMarkerPresent(snapshot.latestUserText, command.effectId);
      this.control.browserObserveEffect({
        conversationId: command.conversationId,
        conversationUrl: command.conversationUrl,
        effectId: command.effectId,
        observationId: `native-observe-${randomUUID()}`,
        outcome: exact ? 'applied' : markerPresent ? 'unknown' : 'not_applied',
        evidence: {
          surface: 'macos-native',
          exact_user_message: exact,
          reconciliation: true,
          target_marker_present: markerPresent,
          latest_user_text: snapshot.latestUserText,
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
      snapshot = await this.deps.snapshot(page);
      exact = normalize(snapshot.latestUserText) === normalize(command.prompt);
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
