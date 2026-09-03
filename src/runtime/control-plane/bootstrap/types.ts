export type BootstrapControllerKind = 'chatgpt' | 'codex' | 'claude' | 'mcp';
export type BootstrapConnectivityMode = 'auto' | 'local' | 'remote';
export type BootstrapTransportKind = 'openai-secure-tunnel' | 'https-endpoint' | 'loopback' | 'none';
export type BootstrapStatus = 'in_progress' | 'blocked' | 'ready';
export type BootstrapObservationStatus = 'ready' | 'missing' | 'degraded' | 'blocked' | 'unsupported' | 'unknown';
export type BootstrapStepState = 'pending' | 'blocked' | 'ready' | 'skipped';
export type BootstrapBlockerKind = 'automatic_retry' | 'user_action' | 'unsupported' | 'failed';
export type BootstrapActionKind = 'configure' | 'install' | 'repair' | 'authenticate' | 'reconnect' | 'verify';
export type BootstrapActionOwner = 'forge' | 'user';

export interface BootstrapDesiredState {
  schemaVersion: 1;
  primaryController: BootstrapControllerKind;
  controllers: BootstrapControllerKind[];
  connectivity: {
    mode: BootstrapConnectivityMode;
    preferredTransport?: BootstrapTransportKind;
    endpoint?: string;
    tunnelId?: string;
  };
  capabilityIntents: string[];
}

/** Bounded observation. Raw logs, arbitrary objects, and credentials are intentionally absent. */
export interface BootstrapObservation {
  id: string;
  component: 'controller' | 'runtime' | 'connectivity' | 'provider' | 'plugin' | 'package-connector' | 'platform';
  status: BootstrapObservationStatus;
  summary: string;
  reasonCodes?: string[];
  provider?: string;
  version?: string;
  releaseId?: string;
  endpoint?: string;
  observedAt: string;
}

export interface BootstrapAction {
  id: string;
  kind: BootstrapActionKind;
  owner: BootstrapActionOwner;
  summary: string;
  command?: string;
  verification?: string;
  risk?: string;
}

export interface BootstrapBlocker {
  code: string;
  kind: BootstrapBlockerKind;
  stepId: string;
  summary: string;
  actionIds: string[];
}

export interface BootstrapStep {
  id: string;
  label: string;
  state: BootstrapStepState;
  dependsOn: string[];
  observationIds: string[];
  blockerCodes: string[];
  actionIds: string[];
}

export interface BootstrapSnapshot {
  schemaVersion: 1;
  status: BootstrapStatus;
  revision: number;
  stateFingerprint: string;
  controllerHome: string;
  desired: BootstrapDesiredState;
  observations: BootstrapObservation[];
  steps: BootstrapStep[];
  blockers: BootstrapBlocker[];
  actions: BootstrapAction[];
  createdAt: string;
  updatedAt: string;
}

export interface BootstrapEvaluation {
  desired: BootstrapDesiredState;
  observations: BootstrapObservation[];
  steps: BootstrapStep[];
  blockers: BootstrapBlocker[];
  actions: BootstrapAction[];
}
