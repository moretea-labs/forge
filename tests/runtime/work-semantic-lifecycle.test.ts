import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { createWorkContract, getWorkContract, listWorkSemanticRevisionRecords, recordWorkEvidenceState, reviseWorkSemanticContext, transitionWorkContractPhase, workSemanticView } from '../../packages/kernel/work/api/index';
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

function createOpenWork(options: { controllerHome: string; repoId: string }, workId: string, overrides: Record<string, unknown> = {}): void {
  createWorkContract(options, {
    workId,
    repoId: options.repoId,
    workKind: 'repository_change',
    objective: 'Keep semantic Work thin.',
    acceptanceCriteria: ['Semantic state is the only Work state'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: {},
    requestedBy: 'chatgpt',
    ...overrides,
  });
}

describe('thin semantic Work lifecycle', () => {

  test('start creates only semantic Work context and deduplicates the same request', async () => {
    const options = store();
    const first = structured(await callRhWorkSemanticOperation(options, 'start', {
      objective: 'Execute one thin Work without lifecycle ceremony.',
      request_id: 'semantic-start-idempotency',
    }));
    expect(first.status).toBe('ok');
    expect(first.data.deduplicated).toBe(false);
    expect(first.data.work).toMatchObject({
      state: 'open',
      revision: 1,
      objective: 'Execute one thin Work without lifecycle ceremony.',
    });
    expect(Object.keys(first.data.work).sort()).toEqual([
      'createdAt',
      'objective',
      'resultRefs',
      'revision',
      'semanticScope',
      'state',
      'updatedAt',
      'workId',
    ]);

    const second = structured(await callRhWorkSemanticOperation(options, 'start', {
      objective: 'Execute one thin Work without lifecycle ceremony.',
      request_id: 'semantic-start-idempotency',
    }));
    expect(second.status).toBe('ok');
    expect(second.data.deduplicated).toBe(true);
    expect(second.data.work.workId).toBe(first.data.work.workId);

    const stored = getWorkContract(options, first.data.work.workId)!;
    expect(stored.worktreeRef).toBeUndefined();
    expect(stored.checkRefs).toEqual([]);
    expect(stored.implementationReviews ?? []).toEqual([]);
  });

  test('completes a Work with complete alone, without verify, review or finalize phases', async () => {
    const options = store();
    createWorkContract(options, {
      workId: 'work-semantic-close',
      repoId: options.repoId,
      workKind: 'remote_effect',
      objective: 'Record one durable external outcome.',
      acceptanceCriteria: ['Outcome is recorded'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: {},
      requestedBy: 'chatgpt',
      dispatchState: 'running',
    });
    expect(workSemanticView(getWorkContract(options, 'work-semantic-close')!).state).toBe('open');

    const completed = structured(await callRhWorkSemanticOperation(options, 'complete', {
      work_id: 'work-semantic-close',
      expected_revision: 1,
      work_result_refs: ['artifact://external/outcome'],
    }));
    expect(completed.status).toBe('ok');
    expect(completed.data.work).toMatchObject({ workId: 'work-semantic-close', state: 'completed', revision: 2 });

    const stored = getWorkContract(options, 'work-semantic-close')!;
    expect(stored.semanticState).toBe('completed');
    expect(stored.semanticResultRefs).toEqual(['artifact://external/outcome']);
    // No verification, implementation review or finalize phase was required.
    expect(stored.checkRefs).toEqual([]);
    expect(stored.implementationReviews ?? []).toEqual([]);
  });

  test('rejects a stale complete without writing and returns current semantic state', async () => {
    const options = store();
    createOpenWork(options, 'work-stale-close', { workKind: 'remote_effect', objective: 'Remain open until the model closes it.' });

    const stale = structured(await callRhWorkSemanticOperation(options, 'complete', {
      work_id: 'work-stale-close',
      expected_revision: 7,
    }));
    expect(stale.status).toBe('blocked');
    expect(String(stale.summary)).toContain('WORK_REVISION_CONFLICT');
    expect(stale.data.currentWork).toMatchObject({ workId: 'work-stale-close', state: 'open', revision: 1 });
    expect(getWorkContract(options, 'work-stale-close')?.semanticState).toBe('open');
  });

  test('semantic completion never requires a delivery/cleanup receipt, evidence, review or controller round', async () => {
    const options = store();
    createOpenWork(options, 'work-no-mechanics');

    const completed = structured(await callRhWorkSemanticOperation(options, 'complete', {
      work_id: 'work-no-mechanics',
      expected_revision: 1,
      work_result_refs: ['git:commit:abcdef0'],
    }));
    expect(completed.status).toBe('ok');
    expect(completed.data.work).toMatchObject({ workId: 'work-no-mechanics', state: 'completed', revision: 2 });

    const stored = getWorkContract(options, 'work-no-mechanics')!;
    expect(workSemanticView(stored).state).toBe('completed');
    // A semantic close is not a delivery claim: mechanical completion facts stay absent.
    expect(stored.completionReceipt).toBeUndefined();
    expect(stored.completionOutcome).toBeUndefined();
    expect(stored.checkRefs).toEqual([]);
    expect(stored.implementationReviews ?? []).toEqual([]);
    expect(stored.reconciliations ?? []).toEqual([]);
  });

  test('detail read projects bounded canonical continuation facts without widening semantic Work state', async () => {
    const options = store();
    createOpenWork(options, 'work-continuation-detail', {
      continuationPrompt: 'Continue from the exact canonical facts   and preserve authority boundaries.',
      dispatchState: 'running',
    });

    const detail = structured(await callRhWorkSemanticOperation(options, 'get', {
      work_id: 'work-continuation-detail',
      detail_level: 'detail',
    }));
    expect(detail.data.continuation).toMatchObject({
      schemaVersion: 1,
      workId: 'work-continuation-detail',
      repoId: options.repoId,
      continuationPrompt: 'Continue from the exact canonical facts and preserve authority boundaries.',
      reconciliationRequired: false,
      nextSafeAction: 'Inspect the bound Work and its durable process/check evidence; do not resubmit the same request ID.',
    });
    expect(detail.data.work).toMatchObject({ workId: 'work-continuation-detail', state: 'open', revision: 1 });
    expect(detail.data.work).not.toHaveProperty('continuationPrompt');
    expect(detail.data.work).not.toHaveProperty('nextSafeAction');
  });

  test('mechanical lifecycle axes (running/blocked/failed/ready) stay non-authoritative and are not caller-visible Work state', async () => {
    const options = store();
    createOpenWork(options, 'work-mechanical-axes');

    // Drive the mechanical execution projection into a blocked/ready shape. None of
    // these writes may become the semantic Work state.
    transitionWorkContractPhase(options, 'work-mechanical-axes', {
      phase: 'verification',
      state: 'blocked',
      dispatchState: 'blocked',
      summary: 'Mechanical verification blocker observed.',
    });
    recordWorkEvidenceState(options, 'work-mechanical-axes', 'partial');

    const blocked = structured(await callRhWorkSemanticOperation(options, 'get', { work_id: 'work-mechanical-axes' }));
    expect(blocked.data.work).toMatchObject({ workId: 'work-mechanical-axes', state: 'open', revision: 1 });
    expect(JSON.stringify(blocked.data.work)).not.toMatch(/blocked|ready|failed|running/);

    const completed = structured(await callRhWorkSemanticOperation(options, 'complete', {
      work_id: 'work-mechanical-axes',
      expected_revision: 1,
    }));
    expect(completed.status).toBe('ok');
    expect(completed.data.work.state).toBe('completed');

    const stored = getWorkContract(options, 'work-mechanical-axes')!;
    expect(workSemanticView(stored).state).toBe('completed');
    // The mechanical execution projection is still recorded for migration reads,
    // but it never decided or blocked the semantic close.
    expect(stored.semanticState).toBe('completed');
  });

  test('start persists normalized objective relations and deduplicates the same semantic create', async () => {
    const options = store();
    createOpenWork(options, 'work-create-parent');
    createOpenWork(options, 'work-create-dependency');

    const created = structured(await callRhWorkSemanticOperation(options, 'start', {
      work_id: 'work-created-related',
      objective: 'Create one related semantic Work.',
      semantic_parent_work_id: 'work-create-parent',
      depends_on_work_ids: ['work-create-dependency', 'work-create-dependency'],
      request_id: 'work-created-related-request',
    }));
    expect(created.status).toBe('ok');
    expect(created.data.work).toMatchObject({
      revision: 1,
      semanticParentWorkId: 'work-create-parent',
      dependsOnWorkIds: ['work-create-dependency'],
    });

    const deduplicated = structured(await callRhWorkSemanticOperation(options, 'start', {
      work_id: 'work-created-related',
      objective: 'Create one related semantic Work.',
      semantic_parent_work_id: 'work-create-parent',
      depends_on_work_ids: ['work-create-dependency'],
      request_id: 'work-created-related-request',
    }));
    expect(deduplicated.status).toBe('ok');
    expect(deduplicated.data.deduplicated).toBe(true);
  });

  test('revise exposes exactly one thin semantic state vocabulary', async () => {
    const options = store();
    createOpenWork(options, 'work-parent');
    createOpenWork(options, 'work-dependency');
    createOpenWork(options, 'work-vocabulary');

    const related = structured(await callRhWorkSemanticOperation(options, 'revise', {
      work_id: 'work-vocabulary',
      expected_revision: 1,
      semantic_parent_work_id: 'work-parent',
      depends_on_work_ids: ['work-dependency'],
    }));
    expect(related.status).toBe('ok');
    expect(related.data.work).toMatchObject({
      state: 'open',
      revision: 2,
      semanticParentWorkId: 'work-parent',
      dependsOnWorkIds: ['work-dependency'],
    });
    const detail = structured(await callRhWorkSemanticOperation(options, 'get', {
      work_id: 'work-vocabulary',
      detail_level: 'detail',
    }));
    expect(detail.data.objectiveGraph.current.edges).toEqual(expect.arrayContaining([
      { kind: 'decomposition', fromWorkId: 'work-parent', toWorkId: 'work-vocabulary', workRevision: 2 },
      { kind: 'dependency', fromWorkId: 'work-dependency', toWorkId: 'work-vocabulary', workRevision: 2 },
    ]));
    const cycle = structured(await callRhWorkSemanticOperation(options, 'revise', {
      work_id: 'work-parent',
      expected_revision: 1,
      semantic_parent_work_id: 'work-vocabulary',
    }));
    expect(cycle.status).toBe('blocked');
    expect(String(cycle.summary)).toContain('WORK_SEMANTIC_PARENT_CYCLE');

    const historyBeforeRejectedRelations = listWorkSemanticRevisionRecords(options, 'work-vocabulary');
    const missing = structured(await callRhWorkSemanticOperation(options, 'revise', {
      work_id: 'work-vocabulary',
      expected_revision: 2,
      depends_on_work_ids: ['work-missing'],
    }));
    expect(missing.status).toBe('blocked');
    expect(String(missing.summary)).toContain('WORK_OBJECTIVE_RELATION_NOT_FOUND');
    expect(getWorkContract(options, 'work-vocabulary')?.semanticRevision).toBe(2);
    expect(listWorkSemanticRevisionRecords(options, 'work-vocabulary')).toEqual(historyBeforeRejectedRelations);

    const selfParent = structured(await callRhWorkSemanticOperation(options, 'revise', {
      work_id: 'work-vocabulary',
      expected_revision: 2,
      semantic_parent_work_id: 'work-vocabulary',
    }));
    expect(selfParent.status).toBe('blocked');
    expect(String(selfParent.summary)).toContain('WORK_SEMANTIC_PARENT_SELF_REFERENCE');
    expect(getWorkContract(options, 'work-vocabulary')?.semanticRevision).toBe(2);
    expect(listWorkSemanticRevisionRecords(options, 'work-vocabulary')).toEqual(historyBeforeRejectedRelations);

    const selfDependency = structured(await callRhWorkSemanticOperation(options, 'revise', {
      work_id: 'work-vocabulary',
      expected_revision: 2,
      depends_on_work_ids: ['work-vocabulary'],
    }));
    expect(selfDependency.status).toBe('blocked');
    expect(String(selfDependency.summary)).toContain('WORK_DEPENDENCY_SELF_REFERENCE');
    expect(getWorkContract(options, 'work-vocabulary')?.semanticRevision).toBe(2);
    expect(listWorkSemanticRevisionRecords(options, 'work-vocabulary')).toEqual(historyBeforeRejectedRelations);

    const dependencyCycle = structured(await callRhWorkSemanticOperation(options, 'revise', {
      work_id: 'work-dependency',
      expected_revision: 1,
      depends_on_work_ids: ['work-vocabulary'],
    }));
    expect(dependencyCycle.status).toBe('blocked');
    expect(String(dependencyCycle.summary)).toContain('WORK_DEPENDENCY_CYCLE');
    expect(getWorkContract(options, 'work-dependency')?.semanticRevision).toBe(1);
    expect(listWorkSemanticRevisionRecords(options, 'work-dependency')).toEqual([]);

    const revised = structured(await callRhWorkSemanticOperation(options, 'revise', {
      work_id: 'work-vocabulary',
      expected_revision: 2,
      work_state: 'cancelled',
    }));
    expect(revised.status).toBe('ok');
    expect(revised.data.work.state).toBe('cancelled');
    expect(listWorkSemanticRevisionRecords(options, 'work-vocabulary')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        revision: 2,
        semanticParentWorkId: 'work-parent',
        dependsOnWorkIds: ['work-dependency'],
      }),
    ]));
    expect(workSemanticView(reviseWorkSemanticContext(options, 'work-vocabulary', { expectedRevision: 3 })).state).toBe('cancelled');
  });
});
