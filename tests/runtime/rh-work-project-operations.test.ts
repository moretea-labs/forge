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

    const standaloneTask = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'requirement_create', project_id: 'project-standalone',
      requirement_id: 'REQ-STANDALONE-TASK', requirement_title: 'Independent project task',
      requirement_outcome: 'Manage a task without any repository binding.',
      requirement_status: 'active', requirement_priority: 'normal', requirement_assignee: 'owner',
    }));
    expect(standaloneTask.status).toBe('ok');
    expect(standaloneTask.data.requirement).toMatchObject({
      projectId: 'project-standalone', status: 'active', priority: 'normal', assignee: 'owner',
    });
    expect(standaloneTask.data.requirement.repoId).toBeUndefined();
    const reusedStandaloneTask = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'requirement_create', project_id: 'project-standalone',
      requirement_id: 'REQ-STANDALONE-TASK', requirement_title: 'Independent project task',
      requirement_outcome: 'Manage a task without any repository binding.',
      requirement_status: 'waiting_for_user', requirement_priority: 'urgent',
    }));
    expect(reusedStandaloneTask.data).toMatchObject({
      admissionDecision: 'reuse_existing', requirement: { projectId: 'project-standalone', status: 'active', priority: 'normal' },
    });
    const missingProjectTask = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'requirement_create', project_id: 'project-missing',
      requirement_id: 'REQ-MISSING-PROJECT', requirement_title: 'Not created',
      requirement_outcome: 'Missing Project cannot own a task.',
    }));
    expect(missingProjectTask.status).toBe('blocked');
    expect(missingProjectTask.summary).toContain('REQUIREMENT_PROJECT_NOT_FOUND');

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
    const mismatchedPlacement = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'requirement_create', project_id: 'project-b',
      requirement_id: 'REQ-INVALID-PROJECT-PLACEMENT', requirement_title: 'Incorrect project',
      requirement_outcome: 'A repository task cannot claim a different Project.',
    }));
    expect(mismatchedPlacement.status).toBe('blocked');
    expect(mismatchedPlacement.summary).toContain('REQUIREMENT_PROJECT_SCOPE_CONFLICT');

    const taskA = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'requirement_create', requirement_id: 'REQ-PROJECT-A-TASK',
      requirement_title: 'Project A task', requirement_outcome: 'Complete the Project A workflow.',
      requirement_status: 'active', requirement_priority: 'high', requirement_assignee: 'alice',
    }));
    expect(taskA.status).toBe('ok');
    expect(taskA.data.requirement).toMatchObject({ projectId: 'project-a', repoId: repositoryA.repoId, status: 'active', priority: 'high', assignee: 'alice' });

    const taskB = structured(await callRuntimeTool(context(controllerHome, repositoryB), 'rh_work', {
      operation: 'requirement_create', requirement_id: 'REQ-PROJECT-B-TASK',
      requirement_title: 'Project B task', requirement_outcome: 'Complete the Project B workflow.',
      requirement_status: 'waiting_for_user', requirement_priority: 'urgent', requirement_assignee: 'bob',
    }));
    expect(taskB.status).toBe('ok');
    expect(taskB.data.requirement).toMatchObject({ projectId: 'project-b', repoId: repositoryB.repoId, status: 'waiting_for_user', priority: 'urgent', assignee: 'bob' });

    const taskAWithDependency = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'requirement_revise', requirement_id: 'REQ-PROJECT-A-TASK', expected_revision: 1,
      requirement_dependencies: ['REQ-PROJECT-B-TASK'],
    }));
    expect(taskAWithDependency.status).toBe('ok');
    expect(taskAWithDependency.data.requirement).toMatchObject({ projectId: 'project-a', dependsOnRequirementIds: ['REQ-PROJECT-B-TASK'] });

    const staleTaskWrite = structured(await callRuntimeTool(context(controllerHome, repositoryA), 'rh_work', {
      operation: 'requirement_revise', requirement_id: 'REQ-PROJECT-A-TASK', expected_revision: 1,
      requirement_priority: 'normal',
    }));
    expect(staleTaskWrite.status).toBe('blocked');
    expect(staleTaskWrite.summary).toMatch(/REVISION_CONFLICT|REVISION_MISMATCH|STALE/i);

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
    const archivedProjectTask = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'requirement_create', project_id: 'project-a',
      requirement_id: 'REQ-ARCHIVED-PROJECT', requirement_title: 'Blocked while archived',
      requirement_outcome: 'Archived Projects cannot receive new tasks.',
    }));
    expect(archivedProjectTask.status).toBe('blocked');
    expect(archivedProjectTask.summary).toContain('REQUIREMENT_PROJECT_ARCHIVED');

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
      operation: 'project_get', project_id: 'project-a', workspace_id: 'workspace-personal', detail_level: 'detail',
    }));
    expect(fetched.status).toBe('ok');
    expect(fetched.data.project).toMatchObject({ projectId: 'project-a', displayName: 'Project A Renamed', status: 'active', revision: 3 });
    expect(fetched.data).toMatchObject({ requirementCount: 1, requirementsTruncated: false });
    expect(fetched.data.requirements).toMatchObject([{
      requirementId: 'REQ-PROJECT-A-TASK', title: 'Project A task', status: 'active',
      priority: 'high', assignee: 'alice', dependencyCount: 1,
    }]);
    expect(fetched.data.requirements.map((task: { requirementId: string }) => task.requirementId))
      .not.toContain('REQ-PROJECT-B-TASK');

    const projectBDetail = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'project_get', project_id: 'project-b', detail_level: 'detail',
    }));
    expect(projectBDetail.data.requirements).toMatchObject([{
      requirementId: 'REQ-PROJECT-B-TASK', status: 'waiting_for_user', priority: 'urgent', assignee: 'bob',
    }]);
    const standaloneDetail = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'project_get', project_id: 'project-standalone', detail_level: 'detail',
    }));
    expect(standaloneDetail.data).toMatchObject({
      requirements: [{ requirementId: 'REQ-STANDALONE-TASK', projectId: 'project-standalone',
        title: 'Independent project task', status: 'active', priority: 'normal', assignee: 'owner' }],
      requirementCount: 1, requirementsTruncated: false,
    });
    const standaloneTaskRevised = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'requirement_revise', requirement_id: 'REQ-STANDALONE-TASK',
      expected_revision: 1, requirement_status: 'waiting_for_user', requirement_priority: 'high',
    }));
    expect(standaloneTaskRevised.status).toBe('ok');
    expect(standaloneTaskRevised.data.requirement).toMatchObject({
      projectId: 'project-standalone', revision: 2, status: 'waiting_for_user', priority: 'high',
    });
    const summary = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'project_get', project_id: 'project-a',
    }));
    expect(summary.data.requirements).toBeUndefined();
    expect(fetched.data.revisionHistory.map((entry: { revision: number; displayName: string; status: string; action: string }) => ({
      revision: entry.revision, displayName: entry.displayName, status: entry.status, action: entry.action,
    }))).toEqual([
      { revision: 3, displayName: 'Project A Renamed', status: 'active', action: 'project_semantic_write' },
      { revision: 2, displayName: 'Project A Renamed', status: 'archived', action: 'project_semantic_write' },
      { revision: 1, displayName: 'Project A', status: 'active', action: 'project_semantic_onboard' },
    ]);

    // Re-read the registry and Requirement authority as a fresh runtime would after restart.
    ensureControllerHome(controllerHome);
    const independentAfterRestart = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'project_get', project_id: 'project-standalone', detail_level: 'detail',
    }));
    expect(independentAfterRestart.data.requirements).toMatchObject([{
      requirementId: 'REQ-STANDALONE-TASK', revision: 2, status: 'waiting_for_user', priority: 'high',
    }]);
    const standaloneHistory = structured(await callRuntimeTool(context(controllerHome), 'rh_work', {
      operation: 'requirement_get', requirement_id: 'REQ-STANDALONE-TASK', detail_level: 'detail',
    }));
    expect(standaloneHistory.data.revisionHistory).toMatchObject([{ revision: 1, projectId: 'project-standalone', status: 'active' }]);
    const repositoriesAfterRestart = listRepositories(controllerHome);
    const repositoryAAfterRestart = repositoriesAfterRestart.find((repository) => repository.repoId === repositoryA.repoId);
    expect(repositoryAAfterRestart).toBeTruthy();
    const taskListAfterRestart = structured(await callRuntimeTool(
      context(controllerHome, repositoryAAfterRestart as ReturnType<typeof registerRepository>), 'rh_work',
      { operation: 'requirement_list', limit: 20 },
    ));
    expect(taskListAfterRestart.data.requirements).toMatchObject([{
      requirementId: 'REQ-PROJECT-A-TASK', projectId: 'project-a', status: 'active', priority: 'high', assignee: 'alice', dependencyCount: 1,
    }]);

    const taskDetailAfterRestart = structured(await callRuntimeTool(
      context(controllerHome, repositoryAAfterRestart as ReturnType<typeof registerRepository>), 'rh_work',
      { operation: 'requirement_get', requirement_id: 'REQ-PROJECT-A-TASK', detail_level: 'detail' },
    ));
    expect(taskDetailAfterRestart.data.requirement).toMatchObject({
      projectId: 'project-a', status: 'active', priority: 'high', assignee: 'alice', dependsOnRequirementIds: ['REQ-PROJECT-B-TASK'],
    });
    expect(taskDetailAfterRestart.data.dependencyRequirements).toMatchObject([{
      requirementId: 'REQ-PROJECT-B-TASK', title: 'Project B task', status: 'waiting_for_user', priority: 'urgent', assignee: 'bob', repoId: repositoryB.repoId,
    }]);
    expect(taskDetailAfterRestart.data.revisionHistory).toMatchObject([{ revision: 1, status: 'active', priority: 'high', assignee: 'alice', dependsOnRequirementIds: [] }]);

    expect(RH_WORK_MODEL_OPERATIONS).toEqual(expect.arrayContaining([
      'project_create', 'project_list', 'project_get', 'project_revise',
      'requirement_list', 'requirement_create', 'requirement_get', 'requirement_revise',
    ]));
    const rhWork = runtimeToolDefinitions.find((tool) => tool.name === 'rh_work');
    const schemaProperties = (rhWork?.inputSchema as {
      properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
    }).properties;
    expect(schemaProperties?.operation?.enum).toEqual(expect.arrayContaining([
      'project_create', 'project_list', 'project_get', 'project_revise', 'requirement_list',
    ]));
    expect(schemaProperties).toMatchObject({
      project_id: { type: 'string' },
      project_display_name: { type: 'string' },
      project_status: { enum: ['active', 'archived'] },
      requirement_status: { type: 'string' },
      requirement_priority: { type: 'string' },
      requirement_assignee: { type: 'string' },
      requirement_dependencies: { type: 'array' },
      requirement_legacy_aliases: { type: 'array' },
    });
    expect(schemaProperties?.requirement_legacy_aliases?.description).toContain('requirement_create/requirement_revise');
  });
});
