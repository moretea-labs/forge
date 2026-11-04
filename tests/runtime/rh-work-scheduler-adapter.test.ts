import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../adapters/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callRuntimeTool } from '../../adapters/mcp/runtime-gateway/runtime-tools';
import { bindControllerSessionBinding, claimControllerSession, releaseControllerSession } from '../../packages/kernel/controller/api/index';
import { upsertChatgptControllerBinding } from '../../adapters/chatgpt/controller-binding-store';
import { cronDue } from '../../packages/kernel/scheduler/application/eligibility';
import { getSchedule, saveSchedule } from '../../packages/kernel/scheduler/api/index';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { createWorkContract } from '../../packages/kernel/work/api/index';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function fixture() {
  const repoRoot = tempRoot('forge-rh-work-schedule-repo-');
  const controllerHome = tempRoot('forge-rh-work-schedule-home-');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'rh-work-schedule-fixture' }, null, 2));
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'rh_work schedule fixture' });
  const workId = 'work-schedule-fixture';
  createWorkContract({ controllerHome, repoId: repository.repoId }, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    baseRevision: git(repoRoot, 'rev-parse', 'HEAD'),
    objective: 'Exercise the rh_work Scheduler transport boundary.',
    acceptanceCriteria: ['Schedule transport preserves Scheduler authority.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: {},
    requestedBy: 'chatgpt',
    workKind: 'local_effect',
    dispatchState: 'running',
    phase: 'implementation',
  });
  const ctx = {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'full',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { controllerHome, repository, ctx, workId };
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, any>;
}

async function createShadowKeepalive(ctx: MultiRepositoryMcpToolContext, repoId: string, workId: string, requestId: string) {
  const created = structured(await callRuntimeTool(ctx, 'rh_work', {
    repo_id: repoId,
    operation: 'schedule_create',
    work_id: workId,
    schedule_mode: 'browser_keepalive',
    controller_type: 'chatgpt',
    schedule_name: `Fixture ${requestId}`,
    schedule_request_id: requestId,
    trigger_type: 'manual',
    probe_url: 'https://chatgpt.com/',
    shadow_mode: true,
  }));
  expect(created.status).toBe('ok');
  expect(created.data.schedule.policy.shadowMode).toBe(true);
  return created.data.schedule.scheduleId as string;
}

test('cron schedule eligibility stays correct across consecutive days and DST-independent dates', () => {
  expect(cronDue('0 8 * * *', Date.parse('2026-10-17T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);
  expect(cronDue('0 8 * * *', Date.parse('2026-10-17T23:59:00.000Z'), 'Asia/Shanghai')).toBe(false);
  expect(cronDue('0 8 * * *', Date.parse('2026-10-18T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);
  expect(cronDue('0 8 * * *', Date.parse('2026-11-01T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);
});

describe('retired autonomous Schedule actions', () => {
  for (const operation of ['external_controller_wake', 'controller_progression']) {
    test(operation + ' stops once without dispatching or creating an occurrence', async () => {
      const { controllerHome, repository, ctx, workId } = fixture();
      const scheduleId = await createShadowKeepalive(ctx, repository.repoId, workId, 'retire-' + operation);
      const old = getSchedule(controllerHome, repository.repoId, scheduleId);
      const candidate = saveSchedule(controllerHome, {
        ...old,
        enabled: true,
        action: { operation, target: 'controller', arguments: { work_id: workId, controller_type: 'chatgpt' } },
      });
      expect(await evaluateSchedule(controllerHome, candidate, true, { source: 'manual' })).toBeUndefined();
      const stopped = getSchedule(controllerHome, repository.repoId, scheduleId);
      expect(stopped.enabled).toBe(false);
      expect(stopped.pausedReason).toBe('RETIRED_AUTONOMOUS_CONTINUATION_SCHEDULE');
      expect(stopped.lastOccurrenceId).toBeUndefined();
      expect(await evaluateSchedule(controllerHome, candidate, true, { source: 'manual' })).toBeUndefined();
      expect(getSchedule(controllerHome, repository.repoId, scheduleId).revision).toBe(stopped.revision);
    });
  }
});

describe('Work-free observe-only Schedule', () => {
  test('creates and manually triggers a browser watcher without Work, Controller binding, or model wake', async () => {
    const { controllerHome, repository, ctx } = fixture();
    const input = {
      repo_id: repository.repoId,
      operation: 'schedule_create',
      schedule_mode: 'browser_watch',
      schedule_name: 'Standalone browser observation',
      schedule_request_id: 'observe-without-work',
      trigger_type: 'manual',
      probe_url: 'https://chatgpt.com/',
      shadow_mode: true,
    };
    const created = structured(await callRuntimeTool(ctx, 'rh_work', input));
    expect(created.status).toBe('ok');
    const scheduleId = created.data.schedule.scheduleId as string;
    const stored = getSchedule(controllerHome, repository.repoId, scheduleId);
    expect(stored.action.operation).toBe('browser_probe');
    expect(stored.action.arguments?.work_id).toBeUndefined();
    expect(stored.action.arguments?.controller_binding_id).toBeUndefined();
    expect(stored.action.arguments?.keepalive_only).toBe(false);

    const unsafe = structured(await callRuntimeTool(ctx, 'rh_work', {
      ...input,
      schedule_request_id: 'rejected-auto-turn',
      continuation_prompt: 'CONTINUE',
    }));
    expect(unsafe.status).toBe('blocked');
    expect(unsafe.summary).toContain('SCHEDULE_AUTONOMOUS_MODEL_LAUNCH_FIELDS_RETIRED');

    const replay = structured(await callRuntimeTool(ctx, 'rh_work', input));
    expect(replay.status).toBe('ok');
    expect(replay.data.schedule.scheduleId).toBe(scheduleId);

    const triggered = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_trigger',
      schedule_id: scheduleId,
      request_id: 'observe-once',
    }));
    expect(triggered.status).toBe('ok');
    expect(triggered.data.occurrence).toMatchObject({ decision: 'would_execute', status: 'shadowed' });
  });
});

describe('rh_work Scheduler MCP adapter', () => {
  test('bounds Schedule listing and hides historical model prompts while preserving exact detail', async () => {
    const { controllerHome, repository, ctx, workId } = fixture();
    const first = await createShadowKeepalive(ctx, repository.repoId, workId, 'bounded-list-first');
    const second = await createShadowKeepalive(ctx, repository.repoId, workId, 'bounded-list-second');
    const retired = await createShadowKeepalive(ctx, repository.repoId, workId, 'bounded-list-retired');
    const stored = getSchedule(controllerHome, repository.repoId, retired);
    saveSchedule(controllerHome, {
      ...stored,
      enabled: false,
      action: {
        operation: 'external_controller_wake',
        target: 'runtime',
        arguments: { work_id: workId, continuation_prompt: 'CONTINUE'.repeat(10_000) },
      },
    });

    const bounded = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_list',
      limit: 2,
      include_occurrences: true,
    }));
    expect(bounded.status).toBe('ok');
    expect(bounded.data.totalCount).toBe(3);
    expect(bounded.data.truncated).toBe(true);
    expect(bounded.data.schedules).toHaveLength(2);
    expect(bounded.data.schedules.every((schedule: { enabled: boolean }) => schedule.enabled)).toBe(true);
    expect(bounded.data.schedules.map((schedule: { scheduleId: string }) => schedule.scheduleId).sort()).toEqual([first, second].sort());
    expect(JSON.stringify(bounded.data)).not.toContain('CONTINUE');
    expect(bounded.data.occurrences).toEqual([]);

    const all = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_list',
      limit: 100,
    }));
    expect(all.data.totalCount).toBe(3);
    expect(all.data.truncated).toBe(false);
    expect(all.data.schedules).toHaveLength(3);
    expect(JSON.stringify(all.data)).not.toContain('CONTINUE');

    const detail = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_get',
      schedule_id: retired,
    }));
    expect(detail.data.schedule.action.arguments.continuation_prompt).toContain('CONTINUE');
    expect(detail.data.schedule.action.arguments.continuation_prompt.length).toBeGreaterThan(100);
  });

  test('routes the complete schedule lifecycle through the Scheduler adapter without external effects', async () => {
    const { controllerHome, repository, ctx, workId } = fixture();
    const scheduleId = await createShadowKeepalive(ctx, repository.repoId, workId, 'schedule-lifecycle-fixture');

    const retired = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_create',
      work_id: workId,
      schedule_mode: 'continuation',
      controller_type: 'chatgpt',
      schedule_name: 'Retired autonomous schedule',
      schedule_request_id: 'schedule-autonomous-creation-denied-fixture',
      trigger_type: 'manual',
    }));
    expect(retired.status).toBe('blocked');
    expect(retired.summary).toContain('SCHEDULE_AUTONOMOUS_CONTINUATION_RETIRED');

    const listed = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_list',
    }));
    expect(listed.status).toBe('ok');
    expect(listed.data.schedules.some((schedule: { scheduleId: string }) => schedule.scheduleId === scheduleId)).toBe(true);

    const fetched = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_get',
      schedule_id: scheduleId,
    }));
    expect(fetched.status).toBe('ok');
    expect(fetched.data.schedule.scheduleId).toBe(scheduleId);

    const paused = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_pause',
      schedule_id: scheduleId,
      reason: 'fixture pause',
    }));
    expect(paused.status).toBe('ok');
    expect(paused.data.schedule.enabled).toBe(false);

    const resumed = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_resume',
      schedule_id: scheduleId,
    }));
    expect(resumed.status).toBe('ok');
    expect(resumed.data.schedule.enabled).toBe(true);

    const triggered = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_trigger',
      schedule_id: scheduleId,
      request_id: 'manual-shadow-occurrence',
    }));
    expect(triggered.status).toBe('ok');
    expect(triggered.data.occurrence).toMatchObject({ decision: 'would_execute', status: 'shadowed' });

    const pausedForDelete = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_pause',
      schedule_id: scheduleId,
      reason: 'fixture delete precondition',
    }));
    expect(pausedForDelete.status).toBe('ok');

    const deleted = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_delete',
      schedule_id: scheduleId,
    }));
    expect(deleted.status).toBe('ok');
    expect(deleted.data).toMatchObject({ scheduleId, deleted: true });

    const missing = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_get',
      schedule_id: scheduleId,
    }));
    expect(missing.status).toBe('blocked');
  });

  test('rejects the removed frozen schedule.delete carrier and uses the canonical Scheduler operation', async () => {
    const { repository, ctx, workId } = fixture();
    const scheduleId = await createShadowKeepalive(ctx, repository.repoId, workId, 'schedule-frozen-delete-fixture');

    const paused = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_pause',
      schedule_id: scheduleId,
      reason: 'fixture canonical delete precondition',
    }));
    expect(paused.status).toBe('ok');

    const legacyDelete = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      capability_id: `schedule.delete:${scheduleId}`,
    }));
    expect(legacyDelete.status).toBe('blocked');
    expect(JSON.stringify(legacyDelete)).toContain('FROZEN_MCP_LIFECYCLE_REMOVED');

    const deleted = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_delete',
      schedule_id: scheduleId,
    }));
    expect(deleted.status).toBe('ok');
    expect(deleted.data).toMatchObject({ scheduleId, deleted: true });

    const missing = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_get',
      schedule_id: scheduleId,
    }));
    expect(missing.status).toBe('blocked');
  });
});
