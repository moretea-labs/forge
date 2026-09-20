import type { RepositoryRecord } from '../../../cli/repositories/types';
import { cleanupRuntimeComputerInteractionTargets } from '../../root/computer-target-composition';
import { cleanupControllerHomeBrowserArtifacts, cleanupGeneratedRepositoryCaches, cleanupIdleXCTestDevices } from '../generated-cache-retention';
import {
  cleanupRuntimeBrowserSessionTombstones,
  closeRuntimeBrowserSessionLegacyImportCutover,
} from '../../root/browser-session-composition';
import type { cleanupControllerRuntimeState } from '../runtime-cleanup';
import type { reconcileTerminalWorkCleanups } from '../execution/work-terminal-cleanup';
import type { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import { cleanupPersistedCheckResults } from '../../execution/process-runtime/check-result-retention';
import { cleanupRetiredExecutionJobs } from '../../execution/jobs/store';
import type { reconcilePendingWorkValidations } from '../execution/work-validation-reconciler';
import type { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';
import {
  beginControllerRoundProviderDispatch,
  claimStalledControllerRoundRelays,
  finishControllerRoundRelayDispatch,
  listControllerRoundRelaysByBlocker,
} from '../../../../packages/kernel/controller/api/index';
import { assertAutomatedOperationAllowed } from '../governance/external-effects';
import { runWorkChatgptContinuation, settleWorkChatgptAutomationTab } from '../launcher/chatgpt-work-continuation';
import { getChatgptWorkConversationBinding } from '../../../../adapters/chatgpt/work-conversation-binding-store';
import { getChatgptControllerRoundSettlement } from '../../../../adapters/chatgpt/controller-round-settlement-store';
import { recordChatgptControllerRoundTabSettlement, renderChatgptControllerRoundPrompt } from '../../root/controller-round-composition';
import { ensureWorkflowSupervisorEnrollmentForWork, workflowSupervisorBoundaryForWork } from '../../root/workflow-supervisor-composition';

const PERIODIC_RETENTION_INTERVAL_MS = 5 * 60_000;
const PERIODIC_DEEP_RETENTION_INTERVAL_MS = 15 * 60_000;
// A provider-ambiguous ControllerRound remains durable and claimable, but its
// Forge-owned Chrome tab is not durable authority. Give an in-flight ChatGPT
// turn a bounded claim window, then release the ephemeral resource without
// replaying or clearing the semantic outcome-unknown fence.
const CHATGPT_OUTCOME_UNKNOWN_TAB_SETTLEMENT_GRACE_MS = 5 * 60_000;

export function planSchedulerPeriodicMaintenance(input: {
  nowMs: number;
  cleanupIntervalMs: number;
  repositoryCount: number;
}): {
  periodicSequence: number;
  runRetention: boolean;
  runDeepRetention: boolean;
  processGcRepositoryIndex?: number;
  deepRetentionRepositoryIndex?: number;
} {
  const cleanupIntervalMs = Math.max(1, input.cleanupIntervalMs);
  const periodicSequence = Math.floor(input.nowMs / cleanupIntervalMs);
  const retentionEvery = Math.max(1, Math.ceil(PERIODIC_RETENTION_INTERVAL_MS / cleanupIntervalMs));
  const deepRetentionEvery = Math.max(retentionEvery, Math.ceil(PERIODIC_DEEP_RETENTION_INTERVAL_MS / cleanupIntervalMs));
  const repositoryCount = Math.max(0, Math.trunc(input.repositoryCount));
  return {
    periodicSequence,
    runRetention: periodicSequence % retentionEvery === 0,
    runDeepRetention: periodicSequence % deepRetentionEvery === 0,
    processGcRepositoryIndex: repositoryCount > 0 ? periodicSequence % repositoryCount : undefined,
    deepRetentionRepositoryIndex: repositoryCount > 0 && periodicSequence % deepRetentionEvery === 0
      ? Math.floor(periodicSequence / deepRetentionEvery) % repositoryCount
      : undefined,
  };
}

export async function runSchedulerPeriodicCleanup(input: {
  controllerHome: string;
  controllerPid: number;
  nowMs: number;
  cleanupIntervalMs: number;
  repositories: readonly RepositoryRecord[];
  runtimeCleanup: typeof cleanupControllerRuntimeState;
  terminalWorkCleanup: typeof reconcileTerminalWorkCleanups;
  processGc: typeof gcTerminalProcesses;
}): Promise<void> {
  const plan = planSchedulerPeriodicMaintenance({
    nowMs: input.nowMs,
    cleanupIntervalMs: input.cleanupIntervalMs,
    repositoryCount: input.repositories.length,
  });
  // Runtime-state phase rotation and terminal Work cleanup are lifecycle
  // reconciliation, not retention. Keep them at the base cleanup cadence.
  try {
    input.runtimeCleanup(input.controllerHome, {
      reason: 'periodic',
      nowMs: input.nowMs,
      periodicSequence: plan.periodicSequence,
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

  // Browser/computer tombstones are retention state. Their lifecycle truth is
  // written synchronously by their owning authorities, so a five-minute sweep
  // is sufficient and avoids repeating controller-wide scans every minute.
  if (plan.runRetention) {
    try {
      closeRuntimeBrowserSessionLegacyImportCutover(
        input.controllerHome,
        input.repositories.map((repository) => ({ repoId: repository.repoId, repoRoot: repository.canonicalRoot })),
      );
      const browserSessions = cleanupRuntimeBrowserSessionTombstones(input.controllerHome, { nowMs: input.nowMs });
      if (browserSessions.blockers.length > 0 || browserSessions.budgetExhausted) {
        console.error('[forge cleanup] Browser session retention reported bounded blockers');
      }
    } catch (error) {
      console.error('[forge cleanup] Browser session retention failed:', error);
    }
    try {
      const computerTargets = await cleanupRuntimeComputerInteractionTargets(input.controllerHome, { nowMs: input.nowMs });
      if (computerTargets.blockers.length > 0 || computerTargets.overCapacity || computerTargets.budgetExhausted) {
        console.error('[forge cleanup] Computer interaction-target retention reported bounded blockers');
      }
    } catch (error) {
      console.error('[forge cleanup] Computer interaction-target retention failed:', error);
    }
    for (const repository of input.repositories) {
      const store = { controllerHome: input.controllerHome, repoId: repository.repoId };
      for (const relay of listControllerRoundRelaysByBlocker(store, 'provider_dispatch_outcome_unknown', 16)) {
        const blockedAtMs = Date.parse(relay.updatedAt);
        if (!Number.isFinite(blockedAtMs) || input.nowMs - blockedAtMs < CHATGPT_OUTCOME_UNKNOWN_TAB_SETTLEMENT_GRACE_MS) continue;
        const existingSettlement = getChatgptControllerRoundSettlement(store, {
          workId: relay.originWorkId,
          relayScopeId: relay.relayScopeId,
        });
        if (existingSettlement && ['closed', 'preserved_user_owned', 'session_closed'].includes(existingSettlement.status)) continue;
        const binding = getChatgptWorkConversationBinding(store, relay.originWorkId);
        if (!binding?.latestBrowserSessionId) continue;
        const settlement = await settleWorkChatgptAutomationTab({
          controllerHome: input.controllerHome,
          workId: relay.originWorkId,
          browserSessionId: binding.latestBrowserSessionId,
          authorizationGrantRefs: binding.authorizationGrantRefs,
        });
        recordChatgptControllerRoundTabSettlement(store, {
          workId: relay.originWorkId,
          relayScopeId: relay.relayScopeId,
          status: settlement.status,
          error: settlement.error?.message,
        });
      }
    }
  }

  // Process GC includes stale-active reconciliation with a five-minute minimum
  // age. Preserve the existing one-repository-per-base-pass round robin so that
  // recovery remains smooth instead of concentrating all repositories in one
  // periodic spike.
  if (plan.processGcRepositoryIndex !== undefined) {
    const processRepo = input.repositories[plan.processGcRepositoryIndex]!;
    const result = input.processGc({ controllerHome: input.controllerHome, repoId: processRepo.repoId });
    if (!result.ok) console.error('[forge cleanup] Process GC failed:', result.error ?? 'unknown error');
  }

  if (!plan.runDeepRetention) return;

  // Generated caches and persisted artifacts have hour/day-scale retention
  // thresholds. Run one repository per deep-retention pass, and rotate the
  // repository index on the deep cadence rather than the one-minute sequence.
  try {
    const xctestCleanup = cleanupIdleXCTestDevices(input.controllerHome);
    if (xctestCleanup.error) console.error('[forge cleanup] XCTest device cleanup failed:', xctestCleanup.error);
  } catch (error) {
    console.error('[forge cleanup] XCTest device cleanup failed:', error);
  }
  if (plan.deepRetentionRepositoryIndex === undefined) return;
  const repo = input.repositories[plan.deepRetentionRepositoryIndex]!;
  try {
    const generated = cleanupGeneratedRepositoryCaches(repo.canonicalRoot, { nowMs: input.nowMs });
    if (generated.errors.length > 0) {
      console.error(`[forge cleanup] generated-cache retention reported ${generated.errors.length} error(s) for ${repo.repoId}`);
    }
  } catch (error) {
    console.error(`[forge cleanup] generated-cache retention failed for ${repo.repoId}:`, error);
  }
  try {
    const browserArtifacts = cleanupControllerHomeBrowserArtifacts(input.controllerHome, repo.repoId, { nowMs: input.nowMs });
    if (browserArtifacts.errors.length > 0 || Object.values(browserArtifacts.classes).some((item) => item.overCapacity)) {
      console.error(`[forge cleanup] Browser artifact retention reported bounded blockers for ${repo.repoId}`);
    }
  } catch (error) {
    console.error(`[forge cleanup] Browser artifact retention failed for ${repo.repoId}:`, error);
  }
  try {
    const checkResults = cleanupPersistedCheckResults(input.controllerHome, repo.repoId, { nowMs: input.nowMs });
    if (checkResults.blockers.length > 0 || checkResults.budgetExhausted) {
      console.error(`[forge cleanup] persisted check-result retention reported bounded blockers for ${repo.repoId}`);
    }
  } catch (error) {
    console.error(`[forge cleanup] persisted check-result retention failed for ${repo.repoId}:`, error);
  }
  try {
    const retiredJobs = cleanupRetiredExecutionJobs(input.controllerHome, repo.repoId, { nowMs: input.nowMs });
    if (retiredJobs.blockers.length > 0 || retiredJobs.scanTruncated || retiredJobs.budgetExhausted) {
      console.error(`[forge cleanup] retired ExecutionJob retention reported bounded blockers for ${repo.repoId}`);
    }
  } catch (error) {
    console.error(`[forge cleanup] retired ExecutionJob retention failed for ${repo.repoId}:`, error);
  }
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
  repositories: readonly Pick<RepositoryRecord, 'repoId' | 'canonicalRoot' | 'localRoot'>[];
  graceMs?: number;
  maxRecoveries?: number;
  dispatchPrompt?: typeof runWorkChatgptContinuation;
  authorizeWake?: typeof assertAutomatedOperationAllowed;
}): Promise<{ claimed: number; dispatched: number; failed: number }> {
  const dispatchPrompt = input.dispatchPrompt ?? runWorkChatgptContinuation;
  const authorizeWake = input.authorizeWake ?? assertAutomatedOperationAllowed;
  const maxRecoveries = Math.max(1, Math.min(Math.trunc(input.maxRecoveries ?? 2), 8));
  let claimed = 0;
  let dispatched = 0;
  let failed = 0;

  for (const repository of input.repositories) {
    if (claimed >= maxRecoveries) break;
    const store = { controllerHome: input.controllerHome, repoId: repository.repoId };
    let records: ReturnType<typeof claimStalledControllerRoundRelays>;
    try {
      records = claimStalledControllerRoundRelays(store, {
        nowMs: input.nowMs,
        graceMs: input.graceMs,
        limit: maxRecoveries - claimed,
        controllerTypes: ['chatgpt'],
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed += 1;
      console.error(`[forge controller relay] stalled round scan failed for ${repository.repoId}:`, reason);
      continue;
    }
    claimed += records.length;
    for (const record of records) {
      try {
        authorizeWake('external_controller_wake', {
          work_id: record.originWorkId,
          controller_type: 'chatgpt',
          relay_scope_id: record.relayScopeId,
          recovery_reason: 'unclosed_dispatched_round',
        });
        const boundary = workflowSupervisorBoundaryForWork(store, record.originWorkId);
        if (boundary.status === 'outer_turn') {
          await ensureWorkflowSupervisorEnrollmentForWork(store, record.originWorkId, {
            schedulerRecoveryKey: record.occurrenceId ?? record.updatedAt,
          });
          continue;
        }
        const binding = getChatgptWorkConversationBinding(store, record.originWorkId);
        const predecessorBinding = !binding && record.predecessorWorkId
          ? getChatgptWorkConversationBinding(store, record.predecessorWorkId)
          : undefined;
        const deliveryBinding = binding ?? predecessorBinding;
        if (!record.authorityId) throw new Error(`CONTROLLER_ROUND_AUTHORITY_REQUIRED:${record.relayScopeId}`);
        const dispatchingRecord = beginControllerRoundProviderDispatch(store, {
          workId: record.originWorkId,
          authorityId: record.authorityId,
          expectedUpdatedAt: record.updatedAt,
          bindingId: binding?.bindingId,
        });
        const result = await dispatchPrompt({
          controllerHome: input.controllerHome,
          repoId: repository.repoId,
          repoRoot: repository.canonicalRoot ?? repository.localRoot,
          workId: record.originWorkId,
          prompt: renderChatgptControllerRoundPrompt(store, dispatchingRecord, { exactOriginWork: !dispatchingRecord.requirementId }),
          controllerAuthorityId: dispatchingRecord.authorityId,
          relayScopeId: dispatchingRecord.relayScopeId,
          browserSessionId: deliveryBinding?.latestBrowserSessionId,
          conversationUrl: deliveryBinding?.conversationUrl,
          authorizationGrantRefs: deliveryBinding?.authorizationGrantRefs,
          model: 'gpt-5.6',
          reasoning: 'high',
          tabPolicy: 'auto',
          timeoutMs: 30_000,
        });
        if (result.status === 'failed') throw new Error(result.error?.message ?? 'CHATGPT_CONTROLLER_RELAY_RECOVERY_FAILED');
        const updatedBinding = getChatgptWorkConversationBinding(store, record.originWorkId);
        finishControllerRoundRelayDispatch(store, {
          workId: record.originWorkId,
          ok: true,
          bindingId: updatedBinding?.bindingId,
        });
        dispatched += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        finishControllerRoundRelayDispatch(store, {
          workId: record.originWorkId,
          ok: false,
          error: reason,
          recovery: true,
          nowMs: input.nowMs,
        });
        failed += 1;
        console.error(`[forge controller relay] stalled round recovery failed for ${record.relayScopeId}:`, reason);
      }
    }
  }
  return { claimed, dispatched, failed };
}
