import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const content = readFileSync(
  new URL('../../adapters/computer/chatgpt-provider-extension/content.js', import.meta.url),
  'utf8',
);

function helperSource(): string {
  const start = content.indexOf('  const modelLockWait =');
  const end = content.indexOf('  const writeComposer =', start);
  if (start < 0 || end <= start) throw new Error('model-lock helper block missing');
  return [
    "const CHATGPT_MODEL_LOCK_CAPABILITY = 'gpt-5.6-sol-high-v1';",
    "const CHATGPT_MODEL_LOCK_NAME = 'GPT-5.6 Sol';",
    'const visible = (node) => Boolean(node?.getClientRects?.().length);',
    content.slice(start, end),
    'globalThis.__ensureGpt56High = ensureGpt56High;',
    'globalThis.__enforceWebModelLock = enforceWebModelLock;',
  ].join('\n');
}

class FakeKeyboardEvent {
  type: string;
  key: string;
  constructor(type: string, init: { key?: string } = {}) {
    this.type = type;
    this.key = String(init.key ?? '');
  }
}

function fixture(options: { picker?: boolean; model?: boolean; reasoning?: number; modelText?: string; radio?: boolean; max?: string; label?: string; missingSliderValue?: boolean } = {}) {
  const state = {
    picker: options.picker ?? true,
    menuOpen: false,
    model: options.model ?? false,
    reasoning: options.reasoning ?? 0,
  };

  const slider = {
    getClientRects: () => [{}],
    getAttribute(name: string) {
      if (name === 'aria-valuenow') return options.missingSliderValue ? null : String(state.reasoning);
      if (name === 'aria-valuemax') return options.max ?? '2';
      return null;
    },
  };

  const row = {
    getClientRects: () => [{}],
    querySelector(selector: string) {
      return selector === '[role="slider"]' ? slider : null;
    },
    focus() {
      document.activeElement = row;
    },
    dispatchEvent(event: FakeKeyboardEvent) {
      if (event.type === 'keydown' && event.key === 'ArrowRight') {
        state.reasoning = Math.min(2, state.reasoning + 1);
      }
      if (event.type === 'keydown' && event.key === 'Escape') {
        state.menuOpen = false;
      }
      return true;
    },
  };

  const option = {
    getClientRects: () => [{}],
    getAttribute(name: string) {
      return name === 'aria-checked' ? String(state.model) : null;
    },
    get innerText() {
      return options.modelText ?? 'GPT-5.6 Sol';
    },
    get textContent() {
      return options.modelText ?? 'GPT-5.6 Sol';
    },
    click() {
      state.model = true;
      state.menuOpen = false;
    },
  };

  const high = {
    getClientRects: () => [{}],
    innerText: 'High',
    getAttribute(name: string) {
      return name === 'aria-checked' ? String(state.reasoning === 2) : null;
    },
    click() {
      state.reasoning = 2;
      state.menuOpen = false;
    },
  };

  const menu = {
    getClientRects: () => state.menuOpen ? [{}] : [],
    querySelectorAll(selector: string) {
      return selector === '[role="menuitemradio"]' ? [option, ...(options.radio ? [high] : [])] : [];
    },
    querySelector(selector: string) {
      if (options.radio) return null;
      if (selector === '[data-reasoning-slider="true"] [role="slider"]') return slider;
      if (selector === '[data-reasoning-slider="true"]') return row;
      return null;
    },
  };

  const picker = {
    getClientRects: () => state.picker ? [{}] : [],
    getAttribute(name: string) {
      if (name === 'aria-label') return '选择 ChatGPT 模型';
      if (name === 'aria-expanded') return String(state.menuOpen);
      return null;
    },
    get innerText() {
      return options.label ?? (state.model && state.reasoning === 2 ? '5.6 高' : '6.2 中');
    },
    get textContent() {
      return this.innerText;
    },
    click() {
      state.menuOpen = true;
    },
  };

  const body = {
    dispatchEvent(event: FakeKeyboardEvent) {
      if (event.type === 'keydown' && event.key === 'Escape') state.menuOpen = false;
      return true;
    },
  };

  const document: any = {
    activeElement: body,
    body,
    querySelectorAll(selector: string) {
      if (selector === 'button') return state.picker ? [picker] : [];
      if (selector === '[role="menu"]') return state.menuOpen ? [menu] : [];
      return [];
    },
  };

  const context: Record<string, unknown> = {
    document,
    KeyboardEvent: FakeKeyboardEvent,
    Promise,
    hasLiveGenerationSignal: () => false,
    clearTimeout() {},
    setTimeout(callback: () => void) {
      callback();
      return 1;
    },
  };
  runInNewContext(helperSource(), context, { filename: 'model-lock-helpers.js' });
  const helpers = context as typeof context & {
    __ensureGpt56High: () => Promise<Record<string, unknown>>;
    __enforceWebModelLock: () => Promise<void>;
  };
  return { state, ensure: helpers.__ensureGpt56High, enforceWeb: helpers.__enforceWebModelLock };
}

test('automatic ChatGPT lock corrects model and reasoning to GPT-5.6 Sol High', async () => {
  const { state, ensure } = fixture({ model: false, reasoning: 0 });
  const proof = await ensure();
  expect(proof).toMatchObject({
    ready: true,
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    capability: 'gpt-5.6-sol-high-v1',
  });
  expect(state.model).toBe(true);
  expect(state.reasoning).toBe(2);
  expect(state.menuOpen).toBe(false);
});

test('automatic ChatGPT lock fails closed when the exact model picker is unavailable', async () => {
  const { state, ensure } = fixture({ picker: false });
  const proof = await ensure();
  expect(proof).toEqual({
    ready: false,
    reason: 'provider_model_lock_picker_ambiguous',
  });
  expect(state.menuOpen).toBe(false);
});

test('model option accepts a separate provider retirement notice', async () => {
  const { ensure } = fixture({ modelText: 'GPT-5.6 Sol\n将于 12 月 23 日下线' });
  expect(await ensure()).toMatchObject({ ready: true });
});

test('model option rejects a same-line extension and closes the menu', async () => {
  const { state, ensure } = fixture({ modelText: 'GPT-5.6 Sol Plus' });
  expect(await ensure()).toMatchObject({ ready: false });
  expect(state.menuOpen).toBe(false);
});

test('model lock supports an exact High radio option', async () => {
  const { state, ensure } = fixture({ radio: true });
  expect(await ensure()).toMatchObject({ ready: true, reasoning: 'high' });
  expect(state.reasoning).toBe(2);
  expect(state.menuOpen).toBe(false);
});

test('model lock never proves High from missing or expanded slider ranges', async () => {
  for (const options of [{ missingSliderValue: true }, { max: '3' }]) {
    const { state, ensure } = fixture(options);
    expect(await ensure()).toMatchObject({ ready: false, reason: 'provider_model_lock_reasoning_invalid' });
    expect(state.menuOpen).toBe(false);
  }
});

test('model lock does not accept Extra High as High in the collapsed picker', async () => {
  const { ensure } = fixture({ label: '5.6 Extra High' });
  expect(await ensure()).toMatchObject({ ready: false, reason: 'provider_model_lock_picker_confirmation_failed' });
});

test('unattended Forge prompts fail closed unless GPT-5.6 Sol High is proven', () => {
  expect(content).toContain("const automaticDispatch = /^\\[forge-supervisor(?:\\s|\\])/i.test(actualPrompt)");
  expect(content).toContain("if (!prepareOnly && automaticDispatch) {");
  expect(content).toContain("const modelLock = await ensureGpt56High();");
  expect(content).toContain("return { dispatched: false, reason: String(modelLock.reason ?? 'provider_model_lock_unavailable') };");
  expect(content).not.toContain('modelLockFallbackReason');
});

test('ordinary ChatGPT Web pages correct a non-5.6 picker back to GPT-5.6 Sol High', async () => {
  const { state, enforceWeb } = fixture({ model: false, reasoning: 0 });
  await enforceWeb();
  expect(state.model).toBe(true);
  expect(state.reasoning).toBe(2);
  expect(state.menuOpen).toBe(false);
});

test('ordinary ChatGPT Web pages leave an already locked picker untouched', async () => {
  const { state, enforceWeb } = fixture({ model: true, reasoning: 2 });
  await enforceWeb();
  expect(state.model).toBe(true);
  expect(state.reasoning).toBe(2);
  expect(state.menuOpen).toBe(false);
  expect(content).toContain('scheduleWebModelLock();');
});
