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
  type ChatgptProviderDeliveryHost,
  type ChatgptProviderDeliveryStatus,
} from '../../../../adapters/chatgpt/provider-delivery';
import {
  closeChatgptAutomationTabAfterDispatch,
  ensureChatgptExecutionPreference,
  ensureControllerChatgptBrowser,
  navigateWorkConversation,
  settleWorkChatgptAutomationTab,
  submitChatgptPrompt,
  withChatgptBrowserActionOrigin,
} from '../../../../adapters/chatgpt/browser-delivery-runtime';
import { getWorkContract } from '../../../../packages/kernel/work/api/index';
import { readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import { ensureWorkflowSupervisorEnrollmentForWork } from '../../root/workflow-supervisor-composition';
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

const LEGACY_CONTROLLER_CHATGPT_SESSION_ID = 'forge-chatgpt-supercontroller';
export const DEFAULT_CHATGPT_AUTOMATION_PLUGIN_MENTION = '@forge';

export class ChatgptExecutionPlacementError extends Error {
  readonly code = 'CHATGPT_EXECUTION_PLACEMENT_MISMATCH';
  readonly targetForgeInstanceId: string;
  readonly currentForgeInstanceId?: string;

  constructor(targetForgeInstanceId: string, currentForgeInstanceId?: string) {
    super(`CHATGPT_EXECUTION_PLACEMENT_MISMATCH: target=${targetForgeInstanceId} current=${currentForgeInstanceId ?? 'unavailable'}`);
    this.name = 'ChatgptExecutionPlacementError';
    this.targetForgeInstanceId = targetForgeInstanceId;
    this.currentForgeInstanceId = currentForgeInstanceId;
  }
}


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
  /** Transport-only conversation policy. `fresh` starts a new ChatGPT conversation while preserving the same durable Work/ControllerRound authority. */
  transportConversation?: 'bound' | 'fresh';
  timeoutMs?: number;
  /** Authorization provenance for Browser actions. Immediate/source launches default to chatgpt-action; Scheduler resume must pass schedule. */
  originSurface?: 'chatgpt-action' | 'schedule';
  /** Explicit controller-scoped Browser grant refs already authorized for this Work transport. */
  authorizationGrantRefs?: readonly string[];
}

export interface WorkChatgptContinuationDependencies {
  bridgeRuntime?: boolean;
  browserHost?: ChatgptProviderDeliveryHost;
  wslHost?: ChatgptProviderDeliveryHost;
  /** Test seam plus one canonical resource-settlement owner for known Browser delivery failures. */
  settleBrowserTab?: typeof settleWorkChatgptAutomationTab;
  /** Test seam for the outer-turn owner. Bound continuation must enroll here instead of re-entering Browser delivery. */
  enrollWorkflowSupervisor?: typeof ensureWorkflowSupervisorEnrollmentForWork;
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

function workflowToolAttributionInstruction(input: WorkChatgptContinuationInput): string {
  const workId = input.workId;
  const relayScopeId = input.relayScopeId?.trim();
  const requirementScoped = relayScopeId?.startsWith('requirement:') === true;
  const repositoryAttribution = requirementScoped
    ? `源码写操作应归属本轮语义上实际推进的 repository-change Work；如果仍在推进 origin Work，则传 work_id=${workId}。不要把只读/编排 Work 用作源码修改归属。`
    : `如果源码写操作需要 durable Work 归属，则使用 work_id=${workId}。`;
  return `Forge continuation context：继续精确 Work ${workId} 的原始目标，不重复已完成工作。Forge 内部维护 provider/session binding、transport recovery、effect dedupe 和机械重试；这些机械状态不属于模型工作流。验证与 review 由模型使用正常 capability/evidence 完成，不是 Forge 生命周期阶段；只有 durable 语义实际变化时才更新 Work/Plan/Requirement。${repositoryAttribution}`;
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

const DEFAULT_CHATGPT_CONTROLLER_REASONING: ChatgptAutomationReasoning = 'xhigh';

function normalizeControllerReasoning(value?: ChatgptAutomationReasoning): ChatgptAutomationReasoning {
  return value ?? DEFAULT_CHATGPT_CONTROLLER_REASONING;
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
      () => host.dispatch({
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
      }),
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

/**
 * Dispatches a bounded resume prompt to one controller-owned ChatGPT Web tab.
 * Chat history is transport context only. Forge Work/Plan/evidence remain authoritative.
 */
export async function runWorkChatgptContinuation(
  input: WorkChatgptContinuationInput,
  dependencies: WorkChatgptContinuationDependencies = {},
): Promise<WorkChatgptContinuationResult> {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const existing = getChatgptWorkConversationBinding(store, input.workId);
  const authorizationGrantRefs = new Set(
    [...(existing?.authorizationGrantRefs ?? []), ...(input.authorizationGrantRefs ?? [])]
      .map((ref) => ref.trim())
      .filter(Boolean),
  );
  const transportConversation = input.transportConversation ?? 'bound';
  const seedUrl = transportConversation === 'fresh' ? undefined : input.conversationUrl?.trim() || existing?.conversationUrl;
  const model = normalizeModel(input.model);
  const reasoning = normalizeControllerReasoning(input.reasoning);
  const tabPolicy = transportConversation === 'fresh' ? 'new' : normalizeTabPolicy(input.tabPolicy);
  const bridgeRuntime = dependencies.bridgeRuntime ?? isWslWindowsRuntime();
  const authorityInputError = controllerRoundAuthorityInputError(input);
  if (authorityInputError) {
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
      authorizationGrantRefs: [...authorizationGrantRefs],
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
  const deliverySessionId = bridgeRuntime
    ? stableChatgptWorkBridgeSessionId(input.repoId, input.workId)
    : sessionId;

  try {
    const work = getWorkContract(store, input.workId);
    if (!work || work.repoId !== input.repoId) {
      throw new Error(`CHATGPT_WORK_CONTRACT_NOT_FOUND: ${input.repoId}:${input.workId}`);
    }
    const targetForgeInstanceId = work.executionPlacement?.forgeInstanceId?.trim();
    if (targetForgeInstanceId) {
      const currentForgeInstanceId = readForgeInstanceIdentity(input.controllerHome)?.instanceId?.trim();
      if (currentForgeInstanceId !== targetForgeInstanceId) {
        throw new ChatgptExecutionPlacementError(targetForgeInstanceId, currentForgeInstanceId);
      }
    }
    if (existing && transportConversation !== 'fresh') {
      const enrollment = await (dependencies.enrollWorkflowSupervisor ?? ensureWorkflowSupervisorEnrollmentForWork)(store, input.workId);
      if (enrollment.status !== 'enrolled') {
        return {
          status: 'failed',
          provider: bridgeRuntime ? 'chatgpt-bridge' : 'controller-browser',
          browserSessionId: deliverySessionId,
          conversationUrl: existing.conversationUrl,
          conversationId: existing.conversationId,
          localAlias: existing.localAlias,
          resumedFromBinding: true,
          model,
          reasoning,
          tabPolicy,
          executionPreferenceVerified: false,
          authorizationGrantRefs: [...authorizationGrantRefs],
          error: {
            code: `WORKFLOW_SUPERVISOR_${enrollment.status.toUpperCase()}`,
            message: enrollment.reason ?? `Workflow Supervisor enrollment did not accept bound continuation: ${enrollment.status}`,
          },
        };
      }
      return {
        status: 'dispatched',
        provider: bridgeRuntime ? 'chatgpt-bridge' : 'controller-browser',
        browserSessionId: deliverySessionId,
        conversationUrl: existing.conversationUrl,
        conversationId: existing.conversationId,
        localAlias: existing.localAlias,
        resumedFromBinding: true,
        model,
        reasoning,
        tabPolicy,
        executionPreferenceVerified: false,
        authorizationGrantRefs: [...authorizationGrantRefs],
      };
    }
    const { host } = resolveChatgptProviderDeliveryHost(dependencies);
    if (!bridgeRuntime && seedUrl && !binding && hasChatgptConversationIdentity(seedUrl)) {
      binding = bindChatgptWorkConversation(store, {
        workId: input.workId,
        conversationUrl: seedUrl,
        latestBrowserSessionId: deliverySessionId,
        authorizationGrantRefs: [...authorizationGrantRefs],
        localAlias: input.title,
      });
    }
    const targetUrl = transportConversation === 'fresh' ? 'https://chatgpt.com/' : binding?.conversationUrl ?? seedUrl ?? 'https://chatgpt.com/';
    const renderedPrompt = `${workflowToolAttributionInstruction(input)}\n\n${input.prompt}`;
    const delivery = await withChatgptBrowserActionOrigin(
      { surface: input.originSurface ?? 'chatgpt-action', actor: 'chatgpt-work-continuation' },
      () => host.dispatch({
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
      }),
      authorizationGrantRefs,
    );
    const observedUrl = delivery.conversationUrl ?? targetUrl;
    const mayPersistObservedConversation = delivery.status === 'dispatch_confirmed' || delivery.status === 'outcome_unknown';
    if (mayPersistObservedConversation && /\/c\/[^/?#]+/.test(observedUrl)) {
      const observedIdentity = parseChatgptConversationIdentity(observedUrl);
      binding = binding && binding.conversationId !== observedIdentity.conversationId
        ? rebindChatgptWorkConversation(store, {
            workId: input.workId,
            previousConversationId: binding.conversationId,
            conversationUrl: observedUrl,
            latestBrowserSessionId: delivery.browserSessionId,
            authorizationGrantRefs: [...authorizationGrantRefs],
            localAlias: binding.localAlias ?? input.title,
          })
        : bindChatgptWorkConversation(store, {
            workId: input.workId,
            conversationUrl: observedUrl,
            latestBrowserSessionId: delivery.browserSessionId,
            authorizationGrantRefs: [...authorizationGrantRefs],
            localAlias: binding?.localAlias ?? input.title,
          });
    }
    if (binding && (delivery.status === 'dispatch_confirmed' || delivery.status === 'outcome_unknown')) {
      // Exact conversation identity is enough to hand observation to the canonical
      // Supervisor. outcome_unknown stays ambiguous: Supervisor observes the same
      // turn and never authorizes replay of the possibly committed provider send.
      try { await (dependencies.enrollWorkflowSupervisor ?? ensureWorkflowSupervisorEnrollmentForWork)(store, input.workId); } catch {}
    }
    if (delivery.status !== 'dispatch_confirmed') {
      // Only a proven provider failure is safe to settle immediately. An
      // outcome-unknown send remains fenced for exact ControllerRound claim
      // reconciliation, and wait-for-user retains the page for the explicit
      // provider action. This keeps semantic ambiguity separate from ephemeral
      // Browser resource ownership without replaying a possibly committed send.
      const tabCleanup = delivery.provider === 'controller-browser' && delivery.status === 'failed'
        ? await (dependencies.settleBrowserTab ?? settleWorkChatgptAutomationTab)({
            controllerHome: input.controllerHome,
            workId: input.workId,
            browserSessionId: delivery.browserSessionId,
            timeoutMs: input.timeoutMs,
            authorizationGrantRefs: [...authorizationGrantRefs],
          })
        : undefined;
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
        authorizationGrantRefs: [...authorizationGrantRefs],
        providerDeliveryStatus: delivery.status,
        ...(tabCleanup ? { tabCleanupStatus: tabCleanup.status } : {}),
        ...(tabCleanup?.error ? { tabCleanupError: tabCleanup.error } : {}),
        error: delivery.error ?? { code: `CHATGPT_PROVIDER_${delivery.status.toUpperCase()}`, message: delivery.status },
      };
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
      authorizationGrantRefs: [...authorizationGrantRefs],
      providerDeliveryStatus: delivery.status,
    };
  } catch (error) {
    const provider = bridgeRuntime ? 'chatgpt-bridge' : 'controller-browser';
    const fallbackSessionId = bridgeRuntime ? deliverySessionId : sessionId;
    // A provider exception may occur after create_session/navigation already
    // materialized an exact Forge-owned Browser resource. Settle that exact
    // session here rather than waiting for a later relay blocker projection.
    // Browser ownership authority still preserves user-owned tabs.
    const tabCleanup = provider === 'controller-browser'
      ? await (dependencies.settleBrowserTab ?? settleWorkChatgptAutomationTab)({
          controllerHome: input.controllerHome,
          workId: input.workId,
          browserSessionId: fallbackSessionId,
          timeoutMs: input.timeoutMs,
          authorizationGrantRefs: [...authorizationGrantRefs],
        })
      : undefined;
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
      authorizationGrantRefs: [...authorizationGrantRefs],
      ...(tabCleanup ? { tabCleanupStatus: tabCleanup.status } : {}),
      ...(tabCleanup?.error ? { tabCleanupError: tabCleanup.error } : {}),
      error: {
        code: error instanceof ChatgptExecutionPlacementError
          ? error.code
          : error instanceof Error && error.message.includes(':')
            ? error.message.split(':', 1)[0]
            : bridgeRuntime ? 'CHATGPT_BRIDGE_DISPATCH_FAILED' : 'CHATGPT_CONTROLLER_BROWSER_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
