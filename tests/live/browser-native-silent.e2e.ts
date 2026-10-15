#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertUniqueGuiChromeProcess } from './chrome-process-identity';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  executeBrowserPluginAction,
  resetBrowserPluginRuntimeHooksForTest,
  setBrowserPluginRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-adapter';
import { callBrowserAutomationBroker } from '../../src/runtime/plugins/browser-automation-service';

if (process.platform !== 'darwin') throw new Error('Native silent browser E2E requires macOS.');

const repoRoot = mkdtempSync(join(tmpdir(), 'forge-browser-live-'));
const controllerHome = mkdtempSync(join(tmpdir(), 'forge-browser-live-controller-'));
let server: ReturnType<typeof Bun.serve> | undefined;
let sessionId = '';
const timings: Array<{ kind: string; ms: number }> = [];

function nativeTabId(result: Record<string, unknown>): string {
  const connection = result.browserConnection;
  assert(connection && typeof connection === 'object', 'missing browserConnection');
  const tab = (connection as Record<string, unknown>).tab;
  assert(tab && typeof tab === 'object', 'missing browserConnection.tab');
  const tabId = (tab as Record<string, unknown>).tabId;
  assert.equal(typeof tabId, 'string', 'missing browserConnection.tab.tabId');
  return tabId as string;
}

/** The stable Desktop Operator is the only macOS automation principal.
 * Checking GUI Chrome's state through a separate osascript child can test
 * a different TCC identity and report a misleading permissions failure.
 */
async function activeChromeTabIdentity(): Promise<{ windowId: string; tabId: string; url: string; title: string }> {
  const result = await callBrowserAutomationBroker({ action: 'metadata', product: 'chrome' }, 5_000);
  const parts = String(result.value ?? '').split(String.fromCharCode(30));
  assert(parts.length >= 7 && Boolean(parts[1]), 'Desktop Operator returned incomplete Chrome metadata');
  return { windowId: parts[7] ?? '', tabId: parts[8] ?? '', url: parts[1] ?? '', title: parts[2] ?? '' };
}

function assertUserTabPreserved(
  before: { windowId: string; tabId: string; url: string; title: string },
  after: { windowId: string; tabId: string; url: string; title: string },
): void {
  if (before.windowId && before.tabId && after.windowId && after.tabId) {
    assert.equal(after.windowId, before.windowId, 'Chrome active user window changed');
    assert.equal(after.tabId, before.tabId, 'Chrome active user tab changed');
  } else {
    assert.equal(after.url, before.url, 'Chrome active user URL changed');
    assert.equal(after.title, before.title, 'Chrome active user page title changed');
  }
}


async function action(actionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const started = performance.now();
  try {
    return await executeBrowserPluginAction({
    controllerHome, repoId: 'repo', repoRoot, pluginId: 'browser', actionId,
    requestId: `browser-live-${actionId}-${crypto.randomUUID()}`, args, origin: { surface: 'local-ui', actor: 'e2e' },
    });
  } finally {
    timings.push({ kind: actionId, ms: Math.round((performance.now() - started) * 10) / 10 });
  }
}

try {
  // Browser session/artifact state is scoped by input.controllerHome. The
  // Computer provider must retain the real controller's registered identity.
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
  mkdirSync(join(repoRoot, '.forge/plugins'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'src/upload-one.txt'), 'first');
  writeFileSync(join(repoRoot, 'src/upload-two.txt'), 'second');
  writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  registerRepository({ path: repoRoot, controllerHome });

  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const title = path === '/three' ? 'Forge Three' : path === '/two' ? 'Forge Two' : 'Forge One';
      return new Response(`<!doctype html><title>${title}</title><body><main>${title}</main><input id="email"><button id="btn" onclick="document.querySelector('#status').textContent='clicked:'+document.querySelector('#email').value">Apply</button><a id="next" href="/three">Next</a><div id="status">idle</div><input id="upload" type="file" multiple oninput="document.querySelector(\'#upload-status\').textContent=Array.from(this.files||[]).map(f=>f.name+\':\'+f.size).join(\',\')"><div id="upload-status">empty</div></body>`, { headers: { 'content-type': 'text/html' } });
    },
  });
  const port = server.port;
  const one = `http://127.0.0.1:${port}/one`;
  const two = `http://127.0.0.1:${port}/two`;
  writeFileSync(join(repoRoot, '.forge/plugins/browser.json'), `${JSON.stringify({
    schemaVersion: 1, enabled: true, provider: 'playwright', browserMode: 'attach_preferred',
    cdpAttachFallback: 'fail_closed', nativeAttachMode: 'auto', nativeBrowserCandidates: ['chrome'], defaultTimeoutMs: 10_000,
  }, null, 2)}\n`);
  setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
  // A bundle name alone cannot prove which running Chrome instance receives
  // Apple Events. Check process roots *before* any scripting or tab mutation.
  const processList = spawnSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
  if (processList.error || processList.status !== 0) {
    throw new Error('CHROME_APPLE_EVENTS_PROCESS_PROBE_UNAVAILABLE: Cannot prove which Chrome instance would receive Apple Events.');
  }
  assertUniqueGuiChromeProcess(processList.stdout);
  const userTabBefore = await activeChromeTabIdentity();
  const first = await action('get_text', { url: one });
  assert(String(first.text).includes('Forge One'));
  sessionId = String(first.sessionId);
  const firstTabId = nativeTabId(first);
  const second = await action('open_page', { session_id: sessionId, url: two });
  const secondTabId = nativeTabId(second);
  assert.equal(secondTabId, firstTabId);

  const filled = await action('fill', { session_id: sessionId, selector: '#email', text: 'silent@example.com', post_action_wait_ms: 1 });
  assert.equal(filled.evidenceMode, 'dom');
  assert(!('screenshot' in filled));
  await action('click', { session_id: sessionId, selector: '#btn', post_action_wait_ms: 1 });
  assert(String((await action('get_text', { session_id: sessionId, selector: '#status' })).text).includes('clicked:silent@example.com'));
  await action('attach_local_file', { session_id: sessionId, selector: '#upload', file_paths: ['src/upload-one.txt', 'src/upload-two.txt'] });
  assert.equal(String((await action('get_text', { session_id: sessionId, selector: '#upload-status' })).text).trim(), 'upload-one.txt:5,upload-two.txt:6');

  const navigated = await action('click', { session_id: sessionId, selector: '#next', post_action_wait_ms: 100 });
  assert.equal(String(navigated.url), `http://127.0.0.1:${port}/three`);
  assert.equal(nativeTabId(navigated), secondTabId);
  assert(String((await action('get_text', { session_id: sessionId })).text).includes('Forge Three'));
  const back = await action('go_back', { session_id: sessionId });
  assert.equal(String((back.session as Record<string, unknown>).url), two);
  assert.equal(nativeTabId(back), secondTabId);
  const reloaded = await action('reload', { session_id: sessionId });
  assert.equal(String((reloaded.session as Record<string, unknown>).url), two);

  let screenshotCode = '';
  try { await action('screenshot', { session_id: sessionId }); } catch (error) {
    screenshotCode = String((error as { code?: unknown }).code ?? '');
  }
  assert.equal(screenshotCode, 'PLUGIN_BROWSER_FOREGROUND_REQUIRED');
  const closed = await action('close_session', { session_id: sessionId });
  sessionId = '';
  assert.equal(closed.closed, true);
  assert.equal(closed.resourceClosed, true);
  assertUserTabPreserved(userTabBefore, await activeChromeTabIdentity());
  console.log(JSON.stringify({ ok: true, provider: 'desktop_operator', actionCount: timings.length, durationMs: Math.round(timings.reduce((sum, entry) => sum + entry.ms, 0)), timings }));
} finally {
  if (sessionId) await action('close_session', { session_id: sessionId }).catch(() => undefined);
  server?.stop(true);
  resetBrowserPluginRuntimeHooksForTest();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(controllerHome, { recursive: true, force: true });
}
