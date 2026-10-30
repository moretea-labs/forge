import {
  closeMacOsBrowserOwnedTab,
  createMacOsBrowserOwnedPageForProduct,
  listMacOsBrowserTabs,
  reattachMacOsBrowserOwnedPage,
} from './browser-macos-bridge';
import type { ComputerChatgptNativeBrowserTargetDriver } from '../../../packages/plugin-runtime/computer';

const BROWSER_PRODUCT = 'chrome';
const BROWSER_TIMEOUT_MS = 5_000;

/** Adapts the existing Browser capability; it owns no ChatGPT state or send semantics. */
export function createNativeBrowserChatgptTargetDriver(): ComputerChatgptNativeBrowserTargetDriver {
  return {
    listTabs: async () => {
      const inventory = await listMacOsBrowserTabs(BROWSER_PRODUCT, BROWSER_TIMEOUT_MS, { correctFrontmost: false });
      return { tabs: inventory.tabs, truncated: inventory.truncated };
    },
    attach: async (ref) => (await reattachMacOsBrowserOwnedPage(BROWSER_PRODUCT, ref, BROWSER_TIMEOUT_MS)).page,
    create: async (url, preferredWindowId) => (
      await createMacOsBrowserOwnedPageForProduct(BROWSER_PRODUCT, url, [], preferredWindowId, BROWSER_TIMEOUT_MS)
    ).page,
    close: async (ref) => closeMacOsBrowserOwnedTab(BROWSER_PRODUCT, ref, BROWSER_TIMEOUT_MS),
  };
}
