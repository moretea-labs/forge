import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
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
  browserHandoffArtifactIdentity?: string;
  processRunnerArtifactIdentity?: string;
  checkRunnerArtifactIdentity?: string;
  externalPluginProbeArtifactIdentity?: string;
  codeGraphNodeArtifactIdentity?: string;
  codeGraphSidecarArtifactIdentity?: string;
  codeGraphLibraryArtifactIdentity?: string;
  controllerUiArtifactIdentity?: string;
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

export interface CandidateRuntimeStageReceiptV1 {
  schemaVersion: 1;
  releasePath: string;
  manifestPath: string;
  releaseId: string;
  artifactIdentity: string;
  manifestSha256: string;
  sourceCommit: string;
}

export interface CandidateRuntimeReleaseStagerDependencies {
  runCandidateStager?: (input: {
    bunExecutable: string;
    scriptPath: string;
    sourceRoot: string;
    controllerHome: string;
    expectedHead: string;
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

function requireCandidateStageString(value: unknown, field: keyof CandidateRuntimeStageReceiptV1): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`RUNTIME_RELEASE_CANDIDATE_RECEIPT_INVALID: ${field} is required`);
  return value.trim();
}

function parseCandidateStageReceipt(stdout: string): CandidateRuntimeStageReceiptV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`RUNTIME_RELEASE_CANDIDATE_RECEIPT_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_RECEIPT_INVALID: root must be an object');
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('RUNTIME_RELEASE_CANDIDATE_RECEIPT_INVALID: schemaVersion must be 1');
  const receipt: CandidateRuntimeStageReceiptV1 = {
    schemaVersion: 1,
    releasePath: requireCandidateStageString(value.releasePath, 'releasePath'),
    manifestPath: requireCandidateStageString(value.manifestPath, 'manifestPath'),
    releaseId: requireCandidateStageString(value.releaseId, 'releaseId'),
    artifactIdentity: requireCandidateStageString(value.artifactIdentity, 'artifactIdentity'),
    manifestSha256: requireCandidateStageString(value.manifestSha256, 'manifestSha256'),
    sourceCommit: requireCandidateStageString(value.sourceCommit, 'sourceCommit'),
  };
  if (!/^sha256:[a-f0-9]{64}$/i.test(receipt.artifactIdentity)) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_RECEIPT_INVALID: artifactIdentity must be sha256:<64 hex>');
  }
  if (!/^[a-f0-9]{64}$/i.test(receipt.manifestSha256)) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_RECEIPT_INVALID: manifestSha256 must be 64 hex');
  }
  if (!/^[a-f0-9]{40}$/i.test(receipt.sourceCommit)) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_RECEIPT_INVALID: sourceCommit must be a Git commit');
  }
  return receipt;
}

/**
 * Run the release materializer from the candidate source tree itself. The
 * long-lived caller deliberately consumes only a stable, minimal receipt; it
 * does not need to understand sidecars or optional manifest fields introduced
 * by a newer candidate. This prevents release packaging from lagging one
 * Runtime generation behind the source being activated.
 */
export function stageRuntimeReleaseFromCandidateSource(input: {
  controllerHome: string;
  sourceRoot: string;
}, dependencies: CandidateRuntimeReleaseStagerDependencies = {}): StagedRuntimeRelease {
  const controllerHome = resolve(input.controllerHome);
  const sourceRoot = resolve(input.sourceRoot);
  const expectedHead = gitText(sourceRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40}$/i.test(expectedHead)) throw new Error('RUNTIME_RELEASE_SOURCE_COMMIT_INVALID');
  const dirtyBefore = gitText(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (dirtyBefore) throw new Error(`RUNTIME_RELEASE_DIRTY_SOURCE: ${dirtyBefore.split(/\r?\n/).slice(0, 20).join(', ')}`);

  const scriptPath = join(sourceRoot, 'scripts', 'stage-runtime-release.ts');
  if (!existsSync(scriptPath) || lstatSync(scriptPath).isSymbolicLink() || !lstatSync(scriptPath).isFile()) {
    throw new Error(`RUNTIME_RELEASE_CANDIDATE_STAGER_MISSING: ${scriptPath}`);
  }
  const configured = process.env.FORGE_BUN_BIN?.trim();
  const bunExecutable = configured || resolveBunExecutable(process.execPath, process.env);
  const runCandidateStager = dependencies.runCandidateStager ?? ((request) => runProcess(request.bunExecutable, [
    request.scriptPath,
    '--controller-home', request.controllerHome,
    '--source-root', request.sourceRoot,
    '--expected-head', request.expectedHead,
  ], { cwd: request.sourceRoot, timeoutMs: 600_000, maxOutputBytes: 512 * 1024 }));
  const executed = runCandidateStager({ bunExecutable, scriptPath, sourceRoot, controllerHome, expectedHead });
  if (!executed.ok) {
    throw new Error(`RUNTIME_RELEASE_CANDIDATE_STAGE_FAILED: ${executed.stderr || executed.stdout || executed.error}`.slice(0, 2_000));
  }
  const receipt = parseCandidateStageReceipt(executed.stdout ?? '');
  if (receipt.sourceCommit !== expectedHead) {
    throw new Error(`RUNTIME_RELEASE_CANDIDATE_SOURCE_MISMATCH: expected ${expectedHead}, got ${receipt.sourceCommit}`);
  }

  const headAfter = gitText(sourceRoot, ['rev-parse', '--verify', 'HEAD']);
  const dirtyAfter = gitText(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (headAfter !== expectedHead || dirtyAfter) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_SOURCE_CHANGED_DURING_STAGE');
  }

  const releasesRoot = join(controllerHome, 'runtime', 'releases');
  const releasePath = resolve(receipt.releasePath);
  const manifestPath = resolve(receipt.manifestPath);
  if (dirname(releasePath) !== releasesRoot || releasePath !== join(releasesRoot, receipt.releaseId)) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_PATH_OUTSIDE_RELEASE_ROOT');
  }
  if (manifestPath !== join(releasePath, 'manifest.json')) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_MANIFEST_PATH_INVALID');
  }
  const runtimePath = join(releasePath, 'forge-runtime');
  if (!existsSync(releasePath) || !existsSync(manifestPath) || !existsSync(runtimePath)) {
    throw new Error(`RUNTIME_RELEASE_FILES_MISSING: ${releasePath}`);
  }
  const physicalReleasePath = join(realpathSync(releasesRoot), receipt.releaseId);
  const releaseStat = lstatSync(releasePath), manifestStat = lstatSync(manifestPath), runtimeStat = lstatSync(runtimePath);
  if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory()
    || manifestStat.isSymbolicLink() || !manifestStat.isFile()
    || runtimeStat.isSymbolicLink() || !runtimeStat.isFile()
    || realpathSync(releasePath) !== physicalReleasePath) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_PATH_NOT_PHYSICAL');
  }
  const runtimeIdentity = `sha256:${sha256(runtimePath)}`;
  if (runtimeIdentity !== receipt.artifactIdentity) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_ARTIFACT_IDENTITY_MISMATCH');
  }
  if (sha256(manifestPath) !== receipt.manifestSha256) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_MANIFEST_IDENTITY_MISMATCH');
  }

  return {
    releasePath,
    manifestPath,
    releaseId: receipt.releaseId,
    artifactIdentity: receipt.artifactIdentity,
    manifestSha256: receipt.manifestSha256,
    sourceCommit: receipt.sourceCommit,
  };
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

    const browserHandoffEntrypoint = 'browser-handoff-host.js' as const;
    const browserHandoffPath = join(staging, browserHandoffEntrypoint);
    const browserHandoffBundle = bundleNodeHost({
      sourceRoot,
      outputPath: browserHandoffPath,
      entryPath: join(sourceRoot, 'src/runtime/plugins/browser-handoff-host.ts'),
    });
    if (!browserHandoffBundle.ok) {
      throw new Error(`RUNTIME_RELEASE_BROWSER_HANDOFF_HOST_BUILD_FAILED: ${browserHandoffBundle.stderr || browserHandoffBundle.stdout || browserHandoffBundle.error}`.slice(0, 2_000));
    }
    chmodSync(browserHandoffPath, 0o700);
    const browserHandoffArtifactIdentity = `sha256:${sha256(browserHandoffPath)}`;

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

    const controllerUiRoot = 'ui-dist' as const;
    const sourceControllerUiPath = join(sourceRoot, 'src', 'cli', 'local-bridge', controllerUiRoot);
    const sourceControllerUiJs = join(sourceControllerUiPath, 'app.js');
    const sourceControllerUiCss = join(sourceControllerUiPath, 'app.css');
    if (!existsSync(sourceControllerUiJs) || !existsSync(sourceControllerUiCss)) {
      throw new Error(`RUNTIME_RELEASE_CONTROLLER_UI_SOURCE_MISSING: ${sourceControllerUiPath}`);
    }
    const controllerUiPath = join(staging, controllerUiRoot);
    cpSync(sourceControllerUiPath, controllerUiPath, { recursive: true, force: false });
    const controllerUiArtifactIdentity = `sha256:${sha256Directory(controllerUiPath)}`;

    const manifest = {
      schemaVersion: 1,
      releaseId,
      artifactIdentity,
      entrypoint: 'forge-runtime',
      diagnosticEntrypoint: 'forge-cli',
      diagnosticArtifactIdentity,
      browserNodeBridgeEntrypoint,
      browserNodeBridgeArtifactIdentity,
      browserHandoffEntrypoint,
      browserHandoffArtifactIdentity,
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
      controllerUiRoot,
      controllerUiArtifactIdentity,
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
      browserHandoffArtifactIdentity,
      processRunnerArtifactIdentity,
      checkRunnerArtifactIdentity,
      externalPluginProbeArtifactIdentity,
      codeGraphNodeArtifactIdentity,
      codeGraphSidecarArtifactIdentity,
      codeGraphLibraryArtifactIdentity,
      controllerUiArtifactIdentity,
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
  if (release.browserHandoffArtifactIdentity && !existsSync(join(release.releasePath, 'browser-handoff-host.js'))) {
    throw new Error(`RUNTIME_RELEASE_BROWSER_HANDOFF_HOST_MISSING: ${join(release.releasePath, 'browser-handoff-host.js')}`);
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
  if (release.controllerUiArtifactIdentity
    && (!existsSync(join(release.releasePath, 'ui-dist', 'app.js')) || !existsSync(join(release.releasePath, 'ui-dist', 'app.css')))) {
    throw new Error(`RUNTIME_RELEASE_CONTROLLER_UI_MISSING: ${join(release.releasePath, 'ui-dist')}`);
  }
}
