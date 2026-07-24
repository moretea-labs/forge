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

describe('Quick Agent v7 ephemeral lifecycle', () => {
  test('refuses new Local Bridge quick-agent-session Jobs', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-ephemeral-'));
    const home = mkdtempSync(join(tmpdir(), 'repo-harness-ephemeral-home-'));
    roots.push(root, home);
    process.env.REPO_HARNESS_CONTROLLER_HOME = home;
    mkdirSync(join(root, '.ai/harness'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# fixture\n');
    spawnSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    spawnSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
      cwd: root,
      stdio: 'ignore',
    });

    expect(() => submitLocalBridgeJob(root, {
      action: 'quick-agent-session',
      requestId: 'ephemeral-1',
      payload: {
        objective: 'noop',
        agent: 'codex',
        ephemeral: true,
      },
    } as any)).toThrow(/LOCAL_BRIDGE_JOB_RETIRED/);
  });
});
