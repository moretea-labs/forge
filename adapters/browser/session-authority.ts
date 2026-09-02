import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  DEFAULT_BROWSER_SESSION_LIST_LIMIT,
  MAX_BROWSER_SESSION_LIST_LIMIT,
  type BrowserSessionAuthorityContext,
  type BrowserSessionAuthorityPage,
  type BrowserSessionAuthorityPort,
  type BrowserSessionAuthoritySession,
} from '../../packages/plugin-runtime/browser/session-authority';
import type { BrowserSessionPersistencePort } from '../../packages/plugin-runtime/browser/session-persistence';

const SESSION_NAMESPACE = 'browser_session';
const SESSION_SCOPE = 'controller';
const IMPORT_NAMESPACE = 'browser_session_legacy_import';
const MAX_AUTHORITY_RECORDS = 5_000;

interface BrowserSessionAuthorityEntry<T extends BrowserSessionAuthoritySession = BrowserSessionAuthoritySession> {
  schemaVersion: 1;
  status: 'active' | 'tombstoned';
  session: T;
  aliases: string[];
  repositoryIds: string[];
  nativeIdentity?: string;
  tombstonedAt?: string;
  importedFromLegacy?: boolean;
}

interface LegacyImportMarker {
  schemaVersion: 1;
  repoId: string;
  repoRootFingerprint: string;
  importedAt: string;
  importedRecordCount: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nativeIdentity(session: BrowserSessionAuthoritySession): string | undefined {
  const browser = session.browser;
  const tab = browser?.tab;
  if (browser?.provider !== 'macos-apple-events' || !browser.browserProduct || !tab?.windowId || !tab.tabId) return undefined;
  return `${browser.provider}:${browser.browserProduct}:${tab.windowId}:${tab.tabId}`;
}

function recordKey(repoId: string, session: BrowserSessionAuthoritySession): string {
  const native = nativeIdentity(session);
  return native ? `native-${digest(native).slice(0, 40)}` : `session-${digest(`${repoId}:${session.sessionId}`).slice(0, 40)}`;
}

function importMarkerKey(repoRoot: string): string {
  return digest(resolve(repoRoot)).slice(0, 40);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function parseLegacySession(path: string): BrowserSessionAuthoritySession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`PLUGIN_BROWSER_SESSION_STATE_CORRUPT: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`PLUGIN_BROWSER_SESSION_STATE_CORRUPT: ${path}: expected object`);
  }
  const session = parsed as Partial<BrowserSessionAuthoritySession>;
  if (session.schemaVersion !== 1 || typeof session.sessionId !== 'string' || typeof session.url !== 'string'
    || typeof session.createdAt !== 'string' || typeof session.updatedAt !== 'string') {
    throw new Error(`PLUGIN_BROWSER_SESSION_STATE_CORRUPT: ${path}: required session fields are missing`);
  }
  return session as BrowserSessionAuthoritySession;
}

function legacySessions(repoRoot: string): BrowserSessionAuthoritySession[] {
  const root = join(repoRoot, '.forge', 'browser', 'sessions');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.json')).sort().map((name) => parseLegacySession(join(root, name)));
}

function mergeEntry<T extends BrowserSessionAuthoritySession>(
  existing: BrowserSessionAuthorityEntry<T> | undefined,
  repoId: string,
  session: T,
  options: { importedFromLegacy?: boolean } = {},
): BrowserSessionAuthorityEntry<T> {
  const canonicalSessionId = existing?.session.sessionId ?? session.sessionId;
  const canonicalCreatedAt = existing?.session.createdAt ?? session.createdAt;
  const normalizedSession = {
    ...session,
    sessionId: canonicalSessionId,
    createdAt: canonicalCreatedAt,
  } as T;
  return {
    schemaVersion: 1,
    status: 'active',
    session: normalizedSession,
    aliases: unique([...(existing?.aliases ?? []), existing?.session.sessionId ?? '', session.sessionId, canonicalSessionId]),
    repositoryIds: unique([...(existing?.repositoryIds ?? []), repoId]),
    nativeIdentity: nativeIdentity(session) ?? existing?.nativeIdentity,
    importedFromLegacy: options.importedFromLegacy === true || existing?.importedFromLegacy === true,
  };
}

export function ensureLegacyBrowserSessionsImported(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
  repoId: string,
  repoRoot: string,
): number {
  const markerKey = importMarkerKey(repoRoot);
  if (persistence.read<LegacyImportMarker>(controllerHome, IMPORT_NAMESPACE, repoId, markerKey)) return 0;
  const sessions = legacySessions(repoRoot);
  return persistence.transaction(controllerHome, (transaction) => {
    const marker = transaction.read<LegacyImportMarker>(IMPORT_NAMESPACE, repoId, markerKey);
    if (marker) return 0;
    let imported = 0;
    for (const session of sessions) {
      const key = recordKey(repoId, session);
      const current = transaction.read<BrowserSessionAuthorityEntry>(SESSION_NAMESPACE, SESSION_SCOPE, key);
      const next = mergeEntry(current?.value, repoId, session, { importedFromLegacy: true });
      transaction.write({
        namespace: SESSION_NAMESPACE,
        scope: SESSION_SCOPE,
        key,
        schemaVersion: 1,
        value: next,
        expectedRevision: current?.revision ?? null,
        action: current ? 'legacy_merge' : 'legacy_import',
      });
      imported += 1;
    }
    transaction.write({
      namespace: IMPORT_NAMESPACE,
      scope: repoId,
      key: markerKey,
      schemaVersion: 1,
      value: {
        schemaVersion: 1,
        repoId,
        repoRootFingerprint: markerKey,
        importedAt: new Date().toISOString(),
        importedRecordCount: imported,
      } satisfies LegacyImportMarker,
      expectedRevision: null,
      action: 'legacy_import_complete',
    });
    return imported;
  });
}

function authorityEntries(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
): BrowserSessionAuthorityEntry[] {
  return persistence.list<BrowserSessionAuthorityEntry>(controllerHome, {
    namespace: SESSION_NAMESPACE,
    scope: SESSION_SCOPE,
    limit: MAX_AUTHORITY_RECORDS,
  }).map((record) => record.value);
}

function visibleToRepository(entry: BrowserSessionAuthorityEntry, repoId: string): boolean {
  return Boolean(entry.nativeIdentity) || entry.repositoryIds.includes(repoId);
}

function activeEntries(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
  repoId: string,
  repoRoot: string,
): BrowserSessionAuthorityEntry[] {
  ensureLegacyBrowserSessionsImported(persistence, controllerHome, repoId, repoRoot);
  return authorityEntries(persistence, controllerHome)
    .filter((entry) => entry.status === 'active' && visibleToRepository(entry, repoId))
    .sort((left, right) => {
      const updated = right.session.updatedAt.localeCompare(left.session.updatedAt);
      return updated !== 0 ? updated : left.session.sessionId.localeCompare(right.session.sessionId);
    });
}

export function saveBrowserSession<T extends BrowserSessionAuthoritySession>(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  session: T,
): T {
  ensureLegacyBrowserSessionsImported(persistence, controllerHome, repoId, repoRoot);
  const key = recordKey(repoId, session);
  return persistence.transaction(controllerHome, (transaction) => {
    const current = transaction.read<BrowserSessionAuthorityEntry<T>>(SESSION_NAMESPACE, SESSION_SCOPE, key);
    const next = mergeEntry(current?.value, repoId, session);
    const written = transaction.write({
      namespace: SESSION_NAMESPACE,
      scope: SESSION_SCOPE,
      key,
      schemaVersion: 1,
      value: next,
      expectedRevision: current?.revision ?? null,
      action: current ? 'save' : 'create',
    });
    return written.value.session;
  });
}

export function findBrowserSession<T extends BrowserSessionAuthoritySession>(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  sessionId: string,
): T | undefined {
  return activeEntries(persistence, controllerHome, repoId, repoRoot)
    .find((entry) => entry.session.sessionId === sessionId || entry.aliases.includes(sessionId))?.session as T | undefined;
}

export function listBrowserSessions<T extends BrowserSessionAuthoritySession>(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  options: { limit?: number; cursor?: string } = {},
): BrowserSessionAuthorityPage<T> {
  const entries = activeEntries(persistence, controllerHome, repoId, repoRoot);
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? DEFAULT_BROWSER_SESSION_LIST_LIMIT), MAX_BROWSER_SESSION_LIST_LIMIT));
  let offset = 0;
  if (options.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as { offset?: unknown };
      if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error('invalid offset');
      offset = Number(parsed.offset);
    } catch {
      throw new Error('PLUGIN_BROWSER_SESSION_CURSOR_INVALID: cursor is invalid or expired');
    }
  }
  const page = entries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < entries.length
    ? Buffer.from(JSON.stringify({ offset: nextOffset }), 'utf8').toString('base64url')
    : undefined;
  return {
    sessions: page.map((entry) => entry.session as T),
    limit,
    totalCount: entries.length,
    nextCursor,
  };
}

export function listAllBrowserSessionsForRepository<T extends BrowserSessionAuthoritySession>(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
  repoId: string,
  repoRoot: string,
): T[] {
  return activeEntries(persistence, controllerHome, repoId, repoRoot).map((entry) => entry.session as T);
}

export function tombstoneBrowserSession(
  persistence: BrowserSessionPersistencePort,
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  sessionId: string,
): boolean {
  ensureLegacyBrowserSessionsImported(persistence, controllerHome, repoId, repoRoot);
  const record = persistence.list<BrowserSessionAuthorityEntry>(controllerHome, {
    namespace: SESSION_NAMESPACE,
    scope: SESSION_SCOPE,
    limit: MAX_AUTHORITY_RECORDS,
  }).find((candidate) => {
    const entry = candidate.value;
    return entry.status === 'active' && visibleToRepository(entry, repoId)
      && (entry.session.sessionId === sessionId || entry.aliases.includes(sessionId));
  });
  if (!record) return false;
  return persistence.transaction(controllerHome, (transaction) => {
    const current = transaction.read<BrowserSessionAuthorityEntry>(SESSION_NAMESPACE, SESSION_SCOPE, record.key);
    if (!current || current.value.status !== 'active') return false;
    transaction.write({
      namespace: SESSION_NAMESPACE,
      scope: SESSION_SCOPE,
      key: record.key,
      schemaVersion: 1,
      value: {
        ...current.value,
        status: 'tombstoned',
        tombstonedAt: new Date().toISOString(),
      },
      expectedRevision: current.revision,
      action: 'tombstone',
    });
    return true;
  });
}

export function createBrowserSessionAuthority(
  persistence: BrowserSessionPersistencePort,
): BrowserSessionAuthorityPort {
  return {
    ensureLegacyImported: (context, repoRoot) => ensureLegacyBrowserSessionsImported(persistence, context.controllerHome, context.repoId, repoRoot),
    save: (context, repoRoot, session) => saveBrowserSession(persistence, context.controllerHome, context.repoId, repoRoot, session),
    find: (context, repoRoot, sessionId) => findBrowserSession(persistence, context.controllerHome, context.repoId, repoRoot, sessionId),
    list: (context, repoRoot, options) => listBrowserSessions(persistence, context.controllerHome, context.repoId, repoRoot, options),
    listAll: (context, repoRoot) => listAllBrowserSessionsForRepository(persistence, context.controllerHome, context.repoId, repoRoot),
    tombstone: (context, repoRoot, sessionId) => tombstoneBrowserSession(persistence, context.controllerHome, context.repoId, repoRoot, sessionId),
  };
}
