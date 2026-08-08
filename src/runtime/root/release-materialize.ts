import { createHash, randomUUID } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';
import { resolveBunExecutable } from '../shared/process-environment';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../control-plane/persistence/sqlite-store';

/**
 * Stage one immutable Forge Runtime release below Controller Home. The staged
 * release contains the compiled `forge-runtime` entrypoint, a same-commit
 * `forge-cli` diagnostic sidecar, plus a manifest that satisfies
 * `loadRuntimeReleaseManifest`. Activation is the explicit
 * `forge runtime service install` operation; staging alone never starts or
 * publishes anything.
 */
export interface StagedRuntimeRelease {
  releasePath: string;
  manifestPath: string;
  releaseId: string;
  artifactIdentity: string;
  diagnosticArtifactIdentity?: string;
  browserNodeBridgeArtifactIdentity?: string;
  desktopHelperArtifactIdentity?: string;
  processRunnerArtifactIdentity?: string;
  checkRunnerArtifactIdentity?: string;
  manifestSha256: string;
  sourceCommit: string;
}

export interface RuntimeReleaseMaterializerDependencies {
  now?: () => number;
  uuid?: () => string;
  compileBinary?: (input: { sourceRoot: string; outputPath: string; entryPath?: string }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
  bundleNodeHost?: (input: { sourceRoot: string; outputPath: string; entryPath: string }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
  bundleProcessRunner?: (input: { sourceRoot: string; outputPath: string; entryPath: string }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
}

function gitText(root: string, args: string[]): string {
  const result = runProcess('git', ['-C', root, ...args], { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
  if (!result.ok) throw new Error(`RUNTIME_RELEASE_GIT_FAILED: ${result.stderr || result.stdout || result.error}`.slice(0, 2_000));
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function defaultCompileBinary(input: { sourceRoot: string; outputPath: string; entryPath?: string }): { ok: boolean; stderr?: string; stdout?: string; error?: string } {
  const configured = process.env.FORGE_BUN_BIN?.trim();
  const bun = configured || resolveBunExecutable(process.execPath, process.env);
  return runProcess(bun, [
    'build',
    input.entryPath ?? join(input.sourceRoot, 'src/runtime/root/entry.ts'),
    '--compile',
    '--outfile',
    input.outputPath,
  ], { cwd: input.sourceRoot, timeoutMs: 300_000, maxOutputBytes: 512 * 1024 });
}

function defaultBundleNodeScript(input: { sourceRoot: string; outputPath: string; entryPath: string }): { ok: boolean; stderr?: string; stdout?: string; error?: string } {
  const configured = process.env.FORGE_BUN_BIN?.trim();
  const bun = configured || resolveBunExecutable(process.execPath, process.env);
  return runProcess(bun, [
    'build',
    input.entryPath,
    '--target=node',
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
    const compileBinary = dependencies.compileBinary ?? defaultCompileBinary;
    const executable = join(staging, 'forge-runtime');
    const compile = compileBinary({
      sourceRoot,
      outputPath: executable,
      entryPath: join(sourceRoot, 'src/runtime/root/entry.ts'),
    });
    if (!compile.ok) {
      throw new Error(`RUNTIME_RELEASE_BUILD_FAILED: ${compile.stderr || compile.stdout || compile.error}`.slice(0, 2_000));
    }
    chmodSync(executable, 0o700);
    const artifactIdentity = `sha256:${sha256(executable)}`;

    const diagnosticExecutable = join(staging, 'forge-cli');
    const diagnosticCompile = compileBinary({
      sourceRoot,
      outputPath: diagnosticExecutable,
      entryPath: join(sourceRoot, 'src/cli/diagnostic-entry.ts'),
    });
    if (!diagnosticCompile.ok) {
      throw new Error(`RUNTIME_RELEASE_DIAGNOSTIC_BUILD_FAILED: ${diagnosticCompile.stderr || diagnosticCompile.stdout || diagnosticCompile.error}`.slice(0, 2_000));
    }
    chmodSync(diagnosticExecutable, 0o700);
    const diagnosticArtifactIdentity = `sha256:${sha256(diagnosticExecutable)}`;

    const browserNodeBridgeEntrypoint = 'browser-node-bridge-host.js' as const;
    const browserNodeBridgePath = join(staging, browserNodeBridgeEntrypoint);
    const bundleNodeHost = dependencies.bundleNodeHost ?? defaultBundleNodeScript;
    const browserHostBundle = bundleNodeHost({
      sourceRoot,
      outputPath: browserNodeBridgePath,
      entryPath: join(sourceRoot, 'src/runtime/plugins/browser-node-bridge-host.ts'),
    });
    if (!browserHostBundle.ok) {
      throw new Error(`RUNTIME_RELEASE_BROWSER_NODE_HOST_BUILD_FAILED: ${browserHostBundle.stderr || browserHostBundle.stdout || browserHostBundle.error}`.slice(0, 2_000));
    }
    chmodSync(browserNodeBridgePath, 0o700);
    const browserNodeBridgeArtifactIdentity = `sha256:${sha256(browserNodeBridgePath)}`;

    const processRunnerEntrypoint = 'process-runner.js' as const;
    const processRunnerPath = join(staging, processRunnerEntrypoint);
    const bundleProcessRunner = dependencies.bundleProcessRunner ?? defaultBundleNodeScript;
    const processRunnerBundle = bundleProcessRunner({
      sourceRoot,
      outputPath: processRunnerPath,
      entryPath: join(sourceRoot, 'src/runtime/execution/process-runtime/process-runner-entry.ts'),
    });
    if (!processRunnerBundle.ok) {
      throw new Error(`RUNTIME_RELEASE_PROCESS_RUNNER_BUILD_FAILED: ${processRunnerBundle.stderr || processRunnerBundle.stdout || processRunnerBundle.error}`.slice(0, 2_000));
    }
    chmodSync(processRunnerPath, 0o700);
    const processRunnerArtifactIdentity = `sha256:${sha256(processRunnerPath)}`;

    const checkRunnerEntrypoint = 'forge-check-runner' as const;
    const checkRunnerPath = join(staging, checkRunnerEntrypoint);
    const checkRunnerCompile = compileBinary({
      sourceRoot,
      outputPath: checkRunnerPath,
      entryPath: join(sourceRoot, 'src/runtime/execution/process-runtime/check-runner-sidecar.ts'),
    });
    if (!checkRunnerCompile.ok) {
      throw new Error(`RUNTIME_RELEASE_CHECK_RUNNER_BUILD_FAILED: ${checkRunnerCompile.stderr || checkRunnerCompile.stdout || checkRunnerCompile.error}`.slice(0, 2_000));
    }
    chmodSync(checkRunnerPath, 0o700);
    const checkRunnerArtifactIdentity = `sha256:${sha256(checkRunnerPath)}`;

    const desktopHelperEntrypoint = 'forge-desktop-helper.mjs' as const;
    const sourceDesktopHelperPath = join(sourceRoot, 'bin', desktopHelperEntrypoint);
    if (!existsSync(sourceDesktopHelperPath)) {
      throw new Error(`RUNTIME_RELEASE_DESKTOP_HELPER_SOURCE_MISSING: ${sourceDesktopHelperPath}`);
    }
    const desktopHelperPath = join(staging, desktopHelperEntrypoint);
    copyFileSync(sourceDesktopHelperPath, desktopHelperPath);
    chmodSync(desktopHelperPath, 0o700);
    const desktopHelperArtifactIdentity = `sha256:${sha256(desktopHelperPath)}`;
    const manifest = {
      schemaVersion: 1,
      releaseId,
      artifactIdentity,
      entrypoint: 'forge-runtime',
      diagnosticEntrypoint: 'forge-cli',
      diagnosticArtifactIdentity,
      browserNodeBridgeEntrypoint,
      browserNodeBridgeArtifactIdentity,
      desktopHelperEntrypoint,
      desktopHelperArtifactIdentity,
      processRunnerEntrypoint,
      processRunnerArtifactIdentity,
      checkRunnerEntrypoint,
      checkRunnerArtifactIdentity,
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
      diagnosticArtifactIdentity,
      browserNodeBridgeArtifactIdentity,
      desktopHelperArtifactIdentity,
      processRunnerArtifactIdentity,
      checkRunnerArtifactIdentity,
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
  if (release.diagnosticArtifactIdentity && !existsSync(join(release.releasePath, 'forge-cli'))) {
    throw new Error(`RUNTIME_RELEASE_DIAGNOSTIC_ENTRYPOINT_MISSING: ${join(release.releasePath, 'forge-cli')}`);
  }
  if (release.browserNodeBridgeArtifactIdentity && !existsSync(join(release.releasePath, 'browser-node-bridge-host.js'))) {
    throw new Error(`RUNTIME_RELEASE_BROWSER_NODE_HOST_MISSING: ${join(release.releasePath, 'browser-node-bridge-host.js')}`);
  }
  if (release.desktopHelperArtifactIdentity && !existsSync(join(release.releasePath, 'forge-desktop-helper.mjs'))) {
    throw new Error(`RUNTIME_RELEASE_DESKTOP_HELPER_MISSING: ${join(release.releasePath, 'forge-desktop-helper.mjs')}`);
  }
  if (release.processRunnerArtifactIdentity && !existsSync(join(release.releasePath, 'process-runner.js'))) {
    throw new Error(`RUNTIME_RELEASE_PROCESS_RUNNER_MISSING: ${join(release.releasePath, 'process-runner.js')}`);
  }
  if (release.checkRunnerArtifactIdentity && !existsSync(join(release.releasePath, 'forge-check-runner'))) {
    throw new Error(`RUNTIME_RELEASE_CHECK_RUNNER_MISSING: ${join(release.releasePath, 'forge-check-runner')}`);
  }
}
