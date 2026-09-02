export type ScheduledContinuationDispatchStatus =
  | 'prepared'
  | 'dispatching'
  | 'dispatched'
  | 'wait_for_user'
  | 'rejected'
  | 'outcome_unknown';

export interface ScheduledContinuationDispatch {
  schemaVersion: 1;
  repoId: string;
  scheduleId: string;
  occurrenceId: string;
  workId: string;
  /** Observed transport/session at initial dispatch; never part of semantic occurrence identity. */
  controllerSessionId: string;
  controllerBindingId: string;
  relayScopeId: string;
  controllerAuthorityId?: string;
  status: ScheduledContinuationDispatchStatus;
  /** Projection of ControllerRound.providerDispatchReceiptId for occurrence replay diagnostics. */
  hostDispatchId?: string;
  handoffId?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledControllerContinuationInput {
  scheduleId: string;
  occurrenceId: string;
  workId: string;
  /** Observed transport/session at initial dispatch; never part of semantic occurrence identity. */
  controllerBindingId: string;
  relayScopeId?: string;
  continuationHint?: string;
}
