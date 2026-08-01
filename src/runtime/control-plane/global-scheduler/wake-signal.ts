import { mkdirSync, watch } from 'fs';
import { dirname, join } from 'path';
import { ensureControllerHome } from '../../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';

interface SchedulerWakeSignal {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  reason?: string;
}

function wakeSignalPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'scheduler', 'wake-signal.json');
}

export function readSchedulerWakeSignal(controllerHome: string): SchedulerWakeSignal {
  return readJsonFile<SchedulerWakeSignal>(wakeSignalPath(controllerHome), {
    schemaVersion: 1,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  });
}

export function touchSchedulerWakeSignal(controllerHome: string, reason: string): SchedulerWakeSignal {
  const path = wakeSignalPath(controllerHome);
  const current = readSchedulerWakeSignal(controllerHome);
  const next: SchedulerWakeSignal = {
    schemaVersion: 1,
    revision: Math.max(0, current.revision) + 1,
    updatedAt: new Date().toISOString(),
    reason,
  };
  writeJsonAtomic(path, next);
  return next;
}

export async function waitForSchedulerWakeSignal(
  controllerHome: string,
  expectedRevision: number,
  timeoutMs: number,
  signal?: AbortSignal,
  options: { fallbackPollMs?: number } = {},
): Promise<'wakeup' | 'timeout' | 'aborted'> {
  if (signal?.aborted) return 'aborted';
  if (readSchedulerWakeSignal(controllerHome).revision !== expectedRevision) return 'wakeup';

  const path = wakeSignalPath(controllerHome);
  mkdirSync(dirname(path), { recursive: true });

  return await new Promise((resolve) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let poller: NodeJS.Timeout | undefined;

    const finish = (result: 'wakeup' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      watcher?.close();
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => finish('aborted');
    const maybeWake = () => {
      if (readSchedulerWakeSignal(controllerHome).revision !== expectedRevision) finish('wakeup');
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      watcher = watch(dirname(path), maybeWake);
      watcher.on?.('error', maybeWake);
    } catch {
      watcher = undefined;
    }
    // fs.watch is the primary wake path. Polling is only a lost-event safety
    // net, so keep it coarse enough that an idle scheduler does not perform a
    // read/stat storm while still bounding cross-platform wake loss.
    const fallbackPollMs = Math.min(2_000, Math.max(250, Math.trunc(options.fallbackPollMs ?? 1_000)));
    poller = setInterval(maybeWake, fallbackPollMs);
    poller.unref?.();
    timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
    timer.unref?.();
    maybeWake();
  });
}
