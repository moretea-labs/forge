import { describe, expect, test } from 'bun:test';
import {
  processCheckArtifactPath,
  processCheckCompletionReceipt,
} from '../../src/runtime/execution/process-runtime/check-receipt';
import type {
  ManagedProcessRecord,
  ProcessRuntimeStatus,
} from '../../src/runtime/execution/process-runtime/types';

function processRecord(
  status: ProcessRuntimeStatus,
  overrides: Partial<ManagedProcessRecord> = {},
): ManagedProcessRecord {
  const now = '2026-07-31T09:00:00.000Z';
  return {
    schemaVersion: 1,
    processId: 'proc_receipt_1',
    repoId: 'repo_receipt',
    checkoutId: 'checkout_receipt',
    workId: 'work_receipt',
    commandId: 'command_receipt',
    controllerHome: '/controller',
    status,
    route: 'direct',
    command: {
      kind: 'argv',
      executable: 'bun',
      args: ['test'],
      cwd: '/repo',
    },
    resourceClaims: [],
    interactiveWaitMs: 1_000,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    exitCode: status === 'succeeded' ? 0 : 1,
    timedOut: status === 'timed_out',
    cancelled: status === 'cancelled',
    stdoutTail: status === 'succeeded' ? 'ok' : '',
    stderrTail: status === 'succeeded' ? '' : 'check did not pass',
    terminalFenceToken: 'fence',
    origin: {
      surface: 'check',
      toolName: 'run_check',
      requestId: 'request_receipt',
      checkId: 'ios:workspace:verify',
      correlationId: 'work_receipt',
      executionSessionId: 'mcp_receipt',
      editSessionId: 'EDIT-receipt',
      editRevision: 3,
      issueId: 'ISS-receipt',
      taskId: 'T4',
    },
    ...overrides,
  } as ManagedProcessRecord;
}

const exactIdentity = {
  repoId: 'repo_receipt',
  checkoutId: 'checkout_receipt',
  workId: 'work_receipt',
  executionSessionId: 'mcp_receipt',
  editSessionId: 'EDIT-receipt',
  editRevision: 3,
  issueId: 'ISS-receipt',
  taskId: 'T4',
  checkId: 'ios:workspace:verify',
  requestId: 'request_receipt',
  processId: 'proc_receipt_1',
};

describe('Process check completion receipts', () => {
  test('normalizes success into deterministic passed evidence', () => {
    const first = processCheckCompletionReceipt(processRecord('succeeded'), exactIdentity);
    const second = processCheckCompletionReceipt(processRecord('succeeded'), exactIdentity);

    expect(first.status).toBe('passed');
    expect(first.ok).toBe(true);
    expect(first.receiptId).toBe(second.receiptId);
    expect(first.resultDigest).toBe(second.resultDigest);
    expect(first.artifactPath).toBe('controller-home://checks/controller/latest-ios-workspace-verify.json');
    expect(processCheckArtifactPath('ios:workspace:verify')).toBe(first.artifactPath);
  });

  test.each([
    ['failed', 'failed'],
    ['timed_out', 'timed_out'],
    ['cancelled', 'cancelled'],
  ] as const)('maps %s without treating it as success', (runtimeStatus, receiptStatus) => {
    const receipt = processCheckCompletionReceipt(processRecord(runtimeStatus), exactIdentity);
    expect(receipt.status).toBe(receiptStatus);
    expect(receipt.ok).toBe(false);
    expect(receipt.timedOut).toBe(runtimeStatus === 'timed_out');
    expect(receipt.cancelled).toBe(runtimeStatus === 'cancelled');
  });

  test.each(['starting', 'running', 'running_recovered', 'orphaned', 'completed_unknown', 'unknown'] as const)(
    'rejects non-authoritative terminal status %s',
    (status) => {
      expect(() => processCheckCompletionReceipt(processRecord(status, { finishedAt: undefined }), exactIdentity))
        .toThrow(/PROCESS_CHECK_RECEIPT_NOT_TERMINAL/);
    },
  );

  test.each([
    ['repoId', { repoId: 'repo_wrong' }],
    ['checkoutId', { checkoutId: 'checkout_wrong' }],
    ['workId', { workId: 'work_wrong' }],
    ['editSessionId', { editSessionId: 'EDIT-wrong' }],
    ['editRevision', { editRevision: 4 }],
    ['issueId', { issueId: 'ISS-wrong' }],
    ['taskId', { taskId: 'T-wrong' }],
    ['checkId', { checkId: 'wrong:check' }],
    ['requestId', { requestId: 'request_wrong' }],
    ['processId', { processId: 'proc_wrong' }],
  ] as const)('fails closed on %s mismatch', (_label, mismatch) => {
    expect(() => processCheckCompletionReceipt(processRecord('succeeded'), {
      ...exactIdentity,
      ...mismatch,
    })).toThrow(/PROCESS_CHECK_RECEIPT_IDENTITY_MISMATCH/);
  });

  test.each([
    ['succeeded with non-zero exit', processRecord('succeeded', { exitCode: 7 })],
    ['failed with zero exit', processRecord('failed', { exitCode: 0 })],
    ['timed out without timeout evidence', processRecord('timed_out', { timedOut: false })],
    ['cancelled without cancellation evidence', processRecord('cancelled', { cancelled: false })],
  ] as const)('rejects contradictory terminal evidence: %s', (_label, record) => {
    expect(() => processCheckCompletionReceipt(record)).toThrow(/PROCESS_CHECK_RECEIPT_STATUS_CONTRADICTION/);
  });

  test('rejects a terminal process that is not a registered check execution', () => {
    expect(() => processCheckCompletionReceipt(processRecord('succeeded', {
      origin: { surface: 'command', requestId: 'request_receipt' },
    }))).toThrow(/PROCESS_CHECK_RECEIPT_NOT_CHECK/);
  });
});
