import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { defaultSnapshot, WorkflowSupervisorNativeBrowserAdapter, type WorkflowSupervisorNativeBrowserDependencies, type WorkflowSupervisorNativePage } from '../../supervisor/native-browser-adapter';
import { SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../../supervisor/protocol';
import { WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import type { MacOsBrowserTabInventoryEntry, MacOsBrowserTabRef } from '../../src/runtime/plugins/browser-macos-bridge';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function home(): string { const value = mkdtempSync(join(tmpdir(), 'forge-supervisor-native-browser-')); roots.push(value); return value; }

class FakePage implements WorkflowSupervisorNativePage {
  owner = ''; latestUserText = ''; latestAssistantResponse = ''; isGenerating = false; closed = false;
  constructor(readonly ref: MacOsBrowserTabRef, public url: string, public title = 'ChatGPT') {}
  async evaluate<T>(): Promise<T> { throw new Error('fake evaluate should be replaced by adapter dependencies'); }
  tabRef(): MacOsBrowserTabRef { return { ...this.ref }; }
}
function inventory(page: FakePage): MacOsBrowserTabInventoryEntry {
  return { windowId: page.ref.windowId, tabId: page.ref.tabId, url: page.url, title: page.title, active: false };
}
function harness(initial: FakePage[] = [], lowerLayerContext = '', providerConfirmed = false, preSubmitFailureReason = '', dispatchedUserSuffix = '') {
  const settlements: string[] = [];
  const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(home()), {
    completionContract: async () => ({ valid: true, reason: 'ok' }),
    userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }),
  }, {
    assistantTurnCommitted: async (_task, completion) => {
      settlements.push(completion.completionFingerprint);
      return { continuationAllowed: true, ...(lowerLayerContext ? { continuationContext: lowerLayerContext } : {}) };
    },
  });
  const discovery = new WorkflowSupervisorEphemeralDiscovery();
  const pages = [...initial]; let created = 0; let dispatchAttempts = 0; let nowMs = 1_000_000; const errors: string[] = [];
  const dependencies: Partial<WorkflowSupervisorNativeBrowserDependencies> = {
    platform: 'darwin',
    listTabs: async () => pages.filter((page) => !page.closed).map(inventory),
    reattach: async (ref) => pages.find((page) => !page.closed && page.ref.tabId === ref.tabId)!,
    create: async (url) => {
      const page = new FakePage({ windowId: 'forge-window', tabId: `forge-tab-${++created}` }, url);
      pages.push(page); return page;
    },
    close: async (ref) => { const page = pages.find((candidate) => candidate.ref.tabId === ref.tabId); if (page) page.closed = true; },
    readOwner: async (page) => (page as FakePage).owner,
    writeOwner: async (page, marker) => { (page as FakePage).owner = marker; },
    snapshot: async (page) => {
      const value = page as FakePage;
      return { url: value.url, title: value.title, latestUserText: value.latestUserText, latestAssistantResponse: value.latestAssistantResponse, isGenerating: value.isGenerating };
    },
    dispatchPrompt: async (page, prompt) => {
      dispatchAttempts += 1;
      if (preSubmitFailureReason && dispatchAttempts === 1) return { dispatched: false, reason: preSubmitFailureReason };
      if (!providerConfirmed) (page as FakePage).latestUserText = `${prompt}${dispatchedUserSuffix}`;
      return { dispatched: true, ...(providerConfirmed ? { confirmed: true } : {}) };
    },
    nowMs: () => nowMs,
    providerIdleGraceMs: 1_000,
    sleep: async () => undefined,
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
  };
  return { control, discovery, pages, errors, settlements, adapter: new WorkflowSupervisorNativeBrowserAdapter(control, discovery, dependencies), created: () => created, dispatchAttempts: () => dispatchAttempts, advance: (ms: number) => { nowMs += ms; } };
}
function register(control: WorkflowSupervisorControlPlane, conversationId: string) {
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId: `task-${conversationId}`, conversationId, conversationUrl, objective: 'Continue the Forge task.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  return { conversationUrl, effect: control.reserveEnrollment(`task-${conversationId}`) };
}

describe('Workflow Supervisor macOS native browser adapter', () => {
  test('keeps effect markers when later user-role nodes are visible in the browser DOM', async () => {
    const page: WorkflowSupervisorNativePage = {
      async evaluate<T>(expression: string): Promise<T> {
        const fakeDocument = {
          querySelectorAll: (selector: string) => selector.includes('user')
            ? [{ innerText: 'effect marker prompt' }, { innerText: 'later provider user node' }]
            : [{ innerText: 'latest assistant response' }],
          querySelector: () => null,
          body: { innerText: 'full visible conversation with effect marker' },
          title: 'ChatGPT',
        };
        return Function('document', 'location', `return ${expression}`)(fakeDocument, { href: 'https://chatgpt.com/c/test' }) as T;
      },
      tabRef: () => undefined,
    };
    const snapshot = await defaultSnapshot(page);
    expect(snapshot.latestUserText).toBe('effect marker prompt\nlater provider user node');
    expect(snapshot.pageText).toBe('full visible conversation with effect marker');
    expect(snapshot.latestAssistantResponse).toBe('latest assistant response');
  });

  test('never adopts an unmarked user tab and sends enrollment only through a new Forge-owned exact tab', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const userTab = new FakePage({ windowId: 'user-window', tabId: 'user-tab' }, url);
    const h = harness([userTab]); const { effect } = register(h.control, conversationId);
    await h.adapter.runOnce();
    expect(h.created()).toBe(1);
    const owned = h.pages.find((page) => page.ref.tabId === 'forge-tab-1')!;
    expect(userTab.latestUserText).toBe('');
    expect(owned.owner).toBe(`forge-workflow-supervisor:${conversationId}`);
    expect(owned.latestUserText).toBe(effect.prompt);
    expect(h.control.browserPoll({ conversationId, conversationUrl: url }).command).toBeUndefined();
    expect(h.discovery.get().conversations).toEqual([{ conversationId, canonicalUrl: url, title: 'ChatGPT' }]);
    expect(h.errors).toEqual([]);
  });

  test('retries a historical pre-submit send-control failure without treating unknown submit outcomes as replayable', async () => {
    const conversationId = '13131313-2424-3535-4646-575757575757';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const h = harness([], '', false, 'send_button_missing');
    const { effect } = register(h.control, conversationId);
    await h.adapter.runOnce();
    h.control.browserObserveEffect({ conversationId, conversationUrl: url, effectId: effect.effectId, observationId: 'generic-reconcile-after-safe-failure', outcome: 'unknown', evidence: { reason: 'not_applied_proof_incomplete', reconciliation: true } });
    const retry = h.control.browserPoll({ conversationId, conversationUrl: url });
    expect(retry.command?.mode).toBe('send');
    expect(retry.command?.dispatchGeneration).toBe(2);
    await h.adapter.runOnce();
    expect(h.control.store.latestEffectDispatch(effect.effectId)?.generation).toBe(2);
    expect(h.control.browserPoll({ conversationId, conversationUrl: url }).command).toBeUndefined();
    expect(h.errors).toEqual([]);
  });
  test('leaves a pending effect untouched while the provider is still generating', async () => {
    const conversationId = '14141414-2525-3636-4747-585858585858';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const page = new FakePage({ windowId: 'forge-window', tabId: 'forge-tab-generating' }, url);
    page.owner = `forge-workflow-supervisor:${conversationId}`;
    page.isGenerating = true;
    const h = harness([page]);
    const { effect } = register(h.control, conversationId);

    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(0);
    expect(h.control.store.latestEffectDispatch(effect.effectId)).toBeUndefined();
    expect(h.control.browserPoll({ conversationId, conversationUrl: url }).command?.mode).toBe('send');

    page.isGenerating = false;
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(1);
    expect(h.control.store.effectApplied(effect.effectId)).toBe(true);
    expect(h.errors).toEqual([]);
  });
  test('confirms a dispatched effect from its unique marker when the DOM adds UI text', async () => {
    const conversationId = '15151515-2626-3737-4848-595959595959';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const h = harness([], '', false, '', '\\n展开');
    const { effect } = register(h.control, conversationId);

    await h.adapter.runOnce();
    expect(h.control.store.effectApplied(effect.effectId)).toBe(true);
    expect(h.control.browserPoll({ conversationId, conversationUrl: url }).command).toBeUndefined();
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(1);
    expect(h.errors).toEqual([]);
  });
  test('accepts canonical provider confirmation without requiring DOM user-message equality', async () => {
    const conversationId = '12121212-3434-5656-7878-909090909090';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const h = harness([], '', true);
    register(h.control, conversationId);
    await h.adapter.runOnce();
    const owned = h.pages.find((page) => page.ref.tabId === 'forge-tab-1')!;
    expect(owned.latestUserText).toBe('');
    expect(h.control.browserPoll({ conversationId, conversationUrl: url }).command).toBeUndefined();
    expect(h.errors).toEqual([]);
  });
  test('recovers only the exact marked tab after Runtime memory loss', async () => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const userTab = new FakePage({ windowId: 'user-window', tabId: 'user-tab' }, url);
    const owned = new FakePage({ windowId: 'forge-window', tabId: 'forge-tab-old' }, url);
    owned.owner = `forge-workflow-supervisor:${conversationId}`;
    const h = harness([userTab, owned]); const { effect } = register(h.control, conversationId);
    await h.adapter.runOnce();
    expect(h.created()).toBe(0);
    expect(userTab.latestUserText).toBe('');
    expect(owned.latestUserText).toBe(effect.prompt);
    expect(h.errors).toEqual([]);
  });

  test('uses bounded causal recovery for an applied effect whose provider turn becomes stably idle', async () => {
    const conversationId = '77777777-6666-5555-4444-333333333333';
    const h = harness();
    const { effect } = register(h.control, conversationId);
    await h.adapter.runOnce();
    const page = h.pages.find((candidate) => candidate.ref.tabId === 'forge-tab-1')!;
    expect(h.control.store.effectApplied(effect.effectId)).toBe(true);
    expect(h.dispatchAttempts()).toBe(1);

    page.isGenerating = true;
    h.advance(10_000);
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(1);

    page.isGenerating = false;
    await h.adapter.runOnce();
    h.advance(999);
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(1);
    h.advance(1);
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(2);
    expect(page.latestUserText).toContain('Resume the original task after the previous provider turn ended without a committed Supervisor completion.');
    expect(page.latestUserText).toContain(`Applied Supervisor effect ${effect.effectId}`);
    expect(h.control.store.effectApplied(effect.effectId)).toBe(true);
    expect(h.control.store.latestEffectDispatch(effect.effectId)?.generation).toBe(1);

    await h.adapter.runOnce();
    h.advance(1_000);
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(3);
    const secondRecovery = h.control.store.latestAppliedEffectWithoutCompletion(`task-${conversationId}`)!;
    expect(secondRecovery.kind).toBe('recovery');
    await h.adapter.runOnce();
    h.advance(1_000);
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(3);
    expect(h.control.store.providerRecoveryExhausted(secondRecovery.effectId)).toBe(true);
    h.advance(60_000);
    await h.adapter.runOnce();
    expect(h.dispatchAttempts()).toBe(3);
    expect(h.errors).toEqual([]);
  });
  test('observes a committed CONTINUE response and dispatches the successor effect in the same loop', async () => {
    const conversationId = '99999999-8888-7777-6666-555555555555';
    const h = harness([], 'controller_authority_id=ctrl_next relay_scope_id=requirement:REQ-next', false, '', '\\n展开'); const { conversationUrl, effect } = register(h.control, conversationId);
    await h.adapter.runOnce();
    const page = h.pages.find((candidate) => candidate.ref.tabId === 'forge-tab-1')!;
    const firstPrompt = page.latestUserText;
    page.latestAssistantResponse = `Work remains.\n${SUPERVISOR_BLOCK_START}\n${JSON.stringify({ action: 'CONTINUE', source_effect_id: effect.effectId, checkpoint: 'native checkpoint', reason: 'continue', evidence: ['native transport'] })}\n${SUPERVISOR_BLOCK_END}`;
    await h.adapter.runOnce();
    expect(page.latestUserText).not.toBe(firstPrompt);
    expect(page.latestUserText).toContain('<<<FORGE_WORKFLOW_EFFECT_V1:');
    expect(page.latestUserText).toContain('Previous checkpoint evidence only');
    expect(page.latestUserText).toContain('controller_authority_id=ctrl_next');
    expect(page.latestUserText).toContain('relay_scope_id=requirement:REQ-next');
    expect(h.settlements).toHaveLength(1);
    expect(h.control.browserPoll({ conversationId, conversationUrl }).command).toBeUndefined();
    expect(h.errors).toEqual([]);
  });
});
