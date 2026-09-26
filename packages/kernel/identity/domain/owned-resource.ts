/**
 * Canonical OwnedResource model.
 * 
 * Forge-created resources that must survive, recover, or clean up after a crash
 * carry explicit ownership sufficient to distinguish pre-existing user resources
 * from Forge-owned worktrees, apps, browser tabs, temporary files/directories,
 * and provider targets.
 * 
 * Cleanup is idempotent resource work derived from owned-resource facts,
 * not a semantic phase.
 */

export type OwnedResourceKind =
  | 'worktree'
  | 'git_branch'
  | 'browser_tab'
  | 'browser_context'
  | 'temp_dir'
  | 'temp_file'
  | 'process'
  | 'provider_target'
  | 'tunnel';

export type OwnedResourceStatus = 'active' | 'retained' | 'released' | 'failed_cleanup';

export interface OwnedResourceProvenance {
  creator: string; // e.g. 'forge:worktree-manager', 'forge:browser-pool', 'work:work-123'
  createdAt: string;
  associatedWorkId?: string;
  associatedRequirementId?: string;
  repoId?: string;
}

export interface OwnedResourceRetention {
  intent: 'temporary' | 'retain_on_failure' | 'persistent_until_explicit_release';
  expiresAt?: string;
}

/**
 * Kind-specific locator space. Cleanup must resolve the resource through its
 * owning target's own semantics instead of reinterpreting a shared string shape:
 * a Windows path, WSL path, macOS path, Git ref, browser tab id, pid and provider
 * target are not interchangeable locators.
 */
export type OwnedResourceLocatorKind =
  | 'filesystem_path'
  | 'git_ref'
  | 'browser_tab_id'
  | 'browser_context_id'
  | 'process_id'
  | 'provider_target'
  | 'tunnel_id';

export interface OwnedResourceLocator {
  kind: OwnedResourceLocatorKind;
  value: string;
}

export interface OwnedResource {
  schemaVersion: 1;
  resourceId: string;
  kind: OwnedResourceKind;
  targetRef: string; // e.g. path, branch name, tab id, pid
  /** ForgeInstance that created or adopted the resource; cleanup runs on this owner. */
  ownerForgeInstanceId?: string;
  /** Kind-specific locator resolved on the owning ForgeInstance. */
  locator?: OwnedResourceLocator;
  /** Stable fingerprint of the locator, so a recycled path/id cannot be reclaimed as the same resource. */
  identityFingerprint?: string;
  /** Whether Forge owns enough provenance to release this resource. */
  cleanupCapable?: boolean;
  provenance: OwnedResourceProvenance;
  retention: OwnedResourceRetention;
  status: OwnedResourceStatus;
  updatedAt: string;
  cleanupProof?: {
    cleanedAt: string;
    cleanedBy: string;
    receiptRef?: string;
  };
}

export interface RecordOwnedResourceInput {
  resourceId?: string;
  kind: OwnedResourceKind;
  targetRef: string;
  creator: string;
  ownerForgeInstanceId?: string;
  locator?: OwnedResourceLocator;
  identityFingerprint?: string;
  cleanupCapable?: boolean;
  associatedWorkId?: string;
  associatedRequirementId?: string;
  repoId?: string;
  retentionIntent?: OwnedResourceRetention['intent'];
  expiresAt?: string;
}

const LOCATOR_KIND_BY_RESOURCE: Record<OwnedResourceKind, OwnedResourceLocatorKind> = {
  worktree: 'filesystem_path',
  git_branch: 'git_ref',
  browser_tab: 'browser_tab_id',
  browser_context: 'browser_context_id',
  temp_dir: 'filesystem_path',
  temp_file: 'filesystem_path',
  process: 'process_id',
  provider_target: 'provider_target',
  tunnel: 'tunnel_id',
};

/** Kind-specific locator for a resource target. Locator kinds are never interchangeable. */
export function ownedResourceLocator(kind: OwnedResourceKind, targetRef: string): OwnedResourceLocator {
  const value = targetRef.trim();
  if (!value) throw new Error('OWNED_RESOURCE_TARGET_REQUIRED');
  return { kind: LOCATOR_KIND_BY_RESOURCE[kind], value };
}
