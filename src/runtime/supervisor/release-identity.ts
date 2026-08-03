import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import type { RuntimeSourceIdentity } from '../control-plane/runtime-generation';
import { repositoryIdentity } from '../../cli/controller/runtime-config';
import { stableCheckoutId } from '../../cli/repositories/identity';

/**
 * Captured immutable release identity for Supervisor-managed children.
 * See docs/architecture/decisions/20260803-release-identity-binding-and-exit-policy.md
 */
export interface ReleaseIdentityBinding {
  releasePath: string;
  releaseRevision: string;
  sourceCommit: string;
  manifestHash?: string;
}

export const RELEASE_IDENTITY_ENV = {
  releasePath: 'REPO_HARNESS_RELEASE_PATH',
  releaseRevision: 'REPO_HARNESS_RELEASE_REVISION',
  sourceCommit: 'REPO_HARNESS_RELEASE_SOURCE_COMMIT',
  manifestHash: 'REPO_HARNESS_RELEASE_MANIFEST_HASH',
} as const;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Read a complete binding from process environment (Supervisor spawn injection).
 * Partial env is ignored so ambient/partial state cannot invent a half-identity.
 */
export function readReleaseIdentityBindingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReleaseIdentityBinding | undefined {
  const releasePath = nonEmpty(env[RELEASE_IDENTITY_ENV.releasePath]);
  const releaseRevision = nonEmpty(env[RELEASE_IDENTITY_ENV.releaseRevision]);
  const sourceCommit = nonEmpty(env[RELEASE_IDENTITY_ENV.sourceCommit]);
  const manifestHash = nonEmpty(env[RELEASE_IDENTITY_ENV.manifestHash]);
  if (!releasePath || !releaseRevision || !sourceCommit) return undefined;
  const binding: ReleaseIdentityBinding = {
    releasePath: normalizePath(releasePath),
    releaseRevision,
    sourceCommit,
    ...(manifestHash ? { manifestHash } : {}),
  };
  const manifest = readReleaseIdentityBindingFromManifest(binding.releasePath);
  if (manifest && (
    manifest.releaseRevision !== binding.releaseRevision
    || manifest.sourceCommit !== binding.sourceCommit
    || (binding.manifestHash !== undefined && manifest.manifestHash !== binding.manifestHash)
  )) {
    throw new Error(
      `RELEASE_IDENTITY_ENV_MANIFEST_MISMATCH: injected=${binding.releaseRevision}/${binding.sourceCommit} `
      + `manifest=${manifest.releaseRevision}/${manifest.sourceCommit}`,
    );
  }
  return binding;
}

/** Environment fragment injected into managed Daemon / Gateway children. */
export function releaseIdentityBindingEnvironment(
  binding: ReleaseIdentityBinding,
): Record<string, string> {
  return {
    [RELEASE_IDENTITY_ENV.releasePath]: normalizePath(binding.releasePath),
    [RELEASE_IDENTITY_ENV.releaseRevision]: binding.releaseRevision,
    [RELEASE_IDENTITY_ENV.sourceCommit]: binding.sourceCommit,
    ...(binding.manifestHash
      ? { [RELEASE_IDENTITY_ENV.manifestHash]: binding.manifestHash }
      : {}),
  };
}

/**
 * Read binding from an immutable release directory's manifest.json.
 * Incomplete or missing manifests return undefined (caller may fail closed).
 */
export function readReleaseIdentityBindingFromManifest(
  releasePath: string,
): ReleaseIdentityBinding | undefined {
  const root = normalizePath(releasePath);
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const sourceCommit = typeof manifest.sourceCommit === 'string' ? manifest.sourceCommit.trim() : '';
  const releaseRevision = typeof manifest.releaseRevision === 'string' ? manifest.releaseRevision.trim() : '';
  if (!sourceCommit || !releaseRevision) return undefined;
  let manifestHash: string | undefined;
  try {
    manifestHash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  } catch {
    manifestHash = undefined;
  }
  return {
    releasePath: root,
    releaseRevision,
    sourceCommit,
    ...(manifestHash ? { manifestHash } : {}),
  };
}

/**
 * Resolve the binding Supervisor should inject for managed children.
 * A complete immutable manifest is authoritative. Manifest-less compatibility
 * requires an explicit path, revision, and source commit; revision is never
 * silently promoted into a source commit.
 */
export function resolveSupervisorReleaseIdentityBinding(input: {
  releasePath?: string;
  releaseRevision?: string;
  sourceCommit?: string;
  manifestHash?: string;
}): ReleaseIdentityBinding | undefined {
  if (input.releasePath) {
    const fromManifest = readReleaseIdentityBindingFromManifest(input.releasePath);
    if (fromManifest) {
      const releaseRevision = nonEmpty(input.releaseRevision);
      const sourceCommit = nonEmpty(input.sourceCommit);
      const manifestHash = nonEmpty(input.manifestHash);
      if (
        (releaseRevision !== undefined && releaseRevision !== fromManifest.releaseRevision)
        || (sourceCommit !== undefined && sourceCommit !== fromManifest.sourceCommit)
        || (manifestHash !== undefined && manifestHash !== fromManifest.manifestHash)
      ) {
        throw new Error(
          `SUPERVISOR_RELEASE_IDENTITY_MISMATCH: manifest=${fromManifest.releaseRevision}/${fromManifest.sourceCommit} `
          + `requested=${releaseRevision ?? 'unspecified'}/${sourceCommit ?? 'unspecified'}`,
        );
      }
      return fromManifest;
    }
  }
  const releaseRevision = nonEmpty(input.releaseRevision);
  const sourceCommit = nonEmpty(input.sourceCommit);
  const releasePath = nonEmpty(input.releasePath);
  if (!releaseRevision || !sourceCommit || !releasePath) return undefined;
  return {
    releasePath: normalizePath(releasePath),
    releaseRevision,
    sourceCommit,
    ...(nonEmpty(input.manifestHash) ? { manifestHash: nonEmpty(input.manifestHash) } : {}),
  };
}

/**
 * Build a RuntimeSourceIdentity projection from a captured binding.
 * Does not consult ambient Git.
 */
export function runtimeSourceIdentityFromBinding(
  binding: ReleaseIdentityBinding,
  options: { observedAt?: string } = {},
): RuntimeSourceIdentity {
  // A captured binding owns both revision and execution root. Projecting the
  // caller's ambient runtimeRoot here would recreate a split identity where a
  // candidate binary reports the previous release directory as its source.
  const repoRoot = binding.releasePath;
  // Prefer realpath when the release exists; identity projection must still
  // work for pure in-memory / test bindings without a live directory.
  const canonicalRoot = existsSync(repoRoot) ? normalizePath(repoRoot) : resolve(repoRoot);
  let repoId: string;
  try {
    repoId = `repo_${repositoryIdentity(canonicalRoot)}`;
  } catch {
    repoId = `repo_${createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)}`;
  }
  let checkoutId: string;
  try {
    checkoutId = stableCheckoutId(repoId, canonicalRoot);
  } catch {
    checkoutId = `checkout_${createHash('sha256').update(`${repoId}:${canonicalRoot}`).digest('hex').slice(0, 24)}`;
  }
  return {
    repoId,
    checkoutId,
    repoRoot,
    canonicalRoot,
    branch: null,
    commit: binding.sourceCommit,
    releaseRevision: binding.releaseRevision,
    defaultBranch: 'main',
    defaultBranchCommit: binding.sourceCommit,
    dirty: false,
    observedAt: options.observedAt ?? new Date().toISOString(),
  };
}

/**
 * Prefer injected binding, then immutable release manifest at root, else undefined
 * so callers can fall through to own-git identity collection.
 */
export function resolveManagedRuntimeSourceIdentity(options: {
  runtimeRoot: string;
  env?: NodeJS.ProcessEnv;
}): RuntimeSourceIdentity | undefined {
  const env = options.env ?? process.env;
  const fromEnv = readReleaseIdentityBindingFromEnv(env);
  if (fromEnv) {
    return runtimeSourceIdentityFromBinding(fromEnv);
  }
  // Supervisor children must never walk ambient parent Git when a release
  // manifest is present at the configured runtime root.
  if (env.REPO_HARNESS_SUPERVISOR_CHILD?.trim() === '1') {
    const fromManifest = readReleaseIdentityBindingFromManifest(options.runtimeRoot);
    if (fromManifest) {
      return runtimeSourceIdentityFromBinding(fromManifest);
    }
  }
  return undefined;
}
