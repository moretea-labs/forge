import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureStableSupervisorLayout, supervisorCurrentReleasePath, supervisorReleasesRoot } from '../../src/runtime/supervisor/paths';
import { ensureControllerDaemon, readControllerDaemonStatus, resolveControllerDaemonStatusHome } from '../../src/runtime/control-plane/daemon-client';
import { captureProcessIdentity } from '../../src/runtime/supervisor/identity';
import { createSupervisorState, writeSupervisorState } from '../../src/runtime/supervisor/state-store';

function installedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'stable-supervisor-integration-'));
  ensureStableSupervisorLayout(home);
  const release = join(supervisorReleasesRoot(home), 'fixture');
  mkdirSync(release, { recursive: true });
  for (const entry of ['supervisor.js', 'repo-harness.js', 'daemon.js']) writeFileSync(join(release, entry), '# fixture\n');
  symlinkSync(release, supervisorCurrentReleasePath(home), 'dir');
  return home;
}

describe('stable Supervisor compatibility integration', () => {
  test('refuses Gateway-side daemon creation when a stable release is installed', () => {
    const status = ensureControllerDaemon(installedHome());
    expect(status.status).toBe('unavailable');
    expect(status.error).toBe('SUPERVISOR_REQUIRED');
    expect(status.restartRequired).toBe(true);
  });

  test('slot Gateway resolves Daemon ownership through the durable Supervisor home', () => {
    const controllerHome = installedHome();
    const slotHome = join(controllerHome, 'runtime-slots', 'green');
    mkdirSync(slotHome, { recursive: true });
    const status = ensureControllerDaemon(slotHome);
    expect(status.status).toBe('unavailable');
    expect(status.error).toBe('SUPERVISOR_REQUIRED');
    expect(status.restartRequired).toBe(true);
    expect(existsSync(join(slotHome, 'daemon', 'controller.pid'))).toBe(false);
  });

  test('root Daemon readiness follows the Supervisor-owned active slot', () => {
    const controllerHome = installedHome();
    const slotHome = join(controllerHome, 'runtime-slots', 'green');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    mkdirSync(join(slotHome, 'daemon'), { recursive: true });
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'stopped',
      instanceId: 'stale-root-daemon',
    })}\n`);
    writeFileSync(join(slotHome, 'daemon', 'controller.pid'), `${process.pid}\n`);
    writeFileSync(join(slotHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'starting',
      pid: process.pid,
      instanceId: 'active-slot-daemon',
      slot: 'green',
      startedAt: new Date().toISOString(),
    })}\n`);
    const supervisorIdentity = captureProcessIdentity(process.pid, {
      controllerHome,
      instanceId: 'test-active-slot-supervisor',
      ownerEpoch: 1,
    });
    expect(supervisorIdentity).toBeDefined();
    const state = createSupervisorState(controllerHome, supervisorIdentity!);
    writeSupervisorState(controllerHome, {
      ...state,
      activeSlot: 'green',
      controllerDaemon: {
        pid: process.pid,
        instanceId: 'active-slot-daemon',
        processStartTime: new Date().toISOString(),
        executableFingerprint: 'fixture',
        controllerHome: slotHome,
        slot: 'green',
        ownerEpoch: 1,
        state: 'running',
        restartCount: 0,
        consecutiveFailures: 0,
      },
    });

    expect(resolveControllerDaemonStatusHome(controllerHome)).toBe(slotHome);
    const projected = readControllerDaemonStatus(controllerHome);
    expect(projected.status).toBe('starting');
    expect(projected.instanceId).toBe('active-slot-daemon');
    expect(projected.pid).toBe(process.pid);
    expect(readControllerDaemonStatus(slotHome).instanceId).toBe('active-slot-daemon');
  });
});
