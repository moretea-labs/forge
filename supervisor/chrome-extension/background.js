importScripts('core.js');
const core = globalThis.ForgeWorkflowSupervisorChromeCore;
const NATIVE_HOST = 'com.moretea.forge.workflow_supervisor';
const ALARM = 'forge-workflow-supervisor-scan';
const REFRESH_MIN_INTERVAL_MS = 2_000;
const PROVIDER_IDLE_GRACE_MS = 60_000;
const MAX_LOCAL_OBSERVATION_ATTEMPTS = 3;
const observedAssistant = new Map();
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The extension is the normal background ChatGPT provider transport. Durable
// send/retry authority remains exclusively in the Supervisor effect ledger; the
// extension only mutates a page after browser_begin_effect/bootstrap_begin_effect
// grants the exact dispatch generation. It stays entirely inside the browser
// extension surface and never uses foreground physical input.
function findConversationTab(tabs, target) {
  return tabs.find((candidate) => core.sameConversation(core.parseConversation(candidate.url ?? ''), target));
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
function tabGet(tabId) {
  return new Promise((resolve, reject) => chrome.tabs.get(tabId, (tab) => {
    const error = chrome.runtime.lastError;
    if (error) { reject(new Error(error.message)); return; }
    resolve(tab);
  }));
}
function tabCreate(url) {
  return new Promise((resolve, reject) => chrome.tabs.create({ url, active: false }, (tab) => {
    const error = chrome.runtime.lastError;
    if (error || !tab?.id) { reject(new Error(error?.message ?? 'WORKFLOW_SUPERVISOR_TAB_CREATE_FAILED')); return; }
    resolve(tab);
  }));
}
function tabRemove(tabId) { return new Promise((resolve) => chrome.tabs.remove(tabId, () => resolve())); }
async function waitForContent(tabId) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const tab = await tabGet(tabId);
      if (tab?.status === 'complete') {
        const snapshot = await tabMessage(tabId, { type: 'forge-workflow-supervisor-snapshot' });
        if (snapshot?.pageUrl) return snapshot;
      }
    } catch (error) { lastError = error; }
    await sleep(200);
  }
  throw lastError ?? new Error('WORKFLOW_SUPERVISOR_TAB_NOT_READY');
}
function snapshotEvidence(snapshot) {
  return {
    surface: 'chrome-extension',
    latest_user_text: String(snapshot?.latestUserText ?? ''),
    latest_assistant_response: String(snapshot?.latestAssistantResponse ?? ''),
  };
}
function snapshotApplied(snapshot, command) {
  const latest = String(snapshot?.latestUserText ?? '');
  return core.normalizeText(latest) === core.normalizeText(command.prompt) || core.promptHasEffect(latest, command.effectId);
}
async function observeProviderTurn(task, snapshot) {
  return nativeRpc('browser_observe_provider_turn', {
    conversation_id: task.conversationId,
    conversation_url: task.conversationUrl,
    generating: snapshot?.providerTurnPending === true,
    latest_assistant_response: String(snapshot?.latestAssistantResponse ?? ''),
    provider_activity_text: '',
    provider_failure_text: String(snapshot?.providerFailureText ?? ''),
    observed_at_ms: Date.now(),
    grace_ms: PROVIDER_IDLE_GRACE_MS,
  }).catch(() => ({ state: 'none' }));
}
async function observeRegularEffect(task, command, snapshot, outcome, evidence = {}) {
  return nativeRpc('browser_observe_effect', {
    conversation_id: task.conversationId,
    conversation_url: task.conversationUrl,
    effect_id: command.effectId,
    observation_id: `extension-${randomId()}`,
    outcome,
    evidence: { surface: 'chrome-extension', ...evidence, target_marker_present: snapshotApplied(snapshot, command) },
  });
}
async function reconcileRegularEffect(task, command, tabId, snapshot) {
  const current = snapshot ?? await tabMessage(tabId, { type: 'forge-workflow-supervisor-snapshot' });
  if (snapshotApplied(current, command)) {
    await observeRegularEffect(task, command, current, 'applied', { reconciliation: true });
  } else {
    await observeRegularEffect(task, command, current, 'unknown', { reconciliation: true, reason: 'submission_not_observed' });
  }
}
async function serviceConversationTask(task, tab) {
  if (!tab?.id) return;
  let poll = await nativeRpc('browser_poll', { conversation_id: task.conversationId, conversation_url: task.conversationUrl });
  if (poll?.terminal) return;
  let snapshot = await tabMessage(tab.id, { type: 'forge-workflow-supervisor-snapshot' });
  const provider = await observeProviderTurn(task, snapshot);
  if (!poll?.command) {
    poll = await nativeRpc('browser_poll', { conversation_id: task.conversationId, conversation_url: task.conversationUrl });
    if (!poll?.command || poll?.terminal) return;
  }
  let command = poll.command;
  if (command.mode === 'send' && snapshot?.providerTurnPending === true && provider?.state !== 'recovery_reserved') return;
  if (provider?.state === 'recovery_reserved') {
    poll = await nativeRpc('browser_poll', { conversation_id: task.conversationId, conversation_url: task.conversationUrl });
    if (!poll?.command || poll?.terminal) return;
    command = poll.command;
  }
  let mode = command.mode;
  if (mode === 'send') {
    const begin = await nativeRpc('browser_begin_effect', {
      conversation_id: task.conversationId,
      conversation_url: task.conversationUrl,
      effect_id: command.effectId,
      dispatch_id: `extension-${randomId()}`,
      dispatch_generation: command.dispatchGeneration,
      evidence: snapshotEvidence(snapshot),
    });
    if (!begin?.started) mode = 'reconcile';
  }
  if (mode === 'reconcile') { await reconcileRegularEffect(task, command, tab.id, snapshot); return; }
  const dispatch = await tabMessage(tab.id, { type: 'forge-workflow-supervisor-dispatch', prompt: command.prompt });
  if (dispatch?.dispatched !== true) {
    await nativeRpc('browser_observe_dispatch_failure', {
      conversation_id: task.conversationId,
      conversation_url: task.conversationUrl,
      effect_id: command.effectId,
      observation_id: `extension-${randomId()}`,
      dispatch_generation: command.dispatchGeneration,
      reason: String(dispatch?.reason ?? 'dispatch_failed'),
    });
    return;
  }
  for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    await sleep(attempt * 250);
    snapshot = await tabMessage(tab.id, { type: 'forge-workflow-supervisor-snapshot' });
    if (snapshotApplied(snapshot, command)) { await observeRegularEffect(task, command, snapshot, 'applied'); return; }
  }
  await observeRegularEffect(task, command, snapshot, 'unknown', { reason: 'outbound_not_confirmed' });
}
async function reconcileBootstrapTask(task, command, tabs) {
  const matches = [];
  for (const tab of tabs) {
    if (!tab.id || !String(tab.url ?? '').startsWith('https://chatgpt.com/')) continue;
    try {
      const snapshot = await tabMessage(tab.id, { type: 'forge-workflow-supervisor-snapshot' });
      const identity = core.parseConversation(snapshot?.pageUrl ?? tab.url ?? '');
      if (identity && snapshotApplied(snapshot, command)) matches.push({ identity, snapshot });
    } catch { /* one unreadable tab is not negative proof */ }
  }
  if (matches.length !== 1) return;
  const match = matches[0];
  await nativeRpc('bootstrap_bind_conversation', { task_id: task.taskId, conversation_id: match.identity.conversationId, conversation_url: match.identity.canonicalUrl });
  await nativeRpc('bootstrap_observe_effect', { task_id: task.taskId, effect_id: command.effectId, observation_id: `extension-${randomId()}`, outcome: 'applied', evidence: { surface: 'chrome-extension', reconciliation: true, target_marker_present: true } });
}
async function serviceBootstrapTask(task, tabs) {
  const poll = await nativeRpc('bootstrap_poll', { task_id: task.taskId });
  const command = poll?.command;
  if (!command) return;
  if (command.mode === 'reconcile') { await reconcileBootstrapTask(task, command, tabs); return; }
  const project = await nativeRpc('bootstrap_project_url', { task_id: task.taskId });
  const begin = await nativeRpc('bootstrap_begin_effect', { task_id: task.taskId, effect_id: command.effectId, dispatch_id: `extension-bootstrap-${randomId()}`, dispatch_generation: command.dispatchGeneration });
  if (!begin?.started) { await reconcileBootstrapTask(task, command, tabs); return; }
  let createdTab;
  let dispatched = false;
  try {
    createdTab = await tabCreate(String(project?.project_url ?? ''));
    await waitForContent(createdTab.id);
    const dispatch = await tabMessage(createdTab.id, { type: 'forge-workflow-supervisor-dispatch', prompt: command.prompt });
    if (dispatch?.dispatched !== true) {
      await nativeRpc('bootstrap_observe_effect', { task_id: task.taskId, effect_id: command.effectId, observation_id: `extension-${randomId()}`, outcome: 'not_applied', evidence: { surface: 'chrome-extension', pre_send_rejection: true, reason: String(dispatch?.reason ?? 'dispatch_failed') } });
      await tabRemove(createdTab.id);
      return;
    }
    dispatched = true;
    let snapshot;
    for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
      await sleep(attempt * 350);
      snapshot = await tabMessage(createdTab.id, { type: 'forge-workflow-supervisor-snapshot' });
      const identity = core.parseConversation(snapshot?.pageUrl ?? '');
      if (!identity || !snapshotApplied(snapshot, command)) continue;
      await nativeRpc('bootstrap_bind_conversation', { task_id: task.taskId, conversation_id: identity.conversationId, conversation_url: identity.canonicalUrl });
      await nativeRpc('bootstrap_observe_effect', { task_id: task.taskId, effect_id: command.effectId, observation_id: `extension-${randomId()}`, outcome: 'applied', evidence: { surface: 'chrome-extension', target_marker_present: true } });
      return;
    }
    await nativeRpc('bootstrap_observe_effect', { task_id: task.taskId, effect_id: command.effectId, observation_id: `extension-${randomId()}`, outcome: 'unknown', evidence: { surface: 'chrome-extension', reconciliation: true, reason: 'bootstrap_outbound_not_confirmed' } });
  } catch (error) {
    await nativeRpc('bootstrap_observe_effect', { task_id: task.taskId, effect_id: command.effectId, observation_id: `extension-${randomId()}`, outcome: dispatched ? 'unknown' : 'not_applied', evidence: { surface: 'chrome-extension', ...(dispatched ? { reconciliation: true } : { pre_send_rejection: true }), reason: String(error?.message ?? error) } }).catch(() => undefined);
    if (!dispatched && createdTab?.id) await tabRemove(createdTab.id);
  }
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
        const text = String(error?.message ?? error);
        if (text.includes('WORKFLOW_SUPERVISOR_') && !text.includes('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH')) observedAssistant.set(identity.conversationId, fingerprint);
        if (!text.includes('TASK_TERMINAL')) console.warn('[Forge Supervisor] assistant observation rejected', error);
      }
    }
  }
  scheduleRefresh();
}
async function discoveryScan(tabId, projectTitles) {
  try { return await tabMessage(tabId, { type: 'forge-workflow-supervisor-discovery-scan', projectTitles }); }
  catch { return {}; }
}
async function publishDiscovery(tabs, projectConversations = [], currentTabId) {
  const seen = new Set();
  const conversations = [];
  const projectByConversation = new Map(projectConversations.map((entry) => [entry.conversation_id, entry]));
  const append = (entry) => {
    if (!entry?.conversation_id || seen.has(entry.conversation_id) || conversations.length >= 512) return;
    seen.add(entry.conversation_id);
    conversations.push(entry);
  };
  for (const tab of tabs) {
    const identity = core.parseConversation(tab.url ?? '');
    if (!identity) continue;
    const title = String(tab.title ?? '').trim();
    append({ ...projectByConversation.get(identity.conversationId), conversation_id: identity.conversationId, canonical_url: identity.canonicalUrl, ...(title ? { title: title.slice(0, 512) } : {}), ...(tab.id === currentTabId ? { is_current: true } : {}) });
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
  for (const tab of tabs) {
    const identity = core.parseConversation(tab.url ?? '');
    const tabProjectId = core.projectId(tab.url ?? '');
    if (!identity || !tabProjectId) continue;
    const project = [...projectLinks.values()].find((entry) => core.projectId(entry.url) === tabProjectId);
    if (!project) continue;
    projectConversations.push({ conversation_id: identity.conversationId, canonical_url: identity.canonicalUrl, project_title: project.title, project_url: project.url });
  }
  for (const scope of projectScopes) {
    const project = projectLinks.get(scope.title.trim().toLocaleLowerCase());
    if (!project) continue;
    const projectTab = tabs.find((tab) => String(tab.url ?? '') === project.url);
    if (!projectTab?.id) continue;
    const scan = await discoveryScan(projectTab.id, projectTitles);
    const projectId = core.projectId(project.url);
    if (!projectId || core.projectId(scan.pageUrl) !== projectId) continue;
    for (const conversation of Array.isArray(scan?.conversations) ? scan.conversations : []) {
      const identity = core.parseConversation(conversation?.canonicalUrl ?? '');
      if (!identity || core.projectId(identity.canonicalUrl) !== projectId) continue;
      const title = String(conversation?.title ?? '').trim();
      projectConversations.push({ conversation_id: identity.conversationId, canonical_url: identity.canonicalUrl, ...(title ? { title: title.slice(0, 512) } : {}), project_title: scope.title.trim(), project_url: project.url });
    }
  }
  await publishDiscovery(tabs, projectConversations, currentTab?.id).catch(() => undefined);
  const result = await nativeRpc('browser_tasks');
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  for (const task of tasks) {
    try {
      if (String(task.conversationId ?? '').startsWith('bootstrap:')) { await serviceBootstrapTask(task, tabs); continue; }
      const target = core.parseConversation(task.conversationUrl);
      if (!target || target.conversationId !== task.conversationId) continue;
      const tab = findConversationTab(tabs, target);
      if (!tab) continue;
      if (tab.discarded && tab.id) { await chrome.tabs.reload(tab.id); continue; }
      await serviceConversationTask(task, tab);
    } catch (error) { console.warn('[Forge Supervisor] task transport failed', error); }
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
