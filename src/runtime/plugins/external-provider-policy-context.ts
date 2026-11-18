import type { DesktopApplicationIdentity, VerifiedDesktopApplicationActivation } from './local-system-adapter';

export interface ExternalProviderPolicyContext {
  callProvider(
    requestId: string,
    actionId: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  verifyProviderIdentity(requestId: string, signal?: AbortSignal): Promise<void>;
  activateAndVerifyFrontmostApplication(identity: DesktopApplicationIdentity): Promise<VerifiedDesktopApplicationActivation>;
}
