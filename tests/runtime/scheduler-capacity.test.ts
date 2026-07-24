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

  test('samples host available memory without throwing', () => {
    expect(() => sampleDarwinAvailableMemoryMb()).not.toThrow();
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
