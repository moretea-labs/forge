export type ProcessCheckReceiptStatus = 'passed' | 'failed' | 'timed_out' | 'cancelled';
export type ProcessCheckReceiptRuntimeStatus = 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

/**
 * Stable, persistence-safe evidence contract shared by Edit Sessions, Work and Tasks.
 * It deliberately contains no execution-runtime implementation types.
 */
export interface ProcessCheckReceiptEvidence {
  schemaVersion: 1;
  receiptId: string;
  resultDigest: string;
  repoId: string;
  checkoutId?: string;
  workId?: string;
  executionSessionId?: string;
  editSessionId?: string;
  editRevision?: number;
  issueId?: string;
  taskId?: string;
  checkId: string;
  requestId?: string;
  processId: string;
  commandId?: string;
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
