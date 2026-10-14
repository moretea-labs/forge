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

test('native Supervisor sends the plain-text effect without requiring an App chip', async () => {
  let calls = 0;
  const page = {
    evaluate: async <T>(source: string) => {
      calls += 1;
      if (source.includes('const expectedNorm')) return { prepared: true } as T;
      if (source.includes('const chips')) throw new Error('App chip picker must not be invoked');
      if (source.includes('sendButton.click()')) return { dispatched: true } as T;
      throw new Error('Unexpected native browser action');
    },
    tabRef: () => undefined,
  };
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_test_native_123456789>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  expect(await dispatchMacOsChatgptPrompt(page, prompt)).toEqual({ mutation: 'attempted' });
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

  // ProseMirror can render an empty <p><br></p> as innerText="\n".
  // That placeholder is not a draft and must not block a verified pre-send.
  class FakeComposer {
    innerText = '\n';
    textContent = '';
    isContentEditable = true;
    children = [{ tagName: 'P', textContent: '', querySelector: (selector: string) => selector === 'br' ? {} : null }];
    getClientRects() { return [1]; }
    querySelector() { return null; }
    focus() {}
  }
  const composer = new FakeComposer();
  const selection = { removeAllRanges() {}, addRange() {} };
  const document = {
    querySelectorAll: (selector: string) => selector === 'main' ? []
      : selector.startsWith('div#prompt-textarea') ? [composer]
      : selector.startsWith('[data-testid="send-button"]') ? [{ getClientRects: () => [1], hasAttribute: () => false, getAttribute: () => null }]
      : [],
    createRange: () => ({ selectNodeContents() {}, deleteContents() { composer.innerText = ''; }, collapse() {} }),
    execCommand: (_name: string, _show: boolean, value: string) => {
      composer.innerText = value; composer.textContent = value; return true;
    },
  };
  const emptyEditorPage = {
    evaluate: async <T>(source: string) => new Function('document', 'window', 'HTMLElement', 'location', 'return ' + source)(
      document, { getSelection: () => selection }, FakeComposer, { href: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    ) as T,
    tabRef: () => undefined,
  };
  expect(await dispatchMacOsChatgptPrompt(emptyEditorPage, 'verified effect', { prepareOnly: true }))
    .toEqual({ mutation: 'prepared' });
  // A deliberate whitespace draft stays protected even with a trailing BR.
  composer.innerText = '  ';
  composer.textContent = '  ';
  composer.children = [{ tagName: 'P', textContent: '  ', querySelector: (selector: string) => selector === 'br' ? {} : null }];
  expect(await dispatchMacOsChatgptPrompt(emptyEditorPage, 'different effect', { prepareOnly: true }))
    .toEqual({ mutation: 'not_attempted', reasonCode: 'composer_not_empty' });
  expect(composer.innerText).toBe('  ');
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

test('Mac native Computer refuses a foreign exact-conversation URL before editing a draft', async () => {
  const expected = { namespace: 'chatgpt.conversation' as const,
    conversationId: 'aaaa1111-bbbb-cccc-dddd-eeeeffffffff',
    canonicalUrl: 'https://chatgpt.com/c/aaaa1111-bbbb-cccc-dddd-eeeeffffffff' };
  let sendClicks = 0;
  const page = {
    evaluate: async <T>(source: string) => {
      if (source.includes('sendButton.click()')) sendClicks += 1;
      return new Function('document', 'location', `return ${source}`)(
        { querySelectorAll: () => [] },
        { href: 'https://chatgpt.com/c/foreign-conversation' },
      ) as T;
    },
    tabRef: () => undefined,
  };
  expect(await dispatchMacOsChatgptPrompt(page, 'only for the expected conversation', {
    targetIdentity: expected, prepareOnly: true,
  })).toEqual({ mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN' });
  expect(sendClicks).toBe(0);
});

test('Mac native Computer rechecks exact URL inside the same JavaScript action as Send', async () => {
  const expected = { namespace: 'chatgpt.conversation' as const,
    conversationId: 'aaaa1111-bbbb-cccc-dddd-eeeeffffffff',
    canonicalUrl: 'https://chatgpt.com/c/aaaa1111-bbbb-cccc-dddd-eeeeffffffff' };
  let finalSubmitEvaluations = 0;
  const page = {
    evaluate: async <T>(source: string) => {
      if (source.includes('const expectedNorm')) return { prepared: true } as T;
      if (source.includes('sendButton.click()')) {
        finalSubmitEvaluations += 1;
        // Simulate navigation after preflight, just before the DOM Send action.
        return new Function('document', 'location', `return ${source}`)(
          { querySelectorAll: () => [] },
          { href: 'https://chatgpt.com/c/other-conversation' },
        ) as T;
      }
      throw new Error('unexpected browser stage');
    },
    tabRef: () => undefined,
  };
  expect(await dispatchMacOsChatgptPrompt(page, 'only for expected', {
    targetIdentity: expected,
  })).toEqual({ mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN' });
  expect(finalSubmitEvaluations).toBe(1);
});

test('Mac native bootstrap rejects the wrong Project and a pre-existing conversation before sending', async () => {
  const expected = { namespace: 'chatgpt.bootstrap' as const,
    bootstrapKey: 'supervisor:expected-task',
    projectUrl: 'https://chatgpt.com/g/g-p-abcdef123456-forge/project' };
  for (const href of ['https://chatgpt.com/g/g-p-999999-other/project',
    'https://chatgpt.com/g/g-p-abcdef123456-forge/c/old-conversation']) {
    const page = {
      evaluate: async <T>(source: string) => new Function('document', 'location', `return ${source}`)(
        { querySelectorAll: () => [] }, { href },
      ) as T,
      tabRef: () => undefined,
    };
    expect(await dispatchMacOsChatgptPrompt(page, 'bootstrap once', {
      targetIdentity: expected, prepareOnly: true,
    })).toEqual({ mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN' });
  }
});

test('Mac native refuses Send when whitespace changed after prepare and permits an exact payload', async () => {
  const prompt = 'alpha  beta\nline two';
  const identity = { namespace: 'chatgpt.conversation' as const,
    conversationId: 'abababab-1234-5678-9999-aaaaaaaaaaaa',
    canonicalUrl: 'https://chatgpt.com/c/abababab-1234-5678-9999-aaaaaaaaaaaa' };
  class FakeElement {
    innerText = '';
    isContentEditable = true;
    disabled = false;
    getClientRects() { return [1]; }
    hasAttribute(_name: string) { return false; }
    getAttribute(_name: string) { return null; }
    querySelectorAll(_selector: string) { return []; }
    querySelector(_selector: string) { return null; }
  }
  for (const [rendered, expectedMutation] of [
    ['alpha beta\nline two', 'not_attempted'],
    ['alpha  beta line two', 'not_attempted'],
    [prompt, 'attempted'],
  ] as const) {
    const composer = new FakeElement();
    composer.innerText = rendered;
    const send = new FakeElement();
    let clicks = 0;
    (send as FakeElement & { click: () => void }).click = () => { clicks += 1; };
    const document = {
      querySelectorAll: (selector: string) => selector === 'main' ? []
        : selector.startsWith('div#prompt-textarea') ? [composer]
        : selector.startsWith('[data-testid="send-button"]') ? [send] : [],
    };
    const page = {
      evaluate: async <T>(source: string) => {
        if (source.includes('const expectedNorm')) return { prepared: true } as T;
        if (!source.includes('sendButton.click()')) throw new Error('unexpected page action');
        return new Function('document', 'location', 'HTMLElement', `return ${source}`)(
          document, { href: identity.canonicalUrl }, FakeElement,
        ) as T;
      },
      tabRef: () => undefined,
    };
    const result = await dispatchMacOsChatgptPrompt(page, prompt, { targetIdentity: identity });
    expect(result.mutation).toBe(expectedMutation);
    expect(clicks).toBe(expectedMutation === 'attempted' ? 1 : 0);
  }
});
