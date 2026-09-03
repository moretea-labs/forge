import {
  ComputerProviderError,
  ComputerProviderRegistry,
  computerProviderRegistrationSnapshot,
} from '../../../packages/plugin-runtime/computer/index';
import { COMPUTER_BROWSER_AUTOMATION_CAPABILITY, type ComputerBrowserAutomationRequest, type ComputerBrowserProduct, type ComputerExecutionRequest } from '../../../packages/protocols/computer/index';
import { DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } from '../../../adapters/computer/desktop-operator-contract';
import { createDesktopOperatorComputerProvider } from '../../../adapters/computer/index';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { getExternalPluginAdapter } from '../plugins/external-adapter';
import { getExternalPluginRegistration } from '../plugins/external-registration';
import { AssistantPluginError } from '../plugins/errors';
import type { AssistantPluginActionExecutionInput } from '../plugins/types';

let computerProviders: ComputerProviderRegistry | undefined;
let computerProviderCompositionFingerprint: string | undefined;
const NATIVE_BROWSER_BUNDLE_IDS: Record<ComputerBrowserProduct, string> = {
  chrome: 'com.google.Chrome',
  vivaldi: 'com.vivaldi.Vivaldi',
};
function currentDesktopOperatorRegistration() {
  return getExternalPluginRegistration(resolveControllerHome(), DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
}

function computerCompositionFingerprint(): string {
  const registration = currentDesktopOperatorRegistration();
  return registration
    ? `${registration.revision}:${registration.registrationFingerprint}:${registration.enabled ? 'enabled' : 'disabled'}`
    : 'desktop_operator:unregistered_v0_2';
}

function ensureComputerComposition(): ComputerProviderRegistry {
  const fingerprint = computerCompositionFingerprint();
  if (computerProviders && computerProviderCompositionFingerprint === fingerprint) return computerProviders;

  const registration = currentDesktopOperatorRegistration();
  const next = new ComputerProviderRegistry();
  next.register(createDesktopOperatorComputerProvider({
    lookupRegistration: (providerPluginId) => {
      if (providerPluginId !== DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID || !registration) return undefined;
      return computerProviderRegistrationSnapshot(registration);
    },
    // Compatibility is an explicit Runtime composition decision, never an adapter fallback.
    // Remove this switch once Desktop Operator 0.2.x support is retired.
    legacyFallback: 'unregistered_v0_2',
  }));
  computerProviders = next;
  computerProviderCompositionFingerprint = fingerprint;
  return next;
}

export async function executeRuntimeComputer(
  request: ComputerExecutionRequest,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const providers = ensureComputerComposition();
  try {
    return await providers.execute(request, timeoutMs);
  } catch (error) {
    if (error instanceof ComputerProviderError) {
      throw new AssistantPluginError(error.code, error.detailMessage, {
        retryable: error.retryable,
        details: error.details,
      });
    }
    throw error;
  }
}

export async function executeRuntimeComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await executeRuntimeComputer({ capability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY, request }, timeoutMs);
}

export async function activateRuntimeComputerBrowserApplication(
  input: AssistantPluginActionExecutionInput,
  product: ComputerBrowserProduct,
): Promise<void> {
  const desktopOperator = getExternalPluginAdapter(input.controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
  if (!desktopOperator) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNAVAILABLE',
      'Native browser foreground activation requires an available Computer application provider.',
      { retryable: true, details: { browserProduct: product, providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } },
    );
  }
  await desktopOperator.executeAction({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    pluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
    actionId: 'desktop_session_open',
    requestId: `${input.requestId}:native-browser-foreground:${product}`,
    args: { bundle_id: NATIVE_BROWSER_BUNDLE_IDS[product], launch: false, activate: true },
    origin: input.origin,
    jobId: input.jobId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
  });
}

export function runtimeComputerProviderSnapshot(): Array<{ providerId: string; capabilities: string[] }> {
  return ensureComputerComposition().snapshot();
}
