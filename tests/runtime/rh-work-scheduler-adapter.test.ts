import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
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
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    workKind: 'local_effect',
    status: 'running',
    phase: 'implementation',
  });
  const ctx = {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'core',
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

describe('rh_work Scheduler MCP adapter', () => {
  test('routes the complete schedule lifecycle through the Scheduler adapter without external effects', async () => {
    const { repository, ctx, workId } = fixture();
    const scheduleId = await createShadowKeepalive(ctx, repository.repoId, workId, 'schedule-lifecycle-fixture');

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

  test('keeps frozen schedule.delete compatibility as transport-only delegation', async () => {
    const { repository, ctx, workId } = fixture();
    const scheduleId = await createShadowKeepalive(ctx, repository.repoId, workId, 'schedule-frozen-delete-fixture');

    const paused = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_pause',
      schedule_id: scheduleId,
      reason: 'fixture compatibility delete precondition',
    }));
    expect(paused.status).toBe('ok');

    const deleted = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      capability_id: `schedule.delete:${scheduleId}`,
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
