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
