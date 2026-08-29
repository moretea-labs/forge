export const MAX_BROWSER_CDP_ENDPOINT_CANDIDATES = 5;

export type BrowserProviderCapability =
  | 'dom.read'
  | 'dom.interact'
  | 'browser.internal_resources'
  | 'browser.screenshot'
  | 'browser.trusted_input'
  | 'browser.foreground'
  | 'browser.transaction'
  | 'browser.persistent_handle';

export type BrowserTargetOwnership = 'plugin_owned' | 'user_owned' | 'provider_owned';
export type BrowserTargetKind = 'page' | 'tab' | 'browser_internal_resource';
export type BrowserForegroundRequirement = 'none' | 'explicit_required';
export type BrowserActionReplaySafety = 'read_only' | 'idempotent' | 'non_idempotent';

/** Stable resource identity. URL/title are deliberately excluded because they are mutable observations. */
export interface BrowserTargetIdentity {
  providerId: string;
  resourceKind: BrowserTargetKind;
  resourceId: string;
  browserProduct?: string;
  ownership: BrowserTargetOwnership;
}

export interface BrowserObservedState {
  url: string;
  title?: string;
  observedAt: string;
  providerRevision?: string;
}

export interface BrowserProviderCapabilities {
  providerId: string;
  capabilities: readonly BrowserProviderCapability[];
  foreground: BrowserForegroundRequirement;
  /** True only when the provider can verify postconditions in the same provider call that performs the action. */
  verifiesPostconditions: boolean;
  /** True only when an already-bound provider handle can be reused across bounded consecutive actions. */
  persistentHandle: boolean;
}

export type BrowserCondition =
  | { kind: 'target_identity'; target: BrowserTargetIdentity }
  | { kind: 'url_equals'; url: string }
  | { kind: 'url_matches'; pattern: string }
  | { kind: 'selector_exists'; selector: string }
  | { kind: 'selector_visible'; selector: string }
  | { kind: 'text_contains'; text: string; selector?: string }
  | { kind: 'attribute_equals'; selector: string; attribute: string; value: string }
  | { kind: 'provider_assertion'; assertion: string; expected: string | number | boolean };

export type BrowserTransactionAction =
  | { kind: 'read'; operation: string; arguments?: Record<string, unknown> }
  | { kind: 'dom'; operation: string; arguments?: Record<string, unknown> }
  | { kind: 'internal_resource'; operation: string; arguments?: Record<string, unknown> }
  | { kind: 'trusted_input'; operation: string; arguments?: Record<string, unknown> };

export interface BrowserTransaction {
  transactionId: string;
  target: BrowserTargetIdentity;
  requiredCapabilities: readonly BrowserProviderCapability[];
  foreground: BrowserForegroundRequirement;
  replaySafety: BrowserActionReplaySafety;
  preconditions?: readonly BrowserCondition[];
  action: BrowserTransactionAction;
  /** Writes/interactions require at least one postcondition unless the action itself returns a typed read result. */
  postconditions?: readonly BrowserCondition[];
  timeoutMs: number;
}

export interface BrowserConditionEvidence {
  condition: BrowserCondition;
  satisfied: boolean;
  observed?: unknown;
  reason?: string;
}

export interface BrowserTransactionTiming {
  providerCalls: number;
  providerDurationMs: number;
  totalDurationMs: number;
}

export interface BrowserTransactionResult<T = unknown> {
  transactionId: string;
  target: BrowserTargetIdentity;
  transportSucceeded: boolean;
  actionPerformed: boolean;
  /** Authoritative success bit. AX/transport success alone must never set this true. */
  verified: boolean;
  result?: T;
  observedState?: BrowserObservedState;
  preconditionEvidence: readonly BrowserConditionEvidence[];
  postconditionEvidence: readonly BrowserConditionEvidence[];
  timing: BrowserTransactionTiming;
}

export interface BrowserRuntimeBudget {
  p95Ms: number;
  maxProviderCallsWarm: number;
  maxProviderCallsCold: number;
  foregroundAllowed: boolean;
}

/**
 * Architecture targets, not per-host promises. Live V2 gates report p50/p95 and fail when a
 * regression materially exceeds these budgets without attributable provider evidence.
 */
export const BROWSER_RUNTIME_V2_BUDGETS = {
  read: { p95Ms: 350, maxProviderCallsWarm: 1, maxProviderCallsCold: 2, foregroundAllowed: false },
  domInteraction: { p95Ms: 600, maxProviderCallsWarm: 1, maxProviderCallsCold: 2, foregroundAllowed: false },
  internalResource: { p95Ms: 700, maxProviderCallsWarm: 1, maxProviderCallsCold: 2, foregroundAllowed: false },
  physicalInput: { p95Ms: 1_500, maxProviderCallsWarm: 1, maxProviderCallsCold: 2, foregroundAllowed: true },
} as const satisfies Record<string, BrowserRuntimeBudget>;

export function browserTargetKey(target: BrowserTargetIdentity): string {
  return [target.providerId, target.browserProduct ?? '', target.resourceKind, target.resourceId, target.ownership].join(':');
}

export function providerSupports(
  provider: BrowserProviderCapabilities,
  required: readonly BrowserProviderCapability[],
): boolean {
  const available = new Set(provider.capabilities);
  return required.every((capability) => available.has(capability));
}

export function browserTransactionVerified(result: BrowserTransactionResult): boolean {
  return result.transportSucceeded
    && result.actionPerformed
    && result.verified
    && result.preconditionEvidence.every((entry) => entry.satisfied)
    && result.postconditionEvidence.every((entry) => entry.satisfied);
}

export function browserTransactionRequiresPostcondition(transaction: BrowserTransaction): boolean {
  return transaction.replaySafety !== 'read_only';
}

export function validateBrowserTransaction(transaction: BrowserTransaction): string[] {
  const errors: string[] = [];
  if (!transaction.transactionId.trim()) errors.push('transactionId is required');
  if (!transaction.target.providerId.trim() || !transaction.target.resourceId.trim()) errors.push('stable target identity is incomplete');
  if (!Number.isFinite(transaction.timeoutMs) || transaction.timeoutMs <= 0) errors.push('timeoutMs must be positive');
  if (transaction.foreground === 'none' && transaction.requiredCapabilities.includes('browser.foreground')) {
    errors.push('foreground capability cannot be required by a foreground-free transaction');
  }
  if (browserTransactionRequiresPostcondition(transaction) && (transaction.postconditions?.length ?? 0) === 0) {
    errors.push('interactive transactions require at least one postcondition');
  }
  return errors;
}
