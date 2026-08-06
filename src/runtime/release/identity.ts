import { existsSync, readFileSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { repositoryIdentity } from '../../cli/controller/runtime-config';
import { stableCheckoutId } from '../../cli/repositories/identity';

export interface ReleaseIdentityBinding {
  releasePath: string;
  releaseId?: string;
  releaseRevision?: string;
  sourceCommit?: string;
  cleanWorkspace: boolean;
}

interface ReleaseManifestIdentity {
  releaseId?: string;
  releaseRevision?: string;
  sourceCommit?: string;
  cleanWorkspace?: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readManifest(releasePath: string): ReleaseManifestIdentity | undefined {
  const path = resolve(releasePath, 'manifest.json');
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      releaseId: text(manifest.releaseId),
      releaseRevision: text(manifest.releaseRevision),
      sourceCommit: text(manifest.sourceCommit),
      cleanWorkspace: typeof manifest.cleanWorkspace === 'boolean' ? manifest.cleanWorkspace : undefined,
    };
  } catch {
    throw new Error(`RUNTIME_RELEASE_MANIFEST_INVALID: ${path}`);
  }
}

export function readReleaseIdentityBindingFromEnv(env: NodeJS.ProcessEnv = process.env): ReleaseIdentityBinding | undefined {
  const configuredPath = env.FORGE_RELEASE_PATH?.trim();
  if (!configuredPath) return undefined;
  const releasePath = existsSync(configuredPath) ? realpathSync(configuredPath) : resolve(configuredPath);
  const manifest = readManifest(releasePath);
  return {
    releasePath,
    releaseId: env.FORGE_RELEASE_ID?.trim() || manifest?.releaseId,
    releaseRevision: env.FORGE_RELEASE_REVISION?.trim() || manifest?.releaseRevision || env.FORGE_RELEASE_ID?.trim(),
    sourceCommit: env.FORGE_RELEASE_SOURCE_COMMIT?.trim() || manifest?.sourceCommit,
    cleanWorkspace: env.FORGE_RELEASE_CLEAN_WORKSPACE
      ? env.FORGE_RELEASE_CLEAN_WORKSPACE !== 'false'
      : manifest?.cleanWorkspace !== false,
  };
}

export function resolveManagedRuntimeSourceIdentity(options: {
  runtimeRoot: string;
  env?: NodeJS.ProcessEnv;
}): {
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  canonicalRoot: string;
  branch: null;
  commit?: string;
  releaseRevision?: string;
  defaultBranch: string;
  defaultBranchCommit?: string;
  dirty: boolean;
  observedAt: string;
} | undefined {
  const binding = readReleaseIdentityBindingFromEnv(options.env ?? process.env);
  if (!binding) return undefined;
  const canonicalRoot = binding.releasePath;
  const repoId = `repo_${repositoryIdentity(canonicalRoot)}`;
  return {
    repoId,
    checkoutId: stableCheckoutId(repoId, canonicalRoot),
    repoRoot: canonicalRoot,
    canonicalRoot,
    branch: null,
    commit: binding.sourceCommit,
    releaseRevision: binding.releaseRevision,
    defaultBranch: 'main',
    defaultBranchCommit: binding.sourceCommit,
    dirty: !binding.cleanWorkspace,
    observedAt: new Date().toISOString(),
  };
}
