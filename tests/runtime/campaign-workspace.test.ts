import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getRepository,
  registerRepository,
  selectRepositoryCheckout,
} from '../../src/cli/repositories/registry';
import { ensureCampaignWorkspace } from '../../src/runtime/workflow/campaigns/workspace';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-campaign-workspace-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Repo Harness Test');
  writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
  writeFileSync(join(repoRoot, 'marker.txt'), 'source checkout\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { root, controllerHome, repoRoot, repository };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Campaign workspace isolation', () => {
  test('creates one idempotent long-lived worktree without changing the active checkout', () => {
    const { controllerHome, repository } = fixture();
    const workspace = ensureCampaignWorkspace(controllerHome, repository, {
      requestId: 'campaign-request-1',
      title: 'ChatGPT supervised automation',
    });
    writeFileSync(join(repository.canonicalRoot, 'later.txt'), 'later source commit\n');
    execFileSync('git', ['-C', repository.canonicalRoot, 'add', 'later.txt']);
    execFileSync('git', ['-C', repository.canonicalRoot, 'commit', '-q', '-m', 'source advanced']);
    const repeated = ensureCampaignWorkspace(controllerHome, repository, {
      requestId: 'campaign-request-1',
      title: 'ChatGPT supervised automation',
    });
    const registered = getRepository(repository.repoId, controllerHome);

    expect(workspace.mode).toBe('isolated');
    expect(workspace.managed).toBe(true);
    expect(workspace.checkoutId).not.toBe(repository.activeCheckoutId);
    expect(repeated).toEqual(workspace);
    expect(registered.activeCheckoutId).toBe(repository.activeCheckoutId);
    expect(registered.checkouts).toHaveLength(2);
    expect(selectRepositoryCheckout(registered, workspace.checkoutId).canonicalRoot).toBe(workspace.root!);
  });

  test('ignores only missing historical checkout paths when creating a new workspace', () => {
    const { controllerHome, repository } = fixture();
    const stale = ensureCampaignWorkspace(controllerHome, repository, {
      requestId: 'campaign-request-stale',
      title: 'Stale managed checkout',
    });
    rmSync(stale.root!, { recursive: true, force: true });

    const next = ensureCampaignWorkspace(controllerHome, repository, {
      requestId: 'campaign-request-after-stale',
      title: 'Workspace after stale checkout',
    });
    expect(next.mode).toBe('isolated');
    expect(next.checkoutId).not.toBe(stale.checkoutId);
    expect(next.root).toBeTruthy();
  });

  test('keeps managed campaign checkouts addressable without creating ExecutionJobs', () => {
    const { controllerHome, repository } = fixture();
    const workspace = ensureCampaignWorkspace(controllerHome, repository, {
      requestId: 'campaign-request-routing',
      title: 'Checkout routing',
    });
    writeFileSync(join(workspace.root!, 'marker.txt'), 'campaign checkout\n');
    const registered = getRepository(repository.repoId, controllerHome);
    const checkout = selectRepositoryCheckout(registered, workspace.checkoutId);
    expect(checkout.canonicalRoot).toBe(workspace.root!);
    expect(readFileSync(join(checkout.canonicalRoot, 'marker.txt'), 'utf8')).toContain('campaign checkout');
  });
});
