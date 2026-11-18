(() => {
  function normalizeText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
  function parseConversation(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
      const segments = url.pathname.split('/').filter(Boolean);
      const marker = segments.lastIndexOf('c');
      if (marker < 0 || marker + 2 !== segments.length) return null;
      const conversationId = String(segments[marker + 1] ?? '').trim();
      if (!conversationId || conversationId.length > 256) return null;
      return { conversationId, canonicalUrl: `https://chatgpt.com/${segments.join('/')}` };
    } catch { return null; }
  }
  function projectId(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
      return /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/(?:project\/?|c\/[^/]+\/?)$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
    } catch { return null; }
  }
  function sameConversation(a, b) { return Boolean(a && b && a.conversationId === b.conversationId); }
  globalThis.ForgeComputerChatgptCore = Object.freeze({ normalizeText, parseConversation, projectId, sameConversation });
})();
