importScripts('core.js');
const core = globalThis.ForgeComputerChatgptCore;
const NATIVE_HOST = 'com.moretea.forge.workflow_supervisor';
const ALARM = 'forge-computer-chatgpt-provider';
const PROVIDER_ID = 'browser.chrome-extension';
const PROVIDER_TICK_MS = 750;
const DISCOVERY_MIN_INTERVAL_MS = 2_000;
const RPC_TIMEOUT_MS = 30_000;
const HEARTBEAT_DEADLINE_MS = 10_000;
const HEARTBEAT_RPC_TIMEOUT_MS = 6_000;
const TABS_QUERY_TIMEOUT_MS = 5_000;
// The broker budgets 12 seconds for a claimed command; a hung content
// callback must settle earlier without claiming a Send never happened.
const TAB_MESSAGE_TIMEOUT_MS = 7_000;
const bootstrapTabs = new Map();
// Transient per-tab hydration retry spacing, not a Supervisor effect state.
const unreadableConversationTabs = new Map();
const UNREADABLE_CHAT_GRACE_MS = 60_000;
const UNREADABLE_CHAT_RELOAD_INTERVAL_MS = 5 * 60_000;
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let providerInstancePromise;
let providerInstanceCandidate;
function withDeadline(promise, deadlineAt, code) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.reject(new Error(code));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), remainingMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
function providerInstanceId(deadlineAt = Date.now() + HEARTBEAT_DEADLINE_MS) {
  // Profile-local storage survives worker and browser restarts. It identifies
  // this Chrome profile, never a task or an outbound effect.
  // A fresh worker UUID would invalidate every Controller-pinned tab.
  if (!providerInstancePromise) {
    const operation = (async () => {
      const saved = await chrome.storage.local.get('forgeComputerProviderInstanceId');
      if (typeof saved.forgeComputerProviderInstanceId === 'string' && saved.forgeComputerProviderInstanceId) return saved.forgeComputerProviderInstanceId;
      // Reuse the same candidate if a timed-out storage write completes late.
      providerInstanceCandidate ??= randomId();
      await chrome.storage.local.set({ forgeComputerProviderInstanceId: providerInstanceCandidate });
      return providerInstanceCandidate;
    })();
    let attempt;
    attempt = withDeadline(operation, deadlineAt, 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_ID_TIMEOUT').catch((error) => {
      if (providerInstancePromise === attempt) providerInstancePromise = undefined;
      throw error;
    });
    providerInstancePromise = attempt;
  }
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
function invalidateNativePort(port, error) {
  if (nativePort !== port) return;
  nativePort = undefined;
  rejectNativePending(error);
  try { port.disconnect(); } catch { /* already disconnected */ }
  setTimeout(() => { void providerTick().catch(() => undefined); }, 500);
}
function ensureNativePort() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener((response) => {
    if (nativePort !== port) return;
    const pending = pendingNative.get(response?.id);
    if (!pending) return;
    pendingNative.delete(response.id);
    clearTimeout(pending.timer);
    if (response?.ok === true) pending.resolve(response.result ?? {});
    else pending.reject(new Error(response?.error?.message ?? 'COMPUTER_CHATGPT_NATIVE_RPC_FAILED'));
  });
  port.onDisconnect.addListener(() => {
    invalidateNativePort(port, new Error(chrome.runtime.lastError?.message ?? 'COMPUTER_CHATGPT_NATIVE_PORT_DISCONNECTED'));
  });
  return port;
}
function nativeRpc(method, params = {}, timeoutOverrideMs) {
  return new Promise((resolve, reject) => {
    const id = randomId();
    let port;
    const timeoutMs = timeoutOverrideMs ?? (method === 'computer_extension_heartbeat' ? HEARTBEAT_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS);
    const timer = setTimeout(() => {
      const pending = pendingNative.get(id);
      if (!pending) return;
      pendingNative.delete(id);
      pending.reject(new Error(`COMPUTER_CHATGPT_NATIVE_RPC_TIMEOUT:${method}`));
      // One slow request must not cancel a concurrent command/receipt RPC.
      // Retire the shared port only when this was its final pending request.
      if (port && nativePort === port && pendingNative.size === 0) {
        invalidateNativePort(port, new Error(`COMPUTER_CHATGPT_NATIVE_RPC_TIMEOUT:${method}`));
      }
    }, timeoutMs);
    pendingNative.set(id, { resolve, reject, timer });
    try { port = ensureNativePort(); port.postMessage({ id, method, params }); }
    catch (error) {
      if (port && nativePort === port) invalidateNativePort(port, error);
      else { clearTimeout(timer); pendingNative.delete(id); reject(error); }
    }
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
function tabReload(tabId) { return new Promise((resolve, reject) => chrome.tabs.reload(tabId, () => {
  const error = chrome.runtime.lastError;
  if (error) reject(new Error(error.message)); else resolve();
})); }
function boundedTabsQuery(query, deadlineAt = Date.now() + TABS_QUERY_TIMEOUT_MS) {
  const timeoutMs = Math.min(TABS_QUERY_TIMEOUT_MS, deadlineAt - Date.now());
  if (timeoutMs <= 0) return Promise.reject(new Error('COMPUTER_CHATGPT_EXTENSION_TABS_QUERY_TIMEOUT'));
  let timer;
  return Promise.race([
    Promise.resolve().then(() => chrome.tabs.query(query)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('COMPUTER_CHATGPT_EXTENSION_TABS_QUERY_TIMEOUT')), timeoutMs);
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
async function chatgptTabs(deadlineAt) { return await boundedTabsQuery({ url: 'https://chatgpt.com/*' }, deadlineAt); }
// Controller binding owns the durable source identity. This browser-session
// attestation proves that the exact physical tab was created by this extension;
// browser restarts invalidate it rather than permitting tab-id reuse to close
// an unrelated restored/user tab.
function ownedTabKey(tabId) { return `forgeComputerOwnedTabV1:${tabId}`; }
async function attestedOwnerToken(tab, pinnedBinding) {
  // Chrome preserves a tab ID across window moves, so the browser-session
  // token (not the mutable window ID) attests its physical identity.
  if (!pinnedBinding?.ownerToken || String(pinnedBinding.tabId) !== String(tab.id)) return;
  try {
    const key = ownedTabKey(tab.id);
    const stored = await chrome.storage.session.get(key);
    if (stored[key] === pinnedBinding.ownerToken) return pinnedBinding.ownerToken;
  } catch { /* missing browser-session provenance is never closure authority */ }
}
async function requirePinnedOwner(tab, pinnedBinding, identity) {
  const ownerToken = await attestedOwnerToken(tab, pinnedBinding);
  // A reused Chrome tab ID with the same Project or conversation URL is not
  // sufficient authority to adopt a different physical browser tab.
  if (pinnedBinding?.providerId === PROVIDER_ID && pinnedBinding.tabId && !pinnedBinding.ownerToken)
    throw new Error(identity?.namespace === 'chatgpt.bootstrap'
      ? 'COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_MISSING'
      : 'COMPUTER_CHATGPT_EXTENSION_PINNED_OWNER_TOKEN_MISSING');
  if (pinnedBinding?.providerId === PROVIDER_ID && pinnedBinding.ownerToken
    && ownerToken !== pinnedBinding.ownerToken) {
    throw new Error(identity?.namespace === 'chatgpt.bootstrap'
      ? 'COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_MISMATCH'
      : 'COMPUTER_CHATGPT_EXTENSION_PINNED_OWNER_TOKEN_MISMATCH');
  }
  return ownerToken;
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
function bootstrapTabBelongsToProject(tab, identity) {
  if (identity?.namespace !== 'chatgpt.bootstrap') return false;
  const url = String(tab.url ?? '');
  const projectUrl = String(identity.projectUrl ?? '');
  const projectId = core.projectId(projectUrl);
  return url === projectUrl || Boolean(projectId && core.projectId(url) === projectId);
}
function receiverMatchesIdentity(tab, identity) {
  if (identity?.namespace === 'chatgpt.conversation')
    return core.parseConversation(tab.url ?? '')?.conversationId === identity.conversationId;
  // A Project conversation can share the bootstrap Project id. It is not
  // an unsent bootstrap receiver and must never be rebound as one.
  return bootstrapTabBelongsToProject(tab, identity)
    && !core.parseConversation(tab.url ?? '');
}
async function restoreExactContentReceiver(tabId, identity) {
  // The physical tab is already resolved by the one Computer target authority.
  // A missing MV3 message receiver is not permission to reload/navigate that tab,
  // replace its draft, or create another tab. Inject only read-only listeners on
  // this SAME proven conversation/Project, then verify its identity again.
  const matches = (tab) => receiverMatchesIdentity(tab, identity);
  // A retained bootstrap pin may now show a conversation in this Project.
  // Restore observation on that same physical tab so the bootstrap owner can
  // detect and retire it before Send. Receiver hydration grants no Send or
  // identity promotion; bootstrapTask still rejects existing conversations.
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
function isMissingContentReceiver(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(String(error?.message ?? error));
}
// A pinned bootstrap tab becomes a conversation after its first successful
// Send. For marker reconciliation ONLY, hydrate a missing read receiver against
// the new exact conversation while retaining the original physical tab pin.
// Bootstrap preparation and all Send paths still reject migrated tabs.
function markerReconciliationReadIdentity(tab, bootstrapIdentity) {
  if (bootstrapIdentity?.namespace !== 'chatgpt.bootstrap') return bootstrapIdentity;
  const conversation = core.parseConversation(tab?.url ?? '');
  const projectId = core.projectId(bootstrapIdentity.projectUrl);
  if (!conversation || !projectId || core.projectId(tab?.url ?? '') !== projectId) return bootstrapIdentity;
  return { namespace: 'chatgpt.conversation', conversationId: conversation.conversationId,
    canonicalUrl: conversation.canonicalUrl };
}
async function snapshotWithExactReceiverRecovery(tabId, identity, options = {}) {
  try { return await snapshot(tabId, options); }
  catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
    // Restore only the exact physical tab's read-only listener, never Send.
    await restoreExactContentReceiver(tabId, identity);
    return await snapshot(tabId, options);
  }
}
async function waitForContent(tabId, requireBootstrapUi = false, recoverReceiver) {
  let lastError;
  let recoveryAttempted = false;
  // Bootstrap is a new provider page: seeing its URL proves location, not
  // that the React composer is hydrated. The Supervisor uses the user's
  // exact target page readiness. Bound this wait below the
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
      if (!recoveryAttempted && recoverReceiver && isMissingContentReceiver(error)) {
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
    const belongsToProject = (tab) => bootstrapTabBelongsToProject(tab, identity);
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
async function resolveTarget(identity, createIfMissing, pinnedBinding, instanceId) {
  // A provider switch or incomplete legacy pin must not silently fall back
  // to the extension's cached Bootstrap tab, nor allocate a new Send target.
  if (pinnedBinding != null) {
    if (pinnedBinding.providerId !== PROVIDER_ID)
      throw new Error('COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH');
    if (pinnedBinding.tabId && !pinnedBinding.ownerToken)
      throw new Error(identity?.namespace === 'chatgpt.bootstrap'
        ? 'COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_MISSING'
        : 'COMPUTER_CHATGPT_EXTENSION_PINNED_OWNER_TOKEN_MISSING');
    if (!pinnedBinding.tabId || !pinnedBinding.windowId || !pinnedBinding.ownerToken)
      throw new Error('COMPUTER_CHATGPT_EXTENSION_PINNED_BINDING_INCOMPLETE');
    // Tab ID and Token cannot authorize a different Chrome profile/session.
    // Reject before lookup, snapshot or any possible Send.
    if (!instanceId || !pinnedBinding.providerSessionId
      || pinnedBinding.providerSessionId !== instanceId)
      throw new Error('COMPUTER_CHATGPT_EXTENSION_PROVIDER_SESSION_MISMATCH');
  } else if (identity?.namespace === 'chatgpt.bootstrap' && bootstrapTabs.has(identity.bootstrapKey)) {
    // A same-worker map never authorizes Prepare/Dispatch or URL-only adoption.
    // Ensure may only reconstruct a Controller pin when this exact task's
    // mapped physical tab is still on the bootstrap Project AND the same
    // browser session proves the owner token written when that tab was created.
    // This closes the crash/lost-receipt window after tabCreate but before the
    // Controller persisted providerBinding, without creating or sending again.
    if (!createIfMissing) throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_BINDING_REQUIRED');
    const mappedId = bootstrapTabs.get(identity.bootstrapKey);
    const currentTabs = await chatgptTabs();
    const mapped = currentTabs.find((tab) => tab.id === mappedId);
    if (mapped && receiverMatchesIdentity(mapped, identity)) {
      let ownerToken;
      try {
        const stored = await chrome.storage.session.get(ownedTabKey(mapped.id));
        ownerToken = stored[ownedTabKey(mapped.id)];
      } catch { /* absence is not ownership proof */ }
      if (typeof ownerToken !== 'string' || !ownerToken)
        throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_BINDING_REQUIRED');
      return { tab: mapped, created: false, ownerToken };
    }
    // After a completed bootstrap migration the pinned tab can be a /c/...
    // conversation (or have closed), while this MV3 worker still remembers
    // its old bootstrap id. The Controller no longer owns a bootstrap pin.
    // Retire ONLY this stale in-worker hint; never close/adopt/navigate its
    // former tab. A fresh Ensure must still create and attest its own tab
    // before the Controller can bind it and authorize any Send.
    bootstrapTabs.delete(identity.bootstrapKey);
  }
  const tabs = await chatgptTabs();
  let staleUnattestedConversationPin = false;
  if (identity?.namespace === 'chatgpt.conversation' && pinnedBinding?.providerId === PROVIDER_ID && pinnedBinding.tabId) {
    // Window moves preserve Chrome's profile-local tab id. A vanished id may
    // be recovered by exact conversation, but an existing tab at another URL
    // is not ours to reuse or alter; Ensure may create a separate owned tab.
    let pinned;
    try { pinned = await tabGet(Number(pinnedBinding.tabId)); }
    catch (error) {
      if (!/No tab with id/i.test(String(error?.message ?? error))) throw error;
    }
    if (pinned) {
      if (core.parseConversation(pinned.url ?? '')?.conversationId !== identity.conversationId) {
        if (!createIfMissing) throw new Error('COMPUTER_CHATGPT_EXTENSION_PINNED_TAB_IDENTITY_CHANGED');
        staleUnattestedConversationPin = true;
      }
      if (!staleUnattestedConversationPin) {
        try {
          return { tab: pinned, created: false, ownerToken: await requirePinnedOwner(pinned, pinnedBinding, identity) };
        } catch (error) {
          if (!createIfMissing || String(error?.message ?? error) !== 'COMPUTER_CHATGPT_EXTENSION_PINNED_OWNER_TOKEN_MISMATCH')
            throw error;
          // The old physical tab is NOT ours to observe, close or navigate.
          // Ensure alone may create a NEW owned tab for this exact conversation
          // and return its attested identity to the Controller's leased binder.
          // Prepare/Dispatch still reject the stale owner token; no Send occurs.
          staleUnattestedConversationPin = true;
        }
      }
    }
  }
  // An exact Conversation URL proves page identity, not ownership of the
  // physical tab. First-time Ensure can create a dedicated attested tab;
  // Prepare and Dispatch cannot borrow an existing user's unbound tab.
  const trustedConversationPin = identity?.namespace === 'chatgpt.conversation'
    && pinnedBinding?.providerId === PROVIDER_ID && pinnedBinding.tabId && pinnedBinding.ownerToken;
  const matches = identity?.namespace === 'chatgpt.conversation' && (!trustedConversationPin || staleUnattestedConversationPin)
    ? [] : matchingTabs(tabs, identity, pinnedBinding);
  if (matches.length > 1) throw new Error('COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_AMBIGUOUS');
  if (matches.length === 1) {
    const tab = matches[0];
    const ownerToken = await requirePinnedOwner(tab, pinnedBinding, identity);
    if (identity.namespace === 'chatgpt.bootstrap') bootstrapTabs.set(identity.bootstrapKey, tab.id);
    return { tab, created: false, ownerToken };
  }
  if (identity?.namespace === 'chatgpt.bootstrap' && pinnedBinding?.providerId === PROVIDER_ID
    && pinnedBinding.tabId && pinnedBinding.windowId) {
    throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING');
  }
  if (!createIfMissing) return undefined;
  const url = identity.namespace === 'chatgpt.conversation' ? identity.canonicalUrl : identity.projectUrl;
  const tab = await tabCreate(url);
  const token = randomId();
  const key = ownedTabKey(tab.id);
  try {
    await chrome.storage.session.set({ [key]: token });
    const stored = await chrome.storage.session.get(key);
    if (stored[key] !== token) throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_UNAVAILABLE');
  } catch {
    // Preserve the visible tab, but neither a Controller binding nor an
    // in-worker map may adopt an unverified physical tab or enable Send.
    throw new Error('COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_UNAVAILABLE');
  }
  if (identity.namespace === 'chatgpt.bootstrap') bootstrapTabs.set(identity.bootstrapKey, tab.id);
  return { tab, created: true, ownerToken: token };
}
function dispatchTransportNotReached(error) {
  const text = String(error?.message ?? error);
  return /Receiving end does not exist|Could not establish connection|No tab with id/i.test(text);
}
function shouldReloadUnreadableConversation(tabId, identity, observation, nowMs = Date.now()) {
  const unreadable = identity?.namespace === 'chatgpt.conversation'
    && typeof observation?.url === 'string'
    && core.parseConversation(observation.url)?.conversationId === identity.conversationId
    && /(?:无法加载此 ChatGPT 对话|Unable to load this (?:ChatGPT )?conversation)/i.test(observation.providerFailureText ?? '')
    && !observation.latestUserText?.trim() && !observation.latestAssistantResponse?.trim()
    && !observation.composerText?.trim() && observation.isGenerating !== true;
  if (!unreadable) {
    const prior = unreadableConversationTabs.get(tabId);
    if (prior) prior.firstObservedAt = undefined;
    return false;
  }
  const prior = unreadableConversationTabs.get(tabId) ?? { firstObservedAt: nowMs, lastReloadAt: -Infinity };
  prior.firstObservedAt ??= nowMs;
  unreadableConversationTabs.set(tabId, prior);
  if (nowMs - prior.firstObservedAt < UNREADABLE_CHAT_GRACE_MS
    || nowMs - prior.lastReloadAt < UNREADABLE_CHAT_RELOAD_INTERVAL_MS) return false;
  prior.lastReloadAt = nowMs;
  return true;
}
async function executeEnsure(command, instanceId) {
  let target;
  try {
    target = await resolveTarget(command.identity, true, command.providerBinding, instanceId);
    // Created and already-bound tabs share one exact-identity receiver repair.
    // The editor must hydrate before 'ensured'; on failure the existing typed
    // failed receipt still carries this tab's binding without permitting Send.
    let observation = await waitForContent(target.tab.id, command.identity.namespace === 'chatgpt.bootstrap',
      () => restoreExactContentReceiver(target.tab.id, command.identity));
    if (shouldReloadUnreadableConversation(target.tab.id, command.identity, observation)) {
      // Reload ONLY the already-attested exact physical tab, after the same
      // error has remained visible for a minute. No new tab, Send or effect
      // dispatch is permitted by this read-only page recovery.
      const before = await tabGet(target.tab.id);
      if (!receiverMatchesIdentity(before, command.identity))
        throw new Error('COMPUTER_CHATGPT_EXTENSION_RECEIVER_TARGET_CHANGED');
      await tabReload(target.tab.id);
      observation = await waitForContent(target.tab.id, false,
        () => restoreExactContentReceiver(target.tab.id, command.identity));
    }
    const refreshed = await tabGet(target.tab.id);
    if (!receiverMatchesIdentity(refreshed, command.identity))
      throw new Error('COMPUTER_CHATGPT_EXTENSION_RECEIVER_TARGET_CHANGED');
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
    const target = await resolveTarget(command.identity, false, command.providerBinding, instanceId);
    if (!target) return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING', retryable: true, failoverSafe: true };
    const observation = await snapshotWithExactReceiverRecovery(target.tab.id, command.identity, command.options ?? {});
    const refreshed = await tabGet(target.tab.id);
    if (!receiverMatchesIdentity(refreshed, command.identity))
      throw new Error('COMPUTER_CHATGPT_EXTENSION_RECEIVER_TARGET_CHANGED');
    return { kind: 'observation', providerBinding: binding(refreshed, instanceId, await attestedOwnerToken(refreshed, command.providerBinding)), observation };
  } catch (error) {
    return { kind: 'failed', code: String(error?.message ?? error).split(':')[0] || 'COMPUTER_CHATGPT_EXTENSION_OBSERVE_FAILED', retryable: true, failoverSafe: true };
  }
}
function targetResolutionReasonCode(error) {
  const code = String(error?.message ?? error).split(':')[0];
  // Preserve only stable local target-refusal codes, never arbitrary message
  // content or a transport-failure claim of whether Send was attempted.
  return /^COMPUTER_CHATGPT_[A-Z0-9_]+$/.test(code)
    ? code : 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING';
}
async function executePrepare(command, instanceId) {
  let target;
  try { target = await resolveTarget(command.identity, false, command.providerBinding, instanceId); }
  catch (error) { return { kind: 'prepared', ready: false, reasonCode: targetResolutionReasonCode(error) }; }
  if (!target) return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING' };
  const expectedProjectId = command.identity?.namespace === 'chatgpt.bootstrap' ? core.projectId(command.identity.projectUrl) : undefined;
  if (command.identity?.namespace === 'chatgpt.bootstrap' && !expectedProjectId)
    return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_UNPROVEN' };
  const requiresDraftReplacement = typeof command.prompt === 'string' && command.prompt.startsWith('<<<FORGE_DRAFT_REPLACE_V1:');
  const requiresRecoveryCapability = command.mode === 'recover' && command.identity?.namespace === 'chatgpt.conversation';
  if (expectedProjectId || requiresDraftReplacement || requiresRecoveryCapability) {
    let capability;
    try { capability = await tabMessage(target.tab.id, { type: 'forge-computer-chatgpt-capabilities' }); }
    catch { return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_CONTENT_CAPABILITIES_UNAVAILABLE' }; }
    // Older content scripts ignore expectedProjectId. No bootstrap draft/send
    // may cross this version boundary without target verification.
    if (expectedProjectId && capability?.bootstrapTargetGuard !== 'project-checked-before-send-v1')
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' };
    if (requiresDraftReplacement && capability?.composerReplacementContract !== 'exact-backed-up-project-draft-v1')
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_LOADED_SCRIPT_STALE' };
    if (requiresRecoveryCapability && capability?.recoveryCapability !== 'recover-no-stop-prewrite-v1')
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_RECOVERY_CAPABILITY_UNSUPPORTED' };
  }
  try {
    const result = await tabMessage(target.tab.id, {
      type: 'forge-computer-chatgpt-prepare', prompt: command.prompt, mode: command.mode,
      ...(command.identity?.namespace === 'chatgpt.conversation' ? { expectedConversationId: command.identity.conversationId } : {}),
      ...(expectedProjectId ? { expectedProjectId } : {}),
    });
    if (result?.prepared !== true) return { kind: 'prepared', ready: false, reasonCode: String(result?.reason ?? 'COMPUTER_CHATGPT_EXTENSION_PREPARE_REJECTED') };
    if (requiresRecoveryCapability && result?.recoveryCapability !== 'recover-no-stop-prewrite-v1')
      return { kind: 'prepared', ready: false, reasonCode: 'COMPUTER_CHATGPT_RECOVERY_CAPABILITY_UNSUPPORTED' };
    return { kind: 'prepared', ready: true, ...(requiresRecoveryCapability ? { recoveryCapability: result.recoveryCapability } : {}) };
  } catch (error) {
    // Prepare has not clicked Send. Preserve the transport reason for the
    // Supervisor's exact-effect recovery instead of masking a receiver loss
    // or a timed-out content script as a generic infrastructure failure.
    const reasonCode = String(error?.message ?? error) === 'COMPUTER_CHATGPT_EXTENSION_TAB_MESSAGE_TIMEOUT'
      ? 'COMPUTER_CHATGPT_EXTENSION_TAB_MESSAGE_TIMEOUT'
      : isMissingContentReceiver(error)
        ? 'COMPUTER_CHATGPT_EXTENSION_CONTENT_UNAVAILABLE'
        : 'COMPUTER_CHATGPT_EXTENSION_PREPARE_UNAVAILABLE';
    return { kind: 'prepared', ready: false, reasonCode };
  }
}
async function executeDispatch(command, instanceId) {
  let target;
  try { target = await resolveTarget(command.identity, false, command.providerBinding, instanceId); }
  catch (error) { return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: targetResolutionReasonCode(error) }; }
  if (!target) return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING' };
  const expectedProjectId = command.identity?.namespace === 'chatgpt.bootstrap' ? core.projectId(command.identity.projectUrl) : undefined;
  if (command.identity?.namespace === 'chatgpt.bootstrap' && !expectedProjectId)
    return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_UNPROVEN' };
  // An old tab may still contain a pre-upgrade content script after the
  // extension/runtime has been upgraded. Probe the *exact target tab* before
  // submitting; a background/version heartbeat alone cannot prove it.
  const requiresRecoveryCapability = command.mode === 'recover' && command.identity?.namespace === 'chatgpt.conversation';
  if (expectedProjectId || requiresRecoveryCapability) {
    let capability;
    try { capability = await tabMessage(target.tab.id, { type: 'forge-computer-chatgpt-capabilities' }); }
    catch { return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_CONTENT_CAPABILITIES_UNAVAILABLE' }; }
    if (expectedProjectId && capability?.bootstrapTargetGuard !== 'project-checked-before-send-v1')
      return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' };
    if (requiresRecoveryCapability && capability?.recoveryCapability !== 'recover-no-stop-prewrite-v1')
      return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_RECOVERY_CAPABILITY_UNSUPPORTED' };
  }
  let result;
  try { result = await tabMessage(target.tab.id, {
    type: 'forge-computer-chatgpt-dispatch', prompt: command.prompt, mode: command.mode,
    ...(command.identity?.namespace === 'chatgpt.conversation' ? { expectedConversationId: command.identity.conversationId } : {}),
    ...(expectedProjectId ? { expectedProjectId } : {}),
  }); }
  catch (error) {
    return dispatchTransportNotReached(error)
      ? { kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'COMPUTER_CHATGPT_EXTENSION_CONTENT_UNAVAILABLE' }
      : { kind: 'dispatch', mutation: 'attempted' };
  }
  if (result?.dispatched === false) {
    const rawProof = result?.prewriteNoMutationProof;
    const reason = String(result?.reason ?? 'COMPUTER_CHATGPT_EXTENSION_PRE_MUTATION_REJECTION');
    const proofReasonAllowed = reason === 'provider_recovery_turn_unknown' || reason === 'provider_recovery_turn_live';
    const ownerToken = typeof target.ownerToken === 'string' ? target.ownerToken : '';
    const recoveryCapability = requiresRecoveryCapability && result?.recoveryCapability === 'recover-no-stop-prewrite-v1'
      ? result.recoveryCapability : undefined;
    const prewriteNoMutationReceipt = recoveryCapability && proofReasonAllowed
      && rawProof?.kind === 'prewrite_no_mutation_proof'
      && rawProof?.phase === 'prewrite_or_preclick'
      && rawProof?.editor_touched === false && rawProof?.stop_clicked === false && rawProof?.send_clicked === false
      && rawProof?.loaded_capability === recoveryCapability
      && Number.isSafeInteger(rawProof?.issued_at_ms) && Math.abs(Date.now() - rawProof.issued_at_ms) <= 30_000
      && ownerToken && String(target.tab?.id) && String(target.tab?.windowId)
      ? {
          kind: 'prewrite_no_mutation_proof', phase: 'prewrite_or_preclick', reason,
          issued_at_ms: rawProof.issued_at_ms, editor_touched: false, stop_clicked: false, send_clicked: false,
          loaded_capability: 'recover-no-stop-prewrite-v1', provider_id: PROVIDER_ID,
          provider_instance_id: instanceId, command_id: command.commandId,
          provider_session_id: String(command.providerBinding?.providerSessionId ?? instanceId),
          profile_id: instanceId, window_id: String(target.tab.windowId), tab_id: String(target.tab.id), owner_token: ownerToken,
        }
      : undefined;
    return { kind: 'dispatch', mutation: 'not_attempted', reasonCode: reason,
      ...(recoveryCapability ? { recoveryCapability } : {}),
      ...(prewriteNoMutationReceipt ? { prewriteNoMutationReceipt } : {}) };
  }
  // A missing/malformed reply after dispatch crossed the content-script boundary
  // is not an attestation that Send never ran.
  if (result?.dispatched !== true) return { kind: 'dispatch', mutation: 'attempted', confirmed: false };
  // The content script observes the committed user turn within the same page.
  // A missing/negative receipt is an outcome-unknown submission, not a retry grant.
  return { kind: 'dispatch', mutation: 'attempted', confirmed: result.confirmed === true, ...(requiresRecoveryCapability && result?.recoveryCapability === 'recover-no-stop-prewrite-v1' ? { recoveryCapability: result.recoveryCapability } : {}) };
}
async function executeFindMarker(command, instanceId) {
  const pinnedBinding = command.providerBinding;
  // Discovery can read unrelated browser pages, but must never convert an
  // explicit other-Provider binding into Chrome's actionable owner identity.
  // Reject before any Chrome tab query or marker scan.
  if (pinnedBinding != null && pinnedBinding.providerId !== PROVIDER_ID)
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH', retryable: false };
  if (pinnedBinding != null && (!pinnedBinding.providerSessionId
    || pinnedBinding.providerSessionId !== instanceId))
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_SESSION_MISMATCH', retryable: false };
  const matches = [];
  let pinnedTarget;
  if (command.identity?.namespace === 'chatgpt.bootstrap'
    && pinnedBinding?.providerId === PROVIDER_ID
    && pinnedBinding.providerSessionId === instanceId
    && pinnedBinding.tabId && pinnedBinding.windowId) {
    try { pinnedTarget = await resolveTarget(command.identity, false, pinnedBinding, instanceId); }
    catch (error) { return { kind: 'failed', code: targetResolutionReasonCode(error), retryable: false }; }
  }
  // A malformed command with a pin but no bootstrap identity must not fall
  // through to discovery of unrelated tabs.
  if (pinnedBinding && !pinnedTarget)
    return { kind: 'failed', code: 'COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING', retryable: false };
  const tabs = await chatgptTabs();
  const pinnedTabId = pinnedTarget ? String(pinnedTarget.tab.id) : undefined;
  // A persisted pin is the only acceptable result for this bootstrap. Do not
  // let unrelated tabs exhaust the broker timeout after that result is found.
  const orderedTabs = pinnedBinding ? (pinnedTarget ? [pinnedTarget.tab] : []) : tabs;
  for (const tab of orderedTabs) {
    if (!tab.id) continue;
    const pinned = Boolean(pinnedTarget && String(tab.id) === pinnedTabId);
    try {
      const readIdentity = pinned
        ? markerReconciliationReadIdentity(await tabGet(tab.id), command.identity) : undefined;
      const observation = pinned
        ? await snapshotWithExactReceiverRecovery(tab.id, readIdentity, { includeUserHistory: true, includePageText: false })
        : await snapshot(tab.id, { includeUserHistory: true, includePageText: false });
      const observedTab = pinned ? await tabGet(tab.id) : tab;
      if (pinned && !receiverMatchesIdentity(observedTab, readIdentity))
        throw new Error('COMPUTER_CHATGPT_EXTENSION_RECEIVER_TARGET_CHANGED');
      const identity = core.parseConversation(observation?.url ?? observedTab.url ?? '');
      if (!identity) continue;
      const texts = [observation.latestUserText, ...(Array.isArray(observation.userMessages) ? observation.userMessages : [])];
      if (!texts.some((text) => String(text ?? '').includes(command.marker))) continue;
      // Only the originally pinned physical tab can re-attest its session
      // ownerToken. Never copy the token to a same-URL or another-profile tab.
      const ownerToken = command.providerBinding?.providerId === PROVIDER_ID
        && String(command.providerBinding.tabId) === String(tab.id)
        && command.providerBinding.providerSessionId === instanceId
        ? await attestedOwnerToken(tab, command.providerBinding) : undefined;
      matches.push({ identity: { namespace: 'chatgpt.conversation', conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl }, providerBinding: binding(observedTab, instanceId, ownerToken), observation });
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
  if (command.kind === 'prepare') return await executePrepare(command, instanceId);
  if (command.kind === 'dispatch') return await executeDispatch(command, instanceId);
  if (command.kind === 'find_marker') return await executeFindMarker(command, instanceId);
  if (command.kind === 'close') return await executeClose(command, instanceId);
  return { kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_COMMAND_UNKNOWN', retryable: false, failoverSafe: true };
}
async function publishHeartbeat() {
  const deadlineAt = Date.now() + HEARTBEAT_DEADLINE_MS;
  const instanceId = await providerInstanceId(deadlineAt);
  const [tabs, [current]] = await Promise.all([
    chatgptTabs(deadlineAt),
    boundedTabsQuery({ active: true, lastFocusedWindow: true, url: 'https://chatgpt.com/*' }, deadlineAt),
  ]);
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
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('COMPUTER_CHATGPT_EXTENSION_HEARTBEAT_DEADLINE_EXCEEDED');
  await nativeRpc('computer_extension_heartbeat', { providerId: PROVIDER_ID, providerInstanceId: instanceId, observedAt: new Date().toISOString(), conversations }, Math.min(HEARTBEAT_RPC_TIMEOUT_MS, remainingMs));
  return instanceId;
}
let providerTickInFlight;
let providerHeartbeatInFlight;
function heartbeatTick() {
  providerHeartbeatInFlight ??= publishHeartbeat()
    .finally(() => { providerHeartbeatInFlight = undefined; });
  return providerHeartbeatInFlight;
}
async function providerTick() {
  // One claimed command retains the sole mutation lane; it must not also
  // suppress profile heartbeat when a page/Chrome callback is slow or hangs.
  if (providerTickInFlight) { await heartbeatTick(); return; }
  providerTickInFlight = (async () => {
    const instanceId = await heartbeatTick();
    // One command per tick keeps heartbeats and other tasks fair. The broker
    // remains the only authority for a claimed Send and its unknown outcome.
    const claim = await nativeRpc('computer_extension_claim', { provider_instance_id: instanceId });
    const command = claim?.command;
    if (!command) return;
    const result = await executeCommand(command, instanceId);
    const completion = await nativeRpc('computer_extension_complete', { provider_instance_id: instanceId, command_id: command.commandId, result });
    if (completion?.recorded !== true) {
      console.warn('COMPUTER_CHATGPT_EXTENSION_COMMAND_COMPLETION_NOT_RECORDED', {
        commandId: command.commandId, kind: command.kind, conversationId: command.identity?.conversationId,
      });
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
  const [current] = await boundedTabsQuery({ active: true, lastFocusedWindow: true, url: 'https://chatgpt.com/*' });
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
chrome.tabs.onRemoved.addListener((tabId) => { unreadableConversationTabs.delete(tabId); void providerTick().catch(() => undefined); scheduleDiscovery(); });
chrome.windows.onFocusChanged.addListener(() => { void providerTick().catch(() => undefined); scheduleDiscovery(); });
chrome.alarms.create(ALARM, { periodInMinutes: 1 });
setInterval(() => { void providerTick().catch(() => undefined); }, PROVIDER_TICK_MS);
void providerTick().catch(() => undefined);
scheduleDiscovery();
