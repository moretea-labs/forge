import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');

describe('bundled Agent launcher', () => {
  test('dispatchAcceptedTaskJob is metadata-only and never spawns a provider process', () => {
    const source = readFileSync(join(ROOT, 'src/cli/agent-jobs/job-manager.ts'), 'utf8');
    const start = source.indexOf('export function dispatchAcceptedTaskJob(');
    const end = source.indexOf('export function cancelAgentJob(', start);
    const dispatch = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(dispatch).toContain('Thin Launcher');
    expect(dispatch).not.toContain('spawn(process.execPath');
    expect(dispatch).not.toContain('job-worker');
    expect(dispatch).not.toContain('agent-worker.js');
  });
});
