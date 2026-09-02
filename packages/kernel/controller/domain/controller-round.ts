import type { ControllerType } from './types';

export const CONTROLLER_ROUND_DISPOSITIONS = [
  'continue_immediately',
  'wait',
  'wait_for_user',
  'goal_complete',
] as const;
export type ControllerRoundDisposition = (typeof CONTROLLER_ROUND_DISPOSITIONS)[number];

export const CONTROLLER_RELAY_ABANDONED_RELEASE_ERROR = 'CONTROLLER_RELAY_CLAIM_RELEASED_WITHOUT_DISPOSITION';

export type ControllerRoundLifecycleStage =
  | 'dispatching'
  | 'dispatch_confirmed'
  | 'controller_claimed'
  | 'semantic_round_closed';

export type ControllerRoundRelayStatus =
  | 'pending_release'
  | 'dispatching'
  | 'dispatched'
  | 'claimed'
  | 'waiting'
  | 'waiting_for_user'
  | 'goal_complete'
  | 'blocked'
  | 'failed';

export interface ControllerRoundRelayRecord {
  schemaVersion: 1;
  repoId: string;
  relayScopeId: string;
  originWorkId: string;
  requirementId?: string;
  disposition: ControllerRoundDisposition;
  status: ControllerRoundRelayStatus;
  /** Durable semantic stage; transport/session state must never substitute for lifecycle authority. */
  lifecycleStage?: ControllerRoundLifecycleStage;
  controllerId: string;
  controllerType: ControllerType;
  principalId: string;
  controllerInstanceId: string;
  sessionId: string;
  claimGeneration: number;
  /** Opaque per-round capability. Rotates when Forge dispatches a new controller round. */
  authorityId?: string;
  stateFingerprint: string;
  roundCount: number;
  repeatedStateCount: number;
  consecutiveFailures: number;
  maxRounds: number;
  maxRepeatedState: number;
  maxFailures: number;
  handoffId?: string;
  reason?: string;
  /** Opaque provider binding owned by a ControllerHost adapter. */
  bindingId?: string;
  blockedReason?: string;
  lastError?: string;
  nextRecoveryAt?: string;
  submittedAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  claimedAt?: string;
}

export interface ControllerRoundRelayIdentity {
  controllerId: string;
  controllerType: ControllerType;
  principalId: string;
  controllerInstanceId: string;
  sessionId: string;
}
