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

function fixture(options: { picker?: boolean; model?: boolean; reasoning?: number } = {}) {
  const state = {
    picker: options.picker ?? true,
    menuOpen: false,
    model: options.model ?? false,
    reasoning: options.reasoning ?? 0,
  };

  const slider = {
    getClientRects: () => [{}],
    getAttribute(name: string) {
      if (name === 'aria-valuenow') return String(state.reasoning);
      if (name === 'aria-valuemax') return '2';
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
      return 'GPT-5.6 Sol';
    },
    get textContent() {
      return 'GPT-5.6 Sol';
    },
    click() {
      state.model = true;
      state.menuOpen = false;
    },
  };

  const menu = {
    getClientRects: () => state.menuOpen ? [{}] : [],
    querySelectorAll(selector: string) {
      return selector === '[role="menuitemradio"]' ? [option] : [];
    },
    querySelector(selector: string) {
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
      return state.model && state.reasoning === 2 ? '5.6 高' : '6.2 中';
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
    setTimeout(callback: () => void) {
      callback();
      return 1;
    },
  };
  runInNewContext(helperSource(), context, { filename: 'model-lock-helpers.js' });
  const ensure = (context as typeof context & {
    __ensureGpt56High: () => Promise<Record<string, unknown>>;
  }).__ensureGpt56High;
  return { state, ensure };
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

test('only unattended Forge prompts enter the content-script model lock gate', () => {
  expect(content).toContain("const automaticDispatch = /^\\[forge-supervisor(?:\\s|\\])/i.test(actualPrompt)");
  expect(content).toContain("if (!prepareOnly && automaticDispatch) {");
  expect(content).toContain("const modelLock = await ensureGpt56High();");
});
