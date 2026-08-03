import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../src/cli/repositories/registry';
import { createMcpToolContext } from '../src/cli/mcp/server';
import { callRepositoryTool } from '../src/cli/mcp/repository-tools';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../src/runtime/control-plane/daemon-client';
import { listExecutionJobs } from '../src/runtime/execution/jobs/store';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';
import { readRepositoryProjection } from '../src/runtime/projections/materialized-view';
import { listActiveLeases } from '../src/runtime/resources/leases/store';

const root = mkdtempSync(join(tmpdir(), 'repo-harness-runtime-smoke-'));
const repoRoot = join(root, 'repo');
const controllerHome = join(root, 'controller');
let daemonPid: number | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Cold CI hosts may pay SQLite, loader, and first-projection startup costs. The
// architectural non-blocking contract is enforced below by zero Jobs/leases and
// read-only SWR evidence; this ceiling only detects an actual hang.
const COLD_READ_CEILING_MS = 5_000;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  mkdirSync(repoRoot, { recursive: true });
  git('init');
  git('config', 'user.email', 'runtime-smoke@example.invalid');
  git('config', 'user.name', 'Runtime Smoke');
  writeFileSync(join(repoRoot, 'README.md'), '# runtime smoke\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'initial');
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'runtime-smoke' });

  const first = ensureControllerDaemon(controllerHome);
  const second = ensureControllerDaemon(controllerHome);
  daemonPid = first.pid;
  assert(Boolean(first.pid) && first.pid === second.pid, `DAEMON_DEDUPE_FAILED: ${first.pid} vs ${second.pid}`);
  // Cold start under the node --loader runtime loads the full daemon module
  // graph through the TS loader; measured 14-20s locally (bun: 2-4s). Keep the
  // budget above that so the smoke gates readiness, not loader warm-up.
  const daemonDeadline = Date.now() + 30_000;
  let daemon = readControllerDaemonStatus(controllerHome);
  while (daemon.status !== 'ready' && Date.now() < daemonDeadline) {
    await sleep(50);
    daemon = readControllerDaemonStatus(controllerHome);
  }
  assert(daemon.status === 'ready', `DAEMON_NOT_READY: ${daemon.status}`);

  const jobsBefore = listExecutionJobs(controllerHome, repository.repoId, 100).map((entry) => entry.jobId);
  assert(jobsBefore.length === 0, 'control-plane smoke started with unexpected ExecutionJobs');

  const workbenchStartedAt = Date.now();
  const workbenchResult = await callRepositoryTool(controllerHome, 'repository_workbench', {
    repo_id: repository.repoId,
    operation: 'summary',
  });
  const workbenchLatencyMs = Date.now() - workbenchStartedAt;
  assert(Boolean(workbenchResult) && !workbenchResult?.isError, 'REPOSITORY_WORKBENCH_DIRECT_FAILED');
  assert(workbenchLatencyMs <= COLD_READ_CEILING_MS, `REPOSITORY_WORKBENCH_BLOCKED_GATEWAY: ${workbenchLatencyMs}ms`);
  const workbench = workbenchResult?.structuredContent as Record<string, unknown> | undefined;
  assert(workbench?.workbench && typeof workbench.workbench === 'object', 'REPOSITORY_WORKBENCH_RESULT_MISSING');

  const mcpContext = createMcpToolContext({ repo: repoRoot, controllerHome, profile: 'controller' });
  const bridgeStartedAt = Date.now();
  const bridgeStatusResult = await callRuntimeTool(mcpContext, 'local_bridge_status', {});
  const bridgeLatencyMs = Date.now() - bridgeStartedAt;
  assert(Boolean(bridgeStatusResult) && !bridgeStatusResult?.isError, 'LOCAL_BRIDGE_STATUS_FAST_PATH_FAILED');
  assert(bridgeLatencyMs <= COLD_READ_CEILING_MS, `LOCAL_BRIDGE_STATUS_BLOCKED_GATEWAY: ${bridgeLatencyMs}ms`);
  const bridgeStatus = bridgeStatusResult?.structuredContent as Record<string, unknown> | undefined;
  assert(bridgeStatus?.nonBlocking === true, 'LOCAL_BRIDGE_STATUS_NOT_MATERIALIZED');

  rmSync(join(controllerHome, 'repositories', repository.repoId, 'projections', 'controller-context.json'), { force: true });
  const contextStartedAt = Date.now();
  const firstContextResult = await callRuntimeTool(mcpContext, 'controller_context', {});
  const contextLatencyMs = Date.now() - contextStartedAt;
  assert(Boolean(firstContextResult) && !firstContextResult?.isError, 'CONTROLLER_CONTEXT_FAST_PATH_FAILED');
  assert(contextLatencyMs <= COLD_READ_CEILING_MS, `CONTROLLER_CONTEXT_BLOCKED_GATEWAY: ${contextLatencyMs}ms`);
  const firstContext = firstContextResult?.structuredContent as Record<string, unknown> | undefined;
  const contextProjection = firstContext?.contextProjection as Record<string, unknown> | undefined;
  assert(contextProjection?.refreshJobId === undefined, 'CONTROLLER_CONTEXT_CREATED_REFRESH_JOB');
  assert(
    contextProjection?.strategy === 'event-driven-swr'
      && contextProjection.readOnly === true
      && contextProjection.nonBlocking === true,
    `CONTROLLER_CONTEXT_NOT_READ_ONLY: ${JSON.stringify(contextProjection)}`,
  );

  const secondContextResult = await callRuntimeTool(mcpContext, 'controller_context', {});
  const secondContext = secondContextResult?.structuredContent as Record<string, unknown> | undefined;
  const secondProjection = secondContext?.contextProjection as Record<string, unknown> | undefined;
  assert(
    secondProjection?.strategy === 'event-driven-swr' && secondProjection.readOnly === true,
    'CONTROLLER_CONTEXT_READ_CONTRACT_CHANGED',
  );

  const jobsAfter = listExecutionJobs(controllerHome, repository.repoId, 100).map((entry) => entry.jobId);
  assert(JSON.stringify(jobsAfter) === JSON.stringify(jobsBefore), 'DIRECT_CONTROL_PLANE_READS_MUTATED_JOB_INDEX');
  assert(listActiveLeases(controllerHome, repository.repoId).length === 0, 'DIRECT_CONTROL_PLANE_READS_LEAKED_LEASES');

  const projection = readRepositoryProjection(controllerHome, repository.repoId);
  assert(projection.activeJobs.length === 0, 'PROJECTION_REPORTED_PHANTOM_ACTIVE_JOBS');

  daemon = readControllerDaemonStatus(controllerHome);
  assert(daemon.status === 'ready', `DAEMON_NOT_READY_AFTER_READS: ${daemon.status}`);
  console.log(JSON.stringify({
    status: 'ok',
    daemonPid: daemon.pid,
    repoId: repository.repoId,
    repositoryWorkbenchLatencyMs: workbenchLatencyMs,
    localBridgeStatusLatencyMs: bridgeLatencyMs,
    controllerContextLatencyMs: contextLatencyMs,
    controllerContextStrategy: contextProjection?.strategy,
    executionJobCount: jobsAfter.length,
    activeLeases: 0,
  }, null, 2));
} finally {
  if (daemonPid) {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* already stopped */ }
    await sleep(200);
  }
  rmSync(root, { recursive: true, force: true });
}
