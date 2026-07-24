import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { submitLocalBridgeJob } from '../../src/cli/local-bridge/job-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

describe('codex command builder', () => {
  test('refuses new Local Bridge Agent launches; Codex args belong to Thin Launcher', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-codex-args-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-codex-args-home-'));
    roots.push(root, controllerHome);
    process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
    mkdirSync(join(root, '.ai/harness'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# fixture\n');
    spawnSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    spawnSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
      cwd: root,
      stdio: 'ignore',
    });

    expect(() => submitLocalBridgeJob(root, {
      action: 'launch-task',
      requestId: 'codex-args-1',
      payload: {
        issueId: 'ISS-1',
        taskId: 'T1',
        agent: 'codex',
      },
    } as any)).toThrow(/LOCAL_BRIDGE_JOB_RETIRED|AGENT_RUN_RETIRED|EXECUTION_JOB_RETIRED/);
  });
});
