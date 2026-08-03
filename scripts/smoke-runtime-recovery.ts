import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import {
  acceptSubmittedWorkContract,
  getWorkContract,
  getWorkContractByRequestId,
  recordWorkCompletionReceipt,
  transitionWorkContractPhase,
} from '../src/runtime/control-plane/facade/work-contract-store';
import {
  claimControllerSession,
  getControllerSession,
  releaseControllerSession,
} from '../src/runtime/control-plane/facade/controller-session-store';
import { listExecutionJobs } from '../src/runtime/execution/jobs/store';
import {
  __resetLiveMonitorsForTests,
  recoverManagedProcesses,
  spawnManagedProcess,
  waitForProcess,
} from '../src/runtime/execution/process-runtime';
import { executionIdentityForRepository } from '../src/runtime/control-plane/execution/execution-identity';
import { createSchedule } from '../src/runtime/workflow/schedules/store';
import { createPortfolioWorkflow } from '../src/runtime/workflow/portfolio/store';
import { recordCandidateFinding } from '../src/runtime/workflow/findings/store';
import { assertAutomatedOperationAllowed } from '../src/runtime/control-plane/governance/external-effects';

const root = mkdtempSync(join(tmpdir(), 'repo-harness-recovery-smoke-'));
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
  const repository = registerRepository({ path: repoRoot, controllerHome, repoIdOverride: 'repo-runtime-recovery-smoke' });
  const operation = {
    name: 'repository_command',
    semanticKey: 'runtime-recovery:process',
    argumentHash: 'runtime-recovery:process',
    mode: 'mutating' as const,
    idempotent: true,
    replayable: true,
    resourceClaims: [],
  };
  const request = {
    requestId: 'runtime-recovery-work-1',
    repoId: repository.repoId,
    semanticKey: operation.semanticKey,
    operation,
    objective: 'Verify WorkContract and Process Runtime recovery without ExecutionJobs',
    checks: [],
  };
  const accepted = acceptSubmittedWorkContract(controllerHome, request);
  const duplicate = acceptSubmittedWorkContract(controllerHome, request);
  assert(duplicate.deduplicated, 'WorkContract requestId was not idempotent');
  assert(duplicate.contract.workId === accepted.contract.workId, 'duplicate request returned a different WorkContract');
  assert(
    getWorkContractByRequestId(controllerHome, request.requestId, repository.repoId)?.workId === accepted.contract.workId,
    'request index did not resolve the WorkContract',
  );
  assert(listExecutionJobs(controllerHome, repository.repoId, 20).length === 0, 'Work acceptance created an ExecutionJob');

  claimControllerSession({ controllerHome, repoId: repository.repoId }, {
    workId: accepted.contract.workId,
    controllerId: 'controller-recovery-a',
    controllerType: 'codex',
    sessionId: 'session-recovery-a',
    leaseMs: 60_000,
  });
  // Recovery smoke follows the same Work-only phase API enforced in production.
  transitionWorkContractPhase({ controllerHome, repoId: repository.repoId }, accepted.contract.workId, {
    phase: 'implementation',
    status: 'running',
    state: 'active',
    summary: 'Process Runtime recovery smoke started implementation.',
  });
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
    workId: accepted.contract.workId,
    commandId: `cmd-${accepted.contract.workId}-recovery`,
    origin: { surface: 'command', toolName: 'smoke-runtime-recovery' },
  });
  assert(!handle.completed, 'managed process unexpectedly completed before recovery');

  __resetLiveMonitorsForTests();
  const recovery = recoverManagedProcesses(controllerHome, repository.repoId);
  const processRecovered = recovery.recovered.includes(handle.processId) || recovery.completedFromReceipt.includes(handle.processId);
  assert(processRecovered, 'Process Runtime record was neither recovered nor completed from its receipt');
  const completed = await waitForProcess(controllerHome, repository.repoId, handle.processId, { timeoutMs: 5_000 });
  assert(completed.completed && completed.ok, 'recovered process did not complete successfully');

  releaseControllerSession({ controllerHome, repoId: repository.repoId }, accepted.contract.workId, 'controller-recovery-a');
  const replacement = claimControllerSession({ controllerHome, repoId: repository.repoId }, {
    workId: accepted.contract.workId,
    controllerId: 'controller-recovery-b',
    controllerType: 'codex',
    sessionId: 'session-recovery-b',
    leaseMs: 60_000,
  });
  assert(replacement.controllerId === 'controller-recovery-b', 'released Work could not be reclaimed');
  assert(getControllerSession({ controllerHome, repoId: repository.repoId }, accepted.contract.workId)?.sessionId === 'session-recovery-b', 'replacement Controller session missing');
  const completionRecordedAt = new Date().toISOString();
  const completionRevision = String(spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout).trim();
  recordWorkCompletionReceipt(
    { controllerHome, repoId: repository.repoId },
    accepted.contract.workId,
    {
      schemaVersion: 1,
      receiptId: `REC-smoke-${accepted.contract.workId}`,
      source: 'direct_edit',
      issueId: 'ISS-runtime-recovery-smoke',
      taskId: 'T1',
      workId: accepted.contract.workId,
      targetBranch: 'main',
      targetRevision: completionRevision,
      changedPaths: [],
      delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt: completionRecordedAt },
      cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt: completionRecordedAt },
      verifiedAt: completionRecordedAt,
      recordedAt: completionRecordedAt,
    },
    'completed_no_change',
    'completed_no_change',
  );
  assert(getWorkContract({ controllerHome, repoId: repository.repoId }, accepted.contract.workId)?.status === 'completed', 'completed WorkContract was not persisted');
  assert(listExecutionJobs(controllerHome, repository.repoId, 20).length === 0, 'runtime recovery created an ExecutionJob');

  const scheduleInput = {
    requestId: 'schedule-idempotency', repoId: repository.repoId, name: 'bounded triage', enabled: true,
    trigger: { type: 'manual' as const },
    policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 10, shadowMode: true },
    action: { operation: 'controller_context', resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' as const }] },
    stopConditions: [] as string[],
  };
  const scheduleA = createSchedule(controllerHome, scheduleInput);
  const scheduleB = createSchedule(controllerHome, scheduleInput);
  assert(scheduleA.scheduleId === scheduleB.scheduleId, 'Schedule requestId was not idempotent');

  const portfolioInput = {
    name: 'portfolio-idempotency', requestId: 'portfolio-idempotency', failurePolicy: 'stop' as const,
    steps: [{ stepId: 'one', repoId: repository.repoId, operation: 'controller_context', dependsOn: [], priority: 'P2' as const, resourceClaims: [], status: 'pending' as const }],
  };
  const portfolioA = createPortfolioWorkflow(controllerHome, portfolioInput);
  const portfolioB = createPortfolioWorkflow(controllerHome, portfolioInput);
  assert(portfolioA.workflowId === portfolioB.workflowId, 'Portfolio requestId was not idempotent');

  const candidateA = recordCandidateFinding(controllerHome, {
    repoId: repository.repoId, requestId: 'candidate-observation-1', semanticKey: 'frequent-502:mcp-timeout',
    title: 'Frequent MCP 502', summary: 'Observed during bounded triage.', evidence: { source: 'schedule', reference: 'OCC-1' },
  });
  const candidateB = recordCandidateFinding(controllerHome, {
    repoId: repository.repoId, requestId: 'candidate-observation-2', semanticKey: 'frequent-502:mcp-timeout',
    title: 'Frequent MCP 502', summary: 'Observed again.', evidence: { source: 'schedule', reference: 'OCC-2' },
  });
  assert(candidateA.findingId === candidateB.findingId && candidateB.observationCount === 2, 'candidate finding was not deduplicated');
  let automaticIssueBlocked = false;
  try { assertAutomatedOperationAllowed('create_issue'); } catch { automaticIssueBlocked = true; }
  assert(automaticIssueBlocked, 'Schedule/Portfolio could create an Issue without candidate promotion');

  let cycleRejected = false;
  try {
    createPortfolioWorkflow(controllerHome, {
      name: 'cycle', requestId: 'portfolio-cycle', failurePolicy: 'stop',
      steps: [
        { stepId: 'a', repoId: repository.repoId, operation: 'controller_context', dependsOn: ['b'], priority: 'P2', resourceClaims: [], status: 'pending' },
        { stepId: 'b', repoId: repository.repoId, operation: 'controller_context', dependsOn: ['a'], priority: 'P2', resourceClaims: [], status: 'pending' },
      ],
    });
  } catch { cycleRejected = true; }
  assert(cycleRejected, 'Portfolio dependency cycle was accepted');

  console.log(JSON.stringify({
    status: 'ok',
    workId: accepted.contract.workId,
    processRecovered,
    replacementController: replacement.controllerId,
    scheduleId: scheduleA.scheduleId,
    portfolioWorkflowId: portfolioA.workflowId,
    candidateFindingDeduplicated: candidateB.observationCount,
    automaticIssueBlocked,
    portfolioCycleRejected: cycleRejected,
    executionJobCount: listExecutionJobs(controllerHome, repository.repoId, 20).length,
  }, null, 2));
} finally {
  __resetLiveMonitorsForTests();
  rmSync(root, { recursive: true, force: true });
}
