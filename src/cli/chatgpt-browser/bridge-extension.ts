import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const CHATGPT_BRIDGE_DEFAULT_PORT = 17651;
export const CHATGPT_BRIDGE_EXTENSION_RELATIVE_PATH = '.ai/harness/chatgpt/bridge-extension';

export interface ChatgptBridgeExtension {
  extensionDir: string;
  manifestPath: string;
  contentScriptPath: string;
  bridgeUrl: string;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderContentScript(bridgeUrl: string, token?: string): string {
  return `const FORGE_CHATGPT_BRIDGE_URL = ${JSON.stringify(bridgeUrl)};
const FORGE_CHATGPT_BRIDGE_TOKEN = ${JSON.stringify(token ?? '')};
function forgeAuthHeaders(base) {
  const headers = Object.assign({}, base);
  if (FORGE_CHATGPT_BRIDGE_TOKEN) headers['x-forge-bridge-token'] = FORGE_CHATGPT_BRIDGE_TOKEN;
  return headers;
}
const FORGE_CHATGPT_COMPOSERS = [
  '[data-testid="composer-text-input"]',
  '#prompt-textarea',
  'textarea[placeholder*="Message"]',
  'div[role="textbox"][contenteditable="true"]',
];
const FORGE_CHATGPT_SEND_BUTTONS = [
  '[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[data-testid*="send"]',
];
const FORGE_CHATGPT_ASSISTANT = '[data-message-author-role="assistant"]';
const FORGE_CHATGPT_USER = '[data-message-author-role="user"]';

function forgeVisible(element) {
  return Boolean(element && element.getClientRects && element.getClientRects().length);
}

function forgeComposer() {
  return FORGE_CHATGPT_COMPOSERS
    .map((selector) => document.querySelector(selector))
    .find(forgeVisible);
}

function forgeSendButton() {
  return FORGE_CHATGPT_SEND_BUTTONS
    .map((selector) => document.querySelector(selector))
    .find((button) => forgeVisible(button) && !button.disabled);
}

async function forgePost(path, payload) {
  await fetch(FORGE_CHATGPT_BRIDGE_URL + path, {
    method: 'POST',
    headers: forgeAuthHeaders({'content-type': 'application/json'}),
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

async function forgeJson(path) {
  const response = await fetch(FORGE_CHATGPT_BRIDGE_URL + path, {
    headers: forgeAuthHeaders({'accept': 'application/json'}),
  });
  if (!response.ok) return {};
  return await response.json();
}

async function forgeSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let forgeLastDispatch = null;

async function forgeHeartbeat() {
  await forgePost('/api/extension/heartbeat', {
    url: location.href,
    title: document.title,
    composerVisible: Boolean(forgeComposer()),
    lastDispatch: forgeLastDispatch,
    ts: new Date().toISOString(),
  });
}

async function forgeWaitForComposer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = forgeComposer();
    if (composer) return composer;
    await forgeSleep(500);
  }
  return null;
}

async function forgeSubmitPrompt(prompt) {
  const composer = await forgeWaitForComposer(30000);
  if (!composer) throw new Error('ChatGPT composer is not visible');
  composer.focus();
  if ('value' in composer) {
    composer.value = '';
    composer.dispatchEvent(new InputEvent('input', {inputType: 'deleteContentBackward', bubbles: true}));
    composer.value = prompt;
    composer.dispatchEvent(new InputEvent('input', {inputType: 'insertText', data: prompt, bubbles: true}));
  } else {
    composer.textContent = '';
    composer.dispatchEvent(new InputEvent('input', {inputType: 'deleteContentBackward', bubbles: true}));
    document.execCommand('insertText', false, prompt);
    if (!composer.textContent || !composer.textContent.includes(prompt.slice(0, Math.min(prompt.length, 80)))) {
      composer.textContent = prompt;
      composer.dispatchEvent(new InputEvent('input', {inputType: 'insertText', data: prompt, bubbles: true}));
    }
  }
  await forgeSleep(300);
  const button = forgeSendButton();
  if (button) {
    button.click();
    return;
  }
  composer.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
  composer.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}));
}

function forgeAssistantText() {
  const nodes = [...document.querySelectorAll(FORGE_CHATGPT_ASSISTANT)];
  return (nodes.at(-1)?.innerText || '').replace(/^ChatGPT said:\\s*/i, '').trim();
}

function forgeComposerText() {
  const composer = forgeComposer();
  if (!composer) return '';
  return ('value' in composer ? composer.value : composer.textContent || '').trim();
}

function forgeNormalizeOutboundText(value) {
  return String(value || '')
    .split(String.fromCharCode(10)).join(' ')
    .split(String.fromCharCode(13)).join(' ')
    .split(String.fromCharCode(9)).join(' ')
    .split(' ').filter(Boolean).join(' ')
    .trim();
}

function forgeOutboundFingerprint(prompt) {
  const normalized = forgeNormalizeOutboundText(prompt);
  const prefix = normalized.slice(0, 160);
  const suffix = normalized.length > 240 ? normalized.slice(-80) : '';
  return suffix ? prefix + '|' + suffix : prefix;
}

function forgeOutboundMessageMatchesPrompt(messageText, prompt) {
  const message = forgeNormalizeOutboundText(messageText);
  const normalizedPrompt = forgeNormalizeOutboundText(prompt);
  if (!message || !normalizedPrompt) return false;
  const prefix = normalizedPrompt.slice(0, Math.min(160, normalizedPrompt.length));
  const suffix = normalizedPrompt.length > 240 ? normalizedPrompt.slice(-80) : '';
  return message.includes(prefix) && (!suffix || message.includes(suffix));
}

function forgeHasConversationIdentity(urlValue) {
  try {
    const pathParts = new URL(urlValue, location.href).pathname.split('/').filter(Boolean);
    return pathParts.length >= 2 && pathParts[0] === 'c' && Boolean(pathParts[1]);
  } catch (_error) {
    return false;
  }
}

async function forgeWaitForSubmission(timeoutMs, initialUrl, prompt, initialUserMessageCount) {
  const deadline = Date.now() + timeoutMs;
  const initialHasConversation = forgeHasConversationIdentity(initialUrl);
  let transportSignalObserved = false;
  while (Date.now() < deadline) {
    if (!forgeComposerText() || document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]')) {
      transportSignalObserved = true;
    }
    const userMessages = [...document.querySelectorAll(FORGE_CHATGPT_USER)];
    const newUserMessage = userMessages.length > initialUserMessageCount ? userMessages.at(-1) : undefined;
    const outboundConfirmed = Boolean(newUserMessage && forgeOutboundMessageMatchesPrompt(newUserMessage.innerText || newUserMessage.textContent || '', prompt));
    const conversationEstablished = initialHasConversation || forgeHasConversationIdentity(location.href);
    if (outboundConfirmed && conversationEstablished) {
      return {
        conversationUrl: location.href,
        outboundFingerprint: forgeOutboundFingerprint(prompt),
        confirmedAt: new Date().toISOString(),
      };
    }
    await forgeSleep(100);
  }
  throw new Error(transportSignalObserved
    ? 'ChatGPT transport changed, but the corresponding outbound user message fingerprint was not observed'
    : 'ChatGPT prompt submission was not observed');
}

async function forgeWaitForAssistant(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const text = forgeAssistantText();
    if (text && text !== 'Retry') {
      if (text !== latest) {
        latest = text;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 5000) {
        return {text, stable: true};
      }
    }
    await forgeSleep(500);
  }
  return {text: latest, stable: false};
}

async function forgeRunTask(task) {
  await forgePost('/api/extension/task-started', {taskId: task.id, url: location.href});
  try {
    const initialUserMessageCount = document.querySelectorAll(FORGE_CHATGPT_USER).length;
    await forgeSubmitPrompt(task.prompt);
    if (task.dispatchOnly === true) {
      const confirmation = await forgeWaitForSubmission(Math.min(task.timeoutMs || 10000, 10000), location.href, task.prompt, initialUserMessageCount);
      forgeLastDispatch = {taskId: task.id, ...confirmation};
      await forgePost('/api/extension/dispatched', forgeLastDispatch).catch(() => undefined);
      return;
    }
    const capture = await forgeWaitForAssistant(task.timeoutMs || 180000);
    await forgePost('/api/extension/result', {
      taskId: task.id,
      status: capture.text ? (capture.stable ? 'completed' : 'incomplete_capture') : 'failed',
      output: capture.text || 'No assistant text was captured before timeout.',
      conversationUrl: location.href,
      error: capture.text ? undefined : {
        code: 'CHATGPT_BRIDGE_CAPTURE_TIMEOUT',
        message: 'no assistant text could be captured before timeout',
        recovery: 'Inspect the ChatGPT tab, then retry with a longer --timeout-ms.',
      },
    });
  } catch (error) {
    await forgePost('/api/extension/result', {
      taskId: task.id,
      status: 'failed',
      output: String(error),
      conversationUrl: location.href,
      error: {
        code: 'CHATGPT_BRIDGE_TASK_FAILED',
        message: String(error),
        recovery: 'Open ChatGPT in the authorized profile, verify the composer is visible, then retry.',
      },
    });
  }
}

async function forgePoll() {
  await forgeHeartbeat();
  const task = await forgeJson('/api/extension/task?pageUrl=' + encodeURIComponent(location.href));
  if (task && task.kind === 'consult' && task.id && task.prompt) {
    await forgeRunTask(task);
  }
}

setInterval(() => {
  forgePoll().catch(() => undefined);
}, 1000);
forgePoll().catch(() => undefined);
`;
}

export function writeChatgptBridgeExtension(repoRoot: string, bridgeUrl: string, token?: string): ChatgptBridgeExtension {
  const extensionDir = join(repoRoot, CHATGPT_BRIDGE_EXTENSION_RELATIVE_PATH);
  const manifestPath = join(extensionDir, 'manifest.json');
  const contentScriptPath = join(extensionDir, 'content-script.js');
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(manifestPath, json({
    manifest_version: 3,
    name: 'forge ChatGPT Bridge',
    version: '0.1.0',
    description: 'Lets forge use only the active ChatGPT Web page in this Chrome profile.',
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      `${bridgeUrl}/*`,
    ],
    content_scripts: [
      {
        matches: [
          'https://chatgpt.com/*',
          'https://chat.openai.com/*',
        ],
        js: ['content-script.js'],
        run_at: 'document_idle',
      },
    ],
  }), 'utf-8');
  writeFileSync(contentScriptPath, renderContentScript(bridgeUrl, token), 'utf-8');
  return { extensionDir, manifestPath, contentScriptPath, bridgeUrl };
}
