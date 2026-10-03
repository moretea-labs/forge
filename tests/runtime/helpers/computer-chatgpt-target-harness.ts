import type {
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationObservation,
  ComputerChatgptConversationObservationOptions,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptTargetIdentity,
  ComputerChatgptTargetResult,
} from '../../../packages/plugin-runtime/computer';
import { parseCanonicalChatgptConversationIdentity } from '../../../packages/plugin-runtime/computer';

export interface TestBrowserTabRef {
  windowId: string;
  tabId: string;
  browserProduct?: 'chrome' | 'vivaldi';
}

export interface TestBrowserTabInventoryEntry extends TestBrowserTabRef {
  url: string;
  title: string;
  active: boolean;
  frontmost?: boolean;
}

export interface TestBrowserPage {
  evaluate<T>(expression: string | ((...args: unknown[]) => unknown), arg?: unknown): Promise<T>;
  waitForSelector?(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  tabRef(): TestBrowserTabRef | undefined;
}

export interface TestComputerTargetHarnessDependencies {
  listTabs(): Promise<{ entries: TestBrowserTabInventoryEntry[]; unavailableProducts?: string[] }>;
  reattach(ref: TestBrowserTabRef): Promise<TestBrowserPage>;
  create(url: string): Promise<TestBrowserPage>;
  close(ref: TestBrowserTabRef): Promise<void>;
  readOwner?(page: TestBrowserPage): Promise<string>;
  writeOwner?(page: TestBrowserPage, marker: string): Promise<void>;
  snapshot(page: TestBrowserPage, options?: ComputerChatgptConversationObservationOptions): Promise<ComputerChatgptConversationObservation>;
  dispatchPrompt(
    page: TestBrowserPage,
    prompt: string,
    options?: { mode?: 'send' | 'resume' },
  ): Promise<{ dispatched: boolean; confirmed?: boolean; reason?: string }>;
}

type BoundTarget = {
  targetId: string;
  identity: ComputerChatgptTargetIdentity;
  page: TestBrowserPage;
};

function conversationIdentity(url: string): ComputerChatgptConversationIdentity | undefined {
  try {
    const parsed = parseCanonicalChatgptConversationIdentity(url);
    return {
      namespace: 'chatgpt.conversation',
      conversationId: parsed.conversationId,
      canonicalUrl: parsed.conversationUrl,
    };
  } catch {
    return undefined;
  }
}

function targetKey(identity: ComputerChatgptTargetIdentity): string {
  return identity.namespace === 'chatgpt.conversation'
    ? `chatgpt.conversation:${identity.conversationId}`
    : `chatgpt.bootstrap:${identity.bootstrapKey}`;
}

export function createTestChatgptTargetPort(
  deps: TestComputerTargetHarnessDependencies,
): ComputerChatgptConversationTargetPort {
  const bound = new Map<string, BoundTarget>();

  const wrap = (entry: BoundTarget): ComputerChatgptConversationTarget => ({
    targetId: entry.targetId,
    identity: entry.identity,
    observe: async (options) => await deps.snapshot(entry.page, options),
    dispatch: async (prompt, options) => {
      const result = await deps.dispatchPrompt(entry.page, prompt, options);
      return result.dispatched
        ? { mutation: 'attempted' as const, ...(result.confirmed === undefined ? {} : { confirmed: result.confirmed }) }
        : { mutation: 'not_attempted' as const, reasonCode: result.reason ?? 'test_pre_mutation_rejection' };
    },
  });

  const bind = async (
    identity: ComputerChatgptTargetIdentity,
    page: TestBrowserPage,
    targetId = identity.namespace === 'chatgpt.conversation'
      ? `test-chatgpt-${identity.conversationId}`
      : `test-bootstrap-${identity.bootstrapKey}`,
  ): Promise<BoundTarget> => {
    await deps.writeOwner?.(page, `test-computer-target:${targetId}`);
    const entry = { targetId, identity, page };
    bound.set(targetId, entry);
    return entry;
  };

  const inventory = async (): Promise<ComputerChatgptConversationInventory> => {
    const raw = await deps.listTabs();
    return {
      conversations: raw.entries.flatMap((entry) => {
        const identity = conversationIdentity(entry.url);
        if (!identity) return [];
        return [{
          conversationId: identity.conversationId,
          canonicalUrl: identity.canonicalUrl,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.active && entry.frontmost ? { isCurrent: true } : {}),
        }];
      }),
      complete: (raw.unavailableProducts?.length ?? 0) === 0,
      unavailableProviders: raw.unavailableProducts ?? [],
    };
  };

  const ensureExact = async (identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> => {
    const targetId = `test-chatgpt-${identity.conversationId}`;
    const cached = bound.get(targetId);
    if (cached) return { state: 'ready', target: wrap(cached), observation: await deps.snapshot(cached.page, { includeUserHistory: false, includePageText: false }) };
    const raw = await deps.listTabs();
    const exact = raw.entries.filter((entry) => conversationIdentity(entry.url)?.conversationId === identity.conversationId);
    if (exact.length > 1) return { state: 'unavailable', failure: { code: 'COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN', retryable: true, phase: 'pre_mutation' } };
    if (exact.length === 1) {
      const page = await deps.reattach(exact[0]!);
      await deps.readOwner?.(page);
      const entry = await bind(identity, page, targetId);
      return { state: 'ready', target: wrap(entry), observation: await deps.snapshot(page, { includeUserHistory: false, includePageText: false }) };
    }
    if ((raw.unavailableProducts?.length ?? 0) > 0) {
      return { state: 'unavailable', failure: { code: 'WORKFLOW_SUPERVISOR_NATIVE_INVENTORY_INCOMPLETE', retryable: true, phase: 'pre_mutation' } };
    }
    const page = await deps.create(identity.canonicalUrl);
    const entry = await bind(identity, page, targetId);
    return { state: 'ready', target: wrap(entry), observation: await deps.snapshot(page, { includeUserHistory: false, includePageText: false }) };
  };

  return {
    inventory,
    ensureExact,
    async openBootstrap(projectUrl, bootstrapKey) {
      const identity = { namespace: 'chatgpt.bootstrap' as const, bootstrapKey, projectUrl };
      const targetId = `test-bootstrap-${bootstrapKey}`;
      const cached = bound.get(targetId);
      if (cached) return { state: 'ready', target: wrap(cached) };
      const raw = await deps.listTabs();
      const candidates = raw.entries.filter((entry) => entry.url === projectUrl);
      const page = candidates.length === 1 ? await deps.reattach(candidates[0]!) : await deps.create(projectUrl);
      const entry = await bind(identity, page, targetId);
      return { state: 'ready', target: wrap(entry) };
    },
    async findBySubmittedMarker(marker, bootstrapKey, betweenObservations) {
      const raw = await deps.listTabs();
      const matches: ComputerChatgptTargetResult[] = [];
      for (const tab of raw.entries) {
        const page = await deps.reattach(tab);
        await deps.readOwner?.(page);
        await betweenObservations?.();
        const observation = await deps.snapshot(page, { includeUserHistory: true, includePageText: false });
        await betweenObservations?.();
        const present = observation.latestUserText.includes(marker)
          || observation.userMessages?.some((message) => message.includes(marker)) === true;
        if (!present) continue;
        const conversation = conversationIdentity(observation.url);
        const identity: ComputerChatgptTargetIdentity | undefined = conversation
          ?? (bootstrapKey ? { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl: observation.url } : undefined);
        if (!identity) continue;
        const entry = await bind(identity, page);
        matches.push({ state: 'ready', target: wrap(entry), observation });
      }
      return matches;
    },
    async promoteBootstrap(targetId, identity) {
      const current = bound.get(targetId);
      if (!current) return { state: 'unavailable', failure: { code: 'TEST_BOOTSTRAP_TARGET_MISSING', retryable: true, phase: 'pre_mutation' } };
      bound.delete(targetId);
      const promoted = await bind(identity, current.page, `test-chatgpt-${identity.conversationId}`);
      return { state: 'ready', target: wrap(promoted), observation: await deps.snapshot(current.page, { includeUserHistory: false, includePageText: false }) };
    },
    async cleanup(activeResourceKeys) {
      const active = new Set(activeResourceKeys);
      for (const [targetId, entry] of [...bound.entries()]) {
        if (active.has(targetKey(entry.identity))) continue;
        const ref = entry.page.tabRef();
        if (ref) await deps.close(ref);
        bound.delete(targetId);
      }
    },
    async release(targetId) {
      const entry = bound.get(targetId);
      if (!entry) return;
      const ref = entry.page.tabRef();
      if (ref) await deps.close(ref);
      bound.delete(targetId);
    },
    async close() {
      // Mirrors production: a Runtime restart forgets the live attachment but
      // does not retire or close the exact ChatGPT conversation target.
      bound.clear();
    },
  };
}
