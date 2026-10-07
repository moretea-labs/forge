import { randomUUID } from 'node:crypto';
import type {
  ComputerChatgptBootstrapIdentity,
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationObservation,
  ComputerChatgptConversationObservationOptions,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptExtensionBrokerRpc,
  ComputerChatgptExtensionCommand,
  ComputerChatgptExtensionCommandInput,
  ComputerChatgptExtensionCommandResult,
  ComputerChatgptExtensionHeartbeat,
  ComputerChatgptTargetIdentity,
  ComputerChatgptTargetResult,
  ComputerInteractionTargetAuthorityPort,
  ComputerSurfaceProviderBinding,
  ComputerSurfaceTarget,
} from '../../packages/plugin-runtime/computer';

const PROVIDER_ID = 'browser.chrome-extension';
const HEARTBEAT_FRESH_MS = 15_000;
const COMMAND_TIMEOUT_MS = 12_000;

type ProviderState = {
  receivedAtMs: number;
  heartbeat: ComputerChatgptExtensionHeartbeat;
};

type PendingCommand = {
  providerInstanceId: string;
  command: ComputerChatgptExtensionCommand;
  claimed: boolean;
  resolve: (value: { claimed: boolean; result?: ComputerChatgptExtensionCommandResult }) => void;
  timer: ReturnType<typeof setTimeout>;
};

function stableIdentity(identity: ComputerChatgptTargetIdentity) {
  return {
    surfaceType: 'browser-tab' as const,
    ownership: 'provider_owned' as const,
    resource: identity.namespace === 'chatgpt.conversation'
      ? { namespace: identity.namespace, key: identity.conversationId }
      : { namespace: identity.namespace, key: identity.bootstrapKey },
  };
}

function alias(identity: ComputerChatgptTargetIdentity): string {
  return identity.namespace === 'chatgpt.conversation'
    ? `chatgpt:conversation:${identity.conversationId}`
    : `chatgpt:bootstrap:${identity.bootstrapKey}`;
}

function providerInstanceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

function conversationContentAvailable(observation: ComputerChatgptConversationObservation): boolean {
  // A matching URL is not enough: an extension can observe the navigation
  // shell before ChatGPT hydrates the conversation, or after the browser has
  // lost the content script. Treat that as transport-unavailable so the
  // preferred target router can try the native browser attachment without
  // sending anything through the empty surface.
  return observation.composerText !== undefined || observation.isGenerating
    || Boolean(observation.latestUserText.trim() || observation.latestAssistantResponse.trim() || observation.providerActivityText.trim());
}

function failure(code: string, input: { retryable?: boolean; failoverSafe?: boolean; humanAction?: 'login' | 'grant_permission' } = {}): ComputerChatgptTargetResult {
  return {
    state: 'unavailable',
    failure: {
      code,
      retryable: input.retryable !== false,
      phase: 'pre_mutation',
      ...(input.failoverSafe === undefined ? {} : { failoverSafe: input.failoverSafe }),
      ...(input.humanAction ? { humanAction: input.humanAction } : {}),
    },
  };
}

function normalizeBinding(binding: ComputerSurfaceProviderBinding | undefined, instanceId?: string): ComputerSurfaceProviderBinding | undefined {
  if (!binding) return undefined;
  if (binding.providerId !== PROVIDER_ID || !binding.windowId || !binding.tabId) return undefined;
  const bindingInstanceId = providerInstanceId(binding.providerSessionId);
  if (instanceId && bindingInstanceId && bindingInstanceId !== instanceId) return undefined;
  return {
    providerId: PROVIDER_ID,
    observedAt: binding.observedAt || new Date().toISOString(),
    ...(instanceId || bindingInstanceId ? { providerSessionId: instanceId ?? bindingInstanceId } : {}),
    ...(binding.browserProduct ? { browserProduct: binding.browserProduct } : {}),
    windowId: String(binding.windowId),
    tabId: String(binding.tabId),
    ...(binding.ownerToken ? { ownerToken: binding.ownerToken } : {}),
  };
}

export class ChromeExtensionChatgptConversationTargetPort
implements ComputerChatgptConversationTargetPort, ComputerChatgptExtensionBrokerRpc {
  private readonly providerStates = new Map<string, ProviderState>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queues = new Map<string, string[]>();

  constructor(
    private readonly controllerHome: string,
    private readonly authority: ComputerInteractionTargetAuthorityPort,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  heartbeat(input: ComputerChatgptExtensionHeartbeat): void {
    if (input.providerId !== PROVIDER_ID) throw new Error('COMPUTER_CHATGPT_EXTENSION_PROVIDER_ID_INVALID');
    const instanceId = providerInstanceId(input.providerInstanceId);
    if (!instanceId) throw new Error('COMPUTER_CHATGPT_EXTENSION_PROVIDER_INSTANCE_REQUIRED');
    const conversations = Array.isArray(input.conversations)
      ? input.conversations.flatMap((entry) => {
          if (!entry || typeof entry.conversationId !== 'string' || !entry.conversationId.trim() || typeof entry.canonicalUrl !== 'string' || !entry.canonicalUrl.trim()) return [];
          const binding = normalizeBinding(entry.providerBinding, instanceId);
          return [{
            conversationId: entry.conversationId.trim(),
            canonicalUrl: entry.canonicalUrl.trim(),
            ...(entry.title ? { title: String(entry.title).slice(0, 512) } : {}),
            ...(entry.projectTitle ? { projectTitle: String(entry.projectTitle).slice(0, 512) } : {}),
            ...(entry.projectUrl ? { projectUrl: String(entry.projectUrl) } : {}),
            ...(entry.isCurrent ? { isCurrent: true } : {}),
            ...(binding ? { providerBinding: binding } : {}),
          }];
        })
      : [];
    this.providerStates.set(instanceId, {
      receivedAtMs: this.nowMs(),
      heartbeat: {
        providerId: PROVIDER_ID,
        providerInstanceId: instanceId,
        observedAt: typeof input.observedAt === 'string' && input.observedAt ? input.observedAt : new Date(this.nowMs()).toISOString(),
        conversations,
      },
    });
  }

  claim(rawProviderInstanceId: string): ComputerChatgptExtensionCommand | undefined {
    const instanceId = providerInstanceId(rawProviderInstanceId);
    if (!instanceId) return undefined;
    const queue = this.queues.get(instanceId);
    while (queue && queue.length > 0) {
      const id = queue.shift()!;
      const entry = this.pending.get(id);
      if (!entry || entry.providerInstanceId !== instanceId || entry.claimed) continue;
      entry.claimed = true;
      return structuredClone(entry.command);
    }
    if (queue?.length === 0) this.queues.delete(instanceId);
    return undefined;
  }

  complete(rawProviderInstanceId: string, commandId: string, result: ComputerChatgptExtensionCommandResult): boolean {
    const instanceId = providerInstanceId(rawProviderInstanceId);
    const entry = this.pending.get(commandId);
    if (!instanceId || !entry || entry.providerInstanceId !== instanceId || !entry.claimed) return false;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.resolve({ claimed: true, result: structuredClone(result) });
    return true;
  }

  private freshProviders(): Array<[string, ProviderState]> {
    const now = this.nowMs();
    const fresh: Array<[string, ProviderState]> = [];
    for (const [instanceId, state] of this.providerStates) {
      if (now - state.receivedAtMs > HEARTBEAT_FRESH_MS) {
        this.providerStates.delete(instanceId);
        continue;
      }
      fresh.push([instanceId, state]);
    }
    return fresh.sort(([left], [right]) => left.localeCompare(right));
  }

  private providerIsFresh(instanceId: string): boolean {
    return this.freshProviders().some(([candidate]) => candidate === instanceId);
  }

  private selectProviderInstance(preferredInstanceId?: string): { instanceId?: string; ambiguous: boolean } {
    const fresh = this.freshProviders();
    if (preferredInstanceId && fresh.some(([instanceId]) => instanceId === preferredInstanceId)) {
      return { instanceId: preferredInstanceId, ambiguous: false };
    }
    const current = fresh.filter(([, state]) => state.heartbeat.conversations.some((conversation) => conversation.isCurrent));
    if (current.length === 1) return { instanceId: current[0]![0], ambiguous: false };
    if (fresh.length === 1) return { instanceId: fresh[0]![0], ambiguous: false };
    return { ambiguous: fresh.length > 1 };
  }

  private preferredProviderInstance(identity: ComputerChatgptTargetIdentity): string | undefined {
    const existing = this.authority.findSurfaceByStableIdentity(this.controllerHome, stableIdentity(identity));
    const binding = existing?.providerBinding;
    if (binding?.providerId !== PROVIDER_ID) return undefined;
    return providerInstanceId(binding.providerSessionId);
  }

  private async submit(providerInstanceId: string, command: ComputerChatgptExtensionCommandInput): Promise<{ claimed: boolean; result?: ComputerChatgptExtensionCommandResult }> {
    const commandId = `computer-extension-${randomUUID()}`;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(commandId);
        if (!current) return;
        this.pending.delete(commandId);
        resolve({ claimed: current.claimed });
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      const full = { ...command, commandId } as ComputerChatgptExtensionCommand;
      this.pending.set(commandId, { providerInstanceId, command: full, claimed: false, resolve, timer });
      const queue = this.queues.get(providerInstanceId) ?? [];
      queue.push(commandId);
      this.queues.set(providerInstanceId, queue);
    });
  }

  private upsert(identity: ComputerChatgptTargetIdentity, binding?: ComputerSurfaceProviderBinding): ComputerSurfaceTarget {
    return this.authority.upsertSurface(this.controllerHome, {
      stableIdentity: stableIdentity(identity),
      compatibilityAliases: [alias(identity)],
      visibility: 'controller',
      ...(binding ? { providerBinding: binding } : {}),
      compatibilityRecords: [{
        namespace: 'chatgpt.target',
        schemaVersion: 1,
        value: identity.namespace === 'chatgpt.conversation'
          ? { namespace: identity.namespace, conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl }
          : { namespace: identity.namespace, bootstrapKey: identity.bootstrapKey, projectUrl: identity.projectUrl },
        updatedAt: new Date(this.nowMs()).toISOString(),
      }],
      reactivate: true,
    }).target;
  }

  private async bindAsync(identity: ComputerChatgptTargetIdentity, binding: ComputerSurfaceProviderBinding | undefined, instanceId: string): Promise<ComputerSurfaceTarget> {
    const record = this.upsert(identity);
    const normalized = normalizeBinding(binding, instanceId);
    if (!normalized) return record;
    return await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => lease.bind(normalized));
  }

  private target(identity: ComputerChatgptTargetIdentity, record: ComputerSurfaceTarget, instanceId: string): ComputerChatgptConversationTarget {
    return {
      targetId: record.targetId,
      identity,
      observe: async (options) => {
        const response = await this.submit(instanceId, { kind: 'observe', identity, ...(options ? { options } : {}) });
        if (!response.result) throw new Error(response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_OBSERVATION_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED');
        if (response.result.kind === 'observation') {
          if (response.result.providerBinding) await this.bindAsync(identity, response.result.providerBinding, instanceId);
          return response.result.observation;
        }
        if (response.result.kind === 'failed') throw new Error(response.result.code);
        throw new Error('COMPUTER_CHATGPT_EXTENSION_OBSERVATION_INVALID');
      },
      dispatch: async (prompt, options) => {
        const response = await this.submit(instanceId, { kind: 'dispatch', identity, prompt, ...(options?.mode ? { mode: options.mode } : {}) });
        if (!response.result) {
          return response.claimed
            ? { mutation: 'attempted' as const }
            : { mutation: 'not_attempted' as const, reasonCode: 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED' };
        }
        if (response.result.kind === 'dispatch') {
          return response.result.mutation === 'attempted'
            ? { mutation: 'attempted' as const, ...(response.result.confirmed === undefined ? {} : { confirmed: response.result.confirmed }) }
            : { mutation: 'not_attempted' as const, reasonCode: response.result.reasonCode };
        }
        if (response.result.kind === 'failed') return { mutation: 'not_attempted' as const, reasonCode: response.result.code };
        return { mutation: 'not_attempted' as const, reasonCode: 'COMPUTER_CHATGPT_EXTENSION_DISPATCH_INVALID' };
      },
    };
  }

  async inventory(): Promise<ComputerChatgptConversationInventory> {
    const fresh = this.freshProviders();
    if (fresh.length === 0) return { conversations: [], complete: false, unavailableProviders: [PROVIDER_ID] };
    const byConversationId = new Map<string, ComputerChatgptConversationInventory['conversations'][number]>();
    for (const [, state] of fresh) {
      for (const { providerBinding: _binding, ...entry } of state.heartbeat.conversations) {
        const previous = byConversationId.get(entry.conversationId);
        if (!previous || entry.isCurrent) byConversationId.set(entry.conversationId, entry);
      }
    }
    return { conversations: [...byConversationId.values()], complete: true, unavailableProviders: [] };
  }

  async ensureExact(identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const fresh = this.freshProviders();
    if (fresh.length === 0) return failure('COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED', { failoverSafe: true });
    const exact = fresh.flatMap(([instanceId, state]) => state.heartbeat.conversations
      .filter((entry) => entry.conversationId === identity.conversationId)
      .map((entry) => ({ instanceId, entry })));
    if (exact.length > 1) return failure('COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_AMBIGUOUS', { failoverSafe: false });
    if (exact.length === 1) {
      const candidate = exact[0]!;
      const record = await this.bindAsync(identity, candidate.entry.providerBinding, candidate.instanceId);
      const target = this.target(identity, record, candidate.instanceId);
      try {
        const observation = await target.observe({ includeUserHistory: false, includePageText: false });
        if (!conversationContentAvailable(observation)) {
          return failure('COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', { failoverSafe: true });
        }
        return { state: 'ready', target, observation };
      } catch (error) {
        return failure(
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : 'COMPUTER_CHATGPT_EXTENSION_OBSERVATION_UNAVAILABLE',
          { failoverSafe: true },
        );
      }
    }
    const selected = this.selectProviderInstance(this.preferredProviderInstance(identity));
    if (!selected.instanceId) {
      return failure(
        selected.ambiguous ? 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_INSTANCE_AMBIGUOUS' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
        { failoverSafe: !selected.ambiguous },
      );
    }
    const response = await this.submit(selected.instanceId, { kind: 'ensure', identity });
    if (!response.result) return failure(
      response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_TARGET_OPEN_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
      { failoverSafe: !response.claimed },
    );
    if (response.result.kind === 'ensured') {
      if (response.result.observation && !conversationContentAvailable(response.result.observation)) {
        return failure('COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', { failoverSafe: true });
      }
      const record = await this.bindAsync(identity, response.result.providerBinding, selected.instanceId);
      return { state: 'ready', target: this.target(identity, record, selected.instanceId), ...(response.result.observation ? { observation: response.result.observation } : {}) };
    }
    if (response.result.kind === 'failed') return failure(response.result.code, { retryable: response.result.retryable, failoverSafe: response.result.failoverSafe !== false, humanAction: response.result.humanAction });
    return failure('COMPUTER_CHATGPT_EXTENSION_ENSURE_INVALID', { failoverSafe: true });
  }

  async openBootstrap(projectUrl: string, bootstrapKey: string): Promise<ComputerChatgptTargetResult> {
    const identity: ComputerChatgptBootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl };
    const selected = this.selectProviderInstance(this.preferredProviderInstance(identity));
    if (!selected.instanceId) {
      return failure(
        selected.ambiguous ? 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_INSTANCE_AMBIGUOUS' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
        { failoverSafe: !selected.ambiguous },
      );
    }
    const response = await this.submit(selected.instanceId, { kind: 'ensure', identity });
    if (!response.result) return failure(
      response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_OPEN_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
      { failoverSafe: !response.claimed },
    );
    if (response.result.kind === 'ensured') {
      const record = await this.bindAsync(identity, response.result.providerBinding, selected.instanceId);
      return { state: 'ready', target: this.target(identity, record, selected.instanceId), ...(response.result.observation ? { observation: response.result.observation } : {}) };
    }
    if (response.result.kind === 'failed') return failure(response.result.code, { retryable: response.result.retryable, failoverSafe: response.result.failoverSafe !== false, humanAction: response.result.humanAction });
    return failure('COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_INVALID', { failoverSafe: true });
  }

  async findBySubmittedMarker(marker: string, bootstrapKey?: string, betweenObservations?: () => Promise<void>): Promise<ComputerChatgptTargetResult[]> {
    await betweenObservations?.();
    const fresh = this.freshProviders();
    if (fresh.length === 0) return [];
    const responses = await Promise.all(fresh.map(async ([instanceId]) => ({
      instanceId,
      response: await this.submit(instanceId, { kind: 'find_marker', marker, ...(bootstrapKey ? { bootstrapKey } : {}) }),
    })));
    await betweenObservations?.();
    const results: ComputerChatgptTargetResult[] = [];
    const seen = new Set<string>();
    for (const { instanceId, response } of responses) {
      if (response.result?.kind !== 'marker_matches') continue;
      for (const match of response.result.matches) {
        if (seen.has(match.identity.conversationId)) continue;
        seen.add(match.identity.conversationId);
        const record = await this.bindAsync(match.identity, match.providerBinding, instanceId);
        results.push({ state: 'ready', target: this.target(match.identity, record, instanceId), observation: match.observation });
      }
    }
    return results;
  }

  async promoteBootstrap(targetId: string, identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const previous = this.authority.getSurface(this.controllerHome, targetId);
    if (!previous) return failure('COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_TARGET_MISSING', { failoverSafe: false });
    const binding = previous.providerBinding;
    if (binding && binding.providerId !== PROVIDER_ID) {
      return failure('COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_PROVIDER_MISMATCH', { retryable: false, failoverSafe: true });
    }
    const boundInstanceId = providerInstanceId(binding?.providerSessionId);
    const selected = boundInstanceId ? { instanceId: boundInstanceId, ambiguous: false } : this.selectProviderInstance();
    if (!selected.instanceId) return failure('COMPUTER_CHATGPT_EXTENSION_PROVIDER_INSTANCE_AMBIGUOUS', { failoverSafe: false });
    await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => { lease.clearBinding(); });
    const record = await this.bindAsync(identity, binding, selected.instanceId);
    this.authority.tombstoneSurface(this.controllerHome, targetId);
    return { state: 'ready', target: this.target(identity, record, selected.instanceId) };
  }

  async cleanup(activeResourceKeys: readonly string[]): Promise<void> {
    const active = new Set(activeResourceKeys);
    for (const record of this.authority.listAllSurfaces(this.controllerHome)) {
      const resource = record.stableIdentity.resource;
      if (!resource || !['chatgpt.conversation', 'chatgpt.bootstrap'].includes(resource.namespace)) continue;
      if (record.providerBinding?.providerId !== PROVIDER_ID || active.has(`${resource.namespace}:${resource.key}`)) continue;
      const compatibility = record.compatibilityRecords.find((entry) => entry.namespace === 'chatgpt.target')?.value as Record<string, unknown> | undefined;
      const identity: ComputerChatgptTargetIdentity | undefined = resource.namespace === 'chatgpt.conversation'
        ? (typeof compatibility?.canonicalUrl === 'string' ? { namespace: 'chatgpt.conversation', conversationId: resource.key, canonicalUrl: compatibility.canonicalUrl } : undefined)
        : (typeof compatibility?.projectUrl === 'string' ? { namespace: 'chatgpt.bootstrap', bootstrapKey: resource.key, projectUrl: compatibility.projectUrl } : undefined);
      const instanceId = providerInstanceId(record.providerBinding?.providerSessionId);
      if (identity && instanceId && this.providerIsFresh(instanceId)) await this.submit(instanceId, { kind: 'close', identity }).catch(() => undefined);
      await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => { lease.clearBinding(); }).catch(() => undefined);
      if (resource.namespace === 'chatgpt.bootstrap') this.authority.tombstoneSurface(this.controllerHome, record.targetId);
    }
  }

  async release(targetId: string): Promise<void> {
    const record = this.authority.getSurface(this.controllerHome, targetId);
    if (!record || (record.providerBinding && record.providerBinding.providerId !== PROVIDER_ID)) return;
    const resource = record.stableIdentity.resource;
    const compatibility = record.compatibilityRecords.find((entry) => entry.namespace === 'chatgpt.target')?.value as Record<string, unknown> | undefined;
    const identity: ComputerChatgptTargetIdentity | undefined = resource?.namespace === 'chatgpt.conversation' && typeof compatibility?.canonicalUrl === 'string'
      ? { namespace: 'chatgpt.conversation', conversationId: resource.key, canonicalUrl: compatibility.canonicalUrl }
      : resource?.namespace === 'chatgpt.bootstrap' && typeof compatibility?.projectUrl === 'string'
        ? { namespace: 'chatgpt.bootstrap', bootstrapKey: resource.key, projectUrl: compatibility.projectUrl }
        : undefined;
    const instanceId = providerInstanceId(record.providerBinding?.providerSessionId);
    if (identity && instanceId && this.providerIsFresh(instanceId)) await this.submit(instanceId, { kind: 'close', identity }).catch(() => undefined);
    await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => { lease.clearBinding(); }).catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ claimed: entry.claimed, result: entry.command.kind === 'dispatch' && entry.claimed
        ? { kind: 'dispatch', mutation: 'attempted' }
        : { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_RUNTIME_CLOSED', retryable: true } });
    }
    this.pending.clear();
    this.queues.clear();
    this.providerStates.clear();
  }
}
