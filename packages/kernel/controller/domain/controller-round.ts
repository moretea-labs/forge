import type { AssistantContextSnapshot, ClosedRoundObservation, ExecutionQualityAdjustmentResult, ExecutionQualityDecision } from './execution-quality';
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
  | 'handed_off'
  | 'blocked'
  | 'failed';

export type ControllerRoundFailureClass = 'terminal_work' | 'abandoned_release';

export interface ControllerRoundRelayRecord {
  schemaVersion: 1;
  repoId: string;
  relayScopeId: string;
  originWorkId: string;
  /** Previous Work when this round was mechanically handed across a Plan successor. */
  predecessorWorkId?: string;
  /** Already-admitted successor Work selected by GoalWorkloop; never selected by ControllerRound. */
  successorWorkId?: string;
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
  /** Round owner appends only at semantic close; oldest entries expire with this bounded record. */
  observationWindow?: ClosedRoundObservation[];
  qualityDecisions?: ExecutionQualityDecision[];
  /** Verified post-adjustment outcomes; these never reset ControllerRound budgets. */
  qualityAdjustmentResults?: ExecutionQualityAdjustmentResult[];
  /** Exact bounded assistant context identity delivered for the currently claimed round. */
  assistantContextSnapshot?: AssistantContextSnapshot;
  /** Provider-neutral evidence that the exact Controller turn visibly settled. Never a semantic disposition by itself. */
  controllerTurnCompletionEvidenceId?: string;
  controllerTurnSettledAt?: string;
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
  /** Stable provider-neutral identity for the exact external dispatch responsibility. */
  providerDispatchEffectId?: string;
  /** Monotonic provider-effect attempt within one semantic round authority. */
  providerDispatchAttempt?: number;
  /** Monotonic historical provider failures; recovery epochs never erase it. */
  providerFailureTotal?: number;
  /** Bounded provider-recovery epoch for the same semantic round. */
  providerRecoveryEpoch?: number;
  providerRecoveryEvidenceId?: string;
  providerFailureEvidenceId?: string;
  providerEffectReconciliationEvidenceId?: string;
  providerDispatchStartedAt?: string;
  /** Canonical provider-dispatch receipt for this semantic round. Trigger occurrences never duplicate this lifecycle truth. */
  providerDispatchReceiptId?: string;
  /** Explicit schedule/manual/replan occurrence identity when a prior lineage exists. */
  occurrenceId?: string;
  blockedReason?: string;
  /** Typed failed-lineage classification. lastError remains diagnostic text only. */
  failureClass?: ControllerRoundFailureClass;
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
