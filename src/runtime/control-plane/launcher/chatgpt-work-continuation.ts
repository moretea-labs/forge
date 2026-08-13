import { randomUUID } from 'crypto';
import { executeBrowserPluginAction, readBrowserPluginConfiguration } from '../../plugins/browser-adapter';
import { controllerPluginRepository } from '../../plugins/store';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  type ChatgptWorkConversationBinding,
} from './chatgpt-work-binding-store';

const CONTROLLER_CHATGPT_SESSION_ID = 'forge-chatgpt-supercontroller';
const CHATGPT_PROMPT_SELECTOR = '[name="prompt-textarea"]';
const CHATGPT_SEND_KEY = 'Enter';
const CHATGPT_ALLOWED_DOMAINS = ['chatgpt.com', 'www.chatgpt.com'];

export interface WorkChatgptContinuationInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  prompt: string;
  title?: string;
  browserSessionId?: string;
  conversationUrl?: string;
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
  const allowedDomains = [...new Set([...existing.allowedDomains, ...CHATGPT_ALLOWED_DOMAINS])];
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
    allowed_domains: allowedDomains,
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
  const sessionId = input.browserSessionId?.trim() || CONTROLLER_CHATGPT_SESSION_ID;
  let binding: ChatgptWorkConversationBinding | undefined = existing;

  try {
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
      error: {
        code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : 'CHATGPT_CONTROLLER_BROWSER_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
