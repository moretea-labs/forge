export interface ComputerApplicationStableIdentity {
  bundleId?: string;
  appName?: string;
}

/** Live application-provider session identity is an observed/rebuildable binding, never durable target identity. */
export interface ComputerProviderTargetBinding {
  providerId: string;
  providerSessionId: string;
  observedAt: string;
}

export type ComputerSurfaceType = 'browser-tab' | 'browser-page';
export type ComputerSurfaceOwnership = 'plugin_owned' | 'user_owned' | 'provider_owned';

/**
 * Durable semantic description of a Computer surface. Mutable URL/title and
 * provider-specific tab/window handles are deliberately excluded.
 */
export interface ComputerSurfaceStableIdentity {
  surfaceType: ComputerSurfaceType;
  ownership: ComputerSurfaceOwnership;
  application?: ComputerApplicationStableIdentity;
}

/**
 * Rebuildable provider observation for a surface. These fields may help a
 * provider reconnect to the same resource, but none of them is semantic target
 * identity; Computer targetId remains canonical.
 */
export interface ComputerSurfaceProviderBinding {
  providerId: string;
  observedAt: string;
  providerSessionId?: string;
  browserProduct?: string;
  windowId?: string;
  tabId?: string;
  ownerToken?: string;
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

export interface ComputerSurfaceTarget {
  schemaVersion: 1;
  targetId: string;
  kind: 'surface';
  stableIdentity: ComputerSurfaceStableIdentity;
  /** Legacy/user-facing identifiers only. They resolve to targetId and never become canonical identity. */
  compatibilityAliases: string[];
  /** Repositories allowed to resolve this target through compatibility APIs. */
  repositoryIds: string[];
  providerBinding?: ComputerSurfaceProviderBinding;
  createdAt: string;
  updatedAt: string;
}

export type ComputerInteractionTarget = ComputerApplicationTarget | ComputerSurfaceTarget;

export interface ComputerInteractionTargetEntry {
  schemaVersion: 1;
  status: 'active' | 'tombstoned';
  target: ComputerInteractionTarget;
  tombstonedAt?: string;
}

export interface ComputerApplicationTargetLease {
  current(): ComputerApplicationTarget;
  bind(binding: ComputerProviderTargetBinding): ComputerApplicationTarget;
  tombstone(): ComputerApplicationTarget;
}

export interface ComputerSurfaceTargetLease {
  current(): ComputerSurfaceTarget;
  bind(binding: ComputerSurfaceProviderBinding): ComputerSurfaceTarget;
  mergeCompatibility(input: { compatibilityAliases?: string[]; repositoryIds?: string[] }): ComputerSurfaceTarget;
  tombstone(): ComputerSurfaceTarget;
}

export interface ComputerInteractionTargetCleanupReport {
  policyVersion: 'computer-target-retention-v1';
  inspected: number;
  activeProtected: number;
  tombstones: number;
  removed: number;
  retained: number;
  overCapacity: boolean;
  budgetExhausted: boolean;
  blockers: string[];
}

/**
 * Sole durable Computer target authority. The legacy application methods stay
 * source-compatible while surface-specific methods share the same persistence,
 * locking, tombstone and retention owner.
 */
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

  createSurface(
    controllerHome: string,
    input: {
      stableIdentity: ComputerSurfaceStableIdentity;
      compatibilityAliases?: string[];
      repositoryIds?: string[];
      providerBinding?: ComputerSurfaceProviderBinding;
    },
  ): ComputerSurfaceTarget;
  getSurface(controllerHome: string, targetId: string): ComputerSurfaceTarget | undefined;
  requireSurface(controllerHome: string, targetId: string): ComputerSurfaceTarget;
  findSurfaceByAlias(controllerHome: string, alias: string, repoId?: string): ComputerSurfaceTarget | undefined;
  listSurfaces(controllerHome: string, options?: { repoId?: string; limit?: number }): ComputerSurfaceTarget[];
  withSurfaceLease<T>(
    controllerHome: string,
    targetId: string,
    operation: (lease: ComputerSurfaceTargetLease) => Promise<T>,
  ): Promise<T>;

  cleanupTombstones(
    controllerHome: string,
    options?: { nowMs?: number; ttlMs?: number; maxTombstones?: number; maxRemovals?: number },
  ): Promise<ComputerInteractionTargetCleanupReport>;
}
