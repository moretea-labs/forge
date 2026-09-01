/** Canonical Kernel Controller contracts. Provider bindings are opaque to Kernel. */
export type ControllerType = 'chatgpt' | 'codex' | 'grok' | 'claude' | 'human';

export interface ControllerSession {
  schemaVersion: 1;
  workId: string;
  controllerId: string;
  controllerType: ControllerType;
  sessionId: string;
  /** SHA-256 digest of the non-relay Work-bound controller capability. The plaintext capability is returned only to the claimant. */
  authorityDigest?: string;
  /** Authenticated authority that owned the claim; legacy records may omit it. */
  principalId?: string;
  /** Controller process/epoch that admitted the transport session. */
  controllerInstanceId?: string;
  /** Monotonic ownership fence. It changes only when ownership moves. */
  claimGeneration?: number;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface ControllerSessionStore {
  schemaVersion: 1;
  updatedAt: string;
  sessions: ControllerSession[];
}


export interface ControllerBinding {
  bindingId: string;
  hostKind: ControllerType;
  /** Opaque adapter-owned reference. Kernel never parses provider metadata. */
  adapterRef: string;
}

export interface ControllerLease {
  workId: string;
  controllerId: string;
  sessionId: string;
  claimGeneration: number;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface ControllerRoundContext {
  workId: string;
  relayScopeId: string;
  roundNumber: number;
  authorityId: string;
  continuationPrompt: string;
}
