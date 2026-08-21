import type { RepositoryRecord } from '../../../cli/repositories/types';
import type { cleanupControllerRuntimeState } from '../runtime-cleanup';
import type { reconcileTerminalWorkCleanups } from '../execution/work-terminal-cleanup';
import type { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import type { reconcilePendingWorkValidations } from '../execution/work-validation-reconciler';
import type { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';

export async function runSchedulerPeriodicCleanup(input: {
  controllerHome: string;
  controllerPid: number;
  nowMs: number;
  cleanupIntervalMs: number;
  repositories: readonly Pick<RepositoryRecord, 'repoId'>[];
  runtimeCleanup: typeof cleanupControllerRuntimeState;
  terminalWorkCleanup: typeof reconcileTerminalWorkCleanups;
  processGc: typeof gcTerminalProcesses;
}): Promise<void> {
  try {
    input.runtimeCleanup(input.controllerHome, {
      reason: 'periodic',
      nowMs: input.nowMs,
      protectedControllerPid: input.controllerPid,
    });
  } catch (error) {
    console.error('[forge cleanup] periodic cleanup failed:', error);
  }
  try {
    await input.terminalWorkCleanup(input.controllerHome, { nowMs: input.nowMs });
  } catch (error) {
    console.error('[forge cleanup] terminal Work cleanup failed:', error);
  }
  if (input.repositories.length === 0) return;
  const slot = Math.floor(input.nowMs / input.cleanupIntervalMs) % input.repositories.length;
  const repo = input.repositories[slot]!;
  const result = input.processGc({ controllerHome: input.controllerHome, repoId: repo.repoId });
  if (!result.ok) console.error('[forge cleanup] Process GC failed:', result.error ?? 'unknown error');
}

export async function runSchedulerValidationReconciliation(input: {
  controllerHome: string;
  repositories: readonly RepositoryRecord[];
  workValidationReconcile: typeof reconcilePendingWorkValidations;
  editValidationReconcile: typeof reconcilePendingEditValidations;
}): Promise<void> {
  for (const repository of input.repositories) {
    const validation = input.workValidationReconcile(input.controllerHome, repository.repoId, 500);
    if (validation.errors.length > 0) {
      console.error(
        `[forge validation] background Work reconciliation reported ${validation.errors.length} error(s) for ${repository.repoId}`,
      );
    }
    const editValidation = await input.editValidationReconcile(input.controllerHome, repository, 200);
    if (editValidation.errors.length > 0) {
      console.error(
        `[forge validation] background EditSession reconciliation reported ${editValidation.errors.length} error(s) for ${repository.repoId}`,
      );
    }
  }
}
