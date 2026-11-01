import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { withChatgptProviderDispatchLane } from '../../adapters/chatgpt/provider-delivery';

const extensionRoot = join(process.cwd(), 'adapters', 'computer', 'chrome-extension');
const coreSource = readFileSync(join(extensionRoot, 'core.js'), 'utf8');
const contentSource = readFileSync(join(extensionRoot, 'content.js'), 'utf8');

class FakeTextArea {
  value = '';
  chipNames: string[] = [];
  disabled = false;
  getClientRects() { return [{}]; }
  focus() {}
  dispatchEvent() { return true; }
  getAttribute() { return null; }
  querySelector() { return this.chipNames.length ? {} : null; }
  querySelectorAll() { return this.chipNames.map((name) => ({ getAttribute(attribute: string) {
    if (attribute === 'app-mention-name') return name;
    if (attribute === 'app-mention-path' && name === 'forge') return 'app://asdk_app_6ac09022b26081918f20ff868c773824';
    return null;
  } })); }
}
class FakeHTMLElement {}

function fixture(options: {
  startingLabel?: string;
  controlPresent?: boolean;
  optionLabel?: string;
  optionDisabled?: boolean;
  acknowledgeSelection?: boolean;
  sliderValue?: number;
  sliderMax?: number;
  acknowledgeSlider?: boolean;
  navigateAfterOptionClick?: string;
  forgeAppLabel?: string;
  projectUrl?: string;
  initialDraft?: string;
} = {}) {
  const state = { controlClicks: 0, optionClicks: 0, sendClicks: 0, controlLabel: options.startingLabel ?? 'GPT-6 High', menuOpen: false };
  const location = { href: options.projectUrl ?? 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc' };
  let onMessage: ((message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => unknown) | undefined;
  const textarea = new FakeTextArea();
  textarea.value = options.initialDraft ?? '';
  let pickerOpen = false;
  const picker = Object.assign(new FakeHTMLElement(), {
    getAttribute: () => pickerOpen ? 'open' : null,
    click() { pickerOpen = true; },
  });
  const forgeOption = Object.assign(new FakeHTMLElement(), {
    get innerText() { return options.forgeAppLabel; },
    click() {
      textarea.value = textarea.value.replace(/\n@forge$/, ' forge');
      textarea.chipNames = [options.forgeAppLabel === 'forge' ? 'forge' : 'forge-recovery'];
    },
  });
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
      if (options.navigateAfterOptionClick) location.href = options.navigateAfterOptionClick;
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
  let submittedUser: { innerText: string } | undefined;
  let onMutation: (() => void) | undefined;
  const documentEvents = new EventTarget();
  const sendButton = {
    isConnected: true,
    disabled: false,
    getClientRects: visible,
    getAttribute: () => null,
    click() {
      state.sendClicks += 1;
      submittedUser = { innerText: textarea.value };
      queueMicrotask(() => onMutation?.());
    },
  };
  const main = {
    getClientRects: visible,
    querySelectorAll(selector: string) {
      const nodes = selector.includes('[data-message-author-role="user"]') && submittedUser
        ? [submittedUser]
        : selector.includes('aria-haspopup') || selector.includes('data-testid*="model"') ? (control ? [control] : []) : [];
      return Object.assign(nodes, { item(index: number) { return nodes[index] ?? null; } });
    },
  };
  const document = {
    documentElement: {},
    title: 'ChatGPT',
    body: { innerText: '' },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    querySelectorAll(selector: string) {
      if (selector === 'main') return [main];
      if (selector.includes('#prompt-textarea')) return [textarea];
      if (selector.includes('send-button')) return [sendButton];
      if (selector.includes('aria-haspopup') || selector.includes('data-testid*="model"') || selector.includes('data-testid*="reasoning"')) return control ? [control] : [];
      if (selector.includes('[data-mention-section-items]')) return pickerOpen && options.forgeAppLabel ? [forgeOption] : [];
      if (selector.includes('[role="menuitemradio"]')) return state.menuOpen && option ? [option] : [];
      if (selector.includes('[role="slider"]')) return state.menuOpen && slider ? [slider] : [];
      return [];
    },
    createRange() { return { selectNodeContents() {}, collapse() {} }; },
    execCommand(_command: string, _show: boolean, value: string) {
      textarea.value += value;
      if (value === 'forge') pickerOpen = true;
      return true;
    },
    querySelector(selector: string) {
      if (selector.includes('Add files and more') || selector.includes('添加文件等内容')) return options.forgeAppLabel ? picker : null;
      if (selector.includes('prompt-textarea') || selector.includes('composer-text-input')) return textarea;
      if (selector.includes('send-button')) return sendButton;
      return null;
    },
  };
  const context = {
    document,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents) },
    location,
    URL,
    crypto: webcrypto,
    TextEncoder,
    HTMLTextAreaElement: FakeTextArea,
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: class {},
    InputEvent: class {},
    KeyboardEvent: class { constructor(public type: string, public options: { key: string }) {} get key() { return this.options.key; } },
    MutationObserver: class {
      constructor(private readonly callback: () => void) {}
      observe() { onMutation = this.callback; }
      disconnect() { onMutation = undefined; }
    },
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
  const prepare = async (reasoning?: string, expectedConversationId?: string, prompt = 'source delivery', expectedProjectId?: string) => {
    return await new Promise<Record<string, unknown>>((resolve) => {
      if (!onMessage) throw new Error('missing content-script message listener');
      onMessage({ type: 'forge-computer-chatgpt-prepare', prompt, reasoning, expectedConversationId, expectedProjectId }, {}, (value) => resolve(value as Record<string, unknown>));
    });
  };
  const dispatch = async (reasoning?: string, expectedConversationId?: string, prompt = 'source delivery', expectedProjectId?: string) => {
    return await new Promise<Record<string, unknown>>((resolve) => {
      if (!onMessage) throw new Error('missing content-script message listener');
      onMessage({ type: 'forge-computer-chatgpt-dispatch', prompt, reasoning, expectedConversationId, expectedProjectId }, {}, (value) => resolve(value as Record<string, unknown>));
    });
  };
  return { dispatch, prepare, capabilities, state, textarea, location };
}

test('Supervisor effect requires exact target identity before plain-text Send', async () => {
  const f = fixture({ controlPresent: false });
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_test_browser_123456789>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  expect(await f.dispatch(undefined, undefined, prompt)).toMatchObject({
    dispatched: false, reason: 'target_identity_unavailable',
  });
  expect(f.state.sendClicks).toBe(0);
  expect(f.textarea.value).toBe('');
});

test('Supervisor sends a complete plain-text effect once without selecting any App', async () => {
  const f = fixture({ controlPresent: false, forgeAppLabel: 'forge' });
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_test_browser_123456789>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  expect(await f.dispatch(undefined, '12345678-1234-1234-1234-123456789abc', prompt)).toMatchObject({ dispatched: true, confirmed: true });
  expect(f.state.sendClicks).toBe(1);
  expect(f.textarea.chipNames).toEqual([]);
  expect(f.textarea.value).toBe(prompt);
});

test('Chrome Extension prepares an exact effect without model-picker selection', async () => {
  const f = fixture({ optionLabel: 'Extra High' });
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_test_pre_send_123456789>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  expect(await f.prepare(undefined, conversationId, prompt)).toMatchObject({ prepared: true });
  expect(f.state.controlClicks).toBe(0);
  expect(f.state.sendClicks).toBe(0);
  expect(f.textarea.chipNames).toEqual([]);
  expect(await f.dispatch(undefined, conversationId, prompt)).toMatchObject({ dispatched: true });
  expect(f.state.sendClicks).toBe(1);
});

test('Chrome Extension rejects an existing App mention before any Send', async () => {
  const f = fixture({ controlPresent: false });
  f.textarea.chipNames = ['forge'];
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_test_pre_send_123456789>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  expect(await f.prepare(undefined, '12345678-1234-1234-1234-123456789abc', prompt))
    .toMatchObject({ prepared: false, reason: 'composer_has_app_mention' });
  expect(f.state.sendClicks).toBe(0);
});

test('similarly named Recovery suggestion is not selected during plain-text Supervisor delivery', async () => {
  const f = fixture({ controlPresent: false, forgeAppLabel: 'Forge Recovery' });
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_test_browser_123456789>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  expect(await f.dispatch(undefined, '12345678-1234-1234-1234-123456789abc', prompt))
    .toMatchObject({ dispatched: true });
  expect(f.textarea.chipNames).toEqual([]);
  expect(f.state.sendClicks).toBe(1);
});

test('content script advertises exact bootstrap guards without mutating the page', async () => {
  const f = fixture({ controlPresent: false });
  expect(await f.capabilities()).toMatchObject({ bootstrapTargetGuard: 'project-checked-before-send-v1' });
  expect(f.state.controlClicks).toBe(0);
  expect(f.state.sendClicks).toBe(0);
});

test('an occupied human composer prevents provider submission', async () => {
  const f = fixture({ optionLabel: 'Extra High' });
  f.textarea.value = 'unsent human draft';
  expect(await f.dispatch()).toMatchObject({ dispatched: false, reason: 'composer_not_empty' });
  expect(f.textarea.value).toBe('unsent human draft');
  expect(f.state.controlClicks).toBe(0);
  expect(f.state.sendClicks).toBe(0);
});

test('plain-text manual delivery never selects a model', async () => {
  const f = fixture({ controlPresent: false });
  expect(await f.dispatch()).toMatchObject({ dispatched: true });
  expect(f.state.sendClicks).toBe(1);
});


test('Chrome extension stages only the exact authorized backed-up project draft and sends canonical prompt once', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-abc123-forge/project';
  const priorDraft = '@forge unrelated\nRead-only user request';
  const effect = 'fx_draft_guard_123456789';
  const prompt = `<<<FORGE_WORKFLOW_EFFECT_V1:${effect}>>>
Run accepted independent audit`;
  const fingerprint = createHash('sha256').update('preflight-composer-v1:\0' + priorDraft).digest('hex').slice(0,24);
  const guarded = `<<<FORGE_DRAFT_REPLACE_V1:${fingerprint}:abcdef0123456789abcdef0123456789>>>
${prompt}`;
  const f = fixture({controlPresent:false,projectUrl,initialDraft:priorDraft});
  expect(await f.prepare(undefined,undefined,prompt,'g-p-abc123')).toMatchObject({prepared:false,reason:'composer_not_empty'});
  expect(f.textarea.value).toBe(priorDraft);
  expect(f.state.sendClicks).toBe(0);
  expect(await f.dispatch(undefined,undefined,guarded,'g-p-abc123')).toMatchObject({dispatched:false,reason:'composer_replacement_mode_invalid'});
  expect(f.textarea.value).toBe(priorDraft);
  expect(await f.prepare(undefined,undefined,guarded,'g-p-abc123')).toMatchObject({prepared:true});
  expect(f.textarea.value).toBe(prompt);
  expect(f.state.sendClicks).toBe(0);
  expect(await f.dispatch(undefined,undefined,prompt,'g-p-abc123')).toMatchObject({dispatched:true,confirmed:true});
  expect(f.state.sendClicks).toBe(1);
});

test('Chrome extension retires an exact STOPPED bootstrap draft in prepare-only mode', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-abc123-forge/project';
  const staleEffect = 'fx_retired_bootstrap_123456';
  const currentEffect = 'fx_current_bootstrap_123456';
  const staleDraft = '<<<FORGE_WORKFLOW_EFFECT_V1:' + staleEffect + '>>>\nRetired bootstrap prompt';
  const nextPrompt = '<<<FORGE_WORKFLOW_EFFECT_V1:' + currentEffect + '>>>\nContinue the same goal';
  const fingerprint = createHash('sha256')
    .update('preflight-composer-v1:\0' + staleDraft)
    .digest('hex').slice(0, 24);
  const retired = '<<<FORGE_RETIRED_DRAFT_V1:' + staleEffect + ':' + fingerprint + '>>>\n' + nextPrompt;
  const f = fixture({controlPresent:false,projectUrl,initialDraft:staleDraft});
  expect(await f.dispatch(undefined,undefined,retired,'g-p-abc123'))
    .toMatchObject({dispatched:false,reason:'composer_replacement_mode_invalid'});
  expect(f.textarea.value).toBe(staleDraft);
  expect(await f.prepare(undefined,undefined,retired,'g-p-abc123')).toMatchObject({prepared:true});
  expect(f.textarea.value).toBe(nextPrompt);
  expect(f.state.sendClicks).toBe(0);
  expect(await f.dispatch(undefined,undefined,nextPrompt,'g-p-abc123')).toMatchObject({dispatched:true,confirmed:true});
  expect(f.state.sendClicks).toBe(1);
  const edited = fixture({controlPresent:false,projectUrl,initialDraft:staleDraft + ' human edit'});
  expect(await edited.prepare(undefined,undefined,retired,'g-p-abc123'))
    .toMatchObject({prepared:false,reason:'composer_not_empty'});
  expect(edited.textarea.value).toBe(staleDraft + ' human edit');
  expect(edited.state.sendClicks).toBe(0);
});

test('Chrome extension refuses stale digest and wrong project without touching unrelated draft', async () => {
  const priorDraft = '@forge unrelated content';
  const effect = 'fx_draft_guard_123456789';
  const prompt = `<<<FORGE_WORKFLOW_EFFECT_V1:${effect}>>>
Source`;
  const projectUrl='https://chatgpt.com/g/g-p-abc123-forge/project';
  const digest=createHash('sha256').update('preflight-composer-v1:\0' + priorDraft).digest('hex').slice(0,24);
  const guard=`<<<FORGE_DRAFT_REPLACE_V1:${digest}:abcdef0123456789abcdef0123456789>>>
${prompt}`;
  const f=fixture({controlPresent:false,projectUrl,initialDraft:priorDraft+' changed'});
  expect(await f.prepare(undefined,undefined,guard,'g-p-abc123')).toMatchObject({prepared:false,reason:'composer_not_empty'});
  expect(await f.prepare(undefined,undefined,guard,'g-p-other')).toMatchObject({prepared:false,reason:'target_identity_changed'});
  expect(f.textarea.value).toBe(priorDraft+' changed');
  expect(f.state.sendClicks).toBe(0);
});

test('foreign-effect Forge draft is preserved until exact ledger retirement is attested', async () => {
  const previous = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_old_serial_123456789>>>\nOld content spanning arbitrary lines';
  const current = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_new_serial_123456789>>>\nNew canonical task content';
  const f = fixture({ controlPresent: false, initialDraft: previous });
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  expect(await f.prepare(undefined, conversationId, current))
    .toMatchObject({ prepared: false, reason: 'composer_not_empty' });
  expect(await f.dispatch(undefined, conversationId, current))
    .toMatchObject({ dispatched: false, reason: 'composer_not_empty' });
  expect(f.textarea.value).toBe(previous);
  expect(f.state.sendClicks).toBe(0);
});

test('Supervisor replaces a partial same-effect marked draft before dispatch', async () => {
  const current = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_current_serial_123456>>>\nComplete current payload';
  const f = fixture({ controlPresent: false, initialDraft: '<<<FORGE_WORKFLOW_EFFECT_V1:fx_current_serial_123456>>>\nComplete' });
  expect(await f.prepare(undefined, '12345678-1234-1234-1234-123456789abc', current)).toMatchObject({ prepared: true });
  expect(f.textarea.value).toBe(current);
  expect(f.state.sendClicks).toBe(0);
  expect(await f.dispatch(undefined, '12345678-1234-1234-1234-123456789abc', current))
    .toMatchObject({ dispatched: true, confirmed: true });
  expect(f.state.sendClicks).toBe(1);
});

test('Supervisor refuses edited same-effect draft before a single Send', async () => {
  const current = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_current_serial_123456>>>\nComplete current payload';
  const edited = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_current_serial_123456>>>\nHuman changed draft';
  const f = fixture({ controlPresent: false, initialDraft: edited });
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  expect(await f.prepare(undefined, conversationId, current))
    .toMatchObject({ prepared: false, reason: 'composer_not_empty' });
  expect(f.textarea.value).toBe(edited);
  expect(f.state.sendClicks).toBe(0);
});

test('Supervisor refuses unmarked and malformed-magic drafts rather than overwriting them', async () => {
  const current = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_new_serial_123456789>>>\nCurrent';
  const drafts = [
    'A real unsent human draft',
    'human prefix <<<FORGE_WORKFLOW_EFFECT_V1:fx_old_serial_123456789>>>\nSome text',
    '<<<FORGE_WORKFLOW_EFFECT_V1:fx_old_serial_123456789>> trailing invalid syntax',
  ];
  for (const draft of drafts) {
    const f = fixture({ controlPresent: false, initialDraft: draft });
    expect(await f.prepare(undefined, '12345678-1234-1234-1234-123456789abc', current))
      .toMatchObject({ prepared: false, reason: 'composer_not_empty' });
    expect(f.textarea.value).toBe(draft);
    expect(f.state.sendClicks).toBe(0);
  }
});

test('Ordinary prompts cannot replace a Forge-marked Supervisor draft', async () => {
  const draft = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_old_serial_123456789>>>\nProtected';
  const f = fixture({ controlPresent: false, initialDraft: draft });
  expect(await f.dispatch(undefined, '12345678-1234-1234-1234-123456789abc', 'ordinary prompt'))
    .toMatchObject({ dispatched: false, reason: 'composer_not_empty' });
  expect(f.textarea.value).toBe(draft);
  expect(f.state.sendClicks).toBe(0);
});

test('account-level provider lane serializes sends without requiring serialized preparation', async () => {
  const scope = 'supervisor-prepare-send-serial-test';
  const events: string[] = [];
  let enteredFirst!: () => void;
  let finishFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const firstCanDispatch = new Promise<void>((resolve) => { finishFirst = resolve; });

  events.push('conversation:prepare');
  events.push('bootstrap:prepare');
  const first = withChatgptProviderDispatchLane(scope, async () => {
    enteredFirst();
    await firstCanDispatch;
    events.push('conversation:dispatch');
    return { providerAccepted: true };
  }, (outcome) => outcome);
  await firstEntered;
  const second = withChatgptProviderDispatchLane(scope, async () => {
    events.push('bootstrap:dispatch');
    return { providerAccepted: true };
  }, (outcome) => outcome);
  await Promise.resolve();
  expect(events).toEqual(['conversation:prepare', 'bootstrap:prepare']);
  finishFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(['conversation:prepare', 'bootstrap:prepare', 'conversation:dispatch', 'bootstrap:dispatch']);
});

test('an unconfirmed provider submission is not replayed by the shared lane', async () => {
  let submissions = 0;
  const result = await withChatgptProviderDispatchLane('supervisor-unknown-no-replay-test', async () => {
    submissions++;
    return { providerAccepted: false };
  }, (outcome) => outcome);
  expect(result.providerAccepted).toBe(false);
  expect(submissions).toBe(1);
});


test('adversarial draft matrix never overwrites another effect or human-edited suffix', async () => {
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  const effectId = 'fx_authorized_123456789';
  const canonical = '<<<FORGE_WORKFLOW_EFFECT_V1:' + effectId + '>>>\nExact canonical continuation';
  const marker = '<<<FORGE_WORKFLOW_EFFECT_V1:' + effectId + '>>>';
  const forged = Array.from({ length: 64 }, (_, i) =>
    '<<<FORGE_WORKFLOW_EFFECT_V1:fx_foreign_' + String(i).padStart(8, '0') + '>>>\n' + canonical);
  const edited = [
    marker + '\nExact canonical continuatioX',
    marker + '\nExact canonical continuation plus arbitrary human text',
    marker + '\nExact  canonical continuation',
    'human note\n' + marker,
    canonical + '\n@',
    canonical + '\nforge',
    'forge ' + canonical,
    '<<<FORGE_WORKFLOW_EFFECT_V1:crpe_foreign_123456789>>>\n' + canonical,
  ];
  for (const draft of [...forged, ...edited]) {
    const f = fixture({ controlPresent: false, initialDraft: draft });
    expect(await f.prepare(undefined, conversationId, canonical))
      .toMatchObject({ prepared: false, reason: 'composer_not_empty' });
    expect(await f.dispatch(undefined, conversationId, canonical))
      .toMatchObject({ dispatched: false, reason: 'composer_not_empty' });
    expect(f.textarea.value).toBe(draft);
    expect(f.state.sendClicks).toBe(0);
  }
});

test('same-effect canonical prefixes repair exactly before a single Send', async () => {
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_authorized_123456789>>>\nExact canonical continuation';
  const start = prompt.indexOf('\n') + 1;
  for (let chars = start; chars < prompt.length; chars += 5) {
    const f = fixture({ controlPresent: false, initialDraft: prompt.slice(0, chars) });
    expect(await f.prepare(undefined, conversationId, prompt)).toMatchObject({ prepared: true });
    expect(f.textarea.value).toBe(prompt);
    expect(f.state.sendClicks).toBe(0);
    expect(await f.dispatch(undefined, conversationId, prompt))
      .toMatchObject({ dispatched: true, confirmed: true });
    expect(f.state.sendClicks).toBe(1);
  }
});
