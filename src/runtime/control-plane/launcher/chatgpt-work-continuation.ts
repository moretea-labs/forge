import { createHash, randomUUID } from 'crypto';
import { isWslWindowsRuntime } from '../../../cli/chatgpt-browser/bridge-provider';
import { createChatgptBrowserDeliveryHost } from '../../../../adapters/chatgpt/browser-delivery-host';
import { createChatgptWslBridgeDeliveryHost } from '../../../../adapters/chatgpt/wsl-bridge-delivery-host';
import {
  CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN,
  DEFAULT_CHATGPT_AUTOMATION_MODEL,
  DEFAULT_CHATGPT_AUTOMATION_REASONING,
  DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY,
  dispatchWithChatgptProviderBackpressure,
  type ChatgptAutomationReasoning,
  type ChatgptAutomationTabCleanupStatus,
  type ChatgptAutomationTabPolicy,
  type ChatgptProviderDeliveryHost,
  type ChatgptProviderDeliveryStatus,
} from '../../../../adapters/chatgpt/provider-delivery';
import {
  closeChatgptAutomationTabAfterDispatch,
  ensureChatgptExecutionPreference,
  ensureControllerChatgptBrowser,
  navigateWorkConversation,
  submitChatgptPrompt,
  withChatgptBrowserActionOrigin,
} from '../../../../adapters/chatgpt/browser-delivery-runtime';

export {
  CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN,
  DEFAULT_CHATGPT_AUTOMATION_MODEL,
  DEFAULT_CHATGPT_AUTOMATION_REASONING,
  DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY,
  type ChatgptAutomationReasoning,
  type ChatgptAutomationTabCleanupStatus,
  type ChatgptAutomationTabPolicy,
  type ChatgptProviderDeliveryStatus,
} from '../../../../adapters/chatgpt/provider-delivery';
export {
  chatgptAutomationControlQueryLimit,
  chatgptAutomationControlWaitBudgets,
  chatgptAutomationNavigationRequiresReplacement,
  chatgptAutomationPageFailure,
  chatgptAutomationReasoningLevelFromLabel,
  chatgptBrowserActionArgs,
  chatgptBrowserActionResult,
  chatgptOutboundMessageMatchesPrompt,
  isChatgptConversationUrl,
  reconciledNewChatgptOpenPageSessionId,
  settleWorkChatgptAutomationTab,
} from '../../../../adapters/chatgpt/browser-delivery-runtime';

export const DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge';

export interface WorkChatgptContinuationDependencies {
  bridgeRuntime?: boolean;
  browserHost?: ChatgptProviderDeliveryHost;
  wslHost?: ChatgptProviderDeliveryHost;
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
  authorizationGrantRefs?: string[];
  /** Typed provider delivery disposition. Present when provider dispatch was attempted; callers must not infer this from error strings. */
  providerDeliveryStatus?: ChatgptProviderDeliveryStatus;
  tabCleanupStatus?: ChatgptAutomationTabCleanupStatus;
  tabCleanupError?: { code: string; message: string };
  error?: { code: string; message: string };
}

export interface StandaloneChatgptPromptInput {
  controllerHome: string;
  repoId: string;
  /** Optional transport context only; current browser/bridge hosts do not derive semantic authority from this path. */
  repoRoot?: string;
  scopeId: string;
  prompt: string;
  browserSessionId?: string;
  conversationUrl?: string;
  model?: string;
  reasoning?: ChatgptAutomationReasoning;
  tabPolicy?: ChatgptAutomationTabPolicy;
  timeoutMs?: number;
  /** Explicit Browser grant refs already authorized by the owning durable workflow/controller binding. */
  authorizationGrantRefs?: readonly string[];
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

function resolveChatgptProviderDeliveryHost(
  dependencies: WorkChatgptContinuationDependencies = {},
): { bridgeRuntime: boolean; host: ChatgptProviderDeliveryHost } {
  const bridgeRuntime = dependencies.bridgeRuntime ?? isWslWindowsRuntime();
  const host = bridgeRuntime
    ? dependencies.wslHost ?? createChatgptWslBridgeDeliveryHost()
    : dependencies.browserHost ?? createChatgptBrowserDeliveryHost({
        ensureBrowser: ensureControllerChatgptBrowser,
        navigate: navigateWorkConversation,
        ensureExecutionPreference: ensureChatgptExecutionPreference,
        submitPrompt: submitChatgptPrompt,
      });
  return { bridgeRuntime, host };
}

export function stableChatgptWorkBridgeSessionId(_repoId: string, workId: string): string {
  const digest = createHash('sha256').update(`bridge\n${workId}`).digest('hex').slice(0, 20);
  return `forge-chatgpt-bridge-${digest}`;
}

export function stableStandaloneChatgptBrowserSessionId(_repoId: string, scopeId: string): string {
  const digest = createHash('sha256').update(`standalone\n${scopeId}`).digest('hex').slice(0, 20);
  return `forge-chatgpt-standalone-${digest}`;
}

function resolveStandaloneChatgptBrowserSessionId(input: StandaloneChatgptPromptInput): string {
  const policy = normalizeTabPolicy(input.tabPolicy);
  const stable = stableStandaloneChatgptBrowserSessionId(input.repoId, input.scopeId);
  if (policy === 'new') return `${stable}-${randomUUID().slice(0, 8)}`;
  return input.browserSessionId?.trim() || stable;
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
export async function runStandaloneChatgptPrompt(
  input: StandaloneChatgptPromptInput,
  dependencies: WorkChatgptContinuationDependencies = {},
): Promise<WorkChatgptContinuationResult> {
  const model = normalizeModel(input.model);
  const reasoning = normalizeReasoning(input.reasoning);
  const tabPolicy = normalizeTabPolicy(input.tabPolicy);
  const browserScopeId = `standalone:${input.scopeId}`;
  const seedUrl = input.conversationUrl?.trim();
  const { bridgeRuntime, host } = resolveChatgptProviderDeliveryHost(dependencies);
  const sessionId = bridgeRuntime
    ? stableChatgptWorkBridgeSessionId(input.repoId, browserScopeId)
    : resolveStandaloneChatgptBrowserSessionId(input);
  const targetUrl = seedUrl ?? 'https://chatgpt.com/';
  const authorizationGrantRefs = new Set(
    (input.authorizationGrantRefs ?? []).map((ref) => ref.trim()).filter(Boolean),
  );

  try {
    const delivery = await withChatgptBrowserActionOrigin(
      { surface: 'chatgpt-action', actor: 'chatgpt-standalone-prompt' },
      () => dispatchWithChatgptProviderBackpressure(input.controllerHome, () => host.dispatch({
        controllerHome: input.controllerHome,
        repoId: input.repoId,
        repoRoot: input.repoRoot ?? process.cwd(),
        workId: browserScopeId,
        prompt: input.prompt,
        browserSessionId: sessionId,
        targetUrl,
        model,
        reasoning,
        timeoutMs: input.timeoutMs,
      })),
      authorizationGrantRefs,
    );
    if (delivery.status !== 'dispatch_confirmed') {
      return {
        status: 'failed',
        provider: delivery.provider,
        browserSessionId: delivery.browserSessionId,
        conversationUrl: delivery.conversationUrl ?? seedUrl,
        resumedFromBinding: false,
        model,
        reasoning,
        tabPolicy,
        executionPreferenceVerified: delivery.executionPreferenceVerified,
        authorizationGrantRefs: [...authorizationGrantRefs],
        providerDeliveryStatus: delivery.status,
        error: delivery.error ?? { code: `CHATGPT_PROVIDER_${delivery.status.toUpperCase()}`, message: delivery.status },
      };
    }
    const tabCleanup = delivery.provider === 'controller-browser'
      ? await closeChatgptAutomationTabAfterDispatch(
          input.controllerHome,
          browserScopeId,
          delivery.browserSessionId,
          input.timeoutMs,
        )
      : undefined;
    return {
      status: 'dispatched',
      provider: delivery.provider,
      browserSessionId: delivery.browserSessionId,
      conversationUrl: delivery.conversationUrl ?? targetUrl,
      resumedFromBinding: false,
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: delivery.executionPreferenceVerified,
      providerDeliveryStatus: delivery.status,
      ...(tabCleanup ? { tabCleanupStatus: tabCleanup.status } : {}),
      ...(tabCleanup?.error ? { tabCleanupError: tabCleanup.error } : {}),
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: bridgeRuntime ? 'chatgpt-bridge' : 'controller-browser',
      browserSessionId: sessionId,
      conversationUrl: seedUrl,
      resumedFromBinding: false,
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: false,
      authorizationGrantRefs: [...authorizationGrantRefs],
      error: {
        code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : bridgeRuntime ? 'CHATGPT_BRIDGE_DISPATCH_FAILED' : 'CHATGPT_CONTROLLER_BROWSER_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
