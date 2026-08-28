import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listWorkBoundRepositoryProcessEvidence } from '../../src/runtime/control-plane/execution/work-process-evidence';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function processRecord(controllerHome: string, overrides: Partial<ManagedProcessRecord> = {}): ManagedProcessRecord {
  const now = '2026-08-28T00:00:00.000Z';
  const workId = overrides.workId ?? 'work-process-evidence';
  return {
    schemaVersion: 1,
    processId: overrides.processId ?? 'proc-process-evidence',
    repoId: 'repo-process-evidence',
    checkoutId: 'checkout-process-evidence',
    workId,
    commandId: 'command-process-evidence',
    controllerHome,
    status: 'succeeded',
    route: 'managed',
    command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: '/tmp' },
    origin: {
      surface: 'command',
      toolName: 'repository_command_execute',
      requestId: 'request-process-evidence',
      correlationId: workId,
    },
    resourceClaims: [],
    interactiveWaitMs: 0,
    timeoutMs: 30_000,
    maxOutputBytes: 1_024,
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    exitCode: 0,
    terminalFenceToken: 1,
    terminalWritten: true,
    leaseReleaseState: 'released',
    leasesReleased: true,
    ...overrides,
  };
}

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-process-evidence-'));
  roots.push(controllerHome);
  return { controllerHome, repoId: 'repo-process-evidence', checkoutId: 'checkout-process-evidence', workId: 'work-process-evidence' };
}

describe('Work-bound repository Process evidence', () => {
  test('re-derives an exact successful terminal repository command across store reads', () => {
    const fx = fixture();
    createProcessRecord(processRecord(fx.controllerHome));

    const first = listWorkBoundRepositoryProcessEvidence(fx);
    const afterControllerRotation = listWorkBoundRepositoryProcessEvidence(fx);

    expect(first).toEqual([{ processId: 'proc-process-evidence', commandId: 'command-process-evidence', finishedAt: '2026-08-28T00:00:00.000Z' }]);
    expect(afterControllerRotation).toEqual(first);
  });

  test('rejects unrelated, failed, timed-out, active, malformed-origin, and unfenced terminal records', () => {
    const fx = fixture();
    const variants: Array<Partial<ManagedProcessRecord>> = [
      { processId: 'proc-wrong-work', workId: 'work-other', origin: { surface: 'command', toolName: 'repository_command_execute', correlationId: 'work-other' } },
      { processId: 'proc-wrong-checkout', checkoutId: 'checkout-other' },
      { processId: 'proc-failed', status: 'failed', exitCode: 1 },
      { processId: 'proc-timed-out', status: 'timed_out', exitCode: undefined, timedOut: true },
      { processId: 'proc-active', status: 'running', exitCode: undefined, finishedAt: undefined, terminalWritten: false },
      { processId: 'proc-check', origin: { surface: 'check', toolName: 'repository_command_execute', correlationId: fx.workId } },
      { processId: 'proc-wrong-tool', origin: { surface: 'command', toolName: 'other_tool', correlationId: fx.workId } },
      { processId: 'proc-wrong-correlation', origin: { surface: 'command', toolName: 'repository_command_execute', correlationId: 'work-other' } },
      { processId: 'proc-unfenced-terminal', terminalWritten: false },
    ];
    for (const variant of variants) createProcessRecord(processRecord(fx.controllerHome, variant));

    expect(listWorkBoundRepositoryProcessEvidence(fx)).toEqual([]);
  });
});
