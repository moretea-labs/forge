export type RuntimeDiagnosticOutcome = 'pass' | 'fail' | 'not_observed';

export interface RuntimeDiagnosticEvidence {
  outcome: RuntimeDiagnosticOutcome;
  reasonCode?: string;
}

/**
 * The complete Runtime has one readiness result. Module observations are
 * diagnostic evidence only; callers must never promote them into independent
 * lifecycle or recovery state machines.
 */
export interface RuntimeReadiness {
  ready: boolean;
  reasonCodes: string[];
  diagnostics: {
    database: RuntimeDiagnosticEvidence;
    scheduler: RuntimeDiagnosticEvidence;
    releaseCoherence: RuntimeDiagnosticEvidence;
    mcpEndToEnd: RuntimeDiagnosticEvidence;
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
  entrypoint: 'forge-runtime';
  diagnosticEntrypoint?: 'forge-cli';
  diagnosticArtifactIdentity?: string;
  browserNodeBridgeEntrypoint?: 'browser-node-bridge-host.js';
  browserNodeBridgeArtifactIdentity?: string;
  arguments: string[];
  configurationSchemaVersion: 1;
  controllerHome: string;
  databaseSchemaCompatibility: {
    minimum: number;
    maximum: number;
  };
  workerProtocolVersion: number;
  sourceCommit?: string;
  releaseRevision?: string;
  cleanWorkspace?: boolean;
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

export interface RuntimeStatusSnapshot {
  schemaVersion: 1;
  runtimeInstanceId: string;
  pid: number;
  releaseId: string;
  artifactIdentity: string;
  endpoint?: string;
  readiness: RuntimeReadiness;
  startedAt: string;
  updatedAt: string;
}

export interface RuntimeStatusObservation {
  schemaVersion: 1;
  running: boolean;
  ready: boolean;
  stale: boolean;
  reasonCodes: string[];
  snapshot?: RuntimeStatusSnapshot;
  observedAt: string;
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
