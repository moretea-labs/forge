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
  /** ephemeral = Fast Path ownership without scheduler/projection noise; release and expiry receipts remain durable. */
  visibility?: LeaseVisibility;
}

export interface LeaseAcquisitionOptions {
  /** Default durable. ephemeral suppresses scheduler/projection and acquisition-event noise; release/expiry receipts remain durable. */
  visibility?: LeaseVisibility;
  notifyScheduler?: boolean;
  invalidateProjection?: boolean;
  /** Controls lease_acquired receipts only; release and expiry receipts are always persisted. */
  emitRuntimeEvent?: boolean;
  ttlMs?: number;
  ownerIdentity?: ExecutionLeaseOwnerIdentity;
}

export interface LeaseAcquisitionResult {
  acquired: boolean;
  leases: ExecutionLease[];
  blockers: Array<{ resourceKey: string; ownerJobId: string; leaseId: string; mode: ResourceClaimMode; ownerIdentityDigest?: string }>;
}
