import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import { callRuntimeTool } from '../../adapters/mcp/runtime-gateway/runtime-tools';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';
import { RH_PROJECT_MODEL_OPERATIONS } from '../../src/runtime/control-plane/facade/rh-project-operation-contract';
import { getToolPolicy } from '../../src/runtime/control-plane/tool-policy';
import {
  bindRequirementProjectPlacement,
  bindRequirementRepositoryPlacement,
} from '../../src/runtime/control-plane/persistence/requirement-store';
import { ensureControllerHome } from '../../src/effects/controller-home';
import {
  listRepositories,
  registerRepository,
  resolveRepositorySelection,
} from '../../src/runtime/repositories/registry';
import { createAutopilotRun, defaultAutopilotPolicy, updateAutopilotRun } from '../../src/runtime/autopilot/store';

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

function context(
  controllerHome: string,
  repository?: ReturnType<typeof registerRepository>,
): MultiRepositoryMcpToolContext {
  const fallbackRoot =
    repository?.canonicalRoot ?? listRepositories(controllerHome)[0]?.canonicalRoot ?? controllerHome;
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
  return (value!.structuredContent ??
    JSON.parse(value!.content[0] && 'text' in value!.content[0] ? String(value!.content[0].text) : '{}')) as Record<
    string,
    any
  >;
}

describe('rh_project Project operations', () => {
  test('repository-scoped project board excludes tasks directly owned by its standalone Project', async () => {
    const home = tempRoot('forge-project-repository-board-');
    const repoRoot = tempRoot('forge-project-repository-board-repo-');
    const otherRoot = tempRoot('forge-project-repository-board-other-');
    ensureControllerHome(home);
    initRepo(repoRoot);
    initRepo(otherRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome: home, displayName: 'Attached repository' });
    registerRepository({ path: otherRoot, controllerHome: home, displayName: 'Unrelated repository' });

    expect(
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'project_create',
          project_id: 'shared-board',
          project_display_name: 'Shared Board',
        }),
      ).status,
    ).toBe('ok');
    expect(
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'requirement_create',
          project_id: 'shared-board',
          requirement_id: 'REQ-BOARD-STANDALONE',
          requirement_title: 'Project-wide task',
          requirement_outcome: 'Track work without repository placement',
        }),
      ).status,
    ).toBe('ok');

    const placed = structured(
      await callRuntimeTool(context(home, repository), 'rh_project', {
        operation: 'project_create',
        project_id: 'shared-board',
        project_display_name: 'Shared Board',
      }),
    );
    expect(placed.status).toBe('ok');
    expect(placed.data.project.placements).toContainEqual(expect.objectContaining({ repositoryId: repository.repoId }));

    expect(
      structured(
        await callRuntimeTool(context(home, repository), 'rh_project', {
          operation: 'requirement_create',
          project_id: 'shared-board',
          requirement_id: 'REQ-BOARD-REPO',
          requirement_title: 'Repository task',
          requirement_outcome: 'Deliver repository task',
        }),
      ).status,
    ).toBe('ok');

    const global = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'requirement_list',
        project_id: 'shared-board',
      }),
    );
    expect(global.data.requirements.map((task: { requirementId: string }) => task.requirementId).sort()).toEqual([
      'REQ-BOARD-REPO',
      'REQ-BOARD-STANDALONE',
    ]);

    const selected = structured(
      await callRuntimeTool(context(home, repository), 'rh_project', {
        operation: 'requirement_list',
        project_id: 'shared-board',
      }),
    );
    expect(selected.status).toBe('ok');
    expect(selected.data.totalCount).toBe(1);
    expect(selected.data.requirements.map((task: { requirementId: string }) => task.requirementId)).toEqual([
      'REQ-BOARD-REPO',
    ]);
  });

  test('project detail pages expose all tasks without duplicating or hiding later rows', async () => {
    const home = tempRoot('forge-project-task-pages-');
    ensureControllerHome(home);
    expect(
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'project_create',
          project_id: 'paged-board',
          project_display_name: 'Paged Board',
        }),
      ).status,
    ).toBe('ok');
    for (const id of ['REQ-PAGE-A', 'REQ-PAGE-B', 'REQ-PAGE-C']) {
      expect(
        structured(
          await callRuntimeTool(context(home), 'rh_project', {
            operation: 'requirement_create',
            project_id: 'paged-board',
            requirement_id: id,
            requirement_title: id,
            requirement_outcome: 'Deliver ' + id,
          }),
        ).status,
      ).toBe('ok');
    }
    const page = async (offset: number) =>
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'project_get',
          project_id: 'paged-board',
          detail_level: 'detail',
          limit: 2,
          offset,
        }),
      );
    const first = await page(0);
    const second = await page(2);
    expect(first.data).toMatchObject({
      requirementCount: 3,
      limit: 2,
      offset: 0,
      hasMore: true,
      requirementsTruncated: true,
    });
    expect(second.data).toMatchObject({
      requirementCount: 3,
      limit: 2,
      offset: 2,
      hasMore: false,
      requirementsTruncated: false,
    });
    const ids = [...first.data.requirements, ...second.data.requirements].map(
      (task: { requirementId: string }) => task.requirementId,
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set(['REQ-PAGE-A', 'REQ-PAGE-B', 'REQ-PAGE-C']));
  });

  test('Requirement and Project task pagination preserves rows above the facade array bound', async () => {
    const home = tempRoot('forge-project-task-pages-over-50-');
    ensureControllerHome(home);
    expect(
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'project_create',
          project_id: 'large-board',
          project_display_name: 'Large Board',
        }),
      ).status,
    ).toBe('ok');
    for (let index = 0; index < 52; index += 1) {
      const id = `REQ-LARGE-${String(index).padStart(2, '0')}`;
      expect(
        structured(
          await callRuntimeTool(context(home), 'rh_project', {
            operation: 'requirement_create',
            project_id: 'large-board',
            requirement_id: id,
            requirement_title: id,
            requirement_outcome: `Deliver ${id}`,
          }),
        ).status,
      ).toBe('ok');
    }

    const requirementPage = async (offset: number, limit = 100) =>
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'requirement_list',
          project_id: 'large-board',
          limit,
          offset,
        }),
      );
    const allRequirements = await requirementPage(0);
    expect(allRequirements.data).toMatchObject({
      totalCount: 52,
      limit: 100,
      offset: 0,
      hasMore: false,
      requirementsTruncated: false,
    });
    expect(allRequirements.data.requirements).toHaveLength(52);
    const firstRequirements = await requirementPage(0, 50);
    const lastRequirements = await requirementPage(50, 50);
    expect(firstRequirements.data).toMatchObject({
      totalCount: 52,
      limit: 50,
      offset: 0,
      hasMore: true,
      requirementsTruncated: true,
    });
    expect(lastRequirements.data).toMatchObject({
      totalCount: 52,
      limit: 50,
      offset: 50,
      hasMore: false,
      requirementsTruncated: false,
    });
    expect([...firstRequirements.data.requirements, ...lastRequirements.data.requirements]).toHaveLength(52);

    const projectPage = async (offset: number, limit = 100) =>
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'project_get',
          project_id: 'large-board',
          detail_level: 'detail',
          limit,
          offset,
        }),
      );
    const allProjectTasks = await projectPage(0);
    expect(allProjectTasks.data).toMatchObject({
      requirementCount: 52,
      limit: 100,
      offset: 0,
      hasMore: false,
      requirementsTruncated: false,
    });
    expect(allProjectTasks.data.requirements).toHaveLength(52);
    const firstProjectTasks = await projectPage(0, 50);
    const lastProjectTasks = await projectPage(50, 50);
    expect(firstProjectTasks.data).toMatchObject({
      requirementCount: 52,
      limit: 50,
      offset: 0,
      hasMore: true,
      requirementsTruncated: true,
    });
    expect(lastProjectTasks.data).toMatchObject({
      requirementCount: 52,
      limit: 50,
      offset: 50,
      hasMore: false,
      requirementsTruncated: false,
    });
    expect([...firstProjectTasks.data.requirements, ...lastProjectTasks.data.requirements]).toHaveLength(52);
  });

  test('dependency-filtered project tasks become unblocked when their prerequisite is completed', async () => {
    const home = tempRoot('forge-project-blockers-');
    ensureControllerHome(home);
    expect(
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'project_create',
          project_id: 'board',
          project_display_name: 'Board',
        }),
      ).status,
    ).toBe('ok');
    for (const [id, dependencies] of [
      ['REQ-PRE', []],
      ['REQ-CHILD', ['REQ-PRE']],
    ] as const) {
      expect(
        structured(
          await callRuntimeTool(context(home), 'rh_project', {
            operation: 'requirement_create',
            project_id: 'board',
            requirement_id: id,
            requirement_title: id,
            requirement_outcome: 'Deliver ' + id,
            requirement_dependencies: dependencies,
          }),
        ).status,
      ).toBe('ok');
    }
    const list = async (filter: string, other: Record<string, unknown> = {}) =>
      structured(
        await callRuntimeTool(context(home), 'rh_project', {
          operation: 'requirement_list',
          project_id: 'board',
          dependency_filter: filter,
          ...other,
        }),
      );
    expect((await list('blocked')).data.requirements).toEqual([
      expect.objectContaining({ requirementId: 'REQ-CHILD', blockingDependencyIds: ['REQ-PRE'] }),
    ]);
    expect((await list('unblocked')).data.totalCount).toBe(1);
    const before = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'project_get',
        project_id: 'board',
        detail_level: 'detail',
      }),
    );
    expect(before.data.requirements).toContainEqual(
      expect.objectContaining({
        requirementId: 'REQ-CHILD',
        blockingDependencyIds: ['REQ-PRE'],
      }),
    );
    const done = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'requirement_revise',
        project_id: 'board',
        requirement_id: 'REQ-PRE',
        expected_revision: 1,
        requirement_status: 'done',
        requirement_remaining_work: [],
        requirement_accepted_evidence_refs: ['test:prerequisite-accepted'],
      }),
    );
    expect(done.status).toBe('ok');
    expect((await list('blocked')).data.totalCount).toBe(0);
    const readyPage = await list('unblocked', { sort_by: 'title', sort_order: 'asc', offset: 1, limit: 1 });
    expect(readyPage.data).toMatchObject({ totalCount: 2, hasMore: false });
    expect(readyPage.data.requirements[0]).toMatchObject({ requirementId: 'REQ-PRE', blockingDependencyIds: [] });
    const detail = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'requirement_get',
        project_id: 'board',
        requirement_id: 'REQ-CHILD',
      }),
    );
    expect(detail.data.requirement.blockingDependencyIds).toEqual([]);
    expect((await list('ready')).status).toBe('blocked');
  });

  test('creates, lists, renames, archives and restores canonical Projects with revision-safe writes', async () => {
    const controllerHome = tempRoot('forge-project-operations-home-');
    const repoRootA = tempRoot('forge-project-operations-a-');
    const repoRootB = tempRoot('forge-project-operations-b-');
    ensureControllerHome(controllerHome);
    initRepo(repoRootA);
    initRepo(repoRootB);
    const repositoryA = registerRepository({ path: repoRootA, controllerHome, displayName: 'Project A repository' });
    const repositoryB = registerRepository({ path: repoRootB, controllerHome, displayName: 'Project B repository' });

    const standalone = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_create',
        project_id: 'project-standalone',
        project_display_name: 'Standalone Project',
      }),
    );
    expect(standalone.status).toBe('ok');
    expect(standalone.data.project).toMatchObject({
      projectId: 'project-standalone',
      workspaceId: 'workspace-personal',
      status: 'active',
      revision: 1,
      placements: [],
    });

    const standaloneTask = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_create',
        project_id: 'project-standalone',
        requirement_id: 'REQ-STANDALONE-TASK',
        requirement_title: 'Independent project task',
        requirement_outcome: 'Manage a task without any repository binding.',
        requirement_status: 'active',
        requirement_priority: 'normal',
        requirement_assignee: 'owner',
      }),
    );
    expect(standaloneTask.status).toBe('ok');
    expect(standaloneTask.data.requirement).toMatchObject({
      projectId: 'project-standalone',
      status: 'active',
      priority: 'normal',
      assignee: 'owner',
    });
    expect(standaloneTask.data.requirement.repoId).toBeUndefined();
    const reusedStandaloneTask = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_create',
        project_id: 'project-standalone',
        requirement_id: 'REQ-STANDALONE-TASK',
        requirement_title: 'Independent project task',
        requirement_outcome: 'Manage a task without any repository binding.',
        requirement_status: 'waiting_for_user',
        requirement_priority: 'urgent',
      }),
    );
    expect(reusedStandaloneTask.data).toMatchObject({
      admissionDecision: 'reuse_existing',
      requirement: { projectId: 'project-standalone', status: 'active', priority: 'normal' },
    });
    const missingProjectTask = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_create',
        project_id: 'project-missing',
        requirement_id: 'REQ-MISSING-PROJECT',
        requirement_title: 'Not created',
        requirement_outcome: 'Missing Project cannot own a task.',
      }),
    );
    expect(missingProjectTask.status).toBe('blocked');
    expect(missingProjectTask.summary).toContain('REQUIREMENT_PROJECT_NOT_FOUND');

    const created = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_create',
        project_id: 'project-a',
        project_display_name: 'Project A',
      }),
    );
    expect(created.status).toBe('ok');
    expect(created.data).toMatchObject({ projectCreated: true, placementCreated: true });
    expect(created.data.project).toMatchObject({
      projectId: 'project-a',
      status: 'active',
      revision: 1,
      placements: [{ repositoryId: repositoryA.repoId }],
    });

    const second = structured(
      await callRuntimeTool(context(controllerHome, repositoryB), 'rh_project', {
        operation: 'project_create',
        project_id: 'project-b',
        project_display_name: 'Project B',
      }),
    );
    expect(second.status).toBe('ok');
    expect(second.data.project).toMatchObject({
      projectId: 'project-b',
      placements: [{ repositoryId: repositoryB.repoId }],
    });
    const mismatchedPlacement = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'requirement_create',
        project_id: 'project-b',
        requirement_id: 'REQ-INVALID-PROJECT-PLACEMENT',
        requirement_title: 'Incorrect project',
        requirement_outcome: 'A repository task cannot claim a different Project.',
      }),
    );
    expect(mismatchedPlacement.status).toBe('blocked');
    expect(mismatchedPlacement.summary).toContain('REQUIREMENT_PROJECT_SCOPE_CONFLICT');

    const taskA = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'requirement_create',
        requirement_id: 'REQ-PROJECT-A-TASK',
        requirement_title: 'Project A task',
        requirement_outcome: 'Complete the Project A workflow.',
        requirement_status: 'active',
        requirement_priority: 'high',
        requirement_assignee: 'alice',
      }),
    );
    expect(taskA.status).toBe('ok');
    expect(taskA.data.requirement).toMatchObject({
      projectId: 'project-a',
      repoId: repositoryA.repoId,
      status: 'active',
      priority: 'high',
      assignee: 'alice',
    });

    const taskB = structured(
      await callRuntimeTool(context(controllerHome, repositoryB), 'rh_project', {
        operation: 'requirement_create',
        requirement_id: 'REQ-PROJECT-B-TASK',
        requirement_title: 'Project B task',
        requirement_outcome: 'Complete the Project B workflow.',
        requirement_status: 'waiting_for_user',
        requirement_priority: 'urgent',
        requirement_assignee: 'bob',
      }),
    );
    expect(taskB.status).toBe('ok');
    expect(taskB.data.requirement).toMatchObject({
      projectId: 'project-b',
      repoId: repositoryB.repoId,
      status: 'waiting_for_user',
      priority: 'urgent',
      assignee: 'bob',
    });

    const taskAWithDependency = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-PROJECT-A-TASK',
        expected_revision: 1,
        requirement_dependencies: ['REQ-PROJECT-B-TASK'],
        requirement_progress_summary: 'Implementation is in progress; dependency wiring is complete.',
        requirement_remaining_work: ['Verify the connected list readback.'],
        requirement_accepted_evidence_refs: ['test:evidence:project-a-progress'],
      }),
    );
    expect(taskAWithDependency.status).toBe('ok');
    expect(taskAWithDependency.data.requirement).toMatchObject({
      projectId: 'project-a',
      dependsOnRequirementIds: ['REQ-PROJECT-B-TASK'],
      progressSummary: 'Implementation is in progress; dependency wiring is complete.',
      remainingWork: ['Verify the connected list readback.'],
      acceptedEvidenceRefs: ['test:evidence:project-a-progress'],
    });
    const taskAPlan = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'plan_create',
        plan_id: 'PLAN-PROJECT-A-TASK',
        requirement_id: 'REQ-PROJECT-A-TASK',
        objective: 'Complete the Project A task.',
        plan_items: [{ id: 'implementation', objective: 'Implement and verify.', dependencies: [] }],
      }),
    );
    expect(taskAPlan.status).toBe('ok');
    const autopilotRun = createAutopilotRun(controllerHome, {
      repoId: repositoryA.repoId,
      checkoutId: repositoryA.activeCheckoutId!,
      requirementId: 'REQ-PROJECT-A-TASK',
      requirementRevision: 2,
      grantId: 'grant-private-must-not-leak',
      policy: defaultAutopilotPolicy({ endpoint: 'https://private-endpoint.example.invalid' }),
    });
    const updatedAutopilotRun = updateAutopilotRun(controllerHome, repositoryA.repoId, 'REQ-PROJECT-A-TASK', (run) => ({
      ...run,
      status: 'paused',
      currentPlanId: 'PLAN-PROJECT-A-TASK',
      lastSummary: 'Implementation passed; device validation remains.',
      stopReason: 'max_tool_calls_reached',
      pendingProcessId: 'proc-private',
      pendingCommandRequestId: 'request-private',
      evidenceRefs: ['check:unit:passed', 'artifact:sha256:abc123'],
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, turns: 2, toolCalls: 3 },
    }));
    expect(updatedAutopilotRun.value.runId).toBe(autopilotRun.value.runId);
    const taskAList = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_list',
        project_id: 'project-a',
        limit: 20,
      }),
    );
    expect(taskAList.data.requirements).toMatchObject([
      {
        requirementId: 'REQ-PROJECT-A-TASK',
        autopilotRun: { runId: autopilotRun.value.runId, status: 'paused', requiresReapproval: false },
      },
    ]);

    const staleTaskWrite = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-PROJECT-A-TASK',
        expected_revision: 1,
        requirement_priority: 'normal',
      }),
    );
    expect(staleTaskWrite.status).toBe('blocked');
    expect(staleTaskWrite.summary).toMatch(/REVISION_CONFLICT|REVISION_MISMATCH|STALE/i);

    const listed = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_list',
        limit: 20,
      }),
    );
    expect(listed.status).toBe('ok');
    expect(listed.data).toMatchObject({
      authority: 'project_semantic',
      progressAuthority: 'github_issue_project',
      bounded: true,
      limit: 20,
      offset: 0,
      totalCount: 3,
      hasMore: false,
      projectsTruncated: false,
    });
    expect(listed.data.projects.map((project: { projectId: string }) => project.projectId).sort()).toEqual([
      'project-a',
      'project-b',
      'project-standalone',
    ]);
    const searchedProjects = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_list',
        search_query: 'project b',
        limit: 20,
      }),
    );
    expect(searchedProjects.data).toMatchObject({ totalCount: 1, searchQuery: 'project b', hasMore: false });
    expect(searchedProjects.data.projects.map((project: { projectId: string }) => project.projectId)).toEqual([
      'project-b',
    ]);
    const nameSorted = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_list',
        project_sort_by: 'display_name',
        sort_order: 'asc',
        limit: 20,
      }),
    );
    expect(nameSorted.data).toMatchObject({ projectSortBy: 'display_name', sortOrder: 'asc' });
    const names = nameSorted.data.projects.map((project: { displayName: string }) => project.displayName);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
    const statusSorted = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_list',
        project_sort_by: 'status',
        sort_order: 'asc',
        limit: 20,
      }),
    );
    const statuses = statusSorted.data.projects.map((project: { status: string }) => project.status);
    expect(statuses).toEqual([...statuses].sort((a: string, b: string) => a.localeCompare(b)));
    expect(listed.data.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: 'project-a',
          requirementCount: 1,
          taskStatusCounts: {
            planned: 0,
            active: 1,
            waiting_for_user: 0,
            done: 0,
            cancelled: 0,
          },
        }),
        expect.objectContaining({
          projectId: 'project-b',
          requirementCount: 1,
          taskStatusCounts: {
            planned: 0,
            active: 0,
            waiting_for_user: 1,
            done: 0,
            cancelled: 0,
          },
        }),
        expect.objectContaining({
          projectId: 'project-standalone',
          requirementCount: 1,
          taskStatusCounts: {
            planned: 0,
            active: 1,
            waiting_for_user: 0,
            done: 0,
            cancelled: 0,
          },
        }),
      ]),
    );
    const boundedProjectList = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_list',
        limit: 2,
        offset: 0,
      }),
    );
    expect(boundedProjectList.data).toMatchObject({ totalCount: 3, offset: 0, hasMore: true, projectsTruncated: true });
    expect(boundedProjectList.data.projects).toHaveLength(2);
    const dependencySummary = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-a',
        detail_level: 'summary',
      }),
    );
    expect(dependencySummary.data).toMatchObject({
      requirementCount: 1,
      taskPriorityCounts: { urgent: 0, high: 1, normal: 0, low: 0, unset: 0 },
      blockedTaskCount: 1,
    });
    const nextProjectPage = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_list',
        limit: 2,
        offset: 2,
      }),
    );
    expect(nextProjectPage.data).toMatchObject({ totalCount: 3, offset: 2, hasMore: false, projectsTruncated: false });
    expect(nextProjectPage.data.projects).toHaveLength(1);
    expect(
      [...boundedProjectList.data.projects, ...nextProjectPage.data.projects]
        .map((project: { projectId: string }) => project.projectId)
        .sort(),
    ).toEqual(['project-a', 'project-b', 'project-standalone']);

    const renamed = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_revise',
        project_id: 'project-a',
        expected_revision: 1,
        project_display_name: 'Project A Renamed',
        project_status: 'archived',
      }),
    );
    expect(renamed.status).toBe('ok');
    expect(renamed.data.project).toMatchObject({
      projectId: 'project-a',
      displayName: 'Project A Renamed',
      status: 'archived',
      revision: 2,
    });
    expect(renamed.data.project.placements).toEqual([
      {
        schemaVersion: 1,
        projectId: 'project-a',
        forgeInstanceId: expect.any(String),
        repositoryId: repositoryA.repoId,
      },
    ]);
    const archivedProjectTask = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_create',
        project_id: 'project-a',
        requirement_id: 'REQ-ARCHIVED-PROJECT',
        requirement_title: 'Blocked while archived',
        requirement_outcome: 'Archived Projects cannot receive new tasks.',
      }),
    );
    expect(archivedProjectTask.status).toBe('blocked');
    expect(archivedProjectTask.summary).toContain('REQUIREMENT_PROJECT_ARCHIVED');
    const archivedRepositoryTask = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'requirement_create',
        requirement_id: 'REQ-ARCHIVED-REPOSITORY-PROJECT',
        requirement_title: 'Blocked in archived repository Project',
        requirement_outcome: 'Repository-backed tasks must respect archived Project state.',
      }),
    );
    expect(archivedRepositoryTask.status).toBe('blocked');
    expect(archivedRepositoryTask.summary).toContain('REQUIREMENT_PROJECT_ARCHIVED');

    const archived = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_list',
        project_status: 'archived',
        limit: 20,
      }),
    );
    expect(archived.status).toBe('ok');
    expect(archived.data).toMatchObject({ statusFilter: 'archived' });
    expect(archived.data.projects.map((project: { projectId: string }) => project.projectId)).toEqual(['project-a']);

    const active = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_list',
        project_status: 'active',
        limit: 20,
      }),
    );
    expect(active.status).toBe('ok');
    expect(active.data.projects.map((project: { projectId: string }) => project.projectId).sort()).toEqual([
      'project-b',
      'project-standalone',
    ]);

    const stale = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_revise',
        project_id: 'project-a',
        expected_revision: 1,
        project_display_name: 'Stale overwrite',
      }),
    );
    expect(stale.status).toBe('blocked');
    expect(stale.summary).toMatch(/REVISION_CONFLICT|REVISION_MISMATCH|STALE/i);

    const restored = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_revise',
        project_id: 'project-a',
        expected_revision: 2,
        project_status: 'active',
      }),
    );
    expect(restored.status).toBe('ok');
    expect(restored.data.project).toMatchObject({ displayName: 'Project A Renamed', status: 'active', revision: 3 });

    const fetched = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-a',
        workspace_id: 'workspace-personal',
        detail_level: 'detail',
      }),
    );
    expect(fetched.status).toBe('ok');
    expect(fetched.data.project).toMatchObject({
      projectId: 'project-a',
      displayName: 'Project A Renamed',
      status: 'active',
      revision: 3,
    });
    expect(fetched.data).toMatchObject({
      progressAuthority: 'github_issue_project',
      requirementCount: 1,
      requirementsTruncated: false,
    });
    expect(fetched.data.requirements).toMatchObject([
      {
        requirementId: 'REQ-PROJECT-A-TASK',
        title: 'Project A task',
        status: 'active',
        priority: 'high',
        assignee: 'alice',
        dependencyCount: 1,
        progressSummary: 'Implementation is in progress; dependency wiring is complete.',
        remainingWorkCount: 1,
        acceptedEvidenceCount: 1,
        autopilotRun: {
          runId: autopilotRun.value.runId,
          status: 'paused',
          requirementRevision: 2,
          requiresReapproval: false,
          currentPlanId: 'PLAN-PROJECT-A-TASK',
          lastSummary: 'Implementation passed; device validation remains.',
          stopReason: 'max_tool_calls_reached',
          processReconciliationPending: true,
          evidenceRefs: ['check:unit:passed', 'artifact:sha256:abc123'],
          evidenceTruncatedCount: 0,
          usage: { totalTokens: 150, turns: 2, toolCalls: 3 },
        },
      },
    ]);
    const autopilotSummary = fetched.data.requirements[0].autopilotRun;
    expect(JSON.stringify(autopilotSummary)).not.toContain('grant-private-must-not-leak');
    expect(JSON.stringify(autopilotSummary)).not.toContain('private-endpoint');
    expect(JSON.stringify(autopilotSummary)).not.toContain('request-private');
    expect(fetched.data.requirements.map((task: { requirementId: string }) => task.requirementId)).not.toContain(
      'REQ-PROJECT-B-TASK',
    );

    const projectFirstPage = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-a',
        detail_level: 'detail',
        limit: 1,
        offset: 0,
      }),
    );
    expect(projectFirstPage.data).toMatchObject({
      requirementCount: 1,
      limit: 1,
      offset: 0,
      hasMore: false,
      requirementsTruncated: false,
    });
    expect(projectFirstPage.data.requirements.map((task: { requirementId: string }) => task.requirementId)).toEqual([
      'REQ-PROJECT-A-TASK',
    ]);
    const beyondEndPage = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-a',
        detail_level: 'detail',
        limit: 1,
        offset: 1,
      }),
    );
    expect(beyondEndPage.data).toMatchObject({
      requirementCount: 1,
      limit: 1,
      offset: 1,
      hasMore: false,
      requirementsTruncated: false,
      requirements: [],
    });

    const projectBDetail = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-b',
        detail_level: 'detail',
      }),
    );
    expect(projectBDetail.data.requirements).toMatchObject([
      {
        requirementId: 'REQ-PROJECT-B-TASK',
        status: 'waiting_for_user',
        priority: 'urgent',
        assignee: 'bob',
        autopilotRun: null,
      },
    ]);
    const standaloneDetail = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-standalone',
        detail_level: 'detail',
      }),
    );
    expect(standaloneDetail.data).toMatchObject({
      requirements: [
        {
          requirementId: 'REQ-STANDALONE-TASK',
          projectId: 'project-standalone',
          title: 'Independent project task',
          status: 'active',
          priority: 'normal',
          assignee: 'owner',
          autopilotRun: null,
        },
      ],
      requirementCount: 1,
      requirementsTruncated: false,
    });
    const standaloneTaskRevised = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-STANDALONE-TASK',
        expected_revision: 1,
        requirement_status: 'waiting_for_user',
        requirement_priority: 'high',
      }),
    );
    expect(standaloneTaskRevised.status).toBe('ok');
    expect(standaloneTaskRevised.data.requirement).toMatchObject({
      projectId: 'project-standalone',
      revision: 2,
      status: 'waiting_for_user',
      priority: 'high',
    });
    const summary = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-a',
      }),
    );
    expect(summary.data.requirements).toBeUndefined();
    expect(
      fetched.data.revisionHistory.map(
        (entry: { revision: number; displayName: string; status: string; action: string }) => ({
          revision: entry.revision,
          displayName: entry.displayName,
          status: entry.status,
          action: entry.action,
        }),
      ),
    ).toEqual([
      { revision: 3, displayName: 'Project A Renamed', status: 'active', action: 'project_semantic_write' },
      { revision: 2, displayName: 'Project A Renamed', status: 'archived', action: 'project_semantic_write' },
      { revision: 1, displayName: 'Project A', status: 'active', action: 'project_semantic_onboard' },
    ]);

    // Re-read the registry and Requirement authority as a fresh runtime would after restart.
    ensureControllerHome(controllerHome);
    const independentAfterRestart = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-standalone',
        detail_level: 'detail',
      }),
    );
    expect(independentAfterRestart.data.requirements).toMatchObject([
      {
        requirementId: 'REQ-STANDALONE-TASK',
        revision: 2,
        status: 'waiting_for_user',
        priority: 'high',
      },
    ]);
    const standaloneHistory = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_get',
        requirement_id: 'REQ-STANDALONE-TASK',
        detail_level: 'detail',
      }),
    );
    expect(standaloneHistory.data.revisionHistory).toMatchObject([
      { revision: 1, projectId: 'project-standalone', status: 'active' },
    ]);
    const repositoriesAfterRestart = listRepositories(controllerHome);
    const repositoryAAfterRestart = repositoriesAfterRestart.find(
      (repository) => repository.repoId === repositoryA.repoId,
    );
    expect(repositoryAAfterRestart).toBeTruthy();
    const taskListAfterRestart = structured(
      await callRuntimeTool(
        context(controllerHome, repositoryAAfterRestart as ReturnType<typeof registerRepository>),
        'rh_project',
        { operation: 'requirement_list', limit: 20 },
      ),
    );
    expect(taskListAfterRestart.data.requirements).toMatchObject([
      {
        requirementId: 'REQ-PROJECT-A-TASK',
        projectId: 'project-a',
        status: 'active',
        priority: 'high',
        assignee: 'alice',
        dependencyCount: 1,
        progressSummary: 'Implementation is in progress; dependency wiring is complete.',
        remainingWorkCount: 1,
        acceptedEvidenceCount: 1,
      },
    ]);

    const taskDetailAfterRestart = structured(
      await callRuntimeTool(
        context(controllerHome, repositoryAAfterRestart as ReturnType<typeof registerRepository>),
        'rh_project',
        { operation: 'requirement_get', requirement_id: 'REQ-PROJECT-A-TASK', detail_level: 'detail' },
      ),
    );
    expect(taskDetailAfterRestart.data.progressAuthority).toBe('github_issue_project');
    expect(taskDetailAfterRestart.data.requirement).toMatchObject({
      projectId: 'project-a',
      status: 'active',
      priority: 'high',
      assignee: 'alice',
      dependsOnRequirementIds: ['REQ-PROJECT-B-TASK'],
      progressSummary: 'Implementation is in progress; dependency wiring is complete.',
      remainingWork: ['Verify the connected list readback.'],
      acceptedEvidenceRefs: ['test:evidence:project-a-progress'],
    });
    expect(taskDetailAfterRestart.data.autopilotRun).toMatchObject({
      runId: autopilotRun.value.runId,
      status: 'paused',
      requirementRevision: 2,
      requiresReapproval: false,
      currentPlanId: 'PLAN-PROJECT-A-TASK',
      processReconciliationPending: true,
      evidenceRefs: ['check:unit:passed', 'artifact:sha256:abc123'],
      activityHistory: [
        { revision: 2, action: 'autopilot_run_updated' },
        { revision: 1, action: 'autopilot_run_started' },
      ],
      activityHistoryTruncated: false,
    });
    expect(taskDetailAfterRestart.data.dependencyRequirements).toMatchObject([
      {
        requirementId: 'REQ-PROJECT-B-TASK',
        title: 'Project B task',
        status: 'waiting_for_user',
        priority: 'urgent',
        assignee: 'bob',
        repoId: repositoryB.repoId,
      },
    ]);
    expect(taskDetailAfterRestart.data.revisionHistory).toMatchObject([
      { revision: 1, status: 'active', priority: 'high', assignee: 'alice', dependsOnRequirementIds: [] },
    ]);
    expect(taskDetailAfterRestart.data.activityHistory).toMatchObject([
      { revision: 2, action: 'requirement_semantic_revised', status: 'active', priority: 'high', assignee: 'alice' },
      { revision: 1, action: 'requirement_created', status: 'active', priority: 'high', assignee: 'alice' },
    ]);
    expect(taskDetailAfterRestart.data.activityHistoryTruncated).toBe(false);
    const revisedAfterRun = structured(
      await callRuntimeTool(
        context(controllerHome, repositoryAAfterRestart as ReturnType<typeof registerRepository>),
        'rh_project',
        {
          operation: 'requirement_revise',
          requirement_id: 'REQ-PROJECT-A-TASK',
          expected_revision: 2,
          requirement_progress_summary: 'Requirement changed after Run authorization; review the new revision.',
        },
      ),
    );
    expect(revisedAfterRun.status).toBe('ok');
    const staleRunDetail = structured(
      await callRuntimeTool(
        context(controllerHome, repositoryAAfterRestart as ReturnType<typeof registerRepository>),
        'rh_project',
        {
          operation: 'requirement_get',
          requirement_id: 'REQ-PROJECT-A-TASK',
          detail_level: 'detail',
        },
      ),
    );
    expect(staleRunDetail.data.autopilotRun).toMatchObject({
      requirementRevision: 2,
      requiresReapproval: true,
      status: 'paused',
    });
    expect(staleRunDetail.data.activityHistory[0]).toMatchObject({
      revision: 3,
      action: 'requirement_semantic_revised',
      status: 'active',
      progressSummary: 'Requirement changed after Run authorization; review the new revision.',
    });
    const restoredRepositoryTask = structured(
      await callRuntimeTool(context(controllerHome, repositoryA), 'rh_project', {
        operation: 'requirement_create',
        requirement_id: 'REQ-ARCHIVED-REPOSITORY-PROJECT',
        requirement_title: 'Blocked in archived repository Project',
        requirement_outcome: 'Repository-backed tasks must respect archived Project state.',
      }),
    );
    expect(restoredRepositoryTask.status).toBe('ok');
    expect(restoredRepositoryTask.data.requirement).toMatchObject({
      requirementId: 'REQ-ARCHIVED-REPOSITORY-PROJECT',
      repoId: repositoryA.repoId,
      projectId: 'project-a',
    });

    expect(RH_PROJECT_MODEL_OPERATIONS).toEqual(
      expect.arrayContaining([
        'project_create',
        'project_list',
        'project_get',
        'project_revise',
        'project_attach_requirement',
        'requirement_list',
        'requirement_create',
        'requirement_get',
        'requirement_revise',
      ]),
    );
    const rhProject = runtimeToolDefinitions.find((tool) => tool.name === 'rh_project');
    const schemaProperties = (
      (rhProject?.inputSchema ?? {}) as {
        properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
      }
    ).properties;
    expect(schemaProperties?.operation?.enum).toEqual(
      expect.arrayContaining([
        'project_create',
        'project_list',
        'project_get',
        'project_revise',
        'project_attach_requirement',
        'requirement_list',
      ]),
    );
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
    expect(schemaProperties?.requirement_legacy_aliases?.description).toContain(
      'requirement_create/requirement_revise',
    );
  });

  test('creates a repository-owned task when the user selects only its Project', async () => {
    const controllerHome = tempRoot('forge-project-board-create-home-');
    const repoRoot = tempRoot('forge-project-board-create-repo-');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Board repository' });
    const otherRoot = tempRoot('forge-project-board-other-repo-');
    initRepo(otherRoot);
    registerRepository({ path: otherRoot, controllerHome, displayName: 'Unrelated repository' });
    // No repository is selected: this is the global Project board, not a repository page.
    const board = {
      ...context(controllerHome),
      repoRoot: controllerHome,
      policy: getToolPolicy('controller', { repoRoot: controllerHome }),
    };
    const repositoryContext = context(controllerHome, repository);
    const project = structured(
      await callRuntimeTool(repositoryContext, 'rh_project', {
        operation: 'project_create',
        project_id: 'project-board',
        project_display_name: 'Board',
      }),
    );
    expect(project.status).toBe('ok');

    const newTask = {
      operation: 'requirement_create',
      project_id: 'project-board',
      requirement_id: 'REQ-BOARD-TASK',
      requirement_title: 'Project board task',
      requirement_outcome: 'Visible in the Project board and its repository task list.',
      requirement_priority: 'high',
      requirement_assignee: 'board-owner',
    };
    const created = structured(await callRuntimeTool(board, 'rh_project', newTask));
    expect(created.status).toBe('ok');
    expect(created.data).toMatchObject({
      requirementCreated: true,
      requirement: { requirementId: 'REQ-BOARD-TASK', projectId: 'project-board', repoId: repository.repoId },
    });

    const repositoryList = structured(
      await callRuntimeTool(repositoryContext, 'rh_project', {
        operation: 'requirement_list',
        limit: 100,
      }),
    );
    expect(repositoryList.data.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirementId: 'REQ-BOARD-TASK',
          projectId: 'project-board',
          repoId: repository.repoId,
        }),
      ]),
    );
    const projectDetail = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'project_get',
        project_id: 'project-board',
        detail_level: 'detail',
      }),
    );
    expect(projectDetail.data.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirementId: 'REQ-BOARD-TASK', repoId: repository.repoId, linkedPlanCount: 0 }),
      ]),
    );
    const beforePlan = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'requirement_get',
        project_id: 'project-board',
        requirement_id: 'REQ-BOARD-TASK',
        detail_level: 'detail',
      }),
    );
    expect(beforePlan.data).toMatchObject({ relatedPlanCount: 0, relatedPlans: [], relatedPlansTruncated: false });
    const createdPlan = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'plan_create',
        project_id: 'project-board',
        scope_key: 'project-board',
        plan_id: 'PLAN-BOARD-TASK',
        requirement_id: 'REQ-BOARD-TASK',
        objective: 'Implement the board task in a linked Plan.',
        plan_items: [{ id: 'implementation', objective: 'Implement the user workflow.', dependencies: [] }],
      }),
    );
    expect(createdPlan.status).toBe('ok');
    const projectWithPlan = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'project_get',
        project_id: 'project-board',
        detail_level: 'detail',
      }),
    );
    expect(projectWithPlan.data.requirements).toContainEqual(
      expect.objectContaining({
        requirementId: 'REQ-BOARD-TASK',
        linkedPlanCount: 1,
      }),
    );
    const taskFromBoard = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'requirement_get',
        project_id: 'project-board',
        requirement_id: 'REQ-BOARD-TASK',
        detail_level: 'detail',
      }),
    );
    expect(taskFromBoard.data).toMatchObject({
      relatedPlanCount: 1,
      relatedPlansTruncated: false,
      planDetailOperation: 'plan_get',
      relatedPlans: [
        {
          planId: 'PLAN-BOARD-TASK',
          repoId: repository.repoId,
          requirementId: 'REQ-BOARD-TASK',
          revision: 1,
          current: true,
          goal: 'Implement the board task in a linked Plan.',
        },
      ],
    });
    const navigatedPlan = structured(
      await callRuntimeTool(board, 'rh_project', {
        repo_id: taskFromBoard.data.relatedPlans[0].repoId,
        project_id: 'project-board',
        operation: 'plan_get',
        plan_id: taskFromBoard.data.relatedPlans[0].planId,
      }),
    );
    expect(navigatedPlan.data.plan).toMatchObject({ planId: 'PLAN-BOARD-TASK', requirementId: 'REQ-BOARD-TASK' });
    const updatedPlan = structured(
      await callRuntimeTool(board, 'rh_project', {
        repo_id: taskFromBoard.data.relatedPlans[0].repoId,
        project_id: 'project-board',
        operation: 'plan_revise',
        plan_id: 'PLAN-BOARD-TASK',
        expected_revision: 1,
        objective: 'Deliver and validate the board task.',
      }),
    );
    expect(updatedPlan.status).toBe('ok');
    const refreshedTaskFromBoard = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'requirement_get',
        project_id: 'project-board',
        requirement_id: 'REQ-BOARD-TASK',
        detail_level: 'detail',
      }),
    );
    expect(refreshedTaskFromBoard.data.relatedPlans[0]).toMatchObject({
      revision: 2,
      goal: 'Deliver and validate the board task.',
    });
    const repeated = structured(
      await callRuntimeTool(repositoryContext, 'rh_project', {
        ...newTask,
        project_id: 'project-board',
      }),
    );
    expect(repeated.data).toMatchObject({ requirementCreated: false, admissionDecision: 'reuse_existing' });

    const archived = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'project_revise',
        project_id: 'project-board',
        expected_revision: 1,
        project_status: 'archived',
      }),
    );
    expect(archived.status).toBe('ok');
    const blocked = structured(
      await callRuntimeTool(board, 'rh_project', {
        ...newTask,
        requirement_id: 'REQ-ARCHIVED-BOARD-TASK',
      }),
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.summary).toContain('REQUIREMENT_PROJECT_ARCHIVED');

    const restored = structured(
      await callRuntimeTool(board, 'rh_project', {
        operation: 'project_revise',
        project_id: 'project-board',
        expected_revision: 2,
        project_status: 'active',
      }),
    );
    expect(restored.status).toBe('ok');
    const afterRestore = structured(
      await callRuntimeTool(board, 'rh_project', {
        ...newTask,
        requirement_id: 'REQ-RESTORED-BOARD-TASK',
      }),
    );
    expect(afterRestore.status).toBe('ok');
    expect(afterRestore.data.requirement).toMatchObject({
      requirementId: 'REQ-RESTORED-BOARD-TASK',
      projectId: 'project-board',
      repoId: repository.repoId,
    });
  });

  test('attaches an existing Requirement through a Project repository placement without changing terminal state or duplicating the task', async () => {
    const controllerHome = tempRoot('forge-project-attach-requirement-home-');
    const repoRoot = tempRoot('forge-project-attach-requirement-repo-');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Migration repository' });

    const project = structured(
      await callRuntimeTool(context(controllerHome, repository), 'rh_project', {
        operation: 'project_create',
        project_id: 'project-migration',
        project_display_name: 'Migration Project',
      }),
    );
    expect(project.status).toBe('ok');
    expect(project.data.project.placements).toMatchObject([{ repositoryId: repository.repoId }]);

    const unscopedContext = {
      ...context(controllerHome),
      repoRoot: controllerHome,
      repositoryAccess: { list: () => [], resolve: resolveRepositorySelection },
    } as unknown as MultiRepositoryMcpToolContext;
    const legacy = structured(
      await callRuntimeTool(unscopedContext, 'rh_project', {
        operation: 'requirement_create',
        requirement_id: 'REQ-LEGACY-UNPLACED',
        requirement_title: 'Existing unplaced task',
        requirement_outcome: 'Attach this existing task to the migration project without creating a duplicate.',
        requirement_priority: 'high',
        requirement_assignee: 'migration-owner',
      }),
    );
    expect(legacy.status).toBe('ok');
    expect(legacy.data.requirement).not.toHaveProperty('repoId');
    expect(legacy.data.requirement).not.toHaveProperty('projectId');

    const completed = structured(
      await callRuntimeTool(unscopedContext, 'rh_project', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-LEGACY-UNPLACED',
        expected_revision: 1,
        requirement_status: 'done',
        requirement_remaining_work: [],
        requirement_accepted_evidence_refs: ['test:evidence:legacy-task-completed'],
      }),
    );
    expect(completed.status).toBe('ok');
    expect(completed.data.requirement).toMatchObject({ status: 'done', revision: 2 });

    const attached = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_attach_requirement',
        project_id: 'project-migration',
        requirement_id: 'REQ-LEGACY-UNPLACED',
      }),
    );
    expect(attached.status).toBe('ok');
    expect(attached.data).toMatchObject({
      attachmentCreated: true,
      attachmentStatus: 'attached',
      repositoryId: repository.repoId,
      requirement: {
        requirementId: 'REQ-LEGACY-UNPLACED',
        projectId: 'project-migration',
        repoId: repository.repoId,
        status: 'done',
        revision: 2,
        priority: 'high',
        assignee: 'migration-owner',
      },
    });

    expect(() =>
      bindRequirementProjectPlacement({ controllerHome }, 'REQ-LEGACY-UNPLACED', 'project-migration'),
    ).toThrow('REQUIREMENT_PROJECT_REPOSITORY_PLACEMENT_CONFLICT');

    const repeated = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_attach_requirement',
        project_id: 'project-migration',
        requirement_id: 'REQ-LEGACY-UNPLACED',
      }),
    );
    expect(repeated.status).toBe('ok');
    expect(repeated.data).toMatchObject({
      attachmentCreated: false,
      attachmentStatus: 'already_attached',
      requirement: { requirementId: 'REQ-LEGACY-UNPLACED', status: 'done', revision: 2 },
    });

    const detail = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-migration',
        detail_level: 'detail',
      }),
    );
    expect(detail.data).toMatchObject({
      requirementCount: 1,
      requirementsTruncated: false,
      requirements: [
        {
          requirementId: 'REQ-LEGACY-UNPLACED',
          projectId: 'project-migration',
          status: 'done',
          priority: 'high',
          assignee: 'migration-owner',
        },
      ],
    });

    const wrongProject = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_attach_requirement',
        project_id: 'another-project',
        requirement_id: 'REQ-LEGACY-UNPLACED',
      }),
    );
    expect(wrongProject.status).toBe('not_found');
  });

  test('attaches an existing Requirement directly to a standalone Project without changing terminal state or duplicating the task', async () => {
    const controllerHome = tempRoot('forge-project-attach-standalone-home-');
    ensureControllerHome(controllerHome);

    const project = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_create',
        project_id: 'project-standalone-migration',
        project_display_name: 'Standalone Migration',
      }),
    );
    expect(project.status).toBe('ok');
    expect(project.data.project.placements).toEqual([]);

    const legacy = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_create',
        requirement_id: 'REQ-LEGACY-STANDALONE',
        requirement_title: 'Existing standalone task',
        requirement_outcome: 'Attach this existing task to a standalone Project without creating a duplicate.',
        requirement_priority: 'high',
        requirement_assignee: 'migration-owner',
      }),
    );
    expect(legacy.status).toBe('ok');
    expect(legacy.data.requirement).not.toHaveProperty('repoId');
    expect(legacy.data.requirement).not.toHaveProperty('projectId');

    const completed = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-LEGACY-STANDALONE',
        expected_revision: 1,
        requirement_status: 'done',
        requirement_remaining_work: [],
        requirement_accepted_evidence_refs: ['test:evidence:standalone-task-completed'],
      }),
    );
    expect(completed.status).toBe('ok');

    const attached = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_attach_requirement',
        project_id: 'project-standalone-migration',
        requirement_id: 'REQ-LEGACY-STANDALONE',
      }),
    );
    expect(attached.status).toBe('ok');
    expect(attached.data).toMatchObject({
      attachmentCreated: true,
      attachmentStatus: 'attached',
      requirement: {
        requirementId: 'REQ-LEGACY-STANDALONE',
        projectId: 'project-standalone-migration',
        status: 'done',
        revision: 2,
        priority: 'high',
        assignee: 'migration-owner',
      },
    });

    expect(() => bindRequirementRepositoryPlacement({ controllerHome }, 'REQ-LEGACY-STANDALONE', 'repo_test')).toThrow(
      'REQUIREMENT_PROJECT_REPOSITORY_PLACEMENT_CONFLICT',
    );

    const repeated = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_attach_requirement',
        project_id: 'project-standalone-migration',
        requirement_id: 'REQ-LEGACY-STANDALONE',
      }),
    );
    expect(repeated.status).toBe('ok');
    expect(repeated.data).toMatchObject({
      attachmentCreated: false,
      attachmentStatus: 'already_attached',
      requirement: { requirementId: 'REQ-LEGACY-STANDALONE', status: 'done', revision: 2 },
    });

    const detail = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-standalone-migration',
        detail_level: 'detail',
      }),
    );
    expect(detail.data).toMatchObject({
      requirementCount: 1,
      requirements: [
        {
          requirementId: 'REQ-LEGACY-STANDALONE',
          projectId: 'project-standalone-migration',
          status: 'done',
          priority: 'high',
          assignee: 'migration-owner',
        },
      ],
    });

    const activeLegacy = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_create',
        requirement_id: 'REQ-LEGACY-ACTIVE',
        requirement_title: 'Existing active task',
        requirement_outcome: 'Keep the task editable after Project attachment.',
        requirement_status: 'active',
        requirement_priority: 'high',
        requirement_assignee: 'migration-owner',
      }),
    );
    expect(activeLegacy.status).toBe('ok');
    const activeAttached = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_attach_requirement',
        project_id: 'project-standalone-migration',
        requirement_id: 'REQ-LEGACY-ACTIVE',
      }),
    );
    expect(activeAttached.status).toBe('ok');

    const revisedAfterAttachment = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-LEGACY-ACTIVE',
        expected_revision: 1,
        requirement_priority: 'urgent',
        requirement_progress_summary: 'Updated after Project attachment.',
      }),
    );
    expect(revisedAfterAttachment.status).toBe('ok');
    const taskHistory = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'requirement_get',
        requirement_id: 'REQ-LEGACY-ACTIVE',
        detail_level: 'detail',
      }),
    );
    expect(taskHistory.data.activityHistory).toMatchObject([
      {
        revision: 3,
        semanticRevision: 2,
        action: 'requirement_semantic_revised',
        status: 'active',
        priority: 'urgent',
      },
      { revision: 2, semanticRevision: 1, action: 'requirement_project_bound', status: 'active', priority: 'high' },
      { revision: 1, semanticRevision: 1, action: 'requirement_created', status: 'active', priority: 'high' },
    ]);

    const otherProject = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_create',
        project_id: 'project-standalone-other',
        project_display_name: 'Other Standalone Project',
      }),
    );
    expect(otherProject.status).toBe('ok');
    const conflict = structured(
      await callRuntimeTool(context(controllerHome), 'rh_project', {
        operation: 'project_attach_requirement',
        project_id: 'project-standalone-other',
        requirement_id: 'REQ-LEGACY-STANDALONE',
      }),
    );
    expect(conflict.status).toBe('blocked');
    expect(conflict.summary).toContain('REQUIREMENT_PROJECT_CONFLICT');
  });

  test('historical task hierarchy migration preserves the existing scoped Plan and acceptance receipt', async () => {
    const home = tempRoot('forge-historical-task-tree-');
    ensureControllerHome(home);
    const ctx = context(home);
    const projectId = 'project-historical-tree';
    const rootId = 'REQ-HISTORICAL-ROOT';
    const taskId = 'REQ-HISTORICAL-TASK';
    const planId = 'PLAN-HISTORICAL-TASK';
    const call = async (args: Record<string, unknown>) =>
      structured(await callRuntimeTool(ctx, 'rh_project', { project_id: projectId, ...args }));
    expect((await call({ operation: 'project_create', project_display_name: 'Historical tree' })).status).toBe('ok');
    for (const requirementId of [rootId, taskId]) {
      expect(
        (
          await call({
            operation: 'requirement_create',
            requirement_id: requirementId,
            requirement_title: requirementId,
            requirement_outcome: 'Preserve existing history',
            ...(requirementId === rootId ? { requirement_is_project_root: true } : {}),
          })
        ).status,
      ).toBe('ok');
    }
    expect(
      (
        await call({
          operation: 'plan_create',
          plan_id: planId,
          requirement_id: taskId,
          scope_key: projectId,
          objective: 'Existing plan',
        })
      ).status,
    ).toBe('ok');
    const before = await call({ operation: 'plan_get', plan_id: planId, detail_level: 'detail' });
    expect(before.status).toBe('ok');
    const closed = await call({
      operation: 'requirement_revise',
      requirement_id: taskId,
      expected_revision: 1,
      requirement_state: 'completed',
      requirement_accepted_evidence_refs: ['receipt:accepted'],
    });
    expect(closed.status).toBe('ok');
    const attached = await call({
      operation: 'requirement_revise',
      requirement_id: taskId,
      expected_revision: 2,
      requirement_parent_id: rootId,
    });
    expect(attached.status).toBe('ok');
    expect(attached.data.requirement).toMatchObject({
      requirementId: taskId,
      revision: 3,
      status: 'done',
      parentRequirementId: rootId,
      rootRequirementId: rootId,
      acceptedEvidenceRefs: ['receipt:accepted'],
    });
    const repeat = await call({
      operation: 'requirement_revise',
      requirement_id: taskId,
      expected_revision: 3,
      requirement_parent_id: rootId,
    });
    expect(repeat.data.requirement).toEqual(attached.data.requirement);
    const after = await call({ operation: 'plan_get', plan_id: planId, detail_level: 'detail' });
    expect(after.status).toBe('ok');
    expect(after.data.plan).toEqual(before.data.plan);
    const detail = await call({ operation: 'project_get', detail_level: 'detail' });
    expect(detail.data.requirementTree.rootRequirementIds).toEqual([rootId]);
    expect(detail.data.requirementTree.nodes).toContainEqual({
      requirementId: taskId,
      parentRequirementId: rootId,
      childRequirementIds: [],
    });
  });

  test('standalone Project owns an isolated Plan lineage for its Requirement', async () => {
    const home = tempRoot('forge-project-plan-scope-');
    ensureControllerHome(home);

    for (const [projectId, requirementId] of [
      ['project-plan-a', 'REQ-PLAN-A'],
      ['project-plan-b', 'REQ-PLAN-B'],
    ] as const) {
      expect(
        structured(
          await callRuntimeTool(context(home), 'rh_project', {
            operation: 'project_create',
            project_id: projectId,
            project_display_name: projectId,
          }),
        ).status,
      ).toBe('ok');
      expect(
        structured(
          await callRuntimeTool(context(home), 'rh_project', {
            operation: 'requirement_create',
            project_id: projectId,
            requirement_id: requirementId,
            requirement_title: requirementId,
            requirement_outcome: 'Own a Project-scoped Plan.',
          }),
        ).status,
      ).toBe('ok');
    }

    const created = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'plan_create',
        project_id: 'project-plan-a',
        scope_key: 'project-plan-a',
        plan_id: 'PLAN-PROJECT-A',
        requirement_id: 'REQ-PLAN-A',
        objective: 'Plan standalone Project work.',
      }),
    );
    expect(created.status).toBe('ok');
    expect(created.data.plan).toMatchObject({
      planId: 'PLAN-PROJECT-A',
      requirementId: 'REQ-PLAN-A',
      revision: 1,
    });

    const detail = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'plan_get',
        project_id: 'project-plan-a',
        plan_id: 'PLAN-PROJECT-A',
        detail_level: 'detail',
      }),
    );
    expect(detail.status).toBe('ok');
    expect(detail.data.plan.planId).toBe('PLAN-PROJECT-A');

    const projectPlans = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'plan_list',
        project_id: 'project-plan-a',
      }),
    );
    expect(projectPlans.data.plans.map((plan: { planId: string }) => plan.planId)).toEqual(['PLAN-PROJECT-A']);
    const otherProjectPlans = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'plan_list',
        project_id: 'project-plan-b',
      }),
    );
    expect(otherProjectPlans.data.plans).toEqual([]);

    const otherProjectRead = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'plan_get',
        project_id: 'project-plan-b',
        plan_id: 'PLAN-PROJECT-A',
      }),
    );
    expect(otherProjectRead.status).toBe('not_found');

    const revised = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'plan_revise',
        project_id: 'project-plan-a',
        plan_id: 'PLAN-PROJECT-A',
        expected_revision: 1,
        objective: 'Revised standalone Project plan.',
      }),
    );
    expect(revised.status).toBe('ok');
    expect(revised.data.plan).toMatchObject({ planId: 'PLAN-PROJECT-A', revision: 2 });

    const crossProjectWrite = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'plan_revise',
        project_id: 'project-plan-b',
        plan_id: 'PLAN-PROJECT-A',
        expected_revision: 2,
        objective: 'Must not cross Project scope.',
      }),
    );
    expect(crossProjectWrite.status).toBe('blocked');
    expect(crossProjectWrite.summary).toContain('PLAN_PROJECT_SCOPE_CONFLICT');

    const projectDetail = structured(
      await callRuntimeTool(context(home), 'rh_project', {
        operation: 'project_get',
        project_id: 'project-plan-a',
        detail_level: 'detail',
      }),
    );
    expect(projectDetail.data.requirements).toMatchObject([
      {
        requirementId: 'REQ-PLAN-A',
        linkedPlanCount: 1,
      },
    ]);
  });
});
