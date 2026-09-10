import {
  ComputerProviderError,
  ComputerProviderRegistry,
  computerProviderRegistrationSnapshot,
} from '../../../packages/plugin-runtime/computer/index';
import { COMPUTER_BROWSER_AUTOMATION_CAPABILITY, type ComputerBrowserAutomationRequest, type ComputerBrowserProduct, type ComputerRuntimeExecutionRequest } from '../../../packages/protocols/computer/index';
import { DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } from '../../../adapters/computer/desktop-operator-contract';
import { createDesktopOperatorComputerProvider, type DesktopOperatorComputerProvider } from '../../../adapters/computer/index';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { currentComputerPlatform } from '../platform/computer-platform';
import { getExternalPluginAdapter } from '../plugins/external-adapter';
import { getExternalPluginRegistration } from '../plugins/external-registration';
import { AssistantPluginError } from '../plugins/errors';
import type { AssistantPluginActionExecutionInput } from '../plugins/types';

let computerProviders: ComputerProviderRegistry | undefined;
let computerProviderCompositionKey: string | undefined;
let desktopOperatorProvider: DesktopOperatorComputerProvider | undefined;
const NATIVE_BROWSER_BUNDLE_IDS: Record<ComputerBrowserProduct, string> = {
  chrome: 'com.google.Chrome',
  vivaldi: 'com.vivaldi.Vivaldi',
};
function currentDesktopOperatorRegistration(controllerHome: string) {
  return getExternalPluginRegistration(controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
}

function computerCompositionKey(controllerHome: string): string {
  const registration = currentDesktopOperatorRegistration(controllerHome);
  const fingerprint = registration
    ? `${registration.revision}:${registration.registrationFingerprint}:${registration.enabled ? 'enabled' : 'disabled'}`
    : 'desktop_operator:unregistered_v0_2';
  return `${controllerHome}:${currentComputerPlatform()}:${fingerprint}`;
}

function ensureComputerComposition(controllerHome: string = resolveControllerHome()): ComputerProviderRegistry {
  const compositionKey = computerCompositionKey(controllerHome);
  if (computerProviders && computerProviderCompositionKey === compositionKey) return computerProviders;

  computerProviders?.dispose();
  const next = new ComputerProviderRegistry();
  if (currentComputerPlatform() === 'darwin') {
    const registration = currentDesktopOperatorRegistration(controllerHome);
    desktopOperatorProvider = createDesktopOperatorComputerProvider({
      lookupRegistration: (providerPluginId) => {
        if (providerPluginId !== DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID || !registration) return undefined;
        return computerProviderRegistrationSnapshot(registration);
      },
      // Compatibility is an explicit Runtime composition decision, never an adapter fallback.
      // Remove this switch once Desktop Operator 0.2.x support is retired.
      legacyFallback: 'unregistered_v0_2',
    });
    next.register(desktopOperatorProvider);
  }
  computerProviders = next;
  computerProviderCompositionKey = compositionKey;
  return next;
}

export async function executeRuntimeComputer(
  request: ComputerRuntimeExecutionRequest,
  timeoutMs: number,
  controllerHome: string = resolveControllerHome(),
): Promise<Record<string, unknown>> {
  const providers = ensureComputerComposition(controllerHome);
  try {
    return await providers.execute(request, timeoutMs);
  } catch (error) {
    if (error instanceof ComputerProviderError) {
      throw new AssistantPluginError(error.code, error.detailMessage, {
        retryable: error.retryable,
        effectOutcome: error.effectOutcome,
        details: error.details,
      });
    }
    throw error;
  }
}

export async function executeRuntimeComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
  controllerHome: string = resolveControllerHome(),
): Promise<Record<string, unknown>> {
  ensureComputerComposition(controllerHome);
  if (!desktopOperatorProvider) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_COMPATIBILITY_PROVIDER_UNAVAILABLE',
      'Native Browser compatibility requires the macOS Desktop Operator provider.',
      { retryable: true, details: { providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } },
    );
  }
  return await desktopOperatorProvider.executeBrowserCompatibility(request, timeoutMs);
}

export async function activateRuntimeComputerBrowserApplication(
  input: AssistantPluginActionExecutionInput,
  product: ComputerBrowserProduct,
): Promise<void> {
  const platform = currentComputerPlatform();
  if (platform !== 'darwin') {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNSUPPORTED_PLATFORM',
      `Native browser foreground activation is unavailable on ${platform} until a platform Computer provider is registered.`,
      { retryable: false, details: { browserProduct: product, platform } },
    );
  }
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

export function runtimeComputerProviderSnapshot(controllerHome: string = resolveControllerHome()): Array<{ providerId: string; capabilities: string[] }> {
  return ensureComputerComposition(controllerHome).snapshot();
}

export function disposeRuntimeComputerComposition(): void {
  computerProviders?.dispose();
  computerProviders = undefined;
  computerProviderCompositionKey = undefined;
  desktopOperatorProvider = undefined;
}
