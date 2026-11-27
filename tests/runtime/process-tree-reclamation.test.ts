import { execFileSync } from 'child_process';
import { describe, expect, test } from 'bun:test';
import { cleanupOwnedProcessGroup } from '../../src/runtime/shared/bounded-child-supervisor';
import {
  isProcessAliveAsync,
  isProcessStatAlive,
  listProcessTreeMembersAsync,
  parseProcessGroupMembersPosix,
} from '../../src/runtime/shared/process-tree';

describe('worker process-tree reclamation', () => {
  test('treats POSIX zombie states as already exited', () => {
    expect(isProcessStatAlive('Z')).toBe(false);
    expect(isProcessStatAlive('Z+')).toBe(false);
    expect(isProcessStatAlive('S+')).toBe(true);
    expect(isProcessStatAlive(undefined)).toBe(false);
  });

  test('filters POSIX process listings by exact process-group id', () => {
    const output = [' 101  77 S', ' 102  88 S+', ' 103  77 Z', ' 104  77 R', ' malformed', ''].join('\n');
    expect(parseProcessGroupMembersPosix(output, 77)).toEqual([101, 104]);
    expect(parseProcessGroupMembersPosix(output, 88)).toEqual([102]);
    expect(parseProcessGroupMembersPosix(output, 99)).toEqual([]);
  });

  test('uses non-blocking process liveness and process-group enumeration', async () => {
    expect(await isProcessAliveAsync(process.pid)).toBe(true);
    if (process.platform === 'win32') return;
    const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    expect(await listProcessTreeMembersAsync(group)).toContain(process.pid);
  });

  test('bounded child cleanup prefers async probes when available', async () => {
    let syncProbeCalled = false;
    const result = await cleanupOwnedProcessGroup(123, {
      isProcessAlive: () => {
        syncProbeCalled = true;
        return false;
      },
      isProcessAliveAsync: async () => false,
      listProcessTreeMembers: () => {
        syncProbeCalled = true;
        return [];
      },
      listProcessTreeMembersAsync: async () => [],
      signalProcessTree: () => true,
      terminateProcessTree: async () => ({
        pid: 123,
        signaled: false,
        escalated: false,
        exited: true,
        remainingPids: [],
      }),
    });
    expect(result).toEqual({ residualPids: [], remainingPids: [], pidReuseFenced: false });
    expect(syncProbeCalled).toBe(false);
  });
});
