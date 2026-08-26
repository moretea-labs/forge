import { afterEach, describe, expect, test } from 'bun:test';
import {
  executeBrowserRuntimeAction,
  invalidateBrowserRuntime,
} from '../../src/runtime/plugins/browser-runtime';
import {
  BrowserProviderUnavailableBeforeActionError,
  type BrowserRuntimeProvider,
} from '../../src/runtime/plugins/browser-provider-registry';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';
import {
  invalidateMacOsBrowserPageHandle,
  invalidateMacOsBrowserPageHandles,
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
