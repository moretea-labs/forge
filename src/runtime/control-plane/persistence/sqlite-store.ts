import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { durableControllerHome } from '../../../cli/repositories/controller-home';

/**
 * Small, dependency-free SQLite boundary for controller-owned runtime facts.
 *
 * Bun is the normal runtime, while the package launcher can fall back to Node
 * 22. Both provide a synchronous SQLite binding, but expose it under a
 * different module/class name. Keeping the adapter here avoids leaking either
 * runtime API into persistence callers or adding a native npm dependency.
 */
interface SqliteStatement {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  Database?: new (path: string) => SqliteDatabase;
  DatabaseSync?: new (path: string) => SqliteDatabase;
}

interface StoredRecordRow {
  namespace: string;
  scope: string;
  record_key: string;
  schema_version: number;
  revision: number;
  payload: string;
  created_at: string;
  updated_at: string;
}

export interface ControlPlaneRecord<T> {
  namespace: string;
  scope: string;
  key: string;
  schemaVersion: number;
  revision: number;
  value: T;
  createdAt: string;
  updatedAt: string;
}

export interface ControlPlaneDatabaseInspection {
  path: string;
  integrity: 'ok';
  schemaVersion: number;
  recordCount: number;
  auditEventCount: number;
  orphanRecordCount: number;
}

export const CONTROL_PLANE_SQLITE_MAINTENANCE_POLICY_VERSION = 'control-plane-sqlite-maintenance-v1' as const;
export const DEFAULT_CONTROL_PLANE_SQLITE_VACUUM_MIN_RECLAIMABLE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CONTROL_PLANE_SQLITE_VACUUM_MIN_RECLAIMABLE_RATIO = 0.20;

export interface ControlPlaneDatabaseMaintenanceOptions {
  minimumReclaimableBytes?: number;
  minimumReclaimableRatio?: number;
  allowVacuum?: boolean;
}

export interface ControlPlaneDatabaseMaintenanceReport {
  policyVersion: typeof CONTROL_PLANE_SQLITE_MAINTENANCE_POLICY_VERSION;
  path: string;
  checkpointMode: 'passive';
  checkpointed: boolean;
  pageSize: number;
  pageCountBefore: number;
  freePageCountBefore: number;
  reclaimableBytesBefore: number;
  reclaimableRatioBefore: number;
  vacuumEligible: boolean;
  vacuumAttempted: boolean;
  vacuumed: boolean;
  pageCountAfter: number;
  freePageCountAfter: number;
  reclaimableBytesAfter: number;
  reclaimableRatioAfter: number;
  reclaimedBytes: number;
  skippedReason?: 'database_missing' | 'below_threshold' | 'vacuum_disabled' | 'database_busy';
}

export const CONTROL_PLANE_SCHEMA_VERSION = 1;
const DATABASE_FILE = 'control-plane.sqlite';
const require = createRequire(import.meta.url);

function now(): string {
  return new Date().toISOString();
}

function sqliteBusyError(path: string, error: unknown): Error | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message)
    ? new Error(`CONTROL_PLANE_SQLITE_BUSY: ${path}: ${message}`)
    : undefined;
}

function sqliteConstructor(): new (path: string) => SqliteDatabase {
  const runtimeModule = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
  const sqlite = require(runtimeModule) as SqliteModule;
  const Constructor = sqlite.Database ?? sqlite.DatabaseSync;
  if (!Constructor) throw new Error(`CONTROL_PLANE_SQLITE_UNAVAILABLE: ${runtimeModule} did not provide a database constructor`);
  return Constructor;
}

function openRawDatabase(path: string): SqliteDatabase {
  const Constructor = sqliteConstructor();
  try {
    return new Constructor(path);
  } catch (error) {
    const busy = sqliteBusyError(path, error);
    if (busy) throw busy;
    throw new Error(`CONTROL_PLANE_SQLITE_CORRUPT: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scalar(row: unknown): unknown {
  if (!row || typeof row !== 'object') return undefined;
  return Object.values(row as Record<string, unknown>)[0];
}

function assertDatabaseIntegrity(database: SqliteDatabase, path: string): void {
  try {
    const result = scalar(database.prepare('PRAGMA quick_check').get());
    if (result !== 'ok') throw new Error(String(result ?? 'missing quick_check result'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('CONTROL_PLANE_SQLITE_CORRUPT:')) throw error;
    throw new Error(`CONTROL_PLANE_SQLITE_CORRUPT: ${path}: ${message}`);
  }
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  const row = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function currentSchemaVersion(database: SqliteDatabase): number | undefined {
  if (!tableExists(database, 'control_plane_schema')) return undefined;
  const value = scalar(database.prepare('SELECT MAX(version) AS version FROM control_plane_schema').get());
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function assertSupportedSchema(database: SqliteDatabase, path: string, requireSchema = false): number | undefined {
  const version = currentSchemaVersion(database);
  if (version === undefined) {
    if (requireSchema) throw new Error(`CONTROL_PLANE_BACKUP_INVALID: ${path}: control_plane_schema is missing`);
    return undefined;
  }
  if (version !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw new Error(`CONTROL_PLANE_SCHEMA_VERSION_UNSUPPORTED: ${path} required=${version} supported=${CONTROL_PLANE_SCHEMA_VERSION}`);
  }
  return version;
}

function initializeSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS control_plane_schema (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS control_plane_records (
      namespace TEXT NOT NULL,
      scope TEXT NOT NULL,
      record_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, scope, record_key)
    );
    CREATE INDEX IF NOT EXISTS control_plane_records_scope_updated
      ON control_plane_records (namespace, scope, updated_at DESC);
    CREATE TABLE IF NOT EXISTS control_plane_audit (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      scope TEXT NOT NULL,
      record_key TEXT NOT NULL,
      action TEXT NOT NULL,
      revision INTEGER NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS control_plane_audit_lookup
      ON control_plane_audit (namespace, scope, record_key, revision);
  `);
  database.prepare('INSERT OR IGNORE INTO control_plane_schema (version, applied_at) VALUES (?, ?)').run(CONTROL_PLANE_SCHEMA_VERSION, now());
}

export function controlPlaneDatabasePath(controllerHome: string): string {
  const home = durableControllerHome(controllerHome);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return join(home, DATABASE_FILE);
}

function openDatabase(controllerHome: string): SqliteDatabase {
  const path = controlPlaneDatabasePath(controllerHome);
  const existed = existsSync(path);
  const database = openRawDatabase(path);
  try {
    // Configure waiting before the first schema read. A concurrent Runtime
    // writer is normal; it must not be reclassified as database corruption.
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    // Ordinary control-plane reads/writes reopen SQLite frequently. A PRAGMA
    // quick_check here turns every bounded metadata access into a full B-tree
    // scan. Runtime startup and explicit backup/restore inspection already call
    // inspectOpenDatabase(), which is the authoritative integrity boundary.
    // Keep schema fail-closed on every open, but reserve the full integrity scan
    // for those lifecycle/inspection boundaries.
    if (existed) {
      try {
        assertSupportedSchema(database, path);
      } catch (error) {
        const busy = sqliteBusyError(path, error);
        if (busy) throw busy;
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('CONTROL_PLANE_')) throw error;
        throw new Error(`CONTROL_PLANE_SQLITE_CORRUPT: ${path}: ${message}`);
      }
    }
    database.exec('PRAGMA journal_mode = WAL;');
    initializeSchema(database);
    assertSupportedSchema(database, path, true);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Open an already initialized authority for SELECT-only callers without
 * re-running WAL/schema setup. In WAL mode a reader can coexist with a writer
 * holding BEGIN IMMEDIATE; forcing PRAGMA journal_mode/DDL on every read turns
 * that harmless writer reservation into a synchronous busy_timeout on the
 * Canonical Runtime event loop.
 */
function openDatabaseForRead(controllerHome: string): SqliteDatabase {
  const path = controlPlaneDatabasePath(controllerHome);
  if (!existsSync(path)) return openDatabase(controllerHome);

  const database = openRawDatabase(path);
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const schemaVersion = assertSupportedSchema(database, path);
    if (schemaVersion !== undefined) return database;
  } catch (error) {
    database.close();
    const busy = sqliteBusyError(path, error);
    if (busy) throw busy;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('CONTROL_PLANE_')) throw error;
    throw new Error(`CONTROL_PLANE_SQLITE_CORRUPT: ${path}: ${message}`);
  }

  // Preserve first-use/partially initialized compatibility: only a database
  // with no schema authority falls back to the initializer/writer path.
  database.close();
  return openDatabase(controllerHome);
}

function rowToRecord<T>(row: StoredRecordRow): ControlPlaneRecord<T> {
  let value: T;
  try {
    value = JSON.parse(row.payload) as T;
  } catch {
    throw new Error(`CONTROL_PLANE_RECORD_CORRUPT: ${row.namespace}/${row.scope}/${row.record_key}`);
  }
  return {
    namespace: row.namespace,
    scope: row.scope,
    key: row.record_key,
    schemaVersion: row.schema_version,
    revision: row.revision,
    value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectRecord<T>(database: SqliteDatabase, namespace: string, scope: string, key: string): ControlPlaneRecord<T> | undefined {
  const row = database.prepare(`
    SELECT namespace, scope, record_key, schema_version, revision, payload, created_at, updated_at
    FROM control_plane_records
    WHERE namespace = ? AND scope = ? AND record_key = ?
  `).get(namespace, scope, key) as StoredRecordRow | undefined;
  return row ? rowToRecord<T>(row) : undefined;
}

function writeRecord<T>(
  database: SqliteDatabase,
  input: { namespace: string; scope: string; key: string; schemaVersion: number; value: T; action: string },
  existing?: ControlPlaneRecord<T>,
): ControlPlaneRecord<T> {
  const at = now();
  const previousAuditRevision = Number(scalar(database.prepare(`
    SELECT MAX(revision) AS revision FROM control_plane_audit
    WHERE namespace = ? AND scope = ? AND record_key = ?
  `).get(input.namespace, input.scope, input.key)) ?? 0);
  const revision = existing
    ? existing.revision + 1
    : Math.max(0, Number.isSafeInteger(previousAuditRevision) ? previousAuditRevision : 0) + 1;
  const createdAt = existing?.createdAt ?? at;
  database.prepare(`
    INSERT INTO control_plane_records (
      namespace, scope, record_key, schema_version, revision, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(namespace, scope, record_key) DO UPDATE SET
      schema_version = excluded.schema_version,
      revision = excluded.revision,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(input.namespace, input.scope, input.key, input.schemaVersion, revision, JSON.stringify(input.value), createdAt, at);
  database.prepare(`
    INSERT INTO control_plane_audit (namespace, scope, record_key, action, revision, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.namespace, input.scope, input.key, input.action, revision, at);
  return {
    namespace: input.namespace,
    scope: input.scope,
    key: input.key,
    schemaVersion: input.schemaVersion,
    revision,
    value: input.value,
    createdAt,
    updatedAt: at,
  };
}

export function readControlPlaneRecordWithinTransaction<T>(
  database: SqliteDatabase,
  namespace: string,
  scope: string,
  key: string,
): ControlPlaneRecord<T> | undefined {
  return selectRecord<T>(database, namespace, scope, key);
}

export function writeControlPlaneRecordWithinTransaction<T>(
  database: SqliteDatabase,
  input: {
    namespace: string;
    scope: string;
    key: string;
    schemaVersion: number;
    value: T;
    action?: string;
    expectedRevision?: number | null;
  },
): ControlPlaneRecord<T> {
  const existing = selectRecord<T>(database, input.namespace, input.scope, input.key);
  if (input.expectedRevision !== undefined) {
    const matches = input.expectedRevision === null
      ? existing === undefined
      : existing?.revision === input.expectedRevision;
    if (!matches) {
      throw new ControlPlaneConflictError(input.namespace, input.scope, input.key, input.expectedRevision, existing?.revision);
    }
  }
  return writeRecord(database, { ...input, action: input.action ?? 'write' }, existing);
}

/** Execute a read/modify/write sequence under SQLite's cross-process write lock. */
export function withControlPlaneTransaction<T>(controllerHome: string, operation: (database: SqliteDatabase) => T): T {
  const database = openDatabase(controllerHome);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(database);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

export function readControlPlaneRecord<T>(controllerHome: string, namespace: string, scope: string, key: string): ControlPlaneRecord<T> | undefined {
  const database = openDatabaseForRead(controllerHome);
  try {
    return selectRecord<T>(database, namespace, scope, key);
  } finally {
    database.close();
  }
}

export function writeControlPlaneRecord<T>(
  controllerHome: string,
  input: {
    namespace: string;
    scope: string;
    key: string;
    schemaVersion: number;
    value: T;
    action?: string;
    expectedRevision?: number | null;
  },
): ControlPlaneRecord<T> {
  return withControlPlaneTransaction(controllerHome, (database) =>
    writeControlPlaneRecordWithinTransaction(database, input));
}

export function deleteControlPlaneRecordWithinTransaction(
  database: SqliteDatabase,
  input: { namespace: string; scope: string; key: string; action?: string; expectedRevision?: number },
): boolean {
  const existing = selectRecord(database, input.namespace, input.scope, input.key);
  if (input.expectedRevision !== undefined && existing?.revision !== input.expectedRevision) {
    throw new ControlPlaneConflictError(input.namespace, input.scope, input.key, input.expectedRevision, existing?.revision);
  }
  if (!existing) return false;
  const revision = existing.revision + 1;
  const at = now();
  database.prepare(`
    DELETE FROM control_plane_records
    WHERE namespace = ? AND scope = ? AND record_key = ?
  `).run(input.namespace, input.scope, input.key);
  database.prepare(`
    INSERT INTO control_plane_audit (namespace, scope, record_key, action, revision, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.namespace, input.scope, input.key, input.action ?? 'delete', revision, at);
  return true;
}

export function deleteControlPlaneRecord(
  controllerHome: string,
  input: { namespace: string; scope: string; key: string; action?: string; expectedRevision?: number },
): boolean {
  return withControlPlaneTransaction(controllerHome, (database) =>
    deleteControlPlaneRecordWithinTransaction(database, input));
}

export function deleteControlPlaneRecordsWithinTransaction(
  database: SqliteDatabase,
  input: { namespace: string; scope: string; action?: string },
): number {
  const rows = database.prepare(`
    SELECT record_key, revision
    FROM control_plane_records
    WHERE namespace = ? AND scope = ?
    ORDER BY record_key ASC
  `).all(input.namespace, input.scope) as Array<{ record_key: string; revision: number }>;
  if (rows.length === 0) return 0;

  const at = now();
  const remove = database.prepare(`
    DELETE FROM control_plane_records
    WHERE namespace = ? AND scope = ? AND record_key = ?
  `);
  const audit = database.prepare(`
    INSERT INTO control_plane_audit (namespace, scope, record_key, action, revision, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    remove.run(input.namespace, input.scope, row.record_key);
    audit.run(input.namespace, input.scope, row.record_key, input.action ?? 'delete_scope', row.revision + 1, at);
  }
  return rows.length;
}

export function deleteControlPlaneRecords(
  controllerHome: string,
  input: { namespace: string; scope: string; action?: string },
): number {
  return withControlPlaneTransaction(controllerHome, (database) =>
    deleteControlPlaneRecordsWithinTransaction(database, input));
}

export class ControlPlaneConflictError extends Error {
  readonly expectedRevision: number | null;
  readonly actualRevision: number | undefined;

  constructor(namespace: string, scope: string, key: string, expectedRevision: number | null, actualRevision: number | undefined) {
    super(`CONTROL_PLANE_REVISION_CONFLICT: ${namespace}/${scope}/${key} expected=${expectedRevision ?? 'absent'} actual=${actualRevision ?? 'absent'}`);
    this.name = 'ControlPlaneConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function listControlPlaneRecords<T>(
  controllerHome: string,
  input: { namespace: string; scope?: string; limit?: number },
): ControlPlaneRecord<T>[] {
  const database = openDatabaseForRead(controllerHome);
  try {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 1000), 5000));
    const rows = input.scope === undefined
      ? database.prepare(`
          SELECT namespace, scope, record_key, schema_version, revision, payload, created_at, updated_at
          FROM control_plane_records
          WHERE namespace = ?
          ORDER BY updated_at ASC, record_key ASC
          LIMIT ?
        `).all(input.namespace, limit)
      : database.prepare(`
          SELECT namespace, scope, record_key, schema_version, revision, payload, created_at, updated_at
          FROM control_plane_records
          WHERE namespace = ? AND scope = ?
          ORDER BY updated_at ASC, record_key ASC
          LIMIT ?
        `).all(input.namespace, input.scope, limit);
    return (rows as StoredRecordRow[]).map((row) => rowToRecord<T>(row));
  } finally {
    database.close();
  }
}

/**
 * Internal correctness surface for authorities that must observe every durable
 * fact in a namespace/scope. User-facing and diagnostic list APIs should keep
 * using listControlPlaneRecords so their output remains bounded.
 */
export function listAllControlPlaneRecords<T>(
  controllerHome: string,
  input: { namespace: string; scope?: string },
): ControlPlaneRecord<T>[] {
  const database = openDatabaseForRead(controllerHome);
  try {
    const rows = input.scope === undefined
      ? database.prepare(`
          SELECT namespace, scope, record_key, schema_version, revision, payload, created_at, updated_at
          FROM control_plane_records
          WHERE namespace = ?
          ORDER BY updated_at ASC, record_key ASC
        `).all(input.namespace)
      : database.prepare(`
          SELECT namespace, scope, record_key, schema_version, revision, payload, created_at, updated_at
          FROM control_plane_records
          WHERE namespace = ? AND scope = ?
          ORDER BY updated_at ASC, record_key ASC
        `).all(input.namespace, input.scope);
    return (rows as StoredRecordRow[]).map((row) => rowToRecord<T>(row));
  } finally {
    database.close();
  }
}

function inspectOpenDatabase(database: SqliteDatabase, path: string): ControlPlaneDatabaseInspection {
  assertDatabaseIntegrity(database, path);
  const schemaVersion = assertSupportedSchema(database, path, true)!;
  if (!tableExists(database, 'control_plane_records') || !tableExists(database, 'control_plane_audit')) {
    throw new Error(`CONTROL_PLANE_BACKUP_INVALID: ${path}: required tables are missing`);
  }
  const recordCount = Number(scalar(database.prepare('SELECT COUNT(*) AS count FROM control_plane_records').get()) ?? 0);
  const auditEventCount = Number(scalar(database.prepare('SELECT COUNT(*) AS count FROM control_plane_audit').get()) ?? 0);
  const orphanRecordCount = Number(scalar(database.prepare(`
    SELECT COUNT(*) AS count
    FROM control_plane_records record
    WHERE (
      SELECT COUNT(DISTINCT audit.revision)
      FROM control_plane_audit audit
      WHERE audit.namespace = record.namespace
        AND audit.scope = record.scope
        AND audit.record_key = record.record_key
        AND audit.revision BETWEEN 1 AND record.revision
    ) != record.revision
      OR COALESCE((
        SELECT MIN(audit.revision)
        FROM control_plane_audit audit
        WHERE audit.namespace = record.namespace
          AND audit.scope = record.scope
          AND audit.record_key = record.record_key
      ), 0) != 1
      OR COALESCE((
        SELECT MAX(audit.revision)
        FROM control_plane_audit audit
        WHERE audit.namespace = record.namespace
          AND audit.scope = record.scope
          AND audit.record_key = record.record_key
      ), 0) != record.revision
  `).get()) ?? 0);
  if (orphanRecordCount > 0) {
    throw new Error(`CONTROL_PLANE_AUDIT_CONTINUITY_INVALID: ${path}: discontinuous_records=${orphanRecordCount}`);
  }
  return { path, integrity: 'ok', schemaVersion, recordCount, auditEventCount, orphanRecordCount };
}

export function inspectControlPlaneDatabase(controllerHome: string): ControlPlaneDatabaseInspection {
  const path = controlPlaneDatabasePath(controllerHome);
  const database = openDatabase(controllerHome);
  try {
    return inspectOpenDatabase(database, path);
  } finally {
    database.close();
  }
}

export function inspectControlPlaneDatabaseFile(path: string): ControlPlaneDatabaseInspection {
  if (!existsSync(path)) throw new Error(`CONTROL_PLANE_BACKUP_MISSING: ${path}`);
  const database = openRawDatabase(path);
  try {
    return inspectOpenDatabase(database, path);
  } finally {
    database.close();
  }
}

interface ControlPlaneDatabasePageSnapshot {
  pageSize: number;
  pageCount: number;
  freePageCount: number;
  reclaimableBytes: number;
  reclaimableRatio: number;
}

function integerPragma(database: SqliteDatabase, sql: string, label: string): number {
  const value = Number(scalar(database.prepare(sql).get()));
  if (!Number.isFinite(value) || value < 0) throw new Error(`CONTROL_PLANE_SQLITE_PRAGMA_INVALID: ${label}`);
  return Math.floor(value);
}

function controlPlaneDatabasePageSnapshot(database: SqliteDatabase): ControlPlaneDatabasePageSnapshot {
  const pageSize = integerPragma(database, 'PRAGMA page_size', 'page_size');
  const pageCount = integerPragma(database, 'PRAGMA page_count', 'page_count');
  const freePageCount = integerPragma(database, 'PRAGMA freelist_count', 'freelist_count');
  const reclaimableBytes = freePageCount * pageSize;
  return {
    pageSize,
    pageCount,
    freePageCount,
    reclaimableBytes,
    reclaimableRatio: pageCount > 0 ? freePageCount / pageCount : 0,
  };
}

/**
 * Physical SQLite maintenance only. Domain lifecycles own row deletion; this
 * boundary never decides semantic terminality or removes canonical records.
 * PASSIVE checkpointing is non-blocking, and VACUUM is attempted only when
 * already-reclaimable free pages exceed both configured thresholds. A live
 * writer causes a fail-closed busy skip instead of lock stealing or corruption
 * recovery.
 */
export function maintainControlPlaneDatabase(
  controllerHome: string,
  options: ControlPlaneDatabaseMaintenanceOptions = {},
): ControlPlaneDatabaseMaintenanceReport {
  const path = controlPlaneDatabasePath(controllerHome);
  const report: ControlPlaneDatabaseMaintenanceReport = {
    policyVersion: CONTROL_PLANE_SQLITE_MAINTENANCE_POLICY_VERSION,
    path,
    checkpointMode: 'passive',
    checkpointed: false,
    pageSize: 0,
    pageCountBefore: 0,
    freePageCountBefore: 0,
    reclaimableBytesBefore: 0,
    reclaimableRatioBefore: 0,
    vacuumEligible: false,
    vacuumAttempted: false,
    vacuumed: false,
    pageCountAfter: 0,
    freePageCountAfter: 0,
    reclaimableBytesAfter: 0,
    reclaimableRatioAfter: 0,
    reclaimedBytes: 0,
  };
  if (!existsSync(path)) {
    report.skippedReason = 'database_missing';
    return report;
  }

  let database: SqliteDatabase;
  try {
    database = openRawDatabase(path);
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)).startsWith('CONTROL_PLANE_SQLITE_BUSY:')) {
      report.skippedReason = 'database_busy';
      return report;
    }
    throw error;
  }
  try {
    database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;');
    assertSupportedSchema(database, path, true);
    try {
      database.exec('PRAGMA wal_checkpoint(PASSIVE);');
      report.checkpointed = true;
    } catch (error) {
      const busy = sqliteBusyError(path, error);
      if (busy) {
        report.skippedReason = 'database_busy';
        return report;
      }
      throw error;
    }

    const before = controlPlaneDatabasePageSnapshot(database);
    report.pageSize = before.pageSize;
    report.pageCountBefore = before.pageCount;
    report.freePageCountBefore = before.freePageCount;
    report.reclaimableBytesBefore = before.reclaimableBytes;
    report.reclaimableRatioBefore = before.reclaimableRatio;
    report.pageCountAfter = before.pageCount;
    report.freePageCountAfter = before.freePageCount;
    report.reclaimableBytesAfter = before.reclaimableBytes;
    report.reclaimableRatioAfter = before.reclaimableRatio;

    const minimumReclaimableBytes = Math.max(0, Math.floor(options.minimumReclaimableBytes ?? DEFAULT_CONTROL_PLANE_SQLITE_VACUUM_MIN_RECLAIMABLE_BYTES));
    const configuredRatio = Number(options.minimumReclaimableRatio ?? DEFAULT_CONTROL_PLANE_SQLITE_VACUUM_MIN_RECLAIMABLE_RATIO);
    const minimumReclaimableRatio = Number.isFinite(configuredRatio) ? Math.min(1, Math.max(0, configuredRatio)) : DEFAULT_CONTROL_PLANE_SQLITE_VACUUM_MIN_RECLAIMABLE_RATIO;
    report.vacuumEligible = before.freePageCount > 0
      && before.reclaimableBytes >= minimumReclaimableBytes
      && before.reclaimableRatio >= minimumReclaimableRatio;
    if (!report.vacuumEligible) {
      report.skippedReason = 'below_threshold';
      return report;
    }
    if (options.allowVacuum === false) {
      report.skippedReason = 'vacuum_disabled';
      return report;
    }

    report.vacuumAttempted = true;
    try {
      database.exec('VACUUM;');
    } catch (error) {
      const busy = sqliteBusyError(path, error);
      if (busy) {
        report.skippedReason = 'database_busy';
        return report;
      }
      throw error;
    }
    assertDatabaseIntegrity(database, path);
    const after = controlPlaneDatabasePageSnapshot(database);
    report.vacuumed = true;
    report.pageCountAfter = after.pageCount;
    report.freePageCountAfter = after.freePageCount;
    report.reclaimableBytesAfter = after.reclaimableBytes;
    report.reclaimableRatioAfter = after.reclaimableRatio;
    report.reclaimedBytes = Math.max(0, (before.pageCount - after.pageCount) * before.pageSize);
    return report;
  } finally {
    database.close();
  }
}

export function backupControlPlaneDatabase(controllerHome: string, destinationPath: string): ControlPlaneDatabaseInspection {
  const destination = join(destinationPath);
  if (existsSync(destination)) throw new Error(`CONTROL_PLANE_BACKUP_EXISTS: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const database = openDatabase(controllerHome);
  try {
    database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
  try {
    return inspectControlPlaneDatabaseFile(destination);
  } catch (error) {
    if (existsSync(destination)) unlinkSync(destination);
    throw error;
  }
}

export function restoreControlPlaneDatabase(controllerHome: string, backupPath: string): ControlPlaneDatabaseInspection {
  if (!existsSync(backupPath)) throw new Error(`CONTROL_PLANE_BACKUP_MISSING: ${backupPath}`);
  const target = controlPlaneDatabasePath(controllerHome);
  const staging = `${target}.restore-${process.pid}-${Date.now()}`;
  copyFileSync(backupPath, staging);
  try {
    const verified = inspectControlPlaneDatabaseFile(staging);
    for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    renameSync(staging, target);
    return { ...verified, path: target };
  } finally {
    if (existsSync(staging)) unlinkSync(staging);
  }
}

/**
 * Imports a legacy JSON record once and only when SQLite has no authoritative
 * row. A failed import never modifies either source. Afterwards callers write
 * only SQLite, preventing a long-lived dual source of truth.
 */
export function readOrImportControlPlaneRecord<T>(
  controllerHome: string,
  input: { namespace: string; scope: string; key: string; schemaVersion: number; readLegacy: () => T | undefined },
): ControlPlaneRecord<T> | undefined {
  const existing = readControlPlaneRecord<T>(controllerHome, input.namespace, input.scope, input.key);
  if (existing) return existing;
  return withControlPlaneTransaction(controllerHome, (database) => {
    const current = selectRecord<T>(database, input.namespace, input.scope, input.key);
    if (current) return current;
    const legacy = input.readLegacy();
    if (legacy === undefined) return undefined;
    return writeRecord(database, { ...input, value: legacy, action: 'legacy_import' });
  });
}

export function mutateControlPlaneRecord<T>(
  controllerHome: string,
  input: {
    namespace: string;
    scope: string;
    key: string;
    schemaVersion: number;
    readLegacy?: () => T | undefined;
    action: string;
    mutate: (current: ControlPlaneRecord<T> | undefined) => T;
  },
): ControlPlaneRecord<T> {
  return withControlPlaneTransaction(controllerHome, (database) => {
    let current = selectRecord<T>(database, input.namespace, input.scope, input.key);
    if (!current && input.readLegacy) {
      const legacy = input.readLegacy();
      if (legacy !== undefined) {
        current = writeRecord(database, {
          namespace: input.namespace,
          scope: input.scope,
          key: input.key,
          schemaVersion: input.schemaVersion,
          value: legacy,
          action: 'legacy_import',
        });
      }
    }
    return writeRecord(database, {
      namespace: input.namespace,
      scope: input.scope,
      key: input.key,
      schemaVersion: input.schemaVersion,
      value: input.mutate(current),
      action: input.action,
    }, current);
  });
}
