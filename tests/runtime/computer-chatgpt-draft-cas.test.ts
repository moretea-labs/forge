import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { dispatchMacOsChatgptPrompt } from '../../src/runtime/plugins/browser-chatgpt-target';
import { runtimeComputerChatgptAction } from '../../src/runtime/root/computer-chatgpt-target';

function fixture(initial: string, generating = false) {
  let value = initial;
  let writes = 0;
  let clicks = 0;
  class Element {
    children: Element[] = [];
    isContentEditable = true;
    get innerText() {
      return value;
    }
    getClientRects() {
      return [{}];
    }
    hasAttribute() {
      return false;
    }
    getAttribute() {
      return null;
    }
    querySelector() {
      return null;
    }
    focus() {}
    click() {
      clicks += 1;
    }
  }
  const composer = new Element();
  const button = new Element();
  const root = {
    getClientRects: () => [{}],
    querySelectorAll: (selector: string) =>
      selector.includes('stop-button')
        ? generating
          ? [button]
          : []
        : selector.includes('contenteditable')
          ? [composer]
          : [button],
  };
  const document = {
    querySelectorAll: () => [root],
    createRange: () => ({
      selectNodeContents() {},
      collapse() {},
      deleteContents() {
        value = '';
        writes += 1;
      },
    }),
    execCommand: (_command: string, _ui: boolean, text: string) => {
      value = text;
      writes += 1;
      return true;
    },
  };
  const page = {
    evaluate: async <T>(script: string | ((...args: unknown[]) => unknown)) => {
      if (typeof script !== 'string') throw new Error('Expected Provider script');
      return runInNewContext(script, {
        HTMLElement: Element,
        document,
        window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
      }) as T;
    },
    tabRef: () => undefined,
  };
  return { page, state: () => ({ value, writes, clicks }) };
}

test('prepare replaces only the exact reconciled draft and never clicks Send', async () => {
  const f = fixture('completed effect draft');
  expect(
    await dispatchMacOsChatgptPrompt(f.page, 'next independent task', {
      prepareOnly: true,
      expectedDraft: 'completed effect draft',
    }),
  ).toEqual({ mutation: 'prepared' });
  expect(f.state()).toEqual({ value: 'next independent task', writes: 2, clicks: 0 });
});

test('a user edit between observation and prepare is preserved without any mutation', async () => {
  const f = fixture('user edited this draft');
  expect(
    await dispatchMacOsChatgptPrompt(f.page, 'next task', {
      prepareOnly: true,
      expectedDraft: 'previously observed draft',
    }),
  ).toEqual({ mutation: 'not_attempted', reasonCode: 'composer_draft_changed' });
  expect(f.state()).toEqual({ value: 'user edited this draft', writes: 0, clicks: 0 });
});

test('dispatch cannot acquire draft-replacement authority', async () => {
  const f = fixture('retained draft');
  expect(
    await dispatchMacOsChatgptPrompt(f.page, 'next task', {
      expectedDraft: 'retained draft',
    }),
  ).toEqual({ mutation: 'not_attempted', reasonCode: 'composer_replace_requires_prepare' });
  expect(f.state()).toEqual({ value: 'retained draft', writes: 0, clicks: 0 });
});

test('a response starting after observation prevents draft replacement', async () => {
  const f = fixture('retained draft', true);
  expect(
    await dispatchMacOsChatgptPrompt(f.page, 'next task', {
      prepareOnly: true,
      expectedDraft: 'retained draft',
    }),
  ).toEqual({ mutation: 'not_attempted', reasonCode: 'provider_busy' });
  expect(f.state()).toEqual({ value: 'retained draft', writes: 0, clicks: 0 });
});

test('ordinary prepare continues to protect occupied composers', async () => {
  const f = fixture('retained user draft');
  expect(await dispatchMacOsChatgptPrompt(f.page, 'next task', { prepareOnly: true })).toEqual({
    mutation: 'not_attempted',
    reasonCode: 'composer_not_empty',
  });
  expect(f.state()).toEqual({ value: 'retained user draft', writes: 0, clicks: 0 });
});

test('Linux rejects unsupported draft replacement before opening or mutating a target', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('Missing platform descriptor');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    expect(
      await runtimeComputerChatgptAction('/nonexistent-draft-cas-controller', {
        kind: 'prepare',
        prompt: 'next task',
        expectedDraft: 'old draft',
        identity: { namespace: 'chatgpt.bootstrap', bootstrapKey: 'fixture', projectUrl: 'https://chatgpt.com/' },
      }),
    ).toEqual({
      state: 'unavailable',
      failure: { code: 'COMPUTER_CHATGPT_DRAFT_CAS_UNSUPPORTED', retryable: false, phase: 'pre_mutation' },
    });
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
