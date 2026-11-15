import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callRhWorkRequirementOperation } from '../../adapters/mcp/runtime-gateway/work-requirement-operations';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import {
  createRequirement,
  listRequirementRevisionRecords,
  readRequirement,
  requirementSemanticView,
  reviseRequirementSemantic,
} from '../../src/runtime/control-plane/persistence/requirement-store';

describe('rh_work Requirement dependencies', () => {
  let controllerHome: string;

  beforeEach(() => {
    controllerHome = mkdtempSync(join(tmpdir(), 'forge-requirement-dependencies-'));
  });

  afterEach(() => {
    rmSync(controllerHome, { recursive: true, force: true });
  });

  function createTask(requirementId: string, repoId: string) {
    return createRequirement({ controllerHome }, {
      requirementId,
      repoId,
      title: `Task ${requirementId}`,
      outcomeStatement: `Deliver ${requirementId}`,
    });
  }

  it('stores cross-project dependencies through rh_work, snapshots them in history, and rejects missing, self and cyclic links', async () => {
    createTask('task-a', 'repo-a');
    createTask('task-b', 'repo-b');
    createTask('task-c', 'repo-c');

    const taskB = reviseRequirementSemantic({ controllerHome }, 'task-b', {
      expectedRevision: 1,
      dependsOnRequirementIds: ['task-c'],
    });
    expect(taskB.dependsOnRequirementIds).toEqual(['task-c']);

    const context = { controllerHome } as MultiRepositoryMcpToolContext;
    const revised = await callRhWorkRequirementOperation(context, undefined, 'requirement_revise', {
      requirement_id: 'task-a',
      expected_revision: 1,
      requirement_dependencies: ['task-b'],
    });
    const response = revised?.structuredContent as { data?: { requirement?: { dependsOnRequirementIds?: string[] } } } | undefined;
    expect(response?.data?.requirement?.dependsOnRequirementIds).toEqual(['task-b']);
    expect(requirementSemanticView(readRequirement({ controllerHome }, 'task-a')!.value).dependsOnRequirementIds).toEqual(['task-b']);
    const listed = await callRhWorkRequirementOperation(context, undefined, 'requirement_list', { limit: 20 });
    const listResponse = listed?.structuredContent as { data?: { requirements?: Array<{ requirementId: string; dependencyCount: number }> } } | undefined;
    expect(listResponse?.data?.requirements?.find((row) => row.requirementId === 'task-a')?.dependencyCount).toBe(1);
    const detailed = await callRhWorkRequirementOperation(context, undefined, 'requirement_get', {
      requirement_id: 'task-a', detail_level: 'detail',
    });
    const detailResponse = detailed?.structuredContent as {
      data?: {
        requirement?: { dependsOnRequirementIds?: string[] };
        revisionHistory?: Array<{ revision: number; dependsOnRequirementIds: string[] }>;
      };
    } | undefined;
    expect(detailResponse?.data?.requirement?.dependsOnRequirementIds).toEqual(['task-b']);
    expect(detailResponse?.data?.revisionHistory?.[0]?.dependsOnRequirementIds).toEqual([]);

    createTask('task-cancelled', 'repo-cancelled');
    reviseRequirementSemantic({ controllerHome }, 'task-cancelled', { expectedRevision: 1, status: 'cancelled' });
    expect(() => reviseRequirementSemantic({ controllerHome }, 'task-a', {
      expectedRevision: 2, dependsOnRequirementIds: ['task-cancelled'],
    })).toThrow('REQUIREMENT_DEPENDENCY_CANCELLED');

    expect(() => reviseRequirementSemantic({ controllerHome }, 'task-c', {
      expectedRevision: 1,
      dependsOnRequirementIds: ['task-a'],
    })).toThrow('REQUIREMENT_DEPENDENCY_CYCLE');

    expect(() => reviseRequirementSemantic({ controllerHome }, 'task-a', {
      expectedRevision: 2,
      dependsOnRequirementIds: ['missing-task'],
    })).toThrow('REQUIREMENT_DEPENDENCY_NOT_FOUND');

    expect(() => reviseRequirementSemantic({ controllerHome }, 'task-a', {
      expectedRevision: 2,
      dependsOnRequirementIds: ['task-a'],
    })).toThrow('REQUIREMENT_DEPENDENCY_CYCLE');

    const history = listRequirementRevisionRecords({ controllerHome }, 'task-a', 10);
    expect(history.map((entry) => ({ revision: entry.revision, dependencies: entry.dependsOnRequirementIds }))).toEqual([
      { revision: 1, dependencies: [] },
    ]);

    reviseRequirementSemantic({ controllerHome }, 'task-b', { expectedRevision: 2, status: 'cancelled' });
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
    expect(listRequirementRevisionRecords({ controllerHome }, 'task-a', 10)
      .map((entry) => ({ revision: entry.revision, dependencies: entry.dependsOnRequirementIds }))).toEqual([
        { revision: 4, dependencies: ['task-b'] },
        { revision: 3, dependencies: ['task-b'] },
        { revision: 2, dependencies: ['task-b'] },
        { revision: 1, dependencies: [] },
      ]);
  });
});
