import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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
  'execution_work_validation_index',
  'work_prepare_request',
  'controller_work_binding',
  'chatgpt_work_conversation_binding',
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

type HistoricalWorkBoundNamespace = 'workflow_run' | 'process_handle_index';
const HISTORICAL_WORK_BOUND_NAMESPACES = ['workflow_run', 'process_handle_index'] as const;

interface HistoricalWorkBoundRow {
  namespace: HistoricalWorkBoundNamespace;
  scope: string;
  record_key: string;
}

/** Erase only Work-attributed historical WorkflowRuns or rebuildable Process locators. */
function historicalWorkBoundRows(db: SqliteDatabase): HistoricalWorkBoundRow[] {
  return HISTORICAL_WORK_BOUND_NAMESPACES.flatMap((namespace) => {
    const rows = db
      .prepare('SELECT scope, record_key, payload FROM control_plane_records WHERE namespace = ?')
      .all(namespace) as Array<{ scope: string; record_key: string; payload: string }>;
    const label = namespace === 'workflow_run' ? 'WORKFLOW' : 'PROCESS_HANDLE';
    return rows.flatMap((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        throw new Error(`RETIRED_WORK_${label}_UNREADABLE`);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`RETIRED_WORK_${label}_INVALID`);
      }
      return Object.hasOwn(payload, 'workId') ? [{ namespace, scope: row.scope, record_key: row.record_key }] : [];
    });
  });
}

const WORK_HISTORY_TABLES = [
  'control_plane_records',
  'control_plane_audit',
  'control_plane_audit_floor',
  'control_plane_audit_record_cursor',
] as const;

function historicalWorkBoundRowsInTable(
  db: SqliteDatabase,
  table: (typeof WORK_HISTORY_TABLES)[number],
  rows: readonly HistoricalWorkBoundRow[],
): number {
  return rows.reduce((total, row) => {
    const result = db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE namespace = ? AND scope = ? AND record_key = ?`)
      .get(row.namespace, row.scope, row.record_key) as { count: number };
    return total + Number(result.count);
  }, 0);
}

function eraseHistoricalWorkBoundRows(db: SqliteDatabase): void {
  for (const row of historicalWorkBoundRows(db)) {
    for (const table of WORK_HISTORY_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE namespace = ? AND scope = ? AND record_key = ?`).run(
        row.namespace,
        row.scope,
        row.record_key,
      );
    }
  }
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

/** Delete legacy Work/ControllerRound columns from mixed cognition tables only while offline. */
function dropRetiredCognitionColumns(db: SqliteDatabase): void {
  for (const table of ['cognition_memory_units', 'cognition_memory_edges'] as const) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    for (const column of ['source_work_id', 'source_round_id'] as const) {
      if (columns.some((entry) => entry.name === column)) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
  }
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

/**
 * Offline erasure must never traverse a symbolic-link component (including
 * semantic/system roots and indexes parents). A symlinked parent could otherwise
 * make rmSync delete a different directory outside this Controller Home.
 * A missing component simply means this old directory is absent.
 */
function safeExistingLegacyDirectory(controllerHome: string, candidate: string): boolean {
  const remainder = relative(controllerHome, candidate);
  if (remainder === '..' || remainder.startsWith('..' + sep) || remainder.startsWith(sep)) {
    throw new Error('RETIRED_WORK_UNSAFE_LEGACY_PATH: ' + candidate);
  }
  const components = remainder.split(sep).filter(Boolean);
  let current = controllerHome;
  for (const segment of ['', ...components]) {
    if (segment) current = join(current, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!entry.isDirectory()) throw new Error('RETIRED_WORK_UNSAFE_LEGACY_PATH: ' + current);
  }
  return true;
}

function legacyDirectories(controllerHome: string): string[] {
  const matches: string[] = [];
  for (const root of scopedRoots(controllerHome)) {
    for (const relativePath of LEGACY_WORK_DIRECTORIES) {
      const path = join(root, relativePath);
      if (safeExistingLegacyDirectory(controllerHome, path)) matches.push(path);
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
  const historicalBound = historicalWorkBoundRows(db);
  const historicalBoundCount = (table: (typeof WORK_HISTORY_TABLES)[number]) =>
    historicalWorkBoundRowsInTable(db, table, historicalBound);
  return {
    records:
      countNamespace(db, 'control_plane_records') +
      countWorkReplicas(db, 'control_plane_records') +
      historicalBoundCount('control_plane_records'),
    auditEvents:
      countNamespace(db, 'control_plane_audit') +
      countWorkReplicas(db, 'control_plane_audit') +
      historicalBoundCount('control_plane_audit'),
    auditFloors:
      countNamespace(db, 'control_plane_audit_floor') +
      countWorkReplicas(db, 'control_plane_audit_floor') +
      historicalBoundCount('control_plane_audit_floor'),
    auditRecordCursors:
      countNamespace(db, 'control_plane_audit_record_cursor') +
      countWorkReplicas(db, 'control_plane_audit_record_cursor') +
      historicalBoundCount('control_plane_audit_record_cursor'),
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
      eraseHistoricalWorkBoundRows(db);
      dropRetiredCognitionColumns(db);
    });
    // Repack after the transaction so old payload bytes are not left in SQLite
    // free pages or the WAL. Only call while the Runtime is stopped.
    compactControlPlaneDatabaseOffline(controllerHome);
  }
  for (const directory of before.directories) {
    if (!safeExistingLegacyDirectory(controllerHome, directory)) continue;
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
