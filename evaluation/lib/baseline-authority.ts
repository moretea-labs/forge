import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v172BaselineReconstructionDigest } from './baseline.ts';

export const V172_BASELINE_AUTHORITY_SCHEMA = 'forge-evaluation-baseline-authority/v1' as const;
export const V172_BASELINE_AUTHORITY_PATH = 'evaluation/baselines/v1.7.2/authority.json' as const;

export interface V172BaselineAuthority {
  schemaVersion: typeof V172_BASELINE_AUTHORITY_SCHEMA;
  reconstructionDigest: string;
  artifactDigest: string;
  productionDependencies: {
    packageEntryCount: number;
    uniqueBlobCount: number;
    digest: string;
  };
  reproducibilityProof: {
    method: 'independent_offline_builds';
    buildCount: 2;
    receiptDigest: string;
    buildProcessIds: readonly [string, string];
    artifactDigests: readonly [string, string];
  };
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value)) throw new Error(`EVALUATION_BASELINE_AUTHORITY_${field}_INVALID`);
  return value.toLowerCase();
}

function productionDependencyIdentity(repoRoot: string): { packageEntryCount: number; uniqueBlobCount: number; digest: string } {
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'evaluation/baselines/v1.7.2/package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: unknown; integrity?: unknown; dev?: unknown; optional?: unknown }>;
  };
  const entries = Object.entries(lock.packages ?? {})
    .filter(([path, value]) => path.startsWith('node_modules/') && value.dev !== true && value.optional !== true
      && typeof value.version === 'string' && typeof value.integrity === 'string')
    .map(([path, value]) => ({ path, version: value.version as string, integrity: value.integrity as string }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    packageEntryCount: entries.length,
    uniqueBlobCount: new Set(entries.map((entry) => entry.integrity)).size,
    digest: sha256(JSON.stringify(entries)),
  };
}

export function readV172BaselineAuthority(repoRoot = process.cwd()): V172BaselineAuthority {
  const raw = readFileSync(resolve(repoRoot, V172_BASELINE_AUTHORITY_PATH), 'utf8');
  const parsed = JSON.parse(raw) as V172BaselineAuthority;
  if (parsed.schemaVersion !== V172_BASELINE_AUTHORITY_SCHEMA) throw new Error('EVALUATION_BASELINE_AUTHORITY_SCHEMA_MISMATCH');
  requireDigest(parsed.reconstructionDigest, 'RECONSTRUCTION_DIGEST');
  requireDigest(parsed.artifactDigest, 'ARTIFACT_DIGEST');
  requireDigest(parsed.productionDependencies?.digest, 'PRODUCTION_DEPENDENCY_DIGEST');
  requireDigest(parsed.reproducibilityProof?.receiptDigest, 'PROOF_RECEIPT_DIGEST');
  if (parsed.reconstructionDigest !== v172BaselineReconstructionDigest(repoRoot)) throw new Error('EVALUATION_BASELINE_AUTHORITY_RECONSTRUCTION_DRIFT');
  const observedDependencies = productionDependencyIdentity(repoRoot);
  if (JSON.stringify(parsed.productionDependencies) !== JSON.stringify(observedDependencies)) throw new Error('EVALUATION_BASELINE_AUTHORITY_DEPENDENCY_DRIFT');
  const proof = parsed.reproducibilityProof;
  if (proof.method !== 'independent_offline_builds' || proof.buildCount !== 2 || proof.buildProcessIds.length !== 2
    || proof.artifactDigests.length !== 2 || proof.artifactDigests.some((digest) => digest !== parsed.artifactDigest)) {
    throw new Error('EVALUATION_BASELINE_AUTHORITY_REPRODUCIBILITY_PROOF_INVALID');
  }
  return Object.freeze(parsed);
}

export function v172BaselineAuthorityDigest(repoRoot = process.cwd()): string {
  readV172BaselineAuthority(repoRoot);
  return sha256(readFileSync(resolve(repoRoot, V172_BASELINE_AUTHORITY_PATH)));
}
