/** Canonical ControllerSession claim/release/fencing application surface. */
export {
  assertControllerOwnershipAuthority,
  bindControllerSessionToCurrentRuntime,
  claimControllerSession,
  controllerSessionAuthorityMatches,
  controllerSessionBlocksRecovery,
  controllerSessionPrincipalId,
  controllerTerminalizationAuthorityFromSession,
  getControllerSession,
  getRetainedControllerSession,
  listControllerSessions,
  mintControllerSessionAuthority,
  releaseControllerSession,
  releaseControllerSessionWithAuthority,
  releaseObservedControllerSession,
  requireControllerOwnershipAuthority,
  resumeControllerSession,
  withControllerSessionTerminalizationFence,
  type ControllerOwnershipAuthority,
  type ControllerSessionClaimInput,
  type ControllerSessionStoreOptions,
  type ControllerTerminalizationAuthority,
  type ControllerTerminalizationFenceReason,
  type ControllerTerminalizationFenceResult,
} from '../infrastructure/controller-session-store';
export type { ControllerBinding, ControllerLease, ControllerRoundContext, ControllerSession, ControllerSessionStore, ControllerType } from '../domain/types';
export type { ControllerHost, ControllerHostResumeResult } from '../ports/controller-host';
export { bindControllerSessionBinding, getControllerSessionBinding, type ControllerSessionBindingRecord } from '../infrastructure/controller-binding-store';
