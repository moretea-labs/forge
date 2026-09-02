import {
  ComputerProviderError,
  ComputerProviderRegistry,
  computerProviderRegistrationSnapshot,
} from '../../../packages/plugin-runtime/computer/index';
import type { ComputerBrowserAutomationRequest, ComputerBrowserProduct } from '../../../packages/protocols/computer/index';
import { DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } from '../../../adapters/computer/desktop-operator-contract';
import { createDesktopOperatorComputerProvider } from '../../../adapters/computer/index';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { getExternalPluginAdapter } from '../plugins/external-adapter';
import { getExternalPluginRegistration } from '../plugins/external-registration';
import { AssistantPluginError } from '../plugins/errors';
import type { AssistantPluginActionExecutionInput } from '../plugins/types';

const computerProviders = new ComputerProviderRegistry();
const NATIVE_BROWSER_BUNDLE_IDS: Record<ComputerBrowserProduct, string> = {
  chrome: 'com.google.Chrome',
  vivaldi: 'com.vivaldi.Vivaldi',
};
let composed = false;

function ensureComputerComposition(): void {
  if (composed) return;
  computerProviders.register(createDesktopOperatorComputerProvider({
    lookupRegistration: (providerPluginId) => {
      const registration = getExternalPluginRegistration(resolveControllerHome(), providerPluginId);
      return registration ? computerProviderRegistrationSnapshot(registration) : undefined;
    },
  }));
  composed = true;
}

export async function executeRuntimeComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  ensureComputerComposition();
  try {
    return await computerProviders.executeBrowserAutomation(request, timeoutMs);
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
  ensureComputerComposition();
  return computerProviders.snapshot();
}
