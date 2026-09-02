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
        if (/OUTCOME_UNKNOWN/i.test(code) || /OUTCOME_UNKNOWN/i.test(message)) {
          throw new Error(`CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN:${code}:${message}`);
        }
        return { accepted: false, reason: message };
      }
      return { accepted: true, dispatchId: result.browserSessionId };
    },
  };
}
