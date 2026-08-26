import { describe, expect, test } from 'bun:test';
import {
  BROWSER_RUNTIME_V2_BUDGETS,
  browserTargetKey,
  browserTransactionVerified,
  providerSupports,
  validateBrowserTransaction,
  type BrowserTransaction,
  type BrowserTransactionResult,
} from '../../src/runtime/plugins/browser-runtime-contract';

const target = {
  providerId: 'native.chrome',
  browserProduct: 'chrome',
  resourceKind: 'tab' as const,
  resourceId: 'window:7/tab:9',
  ownership: 'user_owned' as const,
};

describe('Browser Runtime V2 contract', () => {
  test('stable target identity does not depend on mutable URL', () => {
    expect(browserTargetKey(target)).toBe('native.chrome:chrome:tab:window:7/tab:9:user_owned');
  });

  test('provider routing is capability based', () => {
    const provider = {
      providerId: 'native.chrome',
      capabilities: ['dom.read', 'dom.interact', 'browser.transaction'] as const,
      foreground: 'none' as const,
      verifiesPostconditions: true,
      persistentHandle: true,
    };
    expect(providerSupports(provider, ['dom.read', 'browser.transaction'])).toBe(true);
    expect(providerSupports(provider, ['browser.trusted_input'])).toBe(false);
  });

  test('interactive transactions require postconditions and cannot hide foreground requirements', () => {
    const transaction: BrowserTransaction = {
      transactionId: 'tx-1',
      target,
      requiredCapabilities: ['browser.foreground', 'browser.trusted_input'],
      foreground: 'none',
      replaySafety: 'non_idempotent',
      action: { kind: 'trusted_input', operation: 'click' },
      timeoutMs: 1_000,
    };
    expect(validateBrowserTransaction(transaction)).toEqual([
      'foreground capability cannot be required by a foreground-free transaction',
      'interactive transactions require at least one postcondition',
    ]);
  });

  test('transport or AX success alone is not transaction success', () => {
    const base: BrowserTransactionResult = {
      transactionId: 'tx-2',
      target,
      transportSucceeded: true,
      actionPerformed: true,
      verified: false,
      preconditionEvidence: [],
      postconditionEvidence: [{ condition: { kind: 'selector_exists', selector: '#done' }, satisfied: false }],
      timing: { providerCalls: 1, providerDurationMs: 10, totalDurationMs: 12 },
    };
    expect(browserTransactionVerified(base)).toBe(false);
    expect(browserTransactionVerified({
      ...base,
      verified: true,
      postconditionEvidence: [{ condition: { kind: 'selector_exists', selector: '#done' }, satisfied: true }],
    })).toBe(true);
  });

  test('common background paths are budgeted to one warm provider call', () => {
    expect(BROWSER_RUNTIME_V2_BUDGETS.read.maxProviderCallsWarm).toBe(1);
    expect(BROWSER_RUNTIME_V2_BUDGETS.domInteraction.maxProviderCallsWarm).toBe(1);
    expect(BROWSER_RUNTIME_V2_BUDGETS.internalResource.foregroundAllowed).toBe(false);
    expect(BROWSER_RUNTIME_V2_BUDGETS.physicalInput.foregroundAllowed).toBe(true);
  });
});
