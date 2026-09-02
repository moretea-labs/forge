import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import type { ScheduledContinuationDispatch } from '../domain/continuation';

const NAMESPACE = 'scheduler_continuation_dispatch';

export interface SchedulerContinuationStoreOptions {
  controllerHome: string;
  repoId: string;
  now?: () => string;
}

export function getScheduledContinuationDispatch(
  options: SchedulerContinuationStoreOptions,
  occurrenceId: string,
): ScheduledContinuationDispatch | undefined {
  return readControlPlaneRecord<ScheduledContinuationDispatch>(
    options.controllerHome, NAMESPACE, options.repoId, occurrenceId,
  )?.value;
}

export function updateScheduledContinuationDispatch(
  options: SchedulerContinuationStoreOptions,
  occurrenceId: string,
  actor: string,
  update: (current: ScheduledContinuationDispatch | undefined, now: string) => ScheduledContinuationDispatch,
): ScheduledContinuationDispatch {
  return withControllerLock(options.controllerHome, { scope: 'task', repoId: options.repoId, taskId: `schedule-continuation-${occurrenceId}` }, actor, () => {
    const current = readControlPlaneRecord<ScheduledContinuationDispatch>(options.controllerHome, NAMESPACE, options.repoId, occurrenceId);
    const at = options.now?.() ?? new Date().toISOString();
    const value = update(current?.value, at);
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE, scope: options.repoId, key: occurrenceId, schemaVersion: 1, value,
      action: actor, expectedRevision: current?.revision ?? null,
    });
    return value;
  });
}
