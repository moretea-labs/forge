#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  executeBrowserPluginAction,
  resetBrowserPluginRuntimeHooksForTest,
  setBrowserPluginRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-adapter';
import {
  resetMacOsBrowserRuntimeHooksForTest,
  setMacOsBrowserRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-macos-bridge';
import {
  resetMacOsCapabilityBrokerSocketPathForTest,
  setMacOsCapabilityBrokerSocketPathForTest,
} from '../../src/runtime/plugins/macos-capability-broker';

if (process.platform !== 'darwin') throw new Error('Native silent browser E2E requires macOS.');

const repoRoot = mkdtempSync(join(tmpdir(), 'forge-browser-live-'));
const controllerHome = mkdtempSync(join(tmpdir(), 'forge-browser-live-controller-'));
let server: ReturnType<typeof Bun.serve> | undefined;
let sessionId = '';
const scripts: string[] = [];
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

async function runAppleScript(script: string, args: string[] = []): Promise<string> {
  scripts.push(script);
  const started = performance.now();
  const kind = script.includes('make new tab at end of tabs of targetWindow') ? 'create'
    : script.includes('execute targetTab javascript') ? 'js'
      : script.includes('set targetIsActive') ? 'target-metadata'
        : script.includes('close targetTab') ? 'close'
          : script.includes('set targetTab to active tab of targetWindow') ? 'active-metadata' : 'other';
  const child = Bun.spawn(['/usr/bin/osascript', '-e', script, '--', ...args], { stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timer);
  timings.push({ kind: timedOut ? `${kind}-timeout` : kind, ms: Math.round((performance.now() - started) * 10) / 10 });
  if (timedOut) throw new Error(`osascript timed out: ${kind}`);
  if (exitCode !== 0) throw new Error(stderr || `osascript exited ${exitCode}`);
  return stdout.trim();
}

async function action(actionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await executeBrowserPluginAction({
    controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId,
    requestId: `browser-live-${actionId}-${crypto.randomUUID()}`, args, origin: { surface: 'local-ui', actor: 'e2e' },
  });
}

try {
  process.env.FORGE_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
  mkdirSync(join(repoRoot, '.forge/plugins'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  registerRepository({ path: repoRoot, controllerHome });

  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const title = path === '/three' ? 'Forge Three' : path === '/two' ? 'Forge Two' : 'Forge One';
      return new Response(`<!doctype html><title>${title}</title><body><main>${title}</main><input id="email"><button id="btn" onclick="document.querySelector('#status').textContent='clicked:'+document.querySelector('#email').value">Apply</button><a id="next" href="/three">Next</a><div id="status">idle</div></body>`, { headers: { 'content-type': 'text/html' } });
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
  setMacOsCapabilityBrokerSocketPathForTest(join(tmpdir(), `forge-browser-live-no-broker-${process.pid}.sock`));
  setMacOsBrowserRuntimeHooksForTest({ platform: 'darwin', appExists: () => true, processRunning: async () => true, runAppleScript });

  const userTabBefore = await runAppleScript('tell application "Google Chrome" to return URL of active tab of front window as text');
  const first = await action('get_text', { url: one });
  assert(String(first.text).includes('Forge One'));
  sessionId = String(first.sessionId);
  const firstTabId = nativeTabId(first);
  const second = await action('open_page', { session_id: sessionId, url: two });
  const secondTabId = nativeTabId(second);
  assert.notEqual(secondTabId, firstTabId);

  const filled = await action('fill', { session_id: sessionId, selector: '#email', text: 'silent@example.com', post_action_wait_ms: 1 });
  assert.equal(filled.evidenceMode, 'dom');
  assert(!('screenshot' in filled));
  await action('click', { session_id: sessionId, selector: '#btn', post_action_wait_ms: 1 });
  assert(String((await action('get_text', { session_id: sessionId, selector: '#status' })).text).includes('clicked:silent@example.com'));

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
  assert.equal(await runAppleScript('tell application "Google Chrome" to return URL of active tab of front window as text'), userTabBefore);
  assert.equal(scripts.some((script) => /\n\s*activate\s*\n/.test(script) || script.includes('set index of targetWindow to 1')), false);
  console.log(JSON.stringify({ ok: true, appleScriptCalls: timings.length, durationMs: Math.round(timings.reduce((sum, entry) => sum + entry.ms, 0)), timings }));
} finally {
  if (sessionId) await action('close_session', { session_id: sessionId }).catch(() => undefined);
  server?.stop(true);
  resetBrowserPluginRuntimeHooksForTest();
  resetMacOsBrowserRuntimeHooksForTest();
  resetMacOsCapabilityBrokerSocketPathForTest();
  delete process.env.FORGE_CONTROLLER_HOME;
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(controllerHome, { recursive: true, force: true });
}
