import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import {
  listRepositories,
  registerRepository,
  repositoryCheckoutLifecycle,
  setRepositoryCheckoutLifecycle,
} from '../../src/cli/repositories/registry';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { writeRepositoryAccessPolicy } from '../../src/runtime/control-plane/governance/access-policy';
import { callExecutionTool } from '../../src/runtime/gateway/mcp/execution-tools';
import { listExecutionJobs } from '../../src/runtime/execution/jobs/store';
import { getWorkContract, listWorkContracts, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { readWorkHandle, writeWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { waitForCheckProcess } from '../../src/runtime/execution/process-runtime/check-facade';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-work-recovery-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-work-recovery-home-'));
  roots.push(repoRoot, controllerHome);
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Repo Harness Test');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'work-recovery-fixture' }, null, 2));
  git(repoRoot, 'add', 'package.json');
  git(repoRoot, 'commit', '-m', 'init');
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'work recovery fixture' });
  writeRepositoryAccessPolicy(controllerHome, repository.repoId, 'full_access');
  const context = (sessionId: string, controllerInstanceId: string): MultiRepositoryMcpToolContext => ({
    repoRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot }),
    toolset: 'advanced' as const,
    toolsetLocked: true,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    sessionId,
    principalId: 'principal-work-recovery',
    controllerInstanceId,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext);
  return { repoRoot, controllerHome, repository, context };
}

function structured(result: Awaited<ReturnType<typeof callExecutionTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent ?? {}) as Record<string, any>;
}

describe('controller-owned Work recovery and finalize cleanup', () => {
  test('keeps a running validation pending and reuses its process to converge', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    writeFileSync(join(repoRoot, 'slow-check.cjs'), 'setTimeout(() => process.exit(0), 1500);\n');
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
      name: 'work-recovery-fixture',
      scripts: { 'check:slow': 'node slow-check.cjs' },
    }, null, 2));
    git(repoRoot, 'add', 'package.json', 'slow-check.cjs');
    git(repoRoot, 'commit', '-m', 'add slow validation fixture');

    const ctx = context('session-validation-recovery', 'controller-validation-recovery');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Prove validation process recovery',
      isolation: 'reuse',
      checks: ['package:check:slow'],
      request_id: 'prepare-validation-recovery',
    }));
    const workId = String(prepared.work.workId);
    const first = structured(await callExecutionTool(ctx, 'work_validate', {
      work_id: workId,
      check_ids: ['package:check:slow'],
      request_id: 'validate-recovery-first',
    }));
    expect(first.validation.completed).toBe(false);
    expect(first.validation.checks[0].status).toBe('running');
    expect(first.work.state).toBe('validating');
    expect(first.work.finalization.validation).toBe('pending');
    const processId = String(first.validation.checks[0].process.processId);

    await waitForCheckProcess(controllerHome, repository.repoId, processId, 5_000);
    const second = structured(await callExecutionTool(ctx, 'work_validate', {
      work_id: workId,
      check_ids: ['package:check:slow'],
      request_id: 'validate-recovery-second',
    }));
    expect(second.validation.completed).toBe(true);
    expect(second.validation.passed).toBe(true);
    expect(second.validation.checks[0].process.processId).toBe(processId);
    expect(second.work.state).toBe('editing');
    expect(second.work.finalization.validation).toBe('done');
    expect(readWorkHandle(controllerHome, repository.repoId, workId)?.validationRun).toBeUndefined();
  });

  test('deduplicates identical work_prepare retries and rejects changed request fingerprints', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-idempotent-prepare', 'controller-idempotent-a');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const input = {
      repo_id: repository.repoId,
      objective: 'Prepare exactly one isolated workspace',
      isolation: 'new_worktree',
      request_id: 'work-prepare-idempotency-test',
    };

    const [first, second] = await Promise.all([
      callExecutionTool(ctx, 'work_prepare', input),
      callExecutionTool(ctx, 'work_prepare', input),
    ]).then((results) => results.map(structured));
    expect(second.reused).toBe(true);
    expect(second.work.workId).toBe(first.work.workId);
    expect(second.work.checkoutId).toBe(first.work.checkoutId);
    expect(second.work.branch).toBe(first.work.branch);
    expect(second.work.worktreePath).toBe(first.work.worktreePath);

    const restarted = context('session-idempotent-prepare', 'controller-idempotent-b');
    structured(await callExecutionTool(restarted, 'session_start', {}));
    const afterRestart = structured(await callExecutionTool(restarted, 'work_prepare', input));
    expect(afterRestart.reused).toBe(true);
    expect(afterRestart.work.workId).toBe(first.work.workId);

    const conflict = structured(await callExecutionTool(restarted, 'work_prepare', {
      ...input,
      objective: 'Changed objective must not create another Work',
    }));
    expect(conflict.error.code).toBe('WORK_PREPARE_REQUEST_CONFLICT');

    const contracts = listWorkContracts({ controllerHome, repoId: repository.repoId, status: 'all', limit: 100 })
      .filter((contract) => contract.requestId === input.request_id);
    expect(contracts).toHaveLength(1);
    const refreshed = listRepositories(controllerHome, { includeRemoved: true }).find((entry) => entry.repoId === repository.repoId)!;
    const sourceRoot = realpathSync(repoRoot);
    const managedPaths = refreshed.checkouts
      .filter((checkout) => realpathSync(checkout.canonicalRoot) !== sourceRoot && repositoryCheckoutLifecycle(checkout) !== 'removed')
      .map((checkout) => checkout.canonicalRoot);
    expect(new Set(managedPaths)).toEqual(new Set([String(first.work.worktreePath)]));
  });

  test('returns a terminal Work without reactivating or reclaiming it', async () => {
    const { controllerHome, repository, context } = fixture();
    const ctx = context('session-terminal-prepare', 'controller-terminal-prepare');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const input = {
      repo_id: repository.repoId,
      objective: 'Prepare a Work that will later be cancelled',
      isolation: 'reuse',
      request_id: 'work-prepare-terminal-test',
    };
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', input));
    const workId = String(prepared.work.workId);
    updateWorkContract({ controllerHome, repoId: repository.repoId }, workId, { status: 'cancelled' });

    const retried = structured(await callExecutionTool(ctx, 'work_prepare', input));
    expect(retried.reused).toBe(true);
    expect(retried.terminal).toBe(true);
    expect(retried.controllerClaimed).toBe(false);
    expect(retried.workContractStatus).toBe('cancelled');
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('cancelled');
  });

  test('requires request_id before creating a new Work', async () => {
    const { controllerHome, repository, context } = fixture();
    const ctx = context('session-prepare-request-required', 'controller-prepare-request-required');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const rejected = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Missing request identity',
      isolation: 'reuse',
    }));
    expect(rejected.error.code).toBe('WORK_PREPARE_REQUEST_ID_REQUIRED');
    expect(listWorkContracts({ controllerHome, repoId: repository.repoId, status: 'all', limit: 100 })).toHaveLength(0);
  });

  test('continues an explicit Work handle across controller and MCP session changes', async () => {
    const { repoRoot, repository, context } = fixture();
    const first = context('session-original', 'controller-a');
    structured(await callExecutionTool(first, 'session_start', {}));
    structured(await callExecutionTool(first, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(first, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Recover this work after session restart',
      isolation: 'reuse',
      request_id: 'prepare-cross-session-recovery',
    }));
    const workId = String(prepared.work.workId);

    const sameSessionAfterRestart = context('session-original', 'controller-b');
    const inspectedAfterControllerRestart = structured(await callExecutionTool(sameSessionAfterRestart, 'work_inspect', {
      repo_id: repository.repoId,
      work_id: workId,
    }));
    expect(inspectedAfterControllerRestart.work.workId).toBe(workId);
    expect(inspectedAfterControllerRestart.readiness.valid).toBe(true);

    const newSession = context('session-new', 'controller-c');
    structured(await callExecutionTool(newSession, 'session_start', {}));
    const inspectedAfterSessionRestart = structured(await callExecutionTool(newSession, 'work_inspect', {
      repo_id: repository.repoId,
      work_id: workId,
    }));
    expect(inspectedAfterSessionRestart.work.workId).toBe(workId);
    expect(inspectedAfterSessionRestart.readiness.warnings.join('\n')).toContain('different MCP session');

    const executedAfterRollout = structured(await callExecutionTool(newSession, 'work_execute', {
      repo_id: repository.repoId,
      work_id: workId,
      request_id: 'cross-epoch-work-resume',
      command: 'printf resumed-after-rollout > resumed-after-rollout.txt',
    }));
    expect(executedAfterRollout.executedCount).toBe(1);
    expect(existsSync(join(repoRoot, 'resumed-after-rollout.txt'))).toBe(true);
  });

  test('executes an admitted Work mutation through Process Runtime without creating an ExecutionJob', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-worker-work', 'controller-worker-work');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Execute only through Process Runtime',
      isolation: 'reuse',
      request_id: 'prepare-process-runtime-work',
    }));
    const workId = String(prepared.work.workId);
    const jobCountBefore = listExecutionJobs(controllerHome, repository.repoId).length;
    expect(existsSync(join(repoRoot, 'durable-worker.txt'))).toBe(false);

    const executed = structured(await callExecutionTool(ctx, 'work_execute', {
      repo_id: repository.repoId,
      work_id: workId,
      request_id: 'process-work-execute-test',
      command: 'printf worker-owned > durable-worker.txt',
    }));

    expect(executed.executedCount).toBe(1);
    expect(String((executed.commands as Array<{ status?: string }>)[0]?.status)).toBe('executed');
    expect(existsSync(join(repoRoot, 'durable-worker.txt'))).toBe(true);
    expect(listExecutionJobs(controllerHome, repository.repoId).length).toBe(jobCountBefore);
  });

  test('executes against the explicitly bound repository instead of the ambient connector repository', async () => {
    const { repoRoot: ambientRoot, controllerHome, repository: ambientRepository, context } = fixture();
    const targetRoot = mkdtempSync(join(tmpdir(), 'repo-harness-work-target-repo-'));
    roots.push(targetRoot);
    git(targetRoot, 'init', '-b', 'main');
    git(targetRoot, 'config', 'user.email', 'test@example.com');
    git(targetRoot, 'config', 'user.name', 'Repo Harness Test');
    writeFileSync(join(targetRoot, 'package.json'), JSON.stringify({ name: 'work-target-fixture' }, null, 2));
    git(targetRoot, 'add', 'package.json');
    git(targetRoot, 'commit', '-m', 'init');
    const targetRepository = registerRepository({
      path: targetRoot,
      controllerHome,
      displayName: 'work target fixture',
    });
    writeRepositoryAccessPolicy(controllerHome, targetRepository.repoId, 'full_access');

    const ctx = context('session-cross-repository', 'controller-cross-repository');
    expect(ctx.explicitRepository?.repoId).toBe(ambientRepository.repoId);
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', {
      repo_id: targetRepository.repoId,
    }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: targetRepository.repoId,
      objective: 'Execute only in the explicitly bound target repository',
      isolation: 'reuse',
      request_id: 'prepare-cross-repository-work',
    }));
    const workId = String(prepared.work.workId);
    expect(prepared.work.repoId).toBe(targetRepository.repoId);
    expect(prepared.work.worktreePath).toBe(targetRepository.canonicalRoot);

    const executed = structured(await callExecutionTool(ctx, 'work_execute', {
      repo_id: targetRepository.repoId,
      work_id: workId,
      request_id: 'cross-repository-work-execute-test',
      command: 'printf target-only > cross-repository.txt',
    }));

    expect(executed.executedCount).toBe(1);
    expect(executed.work.repoId).toBe(targetRepository.repoId);
    expect(existsSync(join(targetRoot, 'cross-repository.txt'))).toBe(true);
    expect(existsSync(join(ambientRoot, 'cross-repository.txt'))).toBe(false);
  });

  test('cleanup-only finalize reconciles a clean branch already merged outside the Work stages', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-cleanup-reconcile', 'controller-cleanup-reconcile');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Reconcile externally completed merge before cleanup',
      isolation: 'new_worktree',
      request_id: 'prepare-cleanup-reconcile-work',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const checkoutId = String(prepared.work.checkoutId);
    const worktreePath = String(prepared.work.worktreePath);

    writeFileSync(join(worktreePath, 'already-merged.txt'), 'merged-before-finalize');
    git(worktreePath, 'add', 'already-merged.txt');
    git(worktreePath, 'commit', '-m', 'external commit before finalize');
    git(repoRoot, 'merge', '--ff-only', branch);

    const finalized = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      target_branch: 'main',
    }));
    expect(finalized.completed).toBe(true);
    expect(finalized.work.state).toBe('cleaned');
    expect(finalized.stages.merge).toBe('done');
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoRoot, 'branch', '--list', branch)).toBe('');
    expect(git(repoRoot, 'show', 'HEAD:already-merged.txt')).toBe('merged-before-finalize');

    const refreshed = listRepositories(controllerHome, { includeRemoved: true }).find((entry) => entry.repoId === repository.repoId)!;
    const managedCheckout = refreshed.checkouts.find((checkout) => checkout.checkoutId === checkoutId)!;
    expect(repositoryCheckoutLifecycle(managedCheckout)).toBe('removed');
  });

  test('cleanup-only finalize removes a clean unchanged cancelled duplicate while preserving cancelled evidence', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-cancelled-duplicate-cleanup', 'controller-cancelled-duplicate-cleanup');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Create one unchanged duplicate workspace for cleanup reconciliation',
      isolation: 'new_worktree',
      request_id: 'prepare-cancelled-duplicate-cleanup-work',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const worktreePath = String(prepared.work.worktreePath);
    updateWorkContract({ controllerHome, repoId: repository.repoId }, workId, { status: 'cancelled' });

    const finalized = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      target_branch: 'main',
    }));
    expect(finalized.completed).toBe(true);
    expect(finalized.work.state).toBe('cleaned');
    expect(finalized.stages).toMatchObject({ validation: 'done', commit: 'skipped', merge: 'done', branchCleanup: 'done', worktreeCleanup: 'done' });
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoRoot, 'branch', '--list', branch)).toBe('');
    const contract = getWorkContract({ controllerHome, repoId: repository.repoId }, workId)!;
    expect(contract.status).toBe('cancelled');
    expect(contract.evidenceRefs.some((entry) => entry.title === 'cancelled work cleanup completed')).toBe(true);
  });

  test('cleanup-only finalize resumes branch cleanup after a previous attempt already removed the worktree', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-cancelled-partial-cleanup', 'controller-cancelled-partial-cleanup');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Resume a partial cancelled cleanup after worktree removal',
      isolation: 'new_worktree',
      request_id: 'prepare-cancelled-partial-cleanup-work',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const checkoutId = String(prepared.work.checkoutId);
    const worktreePath = String(prepared.work.worktreePath);
    updateWorkContract({ controllerHome, repoId: repository.repoId }, workId, { status: 'cancelled' });
    git(repoRoot, 'worktree', 'remove', worktreePath);
    setRepositoryCheckoutLifecycle({ controllerHome, repoId: repository.repoId, checkoutId, lifecycle: 'removed', reason: 'simulate cleanup crash after worktree removal' });
    const handle = readWorkHandle(controllerHome, repository.repoId, workId)!;
    writeWorkHandle(controllerHome, {
      ...handle,
      state: 'editing',
      finalization: {
        validation: 'done',
        commit: 'skipped',
        merge: 'skipped',
        branchCleanup: 'skipped',
        worktreeCleanup: 'done',
      },
    });

    const finalized = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      target_branch: 'main',
    }));
    expect(finalized.completed).toBe(true);
    expect(finalized.work.state).toBe('cleaned');
    expect(finalized.stages.branchCleanup).toBe('done');
    expect(finalized.stages.worktreeCleanup).toBe('done');
    expect(git(repoRoot, 'branch', '--list', branch)).toBe('');
  });

  test('cleanup-only finalize rejects a dirty cancelled worktree before deletion', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-cancelled-dirty-cleanup', 'controller-cancelled-dirty-cleanup');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Retain a dirty cancelled workspace',
      isolation: 'new_worktree',
      request_id: 'prepare-cancelled-dirty-cleanup-work',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const worktreePath = String(prepared.work.worktreePath);
    writeFileSync(join(worktreePath, 'uncommitted-output.txt'), 'must remain for review');
    updateWorkContract({ controllerHome, repoId: repository.repoId }, workId, { status: 'cancelled' });

    const rejected = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      target_branch: 'main',
    }));
    expect(rejected.error?.code).toBe('WORK_CANCELLED_CLEANUP_UNSAFE');
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, 'uncommitted-output.txt'))).toBe(true);
    expect(git(repoRoot, 'branch', '--list', branch)).toContain(branch);
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('cancelled');
  });

  test('cleanup-only finalize rejects a cancelled branch with an unintegrated commit', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-cancelled-unintegrated-cleanup', 'controller-cancelled-unintegrated-cleanup');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Retain cancelled work with reviewable unintegrated output',
      isolation: 'new_worktree',
      request_id: 'prepare-cancelled-unintegrated-cleanup-work',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const worktreePath = String(prepared.work.worktreePath);
    writeFileSync(join(worktreePath, 'reviewable-output.txt'), 'must not be deleted');
    git(worktreePath, 'add', 'reviewable-output.txt');
    git(worktreePath, 'commit', '-m', 'retain reviewable cancelled output');
    updateWorkContract({ controllerHome, repoId: repository.repoId }, workId, { status: 'cancelled' });

    const rejected = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      target_branch: 'main',
    }));
    expect(rejected.error?.code).toBe('WORK_CANCELLED_CLEANUP_UNSAFE');
    expect(existsSync(worktreePath)).toBe(true);
    expect(git(repoRoot, 'branch', '--list', branch)).toContain(branch);
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('cancelled');
  });

  test('finalize merges and cleans a precommitted managed branch without creating another commit', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-precommitted-finalize', 'controller-precommitted-finalize');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Finalize a branch committed before Work stages recorded the commit',
      isolation: 'new_worktree',
      request_id: 'prepare-precommitted-finalize-work',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const checkoutId = String(prepared.work.checkoutId);
    const worktreePath = String(prepared.work.worktreePath);

    const precommitted = structured(await callExecutionTool(ctx, 'work_execute', {
      repo_id: repository.repoId,
      work_id: workId,
      command: 'printf precommitted-before-finalize > precommitted.txt && git add precommitted.txt && git commit -m "precommit managed branch"',
    }));
    expect(precommitted.executedCount).toBe(1);
    const featureHead = git(worktreePath, 'rev-parse', 'HEAD');

    const finalized = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: false,
      merge: true,
      cleanup: true,
      target_branch: 'main',
    }));
    expect(finalized.completed).toBe(true);
    expect(finalized.work.state).toBe('cleaned');
    expect(finalized.stages.commit).toBe('skipped');
    expect(finalized.stages.merge).toBe('done');
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoRoot, 'branch', '--list', branch)).toBe('');
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(featureHead);
    expect(git(repoRoot, 'show', 'HEAD:precommitted.txt')).toBe('precommitted-before-finalize');

    const refreshed = listRepositories(controllerHome, { includeRemoved: true }).find((entry) => entry.repoId === repository.repoId)!;
    const managedCheckout = refreshed.checkouts.find((checkout) => checkout.checkoutId === checkoutId)!;
    expect(repositoryCheckoutLifecycle(managedCheckout)).toBe('removed');
  });

  test('finalize reconciles and removes an archived managed checkout', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-archived-finalize', 'controller-archived-finalize');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Finalize an archived managed checkout retained after rollout recovery',
      isolation: 'new_worktree',
      request_id: 'prepare-archived-finalize-work',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const checkoutId = String(prepared.work.checkoutId);
    const worktreePath = String(prepared.work.worktreePath);

    const precommitted = structured(await callExecutionTool(ctx, 'work_execute', {
      repo_id: repository.repoId,
      work_id: workId,
      command: 'printf archived-finalize > archived-finalize.txt && git add archived-finalize.txt && git commit -m "archive before finalize"',
    }));
    expect(precommitted.executedCount).toBe(1);
    setRepositoryCheckoutLifecycle({
      controllerHome,
      repoId: repository.repoId,
      checkoutId,
      lifecycle: 'archived',
      reason: 'simulate startup reconciliation before Work finalization',
    });

    const archived = listRepositories(controllerHome, { includeRemoved: true })
      .find((entry) => entry.repoId === repository.repoId)!
      .checkouts.find((checkout) => checkout.checkoutId === checkoutId)!;
    expect(repositoryCheckoutLifecycle(archived)).toBe('archived');

    const finalized = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: false,
      merge: true,
      cleanup: true,
      target_branch: 'main',
    }));
    expect(finalized.completed).toBe(true);
    expect(finalized.work.state).toBe('cleaned');
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoRoot, 'branch', '--list', branch)).toBe('');
    expect(git(repoRoot, 'show', 'HEAD:archived-finalize.txt')).toBe('archived-finalize');

    const refreshed = listRepositories(controllerHome, { includeRemoved: true }).find((entry) => entry.repoId === repository.repoId)!;
    const managedCheckout = refreshed.checkouts.find((checkout) => checkout.checkoutId === checkoutId)!;
    expect(repositoryCheckoutLifecycle(managedCheckout)).toBe('removed');
  });

  test('finalize commits, merges, removes managed checkout, deletes branch, and clears session focus', async () => {
    const { repoRoot, controllerHome, repository, context } = fixture();
    const ctx = context('session-finalize', 'controller-finalize');
    structured(await callExecutionTool(ctx, 'session_start', {}));
    structured(await callExecutionTool(ctx, 'session_bind_repository', { repo_id: repository.repoId }));
    const prepared = structured(await callExecutionTool(ctx, 'work_prepare', {
      repo_id: repository.repoId,
      objective: 'Finalize managed worktree',
      isolation: 'new_worktree',
      request_id: 'prepare-finalize-managed-worktree',
    }));
    const workId = String(prepared.work.workId);
    const branch = String(prepared.work.branch);
    const checkoutId = String(prepared.work.checkoutId);
    const worktreePath = String(prepared.work.worktreePath);

    const executed = structured(await callExecutionTool(ctx, 'work_execute', {
      repo_id: repository.repoId,
      work_id: workId,
      command: 'printf managed-finalize > feature.txt',
    }));
    expect(executed.executedCount).toBe(1);

    const finalized = structured(await callExecutionTool(ctx, 'work_finalize', {
      repo_id: repository.repoId,
      work_id: workId,
      commit: true,
      message: 'Finalize managed worktree',
      merge: true,
      cleanup: true,
    }));
    expect(finalized.completed).toBe(true);
    expect(finalized.work.state).toBe('cleaned');
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoRoot, 'branch', '--list', branch)).toBe('');

    const refreshed = listRepositories(controllerHome, { includeRemoved: true }).find((entry) => entry.repoId === repository.repoId)!;
    const managedCheckout = refreshed.checkouts.find((checkout) => checkout.checkoutId === checkoutId)!;
    expect(repositoryCheckoutLifecycle(managedCheckout)).toBe('removed');
    expect(git(repoRoot, 'show', 'HEAD:feature.txt')).toBe('managed-finalize');

    const status = structured(await callExecutionTool(ctx, 'session_start', {}));
    expect(status.session.activeWorkId).toBeUndefined();
    expect(status.session.activeCheckoutId).toBe(repository.activeCheckoutId);
  });
});
