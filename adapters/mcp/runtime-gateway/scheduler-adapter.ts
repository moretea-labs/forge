import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { applyScheduleDedupe, buildScheduleDedupeReport, deleteSchedule } from '../../../packages/kernel/scheduler/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade/facade-result';
import { buildWorkContinuationSnapshot } from '../../../src/runtime/control-plane/facade/work-continuation';
import {
  createWorkContinuationSchedule,
  getWorkContinuationSchedule,
  listWorkContinuationSchedules,
  pauseWorkContinuationSchedule,
  resumeWorkContinuationSchedule,
  triggerWorkContinuationSchedule,
  type ContinuationControllerType,
} from '../../../src/runtime/workflow/schedules/work-continuation';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

export type RhWorkScheduleOperation =
  | 'schedule_create'
  | 'schedule_list'
  | 'schedule_get'
  | 'schedule_pause'
  | 'schedule_resume'
  | 'schedule_delete'
  | 'schedule_trigger';

const RH_WORK_SCHEDULE_OPERATIONS = new Set<RhWorkScheduleOperation>([
  'schedule_create',
  'schedule_list',
  'schedule_get',
  'schedule_pause',
  'schedule_resume',
  'schedule_delete',
  'schedule_trigger',
]);

export function isRhWorkScheduleOperation(operation: string): operation is RhWorkScheduleOperation {
  return RH_WORK_SCHEDULE_OPERATIONS.has(operation as RhWorkScheduleOperation);
}

/**
 * MCP transport normalization for the rh_work schedule family. Scheduler and
 * Work-continuation application services remain the only lifecycle/persistence
 * authority; this adapter only parses tool arguments and shapes facade output.
 */
export async function callRhWorkScheduleAdapter(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  operation: RhWorkScheduleOperation,
  args: Record<string, unknown>,
  options: { scheduleIdOverride?: string } = {},
): Promise<CallToolResult> {
  try {
    const workId = String(args.work_id ?? '').trim();
    const scheduleId = options.scheduleIdOverride?.trim() || String(args.schedule_id ?? '').trim();
    if (operation === 'schedule_create') {
      const controllerType = String(args.controller_type ?? 'chatgpt').trim();
      if (!['chatgpt', 'codex', 'claude', 'grok'].includes(controllerType)) throw new Error('CONTROLLER_TYPE_INVALID');
      const triggerTypeRaw = String(args.trigger_type ?? '').trim();
      const triggerType = ['interval', 'cron', 'calendar', 'condition', 'repository-event', 'dependency-checkpoint', 'manual'].includes(triggerTypeRaw)
        ? triggerTypeRaw as 'interval' | 'cron' | 'calendar' | 'condition' | 'repository-event' | 'dependency-checkpoint' | 'manual'
        : undefined;
      const scheduleModeRaw = String(args.schedule_mode ?? (workId ? 'continuation' : '')).trim();
      if (!['continuation', 'browser_watch', 'browser_keepalive'].includes(scheduleModeRaw)) throw new Error('SCHEDULE_MODE_REQUIRES_WORK_OR_EXPLICIT_BROWSER_KEEPALIVE');
      const created = createWorkContinuationSchedule(ctx.controllerHome, repository.repoId, {
        workId,
        scheduleMode: scheduleModeRaw as 'continuation' | 'browser_watch' | 'browser_keepalive',
        controllerType: controllerType as ContinuationControllerType,
        executable: typeof args.executable === 'string' ? args.executable : undefined,
        launchArgs: Array.isArray(args.launch_args) ? args.launch_args.map(String) : undefined,
        launchReservationMs: typeof args.launch_reservation_ms === 'number' ? args.launch_reservation_ms : typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
        handoffId: typeof args.handoff_id === 'string' ? args.handoff_id : undefined,
        browserSessionId: typeof args.browser_session_id === 'string' ? args.browser_session_id : undefined,
        conversationUrl: typeof args.conversation_url === 'string' ? args.conversation_url : undefined,
        continuationPrompt: typeof args.continuation_prompt === 'string' ? args.continuation_prompt : undefined,
        probeUrl: typeof args.probe_url === 'string' ? args.probe_url : undefined,
        probeBrowserSessionId: typeof args.probe_browser_session_id === 'string' ? args.probe_browser_session_id : undefined,
        probeSelector: typeof args.probe_selector === 'string' ? args.probe_selector : undefined,
        probeMaxChars: typeof args.probe_max_chars === 'number' ? args.probe_max_chars : undefined,
        probeTimeoutMs: typeof args.probe_timeout_ms === 'number' ? args.probe_timeout_ms : undefined,
        includeTerms: Array.isArray(args.include_terms) ? args.include_terms.map(String) : undefined,
        ignorePatterns: Array.isArray(args.ignore_patterns) ? args.ignore_patterns.map(String) : undefined,
        loginUrlTerms: Array.isArray(args.login_url_terms) ? args.login_url_terms.map(String) : undefined,
        loginTextTerms: Array.isArray(args.login_text_terms) ? args.login_text_terms.map(String) : undefined,
        wakeOnFirstObservation: args.wake_on_first_observation === true,
        wakeOnAuthRequired: args.wake_on_auth_required !== false,
        authRequiredPrompt: typeof args.auth_required_prompt === 'string' ? args.auth_required_prompt : undefined,
        scheduleName: typeof args.schedule_name === 'string' ? args.schedule_name : undefined,
        requestId: typeof args.schedule_request_id === 'string' ? args.schedule_request_id : undefined,
        triggerType,
        everyMinutes: typeof args.every_minutes === 'number' ? args.every_minutes : undefined,
        cronExpression: typeof args.cron_expression === 'string' ? args.cron_expression : undefined,
        timezone: typeof args.schedule_timezone === 'string' ? args.schedule_timezone : undefined,
        catchUpMinutes: typeof args.catch_up_minutes === 'number' ? args.catch_up_minutes : undefined,
        calendarAt: typeof args.calendar_at === 'string' ? args.calendar_at : undefined,
        condition: args.condition && typeof args.condition === 'object' && !Array.isArray(args.condition) ? args.condition as never : undefined,
        eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
        dependencyJobIds: Array.isArray(args.dependency_job_ids) ? args.dependency_job_ids.map(String) : undefined,
        maxFailures: typeof args.max_failures === 'number' ? args.max_failures : undefined,
        cooldownMinutes: typeof args.cooldown_minutes === 'number' ? args.cooldown_minutes : undefined,
        dailyBudgetMinutes: typeof args.daily_budget_minutes === 'number' ? args.daily_budget_minutes : undefined,
        shadowMode: typeof args.shadow_mode === 'boolean' ? args.shadow_mode : undefined,
        backoffBaseMinutes: typeof args.backoff_base_minutes === 'number' ? args.backoff_base_minutes : undefined,
        backoffMaxMinutes: typeof args.backoff_max_minutes === 'number' ? args.backoff_max_minutes : undefined,
        stopConditions: Array.isArray(args.stop_conditions) ? args.stop_conditions.map(String) : undefined,
      });
      return result(buildFacadeResult({
        summary: created.work
          ? `Work schedule ${created.schedule.scheduleId} is configured for Work ${created.work.workId}.`
          : `Browser keepalive schedule ${created.schedule.scheduleId} is configured without a durable Work.`,
        data: {
          schedule: created.schedule,
          ...(created.work ? { work: buildWorkContinuationSnapshot(created.work) } : {}),
        },
      }) as unknown as Record<string, unknown>);
    }
    if (operation === 'schedule_list') {
      const schedules = listWorkContinuationSchedules(ctx.controllerHome, repository.repoId, {
        workId: workId || undefined,
        includeOccurrences: args.include_occurrences === true,
      });
      const data = args.include_occurrences === true ? schedules : { schedules: schedules.schedules };
      return result(buildFacadeResult({ summary: `Found ${schedules.schedules.length} schedule(s).`, data }) as unknown as Record<string, unknown>);
    }
    if (!scheduleId) throw new Error('SCHEDULE_ID_REQUIRED');
    if (operation === 'schedule_get') {
      const data = getWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, args.include_occurrences === true);
      return result(buildFacadeResult({ summary: `Schedule ${scheduleId}.`, data }) as unknown as Record<string, unknown>);
    }
    if (operation === 'schedule_pause') {
      const saved = pauseWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, typeof args.reason === 'string' ? args.reason : undefined);
      return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is paused.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
    }
    if (operation === 'schedule_resume') {
      const saved = resumeWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId);
      return result(buildFacadeResult({ summary: `Schedule ${scheduleId} is resumed.`, data: { schedule: saved } }) as unknown as Record<string, unknown>);
    }
    if (operation === 'schedule_delete') {
      const schedule = getWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId).schedule;
      deleteSchedule(ctx.controllerHome, repository.repoId, scheduleId);
      return result(buildFacadeResult({
        summary: `Schedule ${scheduleId} is deleted; historical occurrences and evidence are retained.`,
        data: { scheduleId, deleted: true, requestId: schedule.requestId },
      }) as unknown as Record<string, unknown>);
    }
    const repositoryEvent = typeof args.event_name === 'string' && args.event_name.trim().length > 0;
    const explicitEventId = typeof args.event_id === 'string' ? args.event_id.trim() : '';
    const manualRequestId = !repositoryEvent && typeof args.request_id === 'string' ? args.request_id.trim() : '';
    const occurrence = await triggerWorkContinuationSchedule(ctx.controllerHome, repository.repoId, scheduleId, {
      source: repositoryEvent ? 'repository-event' : 'manual',
      eventName: typeof args.event_name === 'string' ? args.event_name : undefined,
      eventId: explicitEventId || manualRequestId || undefined,
      data: args.event_data && typeof args.event_data === 'object' && !Array.isArray(args.event_data) ? args.event_data as Record<string, unknown> : undefined,
    });
    return result(buildFacadeResult({
      summary: occurrence ? `Schedule ${scheduleId} produced ${occurrence.decision}.` : `Schedule ${scheduleId} produced no occurrence.`,
      data: { occurrence },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'Schedule operation failed.',
      data: {},
    }) as unknown as Record<string, unknown>, true);
  }
}

export async function callSchedulerAdapter(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'schedule_dedupe_report': {
        const repository = selected(ctx, args);
        return result({ report: buildScheduleDedupeReport(ctx.controllerHome, repository.repoId) });
      }
      case 'schedule_dedupe_apply': {
        const repository = selected(ctx, args);
        return result({ dedupe: applyScheduleDedupe(ctx.controllerHome, repository.repoId, { dryRun: args.dry_run, confirmAuthorization: args.confirm_authorization }) });
      }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
