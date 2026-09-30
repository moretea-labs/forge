import { expect, test } from 'bun:test';
import {
  defaultDispatchPrompt,
  type WorkflowSupervisorNativePage,
} from '../../supervisor/native-browser-adapter';

test('classifies Chrome JavaScript permission rejection as pre-send not-applied', async () => {
  let evaluateCalls = 0;
  const permissionError = 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED: Google Chrome allows tab/window automation, but DOM actions require Settings > Privacy > Apple Events > Allow JavaScript from Apple Events.';
  const page: WorkflowSupervisorNativePage = {
    evaluate: async <T>() => {
      evaluateCalls += 1;
      throw new Error(permissionError);
    },
    waitForSelector: async () => undefined,
    tabRef: () => undefined,
  };

  await expect(defaultDispatchPrompt(page, 'continue the Forge task')).resolves.toEqual({
    dispatched: false,
    reason: permissionError,
  });
  expect(evaluateCalls).toBe(1);
});
