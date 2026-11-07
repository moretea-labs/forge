import { afterEach, describe, expect, test } from 'bun:test';
import { seedHistoricalWorkHandle } from '../helpers/historical-work-handle';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { splitRepositoryGitStatus } from '../../src/cli/repositories/structured-git';
import { readControlPlaneRecord, withControlPlaneTransaction, writeControlPlaneRecordWithinTransaction } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import { writePersistedCheckResultReceipt } from '../../src/runtime/execution/process-runtime/check-result';
import type { ManagedProcessRecord, ProcessCheckExecutionIdentity } from '../../src/runtime/execution/process-runtime/types';
import {
  effectiveVerificationEvidence,
  verificationInputFingerprint,
  workspaceValidationFingerprint,
  workValidationInputFingerprint,
} from '../../src/runtime/control-plane/execution/verification-evidence';
import type { VerificationRecord } from '../../src/runtime/control-plane/facade/types'; import { execFileSync } from 'child_process'; import { controllerCheckExecutionIdentity, currentControllerCheckRevision } from '../../src/cli/controller/check-runner'; import { materializeWorkVerificationSnapshot } from '../../src/runtime/control-plane/execution/work-verification-snapshot';
import { seedHistoricalWorkContract } from '../helpers/historical-work-contract';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(status: 'succeeded' | 'failed' | 'timed_out', options: {
  createProcess?: boolean;
  checkId?: string;
  worktreePath?: string;
  checkExecution?: ProcessCheckExecutionIdentity;
  bindingCheckExecution?: ProcessCheckExecutionIdentity;
  omitCheckResultReceipt?: boolean;
  semanticOk?: boolean;
  semanticFailureClass?: 'acceptance_failure' | 'infrastructure_failure';
} = {}) {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-'));
  roots.push(controllerHome);
  const now = '2026-08-03T00:00:00.000Z';
  const repoId = 'repo-validation';
  const checkoutId = 'checkout-validation';
  const workId = `work-validation-${status}-${options.createProcess === false ? 'missing' : 'recorded'}`;
  const processId = `proc-validation-${status}-${options.createProcess === false ? 'missing' : 'recorded'}`;
  const checkId = options.checkId ?? 'check-validation';
  const checkExecution: ProcessCheckExecutionIdentity = options.checkExecution ?? {
    schemaVersion: 1,
    checkId,
    cacheKey: `cache-${checkId}`,
    revision: 'fixture-revision',
    definitionDigest: 'fixture-definition',
    environmentFingerprint: 'fixture-environment',
    timeoutMs: 30_000,
    reuseScope: 'checkout',
    scopeKey: `checkout:${checkoutId}|work:${workId}`,
  };
  const bindingCheckExecution = options.bindingCheckExecution ?? checkExecution;
  const semanticOk = options.semanticOk ?? status === 'succeeded';
  const semanticFailureClass = options.semanticFailureClass
    ?? (semanticOk ? undefined : status === 'failed' ? 'acceptance_failure' : 'infrastructure_failure');
  const checkResultReceiptPath = join(controllerHome, `${processId}.check-result.json`);
  if (options.createProcess !== false && !options.omitCheckResultReceipt) {
    writePersistedCheckResultReceipt(checkResultReceiptPath, {
      checkId,
      cacheKey: checkExecution.cacheKey,
      ok: semanticOk,
      status: semanticOk ? 0 : 1,
      timedOut: status === 'timed_out',
      ...(semanticFailureClass ? { failureClass: semanticFailureClass } : {}),
      executedAt: now,
    });
  }
  seedHistoricalWorkContract({ controllerHome, repoId, now: () => now }, {
    workId,
    repoId,
    objective: 'Converge validation from durable Process receipts.',
    acceptanceCriteria: ['Validation outcome is persisted exactly once.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [checkId],
    constraints: {},
    requestedBy: 'chatgpt',
    dispatchState: 'running',
  });
  const handle = seedHistoricalWorkHandle(controllerHome, {
    schemaVersion: 1,
    workId,
    workContractId: workId,
    sessionId: 'session-validation',
    principalId: 'principal-validation',
    repositoryId: repoId,
    checkoutId,
    worktreePath: options.worktreePath ?? '/tmp/work-validation',
    branch: 'work/validation',
    managedWorktree: false,
    permissionSnapshotVersion: 1,
    state: 'validating',
    createdAt: now,
    updatedAt: now,
    finalization: {
      validation: 'pending',
      commit: 'pending',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    },
    validationRun: {
      fingerprint: 'validation-fingerprint',
      head: 'abc123',
      workspaceFingerprint: 'workspace-fingerprint',
      requestedChecks: [checkId],
      resumeState: 'editing',
      processes: {
        [checkId]: {
          processId,
          requestId: 'request-validation',
          checkExecution: { ...bindingCheckExecution },
        },
      },
    },
  });
  const process: ManagedProcessRecord = {
    schemaVersion: 1,
    processId,
    repoId,
    checkoutId,
    workId,
    controllerHome,
    status,
    route: 'managed',
    commandId: 'command-validation',
    command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: handle.worktreePath },
    origin: {
      surface: 'check',
      checkId,
      requestId: 'request-validation',
      executionSessionId: handle.sessionId,
      ...(!options.omitCheckResultReceipt ? { checkResultReceiptPath } : {}),
    },
    resourceClaims: [],
    checkExecution: { ...checkExecution },
    interactiveWaitMs: 0,
    timeoutMs: 30_000,
    maxOutputBytes: 1_024,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
    terminalFenceToken: 41,
    terminalWritten: true,
    leaseReleaseState: 'released',
    leasesReleased: true,
    exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 1 : undefined,
    timedOut: status === 'timed_out',
  };
  if (options.createProcess !== false) createProcessRecord(process);
  return { controllerHome, repoId, workId, handle };
}

function contractFor(fx: ReturnType<typeof fixture>) {
  return getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
}

function workspaceStatus(path: string, porcelain = ` M ${path}`) {
  return {
    head: 'abc123',
    branch: 'work/validation-integrity',
    porcelain,
    staged: [],
    unstaged: [path],
    untracked: [],
  };
}

describe('workspace-bound validation identity', () => {
  test('fingerprints nested Git source without modifying its index and detects same-shape edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-validation-nested-git-'));
    roots.push(root);
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    for (const cwd of [root, nested]) {
      git(cwd, ['init', '-b', 'main']);
      writeFileSync(join(cwd, 'value.txt'), 'initial\n');
      git(cwd, ['add', 'value.txt']);
      git(cwd, ['-c', 'user.name=Validation test', '-c', 'user.email=validation@example.invalid', 'commit', '-m', 'initial']);
    }
    writeFileSync(join(nested, 'value.txt'), 'dirty one\n');
    const status = () => {
      const porcelain = git(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']);
      return { head: git(root, ['rev-parse', 'HEAD']), branch: 'main', porcelain, ...splitRepositoryGitStatus(porcelain) };
    };
    const outer = status();
    expect(outer.untracked).toContain('nested/');
    const index = readFileSync(join(nested, '.git', 'index'));
    const head = git(nested, ['rev-parse', 'HEAD']);
    const first = workspaceValidationFingerprint(root, outer);
    expect(workspaceValidationFingerprint(root, status())).toBe(first);
    writeFileSync(join(nested, 'value.txt'), 'dirty two\n');
    expect(status().porcelain).toBe(outer.porcelain);
    const second = workspaceValidationFingerprint(root, status());
    expect(second).not.toBe(first);
    expect(readFileSync(join(nested, '.git', 'index'))).toEqual(index);
    expect(git(nested, ['rev-parse', 'HEAD'])).toBe(head);
    writeFileSync(join(nested, 'untracked.txt'), 'new source\n');
    const third = workspaceValidationFingerprint(root, status());
    expect(third).not.toBe(second);
    writeFileSync(join(nested, 'untracked.txt'), 'changed source\n');
    const fourth = workspaceValidationFingerprint(root, status());
    expect(fourth).not.toBe(third);
    git(nested, ['-c', 'user.name=Validation test', '-c', 'user.email=validation@example.invalid', 'commit', '--allow-empty', '-m', 'advance source identity']);
    expect(workspaceValidationFingerprint(root, status())).not.toBe(fourth);
  });

  test('fingerprints a linked worktree with external Git metadata without changing its index', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-validation-linked-git-'));
    roots.push(root);
    const owner = join(root, 'owner');
    const parent = join(root, 'parent');
    mkdirSync(owner);
    mkdirSync(parent);
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(owner, ['init', '-b', 'main']);
    writeFileSync(join(owner, 'value.txt'), 'initial\n');
    git(owner, ['add', 'value.txt']);
    git(owner, ['-c', 'user.name=Validation test', '-c', 'user.email=validation@example.invalid', 'commit', '-m', 'initial']);
    const linked = join(parent, 'linked source ');
    git(owner, ['worktree', 'add', '--detach', linked]);
    const indexPath = git(linked, ['rev-parse', '--git-path', 'index']);
    const index = readFileSync(indexPath);
    const status = workspaceStatus('linked source /', '?? "linked source /"');
    const first = workspaceValidationFingerprint(parent, status);
    writeFileSync(join(linked, 'value.txt'), 'modified\n');
    expect(workspaceValidationFingerprint(parent, status)).not.toBe(first);
    expect(readFileSync(indexPath)).toEqual(index);
    writeFileSync(join(linked, 'value.txt'), 'initial\n');
    git(owner, ['worktree', 'remove', linked]);
  });

  test('rejects ordinary directory inputs and applies one path budget across nested repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-validation-nested-budget-'));
    roots.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    const ordinary = join(root, 'ordinary');
    mkdirSync(ordinary);
    // Git would otherwise discover the parent; it is not this directory's source identity.
    expect(() => workspaceValidationFingerprint(root, workspaceStatus('ordinary/', '?? ordinary/'))).toThrow('WORK_VALIDATION_PATH_TYPE_UNSUPPORTED');
    for (const name of ['first', 'second']) {
      const nested = join(root, name);
      mkdirSync(nested);
      execFileSync('git', ['init', '-b', 'main'], { cwd: nested, stdio: 'pipe' });
      for (let index = 0; index < 130; index += 1) writeFileSync(join(nested, `input-${index}.txt`), 'source\n');
    }
    expect(() => workspaceValidationFingerprint(root, {
      ...workspaceStatus('first/'), unstaged: [], untracked: ['first/', 'second/'], porcelain: '?? first/\n?? second/\n',
    })).toThrow('WORK_VALIDATION_TOO_MANY_PATHS');
  });

  test('changes when file content changes without a HEAD or status-shape change', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verification-evidence-'));
    roots.push(root);
    const path = 'source.ts';
    writeFileSync(join(root, path), 'export const value = 1;\n');
    const first = workspaceValidationFingerprint(root, workspaceStatus(path));

    writeFileSync(join(root, path), 'export const value = 2;\n');
    const second = workspaceValidationFingerprint(root, workspaceStatus(path));

    expect(second).not.toBe(first);
    expect(workspaceValidationFingerprint(root, workspaceStatus(path))).toBe(second);
  });

  test('decodes Git quoted paths before hashing exact content', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verification-evidence-'));
    roots.push(root);
    const path = 'space name.txt';
    const quoted = '"space name.txt"';
    writeFileSync(join(root, path), 'first\n');
    const first = workspaceValidationFingerprint(root, workspaceStatus(quoted, `?? ${quoted}`));

    writeFileSync(join(root, path), 'second\n');
    expect(workspaceValidationFingerprint(root, workspaceStatus(quoted, `?? ${quoted}`))).not.toBe(first);
  });

  test('fails closed when Git status output is truncated', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verification-evidence-'));
    roots.push(root);
    expect(() => workspaceValidationFingerprint(root, {
      ...workspaceStatus('source.ts'),
      porcelain: '[output truncated after 524288 bytes]',
    })).toThrow('WORK_VALIDATION_STATUS_TRUNCATED');
  });

  test('binds reusable receipts to workspace content and a stable check set', () => {
    const requestedChecks = ['check:b', 'check:a'];
    const firstWork = workValidationInputFingerprint('abc123', 'workspace-one', requestedChecks);
    expect(firstWork).toBe(workValidationInputFingerprint('abc123', 'workspace-one', [...requestedChecks].reverse()));
    expect(firstWork).not.toBe(workValidationInputFingerprint('abc123', 'workspace-two', requestedChecks));

    const record: VerificationRecord = {
      checkId: 'check:a',
      outcome: 'valid_pass',
      summary: 'passed',
      recordedAt: '2026-08-04T00:00:00.000Z',
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-one',
      verificationInputFingerprint: verificationInputFingerprint({
        sourceRevision: 'abc123',
        workspaceFingerprint: 'workspace-one',
        checkId: 'check:a',
        requestedChecks,
      }),
    };
    expect(effectiveVerificationEvidence([record], {
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-one',
      checkId: 'check:a',
      requestedChecks,
    })[0]).toMatchObject({ current: true });
    expect(effectiveVerificationEvidence([record], {
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-two',
      checkId: 'check:a',
      requestedChecks,
    })[0]).toMatchObject({ current: false, staleReason: 'workspace content changed' });
    expect(effectiveVerificationEvidence([record], {
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-one',
      checkId: 'check:a',
      requestedChecks: ['check:a'],
    })[0]).toMatchObject({ current: false, staleReason: 'verification inputs changed' });
  });

  test('reads an in-flight legacy Work that predates the first-class review checkpoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-review-phase-migration-'));
    roots.push(root);
    const workId = 'work-legacy-review-phase';
    const repoId = 'repo-legacy-review-phase';
    const store = { controllerHome: root, repoId };
    seedHistoricalWorkContract(store, {
      workId,
      repoId,
      objective: 'Continue an in-flight Work across a Runtime schema upgrade.',
      acceptanceCriteria: ['Durable Work remains readable after adding the review phase.'],
      constraints: {},
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      dispatchState: 'running',
    });

    const persisted = readControlPlaneRecord<Record<string, any>>(root, 'work_contract', repoId, workId)!;
    const legacy = structuredClone(persisted.value) as Record<string, any>;
    legacy.schemaVersion = 2;
    legacy.phase = 'delivery';
    legacy.phaseEvidence.implementation.state = 'satisfied';
    legacy.phaseEvidence.verification.state = 'satisfied';
    delete legacy.phaseEvidence.review;
    legacy.phaseEvidence.delivery.state = 'active';
    legacy.phaseEvidence.cleanup.state = 'pending';
    withControlPlaneTransaction(root, (database) => writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'work_contract', scope: repoId, key: workId, schemaVersion: 2, value: legacy,
      action: 'test_seed_legacy_review_phase', expectedRevision: persisted.revision,
    }));

    const migrated = getWorkContract(store, workId)!;
    const stillLegacy = readControlPlaneRecord<Record<string, any>>(root, 'work_contract', repoId, workId)!;
    expect(stillLegacy.schemaVersion).toBe(2);
    expect(stillLegacy.value.phaseEvidence.review).toBeUndefined();
    expect(migrated.phase).toBe('delivery');
    expect(migrated.phaseEvidence.review.state).toBe('skipped');
    expect(migrated.phaseEvidence.review.summary).toContain('compatibility-skipped without synthesizing Controller approval');
    expect(migrated.implementationReviews).toEqual([]);
    expect(migrated.phaseEvidence.delivery.state).toBe('active');
  });

  test('projects a persisted legacy-inferred pending review after the Work already advanced past review', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-review-phase-pending-migration-'));
    roots.push(root);
    const workId = 'work-legacy-pending-review-phase';
    const repoId = 'repo-legacy-pending-review-phase';
    const store = { controllerHome: root, repoId };
    seedHistoricalWorkContract(store, {
      workId,
      repoId,
      objective: 'Read a Work that persisted legacy review evidence before first-class review existed.',
      acceptanceCriteria: ['Only legacy-inferred pending review evidence is compatibility-upgraded.'],
      constraints: {},
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      dispatchState: 'running',
    });

    const persisted = readControlPlaneRecord<Record<string, any>>(root, 'work_contract', repoId, workId)!;
    const legacy = structuredClone(persisted.value) as Record<string, any>;
    legacy.schemaVersion = 2;
    legacy.phase = 'delivery';
    legacy.phaseEvidence.implementation.state = 'satisfied';
    legacy.phaseEvidence.verification.state = 'satisfied';
    legacy.phaseEvidence.review = {
      ...legacy.phaseEvidence.review,
      state: 'pending',
      source: 'legacy_inferred',
      summary: 'Legacy review remained pending before the review checkpoint existed.',
    };
    legacy.phaseEvidence.delivery.state = 'active';
    legacy.phaseEvidence.cleanup.state = 'pending';
    withControlPlaneTransaction(root, (database) => writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'work_contract', scope: repoId, key: workId, schemaVersion: 2, value: legacy,
      action: 'test_seed_legacy_pending_review_phase', expectedRevision: persisted.revision,
    }));

    const migrated = getWorkContract(store, workId)!;
    const stillLegacy = readControlPlaneRecord<Record<string, any>>(root, 'work_contract', repoId, workId)!;
    expect(stillLegacy.schemaVersion).toBe(2);
    expect(stillLegacy.value.phaseEvidence.review.state).toBe('pending');
    expect(migrated.phaseEvidence.review.state).toBe('skipped');
    expect(migrated.phaseEvidence.review.source).toBe('legacy_inferred');
    expect(migrated.phaseEvidence.review.summary).toContain('before that checkpoint existed');
  });
});
