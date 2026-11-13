import { execFile } from 'child_process';
import { realpath } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, sep } from 'path';
import { promisify } from 'util';
import { createSchedule } from '../../../../packages/kernel/scheduler/api/index';
import type { RepositorySchedule } from '../../../../packages/kernel/scheduler/api/index';

const exec = promisify(execFile);
const LABEL = 'com.greyson.forge-supervisor-health';

/**
 * The only rescue target is the installed, user-owned healthcheck LaunchAgent.
 * No caller-controlled executable, shell string, script path, or project name.
 */
export function createSupervisorHealthSchedule(
  controllerHome: string,
  repoId: string,
  input: { requestId: string; scheduleName?: string; everyMinutes?: number; shadowMode?: boolean },
): { schedule: RepositorySchedule } {
  const cadence = input.everyMinutes ?? 180;
  if (!Number.isInteger(cadence) || cadence < 180) throw new Error('SUPERVISOR_HEALTH_CADENCE_MINIMUM_180_MINUTES');
  const schedule = createSchedule(controllerHome, {
    repoId,
    requestId: input.requestId,
    name: input.scheduleName?.trim() || 'External Supervisor rescue (3h)',
    enabled: true,
    trigger: { type: 'interval', everyMinutes: cadence },
    policy: {
      maxActiveOccurrences: 1, maxFailures: 12, cooldownMinutes: 0,
      dailyBudgetMinutes: 60, shadowMode: input.shadowMode !== false,
      backoffBaseMinutes: 5, backoffMaxMinutes: 180,
    },
    action: { operation: 'supervisor_healthcheck', target: 'runtime', arguments: {}, resourceClaims: [] },
    stopConditions: [],
  });
  return { schedule };
}

export async function executeSupervisorHealthcheck(): Promise<{
  laneCount: number; failedTicks: number; pendingEffects: number; attemptedRecoveries: number; unhealthy: number;
}> {
  if (process.platform !== 'darwin') throw new Error('SUPERVISOR_HEALTH_MACOS_REQUIRED');
  const plist = join(homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
  const field = async (key: string) => {
    const result = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { timeout: 5000 });
    return result.stdout.trim();
  };
  const [label, executable, configuredScript] = await Promise.all([
    field('Label'), field('ProgramArguments:0'), field('ProgramArguments:1'),
  ]);
  if (label !== LABEL || executable !== '/usr/bin/python3'
      || !configuredScript.startsWith(homedir() + sep)
      || !configuredScript.endsWith('/forge-supervisor/healthcheck.py')) {
    throw new Error('SUPERVISOR_HEALTH_INSTALLED_IDENTITY_MISMATCH');
  }
  const script = await realpath(configuredScript);
  if (!script.startsWith(homedir() + sep) || !script.endsWith('/forge-supervisor/healthcheck.py')) {
    throw new Error('SUPERVISOR_HEALTH_SCRIPT_IDENTITY_MISMATCH');
  }

  // Invoke the existing healthcheck's sole decision owner. Its per-project
  // guards reconcile pending effects; the Scheduler neither sends CONTINUE
  // nor takes a second Writer/launchd ownership.
  const output = await exec(executable, [script], {
    cwd: dirname(script), timeout: 110_000, maxBuffer: 512 * 1024,
  });
  const line = output.stdout.trim().split('\n').at(-1);
  const result = JSON.parse(line ?? '{}') as { lanes?: Array<{
    action?: string; last_exit?: number; pending_effect?: boolean; kickstart_ok?: boolean; restore_ok?: boolean;
  }> };
  if (!Array.isArray(result.lanes)) throw new Error('SUPERVISOR_HEALTH_RECEIPT_INVALID');
  const lanes = result.lanes;
  return {
    laneCount: lanes.length,
    failedTicks: lanes.filter(l => typeof l.last_exit === 'number' && l.last_exit !== 0).length,
    pendingEffects: lanes.filter(l => l.pending_effect === true).length,
    attemptedRecoveries: lanes.filter(l => ['kickstart', 'wake_provider_recovery', 'restoring_unloaded'].includes(l.action ?? '')).length,
    unhealthy: lanes.filter(l => ['last_tick_failed_pending_receipt', 'last_tick_failed_needs_observation',
      'progress_stalled_recovery_not_verified', 'provider_error_no_pending_receipt_needs_observation',
      'deferred_requirement_unavailable', 'active_writer_or_process_no_forced_restart', 'missing_plist'].includes(l.action ?? '')
      || l.kickstart_ok === false || l.restore_ok === false).length,
  };
}
