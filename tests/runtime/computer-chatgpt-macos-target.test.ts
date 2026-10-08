import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runtimeComputerInteractionTargetAuthority } from '../../src/runtime/root/computer-target-composition';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import { MacOsChatgptConversationTargetPort } from '../../src/runtime/plugins/computer-chatgpt-macos-target';

type BrowserProduct = 'chrome' | 'vivaldi';

interface TestPage {
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  foregroundState(): Promise<{ frontmost: boolean; active: boolean }>;
  bringToFront(): Promise<void>;
  tabRef(): { browserProduct: BrowserProduct; windowId: string; tabId: string };
}

type TestablePort = {
  create(url: string, preferredProduct?: BrowserProduct, preferredWindowId?: string): Promise<TestPage>;
  reattach(ref: { browserProduct: BrowserProduct; windowId: string; tabId: string }): Promise<TestPage>;
  listTabs(): Promise<{ entries: unknown[]; unavailableProviders: string[] }>;
};

function testPage(tabId: string, onEvaluate: () => void): TestPage {
  return {
    evaluate: async <T>() => {
      onEvaluate();
      throw new Error('owner marker unavailable');
    },
    foregroundState: async () => ({ frontmost: true, active: true }),
    bringToFront: async () => undefined,
    tabRef: () => ({ browserProduct: 'vivaldi', windowId: 'bootstrap-window', tabId }),
  };
}

test('bootstrap persists exact native binding before DOM owner marking and reuses it across ports', async () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-chatgpt-bootstrap-binding-'));
  const authority = runtimeComputerInteractionTargetAuthority();
  const bootstrapKey = 'bootstrap-binding-authority';
  const projectUrl = 'https://chatgpt.com/g/g-p-bootstrap/project';
  const identity = {
    surfaceType: 'browser-tab' as const,
    ownership: 'provider_owned' as const,
    resource: { namespace: 'chatgpt.bootstrap', key: bootstrapKey },
  };

  try {
    let createCalls = 0;
    let ownerMarkerAttempts = 0;
    const originalPage = testPage('bootstrap-tab-1', () => { ownerMarkerAttempts += 1; });
    const first = new MacOsChatgptConversationTargetPort(controllerHome, authority, 1_000);
    (first as unknown as TestablePort).create = async () => {
      createCalls += 1;
      return originalPage;
    };

    const opened = await first.openBootstrap(projectUrl, bootstrapKey);
    expect(opened.state).toBe('ready');
    expect(createCalls).toBe(1);
    expect(ownerMarkerAttempts).toBe(1);

    const durable = authority.findSurfaceByStableIdentity(controllerHome, identity);
    expect(durable?.providerBinding).toMatchObject({
      providerId: 'browser.macos-apple-events',
      browserProduct: 'vivaldi',
      windowId: 'bootstrap-window',
      tabId: 'bootstrap-tab-1',
    });
    expect(durable?.providerBinding?.ownerToken).toBeUndefined();

    let reattachCalls = 0;
    const restarted = new MacOsChatgptConversationTargetPort(controllerHome, authority, 1_000);
    (restarted as unknown as TestablePort).reattach = async (ref) => {
      reattachCalls += 1;
      expect(ref).toEqual({
        browserProduct: 'vivaldi',
        windowId: 'bootstrap-window',
        tabId: 'bootstrap-tab-1',
      });
      return originalPage;
    };
    (restarted as unknown as TestablePort).create = async () => {
      createCalls += 1;
      throw new Error('must not create a replacement while the durable tab exists');
    };

    const resumed = await restarted.openBootstrap(projectUrl, bootstrapKey);
    expect(resumed.state).toBe('ready');
    expect(reattachCalls).toBe(1);
    expect(createCalls).toBe(1);

    const transient = new MacOsChatgptConversationTargetPort(controllerHome, authority, 1_000);
    (transient as unknown as TestablePort).reattach = async () => {
      throw new Error('temporary provider transport failure');
    };
    (transient as unknown as TestablePort).create = async () => {
      createCalls += 1;
      throw new Error('transient reattach failure must not mint another tab');
    };

    const unavailable = await transient.openBootstrap(projectUrl, bootstrapKey);
    expect(unavailable.state).toBe('unavailable');
    expect(createCalls).toBe(1);
    expect(authority.findSurfaceByStableIdentity(controllerHome, identity)?.providerBinding?.tabId).toBe('bootstrap-tab-1');

    const replacementPage = testPage('bootstrap-tab-2', () => undefined);
    const stale = new MacOsChatgptConversationTargetPort(controllerHome, authority, 1_000);
    (stale as unknown as TestablePort).reattach = async () => {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN',
        'saved tab is absent from complete live inventory',
        { retryable: true, details: { candidateCount: 0, inventoryTruncated: false } },
      );
    };
    (stale as unknown as TestablePort).create = async () => {
      createCalls += 1;
      return replacementPage;
    };

    const replaced = await stale.openBootstrap(projectUrl, bootstrapKey);
    expect(replaced.state).toBe('ready');
    expect(createCalls).toBe(2);
    expect(authority.findSurfaceByStableIdentity(controllerHome, identity)?.providerBinding?.tabId).toBe('bootstrap-tab-2');
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
});


test('ensureExact preserves the canonical tab on transient reattach and cached DOM failures', async () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-exact-native-busy-'));
  const authority = runtimeComputerInteractionTargetAuthority();
  const conversationId = 'aaaaaaaa-2222-3333-4444-555555555555';
  const canonicalUrl = `https://chatgpt.com/c/${conversationId}`;
  const identity = { namespace: 'chatgpt.conversation' as const, conversationId, canonicalUrl };
  const stableIdentity = {
    surfaceType: 'browser-tab' as const, ownership: 'provider_owned' as const,
    resource: { namespace: 'chatgpt.conversation', key: conversationId },
  };
  try {
    authority.upsertSurface(controllerHome, {
      stableIdentity, visibility: 'controller', reactivate: true,
      providerBinding: {
        providerId: 'browser.macos-apple-events', browserProduct: 'vivaldi',
        windowId: 'exact-window', tabId: 'exact-tab', observedAt: new Date().toISOString(),
      },
    });
    let transient: string | undefined = 'BROWSER_AUTOMATION_SERIALIZATION_BUSY';
    const page: TestPage = {
      evaluate: async <T>() => {
        if (transient) throw new AssistantPluginError(transient, 'native lane unavailable', { retryable: true });
        return {
          url: canonicalUrl, title: 'Exact conversation', latestUserText: '',
          latestAssistantResponse: '', providerActivityText: '', composerText: '', isGenerating: false,
        } as T;
      },
      foregroundState: async () => ({ frontmost: true, active: true }),
      bringToFront: async () => undefined,
      tabRef: () => ({ browserProduct: 'vivaldi', windowId: 'exact-window', tabId: 'exact-tab' }),
    };
    let reattachCalls = 0;
    const port = new MacOsChatgptConversationTargetPort(controllerHome, authority, 1_000);
    const testable = port as unknown as TestablePort;
    testable.reattach = async () => { reattachCalls += 1; return page; };
    testable.listTabs = async () => { throw new Error('busy native observation must not trigger broad inventory'); };
    testable.create = async () => { throw new Error('busy native observation must not create another tab'); };

    const first = await port.ensureExact(identity);
    expect(first.state).toBe('unavailable');
    if (first.state === 'unavailable') expect(first.failure.code).toBe('BROWSER_AUTOMATION_SERIALIZATION_BUSY');
    expect(authority.findSurfaceByStableIdentity(controllerHome, stableIdentity)?.providerBinding?.tabId).toBe('exact-tab');
    expect(reattachCalls).toBe(1);

    transient = undefined;
    expect((await port.ensureExact(identity)).state).toBe('ready');
    transient = 'BROWSER_AUTOMATION_TIMEOUT';
    const cached = await port.ensureExact(identity);
    expect(cached.state).toBe('unavailable');
    if (cached.state === 'unavailable') expect(cached.failure.code).toBe('BROWSER_AUTOMATION_TIMEOUT');
    expect(authority.findSurfaceByStableIdentity(controllerHome, stableIdentity)?.providerBinding?.tabId).toBe('exact-tab');
    expect(reattachCalls).toBe(2);
    transient = undefined;
    expect((await port.ensureExact(identity)).state).toBe('ready');
    expect(reattachCalls).toBe(2);
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
});

test('ensureExact retains a freshly created native tab if its first DOM observation is busy', async () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-exact-native-new-tab-'));
  const authority = runtimeComputerInteractionTargetAuthority();
  const conversationId = 'bbbbbbbb-2222-3333-4444-555555555555';
  const canonicalUrl = `https://chatgpt.com/c/${conversationId}`;
  const identity = { namespace: 'chatgpt.conversation' as const, conversationId, canonicalUrl };
  const stableIdentity = {
    surfaceType: 'browser-tab' as const, ownership: 'provider_owned' as const,
    resource: { namespace: 'chatgpt.conversation', key: conversationId },
  };
  try {
    let failObservation = true;
    let createCalls = 0;
    const page: TestPage = {
      evaluate: async <T>(expression: string | ((...args: unknown[]) => unknown)) => {
        if (String(expression).includes('window.name =')) return 'owner-marked' as T;
        if (failObservation) throw new AssistantPluginError('BROWSER_AUTOMATION_SERIALIZATION_BUSY', 'temporary native contention', { retryable: true });
        return {
          url: canonicalUrl, title: 'Exact conversation', latestUserText: '',
          latestAssistantResponse: '', providerActivityText: '', composerText: '', isGenerating: false,
        } as T;
      },
      foregroundState: async () => ({ frontmost: true, active: true }),
      bringToFront: async () => undefined,
      tabRef: () => ({ browserProduct: 'vivaldi', windowId: 'new-window', tabId: 'new-tab' }),
    };
    const port = new MacOsChatgptConversationTargetPort(controllerHome, authority, 1_000);
    const testable = port as unknown as TestablePort;
    testable.listTabs = async () => ({ entries: [], unavailableProviders: [] });
    testable.create = async () => { createCalls += 1; return page; };
    testable.reattach = async () => { throw new Error('same-port resume must reuse its cached tab'); };
    const first = await port.ensureExact(identity);
    expect(first.state).toBe('unavailable');
    if (first.state === 'unavailable') expect(first.failure.code).toBe('BROWSER_AUTOMATION_SERIALIZATION_BUSY');
    expect(authority.findSurfaceByStableIdentity(controllerHome, stableIdentity)?.providerBinding?.tabId).toBe('new-tab');
    failObservation = false;
    expect((await port.ensureExact(identity)).state).toBe('ready');
    expect(createCalls).toBe(1);
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
});

test('ensureExact replaces a tab only after a complete native inventory proves the old tab absent', async () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-exact-native-missing-'));
  const authority = runtimeComputerInteractionTargetAuthority();
  const conversationId = 'cccccccc-2222-3333-4444-555555555555';
  const canonicalUrl = `https://chatgpt.com/c/${conversationId}`;
  const identity = { namespace: 'chatgpt.conversation' as const, conversationId, canonicalUrl };
  const stableIdentity = {
    surfaceType: 'browser-tab' as const, ownership: 'provider_owned' as const,
    resource: { namespace: 'chatgpt.conversation', key: conversationId },
  };
  try {
    authority.upsertSurface(controllerHome, {
      stableIdentity, visibility: 'controller', reactivate: true,
      providerBinding: {
        providerId: 'browser.macos-apple-events', browserProduct: 'vivaldi',
        windowId: 'old-window', tabId: 'old-tab', observedAt: new Date().toISOString(),
      },
    });
    let createCalls = 0;
    const port = new MacOsChatgptConversationTargetPort(controllerHome, authority, 1_000);
    const testable = port as unknown as TestablePort;
    testable.reattach = async () => {
      throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN', 'saved tab absent', {
        retryable: true, details: { candidateCount: 0, inventoryTruncated: false },
      });
    };
    testable.listTabs = async () => ({ entries: [], unavailableProviders: [] });
    testable.create = async () => {
      createCalls += 1;
      return {
        evaluate: async <T>(expression: string | ((...args: unknown[]) => unknown)) => (
          String(expression).includes('window.name =') ? 'owner-marked' : {
            url: canonicalUrl, title: 'Recovered', latestUserText: '',
            latestAssistantResponse: '', providerActivityText: '', composerText: '', isGenerating: false,
          }
        ) as T,
        foregroundState: async () => ({ frontmost: true, active: true }),
        bringToFront: async () => undefined,
        tabRef: () => ({ browserProduct: 'vivaldi', windowId: 'new-window', tabId: 'replacement-tab' }),
      };
    };
    expect((await port.ensureExact(identity)).state).toBe('ready');
    expect(createCalls).toBe(1);
    expect(authority.findSurfaceByStableIdentity(controllerHome, stableIdentity)?.providerBinding?.tabId).toBe('replacement-tab');
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
});
