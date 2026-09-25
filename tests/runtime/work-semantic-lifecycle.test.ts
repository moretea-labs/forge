import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { createWorkContract, getWorkContract, recordWorkEvidenceState, reviseWorkSemanticContext, transitionWorkContractPhase, workSemanticView } from '../../packages/kernel/work/api/index';
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
    mode: 'goal_workloop',
    workKind: 'repository_change',
    objective: 'Keep semantic Work thin.',
    acceptanceCriteria: ['Semantic state is the only Work state'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    ...overrides,
  });
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
    createOpenWork(options, 'work-stale-close', { workKind: 'remote_effect', objective: 'Remain open until the model closes it.' });

    const stale = structured(await callRhWorkSemanticOperation(options, 'work_complete', {
      work_id: 'work-stale-close',
      expected_revision: 7,
    }));
    expect(stale.status).toBe('blocked');
    expect(String(stale.summary)).toContain('WORK_REVISION_CONFLICT');
    expect(stale.data.currentWork).toMatchObject({ workId: 'work-stale-close', state: 'open', revision: 1 });
    expect(getWorkContract(options, 'work-stale-close')?.status).not.toBe('completed');
  });

  test('semantic completion never requires a delivery/cleanup receipt, evidence, review or controller round', async () => {
    const options = store();
    createOpenWork(options, 'work-no-mechanics');

    const completed = structured(await callRhWorkSemanticOperation(options, 'work_complete', {
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

  test('mechanical lifecycle axes (running/blocked/failed/ready) stay non-authoritative and are not caller-visible Work state', async () => {
    const options = store();
    createOpenWork(options, 'work-mechanical-axes');

    // Drive the legacy mechanical projection into a blocked/ready shape. None of
    // these writes may become the semantic Work state.
    transitionWorkContractPhase(options, 'work-mechanical-axes', {
      phase: 'verification',
      status: 'blocked',
      state: 'blocked',
      summary: 'Mechanical verification blocker observed.',
    });
    recordWorkEvidenceState(options, 'work-mechanical-axes', 'partial');

    const blocked = structured(await callRhWorkSemanticOperation(options, 'work_get', { work_id: 'work-mechanical-axes' }));
    expect(blocked.data.work).toMatchObject({ workId: 'work-mechanical-axes', state: 'open', revision: 1 });
    expect(JSON.stringify(blocked.data.work)).not.toMatch(/blocked|ready|failed|running/);

    const completed = structured(await callRhWorkSemanticOperation(options, 'work_complete', {
      work_id: 'work-mechanical-axes',
      expected_revision: 1,
    }));
    expect(completed.status).toBe('ok');
    expect(completed.data.work.state).toBe('completed');

    const stored = getWorkContract(options, 'work-mechanical-axes')!;
    expect(workSemanticView(stored).state).toBe('completed');
    // The legacy mechanical projection is still recorded for migration reads,
    // but it never decided or blocked the semantic close.
    expect(stored.status).toBe('completed');
  });

  test('work_revise exposes exactly one thin semantic state vocabulary', async () => {
    const options = store();
    createOpenWork(options, 'work-vocabulary');

    const revised = structured(await callRhWorkSemanticOperation(options, 'work_revise', {
      work_id: 'work-vocabulary',
      expected_revision: 1,
      work_state: 'cancelled',
    }));
    expect(revised.status).toBe('ok');
    expect(revised.data.work.state).toBe('cancelled');
    expect(workSemanticView(reviseWorkSemanticContext(options, 'work-vocabulary', { expectedRevision: 2 })).state).toBe('cancelled');
  });
});
