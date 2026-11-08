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
  evidenceRefs: string[];
  inspectionStreak?: number;
  recentToolNames?: string[];
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
