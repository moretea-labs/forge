import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { claimControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import {
  launchSuperController,
  resolveLauncherExecutable,
  type ThinLauncherRequest,
} from '../../src/runtime/control-plane/launcher/thin-launcher';
import { getExternalControllerLaunchReservation, readExternalControllerLaunchReservationRecord } from '../../src/runtime/control-plane/launcher/launch-reservation-store';

const roots: string[] = [];
const launchedPids: number[] = [];

afterEach(() => {
  while (launchedPids.length > 0) {
    const pid = launchedPids.pop()!;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sleepingExecutable(root: string): string {
  const executable = join(root, 'sleeping-controller');
  writeFileSync(executable, '#!/bin/sh\nsleep 5\n', 'utf8');
  chmodSync(executable, 0o755);
  return executable;
}

function codexBootstrap() {
  return {
    url: 'http://127.0.0.1:9876/mcp',
    bearerTokenEnvVar: 'FORGE_RUNTIME_MCP_TOKEN' as const,
    principalId: 'external:codex:test-reservation',
    sessionId: 'external-session:codex:test-reservation',
    env: process.env,
  };
}

function launcherFixture() {
  const root = temp('forge-thin-launcher-');
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const repoId = 'repo-thin-launcher';
  const workId = 'WORK-thin-launcher';
  const store = { controllerHome, repoId };
  createWorkContract(store, {
    workId,
    repoId,
    mode: 'goal_workloop',
    objective: 'Exercise the external Controller launcher.',
    acceptanceCriteria: ['launcher result is observable'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });
  return { root, controllerHome, repoId, workId, store };
}

describe('Thin Launcher startup observability', () => {
  test('resolves Codex from the augmented repository PATH without an explicit executable override', () => {
    const root = temp('forge-thin-launcher-path-');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(codex, 0o755);
    const request: ThinLauncherRequest = { controllerType: 'codex', workId: 'WORK-path', cwd: root };

    expect(resolveLauncherExecutable(request, { HOME: home, PATH: '' })).toBe('codex');
  });

  test('surfaces an immediate detached-process exit and releases the launch reservation', async () => {
    const fx = launcherFixture();
    let message = '';
    try {
      await launchSuperController({ work: fx.store, handoff: fx.store }, {
        controllerType: 'grok',
        executable: process.execPath,
        args: ['-e', 'console.error("launcher-startup-boom"); process.exit(17)'],
        workId: fx.workId,
        cwd: fx.root,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('LAUNCHER_STARTUP_FAILED');
    expect(message).toContain('code=17');
    expect(message).toContain('launcher-startup-boom');
    expect(getExternalControllerLaunchReservation(fx.store, fx.workId)).toBeUndefined();
    expect(readExternalControllerLaunchReservationRecord(fx.store, fx.workId)).toMatchObject({
      exitCode: 17,
      stderrTail: expect.stringContaining('launcher-startup-boom'),
    });
  });

  test('returns only after a live child survives the startup grace', async () => {
    const fx = launcherFixture();
    const launched = await launchSuperController({ work: fx.store, handoff: fx.store }, {
      controllerType: 'grok',
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      workId: fx.workId,
      cwd: fx.root,
    });
    if (launched.pid) launchedPids.push(launched.pid);

    expect(launched.pid).toBeGreaterThan(0);
    expect(launched.prompt).toContain('operation=controller_claim');
    expect(launched.prompt).toContain(`work_id=${fx.workId}`);
    expect(getExternalControllerLaunchReservation(fx.store, fx.workId)).toMatchObject({
      reservationId: launched.reservationId,
      pid: launched.pid,
    });
  });

  test('does not report Codex started until the expected MCP identity claims the exact Work', async () => {
    const fx = launcherFixture();
    const bootstrap = codexBootstrap();
    const claimTimer = setTimeout(() => {
      claimControllerSession(fx.store, {
        workId: fx.workId,
        controllerId: bootstrap.principalId,
        controllerType: 'codex',
        sessionId: bootstrap.sessionId,
        principalId: bootstrap.principalId,
        controllerInstanceId: 'runtime-codex-launch-test',
      });
    }, 50);
    try {
      const launched = await launchSuperController({ work: fx.store, handoff: fx.store }, {
        controllerType: 'codex',
        executable: sleepingExecutable(fx.root),
        workId: fx.workId,
        cwd: fx.root,
      }, {
        resolveProviderMcpBootstrap: () => bootstrap,
        claimTimeoutMs: 1_000,
        claimPollIntervalMs: 10,
      });
      if (launched.pid) launchedPids.push(launched.pid);

      expect(launched.pid).toBeGreaterThan(0);
      expect(getExternalControllerLaunchReservation(fx.store, fx.workId)).toMatchObject({
        reservationId: launched.reservationId,
        pid: launched.pid,
      });
    } finally {
      clearTimeout(claimTimer);
    }
  });

  test('fails closed and releases the reservation when Codex stays alive without claiming the Work', async () => {
    const fx = launcherFixture();
    let message = '';
    try {
      await launchSuperController({ work: fx.store, handoff: fx.store }, {
        controllerType: 'codex',
        executable: sleepingExecutable(fx.root),
        workId: fx.workId,
        cwd: fx.root,
      }, {
        resolveProviderMcpBootstrap: () => codexBootstrap(),
        claimTimeoutMs: 120,
        claimPollIntervalMs: 10,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('LAUNCHER_CLAIM_TIMEOUT');
    expect(message).toContain(fx.workId);
    expect(getExternalControllerLaunchReservation(fx.store, fx.workId)).toBeUndefined();
  });

  test('rejects a live claim from any identity other than the launched Codex MCP identity', async () => {
    const fx = launcherFixture();
    const bootstrap = codexBootstrap();
    const claimTimer = setTimeout(() => {
      claimControllerSession(fx.store, {
        workId: fx.workId,
        controllerId: 'external:codex:wrong-reservation',
        controllerType: 'codex',
        sessionId: 'external-session:codex:wrong-reservation',
        principalId: 'external:codex:wrong-reservation',
        controllerInstanceId: 'runtime-codex-launch-test',
      });
    }, 40);
    let message = '';
    try {
      await launchSuperController({ work: fx.store, handoff: fx.store }, {
        controllerType: 'codex',
        executable: sleepingExecutable(fx.root),
        workId: fx.workId,
        cwd: fx.root,
      }, {
        resolveProviderMcpBootstrap: () => bootstrap,
        claimTimeoutMs: 1_000,
        claimPollIntervalMs: 10,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(claimTimer);
    }

    expect(message).toContain('LAUNCHER_CLAIM_MISMATCH');
    expect(message).toContain('wrong-reservation');
    expect(getExternalControllerLaunchReservation(fx.store, fx.workId)).toBeUndefined();
  });
});
