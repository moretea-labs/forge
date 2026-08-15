import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createMcpToolContext } from '../../src/cli/mcp/server';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { addRepositoryCheckout, registerRepository, setRepositoryCheckoutLifecycle } from '../../src/cli/repositories/registry';
import { callExecutionTool } from '../../src/runtime/gateway/mcp/execution-tools';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { getProcessRecord, waitForProcess } from '../../src/runtime/execution/process-runtime';
import { getWorkContract, listWorkContracts } from '../../src/runtime/control-plane/facade/work-contract-store';
import { getExternalControllerLaunchReservation } from '../../src/runtime/control-plane/launcher/launch-reservation-store';
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
  });
  test('requires Work finalize instead of raw default-branch merge for an active Workflow', async () => { const fx = fixture('workflow-delivery-guard'); const started = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'start', objective: 'Own a recoverable default-checkout change', scope_clear: true, expected_files: 2, expected_changed_lines: 20, requires_recovery: true }); const workId = (started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId; expect(workId).toBeTruthy(); const claimed = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'controller_claim', work_id: workId, controller_type: 'chatgpt' }); expect(claimed?.isError).not.toBe(true); const blocked = await (await import('../../src/cli/mcp/repository-tools')).callRepositoryTool(fx.controllerHome, 'repository_command_execute', { repo_id: fx.repository.repoId, command: ['git', 'merge', '--ff-only', 'nonexistent'] }, fx.ctx); expect(blocked?.isError).toBe(true); expect((blocked?.structuredContent as { error?: { code?: string } }).error?.code).toBe('WORK_DELIVERY_REQUIRES_FINALIZE'); });
  test('reuses exact Plan scope but resolves distinct slices under the same Requirement before creation', async () => { const fx = fixture('plan-admission'); const sourceRevision = git(fx.repoRoot, ['rev-parse', 'HEAD']).trim(); const step = (id: string) => [{ id, objective: 'Implement it', dependencies: [], authoritative_files: [], allowed_paths: [], forbidden_paths: [], check_ids: [], acceptance_criteria: ['done'] }]; const first = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-primary', requirement_id: 'REQ-primary', scope_key: 'primary-scope', source_revision: sourceRevision, objective: 'Implement the primary requirement', plan_steps: step('step-a'), }); expect(first?.isError).not.toBe(true); expect(first?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: true, admissionDecision: 'create_new' } }); const exactDuplicate = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-duplicate', requirement_id: 'REQ-primary', scope_key: 'primary-scope', source_revision: sourceRevision, objective: 'Duplicate exact scope', plan_steps: step('step-dup'), }); expect(exactDuplicate?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: false, admissionDecision: 'reuse_existing', plan: { planId: 'PLAN-primary' } } }); const ambiguousSlice = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-slice-b', requirement_id: 'REQ-primary', scope_key: 'parallel-scope', source_revision: sourceRevision, objective: 'A distinct slice under the same broad requirement', plan_steps: step('step-b'), }); expect(ambiguousSlice?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: false, admissionDecision: 'resolution_required', resolutionRequired: true, allowedPlanRelations: ['extend', 'parallel'] }, }); const parallelSlice = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-slice-b', requirement_id: 'REQ-primary', scope_key: 'parallel-scope', plan_relation: 'parallel', source_revision: sourceRevision, objective: 'A distinct explicitly parallel slice', plan_steps: step('step-b'), }); expect(parallelSlice?.structuredContent).toMatchObject({ status: 'ok', data: { planContractCreated: true, admissionDecision: 'create_new', plan: { planId: 'PLAN-slice-b', requirementId: 'REQ-primary' } } }); });
  test('stopping a Plan-bound Work moves its Plan out of ghost executing state', async () => { const fx = fixture('plan-stop-reconcile'); const sourceRevision = git(fx.repoRoot, ['rev-parse', 'HEAD']).trim(); const created = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_create', plan_id: 'PLAN-stop-reconcile', scope_key: 'plan-stop-reconcile', source_revision: sourceRevision, objective: 'Run one stoppable planned slice', plan_steps: [{ id: 'step-a', objective: 'Execute stoppable work', dependencies: [], authoritative_files: [], allowed_paths: [], forbidden_paths: [], check_ids: ['package:check:type'], acceptance_criteria: ['finish or explicitly replan'], }], }); expect(created?.isError).not.toBe(true); const approved = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_approve', plan_id: 'PLAN-stop-reconcile' }); expect(approved?.isError).not.toBe(true); const started = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'start', plan_id: 'PLAN-stop-reconcile', plan_step_id: 'step-a', objective: 'Execute stoppable work', scope_clear: true, expected_files: 4, expected_changed_lines: 200, requires_recovery: true, }); expect(started?.isError).not.toBe(true); const workId = (started?.structuredContent as { data?: { work?: { workId?: string } } })?.data?.work?.workId; expect(workId).toBeTruthy(); const stopped = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, reason: 'user intentionally stopped this planned slice', }); expect(stopped?.isError).not.toBe(true); expect(stopped?.structuredContent).toMatchObject({ status: 'ok', data: { finalStatus: 'cancelled', plan: { planId: 'PLAN-stop-reconcile', status: 'replanning', steps: [{ id: 'step-a', status: 'ready', workId }] }, }, }); const fetched = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'plan_get', plan_id: 'PLAN-stop-reconcile', detail_level: 'detail' }); expect(fetched?.structuredContent).toMatchObject({ data: { plan: { status: 'replanning', steps: [{ id: 'step-a', status: 'ready', workId }] } } }); });

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

    const resumed = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_resume', schedule_id: scheduleId });
    const resumedPayload = resumed?.structuredContent as { data?: { schedule?: { enabled: boolean; pausedReason?: string } } };
    expect(resumedPayload.data?.schedule?.enabled).toBe(true);
    expect(resumedPayload.data?.schedule?.pausedReason).toBeUndefined();
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
    expect(continuedPayload.data?.controllerSession?.controllerType).toBe('codex'); const transientCtx = { ...externalCtx, sessionId: `${externalSession}-next` }; const command = await (await import('../../src/cli/mcp/repository-tools')).callRepositoryTool(fx.controllerHome, 'repository_command_execute', { repo_id: fx.repository.repoId, checkout_id: executionSession?.activeCheckoutId, command: ['bun', '-e', 'await Bun.sleep(250)'], detail_level: 'detail', return_handle_immediately: true }, transientCtx); expect((command?.structuredContent as { process?: { workId?: string } }).process?.workId).toBe(work.workId); await Bun.sleep(300); const patch = await (await import('../../src/cli/mcp/repository-tools')).callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', { repo_id: fx.repository.repoId, checkout_id: executionSession?.activeCheckoutId, purpose: 'Workflow-bound edit', allowed_paths: ['workflow-attribution.txt'], operations: [{ type: 'create', path: 'workflow-attribution.txt', content: 'owned\n' }] }, transientCtx); expect((patch?.structuredContent as { session?: { workId?: string } }).session?.workId).toBe(work.workId);
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
