import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acceptTaskJob, retryAgentJob, startTaskJob } from '../../src/cli/agent-jobs/job-manager';
import { createIssue, getIssue } from '../../src/cli/controller/issue-store';
import { updateTask } from '../../src/cli/controller/issue-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-agent-retire-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'example.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-retire-fixture' }, null, 2));
  return root;
}

function writeHistoricalFailedRun(repoRoot: string, issueId: string, taskId: string, runId: string): void {
  const dir = join(repoRoot, '.ai/harness/jobs', runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, 'stdout.log'), 'historical stdout\n');
  writeFileSync(join(dir, 'stderr.log'), 'historical stderr\n');
  writeFileSync(join(dir, 'prompt.md'), '# historical prompt\n');
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    issueId,
    taskId,
    agent: 'codex',
    provider: 'local',
    status: 'failed',
    timeoutMs: 60_000,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    promptPath: join(dir, 'prompt.md'),
    stdoutPath: join(dir, 'stdout.log'),
    stderrPath: join(dir, 'stderr.log'),
    allowedPaths: ['src/**'],
    error: 'historical failure',
  }, null, 2)}\n`);
  updateTask(repoRoot, issueId, taskId, {
    status: 'failed',
    runId,
    note: 'Historical failure recorded for retirement regression.',
  });
}

function snapshotTree(root: string, relative = ''): string[] {
  const abs = relative ? join(root, relative) : root;
  if (!existsSync(abs)) return [];
  const entries: string[] = [];
  for (const name of readdirSync(abs, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${name.name}` : name.name;
    if (name.isDirectory()) entries.push(...snapshotTree(root, rel));
    else entries.push(rel);
  }
  return entries.sort();
}

describe('Agent Run write-boundary retirement', () => {
  test('acceptTaskJob and startTaskJob fail closed without creating runs or worktrees', () => {
    const repoRoot = fixtureRepo();
    const issue = createIssue(repoRoot, {
      title: 'Retire accept',
      tasks: [{
        title: 'Bounded edit',
        objective: 'Should not launch an Agent Run.',
        allowedPaths: ['src/example.ts'],
        risk: 'low',
      }],
    });
    const beforeFiles = snapshotTree(repoRoot);
    const beforeIssue = JSON.stringify(getIssue(repoRoot, issue.id));

    expect(() => acceptTaskJob({
      repoRoot,
      issueId: issue.id,
      taskId: 'T1',
      agent: 'codex',
      timeoutMs: 10_000,
      isolate: true,
      requestId: 'req-accept-retire-1',
    })).toThrow(/AGENT_RUN_RETIRED/);

    expect(() => startTaskJob({
      repoRoot,
      issueId: issue.id,
      taskId: 'T1',
      agent: 'codex',
      timeoutMs: 10_000,
      isolate: false,
    })).toThrow(/AGENT_RUN_RETIRED/);

    expect(snapshotTree(repoRoot)).toEqual(beforeFiles);
    expect(JSON.stringify(getIssue(repoRoot, issue.id))).toBe(beforeIssue);
    expect(existsSync(join(repoRoot, '.ai/harness/jobs'))).toBe(false);
    expect(existsSync(join(repoRoot, '.ai/harness/worktrees'))).toBe(false);
  });

  test('retryAgentJob returns AGENT_RUN_RETIRED with zero Task mutation or resource creation', () => {
    const repoRoot = fixtureRepo();
    const issue = createIssue(repoRoot, {
      title: 'Retire retry',
      tasks: [{
        title: 'Historical failed task',
        objective: 'Retry must not mutate state.',
        allowedPaths: ['src/example.ts'],
        risk: 'low',
      }],
    });
    const runId = 'RUN-historical-failed';
    writeHistoricalFailedRun(repoRoot, issue.id, 'T1', runId);

    const taskBefore = getIssue(repoRoot, issue.id).tasks.find((entry) => entry.id === 'T1')!;
    const taskJsonBefore = JSON.stringify(taskBefore);
    const issueJsonBefore = JSON.stringify(getIssue(repoRoot, issue.id));
    const jobsBefore = snapshotTree(join(repoRoot, '.ai/harness/jobs'));
    const metaBefore = readFileSync(join(repoRoot, '.ai/harness/jobs', runId, 'meta.json'), 'utf-8');
    const requestIndexRoot = join(repoRoot, '.ai/harness/jobs', 'requests');
    const requestIndexExisted = existsSync(requestIndexRoot);

    expect(() => retryAgentJob(repoRoot, runId, {
      timeoutMs: 12_000,
      isolate: true,
      supervisorInstructions: 'must not apply',
    })).toThrow(/AGENT_RUN_RETIRED/);

    const taskAfter = getIssue(repoRoot, issue.id).tasks.find((entry) => entry.id === 'T1')!;
    expect(JSON.stringify(taskAfter)).toBe(taskJsonBefore);
    expect(taskAfter.status).toBe('failed');
    expect(taskAfter.runIds ?? []).toContain(runId);
    expect(JSON.stringify(getIssue(repoRoot, issue.id))).toBe(issueJsonBefore);
    expect(snapshotTree(join(repoRoot, '.ai/harness/jobs'))).toEqual(jobsBefore);
    expect(readFileSync(join(repoRoot, '.ai/harness/jobs', runId, 'meta.json'), 'utf-8')).toBe(metaBefore);
    expect(existsSync(join(repoRoot, '.ai/harness/worktrees'))).toBe(false);
    if (!requestIndexExisted) {
      expect(existsSync(requestIndexRoot)).toBe(false);
    }
  });
});
