export interface ComputerApplicationStableIdentity {
  bundleId?: string;
  appName?: string;
}

/** Live application-provider session identity is an observed/rebuildable binding, never durable target identity. */
export interface ComputerProviderTargetBinding {
  providerId: string;
  providerSessionId: string;
  observedAt: string;
  /** Rebuildable exact native process observation for cross-target lifecycle fencing. */
  processId?: number;
}

export type ComputerApplicationLaunchProvenance =
  | { kind: 'preexisting' }
  | { kind: 'provider_launched'; processId: number };

export type ComputerSurfaceType = 'browser-tab' | 'browser-page';
export type ComputerSurfaceOwnership = 'plugin_owned' | 'user_owned' | 'provider_owned';
export type ComputerSurfaceVisibility = 'repositories' | 'controller';

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

/** Opaque, bounded compatibility payload owned semantically by its namespace adapter. */
export interface ComputerSurfaceCompatibilityRecord {
  namespace: string;
  schemaVersion: number;
  value: Record<string, unknown>;
  updatedAt: string;
}

export interface ComputerApplicationTarget {
  schemaVersion: 1;
  targetId: string;
  kind: 'application';
  stableIdentity: ComputerApplicationStableIdentity;
  /** Durable launch fact. Missing means a legacy provider supplied no trustworthy provenance. */
  launchProvenance?: ComputerApplicationLaunchProvenance;
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
  /** Explicit visibility replaces legacy implicit native-session global visibility. */
  visibility: ComputerSurfaceVisibility;
  /** Repositories that created or observed this target; used when visibility=repositories. */
  repositoryIds: string[];
  /** Bounded opaque adapter records; these do not create a separate persistence authority. */
  compatibilityRecords: ComputerSurfaceCompatibilityRecord[];
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
  putCompatibility(record: ComputerSurfaceCompatibilityRecord): ComputerSurfaceTarget;
  tombstone(): ComputerSurfaceTarget;
}

export interface ComputerSurfaceUpsertInput {
  stableIdentity: ComputerSurfaceStableIdentity;
  compatibilityAliases?: string[];
  visibility?: ComputerSurfaceVisibility;
  repositoryIds?: string[];
  compatibilityRecords?: ComputerSurfaceCompatibilityRecord[];
  providerBinding?: ComputerSurfaceProviderBinding;
  /** Migration may seed a tombstone. Steady-state callers normally omit this. */
  initialStatus?: 'active' | 'tombstoned';
  /** Migration preserves an existing status; fresh authoritative writes may reactivate. */
  reactivate?: boolean;
}

export interface ComputerSurfaceUpsertResult {
  target: ComputerSurfaceTarget;
  status: 'active' | 'tombstoned';
  created: boolean;
}

export interface ComputerCompatibilityMigrationMarker {
  schemaVersion: 1;
  migrationId: string;
  scopeId: string;
  status: 'closed';
  closedAt: string;
  importedRecordCount: number;
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
    input: {
      stableIdentity: ComputerApplicationStableIdentity;
      launchProvenance?: ComputerApplicationLaunchProvenance;
      providerBinding?: ComputerProviderTargetBinding;
    },
  ): ComputerApplicationTarget;
  get(controllerHome: string, targetId: string): ComputerApplicationTarget | undefined;
  require(controllerHome: string, targetId: string): ComputerApplicationTarget;
  listAllApplications(controllerHome: string): ComputerApplicationTarget[];
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
      visibility?: ComputerSurfaceVisibility;
      repositoryIds?: string[];
      compatibilityRecords?: ComputerSurfaceCompatibilityRecord[];
      providerBinding?: ComputerSurfaceProviderBinding;
    },
  ): ComputerSurfaceTarget;
  upsertSurface(controllerHome: string, input: ComputerSurfaceUpsertInput): ComputerSurfaceUpsertResult;
  getSurface(controllerHome: string, targetId: string): ComputerSurfaceTarget | undefined;
  requireSurface(controllerHome: string, targetId: string): ComputerSurfaceTarget;
  findSurfaceByAlias(controllerHome: string, alias: string, repoId?: string): ComputerSurfaceTarget | undefined;
  findSurfaceByProviderBinding(controllerHome: string, binding: ComputerSurfaceProviderBinding): ComputerSurfaceTarget | undefined;
  listSurfaces(controllerHome: string, options?: { repoId?: string; limit?: number }): ComputerSurfaceTarget[];
  listAllSurfaces(controllerHome: string, options?: { repoId?: string }): ComputerSurfaceTarget[];
  compatibilityMigrationMarker(controllerHome: string, migrationId: string, scopeId: string): ComputerCompatibilityMigrationMarker | undefined;
  closeCompatibilityMigration(controllerHome: string, input: { migrationId: string; scopeId: string; importedRecordCount: number }): ComputerCompatibilityMigrationMarker;
  tombstoneSurface(controllerHome: string, targetId: string): boolean;
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
