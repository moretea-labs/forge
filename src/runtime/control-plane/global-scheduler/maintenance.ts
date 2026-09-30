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
import { assertRuntimeMayWrite } from '../../root/write-fence';
import { cleanupPersistedCheckResults } from '../../execution/process-runtime/check-result-retention';
import { cleanupRetiredExecutionJobs } from '../../execution/jobs/store';
import type { reconcilePendingWorkValidations } from '../execution/work-validation-reconciler';
import type { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';
import {
  controllerRoundBlockerClass,
  listCurrentControllerRoundRelays,
} from '../../../../packages/kernel/controller/api/index';
import { settleWorkChatgptAutomationTab } from '../launcher/chatgpt-work-continuation';
import { getChatgptWorkConversationBinding } from '../../../../adapters/chatgpt/work-conversation-binding-store';
import {
  chatgptControllerRoundSettlementAttemptIdentity,
  getChatgptControllerRoundSettlement,
} from '../../../../adapters/chatgpt/controller-round-settlement-store';
import { recordChatgptControllerRoundTabSettlement } from '../../root/controller-round-composition';
import { deriveForgeActionableFailureCode, maybeRegisterFailedReleaseSessionRepairs, maybeRegisterForgeActionableFailureRepair } from '../../diagnostics/incident-repair';

const PERIODIC_RETENTION_INTERVAL_MS = 5 * 60_000;
const PERIODIC_DEEP_RETENTION_INTERVAL_MS = 15 * 60_000;
// A provider-ambiguous ControllerRound remains durable and claimable, but its
// Forge-owned Chrome tab is not durable authority. Give an in-flight ChatGPT
// turn a bounded claim window, then release the ephemeral resource without
// replaying or clearing the semantic outcome-unknown fence.
const CHATGPT_OUTCOME_UNKNOWN_TAB_SETTLEMENT_GRACE_MS = 5 * 60_000;
// Retention is a fallback GC path, not the primary ControllerRound settlement path.
// Keep its external-effect volume deliberately small so one stale repository set
// cannot create a provider burst or hold a maintenance worker for hours.
const CHATGPT_TAB_SETTLEMENT_EFFECT_BUDGET_PER_PASS = 4;

function runtimeMaintenanceAuthorityCurrent(controllerHome: string): boolean {
  const fence = assertRuntimeMayWrite('cleanup', controllerHome);
  if (fence.allowed) return true;
  console.error(`[forge cleanup] stale periodic cleanup worker fenced: ${fence.reason ?? 'denied'}`);
  return false;
}

function registerSchedulerFailure(input: {
  controllerHome: string;
  source: 'progression' | 'maintenance';
  prefix: string;
  message: string;
  observationId: string;
  repoId?: string;
  workId?: string;
  atMs?: number;
}): void {
  try {
    maybeRegisterForgeActionableFailureRepair({
      controllerHome: input.controllerHome,
      observation: {
        observationId: input.observationId,
        source: input.source,
        code: deriveForgeActionableFailureCode(input.prefix, input.message),
        message: input.message,
        at: new Date(input.atMs ?? Date.now()).toISOString(),
        repoId: input.repoId,
        workId: input.workId,
      },
    });
  } catch {
    // Repair promotion is evidence-side reconciliation, not the owning maintenance result.
  }
}

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
  settleBrowserTab?: typeof settleWorkChatgptAutomationTab;
}): Promise<void> {
  const plan = planSchedulerPeriodicMaintenance({
    nowMs: input.nowMs,
    cleanupIntervalMs: input.cleanupIntervalMs,
    repositoryCount: input.repositories.length,
  });
  // The cleanup process inherits the spawning Runtime's exact write claim. Re-check
  // that claim throughout a long pass so a detached child cannot survive a Runtime
  // rollover and continue producing effects under retired authority.
  if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
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
    const reason = error instanceof Error ? error.message : String(error);
    registerSchedulerFailure({
      controllerHome: input.controllerHome,
      source: 'maintenance',
      prefix: 'RUNTIME_CLEANUP_FAILED',
      message: reason,
      observationId: `maintenance:runtime-cleanup:${plan.periodicSequence}`,
      atMs: input.nowMs,
    });
    console.error('[forge cleanup] periodic cleanup failed:', error);
  }
  if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
  try {
    await input.terminalWorkCleanup(input.controllerHome, { nowMs: input.nowMs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    registerSchedulerFailure({
      controllerHome: input.controllerHome,
      source: 'maintenance',
      prefix: 'TERMINAL_WORK_CLEANUP_FAILED',
      message: reason,
      observationId: `maintenance:terminal-work-cleanup:${plan.periodicSequence}`,
      atMs: input.nowMs,
    });
    console.error('[forge cleanup] terminal Work cleanup failed:', error);
  }
  if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;

  try {
    maybeRegisterFailedReleaseSessionRepairs({ controllerHome: input.controllerHome, now: () => input.nowMs });
  } catch (error) {
    console.error('[forge cleanup] release failure repair reconciliation failed:', error);
  }

  // Browser/computer tombstones are retention state. Their lifecycle truth is
  // written synchronously by their owning authorities, so a five-minute sweep
  // is sufficient and avoids repeating controller-wide scans every minute.
  if (plan.runRetention) {
    if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
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
    if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
    try {
      const computerTargets = await cleanupRuntimeComputerInteractionTargets(input.controllerHome, { nowMs: input.nowMs });
      if (computerTargets.blockers.length > 0 || computerTargets.overCapacity || computerTargets.budgetExhausted) {
        console.error('[forge cleanup] Computer interaction-target retention reported bounded blockers');
      }
    } catch (error) {
      console.error('[forge cleanup] Computer interaction-target retention failed:', error);
    }
    if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
    let chatgptTabSettlementEffects = 0;
    chatgptTabSettlementSweep:
    for (const repository of input.repositories) {
      const store = { controllerHome: input.controllerHome, repoId: repository.repoId };
      for (const relay of listCurrentControllerRoundRelays(store, 100)) {
        const blocker = controllerRoundBlockerClass(relay);
        const outcomeUnknown = blocker === 'provider_dispatch_outcome_unknown';
        const durableInactiveRound = ['waiting', 'waiting_for_user', 'goal_complete', 'failed'].includes(relay.status)
          || (relay.status === 'blocked' && !outcomeUnknown);
        if (!durableInactiveRound && !outcomeUnknown) continue;
        if (outcomeUnknown) {
          const blockedAtMs = Date.parse(relay.updatedAt);
          if (!Number.isFinite(blockedAtMs) || input.nowMs - blockedAtMs < CHATGPT_OUTCOME_UNKNOWN_TAB_SETTLEMENT_GRACE_MS) continue;
        }
        const existingSettlement = getChatgptControllerRoundSettlement(store, {
          workId: relay.originWorkId,
          relayScopeId: relay.relayScopeId,
        });
        if (existingSettlement && ['closed', 'preserved_user_owned', 'session_closed'].includes(existingSettlement.status)) continue;
        const binding = getChatgptWorkConversationBinding(store, relay.originWorkId);
        if (!binding?.latestBrowserSessionId) continue;
        const attemptIdentity = chatgptControllerRoundSettlementAttemptIdentity({
          browserSessionId: binding.latestBrowserSessionId,
          authorizationGrantRefs: binding.authorizationGrantRefs,
        });
        // Failed close_page calls are commonly authorization failures. Retrying
        // the same browser/grant tuple on every retention pass only creates
        // provider traffic and audit churn; a changed resource or grant set is a
        // distinct attempt and remains eligible for recovery.
        if (existingSettlement?.status === 'failed' && existingSettlement.attemptIdentity === attemptIdentity) continue;
        if (chatgptTabSettlementEffects >= CHATGPT_TAB_SETTLEMENT_EFFECT_BUDGET_PER_PASS) {
          console.error('[forge cleanup] ChatGPT tab settlement reached bounded effect budget');
          break chatgptTabSettlementSweep;
        }
        if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
        chatgptTabSettlementEffects += 1;
        const settlement = await (input.settleBrowserTab ?? settleWorkChatgptAutomationTab)({
          controllerHome: input.controllerHome,
          workId: relay.originWorkId,
          browserSessionId: binding.latestBrowserSessionId,
          authorizationGrantRefs: binding.authorizationGrantRefs,
        });
        if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
        recordChatgptControllerRoundTabSettlement(store, {
          workId: relay.originWorkId,
          relayScopeId: relay.relayScopeId,
          status: settlement.status,
          error: settlement.error?.message,
          attemptIdentity,
        });
      }
    }
  }

  // Process GC includes stale-active reconciliation with a five-minute minimum
  // age. Preserve the existing one-repository-per-base-pass round robin so that
  // recovery remains smooth instead of concentrating all repositories in one
  // periodic spike.
  if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
  if (plan.processGcRepositoryIndex !== undefined) {
    const processRepo = input.repositories[plan.processGcRepositoryIndex]!;
    const result = input.processGc({ controllerHome: input.controllerHome, repoId: processRepo.repoId });
    if (!result.ok) {
      const reason = result.error ?? 'unknown error';
      registerSchedulerFailure({
        controllerHome: input.controllerHome,
        source: 'maintenance',
        prefix: 'PROCESS_GC_FAILED',
        message: reason,
        observationId: `maintenance:process-gc:${processRepo.repoId}:${plan.periodicSequence}`,
        repoId: processRepo.repoId,
        atMs: input.nowMs,
      });
      console.error('[forge cleanup] Process GC failed:', reason);
    }
  }

  if (!plan.runDeepRetention) return;
  if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;

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
