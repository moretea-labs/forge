importScripts('core.js');
const core = globalThis.ForgeWorkflowSupervisorChromeCore;
const NATIVE_HOST = 'com.moretea.forge.workflow_supervisor';
const ALARM = 'forge-workflow-supervisor-scan';
const inflight = new Set();
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function nativeRpc(method, params = {}) {
  return new Promise((resolve, reject) => chrome.runtime.sendNativeMessage(NATIVE_HOST, { id: randomId(), method, params }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) { reject(new Error(error.message)); return; }
    if (!response || response.ok !== true) { reject(new Error(response?.error?.message ?? 'WORKFLOW_SUPERVISOR_NATIVE_RPC_FAILED')); return; }
    resolve(response.result ?? {});
  }));
}
function tabMessage(tabId, message) {
  return new Promise((resolve, reject) => chrome.tabs.sendMessage(tabId, message, (response) => {
    const error = chrome.runtime.lastError;
    if (error) { reject(new Error(error.message)); return; }
    resolve(response ?? {});
  }));
}
async function recordOutcome(identity, command, result) {
  const outcome = result?.outcome === 'applied' ? 'applied' : result?.outcome === 'not_applied' ? 'not_applied' : 'unknown';
  await nativeRpc('browser_observe_effect', { conversation_id: identity.conversationId, conversation_url: identity.canonicalUrl, effect_id: command.effectId, observation_id: randomId(), outcome, evidence: result?.evidence ?? {} });
}
async function act(tabId, identity, command) {
  if (!command || inflight.has(command.effectId)) return;
  inflight.add(command.effectId);
  try {
    let mode = command.mode;
    if (mode === 'send') {
      let baseline;
      try { baseline = await tabMessage(tabId, { type: 'forge-workflow-supervisor-snapshot', effectId: command.effectId }); }
      catch { baseline = undefined; }
      if (!baseline) return;
      const begin = await nativeRpc('browser_begin_effect', { conversation_id: identity.conversationId, conversation_url: identity.canonicalUrl, effect_id: command.effectId, dispatch_id: randomId(), dispatch_generation: command.dispatchGeneration, evidence: { surface: 'chrome-extension', ...baseline } });
      if (begin.started !== true) mode = 'reconcile';
    }
    let result;
    try { result = await tabMessage(tabId, { type: 'forge-workflow-supervisor-effect', ...command, mode }); }
    catch (error) { result = { outcome: 'unknown', evidence: { reason: String(error?.message ?? error) } }; }
    await recordOutcome(identity, command, result);
  } finally { inflight.delete(command.effectId); }
}
async function handlePage(message, sender) {
  const tabId = sender.tab?.id;
  const identity = { conversationId: String(message.conversationId ?? ''), canonicalUrl: String(message.canonicalUrl ?? '') };
  if (!tabId || !core.sameIdentity(identity, core.parseConversation(sender.tab?.url ?? identity.canonicalUrl))) return;
  if (typeof message.assistantResponse === 'string' && core.isCommittedAssistantResponse(message.assistantResponse)) {
    try { await nativeRpc('browser_observe_assistant', { conversation_id: identity.conversationId, conversation_url: identity.canonicalUrl, response_text: message.assistantResponse }); }
    catch (error) { if (!String(error?.message ?? error).includes('TASK_TERMINAL')) console.warn('[Forge Supervisor] assistant observation rejected', error); }
  }
  const poll = await nativeRpc('browser_poll', { conversation_id: identity.conversationId, conversation_url: identity.canonicalUrl });
  if (poll?.command) await act(tabId, identity, poll.command);
}
async function refreshAuthorizedTabs() {
  const result = await nativeRpc('browser_tasks');
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  for (const task of tasks) {
    const target = core.parseConversation(task.conversationUrl);
    if (!target || target.conversationId !== task.conversationId) continue;
    const tab = tabs.find((candidate) => core.sameIdentity(core.parseConversation(candidate.url ?? ''), target));
    if (!tab) { await chrome.tabs.create({ url: target.canonicalUrl, active: false }); continue; }
    if (tab.discarded && tab.id) { await chrome.tabs.reload(tab.id); continue; }
    if (tab.id) await tabMessage(tab.id, { type: 'forge-workflow-supervisor-scan' }).catch(() => undefined);
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'forge-workflow-supervisor-page') return false;
  handlePage(message, sender).then(() => sendResponse({ ok: true }), (error) => { console.warn('[Forge Supervisor] page handling failed', error); sendResponse({ ok: false }); });
  return true;
});
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 1 }); void refreshAuthorizedTabs().catch(() => undefined); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 1 }); void refreshAuthorizedTabs().catch(() => undefined); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void refreshAuthorizedTabs().catch(() => undefined); });
chrome.alarms.create(ALARM, { periodInMinutes: 1 });
void refreshAuthorizedTabs().catch(() => undefined);
