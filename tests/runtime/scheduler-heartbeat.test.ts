import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GlobalScheduler, readSchedulerHealthSnapshot } from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { schedulerHeartbeatSnapshotHealthy } from '../../src/runtime/control-plane/daemon-client';

const homes: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('Scheduler process heartbeat', () => {
  test('continues heartbeat persistence while one asynchronous tick is still running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-scheduler-heartbeat-'));
    homes.push(home);
    const scheduler = new GlobalScheduler(home, {
      pollIntervalMs: 50,
      idleBackoffMaxMs: 250,
      heartbeatIntervalMs: 25,
      heartbeatTimeoutMs: 250,
    });
    const controller = new AbortController();
    let releaseTick: (() => void) | undefined;
    const tickStarted = new Promise<void>((resolveStarted) => {
      (scheduler as unknown as { tick: () => Promise<{ activeJobs: number }> }).tick = async () => {
        resolveStarted();
        await new Promise<void>((resolveTick) => { releaseTick = resolveTick; });
        return { activeJobs: 0 };
      };
    });

    const running = scheduler.run(controller.signal);
    await tickStarted;
    const first = readSchedulerHealthSnapshot(home);
    await sleep(90);
    const second = readSchedulerHealthSnapshot(home);
    expect(first.lastHeartbeatAt).toBeString();
    expect(second.lastHeartbeatAt).toBeString();
    expect(Date.parse(second.lastHeartbeatAt!)).toBeGreaterThan(Date.parse(first.lastHeartbeatAt!));
    expect(second.heartbeatTimeoutMs).toBe(1_000);
    expect(schedulerHeartbeatSnapshotHealthy(second)).toBe(true);

    controller.abort();
    releaseTick?.();
    await running;
  });
});
