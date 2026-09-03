import { randomUUID } from 'crypto';
import { buildBrowserPluginManifest } from '../../src/runtime/plugins/browser-adapter';
import { executeControllerScopedPluginAction } from '../../src/runtime/plugins/store';
import { controllerSystemRoot } from '../../src/cli/repositories/controller-home';
import {
  CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN,
  DEFAULT_CHATGPT_AUTOMATION_MODEL,
  type ChatgptAutomationReasoning,
  type ChatgptAutomationTabCleanupStatus,
} from './provider-delivery';

const DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge';

function withForgePluginMention(prompt: string): string {
  const value = prompt.trim();
  if (!value) throw new Error('CHATGPT_AUTOMATION_PROMPT_REQUIRED');
  if (/^@forge(?:\s|$)/i.test(value)) return value;
  return `${DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION} ${value}`;
}

const CHATGPT_PROMPT_SELECTOR = 'div#prompt-textarea[contenteditable="true"]';
const CHATGPT_SEND_SELECTOR = '[data-testid="send-button"], button[aria-label*="Send"], button[data-testid*="send"]';
const CHATGPT_USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
const CHATGPT_INTELLIGENCE_CONTROL_SELECTORS = [
  'main button, main [role="button"]',
  'button, [role="button"]',
] as const;
const CHATGPT_CAPABILITY_SLIDER_SELECTOR = '[role="slider"]';
const CHATGPT_CAPABILITY_MENUITEM_SELECTOR = '[role="menuitem"][aria-keyshortcuts~="ArrowLeft"][aria-keyshortcuts~="ArrowRight"]';

function requestId(workId: string, actionId: string): string {
  return `chatgpt-work:${workId}:${actionId}:${randomUUID()}`;
}

const CHATGPT_BROWSER_TRANSPORT_OVERRIDES = {
  browser_mode: 'attach_preferred',
  cdp_attach_fallback: 'fail_closed',
  native_attach_mode: 'auto',
  native_browser_candidates: ['chrome'],
} as const;

export function chatgptBrowserActionArgs(actionId: string, args: Record<string, unknown>): Record<string, unknown> {
  if (actionId === 'configure' || actionId === 'list_sessions' || actionId === 'reconcile_sessions') return args;
  return { ...args, ...CHATGPT_BROWSER_TRANSPORT_OVERRIDES };
}

async function controllerBrowserAction(
  controllerHome: string,
  workId: string,
  actionId: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return executeControllerScopedPluginAction({
    controllerHome,
    pluginId: 'browser',
    actionId,
    requestId: requestId(workId, actionId),
    args: chatgptBrowserActionArgs(actionId, args),
    timeoutMs,
    origin: { surface: 'schedule', actor: 'chatgpt-work-continuation' },
  });
}

export async function ensureControllerChatgptBrowser(controllerHome: string, workId: string): Promise<void> {
  const repoRoot = controllerSystemRoot(controllerHome);
  // Browser configure is not a read: it persists configuration and closes managed
  // contexts. Scheduled continuations must not disturb an already-enabled provider
  // merely to prove it is available. Only enable it when the persisted authority is
  // explicitly disabled; action-level transport overrides still fail closed later.
  if (buildBrowserPluginManifest(0, undefined, repoRoot).enabled) return;
  await controllerBrowserAction(controllerHome, workId, 'configure', { enabled: true });
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface BrowserQueryMatch {
  text?: string;
  selectorHint?: string;
}

function queryMatches(result: Record<string, unknown> | undefined): BrowserQueryMatch[] {
  if (!result || !Array.isArray(result.matches)) return [];
  return result.matches.filter((value): value is BrowserQueryMatch => Boolean(value) && typeof value === 'object');
}

function matchText(value: BrowserQueryMatch): string {
  return typeof value.text === 'string' ? value.text.trim() : '';
}

function matchSelector(value: BrowserQueryMatch | undefined): string | undefined {
  return typeof value?.selectorHint === 'string' && value.selectorHint.trim() ? value.selectorHint.trim() : undefined;
}

function normalizeChatgptOutboundText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function chatgptOutboundMessageMatchesPrompt(messageText: string, prompt: string): boolean {
  const message = normalizeChatgptOutboundText(messageText);
  const normalizedPrompt = normalizeChatgptOutboundText(prompt);
  return Boolean(message && normalizedPrompt && message === normalizedPrompt);
}

async function latestChatgptUserMessage(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<{ selector?: string; preview: string; url?: string }> {
  const result = await controllerBrowserAction(controllerHome, workId, 'query_all', {
    session_id: browserSessionId,
    selector: CHATGPT_USER_MESSAGE_SELECTOR,
    limit: 1,
    from_end: true,
    timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
  }, timeoutMs);
  const latest = queryMatches(result).at(-1);
  return { selector: matchSelector(latest), preview: latest ? matchText(latest) : '', url: resultUrl(result) };
}

async function fullChatgptMessageText(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  message: { selector?: string; preview: string },
  timeoutMs?: number,
): Promise<string> {
  if (!message.selector) return message.preview;
  const result = await controllerBrowserAction(controllerHome, workId, 'get_text', {
    session_id: browserSessionId,
    selector: message.selector,
    max_chars: 20_000,
    timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
  }, timeoutMs).catch(() => undefined);
  return stringField(result?.text) ?? message.preview;
}

function chatgptSendControlUnavailable(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('Selector') && error.message.includes('not found'));
}

function normalizeExecutionControlLabel(label: string | undefined): string {
  return (label ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function chatgptAutomationReasoningLevelFromLabel(label: string | undefined): ChatgptAutomationReasoning | undefined {
  const normalized = normalizeExecutionControlLabel(label);
  if (!normalized) return undefined;

  const exact = new Map<string, ChatgptAutomationReasoning>([
    ['medium', 'medium'], ['中', 'medium'], ['中等', 'medium'],
    ['high', 'high'], ['高', 'high'],
    ['xhigh', 'xhigh'], ['extrahigh', 'xhigh'], ['超高', 'xhigh'], ['极高', 'xhigh'],
  ]);
  const exactLevel = exact.get(normalized);
  if (exactLevel) return exactLevel;

  const hasReasoningContext = ['reasoning', 'thinking', '推理', '思考']
    .some((token) => normalized.includes(token));
  if (!hasReasoningContext) return undefined;
  if (['xhigh', 'extrahigh', '超高', '极高'].some((token) => normalized.includes(token))) return 'xhigh';
  if (['medium', '中等'].some((token) => normalized.includes(token))) return 'medium';
  if (['high', '高'].some((token) => normalized.includes(token))) return 'high';
  return undefined;
}

function modelLabelMatches(label: string | undefined, model: string): boolean {
  if (model !== DEFAULT_CHATGPT_AUTOMATION_MODEL || !label) return false;
  const normalized = normalizeExecutionControlLabel(label);
  return normalized.includes('5.6sol') || normalized.includes('gpt5.6sol');
}

function reasoningLabelMatches(label: string | undefined, reasoning: ChatgptAutomationReasoning): boolean {
  return chatgptAutomationReasoningLevelFromLabel(label) === reasoning;
}

function isReasoningControlLabel(label: string | undefined): boolean {
  return reasoningLabelMatches(label, 'medium')
    || reasoningLabelMatches(label, 'high')
    || reasoningLabelMatches(label, 'xhigh');
}

function reasoningSliderValue(reasoning: ChatgptAutomationReasoning): number {
  if (reasoning === 'medium') return 2;
  if (reasoning === 'high') return 3;
  return 4;
}

async function findChatgptIntelligenceControl(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<BrowserQueryMatch | undefined> {
  for (const selector of CHATGPT_INTELLIGENCE_CONTROL_SELECTORS) {
    const result = await controllerBrowserAction(controllerHome, workId, 'query_all', {
      session_id: browserSessionId,
      selector,
      // Prefer the composer/main region so sidebar history cannot crowd the
      // reasoning control out of a bounded query. Keep a larger global fallback
      // for ChatGPT layouts that place the control outside <main>.
      limit: chatgptAutomationControlQueryLimit(selector),
      timeout_ms: timeoutMs ?? 60_000,
    }, timeoutMs);
    const match = queryMatches(result).find((candidate) => {
      const label = matchText(candidate);
      return modelLabelMatches(label, DEFAULT_CHATGPT_AUTOMATION_MODEL) || isReasoningControlLabel(label);
    });
    if (match) return match;
  }
  return undefined;
}

export function chatgptAutomationControlQueryLimit(selector: string): number {
  // Long tool-heavy conversations can contribute well over 80 buttons before
  // the composer controls. Keep the preferred <main> scan bounded but large
  // enough that the current reasoning control is not crowded out by history.
  return selector.startsWith('main ') ? 160 : 320;
}

export function chatgptAutomationControlWaitBudgets(timeoutMs?: number): { waitBudgetMs: number; probeTimeoutMs: number } {
  const waitBudgetMs = Math.min(Math.max(timeoutMs ?? 30_000, 1_000), 30_000);
  // Native Chrome attachment has a few seconds of Apple Events/DOM latency on
  // long conversations. Keep each probe bounded while allowing a real query to
  // complete; the total readiness window remains capped at 30 seconds.
  return { waitBudgetMs, probeTimeoutMs: Math.min(waitBudgetMs, 5_000) };
}

async function waitForChatgptIntelligenceControl(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<BrowserQueryMatch | undefined> {
  const { waitBudgetMs, probeTimeoutMs } = chatgptAutomationControlWaitBudgets(timeoutMs);
  const deadline = Date.now() + waitBudgetMs;
  do {
    const control = await findChatgptIntelligenceControl(controllerHome, workId, browserSessionId, probeTimeoutMs);
    if (control) return control;
    if (Date.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  } while (Date.now() < deadline);
  return undefined;
}

export function chatgptAutomationPageFailure(
  bodyText: string | undefined,
  composerAvailable: boolean,
): 'CHATGPT_AUTOMATION_LOGIN_REQUIRED' | 'CHATGPT_AUTOMATION_COMPOSER_UNAVAILABLE' | undefined {
  if (composerAvailable) return undefined;
  const normalized = (bodyText ?? '').toLowerCase();
  const loginMarkers = [
    'log in', 'sign up', 'continue with google', 'continue with apple',
    '登录', '登陆', '注册', '使用 google 继续', '使用 apple 继续',
  ];
  return loginMarkers.some((marker) => normalized.includes(marker))
    ? 'CHATGPT_AUTOMATION_LOGIN_REQUIRED'
    : 'CHATGPT_AUTOMATION_COMPOSER_UNAVAILABLE';
}

async function assertChatgptAutomationComposerReady(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<void> {
  const composerResult = await controllerBrowserAction(controllerHome, workId, 'query_all', {
    session_id: browserSessionId,
    selector: CHATGPT_PROMPT_SELECTOR,
    limit: 1,
    timeout_ms: Math.min(timeoutMs ?? 5_000, 5_000),
  }, timeoutMs).catch(() => undefined);
  const composerAvailable = queryMatches(composerResult).length > 0;
  if (composerAvailable) return;

  const bodyResult = await controllerBrowserAction(controllerHome, workId, 'get_text', {
    session_id: browserSessionId,
    selector: 'body',
    max_chars: 4_000,
    timeout_ms: Math.min(timeoutMs ?? 5_000, 5_000),
  }, timeoutMs).catch(() => undefined);
  const failure = chatgptAutomationPageFailure(stringField(bodyResult?.text), composerAvailable);
  throw new Error(failure ?? 'CHATGPT_AUTOMATION_COMPOSER_UNAVAILABLE');
}

export async function ensureChatgptExecutionPreference(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  model: string,
  reasoning: ChatgptAutomationReasoning,
  timeoutMs?: number,
): Promise<boolean> {
  if (model !== DEFAULT_CHATGPT_AUTOMATION_MODEL) throw new Error(`CHATGPT_AUTOMATION_MODEL_UNSUPPORTED:${model}`);
  let control = await waitForChatgptIntelligenceControl(controllerHome, workId, browserSessionId, timeoutMs);
  if (!control) {
    await assertChatgptAutomationComposerReady(controllerHome, workId, browserSessionId, timeoutMs);
    throw new Error('CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE');
  }
  // Current ChatGPT UI exposes the reasoning level (for example `高`) on the
  // composer control instead of the model label. The model remains fail-closed
  // through normalizeModel above; only the user-adjustable reasoning control is
  // required to be observable in the page before unattended dispatch proceeds.
  if (reasoningLabelMatches(matchText(control), reasoning)) return true;
  let controlSelector = matchSelector(control);
  if (!controlSelector) throw new Error('CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE');

  const expanded = await controllerBrowserAction(controllerHome, workId, 'get_attribute', {
    session_id: browserSessionId,
    selector: controlSelector,
    attribute: 'aria-expanded',
    timeout_ms: timeoutMs ?? 60_000,
  }, timeoutMs).catch(() => undefined);
  if (stringField(expanded?.value) !== 'true') {
    await controllerBrowserAction(controllerHome, workId, 'press', {
      session_id: browserSessionId,
      selector: controlSelector,
      key: 'ArrowDown',
      timeout_ms: timeoutMs ?? 60_000,
      post_action_wait_ms: 150,
    }, timeoutMs);
  }

  const currentValueResult = await controllerBrowserAction(controllerHome, workId, 'get_attribute', {
    session_id: browserSessionId,
    selector: CHATGPT_CAPABILITY_SLIDER_SELECTOR,
    attribute: 'aria-valuenow',
    timeout_ms: timeoutMs ?? 60_000,
  }, timeoutMs).catch(() => undefined);
  const currentValue = Number(stringField(currentValueResult?.value));
  const targetValue = reasoningSliderValue(reasoning);
  if (!Number.isInteger(currentValue) || currentValue < 0 || currentValue > 4) {
    throw new Error(`CHATGPT_AUTOMATION_REASONING_STATE_UNAVAILABLE:${reasoning}`);
  }
  const direction = targetValue > currentValue ? 'ArrowRight' : 'ArrowLeft';
  for (let index = 0; index < Math.abs(targetValue - currentValue); index += 1) {
    await controllerBrowserAction(controllerHome, workId, 'press', {
      session_id: browserSessionId,
      selector: CHATGPT_CAPABILITY_MENUITEM_SELECTOR,
      key: direction,
      timeout_ms: timeoutMs ?? 60_000,
      post_action_wait_ms: 120,
    }, timeoutMs);
  }

  const verifiedValueResult = await controllerBrowserAction(controllerHome, workId, 'get_attribute', {
    session_id: browserSessionId,
    selector: CHATGPT_CAPABILITY_SLIDER_SELECTOR,
    attribute: 'aria-valuenow',
    timeout_ms: timeoutMs ?? 60_000,
  }, timeoutMs).catch(() => undefined);
  if (Number(stringField(verifiedValueResult?.value)) !== targetValue) {
    throw new Error(`CHATGPT_AUTOMATION_REASONING_NOT_VERIFIED:${reasoning}`);
  }
  control = await findChatgptIntelligenceControl(controllerHome, workId, browserSessionId, timeoutMs) ?? control;
  if (isReasoningControlLabel(matchText(control)) && !reasoningLabelMatches(matchText(control), reasoning)) {
    throw new Error(`CHATGPT_AUTOMATION_REASONING_NOT_VERIFIED:${reasoning}`);
  }
  controlSelector = matchSelector(control) ?? controlSelector;
  await controllerBrowserAction(controllerHome, workId, 'press', {
    session_id: browserSessionId,
    selector: controlSelector,
    key: 'Escape',
    timeout_ms: timeoutMs ?? 60_000,
    post_action_wait_ms: 100,
  }, timeoutMs).catch(() => undefined);
  return true;
}

function resultUrl(result: Record<string, unknown>): string | undefined {
  return stringField(result.url)
    ?? stringField((result.session as Record<string, unknown> | undefined)?.url);
}

function resultSessionId(result: Record<string, unknown>): string | undefined {
  return stringField(result.session_id)
    ?? stringField((result.session as Record<string, unknown> | undefined)?.sessionId);
}

interface ChatgptBrowserSessionInventoryItem {
  sessionId?: unknown;
  url?: unknown;
  liveness?: unknown;
}

function chatgptUrlMatchesContinuationTarget(observedUrl: string, targetUrl: string): boolean {
  try {
    const observed = new URL(observedUrl);
    const target = new URL(targetUrl);
    const allowedHosts = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
    if (observed.protocol !== 'https:' || target.protocol !== 'https:' || !allowedHosts.has(observed.hostname) || !allowedHosts.has(target.hostname)) return false;
    const targetConversation = /\/c\/([^/?#]+)/.exec(target.pathname)?.[1];
    if (targetConversation) {
      const observedConversation = /\/c\/([^/?#]+)/.exec(observed.pathname)?.[1];
      return observedConversation === targetConversation;
    }
    return observed.pathname === target.pathname;
  } catch {
    return false;
  }
}

function completeChatgptBrowserInventorySessions(
  inventory: Record<string, unknown>,
): ChatgptBrowserSessionInventoryItem[] | undefined {
  if (stringField(inventory.nextCursor)) return undefined;
  return Array.isArray(inventory.sessions)
    ? inventory.sessions as ChatgptBrowserSessionInventoryItem[]
    : [];
}

export function reconciledNewChatgptOpenPageSessionId(
  beforeInventory: Record<string, unknown>,
  afterInventory: Record<string, unknown>,
  targetUrl: string,
): string | undefined {
  const beforeSessions = completeChatgptBrowserInventorySessions(beforeInventory);
  const afterSessions = completeChatgptBrowserInventorySessions(afterInventory);
  if (!beforeSessions || !afterSessions) return undefined;
  const beforeIds = new Set(beforeSessions
    .map((entry) => stringField(entry.sessionId))
    .filter((value): value is string => Boolean(value)));
  const matches = afterSessions.flatMap((entry) => {
    const sessionId = stringField(entry.sessionId);
    const url = stringField(entry.url);
    return sessionId
      && !beforeIds.has(sessionId)
      && entry.liveness === 'live'
      && url
      && chatgptUrlMatchesContinuationTarget(url, targetUrl)
      ? [sessionId]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function browserMutationOutcomeUnknown(error: unknown, actionId: string): boolean {
  return error instanceof Error
    && error.message.includes('PLUGIN_BROWSER_MUTATION_OUTCOME_UNKNOWN')
    && error.message.includes(`Browser action ${actionId}`);
}

export function chatgptAutomationNavigationRequiresReplacement(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    'BROWSER_AUTOMATION_BACKGROUND_NAVIGATION_REQUIRES_REPLACEMENT',
    'PLUGIN_BROWSER_SESSION_STATE_LOST',
    'PLUGIN_SESSION_NOT_FOUND',
    'PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN',
  ].some((marker) => error.message.includes(marker));
}

export async function closeChatgptAutomationTabAfterDispatch(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<{ status: ChatgptAutomationTabCleanupStatus; error?: { code: string; message: string } }> {
  try {
    const closed = await controllerBrowserAction(controllerHome, workId, 'close_page', {
      session_id: browserSessionId,
    }, Math.min(timeoutMs ?? 15_000, 15_000));
    if (closed.preservedUserOwnedTab === true) return { status: 'preserved_user_owned' };
    if (closed.resourceClosed === true) return { status: 'closed' };
    return { status: 'session_closed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: {
        code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : 'CHATGPT_AUTOMATION_TAB_CLEANUP_FAILED',
        message,
      },
    };
  }
}

/**
 * Settles the browser resource for one completed Work-bound ChatGPT round.
 * Conversation identity is durable in the Work binding and intentionally
 * survives this ephemeral tab/session cleanup. Browser ownership policy keeps
 * user-owned native tabs intact.
 */
export async function settleWorkChatgptAutomationTab(input: {
  controllerHome: string;
  workId: string;
  browserSessionId: string;
  timeoutMs?: number;
}): Promise<{ status: ChatgptAutomationTabCleanupStatus; error?: { code: string; message: string } }> {
  if (input.browserSessionId.startsWith('forge-chatgpt-bridge-')) return { status: 'session_closed' };
  return closeChatgptAutomationTabAfterDispatch(
    input.controllerHome,
    input.workId,
    input.browserSessionId,
    input.timeoutMs,
  );
}

export function isChatgptConversationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(url.hostname)
      && /\/c\/[^/?#]+/.test(url.pathname);
  } catch {
    return false;
  }
}

export async function navigateWorkConversation(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  targetUrl: string,
  timeoutMs?: number,
): Promise<{ submissionTargetUrl: string; recoveredFromStaleBinding: boolean; browserSessionId: string }> {
  const navigate = async (sessionId: string, url: string) => controllerBrowserAction(controllerHome, workId, 'navigate', {
    session_id: sessionId,
    url,
    wait_until: 'domcontentloaded',
    timeout_ms: timeoutMs ?? 60_000,
    retries: 1,
  }, timeoutMs);
  const openReplacement = async (url: string): Promise<string> => {
    // Browser owns new-session identity. Passing any session_id makes open_page an
    // existing-resource action, which is exactly wrong after the saved Work binding
    // has proven stale. Snapshot complete inventory before dispatch so an unknown
    // mutation outcome can be reconciled by one exact new live session only.
    const beforeInventory = await controllerBrowserAction(controllerHome, workId, 'list_sessions', { limit: 200 }, timeoutMs);
    if (!completeChatgptBrowserInventorySessions(beforeInventory)) {
      throw new Error('CHATGPT_AUTOMATION_SESSION_INVENTORY_TRUNCATED');
    }
    try {
      const opened = await controllerBrowserAction(controllerHome, workId, 'open_page', {
        url,
        wait_until: 'domcontentloaded',
        timeout_ms: timeoutMs ?? 60_000,
        retries: 1,
      }, timeoutMs);
      const replacementSessionId = resultSessionId(opened);
      if (!replacementSessionId) throw new Error('CHATGPT_AUTOMATION_REPLACEMENT_SESSION_NOT_CONFIRMED');
      return replacementSessionId;
    } catch (error) {
      if (!browserMutationOutcomeUnknown(error, 'open_page')) throw error;
      const afterInventory = await controllerBrowserAction(controllerHome, workId, 'list_sessions', { limit: 200 }, timeoutMs);
      const reconciledSessionId = reconciledNewChatgptOpenPageSessionId(beforeInventory, afterInventory, url);
      if (!reconciledSessionId) throw error;
      return reconciledSessionId;
    }
  };
  try {
    // Prove the exact saved Browser resource is still attachable before dispatching
    // a navigation mutation. A stale native tab must be replaced before any write;
    // discovering staleness only after mutation creates an avoidable outcome-unknown window.
    try {
      await controllerBrowserAction(controllerHome, workId, 'verify_state', {
        session_id: browserSessionId,
        expected_url: targetUrl,
      }, timeoutMs);
    } catch (preflightError) {
      if (!chatgptAutomationNavigationRequiresReplacement(preflightError)) throw preflightError;
      const replacementSessionId = await openReplacement(targetUrl);
      return { submissionTargetUrl: targetUrl, recoveredFromStaleBinding: true, browserSessionId: replacementSessionId };
    }
    await navigate(browserSessionId, targetUrl);
    return { submissionTargetUrl: targetUrl, recoveredFromStaleBinding: false, browserSessionId };
  } catch (error) {
    if (browserMutationOutcomeUnknown(error, 'navigate')) {
      try {
        const verified = await controllerBrowserAction(controllerHome, workId, 'verify_state', {
          session_id: browserSessionId,
          expected_url: targetUrl,
        }, timeoutMs);
        if (verified.matched === true && stringField(verified.sessionId) === browserSessionId) {
          return { submissionTargetUrl: targetUrl, recoveredFromStaleBinding: false, browserSessionId };
        }
      } catch {
        // Preserve the original mutation-unknown evidence. Verification failure is
        // not authority to replay navigate or to invent a replacement session.
      }
      throw error;
    }
    if (chatgptAutomationNavigationRequiresReplacement(error)) {
      const replacementSessionId = await openReplacement(targetUrl);
      return { submissionTargetUrl: targetUrl, recoveredFromStaleBinding: false, browserSessionId: replacementSessionId };
    }
    if (!isChatgptConversationUrl(targetUrl)) throw error;
    try {
      await navigate(browserSessionId, 'https://chatgpt.com/');
      return { submissionTargetUrl: 'https://chatgpt.com/', recoveredFromStaleBinding: true, browserSessionId };
    } catch (fallbackError) {
      if (!chatgptAutomationNavigationRequiresReplacement(fallbackError)) throw fallbackError;
      const replacementSessionId = await openReplacement('https://chatgpt.com/');
      return { submissionTargetUrl: 'https://chatgpt.com/', recoveredFromStaleBinding: true, browserSessionId: replacementSessionId };
    }
  }
}

export async function submitChatgptPrompt(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  prompt: string,
  targetUrl: string,
  timeoutMs?: number,
): Promise<string> {
  const renderedPrompt = withForgePluginMention(prompt);
  const before = await latestChatgptUserMessage(controllerHome, workId, browserSessionId, timeoutMs)
    .catch((): { selector?: string; preview: string; url?: string } => ({ selector: undefined, preview: '', url: targetUrl }));
  await controllerBrowserAction(controllerHome, workId, 'fill', {
    session_id: browserSessionId,
    selector: CHATGPT_PROMPT_SELECTOR,
    text: renderedPrompt,
    timeout_ms: timeoutMs ?? 60_000,
    post_action_wait_ms: 100,
  }, timeoutMs);

  let observedUrl = targetUrl;
  let submitOutcomeUnknown = false;
  try {
    const sent = await controllerBrowserAction(controllerHome, workId, 'click', {
      session_id: browserSessionId,
      selector: CHATGPT_SEND_SELECTOR,
      timeout_ms: timeoutMs ?? 60_000,
      post_action_wait_ms: 250,
    }, timeoutMs);
    observedUrl = resultUrl(sent) ?? observedUrl;
  } catch (error) {
    if (browserMutationOutcomeUnknown(error, 'click')) {
      // Never replay an outcome-unknown submit: semantic observation below decides
      // whether the original click committed, preventing duplicate user messages.
      submitOutcomeUnknown = true;
    } else if (chatgptSendControlUnavailable(error)) {
      const pressed = await controllerBrowserAction(controllerHome, workId, 'press', {
        session_id: browserSessionId,
        selector: CHATGPT_PROMPT_SELECTOR,
        key: 'Enter',
        timeout_ms: timeoutMs ?? 60_000,
        post_action_wait_ms: 250,
      }, timeoutMs);
      observedUrl = resultUrl(pressed) ?? observedUrl;
    } else {
      throw error;
    }
  }

  const deadline = Date.now() + Math.min(Math.max(timeoutMs ?? 10_000, 3_000), 10_000);
  do {
    const latest = await latestChatgptUserMessage(controllerHome, workId, browserSessionId, timeoutMs).catch(() => undefined);
    if (latest) {
      observedUrl = latest.url ?? observedUrl;
      const isNewOutbound = Boolean(
        (latest.selector && latest.selector !== before.selector)
        || (!before.preview && latest.preview)
        || latest.preview !== before.preview,
      );
      if (isNewOutbound) {
        const fullText = await fullChatgptMessageText(controllerHome, workId, browserSessionId, latest, timeoutMs);
        if (chatgptOutboundMessageMatchesPrompt(fullText, renderedPrompt) && /\/c\/[^/?#]+/.test(observedUrl)) {
          return observedUrl;
        }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  } while (Date.now() < deadline);
  throw new Error(`${submitOutcomeUnknown ? CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN : 'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED'}:${observedUrl}`);
}

