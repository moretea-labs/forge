import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';
import {
  isProcessStatAlive,
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
    const output = [
      ' 101  77 S',
      ' 102  88 S+',
      ' 103  77 Z',
      ' 104  77 R',
      ' malformed',
      '',
    ].join('\n');

    expect(parseProcessGroupMembersPosix(output, 77)).toEqual([101, 104]);
    expect(parseProcessGroupMembersPosix(output, 88)).toEqual([102]);
    expect(parseProcessGroupMembersPosix(output, 99)).toEqual([]);
  });

  test('refuses new ExecutionJobs used by the retired worker reclamation path', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-process-tree-'));
    try {
      expect(() => createExecutionJob(controllerHome, {
        repoId: 'repo-a',
        type: 'check',
        requestId: 'tree-1',
        semanticKey: 'check:tree-1',
        origin: { surface: 'mcp' },
        payload: { operation: 'run_check', target: 'mcp-tool' },
        resourceClaims: [],
      })).toThrow(/EXECUTION_JOB_RETIRED/);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });
});
