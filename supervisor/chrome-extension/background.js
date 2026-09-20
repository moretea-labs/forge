importScripts('core.js');
const core = globalThis.ForgeWorkflowSupervisorChromeCore;
const NATIVE_HOST = 'com.moretea.forge.workflow_supervisor';
const ALARM = 'forge-workflow-supervisor-scan';
const inflight = new Set();
const observedAssistant = new Map();
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
    const fingerprint = core.textFingerprint(message.assistantResponse);
    if (observedAssistant.get(identity.conversationId) !== fingerprint) {
      try {
        await nativeRpc('browser_observe_assistant', { conversation_id: identity.conversationId, conversation_url: identity.canonicalUrl, response_text: message.assistantResponse });
        observedAssistant.set(identity.conversationId, fingerprint);
      } catch (error) {
        // A malformed provider block is durable evidence that this exact
        // response is not a completion. Do not reparse it on every mutation;
        // the next distinct response remains eligible for observation.
        if (String(error?.message ?? error).includes('WORKFLOW_SUPERVISOR_')) observedAssistant.set(identity.conversationId, fingerprint);
        if (!String(error?.message ?? error).includes('TASK_TERMINAL')) console.warn('[Forge Supervisor] assistant observation rejected', error);
      }
    }
  }
  const poll = await nativeRpc('browser_poll', { conversation_id: identity.conversationId, conversation_url: identity.canonicalUrl });
  if (poll?.command) await act(tabId, identity, poll.command);
}
async function discoveryScan(tabId, projectTitles) {
  try { return await tabMessage(tabId, { type: 'forge-workflow-supervisor-discovery-scan', projectTitles }); }
  catch { return {}; }
}
async function publishDiscovery(tabs, projectConversations = [], currentTabId) {
  const seen = new Set();
  const conversations = [];
  const append = (entry) => {
    if (!entry?.conversation_id || seen.has(entry.conversation_id) || conversations.length >= 512) return;
    seen.add(entry.conversation_id);
    conversations.push(entry);
  };
  for (const tab of tabs) {
    const identity = core.parseConversation(tab.url ?? '');
    if (!identity) continue;
    const title = String(tab.title ?? '').trim();
    append({ conversation_id: identity.conversationId, canonical_url: identity.canonicalUrl, ...(title ? { title: title.slice(0, 512) } : {}), ...(tab.id === currentTabId ? { is_current: true } : {}) });
  }
  for (const entry of projectConversations) append(entry);
  return nativeRpc('browser_discovery_update', { source: 'chrome-extension', conversations });
}
async function refreshAuthorizedTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: 'https://chatgpt.com/*' });
  const scopeResult = await nativeRpc('browser_project_scopes').catch(() => ({ projects: [] }));
  const projectScopes = Array.isArray(scopeResult?.projects) ? scopeResult.projects.filter((entry) => typeof entry?.title === 'string' && entry.title.trim()) : [];
  const projectTitles = [...new Set(projectScopes.map((entry) => entry.title.trim()))];
  const scans = [];
  for (const tab of tabs) if (tab.id) scans.push({ tab, scan: await discoveryScan(tab.id, projectTitles) });
  const projectLinks = new Map();
  for (const { scan } of scans) for (const project of Array.isArray(scan?.projects) ? scan.projects : []) {
    const title = String(project?.title ?? '').trim();
    const url = String(project?.url ?? '').trim();
    if (title && url) projectLinks.set(title.toLocaleLowerCase(), { title, url });
  }
  const projectConversations = [];
  for (const scope of projectScopes) {
    const project = projectLinks.get(scope.title.trim().toLocaleLowerCase());
    if (!project) continue;
    let projectTab = tabs.find((tab) => String(tab.url ?? '') === project.url);
    if (!projectTab) {
      projectTab = await chrome.tabs.create({ url: project.url, active: false });
      continue;
    }
    if (!projectTab.id) continue;
    const scan = await discoveryScan(projectTab.id, projectTitles);
    for (const conversation of Array.isArray(scan?.conversations) ? scan.conversations : []) {
      const identity = core.parseConversation(conversation?.canonicalUrl ?? '');
      if (!identity) continue;
      const title = String(conversation?.title ?? '').trim();
      projectConversations.push({
        conversation_id: identity.conversationId,
        canonical_url: identity.canonicalUrl,
        ...(title ? { title: title.slice(0, 512) } : {}),
        project_title: scope.title.trim(),
        project_url: project.url,
      });
    }
  }
  await publishDiscovery(tabs, projectConversations, currentTab?.id).catch(() => undefined);
  const result = await nativeRpc('browser_tasks');
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
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
let refreshTimer;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refreshAuthorizedTabs().catch(() => undefined), 500); }
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => { if (changeInfo.status === 'complete' && String(tab.url ?? '').startsWith('https://chatgpt.com/')) scheduleRefresh(); });
chrome.tabs.onActivated.addListener(() => scheduleRefresh());
chrome.tabs.onRemoved.addListener(() => scheduleRefresh());
chrome.windows.onFocusChanged.addListener(() => scheduleRefresh());
chrome.alarms.create(ALARM, { periodInMinutes: 1 });
void refreshAuthorizedTabs().catch(() => undefined);
