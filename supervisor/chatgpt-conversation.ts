const CHATGPT_HOST = 'chatgpt.com';
const CONVERSATION_ID = /^[a-zA-Z0-9-]{8,128}$/;

export interface ChatgptConversationIdentity {
  conversationId: string;
  canonicalUrl: string;
}

export function parseChatgptConversationIdentity(value: string): ChatgptConversationIdentity {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== CHATGPT_HOST) throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_URL_INVALID');
  const segments = url.pathname.split('/').filter(Boolean);
  const marker = segments.lastIndexOf('c');
  if (marker < 0 || marker + 2 !== segments.length) throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_CONVERSATION_URL_REQUIRED');
  const conversationId = segments[marker + 1] ?? '';
  if (!CONVERSATION_ID.test(conversationId)) throw new Error('WORKFLOW_SUPERVISOR_CHATGPT_CONVERSATION_ID_INVALID');
  return { conversationId, canonicalUrl: `https://${CHATGPT_HOST}/${segments.join('/')}` };
}
