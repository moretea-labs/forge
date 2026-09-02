import { createHash } from 'crypto';
import {
  getControllerRoundRelay,
  type ControllerBinding,
  type ControllerHost,
  type ControllerRoundContext,
} from '../../packages/kernel/controller/api/index';
import { runWorkChatgptContinuation } from '../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import { buildChatgptControllerRoundPrompt } from './controller-round-host';
import { getChatgptControllerBindingPayload } from './controller-binding-store';
import { getChatgptWorkConversationBinding } from './work-conversation-binding-store';
import { chatgptProviderDispatchReceiptId, classifyChatgptProviderFailure } from './provider-delivery';
import { createHandoffItem, getHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';


function providerUserActionHandoffId(repoId: string, workId: string, relayScopeId: string, authorityId: string): string {
  const digest = createHash('sha256').update(`${repoId}\n${workId}\n${relayScopeId}\n${authorityId}`).digest('hex').slice(0, 20);
  return `hnd-chatgpt-provider-auth-${digest}`;
}

function ensureChatgptProviderUserActionHandoff(
  options: { controllerHome: string; repoId: string },
  roundContext: ControllerRoundContext,
  code: string,
  message: string,
): string {
  const id = providerUserActionHandoffId(options.repoId, roundContext.workId, roundContext.relayScopeId, roundContext.authorityId);
  const existing = getHandoffItem(options, id);
  if (existing && existing.status === 'pending') return existing.id;
  if (existing) return existing.id;
  return createHandoffItem(options, {
    id,
    repoId: options.repoId,
    workId: roundContext.workId,
    title: 'ChatGPT provider authorization required',
    severity: 'needs_review',
    reason: message,
    creationReason: 'missing_authorization',
    summary: `Provider delivery is blocked until the user completes ChatGPT authentication or permission: ${code}`,
    currentState: {
      repoId: options.repoId,
      workId: roundContext.workId,
      statusSummary: 'ControllerRound is waiting for an explicit provider authentication/permission action.',
      blockedBy: [code],
      nextSafeAction: 'Complete the provider login/permission action, then resolve this Handoff to trigger a fresh continuation occurrence.',
    },
    evidenceRefs: [],
    blockingDecision: 'Complete the required ChatGPT login or permission action.',
    recommendedDecision: 'Complete provider authentication/permission and resume the same durable Work.',
    recommendedPrompt: `Resume exact Work ${roundContext.workId} after provider authentication is complete.`,
    suggestedNextActions: [],
  }).id;
}

export function createChatgptControllerHost(options: {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
}): ControllerHost {
  return {
    async resume(binding: ControllerBinding, roundContext: ControllerRoundContext) {
      if (binding.hostKind !== 'chatgpt') return { accepted: false, reason: `CONTROLLER_HOST_KIND_MISMATCH:${binding.hostKind}` };
      const payload = getChatgptControllerBindingPayload(options, binding.adapterRef);
      if (!payload || payload.bindingId !== binding.bindingId || payload.workId !== roundContext.workId) {
        return { accepted: false, reason: `CHATGPT_CONTROLLER_BINDING_NOT_FOUND:${binding.bindingId}` };
      }
      const relayStore = { controllerHome: options.controllerHome, repoId: options.repoId };
      const relay = getControllerRoundRelay(relayStore, roundContext.workId);
      if (!relay || relay.relayScopeId !== roundContext.relayScopeId || relay.authorityId !== roundContext.authorityId) {
        return { accepted: false, reason: `CONTROLLER_ROUND_CONTEXT_STALE:${roundContext.workId}` };
      }
      const durableConversation = getChatgptWorkConversationBinding(relayStore, roundContext.workId);
      const prompt = [
        buildChatgptControllerRoundPrompt(relayStore, relay, { exactOriginWork: roundContext.exactOriginWork === true }),
        roundContext.continuationHint?.trim() ? `Continuation hint: ${roundContext.continuationHint.trim()}` : '',
      ].filter(Boolean).join('\n\n');
      const result = await runWorkChatgptContinuation({
        controllerHome: options.controllerHome,
        repoId: options.repoId,
        repoRoot: options.repoRoot,
        workId: roundContext.workId,
        prompt,
        controllerAuthorityId: roundContext.authorityId,
        relayScopeId: roundContext.relayScopeId,
        title: payload.title,
        browserSessionId: durableConversation?.latestBrowserSessionId ?? payload.browserSessionId,
        conversationUrl: durableConversation?.conversationUrl ?? payload.conversationUrl,
        model: payload.model ?? 'gpt-5.6',
        reasoning: payload.reasoning ?? 'high',
        tabPolicy: payload.tabPolicy ?? 'auto',
        timeoutMs: payload.timeoutMs,
      });
      if (result.status === 'failed') {
        const code = result.error?.code ?? 'CHATGPT_WORK_CONTINUATION_FAILED';
        const message = result.error?.message ?? code;
        const disposition = classifyChatgptProviderFailure(code, message);
        if (disposition === 'outcome_unknown') {
          throw new Error(`CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN:${code}:${message}`);
        }
        if (disposition === 'wait_for_user') {
          const handoffId = ensureChatgptProviderUserActionHandoff(options, roundContext, code, message);
          return { accepted: false, waitForUser: true, handoffId, reason: message };
        }
        return { accepted: false, reason: message };
      }
      return {
        accepted: true,
        dispatchId: chatgptProviderDispatchReceiptId({
          repoId: options.repoId,
          workId: roundContext.workId,
          relayScopeId: roundContext.relayScopeId,
          controllerAuthorityId: roundContext.authorityId,
          provider: result.provider,
        }),
      };
    },
  };
}
