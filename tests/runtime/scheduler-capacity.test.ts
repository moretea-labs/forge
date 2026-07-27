import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isSchedulerResourcePressured,
  parseDarwinAvailableMemoryMb,
  sampleDarwinAvailableMemoryMb,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';
import {
  compareExecutionJobDispatchRanks,
  isExecutionJobDispatchCandidate,
  PRIORITY_AGING_WINDOW_MS,
  rankExecutionJobForDispatch,
} from '../../src/runtime/control-plane/dispatch-priority';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('scheduler capacity', () => {
  test('counts reclaimable macOS pages as available memory', () => {
    const availableMemoryMb = parseDarwinAvailableMemoryMb(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               32768.
Pages active:                            999999.
Pages inactive:                          16384.
Pages speculative:                        4096.
Pages wired down:                        999999.
Pages purgeable:                           2048.
Pages occupied by compressor:            999999.
`);

    expect(availableMemoryMb).toBe(864);
    expect(isSchedulerResourcePressured(
      { freeMemoryMb: availableMemoryMb!, loadPerCpu: 0.4 },
      { minFreeMemoryMb: 512, maxLoadPerCpu: 1.5 },
    )).toBe(false);
  });

  test('samples host available memory without throwing', async () => {
    await expect(sampleDarwinAvailableMemoryMb(512)).resolves.toBeGreaterThanOrEqual(0);
  });

  test('uses one immutable dispatch timestamp and excludes approval-gated Jobs', () => {
    const scheduleNow = Date.parse('2026-07-27T00:00:00.000Z');
    const aged = rankExecutionJobForDispatch({
      priority: 'P2',
      queuedAt: new Date(scheduleNow - 2 * PRIORITY_AGING_WINDOW_MS).toISOString(),
      createdAt: new Date(scheduleNow - 2 * PRIORITY_AGING_WINDOW_MS).toISOString(),
      jobId: 'aged',
    }, scheduleNow);
    const recent = rankExecutionJobForDispatch({
      priority: 'P0',
      queuedAt: new Date(scheduleNow - 1_000).toISOString(),
      createdAt: new Date(scheduleNow - 1_000).toISOString(),
      jobId: 'recent',
    }, scheduleNow);
    const malformed = rankExecutionJobForDispatch({
      priority: 'P2',
      queuedAt: 'not-a-date',
      createdAt: new Date(scheduleNow - PRIORITY_AGING_WINDOW_MS).toISOString(),
      jobId: 'malformed',
    }, scheduleNow);

    expect(aged.effectivePriority).toBe(0);
    expect(compareExecutionJobDispatchRanks(aged, recent)).toBeLessThan(0);
    expect(malformed.effectivePriority).toBe(1);
    expect(isExecutionJobDispatchCandidate({ status: 'waiting_for_approval' })).toBe(false);
    expect(isExecutionJobDispatchCandidate({ status: 'waiting_for_workspace' })).toBe(true);
  });

  test('refuses new ExecutionJob creation used by the retired worker capacity path', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-scheduler-capacity-'));
    roots.push(controllerHome);
    expect(() => createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'check',
      requestId: 'capacity-1',
      semanticKey: 'check:capacity-1',
      origin: { surface: 'mcp' },
      payload: { operation: 'run_check', target: 'mcp-tool' },
      resourceClaims: [],
    })).toThrow(/EXECUTION_JOB_RETIRED/);
  });
});
