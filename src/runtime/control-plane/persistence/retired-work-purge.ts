import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  compactControlPlaneDatabaseOffline,
  withControlPlaneReadDatabase,
  withControlPlaneTransaction,
  type SqliteDatabase,
} from './sqlite-store';

// Exhaustive namespaces owned by the retired Work/WorkHandle lifecycle, NOT
// other execution facts such as Process, Requirement, Plan or UserRequest.
export const RETIRED_WORK_NAMESPACES = ['work_contract', 'work_semantic_revision', 'execution_work_handle'] as const;
const LEGACY_WORK_DIRECTORIES = ['work-handles', 'indexes/work-contracts'] as const;

export interface RetiredWorkPurgeReport {
  controllerHome: string;
  records: number;
  auditEvents: number;
  auditFloors: number;
  auditRecordCursors: number;
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
): Pick<RetiredWorkPurgeReport, 'records' | 'auditEvents' | 'auditFloors' | 'auditRecordCursors'> {
  return {
    records: countNamespace(db, 'control_plane_records'),
    auditEvents: countNamespace(db, 'control_plane_audit'),
    auditFloors: countNamespace(db, 'control_plane_audit_floor'),
    auditRecordCursors: countNamespace(db, 'control_plane_audit_record_cursor'),
  };
}

export function inspectRetiredWorkPurge(controllerHomeInput: string): RetiredWorkPurgeReport {
  const controllerHome = resolve(controllerHomeInput);
  const directories = legacyDirectories(controllerHome);
  const dbPath = join(controllerHome, 'control-plane.sqlite');
  const counts = existsSync(dbPath)
    ? withControlPlaneReadDatabase(controllerHome, statistics)
    : { records: 0, auditEvents: 0, auditFloors: 0, auditRecordCursors: 0 };
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
  if (after.records || after.auditEvents || after.auditFloors || after.auditRecordCursors || after.directories.length) {
    throw new Error('RETIRED_WORK_PURGE_INCOMPLETE');
  }
  return { ...before, applied: true };
}
