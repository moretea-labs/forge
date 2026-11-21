import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  compactControlPlaneDatabaseOffline,
  withControlPlaneReadDatabase,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
  type SqliteDatabase,
} from './sqlite-store';

// Dedicated historical Work/WorkHandle namespaces. Mixed semantic-sync
// replicas and journals are deleted by exact Work keys separately so Project,
// Requirement, Plan, Process and UserRequest records remain intact.
export const RETIRED_WORK_NAMESPACES = [
  'work_contract',
  'work_semantic_revision',
  'execution_work_handle',
  'assistant_experience',
  'assistant_outcome_observation',
] as const;
// Exact Work keys in mixed semantic-sync storage; retain non-Work replicas.
const WORK_REPLICA_NAMESPACE = 'semantic_sync_replica';
const WORK_REPLICA_KEY_PATTERN = 'work:%';
const SYNC_JOURNAL_NAMESPACE = 'semantic_sync_journal';
const LEGACY_WORK_DIRECTORIES = ['work-handles', 'indexes/work-contracts'] as const;

export interface RetiredWorkPurgeReport {
  controllerHome: string;
  records: number;
  auditEvents: number;
  auditFloors: number;
  auditRecordCursors: number;
  journalReferences: number;
  directories: string[];
  applied: boolean;
}

function count(db: SqliteDatabase, table: string, namespace: string): number {
  // Table names are internal compile-time constants, never caller input.
  const row = db.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE namespace = ?').get(namespace) as {
    count: number;
  };
  return Number(row.count);
}

function countNamespace(db: SqliteDatabase, table: string): number {
  return RETIRED_WORK_NAMESPACES.reduce((sum, namespace) => sum + count(db, table, namespace), 0);
}

function countWorkReplicas(db: SqliteDatabase, table: string): number {
  const record = db
    .prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE namespace = ? AND record_key LIKE ?')
    .get(WORK_REPLICA_NAMESPACE, WORK_REPLICA_KEY_PATTERN) as { count: number };
  return Number(record.count);
}

interface SyncJournalRow {
  scope: string;
  record_key: string;
  revision: number;
  payload: string;
}

function scrubbedJournal(payload: string): {
  value: { schemaVersion: 1; entries: Record<string, unknown>[] };
  removed: number;
} {
  let original: unknown;
  try {
    original = JSON.parse(payload);
  } catch {
    throw new Error('RETIRED_WORK_JOURNAL_UNREADABLE');
  }
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new Error('RETIRED_WORK_JOURNAL_INVALID');
  }
  const journal = original as { schemaVersion?: unknown; entries?: unknown };
  if (journal.schemaVersion !== 1 || !Array.isArray(journal.entries)) {
    throw new Error('RETIRED_WORK_JOURNAL_INVALID');
  }
  let removed = 0;
  const entries: Record<string, unknown>[] = journal.entries.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RETIRED_WORK_JOURNAL_INVALID');
    const entry = value as Record<string, unknown>;
    if (!Array.isArray(entry.sampledKeys) || !entry.sampledKeys.every((key) => typeof key === 'string')) {
      throw new Error('RETIRED_WORK_JOURNAL_INVALID');
    }
    const keys = (entry.sampledKeys as string[]).filter((key) => !key.startsWith('work:'));
    removed += entry.sampledKeys.length - keys.length;
    return { ...entry, sampledKeys: keys };
  });
  return { value: { ...(original as Record<string, unknown>), schemaVersion: 1, entries }, removed };
}

function journalWorkReferences(db: SqliteDatabase, apply: boolean): number {
  const rows = db
    .prepare('SELECT scope, record_key, revision, payload FROM control_plane_records WHERE namespace = ?')
    .all(SYNC_JOURNAL_NAMESPACE) as SyncJournalRow[];
  let removed = 0;
  for (const row of rows) {
    const projected = scrubbedJournal(row.payload);
    removed += projected.removed;
    if (apply && projected.removed) {
      writeControlPlaneRecordWithinTransaction(db, {
        namespace: SYNC_JOURNAL_NAMESPACE,
        scope: row.scope,
        key: row.record_key,
        schemaVersion: 1,
        value: projected.value,
        action: 'retired_work_journal_scrub',
        expectedRevision: row.revision,
      });
    }
  }
  return removed;
}

function scopedRoots(controllerHome: string): string[] {
  const roots = [controllerHome, join(controllerHome, 'semantic'), join(controllerHome, 'system')];
  for (const partition of ['repositories', 'workspaces']) {
    const parent = join(controllerHome, partition);
    if (!existsSync(parent)) continue;
    if (!lstatSync(parent).isDirectory()) throw new Error('RETIRED_WORK_UNSAFE_PARTITION: ' + parent);
    for (const child of readdirSync(parent, { withFileTypes: true })) {
      if (child.isDirectory()) roots.push(join(parent, child.name));
    }
  }
  return roots;
}

function legacyDirectories(controllerHome: string): string[] {
  const matches: string[] = [];
  for (const root of scopedRoots(controllerHome)) {
    for (const relativePath of LEGACY_WORK_DIRECTORIES) {
      const path = join(root, relativePath);
      if (!existsSync(path)) continue;
      const entry = lstatSync(path);
      if (!entry.isDirectory()) throw new Error('RETIRED_WORK_UNSAFE_LEGACY_PATH: ' + path);
      matches.push(path);
    }
  }
  return matches.sort();
}

function statistics(
  db: SqliteDatabase,
): Pick<
  RetiredWorkPurgeReport,
  'records' | 'auditEvents' | 'auditFloors' | 'auditRecordCursors' | 'journalReferences'
> {
  return {
    records: countNamespace(db, 'control_plane_records') + countWorkReplicas(db, 'control_plane_records'),
    auditEvents: countNamespace(db, 'control_plane_audit') + countWorkReplicas(db, 'control_plane_audit'),
    auditFloors: countNamespace(db, 'control_plane_audit_floor') + countWorkReplicas(db, 'control_plane_audit_floor'),
    auditRecordCursors:
      countNamespace(db, 'control_plane_audit_record_cursor') +
      countWorkReplicas(db, 'control_plane_audit_record_cursor'),
    journalReferences: journalWorkReferences(db, false),
  };
}

export function inspectRetiredWorkPurge(controllerHomeInput: string): RetiredWorkPurgeReport {
  const controllerHome = resolve(controllerHomeInput);
  const directories = legacyDirectories(controllerHome);
  const dbPath = join(controllerHome, 'control-plane.sqlite');
  const counts = existsSync(dbPath)
    ? withControlPlaneReadDatabase(controllerHome, statistics)
    : { records: 0, auditEvents: 0, auditFloors: 0, auditRecordCursors: 0, journalReferences: 0 };
  return { controllerHome, directories, ...counts, applied: false };
}

/**
 * One-time offline deletion, only for a stopped Runtime. Removes the actual
 * Work rows AND their SQLite audit history, not a tombstone or read-only view.
 * Do not run against a live older Runtime which could reintroduce Work rows.
 */
export function purgeRetiredWork(controllerHomeInput: string): RetiredWorkPurgeReport {
  const controllerHome = resolve(controllerHomeInput);
  const before = inspectRetiredWorkPurge(controllerHome);
  if (existsSync(join(controllerHome, 'control-plane.sqlite'))) {
    withControlPlaneTransaction(controllerHome, (db) => {
      for (const namespace of RETIRED_WORK_NAMESPACES) {
        for (const table of [
          'control_plane_records',
          'control_plane_audit',
          'control_plane_audit_floor',
          'control_plane_audit_record_cursor',
        ]) {
          db.prepare('DELETE FROM ' + table + ' WHERE namespace = ?').run(namespace);
        }
      }
      for (const table of [
        'control_plane_records',
        'control_plane_audit',
        'control_plane_audit_floor',
        'control_plane_audit_record_cursor',
      ]) {
        db.prepare('DELETE FROM ' + table + ' WHERE namespace = ? AND record_key LIKE ?').run(
          WORK_REPLICA_NAMESPACE,
          WORK_REPLICA_KEY_PATTERN,
        );
      }
      journalWorkReferences(db, true);
    });
    // Repack after the transaction so old payload bytes are not left in SQLite
    // free pages or the WAL. Only call while the Runtime is stopped.
    compactControlPlaneDatabaseOffline(controllerHome);
  }
  for (const directory of before.directories) {
    if (!existsSync(directory)) continue;
    if (!lstatSync(directory).isDirectory()) throw new Error('RETIRED_WORK_UNSAFE_LEGACY_PATH: ' + directory);
    rmSync(directory, { recursive: true, force: true });
  }
  const after = inspectRetiredWorkPurge(controllerHome);
  if (
    after.records ||
    after.auditEvents ||
    after.auditFloors ||
    after.auditRecordCursors ||
    after.journalReferences ||
    after.directories.length
  ) {
    throw new Error('RETIRED_WORK_PURGE_INCOMPLETE');
  }
  return { ...before, applied: true };
}
