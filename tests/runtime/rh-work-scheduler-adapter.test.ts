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
import { reconcileControllerProgression } from '../../src/runtime/root/controller-progression-composition';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { renderSupervisorReceipt } from '../../supervisor/protocol';
import { createWorkflowSupervisorServer, WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { bindControllerSessionBinding, claimControllerSession, releaseControllerSession } from '../../packages/kernel/controller/api/index';
import { upsertChatgptControllerBinding } from '../../adapters/chatgpt/controller-binding-store';
import { cronDue, scheduleTriggerWindowKey } from '../../packages/kernel/scheduler/application/eligibility';
import { saveSchedule } from '../../packages/kernel/scheduler/api/index';
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

describe('rh_work Scheduler MCP adapter', () => {
  test('wakes a waiting Supervisor before a lower ControllerRound semantic wait can veto the scheduled turn', async () => {
    const { controllerHome, repository, ctx, workId } = fixture();
    const controllerStore = { controllerHome, repoId: repository.repoId };
    const owner = claimControllerSession(controllerStore, {
      workId,
      controllerId: 'controller-a',
      controllerType: 'chatgpt',
      sessionId: 'session-wake-a',
      principalId: 'controller-a',
      controllerInstanceId: 'runtime-wake-a',
      leaseMs: 60_000,
    });
    const controllerBinding = upsertChatgptControllerBinding(controllerStore, {
      workId,
      sessionId: owner.sessionId,
      title: 'scheduled wake fixture',
      model: 'gpt-6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    bindControllerSessionBinding(controllerStore, {
      workId,
      sessionId: owner.sessionId,
      binding: controllerBinding.binding,
    });
    releaseControllerSession(controllerStore, workId, owner.controllerId);

    let lowerLayerPrepared = false;
    const progression = await reconcileControllerProgression({
      controllerHome,
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
    }, {
      occurrenceId: 'controller-round-occurrence-fixture',
      workId,
      relayScopeId: 'relay-scope-fixture',
      scheduleId: 'SCH-wait-wake-fixture',
      scheduleOccurrenceId: 'SCH-wait-wake-fixture:occurrence-2026-10-17T08:00+08:00',
      bindingArgs: { controller_type: 'chatgpt' },
    }, {
      wakeScheduledSupervisorTask: async () => ({
        status: 'woken',
        taskId: 'task-wait-wake-fixture',
        effectId: 'fx_1234567890abcdef1234567890abcdef',
      }),
      prepareOccurrence: () => {
        lowerLayerPrepared = true;
        return { outcome: 'semantic_wait', reason: 'lower round already semantically settled' } as never;
      },
    });

    expect(progression).toMatchObject({
      status: 'scheduled_supervisor_woken',
      binding: { bindingId: controllerBinding.binding.bindingId },
      taskId: 'task-wait-wake-fixture',
      effectId: 'fx_1234567890abcdef1234567890abcdef',
    });
    expect(lowerLayerPrepared).toBe(false);
  });

  test('executes two distinct cron occurrences through the same durable WAIT task without pausing the Schedule', async () => {
    const { controllerHome, repository, ctx, workId } = fixture();
    const controllerStore = { controllerHome, repoId: repository.repoId };
    const owner = claimControllerSession(controllerStore, {
      workId,
      controllerId: 'controller-daily-wake',
      controllerType: 'chatgpt',
      sessionId: 'session-daily-wake',
      principalId: 'controller-daily-wake',
      controllerInstanceId: 'runtime-daily-wake',
      leaseMs: 60_000,
    });
    const controllerBinding = upsertChatgptControllerBinding(controllerStore, {
      workId,
      sessionId: owner.sessionId,
      title: 'daily Gmail scheduled wake fixture',
      model: 'gpt-6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    bindControllerSessionBinding(controllerStore, {
      workId,
      sessionId: owner.sessionId,
      binding: controllerBinding.binding,
    });
    releaseControllerSession(controllerStore, workId, owner.controllerId);

    const supervisorRoot = join(controllerHome, 'supervisor');
    mkdirSync(supervisorRoot, { recursive: true });
    const supervisorStore = new WorkflowSupervisorStore(supervisorRoot);
    const control = new WorkflowSupervisorControlPlane(supervisorStore);
    const taskId = `forge:${repository.repoId}:work:${workId}`;
    const conversationId = 'bcbcbcbc-1111-2222-3333-444444444444';
    const task = control.registerTask({
      taskId,
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Run the scheduled Gmail routine daily at 08:00 China time and remain open between occurrences.',
      completionContract: {
        kind: 'forge_work_done',
        controller_home: controllerHome,
        repo_id: repository.repoId,
        work_id: workId,
      },
      continuationPolicy: {
        kind: 'forge_goal_outer_turn',
        exact_conversation_id: conversationId,
        exact_conversation_url: `https://chatgpt.com/c/${conversationId}`,
        outer_turn_owner: 'workflow_supervisor',
      },
      userBlockerPolicy: {
        kind: 'forge_work_waiting_for_user',
        controller_home: controllerHome,
        repo_id: repository.repoId,
        work_id: workId,
      },
    });
    const initial = control.reserveEnrollment(taskId);
    const server = createWorkflowSupervisorServer({
      controlPlane: control,
      socketPath: join(supervisorRoot, 'supervisor.sock'),
      discovery: new WorkflowSupervisorEphemeralDiscovery(),
      browserAdapterEnabled: true,
    });
    await new Promise<void>((resolve, reject) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', () => resolve());
      server.once('error', reject);
    });

    const originalDate = globalThis.Date;
    let clockNow = originalDate.parse('2026-10-17T00:00:00.000Z');
    class ScheduledClockDate extends originalDate {
      constructor(value?: string | number, month?: number, day?: number, hours?: number, minutes?: number, seconds?: number, milliseconds?: number) {
        if (value === undefined) super(clockNow);
        else if (typeof value === 'number' && month !== undefined) super(value, month, day ?? 1, hours ?? 0, minutes ?? 0, seconds ?? 0, milliseconds ?? 0);
        else super(value as string | number);
      }
      static now(): number { return clockNow; }
    }
    try {
      const created = structured(await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'schedule_create',
        work_id: workId,
        schedule_mode: 'continuation',
        controller_type: 'chatgpt',
        schedule_name: 'Fixture daily Gmail Supervisor wake',
        schedule_request_id: 'schedule-daily-gmail-two-consecutive-occurrences',
        trigger_type: 'cron',
        cron_expression: '0 8 * * *',
        schedule_timezone: 'Asia/Shanghai',
        continuation_hint: 'Continue the same scheduled Gmail Work.',
        shadow_mode: false,
      }));
      expect(created.status).toBe('ok');
      const scheduleId = created.data.schedule.scheduleId as string;
      expect(created.data.schedule).toMatchObject({
        enabled: true,
        action: { operation: 'controller_progression', arguments: { work_id: workId, controller_binding_id: controllerBinding.binding.bindingId } },
        trigger: { type: 'cron', cronExpression: '0 8 * * *', timezone: 'Asia/Shanghai' },
        policy: { shadowMode: false },
      });
      expect(created.data.supervisorWakeBinding).toEqual({ status: 'bound', taskId });
      expect(control.getEffect(initial.effectId)?.prompt).toContain('SCHEDULED WORK:');
      expect(cronDue('0 8 * * *', Date.parse('2026-10-17T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);
      expect(cronDue('0 8 * * *', Date.parse('2026-10-17T23:59:00.000Z'), 'Asia/Shanghai')).toBe(false);
      expect(cronDue('0 8 * * *', Date.parse('2026-10-18T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);
      expect(cronDue('0 8 * * *', Date.parse('2026-10-19T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);
      expect(cronDue('0 8 * * *', Date.parse('2026-10-31T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);
      expect(cronDue('0 8 * * *', Date.parse('2026-11-01T00:00:00.000Z'), 'Asia/Shanghai')).toBe(true);

      const paused = structured(await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'schedule_pause',
        schedule_id: scheduleId,
        reason: 'verify exact Supervisor wake binding survives Schedule resume',
      }));
      expect(paused.data.schedule.enabled).toBe(false);
      const resumed = structured(await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'schedule_resume',
        schedule_id: scheduleId,
      }));
      expect(resumed.data.schedule).toMatchObject({
        enabled: true,
        action: { operation: 'controller_progression', arguments: { work_id: workId, controller_binding_id: controllerBinding.binding.bindingId } },
      });
      expect(resumed.data.supervisorWakeBinding).toEqual({ status: 'bound', taskId });

      control.observeEffect({ effectId: initial.effectId, observationId: 'daily-gmail-initial-applied', outcome: 'applied' });
      const firstWait = await control.observeAssistantTurn({
        taskId,
        conversationId: task.conversationId,
        responseText: renderSupervisorReceipt(control.getTask(taskId)!, initial.effectId, 'WAIT'),
      });
      expect(firstWait).toMatchObject({ action: 'WAIT', terminal: false });

      globalThis.Date = ScheduledClockDate as DateConstructor;
      const firstTrigger = await evaluateSchedule(controllerHome, created.data.schedule, false, { source: 'timer' });
      expect(firstTrigger).toMatchObject({
        status: 'dispatched',
        decision: 'execute',
        triggerContext: { source: 'timer' },
        windowKey: expect.stringContaining('2026-10-17@08:00[Asia/Shanghai]'),
      });
      const afterFirst = structured(await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'schedule_get',
        schedule_id: scheduleId,
      }));
      expect(afterFirst.data.schedule.enabled).toBe(true);
      const firstWakeStall = control.taskStall(taskId);
      if (!('effectId' in firstWakeStall) || !firstWakeStall.effectId) throw new Error('FIRST_SCHEDULED_WAKE_EFFECT_MISSING');
      const firstWake = control.getEffect(firstWakeStall.effectId)!;
      expect(firstWake).toMatchObject({
        kind: 'continuation',
        sourceCompletionFingerprint: firstWait.completionFingerprint,
      });

      control.observeEffect({ effectId: firstWake.effectId, observationId: 'daily-gmail-occurrence-one-applied', outcome: 'applied' });
      const secondWait = await control.observeAssistantTurn({
        taskId,
        conversationId: task.conversationId,
        responseText: renderSupervisorReceipt(control.getTask(taskId)!, firstWake.effectId, 'WAIT'),
      });
      expect(secondWait).toMatchObject({ action: 'WAIT', terminal: false });

      clockNow = originalDate.parse('2026-10-18T00:00:00.000Z');
      const secondTrigger = await evaluateSchedule(controllerHome, created.data.schedule, false, { source: 'timer' });
      expect(secondTrigger).toMatchObject({
        status: 'dispatched',
        decision: 'execute',
        triggerContext: { source: 'timer' },
        windowKey: expect.stringContaining('2026-10-18@08:00[Asia/Shanghai]'),
      });
      const afterSecond = structured(await callRuntimeTool(ctx, 'rh_work', {
        repo_id: repository.repoId,
        operation: 'schedule_get',
        schedule_id: scheduleId,
      }));
      expect(afterSecond.data.schedule.enabled).toBe(true);
      const secondWakeStall = control.taskStall(taskId);
      if (!('effectId' in secondWakeStall) || !secondWakeStall.effectId) throw new Error('SECOND_SCHEDULED_WAKE_EFFECT_MISSING');
      const secondWake = control.getEffect(secondWakeStall.effectId)!;
      expect(secondWake).toMatchObject({
        kind: 'continuation',
        sourceCompletionFingerprint: secondWait.completionFingerprint,
      });
      expect(secondWake.effectId).not.toBe(firstWake.effectId);
      expect(control.getTask(taskId)?.taskId).toBe(taskId);
    } finally {
      globalThis.Date = originalDate;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      supervisorStore.close();
    }
  });

  test('routes the complete schedule lifecycle through the Scheduler adapter without external effects', async () => {
    const { controllerHome, repository, ctx, workId } = fixture();
    const scheduleId = await createShadowKeepalive(ctx, repository.repoId, workId, 'schedule-lifecycle-fixture');

    const controllerStore = { controllerHome, repoId: repository.repoId };
    const owner = claimControllerSession(controllerStore, {
      workId,
      controllerId: 'controller-a',
      controllerType: 'chatgpt',
      sessionId: 'session-a',
      principalId: 'controller-a',
      controllerInstanceId: 'runtime-a',
      leaseMs: 60_000,
    });
    const controllerBinding = upsertChatgptControllerBinding(controllerStore, {
      workId,
      sessionId: owner.sessionId,
      title: 'scheduled continuation fixture',
      model: 'gpt-6',
      reasoning: 'high',
      tabPolicy: 'auto',
    });
    bindControllerSessionBinding(controllerStore, {
      workId,
      sessionId: owner.sessionId,
      binding: controllerBinding.binding,
    });
    releaseControllerSession(controllerStore, workId, owner.controllerId);

    const continuation = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_create',
      work_id: workId,
      schedule_mode: 'continuation',
      controller_type: 'chatgpt',
      schedule_name: 'Fixture canonical Controller progression',
      schedule_request_id: 'schedule-controller-progression-fixture',
      trigger_type: 'cron',
      cron_expression: '0 8 */2 * *',
      schedule_timezone: 'Asia/Shanghai',
      continuation_hint: 'Continue the exact scheduled Work round.',
      max_failures: 20,
      cooldown_minutes: 0,
      daily_budget_minutes: 600,
      backoff_base_minutes: 1,
      backoff_max_minutes: 2,
      shadow_mode: true,
    }));
    expect(continuation.status).toBe('ok');
    expect(continuation.data.schedule.action).toMatchObject({
      operation: 'controller_progression',
      arguments: { work_id: workId, controller_binding_id: controllerBinding.binding.bindingId },
    });
    expect(continuation.data.schedule.trigger).toMatchObject({ type: 'cron', cronExpression: '0 8 */2 * *', timezone: 'Asia/Shanghai' });
    expect(continuation.data.schedule.policy).toMatchObject({
      shadowMode: true,
      maxFailures: 3,
      dailyBudgetMinutes: 60,
      cooldownMinutes: 10,
      backoffBaseMinutes: 10,
      backoffMaxMinutes: 10,
    });
    const legacyContinuation = saveSchedule(controllerHome, {
      ...continuation.data.schedule,
      action: { ...continuation.data.schedule.action, operation: 'external_controller_wake' },
    });
    expect(legacyContinuation.action.operation).toBe('external_controller_wake');
    const pausedContinuation = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_pause',
      schedule_id: continuation.data.schedule.scheduleId,
      reason: 'fixture policy persistence check',
    }));
    expect(pausedContinuation.status).toBe('ok');
    const resumedContinuation = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'schedule_resume',
      schedule_id: continuation.data.schedule.scheduleId,
    }));
    expect(resumedContinuation.status).toBe('ok');
    expect(resumedContinuation.data.schedule.enabled).toBe(true);
    expect(resumedContinuation.data.schedule.action.operation).toBe('controller_progression');
    expect(resumedContinuation.data.schedule.policy).toMatchObject({
      shadowMode: true,
      maxFailures: 3,
      dailyBudgetMinutes: 60,
      cooldownMinutes: 10,
      backoffBaseMinutes: 10,
      backoffMaxMinutes: 10,
    });
    expect(continuation.data.supervisorWakeBinding).toEqual({ status: 'binding_deferred' });
    const firstCronWindow = scheduleTriggerWindowKey(continuation.data.schedule, { source: 'timer' }, Date.parse('2026-10-17T00:00:00.000Z'));
    const secondCronWindow = scheduleTriggerWindowKey(continuation.data.schedule, { source: 'timer' }, Date.parse('2026-10-19T00:00:00.000Z'));
    expect(firstCronWindow).toContain('2026-10-17');
    expect(secondCronWindow).toContain('2026-10-19');
    expect(secondCronWindow).not.toBe(firstCronWindow);

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
