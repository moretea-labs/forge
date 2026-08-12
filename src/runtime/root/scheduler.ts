import { GlobalScheduler, readSchedulerHealthSnapshot } from '../control-plane/global-scheduler/scheduler';
import { applyPendingContinuationActivations } from '../workflow/schedules/pending-activation';

export interface RuntimeSchedulerHandle {
  ready: Promise<void>;
  done: Promise<void>;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSchedulerHeartbeat(
  controllerHome: string,
  startedAfterMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readSchedulerHealthSnapshot(controllerHome);
    const loopStartedAtMs = Date.parse(state.loopStartedAt ?? '');
    const lastHeartbeatAtMs = Date.parse(state.lastHeartbeatAt ?? '');
    if (Number.isFinite(loopStartedAtMs)
      && Number.isFinite(lastHeartbeatAtMs)
      && loopStartedAtMs >= startedAfterMs
      && lastHeartbeatAtMs >= startedAfterMs) return;
    await delay(25);
  }
  throw new Error(`SCHEDULER_INITIALIZATION_TIMEOUT: ${timeoutMs}ms`);
}

export function startInProcessScheduler(
  controllerHome: string,
  readyTimeoutMs = 5_000,
): RuntimeSchedulerHandle {
  const abort = new AbortController();
  // Old Runtime releases ignore pending activation markers entirely. A naturally
  // restarted Runtime that contains this code consumes them once, before its
  // sole Scheduler starts, so no second scheduler or rollout hook is required.
  applyPendingContinuationActivations(controllerHome);
  const startedAfterMs = Date.now();
  const scheduler = new GlobalScheduler(controllerHome, {}, {
    controllerPid: process.pid,
    fatalOnTickError: true,
  });
  const done = scheduler.run(abort.signal);
  const unexpectedStop = done.then(() => {
    if (!abort.signal.aborted) throw new Error('SCHEDULER_STOPPED_UNEXPECTEDLY');
  });
  const ready = Promise.race([
    waitForSchedulerHeartbeat(controllerHome, startedAfterMs, readyTimeoutMs),
    unexpectedStop,
  ]).then(() => undefined);
  return {
    ready,
    done: unexpectedStop,
    stop: async () => {
      abort.abort();
      await done.catch(() => undefined);
    },
  };
}
