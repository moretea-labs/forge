export type AutopilotRunStatus = 'running' | 'paused' | 'completed' | 'blocked' | 'failed' | 'cancelled';

export interface AutopilotPolicy {
  provider: 'deepseek' | 'joycode';
  endpoint: string;
  protocol: 'chat_completions' | 'responses';
  model: string;
  maxTotalTokens: number;
  maxTurns: number;
  maxToolCalls: number;
  checkpointPlanIds: string[];
}

export interface AutopilotUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  toolCalls: number;
}

export interface AutopilotRun {
  schemaVersion: 1;
  runId: string;
  repoId: string;
  checkoutId: string;
  requirementId: string;
  requirementRevision: number;
  grantId: string;
  status: AutopilotRunStatus;
  policy: AutopilotPolicy;
  usage: AutopilotUsage;
  currentPlanId?: string;
  lastSummary?: string;
  stopReason?: string;
  /** Recovery-only correlation to Forge's canonical Process; not a second execution status owner. */
  pendingProcessId?: string;
  /** Stable request identity written before effect admission; Process Runtime owns dedupe. */
  pendingCommandRequestId?: string;
  evidenceRefs: string[];
  inspectionStreak?: number;
  recentToolNames?: string[];
  budgetBaseline?: {
    totalTokens: number;
    turns: number;
    toolCalls: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotDecision {
  action: 'continue' | 'pause' | 'complete' | 'blocked';
  summary: string;
  currentPlanId?: string;
  nextObjective?: string;
  evidenceRefs?: string[];
}

export interface AutopilotModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
