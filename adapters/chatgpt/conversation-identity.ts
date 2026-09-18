const CHATGPT_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
const MAX_CONVERSATION_ID_CHARS = 256;

export interface CanonicalChatgptConversationIdentity {
  conversationUrl: string;
  conversationId: string;
}

export function parseCanonicalChatgptConversationIdentity(value: string): CanonicalChatgptConversationIdentity {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('CHATGPT_CONVERSATION_URL_INVALID'); }
  if (url.protocol !== 'https:' || !CHATGPT_HOSTS.has(url.hostname)) throw new Error('CHATGPT_CONVERSATION_URL_INVALID');
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.lastIndexOf('c');
  if (marker < 0 || marker + 2 !== parts.length) throw new Error('CHATGPT_CONVERSATION_ID_MISSING');
  const conversationId = parts[marker + 1]?.trim() ?? '';
  if (!conversationId) throw new Error('CHATGPT_CONVERSATION_ID_MISSING');
  if (conversationId.length > MAX_CONVERSATION_ID_CHARS) throw new Error('CHATGPT_CONVERSATION_ID_INVALID');
  url.protocol = 'https:';
  url.hostname = 'chatgpt.com';
  url.search = '';
  url.hash = '';
  return { conversationUrl: url.toString(), conversationId };
}
