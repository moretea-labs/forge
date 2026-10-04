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


test('Computer target router keeps extension absence unavailable instead of opening through compatibility transport', async () => {
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
  expect(await router.ensureExact(identity)).toEqual({
    state: 'unavailable',
    failure: {
      code: 'COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED',
      retryable: true,
      phase: 'pre_mutation',
      failoverSafe: true,
    },
  });
  expect(compatibilityEnsures).toBe(0);
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
