import { AssistantPluginError } from './errors';
import {
  closeMacOsBrowserOwnedTab,
  listMacOsBrowserTabs,
  macOsBrowserPageHandleStale,
  readMacOsBrowserOwnedTabMetadata,
  type MacOsBrowserProduct,
} from './browser-macos-bridge';
import { listSavedBrowserSessions, removeBrowserSession } from './browser-session-store';
import type { BrowserSessionInventoryItem, BrowserSessionState } from '../../../packages/protocols/browser/index';

export interface NativeOwnedSessionInspection {
  items: Map<string, BrowserSessionInventoryItem>;
  liveCount: number;
  deadCount: number;
  unverifiedCount: number;
  prunedCount: number;
  closedInvalidCount: number;
  failedCleanupCount: number;
}

export function nativeTabInventoryUnsupported(error: unknown): boolean {
  if (error instanceof AssistantPluginError && error.code === 'BROWSER_AUTOMATION_ACTION_UNSUPPORTED') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /\bBROWSER_AUTOMATION_ACTION_UNSUPPORTED\b/.test(message);
}

function isDiscardableNativeOwnedTabUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized === ''
    || normalized === 'about:blank'
    || normalized === 'chrome://newtab/'
    || normalized === 'chrome://new-tab-page/'
    || normalized === 'vivaldi://newtab/'
    || normalized === 'vivaldi://startpage/';
}

/**
 * Native tab liveness/cleanup belongs to one service so the Browser adapter does
 * not reinterpret stable native identity or prune policy action-by-action.
 */
export async function inspectNativeOwnedSessions(input: {
  repoRoot: string;
  savedSessions: BrowserSessionState[];
  timeoutMs: number;
  pruneDead?: boolean;
}): Promise<NativeOwnedSessionInspection> {
  const { repoRoot, savedSessions, timeoutMs } = input;
  const items = new Map<string, BrowserSessionInventoryItem>();
  const inventories = new Map<MacOsBrowserProduct, Awaited<ReturnType<typeof listMacOsBrowserTabs>> | Error>();
  const groups = new Map<string, BrowserSessionState[]>();
  let liveCount = 0;
  let deadCount = 0;
  let unverifiedCount = 0;
  let prunedCount = 0;
  let closedInvalidCount = 0;
  let failedCleanupCount = 0;

  for (const session of savedSessions) {
    const browser = session.browser;
    const tab = browser?.tab;
    const product = browser?.browserProduct;
    if (browser?.provider !== 'macos-apple-events' || tab?.ownership !== 'plugin_owned' || !product || !tab.windowId || !tab.tabId) continue;
    const key = `${product}:${tab.windowId}:${tab.tabId}`;
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const canonical = group.reduce((latest, session) => session.updatedAt > latest.updatedAt ? session : latest);
    const browser = canonical.browser!;
    const tab = browser.tab!;
    const product = browser.browserProduct!;
    let inventory = inventories.get(product);
    if (!inventory) {
      try {
        inventory = await listMacOsBrowserTabs(product, timeoutMs);
      } catch (error) {
        inventory = error instanceof Error ? error : new Error(String(error));
      }
      inventories.set(product, inventory);
    }
    if (inventory instanceof Error) {
      if (!nativeTabInventoryUnsupported(inventory)) {
        for (const session of group) items.set(session.sessionId, { session, liveness: 'unverified', evidence: 'native_inventory_unavailable', cleanupError: inventory.message });
        unverifiedCount += group.length;
        continue;
      }

      const ref = { windowId: tab.windowId!, tabId: tab.tabId! };
      let metadata: Awaited<ReturnType<typeof readMacOsBrowserOwnedTabMetadata>>;
      try {
        metadata = await readMacOsBrowserOwnedTabMetadata(product, ref, timeoutMs);
      } catch (metadataError) {
        if (macOsBrowserPageHandleStale(metadataError)) {
          const pruned = input.pruneDead === true;
          if (pruned) {
            for (const session of group) removeBrowserSession(repoRoot, session.sessionId);
            prunedCount += group.length;
          }
          for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_missing', pruned });
          deadCount += group.length;
        } else {
          const cleanupError = metadataError instanceof Error ? metadataError.message : String(metadataError);
          for (const session of group) items.set(session.sessionId, { session, liveness: 'unverified', evidence: 'native_inventory_unavailable', cleanupError });
          unverifiedCount += group.length;
        }
        continue;
      }

      if (isDiscardableNativeOwnedTabUrl(metadata.url)) {
        deadCount += group.length;
        if (input.pruneDead === true) {
          try {
            await closeMacOsBrowserOwnedTab(product, ref, timeoutMs);
            for (const session of group) removeBrowserSession(repoRoot, session.sessionId);
            prunedCount += group.length;
            closedInvalidCount += 1;
            for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid_closed', pruned: true });
          } catch (error) {
            failedCleanupCount += 1;
            const cleanupError = error instanceof Error ? error.message : String(error);
            for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid_close_failed', cleanupError });
          }
        } else {
          for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid' });
        }
      } else {
        for (const session of group) items.set(session.sessionId, { session, liveness: 'live', evidence: 'native_tab_live' });
        liveCount += group.length;
      }
      continue;
    }

    const live = inventory.tabs.find((entry) => entry.windowId === tab.windowId && entry.tabId === tab.tabId);
    if (!live) {
      const pruned = input.pruneDead === true;
      if (pruned) {
        for (const session of group) removeBrowserSession(repoRoot, session.sessionId);
        prunedCount += group.length;
      }
      for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_missing', pruned });
      deadCount += group.length;
      continue;
    }

    if (isDiscardableNativeOwnedTabUrl(live.url)) {
      deadCount += group.length;
      if (input.pruneDead === true) {
        try {
          await closeMacOsBrowserOwnedTab(product, { windowId: tab.windowId!, tabId: tab.tabId! }, timeoutMs);
          for (const session of group) removeBrowserSession(repoRoot, session.sessionId);
          prunedCount += group.length;
          closedInvalidCount += 1;
          for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid_closed', pruned: true });
        } catch (error) {
          failedCleanupCount += 1;
          const cleanupError = error instanceof Error ? error.message : String(error);
          for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid_close_failed', cleanupError });
        }
      } else {
        for (const session of group) items.set(session.sessionId, { session, liveness: 'dead', evidence: 'native_tab_invalid' });
      }
      continue;
    }

    for (const session of group) items.set(session.sessionId, { session, liveness: 'live', evidence: 'native_tab_live' });
    liveCount += group.length;
  }

  return { items, liveCount, deadCount, unverifiedCount, prunedCount, closedInvalidCount, failedCleanupCount };
}

export async function closeTrackedNativeOwnedSession(
  session: BrowserSessionState,
  timeoutMs: number,
): Promise<{ resourceClosed: boolean; resourceAlreadyMissing: boolean }> {
  const browser = session.browser;
  const tab = browser?.tab;
  if (browser?.provider !== 'macos-apple-events' || tab?.ownership !== 'plugin_owned') {
    return { resourceClosed: false, resourceAlreadyMissing: false };
  }
  if (!browser.browserProduct || !tab.windowId || !tab.tabId) {
    throw new AssistantPluginError('PLUGIN_BROWSER_NATIVE_OWNERSHIP_MISSING', 'Tracked plugin-owned native tab is missing stable browser identity; retaining session metadata instead of orphaning the tab.', {
      retryable: false, details: { sessionId: session.sessionId, browserProduct: browser.browserProduct, windowId: tab.windowId, tabId: tab.tabId },
    });
  }
  const ref = { windowId: tab.windowId, tabId: tab.tabId };
  let inventory: Awaited<ReturnType<typeof listMacOsBrowserTabs>> | undefined;
  try {
    inventory = await listMacOsBrowserTabs(browser.browserProduct, timeoutMs);
  } catch (error) {
    if (!nativeTabInventoryUnsupported(error)) throw error;
    try {
      await readMacOsBrowserOwnedTabMetadata(browser.browserProduct, ref, timeoutMs);
    } catch (metadataError) {
      if (macOsBrowserPageHandleStale(metadataError)) return { resourceClosed: false, resourceAlreadyMissing: true };
      throw metadataError;
    }
  }
  if (inventory && !inventory.tabs.some((entry) => entry.windowId === tab.windowId && entry.tabId === tab.tabId)) {
    return { resourceClosed: false, resourceAlreadyMissing: true };
  }
  await closeMacOsBrowserOwnedTab(browser.browserProduct, ref, timeoutMs);
  return { resourceClosed: true, resourceAlreadyMissing: false };
}

export function nativeOwnedAliasSessionIds(repoRoot: string, session: BrowserSessionState): string[] {
  const browser = session.browser;
  const tab = browser?.tab;
  if (browser?.provider !== 'macos-apple-events' || tab?.ownership !== 'plugin_owned' || !browser.browserProduct || !tab.windowId || !tab.tabId) {
    return [session.sessionId];
  }
  return listSavedBrowserSessions(repoRoot)
    .filter((candidate) => candidate.browser?.provider === 'macos-apple-events'
      && candidate.browser.browserProduct === browser.browserProduct
      && candidate.browser.tab?.ownership === 'plugin_owned'
      && candidate.browser.tab.windowId === tab.windowId
      && candidate.browser.tab.tabId === tab.tabId)
    .map((candidate) => candidate.sessionId);
}
