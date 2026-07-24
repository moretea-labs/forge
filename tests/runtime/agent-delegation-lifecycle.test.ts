import { describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('agent delegation lifecycle bootstrap stability', () => {
  test('Kernel no longer creates parent/child ExecutionJobs for Agent delegation', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-agent-delegation-'));
    try {
      expect(() => createExecutionJob(controllerHome, {
        repoId: 'repo-a',
        type: 'agent-run',
        requestId: 'delegate-1',
        semanticKey: 'delegate-1',
        origin: { surface: 'mcp' },
        payload: { operation: 'dispatch_task', target: 'mcp-tool' },
        resourceClaims: [],
      })).toThrow(/EXECUTION_JOB_RETIRED/);
      expect(existsSync(join(import.meta.dir, '../../src/cli/agent-jobs/job-worker.ts'))).toBe(false);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });
});
