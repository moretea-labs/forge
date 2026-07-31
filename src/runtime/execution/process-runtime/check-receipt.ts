import { createHash } from 'crypto';
import type {
  ProcessCheckReceiptEvidence,
  ProcessCheckReceiptStatus,
} from '../../evidence/process-check-receipt';
import type { ManagedProcessRecord, ProcessRuntimeStatus } from './types';

export type { ProcessCheckReceiptEvidence, ProcessCheckReceiptStatus } from '../../evidence/process-check-receipt';

export interface ProcessCheckReceiptExpectation {
  repoId?: string;
  checkoutId?: string;
  workId?: string;
  executionSessionId?: string;
  editSessionId?: string;
  editRevision?: number;
  issueId?: string;
  taskId?: string;
  checkId?: string;
  requestId?: string;
  processId?: string;
}

export interface ProcessCheckCompletionReceipt extends ProcessCheckReceiptEvidence {
  runtimeStatus: Extract<ProcessRuntimeStatus, 'succeeded' | 'failed' | 'timed_out' | 'cancelled'>;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function artifactSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'check';
}

export function processCheckArtifactPath(checkId: string): string {
  return `.ai/harness/checks/controller/latest-${artifactSlug(checkId)}.json`;
}

function receiptStatus(status: ProcessRuntimeStatus): ProcessCheckReceiptStatus {
  if (status === 'succeeded') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'timed_out') return 'timed_out';
  if (status === 'cancelled') return 'cancelled';
  fail('PROCESS_CHECK_RECEIPT_NOT_TERMINAL', `process status ${status} is not an accepted terminal check result`);
}

function assertExpected(label: string, actual: unknown, expected: unknown): void {
  if (expected === undefined) return;
  if (actual !== expected) {
    fail('PROCESS_CHECK_RECEIPT_IDENTITY_MISMATCH', `${label} expected ${String(expected)} but received ${String(actual)}`);
  }
}

function stableDigest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Normalize one persisted Process Runtime record into the single authoritative
 * check completion receipt consumed by Edit Sessions, Work validation and Tasks.
 */
export function processCheckCompletionReceipt(
  record: ManagedProcessRecord,
  expected: ProcessCheckReceiptExpectation = {},
): ProcessCheckCompletionReceipt {
  if (record.origin?.surface !== 'check' || !record.origin.checkId?.trim()) {
    fail('PROCESS_CHECK_RECEIPT_NOT_CHECK', `process ${record.processId} is not a bound check process`);
  }
  const status = receiptStatus(record.status);
  const contradictoryTerminal =
    (status === 'passed' && (record.exitCode !== 0 || record.timedOut === true || record.cancelled === true))
    || (status === 'failed' && (record.exitCode === 0 || record.timedOut === true || record.cancelled === true))
    || (status === 'timed_out' && record.timedOut !== true)
    || (status === 'cancelled' && record.cancelled !== true);
  if (contradictoryTerminal) {
    fail(
      'PROCESS_CHECK_RECEIPT_STATUS_CONTRADICTION',
      `process ${record.processId} status ${record.status} contradicts exitCode/timedOut/cancelled terminal fields`,
    );
  }
  if (!record.finishedAt) {
    fail('PROCESS_CHECK_RECEIPT_INCOMPLETE', `process ${record.processId} has no finishedAt timestamp`);
  }
  const checkId = record.origin.checkId.trim();
  assertExpected('repoId', record.repoId, expected.repoId);
  assertExpected('checkoutId', record.checkoutId, expected.checkoutId);
  assertExpected('workId', record.workId, expected.workId);
  assertExpected('executionSessionId', record.origin.executionSessionId, expected.executionSessionId);
  assertExpected('editSessionId', record.origin.editSessionId, expected.editSessionId);
  assertExpected('editRevision', record.origin.editRevision, expected.editRevision);
  assertExpected('issueId', record.origin.issueId, expected.issueId);
  assertExpected('taskId', record.origin.taskId, expected.taskId);
  assertExpected('checkId', checkId, expected.checkId);
  assertExpected('requestId', record.origin.requestId, expected.requestId);
  assertExpected('processId', record.processId, expected.processId);

  const ok = status === 'passed';
  const summaryTail = (record.stderrTail || record.stdoutTail || '').trim().slice(-500);
  const summary = ok
    ? `Passed with persisted Process evidence: ${record.processId}`
    : `${status === 'timed_out' ? 'Timed out' : status === 'cancelled' ? 'Cancelled' : 'Failed'} with persisted Process evidence: ${record.processId}${summaryTail ? `; ${summaryTail}` : ''}`;
  const stable = {
    schemaVersion: 1,
    repoId: record.repoId,
    checkoutId: record.checkoutId,
    workId: record.workId,
    executionSessionId: record.origin.executionSessionId,
    editSessionId: record.origin.editSessionId,
    editRevision: record.origin.editRevision,
    issueId: record.origin.issueId,
    taskId: record.origin.taskId,
    checkId,
    requestId: record.origin.requestId,
    processId: record.processId,
    commandId: record.commandId,
    status,
    runtimeStatus: record.status as ProcessCheckCompletionReceipt['runtimeStatus'],
    ok,
    exitCode: record.exitCode,
    timedOut: status === 'timed_out' || record.timedOut === true,
    cancelled: status === 'cancelled' || record.cancelled === true,
    artifactPath: processCheckArtifactPath(checkId),
    summary,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  } satisfies Omit<ProcessCheckCompletionReceipt, 'receiptId' | 'resultDigest'>;
  const resultDigest = stableDigest(stable);
  return {
    ...stable,
    resultDigest,
    receiptId: `check_receipt_${resultDigest.slice(0, 24)}`,
  };
}
