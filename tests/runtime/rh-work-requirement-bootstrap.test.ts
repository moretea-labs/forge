import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getToolPolicy } from '../../src/runtime/control-plane/tool-policy';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import { ensureControllerHome } from '../../src/effects/controller-home';
import {
  addRepositoryCheckout,
  listRepositories,
  registerRepository,
  resolveRepositorySelection,
} from '../../src/runtime/repositories/registry';
import { createPlanSemanticContext, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  createRequirement,
  readRequirement,
  updateRequirement,
} from '../../src/runtime/control-plane/persistence/requirement-store';
import { ensureForgeInstanceIdentity, readForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { recordCognitiveMemory, type CognitiveWriteAuthorityPort } from '../../packages/kernel/cognition/api/index';
import { cognitionMemoryStore } from '../../src/runtime/control-plane/persistence/cognition-store';
import {
  resolveProjectForRepositoryPlacement,
  writeProjectIdentity,
  writeProjectPlacement,
  writeWorkspaceIdentity,
} from '../../src/runtime/control-plane/workspace/workspace-store';
import { callRuntimeTool } from '../../adapters/mcp/runtime-gateway/runtime-tools';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';
import { readHistoricalWorkContract, seedHistoricalWorkContract } from '../helpers/historical-work-contract';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'requirement-bootstrap-fixture',
        scripts: { 'check:type': 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
  return git(repoRoot, 'rev-parse', 'HEAD');
}

function mcpContext(
  controllerHome: string,
  repository?: ReturnType<typeof registerRepository>,
): MultiRepositoryMcpToolContext {
  const repoRoot = repository?.canonicalRoot ?? controllerHome;
  return {
    repoRoot,
    controllerHome,
    policy: getToolPolicy('controller', { repoRoot }),
    toolset: 'full',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    repositoryAccess: { list: listRepositories, resolve: resolveRepositorySelection },
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent ??
    JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<
    string,
    any
  >;
}

test('rh_work exposes the single Project root and explicit child Requirement tree', async () => {
  const home = tempRoot('forge-requirement-tree-api-');
  ensureControllerHome(home);
  const ctx = mcpContext(home);
  structured(
    await callRuntimeTool(ctx, 'rh_work', {
      operation: 'project_create',
      project_id: 'tree-api',
      project_display_name: 'Tree API',
    }),
  );
  const root = structured(
    await callRuntimeTool(ctx, 'rh_work', {
      operation: 'requirement_create',
      project_id: 'tree-api',
      requirement_id: 'REQ-TREE-ROOT',
      requirement_title: 'Project root',
      requirement_outcome: 'Deliver the project.',
      requirement_is_project_root: true,
    }),
  );
  expect(root.status).toBe('ok');
  const child = structured(
    await callRuntimeTool(ctx, 'rh_work', {
      operation: 'requirement_create',
      project_id: 'tree-api',
      requirement_id: 'REQ-TREE-CHILD',
      requirement_title: 'Child',
      requirement_outcome: 'Deliver one slice.',
      requirement_parent_id: 'REQ-TREE-ROOT',
      requirement_dependencies: ['REQ-TREE-ROOT'],
    }),
  );
  expect(child.data.requirement).toMatchObject({
    parentRequirementId: 'REQ-TREE-ROOT',
    rootRequirementId: 'REQ-TREE-ROOT',
  });
  await callRuntimeTool(ctx, 'rh_work', {
    operation: 'requirement_create',
    project_id: 'tree-api',
    requirement_id: 'REQ-TREE-LEGACY',
    requirement_title: 'Legacy',
    requirement_outcome: 'Attach later.',
  });
  const attached = structured(
    await callRuntimeTool(ctx, 'rh_work', {
      operation: 'requirement_revise',
      project_id: 'tree-api',
      requirement_id: 'REQ-TREE-LEGACY',
      expected_revision: 1,
      requirement_parent_id: 'REQ-TREE-ROOT',
    }),
  );
  expect(attached.data.requirement).toMatchObject({
    parentRequirementId: 'REQ-TREE-ROOT',
    rootRequirementId: 'REQ-TREE-ROOT',
  });
  const listed = structured(
    await callRuntimeTool(ctx, 'rh_work', { operation: 'requirement_list', project_id: 'tree-api' }),
  );
  expect(listed.data.requirements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ requirementId: 'REQ-TREE-ROOT', rootRequirementId: 'REQ-TREE-ROOT' }),
      expect.objectContaining({
        requirementId: 'REQ-TREE-CHILD',
        parentRequirementId: 'REQ-TREE-ROOT',
        rootRequirementId: 'REQ-TREE-ROOT',
      }),
    ]),
  );
  expect(
    structured(await callRuntimeTool(ctx, 'rh_work', { operation: 'project_get', project_id: 'tree-api' })).data.project
      .rootRequirementId,
  ).toBe('REQ-TREE-ROOT');
  expect(
    structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_create',
        project_id: 'tree-api',
        requirement_id: 'REQ-TREE-SECOND-ROOT',
        requirement_title: 'Second root',
        requirement_outcome: 'Must be rejected.',
        requirement_is_project_root: true,
      }),
    ).status,
  ).toBe('blocked');
  const properties = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work')?.inputSchema
    .properties as Record<string, any>;
  expect(properties.requirement_parent_id).toMatchObject({ type: 'string' });
  expect(properties.requirement_is_project_root).toMatchObject({ type: 'boolean' });
});

describe('Requirement assignment triage', () => {
  test('find unassigned tasks, assign one with CAS and read back the updated queue', async () => {
    const home = tempRoot('forge-assignment-triage-');
    ensureControllerHome(home);
    const ctx = mcpContext(home);
    expect(
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          operation: 'project_create',
          project_id: 'triage-project',
          project_display_name: 'Triage',
        }),
      ).status,
    ).toBe('ok');
    for (const [id, assignee] of [
      ['REQ-NEEDS-OWNER', undefined],
      ['REQ-HAS-OWNER', 'alice'],
    ] as const) {
      const created = structured(
        await callRuntimeTool(ctx, 'rh_work', {
          operation: 'requirement_create',
          project_id: 'triage-project',
          requirement_id: id,
          requirement_title: id,
          requirement_outcome: 'Deliver ' + id,
          ...(assignee ? { requirement_assignee: assignee } : {}),
        }),
      );
      expect(created.status).toBe('ok');
    }
    const queue = async (filter: string, more: Record<string, unknown> = {}) =>
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          operation: 'requirement_list',
          project_id: 'triage-project',
          assignment_filter: filter,
          ...more,
        }),
      );
    const unassigned = await queue('unassigned');
    expect(unassigned.data).toMatchObject({ totalCount: 1, filters: { assignment: 'unassigned' } });
    expect(unassigned.data.requirements.map((task: { requirementId: string }) => task.requirementId)).toEqual([
      'REQ-NEEDS-OWNER',
    ]);
    expect((await queue('assigned')).data.totalCount).toBe(1);
    const assigneeOrder = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'triage-project',
        sort_by: 'assignee',
        sort_order: 'asc',
        limit: 10,
      }),
    );
    expect(assigneeOrder.data.requirements.map((task: { assignee?: string }) => task.assignee ?? '')).toEqual([
      '',
      'alice',
    ]);

    const conflict = await queue('unassigned', { requirement_assignee: 'alice' });
    expect(conflict.status).toBe('blocked');
    const revised = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_revise',
        project_id: 'triage-project',
        requirement_id: 'REQ-NEEDS-OWNER',
        expected_revision: 1,
        requirement_assignee: 'bob',
      }),
    );
    expect(revised.status).toBe('ok');
    expect((await queue('unassigned')).data).toMatchObject({ totalCount: 0, requirements: [] });
    expect((await queue('assigned')).data.totalCount).toBe(2);
    const selected = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_get',
        project_id: 'triage-project',
        requirement_id: 'REQ-NEEDS-OWNER',
        detail_level: 'detail',
      }),
    );
    expect(selected.data.requirement).toMatchObject({ assignee: 'bob', revision: 2 });
  });
});

describe('rh_work Requirement bootstrap', () => {
  test('lists canonical Requirements without requiring Work or Plan authority', async () => {
    const repoRoot = tempRoot('forge-requirement-list-repo-');
    const controllerHome = tempRoot('forge-requirement-list-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Requirement list fixture' });
    const ctx = mcpContext(controllerHome, repository);

    for (const [id, title] of [
      ['REQ-LIST-A', 'List A'],
      ['REQ-LIST-B', 'List B'],
    ] as const) {
      const created = structured(
        await callRuntimeTool(ctx, 'rh_work', {
          operation: 'requirement_create',
          requirement_id: id,
          requirement_title: title,
          requirement_outcome: `Deliver ${title}.`,
        }),
      );
      expect(created.status).toBe('ok');
    }
    const listed = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_list',
        limit: 100,
      }),
    );
    expect(listed.status).toBe('ok');
    expect(listed.data).toMatchObject({ bounded: true, limit: 100, authority: 'semantic_context_only' });
    expect(listed.data.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirementId: 'REQ-LIST-A',
          revision: 1,
          title: 'List A',
          state: 'open',
          repoId: repository.repoId,
        }),
        expect.objectContaining({
          requirementId: 'REQ-LIST-B',
          revision: 1,
          title: 'List B',
          state: 'open',
          repoId: repository.repoId,
        }),
      ]),
    );
    expect(listed.data.requirements.some((entry: Record<string, unknown>) => 'workId' in entry)).toBe(false);
  });

  test('scopes Requirement discovery to repository placement and explicit Plan relationships', async () => {
    const repoRootA = tempRoot('forge-requirement-scope-a-');
    const repoRootB = tempRoot('forge-requirement-scope-b-');
    const controllerHome = tempRoot('forge-requirement-scope-home-');
    initRepo(repoRootA);
    initRepo(repoRootB);
    ensureControllerHome(controllerHome);
    const repositoryA = registerRepository({ path: repoRootA, controllerHome, displayName: 'Requirement scope A' });
    const repositoryB = registerRepository({ path: repoRootB, controllerHome, displayName: 'Requirement scope B' });
    const ctxA = mcpContext(controllerHome, repositoryA);
    const ctxB = mcpContext(controllerHome, repositoryB);

    for (const [ctx, id, title] of [
      [ctxA, 'REQ-SCOPE-A', 'Scope A'],
      [ctxB, 'REQ-SCOPE-B', 'Scope B'],
    ] as const) {
      const created = structured(
        await callRuntimeTool(ctx, 'rh_work', {
          operation: 'requirement_create',
          requirement_id: id,
          requirement_title: title,
          requirement_outcome: `Deliver ${title}.`,
        }),
      );
      expect(created.status).toBe('ok');
    }

    const listedA = structured(await callRuntimeTool(ctxA, 'rh_work', { operation: 'requirement_list', limit: 100 }));
    const listedB = structured(await callRuntimeTool(ctxB, 'rh_work', { operation: 'requirement_list', limit: 100 }));
    expect(listedA.data.requirements.map((entry: Record<string, unknown>) => entry.requirementId)).toContain(
      'REQ-SCOPE-A',
    );
    expect(listedA.data.requirements.map((entry: Record<string, unknown>) => entry.requirementId)).not.toContain(
      'REQ-SCOPE-B',
    );
    expect(listedB.data.requirements.map((entry: Record<string, unknown>) => entry.requirementId)).toContain(
      'REQ-SCOPE-B',
    );
    expect(listedB.data.requirements.map((entry: Record<string, unknown>) => entry.requirementId)).not.toContain(
      'REQ-SCOPE-A',
    );

    const crossRepositoryGet = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_get',
        requirement_id: 'REQ-SCOPE-B',
      }),
    );
    expect(crossRepositoryGet.status).toBe('not_found');
    expect(crossRepositoryGet.data).toMatchObject({
      requirementId: 'REQ-SCOPE-B',
      repoId: repositoryA.repoId,
    });

    // A legacy Plan edge cannot override a Requirement's explicit other-repository owner.
    createPlanSemanticContext(
      { controllerHome, repoId: repositoryA.repoId },
      {
        planId: 'PLAN-FOREIGN-REPO-EDGE',
        repoId: repositoryA.repoId,
        requirementId: 'REQ-SCOPE-B',
        scopeKey: 'foreign-repo-edge',
        sourceBasisRevision: 'foreign-repo',
        goal: 'Do not display or open another repository task through a Plan edge.',
        items: [],
      },
    );
    const foreignLinkedList = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_list',
        limit: 100,
      }),
    );
    expect(
      foreignLinkedList.data.requirements.map((entry: Record<string, unknown>) => entry.requirementId),
    ).not.toContain('REQ-SCOPE-B');
    const foreignLinkedGet = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_get',
        requirement_id: 'REQ-SCOPE-B',
      }),
    );
    expect(foreignLinkedGet.status).toBe('not_found');

    const legacy = createRequirement(
      { controllerHome },
      {
        requirementId: 'REQ-LEGACY-PLAN-EDGE',
        title: 'Legacy edge',
        outcomeStatement: 'Remain visible only where an explicit Plan relationship exists.',
      },
    );
    expect(legacy.repoId).toBeUndefined();
    createPlanSemanticContext(
      {
        controllerHome,
        repoId: repositoryA.repoId,
        now: () => '2026-01-01T00:00:00.000Z',
      },
      {
        planId: 'PLAN-LEGACY-EDGE',
        repoId: repositoryA.repoId,
        requirementId: legacy.requirementId,
        scopeKey: 'legacy-edge',
        sourceBasisRevision: 'legacy-source',
        goal: 'Prove repository relevance through the durable Plan edge.',
        items: [],
      },
    );
    for (let index = 0; index < 100; index++) {
      createPlanSemanticContext(
        {
          controllerHome,
          repoId: repositoryA.repoId,
          now: () => '2026-02-01T00:00:00.000Z',
        },
        {
          planId: `PLAN-SCOPE-FILLER-${index}`,
          repoId: repositoryA.repoId,
          scopeKey: `scope-filler-${index}`,
          sourceBasisRevision: `source-filler-${index}`,
          goal: `Keep legacy placement discovery complete beyond the public Plan list cap (${index}).`,
          items: [],
        },
      );
    }
    const legacyA = structured(await callRuntimeTool(ctxA, 'rh_work', { operation: 'requirement_list', limit: 100 }));
    const legacyB = structured(await callRuntimeTool(ctxB, 'rh_work', { operation: 'requirement_list', limit: 100 }));
    expect(legacyA.data.requirements.map((entry: Record<string, unknown>) => entry.requirementId)).toContain(
      legacy.requirementId,
    );
    expect(legacyB.data.requirements.map((entry: Record<string, unknown>) => entry.requirementId)).not.toContain(
      legacy.requirementId,
    );
  });

  test('lists canonical Project tasks with filters, deterministic sorting and bounded pagination across repository and standalone Projects', async () => {
    const repoRootA = tempRoot('forge-requirement-project-list-a-');
    const repoRootB = tempRoot('forge-requirement-project-list-b-');
    const controllerHome = tempRoot('forge-requirement-project-list-home-');
    initRepo(repoRootA);
    initRepo(repoRootB);
    ensureControllerHome(controllerHome);
    const repositoryA = registerRepository({ path: repoRootA, controllerHome, displayName: 'Project list A' });
    const repositoryB = registerRepository({ path: repoRootB, controllerHome, displayName: 'Project list B' });
    const ctxA = mcpContext(controllerHome, repositoryA);
    const ctxB = mcpContext(controllerHome, repositoryB);
    const globalContext = mcpContext(controllerHome);

    for (const [ctx, projectId, name] of [
      [ctxA, 'project-filter-a', 'Project Filter A'],
      [ctxB, 'project-filter-b', 'Project Filter B'],
    ] as const) {
      const project = structured(
        await callRuntimeTool(ctx, 'rh_work', {
          operation: 'project_create',
          project_id: projectId,
          project_display_name: name,
        }),
      );
      expect(project.status).toBe('ok');
    }
    const standaloneProject = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'project_create',
        project_id: 'project-filter-standalone',
        project_display_name: 'Standalone Filter Project',
      }),
    );
    expect(standaloneProject.status).toBe('ok');

    const createTask = async (
      ctx: MultiRepositoryMcpToolContext,
      requirementId: string,
      title: string,
      status: string,
      priority: string,
      assignee: string,
      projectId?: string,
    ) =>
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          operation: 'requirement_create',
          requirement_id: requirementId,
          requirement_title: title,
          requirement_outcome: `Deliver ${title}.`,
          ...(projectId ? { project_id: projectId } : {}),
          requirement_status: status,
          requirement_priority: priority,
          requirement_assignee: assignee,
        }),
      );

    for (const [requirementId, title, status, priority, assignee] of [
      ['REQ-FILTER-A-URGENT', 'Urgent task', 'active', 'urgent', 'greyson'],
      ['REQ-FILTER-A-NORMAL', 'Normal task', 'active', 'normal', 'greyson'],
      ['REQ-FILTER-A-LOW', 'Low task', 'waiting_for_user', 'low', 'alice'],
    ] as const) {
      expect((await createTask(ctxA, requirementId, title, status, priority, assignee)).status).toBe('ok');
    }
    expect(
      (await createTask(ctxB, 'REQ-FILTER-B-HIGH', 'Other project task', 'active', 'high', 'greyson')).status,
    ).toBe('ok');
    expect(
      (
        await createTask(
          globalContext,
          'REQ-FILTER-STANDALONE',
          'Standalone task',
          'active',
          'urgent',
          'greyson',
          'project-filter-standalone',
        )
      ).status,
    ).toBe('ok');

    createPlanSemanticContext(
      {
        controllerHome,
        repoId: repositoryA.repoId,
        now: () => '2026-11-16T00:00:00.000Z',
      },
      {
        planId: 'PLAN-CROSS-PROJECT-LIST',
        repoId: repositoryA.repoId,
        requirementId: 'REQ-FILTER-STANDALONE',
        scopeKey: 'cross-project-list',
        sourceBasisRevision: 'source-cross-project-list',
        goal: 'A Plan relationship must not leak another Project task into this Project list.',
        items: [],
      },
    );
    const repositoryOnlyList = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_list',
        limit: 100,
      }),
    );
    expect(
      repositoryOnlyList.data.requirements.map((entry: { requirementId: string }) => entry.requirementId),
    ).not.toContain('REQ-FILTER-STANDALONE');
    const foreignProjectGet = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_get',
        requirement_id: 'REQ-FILTER-STANDALONE',
      }),
    );
    expect(foreignProjectGet.status).toBe('not_found');

    const schema = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work')?.inputSchema;
    const properties = schema?.properties as Record<string, any>;
    expect(properties.project_id.description).toContain('requirement_list');
    expect(properties.requirement_status.description).toContain('requirement_list');
    expect(properties.requirement_priority.description).toContain('requirement_list');
    expect(properties.requirement_assignee.description).toContain('requirement_list');
    expect(properties.sort_by).toMatchObject({
      type: 'string',
      enum: ['updated_at', 'created_at', 'priority', 'status', 'title', 'assignee'],
    });
    expect(properties.sort_order).toMatchObject({ type: 'string', enum: ['asc', 'desc'] });
    expect(properties.offset).toMatchObject({ type: 'number', minimum: 0 });
    expect(properties.search_query).toMatchObject({ type: 'string', maxLength: 256 });
    expect(properties.operation.enum).toContain('requirement_get');
    expect(properties.operation.enum).toContain('requirement_revise');

    const projectList = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        limit: 2,
        sort_by: 'priority',
        sort_order: 'desc',
      }),
    );
    expect(projectList.status).toBe('ok');
    expect(projectList.data).toMatchObject({
      totalCount: 3,
      offset: 0,
      hasMore: true,
      requirementsTruncated: true,
      sortBy: 'priority',
      sortOrder: 'desc',
    });
    expect(projectList.data.requirements).toMatchObject([
      { requirementId: 'REQ-FILTER-A-URGENT', projectId: 'project-filter-a', priority: 'urgent' },
      { requirementId: 'REQ-FILTER-A-NORMAL', projectId: 'project-filter-a', priority: 'normal' },
    ]);
    const nextRequirementPage = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        limit: 2,
        offset: 2,
        sort_by: 'priority',
        sort_order: 'desc',
      }),
    );
    expect(nextRequirementPage.data).toMatchObject({
      totalCount: 3,
      offset: 2,
      hasMore: false,
      requirementsTruncated: false,
    });
    expect(nextRequirementPage.data.requirements.map((task: { requirementId: string }) => task.requirementId)).toEqual([
      'REQ-FILTER-A-LOW',
    ]);
    const beyondRequirementPage = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        limit: 2,
        offset: 10,
        sort_by: 'priority',
        sort_order: 'desc',
      }),
    );
    expect(beyondRequirementPage.data).toMatchObject({
      totalCount: 3,
      offset: 10,
      hasMore: false,
      requirementsTruncated: false,
    });
    expect(beyondRequirementPage.data.requirements).toEqual([]);

    const repositoryProjectList = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        sort_by: 'priority',
        sort_order: 'desc',
        limit: 100,
      }),
    );
    expect(repositoryProjectList.data.totalCount).toBe(3);
    expect(
      repositoryProjectList.data.requirements.map((task: { requirementId: string }) => task.requirementId),
    ).not.toContain('REQ-FILTER-STANDALONE');

    const filtered = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        requirement_status: 'active',
        requirement_assignee: 'greyson',
        sort_by: 'title',
        sort_order: 'asc',
        limit: 100,
      }),
    );
    expect(filtered.data).toMatchObject({
      totalCount: 2,
      hasMore: false,
      sortBy: 'title',
      sortOrder: 'asc',
      filters: { projectId: 'project-filter-a', status: 'active', assignee: 'greyson' },
    });
    expect(filtered.data.requirements.map((task: { requirementId: string }) => task.requirementId)).toEqual([
      'REQ-FILTER-A-NORMAL',
      'REQ-FILTER-A-URGENT',
    ]);

    const searchedRequirements = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        search_query: 'URGENT TASK',
        limit: 20,
      }),
    );
    expect(searchedRequirements.data).toMatchObject({
      totalCount: 1,
      filters: { projectId: 'project-filter-a', searchQuery: 'URGENT TASK' },
    });
    expect(searchedRequirements.data.requirements.map((task: { requirementId: string }) => task.requirementId)).toEqual(
      ['REQ-FILTER-A-URGENT'],
    );
    const priorityFiltered = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        requirement_status: 'active',
        requirement_priority: 'urgent',
        requirement_assignee: 'greyson',
      }),
    );
    expect(priorityFiltered.data.requirements.map((task: { requirementId: string }) => task.requirementId)).toEqual([
      'REQ-FILTER-A-URGENT',
    ]);

    const standalone = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-standalone',
      }),
    );
    expect(standalone.data.requirements).toMatchObject([
      { requirementId: 'REQ-FILTER-STANDALONE', projectId: 'project-filter-standalone' },
    ]);

    const repositoryProjectMismatch = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-b',
      }),
    );
    expect(repositoryProjectMismatch.status).toBe('blocked');
    expect(repositoryProjectMismatch.summary).toContain('REQUIREMENT_PROJECT_SCOPE_CONFLICT');

    const invalidSort = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_list',
        project_id: 'project-filter-a',
        sort_by: 'unsupported',
      }),
    );
    expect(invalidSort.status).toBe('blocked');
    expect(invalidSort.summary).toContain('REQUIREMENT_SORT_INVALID');

    // The Project board must not read or edit another Project's task by a stale task ID.
    const foreignProjectRead = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_get',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-B-HIGH',
      }),
    );
    expect(foreignProjectRead.status).toBe('not_found');
    const foreignProjectWrite = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_revise',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-B-HIGH',
        expected_revision: 1,
        requirement_assignee: 'wrong-project-owner',
      }),
    );
    expect(foreignProjectWrite.status).toBe('blocked');
    expect(foreignProjectWrite.data.currentRequirement).toBeUndefined();
    const foreignAfter = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_get',
        project_id: 'project-filter-b',
        requirement_id: 'REQ-FILTER-B-HIGH',
      }),
    );
    expect(foreignAfter.data.requirement).toMatchObject({ revision: 1, assignee: 'greyson' });

    const wrongStandaloneRead = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_get',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-STANDALONE',
      }),
    );
    expect(wrongStandaloneRead.status).toBe('not_found');
    const wrongStandaloneWrite = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_revise',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-STANDALONE',
        expected_revision: 1,
        requirement_assignee: 'wrong-project-owner',
      }),
    );
    expect(wrongStandaloneWrite.status).toBe('blocked');

    const repoWrongProjectRead = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_get',
        project_id: 'project-filter-b',
        requirement_id: 'REQ-FILTER-A-NORMAL',
      }),
    );
    expect(repoWrongProjectRead.status).toBe('blocked');
    expect(repoWrongProjectRead.summary).toContain('REQUIREMENT_PROJECT_SCOPE_CONFLICT');
    const repoWrongProjectWrite = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_revise',
        project_id: 'project-filter-b',
        requirement_id: 'REQ-FILTER-A-NORMAL',
        expected_revision: 1,
        requirement_priority: 'low',
      }),
    );
    expect(repoWrongProjectWrite.status).toBe('blocked');
    expect(repoWrongProjectWrite.summary).toContain('REQUIREMENT_PROJECT_SCOPE_CONFLICT');

    const rightProjectWrite = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_revise',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-A-NORMAL',
        expected_revision: 1,
        requirement_assignee: 'project-editor',
      }),
    );
    expect(rightProjectWrite.status).toBe('ok');
    expect(rightProjectWrite.data.requirement).toMatchObject({
      requirementId: 'REQ-FILTER-A-NORMAL',
      projectId: 'project-filter-a',
      revision: 2,
      assignee: 'project-editor',
    });
    const rightProjectRead = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_get',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-A-NORMAL',
        detail_level: 'detail',
      }),
    );
    expect(rightProjectRead.data.requirement).toMatchObject({ revision: 2, assignee: 'project-editor' });
    expect(rightProjectRead.data.revisionHistory).toMatchObject([{ revision: 1, assignee: 'greyson' }]);
    const rightRepositoryRead = structured(
      await callRuntimeTool(ctxA, 'rh_work', {
        operation: 'requirement_get',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-A-NORMAL',
      }),
    );
    expect(rightRepositoryRead.status).toBe('ok');
    expect(rightRepositoryRead.data.requirement).toMatchObject({ revision: 2, assignee: 'project-editor' });
    const staleProjectWrite = structured(
      await callRuntimeTool(globalContext, 'rh_work', {
        operation: 'requirement_revise',
        project_id: 'project-filter-a',
        requirement_id: 'REQ-FILTER-A-NORMAL',
        expected_revision: 1,
        requirement_assignee: 'stale-owner',
      }),
    );
    expect(staleProjectWrite.status).toBe('blocked');
    expect(staleProjectWrite.summary).toContain('REQUIREMENT_REVISION_CONFLICT');
  });

  test('exposes typed Requirement progress and CAS through rh_work without a Work or legacy carrier', async () => {
    const schema = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work')?.inputSchema;
    expect(schema).toBeDefined();
    const properties = schema?.properties as Record<string, unknown>;
    expect(properties.requirement_title).toMatchObject({ type: 'string' });
    expect((properties.requirement_title as { description: string }).description).toContain('requirement_revise');
    expect((properties.requirement_outcome as { description: string }).description).toContain('requirement_revise');
    expect(properties.requirement_acceptance_criteria).toMatchObject({ type: 'array', maxItems: 50 });
    expect((properties.requirement_acceptance_criteria as { description: string }).description).toContain(
      'requirement_revise',
    );
    expect(properties.requirement_progress_summary).toMatchObject({ type: 'string', maxLength: 2_000 });
    expect(properties.requirement_remaining_work).toMatchObject({
      type: 'array',
      maxItems: 50,
      items: { type: 'string', maxLength: 500 },
    });
    expect(properties.requirement_accepted_evidence_refs).toMatchObject({
      type: 'array',
      maxItems: 100,
      items: { type: 'string', maxLength: 512 },
    });
    expect(properties.requirement_priority).toMatchObject({
      type: 'string',
      enum: ['low', 'normal', 'high', 'urgent'],
    });
    expect(properties.requirement_assignee).toMatchObject({ type: 'string', maxLength: 160 });
    expect(properties.requirement_status).toMatchObject({
      type: 'string',
      enum: ['planned', 'active', 'waiting_for_user', 'done', 'cancelled'],
    });
    expect(properties.expected_requirement_revision).toMatchObject({ type: 'number', minimum: 1 });

    const repoRoot = tempRoot('forge-typed-requirement-progress-repo-');
    const controllerHome = tempRoot('forge-typed-requirement-progress-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({
      path: repoRoot,
      controllerHome,
      displayName: 'Typed Requirement progress fixture',
    });
    const ctx = mcpContext(controllerHome, repository);

    const created = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_create',
        requirement_id: 'REQ-TYPED-PROGRESS',
        requirement_title: 'Typed progress',
        requirement_outcome: 'Deliver an independently verified change.',
        requirement_status: 'active',
        requirement_priority: 'high',
        requirement_assignee: 'greyson',
      }),
    );
    expect(created.status).toBe('ok');
    expect(created.data.requirement).toMatchObject({ status: 'active', priority: 'high', assignee: 'greyson' });

    const reused = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_create',
        requirement_id: 'REQ-TYPED-PROGRESS',
        requirement_title: 'Typed progress',
        requirement_outcome: 'Deliver an independently verified change.',
        requirement_status: 'waiting_for_user',
        requirement_priority: 'urgent',
        requirement_assignee: 'agent:codex',
      }),
    );
    expect(reused.status).toBe('ok');
    expect(reused.data.admissionDecision).toBe('reuse_existing');
    expect(reused.data.requirement).toMatchObject({ status: 'active', priority: 'high', assignee: 'greyson' });

    const updated = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-TYPED-PROGRESS',
        expected_revision: 1,
        requirement_title: 'Typed progress with revisable core',
        requirement_outcome: 'Replace the initial goal without creating a second Requirement.',
        requirement_acceptance_criteria: ['Revised outcome is the current authority.'],
        requirement_progress_summary: 'Source patch submitted; review pending.',
        requirement_remaining_work: ['Review exact HEAD', 'Verify deployed Runtime'],
        requirement_accepted_evidence_refs: ['https://github.com/example/forge/pull/123'],
        requirement_status: 'waiting_for_user',
        requirement_priority: 'urgent',
        requirement_assignee: 'agent:codex',
      }),
    );
    expect(updated.status).toBe('ok');
    expect(updated.data.requirement).toMatchObject({
      revision: 2,
      title: 'Typed progress with revisable core',
      outcomeStatement: 'Replace the initial goal without creating a second Requirement.',
      acceptanceCriteria: ['Revised outcome is the current authority.'],
      progressSummary: 'Source patch submitted; review pending.',
      remainingWork: ['Review exact HEAD', 'Verify deployed Runtime'],
      acceptedEvidenceRefs: ['https://github.com/example/forge/pull/123'],
      state: 'open',
      status: 'waiting_for_user',
      priority: 'urgent',
      assignee: 'agent:codex',
    });

    const stale = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_revise',
        requirement_id: 'REQ-TYPED-PROGRESS',
        expected_revision: 1,
        requirement_outcome: 'Stale goal must not overwrite the revised objective.',
        requirement_progress_summary: 'Stale write must fail.',
      }),
    );
    expect(stale.status).toBe('blocked');
    expect(stale.data.currentRequirement.progressSummary).toBe('Source patch submitted; review pending.');
    expect(stale.data.currentRequirement.outcomeStatement).toBe(
      'Replace the initial goal without creating a second Requirement.',
    );

    const reread = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'requirement_get',
        requirement_id: 'REQ-TYPED-PROGRESS',
        detail_level: 'detail',
      }),
    );
    expect(reread.data.progress).toEqual({
      source: 'requirement',
      summary: 'Source patch submitted; review pending.',
      remainingWork: ['Review exact HEAD', 'Verify deployed Runtime'],
      acceptedEvidenceRefs: ['https://github.com/example/forge/pull/123'],
    });
    expect(reread.data.requirement).toMatchObject({
      status: 'waiting_for_user',
      priority: 'urgent',
      assignee: 'agent:codex',
    });
    expect(reread.data.revisionHistory).toMatchObject([
      { revision: 1, status: 'active', priority: 'high', assignee: 'greyson' },
    ]);
  });

  test('plan_list returns compact discovery rows and leaves detailed semantic content to plan_get (#478)', async () => {
    const repoRoot = tempRoot('forge-rh-work-plan-list-repo-');
    const controllerHome = tempRoot('forge-rh-work-plan-list-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({
      path: repoRoot,
      controllerHome,
      displayName: 'Plan list transport fixture',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const detail = 'semantic-detail-'.padEnd(500, 'x');

    createPlanSemanticContext(store, {
      planId: 'PLAN-LIST-DETAIL',
      repoId: repository.repoId,
      scopeKey: 'plan-list-detail',
      sourceBasisRevision: 'source-plan-list',
      goal: 'Keep plan discovery compact while preserving explicit detail retrieval. '.repeat(8),
      nonGoals: Array.from({ length: 20 }, (_, index) => `non-goal-${index}-${detail}`),
      assumptions: Array.from({ length: 30 }, (_, index) => `assumption-${index}-${detail}`),
      resolvedDecisions: Array.from({ length: 30 }, (_, index) => `decision-${index}-${detail}`),
      stopConditions: Array.from({ length: 20 }, (_, index) => `stop-${index}-${detail}`),
      replanConditions: Array.from({ length: 20 }, (_, index) => `replan-${index}-${detail}`),
      integrationStrategy: detail,
      items: Array.from({ length: 60 }, (_, index) => ({
        id: `item-${index}`,
        objective: `objective-${index}-${detail}`,
        dependencies: index > 0 ? [`item-${index - 1}`] : [],
      })),
    });

    const listed = structured(
      await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
        operation: 'plan_list',
        repo_id: repository.repoId,
        limit: 20,
      }),
    );
    expect(listed.status).toBe('ok');
    expect(listed.data.plans).toHaveLength(1);
    expect(listed.data.plans[0]).toMatchObject({
      planId: 'PLAN-LIST-DETAIL',
      revision: 1,
      sourceBasisRevision: 'source-plan-list',
      itemCount: 60,
    });
    expect(listed.data.plans[0].goal.length).toBeLessThanOrEqual(240);
    expect(listed.data.plans[0].assumptions).toBeUndefined();
    expect(listed.data.plans[0].resolvedDecisions).toBeUndefined();
    expect(listed.data.plans[0].items).toBeUndefined();
    expect(JSON.stringify(listed).length).toBeLessThan(5_000);

    const detailed = structured(
      await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
        operation: 'plan_get',
        repo_id: repository.repoId,
        plan_id: 'PLAN-LIST-DETAIL',
        detail_level: 'detail',
      }),
    );
    expect(detailed.data.plan.assumptions).toHaveLength(30);
    expect(detailed.data.plan.resolvedDecisions).toHaveLength(30);
    // Explicit detail retrieval preserves the complete semantic Plan; only discovery rows are compact.
    expect(detailed.data.plan.items).toHaveLength(60);
    expect(detailed.data.plan.items[59]).toMatchObject({
      id: 'item-59',
      objective: `objective-59-${detail}`,
      dependencies: ['item-58'],
    });
  });

  test('retired historical Work operations are not accepted by rh_work', async () => {
    const repoRoot = tempRoot('forge-work-retirement-api-repo-');
    const controllerHome = tempRoot('forge-work-retirement-api-home-');
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'retirement-api' });
    for (const operation of ['get_contract', 'get', 'list']) {
      const response = structured(
        await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_work', {
          operation,
          repo_id: repository.repoId,
          work_id: 'retired-work',
        }),
      );
      expect(response.data).not.toHaveProperty('workContract');
      expect(response.data).not.toHaveProperty('work');
      expect(response.status).not.toBe('ok');
    }
  });

  test('explicitly promotes one Workspace Cognitive requirement candidate into exactly one canonical Requirement', async () => {
    const repoRoot = tempRoot('forge-requirement-candidate-repo-');
    const controllerHome = tempRoot('forge-requirement-candidate-home-');
    initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({
      path: repoRoot,
      controllerHome,
      displayName: 'Requirement candidate fixture',
    });
    const instance = ensureForgeInstanceIdentity({ controllerHome });
    const workspaceId = 'workspace-requirement-candidate';
    const projectId = 'project-requirement-candidate';
    writeWorkspaceIdentity({
      controllerHome,
      value: { workspaceId, title: 'Requirement Candidate Workspace' },
    });
    writeProjectIdentity({
      controllerHome,
      value: { projectId, workspaceId, displayName: 'Requirement Candidate Project' },
    });
    writeProjectPlacement({
      controllerHome,
      value: {
        projectId,
        forgeInstanceId: instance.instanceId,
        repositoryId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
      },
    });

    const scope = { schemaVersion: 1 as const, kind: 'workspace' as const, id: workspaceId };
    const store = cognitionMemoryStore(controllerHome);
    const authority: CognitiveWriteAuthorityPort = {
      assertMemoryWrite: () => undefined,
      assertEdgeWrite: () => undefined,
      evidenceAvailable: () => true,
    };
    const observedAt = '2026-09-20T09:00:00.000Z';
    recordCognitiveMemory(store, authority, {
      id: 'promoted:requirement-candidate-source',
      scope,
      facets: ['knowledge', 'pattern', 'engineering-principle', 'cross-project', 'repeated_root_cause'],
      canonicalText: 'Repeated root cause shows a systemic architecture defect.',
      concepts: ['forge.execution-quality.repeated_root_cause'],
      provenance: {
        sourceKind: 'system',
        sourceId: 'project-learning-promotion:project-source:consolidated-source',
        recordedAt: observedAt,
        evidenceRefs: ['receipt-root-cause-1', 'receipt-root-cause-2', 'receipt-root-cause-3'],
      },
      confidence: 0.95,
      utility: 0.9,
      tier: 'warm',
      validFrom: observedAt,
      counterEvidenceRefs: [],
    });
    recordCognitiveMemory(store, authority, {
      id: 'candidate:requirement-candidate-source',
      scope,
      facets: [
        'candidate-finding',
        'requirement-candidate',
        'advisory',
        'engineering-improvement',
        'repeated_root_cause',
      ],
      canonicalText: 'Candidate finding for normal Requirement promotion only.',
      concepts: [
        'forge.requirement-candidate',
        'forge.engineering-improvement',
        'forge.execution-quality.repeated_root_cause',
      ],
      provenance: {
        sourceKind: 'system',
        sourceId: 'cognitive-requirement-candidate:promoted:requirement-candidate-source',
        recordedAt: observedAt,
        evidenceRefs: ['receipt-root-cause-1', 'receipt-root-cause-2', 'receipt-root-cause-3'],
      },
      confidence: 0.95,
      utility: 0.9,
      tier: 'warm',
      validFrom: observedAt,
      counterEvidenceRefs: [],
    });

    const ctx = mcpContext(controllerHome, repository);
    const promoted = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'requirement_promote_candidate',
        requirement_candidate_id: 'candidate:requirement-candidate-source',
        requirement_id: 'REQ-COGNITIVE-CANDIDATE',
        requirement_title: 'Resolve repeated systemic root cause',
        requirement_outcome: 'Replace the repeated root cause with one coherent architecture correction.',
        requirement_acceptance_criteria: [
          'The root cause is corrected through normal Requirement/Plan/Work authority.',
        ],
      }),
    );
    expect(promoted.status).toBe('ok');
    expect(promoted.data.requirementCreated).toBe(true);
    expect(promoted.data.admissionDecision).toBe('created');
    expect(promoted.data.requirementCandidatePromoted).toBe(true);
    expect(promoted.data.requirement).not.toHaveProperty('auditRefs');
    expect(readRequirement({ controllerHome }, 'REQ-COGNITIVE-CANDIDATE')?.value.auditRefs).toContain(
      promoted.data.candidateAuditRef,
    );

    const duplicate = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'requirement_promote_candidate',
        requirement_candidate_id: 'candidate:requirement-candidate-source',
        requirement_id: 'REQ-COGNITIVE-CANDIDATE-DUPLICATE',
        requirement_title: 'Duplicate semantic branch must not be created',
        requirement_outcome: 'This should reuse the original candidate-bound Requirement.',
      }),
    );
    expect(duplicate.status).toBe('ok');
    expect(duplicate.data.requirementCreated).toBe(false);
    expect(duplicate.data.admissionDecision).toBe('candidate_already_promoted');
    expect(duplicate.data.requirement.requirementId).toBe('REQ-COGNITIVE-CANDIDATE');
    expect(readRequirement({ controllerHome }, 'REQ-COGNITIVE-CANDIDATE-DUPLICATE')).toBeUndefined();
  });

  test('lets an execution-baseline shift preserve Plan authority without replacing an unrelated active Plan', async () => {
    const repoRoot = tempRoot('forge-frozen-invalidated-plan-repo-');
    const controllerHome = tempRoot('forge-frozen-invalidated-plan-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({
      path: repoRoot,
      controllerHome,
      displayName: 'Frozen invalidated Plan fixture',
    });
    const ctx = mcpContext(controllerHome, repository);
    const requirementId = 'REQ-FROZEN-INVALIDATED-PLAN';
    const predecessorPlanId = 'PLAN-FROZEN-INVALIDATED-R1';
    const unrelatedPlanId = 'PLAN-FROZEN-POST-V2';
    const step = {
      id: 'stage-a',
      objective: 'Preserve exact successor lineage.',
      dependencies: [],
      authoritative_files: [],
      allowed_paths: ['src/**'],
      forbidden_paths: [],
      check_ids: ['package:check:type'],
      acceptance_criteria: ['lineage remains exact'],
    };

    expect(
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          repo_id: repository.repoId,
          operation: 'requirement_create',
          requirement_id: requirementId,
          requirement_title: 'Preserve Plan execution baseline',
          requirement_outcome: 'Keep execution-baseline changes separate from semantic Plan replanning.',
        }),
      ).status,
    ).toBe('ok');
    expect(
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          repo_id: repository.repoId,
          operation: 'plan_create',
          plan_id: predecessorPlanId,
          requirement_id: requirementId,
          scope_key: 'v2-release',
          source_revision: sourceRevision,
          objective: 'Predecessor Plan.',
          plan_steps: [step],
        }),
      ).status,
    ).toBe('ok');
    // The predecessor keeps its authored item state; no Work link, execution
    // baseline or approval-derived status is written.
    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, predecessorPlanId)).toMatchObject({
      planId: predecessorPlanId,
      revision: 1,
      status: 'draft',
      steps: [{ id: 'stage-a', status: 'pending' }],
    });

    expect(
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          repo_id: repository.repoId,
          operation: 'plan_create',
          plan_id: unrelatedPlanId,
          requirement_id: requirementId,
          scope_key: 'post-v2',
          source_revision: sourceRevision,
          objective: 'Unrelated post-V2 Plan.',
          plan_relation: 'parallel',
          plan_steps: [step],
        }),
      ).status,
    ).toBe('ok');

    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, predecessorPlanId)).toMatchObject({
      planId: predecessorPlanId,
      revision: 1,
      status: 'draft',
      steps: [{ id: 'stage-a', status: 'pending' }],
    });
    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, unrelatedPlanId)?.status).toBe('draft');
    expect(
      getPlanContract({ controllerHome, repoId: repository.repoId }, unrelatedPlanId)?.supersededBy,
    ).toBeUndefined();
  }, 15_000);

  test('creates Requirement authority idempotently without implying Plan and still permits explicit Plan creation', async () => {
    const repoRoot = tempRoot('forge-requirement-repo-');
    const controllerHome = tempRoot('forge-requirement-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Requirement fixture' });
    const ctx = mcpContext(controllerHome, repository);

    const requirementArgs = {
      repo_id: repository.repoId,
      operation: 'requirement_create',
      requirement_id: 'REQ-ANDROID-NATIVE-V1',
      requirement_title: 'Android native delivery',
      requirement_outcome: 'Deliver Android through contract-first native implementation.',
      requirement_acceptance_criteria: ['Foundation gates exist before production source.'],
    };

    const created = structured(await callRuntimeTool(ctx, 'rh_work', requirementArgs));
    expect(created.status).toBe('ok');
    expect(created.data.requirementCreated).toBe(true);
    expect(created.summary).toContain('does not imply a Plan');
    expect(created.suggestedNextActions ?? []).toEqual([]);
    expect(readRequirement({ controllerHome }, 'REQ-ANDROID-NATIVE-V1')?.value.title).toBe('Android native delivery');

    const retried = structured(await callRuntimeTool(ctx, 'rh_work', requirementArgs));
    expect(retried.status).toBe('ok');
    expect(retried.data.requirementCreated).toBe(false);
    expect(retried.data.admissionDecision).toBe('reuse_existing');
    expect(retried.summary).toContain('does not imply a Plan');
    expect(retried.suggestedNextActions ?? []).toEqual([]);

    const conflict = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        ...requirementArgs,
        requirement_outcome: 'Conflicting replacement outcome.',
      }),
    );
    expect(conflict.status).toBe('blocked');
    expect(conflict.summary).toContain('REQUIREMENT_ALREADY_EXISTS_CONFLICT');
    expect(readRequirement({ controllerHome }, 'REQ-ANDROID-NATIVE-V1')?.value.outcomeStatement).toBe(
      'Deliver Android through contract-first native implementation.',
    );

    const planned = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-ANDROID-NATIVE-V1',
        requirement_id: 'REQ-ANDROID-NATIVE-V1',
        scope_key: 'android-native-v1',
        source_revision: sourceRevision,
        objective: 'Bootstrap Android governance.',
        plan_steps: [
          {
            id: 'governance',
            objective: 'Create governance gates.',
            dependencies: [],
            authoritative_files: [],
            allowed_paths: ['android/**'],
            forbidden_paths: ['ios/**'],
            check_ids: [],
            acceptance_criteria: ['Governance is machine enforced.'],
          },
        ],
      }),
    );
    expect(planned.status).toBe('ok');
    expect(planned.data.planContractCreated).toBe(true);
  }, 15_000);

  test('current plan_create writes thin semantic Plan items without PlanStep authority or approval', async () => {
    const repoRoot = tempRoot('forge-thin-plan-create-repo-');
    const controllerHome = tempRoot('forge-thin-plan-create-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Thin Plan create fixture' });
    const ctx = mcpContext(controllerHome, repository);

    expect(
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          repo_id: repository.repoId,
          operation: 'requirement_create',
          requirement_id: 'REQ-THIN-PLAN-CREATE',
          requirement_title: 'Thin Plan creation',
          requirement_outcome: 'Plan remains model-authored working memory.',
        }),
      ).status,
    ).toBe('ok');

    const created = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-THIN-CREATE',
        requirement_id: 'REQ-THIN-PLAN-CREATE',
        scope_key: 'thin-plan-create',
        source_revision: sourceRevision,
        expected_requirement_revision: 1,
        objective: 'Record strategy without creating execution ownership.',
        plan_items: [
          { id: 'item-a', objective: 'Describe one useful slice.', dependencies: [] },
          { id: 'item-b', objective: 'Describe a dependent slice.', dependencies: ['item-a'] },
        ],
      }),
    );
    expect(created.status).toBe('ok');
    expect(created.summary).toContain('no approval, PlanStep, path/check, scheduling, Work, or acceptance authority');
    expect(created.data.plan).toMatchObject({
      planId: 'PLAN-THIN-CREATE',
      revision: 1,
      requirementBasisRevision: 1,
      items: [
        { id: 'item-a', objective: 'Describe one useful slice.', dependencies: [] },
        { id: 'item-b', objective: 'Describe a dependent slice.', dependencies: ['item-a'] },
      ],
    });
    const stored = getPlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-THIN-CREATE');
    expect(stored?.steps).toEqual([]);
    expect(stored?.semanticRevision).toBe(1);

    const child = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-THIN-CREATE-CHILD',
        requirement_id: 'REQ-THIN-PLAN-CREATE',
        parent_plan_id: 'PLAN-THIN-CREATE',
        scope_key: 'thin-plan-create-child',
        source_revision: sourceRevision,
        objective: 'Refine the root Plan without creating execution authority.',
        plan_items: [{ id: 'child-a', objective: 'Describe the child slice.', dependencies: [] }],
      }),
    );
    expect(child.status).toBe('ok');
    expect(child.data.plan).toMatchObject({
      planId: 'PLAN-THIN-CREATE-CHILD',
      requirementId: 'REQ-THIN-PLAN-CREATE',
      parentPlanId: 'PLAN-THIN-CREATE',
    });
    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-THIN-CREATE-CHILD')?.parentPlanId).toBe(
      'PLAN-THIN-CREATE',
    );

    const listed = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_list',
        limit: 20,
      }),
    );
    expect(listed.data.plans).toContainEqual(
      expect.objectContaining({
        planId: 'PLAN-THIN-CREATE-CHILD',
        parentPlanId: 'PLAN-THIN-CREATE',
      }),
    );

    expect(
      structured(
        await callRuntimeTool(ctx, 'rh_work', {
          repo_id: repository.repoId,
          operation: 'requirement_create',
          requirement_id: 'REQ-THIN-PLAN-OTHER',
          requirement_title: 'Other Requirement',
          requirement_outcome: 'Own an independent Plan tree.',
        }),
      ).status,
    ).toBe('ok');
    const wrongTree = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-THIN-CREATE-WRONG-PARENT',
        requirement_id: 'REQ-THIN-PLAN-OTHER',
        parent_plan_id: 'PLAN-THIN-CREATE',
        scope_key: 'thin-plan-wrong-parent',
        source_revision: sourceRevision,
        objective: 'Must not cross Requirement tree ownership.',
      }),
    );
    expect(wrongTree.status).toBe('blocked');
    expect(wrongTree.summary).toContain('PLAN_PARENT_REQUIREMENT_MISMATCH:PLAN-THIN-CREATE');

    const sameLabel = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-THIN-CREATE-PARALLEL',
        requirement_id: 'REQ-THIN-PLAN-CREATE',
        scope_key: 'thin-plan-create',
        source_revision: sourceRevision,
        objective: 'A second semantic Plan may share the same descriptive scope label.',
        plan_items: [{ id: 'item-c', objective: 'Remain independent working memory.', dependencies: [] }],
      }),
    );
    expect(sameLabel.status).toBe('blocked');
    expect(sameLabel.summary).toContain('PLAN_SEMANTIC_LINEAGE_ALREADY_EXISTS:thin-plan-create:PLAN-THIN-CREATE');
    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-THIN-CREATE-PARALLEL')).toBeUndefined();

    const revised = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'plan_revise',
        plan_id: 'PLAN-THIN-CREATE',
        expected_revision: 1,
        objective: 'Revise the same stable semantic Plan without repository selection.',
        plan_items: [{ id: 'item-r2', objective: 'Replace working-memory content in place.', dependencies: [] }],
      }),
    );
    expect(revised.status).toBe('ok');
    expect(revised.data.plan).toMatchObject({
      planId: 'PLAN-THIN-CREATE',
      revision: 2,
      goal: 'Revise the same stable semantic Plan without repository selection.',
    });

    const stale = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        operation: 'plan_revise',
        plan_id: 'PLAN-THIN-CREATE',
        expected_revision: 1,
        objective: 'A stale writer must not overwrite revision 2.',
      }),
    );
    expect(stale.status).toBe('blocked');
    expect(stale.data.currentPlan).toMatchObject({ planId: 'PLAN-THIN-CREATE', revision: 2 });

    const parentAdvanced = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'requirement_revise',
        requirement_id: 'REQ-THIN-PLAN-CREATE',
        expected_revision: 1,
        requirement_progress_summary: 'The parent Requirement advanced after proposal analysis.',
      }),
    );
    expect(parentAdvanced.status).toBe('ok');
    expect(parentAdvanced.data.requirement.revision).toBe(2);

    const staleParent = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-THIN-CREATE-STALE-PARENT',
        requirement_id: 'REQ-THIN-PLAN-CREATE',
        scope_key: 'thin-plan-stale-parent',
        expected_requirement_revision: 1,
        objective: 'This Plan must not be created against a stale Requirement revision.',
        plan_items: [],
      }),
    );
    expect(staleParent.status).toBe('blocked');
    expect(staleParent.summary).toContain(
      'PLAN_REQUIREMENT_REVISION_CONFLICT:REQ-THIN-PLAN-CREATE:expected=1:actual=2',
    );
    expect(
      getPlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-THIN-CREATE-STALE-PARENT'),
    ).toBeUndefined();
  }, 15_000);

  test('retires the Plan scope-replan writer without mutating the Work', async () => {
    const repoRoot = tempRoot('forge-active-plan-work-replan-repo-');
    const controllerHome = tempRoot('forge-active-plan-work-replan-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({
      path: repoRoot,
      controllerHome,
      displayName: 'Active Plan Work replan fixture',
    });
    const ctx = mcpContext(controllerHome, repository);
    const store = { controllerHome, repoId: repository.repoId };
    const planId = 'PLAN-ACTIVE-SCOPE-R1';

    const created = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: planId,
        scope_key: 'active-scope-replan',
        source_revision: sourceRevision,
        objective: 'Deliver one active scope-bound Work.',
        plan_steps: [
          {
            id: 'stage',
            objective: 'Deliver without replacing Work authority.',
            dependencies: [],
            authoritative_files: ['src/index.ts'],
            allowed_paths: ['src/**'],
            forbidden_paths: [],
            check_ids: ['package:check:type'],
            acceptance_criteria: ['The same Work remains authoritative.'],
          },
        ],
      }),
    );
    expect(created.status).toBe('ok');
    seedHistoricalWorkContract(store, {
      workId: 'work-active-scope',
      repoId: repository.repoId,
      planId,
      planStepId: 'stage',
      planSourceRevision: sourceRevision,
      objective: 'Deliver without replacing Work authority.',
      acceptanceCriteria: ['The same Work remains authoritative.'],
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: ['package:check:type'],
      constraints: {},
      requestedBy: 'chatgpt',
      dispatchState: 'running',
    });

    const workBeforeRepair = readHistoricalWorkContract(store, 'work-active-scope');

    // Plan-scoped repair is a read-only fact now: it neither replans the Plan nor
    // rewrites the Work, and it never decides replacement admission.
    const repaired = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'repair',
        plan_id: planId,
        plan_step_id: 'stage',
        superseded_by: 'PLAN-ACTIVE-SCOPE-R2',
        source_revision: sourceRevision,
        allowed_paths: ['src/runtime/context/**'],
        repair_operation: 'repair',
        dry_run: false,
        reason: 'Current-source evidence proved the active Plan omitted a path required by its own accepted scope.',
      }),
    );
    expect(repaired.status).toBe('ok');
    expect(repaired.summary).toContain('PLAN_STEP_AUTHORED_FACT');
    expect(repaired.data).toMatchObject({
      repaired: false,
      repairRequired: false,
      compatibilityNoop: true,
      planItemStatus: 'pending',
    });
    expect(getPlanContract(store, planId)).toMatchObject({ planId, revision: 1, status: 'draft' });
    expect(getPlanContract(store, planId)?.steps[0]).toMatchObject({ allowedPaths: ['src/**'] });
    expect(getPlanContract(store, planId)?.steps[0]?.workId).toBeUndefined();
    expect(getPlanContract(store, 'PLAN-ACTIVE-SCOPE-R2')).toBeUndefined();
    // Compare the canonical aggregate: retired top-level allowedPaths are not
    // a scope authority. The entire Work must remain unchanged by Plan repair.
    expect(readHistoricalWorkContract(store, 'work-active-scope')).toEqual(workBeforeRepair);

    expect(readHistoricalWorkContract(store, 'work-active-scope')?.planSourceRevision).toBe(sourceRevision);
  }, 15_000);

  test('repairs a malformed draft Plan in place through rh_work without creating a second authority', async () => {
    const repoRoot = tempRoot('forge-plan-repair-repo-');
    const controllerHome = tempRoot('forge-plan-repair-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Plan repair fixture' });
    const ctx = mcpContext(controllerHome, repository);

    const malformed = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-LEGACY-MALFORMED',
        scope_key: 'legacy-malformed-scope',
        source_revision: '',
        objective: '',
        plan_steps: [],
      }),
    );
    expect(malformed.status).toBe('ok');
    expect(malformed.data.planContractCreated).toBe(true);

    const repeatedCreate = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'plan_create',
        plan_id: 'PLAN-LEGACY-MALFORMED',
        scope_key: 'legacy-malformed-scope',
        source_revision: sourceRevision,
        objective: 'Restore the existing draft to a reviewable PlanContract.',
        plan_steps: [
          {
            id: 'repair',
            objective: 'Repair the draft authority in place.',
            dependencies: [],
            authoritative_files: ['src/index.ts'],
            allowed_paths: ['src/**'],
            forbidden_paths: [],
            check_ids: ['package:check:type'],
            acceptance_criteria: ['The same Plan can be approved.'],
          },
        ],
      }),
    );
    expect(repeatedCreate.status).toBe('ok');
    expect(repeatedCreate.data.planContractCreated).toBe(false);
    expect(repeatedCreate.data.repairRequired).toBe(true);
    expect(repeatedCreate.suggestedNextActions[0]).toMatchObject({
      operation: 'repair',
      payload: { plan_id: 'PLAN-LEGACY-MALFORMED', repair_operation: 'repair', dry_run: false },
    });

    const diagnosed = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'repair',
        plan_id: 'PLAN-LEGACY-MALFORMED',
        repair_operation: 'diagnose',
        dry_run: true,
      }),
    );
    expect(diagnosed.status).toBe('ok');
    expect(diagnosed.data.repairRequired).toBe(true);
    expect(diagnosed.data.plan.planId).toBe('PLAN-LEGACY-MALFORMED');

    const repaired = structured(
      await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'repair',
        plan_id: 'PLAN-LEGACY-MALFORMED',
        repair_operation: 'repair',
        dry_run: false,
        scope_key: 'legacy-malformed-scope',
        source_revision: sourceRevision,
        objective: 'Restore the existing draft to a reviewable PlanContract.',
        plan_steps: [
          {
            id: 'repair',
            objective: 'Repair the draft authority in place.',
            dependencies: [],
            authoritative_files: ['src/index.ts'],
            allowed_paths: ['src/**'],
            forbidden_paths: [],
            check_ids: ['package:check:type'],
            acceptance_criteria: ['The same Plan can be approved.'],
          },
        ],
      }),
    );
    expect(repaired.status).toBe('ok');
    expect(repaired.data.repaired).toBe(true);
    expect(repaired.data.replacementPlanCreated).toBe(false);
    expect(repaired.data.plan.planId).toBe('PLAN-LEGACY-MALFORMED');

    expect(getPlanContract({ controllerHome, repoId: repository.repoId }, 'PLAN-LEGACY-MALFORMED')?.status).toBe(
      'draft',
    );
  }, 15_000);
});
