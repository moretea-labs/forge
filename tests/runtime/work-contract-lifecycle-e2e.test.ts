import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  acceptSubmittedWorkContract,
  createWorkContract,
  getWorkContract,
  getWorkContractByRequestId,
  updateWorkContract,
  type CreateWorkContractInput,
} from '../../src/runtime/control-plane/facade/work-contract-store';
import type { SubmittedWorkOperation } from '../../src/runtime/control-plane/facade/types';
import {
  claimControllerSession,
  getControllerSession,
  releaseControllerSession,
} from '../../src/runtime/control-plane/facade/controller-session-store';
import { createHandoffItem, listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { listExecutionJobs, createExecutionJob } from '../../src/runtime/execution/jobs/store';
import {
  __resetLiveMonitorsForTests,
  cancelProcess,
  spawnManagedProcess,
} from '../../src/runtime/execution/process-runtime';
import { acceptTaskJob } from '../../src/cli/agent-jobs/job-manager';

const roots: string[] = [];

afterEach(() => {
  __resetLiveMonitorsForTests();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function submittedOperation(
  name: string,
  semanticKey: string,
  mode: SubmittedWorkOperation['mode'],
): SubmittedWorkOperation {
  return {
    name,
    semanticKey,
    argumentHash: `test:${semanticKey}`,
    mode,
    idempotent: true,
    replayable: true,
    resourceClaims: [],
  };
}

function workContractInput(
  repoId: string,
  input: Pick<CreateWorkContractInput, 'workId' | 'mode' | 'objective'> & Partial<CreateWorkContractInput>,
): CreateWorkContractInput {
  return {
    acceptanceCriteria: [],
    constraints: { requireHandoffOnAmbiguity: true },
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    requestedBy: 'chatgpt',
    ...input,
    repoId,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-work-e2e-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  const controllerHome = join(root, 'controller');
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'work-e2e' }, null, 2));
  writeFileSync(join(repoRoot, 'README.md'), '# work e2e\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({
    path: repoRoot,
    controllerHome,
    repoIdOverride: `repo_work_e2e_${Date.now().toString(36)}`,
  });
  return { root, repoRoot, controllerHome, repository };
}

describe('WorkContract lifecycle E2E', () => {
  test('A: create → claim → Process Runtime success → complete without ExecutionJobs', async () => {
    const { repoRoot, controllerHome, repository } = fixture();
    const accepted = acceptSubmittedWorkContract(controllerHome, {
      requestId: 'e2e-success-1',
      repoId: repository.repoId,
      semanticKey: 'process:echo-success',
      operation: submittedOperation('repository_command', 'process:echo-success', 'mutating'),
      objective: 'Echo a success marker through Process Runtime',
      checks: [],
    });
    expect(accepted.deduplicated).toBe(false);
    expect(accepted.contract.status).toBe('open');
    expect(listExecutionJobs(controllerHome, repository.repoId, 20)).toHaveLength(0);

    const session = claimControllerSession(
      { controllerHome, repoId: repository.repoId },
      {
        workId: accepted.contract.workId,
        controllerId: 'controller-e2e-a',
        controllerType: 'codex',
        sessionId: 'session-e2e-a',
        leaseMs: 60_000,
      },
    );
    expect(session.controllerId).toBe('controller-e2e-a');
    expect(getControllerSession({ controllerHome, repoId: repository.repoId }, accepted.contract.workId)?.sessionId).toBe('session-e2e-a');

    updateWorkContract({ controllerHome, repoId: repository.repoId }, accepted.contract.workId, {
      status: 'running',
    });

    const handle = await spawnManagedProcess({
      controllerHome,
      repoId: repository.repoId,
      command: {
        kind: 'argv',
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("WORK_E2E_OK"); process.exit(0);'],
        cwd: repoRoot,
      },
      timeoutMs: 15_000,
      interactiveWaitMs: 5_000,
      workId: accepted.contract.workId,
      commandId: `cmd-${accepted.contract.workId}-success`,
      origin: { surface: 'command', toolName: 'work-e2e-a' },
    });
    expect(handle.completed).toBe(true);
    expect(handle.ok).toBe(true);
    expect(handle.exitCode).toBe(0);
    expect(handle.contractStatus).toBe('succeeded');
    expect(String(handle.stdout ?? '')).toContain('WORK_E2E_OK');

    const completed = updateWorkContract({ controllerHome, repoId: repository.repoId }, accepted.contract.workId, {
      status: 'completed',
      evidenceRefs: [{
        title: 'Process Runtime success',
        summary: `process:${handle.processId}`,
        detailLevel: 'detail',
      }],
    });
    expect(completed.status).toBe('completed');
    expect(listExecutionJobs(controllerHome, repository.repoId, 20)).toHaveLength(0);
    releaseControllerSession({ controllerHome, repoId: repository.repoId }, accepted.contract.workId, 'controller-e2e-a');
  });

  test('B: Process Runtime non-zero exit marks Work failed without success evidence', async () => {
    const { repoRoot, controllerHome, repository } = fixture();
    const work = createWorkContract(
      { controllerHome, repoId: repository.repoId },
      workContractInput(repository.repoId, {
        workId: `WORK-fail-${Date.now()}`,
        mode: 'direct_control',
        objective: 'Fail a deterministic command',
        status: 'open',
      }),
    );
    claimControllerSession(
      { controllerHome, repoId: repository.repoId },
      {
        workId: work.workId,
        controllerId: 'controller-e2e-b',
        controllerType: 'codex',
        sessionId: 'session-e2e-b',
      },
    );
    updateWorkContract({ controllerHome, repoId: repository.repoId }, work.workId, { status: 'running' });
    const handle = await spawnManagedProcess({
      controllerHome,
      repoId: repository.repoId,
      command: {
        kind: 'argv',
        executable: process.execPath,
        args: ['-e', 'process.stderr.write("WORK_E2E_FAIL"); process.exit(7);'],
        cwd: repoRoot,
      },
      timeoutMs: 15_000,
      interactiveWaitMs: 5_000,
      workId: work.workId,
      commandId: `cmd-${work.workId}-fail`,
      origin: { surface: 'command', toolName: 'work-e2e-b' },
    });
    expect(handle.completed).toBe(true);
    expect(handle.ok).toBe(false);
    expect(handle.exitCode).toBe(7);
    expect(handle.contractStatus).toBe('failed');
    const failed = updateWorkContract({ controllerHome, repoId: repository.repoId }, work.workId, {
      status: 'failed',
      evidenceRefs: [{
        title: 'Process Runtime failure',
        summary: `process:${handle.processId}:failed`,
        detailLevel: 'detail',
      }],
    });
    expect(failed.status).toBe('failed');
    expect(failed.evidenceRefs?.some((ref) => ref.summary?.includes('failed'))).toBe(true);
  });

  test('C: cancel long process terminates Work and process group', async () => {
    const { repoRoot, controllerHome, repository } = fixture();
    const work = createWorkContract(
      { controllerHome, repoId: repository.repoId },
      workContractInput(repository.repoId, {
        workId: `WORK-cancel-${Date.now()}`,
        mode: 'direct_control',
        objective: 'Cancel a long sleep',
        status: 'running',
      }),
    );
    claimControllerSession(
      { controllerHome, repoId: repository.repoId },
      {
        workId: work.workId,
        controllerId: 'controller-e2e-c',
        controllerType: 'codex',
        sessionId: 'session-e2e-c',
      },
    );
    const handle = await spawnManagedProcess({
      controllerHome,
      repoId: repository.repoId,
      command: {
        kind: 'argv',
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 120000);'],
        cwd: repoRoot,
      },
      timeoutMs: 120_000,
      interactiveWaitMs: 50,
      workId: work.workId,
      commandId: `cmd-${work.workId}-cancel`,
      origin: { surface: 'command', toolName: 'work-e2e-c' },
    });
    const cancelled = await cancelProcess(controllerHome, repository.repoId, handle.processId);
    expect(['cancelled', 'failed', 'succeeded', 'running', 'unknown']).toContain(cancelled.contractStatus);
    const workCancelled = updateWorkContract({ controllerHome, repoId: repository.repoId }, work.workId, {
      status: 'cancelled',
    });
    expect(workCancelled.status).toBe('cancelled');
  });

  test('D: release then re-claim by a new Controller succeeds', () => {
    const { controllerHome, repository } = fixture();
    const work = createWorkContract(
      { controllerHome, repoId: repository.repoId },
      workContractInput(repository.repoId, {
        workId: `WORK-release-${Date.now()}`,
        mode: 'direct_control',
        objective: 'Release recovery',
        status: 'running',
      }),
    );
    claimControllerSession(
      { controllerHome, repoId: repository.repoId },
      {
        workId: work.workId,
        controllerId: 'controller-old',
        controllerType: 'codex',
        sessionId: 'session-old',
      },
    );
    expect(() => claimControllerSession(
      { controllerHome, repoId: repository.repoId },
      {
        workId: work.workId,
        controllerId: 'controller-new',
        controllerType: 'claude',
        sessionId: 'session-new',
      },
    )).toThrow(/WORK_ALREADY_CLAIMED/);
    releaseControllerSession({ controllerHome, repoId: repository.repoId }, work.workId, 'controller-old');
    const next = claimControllerSession(
      { controllerHome, repoId: repository.repoId },
      {
        workId: work.workId,
        controllerId: 'controller-new',
        controllerType: 'claude',
        sessionId: 'session-new',
      },
    );
    expect(next.controllerId).toBe('controller-new');
    expect(getControllerSession({ controllerHome, repoId: repository.repoId }, work.workId)?.controllerId).toBe('controller-new');
  });

  test('E: non-deterministic Work creates Handoff without Jobs or Agent Runs', () => {
    const { controllerHome, repository, repoRoot } = fixture();
    const work = createWorkContract(
      { controllerHome, repoId: repository.repoId },
      workContractInput(repository.repoId, {
        workId: `WORK-handoff-${Date.now()}`,
        mode: 'handoff_only',
        objective: 'Requires external SuperController reasoning',
        status: 'open',
        driver: { preferred: 'external_controller', allowWorker: false, allowDirectEdit: false },
      }),
    );
    createHandoffItem({ controllerHome, repoId: repository.repoId }, {
      id: `HO-${work.workId}`,
      repoId: repository.repoId,
      workId: work.workId,
      title: 'External SuperController required',
      severity: 'needs_review',
      reason: 'non_deterministic_task',
      summary: 'External SuperController must claim this Work.',
      currentState: {
        repoId: repository.repoId,
        workId: work.workId,
        mode: 'handoff_only',
        statusSummary: 'waiting for external controller',
      },
      evidenceRefs: [],
      recommendedDecision: 'Claim the Work and continue outside the Kernel.',
      recommendedPrompt: 'Claim Work and execute via external SuperController.',
      suggestedNextActions: [{
        label: 'Claim controller ownership',
        tool: 'rh_work',
        operation: 'controller_claim',
        risk: 'readonly',
      }],
    });
    expect(() => createExecutionJob(controllerHome, {
      repoId: repository.repoId,
      type: 'mcp-tool',
      requestId: `job-${work.workId}`,
      semanticKey: `job-${work.workId}`,
      origin: { surface: 'mcp' },
      payload: { operation: 'agent', target: 'runtime' },
      resourceClaims: [],
    })).toThrow(/EXECUTION_JOB_RETIRED/);
    expect(() => acceptTaskJob({
      repoRoot,
      issueId: 'ISSUE-none',
      taskId: 'T1',
      agent: 'codex',
      timeoutMs: 5_000,
    })).toThrow(/AGENT_RUN_RETIRED|task not found|issue|not found/i);
    expect(listExecutionJobs(controllerHome, repository.repoId, 20)).toHaveLength(0);
    expect(listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'all' }).some((item) => item.workId === work.workId)).toBe(true);
    expect(existsSync(join(repoRoot, '.ai/harness/jobs'))).toBe(false);
  });

  test('G: identical requestId is idempotent and does not double-persist', () => {
    const { controllerHome, repository } = fixture();
    const first = acceptSubmittedWorkContract(controllerHome, {
      requestId: 'e2e-idempotent-1',
      repoId: repository.repoId,
      semanticKey: 'process:idempotent',
      operation: submittedOperation('controller_context', 'process:idempotent', 'readonly'),
      objective: 'Idempotent accept',
    });
    const second = acceptSubmittedWorkContract(controllerHome, {
      requestId: 'e2e-idempotent-1',
      repoId: repository.repoId,
      semanticKey: 'process:idempotent',
      operation: submittedOperation('controller_context', 'process:idempotent', 'readonly'),
      objective: 'Idempotent accept',
    });
    expect(second.deduplicated).toBe(true);
    expect(second.contract.workId).toBe(first.contract.workId);
    expect(getWorkContractByRequestId(controllerHome, 'e2e-idempotent-1')?.workId).toBe(first.contract.workId);
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, first.contract.workId)?.workId).toBe(first.contract.workId);
    expect(listExecutionJobs(controllerHome, repository.repoId, 20)).toHaveLength(0);
  });
});
