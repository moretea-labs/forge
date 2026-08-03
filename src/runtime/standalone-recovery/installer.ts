import { createHash, randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { runProcess, type ProcessRunResult } from '../../effects/process-runner';
import {
  installLaunchAgent,
  launchAgentPath,
  safeLaunchdHandoff,
  type SafeHandoffResult,
} from '../../cli/controller/launch-agents';
import { isProcessAlive } from '../shared/process-tree';
import { initializeStandaloneRecovery, loadRecoveryConfig, type PublicTunnelServiceConfig, type RecoveryConfig } from './core';
import {
  RECOVERY_RELEASE_BINARIES,
  publishRecoveryCompatibilityLinks,
  publishRecoveryRelease,
  readCurrentRecoveryRelease,
  readPreviousRecoveryRelease,
  readRecoveryRelease,
  readRecoveryRuntimeIdentity,
  recoveryCurrentPath,
  recoveryPreviousPath,
  recoveryReleasesRoot,
  recoveryRoot,
  writeRecoveryReleaseManifest,
  type RecoveryReleaseDescriptor,
  type RecoveryReleaseManifest,
  type RecoveryRuntimeRole,
} from './release';

export const RECOVERY_GATEWAY_LABEL = 'com.moretea.repo-harness-recovery-gateway';
export const RECOVERY_WATCHDOG_LABEL = 'com.moretea.repo-harness-recovery-watchdog';

const RECOVERY_RELEASE_SOURCE_PATHS = [
  'src/runtime/standalone-recovery',
  'src/cli/controller/launch-agents.ts',
  'src/effects/process-runner.ts',
  'src/runtime/shared/process-tree.ts',
  'src/runtime/shared/json-files.ts',
  'scripts/install-standalone-recovery.ts',
  'scripts/load-standalone-recovery.sh',
  'package.json',
  'bun.lock',
] as const;

export interface RecoverySourceIdentity {
  sourceCommit: string;
  releaseRevision: string;
  cleanWorkspace: true;
  sourceRoot: string;
}

export interface StagedRecoveryRelease {
  release: RecoveryReleaseDescriptor;
  canary: { ok: true; detail: string };
}

export interface RecoveryActivationVerification {
  ok: boolean;
  expectedReleaseRevision: string;
  failures: string[];
  gatewayPid?: number;
  watchdogPid?: number;
  healthStatus?: number;
}

export interface RecoveryActivationResult {
  release: RecoveryReleaseDescriptor;
  previous?: RecoveryReleaseDescriptor;
  migratedLegacy?: RecoveryReleaseDescriptor;
  noOp?: boolean;
  handoff?: {
    gateway: SafeHandoffResult;
    watchdog: SafeHandoffResult;
  };
  verification: RecoveryActivationVerification;
  rollback?: {
    release: RecoveryReleaseDescriptor;
    verification: RecoveryActivationVerification;
  };
}

export interface RecoveryInstallResult {
  controllerHome: string;
  staged: StagedRecoveryRelease;
  activated?: RecoveryActivationResult;
  config: RecoveryConfig;
}

export interface RecoveryInstallerDependencies {
  now?: () => number;
  uuid?: () => string;
  compileBinary?: (input: { sourceRoot: string; outputPath: string }) => ProcessRunResult;
  runCanary?: (input: { binaryPath: string; controllerHome: string }) => ProcessRunResult;
  installAgent?: typeof installLaunchAgent;
  handoff?: typeof safeLaunchdHandoff;
  verify?: (input: {
    controllerHome: string;
    config: RecoveryConfig;
    expectedRelease: RecoveryReleaseDescriptor;
    timeoutMs?: number;
  }) => Promise<RecoveryActivationVerification>;
  currentPid?: (controllerHome: string, role: RecoveryRuntimeRole) => number | undefined;
  servicePid?: (controllerHome: string, role: RecoveryRuntimeRole) => number | undefined;
  uid?: () => number;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitText(root: string, args: string[]): string {
  const result = runProcess('git', ['-C', root, ...args], { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
  if (!result.ok) throw new Error(`RECOVERY_RELEASE_GIT_FAILED: ${result.stderr || result.stdout || result.error}`.slice(0, 2_000));
  return result.stdout.trim();
}

export function recoverySourceIdentity(sourceRoot: string): RecoverySourceIdentity {
  const root = resolve(sourceRoot);
  const sourceCommit = gitText(root, ['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error('RECOVERY_RELEASE_SOURCE_COMMIT_INVALID');
  const dirty = gitText(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...RECOVERY_RELEASE_SOURCE_PATHS]);
  if (dirty) throw new Error(`RECOVERY_RELEASE_DIRTY_SOURCE: ${dirty.split(/\r?\n/).slice(0, 20).join(', ')}`);
  return { sourceCommit, releaseRevision: sourceCommit, cleanWorkspace: true, sourceRoot: root };
}

function defaultCompileBinary(input: { sourceRoot: string; outputPath: string }): ProcessRunResult {
  const configured = process.env.REPO_HARNESS_BUN_BIN?.trim();
  const bun = configured || (process.versions.bun && /(?:^|\/)bun(?:$|-)/.test(process.execPath) ? process.execPath : 'bun');
  return runProcess(bun, [
    'build',
    join(input.sourceRoot, 'src/runtime/standalone-recovery/entry.ts'),
    '--compile',
    '--outfile',
    input.outputPath,
  ], { cwd: input.sourceRoot, timeoutMs: 180_000, maxOutputBytes: 512 * 1024 });
}

function defaultRunCanary(input: { binaryPath: string; controllerHome: string }): ProcessRunResult {
  return runProcess(input.binaryPath, ['status', '--controller-home', input.controllerHome], {
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    replaceEnv: true,
  });
}

function completeArtifacts(releasePath: string): RecoveryReleaseManifest['artifacts'] {
  const artifacts = {} as RecoveryReleaseManifest['artifacts'];
  for (const binary of RECOVERY_RELEASE_BINARIES) artifacts[binary] = { sha256: sha256(join(releasePath, binary)) };
  return artifacts;
}

export function stageRecoveryRelease(input: {
  controllerHome: string;
  sourceRoot: string;
}, dependencies: RecoveryInstallerDependencies = {}): StagedRecoveryRelease {
  const identity = recoverySourceIdentity(input.sourceRoot);
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const releasesRoot = recoveryReleasesRoot(input.controllerHome);
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  const staging = join(releasesRoot, `.staging-${identity.releaseRevision}-${uuid().slice(0, 12)}`);
  const finalPath = join(releasesRoot, `${now()}-${identity.releaseRevision}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const primary = join(staging, RECOVERY_RELEASE_BINARIES[0]);
    const compile = (dependencies.compileBinary ?? defaultCompileBinary)({ sourceRoot: identity.sourceRoot, outputPath: primary });
    if (!compile.ok) throw new Error(`RECOVERY_RELEASE_BUILD_FAILED: ${compile.stderr || compile.stdout || compile.error}`.slice(0, 2_000));
    chmodSync(primary, 0o700);
    for (const binary of RECOVERY_RELEASE_BINARIES.slice(1)) {
      const destination = join(staging, binary);
      copyFileSync(primary, destination);
      chmodSync(destination, 0o700);
    }
    writeRecoveryReleaseManifest(staging, {
      schemaVersion: 1,
      ...identity,
      builtAt: new Date(now()).toISOString(),
      artifacts: completeArtifacts(staging),
    });
    const canaryResult = (dependencies.runCanary ?? defaultRunCanary)({ binaryPath: primary, controllerHome: resolve(input.controllerHome) });
    if (!canaryResult.ok) throw new Error(`RECOVERY_RELEASE_CANARY_FAILED: ${canaryResult.stderr || canaryResult.stdout || canaryResult.error}`.slice(0, 2_000));
    renameSync(staging, finalPath);
    const release = readRecoveryRelease(finalPath);
    if (!release) throw new Error('RECOVERY_RELEASE_FINAL_VALIDATION_FAILED');
    return { release, canary: { ok: true, detail: canaryResult.stdout.trim() || 'status canary passed' } };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function flatBinaryPaths(controllerHome: string): Record<(typeof RECOVERY_RELEASE_BINARIES)[number], string> {
  const root = join(recoveryRoot(controllerHome), 'bin');
  return Object.fromEntries(RECOVERY_RELEASE_BINARIES.map((binary) => [binary, join(root, binary)])) as Record<(typeof RECOVERY_RELEASE_BINARIES)[number], string>;
}

function flatBinaryIsLegacy(path: string): boolean {
  try { return !lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export function captureLegacyRecoveryRelease(
  controllerHome: string,
  dependencies: Pick<RecoveryInstallerDependencies, 'now' | 'uuid'> = {},
): RecoveryReleaseDescriptor | undefined {
  if (readCurrentRecoveryRelease(controllerHome)) return undefined;
  const paths = flatBinaryPaths(controllerHome);
  const present = RECOVERY_RELEASE_BINARIES.filter((binary) => flatBinaryIsLegacy(paths[binary]));
  if (present.length === 0) return undefined;
  if (present.length !== RECOVERY_RELEASE_BINARIES.length) throw new Error('RECOVERY_LEGACY_RELEASE_INCOMPLETE');
  const aggregate = createHash('sha256');
  for (const binary of RECOVERY_RELEASE_BINARIES) aggregate.update(binary).update('\0').update(sha256(paths[binary])).update('\0');
  const revision = `legacy-${aggregate.digest('hex').slice(0, 24)}`;
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const capturedAt = now();
  const releasesRoot = recoveryReleasesRoot(controllerHome);
  const stagingPath = join(releasesRoot, `.staging-${revision}-${uuid().slice(0, 12)}`);
  const releasePath = join(releasesRoot, `${capturedAt}-${revision}`);
  mkdirSync(stagingPath, { recursive: true, mode: 0o700 });
  try {
    for (const binary of RECOVERY_RELEASE_BINARIES) {
      copyFileSync(paths[binary], join(stagingPath, binary));
      chmodSync(join(stagingPath, binary), 0o700);
    }
    writeRecoveryReleaseManifest(stagingPath, {
      schemaVersion: 1,
      releaseRevision: revision,
      sourceCommit: 'legacy-unattributed',
      sourceRoot: releasePath,
      cleanWorkspace: false,
      builtAt: new Date(capturedAt).toISOString(),
      legacy: true,
      artifacts: completeArtifacts(stagingPath),
    });
    if (!readRecoveryRelease(stagingPath)) throw new Error('RECOVERY_LEGACY_RELEASE_CAPTURE_FAILED');
    renameSync(stagingPath, releasePath);
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
  const release = readRecoveryRelease(releasePath);
  if (!release) throw new Error('RECOVERY_LEGACY_RELEASE_FINAL_VALIDATION_FAILED');
  return release;
}

function recoveryPlist(input: {
  label: string;
  executable: string;
  command: RecoveryRuntimeRole;
  controllerHome: string;
  logPath: string;
}): string {
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const argumentsList = [
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    input.executable, input.command, '--controller-home', input.controllerHome,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(input.label)}</string><key>ProgramArguments</key><array>${argumentsList.map((argument) => `<string>${xml(argument)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(input.logPath)}</string><key>StandardErrorPath</key><string>${xml(input.logPath)}</string></dict></plist>\n`;
}

function launchctlText(args: string[]): string {
  const result = runProcess('launchctl', args, { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  return result.ok ? result.stdout : '';
}

function launchdCurrentPid(role: RecoveryRuntimeRole): number | undefined {
  if (process.platform !== 'darwin') return undefined;
  const uid = typeof process.getuid === 'function' ? process.getuid() : Number.NaN;
  const label = role === 'gateway' ? RECOVERY_GATEWAY_LABEL : RECOVERY_WATCHDOG_LABEL;
  const output = Number.isInteger(uid) ? launchctlText(['print', `gui/${uid}/${label}`]) : '';
  const match = output.match(/\bpid\s*=\s*(\d+)/);
  const pid = match ? Number(match[1]) : undefined;
  return pid && isProcessAlive(pid) ? pid : undefined;
}

function defaultCurrentPid(controllerHome: string, role: RecoveryRuntimeRole): number | undefined {
  const identity = readRecoveryRuntimeIdentity(controllerHome, role);
  if (identity && isProcessAlive(identity.pid)) return identity.pid;
  return launchdCurrentPid(role);
}

export async function verifyRecoveryReleaseActivation(input: {
  controllerHome: string;
  config: RecoveryConfig;
  expectedRelease: RecoveryReleaseDescriptor;
  timeoutMs?: number;
}, dependencies: Pick<RecoveryInstallerDependencies, 'servicePid'> = {}): Promise<RecoveryActivationVerification> {
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  let last: RecoveryActivationVerification = {
    ok: false,
    expectedReleaseRevision: input.expectedRelease.releaseRevision,
    failures: ['verification not started'],
  };
  while (Date.now() < deadline) {
    const failures: string[] = [];
    const current = readCurrentRecoveryRelease(input.controllerHome);
    if (!current || current.releasePath !== input.expectedRelease.releasePath || current.manifestSha256 !== input.expectedRelease.manifestSha256) {
      failures.push('Recovery current authority does not match expected release');
    }
    const gateway = readRecoveryRuntimeIdentity(input.controllerHome, 'gateway');
    const watchdog = readRecoveryRuntimeIdentity(input.controllerHome, 'watchdog');
    const observedPids: Partial<Record<RecoveryRuntimeRole, number>> = {};
    const servicePid = dependencies.servicePid ?? ((_controllerHome: string, role: RecoveryRuntimeRole) => launchdCurrentPid(role));
    for (const [role, identity] of [['gateway', gateway], ['watchdog', watchdog]] as const) {
      const managedPid = servicePid(input.controllerHome, role);
      if (!managedPid) failures.push(`${role} launchd PID is unavailable`);
      else observedPids[role] = managedPid;
      if (input.expectedRelease.legacy) continue;
      if (!identity) failures.push(`${role} runtime identity missing`);
      else {
        if (!isProcessAlive(identity.pid)) failures.push(`${role} PID ${identity.pid} is not alive`);
        if (managedPid !== undefined && identity.pid !== managedPid) failures.push(`${role} runtime identity PID does not match launchd PID`);
        if (identity.releasePath !== input.expectedRelease.releasePath) failures.push(`${role} release path mismatch`);
        if (identity.releaseRevision !== input.expectedRelease.releaseRevision) failures.push(`${role} release revision mismatch`);
        if (identity.manifestSha256 !== input.expectedRelease.manifestSha256) failures.push(`${role} manifest hash mismatch`);
      }
    }
    let healthStatus: number | undefined;
    try {
      const response = await fetch(`http://${input.config.gateway?.host ?? '127.0.0.1'}:${input.config.gateway?.port ?? 8787}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      healthStatus = response.status;
      const health = await response.json() as { status?: unknown; releaseRevision?: unknown; manifestSha256?: unknown };
      if (response.status !== 200 || health.status !== 'ok') failures.push(`gateway health HTTP ${response.status}`);
      if (!input.expectedRelease.legacy || health.releaseRevision !== undefined) {
        if (health.releaseRevision !== input.expectedRelease.releaseRevision) failures.push('gateway health release revision mismatch');
      }
      if (!input.expectedRelease.legacy || health.manifestSha256 !== undefined) {
        if (health.manifestSha256 !== input.expectedRelease.manifestSha256) failures.push('gateway health manifest hash mismatch');
      }
    } catch (error) {
      failures.push(`gateway health unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    last = {
      ok: failures.length === 0,
      expectedReleaseRevision: input.expectedRelease.releaseRevision,
      failures,
      gatewayPid: observedPids.gateway,
      watchdogPid: observedPids.watchdog,
      healthStatus,
    };
    if (last.ok) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return last;
}

interface RecoveryReleaseLockRecord {
  schemaVersion?: 1;
  pid: number;
  instanceId: string;
  processStartTime?: string;
  acquiredAt: string;
  action?: string;
}

function processStartTime(pid: number): string | undefined {
  const result = runProcess('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 2_000, maxOutputBytes: 4_096 });
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

function readRecoveryReleaseLock(path: string): RecoveryReleaseLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RecoveryReleaseLockRecord;
    return Number.isInteger(parsed.pid) && typeof parsed.instanceId === 'string' && typeof parsed.acquiredAt === 'string'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function recoveryReleaseLockOwnerAlive(lock: RecoveryReleaseLockRecord): boolean {
  if (!isProcessAlive(lock.pid)) return false;
  if (!lock.processStartTime) return true;
  const observed = processStartTime(lock.pid);
  return observed === undefined || observed === lock.processStartTime;
}

function acquireRecoveryReleaseLock(controllerHome: string): { path: string; instanceId: string; close: () => void } {
  const path = join(recoveryRoot(controllerHome), 'locks', 'operation.lock');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const instanceId = `recovery-release-${randomUUID()}`;
  const record: RecoveryReleaseLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    instanceId,
    processStartTime: processStartTime(process.pid),
    acquiredAt: new Date().toISOString(),
    action: 'install_recovery_release',
  };
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(record));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readRecoveryReleaseLock(path);
      if (!existing) throw new Error('RECOVERY_OPERATION_LOCK_UNCERTAIN');
      if (recoveryReleaseLockOwnerAlive(existing)) throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
      const latest = readRecoveryReleaseLock(path);
      if (!latest || latest.instanceId !== existing.instanceId || recoveryReleaseLockOwnerAlive(latest)) {
        if (attempt === 1) throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
        continue;
      }
      try { writeFileSync(`${path}.stale-${Date.now()}-${existing.instanceId}`, readFileSync(path)); } catch { /* evidence best effort */ }
      rmSync(path, { force: true });
    }
  }
  if (fd === undefined) throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
  return {
    path,
    instanceId,
    close: () => {
      closeSync(fd);
      const current = readRecoveryReleaseLock(path);
      if (current?.instanceId === instanceId) rmSync(path, { force: true });
    },
  };
}

async function handoffRecoveryServices(input: {
  controllerHome: string;
  config: RecoveryConfig;
  expectedRelease: RecoveryReleaseDescriptor;
  dependencies: RecoveryInstallerDependencies;
}): Promise<{ gateway: SafeHandoffResult; watchdog: SafeHandoffResult; verification: RecoveryActivationVerification }> {
  if (process.platform !== 'darwin' && !input.dependencies.handoff) throw new Error('RECOVERY_RELEASE_ACTIVATION_REQUIRES_MACOS');
  const uid = (input.dependencies.uid ?? (() => typeof process.getuid === 'function' ? process.getuid() : Number.NaN))();
  if (!Number.isInteger(uid)) throw new Error('RECOVERY_LAUNCHD_UID_UNAVAILABLE');
  const domain = `gui/${uid}`;
  const installAgent = input.dependencies.installAgent ?? installLaunchAgent;
  const generated = (() => {
    const root = recoveryRoot(input.controllerHome);
    const generatedRoot = join(root, 'launchd');
    const auditRoot = join(root, 'audit');
    mkdirSync(generatedRoot, { recursive: true, mode: 0o700 });
    mkdirSync(auditRoot, { recursive: true, mode: 0o700 });
    const gatewayPath = join(generatedRoot, `${RECOVERY_GATEWAY_LABEL}.plist`);
    const watchdogPath = join(generatedRoot, `${RECOVERY_WATCHDOG_LABEL}.plist`);
    writeFileSync(gatewayPath, recoveryPlist({ label: RECOVERY_GATEWAY_LABEL, executable: join(recoveryCurrentPath(input.controllerHome), 'repo-harness-recovery-gateway'), command: 'gateway', controllerHome: resolve(input.controllerHome), logPath: join(auditRoot, 'gateway.log') }), { mode: 0o600 });
    writeFileSync(watchdogPath, recoveryPlist({ label: RECOVERY_WATCHDOG_LABEL, executable: join(recoveryCurrentPath(input.controllerHome), 'repo-harness-recovery-watchdog'), command: 'watchdog', controllerHome: resolve(input.controllerHome), logPath: join(auditRoot, 'watchdog.log') }), { mode: 0o600 });
    return {
      gateway: installAgent(gatewayPath, RECOVERY_GATEWAY_LABEL).path,
      watchdog: installAgent(watchdogPath, RECOVERY_WATCHDOG_LABEL).path,
    };
  })();
  const currentPid = input.dependencies.currentPid ?? defaultCurrentPid;
  const handoff = input.dependencies.handoff ?? safeLaunchdHandoff;
  const gateway = await handoff({
    label: RECOVERY_GATEWAY_LABEL,
    plistPath: generated.gateway,
    domain,
    oldPid: currentPid(input.controllerHome, 'gateway'),
    port: input.config.gateway?.port,
    maxBootoutWaitMs: 20_000,
    maxBootstrapRetry: 3,
  });
  if (!gateway.serviceRegistered || !gateway.pidWaitClean || !gateway.portWaitClean) {
    throw new Error('RECOVERY_GATEWAY_HANDOFF_FAILED');
  }
  const watchdog = await handoff({
    label: RECOVERY_WATCHDOG_LABEL,
    plistPath: generated.watchdog,
    domain,
    oldPid: currentPid(input.controllerHome, 'watchdog'),
    maxBootoutWaitMs: 20_000,
    maxBootstrapRetry: 3,
  });
  if (!watchdog.serviceRegistered || !watchdog.pidWaitClean) throw new Error('RECOVERY_WATCHDOG_HANDOFF_FAILED');
  const verification = await (input.dependencies.verify
    ?? ((verifyInput) => verifyRecoveryReleaseActivation(verifyInput, input.dependencies)))({
    controllerHome: input.controllerHome,
    config: input.config,
    expectedRelease: input.expectedRelease,
  });
  if (!verification.ok) throw new Error(`RECOVERY_RELEASE_VERIFICATION_FAILED: ${verification.failures.join('; ')}`);
  return { gateway, watchdog, verification };
}

function sameRecoveryReleasePayload(left: RecoveryReleaseDescriptor, right: RecoveryReleaseDescriptor): boolean {
  return left.releaseRevision === right.releaseRevision
    && left.sourceCommit === right.sourceCommit
    && left.cleanWorkspace === right.cleanWorkspace
    && RECOVERY_RELEASE_BINARIES.every((binary) => left.artifacts[binary].sha256 === right.artifacts[binary].sha256);
}

export async function activateRecoveryRelease(input: {
  controllerHome: string;
  config?: RecoveryConfig;
  candidate: RecoveryReleaseDescriptor;
}, dependencies: RecoveryInstallerDependencies = {}): Promise<RecoveryActivationResult> {
  const controllerHome = resolve(input.controllerHome);
  const config = input.config ?? loadRecoveryConfig(controllerHome);
  const lock = acquireRecoveryReleaseLock(controllerHome);
  const current = readCurrentRecoveryRelease(controllerHome);
  try {
    if (current && sameRecoveryReleasePayload(current, input.candidate)) {
      const verification = await (dependencies.verify
        ?? ((verifyInput) => verifyRecoveryReleaseActivation(verifyInput, dependencies)))({
        controllerHome,
        config,
        expectedRelease: current,
      });
      if (verification.ok) {
        return {
          release: current,
          previous: readPreviousRecoveryRelease(controllerHome),
          noOp: true,
          verification,
        };
      }
    }
    const previous = current ?? captureLegacyRecoveryRelease(controllerHome, dependencies);
    const migratedLegacy = previous?.legacy ? previous : undefined;
    publishRecoveryRelease(controllerHome, input.candidate.releasePath, previous?.releasePath);
    publishRecoveryCompatibilityLinks(controllerHome);
    try {
      const activated = await handoffRecoveryServices({ controllerHome, config, expectedRelease: input.candidate, dependencies });
      return { release: input.candidate, previous, migratedLegacy, handoff: { gateway: activated.gateway, watchdog: activated.watchdog }, verification: activated.verification };
    } catch (activationError) {
      if (!previous) throw activationError;
      publishRecoveryRelease(controllerHome, previous.releasePath, input.candidate.releasePath);
      publishRecoveryCompatibilityLinks(controllerHome);
      let rollbackResult: Awaited<ReturnType<typeof handoffRecoveryServices>>;
      try {
        rollbackResult = await handoffRecoveryServices({ controllerHome, config, expectedRelease: previous, dependencies });
      } catch (rollbackError) {
        throw new Error(
          `RECOVERY_RELEASE_ACTIVATION_FAILED: ${activationError instanceof Error ? activationError.message : String(activationError)}; `
          + `rollback to ${previous.releaseRevision} failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw new Error(
        `RECOVERY_RELEASE_ACTIVATION_FAILED_ROLLED_BACK: ${activationError instanceof Error ? activationError.message : String(activationError)}; `
        + `restored=${previous.releaseRevision}; gateway=${rollbackResult.verification.gatewayPid ?? 'unknown'}; watchdog=${rollbackResult.verification.watchdogPid ?? 'unknown'}`,
      );
    }
  } finally {
    lock.close();
  }
}

export async function installStandaloneRecovery(input: {
  controllerHome: string;
  repoRoot: string;
  sourceRoot?: string;
  port?: number;
  publicTunnelService?: PublicTunnelServiceConfig;
  stageOnly?: boolean;
}, dependencies: RecoveryInstallerDependencies = {}): Promise<RecoveryInstallResult> {
  const controllerHome = resolve(input.controllerHome);
  const sourceRoot = resolve(input.sourceRoot ?? input.repoRoot);
  const config = initializeStandaloneRecovery(controllerHome, input.port ?? 8787, input.publicTunnelService);
  const staged = stageRecoveryRelease({ controllerHome, sourceRoot }, dependencies);
  if (input.stageOnly) return { controllerHome, staged, config };
  const activated = await activateRecoveryRelease({ controllerHome, config, candidate: staged.release }, dependencies);
  return { controllerHome, staged, activated, config };
}

export function recoveryReleaseAuthoritySnapshot(controllerHome: string): {
  current?: RecoveryReleaseDescriptor;
  previous?: RecoveryReleaseDescriptor;
  currentPath: string;
  previousPath: string;
  gatewayLaunchAgent: string;
  watchdogLaunchAgent: string;
} {
  return {
    current: readCurrentRecoveryRelease(controllerHome),
    previous: readPreviousRecoveryRelease(controllerHome),
    currentPath: recoveryCurrentPath(controllerHome),
    previousPath: recoveryPreviousPath(controllerHome),
    gatewayLaunchAgent: launchAgentPath(RECOVERY_GATEWAY_LABEL),
    watchdogLaunchAgent: launchAgentPath(RECOVERY_WATCHDOG_LABEL),
  };
}
