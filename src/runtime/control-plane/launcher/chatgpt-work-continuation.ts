import { createHash, randomUUID } from 'crypto';
import { executeBrowserPluginAction, readBrowserPluginConfiguration } from '../../plugins/browser-adapter';
import { controllerPluginRepository } from '../../plugins/store';
import { getWorkContract } from '../facade/work-contract-store';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  type ChatgptWorkConversationBinding,
} from './chatgpt-work-binding-store';

const LEGACY_CONTROLLER_CHATGPT_SESSION_ID = 'forge-chatgpt-supercontroller';
export const DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6';
export const DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high';
export const DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY = 'auto';
export const DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge';
const CHATGPT_PROMPT_SELECTOR = '[name="prompt-textarea"]';
const CHATGPT_SEND_KEY = 'Enter';
const CHATGPT_INTELLIGENCE_CONTROL_SELECTOR = 'main button';
const CHATGPT_CAPABILITY_SLIDER_SELECTOR = '[role="slider"]';
const CHATGPT_CAPABILITY_MENUITEM_SELECTOR = '[role="menuitem"][aria-keyshortcuts~="ArrowLeft"][aria-keyshortcuts~="ArrowRight"]';

export type ChatgptAutomationReasoning = 'medium' | 'high' | 'xhigh';
export type ChatgptAutomationTabPolicy = 'auto' | 'reuse' | 'new';

export interface WorkChatgptContinuationInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  prompt: string;
  title?: string;
  browserSessionId?: string;
  conversationUrl?: string;
  model?: string;
  reasoning?: ChatgptAutomationReasoning;
  tabPolicy?: ChatgptAutomationTabPolicy;
  timeoutMs?: number;
}

export interface ScheduledChatgptPromptInput {
  controllerHome: string;
  repoId: string;
  automationId: string;
  prompt: string;
  title?: string;
  browserSessionId?: string;
  conversationUrl?: string;
  model?: string;
  reasoning?: ChatgptAutomationReasoning;
  tabPolicy?: ChatgptAutomationTabPolicy;
  timeoutMs?: number;
}

export interface ScheduledChatgptPromptResult {
  status: 'dispatched' | 'failed';
  provider: 'controller-browser';
  browserSessionId: string;
  conversationUrl?: string;
  model: string;
  reasoning: ChatgptAutomationReasoning;
  tabPolicy: ChatgptAutomationTabPolicy;
  executionPreferenceVerified: boolean;
  reusedSession: boolean;
  error?: { code: string; message: string };
}

export interface WorkChatgptContinuationResult {
  status: 'dispatched' | 'failed';
  provider: 'controller-browser';
  browserSessionId: string;
  conversationUrl?: string;
  conversationId?: string;
  localAlias?: string;
  resumedFromBinding: boolean;
  model: string;
  reasoning: ChatgptAutomationReasoning;
  tabPolicy: ChatgptAutomationTabPolicy;
  executionPreferenceVerified: boolean;
  error?: { code: string; message: string };
}

function requestId(workId: string, actionId: string): string {
  return `chatgpt-work:${workId}:${actionId}:${randomUUID()}`;
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
    args,
    timeoutMs,
    origin: { surface: 'schedule', actor: 'chatgpt-work-continuation' },
  });
}

async function ensureControllerChatgptBrowser(controllerHome: string, workId: string): Promise<void> {
  const repository = controllerPluginRepository(controllerHome);
  const repoRoot = repository.canonicalRoot ?? repository.localRoot;
  if (!repoRoot) throw new Error('CHATGPT_CONTROLLER_BROWSER_ROOT_UNAVAILABLE');
  const existing = readBrowserPluginConfiguration(repoRoot);
  await controllerBrowserAction(controllerHome, workId, 'configure', {
    enabled: true,
    ...(!existing.enabled ? {
      browser_mode: 'attach_preferred',
      profile_mode: 'repo_local',
      browser_channel: 'chromium',
      cdp_attach_fallback: 'fail_closed',
      native_attach_mode: 'auto',
      native_browser_candidates: ['chrome'],
    } : {}),
  });
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

export function stableChatgptAutomationBrowserSessionId(repoId: string, automationId: string): string {
  const digest = createHash('sha256').update(`${repoId}\nautomation\n${automationId}`).digest('hex').slice(0, 20);
  return `forge-chatgpt-automation-${digest}`;
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

function modelLabelMatches(label: string | undefined, model: string): boolean {
  if (model !== DEFAULT_CHATGPT_AUTOMATION_MODEL || !label) return false;
  const normalized = label.toLowerCase().replace(/\s+/g, '');
  return normalized.includes('5.6sol') || normalized.includes('gpt-5.6sol');
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
  const result = await controllerBrowserAction(controllerHome, workId, 'query_all', {
    session_id: browserSessionId,
    selector: CHATGPT_INTELLIGENCE_CONTROL_SELECTOR,
    limit: 50,
    timeout_ms: timeoutMs ?? 60_000,
  }, timeoutMs);
  return queryMatches(result).find((match) => /(?:gpt-)?5\.6\s*sol/i.test(matchText(match)));
}

async function waitForChatgptIntelligenceControl(
  controllerHome: string,
  workId: string,
  browserSessionId: string,
  timeoutMs?: number,
): Promise<BrowserQueryMatch | undefined> {
  const waitBudgetMs = Math.min(Math.max(timeoutMs ?? 12_000, 1_000), 12_000);
  const deadline = Date.now() + waitBudgetMs;
  do {
    const control = await findChatgptIntelligenceControl(controllerHome, workId, browserSessionId, Math.min(waitBudgetMs, 5_000));
    if (control) return control;
    if (Date.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  } while (Date.now() < deadline);
  return undefined;
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
  if (!control) throw new Error('CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE');
  if (!modelLabelMatches(matchText(control), model)) throw new Error(`CHATGPT_AUTOMATION_MODEL_NOT_VERIFIED:${model}`);
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
  if (!modelLabelMatches(matchText(control), model)) throw new Error(`CHATGPT_AUTOMATION_MODEL_NOT_VERIFIED:${model}`);
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

export function withForgePluginMention(prompt: string): string {
  const value = prompt.trim();
  if (!value) throw new Error('CHATGPT_AUTOMATION_PROMPT_REQUIRED');
  if (/^@forge(?:\s|$)/i.test(value)) return value;
  return `${DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION} ${value}`;
}

export async function runScheduledChatgptPrompt(input: ScheduledChatgptPromptInput): Promise<ScheduledChatgptPromptResult> {
  const model = normalizeModel(input.model);
  const reasoning = normalizeReasoning(input.reasoning);
  const tabPolicy = normalizeTabPolicy(input.tabPolicy);
  const stableSessionId = stableChatgptAutomationBrowserSessionId(input.repoId, input.automationId);
  const explicitSessionId = input.browserSessionId?.trim();
  const sessionId = tabPolicy === 'new'
    ? `${stableSessionId}-${randomUUID().slice(0, 8)}`
    : explicitSessionId || stableSessionId;
  const targetUrl = tabPolicy === 'new'
    ? 'https://chatgpt.com/'
    : input.conversationUrl?.trim() || 'https://chatgpt.com/';
  let reusedSession = false;
  try {
    await ensureControllerChatgptBrowser(input.controllerHome, input.automationId);
    if (tabPolicy !== 'new') {
      try {
        await controllerBrowserAction(input.controllerHome, input.automationId, 'get_text', {
          session_id: sessionId,
          selector: 'body',
          max_chars: 1,
          timeout_ms: Math.min(input.timeoutMs ?? 60_000, 3_000),
        }, input.timeoutMs);
        reusedSession = true;
      } catch {
        reusedSession = false;
      }
    }
    if (!reusedSession) {
      await controllerBrowserAction(input.controllerHome, input.automationId, 'open_page', {
        session_id: sessionId,
        url: targetUrl,
        wait_until: 'domcontentloaded',
        timeout_ms: input.timeoutMs ?? 60_000,
        retries: 1,
      }, input.timeoutMs);
    }
    const executionPreferenceVerified = await ensureChatgptExecutionPreference(
      input.controllerHome,
      input.automationId,
      sessionId,
      model,
      reasoning,
      input.timeoutMs,
    );
    await controllerBrowserAction(input.controllerHome, input.automationId, 'fill', {
      session_id: sessionId,
      selector: CHATGPT_PROMPT_SELECTOR,
      text: withForgePluginMention(input.prompt),
      timeout_ms: input.timeoutMs ?? 60_000,
      post_action_wait_ms: 100,
    }, input.timeoutMs);
    const sent = await controllerBrowserAction(input.controllerHome, input.automationId, 'press', {
      session_id: sessionId,
      selector: CHATGPT_PROMPT_SELECTOR,
      key: CHATGPT_SEND_KEY,
      timeout_ms: input.timeoutMs ?? 60_000,
      post_action_wait_ms: 1_500,
    }, input.timeoutMs);
    return {
      status: 'dispatched',
      provider: 'controller-browser',
      browserSessionId: sessionId,
      conversationUrl: resultUrl(sent),
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified,
      reusedSession,
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'controller-browser',
      browserSessionId: sessionId,
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: false,
      reusedSession,
      error: {
        code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : 'CHATGPT_SCHEDULED_PROMPT_FAILED',
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
    if (seedUrl && !binding) {
      binding = bindChatgptWorkConversation(store, {
        workId: input.workId,
        conversationUrl: seedUrl,
        latestBrowserSessionId: sessionId,
        localAlias: input.title,
      });
    }
    const targetUrl = binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/';
    await controllerBrowserAction(input.controllerHome, input.workId, 'navigate', {
      session_id: sessionId,
      url: targetUrl,
      wait_until: 'domcontentloaded',
      timeout_ms: input.timeoutMs ?? 60_000,
      retries: 1,
    }, input.timeoutMs);
    const executionPreferenceVerified = await ensureChatgptExecutionPreference(
      input.controllerHome,
      input.workId,
      sessionId,
      model,
      reasoning,
      input.timeoutMs,
    );
    await controllerBrowserAction(input.controllerHome, input.workId, 'fill', {
      session_id: sessionId,
      selector: CHATGPT_PROMPT_SELECTOR,
      text: withForgePluginMention(input.prompt),
      timeout_ms: input.timeoutMs ?? 60_000,
      post_action_wait_ms: 100,
    }, input.timeoutMs);
    const sent = await controllerBrowserAction(input.controllerHome, input.workId, 'press', {
      session_id: sessionId,
      selector: CHATGPT_PROMPT_SELECTOR,
      key: CHATGPT_SEND_KEY,
      timeout_ms: input.timeoutMs ?? 60_000,
      post_action_wait_ms: 1_500,
    }, input.timeoutMs);
    const observedUrl = resultUrl(sent) ?? targetUrl;
    if (/\/c\/[^/?#]+/.test(observedUrl)) {
      binding = bindChatgptWorkConversation(store, {
        workId: input.workId,
        conversationUrl: observedUrl,
        latestBrowserSessionId: sessionId,
        localAlias: binding?.localAlias ?? input.title,
      });
    }
    return {
      status: 'dispatched',
      provider: 'controller-browser',
      browserSessionId: sessionId,
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
