import type {
  ComputerBrowserAutomationRequest,
  ComputerCapabilityId,
} from '../../protocols/computer/index';

/** Concrete OS/browser implementations live in adapters. Plugin Runtime owns dispatch only. */
export interface ComputerProvider {
  providerId: string;
  capabilities: readonly ComputerCapabilityId[];
  executeBrowserAutomation(
    request: ComputerBrowserAutomationRequest,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
}

export function computerProviderSupports(provider: ComputerProvider, capability: ComputerCapabilityId): boolean {
  return provider.capabilities.includes(capability);
}
