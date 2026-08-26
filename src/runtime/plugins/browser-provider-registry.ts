import { AssistantPluginError } from './errors';
import {
  providerSupports,
  type BrowserForegroundRequirement,
  type BrowserProviderCapabilities,
  type BrowserProviderCapability,
} from './browser-runtime-contract';

export interface BrowserRuntimeProvider<TInput, TResult> extends BrowserProviderCapabilities {
  /** Lower values are preferred when multiple providers satisfy the same capability contract. */
  priority: number;
  /** Availability is decided before execution; ordinary provider failures are never fallback signals. */
  supportsInput(input: TInput): boolean;
  execute(input: TInput): Promise<TResult>;
  /** Runs only after an explicit stale/restart/configuration boundary. */
  revalidate?: () => Promise<void> | void;
}

interface BrowserProviderState<TInput, TResult> {
  provider: BrowserRuntimeProvider<TInput, TResult>;
  generation: number;
  invalidatedReason?: string;
}

export interface BrowserProviderSelection<TInput, TResult> {
  provider: BrowserRuntimeProvider<TInput, TResult>;
  generation: number;
}

/**
 * A typed pre-action rejection. Runtime may select another provider because this proves the action
 * was not attempted. Arbitrary provider errors are intentionally not mapped to this signal.
 */
export class BrowserProviderUnavailableBeforeActionError extends Error {
  readonly providerId: string;
  readonly reason: string;

  constructor(providerId: string, reason: string) {
    super(`${providerId} unavailable before action: ${reason}`);
    this.name = 'BrowserProviderUnavailableBeforeActionError';
    this.providerId = providerId;
    this.reason = reason;
  }
}

function foregroundCompatible(
  provider: BrowserProviderCapabilities,
  requested: BrowserForegroundRequirement,
): boolean {
  // Background-safe providers may execute explicit foreground transactions; foreground-only
  // providers may not satisfy a background-safe transaction.
  return requested === 'explicit_required' || provider.foreground === 'none';
}

export class BrowserProviderRegistry<TInput, TResult> {
  private readonly providers = new Map<string, BrowserProviderState<TInput, TResult>>();

  register(provider: BrowserRuntimeProvider<TInput, TResult>): void {
    const current = this.providers.get(provider.providerId);
    if (current) {
      // Refresh call-local closures without discarding the warm provider generation.
      current.provider = provider;
      return;
    }
    this.providers.set(provider.providerId, { provider, generation: 1 });
  }

  invalidate(providerId: string, reason: string): void {
    const state = this.providers.get(providerId);
    if (state) state.invalidatedReason = reason;
  }

  invalidateAll(reason: string): void {
    for (const state of this.providers.values()) state.invalidatedReason = reason;
  }

  private async prepare(state: BrowserProviderState<TInput, TResult>): Promise<void> {
    if (!state.invalidatedReason) return;
    await state.provider.revalidate?.();
    state.invalidatedReason = undefined;
    state.generation += 1;
  }

  async select(options: {
    input: TInput;
    requiredCapabilities: readonly BrowserProviderCapability[];
    foreground: BrowserForegroundRequirement;
    excludedProviderIds?: ReadonlySet<string>;
  }): Promise<BrowserProviderSelection<TInput, TResult>> {
    const candidates = [...this.providers.values()]
      .filter(({ provider }) => !options.excludedProviderIds?.has(provider.providerId))
      .filter(({ provider }) => provider.supportsInput(options.input))
      .filter(({ provider }) => providerSupports(provider, options.requiredCapabilities))
      .filter(({ provider }) => foregroundCompatible(provider, options.foreground))
      .sort((left, right) => left.provider.priority - right.provider.priority
        || left.provider.providerId.localeCompare(right.provider.providerId));

    const selected = candidates[0];
    if (!selected) {
      throw new AssistantPluginError(
        'PLUGIN_BROWSER_PROVIDER_UNAVAILABLE',
        `No Browser provider satisfies required capabilities: ${options.requiredCapabilities.join(', ') || 'browser.transaction'}.`,
        { retryable: true },
      );
    }
    await this.prepare(selected);
    return { provider: selected.provider, generation: selected.generation };
  }
}
