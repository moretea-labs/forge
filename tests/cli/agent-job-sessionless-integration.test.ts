import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { IntegrationReviewRequiredError, integrateAgentJob } from '../../src/cli/agent-jobs/integration';
import { jobDir, metaPath } from '../../src/runtime/agent-jobs/read-model';
import { getToolPolicy } from '../../src/runtime/control-plane/tool-policy';
import { registerRepository } from '../../src/runtime/repositories/registry';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git ' + args.join(' ') + ' failed');
  }
  return result.stdout.trim();
}

function fixture(runId: string, conflict: boolean) {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-agent-job-sessionless-'));
  const repoRoot = join(workspace, 'repo');
  const controllerHome = join(workspace, 'controller-home');
  const worktree = join(workspace, 'worker-worktree');
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'config', 'user.email', 'forge-test@example.com');
  writeFileSync(join(repoRoot, 'worker.txt'), 'base\n');
  if (conflict) writeFileSync(join(repoRoot, 'conflict.txt'), 'base\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'base');
  const baseRevision = git(repoRoot, 'rev-parse', 'HEAD');
  const branch = 'task/' + runId;
  git(repoRoot, 'worktree', 'add', '-b', branch, worktree, baseRevision);

  writeFileSync(join(worktree, 'worker.txt'), 'worker\n');
  const changedPaths = ['worker.txt'];
  if (conflict) {
    writeFileSync(join(worktree, 'conflict.txt'), 'worker\n');
    changedPaths.push('conflict.txt');
  }
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'worker changes');

  if (conflict) {
    writeFileSync(join(repoRoot, 'conflict.txt'), 'main\n');
    git(repoRoot, 'add', 'conflict.txt');
    git(repoRoot, 'commit', '-m', 'main conflict');
  }

  const registered = registerRepository({ path: repoRoot, controllerHome });
  const directory = jobDir(repoRoot, runId);
  mkdirSync(directory, { recursive: true });
  const relativePath = (path: string) => relative(repoRoot, path).replace(/\\/g, '/');
  const createdAt = new Date().toISOString();
  const promptPath = join(directory, 'prompt.md');
  const stdoutPath = join(directory, 'stdout.log');
  const stderrPath = join(directory, 'stderr.log');
  const resultPath = join(directory, 'result.json');
  const eventsPath = join(directory, 'events.jsonl');
  writeFileSync(promptPath, 'integration test');
  writeFileSync(stdoutPath, '');
  writeFileSync(stderrPath, '');
  writeFileSync(resultPath, JSON.stringify({ ok: true, exitCode: 0, finishedAt: createdAt }));
  writeFileSync(eventsPath, '');
  const meta = {
    schemaVersion: 3,
    repoId: registered.repoId,
    checkoutId: registered.activeCheckoutId,
    runId,
    issueId: 'issue-sessionless-integration',
    taskId: 'task-sessionless-integration',
    agent: 'codex',
    provider: 'local',
    executionMode: 'worktree',
    status: 'succeeded',
    repoRoot,
    executionRoot: worktree,
    worktree,
    worktreePath: worktree,
    branch,
    baseRevision,
    promptPath: relativePath(promptPath),
    stdoutPath: relativePath(stdoutPath),
    stderrPath: relativePath(stderrPath),
    resultPath: relativePath(resultPath),
    eventsPath: relativePath(eventsPath),
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    lastHeartbeatAt: createdAt,
    exitCode: 0,
    autoIntegrate: false,
    closureState: 'ready_to_integrate',
    allowedPaths: changedPaths,
    changeOutcome: 'changed',
  };
  writeFileSync(metaPath(repoRoot, runId), JSON.stringify(meta, null, 2));
  return { workspace, repoRoot, controllerHome, worktree, runId, changedPaths };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('AgentJob sessionless worktree integration', () => {
  test('applies independent paths before preserving a conflict, then retries without EditSession', () => {
    const data = fixture('run-integration-review', true);
    const previousForgeHome = process.env.FORGE_CONTROLLER_HOME;
    const previousControllerHome = process.env.CONTROLLER_HOME;
    process.env.FORGE_CONTROLLER_HOME = data.controllerHome;
    process.env.CONTROLLER_HOME = data.controllerHome;
    try {
      let failure: unknown;
      try {
        integrateAgentJob(data.repoRoot, getToolPolicy('controller', { repoRoot: data.repoRoot }), data.runId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(IntegrationReviewRequiredError);
      expect(readFileSync(join(data.repoRoot, 'worker.txt'), 'utf8')).toBe('worker\n');
      expect(readFileSync(join(data.repoRoot, 'conflict.txt'), 'utf8')).toBe('main\n');
      expect(existsSync(join(jobDir(data.repoRoot, data.runId), 'integration-review.json'))).toBe(true);
      expect(existsSync(join(data.repoRoot, '.ai', 'harness', 'edit-sessions'))).toBe(false);

      writeFileSync(join(data.repoRoot, 'conflict.txt'), 'base\n');
      const retried = integrateAgentJob(
        data.repoRoot,
        getToolPolicy('controller', { repoRoot: data.repoRoot }),
        data.runId,
      );
      expect(retried).toMatchObject({
        status: 'applied',
        changeOutcome: 'changed',
        changedPaths: ['worker.txt', 'conflict.txt'],
      });
      expect(readFileSync(join(data.repoRoot, 'worker.txt'), 'utf8')).toBe('worker\n');
      expect(readFileSync(join(data.repoRoot, 'conflict.txt'), 'utf8')).toBe('worker\n');
      const stored = JSON.parse(readFileSync(metaPath(data.repoRoot, data.runId), 'utf8'));
      expect(stored.integratedAt).toBeTruthy();
      expect(stored.integratedSessionId).toBeUndefined();
      expect(stored.status).toBe('succeeded');
      expect(existsSync(join(data.repoRoot, '.ai', 'harness', 'edit-sessions'))).toBe(false);
    } finally {
      restoreEnv('FORGE_CONTROLLER_HOME', previousForgeHome);
      restoreEnv('CONTROLLER_HOME', previousControllerHome);
      try {
        git(data.repoRoot, 'worktree', 'remove', '--force', data.worktree);
      } catch {}
      rmSync(data.workspace, { recursive: true, force: true });
    }
  });

  test('successful integration is idempotent and stores Git-only completion metadata', () => {
    const data = fixture('run-integration-success', false);
    const previousForgeHome = process.env.FORGE_CONTROLLER_HOME;
    const previousControllerHome = process.env.CONTROLLER_HOME;
    process.env.FORGE_CONTROLLER_HOME = data.controllerHome;
    process.env.CONTROLLER_HOME = data.controllerHome;
    try {
      const first = integrateAgentJob(
        data.repoRoot,
        getToolPolicy('controller', { repoRoot: data.repoRoot }),
        data.runId,
      );
      const second = integrateAgentJob(
        data.repoRoot,
        getToolPolicy('controller', { repoRoot: data.repoRoot }),
        data.runId,
      );
      expect(first).toMatchObject({ status: 'applied', changeOutcome: 'changed', changedPaths: ['worker.txt'] });
      expect(second).toMatchObject({
        status: 'already_integrated',
        changeOutcome: 'changed',
        changedPaths: ['worker.txt'],
      });
      expect(readFileSync(join(data.repoRoot, 'worker.txt'), 'utf8')).toBe('worker\n');
      const stored = JSON.parse(readFileSync(metaPath(data.repoRoot, data.runId), 'utf8'));
      expect(stored.integratedAt).toBeTruthy();
      expect(stored.integratedSessionId).toBeUndefined();
      expect(existsSync(join(data.repoRoot, '.ai', 'harness', 'edit-sessions'))).toBe(false);
    } finally {
      restoreEnv('FORGE_CONTROLLER_HOME', previousForgeHome);
      restoreEnv('CONTROLLER_HOME', previousControllerHome);
      try {
        git(data.repoRoot, 'worktree', 'remove', '--force', data.worktree);
      } catch {}
      rmSync(data.workspace, { recursive: true, force: true });
    }
  });
});
