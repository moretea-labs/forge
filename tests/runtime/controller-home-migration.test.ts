import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyControllerHomeMigration,
  previewControllerHomeMigration,
  rollbackControllerHomeMigration,
} from '../../src/runtime/control-plane/persistence/controller-home-migration';
import { listControlPlaneRecords, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';

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
    record(source, 'work_contract', 'repo-a', 'work-active', { workId: 'work-active', status: 'running', planId: 'plan-active' });
    record(source, 'work_contract', 'repo-a', 'work-terminal', { workId: 'work-terminal', status: 'completed' });
    record(source, 'plan_contract', 'repo-a', 'plan-active', { planId: 'plan-active' });
    record(source, 'execution_work_handle', 'repo-a', 'work-active', { workId: 'work-active', workContractId: 'work-active', sessionId: 'session-active' });
    record(source, 'execution_session', 'controller', 'session-active', { sessionId: 'session-active', principalId: 'controller' });

    const preview = await previewControllerHomeMigration({ sourceHome: source, destinationHome: destination });
    expect(preview.selectedByNamespace).toEqual({
      execution_session: 1,
      execution_work_handle: 1,
      plan_contract: 1,
      work_contract: 1,
    });
    expect(preview.archivedOnly.terminalWorkContracts).toBe(1);
    expect(preview.conflicts).toEqual([]);

    const applied = await applyControllerHomeMigration({ sourceHome: source, destinationHome: destination });
    expect(applied.migration.imported).toHaveLength(4);
    expect(listControlPlaneRecords(destination, { namespace: 'work_contract', scope: 'repo-a' })).toHaveLength(1);
    expect(listControlPlaneRecords(source, { namespace: 'work_contract', scope: 'repo-a' })).toHaveLength(2);

    const rolledBack = rollbackControllerHomeMigration({ destinationHome: destination, migrationId: applied.migration.migrationId });
    expect(rolledBack.status).toBe('rolled_back');
    expect(listControlPlaneRecords(destination, { namespace: 'work_contract', scope: 'repo-a' })).toEqual([]);
  });
});
