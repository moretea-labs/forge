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
