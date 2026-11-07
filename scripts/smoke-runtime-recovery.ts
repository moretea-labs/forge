import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../src/effects/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import { listExecutionJobs } from '../src/runtime/execution/jobs/store';
import {
  __resetLiveMonitorsForTests,
  recoverManagedProcesses,
  spawnManagedProcess,
  waitForProcess,
} from '../src/runtime/execution/process-runtime';
import { executionIdentityForRepository } from '../src/runtime/control-plane/execution/execution-identity';
import { createSchedule } from '../packages/kernel/scheduler/api/index';
import { assertAutomatedOperationAllowed } from '../src/runtime/control-plane/governance/external-effects';

const root = mkdtempSync(join(tmpdir(), 'forge-recovery-smoke-'));
const controllerHome = join(root, 'controller');
const repoRoot = join(root, 'repo');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
  assert(result.status === 0, `git ${args.join(' ')} failed`);
}

try {
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'runtime-recovery-smoke' }, null, 2));
  writeFileSync(join(repoRoot, 'README.md'), '# runtime recovery smoke\n');
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'smoke@example.com']);
  git(['config', 'user.name', 'Runtime Recovery Smoke']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  ensureControllerHome(controllerHome);
  const repository = registerRepository({
    path: repoRoot,
    controllerHome,
    repoIdOverride: 'repo-runtime-recovery-smoke',
  });

  assert(
    listExecutionJobs(controllerHome, repository.repoId, 20).length === 0,
    'runtime recovery smoke must start without ExecutionJobs',
  );

  const handle = await spawnManagedProcess({
    controllerHome,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    executionIdentity: executionIdentityForRepository(repository),
    command: {
      kind: 'argv',
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 250);'],
      cwd: repoRoot,
    },
    timeoutMs: 15_000,
    interactiveWaitMs: 0,
    returnHandleImmediately: true,
    commandId: 'cmd-runtime-recovery-smoke',
    origin: { surface: 'command', toolName: 'smoke-runtime-recovery' },
  });
  assert(!handle.completed, 'managed process unexpectedly completed before recovery');

  __resetLiveMonitorsForTests();
  const recovery = recoverManagedProcesses(controllerHome, repository.repoId);
  const processRecovered = recovery.recovered.includes(handle.processId)
    || recovery.completedFromReceipt.includes(handle.processId);
  assert(processRecovered, 'Process Runtime record was neither recovered nor completed from its receipt');

  const completed = await waitForProcess(controllerHome, repository.repoId, handle.processId, { timeoutMs: 5_000 });
  assert(completed.completed && completed.ok, 'recovered process did not complete successfully');
  assert(
    listExecutionJobs(controllerHome, repository.repoId, 20).length === 0,
    'Process recovery created an ExecutionJob',
  );

  const scheduleInput = {
    requestId: 'schedule-idempotency',
    repoId: repository.repoId,
    name: 'bounded triage',
    enabled: true,
    trigger: { type: 'manual' as const },
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: 3,
      cooldownMinutes: 0,
      dailyBudgetMinutes: 10,
      shadowMode: true,
    },
    action: {
      operation: 'controller_context',
      resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' as const }],
    },
    stopConditions: [] as string[],
  };
  const scheduleA = createSchedule(controllerHome, scheduleInput);
  const scheduleB = createSchedule(controllerHome, scheduleInput);
  assert(scheduleA.scheduleId === scheduleB.scheduleId, 'Schedule requestId was not idempotent');

  let automaticIssueBlocked = false;
  try {
    assertAutomatedOperationAllowed('create_issue');
  } catch {
    automaticIssueBlocked = true;
  }
  assert(automaticIssueBlocked, 'Kernel automation could create an Issue without an explicit external-effect path');

  console.log(JSON.stringify({
    status: 'ok',
    processId: handle.processId,
    processRecovered,
    scheduleId: scheduleA.scheduleId,
    automaticIssueBlocked,
    executionJobCount: listExecutionJobs(controllerHome, repository.repoId, 20).length,
  }, null, 2));
} finally {
  __resetLiveMonitorsForTests();
  rmSync(root, { recursive: true, force: true });
}
