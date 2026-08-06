import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import {
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  type ControlPlaneDatabaseInspection,
} from '../control-plane/persistence/sqlite-store';
import { loadRuntimeReleaseManifest } from './release-manifest';
import type { RuntimeReleaseManifest } from './types';

export interface RuntimeDatabaseBackup {
  path: string;
  schemaVersion: number;
  createdAt: string;
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
  schemaVersion: 1;
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
}

const DEFAULT_DEPENDENCIES: RuntimeReleaseStoreDependencies = {
  backupDatabase: backupControlPlaneDatabase,
  restoreDatabase: restoreControlPlaneDatabase,
};

export function runtimeReleaseAuthorityPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'runtime', 'releases', 'authority.json');
}

function backupPath(controllerHome: string, releaseId: string, operationId: string): string {
  const safe = `${releaseId}-${operationId}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
  return join(ensureControllerHome(controllerHome), 'runtime', 'releases', 'backups', `${Date.now()}-${safe}.sqlite`);
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function manifestRecord(controllerHome: string, manifestPath: string, publishedAt = new Date().toISOString()): RuntimePublishedRelease {
  const path = resolve(manifestPath);
  const manifest = loadRuntimeReleaseManifest(path, controllerHome);
  const bytes = readFileSync(path);
  return {
    releaseId: manifest.releaseId,
    artifactIdentity: manifest.artifactIdentity,
    manifestPath: path,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    workerProtocolVersion: manifest.workerProtocolVersion,
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
      ));
  } catch {
    return false;
  }
}

export function readRuntimeReleaseAuthority(controllerHome: string): RuntimeReleaseAuthority | undefined {
  const path = runtimeReleaseAuthorityPath(controllerHome);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RuntimeReleaseAuthority;
    if (
      value.schemaVersion !== 1
      || value.status !== 'committed'
      || !Number.isInteger(value.revision)
      || value.revision < 1
      || !value.fencingToken
      || !value.operationId
      || !Number.isFinite(Date.parse(value.committedAt))
      || !validRelease(controllerHome, value.active)
      || (value.previous !== undefined && !validRelease(controllerHome, value.previous))
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeRuntimeReleaseAuthority(controllerHome: string, authority: RuntimeReleaseAuthority): RuntimeReleaseAuthority {
  if (!validRelease(controllerHome, authority.active) || (authority.previous && !validRelease(controllerHome, authority.previous))) {
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
  const current = readRuntimeReleaseAuthority(controllerHome);
  if (current) {
    if (!sameRelease(current.active, active)) throw new Error('RUNTIME_RELEASE_AUTHORITY_MISMATCH');
    return current;
  }
  return writeRuntimeReleaseAuthority(controllerHome, {
    schemaVersion: 1,
    status: 'committed',
    revision: 1,
    fencingToken: randomUUID(),
    active,
    operationId,
    committedAt: new Date().toISOString(),
  });
}

export function publishRuntimeRelease(
  controllerHome: string,
  manifestPath: string,
  operationId: string,
  dependencies: RuntimeReleaseStoreDependencies = DEFAULT_DEPENDENCIES,
): RuntimeReleaseAuthority {
  if (!operationId.trim()) throw new Error('RUNTIME_RELEASE_OPERATION_ID_REQUIRED');
  const candidate = manifestRecord(controllerHome, manifestPath);
  const current = readRuntimeReleaseAuthority(controllerHome);
  if (!current) return ensureActiveRuntimeRelease(controllerHome, manifestPath, operationId);
  if (sameRelease(current.active, candidate)) return current;
  const backup = backupPath(controllerHome, current.active.releaseId, operationId);
  const inspection = dependencies.backupDatabase(controllerHome, backup);
  const committedAt = new Date().toISOString();
  return writeRuntimeReleaseAuthority(controllerHome, {
    schemaVersion: 1,
    status: 'committed',
    revision: current.revision + 1,
    fencingToken: randomUUID(),
    active: { ...candidate, publishedAt: committedAt },
    previous: {
      ...current.active,
      databaseBackup: { path: resolve(backup), schemaVersion: inspection.schemaVersion, createdAt: committedAt },
    },
    operationId,
    committedAt,
  });
}

export function rollbackRuntimeRelease(
  controllerHome: string,
  operationId: string,
  dependencies: RuntimeReleaseStoreDependencies = DEFAULT_DEPENDENCIES,
): RuntimeReleaseAuthority {
  if (!operationId.trim()) throw new Error('RUNTIME_RELEASE_OPERATION_ID_REQUIRED');
  const current = readRuntimeReleaseAuthority(controllerHome);
  const target = current?.previous;
  if (!current || !target?.databaseBackup) throw new Error('RUNTIME_PREVIOUS_RELEASE_UNAVAILABLE');
  const currentBackup = backupPath(controllerHome, current.active.releaseId, operationId);
  const currentInspection = dependencies.backupDatabase(controllerHome, currentBackup);
  dependencies.restoreDatabase(controllerHome, target.databaseBackup.path);
  const committedAt = new Date().toISOString();
  try {
    return writeRuntimeReleaseAuthority(controllerHome, {
      schemaVersion: 1,
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
        databaseBackup: { path: resolve(currentBackup), schemaVersion: currentInspection.schemaVersion, createdAt: committedAt },
      },
      operationId,
      committedAt,
    });
  } catch (error) {
    dependencies.restoreDatabase(controllerHome, currentBackup);
    throw error;
  }
}

export function activeRuntimeReleaseManifest(controllerHome: string): RuntimeReleaseManifest | undefined {
  const authority = readRuntimeReleaseAuthority(controllerHome);
  return authority ? loadRuntimeReleaseManifest(authority.active.manifestPath, controllerHome) : undefined;
}
