import { describe, expect, test } from 'bun:test';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
  type ComputerExecutionRequest,
  type ComputerRuntimeProviderCapabilityId,
} from '../../packages/protocols/computer/index';
import {
  ComputerProviderError,
  ComputerProviderRegistry,
  type ComputerProvider,
} from '../../packages/plugin-runtime/computer/index';

function provider(
  providerId: string,
  capabilities: ComputerRuntimeProviderCapabilityId[] = [COMPUTER_BROWSER_AUTOMATION_CAPABILITY],
  seen: ComputerExecutionRequest[] = [],
): ComputerProvider {
  return {
    providerId,
    capabilities,
    execute: async (request) => {
      seen.push(request);
      return { providerId, capability: request.capability };
    },
  };
}

describe('ComputerProviderRegistry authority', () => {
  test('rejects duplicate provider identity instead of silently replacing authority', () => {
    const registry = new ComputerProviderRegistry();
    registry.register(provider('native-a'));
    expect(() => registry.register(provider('native-a'))).toThrow(ComputerProviderError);
    try {
      registry.register(provider('native-a'));
    } catch (error) {
      expect(error).toMatchObject({ code: 'COMPUTER_PROVIDER_DUPLICATE_ID', retryable: false });
    }
  });

  test('fails with a typed unavailable error when no provider owns the capability', () => {
    const registry = new ComputerProviderRegistry();
    expect(() => registry.resolve(COMPUTER_BROWSER_AUTOMATION_CAPABILITY)).toThrow(ComputerProviderError);
    try {
      registry.resolve(COMPUTER_BROWSER_AUTOMATION_CAPABILITY);
    } catch (error) {
      expect(error).toMatchObject({ code: 'COMPUTER_PROVIDER_UNAVAILABLE', retryable: true });
    }
  });

  test('fails closed when capability ownership is ambiguous', () => {
    const registry = new ComputerProviderRegistry();
    registry.register(provider('native-b'));
    registry.register(provider('native-a'));
    try {
      registry.resolve(COMPUTER_BROWSER_AUTOMATION_CAPABILITY);
      throw new Error('expected ambiguous provider resolution to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'COMPUTER_PROVIDER_AMBIGUOUS',
        retryable: false,
        details: { providerIds: ['native-a', 'native-b'] },
      });
    }
  });

  test('dispatches every typed Computer capability through its declared provider and preserves the browser facade', async () => {
    const registry = new ComputerProviderRegistry();
    const seen: ComputerExecutionRequest[] = [];
    registry.register(provider('native-all', [
      COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
      COMPUTER_OBSERVE_CAPABILITY,
      COMPUTER_INPUT_CAPABILITY,
      COMPUTER_CAPTURE_CAPABILITY,
    ], seen));

    await registry.execute({ capability: COMPUTER_OBSERVE_CAPABILITY, action: 'observe', interactionId: 'interaction-1' }, 1_000);
    await registry.execute({ capability: COMPUTER_INPUT_CAPABILITY, action: 'key', interactionId: 'interaction-1', keys: ['ENTER'] }, 1_000);
    await registry.execute({ capability: COMPUTER_CAPTURE_CAPABILITY, action: 'screenshot', scope: 'window', windowId: 7 }, 1_000);
    await registry.executeBrowserAutomation({ action: 'list_tabs', product: 'chrome' }, 1_000);

    expect(seen.map((request) => request.capability)).toEqual([
      COMPUTER_OBSERVE_CAPABILITY,
      COMPUTER_INPUT_CAPABILITY,
      COMPUTER_CAPTURE_CAPABILITY,
      COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
    ]);
    expect(seen.at(-1)).toEqual({ capability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY, request: { action: 'list_tabs', product: 'chrome' } });
  });

  test('does not dispatch an undeclared partial capability to an otherwise healthy provider', async () => {
    const registry = new ComputerProviderRegistry();
    registry.register(provider('browser-only'));
    await expect(registry.execute({ capability: COMPUTER_OBSERVE_CAPABILITY, action: 'observe', interactionId: 'interaction-1' }, 1_000))
      .rejects.toMatchObject({ code: 'COMPUTER_PROVIDER_UNAVAILABLE' });
  });

  test('keeps provider snapshots deterministic without making insertion order authority', () => {
    const registry = new ComputerProviderRegistry();
    registry.register(provider('native-b'));
    registry.register(provider('native-a'));
    expect(registry.snapshot().map((entry) => entry.providerId)).toEqual(['native-a', 'native-b']);
  });
});
