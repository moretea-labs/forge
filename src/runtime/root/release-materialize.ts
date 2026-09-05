import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';
import { resolveBunExecutable } from '../shared/process-environment';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../control-plane/persistence/sqlite-store';
import { assertRuntimeReleaseExecutionSurface, loadRuntimeReleaseManifest, requireCompleteCompiledRuntimeReleaseManifest, type RuntimeReleaseExecutionSurface } from './release-manifest';
import { processRuntimeReleaseCanaryCommands, type ProcessRuntimeReleaseCanaryCommand } from '../execution/process-runtime/canary';
import { packageRuntimeFileIndex, stagePackageRuntimeSnapshot } from './package-runtime-release';

/**
 * Stage one immutable Forge Runtime release below Controller Home. The staged
 * release contains the compiled `forge-runtime` entrypoint, a same-commit
 * `forge-cli` diagnostic sidecar, plus a manifest that satisfies
 * `loadRuntimeReleaseManifest`. Activation is the explicit
 * `forge runtime service install` operation; staging alone never starts or
 * publishes anything.
 */
export const FORGE_MACOS_RUNTIME_SIGNING_IDENTIFIER = 'com.moretea.forge.runtime';

export interface MacOSRuntimeCodeSigning {
  identifier: string;
  teamIdentifier: string;
  designatedRequirement: string;
  authority: string;
}

export interface StagedRuntimeRelease {
  controllerHome: string;
  releasePath: string;
  manifestPath: string;
  releaseId: string;
  artifactIdentity: string;
  diagnosticArtifactIdentity?: string;
  browserNodeBridgeArtifactIdentity?: string;
  browserHandoffArtifactIdentity?: string;
  processRunnerArtifactIdentity?: string;
  checkRunnerArtifactIdentity?: string;
  pluginActionSidecarArtifactIdentity?: string;
  externalPluginProbeArtifactIdentity?: string;
  codeGraphNodeArtifactIdentity?: string;
  codeGraphSidecarArtifactIdentity?: string;
  codeGraphLibraryArtifactIdentity?: string;
  packageArtifactIdentity?: string;
  controllerUiArtifactIdentity?: string;
  macosCodeSigning?: MacOSRuntimeCodeSigning;
  manifestSha256: string;
  sourceCommit: string;
}

export interface RuntimeReleaseMaterializerDependencies {
  now?: () => number;
  platform?: NodeJS.Platform;
  signMacOSRuntime?: (input: { executable: string; controllerHome: string }) => MacOSRuntimeCodeSigning;
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
  platform?: NodeJS.Platform;
  inspectMacOSRuntime?: (executable: string) => MacOSRuntimeCodeSigning;
  runCandidateStager?: (input: {
    bunExecutable: string;
    scriptPath: string;
    sourceRoot: string;
    controllerHome: string;
    expectedHead: string;
  }) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
  runExecutionEntryCanary?: (input: ProcessRuntimeReleaseCanaryCommand) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
}

function gitText(root: string, args: string[]): string {
  const result = runProcess('git', ['-C', root, ...args], { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
  if (!result.ok) throw new Error(`RUNTIME_RELEASE_GIT_FAILED: ${result.stderr || result.stdout || result.error}`.slice(0, 2_000));
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseMacOSRuntimeCodeSigning(value: unknown, context: string): MacOSRuntimeCodeSigning | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context}: macosCodeSigning must be an object`);
  const record = value as Record<string, unknown>;
  const field = (name: keyof MacOSRuntimeCodeSigning): string => {
    const entry = record[name];
    if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${context}: macosCodeSigning.${name} is required`);
    return entry.trim();
  };
  const signing = {
    identifier: field('identifier'),
    teamIdentifier: field('teamIdentifier'),
    designatedRequirement: field('designatedRequirement'),
    authority: field('authority'),
  };
  if (signing.identifier !== FORGE_MACOS_RUNTIME_SIGNING_IDENTIFIER) {
    throw new Error(`${context}: macosCodeSigning.identifier must be ${FORGE_MACOS_RUNTIME_SIGNING_IDENTIFIER}`);
  }
  if (!/^[A-Z0-9]{10}$/.test(signing.teamIdentifier)) throw new Error(`${context}: macosCodeSigning.teamIdentifier is invalid`);
  if (!signing.authority.startsWith('Developer ID Application: ')) throw new Error(`${context}: macosCodeSigning.authority must be Developer ID Application`);
  if (!signing.designatedRequirement.includes(`identifier \"${FORGE_MACOS_RUNTIME_SIGNING_IDENTIFIER}\"`)
    || !signing.designatedRequirement.includes('anchor apple generic')
    || !signing.designatedRequirement.includes(`certificate leaf[subject.OU] = ${signing.teamIdentifier}`)) {
    throw new Error(`${context}: macosCodeSigning.designatedRequirement is not the stable Developer ID contract`);
  }
  return signing;
}

function readActiveMacOSRuntimeTeam(controllerHome: string): string | undefined {
  const authorityPath = join(resolve(controllerHome), 'runtime', 'releases', 'authority.json');
  if (!existsSync(authorityPath)) return undefined;
  try {
    const authority = JSON.parse(readFileSync(authorityPath, 'utf8')) as { active?: { manifestPath?: string } };
    if (!authority.active?.manifestPath || !existsSync(authority.active.manifestPath)) return undefined;
    const manifest = JSON.parse(readFileSync(authority.active.manifestPath, 'utf8')) as Record<string, unknown>;
    return parseMacOSRuntimeCodeSigning(manifest.macosCodeSigning, 'RUNTIME_RELEASE_ACTIVE_SIGNING_INVALID')?.teamIdentifier;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RUNTIME_RELEASE_ACTIVE_SIGNING_INVALID')) throw error;
    return undefined;
  }
}

function inspectMacOSRuntimeCodeSigning(executable: string): MacOSRuntimeCodeSigning {
  const verify = runProcess('codesign', ['--verify', '--strict', executable], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (!verify.ok) throw new Error(`RUNTIME_RELEASE_MACOS_SIGNATURE_INVALID: ${verify.stderr || verify.stdout || verify.error}`.slice(0, 2_000));
  const detail = runProcess('codesign', ['-dv', '--verbose=4', executable], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (!detail.ok) throw new Error(`RUNTIME_RELEASE_MACOS_SIGNATURE_INSPECTION_FAILED: ${detail.stderr || detail.stdout || detail.error}`.slice(0, 2_000));
  const detailText = `${detail.stdout}\n${detail.stderr}`;
  const identifier = detailText.match(/^Identifier=(.+)$/m)?.[1]?.trim() ?? '';
  const teamIdentifier = detailText.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? '';
  const authority = detailText.match(/^Authority=(Developer ID Application:.+)$/m)?.[1]?.trim() ?? '';
  const requirementResult = runProcess('codesign', ['-d', '-r-', executable], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (!requirementResult.ok) throw new Error(`RUNTIME_RELEASE_MACOS_REQUIREMENT_INSPECTION_FAILED: ${requirementResult.stderr || requirementResult.stdout || requirementResult.error}`.slice(0, 2_000));
  const requirementText = `${requirementResult.stdout}\n${requirementResult.stderr}`;
  const designatedRequirement = requirementText.match(/^designated => (.+)$/m)?.[1]?.trim() ?? '';
  return parseMacOSRuntimeCodeSigning({ identifier, teamIdentifier, authority, designatedRequirement }, 'RUNTIME_RELEASE_MACOS_SIGNATURE_INVALID')!;
}

function defaultSignMacOSRuntime(input: { executable: string; controllerHome: string }): MacOSRuntimeCodeSigning {
  const identities = runProcess('security', ['find-identity', '-v', '-p', 'codesigning'], { timeoutMs: 30_000, maxOutputBytes: 128 * 1024 });
  if (!identities.ok) throw new Error(`RUNTIME_RELEASE_MACOS_SIGNING_IDENTITY_LOOKUP_FAILED: ${identities.stderr || identities.stdout || identities.error}`.slice(0, 2_000));
  const candidates = identities.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+\"(Developer ID Application: .+ \(([A-Z0-9]{10})\))\"/);
    return match ? [{ hash: match[1]!, label: match[2]!, teamIdentifier: match[3]! }] : [];
  });
  const configured = process.env.FORGE_MACOS_RUNTIME_SIGNING_IDENTITY?.trim();
  const expectedTeam = readActiveMacOSRuntimeTeam(input.controllerHome);
  let selected = configured
    ? candidates.find((candidate) => candidate.hash.toLowerCase() === configured.toLowerCase() || candidate.label === configured)
    : undefined;
  if (configured && !selected) throw new Error('RUNTIME_RELEASE_MACOS_SIGNING_IDENTITY_NOT_FOUND');
  if (!selected) {
    const eligible = expectedTeam ? candidates.filter((candidate) => candidate.teamIdentifier === expectedTeam) : candidates;
    const teams = Array.from(new Set(eligible.map((candidate) => candidate.teamIdentifier)));
    if (teams.length !== 1 || eligible.length === 0) {
      throw new Error(expectedTeam ? 'RUNTIME_RELEASE_MACOS_SIGNING_IDENTITY_FOR_TEAM_REQUIRED' : 'RUNTIME_RELEASE_MACOS_SIGNING_IDENTITY_REQUIRED');
    }
    selected = eligible[0];
  }
  if (expectedTeam && selected.teamIdentifier !== expectedTeam) throw new Error('RUNTIME_RELEASE_MACOS_SIGNING_TEAM_CHANGED');
  const signed = runProcess('codesign', [
    '--force', '--sign', selected.hash, '--identifier', FORGE_MACOS_RUNTIME_SIGNING_IDENTIFIER, '--options', 'runtime', input.executable,
  ], { timeoutMs: 120_000, maxOutputBytes: 128 * 1024 });
  if (!signed.ok) throw new Error(`RUNTIME_RELEASE_MACOS_SIGNING_FAILED: ${signed.stderr || signed.stdout || signed.error}`.slice(0, 2_000));
  const inspected = inspectMacOSRuntimeCodeSigning(input.executable);
  if (inspected.teamIdentifier !== selected.teamIdentifier) throw new Error('RUNTIME_RELEASE_MACOS_SIGNING_TEAM_MISMATCH');
  return inspected;
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

export interface RuntimeReleaseExecutionCanaryDependencies {
  runExecutionEntryCanary?: (input: ProcessRuntimeReleaseCanaryCommand) => { ok: boolean; stderr?: string; stdout?: string; error?: string };
}

/** Execute the exact immutable Process/Check Runner artifacts in bounded no-op mode. */
export function assertRuntimeReleaseExecutionCanaries(
  manifestPath: string,
  controllerHome: string,
  dependencies: RuntimeReleaseExecutionCanaryDependencies = {},
): RuntimeReleaseExecutionSurface {
  const surface = assertRuntimeReleaseExecutionSurface(manifestPath, controllerHome);
  const runExecutionEntryCanary = dependencies.runExecutionEntryCanary ?? ((request: ProcessRuntimeReleaseCanaryCommand) => runProcess(
    request.executable,
    request.args,
    { cwd: surface.releaseRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
  ));
  for (const canary of processRuntimeReleaseCanaryCommands(surface.releaseRoot)) {
    const result = runExecutionEntryCanary(canary);
    if (!result.ok) {
      throw new Error(`RUNTIME_RELEASE_EXECUTION_CANARY_FAILED: ${canary.name}: ${result.stderr || result.stdout || result.error || 'unknown failure'}`.slice(0, 2_000));
    }
  }
  return surface;
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
  let rawManifest: Record<string, unknown>;
  try { rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>; }
  catch (error) { throw new Error(`RUNTIME_RELEASE_CANDIDATE_MANIFEST_INVALID: ${error instanceof Error ? error.message : String(error)}`); }
  const manifest = loadRuntimeReleaseManifest(manifestPath, controllerHome);
  requireCompleteCompiledRuntimeReleaseManifest(manifest);
  if (manifest.releaseId !== receipt.releaseId
    || manifest.artifactIdentity !== receipt.artifactIdentity
    || manifest.sourceCommit !== receipt.sourceCommit) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_MANIFEST_RECEIPT_MISMATCH');
  }
  const platform = dependencies.platform ?? process.platform;
  const macosCodeSigning = parseMacOSRuntimeCodeSigning(rawManifest.macosCodeSigning, 'RUNTIME_RELEASE_CANDIDATE_SIGNING_INVALID');
  if (platform === 'darwin') {
    if (!macosCodeSigning) throw new Error('RUNTIME_RELEASE_CANDIDATE_MACOS_SIGNING_REQUIRED');
    const actual = (dependencies.inspectMacOSRuntime ?? inspectMacOSRuntimeCodeSigning)(runtimePath);
    if (actual.identifier !== macosCodeSigning.identifier
      || actual.teamIdentifier !== macosCodeSigning.teamIdentifier
      || actual.authority !== macosCodeSigning.authority
      || actual.designatedRequirement !== macosCodeSigning.designatedRequirement) {
      throw new Error('RUNTIME_RELEASE_CANDIDATE_MACOS_SIGNING_MISMATCH');
    }
  }

  const staged: StagedRuntimeRelease = {
    controllerHome,
    releasePath,
    manifestPath,
    releaseId: receipt.releaseId,
    artifactIdentity: receipt.artifactIdentity,
    diagnosticArtifactIdentity: manifest.diagnosticArtifactIdentity,
    browserNodeBridgeArtifactIdentity: manifest.browserNodeBridgeArtifactIdentity,
    browserHandoffArtifactIdentity: manifest.browserHandoffArtifactIdentity,
    processRunnerArtifactIdentity: manifest.processRunnerArtifactIdentity,
    checkRunnerArtifactIdentity: manifest.checkRunnerArtifactIdentity,
    pluginActionSidecarArtifactIdentity: manifest.pluginActionSidecarArtifactIdentity,
    externalPluginProbeArtifactIdentity: manifest.externalPluginProbeArtifactIdentity,
    codeGraphNodeArtifactIdentity: manifest.codeGraphNodeArtifactIdentity,
    codeGraphSidecarArtifactIdentity: manifest.codeGraphSidecarArtifactIdentity,
    codeGraphLibraryArtifactIdentity: manifest.codeGraphLibraryArtifactIdentity,
    packageArtifactIdentity: manifest.packageArtifactIdentity,
    controllerUiArtifactIdentity: manifest.controllerUiArtifactIdentity,
    ...(macosCodeSigning ? { macosCodeSigning } : {}),
    manifestSha256: receipt.manifestSha256,
    sourceCommit: receipt.sourceCommit,
  };
  assertRuntimeReleaseFiles(staged, dependencies);
  assertRuntimeReleaseExecutionCanaries(manifestPath, controllerHome, dependencies);
  return staged;
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
    const platform = dependencies.platform ?? process.platform;
    const macosCodeSigning = platform === 'darwin'
      ? (dependencies.signMacOSRuntime ?? defaultSignMacOSRuntime)({ executable, controllerHome: resolve(input.controllerHome) })
      : undefined;
    if (platform === 'darwin' && !macosCodeSigning) throw new Error('RUNTIME_RELEASE_MACOS_SIGNING_REQUIRED');
    const normalizedMacOSCodeSigning = macosCodeSigning
      ? parseMacOSRuntimeCodeSigning(macosCodeSigning, 'RUNTIME_RELEASE_MACOS_SIGNING_INVALID')
      : undefined;
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

    const pluginActionSidecarEntrypoint = 'forge-plugin-action-sidecar' as const;
    const pluginActionSidecarPath = join(staging, pluginActionSidecarEntrypoint);
    const pluginActionSidecarCompile = compileBinary({
      sourceRoot,
      outputPath: pluginActionSidecarPath,
      entryPath: join(sourceRoot, 'src/runtime/plugins/plugin-action-sidecar.ts'),
    });
    if (!pluginActionSidecarCompile.ok) {
      throw new Error(`RUNTIME_RELEASE_PLUGIN_ACTION_SIDECAR_BUILD_FAILED: ${pluginActionSidecarCompile.stderr || pluginActionSidecarCompile.stdout || pluginActionSidecarCompile.error}`.slice(0, 2_000));
    }
    chmodSync(pluginActionSidecarPath, 0o700);
    const pluginActionSidecarArtifactIdentity = `sha256:${sha256(pluginActionSidecarPath)}`;

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

    // The persistent OAuth/Connector is source-backed even when the primary
    // Runtime itself is compiled. Co-locate one immutable package snapshot in
    // the same release so standalone Recovery can bind the Connector to the
    // exact active release instead of retaining an older package release.
    const packageRoot = 'package' as const;
    const packagePath = join(staging, packageRoot);
    const packageRecords = packageRuntimeFileIndex(sourceRoot);
    stagePackageRuntimeSnapshot(sourceRoot, packagePath, packageRecords);
    const packageArtifactIdentity = `sha256:${sha256Directory(packagePath)}`;

    const manifest = {
      schemaVersion: 1,
      releaseId,
      artifactIdentity,
      entrypoint: 'forge-runtime',
      ...(normalizedMacOSCodeSigning ? { macosCodeSigning: normalizedMacOSCodeSigning } : {}),
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
      pluginActionSidecarEntrypoint,
      pluginActionSidecarArtifactIdentity,
      externalPluginProbeEntrypoint,
      externalPluginProbeArtifactIdentity,
      codeGraphNodeEntrypoint,
      codeGraphNodeArtifactIdentity,
      codeGraphSidecarEntrypoint,
      codeGraphSidecarArtifactIdentity,
      codeGraphLibraryRoot,
      codeGraphLibraryArtifactIdentity,
      packageRoot,
      packageArtifactIdentity,
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
      controllerHome: resolve(input.controllerHome),
      releasePath,
      manifestPath: join(releasePath, 'manifest.json'),
      releaseId,
      artifactIdentity,
      ...(normalizedMacOSCodeSigning ? { macosCodeSigning: normalizedMacOSCodeSigning } : {}),
      diagnosticArtifactIdentity,
      browserNodeBridgeArtifactIdentity,
      browserHandoffArtifactIdentity,
      processRunnerArtifactIdentity,
      checkRunnerArtifactIdentity,
      pluginActionSidecarArtifactIdentity,
      externalPluginProbeArtifactIdentity,
      codeGraphNodeArtifactIdentity,
      codeGraphSidecarArtifactIdentity,
      codeGraphLibraryArtifactIdentity,
      packageArtifactIdentity,
      controllerUiArtifactIdentity,
      manifestSha256: createHash('sha256').update(`${JSON.stringify(manifest, null, 2)}\n`).digest('hex'),
      sourceCommit,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function assertRuntimeReleaseFiles(release: StagedRuntimeRelease, dependencies: { platform?: NodeJS.Platform; inspectMacOSRuntime?: (executable: string) => MacOSRuntimeCodeSigning } = {}): void {
  const assertRegularFile = (path: string, missingCode: string): void => {
    if (!existsSync(path)) throw new Error(`${missingCode}: ${path}`);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile()) throw new Error(`RUNTIME_RELEASE_PATH_NOT_REGULAR_FILE: ${path}`);
  };
  const assertExecutable = (path: string): void => {
    if ((statSync(path).mode & 0o111) === 0) throw new Error(`RUNTIME_RELEASE_ENTRYPOINT_NOT_EXECUTABLE: ${path}`);
  };
  const assertFileIdentity = (path: string, expected: string): void => {
    const actual = `sha256:${sha256(path)}`;
    if (actual !== expected) throw new Error(`RUNTIME_RELEASE_ARTIFACT_IDENTITY_MISMATCH: ${path}`);
  };
  const assertDirectoryIdentity = (path: string, expected: string): void => {
    if (!existsSync(path)) throw new Error(`RUNTIME_RELEASE_DIRECTORY_MISSING: ${path}`);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`RUNTIME_RELEASE_PATH_NOT_DIRECTORY: ${path}`);
    const actual = `sha256:${sha256Directory(path)}`;
    if (actual !== expected) throw new Error(`RUNTIME_RELEASE_ARTIFACT_IDENTITY_MISMATCH: ${path}`);
  };
  const assertComponentFile = (input: { path: string; identity?: string; missingCode: string; executable?: boolean }): void => {
    if (!input.identity) return;
    assertRegularFile(input.path, input.missingCode);
    assertFileIdentity(input.path, input.identity);
    if (input.executable) assertExecutable(input.path);
  };

  if (!existsSync(release.releasePath) || !existsSync(release.manifestPath)) {
    throw new Error(`RUNTIME_RELEASE_FILES_MISSING: ${release.releasePath}`);
  }
  const releasesRoot = join(resolve(release.controllerHome), 'runtime', 'releases');
  if (resolve(release.releasePath) !== join(releasesRoot, release.releaseId)
    || resolve(release.manifestPath) !== join(release.releasePath, 'manifest.json')) {
    throw new Error('RUNTIME_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
  }
  const releaseStatus = lstatSync(release.releasePath);
  const manifestStatus = lstatSync(release.manifestPath);
  if (releaseStatus.isSymbolicLink() || !releaseStatus.isDirectory()
    || manifestStatus.isSymbolicLink() || !manifestStatus.isFile()) {
    throw new Error(`RUNTIME_RELEASE_PATH_NOT_PHYSICAL: ${release.releasePath}`);
  }
  if (sha256(release.manifestPath) !== release.manifestSha256) {
    throw new Error('RUNTIME_RELEASE_MANIFEST_IDENTITY_MISMATCH');
  }
  const runtimePath = join(release.releasePath, 'forge-runtime');
  assertRegularFile(runtimePath, 'RUNTIME_RELEASE_ENTRYPOINT_MISSING');
  assertExecutable(runtimePath);
  assertFileIdentity(runtimePath, release.artifactIdentity);
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'darwin' && release.macosCodeSigning) {
    const actual = (dependencies.inspectMacOSRuntime ?? inspectMacOSRuntimeCodeSigning)(runtimePath);
    if (actual.identifier !== release.macosCodeSigning.identifier
      || actual.teamIdentifier !== release.macosCodeSigning.teamIdentifier
      || actual.authority !== release.macosCodeSigning.authority
      || actual.designatedRequirement !== release.macosCodeSigning.designatedRequirement) {
      throw new Error('RUNTIME_RELEASE_MACOS_SIGNING_MISMATCH');
    }
  }
  assertComponentFile({ path: join(release.releasePath, 'forge-cli'), identity: release.diagnosticArtifactIdentity, missingCode: 'RUNTIME_RELEASE_DIAGNOSTIC_ENTRYPOINT_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'browser-node-bridge-host.js'), identity: release.browserNodeBridgeArtifactIdentity, missingCode: 'RUNTIME_RELEASE_BROWSER_NODE_HOST_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'browser-handoff-host.js'), identity: release.browserHandoffArtifactIdentity, missingCode: 'RUNTIME_RELEASE_BROWSER_HANDOFF_HOST_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'process-runner.js'), identity: release.processRunnerArtifactIdentity, missingCode: 'RUNTIME_RELEASE_PROCESS_RUNNER_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'forge-check-runner'), identity: release.checkRunnerArtifactIdentity, missingCode: 'RUNTIME_RELEASE_CHECK_RUNNER_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'forge-plugin-action-sidecar'), identity: release.pluginActionSidecarArtifactIdentity, missingCode: 'RUNTIME_RELEASE_PLUGIN_ACTION_SIDECAR_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'external-unix-socket-probe.cjs'), identity: release.externalPluginProbeArtifactIdentity, missingCode: 'RUNTIME_RELEASE_EXTERNAL_PLUGIN_PROBE_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'codegraph-node'), identity: release.codeGraphNodeArtifactIdentity, missingCode: 'RUNTIME_RELEASE_CODEGRAPH_NODE_MISSING', executable: true });
  assertComponentFile({ path: join(release.releasePath, 'codegraph-sidecar.cjs'), identity: release.codeGraphSidecarArtifactIdentity, missingCode: 'RUNTIME_RELEASE_CODEGRAPH_SIDECAR_MISSING', executable: true });
  if (release.codeGraphLibraryArtifactIdentity) {
    const libraryRoot = join(release.releasePath, 'codegraph-lib');
    if (!existsSync(join(libraryRoot, 'dist', 'index.js'))) {
      throw new Error(`RUNTIME_RELEASE_CODEGRAPH_LIBRARY_MISSING: ${join(libraryRoot, 'dist', 'index.js')}`);
    }
    assertDirectoryIdentity(libraryRoot, release.codeGraphLibraryArtifactIdentity);
  }
  if (release.packageArtifactIdentity) {
    const packageRoot = join(release.releasePath, 'package');
    assertDirectoryIdentity(packageRoot, release.packageArtifactIdentity);
  }
  if (release.controllerUiArtifactIdentity) {
    const uiRoot = join(release.releasePath, 'ui-dist');
    if (!existsSync(join(uiRoot, 'app.js')) || !existsSync(join(uiRoot, 'app.css'))) {
      throw new Error(`RUNTIME_RELEASE_CONTROLLER_UI_MISSING: ${uiRoot}`);
    }
    assertDirectoryIdentity(uiRoot, release.controllerUiArtifactIdentity);
  }
}
