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
const openSessions = new Set<string>();
let safeProviderRetries = 0;
const brokerOwnedTabs: Array<{ product: MacOsBrowserProduct; ref: { windowId: string; tabId: string } }> = [];
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

async function closeSession(sessionId: string): Promise<void> {
  if (!openSessions.delete(sessionId)) return;
  await action('close_session', { session_id: sessionId }).catch(() => undefined);
}

async function createBrokerTab(product: MacOsBrowserProduct, url: string): Promise<{ windowId: string; tabId: string }> {
  const created = await callBrowserAutomationBroker({ action: 'create_tab', product, url }, 15_000);
  const [legacyWindowId, legacyTabId] = String(created.value ?? '').split(separator);
  const structuredRef = created.ref as Record<string, unknown> | undefined;
  const navigation = created.navigation as Record<string, unknown> | undefined;
  assert(structuredRef && typeof structuredRef.windowId === 'string' && typeof structuredRef.tabId === 'string', `broker create_tab returned incomplete structured ref for ${product}`);
  assert.equal(structuredRef.windowId, legacyWindowId, `broker create_tab structured/legacy window ref diverged for ${product}`);
  assert.equal(structuredRef.tabId, legacyTabId, `broker create_tab structured/legacy tab ref diverged for ${product}`);
  assert(navigation, `broker create_tab returned no navigation provenance for ${product}`);
  assert.equal(navigation.provenanceVersion, 1, `broker create_tab returned unsupported provenance for ${product}`);
  assert.equal(navigation.requestedUrl, url, `broker create_tab did not preserve exact requestedUrl for ${product}`);
  assert.equal(navigation.assignmentAccepted, true, `broker create_tab did not prove URL assignment for ${product}`);
  const ref = { windowId: structuredRef.windowId as string, tabId: structuredRef.tabId as string };
  brokerOwnedTabs.push({ product, ref });
  return ref;
}

async function closeBrokerTab(product: MacOsBrowserProduct, ref: { windowId: string; tabId: string }): Promise<void> {
  const index = brokerOwnedTabs.findIndex((entry) => entry.product === product && entry.ref.windowId === ref.windowId && entry.ref.tabId === ref.tabId);
  if (index >= 0) brokerOwnedTabs.splice(index, 1);
  await callBrowserAutomationBroker({ action: 'close_tab', product, ref }, 10_000).catch(() => undefined);
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
  const report: Record<string, unknown> = { schemaVersion: 1, source: 'current-worktree', products: {} };

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
      openSessions.add(sessionId);
      const created = await action('create_session', {
        session_id: sessionId,
        url: one,
        browser_mode: 'attach_preferred',
        native_browser_candidates: [product],
        cdp_attach_fallback: 'fail_closed',
        extract_text: false,
      });
      assert.equal(resultSessionId(created), sessionId, `${product} concurrent session identity was aliased`);
      return { sessionId, ref: resultTabRef(created) };
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

    const closedIsolationA = await action('close_session', { session_id: isolationA.sessionId });
    openSessions.delete(isolationA.sessionId);
    assert.equal(closedIsolationA.resourceClosed, true, `${product} session A did not close its own tab`);
    const [survivingB, survivingThird] = await Promise.all([
      action('open_page', { session_id: isolationB.sessionId, url: one }),
      action('open_page', { session_id: isolationThird.sessionId, url: one }),
    ]);
    assert.deepEqual(resultTabRef(survivingB), isolationB.ref, `${product} closing session A disturbed session B`);
    assert.deepEqual(resultTabRef(survivingThird), isolationThird.ref, `${product} closing session A disturbed the third session`);
    for (const entry of [isolationB, isolationThird]) {
      const closed = await action('close_session', { session_id: entry.sessionId });
      openSessions.delete(entry.sessionId);
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

    const replacementProbe = await action('create_session', {
      session_id: `browser-v3-replacement-probe-${product}`,
      url: one,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    });
    const replacementProbeSessionId = resultSessionId(replacementProbe);
    openSessions.add(replacementProbeSessionId);
    const replacementProbeOriginalRef = resultTabRef(replacementProbe);
    const replacementReached = await action('open_page', {
      session_id: replacementProbeSessionId,
      url: drifted,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    });
    const replacementProbeRef = resultTabRef(replacementReached);
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
    const replacementProbeClosed = await action('close_session', { session_id: replacementProbeSessionId });
    openSessions.delete(replacementProbeSessionId);
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
    const opened = await action('create_session', {
      url: one,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    });
    const createMs = performance.now() - createStarted;
    assert.equal(opened.provider, 'macos-apple-events');
    const sessionId = resultSessionId(opened);
    openSessions.add(sessionId);
    const ref = resultTabRef(opened);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'create_session');

    let initialText: Record<string, unknown> | undefined;
    try {
      initialText = await action('get_text', { session_id: sessionId, selector: '#main', max_chars: 1_000 });
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? '');
      if (code !== 'PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' || requireDomAll) throw error;
      const closedStarted = performance.now();
      const closed = await action('close_session', { session_id: sessionId });
      const closeMs = performance.now() - closedStarted;
      openSessions.delete(sessionId);
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
    const closed = await action('close_session', { session_id: sessionId });
    const closeMs = performance.now() - closedStarted;
    openSessions.delete(sessionId);
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
    const adopted = await action('create_session', {
      url: internalMetadata.url,
      native_browser_product: 'chrome',
      native_window_id: internalRef.windowId,
      native_tab_id: internalRef.tabId,
      extract_text: false,
    });
    const internalSessionId = resultSessionId(adopted);
    openSessions.add(internalSessionId);
    assert.deepEqual(resultTabRef(adopted), internalRef);
    const closed = await action('close_session', { session_id: internalSessionId });
    openSessions.delete(internalSessionId);
    assert.equal(closed.preservedUserOwnedTab, true);
    await closeBrokerTab('chrome', internalRef);
    report.internalResource = { product: 'chrome', url: internalMetadata.url, exactRefPreserved: true, userOwnedClosePreserved: true };
  }

  console.log(JSON.stringify({ ok: true, ...report, safeProviderRetries }));
} finally {
  for (const sessionId of [...openSessions]) await closeSession(sessionId);
  for (const entry of [...brokerOwnedTabs]) await closeBrokerTab(entry.product, entry.ref);
  server?.stop(true);
  invalidateMacOsBrowserPageHandles();
  disposeRuntimeComputerComposition();
  resetBrowserPluginRuntimeHooksForTest();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(controllerHome, { recursive: true, force: true });
}
