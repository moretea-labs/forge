export type ScheduledContinuationDispatchStatus =
  | 'prepared'
  | 'dispatching'
  | 'dispatched'
  | 'rejected'
  | 'outcome_unknown';

export interface ScheduledContinuationDispatch {
  schemaVersion: 1;
  repoId: string;
  scheduleId: string;
  occurrenceId: string;
  workId: string;
  controllerSessionId: string;
  controllerBindingId: string;
  relayScopeId: string;
  controllerAuthorityId?: string;
  status: ScheduledContinuationDispatchStatus;
  hostDispatchId?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledControllerContinuationInput {
  scheduleId: string;
  occurrenceId: string;
  workId: string;
  controllerSessionId: string;
  controllerBindingId: string;
  relayScopeId?: string;
  continuationHint?: string;
}
