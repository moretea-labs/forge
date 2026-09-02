import { ComputerProviderRegistry } from '../../../packages/plugin-runtime/computer/index';
import type { ComputerBrowserAutomationRequest } from '../../../packages/protocols/computer/index';
import { createDesktopOperatorComputerProvider } from '../../../adapters/computer/index';

const computerProviders = new ComputerProviderRegistry();
let composed = false;

function ensureComputerComposition(): void {
  if (composed) return;
  computerProviders.register(createDesktopOperatorComputerProvider());
  composed = true;
}

export async function executeRuntimeComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  ensureComputerComposition();
  return await computerProviders.executeBrowserAutomation(request, timeoutMs);
}

export function runtimeComputerProviderSnapshot(): Array<{ providerId: string; capabilities: string[] }> {
  ensureComputerComposition();
  return computerProviders.snapshot();
}
