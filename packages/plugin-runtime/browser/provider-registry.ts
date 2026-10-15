import {
  providerSupports,
  type BrowserForegroundRequirement,
  type BrowserProviderCapabilities,
  type BrowserProviderCapability,
} from './runtime-contract';

export interface BrowserRuntimeProvider<TInput, TResult> extends BrowserProviderCapabilities {
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

/** Provider-neutral selection failure. Adapter surfaces map this to their public error contract. */
export class BrowserProviderSelectionError extends Error {
  readonly code = 'PLUGIN_BROWSER_PROVIDER_UNAVAILABLE';
  readonly retryable = true;

  constructor(readonly requiredCapabilities: readonly BrowserProviderCapability[]) {
    super(`No Browser provider satisfies required capabilities: ${requiredCapabilities.join(', ') || 'browser.transaction'}.`);
    this.name = 'BrowserProviderSelectionError';
  }
}

function foregroundCompatible(
  provider: BrowserProviderCapabilities,
  requested: BrowserForegroundRequirement,
): boolean {
  return requested === 'explicit_required' || provider.foreground === 'none';
}

export class BrowserProviderRegistry<TInput, TResult> {
  private state?: BrowserProviderState<TInput, TResult>;

  register(provider: BrowserRuntimeProvider<TInput, TResult>): void {
    if (this.state?.provider.providerId === provider.providerId) {
      this.state.provider = provider;
      return;
    }
    // A configuration change replaces the binding; it never accumulates candidates.
    this.state = { provider, generation: 1 };
  }

  invalidate(providerId: string, reason: string): void {
    if (this.state?.provider.providerId === providerId) this.state.invalidatedReason = reason;
  }

  invalidateAll(reason: string): void {
    if (this.state) this.state.invalidatedReason = reason;
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
  }): Promise<BrowserProviderSelection<TInput, TResult>> {
    const selected = this.state
      && this.state.provider.supportsInput(options.input)
      && providerSupports(this.state.provider, options.requiredCapabilities)
      && foregroundCompatible(this.state.provider, options.foreground)
      ? this.state : undefined;
    if (!selected) throw new BrowserProviderSelectionError(options.requiredCapabilities);
    await this.prepare(selected);
    return { provider: selected.provider, generation: selected.generation };
  }
}
