export type WorkflowSupervisorAction = 'CONTINUE' | 'WAIT' | 'DONE' | 'NEEDS_USER';
export type WorkflowSupervisorState = 'running' | 'waiting' | 'done' | 'needs_user';
export type WorkflowSupervisorTerminalState = 'DONE' | 'NEEDS_USER' | 'STOPPED';
/** Machine receipt attached to Forge MCP calls made by an autonomous ChatGPT turn. */
export type WorkflowEffectKind = 'enrollment' | 'continuation' | 'correction' | 'recovery';
export type WorkflowEffectOutcome = 'applied' | 'not_applied' | 'unknown';

/** Minimal machine-readable context carried into one autonomous provider turn. */
export interface WorkflowSupervisorTurnEnvelope {
  schema_version: 2;
  identity: {
    task_id: string;
    effect_id: string;
    kind: WorkflowEffectKind;
  };
  /** Semantic outcome to pursue. It is context, not an execution-plan DSL. */
  goal?: {
    role: 'outcome';
    objective: string;
  };
  /** Prior-turn continuity is evidence for orientation, never an execution constraint. */
  continuity?: {
    role: 'advisory';
    summary: string;
  };
  repository?: {
    repo_id: string;
    checkout_id?: string;
  };
  cognition?: {
    role: 'advisory';
    projection: string;
  };
  /** Final assistant reply receipt. No intermediate MCP call can end a turn. */
  receipt: { challenge: string };
}

export interface WorkflowSupervisorProposal {
  action: WorkflowSupervisorAction;
  sourceEffectId: string;
  checkpoint: string;
  reason: string;
  evidence: string[];
  /** Required by newly-rendered prompts; optional only for already-reserved legacy effects. */
  conversationId?: string;
  /** Stable Supervisor task identity, distinct from lower-layer Work authority. */
  taskId?: string;
  /** Redundant with action by design so a response carries an explicit machine state. */
  supervisorState?: WorkflowSupervisorState;
  /** Exact durable lower-layer relay scope such as requirement:<id> or goal:<id>. */
  activeScope?: string;
}

export interface WorkflowSupervisorTaskInput {
  taskId: string;
  conversationId: string;
  conversationUrl: string;
  objective: string;
  completionContract: Record<string, unknown>;
  continuationPolicy: Record<string, unknown>;
  userBlockerPolicy: Record<string, unknown>;
}

/** Identity-bound external notification, not GitHub review or merge authorization. */
export interface WorkflowSupervisorReviewNotice {
  taskId: string;
  repoId: string;
  prNumber: number;
  reviewedHeadSha: string;
  currentHeadSha: string;
  reviewId: string;
  source: 'github_review' | 'github_ci' | 'independent_reviewer';
  outcome: 'ACCEPT' | 'REVISE' | 'BLOCK' | 'COMMENTED' | 'CI_FAILED' | 'CI_PASSED';
}

export interface WorkflowSupervisorTask extends WorkflowSupervisorTaskInput {
  createdAt: string;
}

export interface WorkflowSupervisorEffect {
  effectId: string;
  taskId: string;
  kind: WorkflowEffectKind;
  sourceCompletionFingerprint?: string;
  prompt: string;
  createdAt: string;
}

export interface WorkflowSupervisorProviderTurnEvent {
  providerId: 'browser.chrome-extension';
  providerInstanceId: string;
  taskId: string;
  conversationId: string;
  conversationUrl: string;
  effectId: string;
  receiptChallenge: string;
  turnId: string;
  requestId: string;
  startedAtMs: number;
  observedAtMs: number;
  outcome: 'completed' | 'failed';
  statusCode: number;
  contentType?: string;
  assistantMessageId?: string;
  assistantStatus?: string;
  assistantEndTurn?: boolean;
  streamDone?: boolean;
  failureCode?: string;
  retryAfterMs?: number;
}

export interface WorkflowSupervisorProviderTurnReceipt extends WorkflowSupervisorProviderTurnEvent {
  dispatchGeneration: number;
  dispatchEventId: number;
  recordedAt: string;
}

export type WorkflowSupervisorProviderTurnEventResult =
  | { accepted: true; duplicate: boolean; receipt: WorkflowSupervisorProviderTurnReceipt }
  | { accepted: false; retryable: boolean; reason: string };

export interface WorkflowSupervisorCompletion {
  completionFingerprint: string;
  taskId: string;
  sourceEffectId: string;
  action: WorkflowSupervisorAction;
  responseSha256: string;
  controlBlockSha256: string;
  proposal: WorkflowSupervisorProposal;
  committedAt: string;
}

/** Read-only proof derived from the existing effect/completion ledger. */
export interface WorkflowSupervisorContinuationProof {
  taskId: string;
  conversationId: string;
  activeReleaseId: string;
  actions: ['CONTINUE', 'CONTINUE', 'DONE'];
  completionFingerprints: [string, string, string];
  sourceEffectIds: [string, string, string];
  runtimeInstanceIds: string[];
  firstCommittedAt: string;
  lastCommittedAt: string;
}

/** Ephemeral operational projection for the single native Supervisor effect consumer. */
export interface WorkflowSupervisorConsumerStatus {
  enabled: boolean;
  running: boolean;
  observedAt: string;
  lastTickStartedAt?: string;
  lastTickCompletedAt?: string;
  lastCommandAttemptAt?: string;
  nextAttemptAt?: string;
  transportFailureStreak: number;
  providerBackpressureMs: number;
  stalled: boolean;
  dueCommands?: Array<{
    taskId: string;
    conversationId: string;
    effectId: string;
    mode: 'send' | 'reconcile';
    kind: WorkflowEffectKind;
    createdAt?: string;
    ageMs?: number;
  }>;
  taskFailures?: Array<{
    taskId: string;
    code: string;
    observedAt: string;
    effectId?: string;
  }>;
  lastFailure?: {
    code: string;
    observedAt: string;
    taskId?: string;
    effectId?: string;
  };
  /** Per-task applied turns whose visible provider output has stopped changing. */
  awaitingReceiptSilences?: Array<WorkflowSupervisorSilentTurn & {
    taskId: string;
    conversationId: string;
    /** Latest committed Task receipt, not completion of the currently unresolved Effect. */
    lastCommittedCompletion: Pick<WorkflowSupervisorCompletion, 'sourceEffectId' | 'completionFingerprint' | 'committedAt'> | null;
  }>;
  /** Latest successful exact-effect page observation per task in this adapter instance.
   * Absent after restart or settlement; never completion or meaningful-progress proof. */
  lastProviderObservations?: Array<{ taskId: string; effectId: string; conversationId: string; observedAt: string }>;
}

export interface WorkflowContractValidation {
  valid: boolean;
  reason: string;
  evidence?: string[];
}

/**
 * Derived, read-only classification of a non-terminal task's causal position.
 * A mechanically exhausted effect used to make its task silently leave the
 * delivery queue with no durable projection; this makes that state visible and
 * names the exact operator action that can move the task forward.
 */
export interface WorkflowSupervisorPreflightComposerObservation {
  /** Diagnostic of the existing editor before Send, never a draft writer or replay authority. */
  chars: number;
  fingerprint: string;
  classification: 'empty' | 'current_effect' | 'other_effect' | 'unattributed' | 'unavailable';
  selectorVersion?: string;
}

/**
 * Derived from the existing provider-state events: the visible assistant output
 * has not changed while the provider still advertises activity. This is honest
 * progress feedback, never an inference that work is succeeding and never a
 * resend authorization.
 */
export interface WorkflowSupervisorSilentTurn {
  effectId: string;
  providerState: 'generating' | 'idle';
  /** Timestamp of the first durable applied event for this exact effect. */
  effectAppliedAt: string;
  /** Absolute unresolved-effect age; assistant digest changes never reset it. */
  effectElapsedMs: number;
  /** Start of the current unchanged provider-state/output-digest interval; not a progress timestamp. */
  observedSince: string;
  /** Duration of the current unchanged provider-state/output-digest interval. */
  elapsedMs: number;
  /** The existing bounded review threshold, anchored to effect application. */
  recoveryGraceMs: number;
  recoveryReviewAt: string;
  /** Silence alone never authorizes replaying an already-applied Send. */
  resendAuthorized: false;
}

export type WorkflowSupervisorTaskStall =
  | { state: 'terminal' }
  | { state: 'deliverable'; effectId: string; mode: 'send' | 'reconcile'; generation: number }
  | { state: 'spaced'; effectId?: string; reason: 'retry_spacing' | 'unknown_observation_spacing' | 'awaiting_completion_receipt' | 'pre_send_infrastructure_blocked'; preflightReasonCode?: string; preflightComposerObservation?: WorkflowSupervisorPreflightComposerObservation; silentTurn?: WorkflowSupervisorSilentTurn }
  | { state: 'retryable'; effectId: string; generations: number; maxGenerations: number }
  | { state: 'provider_resume_exhausted'; effectId: string; silentTurn?: WorkflowSupervisorSilentTurn }
  | { state: 'waiting'; scheduleId: string; completionFingerprint: string }
  | { state: 'inert' };

export interface WorkflowSupervisorValidators {
  completionContract(task: WorkflowSupervisorTask, proposal: WorkflowSupervisorProposal): Promise<WorkflowContractValidation>;
  userBlockerPolicy(task: WorkflowSupervisorTask, proposal: WorkflowSupervisorProposal): Promise<WorkflowContractValidation>;
}
export interface WorkflowSupervisorLifecycleHooks {
  /** Resolve the current canonical Work objective at prompt generation time. */
  canonicalObjectiveForTask?(task: WorkflowSupervisorTask): string | undefined;
  /** Bounded cognition only; never carries lower-layer authority or lifecycle state. */
  advisoryCognitionForTask?(task: WorkflowSupervisorTask): string | undefined;
  /** Derived project identity used only for browser discovery; never a lifecycle authority. */
  projectScopeForTask?(task: WorkflowSupervisorTask): WorkflowSupervisorProjectScope | undefined;
  /** Build the one bounded enrollment task for a newly discovered project conversation. */
  discoveredConversationTask?(conversation: WorkflowSupervisorDiscoveredConversation, scope: WorkflowSupervisorProjectScope): WorkflowSupervisorTaskInput | undefined;
  /** Exact Work-owned terminal transition, projected into the one Supervisor stop-event writer. */
  terminalWorkStopReasonForTask?(task: WorkflowSupervisorTask): string | undefined;
  /** Admission for a new send only. Never suppress observation of an already-started effect. */
  browserTaskActive?(task: WorkflowSupervisorTask): boolean;
  /** Mechanical provenance attached to outbound effect dispatch evidence. */
  effectDispatchEvidence?(input: { task: WorkflowSupervisorTask; effectId: string }): Record<string, unknown>;
  /**
   * Mechanical projection of the canonical Work the turn is meant to advance.
   * Comparison of the value captured at dispatch with the value observed at
   * receipt is the only structural proof that a provider turn changed anything.
   * Absent means the lower layer exposes no such signal, which is never treated
   * as progress or as its absence.
   */
  workProgressFingerprint?(task: WorkflowSupervisorTask): string | undefined;
  /** Existing lower-layer evidence that this exact reserved effect may already have been dispatched outside Supervisor. */
  inheritedEffectDispatch?(
    task: WorkflowSupervisorTask,
    effect: WorkflowSupervisorEffect,
  ): { generation: number; dispatchId: string; evidence: Record<string, unknown> } | undefined;
  /** Idempotent: browser delivery observation may replay the same applied effect. */
  effectApplied?(
    task: WorkflowSupervisorTask,
    effect: WorkflowSupervisorEffect,
    observation: { observationId: string; evidence?: Record<string, unknown> },
  ): void;
  /** Atomically project a newly-created Computer conversation into Work binding authority. */
  bootstrapConversationBound?(
    task: WorkflowSupervisorTask,
    context?: { migratedFromConversationId?: string; migrationRequestId?: string },
  ): void;
}

export interface WorkflowAssistantObservation {
  taskId: string;
  conversationId: string;
  responseText: string;
}

export interface WorkflowAssistantObservationResult {
  action: WorkflowSupervisorAction;
  completionFingerprint: string;
  terminal: boolean;
  successorEffect?: WorkflowSupervisorEffect;
  validation?: WorkflowContractValidation;
  deduplicated: boolean;
}

export interface WorkflowSupervisorBrowserTask {
  taskId: string;
  conversationId: string;
  conversationUrl: string;
}

export interface WorkflowSupervisorDiscoveredConversation {
  conversationId: string;
  canonicalUrl: string;
  title?: string;
  projectTitle?: string;
  projectUrl?: string;
}

export interface WorkflowSupervisorDiscoverySnapshot {
  observedAt: string;
  conversations: WorkflowSupervisorDiscoveredConversation[];
}

export interface WorkflowSupervisorProjectScope {
  title: string;
  /** Additional stable names used by the external Project surface. */
  aliases?: string[];
  repoId?: string;
  controllerHome?: string;
}

export interface WorkflowSupervisorBrowserCommand {
  mode: 'send' | 'reconcile';
  effectId: string;
  kind: WorkflowEffectKind;
  prompt: string;
  dispatchGeneration: number;
  conversationId: string;
  conversationUrl: string;
}

export interface WorkflowSupervisorBrowserPollResult {
  authorized: true;
  task: WorkflowSupervisorBrowserTask;
  terminal?: WorkflowSupervisorTerminalState;
  command?: WorkflowSupervisorBrowserCommand;
}
