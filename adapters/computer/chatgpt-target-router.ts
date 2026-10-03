import type {
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationObservationOptions,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptTargetIdentity,
  ComputerChatgptTargetResult,
} from '../../packages/plugin-runtime/computer';

function canFailover(result: ComputerChatgptTargetResult): boolean {
  return result.state === 'unavailable' && result.failure.phase === 'pre_mutation' && result.failure.failoverSafe !== false;
}

function identityOf(target: ComputerChatgptConversationTarget): ComputerChatgptTargetIdentity {
  return target.identity;
}

export class PreferredChatgptConversationTargetPort implements ComputerChatgptConversationTargetPort {
  constructor(
    private readonly primary: ComputerChatgptConversationTargetPort,
    private readonly compatibility: ComputerChatgptConversationTargetPort,
  ) {}

  private wrap(primaryTarget: ComputerChatgptConversationTarget, compatibilityTarget?: ComputerChatgptConversationTarget): ComputerChatgptConversationTarget {
    const identity = identityOf(primaryTarget);
    return {
      targetId: primaryTarget.targetId,
      identity,
      observe: async (options?: ComputerChatgptConversationObservationOptions) => {
        try { return await primaryTarget.observe(options); }
        catch (primaryError) {
          if (compatibilityTarget) return await compatibilityTarget.observe(options);
          if (identity.namespace === 'chatgpt.conversation') {
            const fallback = await this.compatibility.ensureExact(identity);
            if (fallback.state === 'ready') return await fallback.target.observe(options);
          }
          throw primaryError;
        }
      },
      dispatch: async (prompt, options) => {
        const result = await primaryTarget.dispatch(prompt, options);
        if (result.mutation === 'attempted') return result;
        let fallbackTarget = compatibilityTarget;
        if (!fallbackTarget && identity.namespace === 'chatgpt.conversation') {
          const fallback = await this.compatibility.ensureExact(identity);
          if (fallback.state === 'ready') fallbackTarget = fallback.target;
        }
        return fallbackTarget ? await fallbackTarget.dispatch(prompt, options) : result;
      },
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
      complete: primary.complete || compatibility.complete,
      unavailableProviders: [...new Set([...primary.unavailableProviders, ...compatibility.unavailableProviders])],
    };
  }

  async ensureExact(identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const primary = await this.primary.ensureExact(identity);
    if (primary.state === 'ready') return { ...primary, target: this.wrap(primary.target) };
    if (!canFailover(primary)) return primary;
    const compatibility = await this.compatibility.ensureExact(identity);
    if (compatibility.state !== 'ready') return compatibility;
    return compatibility;
  }

  async openBootstrap(projectUrl: string, bootstrapKey: string): Promise<ComputerChatgptTargetResult> {
    const primary = await this.primary.openBootstrap(projectUrl, bootstrapKey);
    if (primary.state === 'ready') return { ...primary, target: this.wrap(primary.target) };
    if (!canFailover(primary)) return primary;
    return await this.compatibility.openBootstrap(projectUrl, bootstrapKey);
  }

  async findBySubmittedMarker(marker: string, bootstrapKey?: string, betweenObservations?: () => Promise<void>): Promise<ComputerChatgptTargetResult[]> {
    const primary = await this.primary.findBySubmittedMarker(marker, bootstrapKey, betweenObservations);
    if (primary.length > 0) return primary.map((result) => result.state === 'ready' ? { ...result, target: this.wrap(result.target) } : result);
    return await this.compatibility.findBySubmittedMarker(marker, bootstrapKey, betweenObservations);
  }

  async promoteBootstrap(targetId: string, identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const primary = await this.primary.promoteBootstrap(targetId, identity);
    if (primary.state === 'ready') return { ...primary, target: this.wrap(primary.target) };
    if (!canFailover(primary)) return primary;
    return await this.compatibility.promoteBootstrap(targetId, identity);
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
