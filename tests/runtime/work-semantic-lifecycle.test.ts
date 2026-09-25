import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { createWorkContract, getWorkContract, workSemanticView } from '../../packages/kernel/work/api/index';
import { callRhWorkSemanticOperation } from '../../adapters/mcp/runtime-gateway/work-semantic-operations';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), 'forge-work-semantic-lifecycle-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  return { controllerHome, repoId: 'repo-work-lifecycle' };
}

function structured(result: Awaited<ReturnType<typeof callRhWorkSemanticOperation>> | undefined): Record<string, any> {
  expect(result).toBeTruthy();
  return result!.structuredContent as Record<string, any>;
}

describe('thin semantic Work lifecycle', () => {
  test('completes a Work with work_complete alone, without verify, review or finalize phases', async () => {
    const options = store();
    createWorkContract(options, {
      workId: 'work-semantic-close',
      repoId: options.repoId,
      mode: 'goal_workloop',
      workKind: 'remote_effect',
      objective: 'Record one durable external outcome.',
      acceptanceCriteria: ['Outcome is recorded'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    expect(workSemanticView(getWorkContract(options, 'work-semantic-close')!).state).toBe('open');

    const completed = structured(await callRhWorkSemanticOperation(options, 'work_complete', {
      work_id: 'work-semantic-close',
      expected_revision: 1,
      work_result_refs: ['artifact://external/outcome'],
    }));
    expect(completed.status).toBe('ok');
    expect(completed.data.work).toMatchObject({ workId: 'work-semantic-close', state: 'completed', revision: 2 });

    const stored = getWorkContract(options, 'work-semantic-close')!;
    expect(stored.status).toBe('completed');
    expect(stored.semanticResultRefs).toEqual(['artifact://external/outcome']);
    // No verification, implementation review or finalize phase was required.
    expect(stored.checkRefs).toEqual([]);
    expect(stored.implementationReviews ?? []).toEqual([]);
  });

  test('rejects a stale work_complete without writing and returns current semantic state', async () => {
    const options = store();
    createWorkContract(options, {
      workId: 'work-stale-close',
      repoId: options.repoId,
      mode: 'goal_workloop',
      workKind: 'remote_effect',
      objective: 'Remain open until the model closes it.',
      acceptanceCriteria: ['Outcome is recorded'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });

    const stale = structured(await callRhWorkSemanticOperation(options, 'work_complete', {
      work_id: 'work-stale-close',
      expected_revision: 7,
    }));
    expect(stale.status).toBe('blocked');
    expect(String(stale.summary)).toContain('WORK_REVISION_CONFLICT');
    expect(stale.data.currentWork).toMatchObject({ workId: 'work-stale-close', state: 'open', revision: 1 });
    expect(getWorkContract(options, 'work-stale-close')?.status).not.toBe('completed');
  });
});
