import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../src/runtime/control-plane/daemon-client';
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
