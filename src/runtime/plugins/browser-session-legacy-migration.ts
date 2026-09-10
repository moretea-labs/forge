import { createHash } from 'crypto';
import { readdirSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import type { BrowserSessionState } from '../../../packages/protocols/browser/index';
import {
  listAllControlPlaneRecords,
  readControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import { AssistantPluginError } from './errors';

const LEGACY_SESSION_NAMESPACE = 'browser_session';
const LEGACY_SESSION_SCOPE = 'controller';
const LEGACY_IMPORT_NAMESPACE = 'browser_session_legacy_import';
const LEGACY_IMPORT_CUTOVER_SCOPE = 'controller';
const LEGACY_IMPORT_CUTOVER_KEY = 'v2-browser-session-import-cutover';

export interface LegacyBrowserSessionMigrationEntry {
  schemaVersion: 1;
  status: 'active' | 'tombstoned';
  session: BrowserSessionState;
  aliases: string[];
  repositoryIds: string[];
  nativeIdentity?: string;
  tombstonedAt?: string;
  importedFromLegacy?: boolean;
}

function digest40(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function nativeIdentity(session: BrowserSessionState): string | undefined {
  const browser = session.browser;
  const tab = browser?.tab;
  if (browser?.provider !== 'macos-apple-events' || !browser.browserProduct || !tab?.windowId || !tab.tabId) return undefined;
  return `${browser.provider}:${browser.browserProduct}:${tab.windowId}:${tab.tabId}`;
}

function assertSession(value: unknown, source: string): BrowserSessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_CORRUPT', 'Legacy Browser session metadata is malformed; migration stopped fail-closed.', {
      retryable: false,
      details: { source },
    });
  }
  const session = value as Partial<BrowserSessionState>;
  if (session.schemaVersion !== 1 || typeof session.sessionId !== 'string' || typeof session.url !== 'string'
    || typeof session.createdAt !== 'string' || typeof session.updatedAt !== 'string') {
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_CORRUPT', 'Legacy Browser session metadata is missing required fields; migration stopped fail-closed.', {
      retryable: false,
      details: { source },
    });
  }
  return session as BrowserSessionState;
}

function assertEntry(value: unknown): LegacyBrowserSessionMigrationEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LEGACY_BROWSER_SESSION_ENTRY_INVALID');
  const entry = value as Partial<LegacyBrowserSessionMigrationEntry>;
  if (entry.schemaVersion !== 1 || (entry.status !== 'active' && entry.status !== 'tombstoned')
    || !Array.isArray(entry.aliases) || !Array.isArray(entry.repositoryIds)) throw new Error('LEGACY_BROWSER_SESSION_ENTRY_INVALID');
  return {
    ...(entry as LegacyBrowserSessionMigrationEntry),
    session: assertSession(entry.session, 'controller-home:sqlite/browser_session'),
    aliases: unique(entry.aliases),
    repositoryIds: unique(entry.repositoryIds),
  };
}

function legacySessionDirectories(controllerHome: string, repoId: string, repoRoot: string): string[] {
  return [...new Set([
    join(repoRoot, '.forge', 'browser', 'sessions'),
    join(controllerHome, 'repositories', repoId, 'browser', 'sessions'),
  ].map((path) => resolve(path)))];
}

function readJsonSessions(controllerHome: string, repoId: string, repoRoot: string): BrowserSessionState[] {
  const sessions: BrowserSessionState[] = [];
  for (const root of legacySessionDirectories(controllerHome, repoId, repoRoot)) {
    let names: string[];
    try { names = readdirSync(root); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(join(root, name), 'utf8')); } catch (error) {
        throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_CORRUPT', 'Legacy Browser session JSON is malformed; migration stopped fail-closed.', {
          retryable: false,
          details: { fileName: name, cause: error instanceof Error ? error.message : String(error) },
        });
      }
      sessions.push(assertSession(parsed, name));
    }
  }
  return sessions;
}

function legacyJsonImportAllowed(controllerHome: string, repoId: string, repoRoot: string): boolean {
  const globalCutover = readControlPlaneRecord<{ status?: string }>(
    controllerHome,
    LEGACY_IMPORT_NAMESPACE,
    LEGACY_IMPORT_CUTOVER_SCOPE,
    LEGACY_IMPORT_CUTOVER_KEY,
  );
  if (globalCutover?.value.status === 'closed') return false;
  const markerKey = digest40(resolve(repoRoot));
  return !readControlPlaneRecord(controllerHome, LEGACY_IMPORT_NAMESPACE, repoId, markerKey);
}

function mergeLegacyJson(entries: LegacyBrowserSessionMigrationEntry[], repoId: string, session: BrowserSessionState): void {
  const native = nativeIdentity(session);
  const index = entries.findIndex((entry) => native
    ? entry.nativeIdentity === native
    : !entry.nativeIdentity && entry.repositoryIds.includes(repoId)
      && (entry.session.sessionId === session.sessionId || entry.aliases.includes(session.sessionId)));
  const current = index >= 0 ? entries[index] : undefined;
  if (current?.status === 'tombstoned') return;
  if (current) {
    entries[index] = {
      ...current,
      status: 'active',
      session: { ...session, sessionId: current.session.sessionId, createdAt: current.session.createdAt },
      aliases: unique([...current.aliases, current.session.sessionId, session.sessionId]),
      repositoryIds: unique([...current.repositoryIds, repoId]),
      nativeIdentity: native ?? current.nativeIdentity,
      importedFromLegacy: true,
    };
    return;
  }
  entries.push({
    schemaVersion: 1,
    status: 'active',
    session,
    aliases: [session.sessionId],
    repositoryIds: [repoId],
    ...(native ? { nativeIdentity: native } : {}),
    importedFromLegacy: true,
  });
}

/** Read-only compatibility reader. It can consume retired Browser state but cannot mutate that authority. */
export function readLegacyBrowserSessionMigrationEntries(input: {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
}): LegacyBrowserSessionMigrationEntry[] {
  const entries = listAllControlPlaneRecords<LegacyBrowserSessionMigrationEntry>(input.controllerHome, {
    namespace: LEGACY_SESSION_NAMESPACE,
    scope: LEGACY_SESSION_SCOPE,
  }).map((record) => assertEntry(record.value));
  if (legacyJsonImportAllowed(input.controllerHome, input.repoId, input.repoRoot)) {
    for (const session of readJsonSessions(input.controllerHome, input.repoId, input.repoRoot)) mergeLegacyJson(entries, input.repoId, session);
  }
  return entries;
}

/** Repo-local/controller-home JSON is import-only. Removal after Computer migration is best-effort and idempotent. */
export function cleanupLegacyBrowserSessionJson(controllerHome: string, repoId: string, repoRoot: string): void {
  for (const root of legacySessionDirectories(controllerHome, repoId, repoRoot)) {
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try { rmSync(join(root, name), { force: true }); } catch { /* retry on a later Browser access */ }
    }
  }
}
