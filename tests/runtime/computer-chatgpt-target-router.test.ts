import { expect, test } from 'bun:test';
import type {
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptTargetResult,
} from '../../packages/plugin-runtime/computer';
import { PreferredChatgptConversationTargetPort } from '../../adapters/computer/chatgpt-target-router';

const identity: ComputerChatgptConversationIdentity = {
  namespace: 'chatgpt.conversation',
  conversationId: 'conversation-1',
  canonicalUrl: 'https://chatgpt.com/c/conversation-1',
};

const observation = {
  url: identity.canonicalUrl,
  title: 'Target',
  latestUserText: '',
  latestAssistantResponse: '',
  isGenerating: false,
  providerActivityText: '',
  providerFailureText: '',
};

function target(
  targetId: string,
  dispatch: ComputerChatgptConversationTarget['dispatch'],
): ComputerChatgptConversationTarget {
  return {
    targetId,
    identity,
    observe: async () => observation,
    prepare: async () => ({ ready: true }),
    dispatch,
  };
}

function port(input: {
  ensureExact: (identity: ComputerChatgptConversationIdentity) => Promise<ComputerChatgptTargetResult>;
  promoteBootstrap?: ComputerChatgptConversationTargetPort['promoteBootstrap'];
}): ComputerChatgptConversationTargetPort {
  const inventory: ComputerChatgptConversationInventory = { conversations: [], complete: true, unavailableProviders: [] };
  return {
    inventory: async () => inventory,
    ensureExact: input.ensureExact,
    openBootstrap: async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } }),
    findBySubmittedMarker: async () => [],
    promoteBootstrap: input.promoteBootstrap ?? (async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } })),
    cleanup: async () => undefined,
    release: async () => undefined,
    close: async () => undefined,
  };
}

test('Computer target router never transfers a not-attempted mutation to the compatibility provider', async () => {
  let compatibilityEnsures = 0;
  let compatibilityDispatches = 0;
  const primary = port({
    ensureExact: async () => ({
      state: 'ready',
      target: target('primary', async () => ({ mutation: 'not_attempted', reasonCode: 'extension_pre_mutation_rejection' })),
    }),
  });
  const compatibility = port({
    ensureExact: async () => {
      compatibilityEnsures += 1;
      return {
        state: 'ready',
        target: target('compatibility', async () => {
          compatibilityDispatches += 1;
          return { mutation: 'attempted', confirmed: true };
        }),
      };
    },
  });
  const router = new PreferredChatgptConversationTargetPort(primary, compatibility);
  const ready = await router.ensureExact(identity);
  expect(ready.state).toBe('ready');
  if (ready.state !== 'ready') throw new Error('target not ready');
  expect(await ready.target.dispatch('prompt')).toEqual({ mutation: 'not_attempted', reasonCode: 'extension_pre_mutation_rejection' });
  expect(compatibilityEnsures).toBe(0);
  expect(compatibilityDispatches).toBe(0);
});

test('Computer target router never crosses providers after primary may have mutated the conversation', async () => {
  let compatibilityEnsures = 0;
  let compatibilityDispatches = 0;
  const primary = port({
    ensureExact: async () => ({
      state: 'ready',
      target: target('primary', async () => ({ mutation: 'attempted' })),
    }),
  });
  const compatibility = port({
    ensureExact: async () => {
      compatibilityEnsures += 1;
      return {
        state: 'ready',
        target: target('compatibility', async () => {
          compatibilityDispatches += 1;
          return { mutation: 'attempted', confirmed: true };
        }),
      };
    },
  });
  const router = new PreferredChatgptConversationTargetPort(primary, compatibility);
  const ready = await router.ensureExact(identity);
  expect(ready.state).toBe('ready');
  if (ready.state !== 'ready') throw new Error('target not ready');
  expect(await ready.target.dispatch('prompt')).toEqual({ mutation: 'attempted' });
  expect(compatibilityEnsures).toBe(0);
  expect(compatibilityDispatches).toBe(0);
});


test('Computer target router uses the native transport when extension absence is safely pre-mutation', async () => {
  let compatibilityEnsures = 0;
  const primary = port({
    ensureExact: async () => ({
      state: 'unavailable',
      failure: {
        code: 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
        retryable: true,
        phase: 'pre_mutation',
        failoverSafe: true,
      },
    }),
  });
  const compatibility = port({
    ensureExact: async () => {
      compatibilityEnsures += 1;
      return { state: 'ready', target: target('compatibility', async () => ({ mutation: 'attempted' })) };
    },
  });
  const router = new PreferredChatgptConversationTargetPort(primary, compatibility);
  const result = await router.ensureExact(identity);
  expect(result.state).toBe('ready');
  expect(compatibilityEnsures).toBe(1);
});

test('native fallback honors mode but omits only unsupported reasoning, with no second dispatch', async () => {
  const calls: Array<{ prompt: string; options: unknown }> = [];
  const primary = port({ ensureExact: async () => ({ state: 'unavailable', failure: {
    code: 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED', retryable: true, phase: 'pre_mutation', failoverSafe: true,
  } }) });
  const native = port({ ensureExact: async () => ({ state: 'ready', target: target('native', async (prompt, options) => {
    calls.push({ prompt, options }); return { mutation: 'attempted', confirmed: true };
  }) }) });
  const selected = await new PreferredChatgptConversationTargetPort(primary, native).ensureExact(identity);
  expect(selected.state).toBe('ready');
  if (selected.state !== 'ready') throw new Error('target unavailable');
  expect(await selected.target.dispatch('exact effect', { mode: 'recover', reasoning: 'xhigh' })).toMatchObject({ mutation: 'attempted' });
  expect(calls).toEqual([{ prompt: 'exact effect', options: { mode: 'recover', reasoning: undefined } }]);
});

test('Computer target router refuses resource failover when primary open outcome is unknown', async () => {
  let compatibilityEnsures = 0;
  const primary = port({
    ensureExact: async () => ({
      state: 'unavailable',
      failure: {
        code: 'COMPUTER_CHATGPT_EXTENSION_TARGET_OPEN_OUTCOME_UNKNOWN',
        retryable: true,
        phase: 'pre_mutation',
        failoverSafe: false,
      },
    }),
  });
  const compatibility = port({
    ensureExact: async () => {
      compatibilityEnsures += 1;
      return { state: 'ready', target: target('compatibility', async () => ({ mutation: 'attempted' })) };
    },
  });
  const router = new PreferredChatgptConversationTargetPort(primary, compatibility);
  const result = await router.ensureExact(identity);
  expect(result).toEqual({
    state: 'unavailable',
    failure: {
      code: 'COMPUTER_CHATGPT_EXTENSION_TARGET_OPEN_OUTCOME_UNKNOWN',
      retryable: true,
      phase: 'pre_mutation',
      failoverSafe: false,
    },
  });
  expect(compatibilityEnsures).toBe(0);
});

test('Computer target router does not transfer bootstrap promotion to the compatibility provider', async () => {
  let compatibilityPromotions = 0;
  const primary = port({
    ensureExact: async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } }),
    promoteBootstrap: async () => ({
      state: 'unavailable',
      failure: {
        code: 'COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_PROVIDER_MISMATCH',
        retryable: false,
        phase: 'pre_mutation',
        failoverSafe: true,
      },
    }),
  });
  const compatibility = port({
    ensureExact: async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } }),
    promoteBootstrap: async () => {
      compatibilityPromotions += 1;
      return { state: 'ready', target: target('compatibility-promoted', async () => ({ mutation: 'attempted' })) };
    },
  });

  const router = new PreferredChatgptConversationTargetPort(primary, compatibility);
  const result = await router.promoteBootstrap('foreign-bootstrap-target', identity);

  expect(result).toEqual({
    state: 'unavailable',
    failure: {
      code: 'COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_PROVIDER_MISMATCH',
      retryable: false,
      phase: 'pre_mutation',
      failoverSafe: true,
    },
  });
  expect(compatibilityPromotions).toBe(0);
});

test('read-only native reattachment switches subsequent preparation and dispatch to the same durable target', async () => {
  let primaryDispatches = 0;
  let nativePrepares = 0;
  let nativeDispatches = 0;
  const primaryTarget = {
    ...target('shared-target', async () => { primaryDispatches += 1; return { mutation: 'attempted' as const }; }),
    observe: async () => { throw new Error('EXTENSION_CONTENT_DISCONNECTED'); },
  };
  const nativeTarget = {
    ...target('shared-target', async (_prompt: string, options) => {
      nativeDispatches += 1;
      expect(options).toEqual({ mode: 'recover', reasoning: undefined });
      return { mutation: 'attempted' as const, confirmed: true };
    }),
    prepare: async (_prompt: string, options: Parameters<ComputerChatgptConversationTarget['prepare']>[1]) => {
      nativePrepares += 1;
      expect(options).toEqual({ mode: 'recover', reasoning: undefined });
      return { ready: true as const };
    },
  };
  const primary = port({ ensureExact: async () => ({ state: 'ready', target: primaryTarget }) });
  const native = port({ ensureExact: async () => ({ state: 'ready', target: nativeTarget }) });
  const ensured = await new PreferredChatgptConversationTargetPort(primary, native).ensureExact(identity);
  expect(ensured.state).toBe('ready');
  if (ensured.state !== 'ready') throw new Error('target not ready');
  expect(await ensured.target.observe()).toEqual(observation);
  expect(await ensured.target.prepare('exact effect', { mode: 'recover', reasoning: 'xhigh' })).toEqual({ ready: true });
  expect(await ensured.target.dispatch('exact effect', { mode: 'recover', reasoning: 'xhigh' })).toMatchObject({ mutation: 'attempted', confirmed: true });
  expect(primaryDispatches).toBe(0);
  expect(nativePrepares).toBe(1);
  expect(nativeDispatches).toBe(1);
});

test('failed or foreign-target native observation never changes the bound sender', async () => {
  let primaryDispatches = 0;
  let nativeDispatches = 0;
  const primaryTarget = {
    ...target('bound-target', async () => { primaryDispatches += 1; return { mutation: 'not_attempted' as const, reasonCode: 'preflight_rejected' }; }),
    observe: async () => { throw new Error('EXTENSION_OBSERVATION_UNAVAILABLE'); },
  };
  const native = port({ ensureExact: async () => ({
    state: 'ready', target: target('foreign-target', async () => { nativeDispatches += 1; return { mutation: 'attempted' as const }; }),
  }) });
  const ensured = await new PreferredChatgptConversationTargetPort(
    port({ ensureExact: async () => ({ state: 'ready', target: primaryTarget }) }), native,
  ).ensureExact(identity);
  if (ensured.state !== 'ready') throw new Error('target not ready');
  await expect(ensured.target.observe()).rejects.toThrow('EXTENSION_OBSERVATION_UNAVAILABLE');
  expect(await ensured.target.dispatch('effect')).toEqual({ mutation: 'not_attempted', reasonCode: 'preflight_rejected' });
  expect(primaryDispatches).toBe(1);
  expect(nativeDispatches).toBe(0);
});


test('extension heartbeat completeness never hides an incomplete native browser scan', async () => {
  const conversation = { conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl };
  const primary = {
    ...port({ ensureExact: async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } }) }),
    inventory: async (): Promise<ComputerChatgptConversationInventory> => ({ conversations: [conversation], complete: true, unavailableProviders: [] }),
  };
  const native = {
    ...port({ ensureExact: async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } }) }),
    inventory: async (): Promise<ComputerChatgptConversationInventory> => ({ conversations: [], complete: false, unavailableProviders: ['computer-macos:vivaldi'] }),
  };
  const inventory = await new PreferredChatgptConversationTargetPort(primary, native).inventory();
  expect(inventory).toEqual({ conversations: [conversation], complete: false, providerInventoryReady: true, unavailableProviders: ['computer-macos:vivaldi'] });
});

test('complete native browser inventory remains complete when optional extension is unavailable', async () => {
  const conversation = { conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl };
  const primary = {
    ...port({ ensureExact: async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } }) }),
    inventory: async (): Promise<ComputerChatgptConversationInventory> => ({ conversations: [], complete: false, unavailableProviders: ['computer-extension'] }),
  };
  const native = {
    ...port({ ensureExact: async () => ({ state: 'unavailable', failure: { code: 'unused', retryable: false, phase: 'pre_mutation' } }) }),
    inventory: async (): Promise<ComputerChatgptConversationInventory> => ({ conversations: [conversation], complete: true, unavailableProviders: [] }),
  };
  const inventory = await new PreferredChatgptConversationTargetPort(primary, native).inventory();
  expect(inventory).toEqual({ conversations: [conversation], complete: true, providerInventoryReady: true, unavailableProviders: ['computer-extension'] });
});
