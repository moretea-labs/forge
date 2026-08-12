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
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
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
  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
    sessionId: `mcp-lifecycle-${label}`,
    principalId: `principal-lifecycle-${label}`,
    controllerInstanceId: `runtime-lifecycle-${label}`,
  });
  return { root, controllerHome, repoRoot, repository, ctx };
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
  return (prepared?.structuredContent as { work: { workId: string; worktreePath: string; branch: string } }).work;
}

function branchExists(root: string, branch: string): boolean {
  return spawnSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

describe('rh_work managed lifecycle closure', () => {
  test('finalize commits, merges, removes the managed worktree, and deletes the branch', async () => {
    const fx = fixture('finalize');
    const work = await prepareManagedWork(fx, 'Add one lifecycle acceptance file');
    writeFileSync(join(work.worktreePath, 'lifecycle.txt'), 'closed-loop\n');

    const finalized = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'finalize',
      work_id: work.workId,
    });
    expect(finalized?.isError).not.toBe(true);
    const payload = finalized?.structuredContent as { status?: string; data?: { lifecycleClosed?: boolean } };
    expect(payload.status).toBe('ok');
    expect(payload.data?.lifecycleClosed).toBe(true);
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

    const listed = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_list', work_id: work.workId });
    const listedPayload = listed?.structuredContent as { data?: { schedules?: Array<{ scheduleId: string }> } };
    expect(listedPayload.data?.schedules?.map((entry) => entry.scheduleId)).toEqual([scheduleId]);

    const paused = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_pause', schedule_id: scheduleId, reason: 'test pause' });
    const pausedPayload = paused?.structuredContent as { data?: { schedule?: { enabled: boolean; pausedReason?: string } } };
    expect(pausedPayload.data?.schedule?.enabled).toBe(false);
    expect(pausedPayload.data?.schedule?.pausedReason).toBe('test pause');

    const resumed = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_resume', schedule_id: scheduleId });
    const resumedPayload = resumed?.structuredContent as { data?: { schedule?: { enabled: boolean; pausedReason?: string } } };
    expect(resumedPayload.data?.schedule?.enabled).toBe(true);
    expect(resumedPayload.data?.schedule?.pausedReason).toBeUndefined();
  });

  test('non-shadow continuation trigger wakes exactly one external Controller owner', async () => {
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

    const triggered = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'schedule_trigger', schedule_id: scheduleId });
    expect(triggered?.isError).not.toBe(true);
    const occurrence = (triggered?.structuredContent as { data?: { occurrence?: { decision?: string; status?: string } } })?.data?.occurrence;
    expect(occurrence).toMatchObject({ decision: 'execute', status: 'succeeded' });

    const owner = await callRuntimeTool(fx.ctx, 'rh_work', { repo_id: fx.repository.repoId, operation: 'controller_get_owner', work_id: work.workId });
    const ownerPayload = owner?.structuredContent as { data?: { owner?: { controllerType?: string } } };
    expect(ownerPayload.data?.owner?.controllerType).toBe('codex');

    const second = await callRuntimeTool(fx.ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'schedule_trigger',
      schedule_id: scheduleId,
      event_name: 'manual-second-window',
      event_id: 'manual-second-window-1',
    });
    const secondOccurrence = (second?.structuredContent as { data?: { occurrence?: { decision?: string; reason?: string } } })?.data?.occurrence;
    expect(secondOccurrence?.decision).toBe('nothing_to_do');
    expect(secondOccurrence?.reason).toContain('already has an active Controller');
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
