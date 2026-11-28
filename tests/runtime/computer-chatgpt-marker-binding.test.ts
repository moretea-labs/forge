import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runtimeComputerInteractionTargetAuthority } from '../../src/runtime/root/computer-target-composition';
import { MacOsChatgptConversationTargetPort } from '../../src/runtime/plugins/browser-chatgpt-target';

test('submitted marker discovery preserves its bootstrap binding until explicit promotion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-marker-bootstrap-'));
  const authority = runtimeComputerInteractionTargetAuthority();
  const bootstrapKey = 'supervisor:marker-test:v2';
  const marker = '[forge-supervisor project=marker-test run=abcdef1234567890]';
  const url = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const ref = { browserProduct: 'chrome' as const, windowId: 'marker-window', tabId: 'marker-tab' };
  const binding = { providerId: 'browser.macos-apple-events', ...ref, observedAt: new Date().toISOString() };
  const original = authority.upsertSurface(home, {
    stableIdentity: {
      surfaceType: 'browser-tab',
      ownership: 'provider_owned',
      resource: { namespace: 'chatgpt.bootstrap', key: bootstrapKey },
    },
    visibility: 'controller',
    providerBinding: binding,
  }).target;
  const page = {
    evaluate: async <T>() =>
      ({
        url,
        title: 'Submitted task',
        latestUserText: marker,
        latestAssistantResponse: '',
        providerActivityText: '',
        composerText: '',
        isGenerating: true,
        userMessages: [marker],
      }) as T,
    foregroundState: async () => ({ frontmost: true, active: true }),
    bringToFront: async () => undefined,
    tabRef: () => ref,
  };
  const port = new MacOsChatgptConversationTargetPort(home, authority, 1_000);
  const native = port as unknown as {
    listTabs(): Promise<{
      entries: Array<typeof ref & { url: string; title: string; active: boolean }>;
      unavailableProviders: string[];
    }>;
    reattach(): Promise<typeof page>;
  };
  native.listTabs = async () => ({
    entries: [{ ...ref, url, title: 'Submitted task', active: true }],
    unavailableProviders: [],
  });
  native.reattach = async () => page;
  try {
    const matches = await port.findBySubmittedMarker(marker, bootstrapKey);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.state).toBe('ready');
    if (matches[0]?.state === 'ready') expect(matches[0].target.targetId).toBe(original.targetId);
    expect(authority.getSurface(home, original.targetId)?.providerBinding).toEqual(binding);
    expect(authority.listAllSurfaces(home)).toHaveLength(1);
  } finally {
    await port.close();
    rmSync(home, { recursive: true, force: true });
  }
});
