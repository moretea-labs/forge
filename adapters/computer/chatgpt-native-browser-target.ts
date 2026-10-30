import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ComputerChatgptBootstrapIdentity,
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationInventory,
  ComputerChatgptConversationObservation,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
  ComputerChatgptTargetIdentity,
  ComputerChatgptTargetResult,
  ComputerInteractionTargetAuthorityPort,
  ComputerSurfaceProviderBinding,
  ComputerSurfaceTarget,
  ComputerSurfaceTargetLease,
  ComputerChatgptNativeBrowserTab as NativeBrowserChatgptTab,
  ComputerChatgptNativeBrowserTabInventory as NativeBrowserChatgptTabInventory,
  ComputerChatgptNativeBrowserTargetDriver as NativeBrowserChatgptTargetDriver,
  ComputerChatgptNativeBrowserTargetPage as NativeBrowserChatgptTargetPage,
  ComputerChatgptNativeBrowserTabRef as TabRef,
} from '../../packages/plugin-runtime/computer';

const PROVIDER_ID = 'browser.macos-apple-events';
const LEGACY_PROVIDER_ID = 'browser.chrome-extension';
const TARGET_RECORD_NAMESPACE = 'chatgpt.target';
const BROWSER_PRODUCT = 'chrome';
const PREPARE_READY_ATTEMPTS = 5;
const PREPARE_READY_DELAY_MS = 100;
const RECOVERY_STOP_ATTEMPTS = 20;
const RECOVERY_STOP_DELAY_MS = 100;
const REPLACEMENT_PREFIX = /^<<<FORGE_DRAFT_REPLACE_V1:([a-f0-9]{24}):([a-f0-9]{32})>>>\n/;
const RETIRED_PREFIX = /^<<<FORGE_RETIRED_DRAFT_V1:((?:fx|crpe)_[a-zA-Z0-9_-]{8,120}):([a-f0-9]{24})>>>\n/;

type NativeTab = NativeBrowserChatgptTab;
type NativePage = NativeBrowserChatgptTargetPage;
type PageSnapshotInput = { includeUserHistory?: boolean; includePageText?: boolean; ownerToken?: string };
type PageIdentityInput = { conversationId?: string; projectId?: string; ownerToken?: string };
type PageDispatchResult =
  | { dispatched: false; reasonCode: string }
  | { dispatched: true; beforeUserCount: number; committed: boolean };
type PendingCreate = { ownerToken: string; url: string; existingTabRefs: string[]; startedAt: string };

function stableIdentity(identity: ComputerChatgptTargetIdentity) {
  return {
    surfaceType: 'browser-tab' as const,
    ownership: 'provider_owned' as const,
    resource: identity.namespace === 'chatgpt.conversation'
      ? { namespace: identity.namespace, key: identity.conversationId }
      : { namespace: identity.namespace, key: identity.bootstrapKey },
  };
}

function alias(identity: ComputerChatgptTargetIdentity): string {
  return identity.namespace === 'chatgpt.conversation'
    ? `chatgpt:conversation:${identity.conversationId}`
    : `chatgpt:bootstrap:${identity.bootstrapKey}`;
}

function identityValue(identity: ComputerChatgptTargetIdentity): Record<string, unknown> {
  return identity.namespace === 'chatgpt.conversation'
    ? { namespace: identity.namespace, conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl }
    : { namespace: identity.namespace, bootstrapKey: identity.bootstrapKey, projectUrl: identity.projectUrl };
}

function recordValue(target: ComputerSurfaceTarget | undefined): Record<string, unknown> {
  return (target?.compatibilityRecords.find((record) => record.namespace === TARGET_RECORD_NAMESPACE)?.value ?? {}) as Record<string, unknown>;
}

function pendingCreateFor(target: ComputerSurfaceTarget | undefined): PendingCreate | undefined {
  const pending = recordValue(target).pendingCreate;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return undefined;
  const candidate = pending as Record<string, unknown>;
  if (typeof candidate.ownerToken !== 'string' || !candidate.ownerToken
    || typeof candidate.url !== 'string' || !candidate.url
    || !Array.isArray(candidate.existingTabRefs)
    || !candidate.existingTabRefs.every((entry) => typeof entry === 'string')) return undefined;
  return {
    ownerToken: candidate.ownerToken,
    url: candidate.url,
    existingTabRefs: candidate.existingTabRefs as string[],
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
  };
}

function failure(
  code: string,
  input: { retryable?: boolean; failoverSafe?: boolean; humanAction?: 'login' | 'grant_permission' } = {},
): ComputerChatgptTargetResult {
  return {
    state: 'unavailable',
    failure: {
      code,
      retryable: input.retryable !== false,
      phase: 'pre_mutation',
      ...(input.failoverSafe === undefined ? {} : { failoverSafe: input.failoverSafe }),
      ...(input.humanAction ? { humanAction: input.humanAction } : {}),
    },
  };
}

function toRef(tab: Pick<NativeTab, 'windowId' | 'tabId'>): TabRef | undefined {
  if (tab.windowId === undefined || tab.windowId === null || tab.tabId === undefined || tab.tabId === null) return undefined;
  const windowId = String(tab.windowId);
  const tabId = String(tab.tabId);
  return windowId && tabId ? { windowId, tabId } : undefined;
}

function refKey(ref: TabRef): string {
  return `${ref.windowId}:${ref.tabId}`;
}

function sameRef(left: TabRef | undefined, right: TabRef | undefined): boolean {
  return Boolean(left && right && left.windowId === right.windowId && left.tabId === right.tabId);
}

function bindingRef(binding: ComputerSurfaceProviderBinding | undefined): TabRef | undefined {
  if (!binding?.windowId || !binding.tabId) return undefined;
  if (binding.browserProduct && binding.browserProduct !== BROWSER_PRODUCT) return undefined;
  return { windowId: String(binding.windowId), tabId: String(binding.tabId) };
}

function nativeBinding(ref: TabRef, nowMs: () => number, ownerToken?: string): ComputerSurfaceProviderBinding {
  return {
    providerId: PROVIDER_ID,
    observedAt: new Date(nowMs()).toISOString(),
    browserProduct: BROWSER_PRODUCT,
    windowId: ref.windowId,
    tabId: ref.tabId,
    ...(ownerToken ? { ownerToken } : {}),
  };
}

function projectIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
    return /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/(?:project\/?|c\/[^/]+\/?)$/i.exec(url.pathname)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function parseConversationUrl(value: string): { conversationId: string; canonicalUrl: string; projectId?: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    const marker = segments.lastIndexOf('c');
    if (marker < 0 || marker + 2 !== segments.length) return undefined;
    const conversationId = String(segments[marker + 1] ?? '').trim();
    if (!conversationId || conversationId.length > 256) return undefined;
    const projectId = projectIdFromUrl(url.toString());
    return {
      conversationId,
      canonicalUrl: `https://chatgpt.com/${segments.join('/')}`,
      ...(projectId ? { projectId } : {}),
    };
  } catch {
    return undefined;
  }
}

function exactConversation(identity: ComputerChatgptConversationIdentity, url: string): boolean {
  const actual = parseConversationUrl(url);
  if (!actual || actual.conversationId !== identity.conversationId) return false;
  const expectedProjectId = projectIdFromUrl(identity.canonicalUrl);
  return !expectedProjectId || actual.projectId === expectedProjectId;
}

function exactProject(identity: ComputerChatgptBootstrapIdentity, url: string, allowConversation: boolean): boolean {
  const expectedProjectId = projectIdFromUrl(identity.projectUrl);
  if (!expectedProjectId || projectIdFromUrl(url) !== expectedProjectId) return false;
  return allowConversation || !parseConversationUrl(url);
}

function identityMatchesUrl(identity: ComputerChatgptTargetIdentity, url: string, allowBootstrapConversation = true): boolean {
  return identity.namespace === 'chatgpt.conversation'
    ? exactConversation(identity, url)
    : exactProject(identity, url, allowBootstrapConversation);
}

function pageIdentityInput(identity: ComputerChatgptTargetIdentity, ownerToken?: string): PageIdentityInput {
  return identity.namespace === 'chatgpt.conversation'
    ? { conversationId: identity.conversationId, ...(ownerToken ? { ownerToken } : {}) }
    : { projectId: projectIdFromUrl(identity.projectUrl), ...(ownerToken ? { ownerToken } : {}) };
}

function actualPrompt(prompt: string): string {
  return prompt.replace(REPLACEMENT_PREFIX, '').replace(RETIRED_PREFIX, '')
    .replace(/^@forge\s+(?=<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>)/, '');
}

function pageSnapshot(input: PageSnapshotInput = {}): ComputerChatgptConversationObservation & { ownerTokenValid?: boolean } {
  const ASSISTANT = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
  const USER = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]';
  const COMPOSER = '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-text-input"], textarea[name="prompt"], textarea[placeholder*="Message"], textarea[placeholder*="消息"], form [contenteditable="true"], div[role="textbox"][contenteditable="true"]';
  const STOP = '[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"]';
  const TURN = '[data-testid^="conversation-turn-"]';
  const visible = (node: Element | null | undefined): boolean => Boolean(node?.getClientRects?.().length);
  const root = (): ParentNode => {
    const mains = Array.from(document.querySelectorAll('main')).filter(visible);
    return mains.length ? mains[mains.length - 1]! : document;
  };
  const messageText = (node: Element | undefined): string => {
    if (!node) return '';
    const semantic = node.querySelector('[data-chatgpt-selection-message-id]');
    return String(semantic?.textContent ?? (semantic as HTMLElement | null)?.innerText ?? node.textContent ?? '').trim();
  };
  const roleNodes = (selector: string): Element[] => {
    const seen = new Set<string>();
    const result: Element[] = [];
    for (const node of root().querySelectorAll(selector)) {
      const semanticKey = String(node.getAttribute('data-chatgpt-search-unit-key') || node.getAttribute('data-content-search-unit-key') || '');
      const messageIds = String(node.getAttribute('data-chatgpt-search-message-ids') || node.getAttribute('data-chatgpt-selection-message-id') || '');
      if (semanticKey || messageIds) {
        const key = `${semanticKey}|${messageIds}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      result.push(node);
    }
    return result;
  };
  const userNodes = roleNodes(USER);
  const assistantNodes = roleNodes(ASSISTANT);
  const turns = Array.from(root().querySelectorAll(TURN));
  const latestTurn = turns.length ? turns[turns.length - 1] : undefined;
  const orderedRoles = roleNodes(`${USER}, ${ASSISTANT}`);
  const lastRoleNode = orderedRoles.length ? orderedRoles[orderedRoles.length - 1] : undefined;
  const explicitRole = lastRoleNode?.getAttribute('data-message-author-role');
  const semanticRole = String(lastRoleNode?.getAttribute('data-chatgpt-search-unit-key')
    || lastRoleNode?.getAttribute('data-content-search-unit-key') || '');
  const latestTurnRole = explicitRole === 'user' || explicitRole === 'assistant'
    ? explicitRole
    : semanticRole.endsWith(':user') ? 'user' : semanticRole.endsWith(':assistant') ? 'assistant' : undefined;
  const visibleEditors = Array.from(document.querySelectorAll(COMPOSER))
    .filter((node) => visible(node) && !node.closest('[aria-hidden="true"], [hidden], [inert]'));
  const main = root();
  const inMain = main === document ? [] : visibleEditors.filter((node) => main.contains(node));
  const editors = inMain.length ? inMain : visibleEditors;
  const editor = editors.length === 1 ? editors[0] : undefined;
  const readComposer = (node: Element | undefined): string | undefined => {
    if (!node) return undefined;
    const blocks = (node as HTMLElement).isContentEditable ? Array.from((node as HTMLElement).children ?? []) : [];
    const observed = blocks.length > 0 && blocks.every((block) => block.tagName === 'P')
      ? blocks.map((block) => {
        const value = String(block.textContent ?? (block as HTMLElement).innerText ?? '').replace(/\r\n?/g, '\n');
        return !value.trim() ? '' : value;
      }).join('\n')
      : (node as HTMLInputElement).value ?? (node as HTMLElement).innerText ?? node.textContent;
    const text = String(observed ?? '').replace(/\r\n?/g, '\n');
    return text.trim() ? text : '';
  };
  const stopVisible = Array.from(document.querySelectorAll(`${STOP}, [data-is-streaming="true"]`)).some(visible);
  const currentTurnBusy = Boolean(latestTurn && Array.from(latestTurn.querySelectorAll('[aria-busy="true"]')).some(visible));
  const isGenerating = stopVisible || currentTurnBusy || latestTurnRole === 'user';
  const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
  const providerActivityText = normalize(latestTurn?.textContent ?? '').slice(-(64 * 1024));
  const statusNodes = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]')).filter(visible);
  const capacityNodes = Array.from(root().querySelectorAll('p, span, div'))
    .filter((node) => !node.closest(TURN) && !node.closest('[data-message-author-role]') && visible(node))
    .filter((node) => {
      const text = normalize(node.textContent);
      return text.length <= 250 && /(?:你已达到此对话的长度上限|此对话已达到长度上限|you(?:'ve| have) reached the (?:maximum length for this conversation|conversation length limit)|this conversation has reached its maximum length)/i.test(text);
    });
  const providerFailureText = [...statusNodes, ...capacityNodes].map((node) => normalize(node.textContent)).filter(Boolean).slice(-8).join('\n').slice(-250_000);
  return {
    url: location.href,
    title: document.title,
    latestUserText: messageText(userNodes[userNodes.length - 1]),
    latestAssistantResponse: messageText(assistantNodes[assistantNodes.length - 1]),
    ...(input.includeUserHistory === true ? {
      userMessages: userNodes.map(messageText).filter(Boolean),
      assistantMessages: assistantNodes.map(messageText).filter(Boolean),
    } : {}),
    ...(editor ? { composerText: readComposer(editor) } : {}),
    composerSelectorVersion: 'visible-single-v2',
    composerReplacementContract: 'exact-backed-up-project-draft-v1',
    providerActivityText,
    providerFailureText,
    ...(input.includePageText === true ? { pageText: String(document.body?.innerText ?? '').slice(-500_000) } : {}),
    ...(latestTurnRole ? { latestTurnRole } : {}),
    isGenerating,
    ...(input.ownerToken ? { ownerTokenValid: (() => { const current = String(window.name ?? ''); return !current || current === input.ownerToken; })() } : {}),
  };
}

function readWindowName(): string {
  return String(window.name ?? '');
}

function setWindowName(input: { ownerToken: string }): { ok: boolean; reasonCode?: string } {
  const current = String(window.name ?? '');
  if (current && current !== input.ownerToken) return { ok: false, reasonCode: 'COMPUTER_CHATGPT_OWNER_TOKEN_CONFLICT' };
  window.name = input.ownerToken;
  return { ok: window.name === input.ownerToken, ...(window.name === input.ownerToken ? {} : { reasonCode: 'COMPUTER_CHATGPT_OWNER_TOKEN_NOT_SET' }) };
}

function stopGeneration(input: PageIdentityInput): { stopVisible: boolean; clicked: boolean; reasonCode?: string } {
  const parseConversation = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      const segments = url.pathname.split('/').filter(Boolean);
      const marker = segments.lastIndexOf('c');
      return marker >= 0 && marker + 2 === segments.length ? segments[marker + 1] : undefined;
    } catch { return undefined; }
  };
  const projectId = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      return /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/(?:project\/?|c\/[^/]+\/?)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    } catch { return undefined; }
  };
  const exact = (): boolean => input.conversationId
    ? parseConversation(location.href) === input.conversationId
    : Boolean(input.projectId && projectId(location.href) === input.projectId);
  if (!exact()) return { stopVisible: false, clicked: false, reasonCode: 'target_identity_changed' };
  if (input.ownerToken) {
    const current = String(window.name ?? '');
    if (current && current !== input.ownerToken) return { stopVisible: false, clicked: false, reasonCode: 'owner_token_mismatch' };
  }
  const STOP = '[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"]';
  const visible = (node: Element | null | undefined): boolean => Boolean(node?.getClientRects?.().length);
  const stops = Array.from(document.querySelectorAll(STOP)).filter(visible);
  if (stops.length === 0) return { stopVisible: false, clicked: false };
  if (stops.length !== 1) return { stopVisible: true, clicked: false, reasonCode: 'provider_recovery_stop_ambiguous' };
  (stops[0] as HTMLElement).click();
  return { stopVisible: true, clicked: true };
}

function preparePrompt(input: PageIdentityInput & {
  prompt: string; mode?: 'send' | 'resume' | 'recover'; allowReplacement?: boolean; expectedExistingComposerText?: string;
}): { ready: true } | { ready: false; reasonCode: string } {
  const parseConversation = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      const segments = url.pathname.split('/').filter(Boolean);
      const marker = segments.lastIndexOf('c');
      return marker >= 0 && marker + 2 === segments.length ? segments[marker + 1] : undefined;
    } catch { return undefined; }
  };
  const projectId = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      return /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/(?:project\/?|c\/[^/]+\/?)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    } catch { return undefined; }
  };
  const expectedConversationId = input.conversationId;
  const expectedProjectId = input.projectId;
  const mode = input.mode ?? 'send';
  const prompt = input.prompt;
  const exact = (): boolean => {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return false;
    if (expectedConversationId) return parseConversation(location.href) === expectedConversationId;
    if (expectedProjectId) return projectId(location.href) === expectedProjectId && !parseConversation(location.href);
    return false;
  };
  if (!exact()) return { ready: false, reasonCode: 'target_identity_changed' };
  if (input.ownerToken) {
    const current = String(window.name ?? '');
    if (current && current !== input.ownerToken) return { ready: false, reasonCode: 'owner_token_mismatch' };
  }
  if (typeof prompt !== 'string' || !prompt.trim()) return { ready: false, reasonCode: 'prompt_required' };
  const replacementPrefix = /^<<<FORGE_DRAFT_REPLACE_V1:([a-f0-9]{24}):([a-f0-9]{32})>>>\n/;
  const retiredPrefix = /^<<<FORGE_RETIRED_DRAFT_V1:((?:fx|crpe)_[a-zA-Z0-9_-]{8,120}):([a-f0-9]{24})>>>\n/;
  const replacement = replacementPrefix.exec(prompt);
  const retired = retiredPrefix.exec(prompt);
  if (replacement && (!input.allowReplacement || !expectedProjectId || mode !== 'send')) return { ready: false, reasonCode: 'composer_replacement_mode_invalid' };
  if (retired && (!input.allowReplacement || !expectedProjectId || mode !== 'send' || replacement)) return { ready: false, reasonCode: 'composer_replacement_mode_invalid' };
  const actual = replacement ? prompt.slice(replacement[0].length) : retired ? prompt.slice(retired[0].length) : prompt;
  const STOP = '[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"]';
  const SEND = 'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"], button[data-testid*="send"]';
  const USER = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]';
  const ASSISTANT = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
  const COMPOSER = '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-text-input"], textarea[name="prompt"], textarea[placeholder*="Message"], textarea[placeholder*="消息"], form [contenteditable="true"], div[role="textbox"][contenteditable="true"]';
  const TURN = '[data-testid^="conversation-turn-"]';
  const visible = (node: Element | null | undefined): boolean => Boolean(node?.getClientRects?.().length);
  const root = (): ParentNode => {
    const mains = Array.from(document.querySelectorAll('main')).filter(visible);
    return mains.length ? mains[mains.length - 1]! : document;
  };
  const isGenerating = (): boolean => {
    if (Array.from(document.querySelectorAll(`${STOP}, [data-is-streaming="true"]`)).some(visible)) return true;
    const turns = root().querySelectorAll(TURN);
    const current = turns.length ? turns[turns.length - 1] : undefined;
    if (current && Array.from(current.querySelectorAll('[aria-busy="true"]')).some(visible)) return true;
    const roles = Array.from(root().querySelectorAll(`${USER}, ${ASSISTANT}`));
    const last = roles.length ? roles[roles.length - 1] : undefined;
    const role = last?.getAttribute('data-message-author-role');
    const key = String(last?.getAttribute('data-chatgpt-search-unit-key') || last?.getAttribute('data-content-search-unit-key') || '');
    return role === 'user' || key.endsWith(':user');
  };
  if (mode === 'recover' && Array.from(document.querySelectorAll(STOP)).some(visible)) return { ready: false, reasonCode: 'provider_recovery_stop_pending' };
  const visibleEditors = Array.from(document.querySelectorAll(COMPOSER))
    .filter((node) => visible(node) && !node.closest('[aria-hidden="true"], [hidden], [inert]'));
  const main = root();
  const inMain = main === document ? [] : visibleEditors.filter((node) => main.contains(node));
  const editors = inMain.length ? inMain : visibleEditors;
  const node = editors.length === 1 ? editors[0] : undefined;
  if (!node) return { ready: false, reasonCode: 'composer_missing' };
  const actualPrompt = actual.replace(/^@forge\s+(?=<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>)/, '');
  const supervisor = /^(?:@forge\s+)?<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>/.test(actual);
  const expected = String(actualPrompt).replace(/\r\n?/g, '\n');
  const readText = (element: Element): string => {
    const blocks = (element as HTMLElement).isContentEditable ? Array.from((element as HTMLElement).children ?? []) : [];
    const observed = blocks.length > 0 && blocks.every((block) => block.tagName === 'P')
      ? blocks.map((block) => {
        const value = String(block.textContent ?? (block as HTMLElement).innerText ?? '').replace(/\r\n?/g, '\n');
        return !value.trim() ? '' : value;
      }).join('\n')
      : (element as HTMLInputElement).value ?? (element as HTMLElement).innerText ?? element.textContent;
    const text = String(observed ?? '').replace(/\r\n?/g, '\n');
    return text.trim() ? text : '';
  };
  const existing = readText(node);
  const ownedDrafts = supervisor ? [expected, expected + '\n', actualPrompt + '\n@', actualPrompt + '\nforge', 'forge ' + actualPrompt] : [expected];
  if (node.querySelector('[plugin-mention-name], [app-mention-name]')) return { ready: false, reasonCode: 'composer_has_app_mention' };
  const unowned = Boolean(existing && !ownedDrafts.includes(existing));
  if (unowned && ((!replacement && !retired) || !supervisor)) return { ready: false, reasonCode: 'composer_not_empty' };
  if (retired && (!unowned || !existing.startsWith(`<<<FORGE_WORKFLOW_EFFECT_V1:${retired[1]}>>>`))) return { ready: false, reasonCode: 'composer_not_empty' };
  if (unowned && (!input.allowReplacement || input.expectedExistingComposerText !== existing)) return { ready: false, reasonCode: 'composer_not_empty' };
  if (!exact()) return { ready: false, reasonCode: 'target_identity_changed' };
  if ((editors.length === 1 ? editors[0] : undefined) !== node || readText(node) !== existing) return { ready: false, reasonCode: 'composer_not_empty' };
  if (existing !== expected && existing !== expected + '\n') {
    (node as HTMLElement).focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(node, actualPrompt); else (node as HTMLInputElement).value = actualPrompt;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: actualPrompt }));
    } else if ((node as HTMLElement).isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = document.execCommand('insertText', false, actualPrompt);
      if (!inserted || readText(node) !== expected) {
        node.textContent = actualPrompt;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: actualPrompt }));
      }
      selection?.removeAllRanges();
    }
  }
  if (!exact()) return { ready: false, reasonCode: 'target_identity_changed' };
  const currentEditors = Array.from(document.querySelectorAll(COMPOSER))
    .filter((candidate) => visible(candidate) && !candidate.closest('[aria-hidden="true"], [hidden], [inert]'));
  const mainEditors = currentEditors.filter((candidate) => main !== document && main.contains(candidate));
  const candidates = mainEditors.length ? mainEditors : currentEditors;
  const liveEditor = candidates.length === 1 ? candidates[0] : undefined;
  if (liveEditor !== node) return { ready: false, reasonCode: 'composer_write_unconfirmed' };
  if (readText(node) !== expected && readText(node) !== expected + '\n') return { ready: false, reasonCode: 'composer_write_unconfirmed' };
  if (mode !== 'recover' && isGenerating()) return { ready: false, reasonCode: 'provider_busy' };
  const buttons = Array.from(document.querySelectorAll(SEND)).filter(visible);
  const send = buttons.length === 1 ? buttons[0] : undefined;
  if (!send) return { ready: false, reasonCode: 'send_button_missing' };
  if ((send as HTMLButtonElement).disabled || send.getAttribute('aria-disabled') === 'true') return { ready: false, reasonCode: 'send_button_disabled' };
  return { ready: true };
}

function dispatchPrompt(input: PageIdentityInput & { prompt: string; mode?: 'send' | 'resume' | 'recover' }): PageDispatchResult {
  const parseConversation = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      const segments = url.pathname.split('/').filter(Boolean);
      const marker = segments.lastIndexOf('c');
      return marker >= 0 && marker + 2 === segments.length ? segments[marker + 1] : undefined;
    } catch { return undefined; }
  };
  const projectId = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      return /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/(?:project\/?|c\/[^/]+\/?)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    } catch { return undefined; }
  };
  const mode = input.mode ?? 'send';
  const exact = (): boolean => {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return false;
    if (input.conversationId) return parseConversation(location.href) === input.conversationId;
    return Boolean(input.projectId && projectId(location.href) === input.projectId && !parseConversation(location.href));
  };
  if (!exact()) return { dispatched: false, reasonCode: 'target_identity_changed' };
  if (input.ownerToken) {
    const current = String(window.name ?? '');
    if (current && current !== input.ownerToken) return { dispatched: false, reasonCode: 'owner_token_mismatch' };
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return { dispatched: false, reasonCode: 'prompt_required' };
  const STOP = '[data-testid="stop-button"], [data-testid*="stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"], button[aria-label="停止生成"]';
  const SEND = 'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"], button[data-testid*="send"]';
  const USER = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]';
  const ASSISTANT = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
  const COMPOSER = '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-text-input"], textarea[name="prompt"], textarea[placeholder*="Message"], textarea[placeholder*="消息"], form [contenteditable="true"], div[role="textbox"][contenteditable="true"]';
  const TURN = '[data-testid^="conversation-turn-"]';
  const visible = (node: Element | null | undefined): boolean => Boolean(node?.getClientRects?.().length);
  const root = (): ParentNode => {
    const mains = Array.from(document.querySelectorAll('main')).filter(visible);
    return mains.length ? mains[mains.length - 1]! : document;
  };
  const messageText = (node: Element | undefined): string => {
    if (!node) return '';
    const semantic = node.querySelector('[data-chatgpt-selection-message-id]');
    return String(semantic?.textContent ?? (semantic as HTMLElement | null)?.innerText ?? node.textContent ?? '').trim();
  };
  const roles = (selector: string): Element[] => {
    const seen = new Set<string>();
    const result: Element[] = [];
    for (const node of root().querySelectorAll(selector)) {
      const key = String(node.getAttribute('data-chatgpt-search-unit-key') || node.getAttribute('data-content-search-unit-key') || '');
      const ids = String(node.getAttribute('data-chatgpt-search-message-ids') || node.getAttribute('data-chatgpt-selection-message-id') || '');
      if (key || ids) {
        const fingerprint = `${key}|${ids}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
      }
      result.push(node);
    }
    return result;
  };
  const isGenerating = (): boolean => {
    if (Array.from(document.querySelectorAll(`${STOP}, [data-is-streaming="true"]`)).some(visible)) return true;
    const turns = root().querySelectorAll(TURN);
    const current = turns.length ? turns[turns.length - 1] : undefined;
    if (current && Array.from(current.querySelectorAll('[aria-busy="true"]')).some(visible)) return true;
    const all = roles(`${USER}, ${ASSISTANT}`);
    const last = all.length ? all[all.length - 1] : undefined;
    return last?.getAttribute('data-message-author-role') === 'user'
      || String(last?.getAttribute('data-chatgpt-search-unit-key') || last?.getAttribute('data-content-search-unit-key') || '').endsWith(':user');
  };
  const editors = Array.from(document.querySelectorAll(COMPOSER))
    .filter((node) => visible(node) && !node.closest('[aria-hidden="true"], [hidden], [inert]'));
  const main = root();
  const mainEditors = main === document ? [] : editors.filter((node) => main.contains(node));
  const candidates = mainEditors.length ? mainEditors : editors;
  const node = candidates.length === 1 ? candidates[0] : undefined;
  if (!node) return { dispatched: false, reasonCode: 'composer_missing' };
  const payload = actualPrompt(input.prompt);
  const expected = String(payload).replace(/\r\n?/g, '\n');
  const supervisor = /^(?:@forge\s+)?<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>/.test(payload);
  const readText = (): string => {
    const blocks = (node as HTMLElement).isContentEditable ? Array.from((node as HTMLElement).children ?? []) : [];
    const observed = blocks.length > 0 && blocks.every((block) => block.tagName === 'P')
      ? blocks.map((block) => {
        const value = String(block.textContent ?? (block as HTMLElement).innerText ?? '').replace(/\r\n?/g, '\n');
        return !value.trim() ? '' : value;
      }).join('\n')
      : (node as HTMLInputElement).value ?? (node as HTMLElement).innerText ?? node.textContent;
    const text = String(observed ?? '').replace(/\r\n?/g, '\n');
    return text.trim() ? text : '';
  };
  const currentComposer = readText();
  const ownedDrafts = supervisor ? [expected, expected + '\n', payload + '\n@', payload + '\nforge', 'forge ' + payload] : [expected];
  if (node.querySelector('[plugin-mention-name], [app-mention-name]')) return { dispatched: false, reasonCode: 'composer_has_app_mention' };
  if (!ownedDrafts.includes(currentComposer)) return { dispatched: false, reasonCode: 'composer_not_prepared' };
  if (mode !== 'recover' && isGenerating()) return { dispatched: false, reasonCode: 'provider_busy' };
  if (mode === 'recover' && Array.from(document.querySelectorAll(STOP)).some(visible)) return { dispatched: false, reasonCode: 'provider_recovery_stop_pending' };
  const buttons = Array.from(document.querySelectorAll(SEND)).filter(visible);
  const send = buttons.length === 1 ? buttons[0] : undefined;
  if (!send) return { dispatched: false, reasonCode: 'send_button_missing' };
  if ((send as HTMLButtonElement).disabled || send.getAttribute('aria-disabled') === 'true') return { dispatched: false, reasonCode: 'send_button_disabled' };
  if (!exact()) return { dispatched: false, reasonCode: 'target_identity_changed' };
  const before = roles(USER);
  if (!send.isConnected || !visible(send)) return { dispatched: false, reasonCode: 'send_button_missing' };
  const committedImmediately = (): boolean => {
    const after = roles(USER);
    return after.length > before.length && messageText(after[after.length - 1]) === expected;
  };
  try {
    (send as HTMLElement).click();
  } catch {
    // Once click begins, an exception cannot prove that the provider did not receive the message.
    let committed = false;
    try { committed = committedImmediately(); } catch { /* Reconcile through a later read-only observation. */ }
    return { dispatched: true, beforeUserCount: before.length, committed };
  }
  return { dispatched: true, beforeUserCount: before.length, committed: committedImmediately() };
}

function restoreComposerDraft(input: PageIdentityInput & { expectedPrompt: string; restoreText: string }): { restored: boolean; reasonCode?: string } {
  const parseConversation = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      const segments = url.pathname.split('/').filter(Boolean);
      const marker = segments.lastIndexOf('c');
      return marker >= 0 && marker + 2 === segments.length ? segments[marker + 1] : undefined;
    } catch { return undefined; }
  };
  const projectId = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return undefined;
      return /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/(?:project\/?|c\/[^/]+\/?)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    } catch { return undefined; }
  };
  const exact = (): boolean => {
    if (input.conversationId) return parseConversation(location.href) === input.conversationId;
    return Boolean(input.projectId && projectId(location.href) === input.projectId && !parseConversation(location.href));
  };
  if (!exact()) return { restored: false, reasonCode: 'target_identity_changed' };
  if (input.ownerToken) {
    const current = String(window.name ?? '');
    if (current && current !== input.ownerToken) return { restored: false, reasonCode: 'owner_token_mismatch' };
  }
  const COMPOSER = '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-text-input"], textarea[name="prompt"], textarea[placeholder*="Message"], textarea[placeholder*="消息"], form [contenteditable="true"], div[role="textbox"][contenteditable="true"]';
  const visible = (node: Element | null | undefined): boolean => Boolean(node?.getClientRects?.().length);
  const root = (): ParentNode => {
    const mains = Array.from(document.querySelectorAll('main')).filter(visible);
    return mains.length ? mains[mains.length - 1]! : document;
  };
  const editors = Array.from(document.querySelectorAll(COMPOSER))
    .filter((node) => visible(node) && !node.closest('[aria-hidden="true"], [hidden], [inert]'));
  const main = root();
  const mainEditors = main === document ? [] : editors.filter((node) => main.contains(node));
  const candidates = mainEditors.length ? mainEditors : editors;
  const node = candidates.length === 1 ? candidates[0] : undefined;
  if (!node) return { restored: false, reasonCode: 'composer_missing' };
  if (node.querySelector('[plugin-mention-name], [app-mention-name]')) return { restored: false, reasonCode: 'composer_has_app_mention' };
  const readText = (element: Element): string => {
    const blocks = (element as HTMLElement).isContentEditable ? Array.from((element as HTMLElement).children ?? []) : [];
    const observed = blocks.length > 0 && blocks.every((block) => block.tagName === 'P')
      ? blocks.map((block) => {
        const value = String(block.textContent ?? (block as HTMLElement).innerText ?? '').replace(/\r\n?/g, '\n');
        return !value.trim() ? '' : value;
      }).join('\n')
      : (element as HTMLInputElement).value ?? (element as HTMLElement).innerText ?? element.textContent;
    const text = String(observed ?? '').replace(/\r\n?/g, '\n');
    return text.trim() ? text : '';
  };
  const expected = String(input.expectedPrompt).replace(/\r\n?/g, '\n');
  const current = readText(node);
  if (current !== expected && current !== expected + '\n') return { restored: false, reasonCode: 'composer_changed' };
  if (!exact()) return { restored: false, reasonCode: 'target_identity_changed' };
  const restoreText = String(input.restoreText ?? '').replace(/\r\n?/g, '\n');
  (node as HTMLElement).focus();
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(node, restoreText); else (node as HTMLInputElement).value = restoreText;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: restoreText }));
  } else if ((node as HTMLElement).isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand('insertText', false, restoreText);
    if (!inserted || readText(node) !== restoreText) {
      node.textContent = restoreText;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: restoreText }));
    }
    selection?.removeAllRanges();
  }
  const restored = readText(node);
  return { restored: restored === restoreText || restored === restoreText + '\n' };
}

type PreparedDraftReceipt = {
  schemaVersion: 1;
  effectId: string;
  promptFingerprint: string;
  originalFingerprint: string;
  replacedFingerprint: string;
  originalKind: 'empty' | 'backup';
  phase: 'preparing' | 'prepared' | 'dispatching';
};

function composerFingerprint(value: string): string {
  return createHash('sha256').update('preflight-composer-v1:\0' + value.replace(/\r\n?/g, '\n')).digest('hex').slice(0, 24);
}

function composerMatchesFingerprint(value: string, fingerprint: string): boolean {
  const normalized = value.replace(/\r\n?/g, '\n');
  return composerFingerprint(normalized) === fingerprint
    || (normalized.endsWith('\n') && composerFingerprint(normalized.slice(0, -1)) === fingerprint);
}

function promptText(prompt: string): string {
  return actualPrompt(prompt).replace(/\r\n?/g, '\n');
}

function effectIdForPrompt(prompt: string): string | undefined {
  return /^<<<FORGE_WORKFLOW_EFFECT_V1:((?:fx|crpe)_[a-zA-Z0-9_-]{8,120})>>>/.exec(promptText(prompt))?.[1];
}

function preparedDraftFor(target: ComputerSurfaceTarget): PreparedDraftReceipt | undefined {
  const value = recordValue(target).preparedDraft;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMPUTER_CHATGPT_NATIVE_DRAFT_RECEIPT_INVALID');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1
    || typeof candidate.effectId !== 'string'
    || !/^(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}$/.test(candidate.effectId)
    || typeof candidate.promptFingerprint !== 'string'
    || !/^[a-f0-9]{24}$/.test(candidate.promptFingerprint)
    || typeof candidate.originalFingerprint !== 'string'
    || !/^[a-f0-9]{24}$/.test(candidate.originalFingerprint)
    || typeof candidate.replacedFingerprint !== 'string'
    || !/^[a-f0-9]{24}$/.test(candidate.replacedFingerprint)
    || (candidate.originalKind !== 'empty' && candidate.originalKind !== 'backup')
    || (candidate.phase !== 'preparing' && candidate.phase !== 'prepared' && candidate.phase !== 'dispatching')) {
    throw new Error('COMPUTER_CHATGPT_NATIVE_DRAFT_RECEIPT_INVALID');
  }
  return {
    schemaVersion: 1,
    effectId: candidate.effectId,
    promptFingerprint: candidate.promptFingerprint,
    originalFingerprint: candidate.originalFingerprint,
    replacedFingerprint: candidate.replacedFingerprint,
    originalKind: candidate.originalKind,
    phase: candidate.phase,
  };
}

function draftBackupPath(controllerHome: string, effectId: string, fingerprint: string): string {
  return join(controllerHome, 'supervisor', 'draft-backups', 'composer-' + effectId + '-' + fingerprint + '.json');
}

function readDraftBackup(
  controllerHome: string,
  identity: ComputerChatgptTargetIdentity,
  effectId: string,
  fingerprint: string,
): string | undefined {
  if (identity.namespace !== 'chatgpt.bootstrap') return undefined;
  try {
    const raw = JSON.parse(readFileSync(draftBackupPath(controllerHome, effectId, fingerprint), 'utf8')) as Record<string, unknown>;
    if (raw.schemaVersion !== 1
      || raw.taskId !== identity.bootstrapKey
      || raw.effectId !== effectId
      || raw.projectUrl !== identity.projectUrl
      || raw.fingerprint !== fingerprint
      || raw.selectorVersion !== 'visible-single-v2'
      || typeof raw.composerText !== 'string'
      || composerFingerprint(raw.composerText) !== fingerprint
      || typeof raw.observedUrl !== 'string'
      || !identityMatchesUrl(identity, raw.observedUrl, false)) return undefined;
    return raw.composerText;
  } catch {
    return undefined;
  }
}

function writeDraftBackup(
  controllerHome: string,
  identity: ComputerChatgptTargetIdentity,
  effectId: string,
  snapshot: ComputerChatgptConversationObservation,
  currentFingerprint: string,
  originalText: string = snapshot.composerText ?? '',
): boolean {
  const backupText = originalText.replace(/\r\n?/g, '\n');
  const backupFingerprint = composerFingerprint(backupText);
  if (identity.namespace !== 'chatgpt.bootstrap'
    || snapshot.composerSelectorVersion !== 'visible-single-v2'
    || typeof snapshot.composerText !== 'string'
    || composerFingerprint(snapshot.composerText) !== currentFingerprint
    || !identityMatchesUrl(identity, snapshot.url, false)) return false;
  const base = join(controllerHome, 'supervisor', 'draft-backups');
  const path = draftBackupPath(controllerHome, effectId, backupFingerprint);
  const payload = {
    schemaVersion: 1,
    taskId: identity.bootstrapKey,
    effectId,
    projectUrl: identity.projectUrl,
    observedUrl: snapshot.url,
    selectorVersion: snapshot.composerSelectorVersion,
    fingerprint: backupFingerprint,
    composerText: backupText,
  };
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) return false;
  }
  return readDraftBackup(controllerHome, identity, effectId, backupFingerprint) === backupText;
}

function restoreTextForReceipt(
  controllerHome: string,
  identity: ComputerChatgptTargetIdentity,
  receipt: PreparedDraftReceipt,
): string | undefined {
  if (receipt.originalKind === 'empty') return receipt.originalFingerprint === composerFingerprint('') ? '' : undefined;
  return readDraftBackup(controllerHome, identity, receipt.effectId, receipt.originalFingerprint);
}

export class MacOsBrowserChatgptConversationTargetPort implements ComputerChatgptConversationTargetPort {
  constructor(
    private readonly controllerHome: string,
    private readonly authority: ComputerInteractionTargetAuthorityPort,
    private readonly driver: NativeBrowserChatgptTargetDriver,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  private find(identity: ComputerChatgptTargetIdentity): ComputerSurfaceTarget | undefined {
    return this.authority.findSurfaceByStableIdentity(this.controllerHome, stableIdentity(identity));
  }

  private upsert(
    identity: ComputerChatgptTargetIdentity,
    binding?: ComputerSurfaceProviderBinding,
    extra: Record<string, unknown> = {},
  ): ComputerSurfaceTarget {
    const existing = this.find(identity);
    const previous = existing?.compatibilityRecords.find((record) => record.namespace === TARGET_RECORD_NAMESPACE);
    const value: Record<string, unknown> = { ...((previous?.value ?? {}) as Record<string, unknown>), ...identityValue(identity), ...extra };
    if (extra.clearPendingCreate === true) delete value.pendingCreate;
    delete value.clearPendingCreate;
    const compatibilityRecords = [
      ...(existing?.compatibilityRecords.filter((record) => record.namespace !== TARGET_RECORD_NAMESPACE) ?? []),
      { namespace: TARGET_RECORD_NAMESPACE, schemaVersion: 1, value, updatedAt: new Date(this.nowMs()).toISOString() },
    ];
    return this.authority.upsertSurface(this.controllerHome, {
      stableIdentity: stableIdentity(identity),
      compatibilityAliases: [alias(identity)],
      visibility: 'controller',
      ...(binding ? { providerBinding: binding } : {}),
      compatibilityRecords,
      reactivate: true,
    }).target;
  }

  private async writeCompatibility(targetId: string, identity: ComputerChatgptTargetIdentity, extra: Record<string, unknown>): Promise<ComputerSurfaceTarget> {
    return await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => {
      const current = lease.current();
      const previous = current.compatibilityRecords.find((record) => record.namespace === TARGET_RECORD_NAMESPACE);
      const value: Record<string, unknown> = { ...((previous?.value ?? {}) as Record<string, unknown>), ...identityValue(identity), ...extra };
      if (extra.clearPendingCreate === true) delete value.pendingCreate;
      delete value.clearPendingCreate;
      lease.putCompatibility({ namespace: TARGET_RECORD_NAMESPACE, schemaVersion: 1, value, updatedAt: new Date(this.nowMs()).toISOString() });
      return lease.current();
    });
  }

  private putPreparedDraft(lease: ComputerSurfaceTargetLease, identity: ComputerChatgptTargetIdentity, receipt: PreparedDraftReceipt): void {
    const current = lease.current();
    const previous = current.compatibilityRecords.find((record) => record.namespace === TARGET_RECORD_NAMESPACE);
    const value: Record<string, unknown> = { ...((previous?.value ?? {}) as Record<string, unknown>), ...identityValue(identity), preparedDraft: receipt };
    lease.putCompatibility({ namespace: TARGET_RECORD_NAMESPACE, schemaVersion: 1, value, updatedAt: new Date(this.nowMs()).toISOString() });
  }

  private clearPreparedDraft(lease: ComputerSurfaceTargetLease, expected: PreparedDraftReceipt): void {
    const current = lease.current();
    const receipt = preparedDraftFor(current);
    if (!receipt || receipt.effectId !== expected.effectId || receipt.promptFingerprint !== expected.promptFingerprint || receipt.phase !== expected.phase) return;
    const previous = current.compatibilityRecords.find((record) => record.namespace === TARGET_RECORD_NAMESPACE);
    const value: Record<string, unknown> = { ...((previous?.value ?? {}) as Record<string, unknown>) };
    delete value.preparedDraft;
    lease.putCompatibility({ namespace: TARGET_RECORD_NAMESPACE, schemaVersion: 1, value, updatedAt: new Date(this.nowMs()).toISOString() });
  }

  private async bindAsync(identity: ComputerChatgptTargetIdentity, binding: ComputerSurfaceProviderBinding, clearPendingCreate = false): Promise<ComputerSurfaceTarget> {
    const record = this.upsert(identity);
    const ref = bindingRef(binding);
    if (!ref) return record;
    return await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => {
      const previous = lease.current().providerBinding;
      const samePhysical = sameRef(bindingRef(previous), ref)
        && (!previous?.browserProduct || previous.browserProduct === BROWSER_PRODUCT);
      const ownerToken = binding.ownerToken || (samePhysical ? previous?.ownerToken : undefined);
      lease.bind(nativeBinding(ref, this.nowMs, ownerToken));
      const current = lease.current();
      const previousRecord = current.compatibilityRecords.find((item) => item.namespace === TARGET_RECORD_NAMESPACE);
      const value: Record<string, unknown> = { ...((previousRecord?.value ?? {}) as Record<string, unknown>), ...identityValue(identity) };
      if (clearPendingCreate) delete value.pendingCreate;
      lease.putCompatibility({ namespace: TARGET_RECORD_NAMESPACE, schemaVersion: 1, value, updatedAt: new Date(this.nowMs()).toISOString() });
      return lease.current();
    });
  }

  private async clearBinding(targetId: string, expected: ComputerSurfaceProviderBinding): Promise<void> {
    await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => {
      const binding = lease.current().providerBinding;
      if (!binding || binding.providerId !== expected.providerId || binding.browserProduct !== expected.browserProduct
        || binding.providerSessionId !== expected.providerSessionId || binding.windowId !== expected.windowId
        || binding.tabId !== expected.tabId || binding.ownerToken !== expected.ownerToken) {
        throw new Error('COMPUTER_CHATGPT_NATIVE_BINDING_CHANGED');
      }
      lease.clearBinding();
    });
  }
  private target(identity: ComputerChatgptTargetIdentity, record: ComputerSurfaceTarget): ComputerChatgptConversationTarget {
    return {
      targetId: record.targetId,
      identity,
      observe: async (options) => await this.withPinnedPage(record.targetId, async (page, binding, lease) => {
        const snapshot = await page.evaluate<ComputerChatgptConversationObservation & { ownerTokenValid?: boolean }>(pageSnapshot as (...args: unknown[]) => unknown, {
          ...(options ?? {}),
          ...(binding.ownerToken ? { ownerToken: binding.ownerToken } : {}),
        });
        const { ownerTokenValid, ...observation } = snapshot;
        if (!identityMatchesUrl(identity, observation.url, true)) throw new Error('COMPUTER_CHATGPT_NATIVE_TARGET_IDENTITY_CHANGED');
        if (ownerTokenValid === false) throw new Error('COMPUTER_CHATGPT_NATIVE_OWNER_TOKEN_MISMATCH');
        const receipt = preparedDraftFor(lease.current());
        if (receipt?.phase === 'dispatching' && options?.includeUserHistory === true
          && (observation.userMessages ?? []).some((message) => composerMatchesFingerprint(message, receipt.promptFingerprint))) {
          try { this.clearPreparedDraft(lease, receipt); } catch { /* Observation remains useful; reconciliation can retry receipt cleanup. */ }
        }
        return observation;
      }),
      prepare: async (prompt, options) => await this.prepare(record.targetId, identity, prompt, options?.mode),
      dispatch: async (prompt, options) => await this.dispatch(record.targetId, identity, prompt, options?.mode),
    };
  }

  private async withPinnedPage<T>(
    targetId: string,
    operation: (page: NativePage, binding: ComputerSurfaceProviderBinding, lease: ComputerSurfaceTargetLease) => Promise<T>,
  ): Promise<T> {
    return await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => {
      const binding = lease.current().providerBinding;
      if (!binding || binding.providerId !== PROVIDER_ID || binding.browserProduct !== BROWSER_PRODUCT) {
        throw new Error('COMPUTER_CHATGPT_NATIVE_TARGET_BINDING_UNAVAILABLE');
      }
      const ref = bindingRef(binding);
      if (!ref) throw new Error('COMPUTER_CHATGPT_NATIVE_TARGET_BINDING_INCOMPLETE');
      const page = await this.driver.attach(ref);
      if (!sameRef(page.tabRef(), ref)) throw new Error('COMPUTER_CHATGPT_NATIVE_TARGET_PIN_CHANGED');
      return await operation(page, binding, lease);
    });
  }

  private async prepare(
    targetId: string,
    identity: ComputerChatgptTargetIdentity,
    prompt: string,
    mode: 'send' | 'resume' | 'recover' = 'send',
  ): Promise<{ ready: true } | { ready: false; reasonCode: string }> {
    const effectId = effectIdForPrompt(prompt);
    if (!effectId) return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_EFFECT_ID_REQUIRED' };
    const expected = promptText(prompt);
    const expectedFingerprint = composerFingerprint(expected);
    try {
      return await this.withPinnedPage(targetId, async (page, binding, lease) => {
        const pageIdentity = pageIdentityInput(identity, binding.ownerToken);
        let before = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
        if (!identityMatchesUrl(identity, before.url, false)) return { ready: false, reasonCode: 'target_identity_changed' };

        let receipt = preparedDraftFor(lease.current());
        let originalText: string | undefined;
        let allowReplacement = false;
        let expectedExistingComposerText: string | undefined;
        let promptToPrepare = prompt;
        let inheritedOriginalText: string | undefined;
        if (receipt) {
          if (receipt.phase === 'dispatching') {
            return {
              ready: false,
              reasonCode: receipt.effectId === effectId && receipt.promptFingerprint === expectedFingerprint
                ? 'COMPUTER_CHATGPT_NATIVE_EFFECT_OUTCOME_UNKNOWN'
                : 'COMPUTER_CHATGPT_NATIVE_PREVIOUS_EFFECT_OUTCOME_UNKNOWN',
            };
          }
          if (receipt.effectId === effectId && receipt.promptFingerprint !== expectedFingerprint) {
            return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_EFFECT_PROMPT_CHANGED' };
          }
          if (receipt.effectId === effectId && receipt.promptFingerprint === expectedFingerprint) {
            originalText = restoreTextForReceipt(this.controllerHome, identity, receipt);
            if (originalText === undefined) return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_UNAVAILABLE' };
            const currentText = before.composerText ?? '';
            if (composerMatchesFingerprint(currentText, expectedFingerprint)) {
              // The exact draft is already present. Revalidate it without reusing
              // a one-shot replacement prefix consumed by the first prepare.
              promptToPrepare = actualPrompt(prompt);
            } else if (receipt.phase === 'preparing'
              && composerFingerprint(currentText) === receipt.replacedFingerprint) {
              // Runtime restarted before the editor write completed. Resume only
              // when the original composer bytes still match this effect receipt.
              const replacementAuthorized = REPLACEMENT_PREFIX.test(prompt) || RETIRED_PREFIX.test(prompt);
              if (currentText.trim() && !replacementAuthorized) {
                this.clearPreparedDraft(lease, receipt);
                return { ready: false, reasonCode: 'composer_not_empty' };
              }
              if (replacementAuthorized) {
                allowReplacement = true;
                expectedExistingComposerText = currentText;
              }
            } else {
              // A prepared draft changed or was cleared by a person. Never
              // reconstruct it from stale receipt data.
              this.clearPreparedDraft(lease, receipt);
              return { ready: false, reasonCode: 'composer_not_empty' };
            }
            receipt = { ...receipt, phase: 'preparing' };
            this.putPreparedDraft(lease, identity, receipt);
          } else {
            const currentText = before.composerText ?? '';
            const retired = RETIRED_PREFIX.exec(prompt);
            if (retired
              && receipt.effectId !== effectId
              && retired[1] === receipt.effectId
              && retired[2] === receipt.promptFingerprint
              && composerMatchesFingerprint(currentText, receipt.promptFingerprint)
              && currentText.startsWith('<<<FORGE_WORKFLOW_EFFECT_V1:' + retired[1] + '>>>')) {
              inheritedOriginalText = restoreTextForReceipt(this.controllerHome, identity, receipt);
              if (inheritedOriginalText === undefined) return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_UNAVAILABLE' };
              allowReplacement = true;
              expectedExistingComposerText = currentText;
              // The next effect will replace this receipt only after its own
              // exact original draft backup is durably available.
              receipt = undefined;
            } else {
              if (composerMatchesFingerprint(currentText, receipt.promptFingerprint)) {
                const previousText = restoreTextForReceipt(this.controllerHome, identity, receipt);
                if (previousText === undefined) return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_UNAVAILABLE' };
                const rollback = await page.evaluate<{ restored: boolean; reasonCode?: string }>(restoreComposerDraft as (...args: unknown[]) => unknown, {
                  ...pageIdentity, expectedPrompt: currentText, restoreText: previousText,
                });
                if (!rollback.restored && rollback.reasonCode !== 'composer_changed' && rollback.reasonCode !== 'composer_has_app_mention') {
                  return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING' };
                }
              }
              this.clearPreparedDraft(lease, receipt);
              before = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
              if (!identityMatchesUrl(identity, before.url, false)) return { ready: false, reasonCode: 'target_identity_changed' };
              receipt = undefined;
            }
          }
        }

        if (!receipt) {
          const currentComposer = before.composerText ?? '';
          if (currentComposer === expected || currentComposer === expected + '\n') {
            return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_RECEIPT_MISSING' };
          }
          const replacement = REPLACEMENT_PREFIX.exec(prompt);
          const retired = RETIRED_PREFIX.exec(prompt);
          if (inheritedOriginalText !== undefined) {
            if (!retired
              || composerFingerprint(currentComposer) !== retired[2]
              || !currentComposer.startsWith('<<<FORGE_WORKFLOW_EFFECT_V1:' + retired[1] + '>>>')) {
              return { ready: false, reasonCode: 'composer_not_empty' };
            }
            originalText = inheritedOriginalText;
            if (originalText && !writeDraftBackup(this.controllerHome, identity, effectId, before, retired[2]!, originalText)) {
              return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_WRITE_FAILED' };
            }
            allowReplacement = true;
            expectedExistingComposerText = currentComposer;
          } else if (replacement) {
            const fingerprint = replacement[1]!;
            if (composerFingerprint(currentComposer) !== fingerprint) return { ready: false, reasonCode: 'composer_not_empty' };
            originalText = readDraftBackup(this.controllerHome, identity, effectId, fingerprint);
            if (originalText === undefined) return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_UNAVAILABLE' };
            allowReplacement = true;
            expectedExistingComposerText = currentComposer;
          } else if (retired) {
            const fingerprint = retired[2]!;
            if (composerFingerprint(currentComposer) !== fingerprint
              || !currentComposer.startsWith('<<<FORGE_WORKFLOW_EFFECT_V1:' + retired[1] + '>>>')) {
              return { ready: false, reasonCode: 'composer_not_empty' };
            }
            if (!writeDraftBackup(this.controllerHome, identity, effectId, before, fingerprint, currentComposer)) {
              return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_WRITE_FAILED' };
            }
            originalText = currentComposer;
            allowReplacement = true;
            expectedExistingComposerText = currentComposer;
          } else if (!currentComposer.trim()) {
            originalText = '';
          } else {
            return { ready: false, reasonCode: 'composer_not_empty' };
          }
          const originalKind: PreparedDraftReceipt['originalKind'] = originalText ? 'backup' : 'empty';
          receipt = {
            schemaVersion: 1,
            effectId,
            promptFingerprint: expectedFingerprint,
            originalFingerprint: composerFingerprint(originalText),
            replacedFingerprint: composerFingerprint(currentComposer),
            originalKind,
            phase: 'preparing',
          };
          this.putPreparedDraft(lease, identity, receipt);
        }
        if (originalText === undefined) return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_UNAVAILABLE' };

        const rollback = async (): Promise<{ restored: boolean; reasonCode?: string }> => {
          const result = await page.evaluate<{ restored: boolean; reasonCode?: string }>(restoreComposerDraft as (...args: unknown[]) => unknown, {
            ...pageIdentity, expectedPrompt: expected, restoreText: originalText!,
          }).catch(() => ({ restored: false, reasonCode: 'rollback_observation_failed' }));
          if (result.restored || result.reasonCode === 'composer_changed' || result.reasonCode === 'composer_has_app_mention') {
            this.clearPreparedDraft(lease, receipt!);
            
          }
          return result;
        };
        const runPrepare = async (value: string): Promise<{ ready: true } | { ready: false; reasonCode: string }> => {
          return await page.evaluate<{ ready: true } | { ready: false; reasonCode: string }>(preparePrompt as (...args: unknown[]) => unknown, {
            ...pageIdentity, prompt: value, mode, allowReplacement,
            ...(expectedExistingComposerText === undefined ? {} : { expectedExistingComposerText }),
          });
        };

        let result: { ready: true } | { ready: false; reasonCode: string };
        try {
          result = await runPrepare(promptToPrepare);
          if (!result.ready && ['send_button_disabled', 'send_button_missing'].includes(result.reasonCode)
            && !REPLACEMENT_PREFIX.test(promptToPrepare) && !RETIRED_PREFIX.test(promptToPrepare)) {
            const retryPrompt = actualPrompt(prompt);
            for (let attempt = 1; attempt < PREPARE_READY_ATTEMPTS; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, PREPARE_READY_DELAY_MS));
              result = await runPrepare(retryPrompt);
              if (result.ready || !['send_button_disabled', 'send_button_missing'].includes(result.reasonCode)) break;
            }
          }
        } catch {
          result = { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_PREPARE_EVALUATION_FAILED' };
        }
        if (result.ready) {
          try {
            this.putPreparedDraft(lease, identity, { ...receipt!, phase: 'prepared' });
            return result;
          } catch {
            const rolledBack = await rollback();
            return {
              ready: false,
              reasonCode: rolledBack.restored || rolledBack.reasonCode === 'composer_changed' || rolledBack.reasonCode === 'composer_has_app_mention'
                ? 'COMPUTER_CHATGPT_NATIVE_DRAFT_RECEIPT_PERSIST_FAILED'
                : 'COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING',
            };
          }
        }
        const rolledBack = await rollback();
        if (rolledBack.restored || rolledBack.reasonCode === 'composer_changed' || rolledBack.reasonCode === 'composer_has_app_mention') {
          return result;
        }
        return { ready: false, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING' };
      });
    } catch (error) {
      try {
        const target = this.authority.getSurface(this.controllerHome, targetId);
        const receipt = target ? preparedDraftFor(target) : undefined;
        if (receipt?.effectId === effectId) {
          return { ready: false, reasonCode: receipt.phase === 'dispatching'
            ? 'COMPUTER_CHATGPT_NATIVE_EFFECT_OUTCOME_UNKNOWN' : 'COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING' };
        }
      } catch { /* Preserve the original target failure when durable receipt inspection is unavailable. */ }
      const code = error instanceof Error && error.message.startsWith('COMPUTER_CHATGPT_')
        ? error.message
        : 'COMPUTER_CHATGPT_NATIVE_PREPARE_FAILED';
      return { ready: false, reasonCode: code };
    }
  }

  private async dispatch(
    targetId: string,
    identity: ComputerChatgptTargetIdentity,
    prompt: string,
    mode: 'send' | 'resume' | 'recover' = 'send',
  ): Promise<{ mutation: 'not_attempted'; reasonCode: string } | { mutation: 'attempted'; confirmed?: boolean }> {
    const effectId = effectIdForPrompt(prompt);
    if (!effectId) return { mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_NATIVE_EFFECT_ID_REQUIRED' };
    const expected = promptText(prompt);
    const expectedFingerprint = composerFingerprint(expected);
    try {
      return await this.withPinnedPage(targetId, async (page, binding, lease) => {
        const pageIdentity = pageIdentityInput(identity, binding.ownerToken);
        let receipt = preparedDraftFor(lease.current());
        if (!receipt) return { mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_RECEIPT_MISSING' };
        // A durable dispatching receipt means a prior invocation may have clicked
        // Send. Only the exact effect/payload may be reported as attempted/unknown.
        if (receipt.phase === 'dispatching') {
          if (receipt.effectId === effectId && receipt.promptFingerprint === expectedFingerprint) {
            return { mutation: 'attempted', confirmed: false };
          }
          return { mutation: 'not_attempted', reasonCode: receipt.effectId === effectId
            ? 'COMPUTER_CHATGPT_NATIVE_EFFECT_PROMPT_CHANGED'
            : 'COMPUTER_CHATGPT_NATIVE_PREVIOUS_EFFECT_OUTCOME_UNKNOWN' };
        }
        if (receipt.effectId !== effectId) return { mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_RECEIPT_MISMATCH' };
        if (receipt.promptFingerprint !== expectedFingerprint) {
          return { mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_NATIVE_EFFECT_PROMPT_CHANGED' };
        }
        const restoreText = restoreTextForReceipt(this.controllerHome, identity, receipt);
        if (restoreText === undefined) return { mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_UNAVAILABLE' };
        const rollbackIfNotAttempted = async (reasonCode: string) => {
          const rollback = await page.evaluate<{ restored: boolean; reasonCode?: string }>(restoreComposerDraft as (...args: unknown[]) => unknown, {
            ...pageIdentity, expectedPrompt: expected, restoreText,
          }).catch(() => ({ restored: false, reasonCode: 'rollback_observation_failed' }));
          if (rollback.restored || rollback.reasonCode === 'composer_changed' || rollback.reasonCode === 'composer_has_app_mention') {
            this.clearPreparedDraft(lease, receipt!);
            
            return { mutation: 'not_attempted' as const, reasonCode };
          }
          return { mutation: 'not_attempted' as const, reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING' };
        };

        let before: ComputerChatgptConversationObservation;
        try {
          before = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
        } catch {
          return await rollbackIfNotAttempted('target_observation_unavailable');
        }
        if (!identityMatchesUrl(identity, before.url, false)) return await rollbackIfNotAttempted('target_identity_changed');
        if (!composerMatchesFingerprint(before.composerText ?? '', expectedFingerprint)) {
          this.clearPreparedDraft(lease, receipt);
          return { mutation: 'not_attempted', reasonCode: 'composer_not_prepared' };
        }
        if (receipt.phase !== 'prepared') return await rollbackIfNotAttempted('COMPUTER_CHATGPT_NATIVE_DRAFT_NOT_PREPARED');

        if (mode === 'recover') {
          try {
            const stopped = await page.evaluate<{ stopVisible: boolean; clicked: boolean; reasonCode?: string }>(stopGeneration as (...args: unknown[]) => unknown, pageIdentity);
            if (stopped.reasonCode) return await rollbackIfNotAttempted(stopped.reasonCode);
            if (stopped.stopVisible && stopped.clicked) {
              let stoppedConfirmed = false;
              for (let attempt = 0; attempt < RECOVERY_STOP_ATTEMPTS; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, RECOVERY_STOP_DELAY_MS));
                const snapshot = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
                if (!identityMatchesUrl(identity, snapshot.url, false)) return await rollbackIfNotAttempted('target_identity_changed');
                if (!snapshot.isGenerating) { stoppedConfirmed = true; break; }
              }
              if (!stoppedConfirmed) return await rollbackIfNotAttempted('provider_recovery_stop_unconfirmed');
            }
          } catch {
            return await rollbackIfNotAttempted('provider_recovery_stop_outcome_unknown');
          }
        }

        const dispatchingReceipt = { ...receipt, phase: 'dispatching' as const };
        try {
          this.putPreparedDraft(lease, identity, dispatchingReceipt);
          receipt = dispatchingReceipt;
        } catch {
          return await rollbackIfNotAttempted('COMPUTER_CHATGPT_NATIVE_DRAFT_RECEIPT_PERSIST_FAILED');
        }
        try {
          const result = await page.evaluate<PageDispatchResult>(dispatchPrompt as (...args: unknown[]) => unknown, { ...pageIdentity, prompt, mode });
          if (!result.dispatched) {
            // The page explicitly attested that Send was not attempted. Return
            // the durable receipt to preparing before rollback so a failed
            // cleanup cannot be mistaken for an unknown Send on the next turn.
            const preSendReceipt = { ...receipt, phase: 'preparing' as const };
            try {
              this.putPreparedDraft(lease, identity, preSendReceipt);
              receipt = preSendReceipt;
            } catch {
              // Preserve the write-ahead dispatching receipt if its downgrade
              // cannot be durably committed; that case remains reconcile-only.
              return { mutation: 'attempted', confirmed: false };
            }
            return await rollbackIfNotAttempted(result.reasonCode);
          }
          let confirmed = result.committed;
          try {
            // Once Send has been clicked, all later reads are reconciliation only.
            for (let attempt = 0; !confirmed && attempt < 20; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              const observation = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: true, includePageText: false });
              if (!identityMatchesUrl(identity, observation.url, true)) break;
              const users = observation.userMessages ?? [];
              if (users.length > result.beforeUserCount && String(users.at(-1) ?? '').replace(/\r\n?/g, '\n') === expected) {
                confirmed = true;
                break;
              }
            }
          } catch { /* Unknown after Send is never permission to replay. */ }
          if (confirmed) {
            try { this.clearPreparedDraft(lease, receipt); } catch { /* Keep the dispatching receipt for read-only reconciliation. */ }
          }
          return { mutation: 'attempted', confirmed };
        } catch {
          // The persisted dispatching receipt survives Runtime restart; only the Supervisor ledger can resolve it.
          return { mutation: 'attempted', confirmed: false };
        }
      });
    } catch (error) {
      try {
        const target = this.authority.getSurface(this.controllerHome, targetId);
        const receipt = target ? preparedDraftFor(target) : undefined;
        if (receipt?.effectId === effectId) {
          return receipt.phase === 'dispatching'
            ? { mutation: 'attempted', confirmed: false }
            : { mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING' };
        }
      } catch { /* Preserve the original target failure when durable receipt inspection is unavailable. */ }
      const code = error instanceof Error && error.message.startsWith('COMPUTER_CHATGPT_')
        ? error.message
        : 'COMPUTER_CHATGPT_NATIVE_TARGET_UNAVAILABLE';
      return { mutation: 'not_attempted', reasonCode: code };
    }
  }

  async inventory(): Promise<ComputerChatgptConversationInventory> {
    try {
      const inventory = await this.driver.listTabs();
      const conversations = inventory.tabs.flatMap((tab) => {
        const parsed = parseConversationUrl(tab.url);
        if (!parsed) return [];
        return [{
          conversationId: parsed.conversationId,
          canonicalUrl: parsed.canonicalUrl,
          ...(tab.title ? { title: String(tab.title).slice(0, 512) } : {}),
          ...(parsed.projectId ? { projectUrl: `https://chatgpt.com/g/${parsed.projectId}/project` } : {}),
          ...(tab.active && tab.frontmost ? { isCurrent: true } : {}),
        }];
      });
      return {
        conversations,
        complete: inventory.truncated !== true,
        providerInventoryReady: true,
        unavailableProviders: inventory.truncated ? [`${PROVIDER_ID}:inventory-truncated`] : [],
      };
    } catch {
      return { conversations: [], complete: false, providerInventoryReady: false, unavailableProviders: [PROVIDER_ID] };
    }
  }

  async ensureExact(identity: ComputerChatgptConversationIdentity, options: { createIfMissing?: boolean } = {}): Promise<ComputerChatgptTargetResult> {
    let inventory: NativeBrowserChatgptTabInventory | undefined;
    const existing = this.find(identity);
    const pending = pendingCreateFor(existing);
    if (pending) {
      try { inventory = await this.driver.listTabs(); }
      catch { return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false }); }
      if (!inventory) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false });
      if (inventory.truncated) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_INCOMPLETE', { failoverSafe: false });
      const reconciled = await this.reconcilePendingCreate(identity, existing!, pending, inventory);
      if (reconciled) return reconciled;
      try { inventory = await this.driver.listTabs(); }
      catch { return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false }); }
      if (!inventory) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false });
      if (inventory.truncated) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_INCOMPLETE', { failoverSafe: false });
    }
    const current = this.find(identity);
    const previous = current?.providerBinding;
    if (previous && ![PROVIDER_ID, LEGACY_PROVIDER_ID].includes(previous.providerId)) return failure('COMPUTER_CHATGPT_NATIVE_PROVIDER_MISMATCH', { failoverSafe: false });
    const pinnedRef = bindingRef(previous);
    if (previous && !pinnedRef) return failure('COMPUTER_CHATGPT_NATIVE_BINDING_INCOMPLETE', { failoverSafe: false });
    if (pinnedRef) {
      // A durable physical pin is already authoritative. Attach to that exact
      // tab directly; only enumerate all tabs if attachment fails and we need
      // to classify a missing pin or recover a native-owned window.name token.
      const attached = await this.attachAndObserve(identity, {
        windowId: pinnedRef.windowId, tabId: pinnedRef.tabId, url: identity.canonicalUrl, title: '',
      } as NativeTab);
      if (attached.state === 'ready' && attached.observation) {
        const bound = await this.bindAsync(identity, nativeBinding(pinnedRef, this.nowMs, previous?.ownerToken));
        return { state: 'ready', target: this.target(identity, bound), observation: attached.observation };
      }
      if (attached.state !== 'unavailable' || attached.failure.code !== 'COMPUTER_CHATGPT_NATIVE_ATTACH_OR_OBSERVE_FAILED') return attached;
      if (!inventory) {
        try { inventory = await this.driver.listTabs(); }
        catch { return attached; }
      }
      if (!inventory) return attached;
      if (inventory.truncated) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_INCOMPLETE', { failoverSafe: false });
      if (inventory.tabs.some((tab) => sameRef(toRef(tab), pinnedRef))) return attached;
      if (previous?.providerId === PROVIDER_ID && previous.ownerToken) {
        const ownerMatch = await this.findOwnedTab(identity, previous.ownerToken, inventory);
        if (ownerMatch) return ownerMatch;
      }
      return failure('COMPUTER_CHATGPT_NATIVE_PINNED_TAB_MISSING', { failoverSafe: false });
    }
    if (!inventory) {
      try { inventory = await this.driver.listTabs(); }
      catch { return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false }); }
    }
    if (!inventory) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false });
    if (inventory.truncated) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_INCOMPLETE', { failoverSafe: false });

    const exactTabs = inventory.tabs.filter((tab) => exactConversation(identity, tab.url));
    if (exactTabs.length > 1) return failure('COMPUTER_CHATGPT_NATIVE_TARGET_AMBIGUOUS', { failoverSafe: false });
    if (exactTabs.length === 1) {
      const attached = await this.attachAndObserve(identity, exactTabs[0]!);
      if (attached.state !== 'ready' || !attached.observation) return attached;
      const ref = toRef(exactTabs[0]!);
      if (!ref) return failure('COMPUTER_CHATGPT_NATIVE_TAB_REF_UNAVAILABLE', { failoverSafe: false });
      const bound = await this.bindAsync(identity, nativeBinding(ref, this.nowMs, sameRef(pinnedRef, ref) ? previous?.ownerToken : undefined));
      return { state: 'ready', target: this.target(identity, bound), observation: attached.observation };
    }
    if (!options.createIfMissing) return failure('COMPUTER_CHATGPT_NATIVE_TARGET_NOT_FOUND', { failoverSafe: false });
    return await this.createOwnedTarget(identity, identity.canonicalUrl, inventory, previous?.windowId);
  }

  async openBootstrap(projectUrl: string, bootstrapKey: string): Promise<ComputerChatgptTargetResult> {
    const identity: ComputerChatgptBootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl };
    if (!projectIdFromUrl(projectUrl)) return failure('COMPUTER_CHATGPT_NATIVE_PROJECT_ID_UNAVAILABLE', { failoverSafe: false });
    let inventory: NativeBrowserChatgptTabInventory;
    try { inventory = await this.driver.listTabs(); }
    catch { return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false }); }
    if (inventory.truncated) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_INCOMPLETE', { failoverSafe: false });
    const existing = this.find(identity);
    const pending = pendingCreateFor(existing);
    if (pending) {
      const reconciled = await this.reconcilePendingCreate(identity, existing!, pending, inventory);
      if (reconciled) return reconciled;
      inventory = await this.driver.listTabs();
      if (inventory.truncated) return failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_INCOMPLETE', { failoverSafe: false });
    }
    const current = this.find(identity);
    const previous = current?.providerBinding;
    if (previous && ![PROVIDER_ID, LEGACY_PROVIDER_ID].includes(previous.providerId)) return failure('COMPUTER_CHATGPT_NATIVE_PROVIDER_MISMATCH', { failoverSafe: false });
    const pinnedRef = bindingRef(previous);
    if (previous && !pinnedRef) return failure('COMPUTER_CHATGPT_NATIVE_BOOTSTRAP_BINDING_INCOMPLETE', { failoverSafe: false });

    if (pinnedRef) {
      const pinned = inventory.tabs.find((tab) => sameRef(toRef(tab), pinnedRef));
      if (pinned) {
        if (!exactProject(identity, pinned.url, false)) return failure('COMPUTER_CHATGPT_NATIVE_BOOTSTRAP_PIN_CHANGED', { failoverSafe: false });
        const attached = await this.attachAndObserve(identity, pinned, false);
        if (attached.state !== 'ready' || !attached.observation) return attached;
        const bound = await this.bindAsync(identity, nativeBinding(pinnedRef, this.nowMs, previous?.ownerToken));
        return { state: 'ready', target: this.target(identity, bound), observation: attached.observation };
      }
      if (!previous?.ownerToken) return failure('COMPUTER_CHATGPT_NATIVE_BOOTSTRAP_TARGET_LOST', { failoverSafe: false });
      if (previous.providerId === PROVIDER_ID) {
        const ownerMatch = await this.findOwnedTab(identity, previous.ownerToken, inventory);
        if (ownerMatch?.state === 'ready') return ownerMatch;
        if (ownerMatch?.state === 'unavailable') return ownerMatch;
        if (inventory.tabs.some((tab) => exactProject(identity, tab.url, false))) {
          return failure('COMPUTER_CHATGPT_NATIVE_BOOTSTRAP_OWNER_UNVERIFIED', { failoverSafe: false });
        }
      } else if (inventory.tabs.some((tab) => exactProject(identity, tab.url, false))) {
        return failure('COMPUTER_CHATGPT_NATIVE_LEGACY_BOOTSTRAP_PIN_LOST', { failoverSafe: false });
      }
      await this.clearBinding(current!.targetId, previous);
    }
    return await this.createOwnedTarget(identity, projectUrl, inventory, previous?.windowId);
  }

  private async createOwnedTarget(
    identity: ComputerChatgptTargetIdentity,
    url: string,
    inventory: NativeBrowserChatgptTabInventory,
    preferredWindowId?: string,
  ): Promise<ComputerChatgptTargetResult> {
    const record = this.upsert(identity);
    const ownerToken = randomUUID();
    const pending: PendingCreate = {
      ownerToken,
      url,
      existingTabRefs: inventory.tabs.flatMap((tab) => { const ref = toRef(tab); return ref ? [refKey(ref)] : []; }),
      startedAt: new Date(this.nowMs()).toISOString(),
    };
    await this.writeCompatibility(record.targetId, identity, { pendingCreate: pending });
    await this.authority.withSurfaceLease(this.controllerHome, record.targetId, async (lease) => lease.clearBinding());
    let page: NativePage;
    try { page = await this.driver.create(url, preferredWindowId); }
    catch { return failure('COMPUTER_CHATGPT_NATIVE_CREATE_OUTCOME_UNKNOWN', { failoverSafe: false }); }
    const ref = page.tabRef();
    if (!ref) return failure('COMPUTER_CHATGPT_NATIVE_CREATE_REF_UNKNOWN', { failoverSafe: false });
    try {
      const marked = await page.evaluate<{ ok: boolean; reasonCode?: string }>(setWindowName as (...args: unknown[]) => unknown, { ownerToken });
      if (!marked.ok) return failure(marked.reasonCode ?? 'COMPUTER_CHATGPT_NATIVE_OWNER_TOKEN_NOT_SET', { failoverSafe: false });
      const observation = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
      if (!identityMatchesUrl(identity, observation.url, false)) {
        await this.driver.close(ref).catch(() => undefined);
        await this.writeCompatibility(record.targetId, identity, { clearPendingCreate: true });
        return failure('COMPUTER_CHATGPT_NATIVE_CREATED_TARGET_IDENTITY_MISMATCH', { failoverSafe: false });
      }
      const bound = await this.bindAsync(identity, nativeBinding(ref, this.nowMs, ownerToken), true);
      return { state: 'ready', target: this.target(identity, bound), observation };
    } catch {
      // Pending-create receipt prevents a second tab creation after an unknown
      // result. Recovery adopts only a tab carrying the same owner token.
      return failure('COMPUTER_CHATGPT_NATIVE_CREATE_OUTCOME_UNKNOWN', { failoverSafe: false });
    }
  }

  private async reconcilePendingCreate(
    identity: ComputerChatgptTargetIdentity,
    record: ComputerSurfaceTarget,
    pending: PendingCreate,
    inventory: NativeBrowserChatgptTabInventory,
  ): Promise<ComputerChatgptTargetResult | undefined> {
    const newTabs = inventory.tabs.filter((tab) => {
      const ref = toRef(tab);
      return ref && !pending.existingTabRefs.includes(refKey(ref));
    });
    const matches: Array<{ ref: TabRef; observation: ComputerChatgptConversationObservation }> = [];
    for (const tab of newTabs) {
      const ref = toRef(tab);
      if (!ref) continue;
      const candidate = identity.namespace === 'chatgpt.conversation'
        ? exactConversation(identity, tab.url)
        : exactProject(identity, tab.url, false);
      if (!candidate && tab.url !== 'about:blank') continue;
      try {
        const page = await this.driver.attach(ref);
        if (await page.evaluate<string>(readWindowName as (...args: unknown[]) => unknown, undefined) !== pending.ownerToken) continue;
        const observation = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
        if (!identityMatchesUrl(identity, observation.url, false)) continue;
        matches.push({ ref, observation });
      } catch { /* no ownership proof */ }
    }
    if (matches.length > 1) return failure('COMPUTER_CHATGPT_NATIVE_CREATE_RECONCILIATION_AMBIGUOUS', { failoverSafe: false });
    if (matches.length === 1) {
      const match = matches[0]!;
      const bound = await this.bindAsync(identity, nativeBinding(match.ref, this.nowMs, pending.ownerToken), true);
      return { state: 'ready', target: this.target(identity, bound), observation: match.observation };
    }
    const uncertain = newTabs.filter((tab) => tab.url === 'about:blank'
      || (identity.namespace === 'chatgpt.conversation' ? exactConversation(identity, tab.url) : exactProject(identity, tab.url, false)));
    if (uncertain.length > 0) return failure('COMPUTER_CHATGPT_NATIVE_CREATE_OUTCOME_UNKNOWN', { failoverSafe: false });
    await this.writeCompatibility(record.targetId, identity, { clearPendingCreate: true });
    return undefined;
  }

  private async findOwnedTab(
    identity: ComputerChatgptTargetIdentity,
    ownerToken: string,
    inventory: NativeBrowserChatgptTabInventory,
  ): Promise<ComputerChatgptTargetResult | undefined> {
    const matches: Array<{ ref: TabRef; observation: ComputerChatgptConversationObservation }> = [];
    for (const tab of inventory.tabs) {
      const ref = toRef(tab);
      if (!ref) continue;
      try {
        const page = await this.driver.attach(ref);
        if (await page.evaluate<string>(readWindowName as (...args: unknown[]) => unknown, undefined) !== ownerToken) continue;
        const observation = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
        if (identityMatchesUrl(identity, observation.url, false)) matches.push({ ref, observation });
      } catch { /* no ownership proof */ }
    }
    if (matches.length > 1) return failure('COMPUTER_CHATGPT_NATIVE_OWNER_TOKEN_AMBIGUOUS', { failoverSafe: false });
    if (matches.length === 0) return undefined;
    const match = matches[0]!;
    const bound = await this.bindAsync(identity, nativeBinding(match.ref, this.nowMs, ownerToken));
    return { state: 'ready', target: this.target(identity, bound), observation: match.observation };
  }

  private async attachAndObserve(
    identity: ComputerChatgptTargetIdentity,
    tab: NativeTab,
    allowBootstrapConversation = true,
  ): Promise<ComputerChatgptTargetResult & { observation?: ComputerChatgptConversationObservation }> {
    const ref = toRef(tab);
    if (!ref) return failure('COMPUTER_CHATGPT_NATIVE_TAB_REF_UNAVAILABLE', { failoverSafe: false });
    try {
      const page = await this.driver.attach(ref);
      if (!sameRef(page.tabRef(), ref)) return failure('COMPUTER_CHATGPT_NATIVE_TAB_PIN_CHANGED', { failoverSafe: false });
      const priorTarget = this.find(identity);
      const expectedOwnerToken = priorTarget?.providerBinding?.providerId === PROVIDER_ID ? priorTarget.providerBinding.ownerToken : undefined;
      const snapshot = await page.evaluate<ComputerChatgptConversationObservation & { ownerTokenValid?: boolean }>(pageSnapshot as (...args: unknown[]) => unknown, {
        includeUserHistory: false, includePageText: false, ...(expectedOwnerToken ? { ownerToken: expectedOwnerToken } : {}),
      });
      const { ownerTokenValid, ...observation } = snapshot;
      if (!identityMatchesUrl(identity, observation.url, allowBootstrapConversation)) return failure('COMPUTER_CHATGPT_NATIVE_TARGET_IDENTITY_CHANGED', { failoverSafe: false });
      const existing = this.find(identity);
      const ownerToken = existing?.providerBinding?.ownerToken;
      if (ownerToken && existing?.providerBinding?.providerId === PROVIDER_ID && ownerTokenValid === false) return failure('COMPUTER_CHATGPT_NATIVE_OWNER_TOKEN_MISMATCH', { failoverSafe: false });
      return { state: 'ready', target: this.target(identity, this.upsert(identity)), observation };
    } catch {
      return failure('COMPUTER_CHATGPT_NATIVE_ATTACH_OR_OBSERVE_FAILED', { failoverSafe: false });
    }
  }

  async findBySubmittedMarker(marker: string, bootstrapKey?: string, betweenObservations?: () => Promise<void>): Promise<ComputerChatgptTargetResult[]> {
    let inventory: NativeBrowserChatgptTabInventory;
    try { inventory = await this.driver.listTabs(); }
    catch { return [failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_UNAVAILABLE', { failoverSafe: false })]; }
    if (inventory.truncated) return [failure('COMPUTER_CHATGPT_NATIVE_INVENTORY_INCOMPLETE', { failoverSafe: false })];
    const bootstrapIdentity = bootstrapKey ? {
      namespace: 'chatgpt.bootstrap' as const,
      bootstrapKey,
      projectUrl: this.bootstrapProjectUrl(bootstrapKey) ?? '',
    } : undefined;
    const bootstrapRecord = bootstrapIdentity ? this.find(bootstrapIdentity) : undefined;
    const bootstrapBinding = bootstrapRecord?.providerBinding;
    const pinnedRef = bindingRef(bootstrapBinding);
    const matches: Array<{ ref: TabRef; identity: ComputerChatgptConversationIdentity; observation: ComputerChatgptConversationObservation }> = [];
    for (const tab of inventory.tabs) {
      const ref = toRef(tab);
      if (!ref || !parseConversationUrl(tab.url)) continue;
      if (betweenObservations) await betweenObservations();
      try {
        const page = await this.driver.attach(ref);
        const observation = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: true, includePageText: false });
        const parsed = parseConversationUrl(observation.url);
        if (!parsed || !(observation.userMessages ?? []).some((message) => message.includes(marker))) continue;
        matches.push({ ref, identity: { namespace: 'chatgpt.conversation', conversationId: parsed.conversationId, canonicalUrl: parsed.canonicalUrl }, observation });
      } catch { /* unreadable pages cannot prove a submitted marker */ }
    }
    if (matches.length === 0) return [];
    if (matches.length > 1) {
      return matches.map((match) => {
        const record = this.upsert(match.identity);
        return { state: 'ready' as const, target: this.target(match.identity, record), observation: match.observation };
      });
    }
    const match = matches[0]!;
    if (bootstrapIdentity && bootstrapRecord && pinnedRef && !sameRef(pinnedRef, match.ref)) {
      const pinnedStillExists = inventory.tabs.some((tab) => sameRef(toRef(tab), pinnedRef));
      if (pinnedStillExists) return [failure('COMPUTER_CHATGPT_NATIVE_SUBMITTED_MARKER_PIN_MISMATCH', { failoverSafe: false })];
    }
    if (bootstrapIdentity && bootstrapRecord && pinnedRef && sameRef(pinnedRef, match.ref)) {
      const bound = await this.bindAsync(bootstrapIdentity, nativeBinding(match.ref, this.nowMs, bootstrapBinding?.ownerToken));
      return [{ state: 'ready', target: this.target(bootstrapIdentity, bound), observation: match.observation }];
    }
    const bound = await this.bindAsync(match.identity, nativeBinding(match.ref, this.nowMs));
    return [{ state: 'ready', target: this.target(match.identity, bound), observation: match.observation }];
  }

  private bootstrapProjectUrl(bootstrapKey: string): string | undefined {
    const identity: ComputerChatgptBootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey, projectUrl: '' };
    const value = recordValue(this.find(identity));
    return typeof value.projectUrl === 'string' && value.projectUrl ? value.projectUrl : undefined;
  }

  async promoteBootstrap(targetId: string, identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult> {
    const bootstrap = this.authority.getSurface(this.controllerHome, targetId);
    if (!bootstrap || bootstrap.stableIdentity.resource?.namespace !== 'chatgpt.bootstrap') {
      return failure('COMPUTER_CHATGPT_NATIVE_BOOTSTRAP_TARGET_NOT_FOUND', { failoverSafe: false });
    }
    const value = recordValue(bootstrap);
    const bootstrapIdentity: ComputerChatgptBootstrapIdentity = {
      namespace: 'chatgpt.bootstrap',
      bootstrapKey: String(value.bootstrapKey ?? bootstrap.stableIdentity.resource.key),
      projectUrl: String(value.projectUrl ?? ''),
    };
    const binding = bootstrap.providerBinding;
    const ref = bindingRef(binding);
    if (!binding || !ref || ![PROVIDER_ID, LEGACY_PROVIDER_ID].includes(binding.providerId)) {
      return failure('COMPUTER_CHATGPT_NATIVE_BOOTSTRAP_BINDING_UNAVAILABLE', { failoverSafe: false });
    }
    const attached = await this.attachAndObserve(bootstrapIdentity, { windowId: ref.windowId, tabId: ref.tabId, url: identity.canonicalUrl, title: '' } as NativeTab, true);
    if (attached.state !== 'ready' || !attached.observation || !exactConversation(identity, attached.observation.url)) {
      return failure('COMPUTER_CHATGPT_NATIVE_PROMOTION_IDENTITY_MISMATCH', { failoverSafe: false });
    }
    const existingConversation = this.find(identity);
    const existingRef = bindingRef(existingConversation?.providerBinding);
    if (existingRef && !sameRef(existingRef, ref)) return failure('COMPUTER_CHATGPT_NATIVE_PROMOTION_TARGET_CONFLICT', { failoverSafe: false });
    const conversation = await this.bindAsync(identity, nativeBinding(ref, this.nowMs, binding.ownerToken), true);
    await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => { lease.clearBinding(); lease.tombstone(); });
    return { state: 'ready', target: this.target(identity, conversation), observation: attached.observation };
  }

  async cleanup(activeResourceKeys: readonly string[]): Promise<void> {
    const active = new Set(activeResourceKeys);
    for (const target of this.authority.listSurfaces(this.controllerHome)) {
      if (target.providerBinding?.providerId !== PROVIDER_ID) continue;
      const namespace = target.stableIdentity.resource?.namespace;
      if (namespace !== 'chatgpt.conversation' && namespace !== 'chatgpt.bootstrap') continue;
      const key = target.stableIdentity.resource?.key;
      if (!key) continue;
      const resourceAlias = namespace === 'chatgpt.conversation' ? `chatgpt:conversation:${key}` : `chatgpt:bootstrap:${key}`;
      if (!active.has(resourceAlias)) await this.release(target.targetId);
    }
  }

  async release(targetId: string): Promise<void> {
    const target = this.authority.getSurface(this.controllerHome, targetId);
    if (!target) return;
    const namespace = target.stableIdentity.resource?.namespace;
    if (namespace !== 'chatgpt.conversation' && namespace !== 'chatgpt.bootstrap') return;
    const value = recordValue(target);
    const identity: ComputerChatgptTargetIdentity = namespace === 'chatgpt.conversation'
      ? { namespace, conversationId: String(value.conversationId ?? target.stableIdentity.resource?.key ?? ''), canonicalUrl: String(value.canonicalUrl ?? '') }
      : { namespace, bootstrapKey: String(value.bootstrapKey ?? target.stableIdentity.resource?.key ?? ''), projectUrl: String(value.projectUrl ?? '') };
    await this.authority.withSurfaceLease(this.controllerHome, targetId, async (lease) => {
      let receipt = preparedDraftFor(lease.current());
      const binding = lease.current().providerBinding;
      const ref = bindingRef(binding);
      if (!binding) {
        if (receipt) return;
        if (namespace === 'chatgpt.bootstrap') lease.tombstone();
        return;
      }
      if (binding.providerId === PROVIDER_ID && ref && binding.ownerToken) {
        const page = await this.driver.attach(ref);
        const owner = await page.evaluate<string>(readWindowName as (...args: unknown[]) => unknown, undefined);
        if (owner !== binding.ownerToken || !sameRef(page.tabRef(), ref)) {
          if (receipt) throw new Error('COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING');
        }
        let snapshot = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, {
          includeUserHistory: receipt?.phase === 'dispatching',
          includePageText: false,
        });
        if (receipt && !identityMatchesUrl(identity, snapshot.url, true)) {
          throw new Error('COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING');
        }
        if (receipt?.phase === 'dispatching') {
          const committed = (snapshot.userMessages ?? []).some((message) => composerMatchesFingerprint(message, receipt!.promptFingerprint));
          if (!committed) return;
          this.clearPreparedDraft(lease, receipt);
          receipt = undefined;
          snapshot = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
        } else if (receipt) {
          if (composerMatchesFingerprint(snapshot.composerText ?? '', receipt.promptFingerprint)) {
            const restoreText = restoreTextForReceipt(this.controllerHome, identity, receipt);
            if (restoreText === undefined) throw new Error('COMPUTER_CHATGPT_NATIVE_DRAFT_BACKUP_UNAVAILABLE');
            const rollback = await page.evaluate<{ restored: boolean; reasonCode?: string }>(restoreComposerDraft as (...args: unknown[]) => unknown, {
              ...pageIdentityInput(identity, binding.ownerToken),
              expectedPrompt: snapshot.composerText ?? '',
              restoreText,
            });
            if (!rollback.restored) {
              if (rollback.reasonCode === 'composer_changed' || rollback.reasonCode === 'composer_has_app_mention') {
                this.clearPreparedDraft(lease, receipt);
                receipt = undefined;
              } else {
                throw new Error('COMPUTER_CHATGPT_NATIVE_DRAFT_ROLLBACK_PENDING');
              }
            } else {
              this.clearPreparedDraft(lease, receipt);
              receipt = undefined;
              snapshot = await page.evaluate<ComputerChatgptConversationObservation>(pageSnapshot as (...args: unknown[]) => unknown, { includeUserHistory: false, includePageText: false });
            }
          } else {
            this.clearPreparedDraft(lease, receipt);
            receipt = undefined;
          }
        }
        const inventory = await this.driver.listTabs();
        const tab = inventory.tabs.find((item) => sameRef(toRef(item), ref));
        const safeToClose = !receipt
          && sameRef(page.tabRef(), ref)
          && owner === binding.ownerToken
          && identityMatchesUrl(identity, snapshot.url, true)
          && !snapshot.isGenerating
          && !(snapshot.composerText ?? '').trim()
          && !tab?.active
          && !tab?.frontmost;
        if (safeToClose) await this.driver.close(ref);
      } else if (receipt) {
        return;
      }
      
      lease.clearBinding();
      if (namespace === 'chatgpt.bootstrap') lease.tombstone();
    });
  }

  async close(): Promise<void> {
    // Browser page handles are ephemeral; Computer target authority owns the
    // durable identity and binding.
  }
}
