import { createHash, randomUUID } from 'crypto';
import { isWslWindowsRuntime } from '../../../cli/chatgpt-browser/bridge-provider';
import { createChatgptBrowserDeliveryHost } from '../../../../adapters/chatgpt/browser-delivery-host';
import { createChatgptWslBridgeDeliveryHost } from '../../../../adapters/chatgpt/wsl-bridge-delivery-host';
import {
  CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN,
  DEFAULT_CHATGPT_AUTOMATION_MODEL,
  DEFAULT_CHATGPT_AUTOMATION_REASONING,
  DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY,
  type ChatgptAutomationReasoning,
  type ChatgptAutomationTabCleanupStatus,
  type ChatgptAutomationTabPolicy,
} from '../../../../adapters/chatgpt/provider-delivery';
import {
  closeChatgptAutomationTabAfterDispatch,
  ensureChatgptExecutionPreference,
  ensureControllerChatgptBrowser,
  navigateWorkConversation,
  submitChatgptPrompt,
} from '../../../../adapters/chatgpt/browser-delivery-runtime';
import { getWorkContract } from '../../../../packages/kernel/work/api/index';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
  hasChatgptConversationIdentity,
  parseChatgptConversationIdentity,
  rebindChatgptWorkConversation,
  type ChatgptWorkConversationBinding,
} from '../../../../adapters/chatgpt/work-conversation-binding-store';

export {
  CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN,
  DEFAULT_CHATGPT_AUTOMATION_MODEL,
  DEFAULT_CHATGPT_AUTOMATION_REASONING,
  DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY,
  type ChatgptAutomationReasoning,
  type ChatgptAutomationTabCleanupStatus,
  type ChatgptAutomationTabPolicy,
} from '../../../../adapters/chatgpt/provider-delivery';
export {
  chatgptAutomationControlQueryLimit,
  chatgptAutomationControlWaitBudgets,
  chatgptAutomationNavigationRequiresReplacement,
  chatgptAutomationPageFailure,
  chatgptAutomationReasoningLevelFromLabel,
  chatgptBrowserActionArgs,
  chatgptOutboundMessageMatchesPrompt,
  isChatgptConversationUrl,
  reconciledNewChatgptOpenPageSessionId,
  settleWorkChatgptAutomationTab,
} from '../../../../adapters/chatgpt/browser-delivery-runtime';

const LEGACY_CONTROLLER_CHATGPT_SESSION_ID = 'forge-chatgpt-supercontroller';
export const DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge';


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
    return `Forge Workflow 执行契约：精确 Work ${workId}。本次启动的 controller round 已具备 durable controller authority：controller_authority_id=${authorityId}，relay_scope_id=${relayScopeId}。第一次 controller_claim 必须使用这组完全相同的 authority；不得先调用不带 scope 的 controller_claim，也不得等待 claim 响应后再生成另一份 authority。如果当前 client 暴露 controller_authority_id 与 relay_scope_id，controller_claim 时必须同时传入。如果当前 frozen client schema 缺少任一字段，调用 rh_work operation=repair, work_id=${workId}, capability_id=controller.round:controller_claim:${authorityId}:${relayScopeId}；Forge 会把它映射到同一个 fenced claim。claim 成功后，data.controllerAuthorityId 必须等于 ${authorityId}；continue、verify、finalize、stop、controller_release 必须原样沿用同一 durable authority，必要时使用对应 compatibility capability。绝不能把 data.session.sessionId 当作 durable capability，因为 MCP execution session 可能轮换。本轮每一次 repository_command_execute 和 repository_safe_patch_apply 都必须显式传 work_id=${workId}，不得省略。`;
  }
  return `Forge Workflow 执行契约：首先 claim 精确 Work ${workId}。从成功的 controller_claim 响应中取得 data.controllerAuthorityId；此后该 Work 的每一次 rh_work lifecycle 调用（continue、verify、finalize、stop、controller_release）都必须把它原样作为 controller_authority_id 传入。如果当前 frozen client schema 不暴露 controller_authority_id，则把同一个 opaque value 作为 session_id compatibility carrier。绝不能把 data.session.sessionId 当作 durable capability，因为 MCP execution session 可能在工具调用之间被替换或失效。本轮每一次 repository_command_execute 和 repository_safe_patch_apply 都必须显式传 work_id=${workId}，不得省略。`;
}

function controllerRoundAuthorityInputError(input: WorkChatgptContinuationInput): Error | undefined {
  const hasAuthority = Boolean(input.controllerAuthorityId?.trim());
  const hasRelayScope = Boolean(input.relayScopeId?.trim());
  if (hasAuthority === hasRelayScope) return undefined;
  return new Error('CHATGPT_CONTROLLER_ROUND_AUTHORITY_INCOMPLETE: controllerAuthorityId and relayScopeId must be supplied together');
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

  const sessionId = resolveChatgptWorkBrowserSessionId({
    repoId: input.repoId,
    workId: input.workId,
    tabPolicy,
    explicitSessionId: input.browserSessionId,
    boundSessionId: existing?.latestBrowserSessionId,
  });
  let binding: ChatgptWorkConversationBinding | undefined = existing;
  const bridgeRuntime = isWslWindowsRuntime();
  const deliverySessionId = bridgeRuntime
    ? stableChatgptWorkBridgeSessionId(input.repoId, input.workId)
    : sessionId;

  try {
    const work = getWorkContract(store, input.workId);
    if (!work || work.repoId !== input.repoId) {
      throw new Error(`CHATGPT_WORK_CONTRACT_NOT_FOUND: ${input.repoId}:${input.workId}`);
    }
    if (!bridgeRuntime && seedUrl && !binding && hasChatgptConversationIdentity(seedUrl)) {
      binding = bindChatgptWorkConversation(store, {
        workId: input.workId,
        conversationUrl: seedUrl,
        latestBrowserSessionId: deliverySessionId,
        localAlias: input.title,
      });
    }
    const targetUrl = binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/';
    const renderedPrompt = `${workflowToolAttributionInstruction(input)}\n\n${input.prompt}`;
    const host = bridgeRuntime
      ? createChatgptWslBridgeDeliveryHost()
      : createChatgptBrowserDeliveryHost({
          ensureBrowser: ensureControllerChatgptBrowser,
          navigate: navigateWorkConversation,
          ensureExecutionPreference: ensureChatgptExecutionPreference,
          submitPrompt: submitChatgptPrompt,
        });
    const delivery = await host.dispatch({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      repoRoot: input.repoRoot,
      workId: input.workId,
      prompt: renderedPrompt,
      browserSessionId: deliverySessionId,
      targetUrl,
      model,
      reasoning,
      timeoutMs: input.timeoutMs,
    });
    if (delivery.status !== 'dispatch_confirmed') {
      return {
        status: 'failed',
        provider: delivery.provider,
        browserSessionId: delivery.browserSessionId,
        conversationUrl: binding?.conversationUrl ?? delivery.conversationUrl ?? seedUrl,
        conversationId: binding?.conversationId,
        localAlias: binding?.localAlias,
        resumedFromBinding: Boolean(existing),
        model,
        reasoning,
        tabPolicy,
        executionPreferenceVerified: delivery.executionPreferenceVerified,
        error: delivery.error ?? { code: `CHATGPT_PROVIDER_${delivery.status.toUpperCase()}`, message: delivery.status },
      };
    }
    const observedUrl = delivery.conversationUrl ?? targetUrl;
    if (/\/c\/[^/?#]+/.test(observedUrl)) {
      const observedIdentity = parseChatgptConversationIdentity(observedUrl);
      binding = binding && binding.conversationId !== observedIdentity.conversationId
        ? rebindChatgptWorkConversation(store, {
            workId: input.workId,
            previousConversationId: binding.conversationId,
            conversationUrl: observedUrl,
            latestBrowserSessionId: delivery.browserSessionId,
            localAlias: binding.localAlias ?? input.title,
          })
        : bindChatgptWorkConversation(store, {
            workId: input.workId,
            conversationUrl: observedUrl,
            latestBrowserSessionId: delivery.browserSessionId,
            localAlias: binding?.localAlias ?? input.title,
          });
    }
    return {
      status: 'dispatched',
      provider: delivery.provider,
      browserSessionId: delivery.browserSessionId,
      conversationUrl: binding?.conversationUrl ?? observedUrl,
      conversationId: binding?.conversationId,
      localAlias: binding?.localAlias,
      resumedFromBinding: Boolean(existing),
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: delivery.executionPreferenceVerified,
    };
  } catch (error) {
    const provider = bridgeRuntime ? 'chatgpt-bridge' : 'controller-browser';
    const fallbackSessionId = bridgeRuntime ? deliverySessionId : sessionId;
    return {
      status: 'failed',
      provider,
      browserSessionId: fallbackSessionId,
      conversationUrl: binding?.conversationUrl ?? seedUrl,
      conversationId: binding?.conversationId,
      localAlias: binding?.localAlias,
      resumedFromBinding: Boolean(existing),
      model,
      reasoning,
      tabPolicy,
      executionPreferenceVerified: false,
      error: {
        code: error instanceof Error && error.message.includes(':') ? error.message.split(':', 1)[0] : bridgeRuntime ? 'CHATGPT_BRIDGE_DISPATCH_FAILED' : 'CHATGPT_CONTROLLER_BROWSER_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
