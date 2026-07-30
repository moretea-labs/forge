import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeBrowserPluginAction } from '../src/runtime/plugins/browser-adapter';

interface CdpTarget {
  type?: string;
  url?: string;
}

function endpointFromArgs(): string {
  const endpoint = process.argv[2] ?? process.env.REPO_HARNESS_BROWSER_CDP_ENDPOINT;
  if (!endpoint) throw new Error('Pass a loopback CDP endpoint as argv[2] or REPO_HARNESS_BROWSER_CDP_ENDPOINT.');
  const parsed = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Live Browser CDP smoke accepts loopback endpoints only.');
  }
  return endpoint;
}

async function readTargets(endpoint: string): Promise<CdpTarget[]> {
  const response = await fetch(new URL('/json/list', new URL(endpoint).origin));
  if (!response.ok) throw new Error(`CDP target inventory returned HTTP ${response.status}.`);
  return await response.json() as CdpTarget[];
}

async function main(): Promise<void> {
  const endpoint = endpointFromArgs();
  const before = await readTargets(endpoint);
  const target = before.find((entry) => entry.type === 'page' && typeof entry.url === 'string' && /^https?:\/\//.test(entry.url));
  if (!target?.url) throw new Error('No existing HTTP(S) page target is available for reuse proof.');
  const hostname = new URL(target.url).hostname;
  const repoRoot = mkdtempSync(join(tmpdir(), 'matea-browser-cdp-smoke-'));
  try {
    mkdirSync(join(repoRoot, '.repo-harness/plugins'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness/plugins/browser.json'), `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpEndpoint: endpoint,
      cdpAttachFallback: 'fail_closed',
      allowedDomains: [hostname],
    }, null, 2)}\n`, 'utf8');

    const base = {
      controllerHome: repoRoot,
      repoId: 'browser-cdp-live-smoke',
      repoRoot,
      pluginId: 'browser',
      origin: { surface: 'local-ui' as const, actor: 'browser-cdp-live-smoke' },
    };
    const sessionId = 'browser_cdp_live_smoke';
    const first = await executeBrowserPluginAction({
      ...base,
      actionId: 'open_page',
      requestId: 'browser-cdp-live-smoke-1',
      args: { url: target.url, session_id: sessionId, timeout_ms: 30_000 },
    });
    const second = await executeBrowserPluginAction({
      ...base,
      actionId: 'open_page',
      requestId: 'browser-cdp-live-smoke-2',
      args: { url: target.url, session_id: sessionId, timeout_ms: 30_000 },
    });
    const after = await readTargets(endpoint);
    const firstConnection = first.browserConnection as Record<string, unknown>;
    const secondConnection = second.browserConnection as Record<string, unknown>;
    const firstTab = firstConnection.tab as Record<string, unknown>;
    const secondTab = secondConnection.tab as Record<string, unknown>;
    if (firstConnection.attached !== true || secondConnection.attached !== true) throw new Error('Browser action did not use CDP attach.');
    if (firstTab.matchedBy === 'new_page' || secondTab.matchedBy === 'new_page') throw new Error('Browser action created a duplicate tab.');
    if (after.length !== before.length) throw new Error(`CDP target count changed from ${before.length} to ${after.length}.`);
    const versionResponse = await fetch(new URL('/json/version', new URL(endpoint).origin));
    if (!versionResponse.ok) throw new Error('Attached browser did not remain available after bridge disconnect.');
    console.log(JSON.stringify({
      ok: true,
      hostname,
      targetCountBefore: before.length,
      targetCountAfter: after.length,
      firstMatchedBy: firstTab.matchedBy,
      resumedMatchedBy: secondTab.matchedBy,
      browserSurvivedDisconnect: true,
    }));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Browser CDP live smoke failed.');
  process.exitCode = 1;
});
