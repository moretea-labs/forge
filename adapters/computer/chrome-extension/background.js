importScripts('core.js');
const core = globalThis.ForgeComputerChatgptCore;
const NATIVE_HOST = 'com.moretea.forge.workflow_supervisor';
const ALARM = 'forge-computer-chatgpt-provider';
const PROVIDER_ID = 'browser.chrome-extension';
const PROVIDER_TICK_MS = 750;
const DISCOVERY_MIN_INTERVAL_MS = 2_000;
const RPC_TIMEOUT_MS = 30_000;
const bootstrapTabs = new Map();
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nativePort;
const pendingNative = new Map();
function rejectNativePending(error) {
  for (const pending of pendingNative.values()) { clearTimeout(pending.timer); pending.reject(error); }
  pendingNative.clear();
}
function ensureNativePort() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener((response) => {
    const pending = pendingNative.get(response?.id);
    if (!pending) return;
    pendingNative.delete(response.id);
    clearTimeout(pending.timer);
    if (response?.ok === true) pending.resolve(response.result ?? {});
    else pending.reject(new Error(response?.error?.message ?? 'COMPUTER_CHATGPT_NATIVE_RPC_FAILED'));
  });
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    nativePort = undefined;
    rejectNativePending(new Error(chrome.runtime.lastError?.message ?? 'COMPUTER_CHATGPT_NATIVE_PORT_DISCONNECTED'));
    setTimeout(() => { void providerTick().catch(() => undefined); }, 500);
  });
  return port;
}
function nativeRpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = randomId();
    const timer = setTimeout(() => {
      pendingNative.delete(id);
      reject(new Error(`COMPUTER_CHATGPT_NATIVE_RPC_TIMEOUT:${method}`));
    }, RPC_TIMEOUT_MS);
    pendingNative.set(id, { resolve, reject, timer });
    try { ensureNativePort().postMessage({ id, method, params }); }
    catch (error) { clearTimeout(timer); pendingNative.delete(id); reject(error); }
  });
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
    if (error || !tab?.id) { reject(new Error(error?.message ?? 'COMPUTER_CHATGPT_TAB_CREATE_FAILED')); return; }
    resolve(tab);
  }));
}
function tabRemove(tabId) { return new Promise((resolve) => chrome.tabs.remove(tabId, () => resolve())); }
function tabReload(tabId) { return new Promise((resolve) => chrome.tabs.reload(tabId, () => resolve())); }
async function chatgptTabs() { return await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); }
function binding(tab) {
  return {
    providerId: PROVIDER_ID,
    observedAt: new Date().toISOString(),
    browserProduct: 'chrome',
    windowId: String(tab.windowId),
    tabId: String(tab.id),
  };
}
async function snapshot(tabId, options = {}) {
  return await tabMessage(tabId, { type: 'forge-computer-chatgpt-snapshot', options });
}
async function waitForContent(tabId) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const tab = await tabGet(tabId);
      if (tab?.discarded) await tabReload(tabId);
      const observation = await snapshot(tabId);
      if (typeof observation?.url === 'string' && observation.url) return observation;
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw lastError ?? new Error('COMPUTER_CHATGPT_TAB_NOT_READY');
}
function matchingTabs(tabs, identity) {
  if (identity?.namespace === 'chatgpt.conversation') {
    return tabs.filter((tab) => core.parseConversation(tab.url ?? '')?.conversationId === identity.conversationId);
  }
  if (identity?.namespace === 'chatgpt.bootstrap') {
    const mapped = bootstrapTabs.get(identity.bootstrapKey);
    const exact = mapped ? tabs.filter((tab) => tab.id === mapped) : [];
    if (exact.length) return exact;
    const projectId = core.projectId(identity.projectUrl);
    return tabs.filter((tab) => String(tab.url ?? '') === identity.projectUrl || (projectId && core.projectId(tab.url ?? '') === projectId && !core.parseConversation(tab.url ?? '')));
  }
  return [];
}
async function resolveTarget(identity, createIfMissing) {
  let tabs = await chatgptTabs();
  let matches = matchingTabs(tabs, identity);
  if (matches.length > 1) throw new Error('COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_AMBIGUOUS');
  if (matches.length === 1) {
    const tab = matches[0];
    if (identity.namespace === 'chatgpt.bootstrap') bootstrapTabs.set(identity.bootstrapKey, tab.id);
    return { tab, created: false };
  }
  if (!createIfMissing) return undefined;
  const url = identity.namespace === 'chatgpt.conversation' ? identity.canonicalUrl : identity.projectUrl;
  const tab = await tabCreate(url);
  if (identity.namespace === 'chatgpt.bootstrap') bootstrapTabs.set(identity.bootstrapKey, tab.id);
  return { tab, created: true };
}
function normalize(value) { return core.normalizeText(value); }
function dispatchTransportNotReached(error) {
  const text = String(error?.message ?? error);
  return /Receiving end does not exist|Could not establish connection|No tab with id/i.test(text);
}
async function executeEnsure(command) {
  let target;
  try {
    target = await resolveTarget(command.identity, true);
    const observation = await waitForContent(target.tab.id);
    const refreshed = await tabGet(target.tab.id);
    return { kind: 'ensured', providerBinding: binding(refreshed), observation };
  } catch (error) {
    return {
      kind: 'failed',
      code: String(error?.message ?? error).split(':')[0] || 'COMPUTER_CHATGPT_EXTENSION_ENSURE_FAILED',
      retryable: true,
      failoverSafe: target?.created !== true,
    };
  }
}
async function executeObserve(command) {
  try {
    const target = await resolveTarget(command.identity, false);
    if (!target) return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING', retryable: true, failoverSafe: true };
    const observation = await snapshot(target.tab.id, command.options ?? {});
    const refreshed = await tabGet(target.tab.id);
    return { kind: 'observation', providerBinding: binding(refreshed), observation };
  } catch (error) {
    return { kind: 'failed', code: String(error?.message ?? error).split(':')[0] || 'COMPUTER_CHATGPT_EXTENSION_OBSERVE_FAILED', retryable: true, failoverSafe: true };
  }
}
async function executeDispatch(command) {
  const target = await resolveTarget(command.identity, false).catch(() => undefined);
  if (!target) return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING' };
  let result;
  try { result = await tabMessage(target.tab.id, { type: 'forge-computer-chatgpt-dispatch', prompt: command.prompt, mode: command.mode }); }
  catch (error) {
    return dispatchTransportNotReached(error)
      ? { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXTENSION_CONTENT_UNAVAILABLE' }
      : { kind: 'dispatch', mutation: 'attempted' };
  }
  if (result?.dispatched !== true) return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: String(result?.reason ?? 'COMPUTER_CHATGPT_EXTENSION_PRE_MUTATION_REJECTION') };
  let observation;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await sleep(attempt * 200);
    try {
      observation = await snapshot(target.tab.id, { includeUserHistory: false, includePageText: false });
      if (normalize(observation.latestUserText) === normalize(command.prompt)) return { kind: 'dispatch', mutation: 'attempted', confirmed: true, observation };
    } catch { /* mutation already happened; only confirmation is missing */ }
  }
  return { kind: 'dispatch', mutation: 'attempted', confirmed: false, ...(observation ? { observation } : {}) };
}
async function executeFindMarker(command) {
  const matches = [];
  for (const tab of await chatgptTabs()) {
    if (!tab.id) continue;
    try {
      const observation = await snapshot(tab.id, { includeUserHistory: true, includePageText: false });
      const identity = core.parseConversation(observation?.url ?? tab.url ?? '');
      if (!identity) continue;
      const texts = [observation.latestUserText, ...(Array.isArray(observation.userMessages) ? observation.userMessages : [])];
      if (!texts.some((text) => String(text ?? '').includes(command.marker))) continue;
      matches.push({ identity: { namespace: 'chatgpt.conversation', conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl }, providerBinding: binding(tab), observation });
    } catch { /* an unreadable tab is not negative proof */ }
  }
  return { kind: 'marker_matches', matches };
}
async function executeClose(command) {
  if (command.identity?.namespace === 'chatgpt.bootstrap') {
    const tabId = bootstrapTabs.get(command.identity.bootstrapKey);
    bootstrapTabs.delete(command.identity.bootstrapKey);
    if (tabId) await tabRemove(tabId).catch(() => undefined);
  }
  return { kind: 'closed' };
}
async function executeCommand(command) {
  if (!command || typeof command.commandId !== 'string') return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_COMMAND_INVALID', retryable: false, failoverSafe: true };
  if (command.kind === 'ensure') return await executeEnsure(command);
  if (command.kind === 'observe') return await executeObserve(command);
  if (command.kind === 'dispatch') return await executeDispatch(command);
  if (command.kind === 'find_marker') return await executeFindMarker(command);
  if (command.kind === 'close') return await executeClose(command);
  return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_COMMAND_UNKNOWN', retryable: false, failoverSafe: true };
}
async function publishHeartbeat() {
  const tabs = await chatgptTabs();
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: 'https://chatgpt.com/*' });
  const conversations = [];
  for (const tab of tabs) {
    const identity = core.parseConversation(tab.url ?? '');
    if (!identity || !tab.id) continue;
    conversations.push({
      conversationId: identity.conversationId,
      canonicalUrl: identity.canonicalUrl,
      ...(String(tab.title ?? '').trim() ? { title: String(tab.title).trim().slice(0, 512) } : {}),
      ...(tab.id === current?.id ? { isCurrent: true } : {}),
      providerBinding: binding(tab),
    });
  }
  await nativeRpc('computer_extension_heartbeat', { providerId: PROVIDER_ID, observedAt: new Date().toISOString(), conversations });
}
let providerTickInFlight;
async function providerTick() {
  if (providerTickInFlight) return await providerTickInFlight;
  providerTickInFlight = (async () => {
    await publishHeartbeat();
    for (let index = 0; index < 8; index += 1) {
      const claim = await nativeRpc('computer_extension_claim');
      const command = claim?.command;
      if (!command) break;
      const result = await executeCommand(command);
      await nativeRpc('computer_extension_complete', { command_id: command.commandId, result });
    }
  })().finally(() => { providerTickInFlight = undefined; });
  return await providerTickInFlight;
}
async function discoveryScan(tabId, projectTitles) {
  try { return await tabMessage(tabId, { type: 'forge-computer-chatgpt-discovery-scan', projectTitles }); }
  catch { return {}; }
}
async function refreshDiscovery() {
  const tabs = await chatgptTabs();
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: 'https://chatgpt.com/*' });
  const scopeResult = await nativeRpc('browser_project_scopes').catch(() => ({ projects: [] }));
  const projectScopes = Array.isArray(scopeResult?.projects) ? scopeResult.projects.filter((entry) => typeof entry?.title === 'string' && entry.title.trim()) : [];
  const projectTitles = [...new Set(projectScopes.map((entry) => entry.title.trim()))];
  const projectLinks = new Map();
  const scans = [];
  for (const tab of tabs) if (tab.id) scans.push({ tab, scan: await discoveryScan(tab.id, projectTitles) });
  for (const { scan } of scans) for (const project of Array.isArray(scan?.projects) ? scan.projects : []) {
    const title = String(project?.title ?? '').trim();
    const url = String(project?.url ?? '').trim();
    if (title && url) projectLinks.set(title.toLocaleLowerCase(), { title, url });
  }
  const projectByConversation = new Map();
  for (const scope of projectScopes) {
    const project = projectLinks.get(scope.title.trim().toLocaleLowerCase());
    if (!project) continue;
    const projectId = core.projectId(project.url);
    if (!projectId) continue;
    const projectTab = tabs.find((tab) => String(tab.url ?? '') === project.url);
    if (!projectTab?.id) continue;
    const scan = await discoveryScan(projectTab.id, projectTitles);
    for (const conversation of Array.isArray(scan?.conversations) ? scan.conversations : []) {
      const identity = core.parseConversation(conversation?.canonicalUrl ?? '');
      if (!identity || core.projectId(identity.canonicalUrl) !== projectId) continue;
      projectByConversation.set(identity.conversationId, { project_title: scope.title.trim(), project_url: project.url });
    }
  }
  const conversations = [];
  const seen = new Set();
  for (const tab of tabs) {
    const identity = core.parseConversation(tab.url ?? '');
    if (!identity || seen.has(identity.conversationId)) continue;
    seen.add(identity.conversationId);
    const title = String(tab.title ?? '').trim();
    conversations.push({ conversation_id: identity.conversationId, canonical_url: identity.canonicalUrl, ...projectByConversation.get(identity.conversationId), ...(title ? { title: title.slice(0, 512) } : {}), ...(tab.id === current?.id ? { is_current: true } : {}) });
  }
  await nativeRpc('browser_discovery_update', { source: 'chrome-extension', conversations }).catch(() => undefined);
}
let discoveryInFlight;
let discoveryTimer;
let lastDiscoveryAt = 0;
function scheduleDiscovery() {
  if (discoveryInFlight || discoveryTimer !== undefined) return;
  const delay = Math.max(0, DISCOVERY_MIN_INTERVAL_MS - (Date.now() - lastDiscoveryAt));
  discoveryTimer = setTimeout(() => {
    discoveryTimer = undefined;
    discoveryInFlight = refreshDiscovery().catch(() => undefined).finally(() => { lastDiscoveryAt = Date.now(); discoveryInFlight = undefined; });
  }, delay);
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'forge-computer-chatgpt-page') return false;
  void providerTick().catch(() => undefined);
  scheduleDiscovery();
  sendResponse({ ok: true });
  return false;
});
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 1 }); void providerTick().catch(() => undefined); scheduleDiscovery(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 1 }); void providerTick().catch(() => undefined); scheduleDiscovery(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) { void providerTick().catch(() => undefined); scheduleDiscovery(); } });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => { if (changeInfo.status === 'complete' && String(tab.url ?? '').startsWith('https://chatgpt.com/')) { void providerTick().catch(() => undefined); scheduleDiscovery(); } });
chrome.tabs.onActivated.addListener(() => { void providerTick().catch(() => undefined); scheduleDiscovery(); });
chrome.tabs.onRemoved.addListener(() => { void providerTick().catch(() => undefined); scheduleDiscovery(); });
chrome.windows.onFocusChanged.addListener(() => { void providerTick().catch(() => undefined); scheduleDiscovery(); });
chrome.alarms.create(ALARM, { periodInMinutes: 1 });
setInterval(() => { void providerTick().catch(() => undefined); }, PROVIDER_TICK_MS);
void providerTick().catch(() => undefined);
scheduleDiscovery();
