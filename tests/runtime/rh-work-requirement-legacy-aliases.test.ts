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

describe('rh_work Requirement legacy aliases', () => {
  let controllerHome: string;

  beforeEach(() => {
    controllerHome = mkdtempSync(join(tmpdir(), 'forge-requirement-legacy-aliases-'));
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

  it('links existing Requirements through revision-safe aliases, exposes history, and rejects duplicates', async () => {
    createTask('task-a', 'repo-a');
    createTask('task-b', 'repo-b');
    const alias = 'github:moretea-labs/forge#648';
    const context = { controllerHome } as MultiRepositoryMcpToolContext;

    const revised = await callRhWorkRequirementOperation(context, undefined, 'requirement_revise', {
      requirement_id: 'task-a',
      expected_revision: 1,
      requirement_legacy_aliases: [alias],
    });
    const revisedData = revised?.structuredContent as { data?: { requirement?: { legacyAliases?: string[] } } } | undefined;
    expect(revisedData?.data?.requirement?.legacyAliases).toEqual([alias]);
    expect(requirementSemanticView(readRequirement({ controllerHome }, 'task-a')!.value).legacyAliases).toEqual([alias]);

    const listed = await callRhWorkRequirementOperation(context, undefined, 'requirement_list', { limit: 20 });
    const listData = listed?.structuredContent as { data?: { requirements?: Array<{ requirementId: string; legacyAliases: string[] }> } } | undefined;
    expect(listData?.data?.requirements?.find((row) => row.requirementId === 'task-a')?.legacyAliases).toEqual([alias]);

    const detailed = await callRhWorkRequirementOperation(context, undefined, 'requirement_get', {
      requirement_id: 'task-a',
      detail_level: 'detail',
    });
    const detailData = detailed?.structuredContent as {
      data?: { requirement?: { legacyAliases: string[] }; revisionHistory?: Array<{ legacyAliases: string[] }> };
    } | undefined;
    expect(detailData?.data?.requirement?.legacyAliases).toEqual([alias]);
    expect(detailData?.data?.revisionHistory?.[0]?.legacyAliases).toEqual([]);

    expect(() => reviseRequirementSemantic({ controllerHome }, 'task-b', {
      expectedRevision: 1,
      legacyAliases: [alias],
    })).toThrow('REQUIREMENT_LEGACY_ALIAS_CONFLICT');

    expect(() => createRequirement({ controllerHome }, {
      requirementId: 'task-c',
      repoId: 'repo-c',
      title: 'Task task-c',
      outcomeStatement: 'Deliver task-c',
      legacyAliases: [alias],
    })).toThrow('REQUIREMENT_LEGACY_ALIAS_CONFLICT');

    const cleared = await callRhWorkRequirementOperation(context, undefined, 'requirement_revise', {
      requirement_id: 'task-a',
      expected_revision: 2,
      requirement_legacy_aliases: [],
    });
    const clearedData = cleared?.structuredContent as { data?: { requirement?: { legacyAliases?: string[] } } } | undefined;
    expect(clearedData?.data?.requirement?.legacyAliases).toEqual([]);
    expect(listRequirementRevisionRecords({ controllerHome }, 'task-a', 10)[0]?.legacyAliases).toEqual([alias]);
  });

  it('rejects an empty revision without consuming a semantic revision', async () => {
    createTask('task-empty', 'repo-empty');
    const context = { controllerHome } as MultiRepositoryMcpToolContext;

    const response = await callRhWorkRequirementOperation(context, undefined, 'requirement_revise', {
      requirement_id: 'task-empty',
      expected_revision: 1,
    });
    const data = response?.structuredContent as { status?: string; summary?: string } | undefined;

    expect(data?.status).toBe('blocked');
    expect(data?.summary).toContain('REQUIREMENT_REVISION_EMPTY');
    expect(readRequirement({ controllerHome }, 'task-empty')?.value.semanticRevision).toBe(1);
    expect(listRequirementRevisionRecords({ controllerHome }, 'task-empty', 10)).toEqual([]);
  });
});
