import type {
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationObservationOptions,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptTargetIdentity,
  ComputerChatgptTargetResult,
} from '../../packages/plugin-runtime/computer';

function identityOf(target: ComputerChatgptConversationTarget): ComputerChatgptTargetIdentity {
  return target.identity;
}

export class PreferredChatgptConversationTargetPort implements ComputerChatgptConversationTargetPort {
  constructor(
    private readonly primary: ComputerChatgptConversationTargetPort,
    private readonly compatibility: ComputerChatgptConversationTargetPort,
  ) {}

  private wrap(primaryTarget: ComputerChatgptConversationTarget, nativeCompatibility = false): ComputerChatgptConversationTarget {
    const identity = identityOf(primaryTarget);
    // Computer owns the stable target and its provider binding. A successful
    // read-only reattach must update every subsequent operation on this target,
    // not just return an observation from another provider.
    let selectedTarget = primaryTarget;
    let selectedNative = nativeCompatibility;
    return {
      targetId: primaryTarget.targetId,
      identity,
      observe: async (options?: ComputerChatgptConversationObservationOptions) => {
        try {
          const snapshot = await selectedTarget.observe(options);
          // A previously loaded Chrome extension can still flatten assistant
          // paragraphs after Runtime deploys the corrected content script.
          // Only a trailing compact-receipt candidate warrants one read-only
          // native reattachment. Supervisor still validates the exact challenge;
          // no result here authorizes a second send or an identity change.
          const flattenedReceipt = !selectedNative && identity.namespace === 'chatgpt.conversation'
            && !snapshot.isGenerating && snapshot.latestTurnRole === 'assistant'
            && /(?:^|[^\S\r\n])[CDU] [0-9a-f]{7}$/.test(snapshot.latestAssistantResponse.trim())
            && !/(?:^|\n)[CDU] [0-9a-f]{7}$/.test(snapshot.latestAssistantResponse.trim());
          if (flattenedReceipt) {
            try {
              const rebound = await this.compatibility.ensureExact(identity);
              if (rebound.state === 'ready' && rebound.target.targetId === primaryTarget.targetId) {
                const native = await rebound.target.observe(options);
                if (!native.isGenerating && native.latestTurnRole === 'assistant'
                  && /(?:^|\n)[CDU] [0-9a-f]{7}$/.test(native.latestAssistantResponse.trim())) {
                  selectedTarget = rebound.target;
                  selectedNative = true;
                  return native;
                }
              }
            } catch { /* Unavailable native evidence never changes the bound provider. */ }
          }
          return snapshot;
        } catch (primaryError) {
          if (!selectedNative && identity.namespace === 'chatgpt.conversation') {
            const rebound = await this.compatibility.ensureExact(identity);
            if (rebound.state === 'ready' && rebound.target.targetId === primaryTarget.targetId) {
              const observation = await rebound.target.observe(options);
              selectedTarget = rebound.target;
              selectedNative = true;
              return observation;
            }
          }
          throw primaryError;
        }
      },
      prepare: async (prompt, options) => await selectedTarget.prepare(prompt,
        selectedNative && options?.reasoning ? { ...options, reasoning: undefined } : options),
      // Never replay a possibly submitted effect through another provider.
      // The only transport switch above is a verified read-only reattachment.
      dispatch: async (prompt, options) => await selectedTarget.dispatch(prompt,
        selectedNative && options?.reasoning ? { ...options, reasoning: undefined } : options),
    };
  }

  async inventory(): Promise<ComputerChatgptConversationInventory> {
    const [primary, compatibility] = await Promise.all([
      this.primary.inventory().catch(() => ({ conversations: [], complete: false, unavailableProviders: ['primary'] })),
      this.compatibility.inventory().catch(() => ({ conversations: [], complete: false, unavailableProviders: ['compatibility'] })),
    ]);
    const byId = new Map<string, ComputerChatgptConversationInventory['conversations'][number]>();
    for (const entry of compatibility.conversations) byId.set(entry.conversationId, entry);
    for (const entry of primary.conversations) byId.set(entry.conversationId, entry);
    return {
      conversations: [...byId.values()],
      // Extension heartbeats cover only connected Chromium instances. Only the
      // native inventory scans all supported browser families, so an extension
      // heartbeat cannot prove global coverage when native enumeration is partial.
      complete: compatibility.complete,
      providerInventoryReady: primary.complete || compatibility.complete,
      unavailableProviders: [...new Set([...primary.unavailableProviders, ...compatibility.unavailableProviders])],
    };
  }

  async ensureExact(identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const primary = await this.primary.ensureExact(identity);
    if (primary.state === 'ready') return { ...primary, target: this.wrap(primary.target) };
    // An extension that is not connected has made no browser mutation. Reuse
    // the already available native browser target rather than stranding a due
    // Supervisor continuation behind an optional transport.
    if (primary.failure.failoverSafe === true) {
      const compatibility = await this.compatibility.ensureExact(identity);
      if (compatibility.state === 'ready') return { ...compatibility, target: this.wrap(compatibility.target, true) };
    }
    return primary;
  }

  async openBootstrap(projectUrl: string, bootstrapKey: string): Promise<ComputerChatgptTargetResult> {
    const primary = await this.primary.openBootstrap(projectUrl, bootstrapKey);
    if (primary.state === 'ready') return { ...primary, target: this.wrap(primary.target) };
    // Extension absence is a proven no-open, while a claimed but unanswered
    // create may already have produced a tab. Only the former can use the
    // existing native Computer provider without risking two bootstrap tabs.
    if (primary.failure.phase === 'pre_mutation' && primary.failure.failoverSafe === true) {
      const compatibility = await this.compatibility.openBootstrap(projectUrl, bootstrapKey);
      if (compatibility.state === 'ready') return { ...compatibility, target: this.wrap(compatibility.target, true) };
    }
    return primary;
  }

  async findBySubmittedMarker(marker: string, bootstrapKey?: string, betweenObservations?: () => Promise<void>): Promise<ComputerChatgptTargetResult[]> {
    const primary = await this.primary.findBySubmittedMarker(marker, bootstrapKey, betweenObservations);
    if (primary.length > 0) return primary.map((result) => result.state === 'ready' ? { ...result, target: this.wrap(result.target) } : result);
    return (await this.compatibility.findBySubmittedMarker(marker, bootstrapKey, betweenObservations))
      .map((result) => result.state === 'ready' ? { ...result, target: this.wrap(result.target, true) } : result);
  }

  async promoteBootstrap(targetId: string, identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const primary = await this.primary.promoteBootstrap(targetId, identity);
    if (primary.state === 'ready') return { ...primary, target: this.wrap(primary.target) };
    // A provider-mismatch refusal proves that this extension did not mutate
    // the bootstrap binding. Ask the native owner to promote the SAME target;
    // never open or send again, and reject a mismatched conversation identity.
    if (primary.failure.code === 'COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_PROVIDER_MISMATCH'
      && primary.failure.phase === 'pre_mutation' && primary.failure.failoverSafe === true) {
      const native = await this.compatibility.promoteBootstrap(targetId, identity);
      if (native.state === 'ready') {
        if (native.target.identity.namespace !== 'chatgpt.conversation'
          || native.target.identity.conversationId !== identity.conversationId) {
          return { state: 'unavailable', failure: {
            code: 'COMPUTER_CHATGPT_BOOTSTRAP_PROMOTION_IDENTITY_MISMATCH', retryable: false, phase: 'pre_mutation', failoverSafe: false,
          } };
        }
        return { ...native, target: this.wrap(native.target, true) };
      }
      return native;
    }
    return primary;
  }

  async cleanup(activeResourceKeys: readonly string[]): Promise<void> {
    await Promise.allSettled([this.primary.cleanup(activeResourceKeys), this.compatibility.cleanup(activeResourceKeys)]);
  }

  async release(targetId: string): Promise<void> {
    await Promise.allSettled([this.primary.release(targetId), this.compatibility.release(targetId)]);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.primary.close(), this.compatibility.close()]);
  }
}
