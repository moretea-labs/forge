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
      try {
        await operations.ensureBrowser(input.controllerHome, input.workId);
        const navigation = await operations.navigate(
          input.controllerHome,
          input.workId,
          input.browserSessionId,
          input.targetUrl,
          input.timeoutMs,
        );
        const executionPreferenceVerified = await operations.ensureExecutionPreference(
          input.controllerHome,
          input.workId,
          navigation.browserSessionId,
          input.model,
          input.reasoning,
          input.timeoutMs,
        );
        const observedUrl = await operations.submitPrompt(
          input.controllerHome,
          input.workId,
          navigation.browserSessionId,
          input.prompt,
          navigation.submissionTargetUrl,
          input.timeoutMs,
        );
        return {
          status: 'dispatch_confirmed',
          provider: 'controller-browser',
          browserSessionId: navigation.browserSessionId,
          conversationUrl: observedUrl,
          executionPreferenceVerified,
        };
      } catch (error) {
        const providerError = chatgptProviderError(error, 'CHATGPT_CONTROLLER_BROWSER_FAILED');
        return {
          status: classifyChatgptProviderFailure(providerError.code, providerError.message),
          provider: 'controller-browser',
          browserSessionId: input.browserSessionId,
          conversationUrl: input.targetUrl,
          executionPreferenceVerified: false,
          error: providerError,
        };
      }
    },
  };
}
