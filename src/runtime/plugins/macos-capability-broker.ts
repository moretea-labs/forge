/** @deprecated C0 compatibility shim. Browser code must consume the provider-neutral Computer boundary. */
import type { ComputerBrowserAutomationRequest } from '../../../packages/protocols/computer/index';
import {
  callDesktopOperatorComputerBrowserAutomation,
  desktopOperatorComputerSocketPath,
  resetDesktopOperatorComputerSocketPathForTest,
  setDesktopOperatorComputerSocketPathForTest,
  validateDesktopOperatorComputerHandshake,
} from '../../../adapters/computer/desktop-operator-provider';

export const macOsCapabilityBrokerSocketPath = desktopOperatorComputerSocketPath;
export const resetMacOsCapabilityBrokerSocketPathForTest = resetDesktopOperatorComputerSocketPathForTest;
export const setMacOsCapabilityBrokerSocketPathForTest = setDesktopOperatorComputerSocketPathForTest;
export const validateMacOsCapabilityBrokerHandshake = validateDesktopOperatorComputerHandshake;

export async function callMacOsCapabilityBroker(
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await callDesktopOperatorComputerBrowserAutomation(params as unknown as ComputerBrowserAutomationRequest, timeoutMs);
}
