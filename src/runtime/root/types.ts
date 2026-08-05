export type RuntimeLifecycle = 'starting' | 'running' | 'stopping' | 'stopped';
export type RuntimeCheckState = 'pass' | 'fail' | 'unknown';

export interface RuntimeReadiness {
  lifecycle: RuntimeLifecycle;
  ready: boolean;
  reasonCodes: string[];
  checks: {
    database: RuntimeCheckState;
    scheduler: RuntimeCheckState;
    releaseCoherence: RuntimeCheckState;
    mcpEndToEnd: RuntimeCheckState;
  };
  observedAt: string;
}

export interface RuntimeExitEvidence {
  reasonCode: string;
  observedAt: string;
  message?: string;
}

export interface RuntimeReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  artifactIdentity: string;
  entrypoint: 'repo-harness-runtime';
  arguments: string[];
  configurationSchemaVersion: 1;
  controllerHome: string;
  databaseSchemaCompatibility: {
    minimum: number;
    maximum: number;
  };
  workerProtocolVersion: number;
  createdAt: string;
}

export interface CanonicalRuntimeConfig {
  controllerHome: string;
  repositoryRoot: string;
  releaseManifestPath: string;
  host: string;
  port: number;
  authToken: string;
  exclusiveWorkId?: string;
  runtimeInstanceId?: string;
  schedulerReadyTimeoutMs?: number;
}

export interface RuntimeControllerSnapshot {
  runtimeInstanceId: string;
  releaseId: string;
  readiness: RuntimeReadiness;
  database: {
    integrity: 'ok';
    schemaVersion: number;
    recordCount: number;
    auditEventCount: number;
    orphanRecordCount: number;
  };
}
