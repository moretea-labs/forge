import { spawn, type ChildProcess } from 'child_process';
import { listActiveExecutionJobs } from '../execution/jobs/store';
import { hasActiveLightweightProcesses } from '../execution/process-runtime/lightweight-managed';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_IDLE_GRACE_MS = 5 * 60_000;
const CAFFEINATE_TIMEOUT_SECONDS = 10 * 60;

export interface RuntimePowerAssertionHandle {
  refresh(): void;
  stop(): void;
  isHeld(): boolean;
}

export interface RuntimePowerAssertionInput {
  controllerHome: string;
  runtimePid: number;
  pollIntervalMs?: number;
  idleGraceMs?: number;
}

interface RuntimePowerAssertionDependencies {
  platform?: NodeJS.Platform;
  now?: () => number;
  hasActiveExecution?: (controllerHome: string) => boolean;
  spawnAssertion?: (runtimePid: number) => ChildProcess;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

function controllerHasActiveExecution(controllerHome: string): boolean {
  return hasActiveLightweightProcesses(controllerHome)
    || listActiveExecutionJobs(controllerHome).length > 0;
}

function spawnMacOsCaffeinate(runtimePid: number): ChildProcess {
  return spawn('/usr/bin/caffeinate', [
    '-d',
    '-i',
    '-u',
    '-t', String(CAFFEINATE_TIMEOUT_SECONDS),
    '-w', String(runtimePid),
  ], {
    stdio: 'ignore',
  });
}

function noOpHandle(): RuntimePowerAssertionHandle {
  return {
    refresh: () => undefined,
    stop: () => undefined,
    isHeld: () => false,
  };
}

/**
 * macOS idle-sleep/display-lock guard owned by the Canonical Runtime process.
 *
 * The assertion is deliberately non-durable: it is acquired only while Forge
 * has active execution and is released after a short idle grace. `caffeinate`
 * is additionally fenced to the Runtime PID and bounded by its own timeout, so
 * a Runtime crash cannot leave an indefinite host-wide assertion behind.
 */
export function startActiveExecutionPowerAssertion(
  input: RuntimePowerAssertionInput,
  dependencies: RuntimePowerAssertionDependencies = {},
): RuntimePowerAssertionHandle {
  if ((dependencies.platform ?? process.platform) !== 'darwin') return noOpHandle();

  const pollIntervalMs = Math.max(500, Math.min(Math.trunc(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS), 30_000));
  const idleGraceMs = Math.max(5_000, Math.min(Math.trunc(input.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS), 30 * 60_000));
  const now = dependencies.now ?? Date.now;
  const hasActiveExecution = dependencies.hasActiveExecution ?? controllerHasActiveExecution;
  const spawnAssertion = dependencies.spawnAssertion ?? spawnMacOsCaffeinate;
  const setIntervalFn = dependencies.setIntervalFn ?? setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn ?? clearInterval;

  let assertion: ChildProcess | undefined;
  let lastActiveAt: number | undefined;
  let stopped = false;

  const releaseAssertion = () => {
    const current = assertion;
    assertion = undefined;
    if (!current) return;
    try { current.kill('SIGTERM'); } catch { /* assertion cleanup is best effort */ }
  };

  const ensureAssertion = () => {
    if (assertion || stopped) return;
    try {
      const next = spawnAssertion(input.runtimePid);
      assertion = next;
      const clear = () => {
        if (assertion === next) assertion = undefined;
      };
      next.once('exit', clear);
      next.once('error', clear);
    } catch {
      // Host power-management support is best-effort. Runtime execution must
      // continue even when caffeinate is absent or temporarily unavailable.
    }
  };

  const refresh = () => {
    if (stopped) return;
    let active: boolean;
    try {
      active = hasActiveExecution(input.controllerHome);
    } catch {
      // Ambiguous activity must never release a currently-held assertion.
      return;
    }
    const observedAt = now();
    if (active) {
      lastActiveAt = observedAt;
      ensureAssertion();
      return;
    }
    if (assertion && lastActiveAt !== undefined && observedAt - lastActiveAt >= idleGraceMs) {
      releaseAssertion();
    }
  };

  refresh();
  const timer = setIntervalFn(refresh, pollIntervalMs);
  timer.unref?.();

  return {
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      releaseAssertion();
    },
    isHeld: () => assertion !== undefined,
  };
}
