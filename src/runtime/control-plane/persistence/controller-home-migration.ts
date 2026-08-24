import { createHash, randomUUID } from 'crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  backupControlPlaneDatabase,
  CONTROL_PLANE_SCHEMA_VERSION,
  inspectControlPlaneDatabaseFile,
  listControlPlaneRecords,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecord,
  writeControlPlaneRecordWithinTransaction,
  type ControlPlaneDatabaseInspection,
  type ControlPlaneRecord,
} from './sqlite-store';

const MIGRATION_NAMESPACE = 'controller_home_migration';
const MIGRATION_SCOPE = 'controller';
const IMPORTABLE_REFERENCED_NAMESPACES = [
  'execution_work_validation_index',
  'execution_edit_validation_run',
  'execution_edit_validation_index',
  'chatgpt_work_conversation_binding',
  'controller_session_claim_store',
  'controller_round_relay',
  'external_controller_launch_reservation',
] as const;
const TERMINAL_WORK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface ControllerHomeMigrationRecordRef {
  namespace: string;
  scope: string;
  key: string;
  schemaVersion: number;
  sourceRevision: number;
  sourceUpdatedAt: string;
}

export interface ControllerHomeMigrationConflict extends ControllerHomeMigrationRecordRef {
  kind: 'payload_conflict';
}

export interface ControllerHomeMigrationPreview {
  sourceHome: string;
  destinationHome: string;
  sourceDatabase: {
    path: string;
    sha256: string;
    walPath?: string;
    walSha256?: string;
    inspection: ControlPlaneDatabaseInspection;
  };
  destinationDatabase: {
    path: string;
    exists: boolean;
    inspection?: ControlPlaneDatabaseInspection;
  };
  selected: ControllerHomeMigrationRecordRef[];
  selectedByNamespace: Record<string, number>;
  identical: ControllerHomeMigrationRecordRef[];
  conflicts: ControllerHomeMigrationConflict[];
  archivedOnly: {
    terminalWorkContracts: number;
    excludedNamespaces: readonly string[];
    auditChain: 'retained_in_source_sqlite';
  };
}

interface ImportedRecord extends ControllerHomeMigrationRecordRef {
  destinationRevision: number;
}

interface ControllerHomeMigrationRecord {
  schemaVersion: 1;
  migrationId: string;
  status: 'applied' | 'rolled_back';
  sourceHome: string;
  destinationHome: string;
  sourceDatabase: ControllerHomeMigrationPreview['sourceDatabase'];
  destinationBackupPath: string;
  selected: ControllerHomeMigrationRecordRef[];
  imported: ImportedRecord[];
  identical: ControllerHomeMigrationRecordRef[];
  archivedOnly: ControllerHomeMigrationPreview['archivedOnly'];
  sourceArchive: {
    databaseModeBefore: number;
    databaseModeAfter: number;
    walModeBefore?: number;
    walModeAfter?: number;
    state: 'read_only' | 'restored';
  };
  appliedAt: string;
  rolledBackAt?: string;
}

export interface AppliedControllerHomeMigration {
  preview: ControllerHomeMigrationPreview;
  migration: ControllerHomeMigrationRecord;
  reportPath: string;
}

function databasePath(home: string): string {
  return join(resolve(home), 'control-plane.sqlite');
}

function recordRef(record: ControlPlaneRecord<unknown>): ControllerHomeMigrationRecordRef {
  return {
    namespace: record.namespace,
    scope: record.scope,
    key: record.key,
    schemaVersion: record.schemaVersion,
    sourceRevision: record.revision,
    sourceUpdatedAt: record.updatedAt,
  };
}

function recordIdentity(record: Pick<ControlPlaneRecord<unknown>, 'namespace' | 'scope' | 'key'>): string {
  return `${record.namespace}\u0000${record.scope}\u0000${record.key}`;
}

function sameRecord(left: ControlPlaneRecord<unknown>, right: ControlPlaneRecord<unknown>): boolean {
  return left.schemaVersion === right.schemaVersion && JSON.stringify(left.value) === JSON.stringify(right.value);
}

function referencesOneOf(value: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return ids.has(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => referencesOneOf(entry, ids));
  return Object.values(value as Record<string, unknown>).some((entry) => referencesOneOf(entry, ids));
}

function addRecord(
  selected: Map<string, ControlPlaneRecord<unknown>>,
  record: ControlPlaneRecord<unknown>,
): void {
  selected.set(recordIdentity(record), record);
}

function allRecords(home: string, namespace: string): ControlPlaneRecord<unknown>[] {
  return listControlPlaneRecords<unknown>(home, { namespace, limit: 5_000 });
}

function sourceSelection(sourceHome: string): {
  records: ControlPlaneRecord<unknown>[];
  terminalWorkContracts: number;
} {
  const selected = new Map<string, ControlPlaneRecord<unknown>>();
  const workContracts = allRecords(sourceHome, 'work_contract');
  const activeWork = workContracts.filter((record) => {
    const status = (record.value as { status?: unknown }).status;
    return typeof status === 'string' && !TERMINAL_WORK_STATUSES.has(status);
  });
  for (const record of activeWork) addRecord(selected, record);

  const planIds = new Set(
    activeWork
      .map((record) => (record.value as { planId?: unknown }).planId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  for (const record of allRecords(sourceHome, 'plan_contract')) {
    if (planIds.has(record.key)) addRecord(selected, record);
  }

  const workIds = new Set(activeWork.map((record) => record.key));
  const workHandles = allRecords(sourceHome, 'execution_work_handle').filter((record) => {
    const value = record.value as { workId?: unknown; workContractId?: unknown };
    return (typeof value.workId === 'string' && workIds.has(value.workId))
      || (typeof value.workContractId === 'string' && workIds.has(value.workContractId));
  });
  for (const record of workHandles) addRecord(selected, record);

  const sessionIds = new Set(
    workHandles
      .map((record) => (record.value as { sessionId?: unknown }).sessionId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  for (const record of allRecords(sourceHome, 'execution_session')) {
    const sessionId = (record.value as { sessionId?: unknown }).sessionId;
    if (sessionIds.has(record.key) || (typeof sessionId === 'string' && sessionIds.has(sessionId))) addRecord(selected, record);
  }

  const referenceIds = new Set<string>([...workIds, ...planIds, ...sessionIds]);
  for (const namespace of IMPORTABLE_REFERENCED_NAMESPACES) {
    for (const record of allRecords(sourceHome, namespace)) {
      if (referencesOneOf(record.value, referenceIds)) addRecord(selected, record);
    }
  }

  return {
    records: [...selected.values()].sort((left, right) => recordIdentity(left).localeCompare(recordIdentity(right))),
    terminalWorkContracts: workContracts.length - activeWork.length,
  };
}

async function sha256(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', (chunk: Buffer) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function selectedByNamespace(records: readonly ControllerHomeMigrationRecordRef[]): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.namespace] = (counts[record.namespace] ?? 0) + 1;
    return counts;
  }, {});
}

function destinationRecordIfPresent(
  destinationHome: string,
  destinationExists: boolean,
  record: ControlPlaneRecord<unknown>,
): ControlPlaneRecord<unknown> | undefined {
  if (!destinationExists) return undefined;
  return readControlPlaneRecord<unknown>(destinationHome, record.namespace, record.scope, record.key);
}

export async function previewControllerHomeMigration(input: {
  sourceHome: string;
  destinationHome: string;
}): Promise<ControllerHomeMigrationPreview> {
  const sourceHome = resolve(input.sourceHome);
  const destinationHome = resolve(input.destinationHome);
  if (sourceHome === destinationHome) throw new Error('CONTROLLER_HOME_MIGRATION_SAME_HOME');
  const sourceDatabase = databasePath(sourceHome);
  if (!existsSync(sourceDatabase)) throw new Error(`CONTROLLER_HOME_MIGRATION_SOURCE_DATABASE_MISSING: ${sourceDatabase}`);
  const sourceWal = `${sourceDatabase}-wal`;
  const sourceWalExists = existsSync(sourceWal);

  const selection = sourceSelection(sourceHome);
  const selected = selection.records.map(recordRef);
  const destinationDatabase = databasePath(destinationHome);
  const destinationExists = existsSync(destinationDatabase);
  const identical: ControllerHomeMigrationRecordRef[] = [];
  const conflicts: ControllerHomeMigrationConflict[] = [];
  for (const record of selection.records) {
    const destination = destinationRecordIfPresent(destinationHome, destinationExists, record);
    if (!destination) continue;
    if (sameRecord(record, destination)) identical.push(recordRef(record));
    else conflicts.push({ ...recordRef(record), kind: 'payload_conflict' });
  }

  return {
    sourceHome,
    destinationHome,
    sourceDatabase: {
      path: sourceDatabase,
      sha256: await sha256(sourceDatabase),
      ...(sourceWalExists ? { walPath: sourceWal, walSha256: await sha256(sourceWal) } : {}),
      inspection: inspectControlPlaneDatabaseFile(sourceDatabase),
    },
    destinationDatabase: {
      path: destinationDatabase,
      exists: destinationExists,
      ...(destinationExists ? { inspection: inspectControlPlaneDatabaseFile(destinationDatabase) } : {}),
    },
    selected,
    selectedByNamespace: selectedByNamespace(selected),
    identical,
    conflicts,
    archivedOnly: {
      terminalWorkContracts: selection.terminalWorkContracts,
      excludedNamespaces: ['mcp credentials', 'runtime release authority', 'runtime owner', 'Recovery state', 'plugin configuration', 'process bindings and logs'],
      auditChain: 'retained_in_source_sqlite',
    },
  };
}

function reportPath(destinationHome: string, migrationId: string): string {
  return join(destinationHome, 'archives', 'controller-home-migrations', `${migrationId}.json`);
}

function writeReport(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function applyControllerHomeMigration(input: {
  sourceHome: string;
  destinationHome: string;
}): Promise<AppliedControllerHomeMigration> {
  const preview = await previewControllerHomeMigration(input);
  if (preview.conflicts.length > 0) {
    throw new Error(`CONTROLLER_HOME_MIGRATION_CONFLICTS: ${preview.conflicts.length}`);
  }
  const migrationId = `controller-home-${randomUUID()}`;
  const destinationBackupPath = join(
    preview.destinationHome,
    'backups',
    'controller-home-migrations',
    `${migrationId}.before.sqlite`,
  );
  backupControlPlaneDatabase(preview.destinationHome, destinationBackupPath);
  const sourceMode = statSync(preview.sourceDatabase.path).mode & 0o777;
  const sourceWalMode = preview.sourceDatabase.walPath && existsSync(preview.sourceDatabase.walPath)
    ? statSync(preview.sourceDatabase.walPath).mode & 0o777
    : undefined;
  const imported: ImportedRecord[] = [];
  const selectedRecords = sourceSelection(preview.sourceHome).records;
  const migration = withControlPlaneTransaction(preview.destinationHome, (database) => {
    for (const record of selectedRecords) {
      const current = readControlPlaneRecordWithinTransaction<unknown>(database, record.namespace, record.scope, record.key);
      if (current) {
        if (sameRecord(record, current)) continue;
        throw new Error(`CONTROLLER_HOME_MIGRATION_CONFLICT: ${record.namespace}/${record.scope}/${record.key}`);
      }
      const written = writeControlPlaneRecordWithinTransaction(database, {
        namespace: record.namespace,
        scope: record.scope,
        key: record.key,
        schemaVersion: record.schemaVersion,
        value: record.value,
        action: 'controller_home_migration_import',
        expectedRevision: null,
      });
      imported.push({ ...recordRef(record), destinationRevision: written.revision });
    }
    const value: ControllerHomeMigrationRecord = {
      schemaVersion: 1,
      migrationId,
      status: 'applied',
      sourceHome: preview.sourceHome,
      destinationHome: preview.destinationHome,
      sourceDatabase: preview.sourceDatabase,
      destinationBackupPath,
      selected: preview.selected,
      imported,
      identical: preview.identical,
      archivedOnly: preview.archivedOnly,
      sourceArchive: {
        databaseModeBefore: sourceMode,
        databaseModeAfter: sourceMode,
        ...(sourceWalMode === undefined ? {} : { walModeBefore: sourceWalMode, walModeAfter: sourceWalMode }),
        state: 'restored',
      },
      appliedAt: new Date().toISOString(),
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: MIGRATION_NAMESPACE,
      scope: MIGRATION_SCOPE,
      key: migrationId,
      schemaVersion: 1,
      value,
      action: 'controller_home_migration_applied',
      expectedRevision: null,
    });
    return value;
  });

  // Only the legacy SQLite authority is frozen. Its full audit history stays
  // queryable in place; no OAuth, Runtime, Recovery, or plugin files move.
  const readOnlyMode = sourceMode & ~0o222;
  chmodSync(preview.sourceDatabase.path, readOnlyMode);
  const readOnlyWalMode = sourceWalMode === undefined ? undefined : sourceWalMode & ~0o222;
  if (preview.sourceDatabase.walPath && readOnlyWalMode !== undefined) chmodSync(preview.sourceDatabase.walPath, readOnlyWalMode);
  const archived = {
    ...migration,
    sourceArchive: {
      databaseModeBefore: sourceMode,
      databaseModeAfter: readOnlyMode,
      ...(sourceWalMode === undefined ? {} : { walModeBefore: sourceWalMode, walModeAfter: readOnlyWalMode }),
      state: 'read_only' as const,
    },
  };
  writeControlPlaneRecord(preview.destinationHome, {
    namespace: MIGRATION_NAMESPACE,
    scope: MIGRATION_SCOPE,
    key: migrationId,
    schemaVersion: 1,
    value: archived,
    action: 'controller_home_migration_archive_source',
    expectedRevision: 1,
  });
  const path = reportPath(preview.destinationHome, migrationId);
  writeReport(path, { preview, migration: archived });
  return { preview, migration: archived, reportPath: path };
}

export function rollbackControllerHomeMigration(input: {
  destinationHome: string;
  migrationId: string;
}): ControllerHomeMigrationRecord {
  const destinationHome = resolve(input.destinationHome);
  const current = readControlPlaneRecord<ControllerHomeMigrationRecord>(
    destinationHome,
    MIGRATION_NAMESPACE,
    MIGRATION_SCOPE,
    input.migrationId,
  );
  if (!current) throw new Error(`CONTROLLER_HOME_MIGRATION_NOT_FOUND: ${input.migrationId}`);
  if (current.value.status === 'rolled_back') return current.value;

  const rolledBack = withControlPlaneTransaction(destinationHome, (database) => {
    for (const imported of current.value.imported) {
      const record = readControlPlaneRecordWithinTransaction<unknown>(database, imported.namespace, imported.scope, imported.key);
      if (!record || record.revision !== imported.destinationRevision) {
        throw new Error(`CONTROLLER_HOME_MIGRATION_ROLLBACK_CONFLICT: ${imported.namespace}/${imported.scope}/${imported.key}`);
      }
      database.prepare(`
        DELETE FROM control_plane_audit
        WHERE namespace = ? AND scope = ? AND record_key = ?
      `).run(imported.namespace, imported.scope, imported.key);
      database.prepare(`
        DELETE FROM control_plane_records
        WHERE namespace = ? AND scope = ? AND record_key = ?
      `).run(imported.namespace, imported.scope, imported.key);
    }
    const value: ControllerHomeMigrationRecord = {
      ...current.value,
      status: 'rolled_back',
      sourceArchive: {
        ...current.value.sourceArchive,
        state: 'restored',
      },
      rolledBackAt: new Date().toISOString(),
    };
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: MIGRATION_NAMESPACE,
      scope: MIGRATION_SCOPE,
      key: current.value.migrationId,
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      value,
      action: 'controller_home_migration_rolled_back',
      expectedRevision: current.revision,
    });
    return value;
  });
  chmodSync(rolledBack.sourceDatabase.path, rolledBack.sourceArchive.databaseModeBefore);
  if (rolledBack.sourceDatabase.walPath && rolledBack.sourceArchive.walModeBefore !== undefined) {
    chmodSync(rolledBack.sourceDatabase.walPath, rolledBack.sourceArchive.walModeBefore);
  }
  writeReport(reportPath(destinationHome, rolledBack.migrationId), { migration: rolledBack });
  return rolledBack;
}
