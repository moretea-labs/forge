importScripts('core.js');
const core = globalThis.ForgeComputerChatgptCore;
const NATIVE_HOST = 'com.moretea.forge.workflow_supervisor';
const ALARM = 'forge-computer-chatgpt-provider';
const PROVIDER_ID = 'browser.chrome-extension';
const PROVIDER_TICK_MS = 750;
const DISCOVERY_MIN_INTERVAL_MS = 2_000;
const RPC_TIMEOUT_MS = 30_000;
// The broker budgets 12 seconds for a claimed command; a hung content
// callback must settle earlier without claiming a Send never happened.
const TAB_MESSAGE_TIMEOUT_MS = 7_000;
const bootstrapTabs = new Map();
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let providerInstancePromise;
function providerInstanceId() {
  // Profile-local storage survives worker and browser restarts. It identifies
  // this Chrome profile, never a task or an outbound effect.
  // A fresh worker UUID would invalidate every Controller-pinned tab.
  providerInstancePromise ??= (async () => {
    const saved = await chrome.storage.local.get('forgeComputerProviderInstanceId');
    if (typeof saved.forgeComputerProviderInstanceId === 'string' && saved.forgeComputerProviderInstanceId) return saved.forgeComputerProviderInstanceId;
    const instanceId = randomId();
    await chrome.storage.local.set({ forgeComputerProviderInstanceId: instanceId });
    return instanceId;
  })().catch((error) => { providerInstancePromise = undefined; throw error; });
  return providerInstancePromise;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function browserProduct() {
  const ua = String(globalThis.navigator?.userAgent ?? '');
  if (/Vivaldi/i.test(ua)) return 'vivaldi';
  if (/Chromium/i.test(ua)) return 'chromium';
  return 'chrome';
}

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
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(response ?? {});
    };
    const timer = setTimeout(() => finish(new Error('COMPUTER_CHATGPT_EXTENSION_TAB_MESSAGE_TIMEOUT')), TAB_MESSAGE_TIMEOUT_MS);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        // Read lastError inside the callback, even if the request timed out,
        // so Chrome does not report an unhandled transport error.
        const error = chrome.runtime.lastError;
        finish(error ? new Error(error.message) : undefined, response);
      });
    } catch (error) { finish(error); }
  });
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
function tabRemove(tabId) { return new Promise((resolve, reject) => chrome.tabs.remove(tabId, () => {
  const error = chrome.runtime.lastError;
  if (error) reject(new Error(error.message)); else resolve();
})); }
function tabReload(tabId) { return new Promise((resolve) => chrome.tabs.reload(tabId, () => resolve())); }
async function chatgptTabs() { return await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); }
// Controller binding owns the durable source identity. This browser-session
// attestation proves that the exact physical tab was created by this extension;
// browser restarts invalidate it rather than permitting tab-id reuse to close
// an unrelated restored/user tab.
function ownedTabKey(tabId) { return `forgeComputerOwnedTabV1:${tabId}`; }
async function attestedOwnerToken(tab, pinnedBinding) {
  if (!pinnedBinding?.ownerToken || String(pinnedBinding.tabId) !== String(tab.id)
    || String(pinnedBinding.windowId) !== String(tab.windowId)) return;
  try {
    const key = ownedTabKey(tab.id);
    const stored = await chrome.storage.session.get(key);
    if (stored[key] === pinnedBinding.ownerToken) return pinnedBinding.ownerToken;
  } catch { /* missing browser-session provenance is never closure authority */ }
}
function binding(tab, instanceId, ownerToken) {
  return {
    providerId: PROVIDER_ID,
    providerSessionId: instanceId,
    observedAt: new Date().toISOString(),
    browserProduct: browserProduct(),
    windowId: String(tab.windowId),
    tabId: String(tab.id),
    ...(ownerToken ? { ownerToken } : {}),
  };
}
async function snapshot(tabId, options = {}) {
  return await tabMessage(tabId, { type: 'forge-computer-chatgpt-snapshot', options });
}
async function restoreExactContentReceiver(tabId, identity) {
  // The physical tab is already resolved by the one Computer target authority.
  // A missing MV3 message receiver is not permission to reload/navigate that tab,
  // replace its draft, or create another tab. Inject only read-only listeners on
  // this SAME proven conversation/Project, then verify its identity again.
  const matches = (tab) => identity?.namespace === 'chatgpt.conversation'
    ? core.parseConversation(tab.url ?? '')?.conversationId === identity.conversationId
    : identity?.namespace === 'chatgpt.bootstrap'
      && core.projectId(tab.url ?? '') === core.projectId(identity.projectUrl)
      && !core.parseConversation(tab.url ?? '');
  const before = await tabGet(tabId);
  if (before.discarded || !matches(before)) throw new Error('COMPUTER_CHATGPT_EXTENSION_RECEIVER_TARGET_CHANGED');
  await new Promise((resolve, reject) => chrome.scripting.executeScript({
    target: { tabId }, files: ['core.js', 'content.js'],
  }, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve();
  }));
  const after = await tabGet(tabId);
  if (!matches(after)) throw new Error('COMPUTER_CHATGPT_EXTENSION_RECEIVER_TARGET_CHANGED');
}
async function waitForContent(tabId, requireBootstrapUi = false, recoverReceiver) {
  let lastError;
  let recoveryAttempted = false;
  // Bootstrap is a new provider page: seeing its URL proves location, not
  // that the React composer is hydrated. The Supervisor uses the user's
  // current reasoning setting, not the picker. Bound this wait below the
  // broker's 12-second timeout; missing composer never authorizes Send.
  const attempts = requireBootstrapUi ? 20 : 40;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const tab = await tabGet(tabId);
      if (tab?.discarded) await tabReload(tabId);
      const observation = await snapshot(tabId);
      if (typeof observation?.url === 'string' && observation.url
        && (!requireBootstrapUi || typeof observation.composerText === 'string')) return observation;
    } catch (error) {
      lastError = error;
      if (!recoveryAttempted && recoverReceiver
        && /Receiving end does not exist|Could not establish connection/i.test(String(error?.message ?? error))) {
        recoveryAttempted = true;
        // Reattach the receiver only after exact tab/Project revalidation.
        // Never retry the original Send: this is an observation-only preflight.
        await recoverReceiver();
      }
    }
    await sleep(250);
  }
  throw lastError ?? new Error('COMPUTER_CHATGPT_TAB_NOT_READY');
}
function matchingTabs(tabs, identity, pinnedBinding) {
  if (identity?.namespace === 'chatgpt.conversation') {
    const exact = tabs.filter((tab) => core.parseConversation(tab.url ?? '')?.conversationId === identity.conversationId);
    if (pinnedBinding?.providerId === PROVIDER_ID && pinnedBinding.tabId && pinnedBinding.windowId) {
      const pinned = exact.filter((tab) => String(tab.id) === String(pinnedBinding.tabId));
      if (pinned.length === 1) return pinned;
    }
    // Duplicate exact URLs without a verifiable pin must never select an
    // arbitrary foreground tab (or silently create another one).
    return exact;
  }
  if (identity?.namespace === 'chatgpt.bootstrap') {
    // The Project is a scope, not a tab identity. Multiple tasks share the
    // same Project; adopting its arbitrary new-chat tab steals another task's
    // binding and violates the Controller's unique Computer surface index.
    const projectId = core.projectId(identity.projectUrl);
    const belongsToProject = (tab) => String(tab.url ?? '') === identity.projectUrl
      || Boolean(projectId && core.projectId(tab.url ?? '') === projectId);
    if (pinnedBinding?.providerId === PROVIDER_ID && pinnedBinding.tabId && pinnedBinding.windowId) {
      const exact = tabs.filter((tab) => String(tab.id) === String(pinnedBinding.tabId));
      if (exact.length && !belongsToProject(exact[0])) throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_IDENTITY_CHANGED');
      return exact;
    }
    const mapped = bootstrapTabs.get(identity.bootstrapKey);
    return mapped ? tabs.filter((tab) => tab.id === mapped && belongsToProject(tab)) : [];
  }
  return [];
}
async function resolveTarget(identity, createIfMissing, pinnedBinding) {
  const tabs = await chatgptTabs();
  if (identity?.namespace === 'chatgpt.conversation' && pinnedBinding?.providerId === PROVIDER_ID && pinnedBinding.tabId) {
    // Window moves preserve Chrome's profile-local tab id. A vanished id may
    // be recovered by exact conversation, but an existing tab at another URL
    // is identity drift and must never be silently replaced.
    let pinned;
    try { pinned = await tabGet(Number(pinnedBinding.tabId)); }
    catch (error) {
      if (!/No tab with id/i.test(String(error?.message ?? error))) throw error;
    }
    if (pinned) {
      if (core.parseConversation(pinned.url ?? '')?.conversationId !== identity.conversationId) {
        throw new Error('COMPUTER_CHATGPT_EXTENSION_PINNED_TAB_IDENTITY_CHANGED');
      }
      return { tab: pinned, created: false, ownerToken: await attestedOwnerToken(pinned, pinnedBinding) };
    }
  }
  const matches = matchingTabs(tabs, identity, pinnedBinding);
  if (matches.length > 1) throw new Error('COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_AMBIGUOUS');
  if (matches.length === 1) {
    const tab = matches[0];
    if (identity.namespace === 'chatgpt.bootstrap') bootstrapTabs.set(identity.bootstrapKey, tab.id);
    return { tab, created: false, ownerToken: await attestedOwnerToken(tab, pinnedBinding) };
  }
  if (identity?.namespace === 'chatgpt.bootstrap' && pinnedBinding?.providerId === PROVIDER_ID
    && pinnedBinding.tabId && pinnedBinding.windowId) {
    throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING');
  }
  if (!createIfMissing) return undefined;
  const url = identity.namespace === 'chatgpt.conversation' ? identity.canonicalUrl : identity.projectUrl;
  const tab = await tabCreate(url);
  if (identity.namespace === 'chatgpt.bootstrap') bootstrapTabs.set(identity.bootstrapKey, tab.id);
  const token = randomId();
  let ownerToken;
  try {
    await chrome.storage.session.set({ [ownedTabKey(tab.id)]: token });
    ownerToken = token;
  } catch { /* still preserve the created tab's exact binding, but never auto-close without provenance */ }
  return { tab, created: true, ownerToken };
}
function dispatchTransportNotReached(error) {
  const text = String(error?.message ?? error);
  return /Receiving end does not exist|Could not establish connection|No tab with id/i.test(text);
}
async function executeEnsure(command, instanceId) {
  let target;
  try {
    target = await resolveTarget(command.identity, true, command.providerBinding);
    // Created and already-bound tabs share one exact-identity receiver repair.
    // The editor must hydrate before 'ensured'; on failure the existing typed
    // failed receipt still carries this tab's binding without permitting Send.
    const observation = await waitForContent(target.tab.id, command.identity.namespace === 'chatgpt.bootstrap',
      () => restoreExactContentReceiver(target.tab.id, command.identity));
    const refreshed = await tabGet(target.tab.id);
    return { kind: 'ensured', providerBinding: binding(refreshed, instanceId, target.ownerToken), observation };
  } catch (error) {
    return {
      kind: 'failed',
      code: String(error?.message ?? error).split(':')[0] || 'COMPUTER_CHATGPT_EXTENSION_ENSURE_FAILED',
      retryable: true,
      // A hydration failure must retain the created tab's physical attachment.
      // This receipt grants neither a ready page nor permission to Send.
      ...(target ? { providerBinding: binding(target.tab, instanceId, target.ownerToken) } : {}),
      // Bootstrap tabs can exist before this command even when no new tab was
      // created now. A worker failure cannot prove that creating a different
      // native tab would preserve the one-task/one-tab binding.
      failoverSafe: false,
    };
  }
}
async function executeObserve(command, instanceId) {
  try {
    const target = await resolveTarget(command.identity, false, command.providerBinding);
    if (!target) return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING', retryable: true, failoverSafe: true };
    const observation = await snapshot(target.tab.id, command.options ?? {});
    const refreshed = await tabGet(target.tab.id);
    return { kind: 'observation', providerBinding: binding(refreshed, instanceId, await attestedOwnerToken(refreshed, command.providerBinding)), observation };
  } catch (error) {
    return { kind: 'failed', code: String(error?.message ?? error).split(':')[0] || 'COMPUTER_CHATGPT_EXTENSION_OBSERVE_FAILED', retryable: true, failoverSafe: true };
  }
}
async function executePrepare(command) {
  const target = await resolveTarget(command.identity, false, command.providerBinding).catch(() => undefined);
  if (!target) return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING' };
  const expectedProjectId = command.identity?.namespace === 'chatgpt.bootstrap' ? core.projectId(command.identity.projectUrl) : undefined;
  if (command.identity?.namespace === 'chatgpt.bootstrap' && !expectedProjectId)
    return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_UNPROVEN' };
  const requiresDraftReplacement = typeof command.prompt === 'string' && command.prompt.startsWith('<<<FORGE_DRAFT_REPLACE_V1:');
  if (command.reasoning !== undefined || expectedProjectId || requiresDraftReplacement) {
    let capability;
    try { capability = await tabMessage(target.tab.id, { type: 'forge-computer-chatgpt-capabilities' }); }
    catch { return { kind: 'prepared', ready: false, reasonCode: expectedProjectId
      ? 'COMPUTER_CHATGPT_CONTENT_CAPABILITIES_UNAVAILABLE' : 'COMPUTER_CHATGPT_REASONING_PREFLIGHT_UNAVAILABLE' }; }
    if (command.reasoning !== undefined && capability?.reasoningPreflight !== 'verified_before_send_v1')
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_REASONING_PREFLIGHT_UNSUPPORTED' };
    // Older content scripts ignore expectedProjectId. No bootstrap draft/send
    // may cross this version boundary without target verification.
    if (expectedProjectId && capability?.bootstrapTargetGuard !== 'project-checked-before-send-v1')
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' };
    if (requiresDraftReplacement && capability?.composerReplacementContract !== 'exact-backed-up-project-draft-v1')
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_LOADED_SCRIPT_STALE' };
  }
  try {
    const result = await tabMessage(target.tab.id, {
      type: 'forge-computer-chatgpt-prepare', prompt: command.prompt, mode: command.mode,
      reasoning: command.reasoning,
      ...(command.identity?.namespace === 'chatgpt.conversation' ? { expectedConversationId: command.identity.conversationId } : {}),
      ...(expectedProjectId ? { expectedProjectId } : {}),
    });
    if (result?.prepared !== true) return { kind: 'prepared', ready: false, reasonCode: String(result?.reason ?? 'COMPUTER_CHATGPT_EXTENSION_PREPARE_REJECTED') };
    if (command.reasoning !== undefined && !['medium', 'high', 'xhigh'].includes(result.reasoningVerified)) {
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_REASONING_NOT_VERIFIED' };
    }
    return { kind: 'prepared', ready: true, ...(result.reasoningVerified ? { reasoningVerified: result.reasoningVerified } : {}) };
  } catch {
    // A prepare command contains no Send action. Failure is not a submitted effect.
    return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PREPARE_UNAVAILABLE' };
  }
}
async function executeDispatch(command) {
  const target = await resolveTarget(command.identity, false, command.providerBinding).catch(() => undefined);
  if (!target) return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING' };
  const expectedProjectId = command.identity?.namespace === 'chatgpt.bootstrap' ? core.projectId(command.identity.projectUrl) : undefined;
  if (command.identity?.namespace === 'chatgpt.bootstrap' && !expectedProjectId)
    return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_UNPROVEN' };
  // An old tab may still contain a pre-upgrade content script after the
  // extension/runtime has been upgraded. Probe the *exact target tab* before
  // submitting; a background/version heartbeat alone cannot prove it.
  if (command.reasoning !== undefined || expectedProjectId) {
    let capability;
    try { capability = await tabMessage(target.tab.id, { type: 'forge-computer-chatgpt-capabilities' }); }
    catch { return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: expectedProjectId
      ? 'COMPUTER_CHATGPT_CONTENT_CAPABILITIES_UNAVAILABLE' : 'COMPUTER_CHATGPT_REASONING_PREFLIGHT_UNAVAILABLE' }; }
    if (command.reasoning !== undefined && capability?.reasoningPreflight !== 'verified_before_send_v1')
      return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_REASONING_PREFLIGHT_UNSUPPORTED' };
    if (expectedProjectId && capability?.bootstrapTargetGuard !== 'project-checked-before-send-v1')
      return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' };
  }
  let result;
  try { result = await tabMessage(target.tab.id, {
    type: 'forge-computer-chatgpt-dispatch', prompt: command.prompt, mode: command.mode,
    reasoning: command.reasoning,
    ...(command.identity?.namespace === 'chatgpt.conversation' ? { expectedConversationId: command.identity.conversationId } : {}),
    ...(expectedProjectId ? { expectedProjectId } : {}),
  }); }
  catch (error) {
    return dispatchTransportNotReached(error)
      ? { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXTENSION_CONTENT_UNAVAILABLE' }
      : { kind: 'dispatch', mutation: 'attempted' };
  }
  if (result?.dispatched === false) return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: String(result?.reason ?? 'COMPUTER_CHATGPT_EXTENSION_PRE_MUTATION_REJECTION') };
  // A missing/malformed reply after dispatch crossed the content-script boundary
  // is not an attestation that Send never ran.
  if (result?.dispatched !== true) return { kind: 'dispatch', mutation: 'attempted', confirmed: false };
  // A changed/stale implementation between preflight and send may have clicked
  // without attesting the reasoning choice. It is still a possible mutation,
  // never a safe not_attempted result or verified reasoning claim.
  if (command.reasoning !== undefined && !['medium', 'high', 'xhigh'].includes(result.reasoningVerified)) {
    return { kind: 'dispatch', mutation: 'attempted', confirmed: false };
  }
  // The content script observes the committed user turn within the same page.
  // A missing/negative receipt is an outcome-unknown submission, not a retry grant.
  return { kind: 'dispatch', mutation: 'attempted', confirmed: result.confirmed === true,
    ...(result.reasoningVerified ? { reasoningVerified: result.reasoningVerified } : {}) };
}
async function executeFindMarker(command, instanceId) {
  const matches = [];
  for (const tab of await chatgptTabs()) {
    if (!tab.id) continue;
    try {
      const observation = await snapshot(tab.id, { includeUserHistory: true, includePageText: false });
      const identity = core.parseConversation(observation?.url ?? tab.url ?? '');
      if (!identity) continue;
      const texts = [observation.latestUserText, ...(Array.isArray(observation.userMessages) ? observation.userMessages : [])];
      if (!texts.some((text) => String(text ?? '').includes(command.marker))) continue;
      matches.push({ identity: { namespace: 'chatgpt.conversation', conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl }, providerBinding: binding(tab, instanceId), observation });
    } catch { /* an unreadable tab is not negative proof */ }
  }
  return { kind: 'marker_matches', matches };
}
async function executeClose(command, instanceId) {
  const pinned = command.providerBinding;
  if (!pinned?.ownerToken || pinned.providerId !== PROVIDER_ID
    || pinned.providerSessionId !== instanceId || !pinned.tabId || !pinned.windowId)
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_TAB_OWNERSHIP_UNPROVEN', retryable: false };
  const tabId = Number(pinned.tabId);
  if (!Number.isSafeInteger(tabId) || tabId <= 0)
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_TAB_ID_INVALID', retryable: false };
  let tab;
  try { tab = await tabGet(tabId); }
  catch (error) {
    // This exact Chrome profile has already proved the physical tab absent.
    if (/No tab with id/i.test(String(error?.message ?? error))) return { kind: 'closed' };
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_TAB_CLOSE_UNVERIFIED', retryable: true };
  }
  if (String(tab.windowId) !== String(pinned.windowId)
    || await attestedOwnerToken(tab, pinned) !== pinned.ownerToken)
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_TAB_OWNERSHIP_UNPROVEN', retryable: false };
  const identity = command.identity;
  const exactConversation = identity?.namespace === 'chatgpt.conversation'
    && core.parseConversation(tab.url ?? '')?.conversationId === identity.conversationId;
  const exactBootstrap = identity?.namespace === 'chatgpt.bootstrap'
    && (tab.url === identity.projectUrl || (core.projectId(identity.projectUrl)
      && core.projectId(tab.url ?? '') === core.projectId(identity.projectUrl)));
  if (!exactConversation && !exactBootstrap)
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_TAB_IDENTITY_CHANGED', retryable: false };
  try { await tabRemove(tabId); }
  catch { return { kind: 'failed', code: 'COMPUTER_CHATGPT_TAB_CLOSE_UNVERIFIED', retryable: true }; }
  await chrome.storage.session.remove(ownedTabKey(tabId)).catch(() => undefined);
  if (identity.namespace === 'chatgpt.bootstrap' && bootstrapTabs.get(identity.bootstrapKey) === tabId)
    bootstrapTabs.delete(identity.bootstrapKey);
  return { kind: 'closed' };
}
async function executeCommand(command, instanceId) {
  if (!command || typeof command.commandId !== 'string') return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_COMMAND_INVALID', retryable: false, failoverSafe: true };
  if (command.kind === 'ensure') return await executeEnsure(command, instanceId);
  if (command.kind === 'observe') return await executeObserve(command, instanceId);
  if (command.kind === 'prepare') return await executePrepare(command);
  if (command.kind === 'dispatch') return await executeDispatch(command);
  if (command.kind === 'find_marker') return await executeFindMarker(command, instanceId);
  if (command.kind === 'close') return await executeClose(command, instanceId);
  return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_COMMAND_UNKNOWN', retryable: false, failoverSafe: true };
}
async function publishHeartbeat(instanceId) {
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
      providerBinding: binding(tab, instanceId),
    });
  }
  await nativeRpc('computer_extension_heartbeat', { providerId: PROVIDER_ID, providerInstanceId: instanceId, observedAt: new Date().toISOString(), conversations });
}
let providerTickInFlight;
let providerHeartbeatInFlight;
function heartbeatTick() {
  providerHeartbeatInFlight ??= providerInstanceId().then(publishHeartbeat)
    .finally(() => { providerHeartbeatInFlight = undefined; });
  return providerHeartbeatInFlight;
}
async function providerTick() {
  // One claimed command retains the sole mutation lane; it must not also
  // suppress profile heartbeat when a page/Chrome callback is slow or hangs.
  if (providerTickInFlight) { await heartbeatTick(); return; }
  providerTickInFlight = (async () => {
    const instanceId = await providerInstanceId();
    await heartbeatTick();
    // One command per tick keeps heartbeats and other tasks fair. The broker
    // remains the only authority for a claimed Send and its unknown outcome.
    const claim = await nativeRpc('computer_extension_claim', { provider_instance_id: instanceId });
    const command = claim?.command;
    if (!command) return;
    const result = await executeCommand(command, instanceId);
    await nativeRpc('computer_extension_complete', { provider_instance_id: instanceId, command_id: command.commandId, result });
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
  // Discovery and command routing share one persisted Chrome-profile identity.
  const instanceId = await providerInstanceId();
  await nativeRpc('browser_discovery_update', { source: `chrome-extension:${instanceId}`, conversations }).catch(() => undefined);
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
