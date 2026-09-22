import {
  chatgptProviderError,
  classifyChatgptProviderFailure,
  type ChatgptProviderDeliveryHost,
} from './provider-delivery';

export interface ChatgptBrowserNavigationResult {
  submissionTargetUrl: string;
  recoveredFromStaleBinding: boolean;
  browserSessionId: string;
}

export interface ChatgptBrowserDeliveryOperations {
  ensureBrowser(controllerHome: string, workId: string): Promise<void>;
  navigate(controllerHome: string, workId: string, browserSessionId: string, targetUrl: string, timeoutMs?: number): Promise<ChatgptBrowserNavigationResult>;
  ensureExecutionPreference(controllerHome: string, workId: string, browserSessionId: string, model: string, reasoning: 'medium' | 'high' | 'xhigh', timeoutMs?: number): Promise<boolean>;
  submitPrompt(controllerHome: string, workId: string, browserSessionId: string, prompt: string, targetUrl: string, timeoutMs?: number): Promise<string>;
}

/** Native Browser delivery host. It owns session acquisition/navigation and prompt dispatch confirmation. */
export function createChatgptBrowserDeliveryHost(operations: ChatgptBrowserDeliveryOperations): ChatgptProviderDeliveryHost {
  return {
    async dispatch(input) {
      let effectiveBrowserSessionId = input.browserSessionId;
      try {
        await operations.ensureBrowser(input.controllerHome, input.workId);
        const navigation = await operations.navigate(
          input.controllerHome,
          input.workId,
          effectiveBrowserSessionId,
          input.targetUrl,
          input.timeoutMs,
        );
        effectiveBrowserSessionId = navigation.browserSessionId;
        const executionPreferenceVerified = await operations.ensureExecutionPreference(
          input.controllerHome,
          input.workId,
          effectiveBrowserSessionId,
          input.model,
          input.reasoning,
          input.timeoutMs,
        );
        const observedUrl = await operations.submitPrompt(
          input.controllerHome,
          input.workId,
          effectiveBrowserSessionId,
          input.prompt,
          navigation.submissionTargetUrl,
          input.timeoutMs,
        );
        return {
          status: 'dispatch_confirmed',
          provider: 'controller-browser',
          browserSessionId: effectiveBrowserSessionId,
          conversationUrl: observedUrl,
          executionPreferenceVerified,
        };
      } catch (error) {
        const providerError = chatgptProviderError(error, 'CHATGPT_CONTROLLER_BROWSER_FAILED');
        // SUBMISSION_NOT_CONFIRMED is only a known failure when no provider-side
        // conversation identity appeared. A new /c/<id> means the send may have
        // committed despite lagging DOM confirmation, so preserve outcome_unknown.
        const status = providerError.code === 'CHATGPT_AUTOMATION_SUBMISSION_NOT_CONFIRMED' && providerError.conversationUrl
          ? 'outcome_unknown'
          : classifyChatgptProviderFailure(providerError.code, providerError.message);
        return {
          status,
          provider: 'controller-browser',
          browserSessionId: effectiveBrowserSessionId,
          conversationUrl: providerError.conversationUrl ?? input.targetUrl,
          executionPreferenceVerified: false,
          error: providerError,
        };
      }
    },
  };
}
