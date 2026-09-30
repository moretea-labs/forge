export type WorkflowSupervisorAction = 'CONTINUE' | 'DONE' | 'NEEDS_USER';
export type WorkflowSupervisorState = 'running' | 'done' | 'needs_user';
export type WorkflowSupervisorTerminalState = 'DONE' | 'NEEDS_USER' | 'STOPPED';
/** Machine receipt attached to Forge MCP calls made by an autonomous ChatGPT turn. */
export type WorkflowSupervisorAutomationStatus = 'working' | 'continue' | 'done' | 'needs_user';
export type WorkflowEffectKind = 'enrollment' | 'continuation' | 'correction' | 'recovery';
export type WorkflowEffectOutcome = 'applied' | 'not_applied' | 'unknown';

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

export interface WorkflowContractValidation {
  valid: boolean;
  reason: string;
  evidence?: string[];
}

export interface WorkflowSupervisorValidators {
  completionContract(task: WorkflowSupervisorTask, proposal: WorkflowSupervisorProposal): Promise<WorkflowContractValidation>;
  userBlockerPolicy(task: WorkflowSupervisorTask, proposal: WorkflowSupervisorProposal): Promise<WorkflowContractValidation>;
}
export interface WorkflowSupervisorTurnSettlement {
  continuationAllowed: boolean;
  continuationContext?: string;
  /** Canonical lower-layer non-idempotent send effect identity for the next outer turn. */
  continuationEffectId?: string;
  reason?: string;
}

export interface WorkflowSupervisorLifecycleHooks {
  /** Derived project identity used only for browser discovery; never a lifecycle authority. */
  projectScopeForTask?(task: WorkflowSupervisorTask): WorkflowSupervisorProjectScope | undefined;
  /** Build the one bounded enrollment task for a newly discovered project conversation. */
  discoveredConversationTask?(conversation: WorkflowSupervisorDiscoveredConversation, scope: WorkflowSupervisorProjectScope): WorkflowSupervisorTaskInput | undefined;
  /** Derived from canonical lower-layer lifecycle facts; must not create a second task lifecycle authority. */
  browserTaskActive?(task: WorkflowSupervisorTask): boolean;
  /** Mechanical provenance attached to outbound effect dispatch evidence. */
  effectDispatchEvidence?(): Record<string, unknown>;
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
  /** Idempotent: browser/recovery observation may replay the same completion fingerprint. */
  assistantTurnCommitted?(
    task: WorkflowSupervisorTask,
    completion: WorkflowSupervisorCompletion,
  ): Promise<WorkflowSupervisorTurnSettlement | void>;
  /** Atomically project a newly-created Computer conversation into Work binding authority. */
  bootstrapConversationBound?(task: WorkflowSupervisorTask): void;
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
