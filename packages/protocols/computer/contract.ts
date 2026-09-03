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

/** Every public Computer capability is dispatched through the same typed provider registry. */
export type ComputerRuntimeProviderCapabilityId = ComputerCapabilityId;

/** Runtime advertisement used to negotiate one provider-neutral Computer capability. */
export interface ComputerCapabilityAdvertisement {
  capabilityId: string;
  protocolVersion: number;
  method: string;
  actions: string[];
}

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

export interface ComputerSemanticSelector {
  ref?: string;
  role?: string;
  title?: string;
  identifier?: string;
}

export interface ComputerObserveRequest {
  capability: typeof COMPUTER_OBSERVE_CAPABILITY;
  action: 'observe';
  interactionId: string;
  maxDepth?: number;
  maxNodes?: number;
  includeValues?: boolean;
  includeActions?: boolean;
  includeWindows?: boolean;
  rootSelector?: ComputerSemanticSelector;
}

export type ComputerInputRequest =
  | { capability: typeof COMPUTER_INPUT_CAPABILITY; action: 'press'; interactionId: string; selector: ComputerSemanticSelector; semanticAction?: 'press' | 'show_menu' | 'pick' | 'open' | 'confirm' | 'scroll_down_page' | 'scroll_up_page' }
  | { capability: typeof COMPUTER_INPUT_CAPABILITY; action: 'type_text'; interactionId: string; selector: ComputerSemanticSelector; text: string; replace?: boolean }
  | { capability: typeof COMPUTER_INPUT_CAPABILITY; action: 'key'; interactionId: string; keys: string[] }
  | { capability: typeof COMPUTER_INPUT_CAPABILITY; action: 'open_url'; url: string };

export interface ComputerCaptureRequest {
  capability: typeof COMPUTER_CAPTURE_CAPABILITY;
  action: 'screenshot';
  scope?: 'display' | 'window';
  interactionId?: string;
  windowId?: number;
  label?: string;
}

export type ComputerExecutionRequest =
  | { capability: typeof COMPUTER_BROWSER_AUTOMATION_CAPABILITY; request: ComputerBrowserAutomationRequest }
  | ComputerObserveRequest
  | ComputerInputRequest
  | ComputerCaptureRequest;
