import type { RepositoryRecord } from '../../../cli/repositories/types';
import type { cleanupControllerRuntimeState } from '../runtime-cleanup';
import type { reconcileTerminalWorkCleanups } from '../execution/work-terminal-cleanup';
import type { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import type { reconcilePendingWorkValidations } from '../execution/work-validation-reconciler';
import type { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';
import {
  buildControllerRoundRelayPrompt,
  claimStalledControllerRoundRelays,
  finishControllerRoundRelayDispatch,
} from '../facade/controller-round-relay';
import { assertAutomatedOperationAllowed } from '../governance/external-effects';
import { runStandaloneChatgptPrompt } from '../launcher/chatgpt-work-continuation';

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

export async function runSchedulerControllerRoundRecovery(input: {
  controllerHome: string;
  nowMs: number;
  repositories: readonly Pick<RepositoryRecord, 'repoId'>[];
  graceMs?: number;
  maxRecoveries?: number;
  dispatchPrompt?: typeof runStandaloneChatgptPrompt;
  authorizeWake?: typeof assertAutomatedOperationAllowed;
}): Promise<{ claimed: number; dispatched: number; failed: number }> {
  const dispatchPrompt = input.dispatchPrompt ?? runStandaloneChatgptPrompt;
  const authorizeWake = input.authorizeWake ?? assertAutomatedOperationAllowed;
  const maxRecoveries = Math.max(1, Math.min(Math.trunc(input.maxRecoveries ?? 2), 8));
  let claimed = 0;
  let dispatched = 0;
  let failed = 0;

  for (const repository of input.repositories) {
    if (claimed >= maxRecoveries) break;
    const store = { controllerHome: input.controllerHome, repoId: repository.repoId };
    const records = claimStalledControllerRoundRelays(store, {
      nowMs: input.nowMs,
      graceMs: input.graceMs,
      limit: maxRecoveries - claimed,
    });
    claimed += records.length;
    for (const record of records) {
      try {
        authorizeWake('external_controller_wake', {
          work_id: record.originWorkId,
          controller_type: 'chatgpt',
          relay_scope_id: record.relayScopeId,
          recovery_reason: 'unclosed_dispatched_round',
        });
        const result = await dispatchPrompt({
          controllerHome: input.controllerHome,
          repoId: repository.repoId,
          scopeId: `controller-relay:${record.relayScopeId}`,
          prompt: buildControllerRoundRelayPrompt(store, record),
          browserSessionId: record.browserSessionId,
          conversationUrl: record.conversationUrl,
          model: 'gpt-5.6',
          reasoning: 'high',
          tabPolicy: 'auto',
          timeoutMs: 30_000,
        });
        if (result.status === 'failed') throw new Error(result.error?.message ?? 'CHATGPT_CONTROLLER_RELAY_RECOVERY_FAILED');
        finishControllerRoundRelayDispatch(store, {
          workId: record.originWorkId,
          ok: true,
          browserSessionId: result.browserSessionId,
          conversationUrl: result.conversationUrl,
        });
        dispatched += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        finishControllerRoundRelayDispatch(store, { workId: record.originWorkId, ok: false, error: reason });
        failed += 1;
        console.error(`[forge controller relay] stalled round recovery failed for ${record.relayScopeId}:`, reason);
      }
    }
  }
  return { claimed, dispatched, failed };
}
