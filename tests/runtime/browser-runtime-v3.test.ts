import { afterEach, describe, expect, test } from 'bun:test';
import {
  executeBrowserRuntimeAction,
  invalidateBrowserRuntime,
} from '../../src/runtime/plugins/browser-runtime';
import {
  nativeReplacementAssignmentProvenanceProvesTarget,
  nativeReplacementMismatchDiagnostic,
  nativeReplacementPostAssignmentUrlMatchesTarget,
  nativeReplacementUrlMatchesTarget,
  browserActionCanReplayAfterDispatch,
  settleNativeCreatedPageIdentity,
} from '../../src/runtime/plugins/browser-adapter';
import {
  BrowserProviderUnavailableBeforeActionError,
  type BrowserRuntimeProvider,
} from '../../src/runtime/plugins/browser-provider-registry';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';
import {
  invalidateMacOsBrowserPageHandle,
  invalidateMacOsBrowserPageHandles,
  nativeDomLoadStateSatisfied,
  parseMacOsBrowserCreateTabBrokerResult,
  reattachMacOsBrowserOwnedPage,
  resetMacOsBrowserRuntimeHooksForTest,
  setMacOsBrowserRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-macos-bridge';

const nativeSeparator = String.fromCharCode(30);

afterEach(() => {
  resetMacOsBrowserRuntimeHooksForTest();
  invalidateMacOsBrowserPageHandles();
});

function input(actionId: string, requestId: string): AssistantPluginActionExecutionInput {
  return {
    controllerHome: '/tmp/browser-v3-controller',
    repoId: 'repo-browser-v3',
    repoRoot: '/tmp/browser-v3-repo',
    pluginId: 'browser',
    actionId,
    requestId,
    args: {},
    origin: { surface: 'mcp', actor: 'test' },
  };
}

function provider(options: {
  providerId: string;
  capabilities: BrowserRuntimeProvider<AssistantPluginActionExecutionInput, Record<string, unknown>>['capabilities'];
  priority: number;
  execute: BrowserRuntimeProvider<AssistantPluginActionExecutionInput, Record<string, unknown>>['execute'];
  revalidate?: () => void;
}): BrowserRuntimeProvider<AssistantPluginActionExecutionInput, Record<string, unknown>> {
  return {
    providerId: options.providerId,
    capabilities: options.capabilities,
    foreground: 'none',
    verifiesPostconditions: true,
    persistentHandle: true,
    priority: options.priority,
    supportsInput: () => true,
    execute: options.execute,
    revalidate: options.revalidate,
  };
}

describe('Browser Runtime V3 native create-tab provenance', () => {
  test('prefers the structured stable ref and preserves exact assignment provenance', () => {
    const evidence = parseMacOsBrowserCreateTabBrokerResult({
      value: `window-42${nativeSeparator}tab-99`,
      ref: { windowId: 'window-42', tabId: 'tab-99' },
      navigation: {
        provenanceVersion: 1,
        requestedUrl: 'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
        assignmentAccepted: true,
        acceptedBy: 'chrome_applescript_url_set',
        observedUrlAfterAssignment: 'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
      },
    });
    expect(evidence).toEqual({
      ref: { windowId: 'window-42', tabId: 'tab-99' },
      refSource: 'structured',
      navigation: {
        provenanceVersion: 1,
        requestedUrl: 'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
        assignmentAccepted: true,
        acceptedBy: 'chrome_applescript_url_set',
        observedUrlAfterAssignment: 'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
      },
    });
    expect(nativeReplacementAssignmentProvenanceProvesTarget(
      evidence,
      'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
      { windowId: 'window-42', tabId: 'tab-99' },
    )).toBe(true);
  });

  test('keeps legacy value parsing compatible but insufficient for replacement authority', () => {
    const evidence = parseMacOsBrowserCreateTabBrokerResult({ value: `window-legacy${nativeSeparator}tab-legacy` });
    expect(evidence).toEqual({
      ref: { windowId: 'window-legacy', tabId: 'tab-legacy' },
      refSource: 'legacy_value',
    });
    expect(nativeReplacementAssignmentProvenanceProvesTarget(
      evidence,
      'https://chatgpt.com/',
      evidence.ref,
    )).toBe(false);
  });

  test('fails replacement authority for mismatched request or stable ref', () => {
    const evidence = parseMacOsBrowserCreateTabBrokerResult({
      ref: { windowId: 'window-1', tabId: 'tab-2' },
      navigation: { provenanceVersion: 1, requestedUrl: 'https://chatgpt.com/c/exact', assignmentAccepted: true },
    });
    expect(nativeReplacementAssignmentProvenanceProvesTarget(
      evidence,
      'https://chatgpt.com/c/other',
      evidence.ref,
    )).toBe(false);
    expect(nativeReplacementAssignmentProvenanceProvesTarget(
      evidence,
      'https://chatgpt.com/c/exact/',
      evidence.ref,
    )).toBe(false);
    expect(nativeReplacementAssignmentProvenanceProvesTarget(
      evidence,
      'https://chatgpt.com/c/exact',
      { windowId: 'window-1', tabId: 'tab-other' },
    )).toBe(false);
  });

  test('accepts same-origin canonicalization only after exact assignment proof and never accepts wrong origin', () => {
    expect(nativeReplacementPostAssignmentUrlMatchesTarget(
      'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
      'https://www.tunemymusic.com/',
      true,
    )).toBe(true);
    expect(nativeReplacementPostAssignmentUrlMatchesTarget(
      'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
      'https://www.tunemymusic.com/',
      false,
    )).toBe(false);
    expect(nativeReplacementPostAssignmentUrlMatchesTarget(
      'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
      'https://example.com/',
      true,
    )).toBe(false);
  });

  test('rejects conflicting structured and legacy stable refs', () => {
    expect(() => parseMacOsBrowserCreateTabBrokerResult({
      value: `legacy-window${nativeSeparator}legacy-tab`,
      ref: { windowId: 'window-1', tabId: 'tab-2' },
    })).toThrow('conflicting structured and legacy create-tab refs');
  });

  test('rejects malformed structured provenance instead of silently downgrading to legacy value', () => {
    expect(() => parseMacOsBrowserCreateTabBrokerResult({
      value: `window-1${nativeSeparator}tab-2`,
      ref: { windowId: 'window-1', tabId: 'tab-2' },
      navigation: { provenanceVersion: 1, requestedUrl: 'https://chatgpt.com/', assignmentAccepted: false },
    })).toThrow('incomplete create-tab navigation provenance');
  });
});

describe('Browser Runtime V3 retry fencing', () => {
  test('replays only observation actions after dispatch and fences unknown mutation outcomes', () => {
    for (const actionId of ['wait_for_load_state', 'get_text', 'query_selector', 'verify_state', 'screenshot', 'wait_for_selector']) {
      expect(browserActionCanReplayAfterDispatch(actionId)).toBe(true);
    }
    for (const actionId of ['open_page', 'navigate', 'reload', 'go_back', 'click', 'fill', 'press', 'trusted_input', 'dispatch_event', 'attach_local_file', 'await_file_transfer']) {
      expect(browserActionCanReplayAfterDispatch(actionId)).toBe(false);
    }
    expect(browserActionCanReplayAfterDispatch('get_text', false)).toBe(false);
  });
});

describe('Browser Runtime V3 native replacement postconditions', () => {
  test('accepts same-origin canonical landing only for an HTTP(S) origin-root target', () => {
    expect(nativeReplacementUrlMatchesTarget('https://chatgpt.com/', 'https://chatgpt.com/?temporary-chat=true')).toBe(true);
    expect(nativeReplacementUrlMatchesTarget('https://chatgpt.com/', 'https://chatgpt.com/c/new-session')).toBe(true);
    expect(nativeReplacementUrlMatchesTarget('https://chatgpt.com/', 'https://example.com/')).toBe(false);
  });

  test('keeps concrete resource targets fail-closed against same-origin path drift', () => {
    expect(nativeReplacementUrlMatchesTarget('https://chatgpt.com/c/exact', 'https://chatgpt.com/c/exact')).toBe(true);
    expect(nativeReplacementUrlMatchesTarget('https://chatgpt.com/c/exact', 'https://chatgpt.com/')).toBe(false);
    expect(nativeReplacementUrlMatchesTarget('https://chatgpt.com/c/exact', 'https://chatgpt.com/c/other')).toBe(false);
    expect(nativeReplacementUrlMatchesTarget('https://example.com/?mode=exact', 'https://example.com/?mode=other')).toBe(false);
  });

  test('does not accept transitional native URLs merely because DOM readyState is complete', () => {
    expect(nativeDomLoadStateSatisfied('domcontentloaded', 'complete', 'about:blank', true)).toBe(false);
    expect(nativeDomLoadStateSatisfied('domcontentloaded', 'complete', 'chrome://newtab/', true)).toBe(false);
    expect(nativeDomLoadStateSatisfied('domcontentloaded', 'interactive', 'https://chatgpt.com/', true)).toBe(true);
    expect(nativeDomLoadStateSatisfied('load', 'interactive', 'https://chatgpt.com/', true)).toBe(false);
    expect(nativeDomLoadStateSatisfied('load', 'complete', 'https://chatgpt.com/', true)).toBe(true);
    expect(nativeDomLoadStateSatisfied('domcontentloaded', 'complete', 'about:blank', false)).toBe(true);
  });

  test('settles a newly created exact native tab before reading identity', async () => {
    const calls: string[] = [];
    let url = 'chrome://newtab/';
    const identity = await settleNativeCreatedPageIdentity({
      waitForLoadState: async (state, options) => {
        calls.push(`wait:${state}:${String(options?.timeout)}:${String(options?.requireHttpUrl)}`);
        url = 'https://chatgpt.com/';
      },
      identity: async () => {
        calls.push('identity');
        return { url, title: 'ChatGPT' };
      },
    }, 'domcontentloaded', 1_234);
    expect(calls).toEqual(['wait:domcontentloaded:1234:true', 'identity']);
    expect(identity.url).toBe('https://chatgpt.com/');
    expect(nativeReplacementUrlMatchesTarget('https://chatgpt.com/', identity.url)).toBe(true);
  });

  test('waits on the same replacement ref when it briefly preserves the previous URL', async () => {
    let identityReads = 0;
    const identity = await settleNativeCreatedPageIdentity({
      waitForLoadState: async () => undefined,
      identity: async () => {
        identityReads += 1;
        return identityReads === 1
          ? { url: 'https://example.com/previous', title: 'Previous' }
          : { url: 'https://www.tunemymusic.com/transfer/spotify-to-apple-music', title: 'Tune My Music' };
      },
    }, 'domcontentloaded', 25, {
      requestedUrl: 'https://www.tunemymusic.com/transfer/spotify-to-apple-music',
      previousUrl: 'https://example.com/previous',
    });
    expect(identityReads).toBe(2);
    expect(nativeReplacementUrlMatchesTarget('https://www.tunemymusic.com/transfer/spotify-to-apple-music', identity.url)).toBe(true);
  });

  test('still rejects a settled wrong HTTP target after native tab settlement', async () => {
    const identity = await settleNativeCreatedPageIdentity({
      waitForLoadState: async () => undefined,
      identity: async () => ({ url: 'https://example.com/wrong', title: 'Wrong' }),
    }, 'domcontentloaded', 1_000, {
      requestedUrl: 'https://example.com/exact',
      previousUrl: 'https://example.com/previous',
    });
    expect(nativeReplacementUrlMatchesTarget('https://example.com/exact', identity.url)).toBe(false);
  });

  test('classifies replacement mismatch without exposing URL contents', () => {
    expect(nativeReplacementMismatchDiagnostic({
      requestedUrl: 'https://chatgpt.com/',
      actualUrl: 'https://example.com/previous',
      previousUrl: 'https://example.com/previous',
      obsoleteRef: { windowId: 'window-old', tabId: 'tab-old' },
      replacementRef: { windowId: 'window-old', tabId: 'tab-new' },
    })).toEqual({
      sameTargetOrigin: false,
      samePreviousOrigin: true,
      samePreviousUrl: true,
      sameTabRef: false,
      actualScheme: 'https',
    });
    expect(nativeReplacementMismatchDiagnostic({
      requestedUrl: 'https://chatgpt.com/',
      actualUrl: 'chrome://newtab/',
      previousUrl: 'https://example.com/previous',
      obsoleteRef: { windowId: 'window-old', tabId: 'tab-old' },
      replacementRef: { windowId: 'window-old', tabId: 'tab-old' },
    })).toEqual({
      sameTargetOrigin: false,
      samePreviousOrigin: false,
      samePreviousUrl: false,
      sameTabRef: true,
      actualScheme: 'chrome',
    });
  });
});

describe('Browser Runtime V3 routing', () => {
  test('selects providers by required capabilities rather than failure-driven fallback order', async () => {
    const calls: string[] = [];
    const result = await executeBrowserRuntimeAction({
      runtimeKey: 'browser-v3:capability-routing',
      input: input('click', 'tx-capability'),
      providers: [
        provider({
          providerId: 'read-only',
          capabilities: ['dom.read', 'browser.transaction'],
          priority: 1,
          execute: async () => {
            calls.push('read-only');
            return { provider: 'read-only' };
          },
        }),
        provider({
          providerId: 'interactive',
          capabilities: ['dom.interact', 'browser.transaction'],
          priority: 20,
          execute: async () => {
            calls.push('interactive');
            return { provider: 'interactive' };
          },
        }),
      ],
    });

    expect(result).toEqual({ provider: 'interactive' });
    expect(calls).toEqual(['interactive']);
  });

  test('only a typed pre-action rejection may reselect a provider', async () => {
    const calls: string[] = [];
    const result = await executeBrowserRuntimeAction({
      runtimeKey: 'browser-v3:pre-action-reselect',
      input: input('click', 'tx-pre-action'),
      providers: [
        provider({
          providerId: 'preferred',
          capabilities: ['dom.interact', 'browser.transaction'],
          priority: 1,
          execute: async () => {
            calls.push('preferred');
            throw new BrowserProviderUnavailableBeforeActionError('preferred', 'not-started');
          },
        }),
        provider({
          providerId: 'alternate',
          capabilities: ['dom.interact', 'browser.transaction'],
          priority: 2,
          execute: async () => {
            calls.push('alternate');
            return { provider: 'alternate' };
          },
        }),
      ],
    });

    expect(result).toEqual({ provider: 'alternate' });
    expect(calls).toEqual(['preferred', 'alternate']);
  });

  test('does not replay an unknown non-idempotent outcome on another provider', async () => {
    const calls: string[] = [];
    let observed: unknown;
    try {
      await executeBrowserRuntimeAction({
        runtimeKey: 'browser-v3:no-blind-replay',
        input: input('click', 'tx-unknown-outcome'),
        providers: [
          provider({
            providerId: 'preferred',
            capabilities: ['dom.interact', 'browser.transaction'],
            priority: 1,
            execute: async () => {
              calls.push('preferred');
              throw new Error('unknown outcome after transport started');
            },
          }),
          provider({
            providerId: 'alternate',
            capabilities: ['dom.interact', 'browser.transaction'],
            priority: 2,
            execute: async () => {
              calls.push('alternate');
              return { provider: 'alternate' };
            },
          }),
        ],
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toBe('unknown outcome after transport started');
    expect(calls).toEqual(['preferred']);
  });

  test('reuses one stable native tab handle without metadata or foreground preflight on the warm path', async () => {
    const metadataUrl = 'https://example.com/native-warm';
    const driftUrl = 'https://example.com/native-warm/drifted';
    let metadataCalls = 0;
    let javaScriptCalls = 0;
    let activationCalls = 0;
    const metadata = () => [
      'false', metadataUrl, 'Native Warm', '0', '0', '1200', '800', '7', '9', 'false', 'false',
    ].join(nativeSeparator);

    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('execute targetTab javascript')) {
          javaScriptCalls += 1;
          return JSON.stringify({ ok: true, value: 'warm-value', page: { url: driftUrl, title: 'Drifted' } });
        }
        if (script.includes('set active tab index of targetWindow')) activationCalls += 1;
        metadataCalls += 1;
        return metadata();
      },
    });

    const first = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1_000);
    // A moved window keeps the same stable tab entity; warm lookup is keyed by product + tabId.
    const second = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '99', tabId: '9' }, 2_000);
    expect(second.page).toBe(first.page);
    expect(metadataCalls).toBe(1);

    expect(await second.page.evaluate<string>('document.body ? document.body.innerText : ""')).toBe('warm-value');
    expect(second.page.url()).toBe(driftUrl);
    expect(javaScriptCalls).toBe(1);
    expect(activationCalls).toBe(0);

    invalidateMacOsBrowserPageHandle('chrome', { windowId: '7', tabId: '9' });
    const third = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1_000);
    expect(third.page).not.toBe(first.page);
    expect(metadataCalls).toBe(2);
  });

  test('re-resolves a stable native tab immediately before activation after window topology drift', async () => {
    let currentWindowId = '7';
    const activationScripts: string[] = [];
    const metadata = () => [
      'true', 'https://chatgpt.com/c/native-stable', 'Native Stable', '0', '0', '1200', '800', currentWindowId, '9', 'true', 'false',
    ].join(nativeSeparator);

    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      tabInventory: async () => ({
        product: 'chrome',
        truncated: false,
        tabs: [{ windowId: currentWindowId, tabId: '9', active: true, url: 'https://chatgpt.com/c/native-stable', title: 'Native Stable' }],
      }),
      runAppleScript: async (script) => {
        if (script.includes('set active tab index of targetWindow')) {
          activationScripts.push(script);
          return '';
        }
        return metadata();
      },
    });

    const attached = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1_000);
    currentWindowId = '99';
    await attached.page.bringToFront();

    expect(activationScripts).toHaveLength(1);
    expect(activationScripts[0]).toContain('set targetTabId to "9"');
    expect(activationScripts[0]).not.toContain('first window whose id is');
    expect(attached.page.tabRef()).toEqual({ windowId: '99', tabId: '9' });
  });

  test('fails closed before activation when live native tab identity cannot be proven', async () => {
    let ambiguous = false;
    let activationCalls = 0;
    const metadata = () => [
      'true', 'https://chatgpt.com/c/native-ambiguous', 'Native Ambiguous', '0', '0', '1200', '800', '7', '9', 'true', 'false',
    ].join(nativeSeparator);

    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      tabInventory: async () => ({
        product: 'chrome',
        truncated: false,
        tabs: ambiguous
          ? [
            { windowId: '7', tabId: '9', active: true, url: 'https://chatgpt.com/c/native-ambiguous', title: 'Native Ambiguous' },
            { windowId: '99', tabId: '9', active: false, url: 'https://example.com/', title: 'Other' },
          ]
          : [{ windowId: '7', tabId: '9', active: true, url: 'https://chatgpt.com/c/native-ambiguous', title: 'Native Ambiguous' }],
      }),
      runAppleScript: async (script) => {
        if (script.includes('set active tab index of targetWindow')) activationCalls += 1;
        return metadata();
      },
    });

    const attached = await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1_000);
    ambiguous = true;
    await expect(attached.page.bringToFront()).rejects.toThrow('PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN');
    expect(activationCalls).toBe(0);
  });

  test('keeps warm providers valid until an explicit invalidation boundary', async () => {
    const runtimeKey = 'browser-v3:warm-generation';
    let revalidations = 0;
    let executions = 0;
    const warmProvider = provider({
      providerId: 'warm-read',
      capabilities: ['dom.read', 'browser.transaction', 'browser.persistent_handle'],
      priority: 1,
      revalidate: () => { revalidations += 1; },
      execute: async () => {
        executions += 1;
        return { executions };
      },
    });

    await executeBrowserRuntimeAction({ runtimeKey, input: input('get_text', 'tx-warm-1'), providers: [warmProvider] });
    await executeBrowserRuntimeAction({ runtimeKey, input: input('get_text', 'tx-warm-2'), providers: [warmProvider] });
    expect(revalidations).toBe(0);
    expect(executions).toBe(2);

    invalidateBrowserRuntime(runtimeKey, 'runtime_restart');
    await executeBrowserRuntimeAction({ runtimeKey, input: input('get_text', 'tx-warm-3'), providers: [warmProvider] });
    expect(revalidations).toBe(1);
    expect(executions).toBe(3);
  });
});
