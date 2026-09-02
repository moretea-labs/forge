export const COMPUTER_CAPABILITY_PROTOCOL_VERSION = 1 as const;
export const COMPUTER_CAPABILITY_EXECUTION_METHOD = 'computer_execute' as const;

export const COMPUTER_BROWSER_AUTOMATION_CAPABILITY = 'computer.browser_automation.v1' as const;
export const COMPUTER_OBSERVE_CAPABILITY = 'computer.observe.v1' as const;
export const COMPUTER_INPUT_CAPABILITY = 'computer.input.v1' as const;
export const COMPUTER_CAPTURE_CAPABILITY = 'computer.capture.v1' as const;

export type ComputerCapabilityId =
  | typeof COMPUTER_BROWSER_AUTOMATION_CAPABILITY
  | typeof COMPUTER_OBSERVE_CAPABILITY
  | typeof COMPUTER_INPUT_CAPABILITY
  | typeof COMPUTER_CAPTURE_CAPABILITY;

export type ComputerBrowserProduct = 'chrome' | 'vivaldi';

export interface ComputerBrowserTabRef {
  windowId: string;
  tabId: string;
}

export interface ComputerCaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ComputerTrustedInput =
  | { kind: 'click'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount: number }
  | { kind: 'move'; x: number; y: number; steps: number }
  | { kind: 'wheel'; deltaX: number; deltaY: number }
  | { kind: 'drag'; fromX: number; fromY: number; toX: number; toY: number; button: 'left' | 'middle' | 'right'; steps: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string };

/** Provider-neutral browser automation request carried over the Computer boundary. */
export type ComputerBrowserAutomationRequest =
  | { action: 'metadata'; product: ComputerBrowserProduct; ref?: ComputerBrowserTabRef }
  | { action: 'list_tabs'; product: ComputerBrowserProduct }
  | { action: 'create_tab'; product: ComputerBrowserProduct; url: string }
  | { action: 'close_tab'; product: ComputerBrowserProduct; ref: ComputerBrowserTabRef }
  | { action: 'navigate'; product: ComputerBrowserProduct; ref?: ComputerBrowserTabRef; url: string }
  | { action: 'reload'; product: ComputerBrowserProduct; ref?: ComputerBrowserTabRef }
  | { action: 'execute_javascript'; product: ComputerBrowserProduct; ref?: ComputerBrowserTabRef; source: string }
  | { action: 'activate'; product: ComputerBrowserProduct; ref?: ComputerBrowserTabRef }
  | { action: 'trusted_input'; product: ComputerBrowserProduct; ref: ComputerBrowserTabRef; input: ComputerTrustedInput }
  | { action: 'capture_region'; region: ComputerCaptureRegion };
