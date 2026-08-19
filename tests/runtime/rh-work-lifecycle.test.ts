import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createMcpToolContext } from '../../src/cli/mcp/server';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { addRepositoryCheckout, registerRepository, resolveRepositorySelection, setRepositoryCheckoutLifecycle } from '../../src/cli/repositories/registry';
import { callExecutionTool } from '../../src/runtime/gateway/mcp/execution-tools';
import { callRuntimeTool, classifyTerminalCheckEvidence, RH_WORK_VERIFY_LEASE_WAIT_MS } from '../../src/runtime/gateway/mcp/runtime-tools';
import { getProcessRecord, waitForProcess } from '../../src/runtime/execution/process-runtime';
import { getWorkContract, listWorkContracts, transitionWorkContractPhase, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { continueGoalWorkloop, finalizeGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
import { approvePlanContract, claimPlanStepForWork, completePlanStepForWork, createPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { readWorkHandle, writeWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { getExternalControllerLaunchReservation } from '../../src/runtime/control-plane/launcher/launch-reservation-store';
import { getSchedule, saveSchedule } from '../../src/runtime/workflow/schedules/store';
import { acquireExecutionLeases, releaseExecutionLeases } from '../../src/runtime/resources/leases/store';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureActiveRuntimeRelease } from '../../src/runtime/root/release-store';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaimForTests } from '../../src/runtime/root/write-fence';
const roots: string[] = [];
afterEach(() => {
  clearRuntimeWriteClaimForTests();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr || `git ${args.join(' ')} failed`));
  return String(result.stdout ?? '').trim();
}
function runtimeManifest(controllerHome: string): string {
  const path = join(controllerHome, 'lifecycle-test.manifest.json');
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'release-lifecycle-test',
    artifactIdentity: 'artifact-lifecycle-test',
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome,
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: new Date().toISOString(),
  }));
  return path;
}
function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `forge-rh-work-lifecycle-${label}-`));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Lifecycle Test']);
  git(repoRoot, ['config', 'user.email', 'lifecycle@example.test']);
  writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'fixture']);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: `lifecycle-${label}` });
  const owner = acquireRuntimeOwnership(controllerHome, `runtime-lifecycle-${label}`);
  const authority = ensureActiveRuntimeRelease(controllerHome, runtimeManifest(controllerHome));
  bindRuntimeWriteClaim({ controllerHome, owner: owner.record, authority });
  const runtimeService = forgeRuntimeServicePaths(controllerHome);
  mkdirSync(runtimeService.serviceRoot, { recursive: true });
  const runtimeTokenPath = join(controllerHome, 'mcp', 'runtime-token');
  mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
  writeFileSync(runtimeTokenPath, `fixture-token-${label}\n`, { mode: 0o600 });
  writeFileSync(runtimeService.configPath, JSON.stringify({
    schemaVersion: 1,
    controllerHome,
    repositoryRoot: repoRoot,
    host: '127.0.0.1',
    port: 9876,
    authTokenFile: runtimeTokenPath,
  }));
  const runtimeObservedAt = new Date().toISOString();
  writeRuntimeStatusSnapshot(controllerHome, {
    schemaVersion: 1,
    runtimeInstanceId: owner.record.runtimeInstanceId,
    pid: owner.record.pid,
    releaseId: authority.active.releaseId,
    artifactIdentity: authority.active.artifactIdentity,
    endpoint: 'http://127.0.0.1:9876/mcp',
    readiness: {
      ready: true,
      reasonCodes: [],
      diagnostics: {
        database: { outcome: 'pass' },
        scheduler: { outcome: 'pass' },
        releaseCoherence: { outcome: 'pass' },
        mcpEndToEnd: { outcome: 'pass' },
      },
      observedAt: runtimeObservedAt,
    },
    startedAt: runtimeObservedAt,
    updatedAt: runtimeObservedAt,
  });
  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
    sessionId: `mcp-lifecycle-${label}`,
    principalId: `principal-lifecycle-${label}`,
    controllerInstanceId: `runtime-lifecycle-${label}`,
  });
  return { root, controllerHome, repoRoot, repository, ctx, owner, authority };
}
async function prepareManagedWork(fx: ReturnType<typeof fixture>, objective: string) {
  const started = await callExecutionTool(fx.ctx, 'session_start', {});
  const sessionId = String((started?.structuredContent as { session?: { sessionId?: string } })?.session?.sessionId ?? '');
  expect(sessionId).toBeTruthy();
  const bound = await callExecutionTool(fx.ctx, 'session_bind_repository', {
    session_id: sessionId,
    repo_id: fx.repository.repoId,
  });
  expect(bound?.isError).not.toBe(true);
  const prepared = await callExecutionTool(fx.ctx, 'work_prepare', {
    session_id: sessionId,
    repo_id: fx.repository.repoId,
    objective,
    acceptance_criteria: ['Temporary managed Git resources are removed after delivery or stop.'],
    checks: [],
    isolation: 'new_worktree',
    request_id: `prepare-${objective.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
  });
  expect(prepared?.isError).not.toBe(true);
  return (prepared?.structuredContent as { work: { workId: string; checkoutId: string; worktreePath: string; branch: string } }).work;
}
function branchExists(root: string, branch: string): boolean {
  return spawnSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}
describe('rh_work managed lifecycle closure', () => {
  test('classifies terminal Check evidence without conflating pre-execution failure, missing receipt, and identity mismatch', () => {
    expect(RH_WORK_VERIFY_LEASE_WAIT_MS).toBe(8_000);
    expect(classifyTerminalCheckEvidence({
      processError: { code: 'FAILED', message: 'PROCESS_LEASE_CONFLICT: build-cache:repo@process:holder' },
      structuredPresent: false,
      structuredMatches: false,
      legacyPresent: false,
      legacyMatches: false,
    })).toMatchObject({
      state: 'process_runtime_failed_before_result',
      infrastructureReason: 'PROCESS_LEASE_CONFLICT: build-cache:repo@process:holder',
    });
    expect(classifyTerminalCheckEvidence({
      structuredPresent: true,
      structuredMatches: false,
      legacyPresent: false,
      legacyMatches: false,
    })).toEqual({
      state: 'mismatch',
      warning: 'check result receipt did not match the terminal Process semantic identity',
    });
    expect(classifyTerminalCheckEvidence({
      structuredPresent: false,
      structuredMatches: false,
      legacyPresent: false,
      legacyMatches: false,
    })).toEqual({
      state: 'missing',
      warning: 'check result receipt is missing for the terminal Check Process',
    });
    expect(classifyTerminalCheckEvidence({
      structuredPresent: true,
      structuredMatches: true,
      legacyPresent: false,
      legacyMatches: false,
    })).toEqual({ state: 'matched' });
  });
  test('verifies an isolated Work against its WorkContract checkout rather than active main', async () => {
    const fx = fixture('verify-work-checkout');
    writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({ scripts: { 'check:checkout': 'node -e "process.exit(0)"' } }, null, 2));
    git(fx.repoRoot, ['add', 'package.json']);
    git(fx.repoRoot, ['commit', '-m', 'add checkout check']);
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId, operation: 'start', objective: 'Verify one isolated checkout', scope_clear: true,
      expected_files: 1, expected_changed_lines: 1, requires_recovery: true, allowed_paths: ['README.md'],
      check_ids: ['package:check:checkout'], constraints: { workspaceMode: 'isolated' },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    expect(started?.isError).not.toBe(true); expect(contract.checkoutId).toBeTruthy(); expect(contract.checkoutId).not.toBe(fx.repository.activeCheckoutId);
    const verified = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'verify', work_id: workId, check_id: 'package:check:checkout', request_id: 'verify-work-checkout' });
    const processId = String((verified?.structuredContent as { data?: { verification?: { processId?: string } } })?.data?.verification?.processId ?? '');
    expect(verified?.isError).not.toBe(true); expect(processId).toBeTruthy();
    expect(getProcessRecord(fx.controllerHome, fx.repository.repoId, processId)?.checkoutId).toBe(contract.checkoutId);
    await waitForProcess(fx.controllerHome, fx.repository.repoId, processId, { timeoutMs: 5_000 });

    const continued = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'continue',
      work_id: workId,
    });
    expect(continued?.isError).not.toBe(true);
    expect(continued?.structuredContent).toMatchObject({ status: 'ok', data: { nextStep: 'finalize' } });
    const afterContinue = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const reconciled = afterContinue.checkRefs.find((record) => record.checkId === 'package:check:checkout' && record.outcome === 'valid_pass');
    expect(reconciled?.receipt).toMatchObject({
      processId,
      workId,
      checkoutId: contract.checkoutId,
      checkId: 'package:check:checkout',
      ok: true,
    });
  });
  test('waits through brief build-cache contention instead of creating a terminal failed verification Process', async () => {
    const fx = fixture('verify-build-cache-lease-wait');
    writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({
      scripts: { 'check:type': 'node -e "process.exit(0)"' },
    }, null, 2));
    git(fx.repoRoot, ['add', 'package.json']);
    git(fx.repoRoot, ['commit', '-m', 'add type check for lease wait']);
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Verify after a brief shared build-cache contention window',
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 1,
      requires_recovery: true,
      check_ids: ['package:check:type'],
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const held = acquireExecutionLeases(
      fx.controllerHome,
      fx.repository.repoId,
      'process:test-build-cache-holder',
      [{
        resourceKey: `build-cache:${fx.repository.repoId}`,
        mode: 'write',
        repoId: fx.repository.repoId,
      }],
      5_000,
    );
    expect(held.acquired).toBe(true);
    const releaseTimer = setTimeout(() => {
      releaseExecutionLeases(fx.controllerHome, fx.repository.repoId, 'process:test-build-cache-holder');
    }, 150);
    releaseTimer.unref?.();

    const verifyArgs = {
      repo_id: fx.repository.repoId,
      operation: 'verify' as const,
      work_id: workId,
      check_id: 'package:check:type',
      request_id: 'verify-after-build-cache-contention',
    };
    const startedAt = Date.now();
    let verified = await callRuntimeTool(fx.ctx, 'rh_work', verifyArgs);
    const admissionElapsedMs = Date.now() - startedAt;
    let verification = (verified?.structuredContent as { data?: { verification?: { processId?: string; outcome?: string; infrastructureReason?: string } } })?.data?.verification;
    expect(admissionElapsedMs).toBeGreaterThanOrEqual(100);
    expect(verification?.processId).toBeTruthy();
    if (verification?.processId && verification.outcome === 'running') {
      await waitForProcess(fx.controllerHome, fx.repository.repoId, verification.processId, { timeoutMs: 5_000 });
      verified = await callRuntimeTool(fx.ctx, 'rh_work', verifyArgs);
      verification = (verified?.structuredContent as { data?: { verification?: { processId?: string; outcome?: string; infrastructureReason?: string } } })?.data?.verification;
    }
    expect(verification?.outcome).toBe('valid_pass');
    expect(verification?.infrastructureReason).toBeUndefined();
    expect(getProcessRecord(fx.controllerHome, fx.repository.repoId, String(verification?.processId))?.checkoutId).toBe(contract.checkoutId);
  });

  test('rejects rh_work verify without check_id before recording verification evidence', async () => {
    const fx = fixture('verify-check-id-required');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Require an explicit verification check id',
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 1,
      requires_recovery: true,
      allowed_paths: ['README.md'],
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    expect(workId).toBeTruthy();
    const before = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const verified = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'verify',
      work_id: workId,
    });
    expect(verified?.isError).toBe(true);
    expect(verified?.structuredContent).toMatchObject({
      status: 'blocked',
      data: { verification: { outcome: 'check_id_required', isAcceptanceFailure: false } },
    });
    expect((verified?.structuredContent as { warnings?: string[] }).warnings?.[0]).toContain('CHECK_ID_REQUIRED');
    const after = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    expect(after.checkRefs).toEqual(before.checkRefs);
  });
  test('continue reconciles one completed Work-bound verification Process without a second verify call', async () => {
    const fx = fixture('managed-verification-reconcile-on-continue');
    writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({
      scripts: { 'check:reconcile': 'node -e "setTimeout(() => process.exit(0), 250)"' },
    }, null, 2));
    git(fx.repoRoot, ['add', 'package.json']);
    git(fx.repoRoot, ['commit', '-m', 'add reconciliation check']);

    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Reconcile one terminal managed verification process',
      scope_clear: true,
      expected_files: 2,
      expected_changed_lines: 20,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    expect(workId).toBeTruthy();

    const verified = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'package:check:reconcile',
      request_id: 'managed-reconcile-on-continue',
    });
    const verification = (verified?.structuredContent as { data?: { verification?: { processId?: string; outcome?: string } } })?.data?.verification;
    expect(verification?.outcome).toBe('running');
    expect(verification?.processId).toBeTruthy();
    await waitForProcess(fx.controllerHome, fx.repository.repoId, verification!.processId!, { timeoutMs: 5_000 });
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.checkRefs).toHaveLength(0);

    const continued = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'continue',
      work_id: workId,
    });
    expect(continued?.isError, JSON.stringify(continued?.structuredContent)).not.toBe(true);
    expect(continued?.structuredContent).toMatchObject({ status: 'ok', data: { nextStep: 'finalize' } });
    const reconciled = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    expect(reconciled.checkRefs).toHaveLength(1);
    expect(reconciled.checkRefs[0]).toMatchObject({
      checkId: 'package:check:reconcile',
      outcome: 'valid_pass',
      receipt: { processId: verification!.processId, ok: true, timedOut: false, cancelled: false },
    });
  });

  test('continue does not reconcile a completed verification Process after Work revision drift', async () => {
    const fx = fixture('managed-verification-reconcile-drift');
    writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({
      scripts: { 'check:reconcile-drift': 'node -e "setTimeout(() => process.exit(0), 250)"' },
    }, null, 2));
    git(fx.repoRoot, ['add', 'package.json']);
    git(fx.repoRoot, ['commit', '-m', 'add drift reconciliation check']);

    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Reject stale terminal verification evidence after drift',
      scope_clear: true,
      expected_files: 2,
      expected_changed_lines: 20,
      requires_recovery: true,
      allowed_paths: ['drift.txt'],
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const verified = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'package:check:reconcile-drift',
      request_id: 'managed-reconcile-drift',
    });
    const processId = String((verified?.structuredContent as { data?: { verification?: { processId?: string } } })?.data?.verification?.processId ?? '');
    expect(processId).toBeTruthy();
    await waitForProcess(fx.controllerHome, fx.repository.repoId, processId, { timeoutMs: 5_000 });

    writeFileSync(join(contract.worktreeRef!, 'drift.txt'), 'new revision\n');
    git(contract.worktreeRef!, ['add', 'drift.txt']);
    git(contract.worktreeRef!, ['commit', '-m', 'drift after managed verification']);
    await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'continue',
      work_id: workId,
    });
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.checkRefs).toHaveLength(0);
  });

  test('finalize safely adopts one clean Work-owned successor commit before merge', async () => {
    const fx = fixture('finalize-adopt-clean-successor');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Integrate one clean Work-owned successor commit',
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 10,
      requires_recovery: true,
      allowed_paths: ['successor.txt'],
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const worktreePath = contract.worktreeRef!;
    const branch = git(worktreePath, ['branch', '--show-current']);
    expect(readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)?.state).toBe('prepared');

    writeFileSync(join(worktreePath, 'successor.txt'), 'successor\n');
    git(worktreePath, ['add', 'successor.txt']);
    git(worktreePath, ['commit', '-m', 'work-owned successor']);

    const finalized = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: true,
      cleanup: true,
    });
    expect(finalized?.isError, JSON.stringify(finalized?.structuredContent)).not.toBe(true);
    expect(finalized?.structuredContent).toMatchObject({ status: 'ok', data: { lifecycleClosed: true } });
    expect(readFileSync(join(fx.repoRoot, 'successor.txt'), 'utf8')).toBe('successor\n');
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, branch)).toBe(false);
  });

  test('persists current Work-bound verification receipt and rejects it after revision drift', async () => {
    const fx = fixture('work-bound-verification-evidence');
    writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({
      scripts: { 'check:work-evidence': 'node -e "process.exit(0)"' },
    }, null, 2));
    git(fx.repoRoot, ['add', 'package.json']);
    git(fx.repoRoot, ['commit', '-m', 'add work evidence check']);

    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Prove a no-check Work with one authoritative Work-bound verification receipt',
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 1,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    const initial = getWorkContract(store, workId)!;
    expect(initial.checks).toEqual([]);
    const verifiedRevision = git(initial.worktreeRef!, ['rev-parse', 'HEAD']);
    const verifyArgs = {
      repo_id: fx.repository.repoId,
      operation: 'verify',
      work_id: workId,
      check_id: 'package:check:work-evidence',
    };
    let verified = await callRuntimeTool(fx.ctx, 'rh_work', verifyArgs);
    let verification = (verified?.structuredContent as { data?: { verification?: { processId?: string; outcome?: string } } })?.data?.verification;
    if (verification?.processId && verification.outcome === 'running') {
      await waitForProcess(fx.controllerHome, fx.repository.repoId, verification.processId, { timeoutMs: 5_000 });
      verified = await callRuntimeTool(fx.ctx, 'rh_work', verifyArgs);
      verification = (verified?.structuredContent as { data?: { verification?: { processId?: string; outcome?: string } } })?.data?.verification;
    }
    expect(verification?.outcome).toBe('valid_pass');

    const afterVerify = getWorkContract(store, workId)!;
    const persisted = afterVerify.checkRefs.find((record) => record.checkId === 'package:check:work-evidence' && record.outcome === 'valid_pass');
    expect(persisted?.sourceRevision).toBe(verifiedRevision);
    expect(persisted?.receipt).toMatchObject({
      repoId: fx.repository.repoId,
      workId,
      checkId: 'package:check:work-evidence',
      ok: true,
      timedOut: false,
      cancelled: false,
    });
    expect(persisted?.summary).toContain(String(persisted?.receipt?.receiptId));

    const currentEvidence = continueGoalWorkloop({
      workStore: store,
      handoffStore: store,
      repoId: fx.repository.repoId,
      sourceRevision: verifiedRevision,
    }, { workId });
    expect(currentEvidence.status).toBe('ok');
    expect(currentEvidence.data).toMatchObject({ nextStep: 'finalize' });

    writeFileSync(join(initial.worktreeRef!, 'revision-drift.txt'), 'new revision\n');
    git(initial.worktreeRef!, ['add', 'revision-drift.txt']);
    git(initial.worktreeRef!, ['commit', '-m', 'drift after verification']);
    const driftedRevision = git(initial.worktreeRef!, ['rev-parse', 'HEAD']);
    expect(driftedRevision).not.toBe(verifiedRevision);
    const staleFinalize = finalizeGoalWorkloop({
      workStore: store,
      handoffStore: store,
      repoId: fx.repository.repoId,
      sourceRevision: driftedRevision,
    }, { workId });
    expect(staleFinalize.status).toBe('blocked');
    expect(staleFinalize.summary).toContain('verification evidence is stale');
    expect(staleFinalize.data).toMatchObject({ validPasses: [], durableResultEvidence: false });
  });

  test('keeps ordinary repository commands independent from active Work while preserving the raw default-branch merge guard', async () => {
    const fx = fixture('workflow-command-attribution');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Own a recoverable default-checkout change',
      scope_clear: true,
      expected_files: 2,
      expected_changed_lines: 20,
      requires_recovery: true,
    });
    const workId = (started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId;
    expect(workId).toBeTruthy();
    const claimed = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workId, controller_type: 'chatgpt' });
    expect(claimed?.isError).not.toBe(true);

    const repositoryTools = await import('../../src/cli/mcp/repository-tools');
    const ordinary = await repositoryTools.callRepositoryTool(fx.controllerHome, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 250)'],
      apply_mode: 'async',
    }, fx.ctx);
    expect(ordinary?.isError).not.toBe(true);
    const processId = String((ordinary?.structuredContent as { processId?: string })?.processId ?? '');
    expect(processId).toBeTruthy();
    expect(getProcessRecord(fx.controllerHome, fx.repository.repoId, processId)?.workId).toBeUndefined();
    await Bun.sleep(350);

    const blocked = await repositoryTools.callRepositoryTool(fx.controllerHome, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: ['git', 'merge', '--ff-only', 'nonexistent'],
    }, fx.ctx);
    expect(blocked?.isError).toBe(true);
    expect((blocked?.structuredContent as { error?: { code?: string } }).error?.code).toBe('WORK_DELIVERY_REQUIRES_FINALIZE');
  });
  test('reuses exact Plan scope but resolves distinct slices under the same Requirement before creation', async () => { const fx = fixture('plan-admission'); const sourceRevision = git(fx.repoRoot, ['rev-parse', 'HEAD']).trim(); const step = (id: string) => [{ id, objective: 'Implement it', dependencies: [], authoritative_files: [], allowed_paths: [], forbidden_paths: [], check_ids: [], acceptance_criteria: ['done'] }]; const first = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-primary', requirement_id: 'REQ-primary', scope_key: 'primary-scope', source_revision: sourceRevision, objective: 'Implement the primary requirement', plan_steps: step('step-a'), }); expect(first?.isError).not.toBe(true); expect(first?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: true, admissionDecision: 'create_new' } }); const exactDuplicate = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-duplicate', requirement_id: 'REQ-primary', scope_key: 'primary-scope', source_revision: sourceRevision, objective: 'Duplicate exact scope', plan_steps: step('step-dup'), }); expect(exactDuplicate?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: false, admissionDecision: 'reuse_existing', plan: { planId: 'PLAN-primary' } } }); const ambiguousSlice = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-slice-b', requirement_id: 'REQ-primary', scope_key: 'parallel-scope', source_revision: sourceRevision, objective: 'A distinct slice under the same broad requirement', plan_steps: step('step-b'), }); expect(ambiguousSlice?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true, allowedPlanRelations: ['extend', 'parallel'] }, }); const parallelSlice = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-slice-b', requirement_id: 'REQ-primary', scope_key: 'parallel-scope', plan_relation: 'parallel', source_revision: sourceRevision, objective: 'A distinct explicitly parallel slice', plan_steps: step('step-b'), }); expect(parallelSlice?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: true, admissionDecision: 'create_new', plan: { planId: 'PLAN-slice-b', requirementId: 'REQ-primary' } } }); });
  test('exposes explicit Controller semantic acceptance for a delivered validating Plan step', async () => {
    const fx = fixture('plan-semantic-accept');
    const sourceRevision = git(fx.repoRoot, ['rev-parse', 'HEAD']).trim();
    const store = { controllerHome: fx.controllerHome, repoId: fx.repository.repoId };
    createPlanContract(store, {
      planId: 'PLAN-semantic-accept',
      repoId: fx.repository.repoId,
      scopeKey: 'plan-semantic-accept',
      sourceRevision,
      goal: 'Validate one delivered slice semantically',
      steps: [{ id: 'step-a', objective: 'Deliver the slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['package:check:type'], acceptanceCriteria: ['The delivered evidence is semantically correct.'] }],
    });
    approvePlanContract(store, 'PLAN-semantic-accept');
    claimPlanStepForWork(store, { planId: 'PLAN-semantic-accept', stepId: 'step-a', workId: 'work-semantic-accept', sourceRevision });
    completePlanStepForWork(store, {
      planId: 'PLAN-semantic-accept',
      stepId: 'step-a',
      work: {
        workId: 'work-semantic-accept',
        status: 'completed',
        phase: 'cleanup',
        evidenceState: 'valid',
        completionOutcome: 'completed_no_change',
        completionReceipt: {
          schemaVersion: 1,
          receiptId: 'receipt-semantic-accept',
          source: 'controller_work',
          issueId: 'ISS-semantic-accept',
          taskId: 'T1',
          workId: 'work-semantic-accept',
          targetBranch: 'main',
          targetRevision: sourceRevision,
          changedPaths: [],
          delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt: '2026-08-16T00:00:00.000Z' },
          cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt: '2026-08-16T00:00:00.000Z' },
          verifiedAt: '2026-08-16T00:00:00.000Z',
          recordedAt: '2026-08-16T00:00:00.000Z',
        },
        evidenceRefs: [{ title: 'Delivered Work evidence', summary: 'Machine delivery passed.' }],
      },
    });
    const accepted = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'plan_accept_step',
      plan_id: 'PLAN-semantic-accept',
      plan_step_id: 'step-a',
      acceptance_rationale: 'Reviewed the completed Work evidence against the Plan acceptance criterion.',
    });
    expect(accepted?.isError, JSON.stringify(accepted?.structuredContent)).not.toBe(true);
    expect(accepted?.structuredContent).toMatchObject({
      status: 'ok',
      data: {
        semanticAcceptanceRecorded: true,
        reviewer: 'principal-lifecycle-plan-semantic-accept',
        plan: { planId: 'PLAN-semantic-accept', status: 'finalized', completedSteps: 1 },
      },
    });
  });

  test('stopping a Plan-bound Work moves its Plan out of ghost executing state', async () => { const fx = fixture('plan-stop-reconcile'); writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({ scripts: { 'check:type': 'node -e "process.exit(0)"' } }, null, 2)); git(fx.repoRoot, ['add', 'package.json']); git(fx.repoRoot, ['commit', '-m', 'register plan lifecycle check']); const sourceRevision = git(fx.repoRoot, ['rev-parse', 'HEAD']).trim(); const created = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-stop-reconcile', scope_key: 'plan-stop-reconcile', source_revision: sourceRevision, objective: 'Run one stoppable planned slice', plan_steps: [{ id: 'step-a', objective: 'Execute stoppable work', dependencies: [], authoritative_files: [], allowed_paths: [], forbidden_paths: [], check_ids: ['package:check:type'], acceptance_criteria: ['finish or explicitly replan'], }], }); expect(created?.isError).not.toBe(true); const approved = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_approve', plan_id: 'PLAN-stop-reconcile' }); expect(approved?.isError).not.toBe(true); const started = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'start', plan_id: 'PLAN-stop-reconcile', plan_step_id: 'step-a', objective: 'Execute stoppable work', scope_clear: true, expected_files: 4, expected_changed_lines: 200, requires_recovery: true, }); expect(started?.isError).not.toBe(true); const workId = (started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId; expect(workId).toBeTruthy(); const stopped = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, reason: 'user intentionally stopped this planned slice', }); expect(stopped?.isError).not.toBe(true); expect(stopped?.structuredContent).toMatchObject({ status: 'ok', data: { finalStatus: 'cancelled', plan: { planId: 'PLAN-stop-reconcile', status: 'replanning', steps: [{ id: 'step-a', status: 'ready', workId }] }, }, }); const fetched = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_get', plan_id: 'PLAN-stop-reconcile', detail_level: 'detail' }); expect(fetched?.structuredContent).toMatchObject({ data: { plan: { status: 'replanning', steps: [{ id: 'step-a', status: 'ready', workId }] } } }); });

  test('rh_work finalize closes an explicitly reviewed historical Direct Edit delivery', async () => {
    const fx = fixture('historical-direct-edit');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'start', objective: 'Deliver one historical Direct Edit', scope_clear: true, expected_files: 1, expected_changed_lines: 5, requires_recovery: true, allowed_paths: ['historical.txt'] });
    expect(started?.isError).not.toBe(true);
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    writeFileSync(join(fx.repoRoot, 'historical.txt'), 'already integrated\n');
    git(fx.repoRoot, ['add', 'historical.txt']);
    git(fx.repoRoot, ['commit', '-m', 'historical direct edit']);
    const targetRevision = git(fx.repoRoot, ['rev-parse', 'HEAD']);

    const finalized = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      reconcile_historical_delivery: true,
      reconcile_target_revision: targetRevision,
      reconcile_compared_paths: ['historical.txt'],
      reconcile_rationale: 'The exact Work-owned path tree is already integrated at the reviewed commit.',
      reconcile_cleanup_proof: 'The Work used the current checkout and owns no managed branch or worktree cleanup.',
    });
    expect(finalized?.isError).not.toBe(true);
    expect(finalized?.structuredContent).toMatchObject({ status: 'ok', data: { lifecycleClosed: true, completionReceipt: { source: 'direct_edit_work', targetRevision } } });
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)).toMatchObject({ status: 'completed', completionOutcome: 'completed_changed' });
  });

  test('rh_work finalize owns exact validation, commit, merge, and cleanup without exposing work_validate', async () => {
    const fx = fixture('finalize');
    writeFileSync(join(fx.repoRoot, 'package.json'), JSON.stringify({ scripts: { 'check:finalize': 'node -e "process.exit(0)"' } }, null, 2));
    git(fx.repoRoot, ['add', 'package.json']); git(fx.repoRoot, ['commit', '-m', 'add finalize check']);
    const started = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'start', objective: 'Add one lifecycle acceptance file', scope_clear: true, expected_files: 4, expected_changed_lines: 200, requires_recovery: true, check_ids: ['package:check:finalize'], constraints: { requireWorktree: true } });
    expect(started?.isError).not.toBe(true);
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string }; executionHandle?: { workId?: string } } })?.data?.work?.workId ?? '');
    expect((started?.structuredContent as { data?: { executionHandle?: { workId?: string; managedWorktree?: boolean }; ownershipClaimed?: boolean } })?.data).toMatchObject({ executionHandle: { workId, managedWorktree: true }, ownershipClaimed: true });
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const work = { workId, worktreePath: contract.worktreeRef!, branch: git(contract.worktreeRef!, ['branch', '--show-current']) };
    writeFileSync(join(work.worktreePath, 'lifecycle.txt'), 'precommitted\n');
    git(work.worktreePath, ['add', 'lifecycle.txt']);
    git(work.worktreePath, ['commit', '-m', 'Work-owned progress']);
    writeFileSync(join(work.worktreePath, 'lifecycle.txt'), 'closed-loop\n');

    let finalized = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'finalize', work_id: work.workId });
    for (let attempt = 0; attempt < 4 && (finalized?.structuredContent as { status?: string })?.status !== 'ok'; attempt += 1) {
      expect(finalized?.isError).not.toBe(true);
      const validation = finalized?.structuredContent as { validation?: { checks?: Array<{ process?: { processId?: string } }> } };
      const processId = validation.validation?.checks?.find((entry) => entry.process?.processId)?.process?.processId;
      expect(processId).toBeTruthy();
      await waitForProcess(fx.controllerHome, fx.repository.repoId, processId!, { timeoutMs: 5_000 });
      finalized = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'finalize', work_id: work.workId });
    }
    expect(finalized?.isError).not.toBe(true);
    const payload = finalized?.structuredContent as { status?: string; data?: { lifecycleClosed?: boolean } };
    expect(payload.status).toBe('ok'); expect(payload.data?.lifecycleClosed).toBe(true);
    expect(readFileSync(join(fx.repoRoot, 'lifecycle.txt'), 'utf8')).toBe('closed-loop\n');
    expect(existsSync(work.worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, work.branch)).toBe(false);
  });

  test('failed finalize preserves checkout resources and the same Work can retry successfully', async () => {
    const fx = fixture('finalize-retry-preserves-worktree');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Retry one failed finalize without losing its worktree',
      scope_clear: true,
      expected_files: 2,
      expected_changed_lines: 20,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const worktreePath = contract.worktreeRef!;
    const branch = git(worktreePath, ['branch', '--show-current']);
    writeFileSync(join(worktreePath, 'retry.txt'), 'retryable\n');

    const failed = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: true,
      cleanup: true,
    });
    expect(failed?.isError).toBe(true);
    expect(JSON.stringify(failed?.structuredContent)).toContain('WORK_MERGE_UNCOMMITTED_CHANGES');
    expect(existsSync(worktreePath)).toBe(true);
    expect(branchExists(fx.repoRoot, branch)).toBe(true);
    expect(contract.checkoutId).toBeTruthy();
    const afterFailure = resolveRepositorySelection({ repoId: fx.repository.repoId, checkoutId: contract.checkoutId, controllerHome: fx.controllerHome, allowSoleRepository: false });
    expect(afterFailure.activeCheckoutId).toBe(contract.checkoutId!);

    const retried = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
    });
    expect(retried?.isError).not.toBe(true);
    expect(retried?.structuredContent).toMatchObject({ status: 'ok', data: { lifecycleClosed: true } });
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, branch)).toBe(false);
  });

  test('ff-only merge failure remains retryable and historical terminalized state can recover with no_ff', async () => {
    const fx = fixture('finalize-diverged-no-ff-retry');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Integrate one verified branch after main advances concurrently',
      scope_clear: true,
      expected_files: 2,
      expected_changed_lines: 20,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const worktreePath = contract.worktreeRef!;
    const branch = git(worktreePath, ['branch', '--show-current']);

    writeFileSync(join(worktreePath, 'work-change.txt'), 'from work\n');
    git(worktreePath, ['add', 'work-change.txt']);
    git(worktreePath, ['commit', '-m', 'work change']);

    writeFileSync(join(fx.repoRoot, 'concurrent-main.txt'), 'from main\n');
    git(fx.repoRoot, ['add', 'concurrent-main.txt']);
    git(fx.repoRoot, ['commit', '-m', 'concurrent main change']);

    const failed = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: true,
      cleanup: true,
    });
    expect(JSON.stringify(failed?.structuredContent)).toContain('Not possible to fast-forward');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)).toMatchObject({
      status: 'blocked',
      phase: 'delivery',
    });
    expect(existsSync(worktreePath)).toBe(true);
    expect(branchExists(fx.repoRoot, branch)).toBe(true);

    // Reproduce the historical bug written by older runtimes: a retryable
    // delivery-stage failure was projected as a terminal failed WorkContract.
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId, { status: 'failed' });
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)).toMatchObject({
      status: 'failed',
      phase: 'cleanup',
    });

    const retried = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: true,
      cleanup: true,
      no_ff: true,
    });
    expect(retried?.isError).not.toBe(true);
    expect(retried?.structuredContent).toMatchObject({
      status: 'ok',
      data: {
        lifecycleClosed: true,
        completionReceipt: {
          changedPaths: ['work-change.txt'],
        },
      },
    });
    expect(readFileSync(join(fx.repoRoot, 'work-change.txt'), 'utf8')).toBe('from work\n');
    expect(readFileSync(join(fx.repoRoot, 'concurrent-main.txt'), 'utf8')).toBe('from main\n');
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, branch)).toBe(false);
  });

  test('cleanup-only finalize restores an exact expected HEAD already integrated into target before cleaning', async () => {
    const fx = fixture('finalize-exact-head-cleanup-boundary');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Clean one Work whose exact expected HEAD was already integrated',
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 5,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    expect(started?.isError).not.toBe(true);
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const worktreePath = contract.worktreeRef!;
    const branch = git(worktreePath, ['branch', '--show-current']);

    writeFileSync(join(worktreePath, 'exact-head-cleanup.txt'), 'integrated\n');
    git(worktreePath, ['add', 'exact-head-cleanup.txt']);
    git(worktreePath, ['commit', '-m', 'exact head cleanup change']);
    const workHead = git(worktreePath, ['rev-parse', 'HEAD']);
    git(fx.repoRoot, ['merge', '--ff-only', branch]);

    const handle = readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)!;
    writeWorkHandle(fx.controllerHome, {
      ...handle,
      state: 'prepared',
      expectedHead: workHead,
      finalization: {
        validation: 'pending',
        commit: 'pending',
        merge: 'pending',
        worktreeCleanup: 'pending',
        branchCleanup: 'pending',
      },
    });

    const finalized = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      completion_outcome: 'completed_changed',
    });
    expect(finalized?.isError, JSON.stringify(finalized?.structuredContent)).not.toBe(true);
    expect(finalized?.structuredContent).toMatchObject({ status: 'ok', data: { lifecycleClosed: true } });
    expect(readFileSync(join(fx.repoRoot, 'exact-head-cleanup.txt'), 'utf8')).toBe('integrated\n');
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, branch)).toBe(false);

    const repeated = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      completion_outcome: 'completed_changed',
    });
    expect(repeated?.isError, JSON.stringify(repeated?.structuredContent)).not.toBe(true);
    expect(JSON.stringify(repeated?.structuredContent)).not.toContain('CHECKOUT_NOT_ACTIVE');
  });

  test('cleanup-only finalize preserves an unintegrated exact expected HEAD instead of deleting its worktree', async () => {
    const fx = fixture('finalize-unintegrated-cleanup-blocked');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Refuse cleanup before changed delivery is integrated',
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 5,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    expect(started?.isError).not.toBe(true);
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const worktreePath = contract.worktreeRef!;
    const branch = git(worktreePath, ['branch', '--show-current']);

    writeFileSync(join(worktreePath, 'unintegrated-cleanup.txt'), 'not delivered\n');
    git(worktreePath, ['add', 'unintegrated-cleanup.txt']);
    git(worktreePath, ['commit', '-m', 'unintegrated cleanup change']);
    const workHead = git(worktreePath, ['rev-parse', 'HEAD']);
    const handle = readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)!;
    writeWorkHandle(fx.controllerHome, { ...handle, state: 'prepared', expectedHead: workHead });

    const finalized = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      completion_outcome: 'completed_changed',
    });
    expect(finalized?.isError).toBe(true);
    expect(JSON.stringify(finalized?.structuredContent)).toContain('WORK_CLEANUP_DELIVERY_NOT_PROVEN');
    expect(existsSync(worktreePath)).toBe(true);
    expect(branchExists(fx.repoRoot, branch)).toBe(true);
    expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(workHead);
  });

  test('cleanup retry restores a failed handle to the merged delivery boundary before cleaning', async () => {
    const fx = fixture('finalize-cleanup-retry-boundary');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Resume cleanup after delivery was already integrated',
      scope_clear: true,
      expected_files: 2,
      expected_changed_lines: 20,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const worktreePath = contract.worktreeRef!;
    const branch = git(worktreePath, ['branch', '--show-current']);
    writeFileSync(join(worktreePath, 'cleanup-retry.txt'), 'integrated\n');
    git(worktreePath, ['add', 'cleanup-retry.txt']);
    git(worktreePath, ['commit', '-m', 'cleanup retry change']);
    const workHead = git(worktreePath, ['rev-parse', 'HEAD']);
    git(fx.repoRoot, ['merge', '--ff-only', branch]);

    const handle = readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)!;
    writeWorkHandle(fx.controllerHome, {
      ...handle,
      state: 'failed',
      expectedHead: workHead,
      failureReason: 'simulated worktree cleanup failure after merge',
      finalization: {
        validation: 'done',
        commit: 'done',
        merge: 'done',
        worktreeCleanup: 'failed',
        branchCleanup: 'pending',
        lastError: 'simulated worktree cleanup failure after merge',
      },
    });
    transitionWorkContractPhase(
      { controllerHome: fx.controllerHome, repoId: fx.repository.repoId },
      workId,
      {
        phase: 'cleanup',
        status: 'blocked',
        state: 'blocked',
        summary: 'Simulated retryable cleanup failure after integrated delivery.',
      },
    );

    const retried = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      completion_outcome: 'completed_changed',
    });
    expect(retried?.isError).not.toBe(true);
    expect(retried?.structuredContent).toMatchObject({ status: 'ok', data: { lifecycleClosed: true } });
    expect(readFileSync(join(fx.repoRoot, 'cleanup-retry.txt'), 'utf8')).toBe('integrated\n');
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, branch)).toBe(false);
  });

  test('no-change finalize establishes delivery before cleanup and closes cleanly', async () => {
    const fx = fixture('finalize-no-change');
    const started = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'start',
      objective: 'Prove no repository change is required',
      scope_clear: true,
      expected_files: 1,
      expected_changed_lines: 1,
      requires_recovery: true,
      constraints: { requireWorktree: true },
    });
    const workId = String((started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId ?? '');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)!;
    const worktreePath = contract.worktreeRef!;
    const branch = git(worktreePath, ['branch', '--show-current']);

    const finalized = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: workId,
      commit: false,
      merge: false,
      cleanup: true,
      completion_outcome: 'completed_no_change',
      no_change_evidence: 'Inspection and verification prove the requested behavior already exists with no repository delta.',
    });
    expect(finalized?.isError).not.toBe(true);
    expect(finalized?.structuredContent).toMatchObject({
      status: 'ok',
      data: { lifecycleClosed: true, completionReceipt: { delivery: { kind: 'no_change', status: 'integrated' } } },
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, branch)).toBe(false);
  });

  test('stop can close a legacy Work after its source checkout registry entry was removed', async () => {
    const fx = fixture('removed-source');
    const work = await prepareManagedWork(fx, 'Legacy Work whose source checkout was already removed');
    const replacementRoot = join(fx.root, 'replacement-checkout');
    git(fx.repoRoot, ['worktree', 'add', '-b', 'replacement-checkout', replacementRoot, 'main']);
    addRepositoryCheckout({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      path: replacementRoot,
      activate: true,
    });
    setRepositoryCheckoutLifecycle({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      lifecycle: 'removed',
      reason: 'simulate an earlier partial lifecycle cleanup',
    });

    const stopped = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'stop',
      work_id: work.workId,
      reason: 'legacy cleanup acceptance',
    });
    expect(stopped?.isError).not.toBe(true);
    const payload = stopped?.structuredContent as { status?: string; data?: { worktreeDeleted?: boolean; cleanupPending?: boolean } };
    expect(payload.status).toBe('ok');
    expect(payload.data?.worktreeDeleted).toBe(true);
    expect(payload.data?.cleanupPending).toBe(false);
    expect(existsSync(work.worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, work.branch)).toBe(false);
  });

  test('stop cancels and automatically removes the managed worktree and branch', async () => {
    const fx = fixture('stop');
    const work = await prepareManagedWork(fx, 'Disposable no-change acceptance Work');

    const stopped = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'stop',
      work_id: work.workId,
      reason: 'acceptance complete',
    });
    expect(stopped?.isError).not.toBe(true);
    const payload = stopped?.structuredContent as { status?: string; data?: { worktreeDeleted?: boolean; cleanupPending?: boolean } };
    expect(payload.status).toBe('ok');
    expect(payload.data?.worktreeDeleted).toBe(true);
    expect(payload.data?.cleanupPending).toBe(false);
    expect(existsSync(work.worktreePath)).toBe(false);
    expect(branchExists(fx.repoRoot, work.branch)).toBe(false);
  });

  test('rh_work creates a Work-free workflow schedule with one finite shadow occurrence', async () => { const fx = fixture('schedule-workflow'); expect(listWorkContracts({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId })).toHaveLength(0); const created = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_create', schedule_mode: 'workflow', objective: 'Review current Forge issues and repair only a clear reproducible defect; otherwise do nothing.', schedule_name: 'Forge issue workflow', trigger_type: 'manual', shadow_mode: true, schedule_request_id: 'generic-workflow-schedule-stable' }); expect(created?.isError).not.toBe(true); const schedule = (created?.structuredContent as { data?: { schedule?: { scheduleId?: string; action?: { operation?: string; arguments?: Record<string, unknown> } } } })?.data?.schedule; const scheduleId = schedule?.scheduleId ?? ''; expect(scheduleId).toBeTruthy(); expect(schedule?.action?.operation).toBe('chatgpt_browser_prompt'); expect(schedule?.action?.arguments?.prompt).toContain('repair only a clear reproducible defect'); expect(schedule?.action?.arguments?.work_id).toBeUndefined(); expect(listWorkContracts({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId })).toHaveLength(0); const triggered = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_trigger', schedule_id: scheduleId }); expect(triggered?.isError).not.toBe(true); const occurrence = (triggered?.structuredContent as { data?: { occurrence?: { status?: string; decision?: string; occurrenceId?: string } } })?.data?.occurrence; expect(occurrence).toMatchObject({ status: 'shadowed', decision: 'would_execute' }); expect(occurrence?.occurrenceId).toBeTruthy(); expect(listWorkContracts({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId })).toHaveLength(0); const fetched = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_get', schedule_id: scheduleId, include_occurrences: true }); expect((fetched?.structuredContent as { data?: { occurrences?: Array<{ occurrenceId?: string }> } })?.data?.occurrences?.map((entry) => entry.occurrenceId)).toContain(occurrence?.occurrenceId); });

  test('rh_work manages one idempotent continuation schedule for bounded Work', async () => {
    const fx = fixture('schedule-management');
    const work = await prepareManagedWork(fx, 'Continue this bounded Work without repeated user prompts');

    const created = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_create',
      work_id: work.workId,
      controller_type: 'codex',
      executable: '/usr/bin/true',
      trigger_type: 'interval',
      every_minutes: 60,
      schedule_request_id: 'schedule-management-stable',
    });
    expect(created?.isError).not.toBe(true);
    const createdPayload = created?.structuredContent as { status?: string; data?: { schedule?: { scheduleId: string; policy: { shadowMode: boolean }; action: { operation: string; arguments?: Record<string, unknown> } } } };
    expect(createdPayload.status).toBe('ok');
    const scheduleId = createdPayload.data?.schedule?.scheduleId ?? '';
    expect(scheduleId).toBeTruthy();
    expect(createdPayload.data?.schedule?.policy.shadowMode).toBe(true);
    expect(createdPayload.data?.schedule?.action.operation).toBe('external_controller_wake');
    expect(createdPayload.data?.schedule?.action.arguments?.work_id).toBe(work.workId);

    const duplicate = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_create',
      work_id: work.workId,
      controller_type: 'codex',
      executable: '/usr/bin/true',
      trigger_type: 'interval',
      every_minutes: 60,
      schedule_request_id: 'schedule-management-stable',
    });
    const duplicatePayload = duplicate?.structuredContent as { data?: { schedule?: { scheduleId: string } } };
    expect(duplicatePayload.data?.schedule?.scheduleId).toBe(scheduleId);

    const reconfigured = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_create',
      work_id: work.workId,
      controller_type: 'chatgpt',
      trigger_type: 'interval',
      every_minutes: 15,
      continuation_prompt: 'Continue the same authoritative Work with the updated scope.',
    });
    const reconfiguredPayload = reconfigured?.structuredContent as { data?: { schedule?: { scheduleId: string; trigger?: { everyMinutes?: number }; action?: { arguments?: Record<string, unknown> } } } };
    expect(reconfiguredPayload.data?.schedule?.scheduleId).toBe(scheduleId);
    expect(reconfiguredPayload.data?.schedule?.trigger?.everyMinutes).toBe(15);
    expect(reconfiguredPayload.data?.schedule?.action?.arguments?.continuation_prompt).toContain('same authoritative Work');

    const listed = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_list', work_id: work.workId });
    const listedPayload = listed?.structuredContent as { data?: { schedules?: Array<{ scheduleId: string; enabled?: boolean }> } };
    expect(listedPayload.data?.schedules?.filter((entry) => entry.enabled !== false).map((entry) => entry.scheduleId)).toEqual([scheduleId]);

    const paused = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_pause', schedule_id: scheduleId, reason: 'test pause' });
    const pausedPayload = paused?.structuredContent as { data?: { schedule?: { enabled: boolean; pausedReason?: string } } };
    expect(pausedPayload.data?.schedule?.enabled).toBe(false);
    expect(pausedPayload.data?.schedule?.pausedReason).toBe('test pause');

    const fused = getSchedule(fx.controllerHome, fx.repository.repoId, scheduleId);
    saveSchedule(fx.controllerHome, {
      ...fused,
      enabled: false,
      consecutiveFailures: fused.policy.maxFailures,
      nextEligibleAt: '2099-01-01T00:00:00.000Z',
      pausedReason: 'Maximum consecutive failures reached.',
    });
    const resumed = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_resume', schedule_id: scheduleId });
    const resumedPayload = resumed?.structuredContent as { data?: { schedule?: { enabled: boolean; pausedReason?: string; consecutiveFailures?: number; nextEligibleAt?: string } } };
    expect(resumedPayload.data?.schedule?.enabled).toBe(true);
    expect(resumedPayload.data?.schedule?.pausedReason).toBeUndefined();
    expect(resumedPayload.data?.schedule?.consecutiveFailures).toBe(0);
    expect(resumedPayload.data?.schedule?.nextEligibleAt).toBeUndefined();
  });

  test('rh_work creates a standalone browser keepalive without a durable Work', async () => {
    const fx = fixture('schedule-browser-keepalive-standalone');
    expect(listWorkContracts({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId })).toHaveLength(0);

    const created = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_create',
      schedule_mode: 'browser_keepalive',
      controller_type: 'chatgpt',
      trigger_type: 'manual',
      probe_browser_session_id: 'browser-xiaohongshu-session',
      login_url_terms: ['/login', 'passport.xiaohongshu.com'],
      login_text_terms: ['手机号登录', '扫码登录'],
      auth_required_prompt: 'Xiaohongshu login expired; request only the necessary user re-authentication.',
      shadow_mode: false,
      schedule_request_id: 'schedule-browser-keepalive-standalone',
      schedule_name: 'Xiaohongshu Session Keepalive',
    });

    expect(created?.isError).not.toBe(true);
    const schedule = (created?.structuredContent as { data?: { schedule?: { action?: { operation?: string; arguments?: Record<string, unknown> }; stopConditions?: string[] } } })?.data?.schedule;
    expect(schedule?.action?.operation).toBe('browser_probe');
    expect(schedule?.action?.arguments).toMatchObject({
      probe_session_id: 'browser-xiaohongshu-session',
      keepalive_only: true,
      wake_on_change: false,
    });
    expect(schedule?.action?.arguments?.work_id).toBeUndefined();
    expect(schedule?.stopConditions).toEqual([]);
    expect(listWorkContracts({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId })).toHaveLength(0);
  });

  test('rh_work creates a Work-bound browser watcher and stops it before browser access when Work is terminal', async () => {
    const fx = fixture('schedule-browser-watch');
    const work = await prepareManagedWork(fx, 'Wait for one external browser-visible dependency');

    const created = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_create',
      work_id: work.workId,
      schedule_mode: 'browser_watch',
      controller_type: 'chatgpt',
      trigger_type: 'manual',
      probe_url: 'https://example.invalid/external-dependency',
      include_terms: ['Apple Support', 'CASE-12345'],
      ignore_patterns: ['\\b\\d{1,2}:\\d{2}\\b'],
      login_url_terms: ['/login'],
      wake_on_first_observation: false,
      shadow_mode: false,
      schedule_request_id: 'schedule-browser-watch-stable',
    });
    expect(created?.isError).not.toBe(true);
    const createdPayload = created?.structuredContent as { data?: { schedule?: { scheduleId?: string; action?: { operation?: string; arguments?: Record<string, unknown> } } } };
    const scheduleId = createdPayload.data?.schedule?.scheduleId ?? '';
    expect(scheduleId).toBeTruthy();
    expect(createdPayload.data?.schedule?.action?.operation).toBe('browser_probe');
    expect(createdPayload.data?.schedule?.action?.arguments).toMatchObject({
      work_id: work.workId,
      probe_url: 'https://example.invalid/external-dependency',
      include_terms: ['Apple Support', 'CASE-12345'],
      wake_on_change: true,
      keepalive_only: false,
    });

    const stopped = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'stop',
      work_id: work.workId,
      reason: 'external dependency goal completed',
    });
    expect(stopped?.isError).not.toBe(true);

    const triggered = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_trigger',
      schedule_id: scheduleId,
    });
    expect(triggered?.isError).not.toBe(true);
    const occurrence = (triggered?.structuredContent as { data?: { occurrence?: { decision?: string; status?: string; reason?: string } } })?.data?.occurrence;
    expect(occurrence?.decision).toBe('nothing_to_do');
    expect(occurrence?.status).toBe('skipped');
    expect(occurrence?.reason).toContain('terminal');

    const fetched = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_get',
      schedule_id: scheduleId,
    });
    const fetchedSchedule = (fetched?.structuredContent as { data?: { schedule?: { enabled?: boolean; pausedReason?: string } } })?.data?.schedule;
    expect(fetchedSchedule?.enabled).toBe(false);
    expect(fetchedSchedule?.pausedReason).toContain('terminal');
  });

  test('non-shadow continuation trigger reserves one launch while authenticated MCP retains Work ownership authority', async () => {
    const fx = fixture('schedule-live-wake');
    const work = await prepareManagedWork(fx, 'Wake one external Controller for this bounded Work');
    const created = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_create',
      work_id: work.workId,
      controller_type: 'codex',
      executable: '/usr/bin/true',
      trigger_type: 'manual',
      shadow_mode: false,
      schedule_request_id: 'schedule-live-wake-stable',
    });
    const scheduleId = ((created?.structuredContent as { data?: { schedule?: { scheduleId?: string } } })?.data?.schedule?.scheduleId ?? '');
    expect(scheduleId).toBeTruthy();

    const released = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'controller_release',
      work_id: work.workId,
    });
    expect(released?.isError).not.toBe(true);
    const runtimeObservedAt = new Date().toISOString();
    writeRuntimeStatusSnapshot(fx.controllerHome, {
      schemaVersion: 1,
      runtimeInstanceId: fx.owner.record.runtimeInstanceId,
      pid: fx.owner.record.pid,
      releaseId: fx.authority.active.releaseId,
      artifactIdentity: fx.authority.active.artifactIdentity,
      endpoint: 'http://127.0.0.1:9876/mcp',
      readiness: {
        ready: true, reasonCodes: [],
        diagnostics: { database: { outcome: 'pass' }, scheduler: { outcome: 'pass' }, releaseCoherence: { outcome: 'pass' }, mcpEndToEnd: { outcome: 'pass' } },
        observedAt: runtimeObservedAt,
      },
      startedAt: runtimeObservedAt, updatedAt: runtimeObservedAt,
    });

    const triggered = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_trigger', schedule_id: scheduleId });
    expect(triggered?.isError).not.toBe(true);
    const occurrence = (triggered?.structuredContent as { data?: { occurrence?: { decision?: string; status?: string } } })?.data?.occurrence;
    expect(occurrence).toMatchObject({ decision: 'execute', status: 'succeeded' });

    const ownerBeforeMcp = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'controller_get_owner', work_id: work.workId });
    const ownerBeforeMcpPayload = ownerBeforeMcp?.structuredContent as { data?: { owner?: unknown } };
    expect(ownerBeforeMcpPayload.data?.owner).toBeUndefined();
    const reservation = getExternalControllerLaunchReservation({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, work.workId);
    expect(reservation?.controllerType).toBe('codex');
    expect(reservation?.pid).toBeTruthy();

    const second = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_trigger',
      schedule_id: scheduleId,
      event_name: 'manual-second-window',
      event_id: 'manual-second-window-1',
    });
    const secondOccurrence = (second?.structuredContent as { data?: { occurrence?: { decision?: string; reason?: string } } })?.data?.occurrence;
    expect(secondOccurrence?.decision).toBe('nothing_to_do');
    expect(secondOccurrence?.reason).toContain('pending external Controller launch');

    const externalPrincipal = `external:codex:${reservation!.reservationId}`;
    const externalSession = `external-session:codex:${reservation!.reservationId}`;
    const externalCtx = createMcpToolContext({
      repo: fx.repoRoot,
      controllerHome: fx.controllerHome,
      profile: 'controller',
      principalId: externalPrincipal,
      sessionId: externalSession,
      controllerType: 'codex',
      controllerInstanceId: fx.owner.record.runtimeInstanceId,
    });
    const continued = await callRuntimeTool(externalCtx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'continue', work_id: work.workId });
    const continuedPayload = continued?.structuredContent as { data?: { ownershipResumed?: boolean; controllerSession?: { controllerId?: string; sessionId?: string; controllerType?: string } } };
    expect(continuedPayload.data?.ownershipResumed).toBe(true);
    expect(continuedPayload.data?.controllerSession?.controllerId).toBe(externalPrincipal); const claimed = await callRuntimeTool(externalCtx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: work.workId, controller_type: 'codex' }); expect(claimed?.isError).not.toBe(true);
    expect(continuedPayload.data?.controllerSession?.sessionId).toBe(externalSession); const executionSession = (await import('../../src/runtime/control-plane/execution/session-store')).readExecutionSession(fx.controllerHome, { sessionId: externalSession, principalId: externalPrincipal, controllerInstanceId: fx.owner.record.runtimeInstanceId }); expect(executionSession?.activeWorkId).toBe(work.workId);
    expect(continuedPayload.data?.controllerSession?.controllerType).toBe('codex'); const transientCtx = { ...externalCtx, sessionId: `${externalSession}-next` }; const command = await (await import('../../src/cli/mcp/repository-tools')).callRepositoryTool(fx.controllerHome, 'repository_command_execute', { repo_id: fx.repository.repoId, checkout_id: executionSession?.activeCheckoutId, command: ['bun', '-e', 'await Bun.sleep(250)'], detail_level: 'detail', return_handle_immediately: true }, transientCtx); expect((command?.structuredContent as { process?: { workId?: string } }).process?.workId).toBeUndefined(); await Bun.sleep(300); const patch = await (await import('../../src/cli/mcp/repository-tools')).callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', { repo_id: fx.repository.repoId, checkout_id: executionSession?.activeCheckoutId, purpose: 'Workflow-bound edit', allowed_paths: ['workflow-attribution.txt'], operations: [{ type: 'create', path: 'workflow-attribution.txt', content: 'owned\n' }] }, transientCtx); expect((patch?.structuredContent as { session?: { workId?: string } }).session?.workId).toBe(work.workId);
    const ownerAfterMcp = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'controller_get_owner', work_id: work.workId });
    const ownerAfterMcpPayload = ownerAfterMcp?.structuredContent as { data?: { owner?: { controllerId?: string; sessionId?: string; controllerType?: string } } };
    expect(ownerAfterMcpPayload.data?.owner?.controllerId).toBe(externalPrincipal);
    expect(ownerAfterMcpPayload.data?.owner?.sessionId).toBe(externalSession);
    expect(ownerAfterMcpPayload.data?.owner?.controllerType).toBe('codex');

    const handedOff = await callRuntimeTool(externalCtx, 'rh_inbox', {
      repo_id: fx.repository.repoId,
      operation: 'create',
      handoff_id: 'hnd-schedule-live-wake-yield',
      work_id: work.workId,
      title: 'Validation needs controller judgement',
      reason: 'Bounded infrastructure blocker.',
      summary: 'Yield control instead of retaining a stale owner lease.',
      recommended_decision: 'Repair the blocker and resume later.',
      recommended_prompt: 'Resume after the blocker is repaired.',
    });
    const handoffPayload = handedOff?.structuredContent as { data?: { ownershipReleased?: boolean } };
    expect(handoffPayload.data?.ownershipReleased).toBe(true);
    const ownerAfterHandoff = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'controller_get_owner', work_id: work.workId });
    expect((ownerAfterHandoff?.structuredContent as { data?: { owner?: unknown } }).data?.owner).toBeUndefined();
  });

  test('continuation schedule disables itself instead of waking a terminal Work', async () => {
    const fx = fixture('schedule-terminal-stop');
    const work = await prepareManagedWork(fx, 'Stop automatic continuation once acceptance is terminal');
    const created = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_create',
      work_id: work.workId,
      controller_type: 'codex',
      executable: '/usr/bin/true',
      trigger_type: 'manual',
      shadow_mode: false,
      schedule_request_id: 'schedule-terminal-stop-stable',
    });
    const createdPayload = created?.structuredContent as { data?: { schedule?: { scheduleId: string } } };
    const scheduleId = createdPayload.data?.schedule?.scheduleId ?? '';
    expect(scheduleId).toBeTruthy();

    const stopped = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'stop',
      work_id: work.workId,
      reason: 'acceptance is terminal',
    });
    expect(stopped?.isError).not.toBe(true);

    const triggered = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_trigger',
      schedule_id: scheduleId,
    });
    expect(triggered?.isError).not.toBe(true);
    const triggeredPayload = triggered?.structuredContent as { data?: { occurrence?: { decision: string; status: string; reason?: string } } };
    expect(triggeredPayload.data?.occurrence?.decision).toBe('nothing_to_do');
    expect(triggeredPayload.data?.occurrence?.status).toBe('skipped');
    expect(triggeredPayload.data?.occurrence?.reason).toContain('automatic continuation stopped');

    const fetched = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_get', schedule_id: scheduleId });
    const fetchedPayload = fetched?.structuredContent as { data?: { schedule?: { enabled: boolean; pausedReason?: string } } };
    expect(fetchedPayload.data?.schedule?.enabled).toBe(false);
    expect(fetchedPayload.data?.schedule?.pausedReason).toContain('terminal');
  });
});
