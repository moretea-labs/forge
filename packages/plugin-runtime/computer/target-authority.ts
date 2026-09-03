export interface ComputerApplicationStableIdentity {
  bundleId?: string;
  appName?: string;
}

/** Live provider session identity is an observed/rebuildable binding, never durable target identity. */
export interface ComputerProviderTargetBinding {
  providerId: string;
  providerSessionId: string;
  observedAt: string;
}

export interface ComputerApplicationTarget {
  schemaVersion: 1;
  targetId: string;
  kind: 'application';
  stableIdentity: ComputerApplicationStableIdentity;
  providerBinding?: ComputerProviderTargetBinding;
  createdAt: string;
  updatedAt: string;
}

export interface ComputerInteractionTargetEntry {
  schemaVersion: 1;
  status: 'active' | 'tombstoned';
  target: ComputerApplicationTarget;
  tombstonedAt?: string;
}

export interface ComputerApplicationTargetLease {
  current(): ComputerApplicationTarget;
  bind(binding: ComputerProviderTargetBinding): ComputerApplicationTarget;
  tombstone(): ComputerApplicationTarget;
}

/** Durable target authority. Provider live session ids never escape this boundary as semantic identity. */
export interface ComputerInteractionTargetAuthorityPort {
  create(
    controllerHome: string,
    input: { stableIdentity: ComputerApplicationStableIdentity; providerBinding?: ComputerProviderTargetBinding },
  ): ComputerApplicationTarget;
  get(controllerHome: string, targetId: string): ComputerApplicationTarget | undefined;
  require(controllerHome: string, targetId: string): ComputerApplicationTarget;
  withLease<T>(
    controllerHome: string,
    targetId: string,
    operation: (lease: ComputerApplicationTargetLease) => Promise<T>,
  ): Promise<T>;
}
