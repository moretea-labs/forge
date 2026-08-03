import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { writeJsonAtomic } from '../shared/json-files';

export const RECOVERY_RELEASE_BINARIES = [
  'repo-harness-recovery',
  'repo-harness-recovery-gateway',
  'repo-harness-recovery-watchdog',
] as const;

export const RECOVERY_RELEASE_ROLE_CANARY_ARG = '--repo-harness-release-role-canary';

export type RecoveryReleaseBinary = (typeof RECOVERY_RELEASE_BINARIES)[number];
export type RecoveryRuntimeRole = 'gateway' | 'watchdog';
export const RECOVERY_AGENT_PROMPT = 'pi-recovery.md' as const;

export interface RecoveryReleaseManifest {
  schemaVersion: 1;
  releaseRevision: string;
  sourceCommit: string;
  sourceRoot: string;
  cleanWorkspace: boolean;
  builtAt: string;
  legacy?: boolean;
  artifacts: Record<RecoveryReleaseBinary, { sha256: string }>;
  resources?: Partial<Record<typeof RECOVERY_AGENT_PROMPT, { sha256: string }>>;
}

export interface RecoveryReleaseDescriptor {
  releasePath: string;
  releaseRevision: string;
  sourceCommit: string;
  sourceRoot: string;
  cleanWorkspace: boolean;
  manifestSha256: string;
  artifacts: RecoveryReleaseManifest['artifacts'];
  resources: NonNullable<RecoveryReleaseManifest['resources']>;
  legacy: boolean;
}

export interface RecoveryRuntimeIdentity {
  schemaVersion: 1;
  role: RecoveryRuntimeRole;
  pid: number;
  startedAt: string;
  releasePath: string;
  releaseRevision: string;
  sourceCommit: string;
  manifestSha256: string;
}

export function recoveryRoot(controllerHome: string): string {
  const resolved = resolve(controllerHome);
  let canonical = resolved;
  try { canonical = realpathSync(resolved); } catch { /* fresh controller home */ }
  return join(canonical, 'recovery');
}

export function recoveryReleasesRoot(controllerHome: string): string {
  return join(recoveryRoot(controllerHome), 'releases');
}

export function recoveryCurrentPath(controllerHome: string): string {
  return join(recoveryRoot(controllerHome), 'current');
}

export function recoveryPreviousPath(controllerHome: string): string {
  return join(recoveryRoot(controllerHome), 'previous');
}

export function recoveryRuntimeStatePath(controllerHome: string, role: RecoveryRuntimeRole): string {
  return join(recoveryRoot(controllerHome), 'state', `${role}-runtime.json`);
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function manifestPath(releasePath: string): string {
  return join(resolve(releasePath), 'manifest.json');
}

function releaseLink(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined;
  }
}

export function readRecoveryRelease(path: string | undefined): RecoveryReleaseDescriptor | undefined {
  if (!path) return undefined;
  try {
    const releasePath = realpathSync(path);
    const bytes = readFileSync(manifestPath(releasePath));
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<RecoveryReleaseManifest>;
    if (parsed.schemaVersion !== 1) return undefined;
    if (typeof parsed.releaseRevision !== 'string' || !parsed.releaseRevision.trim()) return undefined;
    if (typeof parsed.sourceCommit !== 'string' || !parsed.sourceCommit.trim()) return undefined;
    if (typeof parsed.sourceRoot !== 'string' || !parsed.sourceRoot.trim()) return undefined;
    if (typeof parsed.cleanWorkspace !== 'boolean') return undefined;
    if (!parsed.artifacts || typeof parsed.artifacts !== 'object') return undefined;
    const artifacts = {} as RecoveryReleaseManifest['artifacts'];
    for (const binary of RECOVERY_RELEASE_BINARIES) {
      const expected = parsed.artifacts[binary]?.sha256;
      const binaryPath = join(releasePath, binary);
      if (typeof expected !== 'string' || !existsSync(binaryPath) || fileSha256(binaryPath) !== expected) return undefined;
      artifacts[binary] = { sha256: expected };
    }
    const resources: NonNullable<RecoveryReleaseManifest['resources']> = {};
    const promptHash = parsed.resources?.[RECOVERY_AGENT_PROMPT]?.sha256;
    if (promptHash !== undefined) {
      const promptPath = join(releasePath, RECOVERY_AGENT_PROMPT);
      if (typeof promptHash !== 'string' || !existsSync(promptPath) || fileSha256(promptPath) !== promptHash) return undefined;
      resources[RECOVERY_AGENT_PROMPT] = { sha256: promptHash };
    }
    return {
      releasePath,
      releaseRevision: parsed.releaseRevision,
      sourceCommit: parsed.sourceCommit,
      sourceRoot: resolve(parsed.sourceRoot),
      cleanWorkspace: parsed.cleanWorkspace,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
      artifacts,
      resources,
      legacy: parsed.legacy === true,
    };
  } catch {
    return undefined;
  }
}

export function readCurrentRecoveryRelease(controllerHome: string): RecoveryReleaseDescriptor | undefined {
  return readRecoveryRelease(releaseLink(recoveryCurrentPath(controllerHome)));
}

export function readPreviousRecoveryRelease(controllerHome: string): RecoveryReleaseDescriptor | undefined {
  return readRecoveryRelease(releaseLink(recoveryPreviousPath(controllerHome)));
}

function atomicReleaseLink(linkPath: string, releasePath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true, mode: 0o700 });
  const temporary = `${linkPath}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(relative(dirname(linkPath), resolve(releasePath)), temporary, 'dir');
  renameSync(temporary, linkPath);
}

function assertRecoveryReleaseContained(controllerHome: string, release: RecoveryReleaseDescriptor): void {
  const releasesRoot = resolve(recoveryReleasesRoot(controllerHome));
  if (!release.releasePath.startsWith(`${releasesRoot}${sep}`)) {
    throw new Error(`RECOVERY_RELEASE_OUTSIDE_AUTHORITY: ${release.releasePath}`);
  }
}

export function publishRecoveryRelease(
  controllerHome: string,
  releasePath: string,
  previousPath?: string,
): RecoveryReleaseDescriptor {
  const release = readRecoveryRelease(releasePath);
  if (!release) throw new Error('RECOVERY_RELEASE_INVALID');
  assertRecoveryReleaseContained(controllerHome, release);
  if (previousPath && resolve(previousPath) !== release.releasePath) {
    const previous = readRecoveryRelease(previousPath);
    if (!previous) throw new Error('RECOVERY_PREVIOUS_RELEASE_INVALID');
    assertRecoveryReleaseContained(controllerHome, previous);
    atomicReleaseLink(recoveryPreviousPath(controllerHome), previous.releasePath);
  }
  atomicReleaseLink(recoveryCurrentPath(controllerHome), release.releasePath);
  return release;
}

export function publishRecoveryCompatibilityLinks(controllerHome: string): void {
  const current = readCurrentRecoveryRelease(controllerHome);
  if (!current) throw new Error('RECOVERY_CURRENT_RELEASE_INVALID');
  assertRecoveryReleaseContained(controllerHome, current);
  const binRoot = join(recoveryRoot(controllerHome), 'bin');
  mkdirSync(binRoot, { recursive: true, mode: 0o700 });
  for (const binary of RECOVERY_RELEASE_BINARIES) {
    const destination = join(binRoot, binary);
    const temporary = `${destination}.${process.pid}.tmp`;
    rmSync(temporary, { force: true });
    symlinkSync(join('..', 'current', binary), temporary);
    renameSync(temporary, destination);
  }
}

export function writeRecoveryReleaseManifest(releasePath: string, manifest: RecoveryReleaseManifest): void {
  mkdirSync(releasePath, { recursive: true, mode: 0o700 });
  const path = manifestPath(releasePath);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
}

export function recoveryIdentityFromExecutable(executable = process.execPath): Omit<RecoveryRuntimeIdentity, 'role' | 'pid' | 'startedAt'> | undefined {
  try {
    const release = readRecoveryRelease(dirname(realpathSync(executable)));
    if (!release) return undefined;
    return {
      schemaVersion: 1,
      releasePath: release.releasePath,
      releaseRevision: release.releaseRevision,
      sourceCommit: release.sourceCommit,
      manifestSha256: release.manifestSha256,
    };
  } catch {
    return undefined;
  }
}

export function writeRecoveryRuntimeIdentity(
  controllerHome: string,
  role: RecoveryRuntimeRole,
  executable = process.execPath,
): RecoveryRuntimeIdentity | undefined {
  const release = recoveryIdentityFromExecutable(executable);
  if (!release) return undefined;
  const state: RecoveryRuntimeIdentity = {
    ...release,
    role,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(recoveryRuntimeStatePath(controllerHome, role), state);
  return state;
}

export function readRecoveryRuntimeIdentity(controllerHome: string, role: RecoveryRuntimeRole): RecoveryRuntimeIdentity | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recoveryRuntimeStatePath(controllerHome, role), 'utf8')) as RecoveryRuntimeIdentity;
    if (parsed.schemaVersion !== 1 || parsed.role !== role || !Number.isInteger(parsed.pid)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
