import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { RuntimeControllerServices } from '../../src/runtime/root/controller-services';
import {
  readControlPlaneRecord,
  type ControlPlaneDatabaseInspection,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import { scopedOperationRoot } from '../../src/effects/controller-home';
import { readWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import type { RuntimeReadiness, RuntimeReleaseManifest } from '../../src/runtime/root/types';

describe('retired Work has no Runtime startup admission authority', () => {
  test('initialization inspects the database without creating a historical Work index', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-no-work-index-'));
    try {
      const inspection = {
        integrity: 'ok',
        schemaVersion: 1,
        recordCount: 0,
        auditEventCount: 0,
        orphanRecordCount: 0,
      } as ControlPlaneDatabaseInspection;
      let calls = 0;
      const services = new RuntimeControllerServices(
        controllerHome,
        'retired-work-test',
        { releaseId: 'test' } as RuntimeReleaseManifest,
        () => ({}) as RuntimeReadiness,
        () => {
          calls += 1;
          return inspection;
        },
      );
      expect(services.initialize()).toBe(inspection);
      expect(calls).toBe(1);
      expect(readdirSync(controllerHome)).toEqual([]);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('historical JSON WorkHandle read does not import a WorkHandle SQLite record', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-no-work-import-'));
    const repoId = 'repo-legacy-read';
    const workId = 'work-legacy-read';
    try {
      const path = join(scopedOperationRoot(controllerHome, repoId), 'work-handles', workId + '.json');
      mkdirSync(dirname(path), { recursive: true });
      const handle = {
        schemaVersion: 1,
        workId,
        repositoryId: repoId,
        checkoutId: 'checkout-old',
        state: 'prepared',
      } as WorkHandleState;
      writeFileSync(path, JSON.stringify(handle));
      expect(readWorkHandle(controllerHome, repoId, workId)).toMatchObject(handle);
      expect(readWorkHandle(controllerHome, repoId, workId)).toMatchObject(handle);
      expect(readControlPlaneRecord(controllerHome, 'execution_work_handle', repoId, workId)).toBeUndefined();
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });
});
