importScripts('core.js');
const core = globalThis.ForgeWorkflowSupervisorChromeCore;
const NATIVE_HOST = 'com.moretea.forge.workflow_supervisor';
const ALARM = 'forge-workflow-supervisor-scan';
const REFRESH_MIN_INTERVAL_MS = 2_000;
const CREATED_TAB_COOLDOWN_MS = 5 * 60 * 1000;
const observedAssistant = new Map();
const recentCreatedTabs = new Map();
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function ensureConversationTab(tabs, target) {
  const existing = tabs.find((candidate) => core.sameConversation(core.parseConversation(candidate.url ?? ''), target));
  if (existing) return existing;
  // A tab created here fires tabs.onUpdated and can be missing from the snapshot
  // this pass already holds, so re-read live tabs before opening anything.
  const fresh = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const live = fresh.find((candidate) => core.sameConversation(core.parseConversation(candidate.url ?? ''), target));
  if (live) { tabs.push(live); return live; }
  const key = `conversation:${target.conversationId}`;
  if (Date.now() - (recentCreatedTabs.get(key) ?? 0) < CREATED_TAB_COOLDOWN_MS) return undefined;
  const created = await chrome.tabs.create({ url: target.canonicalUrl, active: false });
  recentCreatedTabs.set(key, Date.now());
  if (created) tabs.push(created);
  return undefined;
}

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
  // Provider activity is a composer-safety gate only. It never replaces the
  // exact Supervisor END marker as completion authority. Initial enrollment can
  // start from an ordinary assistant turn, so wait until that turn is idle
  // before submitting the first Supervisor effect into this same conversation.
  if (message.providerTurnPending === true) return;
  // Native macOS transport is the only outbound sender. DOM-created input and
  // click events are not a provider submission receipt, so this extension is
  // deliberately limited to discovery and assistant-turn observation.
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
      const key = `project:${project.url}`;
      if (Date.now() - (recentCreatedTabs.get(key) ?? 0) < CREATED_TAB_COOLDOWN_MS) continue;
      projectTab = await chrome.tabs.create({ url: project.url, active: false });
      recentCreatedTabs.set(key, Date.now());
      if (projectTab) tabs.push(projectTab);
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
    const tab = await ensureConversationTab(tabs, target);
    if (!tab) continue;
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
let refreshInFlight;
let refreshQueued = false;
let refreshTimer;
let lastRefreshAtMs = 0;
async function runRefreshLoop() {
  if (refreshInFlight) return;
  refreshQueued = false;
  refreshInFlight = refreshAuthorizedTabs().catch(() => undefined).finally(() => {
    lastRefreshAtMs = Date.now();
    refreshInFlight = undefined;
    if (refreshQueued) scheduleRefresh();
  });
  await refreshInFlight;
}
// Tab load/activate/close events fire constantly while ChatGPT tabs churn. Each
// full pass ends in a task reconciliation that can reopen conversation tabs, so
// the triggers are coalesced behind a minimum interval instead of running a new
// pass per browser event.
function scheduleRefresh() {
  refreshQueued = true;
  if (refreshInFlight || refreshTimer !== undefined) return;
  const waitMs = Math.max(0, REFRESH_MIN_INTERVAL_MS - (Date.now() - lastRefreshAtMs));
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void runRefreshLoop(); }, waitMs);
}
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => { if (changeInfo.status === 'complete' && String(tab.url ?? '').startsWith('https://chatgpt.com/')) scheduleRefresh(); });
chrome.tabs.onActivated.addListener(() => scheduleRefresh());
chrome.tabs.onRemoved.addListener(() => scheduleRefresh());
chrome.windows.onFocusChanged.addListener(() => scheduleRefresh());
chrome.alarms.create(ALARM, { periodInMinutes: 1 });
void refreshAuthorizedTabs().catch(() => undefined);
