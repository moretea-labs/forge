import { expect, test } from 'bun:test';
import { dispatchMacOsChatgptPrompt } from '../../src/runtime/plugins/computer-chatgpt-macos-target';

test('Computer provider classifies Chrome JavaScript permission rejection as pre-mutation not-applied', async () => {
  let evaluateCalls = 0;
  const permissionError = 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED: Google Chrome allows tab/window automation, but DOM actions require Settings > Privacy > Apple Events > Allow JavaScript from Apple Events.';
  const page = {
    evaluate: async <T>() => {
      evaluateCalls += 1;
      throw new Error(permissionError);
    },
    tabRef: () => undefined,
  };

  await expect(dispatchMacOsChatgptPrompt(page, 'continue the Forge task')).resolves.toEqual({
    mutation: 'not_attempted',
    reasonCode: 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED',
  });
  expect(evaluateCalls).toBe(1);
});

test('native Supervisor send refuses a plain @forge draft without a verified main-app chip', async () => {
  let calls = 0;
  const page = {
    evaluate: async <T>(source: string) => {
      calls += 1;
      if (source.includes('const expectedNorm')) return { prepared: true } as T;
      if (source.includes('const chips')) return { bound: false, opened: false, reason: 'forge_app_picker_missing' } as T;
      throw new Error('Send must not be reached without a bound app');
    },
    tabRef: () => undefined,
  };
  const prompt = '@forge\n<<<FORGE_WORKFLOW_EFFECT_V1:fx_test_native_123456789>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  expect(await dispatchMacOsChatgptPrompt(page, prompt)).toEqual({
    mutation: 'not_attempted', reasonCode: 'forge_app_picker_missing',
  });
  expect(calls).toBe(2);
});

test('Mac native pre-send preparation never clicks Send or claims provider mutation', async () => {
  let sendStageCalls = 0;
  const page = {
    evaluate: async <T>(source: string) => {
      if (source.includes('const expectedNorm')) return { prepared: true } as T;
      if (source.includes('const root') && source.includes('send-button') && !source.includes('sendButton.click')) return true as T;
      sendStageCalls++;
      throw new Error('No send-stage execution before Supervisor reserves effect authority');
    },
    tabRef: () => undefined,
  };
  expect(await dispatchMacOsChatgptPrompt(page, 'A prepared but unsent prompt', { prepareOnly: true }))
    .toEqual({ mutation: 'prepared' });
  expect(sendStageCalls).toBe(0);
});

test('Apple Events compatibility provider never claims an unverified requested reasoning level', async () => {
  let evaluateCalls = 0;
  const page = {
    evaluate: async <T>() => {
      evaluateCalls += 1;
      throw new Error('The page must not be inspected when the provider has no reasoning verifier');
    },
    tabRef: () => undefined,
  };
  await expect(dispatchMacOsChatgptPrompt(page, 'continue the Forge task', { reasoning: 'xhigh' })).resolves.toEqual({
    mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_REASONING_UNSUPPORTED_BY_PROVIDER',
  });
  expect(evaluateCalls).toBe(0);
});
