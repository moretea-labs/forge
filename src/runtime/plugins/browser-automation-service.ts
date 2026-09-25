import type {
  ComputerBrowserAutomationRequest,
  ComputerBrowserProduct,
  ComputerBrowserTabRef,
  ComputerCaptureRegion,
  ComputerTrustedInput,
} from '../../../packages/protocols/computer/index';
import { executeRuntimeComputerBrowserAutomation, executeRuntimeComputerBrowserTrustedInput } from '../root/computer-composition';
import { AssistantPluginError } from './errors';

export type BrowserAutomationProduct = ComputerBrowserProduct;
export type BrowserAutomationTabRef = ComputerBrowserTabRef;
export type BrowserAutomationRegion = ComputerCaptureRegion;
export type BrowserAutomationTrustedInput = ComputerTrustedInput;
export interface BrowserAutomationSemanticTargetProof {
  domRole: string;
  accessibleName: string;
  editable: true;
  focused: true;
  multiline: boolean;
}
export type BrowserAutomationTrustedInputRequest = Extract<ComputerBrowserAutomationRequest, { action: 'trusted_input' }> & {
  /** Ephemeral Browser-owned proof; never persisted or forwarded to compatibility providers. */
  semanticTarget?: BrowserAutomationSemanticTargetProof;
};
export type BrowserAutomationBrokerAction =
  | Exclude<ComputerBrowserAutomationRequest, { action: 'trusted_input' }>
  | BrowserAutomationTrustedInputRequest;

export async function callBrowserAutomationBroker(
  request: BrowserAutomationBrokerAction,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (request.action === 'trusted_input'
      && (request.input.kind === 'key' || (request.input.kind === 'text' && request.semanticTarget))) {
    return await executeRuntimeComputerBrowserTrustedInput(request, timeoutMs);
  }
  // Generic trusted text remains on the explicit Browser compatibility contract.
  // Only Browser-owned semantic proof authorizes the Unified Computer text path.
  const { semanticTarget: _semanticTarget, ...compatibilityRequest } = request as BrowserAutomationTrustedInputRequest;
  return await executeRuntimeComputerBrowserAutomation(compatibilityRequest as ComputerBrowserAutomationRequest, timeoutMs);
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
