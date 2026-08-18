import { callMacOsCapabilityBroker } from './macos-capability-broker';
import { AssistantPluginError } from './errors';

const BROWSER_AUTOMATION_PROTOCOL_VERSION = 1;

export type BrowserAutomationProduct = 'chrome' | 'vivaldi';
export interface BrowserAutomationTabRef {
  windowId: string;
  tabId: string;
}
export interface BrowserAutomationRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserAutomationBrokerAction =
  | { action: 'metadata'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef }
  | { action: 'list_tabs'; product: BrowserAutomationProduct }
  | { action: 'create_tab'; product: BrowserAutomationProduct; url: string }
  | { action: 'close_tab'; product: BrowserAutomationProduct; ref: BrowserAutomationTabRef }
  | { action: 'navigate'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef; url: string }
  | { action: 'reload'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef }
  | { action: 'execute_javascript'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef; source: string }
  | { action: 'activate'; product: BrowserAutomationProduct; ref?: BrowserAutomationTabRef }
  | { action: 'capture_region'; region: BrowserAutomationRegion };

export async function callBrowserAutomationBroker(
  request: BrowserAutomationBrokerAction,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await callMacOsCapabilityBroker({ ...request, timeoutMs, protocolVersion: BROWSER_AUTOMATION_PROTOCOL_VERSION }, timeoutMs);
}

export async function captureBrowserAutomationRegion(region: BrowserAutomationRegion, timeoutMs: number): Promise<Buffer> {
  const result = await callBrowserAutomationBroker({ action: 'capture_region', region }, timeoutMs);
  const base64 = typeof result.base64 === 'string' ? result.base64 : '';
  if (!base64) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_PROTOCOL_ERROR',
      'Stable Forge macOS capability broker returned an invalid screenshot payload.',
      { retryable: true },
    );
  }
  return Buffer.from(base64, 'base64');
}
