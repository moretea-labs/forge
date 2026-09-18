import { parseCanonicalChatgptConversationIdentity } from '../adapters/chatgpt/conversation-identity';

export interface ChatgptConversationIdentity {
  conversationId: string;
  canonicalUrl: string;
}

export function parseChatgptConversationIdentity(value: string): ChatgptConversationIdentity {
  try {
    const identity = parseCanonicalChatgptConversationIdentity(value);
    return { conversationId: identity.conversationId, canonicalUrl: identity.conversationUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'CHATGPT_CONVERSATION_URL_INVALID') throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_URL_INVALID');
    if (message === 'CHATGPT_CONVERSATION_ID_MISSING') throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_CONVERSATION_URL_REQUIRED');
    throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_CONVERSATION_ID_INVALID');
  }
}
