import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cliRepositoryCommandClaims } from '../../src/cli/commands/repository';
import { acquireControllerLock, releaseControllerLock } from '../../src/effects/controller-locks';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { acquireExecutionLeases, releaseExecutionLeases } from '../../src/runtime/resources/leases/store';

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src/cli/index.ts');
const EFFECTS = {
  visibility: 'ephemeral',
  notifyScheduler: false,
  invalidateProjection: false,
  emitRuntimeEvent: false,
} as const;

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-cli-repo-command-claims-'));
  const controllerHome = join(workspace, 'controller-home');
  const repoRoot = join(workspace, 'repo');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Forge Test']);
  git(repoRoot, ['config', 'user.email', 'forge-test@example.com']);
  writeFileSync(join(repoRoot, 'app.txt'), 'before\n');
  git(repoRoot, ['add', 'app.txt']);
  git(repoRoot, ['commit', '-qm', 'init']);
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return {
    workspace,
    controllerHome,
    repoRoot,
    repository,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

function runCli(controllerHome: string, args: string[]) {
  return spawnSync('bun', [CLI, 'repo', 'command', ...args, '--controller-home', controllerHome, '--json'], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORGE_CONTROLLER_HOME: controllerHome },
    timeout: 60_000,
  });
}

describe('CLI repo command resource claims (#713)', () => {
  test('claims are exact resources, never a checkout-wide workspace writer', () => {
    const fx = fixture();
    try {
      const readonly = cliRepositoryCommandClaims(fx.repository, 'git status --short');
      expect(readonly.every((claim) => claim.mode === 'read')).toBe(true);
      const stage = cliRepositoryCommandClaims(fx.repository, 'git add app.txt');
      expect(stage.map((claim) => claim.resourceKey)).toContain(`git-index:${fx.repository.activeCheckoutId}`);
      for (const claims of [readonly, stage]) {
        expect(claims.some((claim) => claim.resourceKey.startsWith('workspace:'))).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });

  test('a readonly command runs while another Writer holds the repository ControllerLock', () => {
    const fx = fixture();
    const key = { scope: 'repository' as const, repoId: fx.repository.repoId };
    const foreign = acquireControllerLock(fx.controllerHome, key, 'foreign-writer');
    try {
      const result = runCli(fx.controllerHome, [fx.repository.repoId, '--cmd', 'git status --short']);
      expect(`${result.stdout}${result.stderr}`).not.toContain('LOCK_HELD');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe('executed');
    } finally {
      releaseControllerLock(fx.controllerHome, key, foreign.lockId);
      fx.cleanup();
    }
  });

  test('a real Git index conflict still fences the command before it runs', () => {
    const fx = fixture();
    writeFileSync(join(fx.repoRoot, 'app.txt'), 'after\n');
    const held = acquireExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'test:foreign-index-owner',
      [
        {
          resourceKey: `git-index:${fx.repository.activeCheckoutId}`,
          mode: 'exclusive',
          repoId: fx.repository.repoId,
          checkoutId: fx.repository.activeCheckoutId,
        },
      ],
      EFFECTS,
    );
    expect(held.acquired).toBe(true);
    try {
      const result = runCli(fx.controllerHome, [fx.repository.repoId, '--cmd', 'git add app.txt']);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('REPOSITORY_PROCESS_LEASE_HELD');
      const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: fx.repoRoot, encoding: 'utf-8' });
      expect(staged.stdout.trim()).toBe('');
    } finally {
      releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'test:foreign-index-owner', held.leases, EFFECTS);
      fx.cleanup();
    }
  });
});
