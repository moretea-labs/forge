import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';
import { existsSync } from 'fs';

describe('durable Execution Worker lifecycle', () => {
  test('refuses new ExecutionJobs and keeps the retired Agent worker entrypoint absent', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-durable-worker-'));
    try {
      expect(() => createExecutionJob(controllerHome, {
        repoId: 'repo-a',
        type: 'mcp-tool',
        requestId: 'worker-1',
        semanticKey: 'worker-1',
        origin: { surface: 'mcp' },
        payload: { operation: 'controller_context', target: 'mcp-tool' },
        resourceClaims: [],
      })).toThrow(/EXECUTION_JOB_RETIRED/);
      expect(existsSync(join(import.meta.dir, '../../src/cli/agent-jobs/job-worker.ts'))).toBe(false);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });
});
