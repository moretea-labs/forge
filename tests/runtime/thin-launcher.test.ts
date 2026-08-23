import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import {
  launchSuperController,
  resolveLauncherExecutable,
  type ThinLauncherRequest,
} from '../../src/runtime/control-plane/launcher/thin-launcher';
import { getExternalControllerLaunchReservation } from '../../src/runtime/control-plane/launcher/launch-reservation-store';

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
        args: ['-e', 'process.exit(17)'],
        workId: fx.workId,
        cwd: fx.root,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('LAUNCHER_STARTUP_FAILED');
    expect(message).toContain('code=17');
    expect(getExternalControllerLaunchReservation(fx.store, fx.workId)).toBeUndefined();
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
});
