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
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';
import {
  invalidateMacOsBrowserPageHandles,
  listMacOsBrowserTabs,
  resetMacOsBrowserRuntimeHooksForTest,
  setMacOsBrowserRuntimeHooksForTest,
  type MacOsBrowserAutomationTiming,
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
type OpenSession = { owner: 'browser' | 'computer'; product: MacOsBrowserProduct; ref?: OwnedTabRef };
const openSessions = new Map<string, OpenSession>();
const attemptedSessionCloses = new Set<string>();
const attemptedBrokerTabCloses = new Set<string>();
const cleanupReceipts: Array<Record<string, unknown>> = [];
const cleanupFailures: Array<Record<string, unknown>> = [];
const nativeAutomationTimings: MacOsBrowserAutomationTiming[] = [];
let safeProviderRetries = 0;
let testCompleted = false;
const brokerOwnedTabs: Array<{ product: MacOsBrowserProduct; ref: OwnedTabRef }> = [];
let server: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = { schemaVersion: 1, source: 'current-worktree', products: {} };

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

type BrowserBrokerRequest = Parameters<typeof callBrowserAutomationBroker>[0];

async function brokerAction(
  request: BrowserBrokerRequest,
  timeoutMs: number,
  phase: string,
): Promise<Record<string, unknown>> {
  const correlationId = `browser-v3-live-broker-${request.action}-${crypto.randomUUID()}`;
  const target = request as unknown as {
    product?: string;
    ref?: { windowId?: string; tabId?: string };
  };
  try {
    return await callBrowserAutomationBroker(request, timeoutMs);
  } catch (error) {
    const providerFailure = error as {
      code?: unknown; retryable?: unknown; effectOutcome?: unknown; details?: unknown;
    };
    console.error(JSON.stringify({
      event: 'browser_broker_failure',
      phase,
      correlationId,
      action: request.action,
      product: target.product ?? null,
      windowId: target.ref?.windowId ?? null,
      tabId: target.ref?.tabId ?? null,
      timeoutMs,
      code: providerFailure.code ?? null,
      retryable: providerFailure.retryable ?? null,
      effectOutcome: providerFailure.effectOutcome ?? null,
      details: providerFailure.details ?? null,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    }));
    throw error;
  }
}

async function productMetadata(product: MacOsBrowserProduct): Promise<BrokerMetadata> {
  return parseMetadata((await brokerAction({ action: 'metadata', product }, 15_000, `metadata.current.${product}`)).value);
}

async function exactMetadata(product: MacOsBrowserProduct, ref: { windowId: string; tabId: string }): Promise<BrokerMetadata> {
  return parseMetadata((await brokerAction({ action: 'metadata', product, ref }, 15_000, `metadata.exact.${product}`)).value);
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

async function action(actionId: string, args: Record<string, unknown>, phase = actionId): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const requestId = `browser-v3-live-${actionId}-${crypto.randomUUID()}`;
    try {
      return await executeBrowserPluginAction({
        controllerHome,
        repoId: 'browser-v3-live',
        repoRoot,
        pluginId: 'browser',
        actionId,
        requestId,
        args,
        origin: { surface: 'local-ui', actor: 'browser-v3-live' },
      });
    } catch (error) {
      const providerFailure = error as {
        code?: unknown; retryable?: unknown; effectOutcome?: unknown; details?: unknown;
      };
      console.error(JSON.stringify({
        event: 'browser_plugin_action_failure',
        phase,
        actionId,
        requestId,
        attempt,
        sessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
        code: providerFailure.code ?? null,
        retryable: providerFailure.retryable ?? null,
        effectOutcome: providerFailure.effectOutcome ?? null,
        details: providerFailure.details ?? null,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      }));
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

type ComputerActionTrace = { actionId: string; phase: string; requestId: string; attempt: number; durationMs?: number; outcome?: 'succeeded' | 'failed'; providerPhases?: MacOsBrowserAutomationTiming[] };

async function computerAction(
  actionId: string,
  args: Record<string, unknown>,
  context: { phase?: string; trace?: ComputerActionTrace[] } = {},
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const requestId = `computer-v3-live-${actionId}-${crypto.randomUUID()}`;
    const phase = context.phase ?? actionId;
    const traceRecord: ComputerActionTrace = { actionId, phase, requestId, attempt };
    context.trace?.push(traceRecord);
    const timingStartIndex = nativeAutomationTimings.length;
    const startedAt = performance.now();
    try {
      const result = await computerPluginAdapter.executeAction({
        controllerHome,
        repoId: 'computer-v3-live',
        repoRoot,
        pluginId: 'computer',
        actionId,
        requestId,
        args,
        origin: { surface: 'local-ui', actor: 'computer-v3-live' },
      }) as Record<string, unknown>;
      traceRecord.durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      traceRecord.outcome = 'succeeded';
      traceRecord.providerPhases = nativeAutomationTimings.slice(timingStartIndex);
      return result;
    } catch (error) {
      traceRecord.durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      traceRecord.outcome = 'failed';
      traceRecord.providerPhases = nativeAutomationTimings.slice(timingStartIndex);
      const providerFailure = error as {
        code?: unknown; retryable?: unknown; effectOutcome?: unknown; details?: unknown;
      };
      console.error(JSON.stringify({
        event: 'computer_action_failure',
        phase,
        actionId,
        requestId,
        attempt,
        sessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
        stepCount: Array.isArray(args.steps) ? args.steps.length : undefined,
        code: providerFailure.code ?? null,
        retryable: providerFailure.retryable ?? null,
        effectOutcome: providerFailure.effectOutcome ?? null,
        details: providerFailure.details ?? null,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      }));
      const safeSerializationRetry = providerFailure.code === 'BROWSER_AUTOMATION_SERIALIZATION_BUSY'
        && providerFailure.retryable === true
        && providerFailure.effectOutcome === 'failed';
      if (!safeSerializationRetry || attempt === 3) throw error;
      safeProviderRetries += 1;
      await Bun.sleep(100 * attempt);
    }
  }
  throw new Error('Computer action retry loop exhausted unexpectedly.');
}

function cleanupErrorSummary(error: unknown): Record<string, unknown> {
  const value = error as { code?: unknown; effectOutcome?: unknown; retryable?: unknown };
  return { code: value.code ?? null, effectOutcome: value.effectOutcome ?? null, retryable: value.retryable ?? null, message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
}

async function closeOwnedSession(sessionId: string, trace?: ComputerActionTrace[]): Promise<Record<string, unknown>> {
  const owner = openSessions.get(sessionId);
  if (!owner) return { closed: true, alreadyClosed: true };
  if (attemptedSessionCloses.has(sessionId)) throw new Error(`Refusing to replay an attempted close for ${sessionId}.`);
  attemptedSessionCloses.add(sessionId);
  let result: Record<string, unknown> | undefined;
  let actionError: unknown;
  try {
    result = owner.owner === 'computer'
      ? await computerAction('close_session', { session_id: sessionId }, { phase: 'cleanup.close_session', trace })
      : await action('close_session', { session_id: sessionId }, 'cleanup.close_session');
  } catch (error) {
    actionError = error;
  }
  const providerClosed = result?.closed === true && (result.resourceClosed === true || result.resourceAlreadyMissing === true || result.preservedUserOwnedTab === true);
  if (actionError || !providerClosed) {
    let verifiedAbsent = false;
    let inventoryError: unknown;
    if (owner.ref) {
      try {
        const inventory = await listMacOsBrowserTabs(owner.product, 10_000, { correctFrontmost: false });
        verifiedAbsent = !inventory.tabs.some((tab) => tab.windowId === owner.ref!.windowId && tab.tabId === owner.ref!.tabId);
      } catch (error) {
        inventoryError = error;
      }
    }
    if (verifiedAbsent) {
      cleanupReceipts.push({ kind: 'session', sessionId, owner: owner.owner, closeActionOutcome: actionError ? cleanupErrorSummary(actionError) : 'postcondition_unproven', reconciledByInventory: true, verifiedAbsent: true });
      openSessions.delete(sessionId);
      return { closed: true, resourceClosed: true, reconciledByInventory: true };
    }
    const failure = {
      kind: 'session', sessionId, owner: owner.owner,
      ...(actionError ? cleanupErrorSummary(actionError) : { code: 'COMPUTER_SESSION_CLOSE_POSTCONDITION_UNPROVEN', effectOutcome: 'outcome_unknown', retryable: false, message: 'Provider did not prove owned session resource closure.' }),
      reconciliation: inventoryError ? cleanupErrorSummary(inventoryError) : owner.ref ? 'exact_owned_tab_still_present' : 'exact_owned_tab_ref_unavailable',
    };
    cleanupFailures.push(failure);
    throw actionError ?? new Error('Provider did not prove owned session resource closure.');
  }
  const closedResult = result as Record<string, unknown>;
  cleanupReceipts.push({ kind: 'session', sessionId, owner: owner.owner, closed: true, resourceClosed: closedResult.resourceClosed === true, resourceAlreadyMissing: closedResult.resourceAlreadyMissing === true, preservedUserOwnedTab: closedResult.preservedUserOwnedTab === true });
  openSessions.delete(sessionId);
  return closedResult;
}

async function createBrokerTab(product: MacOsBrowserProduct, url: string): Promise<OwnedTabRef> {
  const created = await brokerAction({ action: 'create_tab', product, url }, 15_000, `fixture.create_tab.${product}`);
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

async function closeBrokerTab(product: MacOsBrowserProduct, ref: OwnedTabRef): Promise<void> {
  const key = `${product}:${ref.windowId}:${ref.tabId}`;
  if (attemptedBrokerTabCloses.has(key)) throw new Error(`Refusing to replay an attempted close for ${key}.`);
  attemptedBrokerTabCloses.add(key);
  const index = brokerOwnedTabs.findIndex((entry) => entry.product === product && entry.ref.windowId === ref.windowId && entry.ref.tabId === ref.tabId);
  let closeError: unknown;
  let verifiedAbsent = false;
  try {
    try { await brokerAction({ action: 'close_tab', product, ref }, 10_000, `fixture.close_tab.${product}`); } catch (error) { closeError = error; }
    let inventory;
    try { inventory = await listMacOsBrowserTabs(product, 10_000, { correctFrontmost: false }); }
    catch (error) {
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
      return new Response(`<!doctype html><html><head><title>${title}</title></head><body>
        <main id="main">${title}</main><a id="next" href="/drifted">Drift</a><div id="status">idle</div>
        <form id="task-form"><input id="task" name="task"><button id="add" type="submit">Add task</button></form><ol id="tasks"></ol>
        <script>
          document.querySelector('#task-form').addEventListener('submit', (event) => {
            event.preventDefault();
            const input = document.querySelector('#task');
            const value = input.value;
            const item = document.createElement('li');
            item.textContent = value + ':high';
            document.querySelector('#tasks').append(item);
            document.querySelector('#status').textContent = 'saved:' + value;
            input.value = '';
          });
        </script>
      </body></html>`, { headers: { 'content-type': 'text/html' } });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const one = `${origin}/one`;
  const drifted = `${origin}/drifted`;
  const redirect = `${origin}/redirect`;
  const wrong = `${origin}/wrong`;

  setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
  setMacOsBrowserRuntimeHooksForTest({ onAutomationTiming: (timing) => nativeAutomationTimings.push(timing) });
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
      openSessions.set(sessionId, { owner: 'browser', product });
      const created = await action('create_session', {
        session_id: sessionId,
        url: one,
        browser_mode: 'attach_preferred',
        native_browser_candidates: [product],
        cdp_attach_fallback: 'fail_closed',
        extract_text: false,
      });
      assert.equal(resultSessionId(created), sessionId, `${product} concurrent session identity was aliased`);
      const ref = resultTabRef(created);
      openSessions.set(sessionId, { owner: 'browser', product, ref });
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
    openSessions.set(replacementProbeSessionId, { owner: 'browser', product });
    const replacementProbe = await action('create_session', {
      session_id: replacementProbeSessionId,
      url: one,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    });
    assert.equal(resultSessionId(replacementProbe), replacementProbeSessionId);
    const replacementProbeOriginalRef = resultTabRef(replacementProbe);
    openSessions.set(replacementProbeSessionId, { owner: 'browser', product, ref: replacementProbeOriginalRef });
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
    const sessionId = `browser-v3-primary-${product}`;
    openSessions.set(sessionId, { owner: 'browser', product });
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
    assert.equal(resultSessionId(opened), sessionId);
    const ref = resultTabRef(opened);
    openSessions.set(sessionId, { owner: 'browser', product, ref });
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

    // Keep the existing Browser lifecycle suite intact; measure the public Computer
    // adapter on its own plugin-owned tab so its native-only policy is exercised.
    const computerSessionId = `computer-v3-primary-${product}`;
    const computerLifecycleRequestTrace: ComputerActionTrace[] = [];
    const computerCleanupRequestTrace: ComputerActionTrace[] = [];
    openSessions.set(computerSessionId, { owner: 'computer', product });
    const computerOpened = await computerAction('create_session', {
      session_id: computerSessionId,
      url: one,
      browser_mode: 'attach_preferred',
      native_browser_candidates: [product],
      cdp_attach_fallback: 'fail_closed',
      extract_text: false,
    }, { phase: 'native_lifecycle.create_session', trace: computerLifecycleRequestTrace });
    assert.equal(computerOpened.provider, 'macos-apple-events');
    assert.equal(resultSessionId(computerOpened), computerSessionId);
    const computerRef = resultTabRef(computerOpened);
    openSessions.set(computerSessionId, { owner: 'computer', product, ref: computerRef });
    assert.notDeepEqual(computerRef, ref, 'Computer batch fixture must use its own exact tab');
    assert.equal((await exactMetadata(product, computerRef)).url, one);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'Computer create_session');

    // Compare separate Computer actions with one bounded run_steps transaction.
    // Native Apple Events batches contiguous DOM mutations but leaves explicit
    // selector waits as independent observations.
    const batchSamples = Math.max(5, Math.min(Number(process.env.FORGE_BROWSER_V3_BATCH_SAMPLES ?? 10), 20));
    const sequentialBatchSamples: number[] = [];
    const nativeBatchSamples: number[] = [];
    const sequentialVerifiedTaskSamples: number[] = [];
    const nativeBatchVerifiedTaskSamples: number[] = [];
    const nativeProviderBatchDurations: number[] = [];
    const nativeBatchStepTimings: Array<{ sample: number; warmup: boolean; providerBatchDurationMs: number; steps: Array<{ index: number; action: string; durationMs: number }> }> = [];
    const sequentialBatchRequestTrace: Array<{ sample: number; warmup: boolean; requests: ComputerActionTrace[] }> = [];
    const nativeBatchRequestTrace: Array<{ sample: number; warmup: boolean; requests: ComputerActionTrace[] }> = [];
    let taskCount = 0;
    async function mutationTrial(variant: 'sequential' | 'batched', index: number): Promise<{ actionWallMs: number; verifiedTaskWallMs: number }> {
      const requestTrace: ComputerActionTrace[] = [];
      const marker = `computer-${product}-${index}-${variant}`;
      const firstTaskIndex = taskCount + 1;
      const secondTaskIndex = taskCount + 2;
      const steps = [
        { action: 'fill', selector: '#task', text: marker + '-a' },
        { action: 'press', selector: '#task', key: 'Enter' },
        { action: 'wait_for_selector', selector: `#tasks li:nth-child(${firstTaskIndex})`, state: 'visible' },
        { action: 'fill', selector: '#task', text: marker + '-b' },
        { action: 'press', selector: '#task', key: 'Enter' },
        { action: 'wait_for_selector', selector: `#tasks li:nth-child(${secondTaskIndex})`, state: 'visible' },
        { action: 'fill', selector: '#task', text: marker + '-c' },
        { action: 'click', selector: '#add' },
      ];
      const startedAt = performance.now();
      if (variant === 'batched') {
        const result = await computerAction('run_steps', { session_id: computerSessionId, steps }, {
          phase: `native_batch.batched.sample_${index}.run_steps`, trace: requestTrace,
        });
        const summary = result.action as Record<string, unknown>;
        assert.equal(summary.completedSteps, 8, 'Computer run_steps must complete all 8 native actions');
        assert.equal(summary.providerBatchCount, 3, 'three contiguous mutation groups should use three native evaluations');
        assert.equal(summary.providerBatchStepCount, 6, 'all six mutations should be covered by native batches');
        assert.equal(typeof summary.providerBatchDurationMs, 'number');
        assert(Array.isArray(summary.steps), 'Computer run_steps must return per-step timings');
        assert.equal(summary.steps.length, 8, 'Computer run_steps must return one timing for each of the 8 actions');
        const stepTimings = summary.steps.map((step, stepIndex) => {
          const item = step as Record<string, unknown>;
          assert.equal(item.index, stepIndex, 'Computer run_steps timings must preserve step order');
          assert.equal(typeof item.action, 'string');
          assert.equal(typeof item.durationMs, 'number');
          assert(Number.isFinite(item.durationMs), 'Computer run_steps duration must be finite');
          return { index: stepIndex, action: String(item.action), durationMs: Number(item.durationMs) };
        });
        nativeBatchStepTimings.push({
          sample: index,
          warmup: index === 0,
          providerBatchDurationMs: summary.providerBatchDurationMs as number,
          steps: stepTimings,
        });
        if (index !== 0) nativeProviderBatchDurations.push(summary.providerBatchDurationMs as number);
      } else {
        for (const step of steps) {
          const { action: stepAction, ...stepArgs } = step;
          await computerAction(stepAction, { session_id: computerSessionId, ...stepArgs }, {
            phase: `native_batch.sequential.sample_${index}.${stepAction}`, trace: requestTrace,
          });
        }
      }
      const actionWallMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const observed = await computerAction('get_text', { session_id: computerSessionId, selector: '#tasks', max_chars: 10_000 }, {
        phase: `native_batch.${variant}.sample_${index}.readback`, trace: requestTrace,
      });
      const verifiedTaskWallMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const text = String(observed.text ?? '');
      for (const suffix of ['-a', '-b', '-c']) {
        assert(text.includes(marker + suffix + ':high'), `${product} ${variant} did not persist ${marker}${suffix}`);
      }
      taskCount += 3;
      assert(requestTrace.every((request) => typeof request.durationMs === 'number' && Number.isFinite(request.durationMs)),
        'every Computer request trace must include its action wall duration');
      (variant === 'sequential' ? sequentialBatchRequestTrace : nativeBatchRequestTrace)
        .push({ sample: index, warmup: index === 0, requests: requestTrace });
      return { actionWallMs, verifiedTaskWallMs };
    }

    for (let index = 0; index <= batchSamples; index += 1) {
      const order: Array<'sequential' | 'batched'> = index % 2 === 0
        ? ['sequential', 'batched'] : ['batched', 'sequential'];
      for (const variant of order) {
        const timing = await mutationTrial(variant, index);
        if (index !== 0) {
          if (variant === 'sequential') {
            sequentialBatchSamples.push(timing.actionWallMs);
            sequentialVerifiedTaskSamples.push(timing.verifiedTaskWallMs);
          } else {
            nativeBatchSamples.push(timing.actionWallMs);
            nativeBatchVerifiedTaskSamples.push(timing.verifiedTaskWallMs);
          }
        }
      }
    }
    assert.equal(sequentialBatchSamples.length, batchSamples);
    assert.equal(nativeBatchSamples.length, batchSamples);
    assert.equal(sequentialVerifiedTaskSamples.length, batchSamples);
    assert.equal(nativeBatchVerifiedTaskSamples.length, batchSamples);
    assert.equal(nativeProviderBatchDurations.length, batchSamples);
    assert.equal(nativeBatchStepTimings.length, batchSamples + 1);
    const nativeBatchStepDurationByAction = Object.fromEntries(
      (['fill', 'press', 'wait_for_selector', 'click'] as const).map((action) => {
        const durations = nativeBatchStepTimings
          .filter((sample) => !sample.warmup)
          .flatMap((sample) => sample.steps.filter((step) => step.action === action).map((step) => step.durationMs));
        return [action, { samples: durations.length, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) }];
      }),
    );
    // Evaluate after close_session so the lifecycle report includes its cleanup trace.
    const computerRequestSamples = () => [
      ...computerLifecycleRequestTrace,
      ...computerCleanupRequestTrace,
      ...[...sequentialBatchRequestTrace, ...nativeBatchRequestTrace]
        .filter((sample) => !sample.warmup)
        .flatMap((sample) => sample.requests),
    ];
    const actionWallSummary = (samples: ComputerActionTrace[]) => {
      const durations = samples.flatMap((sample) => sample.durationMs === undefined ? [] : [sample.durationMs]);
      return {
        attempts: samples.length,
        succeeded: samples.filter((sample) => sample.outcome === 'succeeded').length,
        failed: samples.filter((sample) => sample.outcome === 'failed').length,
        samples: durations.length,
        ...(durations.length > 0 ? {
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
          maxMs: Math.max(...durations),
        } : {}),
      };
    };
    const computerActionWallByAction = () => Object.fromEntries(
      [...new Set(computerRequestSamples().map((sample) => sample.actionId))].sort().map((actionId) => [
        actionId,
        actionWallSummary(computerRequestSamples().filter((sample) => sample.actionId === actionId)),
      ]),
    );
    const nativePhaseSamples = () => computerRequestSamples().flatMap((request) => request.providerPhases ?? []);
    const phaseSummary = (values: number[]) => values.length === 0
      ? { samples: 0 }
      : {
        samples: values.length,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        maxMs: Math.max(...values),
      };
    const nativeAutomationPhaseByAction = () => Object.fromEntries(
      [...new Set(nativePhaseSamples().map((sample) => sample.action))].sort().map((action) => {
        const samples = nativePhaseSamples().filter((sample) => sample.action === action);
        return [action, {
          requests: samples.length,
          succeeded: samples.filter((sample) => sample.outcome === 'succeeded').length,
          failed: samples.filter((sample) => sample.outcome === 'failed').length,
          processPrecondition: phaseSummary(samples.map((sample) => sample.processPreconditionMs)),
          brokerRoundTrip: phaseSummary(samples.flatMap((sample) => sample.brokerRoundTripMs === undefined ? [] : [sample.brokerRoundTripMs])),
          testHookRoundTrip: phaseSummary(samples.flatMap((sample) => sample.testHookRoundTripMs === undefined ? [] : [sample.testHookRoundTripMs])),
          total: phaseSummary(samples.map((sample) => sample.totalMs)),
        }];
      }),
    );
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'native mutation batch');

    const unknownMarker = `computer-${product}-unknown-outcome`;
    const unknownOutcomeRequestTrace: ComputerActionTrace[] = [];
    let unknownOutcome: { code?: unknown; details?: Record<string, unknown> } | undefined;
    try {
      await computerAction('run_steps', {
        session_id: computerSessionId,
        steps: [
          { action: 'fill', selector: '#task', text: unknownMarker },
          { action: 'click', selector: '#add' },
          { action: 'fill', selector: '#missing', text: 'must-not-run' },
        ],
      }, { phase: 'native_batch.unknown_outcome_injection', trace: unknownOutcomeRequestTrace });
      throw new Error('Computer accepted a mutation batch with a missing selector.');
    } catch (error) {
      if (error instanceof Error && error.message === 'Computer accepted a mutation batch with a missing selector.') throw error;
      unknownOutcome = error as { code?: unknown; details?: Record<string, unknown> };
    }
    assert.equal(unknownOutcome?.code, 'PLUGIN_BROWSER_MUTATION_OUTCOME_UNKNOWN');
    assert.equal(unknownOutcome?.details?.failedIndex, 2);
    assert.equal(unknownOutcome?.details?.completedSteps, 2);
    const reconciled = await computerAction('get_text', { session_id: computerSessionId, selector: '#tasks', max_chars: 10_000 }, {
      phase: 'native_batch.unknown_outcome_reconcile', trace: unknownOutcomeRequestTrace,
    });
    const reconciledText = String(reconciled.text ?? '');
    assert.equal(reconciledText.split(unknownMarker + ':high').length - 1, 1, 'unknown mutation must be reconciled, never replayed');
    const computerClosed = await closeOwnedSession(computerSessionId, computerCleanupRequestTrace);
    assert.equal(computerClosed.closed, true);
    assert.equal(computerClosed.resourceClosed, true);
    assertActiveUserTabPreserved(product, userBefore, await productMetadata(product), 'Computer close_session');

    await brokerAction({
      action: 'execute_javascript',
      product,
      ref,
      source: `JSON.stringify((()=>{ history.pushState({}, '', '/drifted'); document.querySelector('#main').textContent='Forge Drifted'; return {url:location.href,title:document.title}; })())`,
    }, 5_000, `fixture.external_same_origin_drift.${product}`);
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
      nativeBatch: {
        samples: batchSamples,
        stepsPerTrial: 8,
        mutationProviderBatchesPerTrial: 3,
        mutationStepsPerTrial: 6,
        providerEvaluationsPerTrial: { sequential: 8, batched: 5 },
        sequentialWallP50Ms: percentile(sequentialBatchSamples, 0.5),
        sequentialWallP95Ms: percentile(sequentialBatchSamples, 0.95),
        batchedWallP50Ms: percentile(nativeBatchSamples, 0.5),
        batchedWallP95Ms: percentile(nativeBatchSamples, 0.95),
        actionWallBoundary: 'mutation sequence; excludes independent readback',
        sequentialVerifiedTaskP50Ms: percentile(sequentialVerifiedTaskSamples, 0.5),
        sequentialVerifiedTaskP95Ms: percentile(sequentialVerifiedTaskSamples, 0.95),
        batchedVerifiedTaskP50Ms: percentile(nativeBatchVerifiedTaskSamples, 0.5),
        batchedVerifiedTaskP95Ms: percentile(nativeBatchVerifiedTaskSamples, 0.95),
        verifiedTaskBoundary: 'mutation sequence plus independent get_text readback',
        verifiedTaskSamples: {
          sequential: sequentialVerifiedTaskSamples,
          batched: nativeBatchVerifiedTaskSamples,
        },
        providerBatchP50Ms: percentile(nativeProviderBatchDurations, 0.5),
        providerBatchP95Ms: percentile(nativeProviderBatchDurations, 0.95),
        stepDurationByActionMs: nativeBatchStepDurationByAction,
        stepTimingSamples: nativeBatchStepTimings,
        nativeAutomationPhaseBoundary: 'process precondition and Computer provider broker round-trip; broker timing includes Runtime-to-sidecar dispatch and is not an inner Apple Event span',
        nativeAutomationPhaseByAction: nativeAutomationPhaseByAction(),
        computerActionWallByAction: computerActionWallByAction(),
        lifecycleRequestTrace: { create: computerLifecycleRequestTrace, close: computerCleanupRequestTrace },
        p50Speedup: Math.round((percentile(sequentialBatchSamples, 0.5) / percentile(nativeBatchSamples, 0.5)) * 100) / 100,
        unknownOutcomeReconciledOnce: true,
        requestTrace: {
          sequential: sequentialBatchRequestTrace,
          batched: nativeBatchRequestTrace,
          unknownOutcome: unknownOutcomeRequestTrace,
        },
      },
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
    openSessions.set(internalSessionId, { owner: 'browser', product: 'chrome' });
    const adopted = await action('create_session', {
      session_id: internalSessionId,
      url: internalMetadata.url,
      native_browser_product: 'chrome',
      native_window_id: internalRef.windowId,
      native_tab_id: internalRef.tabId,
      extract_text: false,
    });
    assert.equal(resultSessionId(adopted), internalSessionId);
    openSessions.set(internalSessionId, { owner: 'browser', product: 'chrome', ref: resultTabRef(adopted) });
    assert.deepEqual(resultTabRef(adopted), internalRef);
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
  resetMacOsBrowserRuntimeHooksForTest();
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
