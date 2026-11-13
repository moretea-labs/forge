#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeBrowserPluginAction,
  resetBrowserPluginRuntimeHooksForTest,
  setBrowserPluginRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-adapter';
import {
  invalidateMacOsBrowserPageHandles,
  listMacOsBrowserTabs,
  type MacOsBrowserProduct,
} from '../../src/runtime/plugins/browser-macos-bridge';
import { callBrowserAutomationBroker } from '../../src/runtime/plugins/browser-automation-service';
import { disposeRuntimeComputerComposition } from '../../src/runtime/root/computer-composition';
import { writeControllerPluginConfig } from '../../src/runtime/plugins/config-store';

if (process.platform !== 'darwin') throw new Error('Browser Runtime V3 live E2E requires macOS.');

const separator = String.fromCharCode(30);
const repoRoot = mkdtempSync(join(tmpdir(), 'forge-browser-v3-live-'));
const controllerHome = mkdtempSync(join(tmpdir(), 'forge-browser-v3-controller-'));
const requestedProducts = (process.env.FORGE_BROWSER_V3_PRODUCTS ?? 'chrome,vivaldi')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter((value): value is MacOsBrowserProduct => value === 'chrome' || value === 'vivaldi');
const requireCompetingForeground = process.env.FORGE_BROWSER_V3_REQUIRE_COMPETING_FOREGROUND === '1';
const requireDomAll = process.env.FORGE_BROWSER_V3_REQUIRE_DOM_ALL === '1';
const samplesPerProduct = Math.max(3, Math.min(Number(process.env.FORGE_BROWSER_V3_SAMPLES ?? 5), 20));
type OwnedTabRef = { windowId: string; tabId: string };
type OpenSession = { product: MacOsBrowserProduct; ref?: OwnedTabRef };
const openSessions = new Map<string, OpenSession>();
const attemptedSessionCloses = new Set<string>();
const attemptedBrokerTabCloses = new Set<string>();
const cleanupReceipts: Array<Record<string, unknown>> = [];
const cleanupFailures: Array<Record<string, unknown>> = [];
let safeProviderRetries = 0;
let testCompleted = false;
const brokerOwnedTabs: Array<{ product: MacOsBrowserProduct; ref: OwnedTabRef }> = [];
const report: Record<string, unknown> = { schemaVersion: 1, source: 'current-worktree', products: {} };
let server: ReturnType<typeof Bun.serve> | undefined;

interface BrokerMetadata {
  frontmost: boolean;
  url: string;
  title: string;
  windowId?: string;
  tabId?: string;
  active: boolean;
  loading: boolean;
}

function percentile(samples: number[], p: number): number {
  assert(samples.length > 0, 'percentile requires samples');
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[index]! * 10) / 10;
}

function parseMetadata(value: unknown): BrokerMetadata {
  const parts = String(value ?? '').split(separator);
  assert(parts.length >= 7, `incomplete broker metadata: ${String(value)}`);
  return {
    frontmost: parts[0]?.toLowerCase() === 'true',
    url: parts[1] ?? '',
    title: parts[2] ?? '',
    windowId: parts[7] || undefined,
    tabId: parts[8] || undefined,
    active: parts.length >= 10 ? parts[9]?.toLowerCase() === 'true' : true,
    loading: parts.length >= 11 ? parts[10]?.toLowerCase() === 'true' : false,
  };
}

async function productMetadata(product: MacOsBrowserProduct): Promise<BrokerMetadata> {
  return parseMetadata((await callBrowserAutomationBroker({ action: 'metadata', product }, 15_000)).value);
}

async function exactMetadata(product: MacOsBrowserProduct, ref: { windowId: string; tabId: string }): Promise<BrokerMetadata> {
  return parseMetadata((await callBrowserAutomationBroker({ action: 'metadata', product, ref }, 15_000)).value);
}

function assertActiveUserTabPreserved(product: MacOsBrowserProduct, before: BrokerMetadata, after: BrokerMetadata, stage: string): void {
  if (before.windowId && before.tabId && after.windowId && after.tabId) {
    assert.equal(after.windowId, before.windowId, `${product} active user window changed during ${stage}`);
    assert.equal(after.tabId, before.tabId, `${product} active user tab changed during ${stage}`);
    return;
  }
  assert.equal(after.url, before.url, `${product} active user URL changed during ${stage}`);
  assert.equal(after.title, before.title, `${product} active user title changed during ${stage}`);
}

function resultSessionId(result: Record<string, unknown>): string {
  const session = result.session as Record<string, unknown> | undefined;
  const sessionId = session?.sessionId;
  assert.equal(typeof sessionId, 'string', 'missing Browser session id');
  return sessionId as string;
}

function resultTabRef(result: Record<string, unknown>): { windowId: string; tabId: string } {
  const connection = result.browserConnection as Record<string, unknown> | undefined;
  const tab = connection?.tab as Record<string, unknown> | undefined;
  if (!tab) throw new Error('missing native browser tab metadata');
  assert.equal(typeof tab.windowId, 'string', 'missing native windowId');
  assert.equal(typeof tab.tabId, 'string', 'missing native tabId');
  return { windowId: tab.windowId as string, tabId: tab.tabId as string };
}

async function action(actionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await executeBrowserPluginAction({
        controllerHome,
        repoId: 'browser-v3-live',
        repoRoot,
        pluginId: 'browser',
        actionId,
        requestId: `browser-v3-live-${actionId}-${crypto.randomUUID()}`,
        args,
        origin: { surface: 'local-ui', actor: 'browser-v3-live' },
      });
    } catch (error) {
      const providerFailure = error as { code?: unknown; retryable?: unknown; effectOutcome?: unknown };
      const safeSerializationRetry = providerFailure.code === 'BROWSER_AUTOMATION_SERIALIZATION_BUSY'
        && providerFailure.retryable === true
        && providerFailure.effectOutcome === 'failed';
      if (!safeSerializationRetry || attempt === 3) throw error;
      safeProviderRetries += 1;
      await Bun.sleep(100 * attempt);
    }
  }
  throw new Error('Browser action retry loop exhausted unexpectedly.');
}

function cleanupErrorSummary(error: unknown): Record<string, unknown> {
  const value = error as { code?: unknown; effectOutcome?: unknown; retryable?: unknown };
  return {
    code: value.code ?? null,
    effectOutcome: value.effectOutcome ?? null,
    retryable: value.retryable ?? null,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

async function closeOwnedSession(sessionId: string): Promise<Record<string, unknown>> {
  const owner = openSessions.get(sessionId);
  if (!owner) return { closed: true, alreadyClosed: true };
  if (attemptedSessionCloses.has(sessionId)) throw new Error(`Refusing to replay an attempted close for ${sessionId}.`);
  attemptedSessionCloses.add(sessionId);

  let result: Record<string, unknown> | undefined;
  let actionError: unknown;
  try {
    result = await action('close_session', { session_id: sessionId });
  } catch (error) {
    actionError = error;
  }
  const providerClosed = result?.closed === true
    && (result.resourceClosed === true || result.resourceAlreadyMissing === true || result.preservedUserOwnedTab === true);
  if (actionError || !result || !providerClosed) {
    let verifiedAbsent = false;
    let inventoryError: unknown;
    if (owner.ref) {
      try {
        const inventory = await listMacOsBrowserTabs(owner.product, 10_000, { correctFrontmost: false });
        if (inventory.truncated) throw new Error(`Cannot reconcile ${sessionId}: native tab inventory is truncated.`);
        verifiedAbsent = !inventory.tabs.some((tab) => tab.windowId === owner.ref!.windowId && tab.tabId === owner.ref!.tabId);
      } catch (error) {
        inventoryError = error;
      }
    }
    if (verifiedAbsent) {
      cleanupReceipts.push({ kind: 'session', sessionId, closeActionOutcome: actionError ? cleanupErrorSummary(actionError) : 'postcondition_unproven', reconciledByInventory: true, verifiedAbsent: true });
      openSessions.delete(sessionId);
      return { closed: true, resourceClosed: true, reconciledByInventory: true };
    }
    cleanupFailures.push({
      kind: 'session', sessionId,
      ...(actionError ? cleanupErrorSummary(actionError) : {
        code: 'BROWSER_SESSION_CLOSE_POSTCONDITION_UNPROVEN',
        effectOutcome: 'outcome_unknown', retryable: false,
        message: 'Provider did not prove owned session resource closure.',
      }),
      reconciliation: inventoryError ? cleanupErrorSummary(inventoryError) : owner.ref ? 'exact_owned_tab_still_present' : 'exact_owned_tab_ref_unavailable',
    });
    throw actionError ?? new Error('Provider did not prove owned session resource closure.');
  }

  cleanupReceipts.push({
    kind: 'session', sessionId, closed: true,
    resourceClosed: result.resourceClosed === true,
    resourceAlreadyMissing: result.resourceAlreadyMissing === true,
    preservedUserOwnedTab: result.preservedUserOwnedTab === true,
  });
  openSessions.delete(sessionId);
  return result;
}

async function createBrokerTab(product: MacOsBrowserProduct, url: string): Promise<OwnedTabRef> {
  let created: Record<string, unknown>;
  try {
    created = await callBrowserAutomationBroker({ action: 'create_tab', product, url }, 15_000);
  } catch (error) {
    const summary = cleanupErrorSummary(error);
    if (summary.effectOutcome !== 'failed') {
      cleanupFailures.push({ kind: 'tab', product, ...summary, reconciliation: 'create_tab_outcome_unknown_without_exact_ref' });
    }
    throw error;
  }
  const [legacyWindowId, legacyTabId] = String(created.value ?? '').split(separator);
  const structuredRef = created.ref as Record<string, unknown> | undefined;
  const navigation = created.navigation as Record<string, unknown> | undefined;
  if (structuredRef && typeof structuredRef.windowId === 'string' && typeof structuredRef.tabId === 'string') {
    const ref = { windowId: structuredRef.windowId, tabId: structuredRef.tabId };
    brokerOwnedTabs.push({ product, ref });
    assert.equal(structuredRef.windowId, legacyWindowId, `broker create_tab structured/legacy window ref diverged for ${product}`);
    assert.equal(structuredRef.tabId, legacyTabId, `broker create_tab structured/legacy tab ref diverged for ${product}`);
    assert(navigation, `broker create_tab returned no navigation provenance for ${product}`);
    assert.equal(navigation.provenanceVersion, 1, `broker create_tab returned unsupported provenance for ${product}`);
    assert.equal(navigation.requestedUrl, url, `broker create_tab did not preserve exact requestedUrl for ${product}`);
    assert.equal(navigation.assignmentAccepted, true, `broker create_tab did not prove URL assignment for ${product}`);
    return ref;
  }
  cleanupFailures.push({ kind: 'tab', product, code: 'BROWSER_BROKER_CREATE_REF_UNAVAILABLE', effectOutcome: 'outcome_unknown', retryable: false, reconciliation: 'exact_tab_ref_unavailable' });
  throw new Error(`broker create_tab returned no exact structured ref for ${product}`);
}

async function closeBrokerTab(product: MacOsBrowserProduct, ref: OwnedTabRef): Promise<void> {
  const key = `${product}:${ref.windowId}:${ref.tabId}`;
  if (attemptedBrokerTabCloses.has(key)) throw new Error(`Refusing to replay an attempted close for ${key}.`);
  attemptedBrokerTabCloses.add(key);
  const index = brokerOwnedTabs.findIndex((entry) => entry.product === product && entry.ref.windowId === ref.windowId && entry.ref.tabId === ref.tabId);
  let closeError: unknown;
  let verifiedAbsent = false;
  try {
    try { await callBrowserAutomationBroker({ action: 'close_tab', product, ref }, 10_000); } catch (error) { closeError = error; }
    let inventory;
    try {
      inventory = await listMacOsBrowserTabs(product, 10_000, { correctFrontmost: false });
      if (inventory.truncated) throw new Error(`Cannot reconcile ${key}: native tab inventory is truncated.`);
    } catch (error) {
      cleanupFailures.push({ kind: 'tab', product, ...ref, closeActionError: closeError ? cleanupErrorSummary(closeError) : null, verificationError: cleanupErrorSummary(error), verifiedAbsent: false });
      throw error;
    }
    const stillPresent = inventory.tabs.some((tab) => tab.windowId === ref.windowId && tab.tabId === ref.tabId);
    if (stillPresent) {
      const error = closeError ?? new Error(`Owned tab ${key} remains after close_tab.`);
      cleanupFailures.push({ kind: 'tab', product, ...ref, ...(closeError ? cleanupErrorSummary(closeError) : { code: 'BROWSER_OWNED_TAB_CLOSE_POSTCONDITION_FAILED', effectOutcome: 'failed', retryable: false }), verifiedAbsent: false });
      throw error;
    }
    verifiedAbsent = true;
    cleanupReceipts.push({ kind: 'tab', product, ...ref, closeActionOutcome: closeError ? cleanupErrorSummary(closeError) : 'succeeded', verifiedAbsent: true });
  } finally {
    if (verifiedAbsent && index >= 0) brokerOwnedTabs.splice(index, 1);
  }
}

async function waitForExactUrl(product: MacOsBrowserProduct, ref: { windowId: string; tabId: string }, predicate: (url: string) => boolean): Promise<BrokerMetadata> {
  const deadline = Date.now() + 15_000;
  let latest = await exactMetadata(product, ref);
  while (Date.now() < deadline) {
    if (!latest.loading && predicate(latest.url)) return latest;
    await Bun.sleep(100);
    latest = await exactMetadata(product, ref);
  }
  return latest;
}

try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/redirect') return Response.redirect(`http://127.0.0.1:${server!.port}/wrong`, 302);
      const title = path === '/wrong' ? 'Forge Wrong' : path === '/drifted' ? 'Forge Drifted' : 'Forge One';
      return new Response(`<!doctype html><html><head><title>${title}</title></head><body><main id="main">${title}</main><a id="next" href="/drifted">Drift</a><div id="status">idle</div></body></html>`, { headers: { 'content-type': 'text/html' } });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const one = `${origin}/one`;
  const drifted = `${origin}/drifted`;
  const redirect = `${origin}/redirect`;
  const wrong = `${origin}/wrong`;

  setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });

  for (const product of requestedProducts) {
    writeControllerPluginConfig(controllerHome, 'browser', {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: [product],
      defaultTimeoutMs: 10_000,
    });

    const userBefore = await productMetadata(product);
    const createIsolationSession = async (sessionId: string) => {
      openSessions.set(sessionId, { product });
      const created = await action('create_session', {
        session_id: sessionId,
        url: one,
        browser_mode: 'attach_preferred',
        native_browser_candidates: [product],
        cdp_attach_fallback: 'fail_closed',
        extract_text: false,
      });
      const actualSessionId = resultSessionId(created);
      if (actualSessionId !== sessionId) {
        openSessions.delete(sessionId);
        openSessions.set(actualSessionId, { product });
      }
      assert.equal(actualSessionId, sessionId, `${product} concurrent session identity was aliased`);
      const ref = resultTabRef(created);
      openSessions.set(actualSessionId, { product, ref });
      return { sessionId, ref };
    };
    const isolationA = await createIsolationSession(`browser-v3-isolation-a-${product}`);
    const isolationB = await createIsolationSession(`browser-v3-isolation-b-${product}`);
    assert.notDeepEqual(isolationA.ref, isolationB.ref, `${product} concurrent fresh sessions shared one native tab`);
    const isolationThird = await createIsolationSession(`browser-v3-isolation-third-${product}`);
    assert.notDeepEqual(isolationThird.ref, isolationA.ref, `${product} third session reused session A's tab`);
    assert.notDeepEqual(isolationThird.ref, isolationB.ref, `${product} third session reused session B's tab`);
    for (const entry of [isolationA, isolationB, isolationThird]) {
      assert.equal((await exactMetadata(product, entry.ref)).url, one, `${product} session did not retain its assigned URL`);
    }

    const [reopenedA, reopenedB] = await Promise.all([
      action('open_page', { session_id: isolationA.sessionId, url: one }),
      action('open_page', { session_id: isolationB.sessionId, url: one }),
    ]);
    assert.deepEqual(resultTabRef(reopenedA), isolationA.ref, `${product} session A lost its exact tab binding`);
    assert.deepEqual(resultTabRef(reopenedB), isolationB.ref, `${product} session B lost its exact tab binding`);

    const closedIsolationA = await closeOwnedSession(isolationA.sessionId);
    assert.equal(closedIsolationA.resourceClosed, true, `${product} session A did not close its own tab`);
    const [survivingB, survivingThird] = await Promise.all([
      action('open_page', { session_id: isolationB.sessionId, url: one }),
      action('open_page', { session_id: isolationThird.sessionId, url: one }),
    ]);
    assert.deepEqual(resultTabRef(survivingB), isolationB.ref, `${product} closing session A disturbed session B`);
    assert.deepEqual(resultTabRef(survivingThird), isolationThird.ref, `${product} closing session A disturbed the third session`);
    for (const entry of [isolationB, isolationThird]) {
      const closed = await closeOwnedSession(entry.sessionId);
      assert.equal(closed.resourceClosed, true, `${product} session ${entry.sessionId} did not close its own tab`);
    }
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'concurrent session isolation');
    const concurrentSessionIsolation = {
      concurrentDistinctTabs: true,
      thirdFreshSessionDistinct: true,
      exactReattachment: true,
      closeIsolation: true,
    };


    if (requireCompetingForeground) assert.equal(userBefore.frontmost, false, `${product} must start behind a competing foreground app`);

    const replacementProbeSessionId = `browser-v3-replacement-probe-${product}`;
    openSessions.set(replacementProbeSessionId, { product });
    const replacementProbe = await action('create_session', {
      session_id: replacementProbeSessionId,
      url: one,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    });
    const actualReplacementProbeSessionId = resultSessionId(replacementProbe);
    if (actualReplacementProbeSessionId !== replacementProbeSessionId) {
      openSessions.delete(replacementProbeSessionId);
      openSessions.set(actualReplacementProbeSessionId, { product });
    }
    assert.equal(actualReplacementProbeSessionId, replacementProbeSessionId);
    const replacementProbeOriginalRef = resultTabRef(replacementProbe);
    openSessions.set(actualReplacementProbeSessionId, { product, ref: replacementProbeOriginalRef });
    const replacementReached = await action('open_page', {
      session_id: replacementProbeSessionId,
      url: drifted,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    });
    const replacementProbeRef = resultTabRef(replacementReached);
    openSessions.set(replacementProbeSessionId, { product, ref: replacementProbeRef });
    const replacementReachedMetadata = await exactMetadata(product, replacementProbeRef);
    assert.equal(replacementReachedMetadata.url, drifted, `${product} replacement did not reach the requested URL`);
    assert.notDeepEqual(replacementProbeRef, replacementProbeOriginalRef, `${product} replacement did not establish a new stable tab ref`);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'replacement success');

    let replacementMismatchCode = '';
    try {
      const unexpected = await action('open_page', { session_id: replacementProbeSessionId, url: redirect });
      throw new Error(`Browser accepted a failed replacement postcondition: expected=${redirect} actual=${String(unexpected.url)} wrong=${wrong}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Browser accepted a failed replacement postcondition:')) throw error;
      replacementMismatchCode = String((error as { code?: unknown }).code ?? '');
      assert.equal(replacementMismatchCode, 'PLUGIN_BROWSER_NATIVE_REPLACEMENT_MISMATCH');
    }
    const replacementAfterMismatch = await exactMetadata(product, replacementProbeRef);
    assert.equal(replacementAfterMismatch.url, drifted, `${product} failed replacement mutated the authoritative tab URL`);
    const replacementProbeClosed = await closeOwnedSession(replacementProbeSessionId);
    assert.equal(replacementProbeClosed.closed, true);
    assert.equal(replacementProbeClosed.resourceClosed, true);
    let authoritativeRefStillExists = true;
    try {
      await exactMetadata(product, replacementProbeRef);
    } catch {
      authoritativeRefStillExists = false;
    }
    assert.equal(authoritativeRefStillExists, false, `${product} close_session did not close the preserved authoritative replacement ref`);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'replacement probe cleanup');

    const createStarted = performance.now();
    const sessionId = `browser-v3-live-${product}`;
    openSessions.set(sessionId, { product });
    const opened = await action('create_session', {
      session_id: sessionId,
      url: one,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    });
    const createMs = performance.now() - createStarted;
    assert.equal(opened.provider, 'macos-apple-events');
    const actualSessionId = resultSessionId(opened);
    if (actualSessionId !== sessionId) {
      openSessions.delete(sessionId);
      openSessions.set(actualSessionId, { product });
    }
    assert.equal(actualSessionId, sessionId);
    const ref = resultTabRef(opened);
    openSessions.set(actualSessionId, { product, ref });
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'create_session');

    let initialText: Record<string, unknown> | undefined;
    try {
      initialText = await action('get_text', { session_id: sessionId, selector: '#main', max_chars: 1_000 });
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? '');
      if (code !== 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' || requireDomAll) throw error;
      const closedStarted = performance.now();
      const closed = await closeOwnedSession(sessionId);
      const closeMs = performance.now() - closedStarted;
      assert.equal(closed.closed, true);
      assert.equal(closed.resourceClosed, true);
      const userAfter = await productMetadata(product);
      assertActiveUserTabPreserved(product, userBefore, userAfter, 'permission-blocked lifecycle');
      (report.products as Record<string, unknown>)[product] = {
        status: 'external_permission_required',
        externalBlockerCode: code,
        browserProduct: product,
        activeUserTabPreserved: true,
        stableTabRef: ref,
        latencyMs: { create: Math.round(createMs * 10) / 10, close: Math.round(closeMs * 10) / 10 },
      };
      continue;
    }
    assert(String(initialText?.text).includes('Forge One'), `${product} initial get_text did not contain fixture text`);

    const warmSamples: number[] = [];
    for (let index = 0; index < samplesPerProduct; index += 1) {
      const started = performance.now();
      const text = await action('get_text', { session_id: sessionId, selector: '#main', max_chars: 1_000 });
      warmSamples.push(performance.now() - started);
      assert(String(text.text).includes('Forge One'));
    }
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'warm DOM reads');

    await callBrowserAutomationBroker({
      action: 'execute_javascript',
      product,
      ref,
      source: `JSON.stringify((()=>{ history.pushState({}, '', '/drifted'); document.querySelector('#main').textContent='Forge Drifted'; return {url:location.href,title:document.title}; })())`,
    }, 5_000);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'external same-origin drift');
    invalidateMacOsBrowserPageHandles();
    const reboundStarted = performance.now();
    const rebound = await action('get_text', { session_id: sessionId, selector: '#main', max_chars: 1_000 });
    const rebindMs = performance.now() - reboundStarted;
    assert(String(rebound.text).includes('Forge Drifted'));
    assert.equal(String(rebound.url), `${origin}/drifted`);
    const reboundRef = resultTabRef(rebound);
    assert.deepEqual(reboundRef, ref, `${product} cold rebind changed stable tab identity`);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'cold rebind');

    let postconditionCode = '';
    try {
      const unexpected = await action('open_page', { session_id: sessionId, url: redirect });
      throw new Error(`Browser accepted a failed redirect postcondition: expected=${redirect} actual=${String(unexpected.url)} wrong=${wrong}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Browser accepted a failed redirect postcondition:')) throw error;
      postconditionCode = String((error as { code?: unknown }).code ?? '');
      assert.equal(postconditionCode, 'PLUGIN_BROWSER_NATIVE_REPLACEMENT_MISMATCH');
    }
    const afterFailure = await action('get_text', { session_id: sessionId, selector: '#main', max_chars: 1_000 });
    assert(String(afterFailure.text).includes('Forge Drifted'), `${product} postcondition failure did not preserve prior tab state`);
    assert.deepEqual(resultTabRef(afterFailure), ref, `${product} postcondition failure changed the authoritative tab`);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'failed replacement postcondition');

    const closedStarted = performance.now();
    const closed = await closeOwnedSession(sessionId);
    const closeMs = performance.now() - closedStarted;
    assert.equal(closed.closed, true);
    assert.equal(closed.resourceClosed, true);

    const userAfter = await productMetadata(product);
    assertActiveUserTabPreserved(product, userBefore, userAfter, 'close_session');
    if (requireCompetingForeground) assert.equal(userAfter.frontmost, false, `${product} stole system foreground during background flow`);

    (report.products as Record<string, unknown>)[product] = {
      concurrentSessionIsolation,
      competingForeground: { before: !userBefore.frontmost, after: !userAfter.frontmost },
      activeUserTabPreserved: true,
      activeUserIdentityEvidence: userBefore.windowId && userBefore.tabId ? 'stable_ref+url+title' : 'legacy_metadata_url+title',
      stableTabRef: ref,
      urlDrift: `${origin}/drifted`,
      coldRebindMs: Math.round(rebindMs * 10) / 10,
      postconditionFailureCode: postconditionCode,
      latencyMs: {
        create: Math.round(createMs * 10) / 10,
        close: Math.round(closeMs * 10) / 10,
        warmSamples: warmSamples.map((value) => Math.round(value * 10) / 10),
        warmP50: percentile(warmSamples, 0.5),
        warmP95: percentile(warmSamples, 0.95),
      },
    };
  }

  if (requestedProducts.includes('chrome')) {
    const internalRef = await createBrokerTab('chrome', 'chrome://bookmarks/');
    const internalMetadata = await waitForExactUrl('chrome', internalRef, (url) => url.startsWith('chrome://bookmarks'));
    assert(internalMetadata.url.startsWith('chrome://bookmarks'), `Chrome internal resource did not resolve: ${internalMetadata.url}`);
    const internalSessionId = 'browser-v3-internal-chrome';
    openSessions.set(internalSessionId, { product: 'chrome' });
    const adopted = await action('create_session', {
      session_id: internalSessionId,
      url: internalMetadata.url,
      native_browser_product: 'chrome',
      native_window_id: internalRef.windowId,
      native_tab_id: internalRef.tabId,
      extract_text: false,
    });
    const actualInternalSessionId = resultSessionId(adopted);
    if (actualInternalSessionId !== internalSessionId) {
      openSessions.delete(internalSessionId);
      openSessions.set(actualInternalSessionId, { product: 'chrome' });
    }
    assert.equal(actualInternalSessionId, internalSessionId);
    const adoptedRef = resultTabRef(adopted);
    openSessions.set(actualInternalSessionId, { product: 'chrome', ref: adoptedRef });
    assert.deepEqual(adoptedRef, internalRef);
    const closed = await closeOwnedSession(internalSessionId);
    assert.equal(closed.preservedUserOwnedTab, true);
    await closeBrokerTab('chrome', internalRef);
    report.internalResource = { product: 'chrome', url: internalMetadata.url, exactRefPreserved: true, userOwnedClosePreserved: true };
  }

  testCompleted = true;
} finally {
  for (const sessionId of [...openSessions.keys()]) {
    if (attemptedSessionCloses.has(sessionId)) continue;
    try { await closeOwnedSession(sessionId); } catch { /* failure is retained in cleanupFailures */ }
  }
  for (const entry of [...brokerOwnedTabs]) {
    try { await closeBrokerTab(entry.product, entry.ref); } catch { /* failure is retained in cleanupFailures */ }
  }
  server?.stop(true);
  invalidateMacOsBrowserPageHandles();
  disposeRuntimeComputerComposition();
  resetBrowserPluginRuntimeHooksForTest();
  rmSync(repoRoot, { recursive: true, force: true });
  const cleanupOk = cleanupFailures.length === 0 && openSessions.size === 0 && brokerOwnedTabs.length === 0;
  if (cleanupOk) rmSync(controllerHome, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: testCompleted && cleanupOk,
    ...report,
    safeProviderRetries,
    cleanup: {
      ok: cleanupOk,
      receipts: cleanupReceipts,
      failures: cleanupFailures,
      recoveryPaths: cleanupOk ? undefined : { controllerHome },
      remainingSessions: [...openSessions.keys()],
      remainingTabs: brokerOwnedTabs.map((entry) => ({ product: entry.product, ...entry.ref })),
    },
  }));
  if (!cleanupOk) process.exitCode = 1;
}
