import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { runProcess } from '../../effects/process-runner';
import { looksLikeControllerRuntimePackage, resolveControllerRuntimeSourceRoot } from '../control-plane/runtime-generation';
import {
  readCurrentRelease,
  readSupervisorRelease,
  ensureStableSupervisorLayout,
  publishCurrentRelease,
  supervisorBootstrapConfigPath,
  supervisorBootstrapManifestPath,
  supervisorBootstrapPath,
  supervisorLogsRoot,
  supervisorReleasesRoot,
  supervisorRoot,
  SUPERVISOR_RELEASE_ENTRYPOINTS,
  supervisorReleaseClosureMissing,
} from './paths';
import type { SupervisorSourceIdentity } from './types';

export interface SupervisorInstallResult {
  controllerHome: string;
  releaseRevision: string;
  sourceCommit?: string;
  cleanWorkspace?: boolean;
  artifactHash?: string;
  releasePath: string;
  currentPath: string;
  previousPath?: string;
  bootstrapPath: string;
  launchdPlistPath: string;
  systemdUnitPath: string;
}

const RUNTIME_RELEASE_PATHS = ['src', 'scripts', 'package.json', 'bun.lock'] as const;
const RELEASE_EXECUTABLES = SUPERVISOR_RELEASE_ENTRYPOINTS;

function runtimeSourceRoot(explicit?: string): string {
  const resolved = resolveControllerRuntimeSourceRoot({ explicitRoot: explicit });
  if (!resolved.root) throw new Error(`SUPERVISOR_RUNTIME_SOURCE_UNAVAILABLE: ${resolved.detail ?? resolved.reason}`);
  return resolved.root;
}

function gitHead(root: string): string | undefined {
  const result = runProcess('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: 10_000, maxOutputBytes: 4_096 });
  return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function containmentPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function pathIsInside(parent: string, candidate: string): boolean {
  const normalizedParent = containmentPath(parent);
  const normalizedCandidate = containmentPath(candidate);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${sep}`);
}

function controllerManagedRuntimeSource(controllerHome: string, sourceRoot: string): boolean {
  return pathIsInside(join(resolve(controllerHome), 'repositories'), sourceRoot);
}

function publishRuntimeSourceRoot(input: {
  controllerHome: string;
  repoRoot: string;
  release: NonNullable<ReturnType<typeof readSupervisorRelease>>;
}): string {
  const repoRoot = runtimeSourceRoot(input.repoRoot);
  const releaseSourceRoot = input.release.sourceRoot ? resolve(input.release.sourceRoot) : undefined;
  if (!releaseSourceRoot) return repoRoot;

  const releaseSourceExists = existsSync(releaseSourceRoot);
  const releaseSourceLooksValid = releaseSourceExists && looksLikeControllerRuntimePackage(releaseSourceRoot);
  const managedSource = controllerManagedRuntimeSource(input.controllerHome, releaseSourceRoot);
  const repoHead = gitHead(repoRoot);
  const canonicalRepoRoot = containmentPath(repoRoot);
  const canonicalReleaseSourceRoot = containmentPath(releaseSourceRoot);
  if (canonicalReleaseSourceRoot === canonicalRepoRoot) return repoRoot;

  // A release may have been built in an isolated checkout, but its launched
  // runtime must always resolve source-relative behavior from the authoritative
  // checkout bound to this Controller Home. Never persist an arbitrary sibling
  // worktree path merely because it contains a valid runtime package.
  if (input.release.sourceCommit && repoHead === input.release.sourceCommit && looksLikeControllerRuntimePackage(repoRoot)) {
    return repoRoot;
  }

  const reasons = [
    releaseSourceExists ? undefined : 'sourceRoot missing',
    releaseSourceExists && !releaseSourceLooksValid ? 'sourceRoot is not a controller runtime package' : undefined,
    managedSource ? 'sourceRoot is a controller-managed worktree' : undefined,
    !managedSource ? `sourceRoot is not the authoritative repoRoot ${repoRoot}` : undefined,
    input.release.sourceCommit ? undefined : 'sourceCommit missing',
    repoHead && input.release.sourceCommit && repoHead !== input.release.sourceCommit
      ? `repoRoot HEAD ${repoHead} differs from release sourceCommit ${input.release.sourceCommit}`
      : undefined,
  ].filter(Boolean).join('; ');
  throw new Error(
    `SUPERVISOR_RELEASE_SOURCE_UNPUBLISHABLE: refusing to publish release ${input.release.releaseRevision ?? input.release.releasePath} `
    + `with unsafe runtime source ${releaseSourceRoot} (${reasons || 'unknown reason'})`,
  );
}

interface RuntimeSourceReleaseIdentity {
  sourceCommit: string;
  releaseRevision: string;
  cleanWorkspace: boolean;
  dirtyRuntimePaths: string[];
}

function parseDirtyRuntimePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ''))
    .map((path) => path.includes(' -> ') ? path.split(' -> ').pop() ?? path : path)
    .filter(Boolean);
}

function runtimeSourceIdentity(root: string, allowDirtyRuntimeSourceForTests = false): RuntimeSourceReleaseIdentity {
  const commit = runProcess('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: 10_000, maxOutputBytes: 4_096 });
  if (!commit.ok || !commit.stdout.trim()) {
    throw new Error('SUPERVISOR_RELEASE_SOURCE_COMMIT_UNAVAILABLE: Supervisor releases require a Git HEAD source commit.');
  }
  const dirty = runProcess('git', [
    '-C', root,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...RUNTIME_RELEASE_PATHS,
  ], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  if (!dirty.ok) {
    throw new Error(`SUPERVISOR_RELEASE_DIRTY_CHECK_FAILED: ${dirty.stderr || dirty.stdout || 'git status failed'}`.slice(0, 2_000));
  }
  const dirtyRuntimePaths = parseDirtyRuntimePaths(dirty.stdout);
  if (dirtyRuntimePaths.length > 0 && !allowDirtyRuntimeSourceForTests) {
    const listed = dirtyRuntimePaths.slice(0, 20).join(', ');
    const suffix = dirtyRuntimePaths.length > 20 ? `, ... ${dirtyRuntimePaths.length - 20} more` : '';
    throw new Error(
      `SUPERVISOR_RELEASE_DIRTY_RUNTIME_SOURCE: refusing to build Supervisor Release from dirty runtime source (${listed}${suffix}). `
      + `Commit or revert ${RUNTIME_RELEASE_PATHS.join(', ')} before staging a release.`,
    );
  }
  const sourceCommit = commit.stdout.trim();
  const cleanWorkspace = dirtyRuntimePaths.length === 0;
  return {
    sourceCommit,
    releaseRevision: `${sourceCommit}${cleanWorkspace ? '' : '-dirty'}`,
    cleanWorkspace,
    dirtyRuntimePaths,
  };
}

/**
 * Re-check the immutable source binding immediately before a candidate is
 * activated. Staging alone is insufficient: an explicit worktree may move or
 * become dirty while the asynchronous Supervisor operation is queued.
 */
export function verifySupervisorSourceIdentity(
  identity: SupervisorSourceIdentity,
  release: NonNullable<ReturnType<typeof readSupervisorRelease>>,
): void {
  const expectedPath = containmentPath(identity.sourcePath);
  const releasePath = containmentPath(release.sourceRoot ?? '');
  if (!release.sourceRoot || expectedPath !== releasePath) {
    throw new Error(`SUPERVISOR_SOURCE_IDENTITY_MISMATCH: release source ${release.sourceRoot ?? 'missing'} != ${identity.sourcePath}`);
  }
  if (release.sourceCommit !== identity.expectedHead) {
    throw new Error(`SUPERVISOR_SOURCE_HEAD_MISMATCH: release ${release.sourceCommit ?? 'missing'} != expected ${identity.expectedHead}`);
  }
  if (release.releaseRevision !== identity.expectedRevision) {
    throw new Error(`SUPERVISOR_SOURCE_REVISION_MISMATCH: release ${release.releaseRevision ?? 'missing'} != expected ${identity.expectedRevision}`);
  }
  const current = runtimeSourceIdentity(identity.sourcePath);
  if (current.sourceCommit !== identity.expectedHead) {
    throw new Error(`SUPERVISOR_SOURCE_HEAD_CHANGED: ${current.sourceCommit} != expected ${identity.expectedHead}`);
  }
  if (current.releaseRevision !== identity.expectedRevision || current.cleanWorkspace !== true) {
    throw new Error(`SUPERVISOR_SOURCE_DIRTY_OR_REVISION_CHANGED: ${current.releaseRevision}`);
  }
}

function buildEntry(
  sourceRoot: string,
  entry: string,
  output: string,
  target: 'bun' | 'node' = 'bun',
  standalone = true,
): void {
  const bun = process.versions.bun ? process.execPath : 'bun';
  const args = ['build', ...(standalone ? ['--compile'] : []), join(sourceRoot, entry), '--outfile', output, '--target', target];
  const result = runProcess(bun, args, {
    cwd: sourceRoot,
    timeoutMs: 180_000,
    maxOutputBytes: 128 * 1024,
  });
  if (!result.ok) throw new Error(`SUPERVISOR_RELEASE_BUILD_FAILED: ${result.stderr || result.stdout}`.slice(0, 2_000));
}

function serviceSuffix(controllerHome: string): string {
  const normalized = resolve(controllerHome);
  const readable = normalized.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-28) || 'default';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `${readable}-${digest}`;
}

function serviceLabel(controllerHome: string): string {
  return `com.repo-harness.supervisor.${serviceSuffix(controllerHome)}`;
}

export function supervisorSystemdUnitName(controllerHome: string): string {
  return `repo-harness-supervisor-${serviceSuffix(controllerHome)}.service`;
}

function systemdQuote(value: string): string {
  return JSON.stringify(value);
}

function supervisorServicePath(
  bunPath: string,
  homeDir = process.env.HOME,
  nvmBin = process.env.NVM_BIN,
): string {
  const userRuntimePaths = homeDir
    ? [
        join(homeDir, '.bun', 'bin'),
        join(homeDir, '.volta', 'bin'),
        ...(nvmBin ? [nvmBin] : []),
        join(homeDir, '.local', 'share', 'mise', 'shims'),
        join(homeDir, '.asdf', 'shims'),
        join(homeDir, '.local', 'bin'),
      ]
    : [];
  return Array.from(new Set([
    dirname(bunPath),
    ...userRuntimePaths,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])).join(':');
}

export function renderLaunchdSupervisorPlist(input: {
  label: string;
  bootstrapPath?: string;
  bunPath?: string;
  supervisorPath?: string;
  repoRoot?: string;
  controllerHome: string;
  runtimeSourceRoot?: string;
  releaseRevision?: string;
  logPath: string;
  homeDir?: string;
  nvmBin?: string;
}): string {
  const bootstrap = input.bootstrapPath ?? input.supervisorPath;
  if (!bootstrap) throw new Error('SUPERVISOR_BOOTSTRAP_PATH_REQUIRED');
  const args = input.bootstrapPath
    ? [input.bootstrapPath, '--controller-home', input.controllerHome]
    : [
      input.bunPath ?? 'bun',
      bootstrap,
      '--repo', input.repoRoot ?? input.controllerHome,
      '--controller-home', input.controllerHome,
      ...(input.runtimeSourceRoot ? ['--runtime-source-root', input.runtimeSourceRoot] : []),
      ...(input.releaseRevision ? ['--release-revision', input.releaseRevision] : []),
    ];
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(input.label)}</string>\n  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(supervisorServicePath(input.bootstrapPath ?? input.bunPath ?? bootstrap, input.homeDir, input.nvmBin))}</string><key>REPO_HARNESS_SUPERVISOR_SERVICE_MODE</key><string>managed</string></dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>2</integer>\n  <key>ProcessType</key><string>Interactive</string>\n  <key>StandardOutPath</key><string>${xml(input.logPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(input.logPath)}</string>\n</dict></plist>\n`;
}

export function renderSystemdSupervisorUnit(input: {
  bootstrapPath?: string;
  bunPath?: string;
  supervisorPath?: string;
  repoRoot?: string;
  controllerHome: string;
  runtimeSourceRoot?: string;
  homeDir?: string;
  nvmBin?: string;
}): string {
  const bootstrap = input.bootstrapPath ?? input.supervisorPath;
  if (!bootstrap) throw new Error('SUPERVISOR_BOOTSTRAP_PATH_REQUIRED');
  const args = input.bootstrapPath
    ? [input.bootstrapPath, '--controller-home', input.controllerHome]
    : [
      input.bunPath ?? 'bun',
      bootstrap,
      '--repo', input.repoRoot ?? input.controllerHome,
      '--controller-home', input.controllerHome,
      ...(input.runtimeSourceRoot ? ['--runtime-source-root', input.runtimeSourceRoot] : []),
    ];
  return `[Unit]\nDescription=repo-harness Stable External Runtime Supervisor\nAfter=default.target\n\n[Service]\nType=simple\nEnvironment=${systemdQuote(`PATH=${supervisorServicePath(input.bootstrapPath ?? input.bunPath ?? bootstrap, input.homeDir, input.nvmBin)}`)}\nEnvironment=${systemdQuote('REPO_HARNESS_SUPERVISOR_SERVICE_MODE=managed')}\nExecStart=${args.map(systemdQuote).join(' ')}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
}

export interface SupervisorStagedRelease {
  controllerHome: string;
  sourceRoot: string;
  releaseRevision: string;
  sourceCommit?: string;
  cleanWorkspace?: boolean;
  artifactHash?: string;
  executionMode: 'standalone-binary';
  releasePath: string;
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function releaseArtifactHash(releasePath: string): { artifactHash: string; artifacts: Record<string, { sha256: string }> } {
  const artifacts: Record<string, { sha256: string }> = {};
  const aggregate = createHash('sha256');
  for (const executable of RELEASE_EXECUTABLES) {
    const sha256 = fileSha256(join(releasePath, executable));
    artifacts[executable] = { sha256 };
    aggregate.update(executable);
    aggregate.update('\0');
    aggregate.update(sha256);
    aggregate.update('\0');
  }
  return { artifactHash: aggregate.digest('hex'), artifacts };
}

export interface SupervisorReleaseExecutionCanaryResult {
  releasePath: string;
  processId: string;
  exitCode: number;
  commandExecutedOnce: boolean;
}

/**
 * Prove that the immutable release can launch its own Process Runner and that
 * the runner can spawn one harmless child command and persist an exit receipt.
 * This uses the same bundled process-runner.js entrypoint as
 * repository_command_execute, rather than merely checking that the file exists.
 */
export function verifySupervisorReleaseExecutionCanary(input: {
  releasePath: string;
  cwd: string;
  executionMode?: 'standalone-binary' | 'script';
}): SupervisorReleaseExecutionCanaryResult {
  const releasePath = resolve(input.releasePath);
  const runnerPath = join(releasePath, 'process-runner.js');
  if (!existsSync(runnerPath)) {
    throw new Error('SUPERVISOR_RELEASE_PROCESS_CANARY_FAILED: process-runner.js is missing');
  }
  const processId = `release-canary-${process.pid}-${randomUUID().slice(0, 8)}`;
  const canaryRoot = join(dirname(releasePath), `.${processId}`);
  const descriptorPath = join(canaryRoot, 'command.json');
  const stdoutPath = join(canaryRoot, 'stdout.log');
  const stderrPath = join(canaryRoot, 'stderr.log');
  const exitReceiptPath = join(canaryRoot, 'exit.json');
  mkdirSync(canaryRoot, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(descriptorPath, `${JSON.stringify({
      schemaVersion: 1,
      processId,
      repoId: 'supervisor-release-canary',
      controllerHome: canaryRoot,
      command: {
        kind: 'argv',
        executable: process.execPath,
        args: ['--version'],
        cwd: resolve(input.cwd),
      },
      timeoutMs: 10_000,
      maxStdoutBytes: 16 * 1024,
      maxStderrBytes: 16 * 1024,
      stdoutPath,
      stderrPath,
      exitReceiptPath,
      startedAt: new Date().toISOString(),
      streamLogs: false,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const standalone = input.executionMode === 'standalone-binary';
    const runtime = standalone ? runnerPath : process.versions.bun ? process.execPath : 'bun';
    const args = standalone ? ['--descriptor', descriptorPath] : [runnerPath, '--descriptor', descriptorPath];
    const result = runProcess(runtime, args, {
      cwd: resolve(input.cwd),
      timeoutMs: 20_000,
      maxOutputBytes: 32 * 1024,
    });
    let receipt: {
      schemaVersion?: number;
      processId?: string;
      exitCode?: number | null;
      commandExecutedOnce?: boolean;
    } | undefined;
    try {
      receipt = JSON.parse(readFileSync(exitReceiptPath, 'utf8')) as typeof receipt;
    } catch {
      receipt = undefined;
    }
    if (
      !result.ok
      || receipt?.schemaVersion !== 1
      || receipt.processId !== processId
      || receipt.exitCode !== 0
      || receipt.commandExecutedOnce !== true
    ) {
      const detail = result.stderr || result.stdout || 'runner did not produce a successful receipt';
      throw new Error(`SUPERVISOR_RELEASE_PROCESS_CANARY_FAILED: ${detail}`.slice(0, 2_000));
    }
    return {
      releasePath,
      processId,
      exitCode: receipt.exitCode,
      commandExecutedOnce: true,
    };
  } finally {
    rmSync(canaryRoot, { recursive: true, force: true });
  }
}
function installFixedSupervisorBootstrap(controllerHome: string, sourceRoot: string, repoRoot: string): string {
  const home = resolve(controllerHome);
  ensureStableSupervisorLayout(home);
  const bootstrapPath = supervisorBootstrapPath(home);
  if (!existsSync(bootstrapPath) || statSync(bootstrapPath).size === 0) {
    const temporary = `${bootstrapPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      buildEntry(sourceRoot, 'src/runtime/bootstrap/entry.ts', temporary, 'bun', true);
      chmodSync(temporary, 0o700);
      if (existsSync(bootstrapPath)) {
        rmSync(temporary, { force: true });
      } else {
        renameSync(temporary, bootstrapPath);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
    writeFileSync(supervisorBootstrapManifestPath(home), `${JSON.stringify({
      schemaVersion: 1,
      executionMode: 'standalone-binary',
      sourceCommit: gitHead(sourceRoot),
      bootstrapPath,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const now = new Date().toISOString();
  const configPath = supervisorBootstrapConfigPath(home);
  const temporaryConfig = `${configPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporaryConfig, `${JSON.stringify({
    schemaVersion: 1,
    controllerHome: home,
    repoRoot: resolve(repoRoot),
    createdAt: now,
    updatedAt: now,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryConfig, configPath);
  return bootstrapPath;
}

function assertOwnedReleasePath(controllerHome: string, releasePath: string): string {
  const candidate = resolve(releasePath);
  try {
    const rootReal = realpathSync(resolve(supervisorReleasesRoot(controllerHome)));
    const candidateReal = realpathSync(candidate);
    if (!candidateReal.startsWith(`${rootReal}${sep}`)) {
      throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME') throw error;
    throw new Error('SUPERVISOR_RELEASE_PATH_OUTSIDE_CONTROLLER_HOME');
  }
  return candidate;
}

export function stageSupervisorRelease(input: { controllerHome: string; repoRoot: string; sourceRoot?: string; allowDirtyRuntimeSourceForTests?: boolean }): SupervisorStagedRelease {
  const controllerHome = resolve(input.controllerHome);
  const sourceRoot = runtimeSourceRoot(input.sourceRoot ?? input.repoRoot);
  ensureStableSupervisorLayout(controllerHome);
  const identity = runtimeSourceIdentity(sourceRoot, input.allowDirtyRuntimeSourceForTests === true);
  const revision = identity.releaseRevision;
  const releaseName = `${Date.now()}-${revision.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
  const releasePath = join(supervisorReleasesRoot(controllerHome), releaseName);
  const stagingPath = join(
    supervisorReleasesRoot(controllerHome),
    `.${releaseName}.staging-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(stagingPath, { recursive: true, mode: 0o700 });
  try {
    buildEntry(sourceRoot, 'src/runtime/supervisor/entry.ts', join(stagingPath, 'supervisor.js'));
    buildEntry(sourceRoot, 'src/cli/index.ts', join(stagingPath, 'repo-harness.js'));
    buildEntry(sourceRoot, 'src/runtime/control-plane/daemon-entry.ts', join(stagingPath, 'daemon.js'));
    buildEntry(sourceRoot, 'src/runtime/execution/workers/worker-entry.ts', join(stagingPath, 'worker.js'));
    buildEntry(sourceRoot, 'src/runtime/execution/process-runtime/process-runner-entry.ts', join(stagingPath, 'process-runner.js'));
    buildEntry(sourceRoot, 'src/runtime/plugins/browser-handoff-host.ts', join(stagingPath, 'browser-handoff-host.js'));
    buildEntry(sourceRoot, 'src/runtime/plugins/browser-node-bridge-host.ts', join(stagingPath, 'browser-node-bridge-host.js'));
    const missing = supervisorReleaseClosureMissing(stagingPath);
    if (missing.length > 0) {
      throw new Error(`SUPERVISOR_RELEASE_CLOSURE_INCOMPLETE: staged release is missing required executables: ${missing.join(', ')}`);
    }
    verifySupervisorReleaseExecutionCanary({ releasePath: stagingPath, cwd: sourceRoot, executionMode: 'standalone-binary' });
    const artifactIdentity = releaseArtifactHash(stagingPath);
    writeFileSync(join(stagingPath, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 3,
      executionMode: 'standalone-binary',
      releaseRevision: revision,
      sourceCommit: identity.sourceCommit,
      sourceRoot,
      cleanWorkspace: identity.cleanWorkspace,
      dirtyRuntimePaths: identity.dirtyRuntimePaths,
      artifactHash: artifactIdentity.artifactHash,
      artifacts: artifactIdentity.artifacts,
      builtAt: new Date().toISOString(),
      entrypoint: 'supervisor.js',
      runtimeEntrypoint: 'repo-harness.js',
      daemonEntrypoint: 'daemon.js',
      workerEntrypoint: 'worker.js',
      processRunnerEntrypoint: 'process-runner.js',
      browserHandoffHostEntrypoint: 'browser-handoff-host.js',
      browserNodeBridgeHostEntrypoint: 'browser-node-bridge-host.js',
      capabilities: ['staged_rollout_release', 'browser_handoff_host', 'browser_node_cdp_bridge', 'independent_process_runner', 'reproducible_release_manifest', 'process_runner_canary'],
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    for (const executable of RELEASE_EXECUTABLES) {
      try { chmodSync(join(stagingPath, executable), 0o700); } catch { /* best effort */ }
    }
    // The final release path becomes visible only after every executable,
    // manifest digest and process-runner canary has succeeded.
    renameSync(stagingPath, releasePath);
    return {
      controllerHome,
      sourceRoot,
      releaseRevision: revision,
      sourceCommit: identity.sourceCommit,
      cleanWorkspace: identity.cleanWorkspace,
      artifactHash: artifactIdentity.artifactHash,
      executionMode: 'standalone-binary',
      releasePath,
    };
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

function assertPublishableRelease(
  release: NonNullable<ReturnType<typeof readSupervisorRelease>>,
  canaryCwd: string,
  allowUnreproducibleReleaseForTests = false,
): void {
  if (allowUnreproducibleReleaseForTests) return;
  // Explicit execution-surface closure: every entrypoint must exist and be
  // non-empty. The artifact hash below would also fail on a missing file, but
  // this check reports exactly which executables are missing instead of a
  // generic hash mismatch, and it guards releases written by older tooling.
  const missing = supervisorReleaseClosureMissing(release.releasePath);
  if (missing.length > 0) {
    throw new Error(`SUPERVISOR_RELEASE_CLOSURE_INCOMPLETE: immutable release is missing required executables: ${missing.join(', ')}`);
  }
  const failures: string[] = [];
  if (!release.sourceCommit) failures.push('sourceCommit missing');
  if (release.cleanWorkspace !== true) failures.push(`cleanWorkspace=${String(release.cleanWorkspace)}`);
  if (!release.artifactHash) failures.push('artifactHash missing');
  if (release.artifactHash) {
    try {
      const actual = releaseArtifactHash(release.releasePath).artifactHash;
      if (actual !== release.artifactHash) failures.push('artifactHash mismatch');
    } catch (error) {
      failures.push(`artifactHash unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (release.releaseRevision?.includes('-dirty')) failures.push(`releaseRevision=${release.releaseRevision}`);
  if (failures.length > 0) {
    throw new Error(`SUPERVISOR_RELEASE_NOT_REPRODUCIBLE: refusing to publish Supervisor Release (${failures.join('; ')})`);
  }
  verifySupervisorReleaseExecutionCanary({ releasePath: release.releasePath, cwd: canaryCwd, executionMode: release.executionMode });
}

export function publishSupervisorRelease(input: { controllerHome: string; repoRoot: string; releasePath: string; allowUnreproducibleReleaseForTests?: boolean }): SupervisorInstallResult {
  const controllerHome = resolve(input.controllerHome);
  const releasePath = assertOwnedReleasePath(controllerHome, input.releasePath);
  const release = readSupervisorRelease(releasePath);
  if (!release) throw new Error('SUPERVISOR_STAGED_RELEASE_INVALID');
  assertPublishableRelease(release, input.repoRoot, input.allowUnreproducibleReleaseForTests === true);
  const sourceRoot = publishRuntimeSourceRoot({ controllerHome, repoRoot: input.repoRoot, release });
  const revision = release.releaseRevision ?? `local-${Date.now()}`;
  const previous = readCurrentRelease(controllerHome);
  const bootstrapPath = installFixedSupervisorBootstrap(controllerHome, sourceRoot, input.repoRoot);
  const label = serviceLabel(controllerHome);
  const launchdDir = join(supervisorRoot(controllerHome), 'launchd');
  const systemdDir = join(supervisorRoot(controllerHome), 'systemd');
  mkdirSync(launchdDir, { recursive: true, mode: 0o700 });
  mkdirSync(systemdDir, { recursive: true, mode: 0o700 });
  const launchdPlistPath = join(launchdDir, `${label}.plist`);
  const systemdUnitPath = join(systemdDir, supervisorSystemdUnitName(controllerHome));
  writeFileSync(launchdPlistPath, renderLaunchdSupervisorPlist({
    label,
    bootstrapPath,
    controllerHome,
    logPath: join(supervisorLogsRoot(controllerHome), 'launchd.log'),
  }), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(systemdUnitPath, renderSystemdSupervisorUnit({
    bootstrapPath,
    controllerHome,
  }), { encoding: 'utf8', mode: 0o600 });
  // The active pointer is the final publication step. Every immutable
  // executable, manifest, canary and service definition must exist first.
  publishCurrentRelease(controllerHome, releasePath, previous);
  return {
    controllerHome,
    releaseRevision: revision,
    ...(release.sourceCommit ? { sourceCommit: release.sourceCommit } : {}),
    ...(release.cleanWorkspace !== undefined ? { cleanWorkspace: release.cleanWorkspace } : {}),
    ...(release.artifactHash ? { artifactHash: release.artifactHash } : {}),
    releasePath,
    currentPath: join(supervisorRoot(controllerHome), 'current'),
    ...(previous ? { previousPath: previous } : {}),
    bootstrapPath,
    launchdPlistPath,
    systemdUnitPath,
  };
}

export function installSupervisorRelease(input: { controllerHome: string; repoRoot: string; sourceRoot?: string; allowDirtyRuntimeSourceForTests?: boolean; allowUnreproducibleReleaseForTests?: boolean }): SupervisorInstallResult {
  const staged = stageSupervisorRelease(input);
  return publishSupervisorRelease({
    controllerHome: staged.controllerHome,
    repoRoot: input.repoRoot,
    releasePath: staged.releasePath,
    allowUnreproducibleReleaseForTests: input.allowUnreproducibleReleaseForTests,
  });
}

export function supervisorServiceLabel(controllerHome: string): string {
  return serviceLabel(controllerHome);
}


export interface SupervisorRegisteredServiceStartResult {
  managed: boolean;
  platform: string;
  target?: string;
  reason?: string;
}

function currentUserId(): number | undefined {
  if (typeof process.getuid === 'function') return process.getuid();
  const result = runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1_024 });
  const value = Number(result.stdout.trim());
  return result.ok && Number.isInteger(value) ? value : undefined;
}

/** Start an already-loaded OS service without creating a second detached owner. */
export function startRegisteredSupervisorService(controllerHome: string): SupervisorRegisteredServiceStartResult {
  if (process.platform === 'darwin') {
    const uid = currentUserId();
    if (uid === undefined) return { managed: false, platform: 'launchd', reason: 'uid_unavailable' };
    const target = `gui/${uid}/${serviceLabel(controllerHome)}`;
    const loaded = runProcess('launchctl', ['print', target], { timeoutMs: 5_000, maxOutputBytes: 8_192 });
    if (!loaded.ok) return { managed: false, platform: 'launchd', target, reason: 'not_loaded' };
    const started = runProcess('launchctl', ['kickstart', target], { timeoutMs: 15_000, maxOutputBytes: 20_000 });
    if (!started.ok && !/already|in progress/i.test(`${started.stderr}\n${started.stdout}`)) {
      throw new Error(`SUPERVISOR_LAUNCHD_START_FAILED: ${started.stderr || started.stdout}`);
    }
    return { managed: true, platform: 'launchd', target };
  }
  if (process.platform === 'linux') {
    const unit = supervisorSystemdUnitName(controllerHome);
    const loaded = runProcess('systemctl', ['--user', 'is-enabled', unit], { timeoutMs: 5_000, maxOutputBytes: 8_192 });
    if (!loaded.ok) return { managed: false, platform: 'systemd', target: unit, reason: 'not_enabled' };
    const started = runProcess('systemctl', ['--user', 'start', unit], { timeoutMs: 15_000, maxOutputBytes: 20_000 });
    if (!started.ok) throw new Error(`SUPERVISOR_SYSTEMD_START_FAILED: ${started.stderr || started.stdout}`);
    return { managed: true, platform: 'systemd', target: unit };
  }
  return { managed: false, platform: process.platform, reason: 'unsupported_platform' };
}
