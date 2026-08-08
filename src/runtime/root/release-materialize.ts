import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';
import { resolveBunExecutable } from '../shared/process-environment';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../control-plane/persistence/sqlite-store';

/**
 * Stage one immutable Forge Runtime release below Controller Home. The staged
 * release contains the compiled `forge-runtime` entrypoint plus a manifest that
 * satisfies `loadRuntimeReleaseManifest`. Activation is the explicit
 * `forge runtime service install` operation; staging alone never starts or
 * publishes anything.
 */
export interface StagedRuntimeRelease {
  releasePath: string;
  manifestPath: string;
  releaseId: string;
  artifactIdentity: string;
  manifestSha256: string;
  sourceCommit: string;
}

export interface RuntimeReleaseMaterializerDependencies {
  now?: () => number;
  uuid?: () => string;
  compileBinary?: (input: { sourceRoot: string; outputPath: string }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
}

function gitText(root: string, args: string[]): string {
  const result = runProcess('git', ['-C', root, ...args], { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
  if (!result.ok) throw new Error(`RUNTIME_RELEASE_GIT_FAILED: ${result.stderr || result.stdout || result.error}`.slice(0, 2_000));
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function defaultCompileBinary(input: { sourceRoot: string; outputPath: string }): { ok: boolean; stderr?: string; stdout?: string; error?: string } {
  const configured = process.env.FORGE_BUN_BIN?.trim();
  const bun = configured || resolveBunExecutable(process.execPath, process.env);
  return runProcess(bun, [
    'build',
    join(input.sourceRoot, 'src/runtime/root/entry.ts'),
    '--compile',
    '--outfile',
    input.outputPath,
  ], { cwd: input.sourceRoot, timeoutMs: 300_000, maxOutputBytes: 512 * 1024 });
}

export function stageRuntimeRelease(input: {
  controllerHome: string;
  sourceRoot: string;
}, dependencies: RuntimeReleaseMaterializerDependencies = {}): StagedRuntimeRelease {
  const sourceRoot = resolve(input.sourceRoot);
  const sourceCommit = gitText(sourceRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error('RUNTIME_RELEASE_SOURCE_COMMIT_INVALID');
  // Immutable release source is the tracked working tree. Untracked files are
  // not part of the release and must never block activation (for example
  // local-only helper apps or .command launchers).
  const dirty = gitText(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (dirty) throw new Error(`RUNTIME_RELEASE_DIRTY_SOURCE: ${dirty.split(/\r?\n/).slice(0, 20).join(', ')}`);

  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const releasesRoot = join(resolve(input.controllerHome), 'runtime', 'releases');
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  const staging = join(releasesRoot, `.staging-${sourceCommit}-${uuid().slice(0, 12)}`);
  const releaseId = `${now()}-${sourceCommit}`;
  const releasePath = join(releasesRoot, releaseId);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const executable = join(staging, 'forge-runtime');
    const compile = (dependencies.compileBinary ?? defaultCompileBinary)({ sourceRoot, outputPath: executable });
    if (!compile.ok) {
      throw new Error(`RUNTIME_RELEASE_BUILD_FAILED: ${compile.stderr || compile.stdout || compile.error}`.slice(0, 2_000));
    }
    chmodSync(executable, 0o700);
    const artifactIdentity = `sha256:${sha256(executable)}`;
    const manifest = {
      schemaVersion: 1,
      releaseId,
      artifactIdentity,
      entrypoint: 'forge-runtime',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome: resolve(input.controllerHome),
      databaseSchemaCompatibility: {
        minimum: CONTROL_PLANE_SCHEMA_VERSION,
        maximum: CONTROL_PLANE_SCHEMA_VERSION,
      },
      workerProtocolVersion: 1,
      sourceCommit,
      releaseRevision: releaseId,
      cleanWorkspace: true,
      createdAt: new Date(now()).toISOString(),
    };
    const manifestPath = join(staging, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, releasePath);
    return {
      releasePath,
      manifestPath: join(releasePath, 'manifest.json'),
      releaseId,
      artifactIdentity,
      manifestSha256: createHash('sha256').update(`${JSON.stringify(manifest, null, 2)}\n`).digest('hex'),
      sourceCommit,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function assertRuntimeReleaseFiles(release: StagedRuntimeRelease): void {
  if (!existsSync(release.releasePath) || !existsSync(release.manifestPath)) {
    throw new Error(`RUNTIME_RELEASE_FILES_MISSING: ${release.releasePath}`);
  }
  if (!existsSync(join(release.releasePath, 'forge-runtime'))) {
    throw new Error(`RUNTIME_RELEASE_ENTRYPOINT_MISSING: ${join(release.releasePath, 'forge-runtime')}`);
  }
}
