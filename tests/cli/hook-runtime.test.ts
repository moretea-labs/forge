import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runHook, resolveHookStateRoot } from '../../src/cli/hook/runtime';
import { registerRepository } from '../../src/cli/repositories/registry';

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  cleanup.push(dir);
  return dir;
}

function gitRepo(): string {
  const repo = tempDir('forge-hook-runtime-repo');
  spawnSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Hook Runtime Test'], { cwd: repo, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'hook-runtime@test.local'], { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'forge.config.json'), '{"schemaVersion":1,"forge":{"enabled":true},"runtimeState":"controller-home"}\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  spawnSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('forge hook runtime state authority', () => {
  test('registered checkout resolves hook state below Controller Home repository namespace', () => {
    const repo = gitRepo();
    const controllerHome = tempDir('forge-hook-controller-home');
    const record = registerRepository({ path: repo, controllerHome });
    const state = resolveHookStateRoot(repo, { FORGE_CONTROLLER_HOME: controllerHome });
    expect(state.source).toBe('controller-home');
    expect(state.repoId).toBe(record.repoId);
    expect(state.root).toBe(path.join(controllerHome, 'repositories', record.repoId, 'hook-state'));
    expect(fs.existsSync(state.root)).toBe(true);
  });

  test('runHook injects Controller Home hook-state without creating repo-local harness state', () => {
    const repo = gitRepo();
    const controllerHome = tempDir('forge-hook-controller-home');
    const record = registerRepository({ path: repo, controllerHome });
    const hooksDir = tempDir('forge-hook-runtime-hooks');
    fs.writeFileSync(path.join(hooksDir, 'prompt-guard.sh'), '#!/bin/bash\nset -euo pipefail\nmkdir -p "$FORGE_HOOK_STATE_ROOT/probe"\nprintf "%s\\n" "$HOOK_REPO_ROOT" > "$FORGE_HOOK_STATE_ROOT/probe/repo-root.txt"\n');
    const previousHome = process.env.FORGE_CONTROLLER_HOME;
    process.env.FORGE_CONTROLLER_HOME = controllerHome;
    try {
      expect(runHook({ event: 'UserPromptSubmit', routeId: 'default', cwd: repo, hooksDir, stdio: 'ignore' }).exitCode).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
      else process.env.FORGE_CONTROLLER_HOME = previousHome;
    }
    const stateRoot = path.join(controllerHome, 'repositories', record.repoId, 'hook-state');
    expect(fs.readFileSync(path.join(stateRoot, 'probe', 'repo-root.txt'), 'utf8').trim()).toBe(repo);
    expect(fs.existsSync(path.join(repo, '.ai', 'harness'))).toBe(false);
  });

  test('unregistered checkout hook state is ephemeral and removed after invocation', () => {
    const repo = gitRepo();
    const controllerHome = tempDir('forge-hook-controller-home');
    const hooksDir = tempDir('forge-hook-runtime-hooks');
    const receipt = path.join(repo, 'hook-state-path.txt');
    fs.writeFileSync(path.join(hooksDir, 'prompt-guard.sh'), `#!/bin/bash\nset -euo pipefail\nprintf "%s\\n" "$FORGE_HOOK_STATE_ROOT" > ${JSON.stringify(receipt)}\n`);
    const previousHome = process.env.FORGE_CONTROLLER_HOME;
    process.env.FORGE_CONTROLLER_HOME = controllerHome;
    try {
      expect(runHook({ event: 'UserPromptSubmit', routeId: 'default', cwd: repo, hooksDir, stdio: 'ignore' }).exitCode).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
      else process.env.FORGE_CONTROLLER_HOME = previousHome;
    }
    const stateRoot = fs.readFileSync(receipt, 'utf8').trim();
    expect(stateRoot.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(stateRoot)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.ai', 'harness'))).toBe(false);
  });
});
