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
  // Process-local physical-operation singleflight, not a second tab lifecycle
  // authority. Exact Surface binding/CAS remains the only durable owner.
  private readonly retiring = new Map<string, Promise<boolean>>();

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
    if (preferredInstanceId) {
      // A disconnected profile is unavailable, not permission to switch to
      // the only other signed-in (or signed-out) Chrome instance.
      return { ...(fresh.some(([instanceId]) => instanceId === preferredInstanceId)
        ? { instanceId: preferredInstanceId } : {}), ambiguous: false };
    }
    // Foreground tab is not a durable browser-principal binding. If more
    // than one Extension instance is connected, require a known pin instead
    // of guessing which profile should receive a new Supervisor effect.
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
    return await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => {
      const previous = lease.current().providerBinding;
      // Heartbeat inventory omits the Forge-create token. Carry it forward only
      // for the same exact physical attachment; never transfer it to a new tab.
      const sameAttachment = previous?.providerId === normalized.providerId
        && previous.providerSessionId === normalized.providerSessionId
        && previous.browserProduct === normalized.browserProduct
        && previous.windowId === normalized.windowId
        && previous.tabId === normalized.tabId;
      return lease.bind({
        ...normalized,
        ...(normalized.ownerToken ? {} : sameAttachment && previous?.ownerToken ? { ownerToken: previous.ownerToken } : {}),
      });
    });
  }

  private target(identity: ComputerChatgptTargetIdentity, record: ComputerSurfaceTarget, instanceId: string): ComputerChatgptConversationTarget {
    return {
      targetId: record.targetId,
      identity,
      observe: async (options) => {
        const response = await this.submit(instanceId, { kind: 'observe', identity, ...(record.providerBinding ? { providerBinding: record.providerBinding } : {}), ...(options ? { options } : {}) });
        if (!response.result) throw new Error(response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_OBSERVATION_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED');
        if (response.result.kind === 'observation') {
          if (response.result.providerBinding) {
            const observed = normalizeBinding(response.result.providerBinding, instanceId);
            const saved = this.authority.getSurface(this.controllerHome, record.targetId)?.providerBinding;
            // A newer observedAt is not a new physical binding. Normal reads
            // must not rewrite the Surface and its binding indexes on every poll.
            if (!observed || !saved || saved.providerId !== observed.providerId
              || saved.providerSessionId !== observed.providerSessionId
              || saved.browserProduct !== observed.browserProduct
              || saved.windowId !== observed.windowId || saved.tabId !== observed.tabId
              || (observed.ownerToken && saved.ownerToken !== observed.ownerToken)) {
              await this.bindAsync(identity, response.result.providerBinding, instanceId);
            }
          }
          return response.result.observation;
        }
        if (response.result.kind === 'failed') throw new Error(response.result.code);
        throw new Error('COMPUTER_CHATGPT_EXTENSION_OBSERVATION_INVALID');
      },
      prepare: async (prompt, options) => {
        const response = await this.submit(instanceId, { kind: 'prepare', identity, ...(record.providerBinding ? { providerBinding: record.providerBinding } : {}), prompt,
          ...(options?.mode ? { mode: options.mode } : {}),
        });
        if (!response.result) return { ready: false, reasonCode: response.claimed
          ? 'COMPUTER_CHATGPT_EXTENSION_PREPARE_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED' };
        if (response.result.kind === 'prepared') {
          if (!response.result.ready) return { ready: false, reasonCode: response.result.reasonCode };
          return { ready: true };
        }
        return { ready: false, reasonCode: response.result.kind === 'failed'
          ? response.result.code : 'COMPUTER_CHATGPT_EXTENSION_PREPARE_INVALID' };
      },
      dispatch: async (prompt, options) => {
        const response = await this.submit(instanceId, { kind: 'dispatch', identity, ...(record.providerBinding ? { providerBinding: record.providerBinding } : {}), prompt, ...(options?.mode ? { mode: options.mode } : {}) });
        if (!response.result) {
          return response.claimed
            ? { mutation: 'attempted' as const }
            : { mutation: 'not_attempted' as const, reasonCode: 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED' };
        }
        if (response.result.kind === 'dispatch') {
          if (response.result.mutation === 'attempted') return { mutation: 'attempted' as const, ...(response.result.confirmed === undefined ? {} : { confirmed: response.result.confirmed }) };
          if (response.result.mutation === 'not_attempted') return { mutation: 'not_attempted' as const, reasonCode: response.result.reasonCode };
        }
        // Only a typed dispatch/not_attempted result proves no Send click. A
        // generic failure or wrong response kind cannot authorize another send.
        return { mutation: 'attempted' as const, confirmed: false };
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

  async ensureExact(identity: ComputerChatgptConversationIdentity, options: { createIfMissing?: boolean } = {}, recoverStalePin = true): Promise<ComputerChatgptTargetResult> {
    const preferredInstanceId = this.preferredProviderInstance(identity);
    const fresh = this.freshProviders();
    if (fresh.length === 0 || (preferredInstanceId && !fresh.some(([instanceId]) => instanceId === preferredInstanceId))) {
      return failure('COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED', { failoverSafe: !preferredInstanceId });
    }
    const exact = fresh.filter(([instanceId]) => !preferredInstanceId || instanceId === preferredInstanceId)
      .flatMap(([instanceId, state]) => state.heartbeat.conversations
      .filter((entry) => entry.conversationId === identity.conversationId)
      .map((entry) => ({ instanceId, entry })));
    // Multiple tabs can show one conversation. Prefer the existing exact
    // Computer binding over heartbeat focus or an arbitrary matching tab.
    const binding = this.authority.findSurfaceByStableIdentity(this.controllerHome, stableIdentity(identity))?.providerBinding;
    let candidates = exact;
    if (binding?.providerId === PROVIDER_ID && binding.windowId && binding.tabId) {
      const bound = exact.filter(({ instanceId, entry }) => instanceId === binding.providerSessionId
        && entry.providerBinding?.tabId === binding.tabId
        && (!binding.browserProduct || entry.providerBinding?.browserProduct === binding.browserProduct));
      // Chrome restart replaces physical tab IDs, not the profile principal or
      // conversation identity. A unique exact tab observed by that SAME live
      // provider may replace an absent pin through the Surface lease below.
      // Never choose between multiple matching tabs or switch browser profiles.
      const replacement = exact.length === 1 && exact[0]!.instanceId === binding.providerSessionId
        && (!binding.browserProduct || exact[0]!.entry.providerBinding?.browserProduct === binding.browserProduct)
        ? exact : [];
      candidates = bound.length ? bound : replacement;
    }
    // A stale binding must not turn two observed exact tabs into a third tab.
    if (exact.length > 1 && candidates.length !== 1) return failure('COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_AMBIGUOUS', { failoverSafe: false });
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      if (!candidate.entry.providerBinding) return failure('COMPUTER_CHATGPT_EXTENSION_PHYSICAL_TAB_UNVERIFIED', { failoverSafe: false });
      const record = await this.bindAsync(identity, candidate.entry.providerBinding, candidate.instanceId);
      const target = this.target(identity, record, candidate.instanceId);
      try {
        const observation = await target.observe({ includeUserHistory: false, includePageText: false });
        if (!conversationContentAvailable(observation)) {
          return failure('COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', { failoverSafe: false });
        }
        return { state: 'ready', target, observation };
      } catch (error) {
        return failure(
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : 'COMPUTER_CHATGPT_EXTENSION_OBSERVATION_UNAVAILABLE',
          { failoverSafe: false },
        );
      }
    }
    // A heartbeat is an inventory hint, not the exact-target authority.
    // When it has no match, let the SAME live Chrome instance perform one
    // read-only physical-tab lookup. This does not create a tab or replay Send;
    // the provider refuses ambiguous matches and drifted pinned tabs.
    if (options.createIfMissing === false) {
      const selected = this.selectProviderInstance(preferredInstanceId);
      if (!selected.instanceId) return failure(
        selected.ambiguous ? 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_INSTANCE_AMBIGUOUS' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
        { failoverSafe: false },
      );
      const response = await this.submit(selected.instanceId, { kind: 'observe', identity,
        ...(binding?.providerId === PROVIDER_ID ? { providerBinding: binding } : {}),
        options: { includeUserHistory: false, includePageText: false },
      });
      if (!response.result) return failure('COMPUTER_CHATGPT_EXTENSION_OBSERVATION_UNAVAILABLE', { failoverSafe: false });
      if (response.result.kind === 'observation') {
        const { observation, providerBinding } = response.result;
        let exactUrl = false;
        try {
          const parsed = new URL(observation.url);
          exactUrl = parsed.origin === 'https://chatgpt.com'
            && parsed.pathname.endsWith(`/c/${identity.conversationId}`);
        } catch { /* Never bind an unparseable or changed conversation target. */ }
        if (!exactUrl || !providerBinding) return failure('COMPUTER_CHATGPT_EXTENSION_TARGET_IDENTITY_UNVERIFIED', { failoverSafe: false });
        if (!conversationContentAvailable(observation)) return failure('COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', { failoverSafe: false });
        const record = await this.bindAsync(identity, providerBinding, selected.instanceId);
        return { state: 'ready', target: this.target(identity, record, selected.instanceId), observation };
      }
      return failure(response.result.kind === 'failed'
        ? response.result.code === 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING'
          ? 'COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_ABSENT_READ_ONLY'
          : response.result.code
        : 'COMPUTER_CHATGPT_EXTENSION_OBSERVATION_INVALID', { failoverSafe: false });
    }
    const selected = this.selectProviderInstance(preferredInstanceId);
    if (!selected.instanceId) {
      return failure(
        selected.ambiguous ? 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_INSTANCE_AMBIGUOUS' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
        { failoverSafe: !selected.ambiguous && !preferredInstanceId },
      );
    }
    const previous = this.authority.findSurfaceByStableIdentity(this.controllerHome, stableIdentity(identity));
    const response = await this.submit(selected.instanceId, { kind: 'ensure', identity,
      ...(previous?.providerBinding?.providerId === PROVIDER_ID ? { providerBinding: previous.providerBinding } : {}),
    });
    if (!response.result) return failure(
      response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_TARGET_OPEN_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
      { failoverSafe: !response.claimed && !preferredInstanceId },
    );
    if (response.result.kind === 'ensured') {
      const record = await this.bindAsync(identity, response.result.providerBinding, selected.instanceId);
      if (response.result.observation && !conversationContentAvailable(response.result.observation)) {
        return failure('COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', { failoverSafe: false });
      }
      return { state: 'ready', target: this.target(identity, record, selected.instanceId), ...(response.result.observation ? { observation: response.result.observation } : {}) };
    }
    if (response.result.kind === 'failed') {
      // A pinned Chrome tab can still exist after the user navigates it to
      // another conversation. The extension proves this is pre-mutation
      // identity drift; never navigate or close the foreign tab. Release only
      // the exact stale Surface binding through its existing CAS lease, then
      // let the SAME provider resolve one unambiguous exact conversation.
      if (recoverStalePin
        && response.result.code === 'COMPUTER_CHATGPT_EXTENSION_PINNED_TAB_IDENTITY_CHANGED'
        && previous && binding?.providerId === PROVIDER_ID
        && binding.providerSessionId === selected.instanceId
        && binding.windowId && binding.tabId) {
        try {
          await this.authority.withSurfaceLease(this.controllerHome, previous.targetId, async (lease) => {
            const current = lease.current();
            const attached = current.providerBinding;
            if (current.stableIdentity.resource?.namespace !== identity.namespace
              || current.stableIdentity.resource.key !== identity.conversationId
              || attached?.providerId !== binding.providerId
              || attached.providerSessionId !== binding.providerSessionId
              || attached.windowId !== binding.windowId
              || attached.tabId !== binding.tabId
              || attached.browserProduct !== binding.browserProduct) {
              throw new Error('COMPUTER_CHATGPT_EXTENSION_PINNED_BINDING_CHANGED');
            }
            lease.clearBinding();
          });
        } catch {
          return failure('COMPUTER_CHATGPT_EXTENSION_PINNED_BINDING_CHANGED', { failoverSafe: false });
        }
        // The provider still enforces exact URL uniqueness and an unspent
        // Send generation; a second drift never loops into another recovery.
        return await this.ensureExact(identity, options, false);
      }
      if (response.result.providerBinding) await this.bindAsync(identity, response.result.providerBinding, selected.instanceId);
      return failure(response.result.code, { retryable: response.result.retryable,
        failoverSafe: !response.result.providerBinding && !preferredInstanceId && response.result.failoverSafe === true,
        humanAction: response.result.humanAction });
    }
    return failure('COMPUTER_CHATGPT_EXTENSION_ENSURE_INVALID', { failoverSafe: false });
  }

  async openBootstrap(projectUrl: string, bootstrapKey: string, recoverStalePin = true): Promise<ComputerChatgptTargetResult> {
    const identity: ComputerChatgptBootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl };
    const previous = this.authority.findSurfaceByStableIdentity(this.controllerHome, stableIdentity(identity));
    const binding = previous?.providerBinding;
    // Existing bootstrap tab identity survives extension reconnects. A foreign
    // provider owns its tab; extension must not create another one for the
    // same task. Conversely, extension absence cannot authorize native tab
    // creation while an extension-owned tab might still exist.
    if (binding && binding.providerId !== PROVIDER_ID) {
      return failure('COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_PROVIDER_MISMATCH', { retryable: false, failoverSafe: true });
    }
    const selected = this.selectProviderInstance(this.preferredProviderInstance(identity));
    if (!selected.instanceId) {
      return failure(
        selected.ambiguous ? 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_INSTANCE_AMBIGUOUS' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
        { failoverSafe: !selected.ambiguous && !binding },
      );
    }
    // Controller's exact tab attachment, not the Project URL, is recovery
    // authority after a worker restart.
    const response = await this.submit(selected.instanceId, { kind: 'ensure', identity,
      ...(previous?.providerBinding?.providerId === PROVIDER_ID ? { providerBinding: previous.providerBinding } : {}),
    });
    if (!response.result) return failure(
      response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_OPEN_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
      { failoverSafe: !response.claimed && !binding },
    );
    if (response.result.kind === 'ensured') {
      const record = await this.bindAsync(identity, response.result.providerBinding, selected.instanceId);
      return { state: 'ready', target: this.target(identity, record, selected.instanceId), ...(response.result.observation ? { observation: response.result.observation } : {}) };
    }
    if (response.result.kind === 'failed') {
      if (response.result.providerBinding) await this.bindAsync(identity, response.result.providerBinding, selected.instanceId);
      // Only openBootstrap's pre-dispatch caller may rebuild a tab attachment.
      // The SAME live Chrome provider must prove that the exact pinned tab is
      // either absent or now serves a DIFFERENT Project. A reused physical tab
      // id is not a valid target and must not permanently strand the unspent
      // bootstrap. Never close/navigate the mismatched foreign tab. Keep the
      // one durable target and lease/CAS-clear only its stale binding; never
      // recover from an unknown tab-create result or switch profiles/providers.
      if (recoverStalePin && (response.result.code === 'COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING'
        || response.result.code === 'COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_IDENTITY_CHANGED')
        && previous && binding?.providerId === PROVIDER_ID
        && providerInstanceId(binding.providerSessionId) === selected.instanceId
        && binding.windowId && binding.tabId) {
        try {
          await this.authority.withSurfaceLease(this.controllerHome, previous.targetId, async (lease) => {
            const current = lease.current();
            const attached = current.providerBinding;
            if (current.stableIdentity.resource?.namespace !== identity.namespace
              || current.stableIdentity.resource.key !== identity.bootstrapKey
              || attached?.providerId !== binding.providerId
              || attached.providerSessionId !== binding.providerSessionId
              || attached.windowId !== binding.windowId || attached.tabId !== binding.tabId
              || attached.browserProduct !== binding.browserProduct) {
              throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_BINDING_CHANGED');
            }
            lease.clearBinding();
          });
        } catch {
          return failure('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_BINDING_CHANGED', { failoverSafe: false });
        }
        // Exactly one same-provider re-open. A claimed but unanswered tabCreate
        // still reports outcome unknown and must never create another tab.
        return await this.openBootstrap(projectUrl, bootstrapKey, false);
      }
      return failure(response.result.code, {
        retryable: response.result.retryable, failoverSafe: response.result.failoverSafe === true && !binding && !response.result.providerBinding,
        humanAction: response.result.humanAction,
      });
    }
    return failure('COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_INVALID', { failoverSafe: false });
  }

  async findBySubmittedMarker(marker: string, bootstrapKey?: string, betweenObservations?: () => Promise<void>): Promise<ComputerChatgptTargetResult[]> {
    await betweenObservations?.();
    // Reconcile the Controller's one physical bootstrap pin first. Its
    // persisted exact Project URL is required for read-only receiver repair.
    const bootstrapSurface = bootstrapKey ? this.authority.findSurfaceByStableIdentity(this.controllerHome, {
      surfaceType: 'browser-tab', ownership: 'provider_owned',
      resource: { namespace: 'chatgpt.bootstrap', key: bootstrapKey },
    }) : undefined;
    const bootstrapMetadata = bootstrapSurface?.compatibilityRecords.find((entry) => entry.namespace === 'chatgpt.target')?.value as Record<string, unknown> | undefined;
    const bootstrapIdentity = bootstrapKey && typeof bootstrapMetadata?.projectUrl === 'string' && bootstrapMetadata.projectUrl
      ? { namespace: 'chatgpt.bootstrap' as const, bootstrapKey, projectUrl: bootstrapMetadata.projectUrl }
      : undefined;
    const bootstrapPin = bootstrapSurface?.providerBinding;
    const fresh = this.freshProviders();
    if (fresh.length === 0) return [];
    const responses = await Promise.all(fresh.map(async ([instanceId]) => ({
      instanceId,
      response: await this.submit(instanceId, { kind: 'find_marker', marker,
        ...(bootstrapKey ? { bootstrapKey } : {}),
        ...(bootstrapIdentity && bootstrapPin?.providerId === PROVIDER_ID && bootstrapPin.providerSessionId === instanceId
          ? { identity: bootstrapIdentity, providerBinding: bootstrapPin } : {}),
      }),
    })));
    await betweenObservations?.();
    const results: ComputerChatgptTargetResult[] = [];
    type MarkerMatch = Extract<ComputerChatgptExtensionCommandResult, { kind: 'marker_matches' }>['matches'][number];
    const matchesByConversation = new Map<string, Array<{ instanceId: string; match: MarkerMatch }>>();
    for (const { instanceId, response } of responses) {
      if (response.result?.kind !== 'marker_matches') continue;
      for (const match of response.result.matches) {
        const entries = matchesByConversation.get(match.identity.conversationId) ?? [];
        entries.push({ instanceId, match });
        matchesByConversation.set(match.identity.conversationId, entries);
      }
    }
    for (const matches of matchesByConversation.values()) {
      const first = matches[0]!;
      const existing = this.authority.findSurfaceByStableIdentity(this.controllerHome, stableIdentity(first.match.identity))?.providerBinding;
      const samePhysicalBinding = (match: MarkerMatch, binding: NonNullable<typeof existing>, instanceId: string): boolean => {
        const observed = match.providerBinding;
        return Boolean(observed
          && observed.providerId === binding.providerId
          && observed.providerSessionId === binding.providerSessionId
          && observed.browserProduct === binding.browserProduct
          && observed.windowId === binding.windowId
          && observed.tabId === binding.tabId
          && observed.ownerToken === binding.ownerToken
          && instanceId === binding.providerSessionId);
      };
      const existingMatch = existing?.providerId === PROVIDER_ID
        ? matches.find(({ instanceId, match }) => samePhysicalBinding(match, existing, instanceId))
        : undefined;
      const bootstrap = bootstrapKey
        ? this.authority.findSurfaceByStableIdentity(this.controllerHome, {
            surfaceType: 'browser-tab', ownership: 'provider_owned',
            resource: { namespace: 'chatgpt.bootstrap', key: bootstrapKey },
          })
        : undefined;
      const pinned = bootstrap?.providerBinding;
      const bootstrapMatch = pinned?.providerId === PROVIDER_ID
        ? matches.find(({ instanceId, match }) => samePhysicalBinding(match, pinned, instanceId))
        : undefined;
      // A task-specific bootstrap pin outranks a conversation surface for the
      // same conversationId. If that exact physical pin is absent, preserve the
      // unknown outcome instead of letting another tab's marker become authority.
      if (pinned && !bootstrapMatch) continue;
      const candidate = pinned
        ? bootstrapMatch
        : existingMatch ?? (matches.length === 1 && first.match.providerBinding ? first : undefined);
      const bootstrapMatchBinding = bootstrapMatch?.match.providerBinding;
      const existingMatchesBootstrap = Boolean(existingMatch && bootstrapMatch && bootstrapMatchBinding
        && existingMatch.instanceId === bootstrapMatch.instanceId
        && samePhysicalBinding(existingMatch.match, bootstrapMatchBinding, existingMatch.instanceId));
      // Resolve duplicate marker tabs only with an exact persisted physical pin.
      // A bootstrap pin already owns its tab: return that target so the caller
      // can promote it, instead of prematurely binding a second conversation
      // Surface to the same tab and hitting COMPUTER_SURFACE_INDEX_CONFLICT.
      if (!candidate) continue;
      if (bootstrap && candidate === bootstrapMatch && !existingMatchesBootstrap) {
        const metadata = bootstrap.compatibilityRecords.find((entry) => entry.namespace === 'chatgpt.target')?.value as Record<string, unknown> | undefined;
        if (typeof metadata?.projectUrl !== 'string' || !metadata.projectUrl) continue;
        const identity: ComputerChatgptBootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey: bootstrapKey!, projectUrl: metadata.projectUrl };
        results.push({ state: 'ready', target: this.target(identity, bootstrap, candidate.instanceId), observation: candidate.match.observation });
        continue;
      }
      const record = await this.bindAsync(candidate.match.identity, candidate.match.providerBinding, candidate.instanceId);
      results.push({ state: 'ready', target: this.target(candidate.match.identity, record, candidate.instanceId), observation: candidate.match.observation });
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

  /** Existing Surface binding is the only retirement authority. A claimed
   * Chrome close with missing acknowledgement is outcome-unknown: retain the
   * exact attachment so the same owner can reconcile/retry, never make it
   * eligible for another physical owner by clearing the index prematurely. */
  private retirePhysicalBinding(record: ComputerSurfaceTarget, identity?: ComputerChatgptTargetIdentity): Promise<boolean> {
    const existing = this.retiring.get(record.targetId);
    if (existing) return existing;
    const pending = this.retirePhysicalBindingOnce(record, identity);
    this.retiring.set(record.targetId, pending);
    const release = (): void => {
      if (this.retiring.get(record.targetId) === pending) this.retiring.delete(record.targetId);
    };
    void pending.then(release, release);
    return pending;
  }

  private async retirePhysicalBindingOnce(record: ComputerSurfaceTarget, identity?: ComputerChatgptTargetIdentity): Promise<boolean> {
    const previous = record.providerBinding;
    if (previous?.providerId !== PROVIDER_ID) return false;
    const resource = record.stableIdentity.resource;
    if (previous.ownerToken) {
      const instanceId = providerInstanceId(previous.providerSessionId);
      if (!identity || !instanceId || !this.providerIsFresh(instanceId)) return false;
      if ([...this.pending.values()].some((entry) => 'identity' in entry.command
        && entry.command.identity !== undefined
        && entry.command.kind !== 'close'
        && entry.command.identity.namespace === resource?.namespace
        && (entry.command.identity.namespace === 'chatgpt.conversation'
          ? entry.command.identity.conversationId === resource?.key
          : entry.command.identity.namespace === 'chatgpt.bootstrap' && entry.command.identity.bootstrapKey === resource?.key))) return false;
      let acknowledged = false;
      try {
        const response = await this.submit(instanceId, { kind: 'close', identity, providerBinding: previous });
        acknowledged = response.result?.kind === 'closed';
      } catch { return false; }
      if (!acknowledged) return false;
    }
    // A legacy or user-attached tab has no Forge-create token: detach only,
    // never turn a matching ChatGPT URL into permission for physical closure.
    let cleared = false;
    try {
      await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => {
        const binding = lease.current().providerBinding;
        if (binding?.providerId !== previous.providerId
          || binding.providerSessionId !== previous.providerSessionId
          || binding.browserProduct !== previous.browserProduct
          || binding.windowId !== previous.windowId || binding.tabId !== previous.tabId
          || binding.ownerToken !== previous.ownerToken) return;
        lease.clearBinding();
        cleared = true;
      });
    } catch { return false; }
    return cleared;
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
      const cleared = await this.retirePhysicalBinding(record, identity);
      if (cleared && resource.namespace === 'chatgpt.bootstrap') this.authority.tombstoneSurface(this.controllerHome, record.targetId);
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
    if (record.providerBinding) await this.retirePhysicalBinding(record, identity);
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
