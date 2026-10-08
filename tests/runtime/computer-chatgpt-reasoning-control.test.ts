import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';

const extensionRoot = join(process.cwd(), 'adapters', 'computer', 'chrome-extension');
const coreSource = readFileSync(join(extensionRoot, 'core.js'), 'utf8');
const contentSource = readFileSync(join(extensionRoot, 'content.js'), 'utf8');

class FakeTextArea {
  value = '';
  disabled = false;
  getClientRects() { return [{}]; }
  focus() {}
  dispatchEvent() { return true; }
  getAttribute() { return null; }
}

function fixture(options: {
  startingLabel?: string;
  controlPresent?: boolean;
  optionLabel?: string;
  optionDisabled?: boolean;
  acknowledgeSelection?: boolean;
  sliderValue?: number;
  sliderMax?: number;
  acknowledgeSlider?: boolean;
} = {}) {
  const state = { controlClicks: 0, optionClicks: 0, sendClicks: 0, controlLabel: options.startingLabel ?? 'GPT-6 High', menuOpen: false };
  let onMessage: ((message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => unknown) | undefined;
  const textarea = new FakeTextArea();
  const visible = () => [{}];
  const control = options.controlPresent === false ? undefined : {
    getClientRects: visible,
    getAttribute: (_: string) => null,
    get innerText() { return state.controlLabel; },
    click() { state.controlClicks += 1; state.menuOpen = true; },
  };
  const option = options.optionLabel === undefined ? undefined : {
    getClientRects: visible,
    getAttribute(name: string) {
      if (name === 'aria-disabled') return options.optionDisabled ? 'true' : null;
      if (name === 'aria-checked') return options.acknowledgeSelection === false ? null : state.controlLabel.includes(options.optionLabel ?? '__missing__') ? 'true' : null;
      return null;
    },
    hasAttribute(name: string) { return name === 'disabled' && options.optionDisabled === true; },
    get innerText() { return options.optionLabel; },
    click() {
      state.optionClicks += 1;
      if (options.acknowledgeSelection !== false) state.controlLabel = `GPT-6 ${options.optionLabel}`;
    },
  };
  let sliderValue = options.sliderValue;
  const slider = sliderValue === undefined ? undefined : {
    getClientRects: visible,
    getAttribute(name: string) {
      if (name === 'aria-valuenow') return String(sliderValue);
      if (name === 'aria-valuemax') return String(options.sliderMax ?? 4);
      if (name === 'aria-valuemin') return '0';
      if (name === 'aria-valuetext') return sliderValue === 4 ? 'Extra High' : sliderValue === 3 ? 'High' : 'Medium';
      return null;
    },
    focus() {},
    dispatchEvent(e: { key: string }) {
      if (options.acknowledgeSlider !== false) sliderValue = Number(sliderValue) + (e.key === 'ArrowRight' ? 1 : -1);
    },
  };
  const main = {
    getClientRects: visible,
    querySelectorAll(selector: string) {
      const nodes = selector.includes('aria-haspopup') || selector.includes('data-testid*="model"') ? (control ? [control] : []) : [];
      return Object.assign(nodes, { item(index: number) { return nodes[index] ?? null; } });
    },
  };
  const document = {
    documentElement: {},
    title: 'ChatGPT',
    body: { innerText: '' },
    querySelectorAll(selector: string) {
      if (selector === 'main') return [main];
      if (selector.includes('[role="menuitemradio"]')) return state.menuOpen && option ? [option] : [];
      if (selector.includes('[role="slider"]')) return state.menuOpen && slider ? [slider] : [];
      return [];
    },
    querySelector(selector: string) {
      if (selector.includes('prompt-textarea') || selector.includes('composer-text-input')) return textarea;
      if (selector.includes('send-button')) return { disabled: false, getAttribute: () => null, click() { state.sendClicks += 1; } };
      return null;
    },
  };
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc' },
    URL,
    HTMLTextAreaElement: FakeTextArea,
    HTMLInputElement: class {},
    InputEvent: class {},
    KeyboardEvent: class { constructor(public type: string, public options: { key: string }) {} get key() { return this.options.key; } },
    MutationObserver: class { observe() {} },
    chrome: {
      runtime: {
        onMessage: { addListener(fn: typeof onMessage) { onMessage = fn; } },
        sendMessage(_message: unknown, callback: () => void) { callback?.(); },
        lastError: undefined,
      },
    },
    clearTimeout() {},
    setTimeout(fn: () => void) { queueMicrotask(fn); return 1; },
  };
  runInNewContext(coreSource, context);
  runInNewContext(contentSource, context);
  const capabilities = () => new Promise<Record<string, unknown>>((resolve) => {
    if (!onMessage) throw new Error('missing content-script message listener');
    onMessage({ type: 'forge-computer-chatgpt-capabilities' }, {}, (value) => resolve(value as Record<string, unknown>));
  });
  const dispatch = async (reasoning?: string) => {
    return await new Promise<Record<string, unknown>>((resolve) => {
      if (!onMessage) throw new Error('missing content-script message listener');
      onMessage({ type: 'forge-computer-chatgpt-dispatch', prompt: 'source delivery', reasoning }, {}, (value) => resolve(value as Record<string, unknown>));
    });
  };
  return { dispatch, capabilities, state, textarea };
}

test('content script advertises exact-tab reasoning preflight without mutating the page', async () => {
  const f = fixture({ controlPresent: false });
  expect(await f.capabilities()).toMatchObject({ reasoningPreflight: 'verified_before_send_v1' });
  expect(f.state.controlClicks).toBe(0);
  expect(f.state.sendClicks).toBe(0);
});

test('Supervisor xhigh selects and verifies the composer option before inserting or sending', async () => {
  const f = fixture({ optionLabel: 'Extra High' });
  const result = await f.dispatch('xhigh');
  expect(result).toMatchObject({ dispatched: true, reasoningVerified: 'xhigh' });
  expect(f.state.controlClicks).toBe(1);
  expect(f.state.optionClicks).toBe(1);
  expect(f.state.sendClicks).toBe(1);
  expect(f.textarea.value).toBe('source delivery');
});

test('an already selected Extra High control can dispatch without opening the menu', async () => {
  const f = fixture({ startingLabel: 'GPT-6 Extra High' });
  expect(await f.dispatch('xhigh')).toMatchObject({ dispatched: true, reasoningVerified: 'xhigh' });
  expect(f.state.controlClicks).toBe(0);
  expect(f.state.sendClicks).toBe(1);
});

test('unobservable reasoning fails closed before any prompt insertion or send', async () => {
  const f = fixture({ controlPresent: false });
  expect(await f.dispatch('xhigh')).toMatchObject({ dispatched: false, reason: 'COMPUTER_CHATGPT_REASONING_CONTROL_UNAVAILABLE' });
  expect(f.textarea.value).toBe('');
  expect(f.state.sendClicks).toBe(0);
});

test('disabled or unverified Extra High selection never dispatches', async () => {
  const disabled = fixture({ optionLabel: 'Extra High', optionDisabled: true });
  expect(await disabled.dispatch('xhigh')).toMatchObject({ dispatched: false, reason: 'COMPUTER_CHATGPT_REASONING_OPTION_UNAVAILABLE' });
  const ignored = fixture({ optionLabel: 'Extra High', acknowledgeSelection: false });
  expect(await ignored.dispatch('xhigh')).toMatchObject({ dispatched: false, reason: 'COMPUTER_CHATGPT_REASONING_NOT_VERIFIED' });
  expect(disabled.textarea.value).toBe('');
  expect(ignored.textarea.value).toBe('');
  expect(disabled.state.sendClicks + ignored.state.sendClicks).toBe(0);
});

test('slider needs an observed state transition rather than an untrusted write', async () => {
  const supported = fixture({ sliderValue: 3 });
  expect(await supported.dispatch('xhigh')).toMatchObject({ dispatched: true, reasoningVerified: 'xhigh' });
  const refused = fixture({ sliderValue: 3, acknowledgeSlider: false });
  expect(await refused.dispatch('xhigh')).toMatchObject({ dispatched: false, reason: 'COMPUTER_CHATGPT_REASONING_NOT_VERIFIED' });
  expect(refused.textarea.value).toBe('');
  expect(refused.state.sendClicks).toBe(0);
  const highOnly = fixture({ sliderValue: 2, sliderMax: 3 });
  expect(await highOnly.dispatch('xhigh')).toMatchObject({ dispatched: true, reasoningVerified: 'high' });
});

test('when Extra High is absent the menu verifies High as the highest available level', async () => {
  const f = fixture({ optionLabel: 'High' });
  expect(await f.dispatch('xhigh')).toMatchObject({ dispatched: true, reasoningVerified: 'high' });
  expect(f.state.optionClicks).toBe(1);
  expect(f.state.sendClicks).toBe(1);
});

test('an occupied human composer prevents both model UI changes and provider submission', async () => {
  const f = fixture({ optionLabel: 'Extra High' });
  f.textarea.value = 'unsent human draft';
  expect(await f.dispatch('xhigh')).toMatchObject({ dispatched: false, reason: 'composer_not_empty' });
  expect(f.textarea.value).toBe('unsent human draft');
  expect(f.state.controlClicks).toBe(0);
  expect(f.state.sendClicks).toBe(0);
});

test('ordinary manual transport without an explicit reasoning requirement is unchanged', async () => {
  const f = fixture({ controlPresent: false });
  expect(await f.dispatch()).toMatchObject({ dispatched: true });
  expect(f.state.sendClicks).toBe(1);
});
