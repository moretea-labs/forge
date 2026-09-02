export type BrowserMode = 'attach_preferred' | 'managed_persistent' | 'isolated';
export type BrowserProfileMode = 'repo_local' | 'custom';
export type BrowserCdpAttachFallback = 'managed_persistent' | 'fail_closed';
export type BrowserNativeProduct = 'chrome' | 'vivaldi';
export type BrowserTabMatchReason = 'owned_token' | 'recovered_tab' | 'saved_url_title' | 'saved_url' | 'exact_url' | 'blank' | 'new_page';

export interface CdpAttachAttempt {
  endpoint: string;
  discoveredEndpoint?: string;
  probeUrl?: string;
  browserVersion?: string;
  error?: string;
}

export interface BrowserNativeAttachAttempt {
  product: BrowserNativeProduct;
  appName: string;
  bundleId: string;
  status: 'selected' | 'available' | 'not_installed' | 'not_running' | 'unavailable';
  frontmost?: boolean;
  error?: string;
}

export interface BrowserSessionResumeDiagnostic {
  sessionId: string;
  status: 'matched' | 'stale_tab' | 'no_saved_tab';
  reason: string;
  savedTab?: Pick<BrowserTabResumeState, 'key' | 'url' | 'title' | 'index'>;
}

export interface BrowserConnectionFallback {
  policy: BrowserCdpAttachFallback;
  from: 'attach_preferred';
  to: 'managed_persistent';
  reason: string;
  attempts: CdpAttachAttempt[];
  nativeAttempts?: BrowserNativeAttachAttempt[];
}

export interface BrowserTabResumeState {
  key: string;
  index: number;
  url: string;
  title?: string;
  matchedBy: BrowserTabMatchReason;
  inventoryCount: number;
  capturedAt: string;
  ownership?: 'plugin_owned' | 'user_owned';
  ownerToken?: string;
  windowId?: string;
  tabId?: string;
}

export interface BrowserSessionConnectionState {
  mode: BrowserMode;
  activeMode: BrowserMode;
  provider: 'playwright-cdp' | 'playwright-persistent-context' | 'macos-apple-events';
  endpoint?: string;
  browserVersion?: string;
  browserProduct?: BrowserNativeProduct;
  nativeBrowserCandidates?: BrowserNativeProduct[];
  fallback?: BrowserConnectionFallback;
  tab?: BrowserTabResumeState;
  sessionResume?: BrowserSessionResumeDiagnostic;
}

export interface BrowserSessionState {
  schemaVersion: 1;
  sessionId: string;
  url: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  browser?: BrowserSessionConnectionState;
}

export type BrowserSessionLiveness = 'live' | 'unverified' | 'dead';
export type BrowserSessionLivenessEvidence =
  | 'runtime_session_binding'
  | 'runtime_owner_token'
  | 'runtime_bound_page_missing'
  | 'runtime_context_unavailable'
  | 'runtime_owner_token_not_observed'
  | 'provider_unverified'
  | 'native_tab_live'
  | 'native_tab_missing'
  | 'native_tab_invalid'
  | 'native_tab_invalid_closed'
  | 'native_tab_invalid_close_failed'
  | 'native_inventory_unavailable';

export interface BrowserSessionInventoryItem {
  session: BrowserSessionState;
  liveness: BrowserSessionLiveness;
  evidence: BrowserSessionLivenessEvidence;
  pruned?: boolean;
  cleanupError?: string;
}
