import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveBunExecutable } from '../../src/runtime/shared/process-environment';
import {
  buildSchedulerWorkerLaunchDescriptor,
  resolveSchedulerWorkerCommand,
  resolveSchedulerWorkerExecutable,
  selectSchedulerWorkerEnvironment,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';
import {
  buildSchedulerWorkerExitFailure,
  buildSchedulerWorkerExitedLifecycle,
  buildSchedulerWorkerRegisteredLifecycle,
  buildSchedulerWorkerSpawnFailureLifecycle,
  buildSchedulerWorkerSpawnedLifecycle,
} from '../../src/runtime/control-plane/global-scheduler/worker-lifecycle';
import { createSchedulerWorkerStderrCapture } from '../../src/runtime/control-plane/global-scheduler/worker-stderr';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('repository child process environment', () => {
  test('never treats a compiled Forge Runtime as Bun through FORGE_BUN_EXECUTABLE', () => {
    expect(resolveBunExecutable('/tmp/forge-runtime', {
      FORGE_BUN_EXECUTABLE: '/tmp/forge-runtime',
      HOME: '/Users/nonexistent-for-test',
    })).toBe(process.platform === 'win32' ? 'bun.exe' : 'bun');
  });

  test('accepts an explicit Bun command name', () => {
    expect(resolveBunExecutable('/tmp/forge-runtime', {
      FORGE_BUN_EXECUTABLE: 'bun',
      HOME: '/Users/nonexistent-for-test',
    })).toBe('bun');
  });

  test('uses the hosting executable only when it is Bun itself', () => {
    expect(resolveBunExecutable('bun', { HOME: '/Users/nonexistent-for-test' })).toBe('bun');
  });

  test('compiled Runtime scheduler resolves a real Bun executable instead of recursively spawning forge-runtime', () => {
    expect(resolveSchedulerWorkerExecutable(true, '/tmp/forge-runtime', {
      FORGE_BUN_EXECUTABLE: 'bun',
      HOME: '/Users/nonexistent-for-test',
    })).toBe('bun');
    expect(resolveSchedulerWorkerExecutable(false, '/tmp/node', {})).toBe('/tmp/node');
  });

  test('resolves and validates Scheduler worker command paths outside GlobalScheduler', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-worker-command-'));
    homes.push(root);
    const workerDir = join(root, 'src', 'runtime', 'execution', 'workers');
    const sharedDir = join(root, 'src', 'runtime', 'shared');
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    const entry = join(workerDir, 'worker-entry.ts');
    const loader = join(sharedDir, 'node-ts-loader.mjs');
    writeFileSync(entry, 'export {};\n');
    writeFileSync(loader, 'export {};\n');

    expect(resolveSchedulerWorkerCommand({ runtimeSourceRoot: root, isBun: false })).toEqual({
      entry,
      loader,
      cwd: root,
    });
    expect(() => resolveSchedulerWorkerCommand({
      runtimeSourceRoot: join(root, 'missing'),
      isBun: false,
    })).toThrow('WORKER_ENTRYPOINT_MISSING');
  });

  test('builds Scheduler worker launch args and separates child env from persisted diagnostics', () => {
    const command = { entry: '/runtime/worker-entry.ts', loader: '/runtime/node-ts-loader.mjs', cwd: '/runtime' };
    const launch = buildSchedulerWorkerLaunchDescriptor({
      command,
      controllerHome: '/controller',
      repoId: 'repo-a',
      jobId: 'job-a',
      controllerPid: 42,
      runtimeSourceRoot: '/runtime',
      isBun: false,
      execPath: '/usr/bin/node',
      environment: { PATH: '/usr/bin', SECRET_FOR_TEST: 'not-persisted' },
      writeClaimEnvironment: {
        FORGE_RUNTIME_INSTANCE_ID: 'runtime-a',
        FORGE_RELEASE_ID: 'release-a',
      },
    });

    expect(launch).toMatchObject({
      executable: '/usr/bin/node',
      args: [
        '--loader', '/runtime/node-ts-loader.mjs', '/runtime/worker-entry.ts',
        '--controller-home', '/controller', '--repo-id', 'repo-a', '--job-id', 'job-a', '--controller-pid', '42',
      ],
      cwd: '/runtime',
      environment: {
        PATH: '/usr/bin',
        SECRET_FOR_TEST: 'not-persisted',
        FORGE_EXECUTION_WORKER: '1',
        FORGE_CONTROLLER_HOME: '/controller',
        FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT: '/runtime',
        FORGE_RUNTIME_INSTANCE_ID: 'runtime-a',
        FORGE_RELEASE_ID: 'release-a',
      },
      lifecycleEnvironment: {
        PATH: '/usr/bin',
        FORGE_EXECUTION_WORKER: '1',
        FORGE_CONTROLLER_HOME: '/controller',
        FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT: '/runtime',
        FORGE_RUNTIME_INSTANCE_ID: 'runtime-a',
        FORGE_RELEASE_ID: 'release-a',
      },
    });
    expect(launch.lifecycleEnvironment).not.toHaveProperty('SECRET_FOR_TEST');
    expect(selectSchedulerWorkerEnvironment({ PATH: '/bin', EXTRA: 'hidden' })).toMatchObject({ PATH: '/bin' });
  });

  test('models Scheduler worker lifecycle diagnostics outside GlobalScheduler', () => {
    const launch = {
      executable: '/usr/bin/node',
      args: ['/runtime/worker-entry.ts'],
      cwd: '/runtime',
      environment: { PATH: '/usr/bin' },
      lifecycleEnvironment: { PATH: '/usr/bin' },
    };
    const spawned = buildSchedulerWorkerSpawnedLifecycle({
      launch,
      ownerPid: 42,
      releaseIdentity: {
        runtimeInstanceId: 'runtime-a',
        releaseAuthorityRevision: 7,
        releaseId: 'release-a',
        artifactIdentity: 'artifact-a',
        workerProtocolVersion: 3,
      },
      attempt: 2,
      maxAttempts: 3,
      stderrPath: '/tmp/stderr.log',
      spawnedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(spawned).toMatchObject({
      executable: '/usr/bin/node',
      startupState: 'spawned',
      runtimeInstanceId: 'runtime-a',
      attempt: 2,
      maxAttempts: 3,
    });

    const exited = buildSchedulerWorkerExitedLifecycle({
      lifecycle: spawned,
      childPid: 99,
      platform: 'linux',
      exitCode: 1,
      signal: null,
      stderr: 'boom',
      stderrTruncated: false,
      exitedAt: '2026-08-21T00:01:00.000Z',
    });
    expect(exited).toMatchObject({
      workerPid: 99,
      processGroupId: 99,
      startupState: 'exited',
      stderr: 'boom',
    });

    const registered = buildSchedulerWorkerRegisteredLifecycle({
      lifecycle: spawned,
      currentLifecycle: exited,
      workerPid: 99,
      platform: 'linux',
      attachedAt: '2026-08-21T00:00:01.000Z',
    });
    expect(registered).toMatchObject({
      workerPid: 99,
      processGroupId: 99,
      startupState: 'registered',
      attachedAt: '2026-08-21T00:00:01.000Z',
    });

    const failure = buildSchedulerWorkerExitFailure({
      lifecycle: exited,
      attempt: 2,
      maxAttempts: 3,
      exitCode: 1,
      signal: null,
      stderr: 'boom',
      stderrTruncated: false,
    });
    expect(failure.retryable).toBe(true);
    expect(failure.error).toMatchObject({
      code: 'WORKER_EXITED',
      retryable: true,
      details: {
        executable: '/usr/bin/node',
        runtimeInstanceId: 'runtime-a',
        attempt: 2,
        maxAttempts: 3,
      },
    });
    expect(failure.error.message).toContain('Worker stderr: boom');

    expect(buildSchedulerWorkerSpawnFailureLifecycle({
      executable: '/bad/runtime',
      cwd: '/runtime',
      environment: {},
      ownerPid: 42,
      attempt: 3,
      maxAttempts: 3,
      spawnedAt: '2026-08-21T00:00:00.000Z',
    })).toMatchObject({ startupState: 'spawn_failed', attempt: 3, maxAttempts: 3 });
  });

  test('captures Scheduler worker stderr with a bounded persisted diagnostic', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-worker-stderr-'));
    homes.push(home);
    const capture = createSchedulerWorkerStderrCapture({
      controllerHome: home,
      repoId: 'repo-a',
      jobId: 'job-a',
      attempt: 2,
      maxBytes: 5,
    });

    capture.append('abc');
    capture.append(Buffer.from('def'));

    expect(capture.path.endsWith('worker-stderr/job-a-attempt-2.log')).toBe(true);
    expect(capture.snapshot()).toEqual({ stderr: 'abcde', stderrTruncated: true });
    expect(readFileSync(capture.path, 'utf8')).toBe('abcde');
  });

  test.skipIf(process.platform === 'win32')('resolves ~/.bun/bin/bun from the OS account home when env -i removes HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-bun-home-'));
    homes.push(home);
    const bin = join(home, '.bun', 'bin');
    mkdirSync(bin, { recursive: true });
    const bun = join(bin, 'bun');
    writeFileSync(bun, 'fixture');
    expect(resolveBunExecutable('/tmp/forge-runtime', {}, home)).toBe(bun);
  });
});
