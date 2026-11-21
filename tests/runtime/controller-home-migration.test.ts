import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyControllerHomeMigration,
  inspectUnroutableMigratedWork,
  previewControllerHomeMigration,
  rollbackControllerHomeMigration,
} from '../../src/runtime/control-plane/persistence/controller-home-migration';
import {
  listControlPlaneRecords,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';

const roots: string[] = [];

function home(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function record(homePath: string, namespace: string, scope: string, key: string, value: unknown): void {
  writeControlPlaneRecord(homePath, { namespace, scope, key, schemaVersion: 1, value, expectedRevision: null });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Controller Home migration', () => {
  test('moves only active Work dependencies, retains terminal history in the source archive, and rolls back atomically', async () => {
    const source = home('forge-controller-home-source-');
    const destination = home('forge-controller-home-destination-');
    record(source, 'work_contract', 'repo-a', 'work-active', {
      workId: 'work-active',
      status: 'running',
      planId: 'plan-active',
    });
    record(source, 'work_contract', 'repo-a', 'work-terminal', { workId: 'work-terminal', status: 'completed' });
    record(source, 'work_contract', 'repo-a', 'work-semantic-open', {
      workId: 'work-semantic-open',
      semanticState: 'open',
      status: 'completed',
      planId: 'plan-active',
    });
    record(source, 'work_contract', 'repo-a', 'work-semantic-done', {
      workId: 'work-semantic-done',
      semanticState: 'completed',
      status: 'running',
    });
    record(source, 'work_contract', 'repo-a', 'work-unknown', { workId: 'work-unknown' });
    record(source, 'plan_contract', 'repo-a', 'plan-active', { planId: 'plan-active' });
    record(source, 'execution_work_handle', 'repo-a', 'work-active', {
      workId: 'work-active',
      workContractId: 'work-active',
      sessionId: 'session-active',
    });
    record(source, 'execution_session', 'controller', 'session-active', {
      sessionId: 'session-active',
      principalId: 'controller',
    });

    const preview = await previewControllerHomeMigration({ sourceHome: source, destinationHome: destination });
    expect(preview.selectedByNamespace).toEqual({
      execution_session: 1,
      execution_work_handle: 1,
      plan_contract: 1,
      work_contract: 3,
    });
    expect(preview.archivedOnly.terminalWorkContracts).toBe(2);
    expect(preview.conflicts).toEqual([]);

    const applied = await applyControllerHomeMigration({ sourceHome: source, destinationHome: destination });
    expect(applied.migration.imported).toHaveLength(6);
    expect(listControlPlaneRecords(destination, { namespace: 'work_contract', scope: 'repo-a' })).toHaveLength(3);
    expect(listControlPlaneRecords(source, { namespace: 'work_contract', scope: 'repo-a' })).toHaveLength(5);

    const before = listControlPlaneRecords(destination, { namespace: 'work_contract', scope: 'repo-a' });
    const handlesBefore = listControlPlaneRecords(destination, { namespace: 'execution_work_handle', scope: 'repo-a' });
    const inspection = inspectUnroutableMigratedWork({
      destinationHome: destination,
      migrationId: applied.migration.migrationId,
    });
    expect(inspection).toEqual({
      migrationId: applied.migration.migrationId,
      readOnly: true,
      unroutableWorkIds: ['work-active', 'work-semantic-open', 'work-unknown'],
      unroutableHandleIds: ['work-active'],
    });
    expect(listControlPlaneRecords(destination, { namespace: 'work_contract', scope: 'repo-a' })).toEqual(before);
    expect(listControlPlaneRecords(destination, { namespace: 'execution_work_handle', scope: 'repo-a' })).toEqual(
      handlesBefore,
    );
    const rolledBack = rollbackControllerHomeMigration({
      destinationHome: destination,
      migrationId: applied.migration.migrationId,
    });
    expect(rolledBack.status).toBe('rolled_back');
    expect(listControlPlaneRecords(destination, { namespace: 'work_contract', scope: 'repo-a' })).toEqual([]);
  });
});
