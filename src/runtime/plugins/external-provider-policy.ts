import {
  desktopOperatorAllowsMissingProviderAction,
  executeDesktopOperatorPolicyAction,
  resolveDesktopOperatorAuthorizationContext,
} from './desktop-operator-external-policy';
import type { ExternalPluginRegistration } from './external-registration';
import type { DesktopApplicationIdentity, VerifiedDesktopApplicationActivation } from './local-system-adapter';
import type { AssistantPluginActionExecutionInput, AssistantPluginAuthorizationContext } from './types';

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

export interface ExternalProviderPolicyExecutionResult {
  handled: boolean;
  result?: Record<string, unknown>;
}

export interface ExternalProviderPolicy {
  allowsMissingProviderAction?(actionId: string): boolean;
  resolveAuthorizationContext?(
    registration: ExternalPluginRegistration,
    input: AssistantPluginActionExecutionInput,
    context: ExternalProviderPolicyContext,
  ): Promise<AssistantPluginAuthorizationContext | undefined>;
  executeAction?(
    input: AssistantPluginActionExecutionInput,
    context: ExternalProviderPolicyContext,
  ): Promise<ExternalProviderPolicyExecutionResult>;
}

const DESKTOP_OPERATOR_EXTERNAL_POLICY: ExternalProviderPolicy = {
  allowsMissingProviderAction: desktopOperatorAllowsMissingProviderAction,
  resolveAuthorizationContext: resolveDesktopOperatorAuthorizationContext,
  executeAction: executeDesktopOperatorPolicyAction,
};

export function resolveExternalProviderPolicy(registration: ExternalPluginRegistration): ExternalProviderPolicy | undefined {
  return registration.pluginId === 'desktop_operator' ? DESKTOP_OPERATOR_EXTERNAL_POLICY : undefined;
}
