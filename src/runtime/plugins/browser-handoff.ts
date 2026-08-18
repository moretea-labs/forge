import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from '../shared/json-files';
import { resolveBunExecutable } from '../shared/process-environment';
import { AssistantPluginError } from './errors';
import type { MacOsBrowserProduct, MacOsBrowserTabRef } from './browser-macos-bridge';
import {
  interactionLaunchSpecPath,
  isInteractionSessionActive,
  listInteractionSessions,
  patchInteractionSession,
  pruneInteractionSessions,
  readInteractionSession,
  writeInteractionCommand,
  writeInteractionSession,
  type InteractionSessionRecord,
} from './interaction-session';

const PROVIDER = 'browser' as const;
const DEFAULT_HANDOFF_TIMEOUT_MS = 10 * 60_000;
const MAX_HANDOFF_TIMEOUT_MS = 60 * 60_000;
const STARTUP_GRACE_MS = 15_000;
const STARTUP_POLL_MS = 50;
const MAX_STARTUP_LOG_CHARS = 4_000;
const MAX_TERMINAL_BROWSER_HANDOFFS = 20;

export interface BrowserHandoffLaunchSpec {
  schemaVersion: 1;
  repoRoot: string;
  interactionId: string;
  sessionId: string;
  sessionPath: string;
  url: string;
  profileDir: string;
  selectedProfilePath: string;
  profileDirectory?: string;
  browserChannel?: string;
  executablePath?: string;
  defaultTimeoutMs: number;
  nativeBrowser?: { product: MacOsBrowserProduct; ref: MacOsBrowserTabRef };
  expiresAt: string;
}

export interface BrowserHandoffStartInput {
  repoRoot: string;
  repoId: string;
  requestId: string;
  jobId?: string;
  sessionId: string;
  sessionPath: string;
  url: string;
  profileDir: string;
  selectedProfilePath: string;
  profileDirectory?: string;
  browserChannel?: string;
  executablePath?: string;
  defaultTimeoutMs: number;
  nativeBrowser?: { product: MacOsBrowserProduct; ref: MacOsBrowserTabRef };
  reason: string;
  instructions?: string;
  timeoutMs?: number;
}

export interface BrowserHandoffRuntimeHooks {
  now(): string;
  pidAlive(pid: number | undefined): boolean;
  spawnHost(specPath: string): { pid?: number };
  signal(pid: number, signal: NodeJS.Signals): void;
  wait(ms: number): Promise<void>;
}

function defaultPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveBrowserHandoffHostExecutable(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const executable = basename(execPath).toLowerCase();
  if (executable === 'node' || executable === 'node.exe' || executable === 'nodejs') return execPath;
  return resolveBunExecutable(execPath, env);
}

export function resolveBrowserHandoffHostPath(
  execPath: string = process.execPath,
  argvEntry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): string {
  const releaseEntry = join(dirname(execPath), 'browser-handoff-host.js');
  if (existsSync(releaseEntry)) return releaseEntry;
  const argvReleaseEntry = argvEntry ? join(dirname(argvEntry), 'browser-handoff-host.js') : undefined;
  if (argvReleaseEntry && existsSync(argvReleaseEntry)) return argvReleaseEntry;
  const sourceEntry = fileURLToPath(new URL('./browser-handoff-host.ts', moduleUrl));
  if (existsSync(sourceEntry)) return sourceEntry;
  throw new AssistantPluginError('PLUGIN_BROWSER_HANDOFF_HOST_MISSING', 'Browser handoff host sidecar is unavailable in the active Runtime release.', { retryable: false });
}

const defaultHooks: BrowserHandoffRuntimeHooks = {
  now: () => new Date().toISOString(),
  pidAlive: defaultPidAlive,
  spawnHost: (specPath) => {
    const sourceEntry = fileURLToPath(new URL('./browser-handoff-host.ts', import.meta.url));
    const loader = fileURLToPath(new URL('../shared/node-ts-loader.mjs', import.meta.url));
    const entry = resolveBrowserHandoffHostPath();
    const args = entry === sourceEntry && !process.versions.bun ? ['--loader', loader, entry, specPath] : [entry, specPath];
    const logPath = specPath.replace(/\.json$/u, '.log');
    const logFd = openSync(logPath, 'a');
    try {
      const child = spawn(resolveBrowserHandoffHostExecutable(), args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd: process.cwd(),
        env: { ...process.env },
      });
      child.once('error', () => undefined);
      child.unref();
      return { pid: child.pid };
    } finally {
      closeSync(logFd);
    }
  },
  signal: (pid, signal) => process.kill(pid, signal),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let hooks: BrowserHandoffRuntimeHooks = { ...defaultHooks };

export function setBrowserHandoffRuntimeHooksForTest(overrides: Partial<BrowserHandoffRuntimeHooks>): void {
  hooks = { ...defaultHooks, ...overrides };
}

export function resetBrowserHandoffRuntimeHooksForTest(): void {
  hooks = { ...defaultHooks };
}

function boundedTimeout(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return DEFAULT_HANDOFF_TIMEOUT_MS;
  return Math.min(Math.trunc(value), MAX_HANDOFF_TIMEOUT_MS);
}

function reconcileRecord(_repoRoot: string, record: InteractionSessionRecord): InteractionSessionRecord {
  if (!isInteractionSessionActive(record.status)) return record;
  const now = hooks.now();
  const nowMs = Date.parse(now);
  const createdMs = Date.parse(record.createdAt);
  const expired = Number.isFinite(nowMs) && Number.isFinite(Date.parse(record.expiresAt)) && nowMs >= Date.parse(record.expiresAt);
  const startupGrace = record.status === 'starting' && Number.isFinite(createdMs) && nowMs - createdMs < STARTUP_GRACE_MS;
  const live = hooks.pidAlive(record.host?.pid);
  const runtimeManaged = record.targetAliases?.includes('runtime-managed') === true;
  if (runtimeManaged && expired) {
    return {
      ...record,
      status: 'failed',
      updatedAt: now,
      error: { code: 'HANDOFF_EXPIRED', message: 'The runtime-managed browser handoff expired before it was resumed.' },
    };
  }
  if (record.status === 'closing') {
    if (live) return record;
    return {
      ...record,
      status: 'failed',
      updatedAt: now,
      error: record.error ?? { code: 'HANDOFF_HOST_NOT_RUNNING', message: 'The browser handoff host stopped while closing.' },
    };
  }
  if (expired && live) {
    return {
      ...record,
      status: 'closing',
      updatedAt: now,
      error: { code: 'HANDOFF_EXPIRED', message: 'The browser handoff expired and its host is closing before the profile is released.' },
    };
  }
  if (!expired && (live || startupGrace)) return record;
  return {
    ...record,
    status: 'failed',
    updatedAt: now,
    error: {
      code: expired ? 'HANDOFF_EXPIRED' : 'HANDOFF_HOST_NOT_RUNNING',
      message: expired ? 'The browser handoff expired before it was resumed.' : 'The browser handoff host is no longer running.',
    },
  };
}

function pruneBrowserHandoffLogs(repoRoot: string): number {
  const retained = new Set(listInteractionSessions(repoRoot, PROVIDER).map((record) => record.interactionId));
  const launchRoot = dirname(interactionLaunchSpecPath(repoRoot, PROVIDER, '__probe__'));
  if (!existsSync(launchRoot)) return 0;
  let removed = 0;
  for (const name of readdirSync(launchRoot)) {
    if (!name.endsWith('.log')) continue;
    const interactionId = name.slice(0, -'.log'.length);
    if (retained.has(interactionId)) continue;
    rmSync(join(launchRoot, name), { force: true });
    removed += 1;
  }
  return removed;
}

function persistDeadBrowserHandoffs(repoRoot: string): void {
  for (const stored of listInteractionSessions(repoRoot, PROVIDER)) {
    const reconciled = reconcileRecord(repoRoot, stored);
    if (stored.status !== reconciled.status && reconciled.status === 'failed') writeInteractionSession(repoRoot, reconciled);
  }
  pruneInteractionSessions(repoRoot, PROVIDER, MAX_TERMINAL_BROWSER_HANDOFFS);
  pruneBrowserHandoffLogs(repoRoot);
}

export function listBrowserHandoffs(repoRoot: string): InteractionSessionRecord[] {
  return listInteractionSessions(repoRoot, PROVIDER).map((record) => reconcileRecord(repoRoot, record));
}

export function getBrowserHandoff(repoRoot: string, interactionId: string): InteractionSessionRecord {
  const record = readInteractionSession(repoRoot, PROVIDER, interactionId);
  if (!record) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', `Unknown browser handoff: ${interactionId}`, { retryable: false });
  }
  return reconcileRecord(repoRoot, record);
}

export function assertBrowserProfileAvailable(repoRoot: string, selectedProfilePath: string): void {
  const active = listBrowserHandoffs(repoRoot).find((record) =>
    record.targetId === selectedProfilePath && isInteractionSessionActive(record.status));
  if (!active) return;
  throw new AssistantPluginError('PLUGIN_RESOURCE_BUSY', 'The browser profile is currently owned by a human handoff session.', {
    retryable: true,
    details: {
      interactionId: active.interactionId,
      sessionId: active.sessionId,
      status: active.status,
    },
  });
}

export function assertBrowserSessionAvailable(repoRoot: string, sessionId?: string): void {
  const active = listBrowserHandoffs(repoRoot).find((record) =>
    isInteractionSessionActive(record.status) && (!sessionId || record.sessionId === sessionId));
  if (!active) return;
  throw new AssistantPluginError('PLUGIN_RESOURCE_BUSY', 'Browser session metadata cannot be changed while a human handoff is active.', {
    retryable: true,
    details: {
      interactionId: active.interactionId,
      sessionId: active.sessionId,
      status: active.status,
    },
  });
}

function startupDiagnostic(specPath: string): string | undefined {
  const logPath = specPath.replace(/\.json$/u, '.log');
  if (!existsSync(logPath)) return undefined;
  try {
    const text = readFileSync(logPath, 'utf8').trim();
    return text ? text.slice(-MAX_STARTUP_LOG_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

async function waitForBrowserHandoffStartup(
  repoRoot: string,
  interactionId: string,
  specPath: string,
  pid: number | undefined,
): Promise<InteractionSessionRecord> {
  const deadline = Date.now() + STARTUP_GRACE_MS;
  while (Date.now() < deadline) {
    const current = readInteractionSession(repoRoot, PROVIDER, interactionId);
    if (!current) break;
    if (current.status !== 'starting') {
      if (current.status === 'waiting_for_user') return current;
      throw new AssistantPluginError('PLUGIN_ACTION_FAILED', current.error?.message ?? `Browser handoff entered ${current.status}.`, {
        retryable: current.status === 'failed',
        details: { interactionId, status: current.status, error: current.error },
      });
    }
    if (!hooks.pidAlive(pid)) {
      const diagnostic = startupDiagnostic(specPath);
      const message = diagnostic
        ? `The browser handoff host exited during startup: ${diagnostic}`
        : 'The browser handoff host exited during startup.';
      const failed = patchInteractionSession(repoRoot, PROVIDER, interactionId, {
        status: 'failed',
        error: { code: 'HANDOFF_HOST_START_FAILED', message },
      });
      throw new AssistantPluginError('PLUGIN_ACTION_FAILED', message, {
        retryable: true,
        details: { interactionId, status: failed?.status ?? 'failed' },
      });
    }
    await hooks.wait(STARTUP_POLL_MS);
  }
  if (pid && hooks.pidAlive(pid)) {
    try { hooks.signal(pid, 'SIGTERM'); } catch { /* host may exit concurrently */ }
  }
  const message = 'The browser handoff host did not become ready before the startup deadline.';
  patchInteractionSession(repoRoot, PROVIDER, interactionId, {
    status: 'failed',
    error: { code: 'HANDOFF_HOST_START_TIMEOUT', message },
  });
  throw new AssistantPluginError('PLUGIN_ACTION_FAILED', message, { retryable: true, details: { interactionId } });
}

export function isRuntimeManagedBrowserHandoff(record: InteractionSessionRecord): boolean {
  return record.targetAliases?.includes('runtime-managed') === true;
}

export function startRuntimeManagedBrowserHandoff(
  input: BrowserHandoffStartInput,
  result: { url?: string; title?: string },
): InteractionSessionRecord {
  persistDeadBrowserHandoffs(input.repoRoot);
  assertBrowserProfileAvailable(input.repoRoot, input.selectedProfilePath);
  const timestamp = hooks.now();
  const interactionId = `browser_handoff_${randomUUID()}`;
  const expiresAt = new Date(Date.parse(timestamp) + boundedTimeout(input.timeoutMs)).toISOString();
  const record: InteractionSessionRecord = {
    schemaVersion: 1,
    interactionId,
    provider: PROVIDER,
    sessionId: input.sessionId,
    targetId: input.selectedProfilePath,
    targetAliases: ['runtime-managed'],
    status: 'waiting_for_user',
    reason: input.reason,
    instructions: input.instructions,
    owner: {
      repoId: input.repoId,
      requestId: input.requestId,
      jobId: input.jobId,
    },
    host: {
      pid: process.pid,
      startedAt: timestamp,
      heartbeatAt: timestamp,
      foregroundPresented: true,
    },
    result,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt,
  };
  return writeInteractionSession(input.repoRoot, record);
}

export function resolveRuntimeManagedBrowserHandoff(
  repoRoot: string,
  interactionId: string,
  resolution: 'resume' | 'cancel',
  result?: { url?: string; title?: string },
): InteractionSessionRecord {
  const current = getBrowserHandoff(repoRoot, interactionId);
  if (!isRuntimeManagedBrowserHandoff(current)) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'The browser handoff is not runtime-managed.', { retryable: false });
  }
  if (!isInteractionSessionActive(current.status)) return current;
  return patchInteractionSession(repoRoot, PROVIDER, interactionId, {
    status: resolution === 'resume' ? 'completed' : 'closed',
    result: result ?? current.result,
    host: {
      ...current.host,
      heartbeatAt: hooks.now(),
      foregroundPresented: false,
    },
  }) ?? current;
}

export async function startBrowserHandoff(input: BrowserHandoffStartInput): Promise<InteractionSessionRecord> {
  persistDeadBrowserHandoffs(input.repoRoot);
  assertBrowserProfileAvailable(input.repoRoot, input.selectedProfilePath);
  const timestamp = hooks.now();
  const interactionId = `browser_handoff_${randomUUID()}`;
  const expiresAt = new Date(Date.parse(timestamp) + boundedTimeout(input.timeoutMs)).toISOString();
  const record: InteractionSessionRecord = {
    schemaVersion: 1,
    interactionId,
    provider: PROVIDER,
    sessionId: input.sessionId,
    targetId: input.selectedProfilePath,
    status: 'starting',
    reason: input.reason,
    instructions: input.instructions,
    owner: {
      repoId: input.repoId,
      requestId: input.requestId,
      jobId: input.jobId,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt,
  };
  writeInteractionSession(input.repoRoot, record);
  const spec: BrowserHandoffLaunchSpec = {
    schemaVersion: 1,
    repoRoot: input.repoRoot,
    interactionId,
    sessionId: input.sessionId,
    sessionPath: input.sessionPath,
    url: input.url,
    profileDir: input.profileDir,
    selectedProfilePath: input.selectedProfilePath,
    profileDirectory: input.profileDirectory,
    browserChannel: input.browserChannel,
    executablePath: input.executablePath,
    defaultTimeoutMs: input.defaultTimeoutMs,
    nativeBrowser: input.nativeBrowser,
    expiresAt,
  };
  const specPath = interactionLaunchSpecPath(input.repoRoot, PROVIDER, interactionId);
  writeJsonAtomic(specPath, spec);
  try {
    const child = hooks.spawnHost(specPath);
    patchInteractionSession(input.repoRoot, PROVIDER, interactionId, {
      host: { pid: child.pid, startedAt: timestamp },
    });
    return await waitForBrowserHandoffStartup(input.repoRoot, interactionId, specPath, child.pid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patchInteractionSession(input.repoRoot, PROVIDER, interactionId, {
      status: 'failed',
      error: { code: 'HANDOFF_HOST_START_FAILED', message },
    });
    throw new AssistantPluginError('PLUGIN_ACTION_FAILED', `Unable to start browser handoff host: ${message}`, { retryable: true });
  }
}

export function resumeBrowserHandoff(repoRoot: string, interactionId: string, requestedBy: string): InteractionSessionRecord {
  const current = getBrowserHandoff(repoRoot, interactionId);
  if (!isInteractionSessionActive(current.status) || current.status === 'closing') return current;
  writeInteractionCommand(repoRoot, PROVIDER, interactionId, 'resume', requestedBy);
  return current;
}

export function cancelBrowserHandoff(repoRoot: string, interactionId: string, requestedBy: string): InteractionSessionRecord {
  const current = getBrowserHandoff(repoRoot, interactionId);
  if (!isInteractionSessionActive(current.status) || current.status === 'closing') return current;
  writeInteractionCommand(repoRoot, PROVIDER, interactionId, 'cancel', requestedBy);
  if (current.host?.pid && hooks.pidAlive(current.host.pid)) {
    try {
      hooks.signal(current.host.pid, 'SIGTERM');
    } catch {
      // The host may have completed between the liveness check and signal.
    }
  }
  return current;
}
