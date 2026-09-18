import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { WorkflowSupervisorNativeBrowserAdapter, type WorkflowSupervisorNativeBrowserDependencies, type WorkflowSupervisorNativePage } from '../../supervisor/native-browser-adapter';
import { SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../../supervisor/protocol';
import { WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import type { MacOsBrowserTabInventoryEntry, MacOsBrowserTabRef } from '../../src/runtime/plugins/browser-macos-bridge';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function home(): string { const value = mkdtempSync(join(tmpdir(), 'forge-supervisor-native-browser-')); roots.push(value); return value; }

class FakePage implements WorkflowSupervisorNativePage {
  owner = ''; latestUserText = ''; latestAssistantResponse = ''; closed = false;
  constructor(readonly ref: MacOsBrowserTabRef, public url: string, public title = 'ChatGPT') {}
  async evaluate<T>(): Promise<T> { throw new Error('fake evaluate should be replaced by adapter dependencies'); }
  tabRef(): MacOsBrowserTabRef { return { ...this.ref }; }
}
function inventory(page: FakePage): MacOsBrowserTabInventoryEntry {
  return { windowId: page.ref.windowId, tabId: page.ref.tabId, url: page.url, title: page.title, active: false };
}
function harness(initial: FakePage[] = []) {
  const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(home()), {
    completionContract: async () => ({ valid: true, reason: 'ok' }),
    userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }),
  });
  const discovery = new WorkflowSupervisorEphemeralDiscovery();
  const pages = [...initial]; let created = 0; const errors: string[] = [];
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
      return { url: value.url, title: value.title, latestUserText: value.latestUserText, latestAssistantResponse: value.latestAssistantResponse };
    },
    dispatchPrompt: async (page, prompt) => { (page as FakePage).latestUserText = prompt; return { dispatched: true }; },
    sleep: async () => undefined,
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
  };
  return { control, discovery, pages, errors, adapter: new WorkflowSupervisorNativeBrowserAdapter(control, discovery, dependencies), created: () => created };
}
function register(control: WorkflowSupervisorControlPlane, conversationId: string) {
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId: `task-${conversationId}`, conversationId, conversationUrl, objective: 'Continue the Forge task.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  return { conversationUrl, effect: control.reserveEnrollment(`task-${conversationId}`) };
}

describe('Workflow Supervisor macOS native browser adapter', () => {
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

  test('observes a committed CONTINUE response and dispatches the successor effect in the same loop', async () => {
    const conversationId = '99999999-8888-7777-6666-555555555555';
    const h = harness(); const { conversationUrl, effect } = register(h.control, conversationId);
    await h.adapter.runOnce();
    const page = h.pages.find((candidate) => candidate.ref.tabId === 'forge-tab-1')!;
    const firstPrompt = page.latestUserText;
    page.latestAssistantResponse = `Work remains.\n${SUPERVISOR_BLOCK_START}\n${JSON.stringify({ action: 'CONTINUE', source_effect_id: effect.effectId, checkpoint: 'native checkpoint', reason: 'continue', evidence: ['native transport'] })}\n${SUPERVISOR_BLOCK_END}`;
    await h.adapter.runOnce();
    expect(page.latestUserText).not.toBe(firstPrompt);
    expect(page.latestUserText).toContain('<<<FORGE_WORKFLOW_EFFECT_V1:');
    expect(page.latestUserText).toContain('Previous checkpoint evidence only');
    expect(h.control.browserPoll({ conversationId, conversationUrl }).command).toBeUndefined();
    expect(h.errors).toEqual([]);
  });
});
