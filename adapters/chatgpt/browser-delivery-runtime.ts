import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionJobOrigin } from '../../src/runtime/execution/jobs/types';
import { browserActions } from '../../src/runtime/plugins/browser-manifest-surface';
import { executeControllerScopedPluginAction, getControllerPluginManifest, submitControllerPluginAction } from '../../src/runtime/plugins/store';
import {
  CHATGPT_AUTOMATION_RATE_LIMITED,
  CHATGPT_AUTOMATION_RATE_LIMITED_AFTER_SUBMIT,
  CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN,
  ChatgptProviderDeliveryError,
  chatgptProviderPageFailure,
  DEFAULT_CHATGPT_AUTOMATION_MODEL,
  type ChatgptAutomationReasoning,
  type ChatgptAutomationTabCleanupStatus,
  type ChatgptProviderPageFailureCode,
} from './provider-delivery';

// The ChatGPT plugin's owned manifest currently names the canonical main app
// `forge-current-1-8-1` (visible label `Forge Current 1.8.1`). A text alias
// `@forge` is NOT a bound plugin and Forge Recovery is a different app.
const CHATGPT_FORGE_PLUGIN_SLUG = 'forge-current-1-8-1';
const CHATGPT_FORGE_PLUGIN_LABEL = 'Forge Current 1.8.1';
const CHATGPT_PLUGIN_PICKER_BUTTON = 'button[aria-label="添加文件等内容"], button[aria-label="Add files and more"]';
const CHATGPT_PLUGIN_PICKER_OPTIONS = '[data-mention-section-id="plugins"] [data-mention-section-items] > button';


type ChatgptBrowserActionOrigin = Pick<ExecutionJobOrigin, 'surface' | 'actor'>;
interface ChatgptBrowserActionContext {
  origin: ChatgptBrowserActionOrigin;
  authorizationGrantRefs: Set<string>;
}
const chatgptBrowserActionOrigin = new AsyncLocalStorage<ChatgptBrowserActionContext>();

export function withChatgptBrowserActionOrigin<T>(
  origin: ChatgptBrowserActionOrigin,
  operation: () => Promise<T>,
  authorizationGrantRefs: Set<string> = new Set(),
): Promise<T> {
  return chatgptBrowserActionOrigin.run({ origin, authorizationGrantRefs }, operation);
}

/** Strip the legacy text trigger; only a real ChatGPT app chip selects Forge. */
export function chatgptSupervisorPromptBody(prompt: string): string {
  const value = prompt.trim().replace(/^@forge(?:[ \t]*\r?\n|[ \t]+|$)/i, '').trim();
  if (!value) throw new Error('CHATGPT_AUTOMATION_PROMPT_REQUIRED');
  return value;
}

// ChatGPT's composer is a ProseMirror textbox; the historical #prompt-textarea id is no longer stable.
// Bind delivery to the semantic composer contract used by the live UI so readiness, fill, and Enter fallback share one selector authority.
const CHATGPT_PROMPT_SELECTOR = '[data-composer-markdown][role="textbox"][contenteditable="true"]';
const CHATGPT_SEND_SELECTOR = '[data-testid="send-button"], button[aria-label="Send"], button[aria-label="发送"], button[data-testid*="send"]';
const CHATGPT_USER_MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]';
const CHATGPT_ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
const CHATGPT_STOP_GENERATING_SELECTOR = '[data-testid="stop-button"], button[aria-label*="Stop"]';
const CHATGPT_INTELLIGENCE_CONTROL_SELECTORS = [
  'main button, main [role="button"]',
  'button, [role="button"]',
] as const;
const CHATGPT_CAPABILITY_SLIDER_SELECTOR = '[role="slider"]';
const CHATGPT_CAPABILITY_MENUITEM_SELECTOR = '[role="menuitem"][aria-keyshortcuts~="ArrowLeft"][aria-keyshortcuts~="ArrowRight"]';

function requestId(workId: string, actionId: string): string {
  return `chatgpt-work:${workId}:${actionId}:${randomUUID()}`;
}

const CHATGPT_BROWSER_AUTHORIZATION_ACTIONS = new Set(
  browserActions()
    .filter((action) => !action.readOnly && action.confirmation === 'authorization')
    .map((action) => action.actionId),
);

export function chatgptBrowserActionArgs(actionId: string, args: Record<string, unknown>): Record<string, unknown> {
  // Browser transport policy is controller-scoped configuration. Do not copy
  // it into every action envelope: older Browser action schemas legitimately
  // reject these optional fields even though the persisted configuration still
  // supports the same policy. Keeping the envelope action-specific also lets a
  // resumed ChatGPT round cross a connector/schema rotation without failing
  // before the provider can observe the conversation.
  void actionId;
  return args;
}

export function chatgptBrowserActionResult(envelope: Record<string, unknown>, actionId: string): Record<string, unknown> {
  const result = envelope.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`CHATGPT_BROWSER_ACTION_RESULT_INVALID:${actionId}`);
  }
  return result as Record<string, unknown>;
}

async function controllerBrowserAction(
  controllerHome: string,
  workId: string,
  actionId: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const context = chatgptBrowserActionOrigin.getStore();
  const origin = context?.origin ?? { surface: 'schedule', actor: 'chatgpt-work-continuation' };
  const actionRequest = {
    pluginId: 'browser',
    actionId,
    requestId: requestId(workId, actionId),
    args: chatgptBrowserActionArgs(actionId, args),
    timeoutMs,
    origin,
  };

  // Interactive ChatGPT delivery is the only place allowed to establish a
  // reusable controller-scoped Browser grant. Scheduled delivery stays on the
  // low-level executor and must present explicit refs already bound to this Work.
  if (origin.surface === 'chatgpt-action' && CHATGPT_BROWSER_AUTHORIZATION_ACTIONS.has(actionId)) {
    const submitted = await submitControllerPluginAction(controllerHome, actionRequest);
    const grantId = submitted.authorization?.grantId?.trim();
    if (grantId) context?.authorizationGrantRefs.add(grantId);
    if (!submitted.result) throw new Error(`CHATGPT_BROWSER_ACTION_RESULT_INVALID:${actionId}`);
    return chatgptBrowserActionResult(submitted.result, actionId);
  }

  const envelope = await executeControllerScopedPluginAction({
    controllerHome,
    ...actionRequest,
    authorizationGrantRefs: [...(context?.authorizationGrantRefs ?? [])],
  });
  return chatgptBrowserActionResult(envelope, actionId);
}

export async function ensureControllerChatgptBrowser(controllerHome: string, workId: string): Promise<void> {
  // Browser configure is not a read: it persists configuration and closes managed
  // contexts. Scheduled continuations must not disturb an already-enabled provider
  // merely to prove it is available. Read the existing controller-scoped manifest
  // authority, and only enable it when that persisted authority is explicitly disabled;
  // action-level transport overrides still fail closed later.
  if (getControllerPluginManifest(controllerHome, 'browser').enabled) return;
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

const CHATGPT_OUTBOUND_MESSAGE_UI_SUFFIXES = ['收起', 'Collapse', 'Show less'] as const;
const MAX_CHATGPT_OUTBOUND_VERIFICATION_CHARS = 100_000;
const MIN_TRUNCATED_CHATGPT_OUTBOUND_PREFIX_CHARS = 256;
const CHATGPT_PROVIDER_ERROR_SELECTOR = '[role="alert"], [aria-live="assertive"], [data-testid*="error"], [data-testid*="toast"], [data-sonner-toast]';
const CHATGPT_DELIVERY_FAILURE_PROBE_INTERVAL_MS = 1_000;

interface BrowserFailedRequest {
  url?: string;
  method?: string;
  status?: number;
  failure?: string;
}

type ChatgptFailedRequestBaseline = Map<string, number>;

export function chatgptOutboundMessageMatchesPrompt(
  messageText: string,
  prompt: string,
  options: { truncated?: boolean; boundForgePlugin?: boolean } = {},
): boolean {
  const message = normalizeChatgptOutboundText(messageText);
  const normalizedPrompt = normalizeChatgptOutboundText(prompt);
  if (!message || !normalizedPrompt) return false;
  const candidatePrompts = [normalizedPrompt,
    ...(options.boundForgePlugin ? [
      `${CHATGPT_FORGE_PLUGIN_LABEL} ${normalizedPrompt}`,
      `${CHATGPT_FORGE_PLUGIN_SLUG} ${normalizedPrompt}`,
    ] : []),
  ];
  if (candidatePrompts.some((candidate) => message === candidate)) return true;
  if (candidatePrompts.some((candidate) => CHATGPT_OUTBOUND_MESSAGE_UI_SUFFIXES.some((suffix) => message === `${candidate} ${suffix}`))) return true;
  // Browser text extraction is deliberately bounded. A large ControllerRound
  // prompt can exceed that bound, so requiring exact equality makes successful
  // submissions mechanically unverifiable. Accept only an explicitly reported
  // truncation of a substantial exact prefix; ordinary partial/mismatched text
  // remains insufficient evidence.
  return options.truncated === true
    && message.length >= MIN_TRUNCATED_CHATGPT_OUTBOUND_PREFIX_CHARS
    && candidatePrompts.some((candidate) => candidate.startsWith(message));
}

export function chatgptAutomationDeliveryFailure(
  bodyText: string | undefined,
): ChatgptProviderPageFailureCode | undefined {
  return chatgptProviderPageFailure(bodyText);
}

export function chatgptSubmissionSettlementWaitBudget(timeoutMs?: number): number {
  return Math.min(Math.max(timeoutMs ?? 30_000, 3_000), 30_000);
}

export function chatgptSubmissionObservationDelayMs(observationIndex: number): number {
  const schedule = [500, 1_000, 2_000, 3_000, 5_000] as const;
  return schedule[Math.min(Math.max(0, Math.trunc(observationIndex)), schedule.length - 1)];
}

export function chatgptSubmissionAcceptanceObserved(input: {
  outboundConfirmed: boolean;
  hasConversationIdentity: boolean;
  assistantResponseObserved: boolean;
  generationInProgress: boolean;
}): boolean {
  return input.outboundConfirmed
    && input.hasConversationIdentity
    && (input.assistantResponseObserved || input.generationInProgress);
}

export function chatgptComposerRetainsPrompt(
  composerText: string | undefined,
  prompt: string,
): boolean {
  if (composerText === undefined) return false;
  const composer = normalizeChatgptOutboundText(composerText);
  const expected = normalizeChatgptOutboundText(prompt);
  return Boolean(composer && expected && composer === expected);
}

async function currentChatgptComposerText(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  const result = await controllerBrowserAction(controllerHome, workId, 'get_text', {
    session_id: browserSessionId,
    selector: CHATGPT_PROMPT_SELECTOR,
    max_chars: MAX_CHATGPT_OUTBOUND_VERIFICATION_CHARS,
    timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
  }, timeoutMs).catch(() => undefined);
  return typeof result?.text === 'string' ? result.text : undefined;
}

async function currentChatgptComposerHtml(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  const result = await controllerBrowserAction(controllerHome, workId, 'get_html', {
    session_id: browserSessionId,
    selector: CHATGPT_PROMPT_SELECTOR,
    max_chars: MAX_CHATGPT_OUTBOUND_VERIFICATION_CHARS,
    timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
  }, timeoutMs).catch(() => undefined);
  return typeof result?.text === 'string' && result.truncated !== true ? result.text : undefined;
}

/** A real ChatGPT plugin mention is a non-editable ProseMirror app chip, not @ text. */
export function chatgptForgePluginMentionBound(
  composerHtml: string | undefined,
  composerText: string | undefined,
  prompt: string,
): boolean {
  if (!composerHtml || !composerText) return false;
  const chips = [...composerHtml.matchAll(/\bapp-mention-name="([^"]+)"/g)].map((match) => match[1]);
  if (chips.length !== 1 || chips[0] !== CHATGPT_FORGE_PLUGIN_SLUG) return false;
  const normalized = normalizeChatgptOutboundText(composerText);
  const payload = normalizeChatgptOutboundText(prompt);
  return normalized === `${CHATGPT_FORGE_PLUGIN_LABEL} ${payload}`
    || normalized === `${CHATGPT_FORGE_PLUGIN_SLUG} ${payload}`;
}

/** Browser owns DOM actions; Supervisor remains the only effect and delivery owner. */
async function bindChatgptForgePluginMention(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  prompt: string,
  targetUrl: string,
  timeoutMs?: number,
): Promise<void> {
  const baseArgs = { session_id: browserSessionId, timeout_ms: timeoutMs ?? 60_000 };
  const state = await controllerBrowserAction(controllerHome, workId, 'get_attribute', {
    ...baseArgs, selector: CHATGPT_PLUGIN_PICKER_BUTTON, attribute: 'data-state',
  }, timeoutMs);
  if (state.value !== 'open') {
    await controllerBrowserAction(controllerHome, workId, 'click', {
      ...baseArgs, selector: CHATGPT_PLUGIN_PICKER_BUTTON,
    }, timeoutMs);
  }
  const open = await controllerBrowserAction(controllerHome, workId, 'get_attribute', {
    ...baseArgs, selector: CHATGPT_PLUGIN_PICKER_BUTTON, attribute: 'data-state',
  }, timeoutMs);
  if (open.value !== 'open') {
    throw new ChatgptProviderDeliveryError('CHATGPT_AUTOMATION_PLUGIN_PICKER_UNAVAILABLE',
      `CHATGPT_AUTOMATION_PLUGIN_PICKER_UNAVAILABLE:${targetUrl}`, { conversationUrl: targetUrl });
  }
  const entries = await controllerBrowserAction(controllerHome, workId, 'query_all', {
    ...baseArgs, selector: CHATGPT_PLUGIN_PICKER_OPTIONS, limit: 80,
  }, timeoutMs);
  const names = queryMatches(entries).map(matchText);
  const index = names.findIndex((name) => name === CHATGPT_FORGE_PLUGIN_LABEL
    || name.startsWith(`${CHATGPT_FORGE_PLUGIN_LABEL} `));
  if (index < 0 || names.filter((name) => name === CHATGPT_FORGE_PLUGIN_LABEL
    || name.startsWith(`${CHATGPT_FORGE_PLUGIN_LABEL} `)).length !== 1) {
    throw new ChatgptProviderDeliveryError('CHATGPT_AUTOMATION_PLUGIN_NOT_IN_PICKER',
      `CHATGPT_AUTOMATION_PLUGIN_NOT_IN_PICKER:${CHATGPT_FORGE_PLUGIN_SLUG}:${targetUrl}`,
      { conversationUrl: targetUrl });
  }
  // The option order was observed from this exact open picker. Never select
  // another Forge-prefixed app as a fallback; verify the resulting app chip.
  await controllerBrowserAction(controllerHome, workId, 'click', {
    ...baseArgs, selector: `${CHATGPT_PLUGIN_PICKER_OPTIONS}:nth-of-type(${index + 1})`,
  }, timeoutMs);
  const [composerHtml, composerText] = await Promise.all([
    currentChatgptComposerHtml(controllerHome, workId, browserSessionId, timeoutMs),
    currentChatgptComposerText(controllerHome, workId, browserSessionId, timeoutMs),
  ]);
  if (!chatgptForgePluginMentionBound(composerHtml, composerText, prompt)) {
    throw new ChatgptProviderDeliveryError('CHATGPT_AUTOMATION_PLUGIN_MENTION_UNVERIFIED',
      `CHATGPT_AUTOMATION_PLUGIN_MENTION_UNVERIFIED:${targetUrl}`, { conversationUrl: targetUrl });
  }
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
): Promise<{ text: string; truncated: boolean }> {
  if (!message.selector) return { text: message.preview, truncated: false };
  const result = await controllerBrowserAction(controllerHome, workId, 'get_text', {
    session_id: browserSessionId,
    selector: message.selector,
    max_chars: MAX_CHATGPT_OUTBOUND_VERIFICATION_CHARS,
    timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
  }, timeoutMs).catch(() => undefined);
  return {
    text: stringField(result?.text) ?? message.preview,
    truncated: result?.truncated === true,
  };
}

async function latestChatgptAssistantMessage(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<{ selector?: string; preview: string }> {
  const result = await controllerBrowserAction(controllerHome, workId, 'query_all', {
    session_id: browserSessionId,
    selector: CHATGPT_ASSISTANT_MESSAGE_SELECTOR,
    limit: 1,
    from_end: true,
    timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
  }, timeoutMs);
  const latest = queryMatches(result).at(-1);
  return { selector: matchSelector(latest), preview: latest ? matchText(latest) : '' };
}

function chatgptMessageObservationChanged(
  before: { selector?: string; preview: string },
  latest: { selector?: string; preview: string },
): boolean {
  return Boolean(
    (latest.selector && latest.selector !== before.selector)
    || (!before.preview && latest.preview)
    || latest.preview !== before.preview,
  );
}

async function chatgptGenerationInProgress(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<boolean> {
  const result = await controllerBrowserAction(controllerHome, workId, 'query_all', {
    session_id: browserSessionId,
    selector: CHATGPT_STOP_GENERATING_SELECTOR,
    limit: 1,
    timeout_ms: Math.min(timeoutMs ?? 1_000, 1_000),
  }, timeoutMs).catch(() => undefined);
  return queryMatches(result).length > 0;
}

function failedRequestKey(request: BrowserFailedRequest): string {
  return `${request.method?.toUpperCase() ?? ''}|${request.status ?? ''}|${request.url ?? ''}|${request.failure ?? ''}`;
}

/** Only provider requests causally inside the current send pipeline may classify that send as rate-limited. */
export function chatgptFailedRequestIsCausalRateLimit(request: Pick<BrowserFailedRequest, 'url' | 'method' | 'status'>): boolean {
  if (request.status !== 429 || request.method?.trim().toUpperCase() !== 'POST') return false;
  try {
    const url = new URL(request.url ?? '');
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return false;
    const path = url.pathname.toLowerCase();
    return /^\/backend-api\/(?:f\/)?conversation(?:\/|$)/.test(path)
      || path === '/backend-api/sentinel/chat-requirements';
  } catch {
    return false;
  }
}

async function chatgptFailedRequestBaseline(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<ChatgptFailedRequestBaseline | undefined> {
  const result = await controllerBrowserAction(controllerHome, workId, 'get_failed_requests', {
    session_id: browserSessionId,
    timeout_ms: Math.min(timeoutMs ?? 2_000, 2_000),
  }, timeoutMs).catch(() => undefined);
  if (!result || !Array.isArray(result.failedRequests)) return undefined;
  const baseline = new Map<string, number>();
  for (const request of result.failedRequests) {
    if (!request || typeof request !== 'object') continue;
    const key = failedRequestKey(request as BrowserFailedRequest);
    baseline.set(key, (baseline.get(key) ?? 0) + 1);
  }
  return baseline;
}

async function chatgptProviderFailureOnErrorUi(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<ChatgptProviderPageFailureCode | undefined> {
  const result = await controllerBrowserAction(controllerHome, workId, 'query_all', {
    session_id: browserSessionId,
    selector: CHATGPT_PROVIDER_ERROR_SELECTOR,
    limit: 20,
    timeout_ms: Math.min(timeoutMs ?? 2_000, 2_000),
  }, timeoutMs).catch(() => undefined);
  for (const match of queryMatches(result)) {
    const failure = chatgptAutomationDeliveryFailure(matchText(match));
    if (failure) return failure;
  }
  return undefined;
}

async function chatgptDeliveryFailureOnPage(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  failedRequestBaseline: ChatgptFailedRequestBaseline | undefined,
  timeoutMs?: number,
): Promise<ChatgptProviderPageFailureCode | undefined> {
  const uiFailure = await chatgptProviderFailureOnErrorUi(controllerHome, workId, browserSessionId, timeoutMs);
  if (uiFailure) return uiFailure;
  if (!failedRequestBaseline) return undefined;

  const current = await controllerBrowserAction(controllerHome, workId, 'get_failed_requests', {
    session_id: browserSessionId,
    timeout_ms: Math.min(timeoutMs ?? 2_000, 2_000),
  }, timeoutMs).catch(() => undefined);
  if (!current || !Array.isArray(current.failedRequests)) return undefined;
  const seen = new Map<string, number>();
  for (const value of current.failedRequests) {
    if (!value || typeof value !== 'object') continue;
    const request = value as BrowserFailedRequest;
    const key = failedRequestKey(request);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const baselineCount = failedRequestBaseline.get(key) ?? 0;
    if (occurrence <= baselineCount) continue;
    if (chatgptFailedRequestIsCausalRateLimit(request)) return CHATGPT_AUTOMATION_RATE_LIMITED;
  }
  return undefined;
}

function chatgptSendControlUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('PLUGIN_BROWSER_SELECTOR_UNAVAILABLE');
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

export function chatgptAutomationModelFamilyMenuTrigger(
  label: string | undefined,
  ariaHasPopup: string | undefined,
): boolean {
  if (ariaHasPopup !== 'menu') return false;
  const normalized = normalizeExecutionControlLabel(label);
  // ChatGPT's composer can rotate model names independently of Forge releases.
  // Locate the combined intelligence control by a bounded model-family prefix
  // plus its menu-trigger role; do not treat arbitrary GPT prose/buttons as authority.
  return /^gpt\d/.test(normalized);
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
    const candidates = queryMatches(result);
    const exactMatch = candidates.find((candidate) => {
      const label = matchText(candidate);
      return modelLabelMatches(label, DEFAULT_CHATGPT_AUTOMATION_MODEL) || isReasoningControlLabel(label);
    });
    if (exactMatch) return exactMatch;
    for (const candidate of candidates) {
      const candidateSelector = matchSelector(candidate);
      if (!candidateSelector || !/^gpt\d/.test(normalizeExecutionControlLabel(matchText(candidate)))) continue;
      const popup = await controllerBrowserAction(controllerHome, workId, 'get_attribute', {
        session_id: browserSessionId,
        selector: candidateSelector,
        attribute: 'aria-haspopup',
        timeout_ms: timeoutMs ?? 60_000,
      }, timeoutMs).catch(() => undefined);
      if (chatgptAutomationModelFamilyMenuTrigger(matchText(candidate), stringField(popup?.value))) return candidate;
    }
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
      selector: CHATGPT_CAPABILITY_SLIDER_SELECTOR,
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

/** The saved Browser session id is not proof of the live native tab identity. */
export function chatgptBrowserObservationMatchesTarget(
  observation: Record<string, unknown>,
  browserSessionId: string,
  targetUrl: string,
): boolean {
  const observedSessionId = stringField(observation.sessionId) ?? resultSessionId(observation);
  if (observedSessionId && observedSessionId !== browserSessionId) return false;
  const connection = observation.browserConnection;
  const liveTab = connection && typeof connection === 'object'
    ? (connection as Record<string, unknown>).tab : undefined;
  const liveTabUrl = liveTab && typeof liveTab === 'object'
    ? stringField((liveTab as Record<string, unknown>).url) : undefined;
  const urls = [resultUrl(observation), liveTabUrl].filter((url): url is string => Boolean(url));
  return urls.length > 0 && urls.every((url) => chatgptUrlMatchesContinuationTarget(url, targetUrl));
}

async function verifyChatgptExactSubmissionTab(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  targetUrl: string,
  timeoutMs?: number,
): Promise<void> {
  const observed = await controllerBrowserAction(controllerHome, workId, 'get_text', {
    session_id: browserSessionId,
    selector: CHATGPT_PROMPT_SELECTOR,
    max_chars: 1,
    timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
  }, timeoutMs);
  if (!chatgptBrowserObservationMatchesTarget(observed, browserSessionId, targetUrl)) {
    throw new ChatgptProviderDeliveryError('CHATGPT_AUTOMATION_TARGET_IDENTITY_CHANGED',
      `CHATGPT_AUTOMATION_TARGET_IDENTITY_CHANGED:${targetUrl}`, { conversationUrl: targetUrl });
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
  authorizationGrantRefs: readonly string[] = [],
): Promise<{ status: ChatgptAutomationTabCleanupStatus; error?: { code: string; message: string } }> {
  try {
    const closePage = () => controllerBrowserAction(controllerHome, workId, 'close_page', {
      session_id: browserSessionId,
    }, Math.min(timeoutMs ?? 15_000, 15_000));
    const closed = authorizationGrantRefs.length > 0
      ? await withChatgptBrowserActionOrigin(
          { surface: 'schedule', actor: 'chatgpt-work-continuation' },
          closePage,
          new Set(authorizationGrantRefs),
        )
      : await closePage();
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
  authorizationGrantRefs?: readonly string[];
}): Promise<{ status: ChatgptAutomationTabCleanupStatus; error?: { code: string; message: string } }> {
  if (input.browserSessionId.startsWith('forge-chatgpt-bridge-')) return { status: 'session_closed' };
  return closeChatgptAutomationTabAfterDispatch(
    input.controllerHome,
    input.workId,
    input.browserSessionId,
    input.timeoutMs,
    input.authorizationGrantRefs,
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
  const openReplacement = async (sessionId: string, url: string): Promise<string> => {
    // Fresh ControllerRound transport already owns an explicit Browser session
    // identity. Use create_session with that exact id so native Browser never has
    // to guess among multiple reusable Forge-owned tabs. The Browser adapter still
    // owns tab identity/replacement and can recover a stale saved tab behind this id.
    try {
      const opened = await controllerBrowserAction(controllerHome, workId, 'create_session', {
        session_id: sessionId,
        url,
        // Direct Browser delivery must never silently escalate to the macOS
        // Apple Events compatibility provider. Work-bound unattended delivery is
        // owned by Workflow Supervisor's extension transport; this legacy direct
        // lane uses a Forge-managed browser resource unless the caller explicitly
        // configured a different transport elsewhere.
        browser_mode: 'managed_persistent',
        native_attach_mode: 'disabled',
        cdp_attach_fallback: 'fail_closed',
        wait_until: 'domcontentloaded',
        timeout_ms: timeoutMs ?? 60_000,
        retries: 1,
      }, timeoutMs);
      const replacementSessionId = resultSessionId(opened);
      if (replacementSessionId !== sessionId) throw new Error('CHATGPT_AUTOMATION_REPLACEMENT_SESSION_NOT_CONFIRMED');
      return replacementSessionId;
    } catch (error) {
      if (!browserMutationOutcomeUnknown(error, 'create_session')) throw error;
      try {
        const verified = await controllerBrowserAction(controllerHome, workId, 'verify_state', {
          session_id: sessionId,
          expected_url: url,
        }, timeoutMs);
        if (verified.matched === true && stringField(verified.sessionId) === sessionId) return sessionId;
      } catch {
        // Preserve the original create_session mutation-unknown evidence.
      }
      throw error;
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
      const replacementSessionId = await openReplacement(browserSessionId, targetUrl);
      // create_session establishes only the session capability. Activating the
      // exact replacement page is an interaction-capability action, so an
      // interactive prepare also establishes the grant required by later
      // schedule-origin fill/click actions on this same origin.
      await controllerBrowserAction(controllerHome, workId, 'activate_page', {
        session_id: replacementSessionId,
      }, timeoutMs);
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
      const replacementSessionId = await openReplacement(browserSessionId, targetUrl);
      return { submissionTargetUrl: targetUrl, recoveredFromStaleBinding: false, browserSessionId: replacementSessionId };
    }
    // A bound /c/<id> is transport identity, not a hint. Falling back to the
    // ChatGPT root silently creates a replacement conversation and can turn one
    // transient navigation failure into duplicate provider recovery. Preserve the
    // exact conversation and let the owning continuation reconcile or retry it.
    throw error;
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
  // Verify the live native tab before reading/sending. The saved session may
  // have retargeted while its Browser handle remained stable.
  await verifyChatgptExactSubmissionTab(
    controllerHome, workId, browserSessionId, targetUrl, timeoutMs,
  );
  const renderedPrompt = chatgptSupervisorPromptBody(prompt);
  const [before, beforeAssistant, failedRequestBaseline, preexistingPageFailure] = await Promise.all([
    latestChatgptUserMessage(controllerHome, workId, browserSessionId, timeoutMs)
      .catch((): { selector?: string; preview: string; url?: string } => ({ selector: undefined, preview: '', url: targetUrl })),
    latestChatgptAssistantMessage(controllerHome, workId, browserSessionId, timeoutMs)
      .catch((): { selector?: string; preview: string } => ({ selector: undefined, preview: '' })),
    chatgptFailedRequestBaseline(controllerHome, workId, browserSessionId, timeoutMs),
    chatgptProviderFailureOnErrorUi(controllerHome, workId, browserSessionId, timeoutMs),
  ]);
  if (preexistingPageFailure === CHATGPT_AUTOMATION_RATE_LIMITED) {
    throw new ChatgptProviderDeliveryError(
      CHATGPT_AUTOMATION_RATE_LIMITED,
      `${CHATGPT_AUTOMATION_RATE_LIMITED}:${targetUrl}`,
      { conversationUrl: targetUrl },
    );
  }
  await controllerBrowserAction(controllerHome, workId, 'fill', {
    session_id: browserSessionId,
    selector: CHATGPT_PROMPT_SELECTOR,
    text: renderedPrompt,
    timeout_ms: timeoutMs ?? 60_000,
    post_action_wait_ms: 100,
  }, timeoutMs);

  // Browser fill can report success even when the live ProseMirror composer did
  // not retain the intended payload. Never send or trigger Enter fallback on
  // an unverified draft; the owning effect must remain unreplayed.
  const verifiedComposerText = await currentChatgptComposerText(
    controllerHome, workId, browserSessionId, timeoutMs,
  );
  if (!chatgptComposerRetainsPrompt(verifiedComposerText, renderedPrompt)) {
    throw new ChatgptProviderDeliveryError(
      'CHATGPT_AUTOMATION_COMPOSER_UNVERIFIED',
      `CHATGPT_AUTOMATION_COMPOSER_UNVERIFIED:${targetUrl}`,
      { conversationUrl: targetUrl },
    );
  }

  // The immutable effect marker alone is not enough: choose the exact main
  // Forge app and verify its structured mention before sending the payload.
  await bindChatgptForgePluginMention(
    controllerHome, workId, browserSessionId, renderedPrompt, targetUrl, timeoutMs,
  );

  // A popup or plugin-selection action can change the native tab. Re-attest
  // immediately before Send, never infer identity from a successful click.
  await verifyChatgptExactSubmissionTab(
    controllerHome, workId, browserSessionId, targetUrl, timeoutMs,
  );

  let observedUrl = targetUrl;
  let submitOutcomeUnknown = false;
  let observedNewOutbound = false;
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
      // Never blind-replay an outcome-unknown submit. First reconcile the exact
      // provider state. If the same payload is still wholly present in the
      // composer, no new user message exists, and no conversation identity was
      // created, the original click is mechanically proven not to have committed.
      // Only then may the same provider dispatch resume Send once without
      // refilling the composer or creating a new semantic effect generation.
      submitOutcomeUnknown = true;
      const latestAfterUnknown = await latestChatgptUserMessage(
        controllerHome,
        workId,
        browserSessionId,
        timeoutMs,
      ).catch(() => undefined);
      if (latestAfterUnknown) {
        observedUrl = latestAfterUnknown.url ?? observedUrl;
        observedNewOutbound = chatgptMessageObservationChanged(before, latestAfterUnknown);
      }
      const hasConversationIdentity = /\/c\/[^/?#]+/.test(observedUrl);
      const [composerHtml, composerText] = await Promise.all([
        currentChatgptComposerHtml(controllerHome, workId, browserSessionId, timeoutMs),
        currentChatgptComposerText(controllerHome, workId, browserSessionId, timeoutMs),
      ]);
      if (
        !observedNewOutbound
        && !hasConversationIdentity
        && chatgptForgePluginMentionBound(composerHtml, composerText, renderedPrompt)
      ) {
        try {
          const resumed = await controllerBrowserAction(controllerHome, workId, 'click', {
            session_id: browserSessionId,
            selector: CHATGPT_SEND_SELECTOR,
            timeout_ms: timeoutMs ?? 60_000,
            post_action_wait_ms: 250,
          }, timeoutMs);
          observedUrl = resultUrl(resumed) ?? observedUrl;
          submitOutcomeUnknown = false;
        } catch (resumeError) {
          if (!browserMutationOutcomeUnknown(resumeError, 'click')) throw resumeError;
        }
      }
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

  const deadline = Date.now() + chatgptSubmissionSettlementWaitBudget(timeoutMs);
  let nextFailureProbeAt = 0;
  let observationIndex = 0;
  do {
    const latest = await latestChatgptUserMessage(controllerHome, workId, browserSessionId, timeoutMs).catch(() => undefined);
    if (latest) {
      observedUrl = latest.url ?? observedUrl;
      const isNewOutbound = chatgptMessageObservationChanged(before, latest);
      if (isNewOutbound) {
        observedNewOutbound = true;
        const fullText = await fullChatgptMessageText(controllerHome, workId, browserSessionId, latest, timeoutMs);
        const outboundConfirmed = chatgptOutboundMessageMatchesPrompt(fullText.text, renderedPrompt, { truncated: fullText.truncated, boundForgePlugin: true });
        const hasConversationIdentity = /\/c\/[^/?#]+/.test(observedUrl);
        if (outboundConfirmed && hasConversationIdentity) {
          const [latestAssistant, generationInProgress] = await Promise.all([
            latestChatgptAssistantMessage(controllerHome, workId, browserSessionId, timeoutMs).catch(() => undefined),
            chatgptGenerationInProgress(controllerHome, workId, browserSessionId, timeoutMs),
          ]);
          const assistantResponseObserved = Boolean(
            latestAssistant?.preview
            && chatgptMessageObservationChanged(beforeAssistant, latestAssistant),
          );
          if (chatgptSubmissionAcceptanceObserved({
            outboundConfirmed,
            hasConversationIdentity,
            assistantResponseObserved,
            generationInProgress,
          })) {
            return observedUrl;
          }
          if (Date.now() >= nextFailureProbeAt) {
            const deliveryFailure = await chatgptDeliveryFailureOnPage(
              controllerHome,
              workId,
              browserSessionId,
              failedRequestBaseline,
              timeoutMs,
            );
            if (deliveryFailure) {
              const failureCode = deliveryFailure === CHATGPT_AUTOMATION_RATE_LIMITED
                ? CHATGPT_AUTOMATION_RATE_LIMITED_AFTER_SUBMIT
                : deliveryFailure;
              throw new ChatgptProviderDeliveryError(
                failureCode,
                `${failureCode}:${observedUrl}`,
                { conversationUrl: observedUrl },
              );
            }
            nextFailureProbeAt = Date.now() + CHATGPT_DELIVERY_FAILURE_PROBE_INTERVAL_MS;
          }
        }
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const observationDelayMs = chatgptSubmissionObservationDelayMs(observationIndex);
    observationIndex += 1;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(observationDelayMs, remainingMs)));
  } while (Date.now() < deadline);
  const hasConversationIdentity = /\/c\/[^/?#]+/.test(observedUrl);
  const finalComposerText = submitOutcomeUnknown && !observedNewOutbound && !hasConversationIdentity
    ? await currentChatgptComposerText(controllerHome, workId, browserSessionId, timeoutMs)
    : undefined;
  const submitProvablyNotApplied = submitOutcomeUnknown
    && !observedNewOutbound
    && !hasConversationIdentity
    && chatgptComposerRetainsPrompt(finalComposerText, renderedPrompt);
  // A fresh /c/<id> or any changed outbound user message is provider-side
  // evidence that the send may have committed even when DOM observation lagged.
  // Keep that ambiguity fenced. Conversely, an exact unchanged composer proves
  // the send did not commit and must not be mislabeled outcome_unknown.
  const failureCode = (submitOutcomeUnknown && !submitProvablyNotApplied) || hasConversationIdentity || observedNewOutbound
    ? CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN
    : 'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED';
  throw new ChatgptProviderDeliveryError(
    failureCode,
    `${failureCode}:${observedUrl}`,
    { conversationUrl: observedUrl },
  );
}
