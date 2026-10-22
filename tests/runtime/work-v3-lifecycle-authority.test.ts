import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readControlPlaneRecord, withControlPlaneTransaction, writeControlPlaneRecordWithinTransaction } from '../../src/runtime/control-plane/persistence/sqlite-store';
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
} from '../../packages/kernel/work/api/index';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Work v3 lifecycle authority', () => {
  test('keeps thin Work semantic revision/CAS independent from mechanical lifecycle state', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-semantic-authority-'));
    roots.push(root);
    const repoId = 'repo-work-semantic-authority';
    const store = { controllerHome: root, repoId };
    const workId = 'work-semantic-authority';
    const created = createWorkContract(store, {
      workId,
      repoId,
      objective: 'Original semantic objective.',
      acceptanceCriteria: [],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: {}, requestedBy: 'chatgpt', workKind: 'local_effect', dispatchState: 'running',
    });
    const createdSemantic = workSemanticView(created);
    expect(createdSemantic).toMatchObject({
      workId, revision: 1, state: 'open', objective: 'Original semantic objective.',
      semanticScope: { kind: 'work', id: workId },
    });

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
    const redelivered = recordWorkCompletionReceipt(store, workId, {
      schemaVersion: 1,
      receiptId: 'mechanical-completion-receipt-2',
      source: 'local_effect',
      workId,
      operation: 'test-local-effect-redelivery',
      target: { kind: 'controller_local', id: 'semantic-authority-test' },
      changed: true,
      recordedAt: '2026-09-24T05:01:00.000Z',
    }, 'completed_local', 'local_effect');
    expect(redelivered.completionReceipt?.receiptId).toBe('mechanical-completion-receipt-2');
    expect(workSemanticView(redelivered)).toMatchObject({ revision: 2, state: 'open' });
    const semanticallyCompleted = reviseWorkSemanticContext(store, workId, { expectedRevision: 2, state: 'completed' });
    expect(semanticallyCompleted.semanticState).toBe('completed');
    expect(workSemanticView(semanticallyCompleted)).toMatchObject({ revision: 3, state: 'completed' });
    expect(isCurrentWorkContract(semanticallyCompleted)).toBe(false);
  });

  test('SQLite reviseWorkSemanticContext guarantees zero write on stale or invalid revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-zero-write-'));
    roots.push(root);
    const repoId = 'repo-zero-write';
    const store = { controllerHome: root, repoId };
    const workId = 'work-zero-write-test';

    createWorkContract(store, {
      workId,
      repoId,
      objective: 'Initial objective.',
      acceptanceCriteria: [],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: {},
      requestedBy: 'chatgpt',
      dispatchState: 'running',
    });

    const initialRecord = readControlPlaneRecord(root, 'work_contract', repoId, workId);
    expect(initialRecord).toBeDefined();
    const initialHistory = listWorkSemanticRevisionRecords(store, workId);
    expect(initialHistory).toEqual([]);

    // 1) Stale expected_revision throws and performs zero writes (no history, no contract store update)
    expect(() => reviseWorkSemanticContext(store, workId, {
      expectedRevision: 99,
      objective: 'Stale expected revision write attempt',
    })).toThrow('WORK_REVISION_CONFLICT');

    expect(readControlPlaneRecord(root, 'work_contract', repoId, workId)).toEqual(initialRecord);
    expect(listWorkSemanticRevisionRecords(store, workId)).toEqual([]);

    // 2) Invalid objective (empty) throws and performs zero writes
    expect(() => reviseWorkSemanticContext(store, workId, {
      expectedRevision: 1,
      objective: '   ',
    })).toThrow('WORK_OBJECTIVE_REQUIRED');

    expect(readControlPlaneRecord(root, 'work_contract', repoId, workId)).toEqual(initialRecord);
    expect(listWorkSemanticRevisionRecords(store, workId)).toEqual([]);

    // 3) Invalid plan revision throws and performs zero writes
    expect(() => reviseWorkSemanticContext(store, workId, {
      expectedRevision: 1,
      planRevision: 0,
    })).toThrow('WORK_PLAN_REVISION_INVALID');

    expect(readControlPlaneRecord(root, 'work_contract', repoId, workId)).toEqual(initialRecord);
    expect(listWorkSemanticRevisionRecords(store, workId)).toEqual([]);

    // 4) Valid revision succeeds and writes both history and next revision
    const valid = reviseWorkSemanticContext(store, workId, {
      expectedRevision: 1,
      objective: 'Updated objective.',
    });
    expect(workSemanticView(valid).revision).toBe(2);
    expect(listWorkSemanticRevisionRecords(store, workId)).toHaveLength(1);
    expect(listWorkSemanticRevisionRecords(store, workId)[0]?.revision).toBe(1);


    // 5) Forbidden reopen on completed work performs zero writes
    const completed = reviseWorkSemanticContext(store, workId, {
      expectedRevision: 2,
      state: 'completed',
    });
    expect(workSemanticView(completed).state).toBe('completed');

    const completedRecord = readControlPlaneRecord(root, 'work_contract', repoId, workId);
    const completedHistory = listWorkSemanticRevisionRecords(store, workId);
    expect(completedHistory).toHaveLength(2);

    expect(() => reviseWorkSemanticContext(store, workId, {
      expectedRevision: 3,
      state: 'open',
    })).toThrow('WORK_SEMANTIC_REOPEN_FORBIDDEN');

    expect(readControlPlaneRecord(root, 'work_contract', repoId, workId)).toEqual(completedRecord);
    expect(listWorkSemanticRevisionRecords(store, workId)).toEqual(completedHistory);
  });

  test('legacy mechanical state is never inferred from status and current lifecycle writes require canonical APIs', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-v3-authority-'));
    roots.push(root);
    const repoId = 'repo-work-v3-authority';
    const store = { controllerHome: root, repoId };
    const workId = 'work-v3-lifecycle-authority';
    createWorkContract(store, {
      workId,
      repoId,
      objective: 'Prove lifecycle authority is explicit after legacy migration.',
      acceptanceCriteria: ['Legacy inference cannot remain a steady-state mutation authority.'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: {},
      requestedBy: 'chatgpt',
      workKind: 'remote_effect',
      dispatchState: 'running',
    });

    const stored = readControlPlaneRecord<Record<string, any>>(root, 'work_contract', repoId, workId)!;
    const legacy = structuredClone(stored.value) as Record<string, any>;
    legacy.schemaVersion = 2;
    delete legacy.phase;
    delete legacy.phaseEvidence;
    delete legacy.dispatchState;
    delete legacy.evidenceState;
    withControlPlaneTransaction(root, (database) => writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'work_contract', scope: repoId, key: workId, schemaVersion: 2, value: legacy,
      action: 'test_seed_legacy_work_contract', expectedRevision: stored.revision,
    }));

    const migrated = readWorkContractStore(store).contracts[0]!;
    expect(migrated).toMatchObject({
      schemaVersion: 4,
      workId,
      semanticState: 'open',
      workKind: 'remote_effect',
      phase: 'implementation',
      // Legacy mechanical phase/dispatch/evidence are migrated once into explicit
      // mechanical facts and never become semantic transition authority.
      dispatchState: 'not_dispatched',
      evidenceState: 'none',
    });
    // A legacy SQLite row is a read-only projection; only an authorized writer persists v4.
    const stillLegacy = readControlPlaneRecord<Record<string, any>>(root, 'work_contract', repoId, workId)!;
    expect(stillLegacy.schemaVersion).toBe(2);
    expect(stillLegacy.value.schemaVersion).toBe(2);
    expect(stillLegacy.value.phase).toBeUndefined();

    // @ts-expect-error Retired status is rejected rather than translated into semantic authority.
    expect(() => updateWorkContract(store, workId, { status: 'ready' })).toThrow('WORK_RETIRED_FIELD_REJECTED: status');
    // @ts-expect-error Evidence lifecycle is intentionally excluded from metadata-only writes.
    expect(() => updateWorkContract(store, workId, { evidenceState: 'valid' })).toThrow('WORK_LIFECYCLE_REQUIRES_TRANSITION_API');
    // @ts-expect-error Work kind is lifecycle semantics and requires an explicit semantic transition API.
    expect(() => updateWorkContract(store, workId, { workKind: 'local_effect' })).toThrow('WORK_LIFECYCLE_REQUIRES_TRANSITION_API');

    const withEvidence = recordWorkEvidenceState(store, workId, 'partial');
    expect(withEvidence).toMatchObject({ phase: 'implementation', dispatchState: 'not_dispatched', evidenceState: 'partial' });
    const persisted = readControlPlaneRecord<Record<string, any>>(root, 'work_contract', repoId, workId)!;
    expect(persisted.schemaVersion).toBe(4);
    expect(persisted.value).toMatchObject({ schemaVersion: 4, semanticState: 'open', phase: 'implementation', dispatchState: 'not_dispatched', evidenceState: 'partial' });
    const cancelled = cancelWorkContract(store, workId, { summary: 'Explicit canonical cancellation.' });
    expect(cancelled).toMatchObject({ semanticState: 'cancelled', phase: 'implementation', dispatchState: 'terminal', evidenceState: 'partial' });
    expect(readWorkContractStore(store).contracts[0]).toMatchObject({
      schemaVersion: 4,
      semanticState: 'cancelled',
      phase: 'implementation',
      dispatchState: 'terminal',
      evidenceState: 'partial',
    });
  });
});
