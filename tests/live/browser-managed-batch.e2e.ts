#!/usr/bin/env bun
// Source-bound browser benchmark: real Chrome engine, private headless profile.
// Never adopts the user's Chrome tabs or changes the foreground application.
// Measures the Browser adapter/provider path; excludes model and MCP transport.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { executeBrowserPluginAction, resetBrowserPluginRuntimeHooksForTest, setBrowserPluginRuntimeHooksForTest } from '../../src/runtime/plugins/browser-adapter';
import { writeControllerPluginConfig } from '../../src/runtime/plugins/config-store';

const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (process.platform !== 'darwin' || !existsSync(chromeExecutable)) {
  throw new Error('Browser managed benchmark requires installed macOS Google Chrome.');
}
const repoRoot = mkdtempSync(join(tmpdir(), 'forge-browser-managed-benchmark-'));
const controllerHome = mkdtempSync(join(tmpdir(), 'forge-browser-managed-controller-'));
const contexts: BrowserContext[] = [];
const samples = 12;
const sequential: number[] = [];
const batched: number[] = [];
let sessionId = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let launchCount = 0;

function quantile(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(sorted.length * percentile));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}
async function action(actionId: string, args: Record<string, unknown>) {
  return executeBrowserPluginAction({
    controllerHome, repoId: 'benchmark-repo', repoRoot, pluginId: 'browser',
    actionId, args, origin: { surface: 'local-ui', actor: 'browser-managed-benchmark' },
    requestId: 'managed-benchmark-' + crypto.randomUUID(),
  });
}
async function trial(variant: 'sequential' | 'batch', index: number): Promise<number> {
  const marker = 'trial-' + index + '-' + variant;
  const steps = [
    { action: 'fill', selector: '#email', text: marker + '-a' },
    { action: 'click', selector: '#apply' },
    { action: 'wait_for_selector', selector: '#status', state: 'visible' },
    { action: 'fill', selector: '#email', text: marker + '-b' },
    { action: 'click', selector: '#apply' },
    { action: 'wait_for_selector', selector: '#status', state: 'visible' },
  ];
  const startedAt = performance.now();
  if (variant === 'batch') {
    const result = await action('run_steps', { session_id: sessionId, steps });
    assert.equal((result.action as Record<string, unknown>).completedSteps, 6);
    assert.equal(result.evidenceMode, 'summary');
    assert(!('screenshot' in result), 'batch should not capture screenshot');
  } else {
    for (const step of steps) {
      const { action: stepAction, ...argumentsWithoutAction } = step;
      await action(stepAction, { session_id: sessionId, ...argumentsWithoutAction });
    }
  }
  const elapsed = performance.now() - startedAt;
  const observed = await action('get_text', { session_id: sessionId, selector: '#status' });
  assert.equal(String(observed.text).trim(), 'clicked:' + marker + '-b');
  return Math.round(elapsed * 100) / 100;
}

try {
  writeControllerPluginConfig(controllerHome, 'browser', {
    schemaVersion: 3, enabled: true, provider: 'playwright', browserMode: 'managed_persistent',
    profileMode: 'repo_local', browserChannel: 'chrome', nativeAttachMode: 'disabled',
    cdpAttachFallback: 'fail_closed', defaultTimeoutMs: 10000,
  });
  setBrowserPluginRuntimeHooksForTest({
    moduleAvailable: () => true,
    loadPlaywright: () => ({
      chromium: {
        launchPersistentContext: async (dir: string, options: Record<string, unknown>) => {
          const { channel: _unused, ...rest } = options;
          const context = await chromium.launchPersistentContext(dir, {
            ...rest, headless: true, executablePath: chromeExecutable,
          });
          launchCount += 1;
          contexts.push(context);
          return context;
        },
      },
    }),
  });
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch() {
      return new Response('<!doctype html><title>Browser Batch Benchmark</title><input id="email"><button id="apply" onclick="document.querySelector(\'#status\').textContent=\'clicked:\'+document.querySelector(\'#email\').value">Apply</button><div id="status">idle</div>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const created = await action('create_session', { url: 'http://127.0.0.1:' + server.port + '/' });
  const createdSession = created.session && typeof created.session === 'object'
    ? created.session as Record<string, unknown> : undefined;
  sessionId = String(createdSession?.sessionId ?? created.sessionId ?? '');
  assert(sessionId && sessionId !== 'undefined', 'Browser session was not returned');

  // Two orders are interleaved to reduce time-order bias, with one warmup pair.
  for (let index = 0; index <= samples; index++) {
    const order: Array<'sequential' | 'batch'> = index % 2 === 0
      ? ['sequential', 'batch'] : ['batch', 'sequential'];
    for (const variant of order) {
      const ms = await trial(variant, index);
      if (index !== 0) (variant === 'sequential' ? sequential : batched).push(ms);
    }
  }
  console.log(JSON.stringify({
    benchmark: 'browser-managed-batch', provider: 'real-headless-chrome',
    samples, stepsPerTrial: 6, launchCount,
    sequential: { p50Ms: quantile(sequential, 0.5), p95Ms: quantile(sequential, 0.95) },
    batched: { p50Ms: quantile(batched, 0.5), p95Ms: quantile(batched, 0.95) },
    evidence: 'DOM state asserted after each trial; no model/network latency or user Chrome tabs',
  }, null, 2));
} finally {
  // The isolated Browser runtime owns persistent pages. Close the exact
  // fixture context rather than touching any pre-existing user Chrome.
  await Promise.allSettled(contexts.map((context) => context.close()));
  server?.stop(true);
  resetBrowserPluginRuntimeHooksForTest();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(controllerHome, { recursive: true, force: true });
}
