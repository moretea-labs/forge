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

export function isSchedulerWakeSignalEvent(filename: string | Buffer | null | undefined): boolean {
  // The wake file shares a directory with scheduler health/state persistence.
  // Atomic writes to those sibling files can emit multiple directory events.
  // Node/macOS reports the final filename, while Bun/macOS may report only the
  // wake file's atomic temporary name; both belong to the same wake authority.
  // Platforms that omit the filename remain conservative and re-check revision.
  if (filename == null) return true;
  const observed = filename.toString();
  return observed === 'wake-signal.json'
    || (observed.startsWith('wake-signal.json.') && observed.endsWith('.tmp'));
}

export function shouldWakeForSchedulerEvent(
  filename: string | Buffer | null | undefined,
  expectedRevision: number,
  observedRevision: number,
): boolean {
  if (!isSchedulerWakeSignalEvent(filename)) return false;
  // A null filename is an ambiguous directory event on some Bun/macOS
  // combinations. Only treat it as a wake when the durable revision changed;
  // otherwise the Scheduler's own state.json write would wake it immediately
  // and turn the idle loop into a CPU-consuming self-trigger cycle.
  if (filename == null) return observedRevision !== expectedRevision;
  // A named wake-file event is authoritative even when the revision is equal:
  // concurrent writers may coalesce onto one revision, while the lifecycle
  // truth remains in the canonical stores.
  return true;
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
      watcher = watch(dirname(path), (_eventType, filename) => {
        if (!shouldWakeForSchedulerEvent(
          filename,
          expectedRevision,
          readSchedulerWakeSignal(controllerHome).revision,
        )) return;
        // A named canonical wake-file event is itself the notification. Do not
        // make event delivery depend on observing a strictly newer JSON
        // revision: concurrent writers may legitimately coalesce onto one
        // revision, while lifecycle truth is read from canonical stores.
        finish('wakeup');
      });
      watcher.on?.('error', maybeWake);
    } catch {
      watcher = undefined;
    }
    // fs.watch is the primary wake path. Polling is only a lost-event safety
    // net, so keep it coarse enough that an idle scheduler does not perform a
    // read/stat storm while still bounding cross-platform wake loss.
    const fallbackPollMs = Math.min(10_000, Math.max(250, Math.trunc(options.fallbackPollMs ?? 1_000)));
    poller = setInterval(maybeWake, fallbackPollMs);
    poller.unref?.();
    timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
    timer.unref?.();
    maybeWake();
  });
}
