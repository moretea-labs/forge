import type {
  ComputerBrowserAutomationRequest,
  ComputerBrowserProduct,
  ComputerBrowserTabRef,
  ComputerCaptureRegion,
  ComputerTrustedInput,
} from '../../../packages/protocols/computer/index';
import { executeRuntimeComputerBrowserAutomation } from '../root/computer-composition';
import { AssistantPluginError } from './errors';

export type BrowserAutomationProduct = ComputerBrowserProduct;
export type BrowserAutomationTabRef = ComputerBrowserTabRef;
export type BrowserAutomationRegion = ComputerCaptureRegion;
export type BrowserAutomationTrustedInput = ComputerTrustedInput;
export type BrowserAutomationBrokerAction = ComputerBrowserAutomationRequest;

export async function callBrowserAutomationBroker(
  request: BrowserAutomationBrokerAction,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await executeRuntimeComputerBrowserAutomation(request, timeoutMs);
}

export async function captureBrowserAutomationRegion(region: BrowserAutomationRegion, timeoutMs: number): Promise<Buffer> {
  const result = await callBrowserAutomationBroker({ action: 'capture_region', region }, timeoutMs);
  const base64 = typeof result.base64 === 'string' ? result.base64 : '';
  if (!base64) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
      'Computer capture provider returned an invalid screenshot payload.',
      { retryable: true },
    );
  }
  return Buffer.from(base64, 'base64');
}
