import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';

export const RUNTIME_BUNDLE_ENTRYPOINT = 'forge-runtime-bundle.js' as const;

interface RuntimeBundleManifestRecord {
  runtimeBundleEntrypoint?: unknown;
  runtimeBundleArtifactIdentity?: unknown;
}

function releaseManifestPath(argv: readonly string[]): string {
  const index = argv.indexOf('--release-manifest');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value?.trim()) throw new Error('RUNTIME_RELEASE_MANIFEST_ARGUMENT_REQUIRED');
  return resolve(value);
}

export function resolveCompiledRuntimeBundle(argv: readonly string[] = process.argv): {
  manifestPath: string;
  bundlePath: string;
  artifactIdentity: string;
} {
  const manifestPath = releaseManifestPath(argv);
  let manifest: RuntimeBundleManifestRecord;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeBundleManifestRecord;
  } catch (error) {
    throw new Error(`RUNTIME_RELEASE_LOADER_MANIFEST_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.runtimeBundleEntrypoint !== RUNTIME_BUNDLE_ENTRYPOINT) {
    throw new Error(`RUNTIME_RELEASE_BUNDLE_ENTRYPOINT_INVALID: expected ${RUNTIME_BUNDLE_ENTRYPOINT}`);
  }
  const artifactIdentity = typeof manifest.runtimeBundleArtifactIdentity === 'string'
    ? manifest.runtimeBundleArtifactIdentity.trim().toLowerCase()
    : '';
  if (!/^sha256:[a-f0-9]{64}$/.test(artifactIdentity)) {
    throw new Error('RUNTIME_RELEASE_BUNDLE_IDENTITY_INVALID');
  }
  const bundlePath = join(dirname(manifestPath), RUNTIME_BUNDLE_ENTRYPOINT);
  let actualIdentity: string;
  try {
    actualIdentity = `sha256:${createHash('sha256').update(readFileSync(bundlePath)).digest('hex')}`;
  } catch (error) {
    throw new Error(`RUNTIME_RELEASE_BUNDLE_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actualIdentity !== artifactIdentity) {
    throw new Error('RUNTIME_RELEASE_BUNDLE_ARTIFACT_IDENTITY_MISMATCH');
  }
  return { manifestPath, bundlePath, artifactIdentity };
}

export async function runCompiledRuntimeLoader(argv: string[] = process.argv): Promise<void> {
  const bundle = resolveCompiledRuntimeBundle(argv);
  const loaded = await import(pathToFileURL(bundle.bundlePath).href) as { runCanonicalRuntimeCli?: (argv?: string[]) => Promise<void> };
  if (typeof loaded.runCanonicalRuntimeCli !== 'function') {
    throw new Error('RUNTIME_RELEASE_BUNDLE_ENTRY_EXPORT_MISSING');
  }
  await loaded.runCanonicalRuntimeCli(argv);
}

if (import.meta.main) {
  runCompiledRuntimeLoader().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
