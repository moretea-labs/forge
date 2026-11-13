#!/usr/bin/env bun
/** Real native Chrome resource lifecycle; no Runtime installation or user-tab cleanup. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';
import { writeControllerPluginConfig } from '../../src/runtime/plugins/config-store';
import { listMacOsBrowserTabs } from '../../src/runtime/plugins/browser-macos-bridge';
import { disposeRuntimeComputerComposition } from '../../src/runtime/root/computer-composition';

const root = mkdtempSync(join(tmpdir(), 'forge-tab-retention-'));
const controllerHome = join(root, 'controller');
assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
const repo = registerRepository({ path: root, controllerHome });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<title>Forge retention acceptance</title><p>Disposable acceptance tab</p>', { headers: { 'content-type': 'text/html' } }) });
writeControllerPluginConfig(controllerHome, 'browser', { schemaVersion: 3, enabled: true, provider: 'playwright', browserMode: 'attach_preferred', cdpAttachFallback: 'fail_closed', nativeAttachMode: 'auto', nativeBrowserCandidates: ['chrome'], defaultTimeoutMs: 10000 });
const pending = new Set<string>();
const samples: Record<string, unknown>[] = [];
let safeProviderRetries = 0;
const inventory = () => listMacOsBrowserTabs('chrome', 10000, { correctFrontmost: false });
function memoryMiB() {
  const ps = spawnSync('/bin/ps', ['-axo', 'rss=,comm='], { encoding: 'utf8' });
  assert.equal(ps.status, 0);
  return Math.round(ps.stdout.split('\n').filter(line => line.includes('Google Chrome')).reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]), 0) / 1024);
}
async function action(actionId: string, args: Record<string, unknown>) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await computerPluginAdapter.executeAction({ controllerHome, repoId: repo.repoId, repoRoot: root, pluginId: 'computer', actionId, requestId: `tab-retention-${crypto.randomUUID()}`, args, origin: { surface: 'local-ui', actor: 'retention-e2e' } });
    } catch (error) {
      const failure = error as { code?: string; retryable?: boolean; effectOutcome?: string };
      // Same explicit pre-dispatch rejection contract as browser-runtime-v3.e2e.
      if (failure.code !== 'BROWSER_AUTOMATION_SERIALIZATION_BUSY'
        || failure.retryable !== true || failure.effectOutcome !== 'failed' || attempt === 3) throw error;
      safeProviderRetries++;
      await Bun.sleep(100 * attempt);
    }
  }
  throw new Error('Provider admission retry budget exhausted');
}
try {
  const before = await inventory();
  assert.equal(before.truncated, false);
  const baselineIds = new Set(before.tabs.map(tab => tab.tabId));
  samples.push({ phase: 'baseline', tabs: before.tabs.length, chromeSummedRssMiB: memoryMiB() });
  for (let cycle = 0; cycle < 5; cycle++) {
    for (let i = 0; i < 3; i++) {
      const opened = await action('create_session', { url: `http://127.0.0.1:${server.port}/cycle-${cycle}-${i}`, extract_text: false });
      const sessionId = (opened.session as { sessionId: string }).sessionId;
      pending.add(sessionId);
      assert.equal(typeof sessionId, 'string');
    }
    const peak = await inventory();
    assert.equal(peak.tabs.length, before.tabs.length + 3, 'three owned resources must exist');
    samples.push({ phase: `cycle-${cycle}-open`, tabs: peak.tabs.length, chromeSummedRssMiB: memoryMiB() });
    for (const sessionId of pending) {
      const closed = await action('close_session', { session_id: sessionId });
      assert.equal(closed.resourceClosed, true, 'metadata deletion alone is insufficient');
      pending.delete(sessionId);
    }
    const after = await inventory();
    assert.equal(after.truncated, false);
    assert.deepEqual(new Set(after.tabs.map(tab => tab.tabId)), baselineIds, 'all original tabs preserved and every test tab gone');
    const sessions = await action('list_sessions', {});
    assert.equal(sessions.savedSessionCount, 0);
    samples.push({ phase: `cycle-${cycle}-closed`, tabs: after.tabs.length, chromeSummedRssMiB: memoryMiB() });
    console.log(JSON.stringify(samples.at(-1)));
  }
  console.log(JSON.stringify({ ok: true, safeProviderRetries, cycles: 5, createdAndClosed: 15, samples, memorySemantics: 'summed RSS includes shared pages; concurrent browser activity is not attributable to this test' }));
} finally {
  for (const sessionId of pending) {
    try { await action('close_session', { session_id: sessionId }); pending.delete(sessionId); }
    catch (error) { console.error('Acceptance resource retained:', sessionId, String(error)); }
  }
  server.stop(true);
  disposeRuntimeComputerComposition();
  if (pending.size === 0) rmSync(root, { recursive: true, force: true });
  else console.error('Retained acceptance controller:', controllerHome);
}
