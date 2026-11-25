import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callRhProjectRequirementOperation } from '../../adapters/mcp/runtime-gateway/rh-project-requirement-operations';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import {
  createRequirement,
  listRequirementRevisionRecords,
  readRequirement,
  requirementSemanticView,
  reviseRequirementSemantic,
} from '../../src/runtime/control-plane/persistence/requirement-store';

describe('rh_project Requirement dependencies', () => {
  let controllerHome: string;

  beforeEach(() => {
    controllerHome = mkdtempSync(join(tmpdir(), 'forge-requirement-dependencies-'));
  });

  afterEach(() => {
    rmSync(controllerHome, { recursive: true, force: true });
  });

  function createTask(requirementId: string, repoId: string) {
    return createRequirement(
      { controllerHome },
      {
        requirementId,
        repoId,
        title: `Task ${requirementId}`,
        outcomeStatement: `Deliver ${requirementId}`,
      },
    );
  }

  it('stores cross-project dependencies through rh_project, snapshots them in history, and rejects missing, self and cyclic links', async () => {
    createTask('task-a', 'repo-a');
    createTask('task-b', 'repo-b');
    createTask('task-c', 'repo-c');

    const taskB = reviseRequirementSemantic({ controllerHome }, 'task-b', {
      expectedRevision: 1,
      dependsOnRequirementIds: ['task-c'],
    });
    expect(taskB.dependsOnRequirementIds).toEqual(['task-c']);

    const context = { controllerHome } as MultiRepositoryMcpToolContext;
    const revised = await callRhProjectRequirementOperation(context, undefined, 'requirement_revise', {
      requirement_id: 'task-a',
      expected_revision: 1,
      requirement_dependencies: ['task-b'],
    });
    const response = revised?.structuredContent as
      | { data?: { requirement?: { dependsOnRequirementIds?: string[] } } }
      | undefined;
    expect(response?.data?.requirement?.dependsOnRequirementIds).toEqual(['task-b']);
    expect(
      requirementSemanticView(readRequirement({ controllerHome }, 'task-a')!.value).dependsOnRequirementIds,
    ).toEqual(['task-b']);
    const listed = await callRhProjectRequirementOperation(context, undefined, 'requirement_list', { limit: 20 });
    const listResponse = listed?.structuredContent as
      | { data?: { requirements?: Array<{ requirementId: string; dependencyCount: number }> } }
      | undefined;
    expect(listResponse?.data?.requirements?.find((row) => row.requirementId === 'task-a')?.dependencyCount).toBe(1);
    const repositoryA = { repoId: 'repo-a' };
    const detailed = await callRhProjectRequirementOperation(context, repositoryA, 'requirement_get', {
      requirement_id: 'task-a',
      detail_level: 'detail',
    });
    const detailResponse = detailed?.structuredContent as
      | {
          data?: {
            requirement?: { dependsOnRequirementIds?: string[] };
            dependencyRequirements?: Array<{
              requirementId: string;
              title?: string;
              status?: string;
              revision?: number;
              repoId?: string;
              missing?: boolean;
            }>;
            revisionHistory?: Array<{ revision: number; dependsOnRequirementIds: string[] }>;
          };
        }
      | undefined;
    expect(detailResponse?.data?.requirement?.dependsOnRequirementIds).toEqual(['task-b']);
    expect(detailResponse?.data?.dependencyRequirements).toEqual([
      {
        requirementId: 'task-b',
        title: 'Task task-b',
        status: 'planned',
        revision: 2,
        repoId: 'repo-b',
      },
    ]);
    expect(detailResponse?.data?.revisionHistory?.[0]?.dependsOnRequirementIds).toEqual([]);

    createTask('task-cancelled', 'repo-cancelled');
    reviseRequirementSemantic({ controllerHome }, 'task-cancelled', { expectedRevision: 1, status: 'cancelled' });
    expect(() =>
      reviseRequirementSemantic({ controllerHome }, 'task-a', {
        expectedRevision: 2,
        dependsOnRequirementIds: ['task-cancelled'],
      }),
    ).toThrow('REQUIREMENT_DEPENDENCY_CANCELLED');

    expect(() =>
      reviseRequirementSemantic({ controllerHome }, 'task-c', {
        expectedRevision: 1,
        dependsOnRequirementIds: ['task-a'],
      }),
    ).toThrow('REQUIREMENT_DEPENDENCY_CYCLE');

    expect(() =>
      reviseRequirementSemantic({ controllerHome }, 'task-a', {
        expectedRevision: 2,
        dependsOnRequirementIds: ['missing-task'],
      }),
    ).toThrow('REQUIREMENT_DEPENDENCY_NOT_FOUND');

    expect(() =>
      reviseRequirementSemantic({ controllerHome }, 'task-a', {
        expectedRevision: 2,
        dependsOnRequirementIds: ['task-a'],
      }),
    ).toThrow('REQUIREMENT_DEPENDENCY_CYCLE');

    const history = listRequirementRevisionRecords({ controllerHome }, 'task-a', 10);
    expect(history.map((entry) => ({ revision: entry.revision, dependencies: entry.dependsOnRequirementIds }))).toEqual(
      [{ revision: 1, dependencies: [] }],
    );

    reviseRequirementSemantic({ controllerHome }, 'task-b', { expectedRevision: 2, status: 'cancelled' });
    const cancelledDependencyDetail = await callRhProjectRequirementOperation(context, repositoryA, 'requirement_get', {
      requirement_id: 'task-a',
      detail_level: 'detail',
    });
    const cancelledDependencyResponse = cancelledDependencyDetail?.structuredContent as
      | {
          data?: { dependencyRequirements?: Array<{ requirementId: string; status?: string }> };
        }
      | undefined;
    expect(cancelledDependencyResponse?.data?.dependencyRequirements?.[0]).toMatchObject({
      requirementId: 'task-b',
      status: 'cancelled',
    });
    const editedAfterDependencyCancellation = reviseRequirementSemantic({ controllerHome }, 'task-a', {
      expectedRevision: 2,
      title: 'Task task-a remains editable after a dependency is cancelled',
    });
    expect(editedAfterDependencyCancellation.dependsOnRequirementIds).toEqual(['task-b']);
    const savedWithUnchangedDependencies = reviseRequirementSemantic({ controllerHome }, 'task-a', {
      expectedRevision: 3,
      title: 'Task task-a can save the unchanged dependency set',
      dependsOnRequirementIds: ['task-b'],
    });
    expect(savedWithUnchangedDependencies.dependsOnRequirementIds).toEqual(['task-b']);

    const cleared = reviseRequirementSemantic({ controllerHome }, 'task-a', {
      expectedRevision: 4,
      dependsOnRequirementIds: [],
    });
    expect(cleared.dependsOnRequirementIds).toEqual([]);
    expect(
      listRequirementRevisionRecords({ controllerHome }, 'task-a', 10).map((entry) => ({
        revision: entry.revision,
        dependencies: entry.dependsOnRequirementIds,
      })),
    ).toEqual([
      { revision: 4, dependencies: ['task-b'] },
      { revision: 3, dependencies: ['task-b'] },
      { revision: 2, dependencies: ['task-b'] },
      { revision: 1, dependencies: [] },
    ]);
  });

  it('creates dependency-bearing Requirements atomically and includes dependencies in bootstrap identity', async () => {
    createTask('parent', 'repo-parent');
    const context = { controllerHome } as MultiRepositoryMcpToolContext;
    const args = {
      requirement_id: 'child',
      requirement_title: 'Child task',
      requirement_outcome: 'Deliver the child task after its existing parent.',
      requirement_acceptance_criteria: ['The child is linked to the exact parent.'],
      requirement_delivery_references: ['https://github.com/moretea-labs/forge/issues/129'],
      requirement_legacy_aliases: ['github:moretea-labs/forge#129'],
      requirement_dependencies: ['parent'],
      requirement_priority: 'urgent',
      requirement_status: 'active',
    };

    const created = await callRhProjectRequirementOperation(context, undefined, 'requirement_create', args);
    const response = created?.structuredContent as
      | {
          data?: {
            requirementCreated?: boolean;
            admissionDecision?: string;
            requirement?: {
              dependsOnRequirementIds?: string[];
              legacyAliases?: string[];
              status?: string;
              priority?: string;
            };
          };
        }
      | undefined;
    expect(response?.data).toMatchObject({
      requirementCreated: true,
      admissionDecision: 'created',
      requirement: {
        dependsOnRequirementIds: ['parent'],
        legacyAliases: ['github:moretea-labs/forge#129'],
        status: 'active',
        priority: 'urgent',
      },
    });
    expect(readRequirement({ controllerHome }, 'child')?.value.dependsOnRequirementIds).toEqual(['parent']);

    const repeated = await callRhProjectRequirementOperation(context, undefined, 'requirement_create', args);
    const repeatedData = repeated?.structuredContent as
      | { data?: { requirementCreated?: boolean; admissionDecision?: string } }
      | undefined;
    expect(repeatedData?.data).toMatchObject({ requirementCreated: false, admissionDecision: 'reuse_existing' });

    const conflicting = await callRhProjectRequirementOperation(context, undefined, 'requirement_create', {
      ...args,
      requirement_dependencies: [],
    });
    const conflictData = conflicting?.structuredContent as { status?: string; summary?: string } | undefined;
    expect(conflictData?.status).toBe('blocked');
    expect(conflictData?.summary).toContain('REQUIREMENT_ALREADY_EXISTS_CONFLICT');
    expect(readRequirement({ controllerHome }, 'child')?.value.dependsOnRequirementIds).toEqual(['parent']);

    const missing = await callRhProjectRequirementOperation(context, undefined, 'requirement_create', {
      ...args,
      requirement_id: 'missing-parent-child',
      requirement_legacy_aliases: ['github:moretea-labs/forge#130'],
      requirement_dependencies: ['not-found'],
    });
    const missingData = missing?.structuredContent as { status?: string; summary?: string } | undefined;
    expect(missingData?.status).toBe('blocked');
    expect(missingData?.summary).toContain('REQUIREMENT_DEPENDENCY_NOT_FOUND');
    expect(readRequirement({ controllerHome }, 'missing-parent-child')).toBeUndefined();

    createTask('cancelled-parent', 'repo-cancelled');
    reviseRequirementSemantic({ controllerHome }, 'cancelled-parent', { expectedRevision: 1, status: 'cancelled' });
    const cancelled = await callRhProjectRequirementOperation(context, undefined, 'requirement_create', {
      ...args,
      requirement_id: 'cancelled-parent-child',
      requirement_legacy_aliases: ['github:moretea-labs/forge#131'],
      requirement_dependencies: ['cancelled-parent'],
    });
    const cancelledData = cancelled?.structuredContent as { status?: string; summary?: string } | undefined;
    expect(cancelledData?.status).toBe('blocked');
    expect(cancelledData?.summary).toContain('REQUIREMENT_DEPENDENCY_CANCELLED');
    expect(readRequirement({ controllerHome }, 'cancelled-parent-child')).toBeUndefined();
  });

  it('shows downstream tasks across repositories and refreshes their blocking state when a prerequisite completes', async () => {
    createTask('shared-prerequisite', 'repo-prerequisite');
    createTask('downstream-a', 'repo-a');
    createTask('downstream-b', 'repo-b');
    reviseRequirementSemantic({ controllerHome }, 'downstream-a', {
      expectedRevision: 1,
      dependsOnRequirementIds: ['shared-prerequisite'],
    });
    reviseRequirementSemantic({ controllerHome }, 'downstream-b', {
      expectedRevision: 1,
      dependsOnRequirementIds: ['shared-prerequisite'],
    });

    const context = { controllerHome } as MultiRepositoryMcpToolContext;
    const before = await callRhProjectRequirementOperation(context, undefined, 'requirement_get', {
      requirement_id: 'shared-prerequisite',
      detail_level: 'detail',
    });
    const beforeData = before?.structuredContent as
      | {
          data?: {
            dependentRequirements?: Array<{
              requirementId: string;
              status: string;
              repoId?: string;
              blocksDependent: boolean;
            }>;
            dependentRequirementCount?: number;
            dependentRequirementsTruncated?: boolean;
          };
        }
      | undefined;
    expect(beforeData?.data).toMatchObject({
      dependentRequirementCount: 2,
      dependentRequirementsTruncated: false,
    });
    expect(beforeData?.data?.dependentRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirementId: 'downstream-a',
          repoId: 'repo-a',
          status: 'planned',
          blocksDependent: true,
        }),
        expect.objectContaining({
          requirementId: 'downstream-b',
          repoId: 'repo-b',
          status: 'planned',
          blocksDependent: true,
        }),
      ]),
    );

    const completed = await callRhProjectRequirementOperation(context, undefined, 'requirement_revise', {
      requirement_id: 'shared-prerequisite',
      expected_revision: 1,
      requirement_status: 'done',
      requirement_remaining_work: [],
      requirement_accepted_evidence_refs: ['https://github.com/moretea-labs/forge/actions/runs/42'],
    });
    expect((completed?.structuredContent as { status?: string } | undefined)?.status).toBe('ok');

    const after = await callRhProjectRequirementOperation(context, undefined, 'requirement_get', {
      requirement_id: 'shared-prerequisite',
      detail_level: 'detail',
    });
    const afterData = after?.structuredContent as
      | {
          data?: {
            dependentRequirements?: Array<{ requirementId: string; blocksDependent: boolean }>;
          };
        }
      | undefined;
    expect(afterData?.data?.dependentRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirementId: 'downstream-a', blocksDependent: false }),
        expect.objectContaining({ requirementId: 'downstream-b', blocksDependent: false }),
      ]),
    );

    const blockedTasks = await callRhProjectRequirementOperation(context, undefined, 'requirement_list', {
      dependency_filter: 'blocked',
      limit: 20,
    });
    const blockedIds = (
      (blockedTasks?.structuredContent as { data?: { requirements?: Array<{ requirementId: string }> } } | undefined)
        ?.data?.requirements ?? []
    ).map((task) => task.requirementId);
    expect(blockedIds).not.toContain('downstream-a');
    expect(blockedIds).not.toContain('downstream-b');
  });
});
