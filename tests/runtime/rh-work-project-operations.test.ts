import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import { callRuntimeTool } from '../../adapters/mcp/runtime-gateway/runtime-tools';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';
import { RH_WORK_MODEL_OPERATIONS } from '../../src/runtime/control-plane/facade/rh-work-operation-contract';
import { getToolPolicy } from '../../src/runtime/control-plane/tool-policy';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { listRepositories, registerRepository, resolveRepositorySelection } from '../../src/runtime/repositories/registry';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function initRepo(repoRoot: string): void {
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'project-operations-fixture' }));
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
}

function context(controllerHome: string, repository?: ReturnType<typeof registerRepository>): MultiRepositoryMcpToolContext {
  const fallbackRoot = repository?.canonicalRoot ?? listRepositories(controllerHome)[0]?.canonicalRoot ?? controllerHome;
  return {
    repoRoot: fallbackRoot,
    controllerHome,
    policy: getToolPolicy('controller', { repoRoot: fallbackRoot }),
    toolset: 'full',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    repositoryAccess: { list: listRepositories, resolve: resolveRepositorySelection },
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function structured(value: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(value).toBeTruthy();
  return (value!.structuredContent
    ?? JSON.parse(value!.content[0] && 'text' in value!.content[0] ? String(value!.content[0].text) : '{}')) as Record<string, any>;
}

describe('rh_work Project operations', () => {
  test('creates, lists, renames, archives and restores canonical Projects with revision-safe writes', async () => {
    const controllerHome = tempRoot('forge-project-operations-home-');
    const repoRootA = tempRoot('forge-project-operations-a-');
    const repoRootB = tempRoot('forge-project-operations-b-');
    ensureControllerHome(controllerHome);
    initRepo(repoRootA);
    initRepo(repoRootB);
    const repositoryA = registerRepository({ path: repoRootA, controllerHome, displayName: 'Project A repository' });
    const repositoryB = registerRepository({ path: repoRootB, controllerHome, displayName: 'Project B repository' });

    const standalone = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'project_create', project_id: 'project-standalone', project_display_name: 'Standalone Project',
    }));
    expect(standalone.status).toBe('ok');
    expect(standalone.data.project).toMatchObject({ projectId: 'project-standalone', workspaceId: 'workspace-personal', status: 'active', revision: 1, placements: [] });

    const created = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'project_create', project_id: 'project-a', project_display_name: 'Project A',
    }));
    expect(created.status).toBe('ok');
    expect(created.data).toMatchObject({ projectCreated: true, placementCreated: true });
    expect(created.data.project).toMatchObject({ projectId: 'project-a', status: 'active', revision: 1, placements: [{ repositoryId: repositoryA.repoId }] });

    const second = structured(await callRuntimeTool(context(controllerHome, repositoryB), 'rh_work', {
      operation: 'project_create', project_id: 'project-b', project_display_name: 'Project B',
    }));
    expect(second.status).toBe('ok');
    expect(second.data.project).toMatchObject({ projectId: 'project-b', placements: [{ repositoryId: repositoryB.repoId }] });

    const listed = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'project_list', limit: 20,
    }));
    expect(listed.status).toBe('ok');
    expect(listed.data).toMatchObject({ authority: 'project_semantic', bounded: true, limit: 20 });
    expect(listed.data.projects.map((project: { projectId: string }) => project.projectId).sort())
      .toEqual(['project-a', 'project-b', 'project-standalone']);

    const renamed = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'project_revise', project_id: 'project-a', expected_revision: 1,
      project_display_name: 'Project A Renamed', project_status: 'archived',
    }));
    expect(renamed.status).toBe('ok');
    expect(renamed.data.project).toMatchObject({ projectId: 'project-a', displayName: 'Project A Renamed', status: 'archived', revision: 2 });
    expect(renamed.data.project.placements).toEqual([{ schemaVersion: 1, projectId: 'project-a', forgeInstanceId: expect.any(String), repositoryId: repositoryA.repoId }]);

    const archived = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'project_list', project_status: 'archived', limit: 20,
    }));
    expect(archived.status).toBe('ok');
    expect(archived.data).toMatchObject({ statusFilter: 'archived' });
    expect(archived.data.projects.map((project: { projectId: string }) => project.projectId)).toEqual(['project-a']);

    const active = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'project_list', project_status: 'active', limit: 20,
    }));
    expect(active.status).toBe('ok');
    expect(active.data.projects.map((project: { projectId: string }) => project.projectId).sort())
      .toEqual(['project-b', 'project-standalone']);

    const stale = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'project_revise', project_id: 'project-a', expected_revision: 1, project_display_name: 'Stale overwrite',
    }));
    expect(stale.status).toBe('blocked');
    expect(stale.summary).toMatch(/REVISION_CONFLICT|REVISION_MISMATCH|STALE/i);

    const restored = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'project_revise', project_id: 'project-a', expected_revision: 2, project_status: 'active',
    }));
    expect(restored.status).toBe('ok');
    expect(restored.data.project).toMatchObject({ displayName: 'Project A Renamed', status: 'active', revision: 3 });

    const fetched = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'project_get', project_id: 'project-a', workspace_id: 'workspace-personal',
    }));
    expect(fetched.status).toBe('ok');
    expect(fetched.data.project).toMatchObject({ projectId: 'project-a', displayName: 'Project A Renamed', status: 'active', revision: 3 });

    expect(RH_WORK_MODEL_OPERATIONS).toEqual(expect.arrayContaining(['project_create', 'project_list', 'project_get', 'project_revise']));
    const rhWork = runtimeToolDefinitions.find((tool) => tool.name === 'rh_work');
    expect((rhWork?.inputSchema as { properties?: { operation?: { enum?: string[] } } }).properties?.operation?.enum)
      .toContain('project_revise');
  });
});
