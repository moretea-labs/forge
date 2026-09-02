import { describe, expect, test } from 'bun:test';
import { COMPUTER_BROWSER_AUTOMATION_CAPABILITY } from '../../packages/protocols/computer/index';
import {
  ComputerProviderError,
  ComputerProviderRegistry,
  type ComputerProvider,
} from '../../packages/plugin-runtime/computer/index';

function provider(providerId: string): ComputerProvider {
  return {
    providerId,
    capabilities: [COMPUTER_BROWSER_AUTOMATION_CAPABILITY],
    executeBrowserAutomation: async () => ({ providerId }),
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

  test('keeps provider snapshots deterministic without making insertion order authority', () => {
    const registry = new ComputerProviderRegistry();
    registry.register(provider('native-b'));
    registry.register(provider('native-a'));
    expect(registry.snapshot().map((entry) => entry.providerId)).toEqual(['native-a', 'native-b']);
  });
});
