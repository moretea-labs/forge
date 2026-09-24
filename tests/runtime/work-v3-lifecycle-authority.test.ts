import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cancelWorkContract,
  createWorkContract,
  readWorkContractStore,
  recordWorkEvidenceState,
  recordWorkCompletionReceipt,
  listWorkSemanticRevisionRecords,
  reviseWorkSemanticContext,
  isCurrentWorkContract,
  workSemanticView,
  updateWorkContract,
  workContractStorePath,
} from '../../packages/kernel/work/api/index';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Work v3 lifecycle authority', () => {
  test('keeps thin Work semantic revision/CAS independent from mechanical lifecycle state', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-semantic-authority-'));
    roots.push(root);
    const store = { root };
    const workId = 'work-semantic-authority';
    const created = createWorkContract(store, {
      workId,
      repoId: 'repo-work-semantic-authority',
      mode: 'direct_control',
      objective: 'Original semantic objective.',
      acceptanceCriteria: [],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const createdSemantic = workSemanticView(created);
    expect(createdSemantic).toMatchObject({ workId, revision: 1, state: 'open', objective: 'Original semantic objective.' });

    const mechanical = recordWorkEvidenceState(store, workId, 'partial');
    expect(workSemanticView(mechanical)).toMatchObject({ revision: 1, updatedAt: createdSemantic.updatedAt });
    const revised = reviseWorkSemanticContext(store, workId, {
      expectedRevision: 1,
      objective: 'Revised semantic objective.',
      requirementRevision: 3,
      planRevision: 7,
      resultRefs: ['receipt-a'],
    });
    expect(workSemanticView(revised)).toMatchObject({
      revision: 2, state: 'open', objective: 'Revised semantic objective.',
      requirementRevision: 3, planRevision: 7, resultRefs: ['receipt-a'],
    });
    expect(listWorkSemanticRevisionRecords(store, workId)).toMatchObject([{ revision: 1, objective: 'Original semantic objective.' }]);
    expect(() => reviseWorkSemanticContext(store, workId, { expectedRevision: 1, objective: 'stale writer' }))
      .toThrow('WORK_REVISION_CONFLICT');
    const mechanicallyCompleted = recordWorkCompletionReceipt(store, workId, {
      schemaVersion: 1,
      receiptId: 'mechanical-completion-receipt',
      source: 'local_effect',
      workId,
      operation: 'test-local-effect',
      target: { kind: 'controller_local', id: 'semantic-authority-test' },
      changed: true,
      recordedAt: '2026-09-24T05:00:00.000Z',
    }, 'completed_local', 'local_effect');
    expect(workSemanticView(mechanicallyCompleted)).toMatchObject({
      revision: 2,
      state: 'open',
      resultRefs: ['receipt-a'],
    });
    expect(workSemanticView(mechanicallyCompleted).resultRefs).not.toContain('mechanical-completion-receipt');
    expect(isCurrentWorkContract(mechanicallyCompleted)).toBe(true);
    const semanticallyCompleted = reviseWorkSemanticContext(store, workId, { expectedRevision: 2, state: 'completed' });
    expect(semanticallyCompleted.status).toBe('completed');
    expect(workSemanticView(semanticallyCompleted)).toMatchObject({ revision: 3, state: 'completed' });
    expect(isCurrentWorkContract(semanticallyCompleted)).toBe(false);
  });

  test('legacy inference is a one-way migration boundary and current lifecycle writes require canonical APIs', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-v3-authority-'));
    roots.push(root);
    const store = { root };
    const workId = 'work-v3-lifecycle-authority';
    createWorkContract(store, {
      workId,
      repoId: 'repo-work-v3-authority',
      mode: 'goal_workloop',
      objective: 'Prove lifecycle authority is explicit after legacy migration.',
      acceptanceCriteria: ['Legacy inference cannot remain a steady-state mutation authority.'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'remote_effect',
      status: 'running',
    });

    const path = workContractStorePath(store);
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as any;
    legacy.schemaVersion = 2;
    legacy.contracts[0].schemaVersion = 2;
    delete legacy.contracts[0].phase;
    delete legacy.contracts[0].phaseEvidence;
    delete legacy.contracts[0].dispatchState;
    delete legacy.contracts[0].evidenceState;
    writeFileSync(path, JSON.stringify(legacy, null, 2) + '\n');

    const migrated = readWorkContractStore(store).contracts[0]!;
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      workId,
      status: 'running',
      workKind: 'remote_effect',
      phase: 'implementation',
      dispatchState: 'running',
      evidenceState: 'none',
    });
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as any;
    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.contracts[0]).toMatchObject({ schemaVersion: 3, phase: 'implementation', dispatchState: 'running', evidenceState: 'none' });

    // @ts-expect-error Lifecycle status is intentionally excluded from metadata-only writes.
    expect(() => updateWorkContract(store, workId, { status: 'ready' })).toThrow('WORK_LIFECYCLE_REQUIRES_TRANSITION_API');
    // @ts-expect-error Evidence lifecycle is intentionally excluded from metadata-only writes.
    expect(() => updateWorkContract(store, workId, { evidenceState: 'valid' })).toThrow('WORK_LIFECYCLE_REQUIRES_TRANSITION_API');
    // @ts-expect-error Work kind is lifecycle semantics and requires an explicit semantic transition API.
    expect(() => updateWorkContract(store, workId, { workKind: 'local_effect' })).toThrow('WORK_LIFECYCLE_REQUIRES_TRANSITION_API');

    const withEvidence = recordWorkEvidenceState(store, workId, 'partial');
    expect(withEvidence).toMatchObject({ phase: 'implementation', dispatchState: 'running', evidenceState: 'partial' });
    const cancelled = cancelWorkContract(store, workId, { summary: 'Explicit canonical cancellation.' });
    expect(cancelled).toMatchObject({ status: 'cancelled', phase: 'implementation', dispatchState: 'terminal', evidenceState: 'partial' });
    expect(readWorkContractStore(store).contracts[0]).toMatchObject({
      schemaVersion: 3,
      status: 'cancelled',
      phase: 'implementation',
      dispatchState: 'terminal',
      evidenceState: 'partial',
    });
  });
});
