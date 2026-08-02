import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { sanitizeFileComponent } from '../shared/json-files';

/**
 * Every executable an immutable runtime release must contain for the execution
 * surface to work. The supervisor, gateway and daemon alone are not enough:
 * Unified Process Runtime commands launch `process-runner.js` from the release.
 */
export const SUPERVISOR_RELEASE_ENTRYPOINTS = [
  'supervisor.js',
  'repo-harness.js',
  'daemon.js',
  'worker.js',
  'process-runner.js',
  'browser-handoff-host.js',
  'browser-node-bridge-host.js',
] as const;

/** Executables missing or empty in a release directory; empty array means complete. */
export function supervisorReleaseClosureMissing(releasePath: string): string[] {
  const missing: string[] = [];
  for (const entrypoint of SUPERVISOR_RELEASE_ENTRYPOINTS) {
    const path = join(releasePath, entrypoint);
    try {
      if (!existsSync(path) || statSync(path).size === 0) missing.push(entrypoint);
    } catch {
      missing.push(entrypoint);
    }
  }
  return missing;
}

export function supervisorRoot(controllerHome: string): string {
  return join(resolve(controllerHome), 'supervisor');
}

export function supervisorReleasesRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'releases');
}

export function supervisorStatePath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'state.json');
}

export function supervisorLockPath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'supervisor.lock');
}

export function supervisorControlSocketPath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'control.sock');
}

export function supervisorOperationsRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'operations');
}

export function supervisorOperationPath(controllerHome: string, operationId: string): string {
  return join(supervisorOperationsRoot(controllerHome), `${sanitizeFileComponent(operationId)}.json`);
}

export function supervisorOperationLockPath(controllerHome: string): string {
  return join(supervisorOperationsRoot(controllerHome), '.schedule.lock');
}

export function supervisorIncidentsRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'incidents');
}

export function supervisorLogsRoot(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'logs');
}

export function supervisorLogPath(controllerHome: string): string {
  return join(supervisorLogsRoot(controllerHome), 'supervisor.log');
}

export function supervisorRescueAuthPath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'rescue-auth.json');
}

export function supervisorCurrentReleasePath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'current');
}

export function supervisorPreviousReleasePath(controllerHome: string): string {
  return join(supervisorRoot(controllerHome), 'previous');
}

export function ensureStableSupervisorLayout(controllerHome: string): string {
  const home = ensureControllerHome(controllerHome);
  const root = supervisorRoot(home);
  for (const directory of [root, supervisorReleasesRoot(home), supervisorOperationsRoot(home), supervisorIncidentsRoot(home), supervisorLogsRoot(home)]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  }
  return root;
}

function readReleaseLink(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined;
  }
}

export interface SupervisorReleaseDescriptor {
  releasePath: string;
  sourceRoot?: string;
  releaseRevision?: string;
  sourceCommit?: string;
  cleanWorkspace?: boolean;
  artifactHash?: string;
  supervisorExecutable: string;
  runtimeExecutable: string;
  daemonExecutable: string;
}

export function readSupervisorRelease(releasePath: string | undefined): SupervisorReleaseDescriptor | undefined {
  if (!releasePath) return undefined;
  const resolved = resolve(releasePath);
  const supervisorExecutable = join(resolved, 'supervisor.js');
  const runtimeExecutable = join(resolved, 'repo-harness.js');
  const daemonExecutable = join(resolved, 'daemon.js');
  if (![supervisorExecutable, runtimeExecutable, daemonExecutable].every((path) => existsSync(path))) return undefined;
  let manifest: Record<string, unknown> = {};
  try { manifest = JSON.parse(readFileSync(join(resolved, 'manifest.json'), 'utf8')) as Record<string, unknown>; } catch { /* optional compatibility manifest */ }
  return {
    releasePath: resolved,
    supervisorExecutable,
    runtimeExecutable,
    daemonExecutable,
    ...(typeof manifest.sourceRoot === 'string' ? { sourceRoot: resolve(manifest.sourceRoot) } : {}),
    ...(typeof manifest.releaseRevision === 'string' ? { releaseRevision: manifest.releaseRevision } : {}),
    ...(typeof manifest.sourceCommit === 'string' ? { sourceCommit: manifest.sourceCommit } : {}),
    ...(typeof manifest.cleanWorkspace === 'boolean' ? { cleanWorkspace: manifest.cleanWorkspace } : {}),
    ...(typeof manifest.artifactHash === 'string' ? { artifactHash: manifest.artifactHash } : {}),
  };
}

export function readCurrentRelease(controllerHome: string): string | undefined {
  return readReleaseLink(supervisorCurrentReleasePath(controllerHome));
}

export function readPreviousRelease(controllerHome: string): string | undefined {
  return readReleaseLink(supervisorPreviousReleasePath(controllerHome));
}

export function readCurrentSupervisorRelease(controllerHome: string): SupervisorReleaseDescriptor | undefined {
  return readSupervisorRelease(readCurrentRelease(controllerHome));
}

export function readPreviousSupervisorRelease(controllerHome: string): SupervisorReleaseDescriptor | undefined {
  return readSupervisorRelease(readPreviousRelease(controllerHome));
}

export function isStableSupervisorInstalled(controllerHome: string): boolean {
  return Boolean(readCurrentSupervisorRelease(controllerHome));
}

export function publishCurrentRelease(controllerHome: string, releasePath: string, previous?: string): void {
  ensureStableSupervisorLayout(controllerHome);
  const current = supervisorCurrentReleasePath(controllerHome);
  const previousPath = supervisorPreviousReleasePath(controllerHome);
  const temporaryCurrent = `${current}.${process.pid}.tmp`;
  const temporaryPrevious = `${previousPath}.${process.pid}.tmp`;
  if (previous && existsSync(previous)) {
    try { unlinkSync(temporaryPrevious); } catch { /* absent */ }
    symlinkSync(resolve(previous), temporaryPrevious, 'dir');
    renameSync(temporaryPrevious, previousPath);
  }
  try { unlinkSync(temporaryCurrent); } catch { /* absent */ }
  symlinkSync(resolve(releasePath), temporaryCurrent, 'dir');
  renameSync(temporaryCurrent, current);
}
