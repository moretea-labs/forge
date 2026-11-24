import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizeRuntimeOutboundProxyPolicy,
  repositoryChildProcessEnvironment,
  resolveBunExecutable,
  resolveRuntimeOutboundProxyEnvironment,
  runtimeAuthorityFreeEnvironment,
} from '../../src/runtime/shared/process-environment';
import {
  buildSchedulerWorkerLaunchDescriptor,
  resolveSchedulerWorkerCommand,
  resolveSchedulerWorkerExecutable,
  selectSchedulerWorkerEnvironment,
} from '../../src/runtime/control-plane/global-scheduler/worker-launch';
import { buildSchedulerWorkerExitFailure } from '../../src/runtime/control-plane/global-scheduler/worker-lifecycle';
import { createSchedulerWorkerStderrCapture } from '../../src/runtime/control-plane/global-scheduler/worker-stderr';
import { cleanupSchedulerWorkerProcesses } from '../../src/runtime/control-plane/global-scheduler/worker-process';
import { persistSchedulerTerminalWorkerLifecycle } from '../../src/runtime/control-plane/global-scheduler/worker-lifecycle-store';
import type { ExecutionJob, ExecutionWorkerLifecycle } from '../../src/runtime/execution/jobs/types';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('repository child process environment', () => {
  test('removes every host-private writer authority before a service boundary adds its own contract', () => {
    const sanitized = runtimeAuthorityFreeEnvironment({
      PATH: '/usr/bin:/bin',
      FORGE_WRITER_SLOT: 'host-writer-must-not-leak',
      FORGE_RUNTIME_INSTANCE_ID: 'runtime-a',
      FORGE_RUNTIME_INCARNATION_GENERATION: '7',
      FORGE_RELEASE_FENCING_TOKEN: 'secret-fence',
      FORGE_CONTROLLER_LIFECYCLE_OWNER: 'host-runtime',
      FORGE_SUPERVISOR_PRIVATE_STATE: 'private',
      USER_VISIBLE_SETTING: 'preserve-me',
    });

    expect(sanitized.FORGE_WRITER_SLOT).toBeUndefined();
    expect(sanitized.FORGE_RUNTIME_INSTANCE_ID).toBeUndefined();
    expect(sanitized.FORGE_RUNTIME_INCARNATION_GENERATION).toBeUndefined();
    expect(sanitized.FORGE_RELEASE_FENCING_TOKEN).toBeUndefined();
    expect(sanitized.FORGE_CONTROLLER_LIFECYCLE_OWNER).toBeUndefined();
    expect(sanitized.FORGE_SUPERVISOR_PRIVATE_STATE).toBeUndefined();
    expect(sanitized.USER_VISIBLE_SETTING).toBe('preserve-me');
  });

  test('passes only allowlisted proxy variables to repository children and always bypasses loopback', () => {
    const normalized = repositoryChildProcessEnvironment(
      {
        PATH: '/usr/bin',
        HTTP_PROXY: 'http://127.0.0.1:7890',
        https_proxy: 'http://127.0.0.1:7890',
        ALL_PROXY: 'socks5://127.0.0.1:7890',
        NO_PROXY: 'internal.local',
        no_proxy: 'registry.local',
      },
      'linux',
    );

    expect(normalized.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(normalized.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(normalized.ALL_PROXY).toBe('socks5://127.0.0.1:7890');
    expect(normalized).not.toHaveProperty('https_proxy');
    expect(normalized).not.toHaveProperty('no_proxy');
    expect(normalized.NO_PROXY).toContain('internal.local');
    expect(normalized.NO_PROXY).toContain('registry.local');
    expect(normalized.NO_PROXY).toContain('localhost');
    expect(normalized.NO_PROXY).toContain('127.0.0.1');
    expect(normalized.NO_PROXY).toContain('::1');
  });

  test('resolves explicit outbound proxy policy and rejects invalid or credential-bearing endpoints', () => {
    const resolved = resolveRuntimeOutboundProxyEnvironment(
      {
        mode: 'explicit',
        httpsProxy: 'http://127.0.0.1:7890',
        noProxy: 'internal.local',
      },
      {
        HTTP_PROXY: 'http://127.0.0.1:9000',
        https_proxy: 'http://127.0.0.1:9001',
        no_proxy: 'registry.local',
      },
      'linux',
    );

    expect(resolved.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(resolved.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(resolved.NO_PROXY).toContain('internal.local');
    expect(resolved.NO_PROXY).toContain('registry.local');
    expect(() => normalizeRuntimeOutboundProxyPolicy({ mode: 'explicit' })).toThrow(
      'FORGE_RUNTIME_OUTBOUND_PROXY_ENDPOINT_REQUIRED',
    );
    expect(() =>
      normalizeRuntimeOutboundProxyPolicy({
        mode: 'explicit',
        httpsProxy: 'http://user:password@127.0.0.1:7890',
      }),
    ).toThrow('FORGE_OUTBOUND_PROXY_URL_INVALID');
  });

  test('direct egress is explicit and clears inherited proxy variables', () => {
    const resolved = resolveRuntimeOutboundProxyEnvironment(
      {
        mode: 'direct',
        noProxy: 'internal.local',
      },
      {
        HTTP_PROXY: 'http://127.0.0.1:7890',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        ALL_PROXY: 'socks5://127.0.0.1:7890',
      },
      'linux',
    );

    expect(resolved.HTTP_PROXY).toBeUndefined();
    expect(resolved.HTTPS_PROXY).toBeUndefined();
    expect(resolved.ALL_PROXY).toBeUndefined();
    expect(resolved.NO_PROXY).toContain('internal.local');
    expect(resolved.NO_PROXY).toContain('localhost');
  });

  test('resolves current macOS system proxy snapshots and fails closed when unavailable', () => {
    const inherited = {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7890',
      NO_PROXY: 'internal.local',
    };
    const first = resolveRuntimeOutboundProxyEnvironment(
      { mode: 'macos-system' },
      inherited,
      'darwin',
      'HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\n',
    );
    const changed = resolveRuntimeOutboundProxyEnvironment(
      { mode: 'macos-system' },
      inherited,
      'darwin',
      'HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 6080\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 6080\n',
    );

    expect(first.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(changed.HTTP_PROXY).toBe('http://127.0.0.1:6080');
    expect(changed.HTTPS_PROXY).toBe('http://127.0.0.1:6080');
    expect(changed.ALL_PROXY).toBeUndefined();
    expect(changed.NO_PROXY).toContain('internal.local');
    expect(changed.NO_PROXY).toContain('127.0.0.1');
    expect(() =>
      resolveRuntimeOutboundProxyEnvironment(
        { mode: 'macos-system' },
        {},
        'darwin',
        'HTTPEnable : 0\nHTTPSEnable : 0\nSOCKSEnable : 0\n',
      ),
    ).toThrow('FORGE_RUNTIME_OUTBOUND_PROXY_SYSTEM_NOT_CONFIGURED');
    expect(() =>
      resolveRuntimeOutboundProxyEnvironment(
        { mode: 'macos-system' },
        {},
        'linux',
        'HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\n',
      ),
    ).toThrow('FORGE_RUNTIME_OUTBOUND_PROXY_PLATFORM_UNSUPPORTED');
  });

  test('normalizes Windows PATH case variants into one usable canonical PATH', () => {
    const normalized = repositoryChildProcessEnvironment(
      {
        Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
        PATH: '',
        FORGE_RUNTIME_PRIVATE_TEST: 'must-not-leak',
        FORGE_RELEASE_PATH: 'C:\\private-runtime-release',
        FORGE_RELEASE_ID: 'private-release-id',
        FORGE_RELEASE_AUTHORITY_REVISION: '321',
        FORGE_RELEASE_SOURCE_COMMIT: 'deadbeef',
        FORGE_BUILD_VERSION: '1.7.2-host-runtime',
        REPOSITORY_VISIBLE_SETTING: 'preserve-me',
      },
      'win32',
    );

    expect(normalized.PATH).toBe('C:\\Windows\\System32;C:\\Program Files\\Git\\cmd');
    expect(Object.keys(normalized).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(normalized.FORGE_RUNTIME_PRIVATE_TEST).toBeUndefined();
    expect(normalized.FORGE_RELEASE_PATH).toBeUndefined();
    expect(normalized.FORGE_RELEASE_ID).toBeUndefined();
    expect(normalized.FORGE_RELEASE_AUTHORITY_REVISION).toBeUndefined();
    expect(normalized.FORGE_RELEASE_SOURCE_COMMIT).toBeUndefined();
    expect(normalized.FORGE_BUILD_VERSION).toBeUndefined();
    expect(normalized.REPOSITORY_VISIBLE_SETTING).toBe('preserve-me');
  });

  test('uses the last non-empty Windows PATH variant as the case-insensitive override', () => {
    const normalized = repositoryChildProcessEnvironment(
      {
        PATH: 'C:\\Windows\\System32',
        Path: 'D:\\tools;C:\\Windows\\System32',
      },
      'win32',
    );

    expect(normalized.PATH).toBe('D:\\tools;C:\\Windows\\System32');
    expect(Object.keys(normalized).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
  });

  test('never treats a compiled Forge Runtime as Bun through FORGE_BUN_EXECUTABLE', () => {
    expect(
      resolveBunExecutable('/tmp/forge-runtime', {
        FORGE_BUN_EXECUTABLE: '/tmp/forge-runtime',
        HOME: '/Users/nonexistent-for-test',
      }),
    ).toBe(process.platform === 'win32' ? 'bun.exe' : 'bun');
  });

  test('accepts an explicit Bun command name', () => {
    expect(
      resolveBunExecutable('/tmp/forge-runtime', {
        FORGE_BUN_EXECUTABLE: 'bun',
        HOME: '/Users/nonexistent-for-test',
      }),
    ).toBe('bun');
  });

  test('uses the hosting executable only when it is Bun itself', () => {
    expect(resolveBunExecutable('bun', { HOME: '/Users/nonexistent-for-test' })).toBe('bun');
  });

  test('scheduler workers receive allowlisted proxy variables without persisting them in lifecycle metadata', () => {
    const launch = buildSchedulerWorkerLaunchDescriptor({
      command: { entry: '/runtime/worker-entry.ts', loader: '/runtime/loader.mjs', cwd: '/runtime' },
      controllerHome: '/controller',
      repoId: 'repo-a',
      jobId: 'job-a',
      controllerPid: 42,
      isBun: true,
      environment: {
        PATH: '/usr/bin',
        HTTP_PROXY: 'http://127.0.0.1:7890',
        https_proxy: 'http://127.0.0.1:7890',
        NO_PROXY: 'internal.local',
      },
    });

    expect(launch.environment.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(launch.environment.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(launch.environment.NO_PROXY).toContain('localhost');
    expect(launch.environment).not.toHaveProperty('https_proxy');
    expect(launch.lifecycleEnvironment).not.toHaveProperty('HTTP_PROXY');
    expect(launch.lifecycleEnvironment).not.toHaveProperty('HTTPS_PROXY');
  });

  test('compiled Runtime scheduler resolves a real Bun executable instead of recursively spawning forge-runtime', () => {
    expect(
      resolveSchedulerWorkerExecutable(true, '/tmp/forge-runtime', {
        FORGE_BUN_EXECUTABLE: 'bun',
        HOME: '/Users/nonexistent-for-test',
      }),
    ).toBe('bun');
    expect(resolveSchedulerWorkerExecutable(false, '/tmp/node', {})).toBe('/tmp/node');
  });

  test('resolves and validates Scheduler worker command paths outside GlobalScheduler', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-worker-command-'));
    homes.push(root);
    const workerDir = join(root, 'src', 'cli', 'execution');
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
    expect(() =>
      resolveSchedulerWorkerCommand({
        runtimeSourceRoot: join(root, 'missing'),
        isBun: false,
      }),
    ).toThrow('WORKER_ENTRYPOINT_MISSING');
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
      environment: {
        PATH: '/usr/bin:/usr/local/bin',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        SECRET_FOR_TEST: 'not-persisted',
      },
      writeClaimEnvironment: {
        FORGE_RUNTIME_INSTANCE_ID: 'runtime-a',
        FORGE_RELEASE_ID: 'release-a',
      },
    });

    expect(launch).toMatchObject({
      executable: '/usr/bin/node',
      args: [
        '--loader',
        '/runtime/node-ts-loader.mjs',
        '/runtime/worker-entry.ts',
        '--controller-home',
        '/controller',
        '--repo-id',
        'repo-a',
        '--job-id',
        'job-a',
        '--controller-pid',
        '42',
      ],
      cwd: '/runtime',
      environment: {
        PATH: '/usr/bin:/usr/local/bin',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        SECRET_FOR_TEST: 'not-persisted',
        FORGE_EXECUTION_WORKER: '1',
        FORGE_CONTROLLER_HOME: '/controller',
        FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT: '/runtime',
        FORGE_RUNTIME_INSTANCE_ID: 'runtime-a',
        FORGE_RELEASE_ID: 'release-a',
      },
      lifecycleEnvironment: {
        PATH: '/usr/bin:/usr/local/bin',
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

  test('models Scheduler worker exit failure diagnostics outside GlobalScheduler', () => {
    const lifecycle: ExecutionWorkerLifecycle = {
      executable: '/usr/bin/node',
      args: ['/runtime/worker-entry.ts'],
      cwd: '/runtime',
      environment: { PATH: '/usr/bin' },
      ownerPid: 42,
      runtimeInstanceId: 'runtime-a',
      attempt: 2,
      maxAttempts: 3,
      spawnedAt: '2026-08-21T00:00:00.000Z',
      workerPid: 99,
      processGroupId: 99,
      stderrPath: '/tmp/stderr.log',
      startupState: 'exited',
    };
    const failure = buildSchedulerWorkerExitFailure({
      lifecycle,
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
      details: { executable: '/usr/bin/node', runtimeInstanceId: 'runtime-a', attempt: 2, maxAttempts: 3 },
    });
    expect(failure.error.message).toContain('Worker stderr: boom');
  });

  test('persists terminal Scheduler worker lifecycle outside GlobalScheduler', () => {
    const lifecycle: ExecutionWorkerLifecycle = {
      executable: '/runtime/worker',
      args: [],
      cwd: '/runtime',
      environment: {},
      ownerPid: 42,
      attempt: 1,
      maxAttempts: 2,
      spawnedAt: '2026-08-21T00:00:00.000Z',
      startupState: 'exited',
    };
    const current = { repoId: 'repo-a', jobId: 'job-a', status: 'succeeded' } as ExecutionJob;
    let updated: ExecutionJob | undefined;
    let rebuilds = 0;
    const dependencies = {
      updateJob: (_controllerHome: string, _repoId: string, _jobId: string, updater: (current: ExecutionJob) => ExecutionJob) => {
        updated = updater(updated ?? current);
        return updated;
      },
      rebuildProjection: () => { rebuilds += 1; },
    };
    expect(persistSchedulerTerminalWorkerLifecycle({
      controllerHome: '/controller', repoId: 'repo-a', jobId: 'job-a', status: 'succeeded', lifecycle,
    }, dependencies)).toBe(true);
    expect(updated?.workerLifecycle).toEqual(lifecycle);
    expect(rebuilds).toBe(1);
    expect(persistSchedulerTerminalWorkerLifecycle({
      controllerHome: '/controller', repoId: 'repo-a', jobId: 'job-a', status: 'running', lifecycle,
    }, dependencies)).toBe(false);
  });

  test('cleans up all tracked Scheduler workers outside GlobalScheduler shutdown logic', async () => {
    const terminated: Array<number | undefined> = [];
    const children = new Map<string, ChildProcess>([
      ['job-a', { pid: 88 } as ChildProcess],
      ['job-b', { pid: 99 } as ChildProcess],
    ]);

    await cleanupSchedulerWorkerProcesses(children, {
      terminateWorker: async (pid) => {
        terminated.push(pid);
      },
    });

    expect(children.size).toBe(0);
    expect(terminated.sort()).toEqual([88, 99]);
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

    expect(capture.path.endsWith(join('worker-stderr', 'job-a-attempt-2.log'))).toBe(true);
    expect(capture.snapshot()).toEqual({ stderr: 'abcde', stderrTruncated: true });
    expect(readFileSync(capture.path, 'utf8')).toBe('abcde');
  });

  test.skipIf(process.platform === 'win32')(
    'resolves ~/.bun/bin/bun from the OS account home when env -i removes HOME',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'forge-bun-home-'));
      homes.push(home);
      const bin = join(home, '.bun', 'bin');
      mkdirSync(bin, { recursive: true });
      const bun = join(bin, 'bun');
      writeFileSync(bun, 'fixture');
      expect(resolveBunExecutable('/tmp/forge-runtime', {}, home)).toBe(bun);
    },
  );
});
