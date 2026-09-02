import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  type ComputerBrowserAutomationRequest,
  type ComputerRuntimeProviderCapabilityId,
} from '../../protocols/computer/index';
import { ComputerProviderError } from './provider-error';
import { computerProviderSupports, type ComputerProvider } from './provider';

export class ComputerProviderRegistry {
  private readonly providers = new Map<string, ComputerProvider>();

  register(provider: ComputerProvider): void {
    if (this.providers.has(provider.providerId)) {
      throw new ComputerProviderError(
        'COMPUTER_PROVIDER_DUPLICATE_ID',
        `Computer provider ${provider.providerId} is already registered.`,
        { retryable: false, details: { providerId: provider.providerId } },
      );
    }
    this.providers.set(provider.providerId, provider);
  }

  resolve(capability: ComputerRuntimeProviderCapabilityId): ComputerProvider {
    const matches = [...this.providers.values()]
      .filter((candidate) => computerProviderSupports(candidate, capability));
    if (matches.length === 0) {
      throw new ComputerProviderError(
        'COMPUTER_PROVIDER_UNAVAILABLE',
        `No Computer provider is registered for ${capability}.`,
        { retryable: true, details: { capability } },
      );
    }
    if (matches.length > 1) {
      throw new ComputerProviderError(
        'COMPUTER_PROVIDER_AMBIGUOUS',
        `Multiple Computer providers are registered for ${capability} without an explicit selection policy.`,
        {
          retryable: false,
          details: { capability, providerIds: matches.map((provider) => provider.providerId).sort() },
        },
      );
    }
    return matches[0]!;
  }

  async executeBrowserAutomation(
    request: ComputerBrowserAutomationRequest,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return await this.resolve(COMPUTER_BROWSER_AUTOMATION_CAPABILITY).executeBrowserAutomation(request, timeoutMs);
  }

  snapshot(): Array<{ providerId: string; capabilities: ComputerRuntimeProviderCapabilityId[] }> {
    return [...this.providers.values()]
      .map((provider) => ({ providerId: provider.providerId, capabilities: [...provider.capabilities] }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }
}
