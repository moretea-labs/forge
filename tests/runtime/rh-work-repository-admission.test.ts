import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { ensureControllerHome, SEMANTIC_SCOPE_KEY } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { getWorkContract } from '../../packages/kernel/work/api/index';
import { readWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initRepo(repoRoot: string): string {
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'rh-work-repository-admission-fixture' }));
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
  return git(repoRoot, 'rev-parse', 'HEAD');
}

function mcpContext(controllerHome: string, repository: ReturnType<typeof registerRepository>): MultiRepositoryMcpToolContext {
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    principalId: 'repository-admission-principal',
    sessionId: 'repository-admission-session',
    controllerInstanceId: 'repository-admission-runtime',
    controllerType: 'chatgpt',
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, any>;
}

describe('rh_work repository admission', () => {
  test('start without explicit repository remains semantic-only working context', async () => {
    const repoRoot = tempRoot('forge-rh-work-semantic-only-repo-');
    const controllerHome = tempRoot('forge-rh-work-semantic-only-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Semantic-only fixture' });
    const started = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
      operation: 'start',
      objective: 'Keep this as semantic working context only.',
      request_id: 'semantic-only-start',
    }));
    expect(started.status).toBe('ok');
    expect(started.data.executionHandle).toBeUndefined();
    const workId = String(started.data.work.workId);
    expect(getWorkContract({ controllerHome, scopeKey: SEMANTIC_SCOPE_KEY }, workId)).toBeDefined();
    expect(readWorkHandle(controllerHome, repository.repoId, workId)).toBeUndefined();
  });

  test('repo-bound start creates a concrete WorkHandle instead of stopping at semantic context', async () => {
    const repoRoot = tempRoot('forge-rh-work-admission-repo-');
    const controllerHome = tempRoot('forge-rh-work-admission-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Repository admission fixture' });
    const started = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Create one concrete repository execution carrier.',
      request_id: 'repository-start-current',
      source_revision: sourceRevision,
      allowed_paths: ['src/**'],
      constraints: { workspace_mode: 'current' },
    }));

    expect(started.status).toBe('ok');
    expect(started.data.executionHandle).toMatchObject({
      checkoutId: repository.activeCheckoutId,
      managedWorktree: false,
      state: 'prepared',
    });
    const workId = String(started.data.work.workId);
    expect(readWorkHandle(controllerHome, repository.repoId, workId)).toMatchObject({
      workId, checkoutId: repository.activeCheckoutId, managedWorktree: false,
    });
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)).toMatchObject({
      checkoutId: repository.activeCheckoutId,
      allowedPaths: ['src/**'],
    });
  });

  test('isolated repo-bound start materializes a managed worktree and binds the same Work identity', async () => {
    const repoRoot = tempRoot('forge-rh-work-isolated-repo-');
    const controllerHome = tempRoot('forge-rh-work-isolated-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Isolated repository admission fixture' });
    const started = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Create one isolated repository execution carrier.',
      request_id: 'repository-start-isolated',
      source_revision: sourceRevision,
      allowed_paths: ['src/**'],
      constraints: { workspace_mode: 'isolated' },
    }));

    expect(started.status).toBe('ok');
    expect(started.data.executionHandle).toMatchObject({ managedWorktree: true, state: 'prepared' });
    expect(started.data.executionHandle.checkoutId).not.toBe(repository.activeCheckoutId);
    const workId = String(started.data.work.workId);
    expect(readWorkHandle(controllerHome, repository.repoId, workId)).toMatchObject({
      workId, checkoutId: started.data.executionHandle.checkoutId, managedWorktree: true,
    });
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)).toMatchObject({
      checkoutId: started.data.executionHandle.checkoutId,
      constraints: { workspaceMode: 'isolated' },
    });
  });

  test('retired placement flags cannot override explicit current placement', async () => {
    const repoRoot = tempRoot('forge-rh-work-explicit-placement-repo-');
    const controllerHome = tempRoot('forge-rh-work-explicit-placement-home-');
    const sourceRevision = initRepo(repoRoot);
    writeFileSync(join(repoRoot, 'src', 'dirty.ts'), 'export const dirty = true;\n');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Explicit placement fixture' });
    const started = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Preserve caller-selected current placement.',
      request_id: 'repository-start-explicit-current',
      source_revision: sourceRevision,
      constraints: { workspace_mode: 'current', require_worktree: true, direct_main_prohibited: true },
    }));

    expect(started.status).toBe('ok');
    expect(started.data.executionHandle).toMatchObject({
      checkoutId: repository.activeCheckoutId,
      managedWorktree: false,
      state: 'prepared',
    });
    const workId = String(started.data.work.workId);
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.constraints).toEqual(
      expect.objectContaining({ workspaceMode: 'current' }),
    );
  });

  test('legacy auto placement mechanically selects isolated frozen-base execution without dirty heuristics', async () => {
    const repoRoot = tempRoot('forge-rh-work-auto-isolated-repo-');
    const controllerHome = tempRoot('forge-rh-work-auto-isolated-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Auto isolated fixture' });
    const started = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
      repo_id: repository.repoId,
      operation: 'start',
      objective: 'Use the stable durable Work auto placement.',
      request_id: 'repository-start-legacy-auto-isolated',
      source_revision: sourceRevision,
      constraints: { workspace_mode: 'auto' },
    }));

    expect(started.status).toBe('ok');
    expect(started.data.executionHandle).toMatchObject({ managedWorktree: true, state: 'prepared' });
    expect(started.data.executionHandle.checkoutId).not.toBe(repository.activeCheckoutId);
    const workId = String(started.data.work.workId);
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.constraints).toEqual(
      expect.objectContaining({ workspaceMode: 'isolated' }),
    );
  });

});
