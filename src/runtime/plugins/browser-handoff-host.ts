import { createRequire } from 'module';
import { existsSync, rmSync } from 'fs';
import { basename } from 'path';
import { spawnSync } from 'child_process';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import {
  interactionCommandPath,
  patchInteractionSession,
  readInteractionCommand,
  removeInteractionCommand,
} from './interaction-session';
import type { BrowserHandoffLaunchSpec } from './browser-handoff';
import { activateMacOsBrowserOwnedTab, readMacOsBrowserOwnedTabMetadata } from './browser-macos-bridge';

const POLL_MS = 300;
const HEARTBEAT_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertHttpUrl(url: string): void {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Browser handoff only supports HTTP(S) URLs: ${url}`);
  }
}

function applicationName(channel?: string): string | undefined {
  if (channel === 'chrome') return 'Google Chrome';
  if (channel === 'chrome-beta') return 'Google Chrome Beta';
  if (channel === 'chrome-dev') return 'Google Chrome Dev';
  if (channel === 'chrome-canary') return 'Google Chrome Canary';
  if (!channel || channel === 'chromium') return 'Chromium';
  return undefined;
}

function presentForeground(channel?: string): boolean {
  if (process.platform !== 'darwin') return false;
  const app = applicationName(channel);
  return Boolean(app && spawnSync('/usr/bin/open', ['-a', app], { stdio: 'ignore' }).status === 0);
}

async function runNativeHandoff(specPath: string, spec: BrowserHandoffLaunchSpec): Promise<void> {
  const native = spec.nativeBrowser;
  if (!native) throw new Error('native browser handoff metadata is required');
  let terminalOutcome: {
    status: 'completed' | 'closed' | 'failed';
    error?: { code: string; message: string };
    result?: { url?: string; title?: string };
  } | undefined;
  const terminate = (status: 'closed' | 'failed', code: string, message: string): void => {
    if (terminalOutcome) return;
    terminalOutcome = { status, ...(status === 'failed' ? { error: { code, message } } : {}) };
    patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
      status: 'closing',
      error: terminalOutcome.error,
    });
  };
  const onSignal = (): void => terminate('closed', 'HANDOFF_CANCELLED', 'The browser handoff was cancelled.');
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    let metadata = await activateMacOsBrowserOwnedTab(native.product, native.ref, spec.defaultTimeoutMs);
    patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
      status: 'waiting_for_user',
      host: {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        foregroundPresented: metadata.frontmost && metadata.active === true,
      },
      result: { url: metadata.url, title: metadata.title },
    });

    let lastHeartbeat = 0;
    while (!terminalOutcome) {
      const nowMs = Date.now();
      if (nowMs >= Date.parse(spec.expiresAt)) {
        terminate('failed', 'HANDOFF_EXPIRED', 'The browser handoff expired before it was resumed.');
        break;
      }
      if (nowMs - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = nowMs;
        metadata = await readMacOsBrowserOwnedTabMetadata(native.product, native.ref, spec.defaultTimeoutMs);
        patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
          host: { pid: process.pid, heartbeatAt: new Date(nowMs).toISOString() },
          result: { url: metadata.url, title: metadata.title },
        });
      }
      const cancel = readInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'cancel');
      if (cancel) {
        removeInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'cancel');
        terminate('closed', 'HANDOFF_CANCELLED', 'The browser handoff was cancelled.');
        break;
      }
      const resume = readInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'resume');
      if (resume) {
        removeInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'resume');
        metadata = await readMacOsBrowserOwnedTabMetadata(native.product, native.ref, spec.defaultTimeoutMs);
        assertHttpUrl(metadata.url);
        const existing = existsSync(spec.sessionPath)
          ? readJsonFile<Record<string, unknown>>(spec.sessionPath, {})
          : {};
        const timestamp = new Date().toISOString();
        const result = { url: metadata.url, title: metadata.title };
        writeJsonAtomic(spec.sessionPath, {
          ...existing,
          schemaVersion: 1,
          sessionId: spec.sessionId,
          ...result,
          createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : timestamp,
          updatedAt: timestamp,
        });
        terminalOutcome = { status: 'completed', result };
        patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, { status: 'closing', result });
        break;
      }
      await delay(POLL_MS);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminate('failed', 'HANDOFF_HOST_FAILED', message);
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    rmSync(specPath, { force: true });
    for (const kind of ['resume', 'cancel'] as const) {
      rmSync(interactionCommandPath(spec.repoRoot, 'browser', spec.interactionId, kind), { force: true });
    }
    if (!terminalOutcome) {
      terminate('failed', 'HANDOFF_HOST_EXITED', `Browser handoff host ${basename(specPath)} exited without a terminal result.`);
    }
    if (terminalOutcome) patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, terminalOutcome);
  }
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('browser handoff launch spec path is required');
  const spec = readJsonFile<BrowserHandoffLaunchSpec>(specPath);
  assertHttpUrl(spec.url);
  if (spec.nativeBrowser) {
    await runNativeHandoff(specPath, spec);
    return;
  }
  const playwright = createRequire(import.meta.url)('playwright') as {
    chromium: {
      launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<{
        pages(): Array<{
          goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
          url(): string;
          title(): Promise<string>;
          bringToFront?(): Promise<void>;
        }>;
        newPage(): Promise<{
          goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
          url(): string;
          title(): Promise<string>;
          bringToFront?(): Promise<void>;
        }>;
        close(): Promise<void>;
      }>;
    };
  };
  const launchOptions: Record<string, unknown> = {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    ...(spec.executablePath ? { executablePath: spec.executablePath } : {}),
    ...(!spec.executablePath && spec.browserChannel && spec.browserChannel !== 'chromium'
      ? { channel: spec.browserChannel }
      : {}),
    ...(spec.profileDirectory ? { args: [`--profile-directory=${spec.profileDirectory}`] } : {}),
  };
  let context: Awaited<ReturnType<typeof playwright.chromium.launchPersistentContext>> | undefined;
  let terminalOutcome: {
    status: 'completed' | 'closed' | 'failed';
    error?: { code: string; message: string };
    result?: { url?: string; title?: string };
  } | undefined;
  const terminate = (status: 'closed' | 'failed', code: string, message: string): void => {
    if (terminalOutcome) return;
    terminalOutcome = { status, ...(status === 'failed' ? { error: { code, message } } : {}) };
    patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
      status: 'closing',
      error: terminalOutcome.error,
    });
  };
  const onSignal = (): void => terminate('closed', 'HANDOFF_CANCELLED', 'The browser handoff was cancelled.');
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    context = await playwright.chromium.launchPersistentContext(spec.profileDir, launchOptions);
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: spec.defaultTimeoutMs });
    if (page.bringToFront) await page.bringToFront();
    const foregroundPresented = presentForeground(spec.browserChannel);
    patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
      status: 'waiting_for_user',
      host: {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        foregroundPresented,
      },
      result: { url: page.url(), title: await page.title() },
    });

    let lastHeartbeat = 0;
    while (!terminalOutcome) {
      const nowMs = Date.now();
      if (nowMs >= Date.parse(spec.expiresAt)) {
        terminate('failed', 'HANDOFF_EXPIRED', 'The browser handoff expired before it was resumed.');
        break;
      }
      const pages = context.pages();
      if (pages.length === 0) {
        terminate('failed', 'BROWSER_CLOSED_BY_USER', 'The browser window was closed before the handoff was resumed.');
        break;
      }
      page = pages[pages.length - 1] ?? page;
      if (nowMs - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = nowMs;
        patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
          host: { pid: process.pid, heartbeatAt: new Date(nowMs).toISOString() },
          result: { url: page.url(), title: await page.title() },
        });
      }
      const cancel = readInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'cancel');
      if (cancel) {
        removeInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'cancel');
        terminate('closed', 'HANDOFF_CANCELLED', 'The browser handoff was cancelled.');
        break;
      }
      const resume = readInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'resume');
      if (resume) {
        removeInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'resume');
        assertHttpUrl(page.url());
        const existing = existsSync(spec.sessionPath)
          ? readJsonFile<Record<string, unknown>>(spec.sessionPath, {})
          : {};
        const timestamp = new Date().toISOString();
        const result = { url: page.url(), title: await page.title() };
        writeJsonAtomic(spec.sessionPath, {
          schemaVersion: 1,
          sessionId: spec.sessionId,
          ...result,
          createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : timestamp,
          updatedAt: timestamp,
        });
        terminalOutcome = { status: 'completed', result };
        patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, { status: 'closing', result });
        break;
      }
      await delay(POLL_MS);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminate('failed', 'HANDOFF_HOST_FAILED', message);
  } finally {
    if (context) await context.close().catch(() => undefined);
    rmSync(specPath, { force: true });
    for (const kind of ['resume', 'cancel'] as const) {
      rmSync(interactionCommandPath(spec.repoRoot, 'browser', spec.interactionId, kind), { force: true });
    }
    if (!terminalOutcome) {
      terminate('failed', 'HANDOFF_HOST_EXITED', `Browser handoff host ${basename(specPath)} exited without a terminal result.`);
    }
    if (terminalOutcome) patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, terminalOutcome);
  }
}

void main().catch((error) => {
  console.error('[forge browser handoff]', error);
  process.exitCode = 1;
});
