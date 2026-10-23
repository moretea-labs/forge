import { listRepositories } from '../../../cli/repositories/registry';
import { cleanupControllerRuntimeState } from '../runtime-cleanup';
import { reconcileTerminalWorkCleanups } from '../execution/work-terminal-cleanup';
import { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import { assertRuntimeMayWrite } from '../../root/write-fence';
import { runSchedulerPeriodicCleanup } from './maintenance';
import { PROCESS_RUNTIME_RELEASE_CANARY_ARG } from '../../execution/process-runtime/canary';

// Release staging executes the exact immutable cleanup artifact in a no-op mode.
// Exit before parsing maintenance arguments or binding any write authority.
if (process.argv.includes(PROCESS_RUNTIME_RELEASE_CANARY_ARG)) {
  process.exit(0);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(`PERIODIC_CLEANUP_ARGUMENT_REQUIRED: ${name}`);
  return value;
}

function positiveNumber(name: string): number {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`PERIODIC_CLEANUP_ARGUMENT_INVALID: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const controllerHome = required('--controller-home');
  const controllerPid = Math.trunc(positiveNumber('--controller-pid'));
  const nowMs = positiveNumber('--now-ms');
  const cleanupIntervalMs = positiveNumber('--cleanup-interval-ms');
  const fence = assertRuntimeMayWrite('cleanup', controllerHome);
  if (!fence.allowed) throw new Error(`PERIODIC_CLEANUP_RUNTIME_FENCED: ${fence.reason}`);
  const repositories = listRepositories(controllerHome).filter((repository) => repository.enabled && !repository.removedAt);
  await runSchedulerPeriodicCleanup({
    controllerHome,
    controllerPid,
    nowMs,
    cleanupIntervalMs,
    repositories,
    runtimeCleanup: cleanupControllerRuntimeState,
    terminalWorkCleanup: reconcileTerminalWorkCleanups,
    processGc: gcTerminalProcesses,
  });
}

void main().catch((error) => {
  console.error('[forge cleanup worker] periodic cleanup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
