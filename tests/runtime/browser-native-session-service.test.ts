import { afterEach, describe, expect, test } from 'bun:test';
import {
  resetMacOsBrowserRuntimeHooksForTest,
  setMacOsBrowserRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-macos-bridge';
import {
  closeTrackedNativeOwnedSession,
  inspectNativeOwnedSessions,
} from '../../src/runtime/plugins/browser-native-session-service';
import type { BrowserSessionState } from '../../packages/protocols/browser/index';

function nativeSession(product: 'chrome' | 'vivaldi' = 'chrome'): BrowserSessionState {
  return {
    schemaVersion: 1,
    sessionId: 'browser-native-owned',
    url: 'https://chatgpt.com/',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    browser: {
      provider: 'macos-apple-events',
      browserProduct: product,
      tab: {
        ownership: 'plugin_owned',
        windowId: '7',
        tabId: '9',
      },
    },
  } as BrowserSessionState;
}

afterEach(() => {
  resetMacOsBrowserRuntimeHooksForTest();
});

describe('native browser session cleanup', () => {
  test('closes an exact Chrome tab without global inventory after verifying its URL and current window', async () => {
    const separator = String.fromCharCode(30);
    let inventoryCalls = 0;
    let metadataCalls = 0;
    let closeCalls = 0;
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('set outputText to "false"')) {
          inventoryCalls += 1;
          throw new Error('global inventory unavailable');
        }
        if (script.includes('close targetTab')) {
          closeCalls += 1;
          return '';
        }
        metadataCalls += 1;
        return ['false', 'https://chatgpt.com/', 'ChatGPT', '0', '0', '900', '600', '8', '9', 'false', 'false'].join(separator);
      },
    });

    await expect(closeTrackedNativeOwnedSession(nativeSession(), 20_000)).resolves.toEqual({
      resourceClosed: true,
      resourceAlreadyMissing: false,
    });
    expect(inventoryCalls).toBe(0);
    expect(metadataCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });
  test('closes an inventory-proven Vivaldi owned tab with one inventory pass', async () => {
    const separator = String.fromCharCode(30);
    const fieldSeparator = String.fromCharCode(31);
    let inventoryCalls = 0;
    let closeCalls = 0;
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('set outputText to "false"')) {
          inventoryCalls += 1;
          return 'false' + separator + '7' + fieldSeparator + '9' + fieldSeparator + 'false'
            + fieldSeparator + 'https://chatgpt.com/' + fieldSeparator + 'ChatGPT';
        }
        if (script.includes('close targetTab')) closeCalls += 1;
        return '';
      },
    });

    await expect(closeTrackedNativeOwnedSession(nativeSession('vivaldi'), 20_000)).resolves.toEqual({
      resourceClosed: true,
      resourceAlreadyMissing: false,
    });
    expect(inventoryCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  test('bounds native inventory budget for close and list inspection', async () => {
    const observedTimeouts: number[] = [];
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script, _args, timeoutMs) => {
        if (script.includes('set outputText to "false"')) {
          observedTimeouts.push(timeoutMs);
          throw new Error('inventory stalled');
        }
        return '';
      },
    });

    await expect(closeTrackedNativeOwnedSession(nativeSession('vivaldi'), 20_000)).rejects.toThrow('inventory stalled');

    const inspection = await inspectNativeOwnedSessions({
      repoRoot: '/tmp/unused-for-unverified-native-session',
      savedSessions: [nativeSession('vivaldi')],
      timeoutMs: 20_000,
      pruneDead: false,
    });
    expect(inspection.unverifiedCount).toBe(1);
    expect(inspection.items.get('browser-native-owned')).toMatchObject({
      liveness: 'unverified',
      evidence: 'native_inventory_unavailable',
    });
    expect(inspection.items.get('browser-native-owned')?.cleanupError).toContain('inventory stalled');
    expect(observedTimeouts).toEqual([3_000, 3_000]);
  });

  test('inspects native session liveness without a redundant foreground metadata probe', async () => {
    const separator = String.fromCharCode(30);
    const fieldSeparator = String.fromCharCode(31);
    let inventoryCalls = 0;
    let foregroundMetadataCalls = 0;
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('set outputText to "false"')) {
          inventoryCalls += 1;
          return 'false' + separator + '7' + fieldSeparator + '9' + fieldSeparator + 'false'
            + fieldSeparator + 'https://chatgpt.com/' + fieldSeparator + 'ChatGPT';
        }
        foregroundMetadataCalls += 1;
        return '';
      },
    });

    const inspection = await inspectNativeOwnedSessions({
      repoRoot: '/tmp/unused-for-native-session-liveness',
      savedSessions: [nativeSession('vivaldi')],
      timeoutMs: 20_000,
      pruneDead: false,
    });

    expect(inspection.liveCount).toBe(1);
    expect(inspection.items.get('browser-native-owned')).toMatchObject({
      liveness: 'live',
      evidence: 'native_tab_live',
    });
    expect(inventoryCalls).toBe(1);
    expect(foregroundMetadataCalls).toBe(0);
  });

  test('does not close a tab when its reused native id no longer resolves to the saved URL', async () => {
    const separator = String.fromCharCode(30);
    let closeCalls = 0;
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('set outputText to "false"')) throw new Error('global inventory must not run');
        if (script.includes('close targetTab')) {
          closeCalls += 1;
          return '';
        }
        return ['false', 'https://chatgpt.com/c/different-conversation', 'ChatGPT',
          '0', '0', '900', '600', '7', '9', 'false', 'false'].join(separator);
      },
    });

    await expect(closeTrackedNativeOwnedSession(nativeSession(), 20_000)).resolves.toEqual({
      resourceClosed: false,
      resourceAlreadyMissing: true,
    });
    expect(closeCalls).toBe(0);
  });

  test('does not close a tab when exact Chrome metadata returns a different tab ID', async () => {
    const separator = String.fromCharCode(30);
    let closeCalls = 0;
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('set outputText to "false"')) throw new Error('global inventory must not run');
        if (script.includes('close targetTab')) {
          closeCalls += 1;
          return '';
        }
        return ['false', 'https://chatgpt.com/', 'ChatGPT',
          '0', '0', '900', '600', '7', '10', 'false', 'false'].join(separator);
      },
    });
    await expect(closeTrackedNativeOwnedSession(nativeSession(), 20_000)).resolves.toEqual({
      resourceClosed: false,
      resourceAlreadyMissing: true,
    });
    expect(closeCalls).toBe(0);
  });

  test('retires plugin-owned transport metadata when its native browser is not running', async () => {
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => false,
    });

    await expect(closeTrackedNativeOwnedSession(nativeSession(), 20_000)).resolves.toEqual({
      resourceClosed: false,
      resourceAlreadyMissing: true,
    });
    const inspection = await inspectNativeOwnedSessions({
      repoRoot: '/tmp/unused-for-stopped-native-browser',
      savedSessions: [nativeSession()],
      timeoutMs: 20_000,
      pruneDead: false,
    });
    expect(inspection.items.get('browser-native-owned')).toMatchObject({
      liveness: 'dead',
      evidence: 'native_tab_missing',
    });
  });
});
