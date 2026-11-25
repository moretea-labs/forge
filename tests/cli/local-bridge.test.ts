import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHmac } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import {
  loadMcpServiceRuntimeState,
  writeMcpServiceLocalConfig,
  writeMcpServiceRuntimeState,
} from '../../adapters/mcp/auth';
import {
  cancelAgentJob,
  getAgentJob,
  listAgentJobs,
} from '../../src/cli/agent-jobs/job-manager';
import {
  controllerCheckConcurrencyClass,
  releaseControllerCheckSubscription,
  runControllerCheckAsync,
} from '../../src/runtime/execution/process-runtime/check-runner';
import { FORGE_TOOL_SURFACE } from '../../src/runtime/shared/runtime-config';
import { getIssue, updateTask } from '../../src/cli/controller/issue-store';
import { writeLegacyIssueFixture } from '../helpers/legacy-issue-fixture';
import {
  readWorkflowRun,
  workflowInputDigest,
  writeWorkflowRunCheckpoint,
} from '../../src/runtime/control-plane/persistence/workflow-run-store';
import {
  cancelLocalBridgeJob,
  dispatchLocalBridgeJob,
  getLocalBridgeJobEvents,
  listLocalBridgeJobs,
  reconcileLocalBridgeJobs,
} from '../../src/cli/local-bridge/job-store';
import { startLocalBridgeServer, type LocalBridgeServerHandle } from '../../src/cli/local-bridge/server';
import { startConfiguredRuntimeLocalBridge } from '../../src/cli/local-bridge/runtime-bridge';
import { isProcessAlive } from '../../src/runtime/shared/process-tree';
import {
  projectAgentRunToLocalBridgeJob,
  projectAgentRunToLocalBridgeStatus,
  reconcileLocalBridgeJobs as reconcileLocalBridgeJobsInRuntime,
  refreshLocalBridgeJob as refreshLocalBridgeJobInRuntime,
} from '../../src/runtime/local-bridge/lifecycle';
import type { LocalBridgeJob } from '../../src/runtime/local-bridge/types';
import {
  loadRepositoryRegistry,
  registerRepository,
  resolveRepositorySelection,
} from '../../src/runtime/repositories/registry';
import { acquireControllerLock, releaseControllerLock } from '../../src/effects/controller-locks';
import { createSchedule, saveOccurrence, saveSchedule } from '../../src/runtime/workflow/schedules/store';
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from '../runtime/process-hygiene';

const roots: string[] = [];
const repoRoots: string[] = [];
const servers: LocalBridgeServerHandle[] = [];
const originalControllerHome = process.env.FORGE_CONTROLLER_HOME;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  const cleanupRoots = repoRoots.splice(0);
  for (const repoRoot of cleanupRoots) {
    for (const job of listLocalBridgeJobs(repoRoot, 5000)) {
      if (['approved', 'dispatched', 'running'].includes(job.status)) {
        cancelLocalBridgeJob(repoRoot, job.jobId);
      }
    }
    for (const run of listAgentJobs(repoRoot, 5000)) {
      if (run.provider === 'local' && ['queued', 'starting', 'running', 'unknown'].includes(run.status)) {
        cancelAgentJob(repoRoot, run.runId);
      }
    }
  }
  const cleanupPaths = [...new Set([...cleanupRoots, ...roots])];
  await terminateProcessesByCommand(cleanupPaths);
  await waitForNoProcessesByCommand(cleanupPaths);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
  else process.env.FORGE_CONTROLLER_HOME = originalControllerHome;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-local-bridge-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-local-bridge-controller-'));
  roots.push(root);
  roots.push(controllerHome);
  repoRoots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, '.ai/harness'), { recursive: true });
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge/mcp.local.json'),
    `${JSON.stringify(
      {
        version: 1,
        devMode: {
          agentRunner: true,
          allowedAgents: ['codex'],
          timeoutMs: 10_000,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'tasks/current.md'), '# Current\n');
  expect(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status).toBe(0);
  process.env.FORGE_CONTROLLER_HOME = controllerHome;
  registerRepository({ path: root, controllerHome });
  return root;
}

describe('Local Execution Bridge', () => {
  test('projects terminal Agent Run evidence into a LocalBridge Job without mutating the stored snapshot', () => {
    const current = {
      schemaVersion: 1 as const,
      jobId: 'job-1',
      action: 'quick-agent-session' as const,
      payload: { title: 'test', objective: 'test' },
      requestedBy: 'test',
      approval: 'auto' as const,
      status: 'running' as const,
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
      runId: 'run-1',
      result: { retained: true },
    };
    const projection = projectAgentRunToLocalBridgeJob(
      current,
      {
        runId: 'run-1',
        status: 'succeeded',
        finishedAt: '2026-11-14T00:01:00.000Z',
        exitCode: 0,
        integratedSessionId: 'edit-1',
        changeOutcome: 'changed',
        changedFiles: ['src/a.ts'],
      },
      '2026-11-14T00:02:00.000Z',
    );
    expect(projection).toMatchObject({
      previousStatus: 'running',
      statusChanged: true,
      terminal: true,
      event: {
        type: 'job_succeeded',
        message: 'Linked Run run-1 moved Local Job to succeeded.',
        data: { runStatus: 'succeeded' },
      },
    });
    expect(projection.job).toMatchObject({
      status: 'succeeded',
      finishedAt: '2026-11-14T00:01:00.000Z',
      result: {
        retained: true,
        runId: 'run-1',
        runStatus: 'succeeded',
        exitCode: 0,
        integratedSessionId: 'edit-1',
        changeOutcome: 'changed',
        changedFiles: ['src/a.ts'],
      },
      outcome: { process: { exitCode: 0 } },
    });
    expect(projection.job.error).toBeUndefined();
    expect(current).toMatchObject({ status: 'running', result: { retained: true } });
  });
  test('keeps LocalBridge reconciliation decisions in Runtime and delegates repository effects', () => {
    const makeJob = (
      jobId: string,
      status: LocalBridgeJob['status'],
      action: LocalBridgeJob['action'],
    ): LocalBridgeJob => ({
      schemaVersion: 1,
      jobId,
      action,
      payload: action === 'run-check' ? { checkId: 'check-1' } : { title: 'test', objective: 'test' },
      requestedBy: 'test',
      approval: 'auto',
      status,
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    });
    const jobs = [
      makeJob('approved', 'approved', 'quick-agent-session'),
      makeJob('running-check', 'running', 'run-check'),
      makeJob('already-terminal', 'cancelled', 'quick-agent-session'),
    ];
    let revisionReads = 0;
    const refreshed: string[] = [];
    const result = reconcileLocalBridgeJobsInRuntime('/repo', {
      listActiveJobs: () => jobs,
      currentCheckRevision: () => {
        revisionReads += 1;
        return 'revision-1';
      },
      refreshJob: (_repoRoot, job, checkRevision) => {
        refreshed.push(`${job.jobId}:${checkRevision}`);
        return { ...job, status: job.jobId === 'running-check' ? 'stale' : 'succeeded' };
      },
    });

    expect(result).toEqual({ scanned: 3, active: 2, terminalized: 2 });
    expect(revisionReads).toBe(1);
    expect(refreshed).toEqual(['approved:revision-1', 'running-check:revision-1']);
  });

  test('keeps LocalBridge refresh transitions in Runtime and delegates effects', () => {
    const at = new Date().toISOString();
    const job: LocalBridgeJob = {
      schemaVersion: 1,
      jobId: 'running-check',
      action: 'run-check',
      payload: { checkId: 'check-1' },
      requestedBy: 'test',
      approval: 'auto',
      status: 'running',
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      revision: 'old-revision',
      ownerPid: process.pid,
    };
    const events: Array<{ type: string; message?: string; data?: Record<string, unknown> }> = [];
    let saved = false;
    let released = false;
    const refreshed = refreshLocalBridgeJobInRuntime('/repo', job, 'new-revision', {
      currentPid: process.pid,
      now: () => at,
      resolveJobTimeout: () => 60_000,
      currentCheckRevision: () => {
        throw new Error('provided reconciliation revision should be reused');
      },
      isPidAlive: () => true,
      signalWorker: () => {},
      releaseCheckSubscription: () => {
        released = true;
      },
      syncProjectedExecutionJob: (_root, current) => current,
      getAgentRun: () => {
        throw new Error('Agent Run lookup is not expected for a running check');
      },
      cleanupEphemeralJob: () => {},
      appendEvent: (_root, _jobId, event) => {
        events.push(event);
      },
      saveJob: (_root, current) => {
        saved = true;
        return current;
      },
    });

    expect(refreshed.status).toBe('stale');
    expect(refreshed.error).toContain('became stale');
    expect(events).toMatchObject([{ type: 'job_failed', data: { stale: true, timedOut: false, orphaned: false } }]);
    expect(saved).toBe(true);
    expect(released).toBe(true);
  });

  test('uses the injected Runtime clock for repository-command execution deadlines', () => {
    const root = '/repo';
    const actualNow = Date.now();
    const injectedNow = new Date(actualNow + 60_000).toISOString();
    const deadlineAt = new Date(actualNow + 30_000).toISOString();
    const startedAt = new Date(actualNow - 60_000).toISOString();
    const job: LocalBridgeJob = {
      schemaVersion: 1,
      jobId: 'timed-out-repository-command',
      action: 'repository-command',
      payload: { controllerHome: root, repoId: 'repo-test', command: {} as never },
      requestedBy: 'test',
      approval: 'auto',
      status: 'running',
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
      deadlineAt,
      ownerPid: process.pid,
      workerPid: 12345,
    };
    const events: Array<{ type: string; message?: string; data?: Record<string, unknown> }> = [];
    let saved = false;
    let signalled = false;
    const refreshed = refreshLocalBridgeJobInRuntime(root, job, undefined, {
      currentPid: process.pid,
      now: () => injectedNow,
      resolveJobTimeout: () => 60_000,
      currentCheckRevision: () => {
        throw new Error('check revision should not be read for a repository-command job');
      },
      isPidAlive: () => true,
      signalWorker: () => {
        signalled = true;
      },
      releaseCheckSubscription: () => {
        throw new Error('repository-command must not release a check subscription');
      },
      syncProjectedExecutionJob: (_root, current) => current,
      getAgentRun: () => {
        throw new Error('Agent Run lookup is not expected for a repository-command job');
      },
      cleanupEphemeralJob: () => {},
      appendEvent: (_root, _jobId, event) => {
        events.push(event);
      },
      saveJob: (_root, current) => {
        saved = true;
        return current;
      },
    });

    expect(refreshed.status).toBe('timed_out');
    expect(refreshed.finishedAt).toBe(injectedNow);
    expect(refreshed.error).toContain('repository-command exceeded');
    expect(events).toMatchObject([{ type: 'job_failed', data: { timedOut: true } }]);
    expect(saved).toBe(true);
    expect(signalled).toBe(true);
  });

  test('projects Agent Run states through the Runtime-owned LocalBridge vocabulary', () => {
    expect(projectAgentRunToLocalBridgeStatus('queued')).toBe('dispatched');
    for (const status of ['starting', 'running', 'waiting_for_user'] as const) {
      expect(projectAgentRunToLocalBridgeStatus(status)).toBe('running');
    }
    expect(projectAgentRunToLocalBridgeStatus('succeeded')).toBe('succeeded');
    expect(projectAgentRunToLocalBridgeStatus('cancelled')).toBe('cancelled');
    for (const status of ['failed', 'unknown'] as const) {
      expect(projectAgentRunToLocalBridgeStatus(status)).toBe('failed');
    }
  });

  test('does not register retired Local Bridge creation and legacy progress mutation routes', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);

    for (const path of [
      '/api/jobs',
      '/api/tasks/launch-ready',
      '/api/issues/ISS-test/launch',
      '/api/issues/ISS-test/tasks/T1/launch',
    ]) {
      const response = await fetch(new URL(path, handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-local-token': handle.token },
        body: '{}',
      });
      expect(response.status).toBe(404);
    }
    for (const path of ['/api/progress', '/api/issues/ISS-test/tasks/T1']) {
      const response = await fetch(new URL(path, handle.url), { headers: { 'x-forge-local-token': handle.token } });
      expect(response.status).toBe(404);
    }
    // Legacy mutations are retired even before repository portfolio migration.
    const retiredWriteRoutes = [
      ['PATCH', '/api/project-state'],
      ...[
        '/api/issues/ISS-test/focus',
        '/api/issues/ISS-test/archive',
        '/api/issues/ISS-test/restore',
        '/api/issues/ISS-test/tasks/T1/verify',
        '/api/issues/ISS-test/tasks/T1/accept',
        '/api/issues/ISS-test/tasks/T1/request-changes',
        '/api/issues/ISS-test/tasks/T1/cancel',
        '/api/issues/ISS-test/tasks/T1/dependencies',
      ].map((path) => ['POST', path]),
    ];
    for (const [method, path] of retiredWriteRoutes) {
      const response = await fetch(new URL(path, handle.url), {
        method,
        headers: { 'content-type': 'application/json', 'x-forge-local-token': handle.token },
        body: '{}',
      });
      expect(response.status).toBe(404);
    }
  });

  test('retires an approved historical Local Bridge Job instead of dispatching it', () => {
    const root = repo();
    const jobId = 'historical-approved-job';
    const createdAt = new Date().toISOString();
    const jobDirectory = join(root, '.ai/harness/local-jobs', jobId);
    mkdirSync(jobDirectory, { recursive: true });
    writeFileSync(
      join(jobDirectory, 'job.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        jobId,
        action: 'repository-command',
        payload: {},
        requestedBy: 'test',
        approval: 'auto',
        status: 'approved',
        createdAt,
        updatedAt: createdAt,
      })}\n`,
    );

    const retired = dispatchLocalBridgeJob(root, jobId);
    expect(retired.status).toBe('failed');
    expect(retired.error).toContain('LOCAL_BRIDGE_JOB_RETIRED');
    expect(getLocalBridgeJobEvents(root, jobId).at(-1)).toMatchObject({
      type: 'job_failed',
      data: { legacyDispatchRetired: true },
    });
    expect(listLocalBridgeJobs(root, 10)).toMatchObject([{ jobId, status: 'failed' }]);
    expect(reconcileLocalBridgeJobs(root)).toMatchObject({ scanned: 0, active: 0, terminalized: 0 });
  });

  test('starts successfully when Local Job runtime storage is already linked', async () => {
    const root = repo();
    const first = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    await first.close();
    expect(lstatSync(join(root, '.ai/harness/local-jobs')).isSymbolicLink()).toBe(true);

    const second = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(second);
    expect((await fetch(new URL('/health', second.url))).status).toBe(200);
  });

  test('repairs a dangling local-job storage link before startup reconciliation', async () => {
    const root = repo();
    const localJobsPath = join(root, '.ai/harness/local-jobs');
    symlinkSync(join(root, '.missing-runtime-storage'), localJobsPath, 'dir');

    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);

    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const repository = loadRepositoryRegistry(controllerHome).repositories.find(
      (entry) => entry.canonicalRoot === realpathSync(root),
    );
    expect(repository).toBeTruthy();
    const controllerLocalJobs = join(controllerHome, 'repositories', repository!.repoId, 'local-jobs');
    expect(realpathSync(localJobsPath)).toBe(realpathSync(controllerLocalJobs));
    expect((await fetch(new URL('/health', handle.url))).status).toBe(200);
  });

  test('starts and stops the configured embedded LocalBridge through the CLI Runtime bridge', async () => {
    const root = repo();
    const controllerHome = process.env.FORGE_CONTROLLER_HOME;
    if (!controllerHome) throw new Error('test repository did not configure Controller Home');
    const at = new Date().toISOString();
    writeMcpServiceLocalConfig(controllerHome, {
      version: 1,
      repo: root,
      profile: 'controller',
      localController: { enabled: true, mode: 'embedded', host: '127.0.0.1', port: 0 },
    });
    writeMcpServiceRuntimeState(controllerHome, {
      version: 1,
      repo: root,
      startedAt: at,
      updatedAt: at,
      status: 'running',
      tunnelMode: 'none',
      server: { endpoint: 'http://127.0.0.1:0', running: true, healthy: true, restartCount: 0 },
    });

    const bridge = await startConfiguredRuntimeLocalBridge({ controllerHome, repositoryRoot: root });
    if (!bridge) throw new Error('configured embedded LocalBridge did not start');
    try {
      expect((await fetch(new URL('/health', bridge.endpoint))).status).toBe(200);
      expect(loadMcpServiceRuntimeState(controllerHome)?.localController).toMatchObject({
        endpoint: bridge.endpoint,
        running: true,
        mode: 'embedded',
        pid: process.pid,
      });
    } finally {
      await bridge.close();
    }
    expect(loadMcpServiceRuntimeState(controllerHome)?.localController).toMatchObject({
      running: false,
      pid: process.pid,
    });
  });

  test('classifies full repository gates as heavy while leaving focused checks concurrent', () => {
    expect(controllerCheckConcurrencyClass('package:test')).toBe('heavy');
    // The unified Forge Runtime suite is an ordinary heavy repository gate.
    expect(controllerCheckConcurrencyClass('package:check:forge-runtime')).toBe('heavy');
    expect(controllerCheckConcurrencyClass('package:check:release-surface')).toBe('heavy');
    expect(controllerCheckConcurrencyClass('focused')).toBe('light');
    expect(controllerCheckConcurrencyClass('package:check:type')).toBe('light');
  });

  test('waits for a repository heavy-check lock held by another Controller', async () => {
    const root = repo();
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(
      join(root, '.forge/checks.json'),
      JSON.stringify({
        version: 1,
        checks: {
          'check:release': {
            command: [process.execPath, '-e', 'process.exit(0)'],
            timeoutMs: 5_000,
          },
        },
      }),
    );
    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const repository = loadRepositoryRegistry(controllerHome).repositories.find(
      (entry) => entry.canonicalRoot === realpathSync(root),
    );
    expect(repository).toBeTruthy();
    const lockPath = join(controllerHome, 'repositories', repository!.repoId, 'checks', 'locks', 'heavy-check.lock');
    mkdirSync(join(controllerHome, 'repositories', repository!.repoId, 'checks', 'locks'), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        lockId: 'external-controller',
        controllerPid: process.pid,
        checkId: 'package:test',
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const pids: number[] = [];
    const pending = runControllerCheckAsync(root, 'check:release', {
      onSpawn: (pid) => pids.push(pid),
    });
    await Bun.sleep(150);
    expect(pids).toHaveLength(0);
    rmSync(lockPath, { force: true });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(pids).toHaveLength(1);
  });

  test('notifies every subscriber when a deduplicated check spawns', async () => {
    const root = repo();
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(
      join(root, '.forge/checks.json'),
      JSON.stringify({
        version: 1,
        checks: {
          shared: {
            command: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 500)'],
            timeoutMs: 5_000,
          },
        },
      }),
    );
    const firstPids: number[] = [];
    const secondPids: number[] = [];
    const first = runControllerCheckAsync(root, 'shared', {
      onSpawn: (pid) => firstPids.push(pid),
    });
    await Bun.sleep(25);
    const second = runControllerCheckAsync(root, 'shared', {
      onSpawn: (pid) => secondPids.push(pid),
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.executedAt).toBe(firstResult.executedAt);
    expect(firstPids).toHaveLength(1);
    expect(secondPids).toEqual(firstPids);
  });

  test('fails a check when the command exits but leaves a child process tree behind', async () => {
    const root = repo();
    mkdirSync(join(root, '.forge'), { recursive: true });
    const childPidPath = join(root, 'leaky-check-child.pid');
    writeFileSync(
      join(root, '.forge/checks.json'),
      JSON.stringify({
        version: 1,
        checks: {
          leaky: {
            command: [
              process.execPath,
              '-e',
              `
            const { spawn } = require("child_process");
            const { writeFileSync } = require("fs");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), "utf8");
            process.exit(0);
          `,
            ],
            timeoutMs: 5_000,
          },
        },
      }),
    );

    const result = await runControllerCheckAsync(root, 'leaky');
    let childPid: number | undefined;
    for (let attempt = 0; attempt < 80 && childPid === undefined; attempt += 1) {
      if (existsSync(childPidPath)) {
        const value = Number.parseInt(readFileSync(childPidPath, 'utf8').trim(), 10);
        if (Number.isInteger(value) && value > 0) childPid = value;
      }
      if (childPid === undefined) await Bun.sleep(25);
    }

    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    // The supervised bridge reports the residual process as a failure code.
    expect(result.stderr).toMatch(/CHILD_SUPERVISOR_RESIDUAL_PROCESS|check process tree remained alive/);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  test('releasing one shared-check subscriber does not terminate the remaining subscriber', async () => {
    const root = repo();
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(
      join(root, '.forge/checks.json'),
      JSON.stringify({
        version: 1,
        checks: {
          shared: {
            command: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 350)'],
            timeoutMs: 5_000,
          },
        },
      }),
    );
    const first = runControllerCheckAsync(root, 'shared', { subscriberId: 'subscriber:first' });
    await Bun.sleep(20);
    const second = runControllerCheckAsync(root, 'shared', { subscriberId: 'subscriber:second' });
    const released = releaseControllerCheckSubscription('subscriber:first');
    expect(released.released).toBe(true);
    expect(released.remainingSubscribers).toBe(1);
    expect(released.terminationRequested).toBe(false);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(secondResult.executedAt).toBe(firstResult.executedAt);
  });

  test('startup reconciliation detects Worker PID reuse without killing the unrelated process', async () => {
    const root = repo();
    const issue = writeLegacyIssueFixture(root, {
      title: 'Orphaned worker',
      tasks: [
        {
          title: 'Recover',
          objective: 'Mark stale ownership without killing a PID-reused process.',
          allowedPaths: ['src/example.ts'],
          risk: 'low',
        },
      ],
    });
    const runId = 'RUN-orphaned-detached-worker';
    const runDir = join(root, '.ai/harness/jobs', runId);
    mkdirSync(runDir, { recursive: true });
    for (const name of ['stdout.log', 'stderr.log', 'events.jsonl']) {
      writeFileSync(join(runDir, name), '');
    }
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const now = new Date().toISOString();
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify(
        {
          schemaVersion: 3,
          repoId: 'repo-test',
          checkoutId: 'checkout-test',
          runId,
          issueId: issue.id,
          taskId: 'T1',
          agent: 'codex',
          provider: 'local',
          executionMode: 'workspace',
          status: 'running',
          repoRoot: root,
          executionRoot: root,
          worktree: root,
          worktreePath: root,
          branch: null,
          baseRevision: null,
          promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
          stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
          stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
          resultPath: `.ai/harness/jobs/${runId}/result.json`,
          eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
          controllerPid: 999_999,
          controllerEpoch: 'stale-epoch',
          controllerEpochPath: '.ai/harness/controller/runtime-owner.json',
          workerPid: worker.pid,
          createdAt: now,
          startedAt: now,
          lastHeartbeatAt: now,
          progress: {
            phase: 'editing',
            currentActivity: 'stale worker',
            lastActivityAt: now,
            activityCount: 1,
          },
        },
        null,
        2,
      )}\n`,
    );
    updateTask(root, issue.id, 'T1', { status: 'running', runId });

    try {
      const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
      servers.push(handle);
      let alive = true;
      for (let attempt = 0; attempt < 80 && alive; attempt += 1) {
        await Bun.sleep(25);
        try {
          process.kill(worker.pid!, 0);
        } catch {
          alive = false;
        }
      }
      const run = getAgentJob(root, runId);
      expect(run.status).toBe('unknown');
      expect(run.error).toContain('Worker PID was reused by an unrelated process');
      expect(alive).toBe(true);
    } finally {
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
  });

  test('startup reconciliation fail-closes a running Run that lost ownership metadata', async () => {
    const root = repo();
    const issue = writeLegacyIssueFixture(root, {
      title: 'Missing run ownership',
      tasks: [
        {
          title: 'Recover',
          objective: 'Stop a local worker whose ownership metadata disappeared.',
          allowedPaths: ['src/example.ts'],
          risk: 'low',
        },
      ],
    });
    const runId = 'RUN-missing-ownership';
    const runDir = join(root, '.ai/harness/jobs', runId);
    mkdirSync(runDir, { recursive: true });
    for (const name of ['stdout.log', 'stderr.log', 'events.jsonl']) {
      writeFileSync(join(runDir, name), '');
    }
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const now = new Date().toISOString();
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify(
        {
          schemaVersion: 3,
          repoId: 'repo-test',
          checkoutId: 'checkout-test',
          runId,
          issueId: issue.id,
          taskId: 'T1',
          agent: 'codex',
          provider: 'local',
          executionMode: 'workspace',
          status: 'running',
          repoRoot: root,
          executionRoot: root,
          worktree: root,
          worktreePath: root,
          branch: null,
          baseRevision: null,
          promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
          stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
          stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
          resultPath: `.ai/harness/jobs/${runId}/result.json`,
          eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
          workerPid: worker.pid,
          createdAt: now,
          startedAt: now,
          lastHeartbeatAt: now,
          progress: {
            phase: 'editing',
            currentActivity: 'ownership disappeared',
            lastActivityAt: now,
            activityCount: 1,
          },
        },
        null,
        2,
      )}\n`,
    );
    updateTask(root, issue.id, 'T1', { status: 'running', runId });

    try {
      const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
      servers.push(handle);
      let alive = true;
      for (let attempt = 0; attempt < 80 && alive; attempt += 1) {
        await Bun.sleep(25);
        try {
          process.kill(worker.pid!, 0);
        } catch {
          alive = false;
        }
      }
      const run = getAgentJob(root, runId);
      expect(run.status).toBe('unknown');
      expect(run.error).toContain('ownership metadata is missing');
      expect(alive).toBe(false);
    } finally {
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
  });

  test('serves V5 governance and read paths while retiring legacy Issue mutations', async () => {
    const root = repo();
    const issue = writeLegacyIssueFixture(root, {
      title: 'V5 API surface',
      summary: 'Expose progress and evidence.',
      goals: ['Inspect one Task.'],
      acceptanceCriteria: ['The V5 endpoints respond.'],
      tasks: [
        {
          title: 'Inspect',
          objective: 'Return Task detail and timeline.',
          allowedPaths: ['src/**'],
          checks: ['focused'],
          acceptanceCriteria: ['Visible'],
          risk: 'low',
        },
      ],
    });
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(
      join(root, '.forge/checks.json'),
      JSON.stringify({
        version: 1,
        checks: { focused: { command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 10_000 } },
      }),
    );
    const runId = 'RUN-v5-api-succeeded';
    const runDir = join(root, '.ai/harness/jobs', runId);
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    for (const name of ['stdout.log', 'stderr.log', 'events.jsonl']) writeFileSync(join(runDir, name), '');
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          runId,
          issueId: issue.id,
          taskId: 'T1',
          agent: 'codex',
          provider: 'local',
          executionMode: 'workspace',
          status: 'succeeded',
          repoRoot: realpathSync(root),
          worktree: realpathSync(root),
          branch: null,
          baseRevision: null,
          promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
          stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
          stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
          resultPath: `.ai/harness/jobs/${runId}/result.json`,
          eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
          timeoutMs: 10_000,
          createdAt: now,
          startedAt: now,
          finishedAt: now,
          integratedSessionId: 'EDIT-v5-api-fixture',
          progress: { phase: 'completed', currentActivity: 'complete', lastActivityAt: now, activityCount: 1 },
        },
        null,
        2,
      ),
    );
    updateTask(root, issue.id, 'T1', { status: 'review', runId, note: 'Ready for verification.' });
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);
    const headers = { 'x-forge-local-token': handle.token };

    for (const path of [
      `/api/issues/${issue.id}/focus`,
      `/api/issues/${issue.id}/tasks/T1/verify`,
      `/api/issues/${issue.id}/tasks/T1/accept`,
    ]) {
      const response = await fetch(new URL(path, handle.url), {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmAcceptance: true }),
      });
      expect(response.status).toBe(404);
    }
    expect(getIssue(root, issue.id).tasks[0]?.status).toBe('review');
    const governance = await fetch(new URL('/api/governance', handle.url), { headers }).then((response) =>
      response.json(),
    );
    expect(Array.isArray(governance.executionQueue)).toBe(true);

    const configured = await fetch(new URL('/api/github/plugin', handle.url), {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, repository: 'owner/repo', syncMode: 'checkpoint' }),
    }).then((response) => response.json());
    expect(configured.enabled).toBe(true);
    expect(configured.syncMode).toBe('checkpoint');

    const exported = await fetch(new URL('/api/worklog/export', handle.url), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outputPath: 'tasks/reports/controller-v5.md' }),
    }).then((response) => response.json());
    expect(exported.eventCount).toBeGreaterThan(0);
    expect(existsSync(join(root, exported.path))).toBe(true);
  });

  test('serves generic plugin discovery and durable plugin action submission APIs', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);
    const headers = { 'x-forge-local-token': handle.token };

    const listed = await fetch(new URL('/api/plugins', handle.url), { headers }).then((response) => response.json());
    expect(listed.plugins.map((plugin: { pluginId: string }) => plugin.pluginId)).toContain('github');

    const accepted = await fetch(new URL('/api/plugins/github/actions/configure', handle.url), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'plugin-config-local-1',
        arguments: { enabled: true, repository: 'owner/repo', sync_mode: 'checkpoint' },
      }),
    }).then((response) => response.json());
    expect(accepted.accepted).toBe(true);
    expect(accepted.action.confirmation).toBe('authorization');
    expect(accepted.job.type).toBe('plugin-action');
    const snapshot = await fetch(new URL('/api/snapshot', handle.url), { headers }).then((response) => response.json());
    expect(snapshot.assistantPlugins.map((plugin: { pluginId: string }) => plugin.pluginId)).toContain('github');
    expect(Array.isArray(snapshot.mobileIntents.devices)).toBe(true);

    const plugin = await fetch(new URL('/api/plugins/github', handle.url), { headers }).then((response) =>
      response.json(),
    );
    expect(
      plugin.plugin.actions.some(
        (action: { actionId: string; confirmation: string }) =>
          action.actionId === 'close_issue' && action.confirmation === 'strong_confirmation',
      ),
    ).toBe(true);
  });

  test('projects repository schedules without personal-assistant routines', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);
    const headers = { 'x-forge-local-token': handle.token, 'content-type': 'application/json' };

    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const registeredRepository = loadRepositoryRegistry(controllerHome).repositories.find(
      (repository) => realpathSync(repository.canonicalRoot) === realpathSync(root),
    );
    expect(registeredRepository).toBeTruthy();
    const browserSchedule = createSchedule(controllerHome, {
      requestId: 'console-browser-watch',
      repoId: registeredRepository!.repoId,
      name: 'Apple ICP · QQ Mail Watcher',
      enabled: true,
      trigger: { type: 'cron', cronExpression: '0 20 * * *', timezone: 'Asia/Shanghai' },
      policy: {
        maxActiveOccurrences: 1,
        maxFailures: 3,
        cooldownMinutes: 60,
        dailyBudgetMinutes: 30,
        shadowMode: false,
      },
      action: {
        operation: 'browser_probe',
        target: 'runtime',
        arguments: {
          work_id: 'WORK-ICP',
          controller_type: 'chatgpt',
          probe_session_id: 'browser-test',
          wake_on_change: true,
          keepalive_only: false,
        },
      },
      stopConditions: ['work_terminal', 'external_blocker'],
    });
    saveSchedule(controllerHome, {
      ...browserSchedule,
      lastObservationStatus: 'baseline',
      lastObservationAt: '2026-08-14T09:33:59.782Z',
    });
    saveOccurrence(controllerHome, {
      schemaVersion: 1,
      revision: 0,
      occurrenceId: 'OCC-CONSOLE-BROWSER-WATCH',
      scheduleId: browserSchedule.scheduleId,
      repoId: registeredRepository!.repoId,
      windowKey: 'console-browser-watch',
      status: 'skipped',
      decision: 'nothing_to_do',
      triggerContext: { source: 'manual' },
      createdAt: '2026-08-14T09:33:59.782Z',
      updatedAt: '2026-08-14T09:33:59.782Z',
      reason: 'Browser watcher baseline recorded; no Controller wake was emitted.',
    });
    const consoleWithWatcher = await fetch(new URL('/api/console/automations', handle.url), { headers }).then(
      (response) => response.json(),
    );
    const projectedWatcher = consoleWithWatcher.automations.find(
      (automation: { name: string }) => automation.name === 'Apple ICP · QQ Mail Watcher',
    );
    expect(projectedWatcher).toMatchObject({
      mode: 'browser_watch',
      modeLabel: '网页变更监听',
      status: 'enabled',
      schedule: '每天 20:00',
      delivery: '变化时唤醒 ChatGPT',
      live: true,
      targetLabel: '已绑定浏览器会话',
      observationStatus: 'baseline',
      lastResult: '已建立基线',
    });
    expect(projectedWatcher.boundWorkId).toBeUndefined();
    expect(projectedWatcher.history).toHaveLength(1);
    expect(projectedWatcher.history[0]).toMatchObject({
      result: '无变化',
      trigger: '手动',
      tone: 'gray',
      reason: '已建立观察基线；没有唤醒 ChatGPT。',
    });

    const failedWorkflow = createSchedule(controllerHome, {
      requestId: 'console-hourly-workflow-failed',
      repoId: registeredRepository!.repoId,
      name: 'Forge 新问题自动修复 Workflow',
      enabled: true,
      trigger: { type: 'cron', cronExpression: '0 * * * *', timezone: 'Asia/Shanghai' },
      policy: {
        maxActiveOccurrences: 1,
        maxFailures: 3,
        cooldownMinutes: 5,
        dailyBudgetMinutes: 240,
        shadowMode: false,
      },
      action: {
        operation: 'external_controller_wake',
        target: 'runtime',
        arguments: { work_id: 'WORK-ISSUE-REPAIR', controller_type: 'chatgpt' },
      },
      stopConditions: [],
    });
    saveSchedule(controllerHome, {
      ...failedWorkflow,
      enabled: false,
      consecutiveFailures: 3,
      pausedReason: 'Maximum consecutive failures reached.',
    });
    const completedWorkflow = createSchedule(controllerHome, {
      requestId: 'console-completed-workflow',
      repoId: registeredRepository!.repoId,
      name: '有限任务',
      enabled: false,
      trigger: { type: 'interval', everyMinutes: 180 },
      policy: {
        maxActiveOccurrences: 1,
        maxFailures: 3,
        cooldownMinutes: 10,
        dailyBudgetMinutes: 240,
        shadowMode: false,
      },
      action: {
        operation: 'external_controller_wake',
        target: 'runtime',
        arguments: { work_id: 'WORK-DONE', controller_type: 'chatgpt' },
      },
      stopConditions: ['work_terminal'],
    });
    saveSchedule(controllerHome, { ...completedWorkflow, pausedReason: 'Work WORK-DONE is terminal (completed).' });
    const consoleStateSemantics = await fetch(new URL('/api/console/automations', handle.url), { headers }).then(
      (response) => response.json(),
    );
    const projectedFailedWorkflow = consoleStateSemantics.automations.find(
      (automation: { name: string }) => automation.name === 'Forge 新问题自动修复 Workflow',
    );
    expect(projectedFailedWorkflow).toBeUndefined();
    const projectedCompletedWorkflow = consoleStateSemantics.automations.find(
      (automation: { name: string }) => automation.name === '有限任务',
    );
    expect(projectedCompletedWorkflow).toBeUndefined();
    expect(consoleStateSemantics.summary.completed).toBe(0);

    for (const path of [
      '/api/assistant/intent',
      '/api/assistant/routines',
      '/api/assistant/readiness',
      '/api/assistant/maintenance/cleanup-preview',
    ]) {
      const response = await fetch(new URL(path, handle.url), { headers });
      expect(response.status).toBe(404);
    }
    const snapshot = await fetch(new URL('/api/snapshot', handle.url), { headers }).then((response) => response.json());
    expect(snapshot.assistant).toBeUndefined();
  });

  test('serves signed mobile Shortcut intents with device scopes, replay protection, and approval polling', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);
    const localHeaders = { 'x-forge-local-token': handle.token, 'content-type': 'application/json' };

    const created = await fetch(new URL('/api/mobile/devices', handle.url), {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({
        name: 'Greyson iPhone',
        scopes: ['plugins:read', 'jobs:read', 'plugin:gmail:configure', 'plugin:gmail:send_message'],
        rateLimitPerMinute: 10,
      }),
    }).then((response) => response.json());
    expect(created.device.deviceId).toBe('greyson-iphone');
    expect(created.token).toStartWith('rhmi_');
    expect(readFileSync(join(root, '.forge/mobile-intents.json'), 'utf-8')).not.toContain(created.token);

    function signedHeaders(body: string, nonce: string) {
      const timestamp = new Date().toISOString();
      const signature = createHmac('sha256', created.token).update(`${timestamp}.${nonce}.${body}`).digest('hex');
      return {
        'content-type': 'application/json',
        authorization: `Bearer ${created.token}`,
        'x-forge-device-id': created.device.deviceId,
        'x-forge-timestamp': timestamp,
        'x-forge-nonce': nonce,
        'x-forge-signature': signature,
      };
    }

    const listBody = JSON.stringify({ intent: 'list_plugins' });
    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const registeredRepository = resolveRepositorySelection({ explicitPath: root, controllerHome });
    const lockKey = { scope: 'repository' as const, repoId: registeredRepository.repoId };
    const heldStoreLock = acquireControllerLock(controllerHome, lockKey, 'test:mobile-intent-store-rotation');
    try {
      const busy = await fetch(new URL('/mobile/intent', handle.url), {
        method: 'POST',
        headers: signedHeaders(listBody, 'nonce-list-0001'),
        body: listBody,
      });
      expect(busy.status).toBe(503);
      expect(busy.headers.get('retry-after')).toBe('1');
      expect(await busy.json()).toEqual({ error: 'MOBILE_INTENT_STORE_BUSY' });
    } finally {
      releaseControllerLock(controllerHome, lockKey, heldStoreLock.lockId);
    }

    // The contended request must not consume the nonce or mutate the device record.
    const listed = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(listBody, 'nonce-list-0001'),
      body: listBody,
    }).then((response) => response.json());
    expect(listed.accepted).toBe(true);
    expect(listed.signatureVerified).toBe(true);
    expect(listed.plugins.map((plugin: { pluginId: string }) => plugin.pluginId)).toContain('gmail');

    const invalidSignatureHeaders = signedHeaders(listBody, 'nonce-bad-signature-0001');
    invalidSignatureHeaders['x-forge-signature'] = 'bad-signature';
    const invalidSignature = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: invalidSignatureHeaders,
      body: listBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(invalidSignature.status).toBe(401);
    expect(invalidSignature.body.error).toContain('MOBILE_INTENT_SIGNATURE_INVALID');

    const replay = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(listBody, 'nonce-list-0001'),
      body: listBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(replay.status).toBe(401);
    expect(replay.body.error).toContain('MOBILE_INTENT_REPLAY_DETECTED');

    const configureBody = JSON.stringify({
      intent: 'plugin_action',
      pluginId: 'gmail',
      actionId: 'configure',
      requestId: 'mobile-gmail-config',
      confirmAuthorization: true,
      arguments: { enabled: true, provider: 'mock', account_email: 'assistant@example.com' },
    });
    const configured = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(configureBody, 'nonce-config-0001'),
      body: configureBody,
    }).then((response) => response.json());
    expect(configured.accepted).toBe(true);
    expect(configured.job.type).toBe('plugin-action');
    expect(configured.job.origin.surface).toBe('mobile-intent');

    const missingApprovalBody = JSON.stringify({
      intent: 'plugin_action',
      pluginId: 'gmail',
      actionId: 'send_message',
      requestId: 'mobile-send-needs-approval',
      arguments: { to: ['recipient@example.com'], subject: 'Hi', body_text: 'Hello' },
    });
    const needsApproval = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(missingApprovalBody, 'nonce-send-0001'),
      body: missingApprovalBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(needsApproval.status).toBe(409);
    expect(needsApproval.body.approvalRequired).toBe(true);
    expect(needsApproval.body.action.requiredConfirmationText).toBe('send-gmail-message');

    const pollBody = JSON.stringify({ intent: 'poll_job', jobId: configured.job.jobId });
    const polled = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(pollBody, 'nonce-poll-0001'),
      body: pollBody,
    }).then((response) => response.json());
    expect(polled.job.jobId).toBe(configured.job.jobId);

    const revoked = await fetch(new URL(`/api/mobile/devices/${created.device.deviceId}/revoke`, handle.url), {
      method: 'POST',
      headers: localHeaders,
      body: '{}',
    }).then((response) => response.json());
    expect(revoked.device.revokedAt).toBeTruthy();

    const afterRevoke = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(listBody, 'nonce-after-revoke-0001'),
      body: listBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.error).toContain('MOBILE_INTENT_DEVICE_REVOKED');
  });

  test('persists signed AgentMail events as one canonical WorkflowRun receipt and rejects replay conflicts', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);
    const localHeaders = { 'x-forge-local-token': handle.token, 'content-type': 'application/json' };
    const created = await fetch(new URL('/api/mobile/devices', handle.url), {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({
        name: 'AgentMail macOS',
        deviceId: 'agentmail-macos',
        scopes: ['workflow:agentmail.mail-watch-event:execute'],
        rateLimitPerMinute: 120,
      }),
    }).then((response) => response.json());
    expect(created.device.scopes).toEqual(['workflow:agentmail.mail-watch-event:execute']);

    function signedHeaders(body: string, nonce: string) {
      const timestamp = new Date().toISOString();
      const signature = createHmac('sha256', created.token).update(`${timestamp}.${nonce}.${body}`).digest('hex');
      return {
        'content-type': 'application/json',
        authorization: `Bearer ${created.token}`,
        'x-forge-device-id': created.device.deviceId,
        'x-forge-timestamp': timestamp,
        'x-forge-nonce': nonce,
        'x-forge-signature': signature,
      };
    }

    const ruleId = '11111111-1111-4111-8111-111111111111';
    const accountId = '22222222-2222-4222-8222-222222222222';
    const providerMessageId = 'provider-message-' + 'm'.repeat(700);
    const event = {
      source: 'mail.watch.matched',
      event_id: ruleId + ':' + accountId + ':' + providerMessageId,
      observed_at: '2026-11-16T16:00:00.000Z',
      ref: {
        provider: 'agentmail',
        account_id: accountId,
        provider_message_id: providerMessageId,
      },
      summary: {
        rule_id: ruleId,
        sender_email: 'sender@example.com',
      },
      // The App target is explicit event data; sender and Watch rule identity never select a Case.
      route: { app_id: '6771288893' },
    };
    const forgedCasePayload = JSON.stringify({
      intent: 'workflow_event',
      event: {
        ...event,
        event_id: `${event.event_id}:forged-case`,
        route: { app_id: '6771288893', case_id: '30000012078130' },
      },
    });
    const forgedCase = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(forgedCasePayload, 'agentmail-event-forged-case'),
      body: forgedCasePayload,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(forgedCase.status).toBe(400);
    expect(forgedCase.body.error).toBe('MOBILE_INTENT_EVENT_ROUTE_INVALID');

    const unknownAppPayload = JSON.stringify({
      intent: 'workflow_event',
      event: {
        ...event,
        event_id: `${event.event_id}:unknown-app`,
        route: { app_id: '1234567890' },
      },
    });
    const unknownApp = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(unknownAppPayload, 'agentmail-event-unknown-app'),
      body: unknownAppPayload,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(unknownApp.status).toBe(400);
    expect(unknownApp.body.error).toBe('AGENTMAIL_APP_CASE_BINDING_UNKNOWN');

    expect(event.event_id.length).toBeGreaterThan(512);
    const body = JSON.stringify({ intent: 'workflow_event', event });
    const first = await fetch(new URL('/mobile/intent', handle.url), {
      method: 'POST',
      headers: signedHeaders(body, 'agentmail-event-0001'),
      body,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      accepted: true,
      durable: true,
      deduplicated: false,
      workflowId: 'agentmail.mail-watch-event',
      status: 'succeeded',
    });
    expect(first.body.workflowRunId).toBeString();

    // The canonical WorkflowRun is durable. Restart the bridge and replay the same event;
    // the already-succeeded run must be ACKed without executing the script again.
    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const registeredRepository = resolveRepositorySelection({ explicitPath: root, controllerHome });
    const scopeId = `repository:${registeredRepository!.repoId}:checkout:${registeredRepository!.activeCheckoutId}:workflow:agentmail.mail-watch-event`;
    const stored = readWorkflowRun(controllerHome, scopeId, first.body.workflowRunId);
    expect(stored?.value.status).toBe('succeeded');
    expect(stored?.value.outputs['validate-event']).toMatchObject({
      route: { app_id: '6771288893', case_id: '30000012066543' },
    });
    const persistedInputs = {
      ...event,
      route: { app_id: '6771288893', case_id: '30000012066543' },
    };
    expect(stored?.value.inputDigest).toBe(workflowInputDigest(persistedInputs));
    const originalProcessReceipt = stored?.value.receipts.find((receipt) => receipt.stepId === 'validate-event');
    expect(originalProcessReceipt?.outcome).toBe('succeeded');

    // Simulate a crash after the script Process succeeded but before its WorkflowRun
    // success checkpoint was persisted. Recovery must reuse that canonical Process receipt.
    writeWorkflowRunCheckpoint({
      controllerHome,
      expectedRevision: stored!.revision,
      inputs: persistedInputs,
      checkpoint: {
        schemaVersion: 1,
        binding: { scopeId, runId: first.body.workflowRunId },
        workflowId: stored!.value.workflowId,
        version: stored!.value.version,
        contentDigest: stored!.value.contentDigest,
        status: 'running',
        nextStepIndex: 0,
        receipts: [],
        outputs: {},
        inFlightStepId: 'validate-event',
      },
    });
    await handle.close();
    servers.splice(servers.indexOf(handle), 1);
    const restarted = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(restarted);

    const replay = await fetch(new URL('/mobile/intent', restarted.url), {
      method: 'POST',
      headers: signedHeaders(body, 'agentmail-event-0002'),
      body,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    if (replay.status !== 202) throw new Error(`AgentMail replay failed: ${JSON.stringify(replay.body)}`);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      accepted: true,
      durable: true,
      deduplicated: true,
      workflowId: 'agentmail.mail-watch-event',
      status: 'succeeded',
    });
    expect(replay.body.workflowRunId).toBe(first.body.workflowRunId);
    const recoveredRun = readWorkflowRun(controllerHome, scopeId, first.body.workflowRunId);
    expect(recoveredRun?.value.status).toBe('succeeded');
    const recoveredProcessReceipts = recoveredRun?.value.receipts.filter(
      (receipt) => receipt.stepId === 'validate-event',
    );
    expect(recoveredProcessReceipts).toHaveLength(1);
    expect(recoveredProcessReceipts?.[0]).toMatchObject({
      outcome: 'succeeded',
      receiptRef: originalProcessReceipt?.receiptRef,
    });
    expect(recoveredRun?.value.outputs['validate-event']).toMatchObject({
      route: { app_id: '6771288893', case_id: '30000012066543' },
    });

    const duplicate = await fetch(new URL('/mobile/intent', restarted.url), {
      method: 'POST',
      headers: signedHeaders(body, 'agentmail-event-0003'),
      body,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toMatchObject({ accepted: true, durable: true, deduplicated: true, status: 'succeeded' });
    expect(duplicate.body.workflowRunId).toBe(first.body.workflowRunId);

    const changedPayload = JSON.stringify({
      intent: 'workflow_event',
      event: { ...event, route: { app_id: '6831952477' } },
    });
    const conflict = await fetch(new URL('/mobile/intent', restarted.url), {
      method: 'POST',
      headers: signedHeaders(changedPayload, 'agentmail-event-0004'),
      body: changedPayload,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ accepted: false, error: 'WORKFLOW_RUN_IDENTITY_CONFLICT' });

    const succeededRun = readWorkflowRun(controllerHome, scopeId, first.body.workflowRunId);
    expect(succeededRun?.value.status).toBe('succeeded');
    writeWorkflowRunCheckpoint({
      controllerHome,
      expectedRevision: succeededRun!.revision,
      inputs: persistedInputs,
      checkpoint: {
        schemaVersion: 1,
        binding: { scopeId, runId: first.body.workflowRunId },
        workflowId: succeededRun!.value.workflowId,
        version: succeededRun!.value.version,
        contentDigest: succeededRun!.value.contentDigest,
        status: 'failed',
        nextStepIndex: 0,
        receipts: [],
        outputs: {},
      },
    });
    const failedReplay = await fetch(new URL('/mobile/intent', restarted.url), {
      method: 'POST',
      headers: signedHeaders(body, 'agentmail-event-0007'),
      body,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(failedReplay.status).toBe(503);
    expect(failedReplay.body).toMatchObject({
      accepted: false,
      durable: true,
      signatureVerified: true,
      status: 'WORKFLOW_RUN_FAILED_RESTART_REQUIRES_NEW_RUN_ID',
      workflowRunId: first.body.workflowRunId,
    });

    const unsafePayload = JSON.stringify({
      intent: 'workflow_event',
      event: { ...event, summary: { ...event.summary, body_text: 'OTP 123456' } },
    });
    const unsafe = await fetch(new URL('/mobile/intent', restarted.url), {
      method: 'POST',
      headers: signedHeaders(unsafePayload, 'agentmail-event-0005'),
      body: unsafePayload,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.error).toContain('MOBILE_INTENT_EVENT_FIELD_UNSUPPORTED');

    const oversizedPayload = JSON.stringify({
      intent: 'workflow_event',
      event: { ...event, event_id: 'x'.repeat(4097) },
    });
    const oversized = await fetch(new URL('/mobile/intent', restarted.url), {
      method: 'POST',
      headers: signedHeaders(oversizedPayload, 'agentmail-event-0006'),
      body: oversizedPayload,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toContain('MOBILE_INTENT_EVENT_ID_INVALID');
  });

  test('Local Bridge no longer exposes EditSession lifecycle routes or snapshot projection', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0 });
    servers.push(handle);
    const headers = { 'x-forge-local-token': handle.token };
    const snapshotResponse = await fetch(new URL('/api/snapshot', handle.url), { headers });
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot).not.toHaveProperty('editSessions');

    const retiredRoutes = [
      { method: 'GET', path: '/api/edit-sessions' },
      { method: 'GET', path: '/api/edit-sessions/session-1' },
      { method: 'GET', path: '/api/edit-sessions/session-1/diff' },
      { method: 'POST', path: '/api/edit-sessions/session-1/savepoints' },
      { method: 'POST', path: '/api/edit-sessions/session-1/verify' },
      { method: 'POST', path: '/api/edit-sessions/session-1/finalize' },
      { method: 'POST', path: '/api/edit-sessions/session-1/finish' },
      { method: 'POST', path: '/api/edit-sessions/session-1/rollback' },
    ] as const;
    for (const route of retiredRoutes) {
      const response = await fetch(new URL(route.path, handle.url), {
        method: route.method,
        headers: route.method === 'GET' ? headers : { ...headers, 'content-type': 'application/json' },
        ...(route.method === 'GET' ? {} : { body: JSON.stringify({}) }),
      });
      expect(response.status).toBe(404);
    }

    const retiredInput = await fetch(new URL('/api/console/edit/apply', handle.url), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ operations: [], sessionId: 'legacy-session', sessionless: false }),
    });
    expect(retiredInput.status).toBe(400);
    const retiredInputBody = await retiredInput.json();
    expect(retiredInputBody.error).toContain('unsupported console edit fields');
    expect(retiredInputBody.error).toContain('sessionId');
    expect(retiredInputBody.error).toContain('sessionless');
  });

  test('registers and soft-removes repositories through the local-bridge API', async () => {
    const root = repo();
    const otherRoot = mkdtempSync(join(tmpdir(), 'forge-local-bridge-other-'));
    roots.push(otherRoot);
    expect(spawnSync('git', ['init', '-b', 'main'], { cwd: otherRoot }).status).toBe(0);
    writeFileSync(join(otherRoot, 'README.md'), '# other\n');

    const handle = await startLocalBridgeServer({
      repoRoot: root,
      port: 0,
    });
    servers.push(handle);
    const headers = { 'x-forge-local-token': handle.token, 'content-type': 'application/json' };

    const registered = await fetch(new URL('/api/repositories/register', handle.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: otherRoot, displayName: 'Other Fixture' }),
    }).then(async (response) => {
      expect(response.status).toBe(201);
      return response.json();
    });
    expect(registered.repository.displayName).toBe('Other Fixture');
    expect(typeof registered.repository.repoId).toBe('string');
    expect(registered.repository.removedAt).toBeUndefined();

    const listedBefore = await fetch(new URL('/api/repositories', handle.url), { headers }).then((response) =>
      response.json(),
    );
    expect(listedBefore.repositories.some((entry: { id: string }) => entry.id === registered.repository.repoId)).toBe(
      true,
    );

    const removed = await fetch(
      new URL(`/api/repositories/${encodeURIComponent(registered.repository.repoId)}/remove`, handle.url),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      },
    ).then(async (response) => {
      expect(response.status).toBe(200);
      return response.json();
    });
    expect(removed.repository.repoId).toBe(registered.repository.repoId);
    expect(typeof removed.repository.removedAt).toBe('string');
    expect(removed.repository.enabled).toBe(false);
    expect(removed.summary).toContain('已删除仓库注册');
    expect(Array.isArray(removed.repositories)).toBe(true);
    expect(removed.repositories.some((entry: { id: string }) => entry.id === registered.repository.repoId)).toBe(false);

    const listedAfter = await fetch(new URL('/api/repositories', handle.url), { headers }).then((response) =>
      response.json(),
    );
    expect(listedAfter.repositories.some((entry: { id: string }) => entry.id === registered.repository.repoId)).toBe(
      false,
    );

    const missing = await fetch(new URL('/api/repositories/does-not-exist/remove', handle.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const missingBody = await missing.json();
    expect(String(missingBody.error)).toContain('repository not found');
  });

  test('serves a hardened localhost API surface', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({
      repoRoot: root,
      port: 0,
    });
    servers.push(handle);

    const health = await fetch(new URL('/health', handle.url)).then((response) => response.json());
    expect(health.status).toBe('ok');
    expect(health.localOnly).toBe(true);
    expect(health.repoRoot).toBeUndefined();
    expect(health.timeoutPolicy).toBeUndefined();
    expect(health.features).toBeUndefined();

    const denied = await fetch(new URL('/api/snapshot', handle.url));
    expect(denied.status).toBe(403);
    const deniedQueryToken = await fetch(
      new URL(`/api/snapshot?token=${encodeURIComponent(handle.token)}`, handle.url),
    );
    expect(deniedQueryToken.status).toBe(403);

    const rejectedOrigin = await fetch(new URL('/api/snapshot', handle.url), {
      headers: {
        origin: 'https://malicious.example',
        'x-forge-local-token': handle.token,
      },
    });
    expect(rejectedOrigin.status).toBe(403);

    const snapshot = await fetch(new URL('/api/snapshot', handle.url), {
      headers: { 'x-forge-local-token': handle.token },
    }).then((response) => response.json());
    expect(snapshot.repoRoot).toBe(realpathSync(root));
    expect(snapshot.board).toBeDefined();
    expect(snapshot.toolSurface).toBe(FORGE_TOOL_SURFACE);
    expect(snapshot.timeoutPolicy).toEqual({
      defaultTimeoutMs: 3_600_000,
      maxTimeoutMs: 43_200_000,
    });

    const auth = { 'x-forge-local-token': handle.token };
    for (const path of [
      '/api/console/automation-settings',
      '/api/console/provider-config',
      '/api/console/local-tools',
      '/api/console/executor-routing',
    ]) {
      expect((await fetch(new URL(path, handle.url), { headers: auth })).status).toBe(404);
    }
    const trackedWork = await fetch(new URL('/api/console/requirements', handle.url), { headers: auth }).then(
      (response) => response.json(),
    );
    expect(Array.isArray(trackedWork.requirements)).toBe(true);
    expect(typeof trackedWork.requirementCount).toBe('number');
    expect((await fetch(new URL('/api/console/work', handle.url), { headers: auth })).status).toBe(404);
    expect((await fetch(new URL('/api/console/work-portfolio', handle.url), { headers: auth })).status).toBe(404);
    const retiredContinuation = await fetch(new URL('/api/controller/codex-continuation', handle.url), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ launch: true }),
    });
    expect(retiredContinuation.status).toBe(404);
    expect(existsSync(join(root, '.ai', 'harness', 'continuations'))).toBe(false);
    const automations = await fetch(new URL('/api/console/automations', handle.url), { headers: auth }).then(
      (response) => response.json(),
    );
    expect(Array.isArray(automations.automations)).toBe(true);
    expect(typeof automations.summary.total).toBe('number');

    const plugins = await fetch(new URL('/api/console/plugins', handle.url), {
      headers: { 'x-forge-local-token': handle.token },
    }).then((response) => response.json());
    expect(Array.isArray(plugins.plugins)).toBe(true);
    expect(plugins.summary).toBeTruthy();
    expect(typeof plugins.summary.total).toBe('number');
    expect(plugins.plugins.some((entry: { id?: string }) => entry.id === 'browser')).toBe(false);
    expect(plugins.plugins.some((entry: { id?: string }) => entry.id === 'desktop')).toBe(false);
  });
});
