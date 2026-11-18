import {
  desktopOperatorAllowsMissingProviderAction,
  executeDesktopOperatorPolicyAction,
  resolveDesktopOperatorAuthorizationContext,
} from './desktop-operator-external-policy';
import { resolveAgentMailAuthorizationContext } from './agentmail-external-policy';
import type { ExternalPluginRegistration } from './external-registration';
import type { ExternalProviderPolicyContext } from './external-provider-policy-context';
export type { ExternalProviderPolicyContext } from './external-provider-policy-context';
import type { AssistantPluginActionExecutionInput, AssistantPluginAuthorizationContext } from './types';

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
const AGENTMAIL_EXTERNAL_POLICY: ExternalProviderPolicy = { resolveAuthorizationContext: resolveAgentMailAuthorizationContext };

export function resolveExternalProviderPolicy(registration: ExternalPluginRegistration): ExternalProviderPolicy | undefined {
  if (registration.pluginId === 'desktop_operator') return DESKTOP_OPERATOR_EXTERNAL_POLICY;
  if (registration.pluginId === 'agentmail') return AGENTMAIL_EXTERNAL_POLICY;
  return undefined;
}
