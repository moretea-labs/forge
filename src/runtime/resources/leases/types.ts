import type { ResourceClaimMode } from '../../execution/jobs/types';

export type LeaseVisibility = 'durable' | 'ephemeral';

export interface ExecutionLeaseOwnerIdentity {
  repositoryId: string;
  checkoutId: string;
  worktreeId: string;
  branch: string;
  principalId: string;
  controllerInstanceId: string;
  controllerGeneration: string;
}

export interface ExecutionLease {
  schemaVersion: 1;
  leaseId: string;
  repoId: string;
  /** Exact checkout placement. Historical persisted leases may also carry workId. */
  checkoutId?: string;
  /** Historical compatibility only; new lease acquisition never writes Work attribution. */
  workId?: string;
  resourceKey: string;
  mode: ResourceClaimMode;
  ownerJobId: string;
  /** Authoritative mutation owner. Missing only on pre-migration historical leases. */
  ownerIdentity?: ExecutionLeaseOwnerIdentity;
  ownerIdentityDigest?: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  /** ephemeral = Fast Path ownership: active set only, no scheduler/projection noise */
  visibility?: LeaseVisibility;
}

export interface LeaseAcquisitionOptions {
  /** Default durable (existing Job path). ephemeral skips scheduler/projection/events. */
  visibility?: LeaseVisibility;
  notifyScheduler?: boolean;
  invalidateProjection?: boolean;
  emitRuntimeEvent?: boolean;
  ttlMs?: number;
  ownerIdentity?: ExecutionLeaseOwnerIdentity;
}

export interface LeaseAcquisitionResult {
  acquired: boolean;
  leases: ExecutionLease[];
  blockers: Array<{ resourceKey: string; ownerJobId: string; leaseId: string; mode: ResourceClaimMode; ownerIdentityDigest?: string }>;
}
