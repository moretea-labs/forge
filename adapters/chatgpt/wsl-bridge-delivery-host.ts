import { runBridgeProvider } from '../../src/cli/chatgpt-browser/bridge-provider';
import { controllerSystemRoot } from '../../src/cli/repositories/controller-home';
import {
  classifyChatgptProviderFailure,
  type ChatgptProviderDeliveryHost,
} from './provider-delivery';

/** WSL bridge delivery host. Windows Chrome is transport; this adapter returns the same dispatch semantics as native Browser. */
export function createChatgptWslBridgeDeliveryHost(): ChatgptProviderDeliveryHost {
  return {
    async dispatch(input) {
      try {
        const bridgeRoot = controllerSystemRoot(input.controllerHome);
        const bridged = await runBridgeProvider({
          repoRoot: bridgeRoot,
          prompt: input.prompt,
          provider: 'bridge',
          chatgptUrl: input.targetUrl,
          timeoutMs: input.timeoutMs ?? 60_000,
          dispatchOnly: true,
        }, {
          prompt: input.prompt,
          rendered: input.prompt,
          files: [],
          followups: [],
          totalChars: input.prompt.length,
        });
        if (bridged.status !== 'completed') {
          const code = bridged.error?.code ?? 'CHATGPT_BRIDGE_DISPATCH_FAILED';
          const message = bridged.error?.message ?? bridged.output;
          return {
            status: classifyChatgptProviderFailure(code, message),
            provider: 'chatgpt-bridge',
            browserSessionId: input.browserSessionId,
            conversationUrl: bridged.conversationUrl ?? input.targetUrl,
            executionPreferenceVerified: false,
            error: { code, message },
          };
        }
        return {
          status: 'dispatch_confirmed',
          provider: 'chatgpt-bridge',
          browserSessionId: input.browserSessionId,
          conversationUrl: bridged.conversationUrl ?? input.targetUrl,
          executionPreferenceVerified: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof Error && error.message.includes(':')
          ? error.message.split(':', 1)[0]
          : 'CHATGPT_BRIDGE_DISPATCH_FAILED';
        return {
          status: classifyChatgptProviderFailure(code, message),
          provider: 'chatgpt-bridge',
          browserSessionId: input.browserSessionId,
          conversationUrl: input.targetUrl,
          executionPreferenceVerified: false,
          error: { code, message },
        };
      }
    },
  };
}
