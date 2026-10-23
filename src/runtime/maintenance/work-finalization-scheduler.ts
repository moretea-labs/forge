/**
 * Periodic Work finalization scheduler.
 *
 * Integrates with the existing periodic cleanup infrastructure to automatically
 * detect and finalize delivered Work, preventing branch/worktree accumulation.
 */

import { executeAutoFinalization } from './work-auto-finalization';

export interface FinalizationSchedulerConfig {
  enabled: boolean;
  intervalMinutes: number;
  minWorkAgeMinutes: number;
  maxWorkPerCycle: number;
}

export const DEFAULT_CONFIG: FinalizationSchedulerConfig = {
  enabled: true,
  intervalMinutes: 15, // Run every 15 minutes
  minWorkAgeMinutes: 5, // Only finalize Work older than 5 minutes
  maxWorkPerCycle: 20, // Process up to 20 Work items per cycle
};

let schedulerTimer: NodeJS.Timeout | undefined;
let lastRunTime: number = 0;
let isRunning = false;

/**
 * Start the automatic finalization scheduler.
 */
export function startWorkFinalizationScheduler(
  controllerHome: string,
  config: Partial<FinalizationSchedulerConfig> = {},
): void {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  if (!finalConfig.enabled) {
    console.log('[work-finalization-scheduler] Disabled by configuration');
    return;
  }

  if (schedulerTimer) {
    console.log('[work-finalization-scheduler] Already running');
    return;
  }

  console.log('[work-finalization-scheduler] Starting with config:', finalConfig);

  const intervalMs = finalConfig.intervalMinutes * 60 * 1000;

  schedulerTimer = setInterval(async () => {
    if (isRunning) {
      console.log('[work-finalization-scheduler] Previous cycle still running, skipping');
      return;
    }

    isRunning = true;
    const cycleStartMs = Date.now();

    try {
      console.log('[work-finalization-scheduler] Starting finalization cycle');

      const report = await executeAutoFinalization(controllerHome, {
        minAgeMinutes: finalConfig.minWorkAgeMinutes,
        maxWork: finalConfig.maxWorkPerCycle,
        dryRun: false,
      });

      const durationMs = Date.now() - cycleStartMs;
      lastRunTime = cycleStartMs;

      console.log('[work-finalization-scheduler] Cycle completed:', {
        durationMs,
        scanned: report.scanned,
        candidates: report.candidates.length,
        autoCompleted: report.autoCompleted.length,
        cleanedUp: report.cleanedUp.length,
        retained: report.retained.length,
        errors: report.errors.length,
      });

      if (report.errors.length > 0) {
        console.error('[work-finalization-scheduler] Errors:',
          report.errors.slice(0, 5).map(e => `${e.workId}: ${e.error}`));
      }

      if (report.autoCompleted.length > 0) {
        console.log('[work-finalization-scheduler] Auto-completed Work:',
          report.autoCompleted.map(w => w.workId));
      }

      if (report.cleanedUp.length > 0) {
        console.log('[work-finalization-scheduler] Cleaned up Work:',
          report.cleanedUp.map(w => `${w.workId} (${w.status})`));
      }
    } catch (error) {
      console.error('[work-finalization-scheduler] Cycle failed:', error);
    } finally {
      isRunning = false;
    }
  }, intervalMs);

  // Run first cycle immediately
  setTimeout(async () => {
    if (!isRunning && schedulerTimer) {
      console.log('[work-finalization-scheduler] Running initial cycle');
      const event = new Event('dummy'); // Trigger interval callback
      schedulerTimer.refresh();
    }
  }, 5000); // Wait 5 seconds after startup
}

/**
 * Stop the automatic finalization scheduler.
 */
export function stopWorkFinalizationScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
    console.log('[work-finalization-scheduler] Stopped');
  }
}

/**
 * Get scheduler status.
 */
export function getSchedulerStatus(): {
  running: boolean;
  lastRunTime: number;
  isCurrentlyExecuting: boolean;
} {
  return {
    running: schedulerTimer !== undefined,
    lastRunTime,
    isCurrentlyExecuting: isRunning,
  };
}
