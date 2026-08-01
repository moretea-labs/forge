import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerDaemon, readControllerDaemonStatus, schedulerHeartbeatSnapshotHealthy } from '../../src/runtime/control-plane/daemon-client';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';
import { TERMINAL_JOB_STATUSES } from '../../src/runtime/execution/jobs/types';

const roots: string[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('control-plane hardening', () => {
  test('keeps a live daemon PID authoritative when the scheduler heartbeat is stale', () => {
    const controllerHome = temp('repo-harness-daemon-fence-');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`);
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt,
    }, null, 2)}\n`);

    const degraded = readControllerDaemonStatus(controllerHome);
    expect(degraded.status).toBe('ready');
    expect(degraded.degraded).toBe(true);
    expect(degraded.pid).toBe(process.pid);

    const ensured = ensureControllerDaemon(controllerHome);
    expect(ensured.pid).toBe(process.pid);
    expect(ensured.startedAt).toBe(startedAt);
  });

  test('keeps a live passive candidate ready without requiring a Scheduler heartbeat', () => {
    const controllerHome = temp('repo-harness-passive-daemon-ready-');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`);
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt,
      passive: true,
      degraded: false,
    }, null, 2)}\n`);

    const status = readControllerDaemonStatus(controllerHome);
    expect(status.status).toBe('ready');
    expect(status.passive).toBe(true);
    expect(status.degraded).toBe(false);
    expect(status.pid).toBe(process.pid);
  });

  test('prefers a live Daemon with a fresh Scheduler heartbeat over a stale terminal projection', () => {
    const controllerHome = temp('repo-harness-daemon-stale-terminal-');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    mkdirSync(join(controllerHome, 'scheduler'), { recursive: true });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'stopped',
      pid: process.pid,
      startedAt,
      stoppedAt: new Date().toISOString(),
      shutdownReason: 'lifecycle_complete',
    }, null, 2)}\n`);
    writeFileSync(join(controllerHome, 'scheduler', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: startedAt,
      lastHeartbeatAt: new Date().toISOString(),
      heartbeatTimeoutMs: 60_000,
      lastRepoDispatch: {},
    }, null, 2)}\n`);

    const status = readControllerDaemonStatus(controllerHome);
    expect(status.status).toBe('ready');
    expect(status.pid).toBe(process.pid);
    expect(status.degraded).toBe(false);
    expect(status.stoppedAt).toBeUndefined();
    expect(status.shutdownReason).toBeUndefined();
    const durable = JSON.parse(readFileSync(join(controllerHome, 'daemon', 'state.json'), 'utf8')) as { status: string };
    expect(durable.status).toBe('stopped');
  });

  test('keeps a stale terminal projection when the Scheduler heartbeat is stale', () => {
    const controllerHome = temp('repo-harness-daemon-terminal-no-heartbeat-');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    mkdirSync(join(controllerHome, 'scheduler'), { recursive: true });
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'stopped',
      pid: process.pid,
      stoppedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    writeFileSync(join(controllerHome, 'scheduler', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
      loopStartedAt: new Date(Date.now() - 180_000).toISOString(),
      lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      heartbeatTimeoutMs: 60_000,
      lastRepoDispatch: {},
    }, null, 2)}\n`);

    expect(readControllerDaemonStatus(controllerHome).status).toBe('stopped');
  });

  test('uses the Scheduler-published heartbeat timeout and a safe legacy fallback', () => {
    const now = Date.now();
    const base = {
      schemaVersion: 1 as const,
      updatedAt: new Date(now).toISOString(),
      loopStartedAt: new Date(now - 120_000).toISOString(),
      lastRepoDispatch: {},
    };
    expect(schedulerHeartbeatSnapshotHealthy({
      ...base,
      lastTickAt: new Date(now - 20_000).toISOString(),
    }, now)).toBe(true);
    expect(schedulerHeartbeatSnapshotHealthy({
      ...base,
      lastHeartbeatAt: new Date(now - 20_000).toISOString(),
      heartbeatTimeoutMs: 30_000,
    }, now)).toBe(true);
    expect(schedulerHeartbeatSnapshotHealthy({
      ...base,
      lastHeartbeatAt: new Date(now - 31_000).toISOString(),
      heartbeatTimeoutMs: 30_000,
    }, now)).toBe(false);
  });

  test('ensureControllerDaemon skips startup cleanup when the daemon PID is live', () => {
    const controllerHome = temp('repo-harness-daemon-hotpath-');
    mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`);
    writeFileSync(join(controllerHome, 'daemon', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt,
    }, null, 2)}\n`);
    mkdirSync(join(controllerHome, 'scheduler'), { recursive: true });
    writeFileSync(join(controllerHome, 'scheduler', 'state.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
      lastReconcileAt: new Date().toISOString(),
      lastRepoDispatch: {},
    }, null, 2)}\n`);

    const first = ensureControllerDaemon(controllerHome);
    const second = ensureControllerDaemon(controllerHome);
    expect(first.pid).toBe(process.pid);
    expect(second.pid).toBe(process.pid);
    expect(second.startedAt).toBe(startedAt);
    expect(readControllerDaemonStatus(controllerHome).pid).toBe(process.pid);
  });

  test('refuses new ExecutionJobs for approval-wait and controller-scope recovery paths', () => {
    const controllerHome = temp('repo-harness-job-retired-');
    expect(() => createExecutionJob(controllerHome, {
      repoId: 'repo-test',
      checkoutId: 'checkout-test',
      type: 'mcp-tool',
      requestId: `request-${Date.now()}`,
      semanticKey: `test:${Date.now()}`,
      origin: { surface: 'system', actor: 'test' },
      payload: { operation: 'controller_ready', target: 'runtime', profile: 'controller', arguments: {} },
      resourceClaims: [],
    })).toThrow(/EXECUTION_JOB_RETIRED/);
    // waiting_for_approval remains a non-terminal historical status for old records.
    expect(TERMINAL_JOB_STATUSES.has('waiting_for_approval')).toBe(false);
  });
});
