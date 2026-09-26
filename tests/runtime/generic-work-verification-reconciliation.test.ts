import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { appendVerificationRecord, createWorkContract, getWorkContract } from '../../packages/kernel/work/api/index';
import { controllerCheckExecutionIdentity } from '../../src/cli/controller/check-runner';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
import { executeWorkVerification, reconcileTerminalWorkVerifications } from '../../src/runtime/control-plane/execution/work-verification-service';
import { verificationInputFingerprint, workspaceValidationFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';
import { writePersistedCheckResultReceipt } from '../../src/runtime/execution/process-runtime/check-result';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord, ProcessCheckExecutionIdentity } from '../../src/runtime/execution/process-runtime/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('reconciles an explicitly named generic run_check Process into the exact Work checkout', async () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-generic-work-reconcile-controller-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-generic-work-reconcile-repo-'));
  roots.push(controllerHome, repoRoot);
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  require('fs').writeFileSync(join(repoRoot, '.forge/checks.json'), JSON.stringify({
    version: 1,
    checks: {
      'check:device': {
        command: ['node', '-e', 'process.exit(0)'],
        effects: { hostServices: ['fixture-device'] },
      },
    },
  }, null, 2));
  require('fs').writeFileSync(join(repoRoot, 'source.txt'), 'candidate\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'candidate'], { cwd: repoRoot });

  const repoId = 'repo-generic-work-reconcile';
  const checkoutId = 'checkout-generic-work-reconcile';
  const workId = 'work-generic-work-reconcile';
  const checkId = 'check:device';
  const now = '2026-09-20T00:00:00.000Z';
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const repository: RepositoryRecord = {
    schemaVersion: 1,
    repoId,
    displayName: 'generic reconciliation fixture',
    localRoot: repoRoot,
    canonicalRoot: repoRoot,
    activeCheckoutId: checkoutId,
    checkouts: [{
      checkoutId,
      localRoot: repoRoot,
      canonicalRoot: repoRoot,
      worktree: false,
      branch: 'main',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }],
    repositoryType: 'git',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    configurationPath: join(repoRoot, '.forge/config.json'),
    stateStorageStrategy: 'controller-home',
  };
  createWorkContract({ controllerHome, repoId, now: () => now }, {
    workId,
    repoId,
    checkoutId,
    baseRevision: head,
    objective: 'Reconcile a completed check from the exact active checkout.',
    acceptanceCriteria: ['The exact device check is recorded as current Work evidence.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [checkId],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });

  const statusBefore = {
    head,
    branch: 'main',
    porcelain: '',
    staged: [],
    unstaged: [],
    untracked: [],
  };
  const workspaceFingerprint = workspaceValidationFingerprint(repoRoot, statusBefore);
  appendVerificationRecord({ controllerHome, repoId }, workId, {
    checkId,
    outcome: 'valid_fail',
    summary: 'Earlier run had no device available.',
    recordedAt: '2026-09-19T23:00:00.000Z',
    sourceRevision: head,
    workspaceFingerprint,
    verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: head, workspaceFingerprint, checkId, requestedChecks: [checkId] }),
  });

  const currentExecution = controllerCheckExecutionIdentity(repoRoot, checkId);
  expect(currentExecution.reuseScope).toBe('checkout');
  const processId = 'proc-generic-device-pass';
  const receiptPath = join(controllerHome, 'check-result.json');
  writePersistedCheckResultReceipt(receiptPath, {
    checkId,
    cacheKey: currentExecution.cacheKey,
    ok: true,
    status: 0,
    timedOut: false,
    validatedRevision: currentExecution.revision,
    executedAt: now,
  });
  const processExecution: ProcessCheckExecutionIdentity = {
    ...currentExecution,
    scopeKey: `checkout:${checkoutId}`,
  };
  const process: ManagedProcessRecord = {
    schemaVersion: 1,
    processId,
    repoId,
    checkoutId,
    workId: null as unknown as undefined,
    executionIdentity: { schemaVersion: 1, repositoryId: repoId, checkoutId, canonicalRoot: resolve(repoRoot) },
    controllerHome,
    status: 'succeeded',
    route: 'managed',
    commandId: processId,
    command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: repoRoot },
    resourceClaims: [],
    checkExecution: processExecution,
    origin: { surface: 'check', toolName: 'run_check', checkId, requestId: 'generic-device-request', checkResultReceiptPath: receiptPath, workVerificationSnapshot: false },
    interactiveWaitMs: 0,
    timeoutMs: currentExecution.timeoutMs,
    maxOutputBytes: 1024,
    startedAt: '2026-09-19T23:01:00.000Z',
    finishedAt: '2026-09-19T23:01:30.000Z',
    updatedAt: '2026-09-19T23:01:30.000Z',
    terminalFenceToken: 1,
    terminalWritten: true,
    leaseReleaseState: 'released',
    leasesReleased: true,
    exitCode: 0,
  };
  createProcessRecord(process);

  const ignored = reconcileTerminalWorkVerifications({ controllerHome, repository, workId });
  expect(ignored.reconciledProcessIds).toEqual([]);

  const execution = await executeWorkVerification({ controllerHome, repository, workId, checkId, reconcileProcessIds: [processId] });
  expect(execution.isError).toBe(false);
  expect(execution.facade.summary).toContain('Reused exact current verification receipt');
  const contract = getWorkContract({ controllerHome, repoId }, workId)!;
  expect(contract.checkRefs[0]).toMatchObject({ checkId, outcome: 'valid_pass', sourceRevision: head, receipt: { processId, workId, ok: true } });
  expect(contract.checkRefs.some((record) => record.outcome === 'valid_fail')).toBe(true);
});
