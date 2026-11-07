export type ProcessCheckReceiptStatus = 'passed' | 'failed' | 'timed_out' | 'cancelled';
export type ProcessCheckReceiptRuntimeStatus = 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

/** Stable evidence produced by Process Runtime and consumed by current EditSession/Issue/Task flows. */
export interface ProcessCheckReceiptEvidence {
  schemaVersion: 1;
  receiptId: string;
  resultDigest: string;
  repoId: string;
  checkoutId?: string;
  executionSessionId?: string;
  editSessionId?: string;
  editRevision?: number;
  issueId?: string;
  taskId?: string;
  checkId: string;
  requestId?: string;
  processId: string;
  commandId?: string;
  sourceCheckoutId?: string;
  checkCacheKey?: string;
  checkRevision?: string;
  checkDefinitionDigest?: string;
  checkEnvironmentFingerprint?: string;
  reusedExecution?: boolean;
  status: ProcessCheckReceiptStatus;
  runtimeStatus: ProcessCheckReceiptRuntimeStatus;
  ok: boolean;
  exitCode?: number;
  timedOut: boolean;
  cancelled: boolean;
  artifactPath: string;
  summary: string;
  startedAt: string;
  finishedAt: string;
}
