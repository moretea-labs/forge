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
const CHATGPT_PROMPT_SELECTOR = '[name="prompt-textarea"]';
const CHATGPT_SEND_KEY = 'Enter';
const CHATGPT_REASONING_TRIGGER_SELECTOR = 'button:has([data-animated-slider-trigger="true"])';
const CHATGPT_REASONING_LABEL_SELECTOR = '[data-animated-slider-trigger="true"]';

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

function reasoningLabelMatches(label: string | undefined, reasoning: ChatgptAutomationReasoning): boolean {
  const value = label?.replace(/\s+/g, '').toLowerCase();
  if (!value) return false;
  if (reasoning === 'high') return value === 'high' || value === '高';
  if (reasoning === 'medium') return value === 'medium' || value === '中';
  return value === 'xhigh' || value === 'extrahigh' || value === '超高';
}

function reasoningSelectors(reasoning: ChatgptAutomationReasoning): string[] {
  const labels = reasoning === 'high'
    ? ['High', '高']
    : reasoning === 'medium'
      ? ['Medium', '中']
      : ['Extra high', 'XHigh', '超高'];
  return labels.flatMap((label) => [
    `[role="menuitemradio"]:has-text("${label}")`,
    `[role="menuitem"]:has-text("${label}")`,
    `[role="option"]:has-text("${label}")`,
  ]);
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
  const current = await controllerBrowserAction(controllerHome, workId, 'get_text', {
    session_id: browserSessionId,
    selector: CHATGPT_REASONING_LABEL_SELECTOR,
    max_chars: 128,
    timeout_ms: timeoutMs ?? 60_000,
  }, timeoutMs).catch(() => undefined);
  if (reasoningLabelMatches(stringField(current?.text), reasoning)) return true;

  await controllerBrowserAction(controllerHome, workId, 'click', {
    session_id: browserSessionId,
    selector: CHATGPT_REASONING_TRIGGER_SELECTOR,
    timeout_ms: timeoutMs ?? 60_000,
    post_action_wait_ms: 250,
  }, timeoutMs);
  let selected = false;
  for (const selector of reasoningSelectors(reasoning)) {
    try {
      await controllerBrowserAction(controllerHome, workId, 'click', {
        session_id: browserSessionId,
        selector,
        timeout_ms: Math.min(timeoutMs ?? 60_000, 3_000),
        post_action_wait_ms: 250,
      }, timeoutMs);
      selected = true;
      break;
    } catch {
      // ChatGPT labels differ by locale. Continue through bounded known labels.
    }
  }
  if (!selected) throw new Error(`CHATGPT_AUTOMATION_REASONING_SELECTION_FAILED:${reasoning}`);
  const verified = await controllerBrowserAction(controllerHome, workId, 'get_text', {
    session_id: browserSessionId,
    selector: CHATGPT_REASONING_LABEL_SELECTOR,
    max_chars: 128,
    timeout_ms: timeoutMs ?? 60_000,
  }, timeoutMs).catch(() => undefined);
  if (!reasoningLabelMatches(stringField(verified?.text), reasoning)) {
    throw new Error(`CHATGPT_AUTOMATION_REASONING_NOT_VERIFIED:${reasoning}`);
  }
  return true;
}

function resultUrl(result: Record<string, unknown>): string | undefined {
  return stringField(result.url)
    ?? stringField((result.session as Record<string, unknown> | undefined)?.url);
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
      text: input.prompt,
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
