import { createHash, randomUUID } from 'crypto';
import { runBridgeProvider, isWslWindowsRuntime } from '../../../cli/chatgpt-browser/bridge-provider';
import { buildBrowserPluginManifest, executeBrowserPluginAction } from '../../plugins/browser-adapter';
import { controllerPluginRepository } from '../../plugins/store';
import { getWorkContract } from '../facade/work-contract-store';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  hasChatgptConversationIdentity,
  parseChatgptConversationIdentity,
  rebindChatgptWorkConversation,
  type ChatgptWorkConversationBinding,
} from './chatgpt-work-binding-store';

const LEGACY_CONTROLLER_CHATGPT_SESSION_ID = 'forge-chatgpt-supercontroller';
export const DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6';
export const DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high';
export const DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY = 'auto';
export const DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge';
const CHATGPT_PROMPT_SELECTOR = 'div#prompt-textarea[contenteditable="true"]';
const CHATGPT_SEND_SELECTOR = '[data-testid="send-button"], button[aria-label*="Send"], button[data-testid*="send"]';
const CHATGPT_INTELLIGENCE_CONTROL_SELECTORS = [
  'main button, main [role="button"]',
  'button, [role="button"]',
] as const;
const CHATGPT_CAPABILITY_SLIDER_SELECTOR = '[role="slider"]';
const CHATGPT_CAPABILITY_MENUITEM_SELECTOR = '[role="menuitem"][aria-keyshortcuts~="ArrowLeft"][aria-keyshortcuts~="ArrowRight"]';

export type ChatgptAutomationReasoning = 'medium' | 'high' | 'xhigh';
export type ChatgptAutomationTabPolicy = 'auto' | 'reuse' | 'new';
export type ChatgptAutomationTabCleanupStatus = 'closed' | 'preserved_user_owned' | 'session_closed' | 'failed';

export interface WorkChatgptContinuationInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  prompt: string;
  /** Durable per-round capability minted before ChatGPT dispatch. */
  controllerAuthorityId?: string;
  /** Durable semantic relay scope paired with controllerAuthorityId. */
  relayScopeId?: string;
  title?: string;
  browserSessionId?: string;
  conversationUrl?: string;
  model?: string;
  reasoning?: ChatgptAutomationReasoning;
  tabPolicy?: ChatgptAutomationTabPolicy;
  timeoutMs?: number;
}

export interface WorkChatgptContinuationResult {
  status: 'dispatched' | 'failed';
  provider: 'controller-browser' | 'chatgpt-bridge';
  browserSessionId: string;
  conversationUrl?: string;
  conversationId?: string;
  localAlias?: string;
  resumedFromBinding: boolean;
  model: string;
  reasoning: ChatgptAutomationReasoning;
  tabPolicy: ChatgptAutomationTabPolicy;
  executionPreferenceVerified: boolean;
  tabCleanupStatus?: ChatgptAutomationTabCleanupStatus;
  tabCleanupError?: { code: string; message: string };
  error?: { code: string; message: string };
}

export interface StandaloneChatgptPromptInput {
  controllerHome: string;
  repoId: string;
  scopeId: string;
  prompt: string;
  browserSessionId?: string;
  conversationUrl?: string;
  model?: string;
  reasoning?: ChatgptAutomationReasoning;
  tabPolicy?: ChatgptAutomationTabPolicy;
  timeoutMs?: number;
}

function workflowToolAttributionInstruction(input: WorkChatgptContinuationInput): string {
  const workId = input.workId;
  const authorityId = input.controllerAuthorityId?.trim();
  const relayScopeId = input.relayScopeId?.trim();
  if (authorityId && relayScopeId) {
    return `Forge Workflow execution contract: exact Work ${workId}. This launched round already has durable controller authority controller_authority_id=${authorityId} with relay_scope_id=${relayScopeId}. Use that exact authority on the FIRST controller_claim; do not call an unscoped controller_claim and do not wait for a claim response to mint another authority. If this client exposes controller_authority_id and relay_scope_id, pass both on controller_claim. If the current frozen client schema omits either field, call rh_work operation=repair, work_id=${workId}, capability_id=controller.round:controller_claim:${authorityId}:${relayScopeId}; Forge maps it to the same fenced claim. After claim, data.controllerAuthorityId must equal ${authorityId}; pass the same durable authority unchanged on continue, verify, finalize, stop, and controller_release, using the corresponding compatibility capability when necessary. Never use data.session.sessionId as the durable capability: MCP execution sessions may rotate. For every repository_command_execute and repository_safe_patch_apply call in this turn, pass work_id=${workId} explicitly; never omit this Work id.`;
  }
  return `Forge Workflow execution contract: first claim exact Work ${workId}. Capture data.controllerAuthorityId from that successful controller_claim response. Pass it unchanged as controller_authority_id on every subsequent rh_work lifecycle call for this Work (continue, verify, finalize, stop, controller_release); if the current frozen client schema does not expose controller_authority_id, pass the same opaque value as session_id compatibility carrier. Never use data.session.sessionId as the durable capability: MCP execution sessions may be replaced or invalidated between tool calls. For every repository_command_execute and repository_safe_patch_apply call in this turn, pass work_id=${workId} explicitly; never omit this Work id.`;
}

function controllerRoundAuthorityInputError(input: WorkChatgptContinuationInput): Error | undefined {
  const hasAuthority = Boolean(input.controllerAuthorityId?.trim());
  const hasRelayScope = Boolean(input.relayScopeId?.trim());
  if (hasAuthority === hasRelayScope) return undefined;
  return new Error('CHATGPT_CONTROLLER_ROUND_AUTHORITY_INCOMPLETE: controllerAuthorityId and relayScopeId must be supplied together');
}

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
  const repository = controllerPluginRepository(controllerHome);
  const repoRoot = repository.canonicalRoot ?? repository.localRoot;
  if (!repoRoot) throw new Error('CHATGPT_CONTROLLER_BROWSER_ROOT_UNAVAILABLE');
  return executeBrowserPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot,
    pluginId: 'browser',
    actionId,
    requestId: requestId(workId, actionId),
    args: chatgptBrowserActionArgs(actionId, args),
    timeoutMs,
    origin: { surface: 'schedule', actor: 'chatgpt-work-continuation' },
  });
}

async function ensureControllerChatgptBrowser(controllerHome: string, workId: string): Promise<void> {
  const repository = controllerPluginRepository(controllerHome);
  const repoRoot = repository.canonicalRoot ?? repository.localRoot;
  if (!repoRoot) throw new Error('CHATGPT_CONTROLLER_BROWSER_ROOT_UNAVAILABLE');
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

function normalizeModel(value?: string): string {
  const model = value?.trim().toLowerCase() || DEFAULT_CHATGPT_AUTOMATION_MODEL;
  if (model === 'gpt-5.6' || model === 'gpt-5.6-sol' || model === '5.6' || model === '5.6s') return DEFAULT_CHATGPT_AUTOMATION_MODEL;
  throw new Error(`CHATGPT_AUTOMATION_MODEL_UNSUPPORTED:${value}`);
}

function normalizeReasoning(value?: ChatgptAutomationReasoning): ChatgptAutomationReasoning {
  return value ?? DEFAULT_CHATGPT_AUTOMATION_REASONING;
}

function normalizeTabPolicy(value?: ChatgptAutomationTabPolicy): ChatgptAutomationTabPolicy {
  return value ?? DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY;
}

export function stableChatgptWorkBrowserSessionId(repoId: string, workId: string): string {
  const digest = createHash('sha256').update(`${repoId}\n${workId}`).digest('hex').slice(0, 20);
  return `forge-chatgpt-work-${digest}`;
}

export function stableChatgptWorkBridgeSessionId(repoId: string, workId: string): string {
  const digest = createHash('sha256').update(`${repoId}\nbridge\n${workId}`).digest('hex').slice(0, 20);
  return `forge-chatgpt-bridge-${digest}`;
}

export function stableStandaloneChatgptBrowserSessionId(repoId: string, scopeId: string): string {
  const digest = createHash('sha256').update(`${repoId}\nstandalone\n${scopeId}`).digest('hex').slice(0, 20);
  return `forge-chatgpt-standalone-${digest}`;
}

function resolveStandaloneChatgptBrowserSessionId(input: StandaloneChatgptPromptInput): string {
  const policy = normalizeTabPolicy(input.tabPolicy);
  const stable = stableStandaloneChatgptBrowserSessionId(input.repoId, input.scopeId);
  if (policy === 'new') return `${stable}-${randomUUID().slice(0, 8)}`;
  return input.browserSessionId?.trim() || stable;
}

export function resolveChatgptWorkBrowserSessionId(input: {
  repoId: string;
  workId: string;
  tabPolicy?: ChatgptAutomationTabPolicy;
  explicitSessionId?: string;
  boundSessionId?: string;
}): string {
  const policy = normalizeTabPolicy(input.tabPolicy);
  const stable = stableChatgptWorkBrowserSessionId(input.repoId, input.workId);
  if (policy === 'new') return `${stable}-${randomUUID().slice(0, 8)}`;
  const explicit = input.explicitSessionId?.trim();
  if (explicit && explicit !== LEGACY_CONTROLLER_CHATGPT_SESSION_ID) return explicit;
  const bound = input.boundSessionId?.trim();
  if (bound && bound !== LEGACY_CONTROLLER_CHATGPT_SESSION_ID) return bound;
  return stable;
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

async function ensureChatgptExecutionPreference(
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

async function closeChatgptAutomationTabAfterDispatch(
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

async function navigateWorkConversation(
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
    const beforeInventory = await controllerBrowserAction(controllerHome, workId, 'list_sessions', { limit: 100 }, timeoutMs);
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
      const afterInventory = await controllerBrowserAction(controllerHome, workId, 'list_sessions', { limit: 100 }, timeoutMs);
      const reconciledSessionId = reconciledNewChatgptOpenPageSessionId(beforeInventory, afterInventory, url);
      if (!reconciledSessionId) throw error;
      return reconciledSessionId;
    }
  };
  try {
    await navigate(browserSessionId, targetUrl);
    return { submissionTargetUrl: targetUrl, recoveredFromStaleBinding: false, browserSessionId };
  } catch (error) {
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

async function submitChatgptPrompt(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  prompt: string,
  targetUrl: string,
  timeoutMs?: number,
): Promise<string> {
  await controllerBrowserAction(controllerHome, workId, 'fill', {
    session_id: browserSessionId,
    selector: CHATGPT_PROMPT_SELECTOR,
    text: withForgePluginMention(prompt),
    timeout_ms: timeoutMs ?? 60_000,
    post_action_wait_ms: 100,
  }, timeoutMs);
  const sent = await controllerBrowserAction(controllerHome, workId, 'click', {
    session_id: browserSessionId,
    selector: CHATGPT_SEND_SELECTOR,
    timeout_ms: timeoutMs ?? 60_000,
    post_action_wait_ms: 1_000,
  }, timeoutMs);
  let observedUrl = resultUrl(sent) ?? targetUrl;
  if (/\/c\/[^/?#]+/.test(observedUrl)) return observedUrl;
  const deadline = Date.now() + Math.min(Math.max(timeoutMs ?? 8_000, 2_000), 8_000);
  do {
    const observed = await controllerBrowserAction(controllerHome, workId, 'query_all', {
      session_id: browserSessionId,
      selector: 'main',
      limit: 1,
      timeout_ms: Math.min(timeoutMs ?? 3_000, 3_000),
    }, timeoutMs).catch(() => undefined);
    observedUrl = observed ? resultUrl(observed) ?? observedUrl : observedUrl;
    if (/\/c\/[^/?#]+/.test(observedUrl)) return observedUrl;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  } while (Date.now() < deadline);
  throw new Error(`CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED:${observedUrl}`);
}

export function withForgePluginMention(prompt: string): string {
  const value = prompt.trim();
  if (!value) throw new Error('CHATGPT_AUTOMATION_PROMPT_REQUIRED');
  if (/^@forge(?:\s|$)/i.test(value)) return value;
  return `${DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION} ${value}`;
}

/**
 * Dispatches a bounded standalone prompt through the same controller-owned
 * ChatGPT browser path without creating or requiring a WorkContract. The scope
 * id is only a stable browser correlation key (for example a Schedule id).
 */
export async function runStandaloneChatgptPrompt(input: StandaloneChatgptPromptInput): Promise<WorkChatgptContinuationResult> {
  const model = normalizeModel(input.model);
  const reasoning = normalizeReasoning(input.reasoning);
  const tabPolicy = normalizeTabPolicy(input.tabPolicy);
  const sessionId = resolveStandaloneChatgptBrowserSessionId(input);
  const browserScopeId = `standalone:${input.scopeId}`;
  const seedUrl = input.conversationUrl?.trim();

  try {
    await ensureControllerChatgptBrowser(input.controllerHome, browserScopeId);
    const targetUrl = seedUrl ?? 'https://chatgpt.com/';
    const navigation = await navigateWorkConversation(
      input.controllerHome,
      browserScopeId,
      sessionId,
      targetUrl,
      input.timeoutMs,
    );
    const executionPreferenceVerified = await ensureChatgptExecutionPreference(
      input.controllerHome,
      browserScopeId,
      navigation.browserSessionId,
      model,
      reasoning,
      input.timeoutMs,
    );
    const observedUrl = await submitChatgptPrompt(
      input.controllerHome,
      browserScopeId,
      navigation.browserSessionId,
      input.prompt,
      navigation.submissionTargetUrl,
      input.timeoutMs,
    );
    const tabCleanup = await closeChatgptAutomationTabAfterDispatch(
      input.controllerHome,
      browserScopeId,
      navigation.browserSessionId,
      input.timeoutMs,
    );
    return {
      status: 'dispatched',
      provider: 'controller-browser',
      browserSessionId: navigation.browserSessionId,
      conversationUrl: observedUrl,
      resumedFromBinding: false,
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified,
      tabCleanupStatus: tabCleanup.status,
      ...(tabCleanup.error ? { tabCleanupError: tabCleanup.error } : {}),
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'controller-browser',
      browserSessionId: sessionId,
      conversationUrl: seedUrl,
      resumedFromBinding: false,
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: false,
      error: {
        code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : 'CHATGPT_CONTROLLER_BROWSER_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Dispatches a bounded resume prompt to one controller-owned ChatGPT Web tab.
 * Chat history is transport context only. Forge Work/Plan/evidence remain authoritative.
 */
export async function runWorkChatgptContinuation(input: WorkChatgptContinuationInput): Promise<WorkChatgptContinuationResult> {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const existing = getChatgptWorkConversationBinding(store, input.workId);
  const seedUrl = input.conversationUrl?.trim() || existing?.conversationUrl;
  const model = normalizeModel(input.model);
  const reasoning = normalizeReasoning(input.reasoning);
  const tabPolicy = normalizeTabPolicy(input.tabPolicy);
  const authorityInputError = controllerRoundAuthorityInputError(input);
  if (authorityInputError) {
    const bridgeRuntime = isWslWindowsRuntime();
    const browserSessionId = bridgeRuntime
      ? stableChatgptWorkBridgeSessionId(input.repoId, input.workId)
      : resolveChatgptWorkBrowserSessionId({
          repoId: input.repoId,
          workId: input.workId,
          tabPolicy,
          explicitSessionId: input.browserSessionId,
          boundSessionId: existing?.latestBrowserSessionId,
        });
    return {
      status: 'failed',
      provider: bridgeRuntime ? 'chatgpt-bridge' : 'controller-browser',
      browserSessionId,
      conversationUrl: seedUrl,
      conversationId: existing?.conversationId,
      localAlias: existing?.localAlias,
      resumedFromBinding: Boolean(existing),
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: false,
      error: {
        code: 'CHATGPT_CONTROLLER_ROUND_AUTHORITY_INCOMPLETE',
        message: authorityInputError.message,
      },
    };
  }
  if (isWslWindowsRuntime()) {
    const bridgeSessionId = stableChatgptWorkBridgeSessionId(input.repoId, input.workId);
    let binding = existing;
    try {
      const work = getWorkContract(store, input.workId);
      if (!work || work.repoId !== input.repoId) throw new Error(`CHATGPT_WORK_CONTRACT_NOT_FOUND: ${input.repoId}:${input.workId}`);
      const repository = controllerPluginRepository(input.controllerHome);
      const bridgeRoot = repository.canonicalRoot ?? repository.localRoot;
      if (!bridgeRoot) throw new Error('CHATGPT_CONTROLLER_BROWSER_ROOT_UNAVAILABLE');
      const targetUrl = binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/';
      const renderedPrompt = `${workflowToolAttributionInstruction(input)}\n\n${input.prompt}`;
      const bridged = await runBridgeProvider({
        repoRoot: bridgeRoot,
        prompt: renderedPrompt,
        provider: 'bridge',
        chatgptUrl: targetUrl,
        timeoutMs: input.timeoutMs ?? 60_000,
        dispatchOnly: true,
      }, {
        prompt: renderedPrompt,
        rendered: renderedPrompt,
        files: [],
        followups: [],
        totalChars: renderedPrompt.length,
      });
      if (bridged.status !== 'completed') {
        throw new Error(`${bridged.error?.code ?? 'CHATGPT_BRIDGE_DISPATCH_FAILED'}: ${bridged.error?.message ?? bridged.output}`);
      }
      const observedUrl = bridged.conversationUrl ?? targetUrl;
      if (/\/c\/[^/?#]+/.test(observedUrl)) {
        const observedIdentity = parseChatgptConversationIdentity(observedUrl);
        binding = binding && binding.conversationId !== observedIdentity.conversationId
          ? rebindChatgptWorkConversation(store, {
              workId: input.workId,
              previousConversationId: binding.conversationId,
              conversationUrl: observedUrl,
              latestBrowserSessionId: bridgeSessionId,
              localAlias: binding.localAlias ?? input.title,
            })
          : bindChatgptWorkConversation(store, {
              workId: input.workId,
              conversationUrl: observedUrl,
              latestBrowserSessionId: bridgeSessionId,
              localAlias: binding?.localAlias ?? input.title,
            });
      }
      return {
        status: 'dispatched',
        provider: 'chatgpt-bridge',
        browserSessionId: bridgeSessionId,
        conversationUrl: binding?.conversationUrl ?? observedUrl,
        conversationId: binding?.conversationId,
        localAlias: binding?.localAlias,
        resumedFromBinding: Boolean(existing),
        model,
        reasoning,
        tabPolicy,
        executionPreferenceVerified: false,
      };
    } catch (error) {
      return {
        status: 'failed',
        provider: 'chatgpt-bridge',
        browserSessionId: bridgeSessionId,
        conversationUrl: binding?.conversationUrl ?? seedUrl,
        conversationId: binding?.conversationId,
        localAlias: binding?.localAlias,
        resumedFromBinding: Boolean(existing),
        model,
        reasoning,
        tabPolicy,
        executionPreferenceVerified: false,
        error: {
          code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : 'CHATGPT_BRIDGE_DISPATCH_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  const sessionId = resolveChatgptWorkBrowserSessionId({
    repoId: input.repoId,
    workId: input.workId,
    tabPolicy,
    explicitSessionId: input.browserSessionId,
    boundSessionId: existing?.latestBrowserSessionId,
  });
  let binding: ChatgptWorkConversationBinding | undefined = existing;

  try {
    const work = getWorkContract(store, input.workId);
    if (!work || work.repoId !== input.repoId) {
      throw new Error(`CHATGPT_WORK_CONTRACT_NOT_FOUND: ${input.repoId}:${input.workId}`);
    }
    await ensureControllerChatgptBrowser(input.controllerHome, input.workId);
    if (seedUrl && !binding && hasChatgptConversationIdentity(seedUrl)) {
      binding = bindChatgptWorkConversation(store, {
        workId: input.workId,
        conversationUrl: seedUrl,
        latestBrowserSessionId: sessionId,
        localAlias: input.title,
      });
    }
    const targetUrl = binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/';
    const navigation = await navigateWorkConversation(
      input.controllerHome,
      input.workId,
      sessionId,
      targetUrl,
      input.timeoutMs,
    );
    const executionPreferenceVerified = await ensureChatgptExecutionPreference(
      input.controllerHome,
      input.workId,
      navigation.browserSessionId,
      model,
      reasoning,
      input.timeoutMs,
    );
    const observedUrl = await submitChatgptPrompt(input.controllerHome, input.workId, navigation.browserSessionId, `${workflowToolAttributionInstruction(input)}\n\n${input.prompt}`, navigation.submissionTargetUrl, input.timeoutMs);
    if (/\/c\/[^/?#]+/.test(observedUrl)) {
      const observedIdentity = parseChatgptConversationIdentity(observedUrl);
      binding = binding && binding.conversationId !== observedIdentity.conversationId
        ? rebindChatgptWorkConversation(store, {
          workId: input.workId,
          previousConversationId: binding.conversationId,
          conversationUrl: observedUrl,
          latestBrowserSessionId: navigation.browserSessionId,
          localAlias: binding.localAlias ?? input.title,
        })
        : bindChatgptWorkConversation(store, {
          workId: input.workId,
          conversationUrl: observedUrl,
          latestBrowserSessionId: navigation.browserSessionId,
          localAlias: binding?.localAlias ?? input.title,
        });
    }
    // Work-bound dispatch keeps the Forge-owned automation tab/session alive for
    // the launched semantic Controller round. The exact Controller release path
    // settles it after an explicit disposition. Closing here would race the new
    // ChatGPT round and make dispatch success look like round completion.
    return {
      status: 'dispatched',
      provider: 'controller-browser',
      browserSessionId: navigation.browserSessionId,
      conversationUrl: binding?.conversationUrl ?? observedUrl,
      conversationId: binding?.conversationId,
      localAlias: binding?.localAlias,
      resumedFromBinding: Boolean(existing),
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified,
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'controller-browser',
      browserSessionId: sessionId,
      conversationUrl: binding?.conversationUrl ?? seedUrl,
      conversationId: binding?.conversationId,
      localAlias: binding?.localAlias,
      resumedFromBinding: Boolean(existing),
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: false,
      error: {
        code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : 'CHATGPT_CONTROLLER_BROWSER_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
