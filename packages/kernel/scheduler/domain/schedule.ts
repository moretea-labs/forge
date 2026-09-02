export type ScheduleExecutionPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface ScheduleResourceClaim {
  resourceKey: string;
  mode: 'read' | 'write' | 'exclusive';
  quantity?: number;
  repoId?: string;
  checkoutId?: string;
  workId?: string;
}

export type ScheduleTriggerType =
  | 'interval'
  | 'cron'
  | 'calendar'
  | 'condition'
  | 'repository-event'
  | 'dependency-checkpoint'
  | 'manual';

export interface ScheduleCondition {
  kind: 'repository_clean' | 'job_succeeded' | 'job_terminal';
  jobId?: string;
}

export interface ScheduleTrigger {
  type: ScheduleTriggerType;
  everyMinutes?: number;
  cronExpression?: string;
  timezone?: string;
  catchUpMinutes?: number;
  calendarAt?: string;
  condition?: ScheduleCondition;
  eventName?: string;
  dependencyJobIds?: string[];
}

export interface ScheduleTriggerContext {
  source?: 'timer' | 'manual' | 'repository-event' | 'dependency-checkpoint' | 'condition';
  eventName?: string;
  eventId?: string;
  data?: Record<string, unknown>;
}

export interface SchedulePolicy {
  maxActiveOccurrences: number;
  maxFailures: number;
  cooldownMinutes: number;
  dailyBudgetMinutes: number;
  shadowMode: boolean;
  backoffBaseMinutes?: number;
  backoffMaxMinutes?: number;
}

export interface ScheduleAction {
  operation: string;
  target?: 'repository' | 'runtime' | 'controller' | 'external';
  arguments?: Record<string, unknown>;
  priority?: ScheduleExecutionPriority;
  resourceClaims?: ScheduleResourceClaim[];
}

export interface RepositorySchedule {
  schemaVersion: 1;
  revision: number;
  scheduleId: string;
  requestId: string;
  repoId: string;
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  policy: SchedulePolicy;
  action: ScheduleAction;
  stopConditions: string[];
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt?: string;
  lastOccurrenceId?: string;
  consecutiveFailures: number;
  consecutiveNoops?: number;
  nextEligibleAt?: string;
  pausedReason?: string;
  /** Last deterministic external observation for observation-driven schedules. */
  lastObservationAt?: string;
  lastObservationFingerprint?: string;
  lastObservationChangedAt?: string;
  lastObservationStatus?: 'baseline' | 'unchanged' | 'changed' | 'keepalive' | 'auth_required';
}

export type ScheduleDecisionType =
  | 'nothing_to_do'
  | 'would_execute'
  | 'execute'
  | 'cooldown'
  | 'budget_exhausted'
  | 'active_occurrence'
  | 'stopped'
  | 'operation_blocked'
  | 'maintenance_not_ready'
  | 'trigger_not_due'
  | 'condition_not_met'
  | 'dependency_not_ready'
  | 'event_not_matched';

export interface ScheduleDecision {
  schemaVersion: 1;
  revision: number;
  decisionId: string;
  occurrenceId: string;
  scheduleId: string;
  repoId: string;
  requestId: string;
  decision: ScheduleDecisionType;
  reason?: string;
  triggerContext?: ScheduleTriggerContext;
  evidence?: Record<string, unknown>;
  createdAt: string;
}

export interface ScheduleOccurrence {
  schemaVersion: 1;
  revision: number;
  occurrenceId: string;
  scheduleId: string;
  repoId: string;
  windowKey: string;
  status: 'created' | 'shadowed' | 'queued' | 'running' | 'dispatched' | 'succeeded' | 'failed' | 'skipped';
  decision: ScheduleDecisionType;
  decisionId?: string;
  triggerContext?: ScheduleTriggerContext;
  createdAt: string;
  updatedAt: string;
  jobId?: string;
  handoffId?: string;
  reason?: string;
}
