import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyEditOperations,
  beginEditSession,
  finalizeEditSession,
  getEditSession,
  recordEditSessionProcessCheckReceipts,
} from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { runProcess } from '../../src/effects/process-runner';
import { processCheckCompletionReceipt } from '../../src/runtime/execution/process-runtime/check-receipt';
import type { ManagedProcessRecord, ProcessRuntimeStatus } from '../../src/runtime/execution/process-runtime/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-edit-receipt-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'example.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'edit-receipt' }, null, 2));
  writeFileSync(join(root, '.gitignore'), '.ai/\n');
  expect(runProcess('git', ['init', '-b', 'main'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
  expect(runProcess('git', ['config', 'user.email', 'receipt@test.local'], { cwd: root, timeoutMs: 5_000 }).ok).toBe(true);
  expect(runProcess('git', ['config', 'user.name', 'Receipt Test'], { cwd: root, timeoutMs: 5_000 }).ok).toBe(true);
  expect(runProcess('git', ['add', '.'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
  expect(runProcess('git', ['commit', '-m', 'init'], { cwd: root, timeoutMs: 10_000 }).ok).toBe(true);
  return root;
}

function editOnce(root: string, sessionId: string): number {
  const policy = getMcpPolicy('controller', { repoRoot: root });
  const initial = readFileSync(join(root, 'src/example.ts'), 'utf8');
  return applyEditOperations(root, policy, sessionId, [{
    type: 'replace',
    path: 'src/example.ts',
    expectedSha256: sha(initial),
    replacements: [{ oldText: 'value = 1', newText: 'value = 2' }],
  }]).currentRevision;
}

function processRecord(input: {
  sessionId: string;
  revision: number;
  status?: ProcessRuntimeStatus;
  processId?: string;
  checkId?: string;
}): ManagedProcessRecord {
  const status = input.status ?? 'succeeded';
  const checkId = input.checkId ?? 'ios:workspace:verify';
  const processId = input.processId ?? 'proc_edit_receipt';
  const at = '2026-07-31T09:15:00.000Z';
  return {
    schemaVersion: 1,
    processId,
    repoId: 'repo_edit_receipt',
    checkoutId: 'checkout_edit_receipt',
    commandId: `command_${processId}`,
    controllerHome: '/controller',
    status,
    route: 'direct',
    command: { kind: 'argv', executable: 'xcodebuild', args: ['test'], cwd: '/repo' },
    resourceClaims: [],
    interactiveWaitMs: 1_000,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    exitCode: status === 'succeeded' ? 0 : 1,
    timedOut: status === 'timed_out',
    cancelled: status === 'cancelled',
    terminalFenceToken: 1,
    origin: {
      surface: 'check',
      requestId: `request_${processId}`,
      checkId,
      editSessionId: input.sessionId,
      editRevision: input.revision,
      issueId: 'ISS-edit-receipt',
      taskId: 'T4',
    },
  } as ManagedProcessRecord;
}

function receiptFor(input: Parameters<typeof processRecord>[0]) {
  const record = processRecord(input);
  return processCheckCompletionReceipt(record, {
    repoId: 'repo_edit_receipt',
    checkoutId: 'checkout_edit_receipt',
    editSessionId: input.sessionId,
    editRevision: input.revision,
    issueId: 'ISS-edit-receipt',
    taskId: 'T4',
    checkId: input.checkId ?? 'ios:workspace:verify',
    processId: record.processId,
  });
}

describe('Edit Session Process check receipts', () => {
  test('records exact-revision evidence, retries idempotently, and finalizes', () => {
    const root = fixtureRepo();
    const session = beginEditSession(root, {
      purpose: 'iOS edit verification receipt',
      issueId: 'ISS-edit-receipt',
      taskId: 'T4',
      allowedPaths: ['src/**'],
      checks: ['ios:workspace:verify'],
    });
    const revision = editOnce(root, session.sessionId);
    const receipt = receiptFor({ sessionId: session.sessionId, revision });

    const checked = recordEditSessionProcessCheckReceipts(root, session.sessionId, {
      repoId: 'repo_edit_receipt',
      checkoutId: 'checkout_edit_receipt',
      receipts: [receipt],
      reviewer: 'receipt-test',
    });
    expect(checked.status).toBe('checked');
    expect(checked.checkResults).toEqual([expect.objectContaining({
      checkId: 'ios:workspace:verify',
      ok: true,
      receiptId: receipt.receiptId,
      resultDigest: receipt.resultDigest,
      revision,
      artifactPath: '.ai/harness/checks/controller/latest-ios-workspace-verify.json',
      receipt: expect.objectContaining({
        receiptId: receipt.receiptId,
        resultDigest: receipt.resultDigest,
        editSessionId: session.sessionId,
        editRevision: revision,
      }),
    })]);

    const retried = recordEditSessionProcessCheckReceipts(root, session.sessionId, {
      repoId: 'repo_edit_receipt',
      checkoutId: 'checkout_edit_receipt',
      receipts: [receipt],
      reviewer: 'receipt-test',
    });
    expect(retried.checkResults).toEqual(checked.checkResults);
    expect(finalizeEditSession(root, session.sessionId, { reviewer: 'receipt-test' }).status).toBe('finalized');
  });

  test('rejects stale and contradictory evidence', () => {
    const root = fixtureRepo();
    const session = beginEditSession(root, {
      purpose: 'Reject stale receipt',
      issueId: 'ISS-edit-receipt',
      taskId: 'T4',
      allowedPaths: ['src/**'],
      checks: ['ios:workspace:verify'],
    });
    const revision = editOnce(root, session.sessionId);
    const receipt = receiptFor({ sessionId: session.sessionId, revision });

    expect(() => recordEditSessionProcessCheckReceipts(root, session.sessionId, {
      repoId: 'repo_edit_receipt',
      checkoutId: 'checkout_edit_receipt',
      receipts: [],
    })).toThrow(/EDIT_CHECK_RECEIPT_REQUIRED_CHECK_MISSING/);

    expect(() => recordEditSessionProcessCheckReceipts(root, session.sessionId, {
      repoId: 'repo_edit_receipt',
      checkoutId: 'checkout_edit_receipt',
      receipts: [receiptFor({ sessionId: session.sessionId, revision: revision - 1, processId: 'proc_stale' })],
    })).toThrow(/EDIT_CHECK_RECEIPT_STALE_REVISION/);

    recordEditSessionProcessCheckReceipts(root, session.sessionId, {
      repoId: 'repo_edit_receipt',
      checkoutId: 'checkout_edit_receipt',
      receipts: [receipt],
    });
    const contradictory = receiptFor({ sessionId: session.sessionId, revision, processId: 'proc_contradictory' });
    expect(() => recordEditSessionProcessCheckReceipts(root, session.sessionId, {
      repoId: 'repo_edit_receipt',
      checkoutId: 'checkout_edit_receipt',
      receipts: [contradictory],
    })).toThrow(/EDIT_CHECK_RECEIPT_CONTRADICTION/);
  });

  test('keeps failed, timed-out, and cancelled checks from finalizing', () => {
    for (const status of ['failed', 'timed_out', 'cancelled'] as const) {
      const root = fixtureRepo();
      const session = beginEditSession(root, {
        purpose: `Reject ${status} receipt`,
        issueId: 'ISS-edit-receipt',
        taskId: 'T4',
        allowedPaths: ['src/**'],
        checks: ['ios:workspace:verify'],
      });
      const revision = editOnce(root, session.sessionId);
      const receipt = receiptFor({ sessionId: session.sessionId, revision, status, processId: `proc_${status}` });
      const checked = recordEditSessionProcessCheckReceipts(root, session.sessionId, {
        repoId: 'repo_edit_receipt',
        checkoutId: 'checkout_edit_receipt',
        receipts: [receipt],
      });
      expect(checked.status).toBe('check_failed');
      expect(checked.checkResults[0]?.status).toBe(status === 'failed' ? 'failed' : status);
      expect(() => finalizeEditSession(root, session.sessionId)).toThrow(/configured checks must pass/i);
      expect(getEditSession(root, session.sessionId).status).toBe('check_failed');
    }
  });
});
