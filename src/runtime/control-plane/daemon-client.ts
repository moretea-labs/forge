import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { durableControllerHome, ensureControllerHome } from '../../cli/repositories/controller-home';
import { withControllerLock } from '../../cli/repositories/locks';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { readSchedulerHealthSnapshot } from './global-scheduler/scheduler';
import {
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
  readRuntimeGeneration,
  resolveControllerRuntimeSourceRoot,
  type RuntimeSourceIdentity,
} from './runtime-generation';
import { cleanupControllerRuntimeState } from './runtime-cleanup';
import type { ControllerStartupRecoveryResult } from './startup-recovery';
import { isStableSupervisorInstalled, supervisorStatePath } from '../supervisor/paths';

export type ControllerDaemonShutdownReason =
  | 'SIGINT'
  | 'SIGTERM'
  | 'max_lifetime'
  | 'scheduler_error'
  | 'lifecycle_complete'
  | 'process_missing';

export interface ControllerDaemonStatus {
  schemaVersion: 1;
  status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unavailable';
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  shutdownReason?: ControllerDaemonShutdownReason;
  error?: string;
  gatewaySeparated?: boolean;
  workerIsolation?: boolean;
  degraded?: boolean;
  recovery?: ControllerStartupRecoveryResult;
  generation?: string;
  source?: RuntimeSourceIdentity;
  restartRequired?: boolean;
  restartReasons?: string[];
  instanceId?: string;
  ownerEpoch?: number;
  slot?: 'blue' | 'green';
}

function daemonPidPath(controllerHome: string): string { return join(ensureControllerHome(controllerHome), 'daemon', 'controller.pid'); }
function daemonStatePath(controllerHome: string): string { return join(ensureControllerHome(controllerHome), 'daemon', 'state.json'); }
export const LEGACY_SCHEDULER_HEARTBEAT_TIMEOUT_MS = 60_000;
const MIN_SCHEDULER_HEARTBEAT_TIMEOUT_MS = 5_000;
const DAEMON_STARTUP_GRACE_MS = 15_000;

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function schedulerHeartbeatSnapshotHealthy(
  scheduler: ReturnType<typeof readSchedulerHealthSnapshot>,
  nowMs = Date.now(),
): boolean {
  if (!scheduler.loopStartedAt) return false;
  const heartbeat = scheduler.lastHeartbeatAt ?? scheduler.lastTickAt;
  if (!heartbeat) return false;
  const heartbeatAt = Date.parse(heartbeat);
  const configuredTimeout = Number(scheduler.heartbeatTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.max(MIN_SCHEDULER_HEARTBEAT_TIMEOUT_MS, configuredTimeout)
    : LEGACY_SCHEDULER_HEARTBEAT_TIMEOUT_MS;
  return Number.isFinite(heartbeatAt) && nowMs - heartbeatAt <= timeoutMs;
}

function schedulerHeartbeatHealthy(controllerHome: string): boolean {
  return schedulerHeartbeatSnapshotHealthy(readSchedulerHealthSnapshot(controllerHome));
}

export function resolveControllerDaemonStatusHome(controllerHome: string): string {
  const requestedHome = ensureControllerHome(controllerHome);
  const stableHome = durableControllerHome(requestedHome);
  // Direct slot callers must stay slot-local. Root callers, including
  // controller_ready and lifecycle diagnostics, follow the Supervisor-owned
  // active process pair instead of reading a stale pre-blue/green state file.
  if (resolve(stableHome) !== resolve(requestedHome) || !isStableSupervisorInstalled(stableHome)) {
    return requestedHome;
  }
  const supervisor = readJsonFile<{
    controllerDaemon?: { controllerHome?: string };
  }>(supervisorStatePath(stableHome), {});
  const activeHome = supervisor.controllerDaemon?.controllerHome?.trim();
  return activeHome ? ensureControllerHome(activeHome) : requestedHome;
}

export function readControllerDaemonStatus(controllerHome: string): ControllerDaemonStatus {
  const home = resolveControllerDaemonStatusHome(controllerHome);
  const generation = readRuntimeGeneration(home);
  const state = readJsonFile<ControllerDaemonStatus>(daemonStatePath(home), { schemaVersion: 1, status: 'unavailable' });
  const withGeneration: ControllerDaemonStatus = {
    ...state,
    generation: state.generation ?? generation?.generation,
    source: state.source ?? generation?.source,
  };
  let pid = state.pid;
  try { pid = Number(readFileSync(daemonPidPath(home), 'utf8').trim()) || pid; } catch { /* no pid */ }
  const alive = pidAlive(pid);
  const heartbeatHealthy = alive ? schedulerHeartbeatHealthy(home) : false;
  if ((withGeneration.status === 'ready' || withGeneration.status === 'starting') && !alive) {
    return {
      ...withGeneration,
      status: 'stopped',
      pid,
      shutdownReason: withGeneration.shutdownReason ?? 'process_missing',
    };
  }
  if ((withGeneration.status === 'stopped' || withGeneration.status === 'failed') && alive && heartbeatHealthy) {
    // Cleanup/projection writers may race a Supervisor replacement. A live
    // Daemon that continues to publish its Scheduler heartbeat is stronger
    // evidence than a stale terminal projection. Keep this read-only; the next
    // lifecycle write or rollout will repair the durable state file.
    return {
      ...withGeneration,
      status: 'ready',
      pid,
      stoppedAt: undefined,
      shutdownReason: undefined,
      error: undefined,
      degraded: false,
    };
  }
  if (withGeneration.status === 'ready' && !heartbeatHealthy) {
    const startedAt = withGeneration.startedAt ? Date.parse(withGeneration.startedAt) : Number.NaN;
    if (Number.isFinite(startedAt) && Date.now() - startedAt < DAEMON_STARTUP_GRACE_MS) {
      return { ...withGeneration, status: 'starting', pid };
    }
    // A stale scheduler heartbeat is degraded runtime state, not proof that the
    // daemon process is dead. Keep the live PID authoritative so callers do not
    // spawn a second daemon and invalidate Workers owned by the first one.
    return {
      ...withGeneration,
      status: 'ready',
      pid,
      degraded: true,
      error: withGeneration.error ?? 'SCHEDULER_HEARTBEAT_STALE',
    };
  }
  return { ...withGeneration, pid };
}

export function ensureControllerDaemon(
  controllerHome: string,
  options: { ownerEpoch?: number; instanceId?: string; slot?: 'blue' | 'green' } = {},
): ControllerDaemonStatus {
  const home = ensureControllerHome(controllerHome);
  // Hot path: a live Controller daemon needs neither cleanup I/O nor the global
  // lock. Durable MCP jobs call this on every mutating request; scanning a large
  // controllerHome on each call was a multi-ms tax even when the daemon was up.
  const live = readControllerDaemonStatus(home);
  if (pidAlive(live.pid)) return live;

  // Once a stable release is installed, the external Supervisor is the only
  // process allowed to create or replace the Controller Daemon. Blue/green
  // Gateways run from slot homes, so ownership must be checked against the
  // durable root rather than the slot-local filesystem.
  const supervisorHome = durableControllerHome(home);
  if (isStableSupervisorInstalled(supervisorHome)) {
    const supervisor = readJsonFile<{ desiredState?: string; supervisor?: { pid?: number } }>(supervisorStatePath(supervisorHome), {});
    return {
      ...live,
      status: 'unavailable',
      error: supervisor?.desiredState === 'running' && pidAlive(supervisor.supervisor?.pid)
        ? 'SUPERVISOR_OWNS_DAEMON'
        : 'SUPERVISOR_REQUIRED',
      restartRequired: true,
    };
  }

  // Cleanup only when we may actually start a daemon. Bounded, but still FS-heavy.
  try {
    cleanupControllerRuntimeState(home, { reason: 'startup' });
  } catch (error) {
    console.error('[repo-harness cleanup] startup cleanup failed:', error);
  }
  return withControllerLock(home, { scope: 'global' }, 'ensure-controller-daemon', () => {
    const current = readControllerDaemonStatus(home);
    // PID liveness is the fencing boundary. A degraded/stale heartbeat must not
    // create a competing daemon while the recorded process is still alive.
    if (pidAlive(current.pid)) return current;
    const entry = fileURLToPath(new URL('./daemon-entry.ts', import.meta.url));
    const bun = Boolean(process.versions.bun);
    const loader = fileURLToPath(new URL('../shared/node-ts-loader.mjs', import.meta.url));
    // Pin daemon runtime source to the package/source authority, not ambient cwd
    // (e.g. business repository) of the process that called ensureControllerDaemon.
    const runtimeSource = resolveControllerRuntimeSourceRoot();
    const args = bun
      ? [entry, '--controller-home', home]
      : ['--loader', loader, entry, '--controller-home', home];
    if (runtimeSource.root) {
      args.push('--runtime-source-root', runtimeSource.root);
    }
    if (options.ownerEpoch !== undefined) args.push('--owner-epoch', String(options.ownerEpoch));
    if (options.instanceId) args.push('--instance-id', options.instanceId);
    if (options.slot) args.push('--slot', options.slot);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...(runtimeSource.root
          ? { [CONTROLLER_RUNTIME_SOURCE_ROOT_ENV]: runtimeSource.root }
          : {}),
      },
      ...(runtimeSource.root ? { cwd: runtimeSource.root } : {}),
    });
    const starting: ControllerDaemonStatus = {
      schemaVersion: 1,
      status: 'starting',
      pid: child.pid,
      startedAt: new Date().toISOString(),
      gatewaySeparated: true,
      workerIsolation: true,
      ...(options.ownerEpoch !== undefined ? { ownerEpoch: options.ownerEpoch } : {}),
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      ...(options.slot ? { slot: options.slot } : {}),
    };
    // Persist the spawn intent before releasing the global lock. Concurrent
    // Gateway requests will observe this PID instead of starting another daemon.
    writeJsonAtomic(daemonStatePath(home), starting);
    if (child.pid) writeFileSync(daemonPidPath(home), `${child.pid}\n`, 'utf8');
    child.once('error', (error) => {
      writeJsonAtomic(daemonStatePath(home), { ...starting, status: 'failed', error: error.message });
    });
    child.unref();
    return starting;
  }, 10_000);
}

export function controllerDaemonPidExists(controllerHome: string): boolean {
  return existsSync(daemonPidPath(controllerHome));
}
