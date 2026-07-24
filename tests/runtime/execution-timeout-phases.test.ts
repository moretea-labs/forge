import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';

describe('ExecutionJob timeout phases', () => {
  test('refuses new ExecutionJob creation because timeout phases are Process Runtime owned', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-timeout-phases-'));
    try {
      expect(() => createExecutionJob(controllerHome, {
        repoId: 'repo-a',
        type: 'mcp-tool',
        requestId: 'timeout-1',
        semanticKey: 'timeout-1',
        origin: { surface: 'mcp' },
        payload: { operation: 'controller_context', target: 'mcp-tool' },
        resourceClaims: [],
        timeoutMs: 5_000,
      })).toThrow(/EXECUTION_JOB_RETIRED/);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });
});
