import { createHash } from 'crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { inspectControlPlaneDatabaseFile, type ControlPlaneDatabaseInspection } from '../control-plane/persistence/sqlite-store';
import { loadRuntimeReleaseManifest } from './release-manifest';
import { forgeRuntimeServicePaths, validateForgeRuntimeServiceConfig, type ForgeRuntimeServiceConfig } from './service';

/**
 * A Recovery-owned, bounded restore point.  The release is immutable Runtime
 * authority; the SQLite copy and service contract are the state and bootstrap
 * material needed to make that release useful after the Kernel is dead.
 */
export interface KnownGoodRecoveryBundle {
  schemaVersion: 1;
  attestationId: string;
  root: string;
  database: {
    path: string;
    sha256: string;
    schemaVersion: number;
    recordCount: number;
    auditEventCount: number;
  };
  serviceContract: {
    path: string;
    sha256: string;
  };
  createdAt: string;
}

export interface KnownGoodReleaseIdentity {
  path: string;
  revision: string;
  artifactIdentity: string;
  manifestSha256: string;
  workerProtocolVersion: number;
  controllerHome?: string;
  recoveryBundle?: KnownGoodRecoveryBundle;
}

export interface InspectedKnownGoodRecoveryBundle {
  releaseRoot: string;
  database: ControlPlaneDatabaseInspection;
  serviceConfig: ForgeRuntimeServiceConfig;
}

const SHA256_FILE_CHUNK_BYTES = 1024 * 1024;

/** Hash arbitrarily large Recovery artifacts without allocating the whole file. */
export function sha256FileBounded(path: string): string {
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(SHA256_FILE_CHUNK_BYTES);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

function canonical(path: string): string {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

function directChild(root: string, path: string): boolean {
  return canonical(dirname(path)) === canonical(root);
}

function inside(root: string, path: string): boolean {
  const value = relative(canonical(root), canonical(path));
  return value === '' || (!value.startsWith('..') && value !== '..');
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}

function requiredPositiveInteger(value: unknown, code: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
}

function validateRecoveryBundleShape(entry: KnownGoodReleaseIdentity, controllerHome: string): KnownGoodRecoveryBundle {
  const bundle = entry.recoveryBundle;
  if (!bundle || bundle.schemaVersion !== 1) throw new Error('KNOWN_GOOD_RECOVERY_BUNDLE_MISSING');
  const home = resolve(controllerHome);
  const root = resolve(bundle.root);
  const expectedBundlesRoot = resolve(home, 'recovery', 'bundles', 'known-good');
  const attestationId = requiredText(bundle.attestationId, 'KNOWN_GOOD_RECOVERY_BUNDLE_ID_INVALID');
  if (basename(root) !== attestationId || !directChild(expectedBundlesRoot, root)) {
    throw new Error('KNOWN_GOOD_RECOVERY_BUNDLE_OUTSIDE_AUTHORITY');
  }
  if (!/^[-a-zA-Z0-9_]{8,160}$/.test(attestationId)) throw new Error('KNOWN_GOOD_RECOVERY_BUNDLE_ID_INVALID');
  if (!inside(root, bundle.database.path) || basename(resolve(bundle.database.path)) !== 'controller.sqlite') {
    throw new Error('KNOWN_GOOD_RECOVERY_DATABASE_PATH_INVALID');
  }
  if (!inside(root, bundle.serviceContract.path) || basename(resolve(bundle.serviceContract.path)) !== 'service-contract.json') {
    throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_CONTRACT_PATH_INVALID');
  }
  requiredText(bundle.database.sha256, 'KNOWN_GOOD_RECOVERY_DATABASE_HASH_INVALID');
  requiredText(bundle.serviceContract.sha256, 'KNOWN_GOOD_RECOVERY_SERVICE_CONTRACT_HASH_INVALID');
  requiredPositiveInteger(bundle.database.schemaVersion, 'KNOWN_GOOD_RECOVERY_DATABASE_SCHEMA_INVALID');
  return {
    ...bundle,
    attestationId,
    root,
    database: { ...bundle.database, path: resolve(bundle.database.path) },
    serviceContract: { ...bundle.serviceContract, path: resolve(bundle.serviceContract.path) },
  };
}

/**
 * Validate the exact three-way restore invariant used by both Recovery and
 * release retention.  Legacy evidence without a Recovery bundle is historical
 * audit data only: it must never be promoted to recoverable authority.
 */
export function inspectKnownGoodRecoveryBundle(
  controllerHome: string,
  entry: KnownGoodReleaseIdentity,
): InspectedKnownGoodRecoveryBundle {
  const home = resolve(controllerHome);
  if (entry.controllerHome && canonical(entry.controllerHome) !== canonical(home)) {
    throw new Error('KNOWN_GOOD_RECOVERY_CONTROLLER_HOME_MISMATCH');
  }
  const manifestPath = resolve(requiredText(entry.path, 'KNOWN_GOOD_RELEASE_MANIFEST_PATH_INVALID'));
  const releasesRoot = resolve(home, 'runtime', 'releases');
  const releaseRoot = dirname(manifestPath);
  if (
    basename(manifestPath) !== 'manifest.json'
    || basename(releaseRoot) !== entry.revision
    || !directChild(releasesRoot, releaseRoot)
    || !existsSync(manifestPath)
  ) throw new Error('KNOWN_GOOD_RELEASE_OUTSIDE_AUTHORITY');
  const manifest = loadRuntimeReleaseManifest(manifestPath, home);
  if (
    manifest.releaseId !== entry.revision
    || manifest.artifactIdentity !== entry.artifactIdentity
    || manifest.workerProtocolVersion !== entry.workerProtocolVersion
    || sha256FileBounded(manifestPath) !== entry.manifestSha256
  ) throw new Error('KNOWN_GOOD_RELEASE_IDENTITY_MISMATCH');

  const bundle = validateRecoveryBundleShape(entry, home);
  if (!existsSync(bundle.database.path)) throw new Error('KNOWN_GOOD_RECOVERY_DATABASE_MISSING');
  if (sha256FileBounded(bundle.database.path) !== bundle.database.sha256) throw new Error('KNOWN_GOOD_RECOVERY_DATABASE_HASH_MISMATCH');
  const database = inspectControlPlaneDatabaseFile(bundle.database.path);
  if (
    database.schemaVersion !== bundle.database.schemaVersion
    || database.recordCount !== bundle.database.recordCount
    || database.auditEventCount !== bundle.database.auditEventCount
  ) throw new Error('KNOWN_GOOD_RECOVERY_DATABASE_INSPECTION_MISMATCH');

  if (!existsSync(bundle.serviceContract.path)) throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_CONTRACT_MISSING');
  if (sha256FileBounded(bundle.serviceContract.path) !== bundle.serviceContract.sha256) {
    throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_CONTRACT_HASH_MISMATCH');
  }
  let rawContract: unknown;
  try { rawContract = JSON.parse(readFileSync(bundle.serviceContract.path, 'utf8')); }
  catch { throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_CONTRACT_INVALID'); }
  if (!rawContract || typeof rawContract !== 'object' || Array.isArray(rawContract)) {
    throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_CONTRACT_INVALID');
  }
  const contract = rawContract as Record<string, unknown>;
  if (contract.schemaVersion !== 1 || !contract.serviceConfig || typeof contract.serviceConfig !== 'object' || Array.isArray(contract.serviceConfig)) {
    throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_CONTRACT_INVALID');
  }
  const serviceConfig = validateForgeRuntimeServiceConfig(contract.serviceConfig as ForgeRuntimeServiceConfig);
  if (canonical(serviceConfig.controllerHome) !== canonical(home)) throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_HOME_MISMATCH');
  const expectedConfigPath = forgeRuntimeServicePaths(home).configPath;
  if (canonical(requiredText(contract.configPath, 'KNOWN_GOOD_RECOVERY_SERVICE_PATH_INVALID')) !== canonical(expectedConfigPath)) {
    throw new Error('KNOWN_GOOD_RECOVERY_SERVICE_PATH_INVALID');
  }
  return { releaseRoot, database, serviceConfig };
}

export function knownGoodRecoveryBundleRoot(controllerHome: string): string {
  return join(resolve(controllerHome), 'recovery', 'bundles', 'known-good');
}
