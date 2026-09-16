(() => {
  const END = '<<<END_FORGE_WORKFLOW_SUPERVISOR_V1>>>';
  const START = '<<<FORGE_WORKFLOW_SUPERVISOR_V1>>>';
  const EFFECT = /^fx_[a-zA-Z0-9_-]{8,120}$/;
  function normalizeText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
  function parseConversation(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
      const segments = url.pathname.split('/').filter(Boolean);
      const marker = segments.lastIndexOf('c');
      if (marker < 0 || marker + 2 !== segments.length) return null;
      const conversationId = segments[marker + 1] ?? '';
      if (!/^[a-zA-Z0-9-]{8,128}$/.test(conversationId)) return null;
      return { conversationId, canonicalUrl: `https://chatgpt.com/${segments.join('/')}` };
    } catch { return null; }
  }
  function effectMarker(effectId) { return EFFECT.test(effectId) ? `<<<FORGE_WORKFLOW_EFFECT_V1:${effectId}>>>` : ''; }
  function promptHasEffect(prompt, effectId) { const marker = effectMarker(effectId); return Boolean(marker && String(prompt).includes(marker)); }
  function isCommittedAssistantResponse(text) { const value = String(text ?? '').trim(); return value.length <= 512 * 1024 && value.endsWith(END) && value.lastIndexOf(START) >= 0; }
  function sameIdentity(a, b) { return Boolean(a && b && a.conversationId === b.conversationId && a.canonicalUrl === b.canonicalUrl); }
  globalThis.ForgeWorkflowSupervisorChromeCore = Object.freeze({ normalizeText, parseConversation, effectMarker, promptHasEffect, isCommittedAssistantResponse, sameIdentity });
})();
