import type { RepositoryRecord } from '../../../cli/repositories/types';
import { cleanupRuntimeComputerInteractionTargets } from '../../root/computer-target-composition';
import { cleanupControllerHomeBrowserArtifacts, cleanupGeneratedRepositoryCheckoutCaches, cleanupIdleXCTestDevices, cleanupReleasableIosTestEvidence } from '../generated-cache-retention';
import type { cleanupControllerRuntimeState } from '../runtime-cleanup';
import type { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import { assertRuntimeMayWrite } from '../../root/write-fence';
import { cleanupPersistedCheckResults } from '../../execution/process-runtime/check-result-retention';
import { cleanupRetiredExecutionJobs } from '../../execution/jobs/store';
import type { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';
import { deriveForgeActionableFailureCode, maybeRegisterFailedReleaseSessionRepairs, maybeRegisterForgeActionableFailureRepair } from '../../diagnostics/incident-repair';

const PERIODIC_RETENTION_INTERVAL_MS = 5 * 60_000;
const PERIODIC_DEEP_RETENTION_INTERVAL_MS = 15 * 60_000;

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
  deepRetentionSequence: number;
  generatedCacheRepositoryIndex?: number;
  generatedCacheRootStartIndex: number;
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
  const deepRetentionSequence = Math.floor(periodicSequence / deepRetentionEvery);
  return {
    periodicSequence,
    deepRetentionSequence,
    generatedCacheRepositoryIndex: repositoryCount > 0 && periodicSequence % retentionEvery === 0
      ? Math.floor(periodicSequence / retentionEvery) % repositoryCount : undefined,
    generatedCacheRootStartIndex: repositoryCount > 0 ? Math.floor(periodicSequence / retentionEvery / repositoryCount) : 0,
    runRetention: periodicSequence % retentionEvery === 0,
    runDeepRetention: periodicSequence % deepRetentionEvery === 0,
    processGcRepositoryIndex: repositoryCount > 0 ? periodicSequence % repositoryCount : undefined,
    deepRetentionRepositoryIndex: repositoryCount > 0 && periodicSequence % deepRetentionEvery === 0
      ? deepRetentionSequence % repositoryCount
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
  processGc: typeof gcTerminalProcesses;
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
  // Runtime-state cleanup remains lifecycle reconciliation at the base cadence.
  // Historical Work is read-only and has no scheduled cleanup writer.
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
    maybeRegisterFailedReleaseSessionRepairs({ controllerHome: input.controllerHome, now: () => input.nowMs });
  } catch (error) {
    console.error('[forge cleanup] release failure repair reconciliation failed:', error);
  }

  // Computer interaction-target tombstones are retention state. Their lifecycle truth is
  // written synchronously by their owning authorities, so a five-minute sweep
  // is sufficient and avoids repeating controller-wide scans every minute.
  if (plan.runRetention) {
    if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
    try {
      const computerTargets = await cleanupRuntimeComputerInteractionTargets(input.controllerHome, { nowMs: input.nowMs });
      if (computerTargets.blockers.length > 0 || computerTargets.overCapacity || computerTargets.budgetExhausted) {
        console.error('[forge cleanup] Computer interaction-target retention reported bounded blockers');
      }
    } catch (error) {
      console.error('[forge cleanup] Computer interaction-target retention failed:', error);
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

  // Cache production is much faster than evidence retention. Reuse the existing
  // five-minute pass, one repository and one bounded budget per pass. The root
  // ordinal advances per repository visit, not by the correlated global index.
  if (plan.generatedCacheRepositoryIndex !== undefined) {
    if (!runtimeMaintenanceAuthorityCurrent(input.controllerHome)) return;
    const cacheRepo = input.repositories[plan.generatedCacheRepositoryIndex]!;
    try {
      const generated = cleanupGeneratedRepositoryCheckoutCaches(cacheRepo, {
        nowMs: input.nowMs, rootStartIndex: plan.generatedCacheRootStartIndex,
      });
      if (generated.errors.length > 0) console.error(`[forge cleanup] generated-cache retention reported ${generated.errors.length} error(s) for ${cacheRepo.repoId}`);
      const evidence = cleanupReleasableIosTestEvidence(cacheRepo, {
        owner: { controllerHome: input.controllerHome, repoId: cacheRepo.repoId },
        nowMs: input.nowMs,
        rootStartIndex: plan.generatedCacheRootStartIndex,
      });
      if (evidence.errors.length > 0) console.error(`[forge cleanup] iOS test-evidence retention reported ${evidence.errors.length} error(s) for ${cacheRepo.repoId}`);
    } catch (error) {
      console.error(`[forge cleanup] generated-cache retention failed for ${cacheRepo.repoId}:`, error);
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
  editValidationReconcile: typeof reconcilePendingEditValidations;
}): Promise<void> {
  for (const repository of input.repositories) {
    const editValidation = await input.editValidationReconcile(input.controllerHome, repository, 200);
    if (editValidation.errors.length > 0) {
      console.error(
        `[forge validation] background EditSession reconciliation reported ${editValidation.errors.length} error(s) for ${repository.repoId}`,
      );
    }
  }
}
