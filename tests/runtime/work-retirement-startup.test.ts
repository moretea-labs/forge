import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeControllerServices } from '../../src/runtime/root/controller-services';
import type { ControlPlaneDatabaseInspection } from '../../src/runtime/control-plane/persistence/sqlite-store';
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
});
