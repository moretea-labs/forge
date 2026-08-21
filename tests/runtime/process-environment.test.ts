import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveBunExecutable } from '../../src/runtime/shared/process-environment';
import {
  buildSchedulerWorkerLaunchDescriptor,
  resolveSchedulerWorkerCommand,
  resolveSchedulerWorkerExecutable,
  selectSchedulerWorkerEnvironment,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';

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
