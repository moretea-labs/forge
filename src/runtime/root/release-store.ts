import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import {
  backupControlPlaneDatabase,
  controlPlaneDatabasePath,
  openControlPlaneDatabaseChangeObserver,
  restoreControlPlaneDatabase,
  sha256ControlPlaneDatabaseFile,
  type ControlPlaneDatabaseChangeObserver,
  type ControlPlaneDatabaseInspection,
} from '../control-plane/persistence/sqlite-store';
import { loadRuntimeReleaseManifest } from './release-manifest';
import type { RuntimeReleaseManifest } from './types';
import { assertStorageHeadroom } from '../shared/storage-capacity';

/**
 * Local Controller Home recovery evidence. This database contains execution
 * state and is never part of a release artifact, source checkout, package, or
 * manifest distributed to another user or machine.
 */
export interface RuntimeDatabaseBackup {
  path: string;
  schemaVersion: number;
  createdAt: string;
  /** Legacy partial mutation evidence retained for wire compatibility/audit. */
  auditEventCount?: number;
  /** Diagnostic cardinality captured with the same SQLite snapshot. */
  recordCount?: number;
  /** Whole SQLite snapshot identity; authoritative for rollback freshness. */
  databaseSha256?: string;
}

export interface RuntimePublishedRelease {
  releaseId: string;
  artifactIdentity: string;
  manifestPath: string;
  manifestSha256: string;
  workerProtocolVersion: number;
  publishedAt: string;
  databaseBackup?: RuntimeDatabaseBackup;
}

export interface RuntimeReleaseAuthority {
  schemaVersion: 2;
  status: 'committed';
  revision: number;
  fencingToken: string;
  active: RuntimePublishedRelease;
  previous?: RuntimePublishedRelease;
  operationId: string;
  committedAt: string;
}

export interface RuntimeReleaseStoreDependencies {
  backupDatabase(controllerHome: string, destinationPath: string): ControlPlaneDatabaseInspection;
  restoreDatabase(controllerHome: string, backupPath: string): ControlPlaneDatabaseInspection;
  openDatabaseChangeObserver?(controllerHome: string): ControlPlaneDatabaseChangeObserver;
}

export interface PreparedRuntimeReleaseDatabaseBackup {
  controllerHome: string;
  activeReleaseId: string;
  operationId: string;
  path: string;
  inspection: ControlPlaneDatabaseInspection;
  databaseSha256: string;
  takeIfCurrent(): { path: string; inspection: ControlPlaneDatabaseInspection; databaseSha256: string } | undefined;
  release(): void;
  discard(): void;
}

export type RuntimeDatabaseRollbackDisposition =
  | 'restored_backup'
  | 'preserved_newer_live_state'
  | 'preserved_unversioned_backup';

export interface RuntimeReleaseRollbackResult {
  authority: RuntimeReleaseAuthority;
  databaseDisposition: RuntimeDatabaseRollbackDisposition;
  liveAuditEventCount: number;
  rollbackAuditEventCount?: number;
}

const DEFAULT_DEPENDENCIES: RuntimeReleaseStoreDependencies = {
  backupDatabase: backupControlPlaneDatabase,
  restoreDatabase: restoreControlPlaneDatabase,
  openDatabaseChangeObserver: openControlPlaneDatabaseChangeObserver,
};

const RUNTIME_RELEASE_STATE_RESERVE_BYTES = 64 * 1024 * 1024;

interface RuntimeManifestIdentityCacheEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  identity: Pick<RuntimePublishedRelease, 'releaseId' | 'artifactIdentity' | 'manifestPath' | 'manifestSha256' | 'workerProtocolVersion'>;
}

const runtimeManifestIdentityCache = new Map<string, RuntimeManifestIdentityCacheEntry>();

function fileSize(path: string): number {
  try { return existsSync(path) ? statSync(path).size : 0; } catch { return 0; }
}

function assertDatabaseBackupHeadroom(controllerHome: string, operation: string, extraBytes = 0): void {
  const databaseBytes = fileSize(controlPlaneDatabasePath(controllerHome));
  assertStorageHeadroom(controllerHome, {
    operation,
    requiredBytes: databaseBytes + Math.max(0, extraBytes),
    reserveBytes: RUNTIME_RELEASE_STATE_RESERVE_BYTES,
  });
}

export function runtimeReleaseAuthorityPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'runtime', 'releases', 'authority.json');
}

/** Resolve a local operational backup path under Controller Home only. */
function backupPath(controllerHome: string, releaseId: string, operationId: string): string {
  const safe = `${releaseId}-${operationId}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
  return join(ensureControllerHome(controllerHome), 'runtime', 'releases', 'backups', `${Date.now()}-${safe}.sqlite`);
}

interface RuntimeReleasePublicationLease {
  schemaVersion: 1;
  pid: number;
  operationId: string;
  candidateReleasePath: string;
  backupPath?: string;
}

function publicationLeaseDirectory(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'runtime', 'releases', '.publication-leases');
}

function publicationLeasePath(controllerHome: string, operationId: string): string {
  const safe = operationId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
  return join(publicationLeaseDirectory(controllerHome), `${safe}-${process.pid}.json`);
}

function writePublicationLease(
  controllerHome: string,
  operationId: string,
  candidateManifestPath: string,
  backupPathValue?: string,
): () => void {
  const path = publicationLeasePath(controllerHome, operationId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lease: RuntimeReleasePublicationLease = {
    schemaVersion: 1,
    pid: process.pid,
    operationId,
    candidateReleasePath: resolve(dirname(candidateManifestPath)),
    ...(backupPathValue ? { backupPath: resolve(backupPathValue) } : {}),
  };
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(path, { force: true });
  };
}

function atomicWrite(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  assertStorageHeadroom(path, {
    operation: 'runtime_release_authority_write',
    requiredBytes: Buffer.byteLength(content),
    reserveBytes: RUNTIME_RELEASE_STATE_RESERVE_BYTES,
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function manifestRecord(controllerHome: string, manifestPath: string, publishedAt = new Date().toISOString()): RuntimePublishedRelease {
  const path = resolve(manifestPath);
  const file = statSync(path);
  const cached = runtimeManifestIdentityCache.get(path);
  const identity = cached
    && cached.size === file.size
    && cached.mtimeMs === file.mtimeMs
    && cached.ctimeMs === file.ctimeMs
    && cached.ino === file.ino
    ? cached.identity
    : (() => {
      const manifest = loadRuntimeReleaseManifest(path, controllerHome);
      const bytes = readFileSync(path);
      const next: RuntimeManifestIdentityCacheEntry = {
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        ino: Number(file.ino ?? 0),
        identity: {
          releaseId: manifest.releaseId,
          artifactIdentity: manifest.artifactIdentity,
          manifestPath: path,
          manifestSha256: createHash('sha256').update(bytes).digest('hex'),
          workerProtocolVersion: manifest.workerProtocolVersion,
        },
      };
      runtimeManifestIdentityCache.set(path, next);
      return next.identity;
    })();
  return {
    ...identity,
    publishedAt,
  };
}

function validRelease(controllerHome: string, release: RuntimePublishedRelease | undefined): release is RuntimePublishedRelease {
  if (!release || !release.releaseId || !release.artifactIdentity || !release.manifestPath || !release.manifestSha256) return false;
  if (!Number.isInteger(release.workerProtocolVersion) || release.workerProtocolVersion < 1 || !Number.isFinite(Date.parse(release.publishedAt))) return false;
  try {
    const observed = manifestRecord(controllerHome, release.manifestPath, release.publishedAt);
    return observed.releaseId === release.releaseId
      && observed.artifactIdentity === release.artifactIdentity
      && observed.manifestSha256 === release.manifestSha256
      && observed.workerProtocolVersion === release.workerProtocolVersion
      && (!release.databaseBackup || (
        resolve(release.databaseBackup.path) === release.databaseBackup.path
        && Number.isInteger(release.databaseBackup.schemaVersion)
        && Number.isFinite(Date.parse(release.databaseBackup.createdAt))
        && (release.databaseBackup.auditEventCount === undefined
          || (Number.isSafeInteger(release.databaseBackup.auditEventCount) && release.databaseBackup.auditEventCount >= 0))
        && (release.databaseBackup.recordCount === undefined
          || (Number.isSafeInteger(release.databaseBackup.recordCount) && release.databaseBackup.recordCount >= 0))
        && (release.databaseBackup.databaseSha256 === undefined
          || /^[a-f0-9]{64}$/i.test(release.databaseBackup.databaseSha256))
      ));
  } catch {
    return false;
  }
}

interface LegacyRuntimeReleaseActivationTransaction {
  schemaVersion: 1;
  operationId: string;
  releaseSessionId?: string;
  candidateReleaseId: string;
  preActivationRevision: number;
  preActivationActive: RuntimePublishedRelease;
  preActivationPrevious?: RuntimePublishedRelease;
  startedAt: string;
}

type LegacyRuntimeReleaseAuthorityV1 = Omit<RuntimeReleaseAuthority, 'schemaVersion'> & {
  schemaVersion: 1;
  activation?: LegacyRuntimeReleaseActivationTransaction;
};

function validRuntimeReleaseAuthority(controllerHome: string, value: RuntimeReleaseAuthority): boolean {
  return value.schemaVersion === 2
    && value.status === 'committed'
    && Number.isInteger(value.revision)
    && value.revision >= 1
    && Boolean(value.fencingToken)
    && Boolean(value.operationId)
    && Number.isFinite(Date.parse(value.committedAt))
    && validRelease(controllerHome, value.active)
    && (value.previous === undefined || validRelease(controllerHome, value.previous));
}

export function migrateRuntimeReleaseAuthorityState(controllerHome: string): RuntimeReleaseAuthority | undefined {
  const path = runtimeReleaseAuthorityPath(controllerHome);
  if (!existsSync(path)) return undefined;
  let raw: RuntimeReleaseAuthority | LegacyRuntimeReleaseAuthorityV1;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as RuntimeReleaseAuthority | LegacyRuntimeReleaseAuthorityV1;
  } catch {
    throw new Error('RUNTIME_RELEASE_AUTHORITY_MIGRATION_INVALID_JSON');
  }
  if (raw.schemaVersion === 2) {
    if (!validRuntimeReleaseAuthority(controllerHome, raw as RuntimeReleaseAuthority)) {
      throw new Error('RUNTIME_RELEASE_AUTHORITY_MIGRATION_INVALID_CURRENT');
    }
    return raw as RuntimeReleaseAuthority;
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`RUNTIME_RELEASE_AUTHORITY_MIGRATION_UNSUPPORTED_SCHEMA: ${String((raw as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  const legacy = raw as LegacyRuntimeReleaseAuthorityV1;
  const { activation: _legacyActivation, ...physical } = legacy;
  const migrated = {
    ...physical,
    schemaVersion: 2,
  } satisfies RuntimeReleaseAuthority;
  if (!validRuntimeReleaseAuthority(controllerHome, migrated)) {
    throw new Error('RUNTIME_RELEASE_AUTHORITY_MIGRATION_INVALID_LEGACY_STATE');
  }
  atomicWrite(path, migrated);
  return migrated;
}

type RuntimeReleaseAuthorityRead =
  | { state: 'missing' }
  | { state: 'valid'; authority: RuntimeReleaseAuthority }
  | { state: 'invalid'; reason: string };

function inspectRuntimeReleaseAuthority(controllerHome: string): RuntimeReleaseAuthorityRead {
  const path = runtimeReleaseAuthorityPath(controllerHome);
  if (!existsSync(path)) return { state: 'missing' };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RuntimeReleaseAuthority;
    if (!validRuntimeReleaseAuthority(controllerHome, value)) {
      return { state: 'invalid', reason: 'authority fields or referenced release evidence are invalid' };
    }
    return { state: 'valid', authority: value };
  } catch (error) {
    return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

function mutableRuntimeReleaseAuthority(controllerHome: string): RuntimeReleaseAuthority | undefined {
  const observed = inspectRuntimeReleaseAuthority(controllerHome);
  if (observed.state === 'invalid') {
    throw new Error(`RUNTIME_RELEASE_AUTHORITY_INVALID_EXISTING: ${observed.reason}`);
  }
  return observed.state === 'valid' ? observed.authority : undefined;
}

export function readRuntimeReleaseAuthority(controllerHome: string): RuntimeReleaseAuthority | undefined {
  const observed = inspectRuntimeReleaseAuthority(controllerHome);
  return observed.state === 'valid' ? observed.authority : undefined;
}

function writeRuntimeReleaseAuthority(controllerHome: string, authority: RuntimeReleaseAuthority): RuntimeReleaseAuthority {
  if (!validRelease(controllerHome, authority.active)
    || (authority.previous && !validRelease(controllerHome, authority.previous))) {
    throw new Error('RUNTIME_RELEASE_AUTHORITY_INVALID');
  }
  atomicWrite(runtimeReleaseAuthorityPath(controllerHome), authority);
  return authority;
}

function sameRelease(left: RuntimePublishedRelease, right: RuntimePublishedRelease): boolean {
  return left.releaseId === right.releaseId
    && left.artifactIdentity === right.artifactIdentity
    && left.manifestSha256 === right.manifestSha256
    && left.workerProtocolVersion === right.workerProtocolVersion;
}

export function ensureActiveRuntimeRelease(
  controllerHome: string,
  manifestPath: string,
  operationId = 'runtime-start',
): RuntimeReleaseAuthority {
  const active = manifestRecord(controllerHome, manifestPath);
  const current = mutableRuntimeReleaseAuthority(controllerHome);
  if (current) {
    if (!sameRelease(current.active, active)) throw new Error('RUNTIME_RELEASE_AUTHORITY_MISMATCH');
    return current;
  }
  return writeRuntimeReleaseAuthority(controllerHome, {
    schemaVersion: 2,
    status: 'committed',
    revision: 1,
    fencingToken: randomUUID(),
    active,
    operationId,
    committedAt: new Date().toISOString(),
  });
}

export function prepareRuntimeReleaseDatabaseBackup(
  controllerHome: string,
  operationId: string,
  dependencies: RuntimeReleaseStoreDependencies = DEFAULT_DEPENDENCIES,
): PreparedRuntimeReleaseDatabaseBackup | undefined {
  if (!operationId.trim()) throw new Error('RUNTIME_RELEASE_OPERATION_ID_REQUIRED');
  const current = mutableRuntimeReleaseAuthority(controllerHome);
  if (!current) return undefined;
  assertDatabaseBackupHeadroom(controllerHome, 'prepare_runtime_release_database_backup');
  const observer = (dependencies.openDatabaseChangeObserver ?? openControlPlaneDatabaseChangeObserver)(controllerHome);
  const initialDataVersion = observer.dataVersion();
  const path = backupPath(controllerHome, current.active.releaseId, operationId);
  const releaseLease = writePublicationLease(controllerHome, operationId, current.active.manifestPath, path);
  let settled = false;
  try {
    const inspection = dependencies.backupDatabase(controllerHome, path);
    const databaseSha256 = sha256ControlPlaneDatabaseFile(path);
    const capturedDataVersion = observer.dataVersion();
    if (capturedDataVersion !== initialDataVersion) {
      observer.close();
      rmSync(path, { force: true });
      releaseLease();
      return undefined;
    }
    const discard = () => {
      if (settled) return;
      settled = true;
      observer.close();
      rmSync(path, { force: true });
      releaseLease();
    };
    return {
      controllerHome: resolve(controllerHome),
      activeReleaseId: current.active.releaseId,
      operationId,
      path: resolve(path),
      inspection,
      databaseSha256,
      takeIfCurrent() {
        if (settled) return undefined;
        settled = true;
        try {
          const currentDataVersion = observer.dataVersion();
          if (currentDataVersion !== capturedDataVersion) {
            rmSync(path, { force: true });
            releaseLease();
            return undefined;
          }
          return { path: resolve(path), inspection, databaseSha256 };
        } catch (error) {
          rmSync(path, { force: true });
          releaseLease();
          throw error;
        } finally {
          observer.close();
        }
      },
      release: releaseLease,
      discard,
    };
  } catch (error) {
    observer.close();
    rmSync(path, { force: true });
    releaseLease();
    throw error;
  }
}

export function publishRuntimeRelease(
  controllerHome: string,
  manifestPath: string,
  operationId: string,
  dependencies: RuntimeReleaseStoreDependencies = DEFAULT_DEPENDENCIES,
  preparedDatabaseBackup?: PreparedRuntimeReleaseDatabaseBackup,
): RuntimeReleaseAuthority {
  if (!operationId.trim()) throw new Error('RUNTIME_RELEASE_OPERATION_ID_REQUIRED');
  const candidate = manifestRecord(controllerHome, manifestPath);
  const current = mutableRuntimeReleaseAuthority(controllerHome);
  if (!current) {
    preparedDatabaseBackup?.discard();
    return writeRuntimeReleaseAuthority(controllerHome, {
      schemaVersion: 2,
      status: 'committed',
      revision: 1,
      fencingToken: randomUUID(),
      active: candidate,
      operationId,
      committedAt: new Date().toISOString(),
    });
  }
  if (sameRelease(current.active, candidate)) {
    preparedDatabaseBackup?.discard();
    return current;
  }
  const preparedMatches = Boolean(
    preparedDatabaseBackup
    && preparedDatabaseBackup.controllerHome === resolve(controllerHome)
    && preparedDatabaseBackup.activeReleaseId === current.active.releaseId
    && preparedDatabaseBackup.operationId === operationId,
  );
  const pendingBackupPath = preparedMatches && preparedDatabaseBackup
    ? preparedDatabaseBackup.path
    : backupPath(controllerHome, current.active.releaseId, operationId);
  let releaseLease = () => {};
  try {
  let prepared: { path: string; inspection: ControlPlaneDatabaseInspection; databaseSha256: string } | undefined;
  if (preparedMatches && preparedDatabaseBackup) {
    prepared = preparedDatabaseBackup.takeIfCurrent();
  } else {
    preparedDatabaseBackup?.discard();
    releaseLease = writePublicationLease(controllerHome, operationId, candidate.manifestPath, pendingBackupPath);
  }
  // A prepared backup lease initially protects Stable A. Refresh the same
  // lease with Candidate B before publication so cleanup protects both sides
  // of the complete authority transition.
  if (prepared || preparedMatches) {
    releaseLease = writePublicationLease(controllerHome, operationId, candidate.manifestPath, pendingBackupPath);
  }
  let backup: string;
  let inspection: ControlPlaneDatabaseInspection;
  let databaseSha256: string;
  if (prepared) {
    backup = prepared.path;
    inspection = prepared.inspection;
    databaseSha256 = prepared.databaseSha256;
  } else {
    assertDatabaseBackupHeadroom(controllerHome, 'publish_runtime_release_database_backup');
    backup = pendingBackupPath;
    inspection = dependencies.backupDatabase(controllerHome, backup);
    databaseSha256 = sha256ControlPlaneDatabaseFile(backup);
  }
  const committedAt = new Date().toISOString();
  const authority = writeRuntimeReleaseAuthority(controllerHome, {
    schemaVersion: 2,
    status: 'committed',
    revision: current.revision + 1,
    fencingToken: randomUUID(),
    active: { ...candidate, publishedAt: committedAt },
    previous: {
      ...current.active,
      databaseBackup: {
        path: resolve(backup),
        schemaVersion: inspection.schemaVersion,
        createdAt: committedAt,
        auditEventCount: inspection.auditEventCount,
        recordCount: inspection.recordCount,
        databaseSha256,
      },
    },
    operationId,
    committedAt,
  });
  return authority;
  } finally {
    releaseLease();
    preparedDatabaseBackup?.release();
  }
}

export function revertInitialRuntimeReleasePublication(controllerHome: string, operationId: string): void {
  const current = mutableRuntimeReleaseAuthority(controllerHome);
  if (!current) return;
  if (current.revision !== 1 || current.previous !== undefined || current.operationId !== operationId) {
    throw new Error('RUNTIME_RELEASE_INITIAL_PUBLICATION_REVERT_MISMATCH');
  }
  rmSync(runtimeReleaseAuthorityPath(controllerHome), { force: true });
}

export function rollbackRuntimeReleaseWithResult(
  controllerHome: string,
  operationId: string,
  dependencies: RuntimeReleaseStoreDependencies = DEFAULT_DEPENDENCIES,
): RuntimeReleaseRollbackResult {
  if (!operationId.trim()) throw new Error('RUNTIME_RELEASE_OPERATION_ID_REQUIRED');
  const current = mutableRuntimeReleaseAuthority(controllerHome);
  const target = current?.previous;
  if (!current || !target?.databaseBackup) throw new Error('RUNTIME_PREVIOUS_RELEASE_UNAVAILABLE');
  assertDatabaseBackupHeadroom(
    controllerHome,
    'rollback_runtime_release_database_transition',
    fileSize(target.databaseBackup.path),
  );
  const currentBackup = backupPath(controllerHome, current.active.releaseId, operationId);
  const currentInspection = dependencies.backupDatabase(controllerHome, currentBackup);
  const currentDatabaseSha256 = sha256ControlPlaneDatabaseFile(currentBackup);
  const rollbackDatabaseSha256 = target.databaseBackup.databaseSha256;
  const rollbackAuditEventCount = target.databaseBackup.auditEventCount;
  if (rollbackAuditEventCount !== undefined && currentInspection.auditEventCount < rollbackAuditEventCount) {
    rmSync(currentBackup, { force: true });
    throw new Error(`RUNTIME_RELEASE_DATABASE_GENERATION_REGRESSED: rollback=${rollbackAuditEventCount}; live=${currentInspection.auditEventCount}`);
  }
  // auditEventCount covers only record-store mutations and is retained as
  // diagnostic/legacy evidence. Whole-snapshot identity is the only proof that
  // no SQLite domain state changed after cutover.
  const databaseDisposition: RuntimeDatabaseRollbackDisposition = rollbackDatabaseSha256 === undefined
    ? 'preserved_unversioned_backup'
    : currentDatabaseSha256 === rollbackDatabaseSha256
      ? 'restored_backup'
      : 'preserved_newer_live_state';
  if (databaseDisposition === 'restored_backup') {
    dependencies.restoreDatabase(controllerHome, target.databaseBackup.path);
  }
  const committedAt = new Date().toISOString();
  try {
    const authority = writeRuntimeReleaseAuthority(controllerHome, {
      schemaVersion: 2,
      status: 'committed',
      revision: current.revision + 1,
      fencingToken: randomUUID(),
      active: {
        releaseId: target.releaseId,
        artifactIdentity: target.artifactIdentity,
        manifestPath: target.manifestPath,
        manifestSha256: target.manifestSha256,
        workerProtocolVersion: target.workerProtocolVersion,
        publishedAt: committedAt,
      },
      previous: {
        ...current.active,
        databaseBackup: {
          path: resolve(currentBackup),
          schemaVersion: currentInspection.schemaVersion,
          createdAt: committedAt,
          auditEventCount: currentInspection.auditEventCount,
          recordCount: currentInspection.recordCount,
          databaseSha256: currentDatabaseSha256,
        },
      },
      operationId,
      committedAt,
    });
    return {
      authority,
      databaseDisposition,
      liveAuditEventCount: currentInspection.auditEventCount,
      ...(rollbackAuditEventCount === undefined ? {} : { rollbackAuditEventCount }),
    };
  } catch (error) {
    if (databaseDisposition === 'restored_backup') {
      dependencies.restoreDatabase(controllerHome, currentBackup);
    }
    throw error;
  }
}

export function rollbackRuntimeRelease(
  controllerHome: string,
  operationId: string,
  dependencies: RuntimeReleaseStoreDependencies = DEFAULT_DEPENDENCIES,
): RuntimeReleaseAuthority {
  return rollbackRuntimeReleaseWithResult(controllerHome, operationId, dependencies).authority;
}

/**
 * Failed activation is transaction compensation, not a user-requested reverse
 * release transition. Once the physical rollback has restored the old active
 * release, restore the exact pre-activation active/previous topology while
 * keeping authority revision monotonic and rotating the fence.
 */
export function reconcileFailedRuntimeReleaseActivationAuthority(
  controllerHome: string,
  before: RuntimeReleaseAuthority,
  failedReleaseId: string,
  operationId: string,
): RuntimeReleaseAuthority {
  if (!operationId.trim()) throw new Error('RUNTIME_RELEASE_OPERATION_ID_REQUIRED');
  const current = mutableRuntimeReleaseAuthority(controllerHome);
  if (!current) throw new Error('RUNTIME_RELEASE_FAILED_ACTIVATION_AUTHORITY_MISSING');
  if (!sameRelease(current.active, before.active)) {
    throw new Error('RUNTIME_RELEASE_FAILED_ACTIVATION_ACTIVE_MISMATCH');
  }
  if (current.previous?.releaseId !== failedReleaseId) {
    throw new Error('RUNTIME_RELEASE_FAILED_ACTIVATION_CANDIDATE_MISMATCH');
  }
  return writeRuntimeReleaseAuthority(controllerHome, {
    schemaVersion: 2,
    status: 'committed',
    revision: current.revision + 1,
    fencingToken: randomUUID(),
    active: before.active,
    ...(before.previous ? { previous: before.previous } : {}),
    operationId,
    committedAt: new Date().toISOString(),
  });
}

export function activeRuntimeReleaseManifest(controllerHome: string): RuntimeReleaseManifest | undefined {
  const authority = readRuntimeReleaseAuthority(controllerHome);
  return authority ? loadRuntimeReleaseManifest(authority.active.manifestPath, controllerHome) : undefined;
}
