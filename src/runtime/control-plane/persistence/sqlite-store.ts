import { createRequire } from 'node:module';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { durableControllerHome } from '../../../cli/repositories/controller-home';

/**
 * Small, dependency-free SQLite boundary for controller-owned runtime facts.
 *
 * Bun is the normal runtime, while the package launcher can fall back to Node
 * 22.  Both provide a synchronous SQLite binding, but expose it under a
 * different module/class name.  Keeping the adapter here avoids leaking either
 * runtime API into persistence callers or adding a native npm dependency.
 */
interface SqliteStatement {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): unknown;
}

interface SqliteDatabase {
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

const DATABASE_FILE = 'control-plane.sqlite';
const require = createRequire(import.meta.url);

function now(): string {
  return new Date().toISOString();
}

export function controlPlaneDatabasePath(controllerHome: string): string {
  const home = durableControllerHome(controllerHome);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return join(home, DATABASE_FILE);
}

function openDatabase(controllerHome: string): SqliteDatabase {
  const runtimeModule = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
  const sqlite = require(runtimeModule) as SqliteModule;
  const Constructor = sqlite.Database ?? sqlite.DatabaseSync;
  if (!Constructor) throw new Error(`CONTROL_PLANE_SQLITE_UNAVAILABLE: ${runtimeModule} did not provide a database constructor`);
  const database = new Constructor(controlPlaneDatabasePath(controllerHome));
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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
  `);
  database.prepare('INSERT OR IGNORE INTO control_plane_schema (version, applied_at) VALUES (?, ?)').run(1, now());
  return database;
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
  const revision = (existing?.revision ?? 0) + 1;
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
  const database = openDatabase(controllerHome);
  try {
    return selectRecord<T>(database, namespace, scope, key);
  } finally {
    database.close();
  }
}

export function writeControlPlaneRecord<T>(
  controllerHome: string,
  input: { namespace: string; scope: string; key: string; schemaVersion: number; value: T; action?: string },
): ControlPlaneRecord<T> {
  return withControlPlaneTransaction(controllerHome, (database) =>
    writeRecord(database, { ...input, action: input.action ?? 'write' }, selectRecord<T>(database, input.namespace, input.scope, input.key)));
}

/**
 * Imports a legacy JSON record once and only when SQLite has no authoritative
 * row.  A failed import never modifies either source.  Afterwards callers
 * write only SQLite, preventing a long-lived dual source of truth.
 */
export function readOrImportControlPlaneRecord<T>(
  controllerHome: string,
  input: { namespace: string; scope: string; key: string; schemaVersion: number; readLegacy: () => T | undefined },
): ControlPlaneRecord<T> | undefined {
  // Normal recovery reads stay read-only.  Only a missing row enters the
  // immediate transaction that arbitrates a single legacy import.
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
