import { COMPUTER_BROWSER_AUTOMATION_CAPABILITY, type ComputerBrowserAutomationRequest, type ComputerCapabilityId } from '../../protocols/computer/index';
import { computerProviderSupports, type ComputerProvider } from './provider';

export class ComputerProviderRegistry {
  private readonly providers = new Map<string, ComputerProvider>();

  register(provider: ComputerProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  resolve(capability: ComputerCapabilityId): ComputerProvider {
    const provider = [...this.providers.values()].find((candidate) => computerProviderSupports(candidate, capability));
    if (!provider) throw new Error(`COMPUTER_PROVIDER_UNAVAILABLE:${capability}`);
    return provider;
  }

  async executeBrowserAutomation(
    request: ComputerBrowserAutomationRequest,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return await this.resolve(COMPUTER_BROWSER_AUTOMATION_CAPABILITY).executeBrowserAutomation(request, timeoutMs);
  }

  snapshot(): Array<{ providerId: string; capabilities: ComputerCapabilityId[] }> {
    return [...this.providers.values()].map((provider) => ({
      providerId: provider.providerId,
      capabilities: [...provider.capabilities],
    }));
  }
}
