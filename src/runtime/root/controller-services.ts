import {
  inspectControlPlaneDatabase,
  type ControlPlaneDatabaseInspection,
} from '../control-plane/persistence/sqlite-store';
import type {
  RuntimeControllerSnapshot,
  RuntimeReadiness,
  RuntimeReleaseManifest,
} from './types';

export class RuntimeControllerServices {
  private initializedDatabase?: ControlPlaneDatabaseInspection;

  constructor(
    private readonly controllerHome: string,
    private readonly runtimeInstanceId: string,
    private readonly release: RuntimeReleaseManifest,
    private readonly readiness: () => RuntimeReadiness,
    private readonly inspectDatabase: (controllerHome: string) => ControlPlaneDatabaseInspection = inspectControlPlaneDatabase,
  ) {}

  initialize(): ControlPlaneDatabaseInspection {
    this.initializedDatabase = this.inspectDatabase(this.controllerHome);
    return this.initializedDatabase;
  }

  readRuntimeSnapshot(): RuntimeControllerSnapshot {
    const inspection = this.inspectDatabase(this.controllerHome);
    return {
      runtimeInstanceId: this.runtimeInstanceId,
      releaseId: this.release.releaseId,
      readiness: this.readiness(),
      database: {
        integrity: inspection.integrity,
        schemaVersion: inspection.schemaVersion,
        recordCount: inspection.recordCount,
        auditEventCount: inspection.auditEventCount,
        orphanRecordCount: inspection.orphanRecordCount,
      },
    };
  }
}
