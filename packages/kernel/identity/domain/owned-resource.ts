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

export interface OwnedResource {
  schemaVersion: 1;
  resourceId: string;
  kind: OwnedResourceKind;
  targetRef: string; // e.g. path, branch name, tab id, pid
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
  associatedWorkId?: string;
  associatedRequirementId?: string;
  repoId?: string;
  retentionIntent?: OwnedResourceRetention['intent'];
  expiresAt?: string;
}
