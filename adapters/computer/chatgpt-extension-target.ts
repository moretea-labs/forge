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

type PendingCommand = {
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

function normalizeBinding(binding: ComputerSurfaceProviderBinding | undefined): ComputerSurfaceProviderBinding | undefined {
  if (!binding) return undefined;
  if (binding.providerId !== PROVIDER_ID || !binding.windowId || !binding.tabId) return undefined;
  return {
    providerId: PROVIDER_ID,
    observedAt: binding.observedAt || new Date().toISOString(),
    ...(binding.browserProduct ? { browserProduct: binding.browserProduct } : { browserProduct: 'chrome' }),
    windowId: String(binding.windowId),
    tabId: String(binding.tabId),
    ...(binding.ownerToken ? { ownerToken: binding.ownerToken } : {}),
  };
}

export class ChromeExtensionChatgptConversationTargetPort
implements ComputerChatgptConversationTargetPort, ComputerChatgptExtensionBrokerRpc {
  private heartbeatState?: { receivedAtMs: number; heartbeat: ComputerChatgptExtensionHeartbeat };
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queue: string[] = [];

  constructor(
    private readonly controllerHome: string,
    private readonly authority: ComputerInteractionTargetAuthorityPort,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  heartbeat(input: ComputerChatgptExtensionHeartbeat): void {
    const conversations = Array.isArray(input.conversations)
      ? input.conversations.flatMap((entry) => {
          if (!entry || typeof entry.conversationId !== 'string' || !entry.conversationId.trim() || typeof entry.canonicalUrl !== 'string' || !entry.canonicalUrl.trim()) return [];
          return [{
            conversationId: entry.conversationId.trim(),
            canonicalUrl: entry.canonicalUrl.trim(),
            ...(entry.title ? { title: String(entry.title).slice(0, 512) } : {}),
            ...(entry.projectTitle ? { projectTitle: String(entry.projectTitle).slice(0, 512) } : {}),
            ...(entry.projectUrl ? { projectUrl: String(entry.projectUrl) } : {}),
            ...(entry.isCurrent ? { isCurrent: true } : {}),
            ...(normalizeBinding(entry.providerBinding) ? { providerBinding: normalizeBinding(entry.providerBinding) } : {}),
          }];
        })
      : [];
    this.heartbeatState = {
      receivedAtMs: this.nowMs(),
      heartbeat: {
        providerId: PROVIDER_ID,
        observedAt: typeof input.observedAt === 'string' && input.observedAt ? input.observedAt : new Date(this.nowMs()).toISOString(),
        conversations,
      },
    };
  }

  claim(): ComputerChatgptExtensionCommand | undefined {
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      const entry = this.pending.get(id);
      if (!entry || entry.claimed) continue;
      entry.claimed = true;
      return structuredClone(entry.command);
    }
    return undefined;
  }

  complete(commandId: string, result: ComputerChatgptExtensionCommandResult): boolean {
    const entry = this.pending.get(commandId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.resolve({ claimed: entry.claimed, result: structuredClone(result) });
    return true;
  }

  private heartbeatFresh(): boolean {
    return Boolean(this.heartbeatState && this.nowMs() - this.heartbeatState.receivedAtMs <= HEARTBEAT_FRESH_MS);
  }

  private async submit(command: ComputerChatgptExtensionCommandInput): Promise<{ claimed: boolean; result?: ComputerChatgptExtensionCommandResult }> {
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
      this.pending.set(commandId, { command: full, claimed: false, resolve, timer });
      this.queue.push(commandId);
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

  private async bindAsync(identity: ComputerChatgptTargetIdentity, binding: ComputerSurfaceProviderBinding | undefined): Promise<ComputerSurfaceTarget> {
    const record = this.upsert(identity);
    const normalized = normalizeBinding(binding);
    if (!normalized) return record;
    return await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => lease.bind(normalized));
  }

  private target(identity: ComputerChatgptTargetIdentity, record: ComputerSurfaceTarget): ComputerChatgptConversationTarget {
    return {
      targetId: record.targetId,
      identity,
      observe: async (options) => {
        const response = await this.submit({ kind: 'observe', identity, ...(options ? { options } : {}) });
        if (!response.result) throw new Error(response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_OBSERVATION_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED');
        if (response.result.kind === 'observation') {
          if (response.result.providerBinding) await this.bindAsync(identity, response.result.providerBinding);
          return response.result.observation;
        }
        if (response.result.kind === 'failed') throw new Error(response.result.code);
        throw new Error('COMPUTER_CHATGPT_EXTENSION_OBSERVATION_INVALID');
      },
      dispatch: async (prompt, options) => {
        const response = await this.submit({ kind: 'dispatch', identity, prompt, ...(options?.mode ? { mode: options.mode } : {}) });
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
    if (!this.heartbeatFresh() || !this.heartbeatState) {
      return { conversations: [], complete: false, unavailableProviders: [PROVIDER_ID] };
    }
    return {
      conversations: this.heartbeatState.heartbeat.conversations.map(({ providerBinding: _binding, ...entry }) => entry),
      complete: true,
      unavailableProviders: [],
    };
  }

  async ensureExact(identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    if (!this.heartbeatFresh() || !this.heartbeatState) return failure('COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED', { failoverSafe: true });
    const exact = this.heartbeatState.heartbeat.conversations.filter((entry) => entry.conversationId === identity.conversationId);
    if (exact.length > 1) return failure('COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_AMBIGUOUS', { failoverSafe: false });
    if (exact.length === 1) {
      const record = await this.bindAsync(identity, exact[0]!.providerBinding);
      return { state: 'ready', target: this.target(identity, record) };
    }
    const response = await this.submit({ kind: 'ensure', identity });
    if (!response.result) return failure(
      response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_TARGET_OPEN_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
      { failoverSafe: !response.claimed },
    );
    if (response.result.kind === 'ensured') {
      const record = await this.bindAsync(identity, response.result.providerBinding);
      return { state: 'ready', target: this.target(identity, record), ...(response.result.observation ? { observation: response.result.observation } : {}) };
    }
    if (response.result.kind === 'failed') return failure(response.result.code, { retryable: response.result.retryable, failoverSafe: response.result.failoverSafe !== false, humanAction: response.result.humanAction });
    return failure('COMPUTER_CHATGPT_EXTENSION_ENSURE_INVALID', { failoverSafe: true });
  }

  async openBootstrap(projectUrl: string, bootstrapKey: string): Promise<ComputerChatgptTargetResult> {
    if (!this.heartbeatFresh()) return failure('COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED', { failoverSafe: true });
    const identity: ComputerChatgptBootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl };
    const response = await this.submit({ kind: 'ensure', identity });
    if (!response.result) return failure(
      response.claimed ? 'COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_OPEN_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
      { failoverSafe: !response.claimed },
    );
    if (response.result.kind === 'ensured') {
      const record = await this.bindAsync(identity, response.result.providerBinding);
      return { state: 'ready', target: this.target(identity, record), ...(response.result.observation ? { observation: response.result.observation } : {}) };
    }
    if (response.result.kind === 'failed') return failure(response.result.code, { retryable: response.result.retryable, failoverSafe: response.result.failoverSafe !== false, humanAction: response.result.humanAction });
    return failure('COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_INVALID', { failoverSafe: true });
  }

  async findBySubmittedMarker(marker: string, bootstrapKey?: string, betweenObservations?: () => Promise<void>): Promise<ComputerChatgptTargetResult[]> {
    await betweenObservations?.();
    if (!this.heartbeatFresh()) return [];
    const response = await this.submit({ kind: 'find_marker', marker, ...(bootstrapKey ? { bootstrapKey } : {}) });
    await betweenObservations?.();
    if (response.result?.kind !== 'marker_matches') return [];
    const results: ComputerChatgptTargetResult[] = [];
    for (const match of response.result.matches) {
      const record = await this.bindAsync(match.identity, match.providerBinding);
      results.push({ state: 'ready', target: this.target(match.identity, record), observation: match.observation });
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
    await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => { lease.clearBinding(); });
    const record = await this.bindAsync(identity, binding);
    this.authority.tombstoneSurface(this.controllerHome, targetId);
    return { state: 'ready', target: this.target(identity, record) };
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
      if (identity && this.heartbeatFresh()) await this.submit({ kind: 'close', identity }).catch(() => undefined);
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
    if (identity && this.heartbeatFresh()) await this.submit({ kind: 'close', identity }).catch(() => undefined);
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
    this.queue.length = 0;
  }
}
