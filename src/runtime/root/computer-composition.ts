import { ComputerProviderRegistry } from '../../../packages/plugin-runtime/computer/index';
import type { ComputerBrowserAutomationRequest, ComputerBrowserProduct } from '../../../packages/protocols/computer/index';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import type { AssistantPluginActionExecutionInput } from '../plugins/types';
import {
  activateDesktopOperatorBrowserApplication,
  createDesktopOperatorComputerProvider,
} from '../../../adapters/computer/index';

const computerProviders = new ComputerProviderRegistry();
let composed = false;

function ensureComputerComposition(): void {
  if (composed) return;
  computerProviders.register(createDesktopOperatorComputerProvider({ resolveControllerHome }));
  composed = true;
}

export async function executeRuntimeComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  ensureComputerComposition();
  return await computerProviders.executeBrowserAutomation(request, timeoutMs);
}

export async function activateRuntimeComputerBrowserApplication(
  input: AssistantPluginActionExecutionInput,
  product: ComputerBrowserProduct,
): Promise<void> {
  await activateDesktopOperatorBrowserApplication(input, product);
}

export function runtimeComputerProviderSnapshot(): Array<{ providerId: string; capabilities: string[] }> {
  ensureComputerComposition();
  return computerProviders.snapshot();
}
