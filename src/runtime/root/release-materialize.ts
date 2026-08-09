import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
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
  externalPluginProbeArtifactIdentity?: string;
  codeGraphNodeArtifactIdentity?: string;
  codeGraphSidecarArtifactIdentity?: string;
  codeGraphLibraryArtifactIdentity?: string;
  manifestSha256: string;
  sourceCommit: string;
}

export interface RuntimeReleaseMaterializerDependencies {
  now?: () => number;
  uuid?: () => string;
  compileBinary?: (input: { sourceRoot: string; outputPath: string; entryPath?: string }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
  bundleNodeHost?: (input: { sourceRoot: string; outputPath: string; entryPath: string }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
  bundleProcessRunner?: (input: { sourceRoot: string; outputPath: string; entryPath: string }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
  materializeCodeGraphRuntime?: (input: {
    sourceRoot: string;
    nodeOutputPath: string;
    sidecarOutputPath: string;
    libraryOutputPath: string;
  }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
}

function gitText(root: string, args: string[]): string {
  const result = runProcess('git', ['-C', root, ...args], { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
  if (!result.ok) throw new Error(`RUNTIME_RELEASE_GIT_FAILED: ${result.stderr || result.stdout || result.error}`.slice(0, 2_000));
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Directory(root: string): string {
  const hash = createHash('sha256');
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(name).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  visit(root);
  return hash.digest('hex');
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

function defaultMaterializeCodeGraphRuntime(input: {
  sourceRoot: string;
  nodeOutputPath: string;
  sidecarOutputPath: string;
  libraryOutputPath: string;
}): { ok: boolean; stderr?: string; stdout?: string; error?: string } {
  try {
    const sourceRequire = createRequire(join(input.sourceRoot, 'package.json'));
    const platformPackage = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
    const packageJson = sourceRequire.resolve(`${platformPackage}/package.json`);
    const packageRoot = dirname(packageJson);
    const nodeSource = join(packageRoot, process.platform === 'win32' ? 'node.exe' : 'node');
    const librarySource = join(packageRoot, 'lib');
    const sidecarSource = join(input.sourceRoot, 'src', 'runtime', 'context', 'codegraph-sidecar.cjs');
    if (!existsSync(nodeSource) || !statSync(nodeSource).isFile()) throw new Error(`${platformPackage} Node runtime is missing`);
    if (!existsSync(librarySource) || !statSync(librarySource).isDirectory()) throw new Error(`${platformPackage} library is missing`);
    if (!existsSync(sidecarSource)) throw new Error('CodeGraph sidecar source is missing');
    copyFileSync(nodeSource, input.nodeOutputPath);
    copyFileSync(sidecarSource, input.sidecarOutputPath);
    cpSync(librarySource, input.libraryOutputPath, { recursive: true, force: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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

    const externalPluginProbeEntrypoint = 'external-unix-socket-probe.cjs' as const;
    const sourceExternalPluginProbePath = join(sourceRoot, 'src', 'runtime', 'plugins', externalPluginProbeEntrypoint);
    if (!existsSync(sourceExternalPluginProbePath)) {
      throw new Error(`RUNTIME_RELEASE_EXTERNAL_PLUGIN_PROBE_SOURCE_MISSING: ${sourceExternalPluginProbePath}`);
    }
    const externalPluginProbePath = join(staging, externalPluginProbeEntrypoint);
    copyFileSync(sourceExternalPluginProbePath, externalPluginProbePath);
    chmodSync(externalPluginProbePath, 0o700);
    const externalPluginProbeArtifactIdentity = `sha256:${sha256(externalPluginProbePath)}`;

    const codeGraphNodeEntrypoint = 'codegraph-node' as const;
    const codeGraphSidecarEntrypoint = 'codegraph-sidecar.cjs' as const;
    const codeGraphLibraryRoot = 'codegraph-lib' as const;
    const codeGraphNodePath = join(staging, codeGraphNodeEntrypoint);
    const codeGraphSidecarPath = join(staging, codeGraphSidecarEntrypoint);
    const codeGraphLibraryPath = join(staging, codeGraphLibraryRoot);
    const codeGraphRuntime = (dependencies.materializeCodeGraphRuntime ?? defaultMaterializeCodeGraphRuntime)({
      sourceRoot,
      nodeOutputPath: codeGraphNodePath,
      sidecarOutputPath: codeGraphSidecarPath,
      libraryOutputPath: codeGraphLibraryPath,
    });
    if (!codeGraphRuntime.ok) {
      throw new Error(`RUNTIME_RELEASE_CODEGRAPH_BUILD_FAILED: ${codeGraphRuntime.stderr || codeGraphRuntime.stdout || codeGraphRuntime.error}`.slice(0, 2_000));
    }
    chmodSync(codeGraphNodePath, 0o700);
    chmodSync(codeGraphSidecarPath, 0o700);
    const codeGraphNodeArtifactIdentity = `sha256:${sha256(codeGraphNodePath)}`;
    const codeGraphSidecarArtifactIdentity = `sha256:${sha256(codeGraphSidecarPath)}`;
    const codeGraphLibraryArtifactIdentity = `sha256:${sha256Directory(codeGraphLibraryPath)}`;

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
      externalPluginProbeEntrypoint,
      externalPluginProbeArtifactIdentity,
      codeGraphNodeEntrypoint,
      codeGraphNodeArtifactIdentity,
      codeGraphSidecarEntrypoint,
      codeGraphSidecarArtifactIdentity,
      codeGraphLibraryRoot,
      codeGraphLibraryArtifactIdentity,
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
      externalPluginProbeArtifactIdentity,
      codeGraphNodeArtifactIdentity,
      codeGraphSidecarArtifactIdentity,
      codeGraphLibraryArtifactIdentity,
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
  if (release.externalPluginProbeArtifactIdentity && !existsSync(join(release.releasePath, 'external-unix-socket-probe.cjs'))) {
    throw new Error(`RUNTIME_RELEASE_EXTERNAL_PLUGIN_PROBE_MISSING: ${join(release.releasePath, 'external-unix-socket-probe.cjs')}`);
  }
  if (release.codeGraphNodeArtifactIdentity && !existsSync(join(release.releasePath, 'codegraph-node'))) {
    throw new Error(`RUNTIME_RELEASE_CODEGRAPH_NODE_MISSING: ${join(release.releasePath, 'codegraph-node')}`);
  }
  if (release.codeGraphSidecarArtifactIdentity && !existsSync(join(release.releasePath, 'codegraph-sidecar.cjs'))) {
    throw new Error(`RUNTIME_RELEASE_CODEGRAPH_SIDECAR_MISSING: ${join(release.releasePath, 'codegraph-sidecar.cjs')}`);
  }
  if (release.codeGraphLibraryArtifactIdentity && !existsSync(join(release.releasePath, 'codegraph-lib', 'dist', 'index.js'))) {
    throw new Error(`RUNTIME_RELEASE_CODEGRAPH_LIBRARY_MISSING: ${join(release.releasePath, 'codegraph-lib', 'dist', 'index.js')}`);
  }
}
