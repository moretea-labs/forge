import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const V172_BASELINE_RECONSTRUCTION_SCHEMA = 'forge-evaluation-baseline-reconstruction/v1' as const;
export const V172_BASELINE_RECONSTRUCTION_PATH = 'evaluation/baselines/v1.7.2/reconstruction.json' as const;

export interface V172BaselineReconstructionAuthority {
  schemaVersion: typeof V172_BASELINE_RECONSTRUCTION_SCHEMA;
  candidateId: 'forge-v1.7.2';
  versionLabel: 'v1.7.2';
  sourceRevision: string;
  executionSurface: 'public_mcp';
  publishedPackage: {
    specifier: '@moretea-labs/forge@1.7.2';
    registry: 'https://registry.npmjs.org/';
    tarballSha256: string;
    releaseManifestPath: string;
    releaseManifestSha256: string;
  };
  dependencyLock: {
    path: string;
    sha256: string;
    sourceRevision: string;
    sourcePath: 'package-lock.json';
    sourceSha256: string;
    normalization: 'root_manifest_metadata_only';
  };
  installer: {
    executable: 'npm';
    version: string;
    arguments: readonly string[];
  };
  builder: {
    entryPath: 'evaluation/build-v172-baseline.ts';
    implementationFiles: Readonly<Record<string, string>>;
  };
  entryPath: 'bin/forge.mjs';
  historicalArtifactDigest: string;
}

function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value)) throw new Error(`EVALUATION_BASELINE_${field}_INVALID`);
  return value.toLowerCase();
}

function fileSha256(repoRoot: string, path: string): string {
  return sha256Bytes(readFileSync(resolve(repoRoot, path)));
}

function gitFile(repoRoot: string, revision: string, path: string): Buffer {
  return execFileSync('git', ['show', `${revision}:${path}`], { cwd: repoRoot });
}

function normalizedReleaseLock(sourceLockBytes: Buffer, releaseManifest: Record<string, unknown>): string {
  const lock = JSON.parse(sourceLockBytes.toString('utf8')) as { packages?: Record<string, Record<string, unknown>> };
  const root = lock.packages?.[''];
  if (!root) throw new Error('EVALUATION_BASELINE_SOURCE_LOCK_ROOT_MISSING');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    if (releaseManifest[key] === undefined) delete root[key];
    else root[key] = releaseManifest[key];
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
}


function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(code);
}

export function readV172BaselineReconstructionAuthority(repoRoot = process.cwd()): V172BaselineReconstructionAuthority {
  const path = resolve(repoRoot, V172_BASELINE_RECONSTRUCTION_PATH);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  exactKeys(parsed, ['schemaVersion', 'candidateId', 'versionLabel', 'sourceRevision', 'executionSurface', 'publishedPackage', 'dependencyLock', 'installer', 'builder', 'entryPath', 'historicalArtifactDigest'], 'EVALUATION_BASELINE_FIELDS_INVALID');
  if (parsed.schemaVersion !== V172_BASELINE_RECONSTRUCTION_SCHEMA || parsed.candidateId !== 'forge-v1.7.2'
    || parsed.versionLabel !== 'v1.7.2' || parsed.executionSurface !== 'public_mcp' || parsed.entryPath !== 'bin/forge.mjs') {
    throw new Error('EVALUATION_BASELINE_IDENTITY_INVALID');
  }
  if (typeof parsed.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(parsed.sourceRevision)) throw new Error('EVALUATION_BASELINE_SOURCE_REVISION_INVALID');

  const publishedPackage = parsed.publishedPackage as Record<string, unknown>;
  exactKeys(publishedPackage, ['specifier', 'registry', 'tarballSha256', 'releaseManifestPath', 'releaseManifestSha256'], 'EVALUATION_BASELINE_PUBLISHED_PACKAGE_FIELDS_INVALID');
  if (publishedPackage.specifier !== '@moretea-labs/forge@1.7.2' || publishedPackage.registry !== 'https://registry.npmjs.org/'
    || typeof publishedPackage.releaseManifestPath !== 'string' || !publishedPackage.releaseManifestPath.trim()) {
    throw new Error('EVALUATION_BASELINE_PUBLISHED_PACKAGE_INVALID');
  }

  const dependencyLock = parsed.dependencyLock as Record<string, unknown>;
  exactKeys(dependencyLock, ['path', 'sha256', 'sourceRevision', 'sourcePath', 'sourceSha256', 'normalization'], 'EVALUATION_BASELINE_LOCK_FIELDS_INVALID');
  if (typeof dependencyLock.path !== 'string' || !dependencyLock.path.trim() || dependencyLock.sourceRevision !== parsed.sourceRevision
    || dependencyLock.sourcePath !== 'package-lock.json' || dependencyLock.normalization !== 'root_manifest_metadata_only') {
    throw new Error('EVALUATION_BASELINE_LOCK_INVALID');
  }

  const installer = parsed.installer as Record<string, unknown>;
  exactKeys(installer, ['executable', 'version', 'arguments'], 'EVALUATION_BASELINE_INSTALLER_FIELDS_INVALID');
  if (installer.executable !== 'npm' || typeof installer.version !== 'string' || !installer.version.trim()
    || !Array.isArray(installer.arguments) || installer.arguments.some((arg) => typeof arg !== 'string' || !arg.trim())) {
    throw new Error('EVALUATION_BASELINE_INSTALLER_INVALID');
  }

  const builder = parsed.builder as Record<string, unknown>;
  exactKeys(builder, ['entryPath', 'implementationFiles'], 'EVALUATION_BASELINE_BUILDER_FIELDS_INVALID');
  if (builder.entryPath !== 'evaluation/build-v172-baseline.ts' || !builder.implementationFiles || typeof builder.implementationFiles !== 'object' || Array.isArray(builder.implementationFiles)) {
    throw new Error('EVALUATION_BASELINE_BUILDER_INVALID');
  }
  const implementationFiles = builder.implementationFiles as Record<string, unknown>;
  const requiredBuilderFiles = ['evaluation/build-v172-baseline.ts', 'evaluation/lib/baseline.ts', 'evaluation/lib/candidate-artifact.ts'];
  if (Object.keys(implementationFiles).sort().join('\0') !== requiredBuilderFiles.sort().join('\0')) throw new Error('EVALUATION_BASELINE_BUILDER_FILES_INVALID');
  for (const path of requiredBuilderFiles) requireSha256(implementationFiles[path], 'BUILDER_FILE_SHA256');

  const authority = parsed as unknown as V172BaselineReconstructionAuthority;
  requireSha256(publishedPackage.tarballSha256, 'TARBALL_SHA256');
  requireSha256(publishedPackage.releaseManifestSha256, 'RELEASE_MANIFEST_SHA256');
  requireSha256(dependencyLock.sha256, 'LOCK_SHA256');
  requireSha256(dependencyLock.sourceSha256, 'SOURCE_LOCK_SHA256');
  requireSha256(parsed.historicalArtifactDigest, 'HISTORICAL_ARTIFACT_DIGEST');

  if (fileSha256(repoRoot, authority.publishedPackage.releaseManifestPath) !== authority.publishedPackage.releaseManifestSha256) {
    throw new Error('EVALUATION_BASELINE_RELEASE_MANIFEST_DRIFT');
  }
  if (fileSha256(repoRoot, authority.dependencyLock.path) !== authority.dependencyLock.sha256) throw new Error('EVALUATION_BASELINE_LOCK_DRIFT');
  for (const [path, digest] of Object.entries(authority.builder.implementationFiles)) {
    if (fileSha256(repoRoot, path) !== digest) throw new Error(`EVALUATION_BASELINE_BUILDER_DRIFT:${path}`);
  }

  const releaseManifest = JSON.parse(readFileSync(resolve(repoRoot, authority.publishedPackage.releaseManifestPath), 'utf8')) as Record<string, unknown>;
  const sourceManifestBytes = gitFile(repoRoot, authority.sourceRevision, 'package.json');
  if (sha256Bytes(sourceManifestBytes) !== authority.publishedPackage.releaseManifestSha256) throw new Error('EVALUATION_BASELINE_SOURCE_MANIFEST_DRIFT');
  const sourceLockBytes = gitFile(repoRoot, authority.dependencyLock.sourceRevision, authority.dependencyLock.sourcePath);
  if (sha256Bytes(sourceLockBytes) !== authority.dependencyLock.sourceSha256) throw new Error('EVALUATION_BASELINE_SOURCE_LOCK_DRIFT');
  const expectedNormalizedLock = normalizedReleaseLock(sourceLockBytes, releaseManifest);
  if (sha256Bytes(expectedNormalizedLock) !== authority.dependencyLock.sha256
    || expectedNormalizedLock !== readFileSync(resolve(repoRoot, authority.dependencyLock.path), 'utf8')) {
    throw new Error('EVALUATION_BASELINE_LOCK_NORMALIZATION_DRIFT');
  }

  const lock = JSON.parse(readFileSync(resolve(repoRoot, authority.dependencyLock.path), 'utf8')) as { packages?: Record<string, Record<string, unknown>> };
  const root = lock.packages?.[''];
  if (!root || root.name !== releaseManifest.name || root.version !== releaseManifest.version) throw new Error('EVALUATION_BASELINE_LOCK_ROOT_IDENTITY_DRIFT');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    if (JSON.stringify(root[key] ?? null) !== JSON.stringify(releaseManifest[key] ?? null)) throw new Error(`EVALUATION_BASELINE_LOCK_ROOT_${key.toUpperCase()}_DRIFT`);
  }
  return Object.freeze(authority);
}

export function v172BaselineReconstructionDigest(repoRoot = process.cwd()): string {
  readV172BaselineReconstructionAuthority(repoRoot);
  return fileSha256(repoRoot, V172_BASELINE_RECONSTRUCTION_PATH);
}
